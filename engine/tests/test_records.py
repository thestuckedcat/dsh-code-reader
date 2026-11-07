"""CL-005 acceptance tests: learning records, CAS, prediction/observation, export.

Design references: ``docs/software-design.md`` §4.3/§8 and
``docs/implementation-contract.md`` §8.  The hard rule under test is that an
Agent explanation never becomes a user claim: prediction/observation stay
pending unless the user or real executed evidence supplies them.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parent.parent
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures" / "events"
if str(FIXTURES_DIR) not in sys.path:
    sys.path.insert(0, str(FIXTURES_DIR))

import support  # noqa: E402
from code_learning import learning, records  # noqa: E402
from code_learning.errors import CodeLearningError  # noqa: E402
from code_learning.util import sha256_bytes, sha256_file  # noqa: E402

WORKSPACE = support.WORKSPACE_ID


def assert_code(testcase: unittest.TestCase, code: str, callable_, *args, **kwargs) -> CodeLearningError:
    with testcase.assertRaises(CodeLearningError) as context:
        callable_(*args, **kwargs)
    testcase.assertEqual(code, context.exception.code, msg=str(context.exception))
    return context.exception


class RecordStoreTestCase(unittest.TestCase):
    """Base case with a synthetic registered workspace and no workspace.py."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="rec-records-")
        self.addCleanup(self._tmp.cleanup)
        self.env, self.workspace = support.make_env(Path(self._tmp.name))

    # -- helpers -------------------------------------------------------
    def draft(self, **kwargs):
        evidence_refs = kwargs.pop("evidence_refs", None)
        return support.make_draft(self.workspace, evidence_refs=evidence_refs, **kwargs)

    def save(self, draft=None, *, expected=0, operation_id=None, workspace_ref=None):
        if workspace_ref is None:
            workspace_ref = WORKSPACE
        return support.save(
            self.env,
            self.workspace,
            draft,
            expected_generation=expected,
            operation_id=operation_id,
            workspace_ref=workspace_ref,
        )

    def export(self, record_id: str, fmt: str = "markdown"):
        return records.export_record(self.env.state, WORKSPACE, record_id, fmt=fmt)

    def markdown_text(self, result) -> str:
        path = self.env.state.exports_dir() / result["export_ref"]
        return path.read_text(encoding="utf-8")

    def body_text(self, record_id: str, generation: int) -> str:
        return support.record_body_path(self.env, record_id, generation).read_text(encoding="utf-8")


class DefaultRecordTests(RecordStoreTestCase):
    def test_default_record_keeps_user_fields_pending(self):
        draft = learning.default_record(self.workspace, support.default_goal())
        self.assertEqual("pending", draft["mental_model"]["status"])
        self.assertEqual({"status": "pending"}, draft["prediction"])
        self.assertEqual({"status": "pending"}, draft["experiment"])
        self.assertEqual({"status": "pending", "evidence_refs": []}, draft["observation"])
        self.assertEqual({"status": "pending"}, draft["difference"])
        self.assertIsNone(draft["next_action"])
        self.assertEqual([], draft["rules"])
        self.assertEqual([], draft["unknowns"])
        self.assertEqual([], draft["invalidation_reasons"])
        self.assertEqual("fresh", draft["freshness"])
        self.assertIsNone(draft["decision"])
        self.assertFalse(draft["archived"])
        self.assertNotIn("generation", draft)

    def test_default_record_uses_workspace_identity_and_build_identity(self):
        draft = learning.default_record(self.workspace, support.default_goal())
        self.assertTrue(draft["record_id"].startswith("rec_"))
        self.assertEqual(WORKSPACE, draft["workspace_id"])
        self.assertEqual(self.workspace["revision"], draft["workspace_revision"])
        self.assertEqual([support.VARIANT_ID], draft["variant_ids"])
        self.assertEqual("local", draft["scope_ref"])
        self.assertEqual(1, draft["schema_version"])
        self.assertEqual(
            self.workspace["variants"][0]["build_identity"], draft["build_identities"][0]
        )

    def test_default_record_goal_is_validated(self):
        bad = {"question": "", "level": "K9", "nature": ["X"]}
        assert_code(self, "INVALID_ARGUMENT", learning.default_record, self.workspace, bad)
        assert_code(
            self,
            "INVALID_ARGUMENT",
            learning.default_record,
            self.workspace,
            {"question": "q", "level": "K1", "nature": ["F"], "extra": 1},
        )


class DraftValidationTests(RecordStoreTestCase):
    def test_validate_accepts_default_record(self):
        result = learning.validate_record_draft(
            learning.default_record(self.workspace, support.default_goal())
        )
        self.assertEqual("pending", result["prediction"]["status"])
        self.assertNotIn("generation", result)

    def test_validate_rejects_generation_and_unknown_fields(self):
        draft = support.make_draft(self.workspace)
        draft["generation"] = 1
        assert_code(self, "INVALID_ARGUMENT", learning.validate_record_draft, draft)
        draft = support.make_draft(self.workspace)
        draft["mystery"] = True
        assert_code(self, "INVALID_ARGUMENT", learning.validate_record_draft, draft)

    def test_validate_rejects_unsupported_schema_version(self):
        draft = support.make_draft(self.workspace)
        draft["schema_version"] = 2
        assert_code(self, "UNSUPPORTED_SCHEMA", learning.validate_record_draft, draft)

    def test_observation_observed_requires_evidence_refs(self):
        draft = support.make_draft(self.workspace)
        draft["experiment"] = {"status": "executed", "run_ref": "run-fixture-1"}
        draft["observation"] = {"status": "observed", "text": "queue moved", "evidence_refs": []}
        assert_code(self, "INVALID_ARGUMENT", learning.validate_record_draft, draft)

    def test_observation_observed_requires_executed_experiment(self):
        ref = support.evidence_ref(self.env)
        draft = support.make_draft(self.workspace, evidence_refs=[ref])
        draft["observation"] = {"status": "observed", "text": "queue moved", "evidence_refs": [ref]}
        draft["experiment"] = {"status": "planned", "plan_ref": "plan-fixture-1"}
        assert_code(self, "INVALID_ARGUMENT", learning.validate_record_draft, draft)
        draft["experiment"] = {"status": "executed", "run_ref": "run-fixture-1"}
        result = learning.validate_record_draft(draft)
        self.assertEqual("observed", result["observation"]["status"])

    def test_experiment_status_requires_matching_evidence_refs(self):
        draft = support.make_draft(self.workspace)
        draft["experiment"] = {"status": "executed"}
        assert_code(self, "INVALID_ARGUMENT", learning.validate_record_draft, draft)
        draft["experiment"] = {"status": "planned"}
        assert_code(self, "INVALID_ARGUMENT", learning.validate_record_draft, draft)
        draft["experiment"] = {"status": "pending", "run_ref": "run-fixture-1"}
        assert_code(self, "INVALID_ARGUMENT", learning.validate_record_draft, draft)

    def test_agent_explanation_can_never_be_a_user_claim(self):
        draft = support.make_draft(self.workspace)
        draft["mental_model"] = {"status": "agent_explanation", "text": "static reasoning", "author": "user"}
        assert_code(self, "INVALID_ARGUMENT", learning.validate_record_draft, draft)
        draft["mental_model"] = {"status": "agent_explanation", "text": "static reasoning", "author": "agent"}
        self.assertEqual("agent", learning.validate_record_draft(draft)["mental_model"]["author"])
        draft["mental_model"] = {"status": "user_provided", "text": "my model", "author": "agent"}
        assert_code(self, "INVALID_ARGUMENT", learning.validate_record_draft, draft)
        draft["mental_model"] = {"status": "user_provided", "text": "my model", "author": "user"}
        self.assertEqual("user", learning.validate_record_draft(draft)["mental_model"]["author"])

    def test_prediction_requires_real_user_provided_fields(self):
        draft = support.make_draft(self.workspace)
        draft["prediction"] = {"status": "user_provided"}
        assert_code(self, "INVALID_ARGUMENT", learning.validate_record_draft, draft)
        draft["prediction"] = {"status": "user_provided", "text": "queue drains late"}
        assert_code(self, "INVALID_ARGUMENT", learning.validate_record_draft, draft)
        draft["prediction"] = {"status": "pending", "text": "queue drains late"}
        assert_code(self, "INVALID_ARGUMENT", learning.validate_record_draft, draft)
        draft["prediction"] = {
            "status": "user_provided",
            "text": "queue drains late",
            "provided_at": "2026-11-07T00:00:00Z",
        }
        self.assertEqual("user_provided", learning.validate_record_draft(draft)["prediction"]["status"])

    def test_next_action_is_at_most_one_with_full_criteria(self):
        draft = support.make_draft(self.workspace)
        draft["next_action"] = {"text": "grep queue_work", "estimated_minutes": 10}
        assert_code(self, "INVALID_ARGUMENT", learning.validate_record_draft, draft)
        draft["next_action"] = {"text": "grep queue_work", "estimated_minutes": 0,
                                "completion_criterion": "found call site"}
        assert_code(self, "INVALID_ARGUMENT", learning.validate_record_draft, draft)
        draft["next_action"] = {"text": "grep queue_work", "estimated_minutes": 10,
                                "completion_criterion": "found call site", "extra": True}
        assert_code(self, "INVALID_ARGUMENT", learning.validate_record_draft, draft)
        draft["next_action"] = [{"text": "a", "estimated_minutes": 1, "completion_criterion": "b"}]
        assert_code(self, "INVALID_ARGUMENT", learning.validate_record_draft, draft)
        draft["next_action"] = {"text": "grep queue_work", "estimated_minutes": 10,
                                "completion_criterion": "found call site"}
        self.assertEqual("grep queue_work", learning.validate_record_draft(draft)["next_action"]["text"])

    def test_supported_rules_need_evidence(self):
        draft = support.make_draft(self.workspace)
        draft["rules"] = [
            {"text": "workqueue runs later", "evidence_refs": [], "applicable_scope": "kmd", "status": "supported"}
        ]
        assert_code(self, "INVALID_ARGUMENT", learning.validate_record_draft, draft)
        draft["rules"] = [
            {"text": "workqueue runs later", "evidence_refs": [], "applicable_scope": "kmd", "status": "candidate"}
        ]
        self.assertEqual("candidate", learning.validate_record_draft(draft)["rules"][0]["status"])

    def test_done_applied_requires_real_evidence(self):
        draft = support.make_draft(self.workspace)
        draft["decision"] = "DONE-APPLIED"
        assert_code(self, "INVALID_ARGUMENT", learning.validate_record_draft, draft)
        ref = support.evidence_ref(self.env)
        draft = support.make_draft(self.workspace, evidence_refs=[ref])
        draft["experiment"] = {"status": "executed", "run_ref": "run-fixture-1"}
        draft["observation"] = {"status": "observed", "text": "observed", "evidence_refs": [ref]}
        draft["decision"] = "DONE-APPLIED"
        self.assertEqual("DONE-APPLIED", learning.validate_record_draft(draft)["decision"])


class SaveRecordTests(RecordStoreTestCase):
    def test_save_assigns_generation_storage_and_pending_prediction(self):
        ref = support.evidence_ref(self.env)
        result = self.save(self.draft(evidence_refs=[ref]))
        self.assertEqual(1, result["schema_version"])
        self.assertEqual(1, result["generation"])
        self.assertEqual(WORKSPACE, result["workspace_id"])
        record_id = result["record_id"]
        self.assertTrue(record_id.startswith("rec_"))
        expected_rel = f"records/{record_id}/1.json"
        self.assertEqual(expected_rel, result["revision_ref"])
        body_path = support.record_body_path(self.env, record_id, 1)
        self.assertTrue(body_path.is_file())
        self.assertEqual(sha256_file(body_path), result["sha256"])
        body = support.read_record_body(self.env, record_id, 1)
        self.assertEqual(1, body["generation"])
        self.assertEqual("pending", body["prediction"]["status"])
        self.assertEqual("pending", body["mental_model"]["status"])
        self.assertEqual([ref], body["evidence_refs"])

        fetched = records.get_record(self.env.state, WORKSPACE, record_id)
        self.assertEqual(record_id, fetched["record_id"])
        self.assertEqual(1, fetched["generation"])
        self.assertEqual("pending", fetched["prediction"]["status"])
        self.assertEqual("fresh", fetched["freshness"])

    def test_save_persists_sqlite_metadata(self):
        result = self.save(self.draft())
        record_id = result["record_id"]
        connection = support.db(self.env)
        try:
            self.assertEqual(1, connection.execute("PRAGMA user_version").fetchone()[0])
            journal = connection.execute("PRAGMA journal_mode").fetchone()[0]
            self.assertEqual("wal", journal.lower())
            tables = {
                row[0]
                for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            self.assertTrue(
                {"workspaces", "records", "revisions", "operations", "event_inbox", "consumer_cursors"}
                <= tables
            )
            row = connection.execute(
                "SELECT workspace_id, generation, freshness, archived FROM records WHERE record_id = ?",
                (record_id,),
            ).fetchone()
            self.assertEqual(WORKSPACE, row["workspace_id"])
            self.assertEqual(1, row["generation"])
            self.assertEqual("fresh", row["freshness"])
            self.assertEqual(0, row["archived"])
            revision = connection.execute(
                "SELECT generation, sha256, relative_path FROM revisions WHERE record_id = ?",
                (record_id,),
            ).fetchone()
            self.assertEqual(1, revision["generation"])
            self.assertEqual(result["sha256"], revision["sha256"])
            self.assertEqual(result["revision_ref"], revision["relative_path"])
            operation = connection.execute(
                "SELECT request_sha256, result_ref FROM operations"
            ).fetchone()
            self.assertEqual(64, len(operation["request_sha256"]))
            self.assertEqual(record_id, json.loads(operation["result_ref"])["record_id"])
        finally:
            connection.close()

    def test_save_cas_conflict_never_overwrites(self):
        result = self.save(self.draft())
        record_id = result["record_id"]
        draft2 = self.draft()
        draft2["record_id"] = record_id
        assert_code(self, "STATE_CONFLICT", self.save, draft2, expected=0)
        result2 = self.save(draft2, expected=1)
        self.assertEqual(2, result2["generation"])
        body1 = support.record_body_path(self.env, record_id, 1)
        body2 = support.record_body_path(self.env, record_id, 2)
        self.assertTrue(body1.is_file())
        self.assertTrue(body2.is_file())
        self.assertEqual(record_id, support.read_record_body(self.env, record_id, 1)["record_id"])
        assert_code(self, "STATE_CONFLICT", self.save, draft2, expected=1)
        latest = records.get_record(self.env.state, WORKSPACE, record_id)
        self.assertEqual(2, latest["generation"])

    def test_operation_idempotency_same_digest_replays_result(self):
        draft = self.draft()
        operation = support.new_operation_id()
        first = self.save(draft, operation_id=operation)
        second = self.save(draft, operation_id=operation)
        self.assertEqual(first, second)
        self.assertEqual(1, second["generation"])
        self.assertEqual(1, len(list((self.env.state.state_root / "records").glob("*/1.json"))))
        connection = support.db(self.env)
        try:
            self.assertEqual(1, connection.execute("SELECT COUNT(*) FROM operations").fetchone()[0])
            self.assertEqual(1, connection.execute("SELECT COUNT(*) FROM revisions").fetchone()[0])
        finally:
            connection.close()

    def test_operation_conflict_on_different_digest(self):
        operation = support.new_operation_id()
        first = self.save(self.draft(), operation_id=operation)
        changed = self.draft(goal={"question": "different question", "level": "K1", "nature": ["Q"]})
        changed["record_id"] = first["record_id"]
        error = assert_code(self, "OPERATION_CONFLICT", self.save, changed, operation_id=operation)
        self.assertIn("operation", str(error.message).lower())

    def test_save_rejects_bool_generation_and_bad_draft(self):
        assert_code(self, "INVALID_ARGUMENT", self.save, True, expected=0)
        assert_code(self, "INVALID_ARGUMENT", self.save, "not-an-object", expected=0)
        assert_code(self, "INVALID_ARGUMENT", self.save, self.draft(), expected=True)

    def test_save_requires_registered_workspace_and_matching_identity(self):
        assert_code(self, "NOT_FOUND", self.save, self.draft(), expected=0, workspace_ref="missing-workspace")
        draft = self.draft()
        draft["workspace_id"] = support.OTHER_WORKSPACE_ID
        assert_code(self, "SCOPE_DENIED", self.save, draft)
        draft = self.draft()
        draft["workspace_revision"] = 99
        assert_code(self, "STATE_CONFLICT", self.save, draft)

    def test_save_rejects_archived_record_growth(self):
        draft = self.draft()
        draft["archived"] = True
        result = self.save(draft)
        self.assertTrue(records.get_record(self.env.state, WORKSPACE, result["record_id"])["archived"])
        draft2 = self.draft()
        draft2["record_id"] = result["record_id"]
        draft2["archived"] = False
        assert_code(self, "STATE_CONFLICT", self.save, draft2, expected=1)

    def test_save_keeps_agent_explanation_separate_from_user_prediction(self):
        draft = self.draft()
        draft["mental_model"] = {
            "status": "agent_explanation",
            "text": "The ioctl enqueues a work item; completion is asynchronous.",
            "author": "agent",
        }
        result = self.save(draft)
        body = records.get_record(self.env.state, WORKSPACE, result["record_id"])
        self.assertEqual("agent_explanation", body["mental_model"]["status"])
        self.assertEqual("agent", body["mental_model"]["author"])
        self.assertEqual({"status": "pending"}, body["prediction"])

    def test_custom_record_id_is_honoured(self):
        draft = self.draft()
        draft["record_id"] = "custom-record.1"
        result = self.save(draft)
        self.assertEqual("custom-record.1", result["record_id"])
        self.assertEqual("custom-record.1", records.get_record(self.env.state, WORKSPACE, "custom-record.1")["record_id"])

    def test_get_record_not_found(self):
        error = assert_code(
            self, "NOT_FOUND", records.get_record, self.env.state, WORKSPACE, "rec_missing"
        )
        self.assertIn("record", str(error.message).lower())

    def test_body_tamper_is_detected_on_read(self):
        result = self.save(self.draft())
        path = support.record_body_path(self.env, result["record_id"], 1)
        self.assertTrue(path.is_file())
        with open(path, "ab") as handle:
            handle.write(b"\n")
        assert_code(
            self, "DEPENDENCY_UNAVAILABLE", records.get_record, self.env.state, WORKSPACE, result["record_id"]
        )


class RecordScopeTests(RecordStoreTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.other_workspace = support.make_other_workspace(self.env, self.workspace)

    def test_get_record_is_workspace_scoped(self):
        other_result = support.save(self.env, self.other_workspace, support.make_draft(self.other_workspace))
        assert_code(
            self,
            "SCOPE_DENIED",
            records.get_record,
            self.env.state,
            WORKSPACE,
            other_result["record_id"],
        )
        own = records.get_record(self.env.state, support.OTHER_WORKSPACE_ID, other_result["record_id"])
        self.assertEqual(support.OTHER_WORKSPACE_ID, own["workspace_id"])

    def test_export_record_is_workspace_scoped(self):
        other_result = support.save(self.env, self.other_workspace, support.make_draft(self.other_workspace))
        assert_code(
            self,
            "SCOPE_DENIED",
            records.export_record,
            self.env.state,
            WORKSPACE,
            other_result["record_id"],
            fmt="markdown",
        )


class ExportRecordTests(RecordStoreTestCase):
    def test_markdown_marks_pending_and_stale_fields_with_evidence(self):
        ref = support.evidence_ref(self.env)
        result = self.save(self.draft(evidence_refs=[ref], freshness="stale", invalidation_reasons=["fixture_change"]))
        exported = self.export(result["record_id"], fmt="markdown")
        self.assertEqual(1, exported["schema_version"])
        self.assertEqual("markdown", exported["format"])
        self.assertFalse(exported["uploaded"])
        path = self.env.state.exports_dir() / exported["export_ref"]
        self.assertTrue(path.is_file())
        self.assertEqual(str(path.name), exported["export_ref"])
        data = path.read_bytes()
        self.assertEqual(len(data), exported["bytes"])
        self.assertEqual(sha256_bytes(data), exported["sha256"])
        text = data.decode("utf-8")
        lowered = text.lower()
        self.assertIn("prediction", lowered)
        self.assertIn("pending", lowered)
        self.assertIn("stale", lowered)
        self.assertIn("agent", lowered)
        self.assertIn(ref, text)
        self.assertIn("fixture_change", text)
        self.assertIn("re-verify", lowered)

    def test_markdown_of_fresh_record_says_fresh_but_still_pending_prediction(self):
        result = self.save(self.draft())
        exported = self.export(result["record_id"], fmt="markdown")
        text = self.markdown_text(exported)
        self.assertIn("fresh", text.lower())
        self.assertIn("pending", text.lower())

    def test_json_export_is_exact_revision_copy(self):
        ref = support.evidence_ref(self.env)
        result = self.save(self.draft(evidence_refs=[ref]))
        body_bytes = support.record_body_path(self.env, result["record_id"], 1).read_bytes()
        exported = self.export(result["record_id"], fmt="json")
        path = self.env.state.exports_dir() / exported["export_ref"]
        self.assertEqual(body_bytes, path.read_bytes())
        self.assertEqual(sha256_bytes(body_bytes), exported["sha256"])
        self.assertEqual(len(body_bytes), exported["bytes"])
        self.assertEqual("json", exported["format"])
        self.assertFalse(exported["uploaded"])

    def test_export_rejects_unknown_format(self):
        result = self.save(self.draft())
        assert_code(self, "INVALID_ARGUMENT", self.export, result["record_id"], fmt="pdf")


if __name__ == "__main__":
    unittest.main()
