"""CL-VIEW-T2 (S2a) five-view read model tests.

Three fixture tiers:

* the committed real Atlas 0.8 bus Demo snapshot
  (``evidence/code-view-slice``): coupling ``routes``/``max_len`` write-exact,
  read-may; ``bus_send`` tree; end-to-end decision/exit/external boundary;
  ``bus.c`` file tree and 174-line read; static sequence warning,
* the committed real Atlas mini snapshot (``fixtures/real-atlas/mini``) for the
  small call chain and the "no resource layer" degradation,
* synthetic Atlas-shaped payloads for budget truncation and ``ref_only`` source
  handling.

The real snapshot records absolute analyzed paths from the machine that
produced it; the tests rewrite those paths into a temporary repository (graph +
manifest only, inside the test) so path mapping, source reads and the resource
projection are exercised without depending on this checkout's machine path.
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
from typing import Any, Dict, Iterable, List, Optional, Tuple
from unittest import mock

from tests import helpers
from tests.fixtures.snapshots import support

from code_learning import five_views, snapshot as snapshot_module, source, workspace
from code_learning.errors import CodeLearningError

REPO_ROOT = Path(__file__).resolve().parents[2]
SLICE_EVIDENCE = REPO_ROOT / "evidence" / "code-view-slice"
REAL_MINI = Path(__file__).resolve().parent / "fixtures" / "real-atlas" / "mini"
REAL_MINI_REPO = Path(__file__).resolve().parent / "fixtures" / "real-atlas" / "mini-repo"

WORKSPACE_ID = "code-view-bus-demo"
MINI_WORKSPACE_ID = "code-view-mini-demo"
VARIANT_ID = "semantic-x86_64"
REPO_ID = "bus"
MINI_REPO_ID = "mini"
BUS_SEND_ID = "f_afa8298f2d197e5fd110e49a"

#: A path-like absolute string.  A first ``/`` followed by ``*`` is a C block
#: comment line (source text), not an absolute path.
_ABS_RE = re.compile(r"^(?:[A-Za-z]:[\\/]|//|/[A-Za-z0-9._~])")


def _uuid() -> str:
    return str(uuid.uuid4())


def _looks_absolute(value: str) -> bool:
    return bool(_ABS_RE.match(value))


def _iter_strings(node: Any) -> Iterable[str]:
    if isinstance(node, dict):
        for value in node.values():
            yield from _iter_strings(value)
    elif isinstance(node, list):
        for item in node:
            yield from _iter_strings(item)
    elif isinstance(node, str):
        yield node


def _rewrite_under(value: str, old_root: str, new_root: str) -> str:
    text = value.replace("\\", "/")
    old = old_root.replace("\\", "/").rstrip("/")
    if old and text.lower().startswith(old.lower()):
        suffix = text[len(old) :].lstrip("/")
        return str(Path(new_root) / suffix) if suffix else str(new_root)
    return value


class FiveViewTestBase(unittest.TestCase):
    """Temp bootstrap + registered repository + a real snapshot pair."""

    #: Subclasses point at the committed fixture directory and workspace facts.
    fixture_dir: Optional[Path] = None
    workspace_id = WORKSPACE_ID
    variant_id = VARIANT_ID
    repo_id = REPO_ID
    repo_source: Optional[Path] = None
    workspace_manifest: Optional[Dict[str, Any]] = None
    snapshot_name = "snapshot-bus"

    def setUp(self) -> None:
        if self.fixture_dir is None or not self.fixture_dir.is_dir():
            self.skipTest(f"committed snapshot fixture is missing: {self.fixture_dir}")
        self.tmp = Path(tempfile.mkdtemp(prefix="cl-five-views-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.env = helpers.make_bootstrap(self.tmp)
        self.repository = self.env.root / self._relative_repository()
        self.repository.mkdir(parents=True, exist_ok=True)
        assert self.repo_source is not None
        for source_file in sorted(self.repo_source.iterdir()):
            if source_file.is_file():
                shutil.copyfile(source_file, self.repository / source_file.name)
        helpers.write_manifest(self.env, self._manifest(), "workspace.json")
        workspace.import_workspace(self.env.state, "workspace.json", 0, _uuid())
        self.snapshot_id = self._import_fixture_snapshot()

    # -- subclass hooks ----------------------------------------------------
    def _relative_repository(self) -> str:
        return "repo"

    def _manifest(self) -> Dict[str, Any]:
        assert self.workspace_manifest is not None
        return self.workspace_manifest

    def _import_fixture_snapshot(self) -> str:
        assert self.fixture_dir is not None
        graph_document = json.loads(
            (self.fixture_dir / "graph.json").read_text(encoding="utf-8")
        )
        manifest_document = json.loads(
            (self.fixture_dir / "analysis_manifest.json").read_text(encoding="utf-8")
        )
        old_root = manifest_document["payload"]["workspace_roots"][0]
        payload = json.loads(json.dumps(graph_document["payload"]))
        for entity in payload.get("evidence") or []:
            if isinstance(entity.get("file"), str):
                entity["file"] = _rewrite_under(
                    entity["file"], old_root, str(self.repository)
                )
        snapshot_id = manifest_document["payload"]["snapshot_id"]
        overrides = {
            "snapshot_id": snapshot_id,
            "analysis_id": manifest_document["payload"]["analysis_id"],
            "input_files": {},
            "workspace_roots": [str(self.repository)],
            "workspace_revisions": {str(self.repository): "fixture-revision"},
            "coverage": json.loads(json.dumps(manifest_document["payload"]["coverage"])),
            "scope": {"mode": "interface", "interface": "submit", "direction": "down"},
        }
        helpers.write_snapshot_dir(
            self.env.inbox_dir / self.snapshot_name, payload, overrides
        )
        projection = snapshot_module.import_snapshot(
            self.env.state,
            self.workspace_id,
            self.variant_id,
            self.repo_id,
            self.snapshot_name,
            _uuid(),
        )
        return projection["snapshot_id"]

    # -- helpers -----------------------------------------------------------
    def import_synthetic(self, name: str, snapshot_id: str, payload: Dict[str, Any]) -> str:
        helpers.write_snapshot_dir(
            self.env.inbox_dir / name, payload, {"snapshot_id": snapshot_id}
        )
        projection = snapshot_module.import_snapshot(
            self.env.state,
            self.workspace_id,
            self.variant_id,
            self.repo_id,
            name,
            _uuid(),
        )
        return projection["snapshot_id"]

    def cli_json(self, *args: str, expect: int = 0) -> Dict[str, Any]:
        return helpers.cli_json(self.env.bootstrap_path, *args, expect=expect)

    def assert_single_json_object(self, *args: str) -> Dict[str, Any]:
        completed = helpers.run_cli(self.env.bootstrap_path, *args)
        lines = [line for line in completed.stdout.splitlines() if line.strip()]
        self.assertEqual(1, len(lines), f"stdout must be one JSON object: {completed.stdout!r}")
        payload = json.loads(lines[0])
        self.assertEqual(1, payload["schema_version"])
        return payload

    def assert_no_absolute_paths(self, payload: Dict[str, Any]) -> None:
        tmp_text = str(self.tmp).replace("\\", "/")
        repo_text = str(self.repository).replace("\\", "/")
        for value in _iter_strings(payload):
            self.assertFalse(
                _looks_absolute(value), f"absolute path leaked into payload: {value!r}"
            )
            normalized = value.replace("\\", "/")
            self.assertNotIn(tmp_text, normalized)
            self.assertNotIn(repo_text, normalized)

    def assert_relative_path_fields(self, payload: Dict[str, Any]) -> None:
        def walk(node: Any, key: Optional[str] = None) -> None:
            if isinstance(node, dict):
                for name, value in node.items():
                    walk(value, name)
            elif isinstance(node, list):
                for item in node:
                    walk(item, key)
            elif isinstance(node, str) and key in ("file", "path"):
                self.assertFalse(_looks_absolute(node), f"{key!r} must be relative: {node!r}")
                self.assertNotIn("..", node)

        walk(payload)


class RealBusFiveViewTest(FiveViewTestBase):
    """The committed real bus Demo snapshot (evidence/code-view-slice)."""

    fixture_dir = SLICE_EVIDENCE / "snapshot"
    workspace_manifest = {
        "schema_version": 1,
        "workspace_id": WORKSPACE_ID,
        "scope_ref": "local",
        "repositories": [
            {
                "repo_id": REPO_ID,
                "root_ref": "synthetic-root",
                "relative_path": "repo",
                "role": "other",
                "vcs": {"kind": "none", "commit": None},
            }
        ],
        "variants": [{"variant_id": VARIANT_ID, "analysis_mode": "semantic"}],
        "toolchains": [],
        "allowed_read_roots": ["synthetic-root"],
        "output_root_ref": "synthetic-root",
        "cross_repo_bindings": [],
    }

    def setUp(self) -> None:
        if self.fixture_dir is None or not self.fixture_dir.is_dir():
            self.skipTest("evidence/code-view-slice is missing")
        # The fixture_dir class attribute points at the *snapshot parent*; the
        # concrete pair directory is the single child (or a direct pair dir).
        if (self.fixture_dir / "graph.json").is_file():
            pair_dir = self.fixture_dir
        else:
            children = [child for child in self.fixture_dir.iterdir() if child.is_dir()]
            if not children:  # pragma: no cover - defensive
                self.skipTest("evidence/code-view-slice has no snapshot pair")
            pair_dir = children[0]
        self.fixture_dir = pair_dir
        self.repo_source = SLICE_EVIDENCE / "repo"
        super().setUp()

    # -- coupling ----------------------------------------------------------
    def test_coupling_entry_neighborhood_keeps_write_exact_and_read_may(self) -> None:
        payload = five_views.coupling(
            self.env.state, WORKSPACE_ID, self.snapshot_id, "bus_send"
        )
        self.assertEqual(1, payload["schema_version"])
        self.assertEqual(
            {"mode": "entry_neighborhood", "entry_id": BUS_SEND_ID}, payload["scope"]
        )
        routes = next(
            item for item in payload["resources"] if item.get("name") == "routes"
        )
        self.assertEqual("bus.c", routes["file"])
        self.assertEqual(26, routes["line"])
        self.assertEqual("struct Route[4]", routes["type"])
        self.assertEqual("STATIC", routes["storage"])
        self.assertEqual("static", routes["lifetime"])
        self.assertEqual(
            [{"field_id": "s_88f4fb0de10c49ea2fa8ceb0", "field_name": "lane", "field_path": ["lane"]},
             {"field_id": "s_8df6ff0e8e3fe13550d4621b", "field_name": "max_len", "field_path": ["max_len"]}],
            routes["fields"],
        )
        tuples = [
            (
                access["access"],
                access["certainty"],
                access["field_name"],
                (access["location"] or {}).get("line"),
            )
            for access in routes["accesses"]
        ]
        # The expected bus shape: write exact at 45/46, read may at 92/93/98
        # (candidate accesses keep their limitations, never upgraded).
        self.assertIn(("write", "exact", "max_len", 46), tuples)
        self.assertIn(("write", "exact", "lane", 45), tuples)
        self.assertIn(("read", "may", "max_len", 92), tuples)
        self.assertIn(("read", "may", "max_len", 93), tuples)
        self.assertIn(("read", "may", "max_len", 98), tuples)
        write_exact = next(
            access
            for access in routes["accesses"]
            if access["access"] == "write"
            and access["certainty"] == "exact"
            and access["field_name"] == "max_len"
        )
        self.assertEqual("store_route", write_exact["function_name"])
        self.assertEqual("bus.c", write_exact["function_file"])
        self.assertEqual(43, write_exact["function_line"])
        candidate = next(
            access
            for access in routes["accesses"]
            if access["access"] == "read" and (access["location"] or {}).get("line") == 98
        )
        self.assertEqual([], candidate["object_ids"])
        self.assertIn("unresolved_or_multiple_base_objects", candidate["limitations"])
        all_limitations = {
            limitation
            for access in routes["accesses"]
            for limitation in access["limitations"]
        }
        self.assertIn("unresolved_or_multiple_base_objects", all_limitations)

        functions = {item["name"]: item for item in payload["functions"]}
        self.assertEqual("writer", functions["store_route"]["role"])
        self.assertEqual(False, functions["store_route"]["is_entry"])
        self.assertEqual({"exact": 2, "may": 0, "unknown": 0}, functions["store_route"]["access_summary"])
        self.assertEqual("reader", functions["lookup_route"]["role"])
        self.assertIn("check_length", functions)

        edge = next(
            item
            for item in payload["edges"]
            if item["to_resource"] == routes["resource_id"]
            and item["access"] == "write"
            and item["certainty"] == "exact"
            and item["field_name"] == "max_len"
        )
        self.assertEqual("access:", edge["edge_id"][: len("access:")])
        self.assertEqual({"file": "bus.c", "line": 46}, edge["location"])
        self.assertEqual([], edge["limitations"])
        edge_ids = [item["edge_id"] for item in payload["edges"]]
        self.assertEqual(len(edge_ids), len(set(edge_ids)), "coupling edge ids must be unique")

        externals = {item["name"]: item for item in payload["external_nodes"]}
        self.assertIn("trace", externals)
        self.assertEqual("external", externals["trace"]["kind"])
        self.assertEqual("implementation_not_found", externals["trace"]["reason"])
        self.assertEqual("bus.c", externals["trace"]["file"])
        self.assertIsNone(externals["trace"]["function_id"])
        self.assertEqual("may", externals["trace"]["certainty"])

        selection = payload["selection"]
        self.assertEqual(BUS_SEND_ID, selection["entry_id"])
        self.assertIsNone(selection["focus_resource_id"])
        self.assertIsNone(selection["focus_callsite_id"])
        # S2b shared-selection extension fields are always present.
        self.assertIsNone(selection["group_id"])
        self.assertIsNone(selection["interface_id"])
        self.assertIsNone(selection["subflow_root_id"])
        gap_codes = {gap["code"] for gap in payload["gaps"]}
        # S2b implements group folding and the interface library: the S2a
        # "not implemented" claims must be gone from this endpoint.
        self.assertNotIn("interface_library", gap_codes)
        self.assertNotIn("group_collapse", gap_codes)
        self.assertIn("ai_summary", gap_codes)
        self.assert_no_absolute_paths(payload)
        self.assert_relative_path_fields(payload)

    def test_coupling_snapshot_scope_and_determinism(self) -> None:
        first = five_views.coupling(self.env.state, WORKSPACE_ID, self.snapshot_id)
        second = five_views.coupling(self.env.state, WORKSPACE_ID, self.snapshot_id)
        self.assertEqual({"mode": "snapshot", "entry_id": None}, first["scope"])
        self.assertGreater(len(first["resources"]), 1)
        self.assertEqual(
            json.dumps(first, ensure_ascii=False, sort_keys=True),
            json.dumps(second, ensure_ascii=False, sort_keys=True),
        )
        routes = next(item for item in first["resources"] if item.get("name") == "routes")
        tuples = [
            (access["access"], access["certainty"], access["field_name"], access["location"]["line"])
            for access in routes["accesses"]
        ]
        self.assertIn(("write", "exact", "max_len", 46), tuples)
        self.assertIn(("read", "may", "max_len", 98), tuples)

    # -- tree --------------------------------------------------------------
    def test_tree_bus_send_expands_calls_guards_and_returns(self) -> None:
        first = five_views.tree(self.env.state, WORKSPACE_ID, self.snapshot_id, "bus_send")
        second = five_views.tree(self.env.state, WORKSPACE_ID, self.snapshot_id, "bus_send")
        self.assertEqual(
            json.dumps(first, ensure_ascii=False, sort_keys=True),
            json.dumps(second, ensure_ascii=False, sort_keys=True),
        )
        self.assertEqual("bus_send", first["entry"]["name"])
        self.assertEqual("bus.c", first["entry"]["file"])
        self.assertEqual(152, first["entry"]["line"])
        self.assertEqual(8, first["max_depth"])
        root = first["nodes"][0]
        self.assertEqual(f"n:{BUS_SEND_ID}", root["node_id"])
        self.assertEqual("entry", root["kind"])
        self.assertIsNone(root["parent_node_id"])
        self.assertEqual(0, root["depth"])
        self.assertTrue(root["children_count"] > 0)
        root_returns = {item["expression"] for item in root["returns"]}
        self.assertIn("-90", root_returns)
        for item in root["returns"]:
            self.assertIn(item["certainty"], {"exact", "may", "unknown"})
            self.assertIn("path_insensitive", item["limitations"])

        depth_one = [node for node in first["nodes"] if node["depth"] == 1]
        names = {node["symbol"].get("name") for node in depth_one}
        self.assertTrue({"lookup_route", "check_length", "dispatch_transfer"} <= names)
        check_length = next(
            node for node in first["nodes"]
            if node["symbol"].get("name") == "check_length" and node["depth"] == 1
        )
        self.assertTrue(check_length["guards"], "check_length call site has a guard")
        self.assertIn("check_length", check_length["guards"][0]["expression"])
        self.assertEqual("call", check_length["kind"])
        self.assertEqual("c_2d6e6d665c1e95aca9ac14b8", check_length["callsite"]["callsite_id"])
        self.assertEqual(164, check_length["callsite"]["line"])
        node_ids = [node["node_id"] for node in first["nodes"]]
        self.assertEqual(len(node_ids), len(set(node_ids)))
        gap_codes = {gap["code"] for gap in first["gaps"]}
        # Groups are an end-to-end concern (contract 10.1); the tree keeps the
        # S2b "group_collapse" implementation gap out of its payload while the
        # still-missing AI summary stays explicit.
        self.assertNotIn("group_collapse", gap_codes)
        self.assertIn("ai_summary", gap_codes)
        self.assert_no_absolute_paths(first)
        self.assert_relative_path_fields(first)

    # -- end-to-end --------------------------------------------------------
    def test_end_to_end_entry_decisions_error_exit_and_external_boundary(self) -> None:
        first = five_views.end_to_end(
            self.env.state, WORKSPACE_ID, self.snapshot_id, "bus_send"
        )
        second = five_views.end_to_end(
            self.env.state, WORKSPACE_ID, self.snapshot_id, "bus_send"
        )
        self.assertEqual(
            json.dumps(first, ensure_ascii=False, sort_keys=True),
            json.dumps(second, ensure_ascii=False, sort_keys=True),
        )
        self.assertEqual("bus_send", first["entry"]["name"])
        self.assertEqual({"direction": "DOWN", "edge_routing": "ORTHOGONAL"}, first["layout"])
        self.assertEqual(
            ["exact", "may", "unknown", "error", "boundary"],
            [item["key"] for item in first["legend"]],
        )
        self.assertLessEqual(len(first["nodes"]), 120)
        self.assertLessEqual(len(first["edges"]), 240)

        entry_node = next(node for node in first["nodes"] if node["kind"] == "entry")
        self.assertEqual("bus_send", entry_node["label"])
        self.assertEqual("ellipse", entry_node["shape"])
        self.assertEqual("bus.c", entry_node["file"])
        self.assertEqual(152, entry_node["line"])

        node_by_id = {node["node_id"]: node for node in first["nodes"]}
        process_labels = {
            node["label"] for node in first["nodes"] if node["kind"] == "process"
        }
        self.assertTrue({"lookup_route", "check_length", "dispatch_transfer"} <= process_labels)

        decisions = [node for node in first["nodes"] if node["kind"] == "decision"]
        self.assertGreaterEqual(len(decisions), 3)
        self.assertTrue(all(node["shape"] == "diamond" for node in decisions))
        decision_labels = " / ".join(node["label"] or "" for node in decisions)
        self.assertIn("check_length", decision_labels)
        self.assertIn("buffered", decision_labels)
        # The invalid-argument branch guards a TRACE (external) call site; it
        # must still become a decision diamond connected to the merged external
        # boundary node, not float without a condition.
        self.assertIn("channel >= CHANNEL_COUNT", decision_labels)
        invalid_guard = next(
            node for node in decisions if "channel >= CHANNEL_COUNT" in (node["label"] or "")
        )
        self.assertEqual("decision:c_2d1d3363a37ca597c959cee5", invalid_guard["node_id"])
        self.assertTrue(
            any(
                edge["kind"] == "guard" and edge["to"] == invalid_guard["node_id"]
                for edge in first["edges"]
            )
        )
        for decision in decisions:
            self.assertEqual("diamond", decision["shape"])
            self.assertIsNotNone(decision["callsite_id"])

        exits = {item["expression"]: item for item in first["exits"]}
        self.assertIn("-90", exits)
        self.assertEqual("error", exits["-90"]["role"])
        exit_node = node_by_id[exits["-90"]["node_id"]]
        self.assertEqual("exit", exit_node["kind"])
        self.assertEqual("error", exit_node["role"])
        self.assertEqual("bus.c", exit_node["file"])
        self.assertEqual(165, exit_node["line"])
        error_edges = [
            edge
            for edge in first["edges"]
            if edge["kind"] == "return" and edge["to"] == exit_node["node_id"]
        ]
        self.assertEqual(1, len(error_edges))
        self.assertEqual({"line": "solid", "color": "exception"}, error_edges[0]["style"])

        external_nodes = [node for node in first["nodes"] if node["kind"] == "external"]
        external_labels = [node["label"] for node in external_nodes]
        # External boundaries are merged per callee name: exactly one trace
        # node and one platform_write node; every call site keeps its own edge.
        self.assertEqual(["platform_write", "trace"], sorted(external_labels))
        self.assertEqual(1, external_labels.count("trace"))
        self.assertEqual(1, external_labels.count("platform_write"))
        trace_node = next(node for node in external_nodes if node["label"] == "trace")
        self.assertEqual("external:callee:trace", trace_node["node_id"])
        self.assertGreaterEqual(trace_node["callsite_count"], 10)
        self.assertEqual(trace_node["callsite_count"], len(trace_node["callsite_ids"]))
        self.assertTrue(trace_node["caller_function_ids"])
        self.assertEqual(
            len(trace_node["caller_function_ids"]),
            len(set(trace_node["caller_function_ids"])),
        )
        self.assertLessEqual(len(trace_node["caller_function_ids"]), 20)
        self.assertEqual("may", trace_node["certainty"])
        trace_external_edges = [
            edge
            for edge in first["edges"]
            if edge["to"] == "external:callee:trace" and edge["kind"] == "external"
        ]
        self.assertEqual(trace_node["callsite_count"], len(trace_external_edges))
        self.assertTrue(all(edge["callsite_id"] for edge in trace_external_edges))
        # The external edge from the invalid-argument decision goes to the
        # merged trace node; the call-site evidence stays on that edge.
        invalid_external_edges = [
            edge
            for edge in first["edges"]
            if edge["from"] == invalid_guard["node_id"] and edge["kind"] == "external"
        ]
        self.assertEqual(1, len(invalid_external_edges))
        self.assertEqual("external:callee:trace", invalid_external_edges[0]["to"])
        self.assertEqual(
            "c_2d1d3363a37ca597c959cee5", invalid_external_edges[0]["callsite_id"]
        )
        self.assertIn("TRACE(INVALID", invalid_external_edges[0]["label"])
        self.assertTrue(invalid_external_edges[0]["evidence_ids"])

        platform_node = next(
            node for node in external_nodes if node["label"] == "platform_write"
        )
        self.assertEqual("external:callee:platform_write", platform_node["node_id"])
        self.assertEqual(1, platform_node["callsite_count"])
        self.assertEqual(
            ["f_f67649a4a3e9dcbcca8b3c1d"],
            platform_node["caller_function_ids"],
        )
        self.assertEqual("f_6c3177a5f9b67214f9855ee8", platform_node["function_id"])
        self.assertEqual("bus.c", platform_node["file"])
        self.assertEqual(113, platform_node["line"])
        self.assertEqual("platform.c", platform_node["function_file"])
        self.assertEqual(19, platform_node["function_line"])
        self.assertEqual("rectangle", platform_node["shape"])
        self.assertEqual("boundary", platform_node["role"])
        self.assertEqual("exact", platform_node["certainty"])
        platform_edges = [
            edge
            for edge in first["edges"]
            if edge["to"] == platform_node["node_id"] and edge["kind"] == "external"
        ]
        self.assertEqual(1, len(platform_edges))
        self.assertEqual(
            {"line": "dashed", "color": "normal"}, platform_edges[0]["style"]
        )
        gap_codes = {gap["code"] for gap in first["gaps"]}
        self.assertIn("callee_returns_summarized", gap_codes)
        self.assertIn("domain_boundary_heuristic", gap_codes)
        branch_gap = next(
            gap for gap in first["gaps"] if gap["code"] == "branch_conditions_partial"
        )
        self.assertEqual("degraded", branch_gap["status"])
        self.assertIn("CFG", branch_gap["reason"])
        self.assertIn("callsite", branch_gap["reason"])
        self.assert_no_absolute_paths(first)
        self.assert_relative_path_fields(first)

    # -- S2b end-to-end groups --------------------------------------------
    def test_end_to_end_private_callee_groups(self) -> None:
        first = five_views.end_to_end(
            self.env.state, WORKSPACE_ID, self.snapshot_id, "bus_send"
        )
        groups = first["groups"]
        self.assertGreaterEqual(len(groups), 2)
        grouping = first["grouping"]
        self.assertEqual("private_callee_subflow", grouping["algorithm"])
        self.assertEqual(len(groups), grouping["groups"])
        self.assertEqual(
            sum(len(group["member_function_ids"]) for group in groups),
            grouping["members"],
        )
        self.assertTrue(
            any(
                gap["code"] == "group_semantics" and gap["status"] == "degraded"
                for gap in grouping["gaps"]
            )
        )
        node_by_id = {node["node_id"]: node for node in first["nodes"]}
        node_ids = set(node_by_id)
        names_by_group: Dict[str, List[str]] = {}
        for group in groups:
            self.assertRegex(group["group_id"], r"^group:f_[0-9a-f]+:[0-9a-f]{8}$")
            self.assertTrue(group["label"].endswith("下游子流程"))
            self.assertIn("仅被", group["description"])
            self.assertTrue(group["collapsed_default"])
            self.assertEqual("structural_heuristic", group["origin"])
            self.assertEqual(
                ["group_structural_heuristic", "group_name_not_semantic"],
                group["limitations"],
            )
            self.assertEqual(
                len(group["member_node_ids"]), len(group["member_function_ids"])
            )
            for node_id in group["member_node_ids"]:
                self.assertIn(node_id, node_ids)
                self.assertEqual("process", node_by_id[node_id]["kind"])
            for node_id in group["entry_node_ids"] + group["exit_node_ids"]:
                self.assertIn(node_id, group["member_node_ids"])
            self.assertTrue(group["evidence_ids"])
            names_by_group[group["label"]] = [
                node_by_id[node_id]["label"] for node_id in group["member_node_ids"]
            ]

        dispatch_group = next(
            group for group in groups if "dispatch_transfer" in group["label"]
        )
        self.assertEqual(
            ["submit_buffered", "submit_direct"],
            names_by_group[dispatch_group["label"]],
        )
        self.assertEqual(
            [
                "fn:f_a6ac5de30cf631400f29d67e",
                "fn:f_bc0e6086fe5e9c1faa1eeeb6",
            ],
            dispatch_group["member_node_ids"],
        )
        self.assertEqual(
            dispatch_group["member_node_ids"], dispatch_group["entry_node_ids"]
        )
        self.assertEqual(
            dispatch_group["member_node_ids"], dispatch_group["exit_node_ids"]
        )
        self.assertIsNone(dispatch_group["parent_group_id"])

        commit_group = next(
            group for group in groups if "commit_transfer" in group["label"]
        )
        self.assertEqual(
            ["encode_doorbell", "write_doorbell"],
            names_by_group[commit_group["label"]],
        )
        # Both members have edges leaving the group (external TRACE calls and
        # the platform_write handoff), so both are exit ports.
        self.assertEqual(
            [
                "fn:f_87403babddf39338cdbd3f69",
                "fn:f_f67649a4a3e9dcbcca8b3c1d",
            ],
            commit_group["exit_node_ids"],
        )
        self.assertEqual(
            [
                "fn:f_87403babddf39338cdbd3f69",
                "fn:f_f67649a4a3e9dcbcca8b3c1d",
            ],
            commit_group["entry_node_ids"],
        )

        # Shared functions (more than one projected caller) never join a group.
        all_members = {fid for group in groups for fid in group["member_function_ids"]}
        self.assertNotIn("f_ec61140249f393550eb97946", all_members)  # commit_transfer
        self.assertNotIn("f_dfb9aead445405de7aafbbfa", all_members)  # store_route
        # Groups are an additive projection: S2a nodes/edges keep their shape.
        self.assertEqual(19, len(first["nodes"]))
        self.assertEqual(31, len(first["edges"]))
        self.assertFalse(first["truncated"])
        self.assert_no_absolute_paths(first)
        self.assert_relative_path_fields(first)

    def test_breadcrumb_subflow_paths(self) -> None:
        state = self.env.state
        main = five_views.end_to_end(
            state, WORKSPACE_ID, self.snapshot_id, "bus_send"
        )
        self.assertEqual([], main["breadcrumb"])
        self.assertIsNone(main["selection"]["subflow_root_id"])

        subflow = five_views.end_to_end(
            state, WORKSPACE_ID, self.snapshot_id, "check_length", root_ref="bus_send"
        )
        breadcrumb = subflow["breadcrumb"]
        self.assertEqual(
            ["bus_send", "check_length"], [item["name"] for item in breadcrumb]
        )
        self.assertEqual(BUS_SEND_ID, breadcrumb[0]["function_id"])
        self.assertEqual("f_b19a05b7a8457000a4562e91", breadcrumb[-1]["function_id"])
        self.assertEqual("bus.c", breadcrumb[1]["file"])
        self.assertEqual(96, breadcrumb[1]["line"])
        self.assertEqual(
            "c_2d6e6d665c1e95aca9ac14b8", breadcrumb[1]["callsite_id"]
        )
        self.assertNotIn("callsite_id", breadcrumb[0])
        self.assertEqual(BUS_SEND_ID, subflow["selection"]["subflow_root_id"])
        self.assertEqual(BUS_SEND_ID, subflow["root"])
        self.assertEqual("check_length", subflow["entry"]["name"])
        self.assertLessEqual(len(breadcrumb), 21)

        same_root = five_views.end_to_end(
            state, WORKSPACE_ID, self.snapshot_id, "bus_send", root_ref="bus_send"
        )
        self.assertEqual([], same_root["breadcrumb"])
        self.assertIsNone(same_root["selection"]["subflow_root_id"])

        unreachable = five_views.end_to_end(
            state,
            WORKSPACE_ID,
            self.snapshot_id,
            "check_length",
            root_ref="write_doorbell",
        )
        self.assertEqual([], unreachable["breadcrumb"])
        unavailable = next(
            gap
            for gap in unreachable["gaps"]
            if gap["code"] == "breadcrumb_unavailable"
        )
        self.assertEqual("unavailable", unavailable["status"])
        self.assertIn("20", unavailable["reason"])
        self.assert_no_absolute_paths(subflow)
        self.assert_no_absolute_paths(unreachable)

    # -- S2b interface library --------------------------------------------
    def test_interfaces_platform_write_and_independent_candidates(self) -> None:
        first = five_views.interfaces(self.env.state, WORKSPACE_ID, self.snapshot_id)
        second = five_views.interfaces(self.env.state, WORKSPACE_ID, self.snapshot_id)
        self.assertEqual(
            json.dumps(first, ensure_ascii=False, sort_keys=True),
            json.dumps(second, ensure_ascii=False, sort_keys=True),
        )
        candidates = first["candidates"]
        self.assertGreaterEqual(len(candidates), 5)
        self.assertLessEqual(len(candidates), 100)
        scores = [candidate["score"] for candidate in candidates]
        self.assertEqual(scores, sorted(scores, reverse=True), "score descending")
        for candidate in candidates:
            self.assertEqual("may", candidate["certainty"])
            self.assertEqual(
                ["candidate_rule_based_not_semantic"], candidate["limitations"]
            )
            self.assertIn(
                "stable_signature", [reason["code"] for reason in candidate["reasons"]]
            )
            self.assertIn(candidate["decoupling"], {"independent", "mixed", "unknown"})
            self.assertIn("interface_id", candidate)
            self.assertEqual(
                f"iface:{candidate['function_id']}", candidate["interface_id"]
            )
            self.assertIn("parameters", candidate)
            self.assertIn("return_type", candidate)
            self.assertIn("callers", candidate)
            self.assertIn("input_guards", candidate)
            self.assertIn("field_accesses", candidate)
        by_name = {candidate["name"]: candidate for candidate in candidates}

        platform_write = by_name["platform_write"]
        self.assertTrue(platform_write["cross_file"])
        self.assertTrue(platform_write["leaf"])
        self.assertEqual("mixed", platform_write["decoupling"])
        self.assertIn(
            "side_effects_present",
            [reason["code"] for reason in platform_write["reasons"]],
        )
        writes = [
            effect
            for effect in platform_write["field_accesses"]
            if effect["access"] in {"write", "rmw", "init", "deinit", "alloc", "free", "acquire", "release"}
        ]
        self.assertTrue(
            any(
                effect["field_name"] == "simulated_doorbell"
                and effect["location"] == {"file": "platform.c", "line": 25}
                for effect in writes
            ),
            "platform_write writes the simulated_doorbell register",
        )
        self.assertEqual("platform.c", platform_write["file"])
        self.assertEqual(19, platform_write["line"])
        self.assertEqual("int (unsigned int, unsigned int)", platform_write["signature"])
        self.assertEqual("int", platform_write["return_type"])
        self.assertEqual(
            [{"name": "address", "type": "unsigned int"}, {"name": "value", "type": "unsigned int"}],
            platform_write["parameters"],
        )
        self.assertEqual(1, platform_write["call_count"])
        self.assertEqual("write_doorbell", platform_write["callers"][0]["name"])
        self.assertEqual(
            {"file": "bus.c", "line": 113}, platform_write["callers"][0]["location"]
        )
        self.assertEqual("c_a9a49f2229277208d6ae0cac", platform_write["callers"][0]["callsite_id"])
        self.assertLess(platform_write["score"], 5)

        independent = {
            candidate["name"]
            for candidate in candidates
            if candidate["decoupling"] == "independent"
        }
        self.assertGreaterEqual(
            len(independent & {"lookup_route", "check_length", "encode_doorbell"}), 2
        )
        for name in ("lookup_route", "check_length", "encode_doorbell"):
            self.assertIn(name, by_name)
        for name in ("lookup_route", "check_length", "encode_doorbell"):
            candidate = by_name[name]
            writes = [
                effect
                for effect in candidate["field_accesses"]
                if effect["access"] in {"write", "rmw", "init", "deinit", "alloc", "free", "acquire", "release"}
            ]
            self.assertEqual([], writes)
            self.assertTrue(candidate["leaf"])
        self.assertTrue(by_name["check_length"]["input_guards"])
        self.assertIn(
            "input_guards_present",
            [reason["code"] for reason in by_name["check_length"]["reasons"]],
        )
        self.assertEqual(
            "c_2d6e6d665c1e95aca9ac14b8",
            by_name["check_length"]["input_guards"][0]["callsite_id"],
        )

        external_boundaries = {
            item["callee"]: item for item in first["external_boundaries"]
        }
        self.assertIn("trace", external_boundaries)
        self.assertEqual(22, external_boundaries["trace"]["call_count"])
        self.assertEqual(22, len(external_boundaries["trace"]["callsite_ids"]))
        self.assert_no_absolute_paths(first)
        self.assert_relative_path_fields(first)

    def test_interfaces_entry_scope_and_cli(self) -> None:
        scoped = five_views.interfaces(
            self.env.state, WORKSPACE_ID, self.snapshot_id, "bus_send"
        )
        names = {candidate["name"] for candidate in scoped["candidates"]}
        self.assertIn("platform_write", names)
        self.assertIn("lookup_route", names)
        self.assertNotIn("platform_reset", names)
        self.assertNotIn("store_route", names)
        self.assertEqual(BUS_SEND_ID, scoped["selection"]["entry_id"])
        self.assertIsNone(scoped["selection"]["interface_id"])
        self.assert_no_absolute_paths(scoped)

        payload = self.assert_single_json_object(
            "view-interfaces",
            "--workspace",
            WORKSPACE_ID,
            "--snapshot",
            self.snapshot_id,
        )
        for key in ("candidates", "external_boundaries", "gaps", "truncated"):
            self.assertIn(key, payload)
        scoped_payload = self.assert_single_json_object(
            "view-interfaces",
            "--workspace",
            WORKSPACE_ID,
            "--snapshot",
            self.snapshot_id,
            "--entry",
            "bus_send",
        )
        self.assertIn(
            "platform_write", {item["name"] for item in scoped_payload["candidates"]}
        )
        subflow = self.assert_single_json_object(
            "view-end-to-end",
            "--workspace",
            WORKSPACE_ID,
            "--snapshot",
            self.snapshot_id,
            "--entry",
            "check_length",
            "--root",
            "bus_send",
        )
        self.assertEqual(
            ["bus_send", "check_length"],
            [item["name"] for item in subflow["breadcrumb"]],
        )
        self.assertIn("groups", subflow)
        self.assertIn("grouping", subflow)
        completed = helpers.run_cli(
            self.env.bootstrap_path,
            "view-end-to-end",
            "--workspace",
            WORKSPACE_ID,
            "--snapshot",
            self.snapshot_id,
            "--entry",
            "check_length",
            "--root",
            "f_does_not_exist",
            expect=2,
        )
        self.assertEqual("NOT_FOUND", json.loads(completed.stdout)["error"]["code"])
        completed = helpers.run_cli(
            self.env.bootstrap_path,
            "view-interfaces",
            "--workspace",
            "no-such-workspace",
            "--snapshot",
            self.snapshot_id,
            expect=2,
        )
        self.assertEqual("NOT_FOUND", json.loads(completed.stdout)["error"]["code"])
        completed = helpers.run_cli(
            self.env.bootstrap_path,
            "view-interfaces",
            "--workspace",
            WORKSPACE_ID,
            "--snapshot",
            self.snapshot_id,
            "--entry",
            "f_does_not_exist",
            expect=2,
        )
        self.assertEqual("NOT_FOUND", json.loads(completed.stdout)["error"]["code"])

    # -- file tree / file read --------------------------------------------
    def test_file_tree_lists_only_snapshot_evidence_files(self) -> None:
        payload = five_views.file_tree(self.env.state, WORKSPACE_ID, self.snapshot_id)
        self.assertEqual(1, len(payload["repos"]))
        repo = payload["repos"][0]
        self.assertEqual("bus", repo["repo_id"])
        self.assertEqual("other", repo["role"])
        self.assertFalse(repo["truncated"])
        files = {item["path"]: item for item in repo["files"]}
        self.assertEqual(["bus.c", "platform.c"], [item["path"] for item in repo["files"]])
        self.assertEqual(4744, files["bus.c"]["bytes"])
        self.assertEqual(751, files["platform.c"]["bytes"])
        self.assertEqual(
            hashlib.sha256((self.repository / "bus.c").read_bytes()).hexdigest(),
            files["bus.c"]["sha256"],
        )
        self.assertTrue(files["bus.c"]["has_evidence"])
        self.assertEqual([], payload["gaps"])
        self.assertFalse(payload["truncated"])
        self.assert_no_absolute_paths(payload)

    def test_file_read_bus_c_lines_and_replayable_evidence(self) -> None:
        payload = five_views.file_read(
            self.env.state, WORKSPACE_ID, self.snapshot_id, REPO_ID, "bus.c"
        )
        self.assertEqual("bus", payload["repo_id"])
        self.assertEqual("bus.c", payload["path"])
        self.assertEqual("ok", payload["status"])
        self.assertIsNone(payload["reason"])
        self.assertEqual(4744, payload["bytes"])
        self.assertEqual(174, payload["total_lines"])
        self.assertEqual(174, len(payload["lines"]))
        self.assertEqual(1, payload["line_start"])
        self.assertEqual(174, payload["line_end"])
        self.assertFalse(payload["truncated"])
        line_by_number = {item["n"]: item["text"] for item in payload["lines"]}
        self.assertEqual("enum Event {", line_by_number[1])
        self.assertEqual("    routes[channel].max_len = max_len;", line_by_number[46])
        self.assertEqual("}", line_by_number[174])
        self.assertIsNotNone(payload["evidence_ref"])
        self.assertEqual(1, len(payload["evidence_refs"]))
        replay = source.read_evidence(
            self.env.state, WORKSPACE_ID, payload["evidence_ref"]
        )
        self.assertIn("routes[channel].max_len = max_len;", replay["safe_text"])
        self.assertEqual(1, replay["evidence"]["line_start"])
        self.assertEqual(174, replay["evidence"]["line_end"])
        self.assert_no_absolute_paths(payload)

    def test_file_read_line_budget_and_stale_hash(self) -> None:
        bounded = five_views.file_read(
            self.env.state, WORKSPACE_ID, self.snapshot_id, REPO_ID, "bus.c", max_lines=5
        )
        self.assertEqual(5, len(bounded["lines"]))
        self.assertEqual(5, bounded["line_end"])
        self.assertTrue(bounded["truncated"])
        self.assertIn(
            "file_read_truncated", {gap["code"] for gap in bounded["gaps"]}
        )
        expected_line_five = (
            (self.repository / "bus.c")
            .read_text(encoding="utf-8")
            .splitlines()[4]
        )
        self.assertEqual(expected_line_five, bounded["lines"][4]["text"])

        (self.repository / "bus.c").write_bytes(
            (self.repository / "bus.c").read_bytes() + b"\n"
        )
        with self.assertRaises(CodeLearningError) as context:
            five_views.file_read(
                self.env.state, WORKSPACE_ID, self.snapshot_id, REPO_ID, "bus.c"
            )
        self.assertEqual("STALE_SOURCE", context.exception.code)
        completed = helpers.run_cli(
            self.env.bootstrap_path,
            "view-file-read",
            "--workspace",
            WORKSPACE_ID,
            "--snapshot",
            self.snapshot_id,
            "--repo",
            REPO_ID,
            "--path",
            "bus.c",
            expect=2,
        )
        self.assertEqual("STALE_SOURCE", json.loads(completed.stdout)["error"]["code"])

    def test_file_read_unknown_and_unreferenced_paths(self) -> None:
        completed = helpers.run_cli(
            self.env.bootstrap_path,
            "view-file-read",
            "--workspace",
            WORKSPACE_ID,
            "--snapshot",
            self.snapshot_id,
            "--repo",
            REPO_ID,
            "--path",
            "does-not-exist.c",
            expect=2,
        )
        self.assertEqual("NOT_FOUND", json.loads(completed.stdout)["error"]["code"])
        for bad_path in ("../escape.c", "/absolute.c", "src\\win.c"):
            completed = helpers.run_cli(
                self.env.bootstrap_path,
                "view-file-read",
                "--workspace",
                WORKSPACE_ID,
                "--snapshot",
                self.snapshot_id,
                "--repo",
                REPO_ID,
                "--path",
                bad_path,
                expect=2,
            )
            self.assertEqual(
                "INVALID_ARGUMENT", json.loads(completed.stdout)["error"]["code"]
            )

    # -- static sequence ---------------------------------------------------
    def test_sequence_static_warning_participants_and_messages(self) -> None:
        payload = five_views.sequence_static(
            self.env.state, WORKSPACE_ID, self.snapshot_id, "bus_send"
        )
        self.assertEqual("static", payload["mode"])
        self.assertFalse(payload["observed"])
        self.assertIn("静态预测", payload["warning"])
        self.assertIn("无运行观测", payload["warning"])
        participant_ids = [item["participant_id"] for item in payload["participants"]]
        for required in ("caller", "driver", "resource", "platform", "external"):
            self.assertIn(required, participant_ids)
        self.assertLessEqual(len(payload["messages"]), 200)
        message_ids = [message["message_id"] for message in payload["messages"]]
        self.assertEqual(len(message_ids), len(set(message_ids)))
        self.assertEqual(
            [f"m_{index + 1}" for index in range(len(message_ids))], message_ids
        )
        labels = " | ".join(message["label"] or "" for message in payload["messages"])
        for name in ("bus_send", "lookup_route", "check_length", "platform_write"):
            self.assertIn(name, labels)
        kinds = {message["kind"] for message in payload["messages"]}
        self.assertTrue(kinds <= {"call", "return", "access", "external", "error"})
        self.assertIn("access", kinds)
        self.assertIn("external", kinds)
        for message in payload["messages"]:
            self.assertIn(message["certainty"], {"exact", "may", "unknown"})
            self.assertIn(message["from"], participant_ids)
            self.assertIn(message["to"], participant_ids)
            self.assertEqual(BUS_SEND_ID, message["entry_id"])
        platform_messages = [
            message for message in payload["messages"] if message["to"] == "platform"
        ]
        self.assertTrue(platform_messages)
        self.assertTrue(any("platform_write" in (message["label"] or "") for message in platform_messages))
        gap_codes = {gap["code"] for gap in payload["gaps"]}
        self.assertIn("run_observation", gap_codes)
        self.assertIn("scenario_execution", gap_codes)
        self.assert_no_absolute_paths(payload)

    # -- CLI wiring --------------------------------------------------------
    def test_cli_six_commands_single_json_contract(self) -> None:
        common = ("--workspace", WORKSPACE_ID, "--snapshot", self.snapshot_id)
        commands: List[List[str]] = [
            ["view-coupling", "--entry", "bus_send", *common],
            ["view-coupling", *common],
            ["view-tree", "--entry", "bus_send", *common],
            ["view-end-to-end", "--entry", "bus_send", *common],
            ["view-end-to-end", "--entry", "check_length", "--root", "bus_send", *common],
            ["view-interfaces", *common],
            ["view-interfaces", "--entry", "bus_send", *common],
            ["view-file-tree", *common],
            ["view-file-read", "--repo", REPO_ID, "--path", "bus.c", *common],
            ["view-file-read", "--repo", REPO_ID, "--path", "bus.c", "--max-lines", "10", *common],
            ["view-sequence", "--entry", "bus_send", *common],
            ["view-sequence", "--entry", "bus_send", "--mode", "static", *common],
        ]
        expectations: List[Tuple[str, ...]] = [
            ("scope", "resources", "functions", "edges", "external_nodes"),
            ("scope", "resources", "functions", "edges", "external_nodes"),
            ("entry", "nodes", "max_depth"),
            ("entry", "nodes", "edges", "exits", "legend", "layout", "groups", "grouping"),
            ("entry", "nodes", "edges", "exits", "legend", "layout", "groups", "grouping", "breadcrumb"),
            ("candidates", "external_boundaries"),
            ("candidates", "external_boundaries"),
            ("repos",),
            ("repo_id", "path", "lines", "evidence_ref"),
            ("repo_id", "path", "lines", "evidence_ref"),
            ("mode", "observed", "warning", "participants", "messages"),
            ("mode", "observed", "warning", "participants", "messages"),
        ]
        for args, keys in zip(commands, expectations):
            with self.subTest(command=args[0]):
                payload = self.assert_single_json_object(*args)
                self.assertIn("snapshot", payload)
                self.assertIn("selection", payload)
                self.assertIn("gaps", payload)
                for key in keys:
                    self.assertIn(key, payload)
                self.assert_no_absolute_paths(payload)

    def test_unknown_entry_and_workspace_errors(self) -> None:
        for command in ("view-tree", "view-end-to-end", "view-sequence"):
            completed = helpers.run_cli(
                self.env.bootstrap_path,
                command,
                "--workspace",
                WORKSPACE_ID,
                "--snapshot",
                self.snapshot_id,
                "--entry",
                "f_does_not_exist",
                expect=2,
            )
            self.assertEqual("NOT_FOUND", json.loads(completed.stdout)["error"]["code"])
        completed = helpers.run_cli(
            self.env.bootstrap_path,
            "view-coupling",
            "--workspace",
            WORKSPACE_ID,
            "--snapshot",
            self.snapshot_id,
            "--entry",
            "f_does_not_exist",
            expect=2,
        )
        self.assertEqual("NOT_FOUND", json.loads(completed.stdout)["error"]["code"])
        completed = helpers.run_cli(
            self.env.bootstrap_path,
            "view-file-tree",
            "--workspace",
            "no-such-workspace",
            "--snapshot",
            self.snapshot_id,
            expect=2,
        )
        self.assertEqual("NOT_FOUND", json.loads(completed.stdout)["error"]["code"])


class MiniFiveViewTest(FiveViewTestBase):
    """Committed real mini snapshot: small chain and no resource layer."""

    fixture_dir = REAL_MINI
    workspace_id = MINI_WORKSPACE_ID
    repo_id = MINI_REPO_ID
    snapshot_name = "snapshot-mini"
    repo_source = REAL_MINI_REPO
    workspace_manifest = {
        "schema_version": 1,
        "workspace_id": MINI_WORKSPACE_ID,
        "scope_ref": "local",
        "repositories": [
            {
                "repo_id": MINI_REPO_ID,
                "root_ref": "synthetic-root",
                "relative_path": "mini-repo",
                "role": "other",
                "vcs": {"kind": "none", "commit": None},
            }
        ],
        "variants": [{"variant_id": VARIANT_ID, "analysis_mode": "source_only"}],
        "toolchains": [],
        "allowed_read_roots": ["synthetic-root"],
        "output_root_ref": "synthetic-root",
        "cross_repo_bindings": [],
    }

    def _relative_repository(self) -> str:
        return "mini-repo"

    def test_tree_small_chain(self) -> None:
        payload = five_views.tree(
            self.env.state, MINI_WORKSPACE_ID, self.snapshot_id, "submit"
        )
        names = [
            (node["depth"], node["kind"], node["symbol"].get("name"))
            for node in payload["nodes"]
        ]
        self.assertEqual(
            [
                (0, "entry", "submit"),
                (1, "call", "clamp_value"),
                (2, "call", "normalize"),
            ],
            names,
        )
        self.assertEqual("mini.c", payload["nodes"][0]["symbol"]["file"])
        self.assertEqual(13, payload["nodes"][0]["symbol"]["line"])
        self.assert_no_absolute_paths(payload)

    def test_file_tree_and_read_for_mini_repo(self) -> None:
        tree_payload = five_views.file_tree(
            self.env.state, MINI_WORKSPACE_ID, self.snapshot_id
        )
        files = tree_payload["repos"][0]["files"]
        self.assertEqual(["mini.c"], [item["path"] for item in files])
        self.assertEqual(212, files[0]["bytes"])
        read_payload = five_views.file_read(
            self.env.state, MINI_WORKSPACE_ID, self.snapshot_id, MINI_REPO_ID, "mini.c"
        )
        self.assertEqual(16, read_payload["total_lines"])
        self.assertEqual(16, len(read_payload["lines"]))
        self.assertEqual("int submit(int value)", read_payload["lines"][12]["text"])
        self.assertEqual("mini.c", read_payload["path"])
        self.assert_no_absolute_paths(read_payload)

    def test_coupling_without_resource_layer_is_explicit_gap(self) -> None:
        payload = five_views.coupling(
            self.env.state, MINI_WORKSPACE_ID, self.snapshot_id, "submit"
        )
        self.assertEqual(
            {"mode": "entry_neighborhood", "entry_id": "f_8cd01e11ce71edcc3a5a5e66"},
            payload["scope"],
        )
        self.assertEqual([], payload["resources"])
        self.assertEqual([], payload["functions"])
        self.assertEqual([], payload["edges"])
        gap_codes = {gap["code"] for gap in payload["gaps"]}
        self.assertIn("resource_graph", gap_codes)
        resource_gap = next(
            gap for gap in payload["gaps"] if gap["code"] == "resource_graph"
        )
        self.assertEqual("unavailable", resource_gap["status"])
        self.assertIn("no_resource", resource_gap["reason"])
        self.assertEqual("unavailable", payload["selection"]["resource_status"])
        self.assert_no_absolute_paths(payload)

    def test_sequence_static_small_chain(self) -> None:
        payload = five_views.sequence_static(
            self.env.state, MINI_WORKSPACE_ID, self.snapshot_id, "submit"
        )
        self.assertFalse(payload["observed"])
        self.assertEqual("static", payload["mode"])
        self.assertIn("静态预测", payload["warning"])
        labels = " | ".join(message["label"] or "" for message in payload["messages"])
        for name in ("submit", "clamp_value", "normalize"):
            self.assertIn(name, labels)
        self.assertIn(
            "run_observation", {gap["code"] for gap in payload["gaps"]}
        )
        self.assert_no_absolute_paths(payload)


class SyntheticBudgetAndDegradationTest(FiveViewTestBase):
    """Synthetic Atlas-shaped payloads for budgets and ref-only source reads."""

    fixture_dir = RealBusFiveViewTest.fixture_dir
    workspace_manifest = RealBusFiveViewTest.workspace_manifest
    repo_source = SLICE_EVIDENCE / "repo"

    def setUp(self) -> None:
        if not (SLICE_EVIDENCE / "repo").is_dir():
            self.skipTest("evidence/code-view-slice is missing")
        if self.fixture_dir is not None and self.fixture_dir.is_dir():
            if (self.fixture_dir / "graph.json").is_file():
                pass
            else:
                children = [
                    child for child in self.fixture_dir.iterdir() if child.is_dir()
                ]
                if children:
                    self.fixture_dir = children[0]
        super().setUp()

    # -- budgets -----------------------------------------------------------
    def test_tree_node_budget(self) -> None:
        functions = [support.function("f_root", "root_fn", file="src/tree.c", line=1)]
        callsites: List[Dict[str, Any]] = []
        evidence: List[Dict[str, Any]] = []
        targets: List[Dict[str, Any]] = []
        for index in range(600):
            leaf_id = f"f_leaf_{index}"
            functions.append(
                support.function(leaf_id, f"leaf_{index}", file="src/tree.c", line=10 + index)
            )
            callsites.append(
                support.callsite(f"c_leaf_{index}", owner="f_root", file="src/tree.c", line=10 + index)
            )
            evidence.append(
                support.evidence(f"e_leaf_{index}", file="src/tree.c", line=10 + index)
            )
            targets.append(
                support.call_target(
                    f"edge_leaf_{index}",
                    callsite=f"c_leaf_{index}",
                    source="f_root",
                    target=leaf_id,
                    evidence=[f"e_leaf_{index}"],
                )
            )
        payload = support.graph_payload(
            functions=functions,
            callsites=callsites,
            call_targets=targets,
            evidence=evidence,
        )
        snapshot_id = self.import_synthetic("snap-tree-budget", "aaaa0000bbbb1111cccc2222dddd3333", payload)
        result = five_views.tree(self.env.state, WORKSPACE_ID, snapshot_id, "root_fn")
        self.assertEqual(500, len(result["nodes"]))
        self.assertTrue(result["truncated"])
        self.assertIn("tree_truncated", {gap["code"] for gap in result["gaps"]})

    def test_end_to_end_function_budget(self) -> None:
        functions = [support.function("f_root", "root_fn", file="src/e2e.c", line=1)]
        callsites: List[Dict[str, Any]] = []
        evidence: List[Dict[str, Any]] = []
        targets: List[Dict[str, Any]] = []
        for index in range(130):
            leaf_id = f"f_leaf_{index}"
            functions.append(
                support.function(leaf_id, f"leaf_{index}", file="src/e2e.c", line=10 + index)
            )
            callsites.append(
                support.callsite(f"c_leaf_{index}", owner="f_root", file="src/e2e.c", line=10 + index)
            )
            evidence.append(
                support.evidence(f"e_leaf_{index}", file="src/e2e.c", line=10 + index)
            )
            targets.append(
                support.call_target(
                    f"edge_leaf_{index}",
                    callsite=f"c_leaf_{index}",
                    source="f_root",
                    target=leaf_id,
                    evidence=[f"e_leaf_{index}"],
                )
            )
        payload = support.graph_payload(
            functions=functions,
            callsites=callsites,
            call_targets=targets,
            evidence=evidence,
        )
        snapshot_id = self.import_synthetic("snap-e2e-budget", "eeee0000ffff1111aaaa2222bbbb3333", payload)
        result = five_views.end_to_end(self.env.state, WORKSPACE_ID, snapshot_id, "root_fn")
        self.assertTrue(result["truncated"])
        self.assertIn(
            "end_to_end_functions_truncated",
            {gap["code"] for gap in result["gaps"]},
        )
        self.assertLessEqual(len(result["nodes"]), 120)
        self.assertLessEqual(len(result["edges"]), 240)

    def test_sequence_message_budget(self) -> None:
        callsites = [
            {
                "id": f"c_trace_{index}",
                "owner": "f_root",
                "file": "src/s.c",
                "line": 10 + index,
                "callee": "trace",
                "expression": f"TRACE(EVENT, {index}, 0, 0)",
            }
            for index in range(250)
        ]
        payload = support.graph_payload(
            functions=[support.function("f_root", "root_fn", file="src/s.c", line=1)],
            callsites=callsites,
        )
        snapshot_id = self.import_synthetic("snap-seq-budget", "1111aaaa2222bbbb3333cccc4444dddd", payload)
        result = five_views.sequence_static(
            self.env.state, WORKSPACE_ID, snapshot_id, "root_fn"
        )
        self.assertEqual(200, len(result["messages"]))
        self.assertTrue(result["truncated"])
        self.assertIn("sequence_truncated", {gap["code"] for gap in result["gaps"]})
        self.assertIn("run_observation", {gap["code"] for gap in result["gaps"]})

    def test_coupling_resource_and_access_budgets(self) -> None:
        functions = [support.function("f_entry", "entry_fn", file="src/c.c", line=1)]
        objects: List[Dict[str, Any]] = []
        evidence: List[Dict[str, Any]] = []
        field_accesses: List[Dict[str, Any]] = []
        for index in range(120):
            object_id = f"s_obj_{index:03d}"
            objects.append(
                {
                    "id": object_id,
                    "kind": "object",
                    "name": f"obj_{index:03d}",
                    "type": "struct R",
                    "storage": "STATIC",
                    "lifetime": "static",
                    "evidence_ids": [f"e_obj_{index:03d}"],
                }
            )
            evidence.append(
                support.evidence(
                    f"e_obj_{index:03d}", file="src/c.c", line=100 + index
                )
            )
            for slot in range(5):
                access_id = f"field_{index:03d}_{slot}"
                evidence.append(
                    support.evidence(
                        f"e_acc_{index:03d}_{slot}",
                        file="src/c.c",
                        line=200 + index * 5 + slot,
                    )
                )
                field_accesses.append(
                    {
                        "id": access_id,
                        "owner": "f_entry",
                        "access": "write" if slot % 2 else "read",
                        "certainty": "may",
                        "object_ids": [object_id],
                        "field_name": "value",
                        "field_path": ["value"],
                        "expression": f"obj_{index:03d}.value",
                        "evidence_ids": [f"e_acc_{index:03d}_{slot}"],
                        "limitations": [],
                    }
                )
        payload = support.graph_payload(
            functions=functions,
            evidence=evidence,
            extra={"objects": objects, "field_accesses": field_accesses},
        )
        snapshot_id = self.import_synthetic("snap-coupling-budget", "abcd0000abcd1111abcd2222abcd3333", payload)
        result = five_views.coupling(self.env.state, WORKSPACE_ID, snapshot_id)
        self.assertEqual(100, len(result["resources"]))
        self.assertLessEqual(len(result["edges"]), 400)
        self.assertTrue(result["truncated"])
        gap_codes = {gap["code"] for gap in result["gaps"]}
        self.assertIn("coupling_resources_truncated", gap_codes)
        self.assertIn("coupling_accesses_truncated", gap_codes)
        self.assert_no_absolute_paths(result)

    def test_file_tree_budget_and_unmapped_gap(self) -> None:
        evidence = [
            support.evidence(f"e_file_{index:04d}", file=f"src/f{index:04d}.c", line=1)
            for index in range(2001)
        ]
        payload = support.graph_payload(evidence=evidence)
        snapshot_id = self.import_synthetic("snap-filetree-budget", "9999aaaa8888bbbb7777cccc6666dddd", payload)
        result = five_views.file_tree(self.env.state, WORKSPACE_ID, snapshot_id)
        files = [
            file
            for repo in result["repos"]
            for file in repo["files"]
        ]
        self.assertEqual(2000, len(files))
        self.assertTrue(result["truncated"])
        gap_codes = {gap["code"] for gap in result["gaps"]}
        self.assertIn("file_tree_truncated", gap_codes)
        self.assertIn("file_source_unavailable", gap_codes)

        outside = str(self.tmp / "outside" / "hidden.c")
        unmapped_payload = support.graph_payload(
            evidence=[
                support.evidence("e_outside", file=outside, line=1),
                support.evidence("e_ok", file="src/in-repo.c", line=1),
            ]
        )
        unmapped_id = self.import_synthetic("snap-unmapped", "0000aaaa1111bbbb2222cccc3333dddd", unmapped_payload)
        unmapped = five_views.file_tree(self.env.state, WORKSPACE_ID, unmapped_id)
        paths = [file["path"] for repo in unmapped["repos"] for file in repo["files"]]
        self.assertEqual(["src/in-repo.c"], paths)
        self.assertIn("file_unmapped", {gap["code"] for gap in unmapped["gaps"]})
        self.assert_no_absolute_paths(unmapped)

    def test_file_read_ref_only_secret(self) -> None:
        secret_bytes = b'static const char *password = "hunter2";\n'
        secret_path = self.repository / "secret.c"
        secret_path.write_bytes(secret_bytes)
        digest = hashlib.sha256(secret_bytes).hexdigest()
        payload = support.graph_payload(
            evidence=[
                {
                    "id": "e_secret",
                    "kind": "evidence",
                    "file": str(secret_path),
                    "hash": digest,
                    "line": 1,
                    "start": 0,
                    "end": len(secret_bytes),
                    "text": secret_bytes.decode("utf-8"),
                }
            ]
        )
        snapshot_id = self.import_synthetic("snap-secret", "cafe0000cafe1111cafe2222cafe3333", payload)
        result = five_views.file_read(
            self.env.state, WORKSPACE_ID, snapshot_id, REPO_ID, "secret.c"
        )
        self.assertEqual("ref_only", result["status"])
        self.assertEqual("secret_suspected", result["reason"])
        self.assertEqual([], result["lines"])
        self.assertFalse(result["truncated"])
        self.assertIsNotNone(result["evidence_ref"])
        self.assert_no_absolute_paths(result)


    def test_nested_private_callee_groups(self) -> None:
        functions = [
            support.function("f_entry", "entry_fn", file="src/n.c", line=1),
            support.function("f_a", "a_fn", file="src/n.c", line=10),
            support.function("f_b", "b_fn", file="src/n.c", line=20),
            support.function("f_x", "x_fn", file="src/n.c", line=30),
            support.function("f_d", "d_fn", file="src/n.c", line=40),
            support.function("f_e", "e_fn", file="src/n.c", line=50),
        ]
        callsites = [
            support.callsite("c_entry_a", owner="f_entry", file="src/n.c", line=2),
            support.callsite("c_a_b", owner="f_a", file="src/n.c", line=11),
            support.callsite("c_a_x", owner="f_a", file="src/n.c", line=12),
            support.callsite("c_b_d", owner="f_b", file="src/n.c", line=21),
            support.callsite("c_b_e", owner="f_b", file="src/n.c", line=22),
        ]
        evidence = [
            support.evidence(f"e_{callsite['id']}", file="src/n.c", line=callsite["line"])
            for callsite in callsites
        ]
        targets = [
            support.call_target(
                f"edge_{callsite['id']}",
                callsite=callsite["id"],
                source=callsite["owner"],
                target=target_id,
                evidence=[f"e_{callsite['id']}"],
            )
            for callsite, target_id in (
                (callsites[0], "f_a"),
                (callsites[1], "f_b"),
                (callsites[2], "f_x"),
                (callsites[3], "f_d"),
                (callsites[4], "f_e"),
            )
        ]
        payload = support.graph_payload(
            functions=functions,
            callsites=callsites,
            call_targets=targets,
            evidence=evidence,
        )
        snapshot_id = self.import_synthetic(
            "snap-nested-groups", "5a5a00005a5a11115a5a22225a5a3333", payload
        )
        result = five_views.end_to_end(
            self.env.state, WORKSPACE_ID, snapshot_id, "entry_fn"
        )
        self.assertEqual(2, result["grouping"]["groups"])
        self.assertEqual(4, result["grouping"]["members"])
        groups = {group["label"]: group for group in result["groups"]}
        self.assertEqual({"a_fn 下游子流程", "b_fn 下游子流程"}, set(groups))
        outer = groups["a_fn 下游子流程"]
        inner = groups["b_fn 下游子流程"]
        self.assertIsNone(outer["parent_group_id"])
        self.assertEqual(outer["group_id"], inner["parent_group_id"])
        self.assertEqual(["f_b", "f_x"], outer["member_function_ids"])
        self.assertEqual(["f_d", "f_e"], inner["member_function_ids"])
        self.assertEqual(
            ["fn:f_b", "fn:f_x"], outer["entry_node_ids"]
        )
        self.assertEqual(["fn:f_b"], outer["exit_node_ids"])
        self.assertEqual(["fn:f_d", "fn:f_e"], inner["entry_node_ids"])
        self.assertEqual([], inner["exit_node_ids"])
        self.assertEqual(
            [reason for reason in outer["limitations"]],
            ["group_structural_heuristic", "group_name_not_semantic"],
        )
        # Groups are additive: the original call edges are untouched.
        call_edge_ids = {
            edge["edge_id"] for edge in result["edges"] if edge["kind"] == "call"
        }
        self.assertEqual(
            {f"call:{target['id']}" for target in targets}, call_edge_ids
        )
        self.assertFalse(result["truncated"])
        self.assert_no_absolute_paths(result)

    def test_s2b_budget_truncation(self) -> None:
        with mock.patch.object(five_views, "MAX_GROUPS", 1):
            result = five_views.end_to_end(
                self.env.state, WORKSPACE_ID, self.snapshot_id, "bus_send"
            )
        self.assertEqual(1, len(result["groups"]))
        self.assertTrue(result["truncated"])
        self.assertIn("groups_truncated", {gap["code"] for gap in result["gaps"]})
        self.assertIn(
            "groups_truncated",
            {gap["code"] for gap in result["grouping"]["gaps"]},
        )
        self.assert_no_absolute_paths(result)

        with mock.patch.object(five_views, "MAX_INTERFACES", 3):
            interfaces = five_views.interfaces(
                self.env.state, WORKSPACE_ID, self.snapshot_id
            )
        self.assertEqual(3, len(interfaces["candidates"]))
        self.assertTrue(interfaces["truncated"])
        self.assertIn(
            "interfaces_truncated", {gap["code"] for gap in interfaces["gaps"]}
        )
        self.assert_no_absolute_paths(interfaces)


if __name__ == "__main__":
    unittest.main()
