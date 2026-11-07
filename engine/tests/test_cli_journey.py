"""CL-009-A: the first-version synthetic learning journey, end to end via CLI.

The journey is deliberately driven through ``python -m code_learning.cli``
only (one JSON object on stdout, diagnostics on stderr): bootstrap-init ->
workspace-import -> status/validate/overview -> source-find/source-read ->
snapshot-import (umd+kmd) -> path (exact/may and cross-repo abi_bridge) ->
pending-prediction record -> resume fresh -> source mutation -> resume stale ->
markdown export with pending markers.  Error JSON/exit codes, the blocked
``run`` command and the strict ``plan`` shape are covered as negative paths.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from pathlib import Path
from typing import Any, Dict, Tuple

from tests import helpers

WORKSPACE_ID = "synthetic-linux-ioctl"
VARIANT_ID = "source-only-x86_64"


def _uuid() -> str:
    return str(uuid.uuid4())


def _tamper_ref(ref: str) -> str:
    """Flip one payload character of a signed ``v1.<payload>.<mac>`` ref.

    Flipping the MAC suffix alone is not a reliable tamper: the last base64
    character carries padding bits, so some edits decode to the same bytes.
    """
    parts = ref.split(".")
    if len(parts) == 3 and parts[0] == "v1" and parts[1]:
        first = "A" if parts[1][0] != "A" else "B"
        return ".".join([parts[0], first + parts[1][1:], parts[2]])
    return ref[:-1] + ("A" if not ref.endswith("A") else "B")


def _snapshot_ref(payload: Dict[str, Any]) -> str:
    for key in ("snapshot_ref", "snapshot_id"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    raise AssertionError(f"snapshot result has no usable ref: {sorted(payload)}")


def _record_ref(payload: Dict[str, Any]) -> str:
    for key in ("record_ref", "record_id"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    record = payload.get("record")
    if isinstance(record, dict):
        value = record.get("record_id")
        if isinstance(value, str) and value:
            return value
    raise AssertionError(f"record-save result has no usable ref: {sorted(payload)}")


def _record_body(payload: Dict[str, Any]) -> Dict[str, Any]:
    record = payload.get("record")
    if isinstance(record, dict):
        return record
    if isinstance(payload.get("prediction"), dict):
        return payload
    raise AssertionError(f"record payload does not contain a record body: {sorted(payload)}")


class CliJourneyTest(unittest.TestCase):
    """End-to-end synthetic journey; one temp bootstrap per test method."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory(prefix="cl-journey-")
        self.addCleanup(self._tmpdir.cleanup)
        self.env = helpers.make_bootstrap(Path(self._tmpdir.name))

    # -- small helpers ---------------------------------------------------
    def cli(self, *args: str, expect: int = 0):
        return helpers.run_cli(self.env.bootstrap_path, *args, expect=expect)

    def cli_json(self, *args: str, expect: int = 0) -> Dict[str, Any]:
        return helpers.cli_json(self.env.bootstrap_path, *args, expect=expect)

    def import_workspace(self, manifest: Dict[str, Any], expected_revision: int = 0) -> Dict[str, Any]:
        name = helpers.write_manifest(self.env, manifest)
        return self.cli_json(
            "workspace-import",
            "--manifest",
            name,
            "--expected-revision",
            str(expected_revision),
            "--operation-id",
            _uuid(),
        )

    def import_snapshots(self) -> Tuple[Dict[str, Any], Dict[str, Dict[str, Any]]]:
        fixtures = helpers.make_snapshot_fixture(self.env)
        payloads: Dict[str, Dict[str, Any]] = {}
        for repo, name in (("umd", "snapshot-umd"), ("kmd", "snapshot-kmd")):
            payload = self.cli_json(
                "snapshot-import",
                "--workspace",
                WORKSPACE_ID,
                "--variant",
                VARIANT_ID,
                "--repo",
                repo,
                "--snapshot",
                name,
                "--operation-id",
                _uuid(),
            )
            payloads[repo] = payload
        return fixtures, payloads

    def find_source_match(self) -> Dict[str, Any]:
        found = self.cli_json(
            "source-find",
            "--workspace",
            WORKSPACE_ID,
            "--repo",
            "umd",
            "--relative-glob",
            "src/*.c",
            "--filename",
            "job_submit.c",
        )
        self.assertEqual(found["schema_version"], 1)
        self.assertGreaterEqual(len(found["matches"]), 1, "synthetic fixture has no source matches")
        return found["matches"][0]

    def read_source_match(self, match: Dict[str, Any]) -> Dict[str, Any]:
        target = self.env.umd / "src" / "job_submit.c"
        size = target.stat().st_size
        end = min(200, size)
        self.assertGreater(end, 0)
        result = self.cli_json(
            "source-read",
            "--workspace",
            WORKSPACE_ID,
            "--path",
            match["path_ref"],
            "--expected-sha256",
            match["source_sha256"],
            "--byte-start",
            "0",
            "--byte-end",
            str(end),
        )
        return result

    def export_text(self, payload: Dict[str, Any]) -> str:
        for key in ("markdown", "content", "text"):
            value = payload.get(key)
            if isinstance(value, str):
                return value
        candidates = sorted(Path(self.env.state.exports_dir()).rglob("*.md"))
        self.assertTrue(candidates, "export produced no markdown artifact")
        return candidates[-1].read_text(encoding="utf-8")

    def record_draft(
        self,
        *,
        imported: Dict[str, Any],
        snapshot: Dict[str, Any],
        evidence_ref: str,
    ) -> Dict[str, Any]:
        variants = imported["variants"]
        build_identity = None
        for variant in variants:
            if variant.get("variant_id") == VARIANT_ID:
                build_identity = variant.get("build_identity")
        self.assertIsInstance(build_identity, dict)
        question = "When does job_submit reach the kernel driver queue?"
        return {
            "schema_version": 1,
            "workspace_id": WORKSPACE_ID,
            "workspace_revision": imported["workspace_revision"],
            "variant_ids": [VARIANT_ID],
            "scope_ref": imported["scope_ref"],
            "goal": {"question": question, "level": "K2", "nature": ["F"]},
            "snapshot_refs": [_snapshot_ref(snapshot)],
            "build_identities": [build_identity],
            "evidence_refs": [evidence_ref],
            "path_refs": [],
            "mental_model": {
                "status": "agent_explanation",
                "text": "The user-space ioctl reaches the driver dispatch through the shared UAPI command.",
                "author": "agent",
            },
            "prediction": {"status": "pending"},
            "experiment": {"status": "pending"},
            "observation": {"status": "pending", "evidence_refs": []},
            "difference": {"status": "pending"},
            "rules": [],
            "unknowns": ["whether the same command value reaches the driver queue"],
            "next_action": None,
            "cursor": {
                "current_question": question,
                "read_evidence_refs": [evidence_ref],
            },
            "freshness": "fresh",
            "invalidation_reasons": [],
            "decision": None,
            "archived": False,
        }

    # -- journeys --------------------------------------------------------
    def test_bootstrap_init_command(self) -> None:
        tmp = Path(self._tmpdir.name) / "init"
        tree = helpers.sample_repo_tree(tmp / "synthetic")
        bootstrap_path = tmp / "bootstrap.json"
        payload = self.cli_json(
            "bootstrap-init",
            "--out",
            str(bootstrap_path),
            "--state-dir",
            str(tmp / "state"),
            "--import-inbox",
            str(tmp / "inbox"),
            "--root",
            f"synthetic-root={tree['root']}",
            "--profile-ref",
            "unittest",
            "--scope-ref",
            "local",
            "--scope-generation",
            "1",
        )
        self.assertEqual(payload["schema_version"], 1)
        self.assertEqual(payload["profile_ref"], "unittest")
        self.assertEqual(payload["scope_generation"], 1)
        self.assertTrue(bootstrap_path.is_file())
        self.assertTrue((tmp / "state" / "secret.key").is_file())
        self.assertTrue((tmp / "inbox").is_dir())
        # The created bootstrap is immediately usable by another command.
        missing = helpers.cli_json(
            bootstrap_path, "status", "--workspace", "unknown-workspace", expect=2
        )
        self.assertEqual(missing["schema_version"], 1)
        self.assertEqual(missing["error"]["code"], "NOT_FOUND")
        # A missing bootstrap configuration is reported as a dependency block.
        absent = helpers.cli_json(
            tmp / "absent-bootstrap.json", "status", "--workspace", "unknown-workspace", expect=2
        )
        self.assertEqual(absent["error"]["code"], "CONFIG_UNAVAILABLE")

    def test_full_learning_journey(self) -> None:
        env = self.env
        manifest = helpers.base_manifest(bindings=[helpers.binding()])
        imported = self.import_workspace(manifest)
        self.assertEqual(imported["schema_version"], 1)
        self.assertEqual(imported["workspace_id"], WORKSPACE_ID)
        self.assertEqual(imported["workspace_revision"], 1)
        self.assertEqual(imported["scope_ref"], "local")
        self.assertEqual(imported["scope_generation"], 1)
        self.assertRegex(imported["manifest_digest"], r"^[0-9a-f]{64}$")
        self.assertEqual(imported["freshness"], "fresh")
        self.assertEqual(imported["semantic_status_by_variant"][VARIANT_ID], "blocked")
        self.assertIn("compiler_build_context", imported["missing_inputs"])
        self.assertEqual(len(imported["bindings"]), 1)
        self.assertEqual(imported["bindings"][0]["binding_id"], "job-ioctl-umd-kmd")
        self.assertEqual(imported["bindings"][0]["kind"], "uapi_ioctl")
        self.assertEqual(imported["bindings"][0]["status"], "supported")

        # -- status / validate / overview --------------------------------
        status = self.cli_json("status", "--workspace", WORKSPACE_ID)
        self.assertEqual(status["schema_version"], 1)
        self.assertEqual(status["workspace_revision"], 1)
        self.assertEqual(status["variants"][0]["variant_id"], VARIANT_ID)
        self.assertEqual(status["variants"][0]["semantic_status"], "blocked")

        validated = self.cli_json("workspace-validate", "--workspace", WORKSPACE_ID)
        self.assertEqual(validated["schema_version"], 1)
        self.assertTrue(validated["valid"])
        self.assertEqual(validated["workspace_revision"], 1)

        overview = self.cli_json("overview", "--workspace", WORKSPACE_ID, "--variant", VARIANT_ID)
        self.assertEqual(overview["schema_version"], 1)
        self.assertEqual(overview["semantic_status"], "blocked")
        self.assertIn("components", overview)
        self.assertIn("unknown_boundaries", overview)

        # -- source-only evidence (no snapshot needed) -------------------
        match = self.find_source_match()
        for key in ("path_ref", "evidence_ref", "source_sha256", "byte_start", "byte_end"):
            self.assertIn(key, match)
        self.assertRegex(match["source_sha256"], r"^[0-9a-f]{64}$")
        read = self.read_source_match(match)
        self.assertEqual(read["schema_version"], 1)
        evidence = read["evidence"]
        self.assertEqual(evidence["origin"], "source_text")
        self.assertEqual(evidence["semantic_status"], "blocked")
        self.assertIsNone(evidence["snapshot_id"])
        self.assertIn("text_only_not_compiler_fact", evidence["limitations"])
        self.assertIn("job_submit", read["safe_text"])
        self.assertEqual(read["actual_byte_start"], 0)
        self.assertLessEqual(read["actual_byte_end"], 200)
        evidence_ref = evidence["evidence_ref"]
        projected = self.cli_json(
            "source", "--workspace", WORKSPACE_ID, "--evidence", evidence_ref, "--max-bytes", "200"
        )
        self.assertEqual(projected["schema_version"], 1)
        self.assertEqual(projected["evidence"]["origin"], "source_text")

        # -- snapshot import (umd + kmd) --------------------------------
        fixtures, snapshots = self.import_snapshots()
        for repo in ("umd", "kmd"):
            payload = snapshots[repo]
            self.assertEqual(payload["schema_version"], 1)
            self.assertEqual(payload["atlas_schema"], "0.1")
            self.assertEqual(payload["freshness"], "fresh")
            self.assertEqual(payload["graph_sha256"], fixtures[repo]["graph_hash"])
            self.assertEqual(payload["manifest_sha256"], fixtures[repo]["manifest_hash"])
        loaded = self.cli_json(
            "snapshot", "--workspace", WORKSPACE_ID, "--snapshot", _snapshot_ref(snapshots["umd"])
        )
        self.assertEqual(loaded["schema_version"], 1)
        self.assertEqual(loaded["freshness"], "fresh")
        self.assertEqual(loaded["snapshot_id"], "snapshot-umd")

        # -- path queries: exact + may within kmd ------------------------
        exact = self.cli_json(
            "path",
            "--workspace",
            WORKSPACE_ID,
            "--variant",
            VARIANT_ID,
            "--from",
            "kmd:job_dispatch",
            "--to",
            "kmd:job_enqueue",
        )
        self.assertEqual(exact["schema_version"], 1)
        self.assertTrue(exact["edges"])
        self.assertTrue(
            any(edge.get("certainty") == "exact" for edge in exact["edges"]),
            f"expected an exact edge, got {exact['edges']}",
        )
        for edge in exact["edges"]:
            self.assertEqual(edge["relation"], "call")
            self.assertIn("callsite", edge)
            self.assertIn("origin", edge)
        may = self.cli_json(
            "path",
            "--workspace",
            WORKSPACE_ID,
            "--variant",
            VARIANT_ID,
            "--from",
            "kmd:job_dispatch",
            "--to",
            "kmd:job_complete",
        )
        self.assertTrue(any(edge.get("certainty") == "may" for edge in may["edges"]))

        # -- cross-repo path through the supported UAPI binding ----------
        cross = self.cli_json(
            "path",
            "--workspace",
            WORKSPACE_ID,
            "--variant",
            VARIANT_ID,
            "--from",
            "umd:job_submit",
            "--to",
            "kmd:job_dispatch",
        )
        self.assertEqual(cross["schema_version"], 1)
        bridges = [edge for edge in cross["edges"] if edge.get("relation") == "abi_bridge"]
        self.assertTrue(bridges, f"supported binding produced no abi_bridge: {cross['edges']}")
        for bridge in bridges:
            self.assertEqual(bridge["certainty"], "may")
            self.assertEqual(bridge["origin"], "derived")

        # -- record with pending prediction, then fresh resume -----------
        draft = self.record_draft(
            imported=imported,
            snapshot=snapshots["umd"],
            evidence_ref=evidence_ref,
        )
        helpers.write_json(env.inbox_dir / "record-draft.json", draft)
        saved = self.cli_json(
            "record-save",
            "--workspace",
            WORKSPACE_ID,
            "--input",
            "record-draft.json",
            "--expected-generation",
            "0",
            "--operation-id",
            _uuid(),
        )
        self.assertEqual(saved["schema_version"], 1)
        record_ref = _record_ref(saved)
        self.assertEqual(saved.get("generation", 1), 1)

        fetched = self.cli_json("record-get", "--workspace", WORKSPACE_ID, "--record", record_ref)
        record = _record_body(fetched)
        self.assertEqual(record["prediction"]["status"], "pending")
        self.assertEqual(record["mental_model"]["author"], "agent")
        self.assertEqual(record["freshness"], "fresh")

        resumed = self.cli_json("resume", "--workspace", WORKSPACE_ID, "--record", record_ref)
        self.assertEqual(resumed["schema_version"], 1)
        self.assertEqual(resumed["freshness"], "fresh")
        self.assertEqual(resumed["changed_inputs"], [])
        self.assertIn("safe_cursor", resumed)
        self.assertEqual(_record_body(resumed)["prediction"]["status"], "pending")

        # -- source mutation makes the paused record stale ---------------
        target = env.umd / "src" / "job_submit.c"
        target.write_text(target.read_text(encoding="utf-8") + "\n/* journey edit */\n", encoding="utf-8")
        stale = self.cli_json("resume", "--workspace", WORKSPACE_ID, "--record", record_ref)
        self.assertEqual(stale["freshness"], "stale")
        self.assertTrue(stale["changed_inputs"], "stale resume must name the changed inputs")
        self.assertEqual(_record_body(stale)["prediction"]["status"], "pending")
        self.assertIn("safe_cursor", stale)

        # -- markdown export keeps explicit pending markers --------------
        exported = self.cli_json(
            "export", "--workspace", WORKSPACE_ID, "--record", record_ref, "--format", "markdown"
        )
        self.assertEqual(exported["schema_version"], 1)
        self.assertRegex(exported["sha256"], r"^[0-9a-f]{64}$")
        markdown = self.export_text(exported)
        self.assertIn("pending", markdown.lower())
        self.assertIn("job_submit", markdown)

    def test_cross_repo_incomplete_binding_yields_unresolved(self) -> None:
        binding = helpers.binding(status="incomplete")
        binding["shared_definition_evidence_refs"] = []
        binding["from"]["interface_revision_ref"] = None
        binding["to"]["interface_revision_ref"] = None
        imported = self.import_workspace(helpers.base_manifest(bindings=[binding]))
        self.assertEqual(imported["bindings"][0]["status"], "incomplete")
        self.import_snapshots()
        result = self.cli_json(
            "path",
            "--workspace",
            WORKSPACE_ID,
            "--variant",
            VARIANT_ID,
            "--from",
            "umd:job_submit",
            "--to",
            "kmd:job_dispatch",
        )
        self.assertEqual(result["schema_version"], 1)
        self.assertEqual([edge for edge in result["edges"] if edge.get("relation") == "abi_bridge"], [])
        self.assertTrue(result["unresolved"], "incomplete binding must stay unresolved")

    def test_plan_is_reference_only_and_run_is_blocked(self) -> None:
        imported = self.import_workspace(helpers.base_manifest())
        self.assertEqual(imported["workspace_revision"], 1)
        helpers.write_json(
            self.env.inbox_dir / "goal.json",
            {"question": "When does job_submit reach the driver queue?", "interface": "job_submit"},
        )
        plan = self.cli_json(
            "plan", "--workspace", WORKSPACE_ID, "--variant", VARIANT_ID, "--goal-file", "goal.json"
        )
        self.assertEqual(plan["schema_version"], 1)
        self.assertEqual(plan["workspace_id"], WORKSPACE_ID)
        self.assertEqual(plan["workspace_revision"], 1)
        self.assertEqual(plan["variant_id"], VARIANT_ID)
        self.assertIsInstance(plan["build_identity"], dict)
        self.assertEqual(plan["goal"]["interface"], "job_submit")
        self.assertIsNone(plan["execution_profile_ref"])
        self.assertTrue(plan["expires_at"].endswith("Z"))
        self.assertRegex(plan["request_digest"], r"^[0-9a-f]{64}$")
        argv = plan["argv"]
        for flag in (
            "--repo",
            "--root",
            "--out",
            "--interface",
            "--max-tu",
            "--tu-timeout",
            "--dataflow",
            "--html",
        ):
            self.assertIn(flag, argv)
        # The frozen plan carries references only: nothing is an absolute path.
        for value in argv:
            self.assertFalse(
                Path(value).is_absolute(), f"plan argv must not embed absolute paths: {value!r}"
            )
        self.assertIn("forced_isolation_profile", plan["required_capabilities"])

        blocked = self.cli_json(
            "run", "--plan", plan["plan_id"], "--operation-id", _uuid(), expect=2
        )
        self.assertEqual(blocked["schema_version"], 1)
        self.assertEqual(blocked["error"]["code"], "EXECUTION_BLOCKED")
        self.assertFalse(blocked["error"]["retryable"])

        tampered = _tamper_ref(plan["plan_id"])
        rejected = self.cli_json("run", "--plan", tampered, "--operation-id", _uuid(), expect=2)
        self.assertEqual(rejected["error"]["code"], "SCOPE_DENIED")

    def test_error_payloads_and_exit_codes(self) -> None:
        self.import_workspace(helpers.base_manifest())
        # Unknown workspace: block, one JSON object on stdout, diagnostic on stderr.
        completed = self.cli("status", "--workspace", "missing-workspace", expect=2)
        raw = completed.stdout.strip()
        self.assertTrue(raw.startswith("{") and raw.endswith("}"), raw)
        payload = json.loads(raw)  # exactly one JSON object
        self.assertEqual(payload["schema_version"], 1)
        self.assertEqual(payload["error"]["code"], "NOT_FOUND")
        self.assertTrue(completed.stderr.strip(), "diagnostics must go to stderr")

        # Neither literal nor filename is an input block.
        neither = self.cli_json(
            "source-find",
            "--workspace",
            WORKSPACE_ID,
            "--repo",
            "umd",
            "--relative-glob",
            "src/*.c",
            expect=2,
        )
        self.assertEqual(neither["error"]["code"], "INVALID_ARGUMENT")
        both = self.cli_json(
            "source-find",
            "--workspace",
            WORKSPACE_ID,
            "--repo",
            "umd",
            "--relative-glob",
            "src/*.c",
            "--literal",
            "job_submit",
            "--filename",
            "job_submit.c",
            expect=2,
        )
        self.assertEqual(both["error"]["code"], "INVALID_ARGUMENT")

        # Tampering with a signed source ref blocks the read before content leaves the engine.
        match = self.find_source_match()
        tampered = _tamper_ref(match["path_ref"])
        tampered_result = self.cli_json(
            "source-read",
            "--workspace",
            WORKSPACE_ID,
            "--path",
            tampered,
            "--expected-sha256",
            match["source_sha256"],
            "--byte-start",
            "0",
            "--byte-end",
            "32",
            expect=2,
        )
        self.assertEqual(tampered_result["error"]["code"], "SCOPE_DENIED")

        # A byte range wider than 16 KiB is rejected by the service boundary.
        too_wide = self.cli_json(
            "source-read",
            "--workspace",
            WORKSPACE_ID,
            "--path",
            match["path_ref"],
            "--expected-sha256",
            match["source_sha256"],
            "--byte-start",
            "0",
            "--byte-end",
            str(20000),
            expect=2,
        )
        self.assertEqual(too_wide["error"]["code"], "INVALID_ARGUMENT")

        # A non-UUID operation id is rejected before any idempotent work starts.
        bad_operation = self.cli_json(
            "workspace-import",
            "--manifest",
            "workspace.json",
            "--expected-revision",
            "1",
            "--operation-id",
            "op-1",
            expect=2,
        )
        self.assertEqual(bad_operation["error"]["code"], "INVALID_ARGUMENT")

        # Stale revision CAS blocks an import instead of overwriting.
        conflict = self.cli_json(
            "workspace-import",
            "--manifest",
            "workspace.json",
            "--expected-revision",
            "7",
            "--operation-id",
            _uuid(),
            expect=2,
        )
        self.assertIn(conflict["error"]["code"], ("STATE_CONFLICT", "INVALID_ARGUMENT"))


if __name__ == "__main__":
    unittest.main()
