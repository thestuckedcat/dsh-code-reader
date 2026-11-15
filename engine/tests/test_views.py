"""CL-VIEW-T1 engine read model: snapshot list, entry list and entry detail.

The tests pin the *real* SDK Code Atlas 0.8 product shape via the committed
``fixtures/real-atlas/mini`` snapshot pair.  The pair records the absolute
analyzed paths of the machine that produced it, so the tests rewrite those
paths into a temporary repository (graph + manifest only, inside the test):
the repository-relative mapping, the signed source window and the resource
projection are then exercised exactly like the real bus Demo snapshot, without
depending on the machine path of this checkout.

Resource projections additionally use a synthetic Atlas payload shaped after the
real ``objects``/``field_accesses`` records (write exact / read may, multiple
base objects, limitations) because the committed mini fixture has no resource
layer; that fixture also covers the explicit ``unavailable`` degradation.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import tempfile
import unittest
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from tests import helpers
from tests.fixtures.snapshots import support

from code_learning import scope, source, views

FIXTURES = Path(__file__).resolve().parent / "fixtures"
REAL_MINI = FIXTURES / "real-atlas" / "mini"
REAL_MINI_REPO = FIXTURES / "real-atlas" / "mini-repo"

WORKSPACE_ID = "code-view-bus-demo"
VARIANT_ID = "semantic-x86_64"
REPO_ID = "mini"
SNAPSHOT_ONE = "22a7c4d18126447688ea05faf45a3e65"
SNAPSHOT_TWO = "0123456789abcdef0123456789abcdef"

SUBMIT_ID = "f_8cd01e11ce71edcc3a5a5e66"
SUBMIT_EVIDENCE = "e_16db6246574c8ecff11b961d"
CALL_EVIDENCE = "e_587fb2e455eb3ab568e98308"

_ABS_RE = re.compile(r"^(?:[A-Za-z]:[\\/]|//|/(?!/))")


def _uuid() -> str:
    return str(uuid.uuid4())


def _looks_absolute(value: str) -> bool:
    return bool(_ABS_RE.match(value))


def _rewrite_under(value: str, old_root: str, new_root: str) -> str:
    """Rewrite an absolute path recorded on another machine into ``new_root``."""
    text = value.replace("\\", "/")
    old = old_root.replace("\\", "/").rstrip("/")
    if old and text.lower().startswith(old.lower()):
        suffix = text[len(old) :].lstrip("/")
        return str(Path(new_root) / suffix) if suffix else str(new_root)
    return value


def _iter_strings(node: Any, key: Optional[str] = None) -> Iterable[tuple]:
    if isinstance(node, dict):
        for name, value in node.items():
            yield from _iter_strings(value, name)
    elif isinstance(node, list):
        for item in node:
            yield from _iter_strings(item, key)
    elif isinstance(node, str):
        yield key, node


class ViewsTestBase(unittest.TestCase):
    """Temporary bootstrap + one registered workspace whose repo is writable."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="cl-views-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.env = helpers.make_bootstrap(self.tmp)
        self.repo = self.env.root / "mini-repo"
        self.repo.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REAL_MINI_REPO / "mini.c", self.repo / "mini.c")
        shutil.copyfile(REAL_MINI_REPO / "mini.h", self.repo / "mini.h")
        self.manifest = self._manifest()
        self._import_workspace(self.manifest)
        self.real_graph_document = json.loads(
            (REAL_MINI / "graph.json").read_text(encoding="utf-8")
        )
        self.real_manifest_document = json.loads(
            (REAL_MINI / "analysis_manifest.json").read_text(encoding="utf-8")
        )
        self.old_root = self.real_manifest_document["payload"]["workspace_roots"][0]

    # -- workspace / snapshot plumbing ------------------------------------
    def _manifest(self) -> Dict[str, Any]:
        return {
            "schema_version": 1,
            "workspace_id": WORKSPACE_ID,
            "scope_ref": "local",
            "repositories": [
                {
                    "repo_id": REPO_ID,
                    "root_ref": "synthetic-root",
                    "relative_path": "mini-repo",
                    "role": "other",
                    "vcs": {"kind": "none", "commit": None},
                }
            ],
            "variants": [
                {"variant_id": VARIANT_ID, "analysis_mode": "semantic"},
            ],
            "toolchains": [],
            "allowed_read_roots": ["synthetic-root"],
            "output_root_ref": "synthetic-root",
            "cross_repo_bindings": [],
        }

    def _import_workspace(
        self, manifest: Dict[str, Any], expected_revision: int = 0
    ) -> Dict[str, Any]:
        name = helpers.write_manifest(self.env, manifest, "workspace.json")
        return helpers.cli_json(
            self.env.bootstrap_path,
            "workspace-import",
            "--manifest",
            name,
            "--expected-revision",
            str(expected_revision),
            "--operation-id",
            _uuid(),
        )

    def real_graph_payload(self, mutator=None) -> Dict[str, Any]:
        payload = json.loads(json.dumps(self.real_graph_document["payload"]))
        for entity in payload.get("evidence") or []:
            if isinstance(entity.get("file"), str):
                entity["file"] = _rewrite_under(entity["file"], self.old_root, str(self.repo))
        for callsite in payload.get("callsites") or []:
            for field in ("target_declaration", "target_definition"):
                if isinstance(callsite.get(field), str):
                    callsite[field] = _rewrite_under(
                        callsite[field], self.old_root, str(self.repo)
                    )
        if mutator is not None:
            mutator(payload)
        return payload

    def real_manifest_overrides(self, snapshot_id: str) -> Dict[str, Any]:
        manifest_payload = self.real_manifest_document["payload"]
        return {
            "snapshot_id": snapshot_id,
            "analysis_id": snapshot_id,
            "input_files": {},
            "workspace_roots": [str(self.repo)],
            "workspace_revisions": {str(self.repo): "fixture-revision"},
            "coverage": json.loads(json.dumps(manifest_payload["coverage"])),
            "scope": {"mode": "interface", "interface": "submit", "direction": "down"},
        }

    def import_snapshot(
        self,
        *,
        name: str,
        snapshot_id: str,
        graph_payload: Optional[Dict[str, Any]] = None,
        overrides: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        payload = (
            graph_payload if graph_payload is not None else self.real_graph_payload()
        )
        manifest_overrides = self.real_manifest_overrides(snapshot_id)
        if overrides is not None:
            manifest_overrides.update(overrides)
        helpers.write_snapshot_dir(
            self.env.inbox_dir / name, payload, manifest_overrides
        )
        return helpers.cli_json(
            self.env.bootstrap_path,
            "snapshot-import",
            "--workspace",
            WORKSPACE_ID,
            "--variant",
            VARIANT_ID,
            "--repo",
            REPO_ID,
            "--snapshot",
            name,
            "--operation-id",
            _uuid(),
        )

    def import_synthetic_snapshot(
        self, *, name: str, snapshot_id: str, payload: Dict[str, Any]
    ) -> Dict[str, Any]:
        helpers.write_snapshot_dir(
            self.env.inbox_dir / name, payload, {"snapshot_id": snapshot_id}
        )
        return helpers.cli_json(
            self.env.bootstrap_path,
            "snapshot-import",
            "--workspace",
            WORKSPACE_ID,
            "--variant",
            VARIANT_ID,
            "--repo",
            REPO_ID,
            "--snapshot",
            name,
            "--operation-id",
            _uuid(),
        )

    # -- assertion helpers -------------------------------------------------
    def assert_no_absolute_paths(self, payload: Dict[str, Any]) -> None:
        """No absolute/bootstap/state path may appear anywhere in the payload."""
        for key, value in _iter_strings(payload):
            self.assertFalse(
                _looks_absolute(value),
                f"absolute path leaked into {key!r}: {value!r}",
            )
            self.assertNotIn(str(self.tmp), value)
            self.assertNotIn(str(self.repo), value)
        for key, value in _iter_strings(payload):
            if key in ("file", "path"):
                self.assertNotIn("..", value, f"{key!r} must not contain traversal: {value!r}")

    def assert_cli_single_json(self, *args: str) -> Dict[str, Any]:
        completed = helpers.run_cli(self.env.bootstrap_path, *args)
        lines = [line for line in completed.stdout.splitlines() if line.strip()]
        self.assertEqual(1, len(lines), f"stdout must be one JSON object: {completed.stdout!r}")
        payload = json.loads(lines[0])
        self.assertEqual(1, payload["schema_version"])
        return payload

    def workspace(self) -> Dict[str, Any]:
        from code_learning import snapshot

        return snapshot.load_workspace_registration(self.env.state, WORKSPACE_ID)


class ViewSnapshotsTest(ViewsTestBase):
    def test_empty_scope_reports_sample_gaps(self) -> None:
        payload = views.list_snapshots(self.env.state)
        self.assertEqual(1, payload["schema_version"])
        self.assertEqual("code-learning", payload["host"]["engine"])
        self.assertEqual("local", payload["host"]["scope_ref"])
        self.assertEqual(1, payload["host"]["scope_generation"])
        self.assertEqual("unittest", payload["host"]["profile_ref"])
        self.assertEqual(1, len(payload["workspaces"]))
        workspace = payload["workspaces"][0]
        self.assertEqual(WORKSPACE_ID, workspace["workspace_id"])
        self.assertEqual(1, workspace["revision"])
        self.assertEqual("semantic", workspace["semantic_status"])
        self.assertEqual([], workspace["snapshots"])
        self.assertEqual(
            [
                {
                    "repo_id": REPO_ID,
                    "role": "other",
                    "root_ref": "synthetic-root",
                    "relative_path": "mini-repo",
                }
            ],
            workspace["repositories"],
        )
        self.assertEqual(
            [{"variant_id": VARIANT_ID, "analysis_mode": "semantic"}],
            workspace["variants"],
        )
        gap_codes = {gap["code"] for gap in payload["gaps"]}
        self.assertIn("snapshot", gap_codes)
        self.assert_no_absolute_paths(payload)

    def test_verified_snapshot_projection(self) -> None:
        self.import_snapshot(name="snap-one", snapshot_id=SNAPSHOT_ONE)
        payload = views.list_snapshots(self.env.state)
        snapshots = payload["workspaces"][0]["snapshots"]
        self.assertEqual(1, len(snapshots))
        item = snapshots[0]
        self.assertEqual(SNAPSHOT_ONE, item["snapshot_id"])
        self.assertEqual(VARIANT_ID, item["variant_id"])
        self.assertEqual(REPO_ID, item["repo_id"])
        self.assertEqual("verified", item["status"])
        self.assertEqual("fresh", item["freshness"])
        self.assertEqual("0.1", item["atlas_schema"])
        self.assertEqual("0.8.0", item["tool_version"])
        self.assertEqual(3, item["entry_count"])
        self.assertEqual(
            {
                "failed_count": 0,
                "pending_count": 0,
                "whole_program_complete": False,
            },
            item["coverage"],
        )
        self.assertEqual("ready", item["capabilities"]["direct_calls"])
        self.assertEqual("unsupported", item["capabilities"]["cfg"])
        self.assertEqual(
            "partial_path_insensitive", item["capabilities"]["data_flow"]
        )
        self.assertIsNone(item["error"])
        self.assertRegex(item["graph_sha256"], r"^[0-9a-f]{64}$")
        self.assertRegex(item["manifest_sha256"], r"^[0-9a-f]{64}$")
        self.assertIsNotNone(item["imported_at"])
        self.assert_no_absolute_paths(payload)

    def test_corrupt_snapshot_is_invalid_but_page_succeeds(self) -> None:
        self.import_snapshot(name="snap-one", snapshot_id=SNAPSHOT_ONE)
        self.import_snapshot(name="snap-two", snapshot_id=SNAPSHOT_TWO)
        destination = self.env.state.snapshot_dir(SNAPSHOT_ONE)
        helpers.write_bytes(destination / "graph.json", b'{"tampered": true}\n')

        payload = self.assert_cli_single_json("view-snapshots")
        items = {
            item["snapshot_id"]: item for item in payload["workspaces"][0]["snapshots"]
        }
        self.assertEqual(2, len(items))
        invalid = items[SNAPSHOT_ONE]
        self.assertEqual("invalid", invalid["status"])
        self.assertEqual("STALE_SNAPSHOT", invalid["error"]["code"])
        self.assertIsNone(invalid["entry_count"])
        self.assertIsNone(invalid["coverage"])
        verified = items[SNAPSHOT_TWO]
        self.assertEqual("verified", verified["status"])
        self.assertEqual(3, verified["entry_count"])
        self.assertEqual("fresh", verified["freshness"])
        self.assert_no_absolute_paths(payload)

    def test_missing_snapshot_files_are_invalid(self) -> None:
        self.import_snapshot(name="snap-one", snapshot_id=SNAPSHOT_ONE)
        destination = self.env.state.snapshot_dir(SNAPSHOT_ONE)
        (destination / "analysis_manifest.json").unlink()
        payload = views.list_snapshots(self.env.state)
        item = payload["workspaces"][0]["snapshots"][0]
        self.assertEqual("invalid", item["status"])
        self.assertEqual("NOT_FOUND", item["error"]["code"])
        self.assertIn("missing", item["error"]["message"])
        self.assert_no_absolute_paths(payload)

    def test_unreadable_workspace_registration_does_not_fail_the_page(self) -> None:
        self.import_snapshot(name="snap-one", snapshot_id=SNAPSHOT_ONE)
        registration = self.env.state.workspace_dir(WORKSPACE_ID) / "registration.json"
        helpers.write_text(registration, "{not json")
        payload = views.list_snapshots(self.env.state)
        self.assertEqual(1, len(payload["workspaces"]))
        workspace = payload["workspaces"][0]
        self.assertEqual(WORKSPACE_ID, workspace["workspace_id"])
        self.assertIsNone(workspace["revision"])
        self.assertEqual("unknown", workspace["semantic_status"])
        self.assertEqual([], workspace["repositories"])
        self.assertEqual("invalid", workspace["snapshots"][0]["status"])
        self.assertEqual(
            "UNSUPPORTED_SCHEMA", workspace["snapshots"][0]["error"]["code"]
        )
        self.assertIn(
            "workspace_unavailable", {gap["code"] for gap in payload["gaps"]}
        )
        self.assert_no_absolute_paths(payload)

    def test_freshness_turns_stale_after_workspace_revision_bump(self) -> None:
        self.import_snapshot(name="snap-one", snapshot_id=SNAPSHOT_ONE)
        self.assertEqual(
            "fresh",
            views.list_snapshots(self.env.state)["workspaces"][0]["snapshots"][0][
                "freshness"
            ],
        )
        self._import_workspace(self.manifest, expected_revision=1)
        payload = views.list_snapshots(self.env.state)
        self.assertEqual(
            "stale", payload["workspaces"][0]["snapshots"][0]["freshness"]
        )
        entries = views.list_entries(self.env.state, WORKSPACE_ID, SNAPSHOT_ONE)
        self.assertIn("snapshot_stale", {gap["code"] for gap in entries["gaps"]})


class ViewEntriesTest(ViewsTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.import_snapshot(name="snap-one", snapshot_id=SNAPSHOT_ONE)

    def test_entry_list_order_counts_and_relative_paths(self) -> None:
        payload = views.list_entries(self.env.state, WORKSPACE_ID, SNAPSHOT_ONE)
        self.assertEqual(1, payload["schema_version"])
        snapshot = payload["snapshot"]
        self.assertEqual(WORKSPACE_ID, snapshot["workspace_id"])
        self.assertEqual(SNAPSHOT_ONE, snapshot["snapshot_id"])
        self.assertEqual(VARIANT_ID, snapshot["variant_id"])
        self.assertEqual(REPO_ID, snapshot["repo_id"])
        self.assertEqual("verified", snapshot["status"])
        self.assertEqual("fresh", snapshot["freshness"])
        self.assertIn("capabilities", snapshot)
        self.assertIn("coverage", snapshot)

        selection = payload["selection"]
        self.assertIsNone(selection["entry_id"])
        self.assertIsNone(selection["symbol_id"])
        self.assertEqual([], selection["callsite_ids"])
        self.assertEqual([], selection["callsite_path"])
        self.assertEqual([], selection["resource_ids"])
        self.assertEqual("unavailable", selection["resource_status"])
        self.assertEqual([], selection["evidence_ids"])
        self.assertIsNone(selection["run_id"])
        self.assertIsNone(selection["event_id"])

        entries = payload["entries"]
        self.assertEqual(["submit", "normalize", "clamp_value"], [row["name"] for row in entries])
        submit = entries[0]
        self.assertEqual(SUBMIT_ID, submit["entry_id"])
        self.assertEqual("s_540f07bbf5866414e08a1f35", submit["symbol_id"])
        self.assertEqual("submit", submit["name"])
        self.assertEqual("submit(int)", submit["display_name"])
        self.assertEqual("function", submit["kind"])
        self.assertEqual("NONE", submit["storage"])
        self.assertEqual("int (int)", submit["signature"])
        self.assertEqual("mini.c", submit["file"])
        self.assertEqual(13, submit["line"])
        self.assertTrue(submit["is_entry"])
        self.assertEqual(0, submit["callers"])
        self.assertEqual(1, submit["callees"])
        self.assertEqual("ok", submit["file_status"])

        normalize = entries[1]
        self.assertEqual("mini.c", normalize["file"])
        self.assertEqual(3, normalize["line"])
        self.assertFalse(normalize["is_entry"])
        self.assertEqual(1, normalize["callers"])
        self.assertEqual(0, normalize["callees"])

        clamp = entries[2]
        self.assertEqual(8, clamp["line"])
        self.assertFalse(clamp["is_entry"])
        self.assertEqual(1, clamp["callers"])
        self.assertEqual(1, clamp["callees"])

        self.assertEqual([], payload["external_nodes"])
        self.assertFalse(payload["truncated"])
        gap_codes = {gap["code"] for gap in payload["gaps"]}
        self.assertIn("resource_graph", gap_codes)
        resource_gap = next(
            gap for gap in payload["gaps"] if gap["code"] == "resource_graph"
        )
        self.assertEqual("unavailable", resource_gap["status"])
        self.assertEqual(
            "atlas_snapshot_has_no_resource_layer", resource_gap["reason"]
        )
        self.assert_no_absolute_paths(payload)

    def test_unresolved_function_location_is_reported_not_faked(self) -> None:
        def mutate(payload: Dict[str, Any]) -> None:
            for entity in payload["evidence"]:
                if entity["id"] == "e_87b5876257600564ff86cea6":
                    entity["file"] = str(self.tmp / "outside" / "not-in-a-repo.c")

        self.import_snapshot(
            name="snap-two",
            snapshot_id=SNAPSHOT_TWO,
            graph_payload=self.real_graph_payload(mutate),
        )
        payload = views.list_entries(self.env.state, WORKSPACE_ID, SNAPSHOT_TWO)
        rows = {row["name"]: row for row in payload["entries"]}
        self.assertIsNone(rows["normalize"]["file"])
        self.assertEqual("path_unresolved", rows["normalize"]["file_status"])
        self.assertEqual(3, rows["normalize"]["line"])
        self.assertEqual("mini.c", rows["submit"]["file"])
        unresolved_gap = next(
            gap for gap in payload["gaps"] if gap["code"] == "path_unresolved"
        )
        self.assertEqual("degraded", unresolved_gap["status"])
        self.assert_no_absolute_paths(payload)

    def test_entry_list_is_truncated_at_2000(self) -> None:
        functions = [
            {
                "id": f"f_many_{index}",
                "name": f"many_{index:04d}",
                "display_name": f"many_{index:04d}",
                "kind": "function",
                "storage": "NONE",
                "signature": "void (void)",
                "return_type": "void",
                "parameters": [],
                "file": "src/many.c",
                "line": index + 1,
            }
            for index in range(2005)
        ]
        payload = support.graph_payload(functions=functions)
        self.import_synthetic_snapshot(
            name="snap-many", snapshot_id="11112222333344445555666677778888", payload=payload
        )
        result = views.list_entries(
            self.env.state, WORKSPACE_ID, "11112222333344445555666677778888"
        )
        self.assertEqual(2000, len(result["entries"]))
        self.assertTrue(result["truncated"])
        self.assert_no_absolute_paths(result)

    def test_cli_view_entries_and_unknown_snapshot(self) -> None:
        payload = self.assert_cli_single_json(
            "view-entries",
            "--workspace",
            WORKSPACE_ID,
            "--snapshot",
            SNAPSHOT_ONE,
        )
        self.assertEqual(
            ["submit", "normalize", "clamp_value"],
            [row["name"] for row in payload["entries"]],
        )

        completed = helpers.run_cli(
            self.env.bootstrap_path,
            "view-entries",
            "--workspace",
            WORKSPACE_ID,
            "--snapshot",
            "ffffffffffffffffffffffffffffffff",
            expect=2,
        )
        error = json.loads(completed.stdout)
        self.assertEqual("NOT_FOUND", error["error"]["code"])
        self.assertEqual(2, completed.returncode)

        completed = helpers.run_cli(
            self.env.bootstrap_path,
            "view-entries",
            "--workspace",
            "no-such-workspace",
            "--snapshot",
            SNAPSHOT_ONE,
            expect=2,
        )
        self.assertEqual("NOT_FOUND", json.loads(completed.stdout)["error"]["code"])

        completed = helpers.run_cli(
            self.env.bootstrap_path,
            "view-entries",
            "--workspace",
            "../escape",
            "--snapshot",
            SNAPSHOT_ONE,
            expect=2,
        )
        self.assertEqual(
            "INVALID_ARGUMENT", json.loads(completed.stdout)["error"]["code"]
        )


class ViewEntryDetailTest(ViewsTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.import_snapshot(name="snap-one", snapshot_id=SNAPSHOT_ONE)

    def _detail(self, entry: str = "submit") -> Dict[str, Any]:
        return views.entry_detail(self.env.state, WORKSPACE_ID, SNAPSHOT_ONE, entry)

    def test_entry_detail_maps_source_calls_and_evidence(self) -> None:
        payload = self._detail()
        self.assertEqual(1, payload["schema_version"])
        entry = payload["entry"]
        self.assertEqual(SUBMIT_ID, entry["entry_id"])
        self.assertEqual("s_540f07bbf5866414e08a1f35", entry["symbol_id"])
        self.assertEqual("submit", entry["name"])
        self.assertEqual("submit(int)", entry["display_name"])
        self.assertEqual("function", entry["kind"])
        self.assertEqual("NONE", entry["storage"])
        self.assertEqual("int (int)", entry["signature"])
        self.assertEqual("int", entry["return_type"])
        self.assertEqual([{"name": "value", "type": "int"}], entry["parameters"])
        self.assertEqual("mini.c", entry["file"])
        self.assertEqual(13, entry["line"])
        self.assertTrue(entry["is_entry"])
        self.assertIsNone(entry["summary"])
        self.assertEqual("missing", entry["summary_origin"])

        selection = payload["selection"]
        self.assertEqual(SUBMIT_ID, selection["entry_id"])
        self.assertEqual("s_540f07bbf5866414e08a1f35", selection["symbol_id"])
        self.assertEqual([SUBMIT_EVIDENCE], selection["evidence_ids"])
        self.assertEqual([], selection["callsite_ids"])
        self.assertEqual([], selection["resource_ids"])
        self.assertEqual("unavailable", selection["resource_status"])

        source_projection = payload["source"]
        self.assertEqual("ok", source_projection["status"])
        self.assertEqual("mini.c", source_projection["path"])
        self.assertEqual(
            hashlib.sha256((REAL_MINI_REPO / "mini.c").read_bytes()).hexdigest(),
            source_projection["sha256"],
        )
        self.assertEqual(151, source_projection["byte_start"])
        self.assertEqual(211, source_projection["byte_end"])
        self.assertEqual(13, source_projection["line_start"])
        self.assertEqual(16, source_projection["line_end"])
        self.assertEqual(
            [
                {"n": 13, "text": "int submit(int value)"},
                {"n": 14, "text": "{"},
                {"n": 15, "text": "    return clamp_value(value) + 1;"},
                {"n": 16, "text": "}"},
            ],
            source_projection["lines"],
        )
        self.assertEqual(
            {"line_start": 13, "line_end": 16}, source_projection["highlight"]
        )
        self.assertFalse(source_projection["truncated"])
        self.assertIsNone(source_projection["reason"])

        # The signed references must be replayable through the existing source
        # contract (later ``code_source action=evidence`` re-verification).
        workspace = self.workspace()
        verified_path = scope.verify_path_ref(
            self.env.state, source_projection["path_ref"], workspace_id=WORKSPACE_ID
        )
        self.assertEqual("mini.c", verified_path["p"])
        replayed = source.read_evidence(
            self.env.state, WORKSPACE_ID, source_projection["evidence_ref"]
        )
        self.assertIn("int submit(int value)", replayed["safe_text"])
        self.assertEqual(13, replayed["evidence"]["line_start"])
        self.assertEqual(16, replayed["evidence"]["line_end"])

        calls = payload["calls"]
        self.assertEqual(1, len(calls))
        call = calls[0]
        self.assertEqual("edge_4918031c53a605f83f688b2d", call["edge_id"])
        self.assertEqual("c_8f9919cc0f7e6caf5ad5a528", call["callsite_id"])
        self.assertEqual("mini.c", call["callsite"]["file"])
        self.assertEqual(15, call["callsite"]["line"])
        self.assertEqual("clamp_value(value)", call["callsite"]["expression"])
        self.assertEqual("f_f2efe1f5a6447bacc4a9f84e", call["target"]["entry_id"])
        self.assertEqual("clamp_value", call["target"]["name"])
        self.assertEqual("mini.c", call["target"]["file"])
        self.assertEqual(8, call["target"]["line"])
        self.assertEqual("exact", call["certainty"])
        self.assertEqual("deterministic_analysis", call["origin"])
        self.assertEqual([CALL_EVIDENCE], call["evidence_ids"])
        self.assertEqual([], call["limitations"])
        self.assertEqual([], payload["callers"])

        evidence_ids = [item["evidence_id"] for item in payload["evidence"]]
        self.assertIn(SUBMIT_EVIDENCE, evidence_ids)
        self.assertIn(CALL_EVIDENCE, evidence_ids)
        definition = next(
            item for item in payload["evidence"] if item["evidence_id"] == SUBMIT_EVIDENCE
        )
        self.assertEqual("mini.c", definition["file"])
        self.assertEqual(13, definition["line"])
        self.assertTrue(definition["text"].startswith("int submit(int value)"))

        resources = payload["resources"]
        self.assertEqual("unavailable", resources["status"])
        self.assertEqual("atlas_snapshot_has_no_resource_layer", resources["reason"])
        self.assertEqual([], resources["objects"])
        self.assertEqual([], resources["field_accesses"])
        self.assertEqual([], resources["gaps"])
        self.assertFalse(resources["truncated"])
        gap_codes = {gap["code"] for gap in payload["gaps"]}
        self.assertIn("resource_graph", gap_codes)
        self.assertFalse(payload["truncated"])
        self.assertIn("capabilities", payload)
        self.assertIn("limitations", payload)
        self.assert_no_absolute_paths(payload)

    def test_source_hash_mismatch_degrades_but_keeps_the_entry(self) -> None:
        (self.repo / "mini.c").write_bytes((self.repo / "mini.c").read_bytes() + b"\n")
        payload = self.assert_cli_single_json(
            "view-entry",
            "--workspace",
            WORKSPACE_ID,
            "--snapshot",
            SNAPSHOT_ONE,
            "--entry",
            "submit",
        )
        self.assertEqual("unavailable", payload["source"]["status"])
        self.assertEqual("STALE_SOURCE", payload["source"]["reason"])
        self.assertEqual([], payload["source"]["lines"])
        # Everything else is still returned.
        self.assertEqual("mini.c", payload["entry"]["file"])
        self.assertEqual(1, len(payload["calls"]))
        gap_codes = {gap["code"] for gap in payload["gaps"]}
        self.assertIn("source_unavailable", gap_codes)
        self.assert_no_absolute_paths(payload)

    def test_source_missing_file_degrades(self) -> None:
        (self.repo / "mini.c").unlink()
        payload = self._detail()
        self.assertEqual("unavailable", payload["source"]["status"])
        self.assertEqual("NOT_FOUND", payload["source"]["reason"])
        self.assertEqual("mini.c", payload["entry"]["file"])
        self.assert_no_absolute_paths(payload)

    def test_unknown_entry_is_not_found(self) -> None:
        completed = helpers.run_cli(
            self.env.bootstrap_path,
            "view-entry",
            "--workspace",
            WORKSPACE_ID,
            "--snapshot",
            SNAPSHOT_ONE,
            "--entry",
            "f_does_not_exist",
            expect=2,
        )
        error = json.loads(completed.stdout)
        self.assertEqual("NOT_FOUND", error["error"]["code"])

    def test_direct_call_edges_are_truncated_at_100(self) -> None:
        functions: List[Dict[str, Any]] = [
            support.function("f_entry", "entry_fn", file="src/edge.c", line=1)
        ]
        callsites: List[Dict[str, Any]] = []
        evidence: List[Dict[str, Any]] = []
        call_targets: List[Dict[str, Any]] = []
        for index in range(105):
            out_id = f"f_out_{index}"
            in_id = f"f_in_{index}"
            functions.append(
                support.function(out_id, f"out_{index}", file="src/edge.c", line=10 + index)
            )
            functions.append(
                support.function(in_id, f"in_{index}", file="src/edge.c", line=200 + index)
            )
            callsites.append(
                support.callsite(f"c_out_{index}", owner="f_entry", file="src/edge.c", line=10 + index)
            )
            callsites.append(
                support.callsite(f"c_in_{index}", owner=in_id, file="src/edge.c", line=200 + index)
            )
            evidence.append(
                support.evidence(f"e_out_{index}", file="src/edge.c", line=10 + index)
            )
            evidence.append(
                support.evidence(f"e_in_{index}", file="src/edge.c", line=200 + index)
            )
            call_targets.append(
                support.call_target(
                    f"edge_out_{index}",
                    callsite=f"c_out_{index}",
                    source="f_entry",
                    target=out_id,
                    evidence=[f"e_out_{index}"],
                )
            )
            call_targets.append(
                support.call_target(
                    f"edge_in_{index}",
                    callsite=f"c_in_{index}",
                    source=in_id,
                    target="f_entry",
                    evidence=[f"e_in_{index}"],
                )
            )
        graph = support.graph_payload(
            functions=functions,
            callsites=callsites,
            call_targets=call_targets,
            evidence=evidence,
        )
        self.import_synthetic_snapshot(
            name="snap-edges", snapshot_id="aaaabbbbccccddddeeeeffff00001111", payload=graph
        )
        result = views.entry_detail(
            self.env.state, WORKSPACE_ID, "aaaabbbbccccddddeeeeffff00001111", "f_entry"
        )
        self.assertEqual(100, len(result["calls"]))
        self.assertEqual(100, len(result["callers"]))
        self.assertTrue(result["truncated"])
        self.assert_no_absolute_paths(result)

    def _resource_graph(self, *, include_may: bool) -> Dict[str, Any]:
        source_path = str(self.repo / "mini.c")
        source_sha = hashlib.sha256((self.repo / "mini.c").read_bytes()).hexdigest()
        evidence = [
            {
                "id": "e_def_submit",
                "kind": "evidence",
                "file": source_path,
                "line": 13,
                "start": 151,
                "end": 211,
                "hash": source_sha,
                "text": "int submit(int value)\n{\n    return clamp_value(value) + 1;\n}",
            },
            {"id": "e_call_store", "kind": "evidence", "file": source_path, "line": 15},
            {"id": "e_obj_routes", "kind": "evidence", "file": source_path, "line": 26},
            {"id": "e_field_write", "kind": "evidence", "file": source_path, "line": 46},
            {"id": "e_field_read", "kind": "evidence", "file": source_path, "line": 57},
        ]
        functions = [
            {
                "id": "f_send",
                "base_id": "s_send",
                "name": "bus_send",
                "display_name": "bus_send(unsigned, unsigned)",
                "kind": "function",
                "storage": "NONE",
                "signature": "int (unsigned int, unsigned int)",
                "return_type": "int",
                "parameters": [
                    {"index": 0, "name": "channel", "type": "unsigned int"},
                    {"index": 1, "name": "length", "type": "unsigned int"},
                ],
                "evidence_ids": ["e_def_submit"],
            },
            {
                "id": "f_store",
                "base_id": "s_store",
                "name": "store_route",
                "display_name": "store_route(unsigned, unsigned, unsigned)",
                "kind": "function",
                "storage": "STATIC",
                "signature": "void (unsigned int, unsigned int, unsigned int)",
                "return_type": "void",
                "parameters": [],
                "evidence_ids": ["e_call_store"],
            },
            {
                "id": "f_other",
                "base_id": "s_other",
                "name": "unrelated",
                "display_name": "unrelated(void)",
                "kind": "function",
                "storage": "NONE",
                "signature": "void (void)",
                "return_type": "void",
                "parameters": [],
                "evidence_ids": [],
            },
        ]
        callsites = [
            {
                "id": "c_send_store",
                "owner": "f_send",
                "expression": "store_route(channel, length, 0)",
                "evidence_ids": ["e_call_store"],
            }
        ]
        call_targets = [
            {
                "id": "edge_send_store",
                "callsite": "c_send_store",
                "source": "f_send",
                "target": "f_store",
                "origin": "deterministic_analysis",
                "certainty": "exact",
                "evidence_ids": ["e_call_store"],
            }
        ]
        objects = [
            {
                "id": "s_routes",
                "kind": "object",
                "name": "routes",
                "type": "struct Route[4]",
                "storage": "STATIC",
                "lifetime": "static",
                "evidence_ids": ["e_obj_routes"],
            },
            {
                "id": "s_defaults",
                "kind": "object",
                "name": "route_defaults",
                "type": "const struct Route[4]",
                "storage": "STATIC",
                "lifetime": "static",
                "evidence_ids": ["e_obj_routes"],
            },
        ]
        field_accesses: List[Dict[str, Any]] = [
            {
                "id": "field_write",
                "owner": "f_store",
                "access": "write",
                "certainty": "exact",
                "object_ids": ["s_routes"],
                "field_name": "max_len",
                "field_path": ["max_len"],
                "expression": "routes[channel].max_len",
                "evidence_ids": ["e_field_write"],
                "limitations": [],
            },
            {
                "id": "field_outside",
                "owner": "f_other",
                "access": "write",
                "certainty": "exact",
                "object_ids": ["s_routes"],
                "field_name": "lane",
                "field_path": ["lane"],
                "expression": "routes[channel].lane",
                "evidence_ids": ["e_field_read"],
                "limitations": [],
            },
        ]
        if include_may:
            field_accesses.insert(
                1,
                {
                    "id": "field_read",
                    "owner": "f_store",
                    "access": "read",
                    "certainty": "may",
                    "object_ids": ["s_routes", "s_defaults"],
                    "field_name": "max_len",
                    "field_path": ["max_len"],
                    "expression": "route->max_len",
                    "evidence_ids": ["e_field_read"],
                    "limitations": ["unresolved_or_multiple_base_objects"],
                },
            )
        return support.graph_payload(
            functions=functions,
            callsites=callsites,
            call_targets=call_targets,
            evidence=evidence,
            extra={"objects": objects, "field_accesses": field_accesses},
        )

    def test_resource_projection_write_exact_and_read_may(self) -> None:
        self.import_synthetic_snapshot(
            name="snap-res",
            snapshot_id="1234567890abcdef1234567890abcdef",
            payload=self._resource_graph(include_may=True),
        )
        payload = views.entry_detail(
            self.env.state, WORKSPACE_ID, "1234567890abcdef1234567890abcdef", "bus_send"
        )
        resources = payload["resources"]
        self.assertEqual("partial", resources["status"])
        self.assertIsNone(resources["reason"])
        self.assertFalse(resources["truncated"])

        self.assertEqual(["s_routes", "s_defaults"], [item["resource_id"] for item in resources["objects"]])
        routes = resources["objects"][0]
        self.assertEqual("routes", routes["name"])
        self.assertEqual("struct Route[4]", routes["type"])
        self.assertEqual("STATIC", routes["storage"])
        self.assertEqual("static", routes["lifetime"])
        self.assertEqual("mini.c", routes["file"])
        self.assertEqual(26, routes["line"])
        self.assertEqual(["e_obj_routes"], routes["evidence_ids"])

        accesses = {item["access_id"]: item for item in resources["field_accesses"]}
        self.assertEqual({"field_write", "field_read"}, set(accesses))
        write = accesses["field_write"]
        self.assertEqual("write", write["access"])
        self.assertEqual("exact", write["certainty"])
        self.assertEqual(["s_routes"], write["object_ids"])
        self.assertEqual(["routes"], write["object_names"])
        self.assertEqual("max_len", write["field_name"])
        self.assertEqual(["max_len"], write["field_path"])
        self.assertEqual("routes[channel].max_len", write["expression"])
        self.assertEqual("f_store", write["owner"]["entry_id"])
        self.assertEqual("store_route", write["owner"]["name"])
        self.assertEqual("mini.c", write["owner"]["file"])
        self.assertEqual(15, write["owner"]["line"])
        self.assertEqual({"file": "mini.c", "line": 46}, write["location"])
        self.assertEqual([], write["limitations"])

        read = accesses["field_read"]
        self.assertEqual("read", read["access"])
        self.assertEqual("may", read["certainty"])
        self.assertEqual(["s_routes", "s_defaults"], read["object_ids"])
        self.assertEqual(["routes", "route_defaults"], read["object_names"])
        self.assertEqual("mini.c", read["location"]["file"])
        self.assertEqual(57, read["location"]["line"])
        self.assertEqual(
            ["unresolved_or_multiple_base_objects"], read["limitations"]
        )

        self.assertEqual(
            ["s_routes", "s_defaults"], payload["selection"]["resource_ids"]
        )
        self.assertEqual("partial", payload["selection"]["resource_status"])
        self.assertEqual("ok", payload["source"]["status"])
        self.assertEqual("mini.c", payload["source"]["path"])
        self.assert_no_absolute_paths(payload)

    def test_resource_projection_all_exact_is_ready(self) -> None:
        self.import_synthetic_snapshot(
            name="snap-res-exact",
            snapshot_id="fedcba0987654321fedcba0987654321",
            payload=self._resource_graph(include_may=False),
        )
        payload = views.entry_detail(
            self.env.state,
            WORKSPACE_ID,
            "fedcba0987654321fedcba0987654321",
            "bus_send",
        )
        resources = payload["resources"]
        self.assertEqual("ready", resources["status"])
        self.assertIsNone(resources["reason"])
        self.assertEqual(
            ["field_write"], [item["access_id"] for item in resources["field_accesses"]]
        )
        self.assertEqual(["s_routes"], payload["selection"]["resource_ids"])
        self.assertEqual("ready", payload["selection"]["resource_status"])
        # Only one-hop owners are projected: the unrelated f_other access is not.
        self.assertNotIn(
            "field_outside",
            [item["access_id"] for item in resources["field_accesses"]],
        )
        self.assert_no_absolute_paths(payload)

    def test_resource_field_accesses_are_truncated_at_100(self) -> None:
        source_path = str(self.repo / "mini.c")
        evidence = [
            {"id": "e_obj", "kind": "evidence", "file": source_path, "line": 26},
            {
                "id": "e_def_entry",
                "kind": "evidence",
                "file": source_path,
                "line": 13,
                "start": 151,
                "end": 211,
                "hash": hashlib.sha256(
                    (self.repo / "mini.c").read_bytes()
                ).hexdigest(),
            },
        ]
        for index in range(105):
            evidence.append(
                {
                    "id": f"e_access_{index}",
                    "kind": "evidence",
                    "file": source_path,
                    "line": 20 + index,
                }
            )
        functions = [
            {
                "id": "f_entry",
                "name": "entry_fn",
                "display_name": "entry_fn(void)",
                "kind": "function",
                "storage": "NONE",
                "signature": "void (void)",
                "return_type": "void",
                "parameters": [],
                "evidence_ids": ["e_def_entry"],
            }
        ]
        objects = [
            {
                "id": "s_routes",
                "kind": "object",
                "name": "routes",
                "type": "struct Route[4]",
                "storage": "STATIC",
                "lifetime": "static",
                "evidence_ids": ["e_obj"],
            }
        ]
        field_accesses = [
            {
                "id": f"field_{index}",
                "owner": "f_entry",
                "access": "write",
                "certainty": "exact",
                "object_ids": ["s_routes"],
                "field_name": "max_len",
                "field_path": ["max_len"],
                "expression": "routes[channel].max_len",
                "evidence_ids": [f"e_access_{index}"],
                "limitations": [],
            }
            for index in range(105)
        ]
        graph = support.graph_payload(
            functions=functions,
            evidence=evidence,
            extra={"objects": objects, "field_accesses": field_accesses},
        )
        self.import_synthetic_snapshot(
            name="snap-res-many",
            snapshot_id="99998888777766665555444433332222",
            payload=graph,
        )
        payload = views.entry_detail(
            self.env.state,
            WORKSPACE_ID,
            "99998888777766665555444433332222",
            "f_entry",
        )
        self.assertEqual(100, len(payload["resources"]["field_accesses"]))
        self.assertTrue(payload["resources"]["truncated"])
        self.assertTrue(payload["truncated"])
        self.assert_no_absolute_paths(payload)


if __name__ == "__main__":
    unittest.main()
