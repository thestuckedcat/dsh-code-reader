"""CL-006 acceptance tests: local recheck, resume and optional event invalidation.

Design references: ``docs/software-design.md`` §4.3/§8/§9 and
``docs/implementation-contract.md`` §8.  Events may only accelerate
invalidation; they can never prove freshness and never replace the local hash
recheck performed by ``resume``.
"""

from __future__ import annotations

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
from code_learning import invalidation, records  # noqa: E402
from code_learning.errors import CodeLearningError  # noqa: E402
from code_learning.util import sha256_file  # noqa: E402

WORKSPACE = support.WORKSPACE_ID


def assert_code(testcase: unittest.TestCase, code: str, callable_, *args, **kwargs) -> CodeLearningError:
    with testcase.assertRaises(CodeLearningError) as context:
        callable_(*args, **kwargs)
    testcase.assertEqual(code, context.exception.code, msg=str(context.exception))
    return context.exception


class InvalidationTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="rec-invalidation-")
        self.addCleanup(self._tmp.cleanup)
        self.env, self.workspace = support.make_env(Path(self._tmp.name))

    # -- helpers -------------------------------------------------------
    def save_record(self, *, evidence_refs=None, **overrides):
        draft = support.make_draft(self.workspace, evidence_refs=evidence_refs, **overrides)
        return support.save(self.env, self.workspace, draft)

    def save_two_records(self):
        first = self.save_record()
        second = self.save_record()
        return first["record_id"], second["record_id"]

    def resume(self, record_id: str):
        return records.resume_record(self.env.state, WORKSPACE, record_id)

    def consume(self, event):
        return support.consume_event(self.env, event)

    def freshness_in_db(self, record_id: str) -> str:
        return support.record_row(self.env, record_id)["freshness"]

    def event(self, fixture: str, **overrides):
        return support.load_event(fixture, **overrides)


class ResumeRecordTests(InvalidationTestCase):
    def test_resume_fresh_record_returns_safe_cursor(self):
        ref = support.evidence_ref(self.env)
        result = self.save_record(evidence_refs=[ref])
        record_id = result["record_id"]
        resumed = self.resume(record_id)
        self.assertEqual(1, resumed["schema_version"])
        self.assertEqual("fresh", resumed["freshness"])
        self.assertEqual([], resumed["changed_inputs"])
        self.assertEqual([], resumed["required_rechecks"])
        self.assertEqual(record_id, resumed["record"]["record_id"])
        self.assertEqual(1, resumed["record"]["generation"])
        self.assertEqual("pending", resumed["record"]["prediction"]["status"])
        cursor = resumed["safe_cursor"]
        self.assertEqual("recheck_evidence_first", cursor["reason"])
        self.assertIn("recheck", cursor["message"].lower())
        self.assertEqual(ref, cursor["evidence_ref"])
        self.assertEqual(self.workspace["revision"], cursor["workspace_revision"])
        self.assertIn("do not treat", cursor["message"].lower())

    def test_resume_without_evidence_refs_is_fresh_when_inputs_match(self):
        result = self.save_record()
        self.assertEqual("fresh", self.resume(result["record_id"])["freshness"])

    def test_resume_detects_unreferenced_source_change(self):
        result = self.save_record()
        support.append_text(self.env.kmd / "driver" / "job_queue.c", "\n/* fixture edit */\n")
        resumed = self.resume(result["record_id"])
        self.assertEqual("stale", resumed["freshness"])
        self.assertTrue(any("source_manifest" in item for item in resumed["changed_inputs"]))
        self.assertTrue(resumed["required_rechecks"])

    def test_resume_detects_config_change(self):
        result = self.save_record()
        support.append_text(self.env.kmd / ".config", "CONFIG_FIXTURE_NEW=y\n")
        resumed = self.resume(result["record_id"])
        self.assertEqual("stale", resumed["freshness"])
        self.assertIn("kmd:.config", resumed["changed_inputs"])

    def test_resume_detects_compdb_change(self):
        result = self.save_record()
        support.append_text(self.env.kmd / "compile_commands.json", "\n")
        resumed = self.resume(result["record_id"])
        self.assertEqual("stale", resumed["freshness"])
        self.assertIn("kmd:compile_commands.json", resumed["changed_inputs"])

    def test_resume_detects_generated_header_change(self):
        result = self.save_record()
        support.append_text(self.env.kmd / "include" / "generated" / "autoconf.h", "/* edit */\n")
        resumed = self.resume(result["record_id"])
        self.assertEqual("stale", resumed["freshness"])
        self.assertIn("kmd:include/generated/autoconf.h", resumed["changed_inputs"])

    def test_resume_detects_toolchain_digest_change(self):
        result = self.save_record()
        identity = self.workspace["variants"][0]["build_identity"]
        identity["toolchain_digest"] = "a" * 64
        support.write_workspace(self.env, self.workspace)
        resumed = self.resume(result["record_id"])
        self.assertEqual("stale", resumed["freshness"])
        self.assertTrue(any("toolchain_digest" in item for item in resumed["changed_inputs"]))

    def test_resume_detects_evidence_sha_mismatch(self):
        forged = support.forged_evidence_ref(self.env)  # real path, wrong sha256
        result = self.save_record(evidence_refs=[forged])
        resumed = self.resume(result["record_id"])
        self.assertEqual("stale", resumed["freshness"])
        self.assertIn("evidence:umd:src/job_submit.c", resumed["changed_inputs"])
        self.assertEqual([], [item for item in resumed["changed_inputs"] if "source_manifest" in item])

    def test_resume_unknown_when_evidence_file_is_missing(self):
        forged = support.forged_evidence_ref(self.env, p="src/does-not-exist.c")
        result = self.save_record(evidence_refs=[forged])
        resumed = self.resume(result["record_id"])
        self.assertEqual("unknown", resumed["freshness"])
        self.assertIn("evidence:umd:src/does-not-exist.c", resumed["changed_inputs"])
        self.assertTrue(resumed["required_rechecks"])
        self.assertEqual(forged, resumed["safe_cursor"]["evidence_ref"])

    def test_resume_unknown_on_invalid_signed_evidence(self):
        result = self.save_record(evidence_refs=["not-a-signed-token"])
        resumed = self.resume(result["record_id"])
        self.assertEqual("unknown", resumed["freshness"])
        self.assertTrue(resumed["required_rechecks"])

    def test_resume_workspace_revision_change_is_conservative_unknown(self):
        result = self.save_record()
        support.bump_workspace_revision(self.env, self.workspace)
        resumed = self.resume(result["record_id"])
        self.assertEqual("unknown", resumed["freshness"])
        self.assertEqual("workspace_revision_changed", resumed.get("reason"))
        self.assertIn("workspace_revision", resumed["changed_inputs"])

    def test_resume_never_rewrites_the_stored_revision(self):
        ref = support.evidence_ref(self.env)
        result = self.save_record(evidence_refs=[ref])
        body_path = support.record_body_path(self.env, result["record_id"], 1)
        before = body_path.read_bytes()
        support.append_text(self.env.umd / "src" / "job_submit.c", "\n/* edit */\n")
        resumed = self.resume(result["record_id"])
        self.assertEqual("stale", resumed["freshness"])
        self.assertEqual(before, body_path.read_bytes())
        self.assertEqual(sha256_file(body_path), result["sha256"])

    def test_resume_missing_record_and_foreign_record(self):
        assert_code(self, "NOT_FOUND", self.resume, "rec_missing")
        other_workspace = support.make_other_workspace(self.env, self.workspace)
        other = support.save(self.env, other_workspace, support.make_draft(other_workspace))
        assert_code(self, "SCOPE_DENIED", self.resume, other["record_id"])


class ConsumeEventTests(InvalidationTestCase):
    def test_workspace_restored_event_marks_records_stale(self):
        first, second = self.save_two_records()
        event = self.event("workspace_files_restored_committed.json", event_id="ev-fixture-1", generation=1)
        result = self.consume(event)
        self.assertEqual(1, result["schema_version"])
        self.assertTrue(result["accepted"])
        self.assertEqual({first, second}, set(result["stale_record_refs"]))
        self.assertEqual([], result["unknown_record_refs"])
        self.assertTrue(result["requires_local_recheck"])
        self.assertFalse(result["gap_detected"])
        self.assertEqual("stale", self.freshness_in_db(first))
        self.assertEqual("stale", self.freshness_in_db(second))
        self.assertEqual(1, support.event_count(self.env))
        cursor = result["next_cursor"]
        self.assertEqual("capability-03-facts", cursor["source"])
        self.assertEqual(1, cursor["last_sequence"])
        self.assertFalse(cursor["gap_detected"])

    def test_event_id_is_idempotent(self):
        first, second = self.save_two_records()
        event = self.event("workspace_files_restored_committed.json", event_id="ev-duplicate", generation=1)
        first_result = self.consume(event)
        again = self.consume(event)
        self.assertFalse(again["accepted"])
        self.assertEqual([], again["stale_record_refs"])
        self.assertEqual([], again["unknown_record_refs"])
        self.assertEqual(1, support.event_count(self.env))
        self.assertEqual(first_result["next_cursor"]["last_sequence"], again["next_cursor"]["last_sequence"])
        self.assertEqual("stale", self.freshness_in_db(first))
        self.assertEqual("stale", self.freshness_in_db(second))

    def test_out_of_order_event_is_audited_but_not_applied(self):
        record_id, _second = self.save_two_records()
        applied = self.event("workspace_files_restored_committed.json", event_id="ev-new", generation=5)
        result = self.consume(applied)
        self.assertTrue(result["accepted"])
        self.assertEqual("stale", self.freshness_in_db(record_id))
        audit = self.event("session_removed_unknown.json", event_id="ev-old", generation=4)
        old_result = self.consume(audit)
        self.assertTrue(old_result["accepted"])
        self.assertEqual([], old_result["stale_record_refs"])
        self.assertEqual([], old_result["unknown_record_refs"])
        self.assertEqual(5, old_result["next_cursor"]["last_sequence"])
        self.assertEqual("stale", self.freshness_in_db(record_id))
        self.assertEqual(2, support.event_count(self.env))

    def test_generation_gap_detected_and_local_recheck_still_works(self):
        record_id, _second = self.save_two_records()
        first = self.event(
            "session_surface_rewound_partial.json",
            event_id="ev-gap-1",
            generation=1,
            outcome="committed",
            affected_refs=[f"record:{record_id}"],
        )
        result = self.consume(first)
        self.assertFalse(result["gap_detected"])
        self.assertEqual("stale", self.freshness_in_db(record_id))
        gap_event = self.event("workspace_files_restored_committed.json", event_id="ev-gap-3", generation=3)
        gap_result = self.consume(gap_event)
        self.assertTrue(gap_result["gap_detected"])
        self.assertTrue(gap_result["requires_local_recheck"])
        self.assertEqual(3, gap_result["next_cursor"]["last_sequence"])
        # A lost/out-of-order event stream must never block the independent local recheck.
        resumed = self.resume(record_id)
        self.assertEqual("fresh", resumed["freshness"])
        self.assertEqual([], resumed["changed_inputs"])

    def test_partial_outcome_marks_unknown_conservatively(self):
        first, second = self.save_two_records()
        event = self.event(
            "session_surface_rewound_partial.json",
            event_id="ev-partial",
            generation=1,
            affected_refs=[f"record:{first}"],
        )
        result = self.consume(event)
        self.assertEqual([], result["stale_record_refs"])
        self.assertEqual([first], result["unknown_record_refs"])
        self.assertEqual("unknown", self.freshness_in_db(first))
        self.assertEqual("fresh", self.freshness_in_db(second))

    def test_unknown_outcome_marks_all_locatable_records_unknown(self):
        first, second = self.save_two_records()
        event = self.event(
            "workspace_files_restored_committed.json",
            event_id="ev-unknown-outcome",
            generation=1,
            outcome="unknown",
        )
        result = self.consume(event)
        self.assertEqual({first, second}, set(result["unknown_record_refs"]))
        self.assertEqual("unknown", self.freshness_in_db(first))
        self.assertEqual("unknown", self.freshness_in_db(second))

    def test_unlocatable_session_removal_marks_scope_records_unknown(self):
        first, second = self.save_two_records()
        event = self.event("session_removed_unknown.json", event_id="ev-session-removed", generation=1)
        result = self.consume(event)
        self.assertEqual({first, second}, set(result["unknown_record_refs"]))
        self.assertEqual("unknown", self.freshness_in_db(first))
        self.assertEqual("unknown", self.freshness_in_db(second))

    def test_committed_session_rewind_targets_only_named_record(self):
        first, second = self.save_two_records()
        event = self.event(
            "session_surface_rewound_partial.json",
            event_id="ev-rewind",
            generation=1,
            outcome="committed",
            affected_refs=[f"record:{first}"],
        )
        result = self.consume(event)
        self.assertEqual([first], result["stale_record_refs"])
        self.assertEqual([], result["unknown_record_refs"])
        self.assertEqual("stale", self.freshness_in_db(first))
        self.assertEqual("fresh", self.freshness_in_db(second))

    def test_archived_records_are_not_invalidated(self):
        archived_draft = support.make_draft(self.workspace, archived=True)
        archived = support.save(self.env, self.workspace, archived_draft)
        active = self.save_record()
        event = self.event("workspace_files_restored_committed.json", event_id="ev-archived", generation=1)
        result = self.consume(event)
        self.assertEqual([active["record_id"]], result["stale_record_refs"])
        self.assertNotIn(archived["record_id"], result["stale_record_refs"])
        self.assertEqual("fresh", self.freshness_in_db(archived["record_id"]))
        self.assertEqual("stale", self.freshness_in_db(active["record_id"]))

    def test_invalid_events_are_rejected(self):
        base = self.event("workspace_files_restored_committed.json", event_id="ev-invalid", generation=1)
        cases = [
            ("INVALID_ARGUMENT", {**base, "kind": "session_replayed"}),
            ("INVALID_ARGUMENT", {**base, "mystery": True}),
            ("INVALID_ARGUMENT", {**base, "outcome": "maybe"}),
            ("INVALID_ARGUMENT", {**base, "generation": -1}),
            ("INVALID_ARGUMENT", {key: value for key, value in base.items() if key != "event_id"}),
            ("UNSUPPORTED_SCHEMA", {**base, "schema_version": 2}),
            ("SCOPE_DENIED", {**base, "scope_ref": "another-scope"}),
        ]
        for expected_code, event in cases:
            assert_code(self, expected_code, self.consume, event)

    def test_consume_event_requires_registered_workspace(self):
        event = self.event("workspace_files_restored_committed.json", event_id="ev-missing-ws", generation=1)
        assert_code(self, "NOT_FOUND", support.consume_event, self.env, event, "missing-workspace")

    def test_in_order_events_advance_cursor_without_proving_freshness(self):
        record_id, _second = self.save_two_records()
        for generation in (1, 2):
            event = self.event(
                "workspace_files_restored_committed.json",
                event_id=f"ev-order-{generation}",
                generation=generation,
            )
            result = self.consume(event)
            self.assertTrue(result["accepted"])
            self.assertEqual(generation, result["next_cursor"]["last_sequence"])
        self.assertEqual("stale", self.freshness_in_db(record_id))
        self.assertNotEqual("fresh", self.freshness_in_db(record_id))


if __name__ == "__main__":
    unittest.main()
