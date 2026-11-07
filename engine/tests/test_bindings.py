"""CL-004-A bindings: strict CrossRepoBindingV1 validation and status recompute.

``status`` is always recomputed from evidence: missing interface revision /
shared definition / one-end evidence / selector value evidence -> incomplete;
mutually exclusive bindings or non-contiguous duplicate revisions ->
conflicting; changed identity or evidence summary -> stale; everything present
-> supported, which can still only become an ``abi_bridge`` with certainty
``may`` (never ``exact``).
"""

from __future__ import annotations

import copy
import unittest

from tests import helpers
from tests.fixtures.snapshots import support

from code_learning import bindings
from code_learning.errors import CodeLearningError


class BindingEvaluationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = support.make_workspace()
        self.workspace["bindings"] = []

    def _evaluate(self, *items):
        return bindings.evaluate_bindings(self.workspace, list(items))

    def _expect_error(self, code, callable_):
        with self.assertRaises(CodeLearningError) as context:
            callable_()
        self.assertEqual(context.exception.code, code, context.exception.message)
        return context.exception

    def test_supported_requires_all_evidence_and_stays_may(self) -> None:
        result = self._evaluate(helpers.binding())
        self.assertEqual(len(result), 1)
        item = result[0]
        self.assertEqual(item["status"], "supported")
        self.assertEqual(item["binding_id"], "job-ioctl-umd-kmd")
        self.assertEqual(item["revision"], 1)
        self.assertEqual(item["from"]["repo_id"], "umd")
        self.assertEqual(item["to"]["repo_id"], "kmd")
        candidate = item["bridge_candidate"]
        self.assertTrue(candidate["can_bridge"])
        self.assertEqual(candidate["certainty"], "may")
        self.assertEqual(candidate["relation"], "abi_bridge")
        self.assertNotEqual(candidate["certainty"], "exact")
        self.assertEqual(len(item["binding_digest"]), 64)

    def test_supported_origin_variants_never_upgrade_to_exact(self) -> None:
        for origin in ("source_derived", "agent", "user_note"):
            with self.subTest(origin=origin):
                entry = helpers.binding(binding_id=f"binding-{origin}")
                entry["origin"] = origin
                result = self._evaluate(entry)[0]
                self.assertEqual(result["status"], "supported")
                self.assertEqual(result["bridge_candidate"]["certainty"], "may")

    def test_incomplete_when_evidence_is_missing(self) -> None:
        cases = {
            "from_version": lambda entry: entry["from"].update({"interface_revision_ref": None}),
            "to_version": lambda entry: entry["to"].update({"interface_revision_ref": None}),
            "from_evidence": lambda entry: entry["from"].update({"source_evidence_refs": []}),
            "to_evidence": lambda entry: entry["to"].update({"source_evidence_refs": []}),
            "shared_definition": lambda entry: entry.update({"shared_definition_evidence_refs": []}),
            "selector_value": lambda entry: entry["selector"].update({"value_evidence_refs": []}),
        }
        for name, mutate in cases.items():
            with self.subTest(name=name):
                entry = helpers.binding(binding_id=f"incomplete-{name}")
                mutate(entry)
                result = self._evaluate(entry)[0]
                self.assertEqual(result["status"], "incomplete")
                self.assertFalse(result["bridge_candidate"]["can_bridge"])
                self.assertTrue(result["bridge_candidate"]["incomplete_reasons"])

    def test_conflicting_when_same_selector_points_to_different_targets(self) -> None:
        first = helpers.binding(binding_id="conflict-left")
        second = helpers.binding(binding_id="conflict-right")
        second["to"]["interface_ref"] = "job_dispatch_other"
        result = self._evaluate(first, second)
        self.assertEqual([item["status"] for item in result], ["conflicting", "conflicting"])
        for item in result:
            self.assertFalse(item["bridge_candidate"]["can_bridge"])

    def test_different_selector_values_do_not_conflict(self) -> None:
        first = helpers.binding(binding_id="selector-one", selector_value="1")
        second = helpers.binding(binding_id="selector-two", selector_value="2")
        second["to"]["interface_ref"] = "job_dispatch_other"
        result = self._evaluate(first, second)
        self.assertEqual([item["status"] for item in result], ["supported", "supported"])

    def test_conflicting_when_endpoint_interface_revisions_disagree(self) -> None:
        entry = helpers.binding(binding_id="version-conflict")
        entry["to"]["interface_revision_ref"] = "uapi-rev-2"
        result = self._evaluate(entry)[0]
        self.assertEqual(result["status"], "conflicting")
        self.assertFalse(result["bridge_candidate"]["can_bridge"])

    def test_conflicting_when_duplicate_revisions_are_not_contiguous(self) -> None:
        first = helpers.binding(binding_id="duplicate")
        second = helpers.binding(binding_id="duplicate")
        second["revision"] = 3
        result = self._evaluate(first, second)
        self.assertEqual([item["status"] for item in result], ["conflicting"])

    def test_stale_when_identity_changes_after_previous_evaluation(self) -> None:
        original = helpers.binding()
        first = self._evaluate(original)
        self.assertEqual(first[0]["status"], "supported")
        self.workspace["bindings"] = first

        changed = helpers.binding()
        changed["revision"] = 2
        changed["from"]["interface_ref"] = "job_submit_v2"
        evaluated = self._evaluate(changed)[0]
        self.assertEqual(evaluated["status"], "stale")
        self.assertFalse(evaluated["bridge_candidate"]["can_bridge"])

    def test_stale_when_evidence_summary_changes_after_previous_evaluation(self) -> None:
        first = self._evaluate(helpers.binding())
        self.workspace["bindings"] = first

        changed = helpers.binding()
        changed["revision"] = 2
        changed["from"]["source_evidence_refs"] = ["different-umd-evidence"]
        evaluated = self._evaluate(changed)[0]
        self.assertEqual(evaluated["status"], "stale")

    def test_stale_through_explicit_previous_bindings_handoff(self) -> None:
        first = self._evaluate(helpers.binding())
        handoff = dict(self.workspace)
        handoff["bindings"] = []
        handoff["previous_bindings"] = first

        changed = helpers.binding()
        changed["revision"] = 2
        changed["from"]["interface_ref"] = "job_submit_v2"
        evaluated = bindings.evaluate_bindings(handoff, [changed])[0]
        self.assertEqual(evaluated["status"], "stale")

        unchanged = bindings.evaluate_bindings(handoff, [helpers.binding()])[0]
        self.assertEqual(unchanged["status"], "supported")

    def test_unchanged_reevaluation_stays_supported(self) -> None:
        first = self._evaluate(helpers.binding())
        self.workspace["bindings"] = first
        again = self._evaluate(helpers.binding())[0]
        self.assertEqual(again["status"], "supported")

        bumped = helpers.binding()
        bumped["revision"] = 2
        bumped_result = self._evaluate(bumped)[0]
        self.assertEqual(bumped_result["status"], "supported")

    def test_structural_validation_rejections(self) -> None:
        cases = {
            "unknown_field": lambda entry: entry.update({"surprise": True}),
            "bad_schema_version": lambda entry: entry.update({"schema_version": 2}),
            "same_repo": lambda entry: entry["to"].update({"repo_id": "umd"}),
            "unregistered_repo": lambda entry: entry["to"].update({"repo_id": "other"}),
            "unregistered_variant": lambda entry: entry["from"].update({"variant_id": "missing-variant"}),
            "bad_variant_pair": lambda entry: entry.update(
                {
                    "applicable_variant_pairs": [
                        {"from_variant": support.SECOND_VARIANT_ID, "to_variant": support.SECOND_VARIANT_ID}
                    ]
                }
            ),
            "missing_pairs": lambda entry: entry.update({"applicable_variant_pairs": []}),
            "bad_kind": lambda entry: entry.update({"kind": "magic"}),
            "bad_abi_endianness": lambda entry: entry["abi"].update({"endianness": "middle"}),
            "bad_abi_pointer_bits": lambda entry: entry["abi"].update({"pointer_bits": 16}),
            "bad_selector_kind": lambda entry: entry["selector"].update({"kind": "magic"}),
            "empty_selector_value": lambda entry: entry["selector"].update({"declared_value": ""}),
            "bad_origin": lambda entry: entry.update({"origin": "compiler"}),
            "bad_revision": lambda entry: entry.update({"revision": 0}),
            "missing_required": lambda entry: entry.pop("selector"),
            "bad_evidence_shape": lambda entry: entry["from"].update({"source_evidence_refs": "ref"}),
        }
        for name, mutate in cases.items():
            with self.subTest(name=name):
                entry = helpers.binding(binding_id=f"invalid-{name}")
                mutate(entry)
                self._expect_error("INVALID_ARGUMENT", lambda: self._evaluate(entry))

    def test_variant_pair_exact_match_is_required(self) -> None:
        self.workspace["variants"] = [
            support.make_variant(support.VARIANT_ID),
            support.make_variant(support.SECOND_VARIANT_ID),
        ]
        entry = helpers.binding()
        entry["applicable_variant_pairs"] = [
            {"from_variant": support.SECOND_VARIANT_ID, "to_variant": support.SECOND_VARIANT_ID}
        ]
        self._expect_error("INVALID_ARGUMENT", lambda: self._evaluate(entry))

        entry["applicable_variant_pairs"] = [
            {"from_variant": support.VARIANT_ID, "to_variant": support.VARIANT_ID}
        ]
        self.assertEqual(self._evaluate(entry)[0]["status"], "supported")

    def test_input_is_not_mutated(self) -> None:
        entry = helpers.binding()
        snapshot = copy.deepcopy(entry)
        self._evaluate(entry)
        self.assertEqual(entry, snapshot)

    def test_input_status_is_ignored_and_recomputed(self) -> None:
        entry = helpers.binding(status="incomplete")
        self.assertEqual(self._evaluate(entry)[0]["status"], "supported")

        entry = helpers.binding(status="supported")
        entry["to"]["source_evidence_refs"] = []
        self.assertEqual(self._evaluate(entry)[0]["status"], "incomplete")

    def test_bad_argument_shapes(self) -> None:
        self._expect_error("INVALID_ARGUMENT", lambda: bindings.evaluate_bindings(self.workspace, "not-a-list"))
        self._expect_error("INVALID_ARGUMENT", lambda: bindings.evaluate_bindings(None, []))

    def test_binding_digest_is_deterministic_and_order_independent(self) -> None:
        first = self._evaluate(helpers.binding())
        second_binding = helpers.binding(binding_id="second-binding")
        second_binding["from"]["interface_ref"] = "other_submit"
        second_binding["to"]["interface_ref"] = "other_dispatch"
        both = self._evaluate(helpers.binding(), second_binding)

        digest_a = bindings.binding_digest(both)
        digest_b = bindings.binding_digest(list(reversed(both)))
        self.assertEqual(digest_a, digest_b)
        self.assertEqual(len(digest_a), 64)
        self.assertEqual(first[0]["binding_digest"], both[0]["binding_digest"])

        changed = helpers.binding()
        changed["from"]["source_evidence_refs"] = ["changed-evidence"]
        changed_result = self._evaluate(changed)
        self.assertNotEqual(changed_result[0]["binding_digest"], first[0]["binding_digest"])

    def test_empty_binding_list(self) -> None:
        self.assertEqual(bindings.evaluate_bindings(self.workspace, []), [])

    def test_bridge_candidate_exposes_interface_refs(self) -> None:
        item = self._evaluate(helpers.binding())[0]
        candidate = item["bridge_candidate"]
        self.assertEqual(candidate["from_interface_ref"], "job_submit")
        self.assertEqual(candidate["to_interface_ref"], "job_dispatch")
        self.assertIn("static_contract_not_runtime_call", candidate["limitations"])


if __name__ == "__main__":
    unittest.main()
