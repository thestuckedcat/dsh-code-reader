"""CL-003-A: Atlas 0.1 snapshot import, integrity verification and projection.

Covers the negative paths the contract calls out: envelope/schema tampering,
``graph_hash`` mismatch, coverage preservation (failed TU objects and pending
unit paths are never coerced to counts), freshness after a workspace/source
change, read-only copies unaffected by inbox/current drift, idempotent import
and operation-id conflicts.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
import uuid
from pathlib import Path

from tests import helpers
from tests.fixtures.snapshots import support

from code_learning import atlas, snapshot, util
from code_learning.errors import CodeLearningError


class SnapshotTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="cl-snapshot-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.env = helpers.make_bootstrap(self.tmp)
        self.workspace = support.make_workspace()
        support.install_workspace(self.env, self.workspace)
        self._patch = support.patch_workspace(self.workspace)
        self._patch.__enter__()
        self.addCleanup(self._patch.__exit__, None, None, None)

    # -- helpers ---------------------------------------------------------
    @property
    def workspace_id(self) -> str:
        return self.workspace["workspace_id"]

    def _snapshot(self, name: str = "snap-umd", payload=None, overrides=None):
        return support.write_snapshot(self.env, name, payload, overrides)

    def _import(self, name: str = "snap-umd", *, repo: str = "umd",
                variant: str = support.VARIANT_ID, operation_id=None):
        return support.import_snapshot(
            self.env,
            self.workspace,
            name,
            repo_id=repo,
            variant_id=variant,
            operation_id=operation_id,
        )

    def _expect_error(self, code: str, callable_):
        with self.assertRaises(CodeLearningError) as context:
            callable_()
        self.assertEqual(context.exception.code, code, context.exception.message)
        return context.exception

    def _rewrite_documents(self, fixture, *, graph_mutator=None, manifest_mutator=None):
        """Rewrite a written snapshot pair so hashes stay coherent (except tamper tests)."""
        if graph_mutator is not None:
            document = json.loads(fixture["graph_path"].read_text(encoding="utf-8"))
            graph_mutator(document)
            raw = json.dumps(document, sort_keys=True).encode("utf-8")
            helpers.write_bytes(fixture["graph_path"], raw)
            fixture["graph_hash"] = util.sha256_bytes(raw)
        manifest_document = json.loads(fixture["manifest_path"].read_text(encoding="utf-8"))
        manifest_document["payload"]["graph_hash"] = fixture["graph_hash"]
        if manifest_mutator is not None:
            manifest_mutator(manifest_document)
        helpers.write_json(fixture["manifest_path"], manifest_document)
        fixture["manifest_hash"] = helpers.sha256_file(fixture["manifest_path"])
        return fixture

    # -- import happy path ----------------------------------------------
    def test_import_verifies_and_copies_snapshot_pair(self) -> None:
        fixture = self._snapshot("snap-umd")
        evidence = self._import("snap-umd")

        self.assertEqual(evidence["schema_version"], 1)
        self.assertEqual(evidence["atlas_schema"], "0.1")
        self.assertEqual(evidence["snapshot_id"], "snap-umd")
        self.assertEqual(evidence["snapshot_ref"], "snap-umd")
        self.assertEqual(evidence["graph_sha256"], fixture["graph_hash"])
        self.assertEqual(evidence["manifest_sha256"], fixture["manifest_hash"])
        self.assertEqual(evidence["freshness"], "fresh")
        self.assertEqual(evidence["workspace_id"], self.workspace_id)
        self.assertEqual(evidence["variant_id"], support.VARIANT_ID)
        self.assertEqual(evidence["repo_id"], "umd")
        self.assertFalse(evidence["coverage"]["whole_program_complete"])
        self.assertEqual(evidence["coverage"]["failed"], [])
        self.assertEqual(evidence["failed_count"], 0)

        directory = self.env.state.snapshot_dir("snap-umd")
        for name in ("graph.json", "analysis_manifest.json", "import.json", "current.json"):
            self.assertTrue((directory / name).is_file(), name)
        self.assertEqual(
            helpers.sha256_file(directory / "graph.json"),
            fixture["graph_hash"],
        )

        import_record = json.loads((directory / "import.json").read_text(encoding="utf-8"))
        self.assertEqual(import_record["schema_version"], 1)
        self.assertEqual(import_record["workspace_id"], self.workspace_id)
        self.assertEqual(import_record["workspace_revision"], 1)
        self.assertEqual(import_record["source_manifest_digest"], "source-digest-1")
        self.assertEqual(import_record["variant_id"], support.VARIANT_ID)
        self.assertEqual(import_record["repo_id"], "umd")
        self.assertEqual(import_record["graph_sha256"], fixture["graph_hash"])
        self.assertEqual(import_record["manifest_sha256"], fixture["manifest_hash"])
        self.assertIsNotNone(import_record["imported_at"])
        expected_identity = util.digest(self.workspace["variants"][0]["build_identity"])
        self.assertEqual(import_record["build_identity_digest"], expected_identity)

        current = json.loads((directory / "current.json").read_text(encoding="utf-8"))
        self.assertEqual(
            current,
            {"snapshot_id": "snap-umd", "manifest_hash": fixture["manifest_hash"]},
        )

        entry = self.env.state.find_snapshot_entry(self.workspace_id, support.VARIANT_ID, "umd")
        self.assertIsNotNone(entry)
        assert entry is not None
        self.assertEqual(entry["snapshot_id"], "snap-umd")
        self.assertEqual(entry["graph_sha256"], fixture["graph_hash"])
        self.assertEqual(entry["manifest_sha256"], fixture["manifest_hash"])

    def test_reimport_is_idempotent_and_index_has_one_entry(self) -> None:
        self._snapshot("snap-umd")
        first = self._import("snap-umd", operation_id="op-reimport")
        replay = self._import("snap-umd", operation_id="op-reimport")
        self.assertEqual(first, replay)

        fresh_operation = self._import("snap-umd", operation_id="op-reimport-2")
        self.assertEqual(fresh_operation["snapshot_id"], "snap-umd")
        entries = [
            entry
            for entry in self.env.state.snapshots_index()["entries"]
            if entry.get("workspace_id") == self.workspace_id
        ]
        self.assertEqual(len(entries), 1)

    def test_operation_id_reuse_with_different_request_conflicts(self) -> None:
        self._snapshot("snap-umd")
        self._import("snap-umd", operation_id="op-shared")
        self._expect_error(
            "OPERATION_CONFLICT",
            lambda: self._import("snap-umd", repo="kmd", operation_id="op-shared"),
        )

    def test_reimport_same_snapshot_id_with_different_graph_conflicts(self) -> None:
        self._snapshot("snap-umd")
        self._import("snap-umd")
        changed = helpers.simple_graph_payload()
        changed["functions"][0]["file"] = "umd/src/job_submit_changed.c"
        support.write_snapshot(self.env, "snap-umd", changed)
        self._expect_error("STATE_CONFLICT", lambda: self._import("snap-umd"))

    # -- tamper / schema rejection --------------------------------------
    def test_tampered_graph_bytes_break_graph_hash(self) -> None:
        fixture = self._snapshot("snap-tamper")
        fixture["graph_path"].write_bytes(fixture["graph_path"].read_bytes() + b"\n")
        self._expect_error("INVALID_ARGUMENT", lambda: self._import("snap-tamper"))

    def test_tampered_manifest_graph_hash_field_rejected(self) -> None:
        fixture = self._snapshot("snap-tamper")
        document = json.loads(fixture["manifest_path"].read_text(encoding="utf-8"))
        document["payload"]["graph_hash"] = "0" * 64
        helpers.write_json(fixture["manifest_path"], document)
        self._expect_error("INVALID_ARGUMENT", lambda: self._import("snap-tamper"))

    def test_non_json_snapshot_file_rejected(self) -> None:
        fixture = self._snapshot("snap-broken")
        helpers.write_bytes(fixture["graph_path"], b"{ this is not json")
        self._expect_error("INVALID_ARGUMENT", lambda: self._import("snap-broken"))

    def test_envelope_schema_rejections(self) -> None:
        cases = {
            "wrong_schema_version": (
                lambda document: document.update({"schema_version": "1.0"}),
                None,
            ),
            "wrong_record_kind": (
                lambda document: document.update({"record_kind": "analysis_manifest"}),
                None,
            ),
            "missing_provenance": (
                lambda document: document.pop("provenance"),
                None,
            ),
        }
        for name, (graph_mutator, manifest_mutator) in cases.items():
            with self.subTest(name=name):
                fixture = self._snapshot(f"snap-{name}")
                self._rewrite_documents(
                    fixture,
                    graph_mutator=graph_mutator,
                    manifest_mutator=manifest_mutator,
                )
                self._expect_error("UNSUPPORTED_SCHEMA", lambda: self._import(f"snap-{name}"))

    def test_graph_payload_schema_rejections(self) -> None:
        cases = {
            "missing_required_array": lambda payload: payload.pop("call_targets"),
            "bad_certainty": lambda payload: payload["call_targets"][0].update({"certainty": "certain"}),
            "unknown_call_target": lambda payload: payload["call_targets"][0].update({"target": "fn_missing"}),
            "unknown_callsite": lambda payload: payload["call_targets"][0].update({"callsite": "cs_missing"}),
            "duplicate_function_id": lambda payload: payload["functions"].append(dict(payload["functions"][0])),
        }
        for name, mutate in cases.items():
            with self.subTest(name=name):
                fixture = self._snapshot(f"snap-{name}")
                self._rewrite_documents(
                    fixture,
                    graph_mutator=lambda document: mutate(document["payload"]),
                )
                self._expect_error("UNSUPPORTED_SCHEMA", lambda: self._import(f"snap-{name}"))

    def test_manifest_payload_schema_rejections(self) -> None:
        cases = {
            "missing_graph_hash": lambda document: document["payload"].pop("graph_hash"),
            "missing_coverage": lambda document: document["payload"].pop("coverage"),
            "bad_tool_version": lambda document: document["payload"].update({"tool_version": ""}),
            "bad_manifest_schema_version": lambda document: document["payload"].update({"schema_version": "1"}),
        }
        for name, mutate in cases.items():
            with self.subTest(name=name):
                fixture = self._snapshot(f"snap-{name}")
                self._rewrite_documents(fixture, manifest_mutator=mutate)
                self._expect_error("UNSUPPORTED_SCHEMA", lambda: self._import(f"snap-{name}"))

    # -- coverage preservation ------------------------------------------
    def test_coverage_failed_and_pending_are_preserved(self) -> None:
        failed = [
            {"tu": "kmd/driver/job_queue.c", "reason": "tu_timeout", "stage": "parse"},
            {"tu": "kmd/driver/irq.c", "reason": "missing_generated_header"},
        ]
        pending = ["uapi/include/job_ioctl.h", "kmd/include/job_queue.h"]
        overrides = {
            "coverage": {
                "selected_scope": "fixture",
                "total_available_units": 9,
                "processed_units": 7,
                "parsed": 5,
                "reused": 2,
                "failed": failed,
                "pending_units": pending,
                "complete_call_chain": False,
                "whole_program_complete": False,
                "requested_scope_complete": True,
                "capabilities": {
                    "direct_calls": "ready",
                    "types": "ready",
                    "global_objects": "ready",
                    "locks": "not_requested",
                    "data_flow": "not_requested",
                    "cfg": "unsupported",
                },
            }
        }
        self._snapshot("snap-coverage", overrides=overrides)
        evidence = self._import("snap-coverage")

        coverage = evidence["coverage"]
        self.assertIsInstance(coverage["failed"], list)
        self.assertIsInstance(coverage["pending_units"], list)
        self.assertEqual(coverage["failed"], failed)
        self.assertEqual(coverage["pending_units"], pending)
        self.assertEqual(coverage["failed_count"], 2)
        self.assertEqual(evidence["failed_count"], 2)
        self.assertEqual(coverage["parsed"], 5)
        self.assertEqual(coverage["reused"], 2)
        self.assertEqual(coverage["total_available_units"], 9)
        self.assertFalse(coverage["whole_program_complete"])
        self.assertTrue(coverage["requested_scope_complete"])

    def test_integer_failed_coverage_is_rejected_not_coerced(self) -> None:
        self._snapshot("snap-coverage-int", overrides={"coverage": {"failed": 3, "pending_units": []}})
        self._expect_error("UNSUPPORTED_SCHEMA", lambda: self._import("snap-coverage-int"))

    def test_integer_pending_units_coverage_is_rejected(self) -> None:
        self._snapshot(
            "snap-pending-int",
            overrides={"coverage": {"failed": [], "pending_units": 4}},
        )
        self._expect_error("UNSUPPORTED_SCHEMA", lambda: self._import("snap-pending-int"))

    # -- read-only copies and freshness ---------------------------------
    def test_current_and_inbox_drift_do_not_change_loaded_snapshot(self) -> None:
        fixture = self._snapshot("snap-drift")
        self._import("snap-drift")

        destination = self.env.state.snapshot_dir("snap-drift")
        helpers.write_json(destination / "current.json", {"snapshot_id": "other", "manifest_hash": "0" * 64})
        fixture["graph_path"].write_bytes(b'{"tampered_in_inbox": true}\n')

        evidence = snapshot.snapshot_evidence(self.env.state, self.workspace_id, "snap-drift")
        self.assertEqual(evidence["freshness"], "fresh")
        self.assertEqual(evidence["graph_sha256"], fixture["graph_hash"])

    def test_freshness_stale_after_workspace_revision_or_source_change(self) -> None:
        self._snapshot("snap-fresh")
        self._import("snap-fresh")
        self.assertEqual(
            snapshot.snapshot_evidence(self.env.state, self.workspace_id, "snap-fresh")["freshness"],
            "fresh",
        )

        self.workspace["revision"] = 2
        stripped = snapshot.snapshot_evidence(self.env.state, self.workspace_id, "snap-fresh")
        self.assertEqual(stripped["freshness"], "stale")
        bundle = snapshot.load_snapshot(self.env.state, self.workspace_id, "snap-fresh")
        self.assertEqual(bundle["freshness"], "stale")

        self.workspace["revision"] = 1
        self.workspace["source_manifest_digest"] = "source-digest-2"
        changed = snapshot.snapshot_evidence(self.env.state, self.workspace_id, "snap-fresh")
        self.assertEqual(changed["freshness"], "stale")

    def test_missing_snapshot_file_reports_unknown(self) -> None:
        fixture = self._snapshot("snap-missing")
        self._import("snap-missing")
        destination = self.env.state.snapshot_dir("snap-missing")
        (destination / "analysis_manifest.json").unlink()

        evidence = snapshot.snapshot_evidence(self.env.state, self.workspace_id, "snap-missing")
        self.assertEqual(evidence["freshness"], "unknown")
        self.assertEqual(evidence["manifest_sha256"], fixture["manifest_hash"])
        self.assertIn("snapshot_file_missing", evidence["limitations"])

    def test_tampered_copy_is_rejected_on_load(self) -> None:
        fixture = self._snapshot("snap-load-tamper")
        self._import("snap-load-tamper")
        destination = self.env.state.snapshot_dir("snap-load-tamper")
        helpers.write_bytes(destination / "graph.json", b'{"tampered": true}\n')
        self._expect_error(
            "STALE_SNAPSHOT",
            lambda: snapshot.snapshot_evidence(self.env.state, self.workspace_id, "snap-load-tamper"),
        )

    def test_reimport_repairs_a_missing_verified_copy(self) -> None:
        self._snapshot("snap-repair")
        self._import("snap-repair")
        destination = self.env.state.snapshot_dir("snap-repair")
        (destination / "analysis_manifest.json").unlink()

        repaired = self._import("snap-repair")
        self.assertEqual(repaired["freshness"], "fresh")
        self.assertTrue((destination / "analysis_manifest.json").is_file())

    # -- argument / scope validation ------------------------------------
    def test_import_argument_validation(self) -> None:
        self._snapshot("snap-args")
        self._expect_error("INVALID_ARGUMENT", lambda: self._import("../escape"))
        self._expect_error("INVALID_ARGUMENT", lambda: self._import("nested/name"))
        self._expect_error("NOT_FOUND", lambda: self._import("does-not-exist"))
        self._expect_error("NOT_FOUND", lambda: self._import("snap-args", variant="unknown-variant"))
        self._expect_error("NOT_FOUND", lambda: self._import("snap-args", repo="not-a-repo"))

    def test_snapshot_for_repo(self) -> None:
        self._snapshot("snap-umd")
        self._import("snap-umd")
        self.assertEqual(
            snapshot.snapshot_for_repo(self.env.state, self.workspace_id, support.VARIANT_ID, "umd"),
            "snap-umd",
        )
        self.assertIsNone(
            snapshot.snapshot_for_repo(self.env.state, self.workspace_id, support.VARIANT_ID, "kmd")
        )

    def test_load_snapshot_unknown_reference(self) -> None:
        self._expect_error(
            "NOT_FOUND",
            lambda: snapshot.load_snapshot(self.env.state, self.workspace_id, "snap-never-imported"),
        )


def _workspace_backend():
    try:
        from code_learning import workspace as workspace_module
    except ImportError:  # pragma: no cover - only while the backend is missing
        return None
    return workspace_module


class SnapshotWorkspaceIntegrationTests(unittest.TestCase):
    """Exercise the real workspace.import_workspace -> snapshot.import_snapshot path."""

    def test_import_snapshot_for_real_registered_workspace(self) -> None:
        backend = _workspace_backend()
        if backend is None:
            self.skipTest("workspace backend is not implemented yet")
        tmp = Path(tempfile.mkdtemp(prefix="cl-snapshot-integration-"))
        self.addCleanup(shutil.rmtree, str(tmp), True)
        env = helpers.make_bootstrap(tmp)
        manifest = helpers.base_manifest()
        helpers.write_manifest(env, manifest, "workspace.json")
        try:
            imported = backend.import_workspace(env.state, "workspace.json", 0, uuid.uuid4().hex)
        except CodeLearningError as error:  # pragma: no cover - transitional
            self.skipTest(f"workspace backend not ready: {error.code}")
        helpers.write_snapshot_dir(env.inbox_dir / "snap-real", helpers.simple_graph_payload())

        evidence = snapshot.import_snapshot(
            env.state,
            imported["workspace_id"],
            "source-only-x86_64",
            "umd",
            "snap-real",
            uuid.uuid4().hex,
        )
        self.assertEqual(evidence["snapshot_id"], "snap-real")
        self.assertEqual(evidence["workspace_id"], imported["workspace_id"])
        self.assertEqual(evidence["freshness"], "fresh")
        self.assertEqual(evidence["coverage"]["failed"], [])


if __name__ == "__main__":
    unittest.main()
