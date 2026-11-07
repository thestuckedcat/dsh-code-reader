"""CL-004-A: bounded call-path queries and relation projections.

Call paths are reconstructed from ``graph.payload.call_targets`` (never from
path lines), so each emitted edge keeps the original callsite/origin/certainty/
evidence of the Atlas fact.  Cross-repository paths may only produce an
``abi_bridge``/``may`` edge for a ``supported`` binding; incomplete,
conflicting or stale bindings yield unresolved entries and no usable path.
Relation modes reject illegal selectors (INVALID_ARGUMENT) and report missing
analysis capability as ``status='unavailable'`` instead of fabricating data.
"""

from __future__ import annotations

import copy
import shutil
import tempfile
import unittest
from pathlib import Path

from tests import helpers
from tests.fixtures.snapshots import support

from code_learning import bindings, paths, snapshot
from code_learning.errors import CodeLearningError


def _functions_edges(result):
    return [edge for edge in result["edges"] if edge["relation"] == "call"]


def _bridge_edges(result):
    return [edge for edge in result["edges"] if edge["relation"] == "abi_bridge"]


def _unresolved_reasons(result):
    return {entry.get("reason") for entry in result["unresolved"]}


def _coverage_overrides(capabilities=None, **extra):
    coverage = {
        "selected_scope": "fixture",
        "total_available_units": 1,
        "processed_units": 1,
        "parsed": 1,
        "reused": 0,
        "failed": [],
        "pending_units": [],
        "complete_call_chain": False,
        "whole_program_complete": False,
        "requested_scope_complete": True,
        "capabilities": capabilities
        or {
            "direct_calls": "ready",
            "types": "ready",
            "global_objects": "ready",
            "locks": "not_requested",
            "data_flow": "not_requested",
            "cfg": "unsupported",
        },
    }
    coverage.update(extra)
    return coverage


class PathQueryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="cl-paths-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.env = helpers.make_bootstrap(self.tmp)
        self.workspace = support.make_workspace()
        support.install_workspace(self.env, self.workspace)
        self._patch = support.patch_workspace(self.workspace)
        self._patch.__enter__()
        self.addCleanup(self._patch.__exit__, None, None, None)

        self.umd_graph = support.graph_payload(
            functions=[
                support.function("fn_main", "main", file="umd/src/main.c", line=3),
                support.function("fn_submit", "job_submit", file="umd/src/job_submit.c", line=8),
                support.function(
                    "fn_submit_alias", "job_submit", file="umd/src/legacy_submit.c", line=6
                ),
                support.function("fn_ioctl", "__x64_sys_ioctl", file="umd/src/sys_ioctl.c", line=21),
                support.function("fn_handler", "job_handler", file="umd/src/handler.c", line=30),
            ],
            call_targets=[
                support.call_target(
                    "ct_main_submit",
                    callsite="cs_main",
                    source="fn_main",
                    target="fn_submit",
                    certainty="exact",
                    evidence=["ev_main"],
                ),
                support.call_target(
                    "ct_submit_ioctl",
                    callsite="cs_submit",
                    source="fn_submit",
                    target="fn_ioctl",
                    certainty="may",
                    evidence=["ev_submit"],
                ),
                support.call_target(
                    "ct_submit_ioctl_shadow",
                    callsite="cs_other",
                    source="fn_submit",
                    target="fn_ioctl",
                    certainty="exact",
                    evidence=["ev_other"],
                ),
            ],
            callsites=[
                support.callsite("cs_main", owner="fn_main", file="umd/src/main.c", line=6),
                support.callsite("cs_submit", owner="fn_submit", file="umd/src/job_submit.c", line=11),
                support.callsite("cs_other", owner="fn_submit", file="umd/src/job_submit.c", line=19),
            ],
            evidence=[
                support.evidence("ev_main", file="umd/src/main.c", line=6),
                support.evidence("ev_submit", file="umd/src/job_submit.c", line=11),
                support.evidence("ev_other", file="umd/src/job_submit.c", line=19),
            ],
            issues=[
                {
                    "id": "iss_indirect",
                    "kind": "semantic_unresolved",
                    "detail": "indirect call target is not resolved",
                    "symbol": "job_handler",
                    "evidence_ids": [],
                },
                {
                    "id": "iss_external",
                    "kind": "external_boundary",
                    "detail": "kernel boundary",
                    "symbol": "ioctl",
                    "evidence_ids": [],
                },
            ],
        )
        support.write_snapshot(self.env, "snap-umd", self.umd_graph)
        support.import_snapshot(self.env, self.workspace, "snap-umd", repo_id="umd")

    @property
    def workspace_id(self) -> str:
        return self.workspace["workspace_id"]

    def _query(self, from_ref, to_ref, **kwargs):
        return paths.query_path(
            self.env.state,
            self.workspace_id,
            support.VARIANT_ID,
            from_ref,
            to_ref,
            **kwargs,
        )

    def _expect_error(self, code, callable_):
        with self.assertRaises(CodeLearningError) as context:
            callable_()
        self.assertEqual(context.exception.code, code, context.exception.message)
        return context.exception

    # -- same-repository paths ------------------------------------------
    def test_path_edges_join_call_targets_and_keep_certainty(self) -> None:
        result = self._query("umd:fn_main", "umd:fn_ioctl")

        self.assertEqual(result["schema_version"], 1)
        self.assertEqual(result["snapshot_refs"], ["snap-umd"])
        self.assertEqual(result["freshness"], "fresh")
        self.assertEqual(
            [node["id"] for node in result["nodes"]],
            ["fn_main", "fn_submit", "fn_ioctl"],
        )
        node = result["nodes"][0]
        self.assertIn("node_ref", node)
        self.assertIn("snap-umd", node["node_ref"])
        self.assertEqual(node["repo_id"], "umd")

        by_id = {edge["edge_id"]: edge for edge in result["edges"]}
        self.assertEqual(by_id["ct_main_submit"]["certainty"], "exact")
        self.assertEqual(by_id["ct_main_submit"]["callsite"], "cs_main")
        self.assertEqual(by_id["ct_main_submit"]["origin"], "deterministic_analysis")
        self.assertEqual(by_id["ct_main_submit"]["evidence_ids"], ["ev_main"])
        # The may/path-insensitive fact must not be upgraded by the path line.
        self.assertEqual(by_id["ct_submit_ioctl"]["certainty"], "may")
        self.assertEqual(by_id["ct_submit_ioctl"]["callsite"], "cs_submit")
        self.assertEqual(by_id["ct_submit_ioctl"]["evidence_ids"], ["ev_submit"])
        self.assertEqual(by_id["ct_submit_ioctl_shadow"]["certainty"], "exact")
        self.assertEqual(by_id["ct_submit_ioctl_shadow"]["callsite"], "cs_other")
        for edge in result["edges"]:
            self.assertEqual(edge["relation"], "call")
            self.assertIn("unknown_target_possible", edge)

        reasons = _unresolved_reasons(result)
        self.assertIn("semantic_unresolved", reasons)
        self.assertIn("external_boundary", reasons)
        self.assertEqual(result["coverage"]["snap-umd"]["failed_count"], 0)
        self.assertIsInstance(result["budget_used"], int)
        self.assertGreaterEqual(result["budget_used"], 1)

    def test_ambiguous_symbol_returns_choices(self) -> None:
        error = self._expect_error(
            "AMBIGUOUS_SYMBOL",
            lambda: self._query("umd:job_submit", "umd:fn_ioctl"),
        )
        choices = error.details.get("choices") if error.details else None
        self.assertIsNotNone(choices)
        assert choices is not None
        self.assertEqual({choice["id"] for choice in choices}, {"fn_submit", "fn_submit_alias"})

    def test_exact_id_wins_over_name(self) -> None:
        result = self._query("umd:fn_submit", "umd:fn_ioctl")
        self.assertEqual([node["id"] for node in result["nodes"]], ["fn_submit", "fn_ioctl"])

    def test_bare_refs_allowed_for_single_variant_snapshot(self) -> None:
        result = self._query("main", "__x64_sys_ioctl")
        self.assertEqual(result["snapshot_refs"], ["snap-umd"])

        support.write_snapshot(self.env, "snap-chain", support.chain_graph(length=3))
        support.import_snapshot(self.env, self.workspace, "snap-chain", repo_id="uapi")
        self._expect_error("INVALID_ARGUMENT", lambda: self._query("main", "__x64_sys_ioctl"))

    def test_common_prefix_and_first_divergence_choices(self) -> None:
        branch = support.graph_payload(
            functions=[
                support.function("fn_start", "start", file="kmd/src/branch.c", line=1),
                support.function("fn_left", "left", file="kmd/src/branch.c", line=4),
                support.function("fn_right", "right", file="kmd/src/branch.c", line=8),
                support.function("fn_goal", "goal", file="kmd/src/branch.c", line=12),
            ],
            call_targets=[
                support.call_target(
                    "ct_sl", callsite="cs_s", source="fn_start", target="fn_left", evidence=["ev_1"]
                ),
                support.call_target(
                    "ct_sr", callsite="cs_s2", source="fn_start", target="fn_right", evidence=["ev_2"]
                ),
                support.call_target(
                    "ct_lg", callsite="cs_l", source="fn_left", target="fn_goal", evidence=["ev_3"]
                ),
                support.call_target(
                    "ct_rg", callsite="cs_r", source="fn_right", target="fn_goal", evidence=["ev_4"]
                ),
            ],
            callsites=[
                support.callsite("cs_s", owner="fn_start"),
                support.callsite("cs_s2", owner="fn_start"),
                support.callsite("cs_l", owner="fn_left"),
                support.callsite("cs_r", owner="fn_right"),
            ],
            evidence=[support.evidence(f"ev_{index}") for index in range(1, 5)],
        )
        support.write_snapshot(self.env, "snap-branch", branch)
        support.import_snapshot(self.env, self.workspace, "snap-branch", repo_id="kmd")

        result = self._query("kmd:fn_start", "kmd:fn_goal")
        self.assertEqual(len(result["edges"]), 4)
        self.assertEqual(len(result["common_prefix"]), 1)
        self.assertIn("fn_start", result["common_prefix"][0]["node_ref"])
        choice_ids = {choice["id"] for choice in result["choices"]}
        self.assertEqual(choice_ids, {"fn_left", "fn_right"})

    def test_direction_up_walks_callers(self) -> None:
        result = self._query("umd:fn_ioctl", "umd:fn_main", direction="up")
        self.assertEqual([node["id"] for node in result["nodes"]], ["fn_ioctl", "fn_submit", "fn_main"])
        call_edges = _functions_edges(result)
        self.assertTrue(call_edges)
        for edge in call_edges:
            self.assertTrue(edge["from_ref"].endswith("/fn_submit") or edge["from_ref"].endswith("/fn_main"))
            self.assertTrue(edge["to_ref"].endswith("/fn_ioctl") or edge["to_ref"].endswith("/fn_submit"))

    def test_budget_truncation_is_reported(self) -> None:
        support.write_snapshot(self.env, "snap-chain", support.chain_graph(length=6))
        support.import_snapshot(self.env, self.workspace, "snap-chain", repo_id="uapi")
        result = self._query("uapi:chain_0", "uapi:chain_5", budget=2)
        self.assertTrue(result["truncated"])
        self.assertLessEqual(result["budget_used"], 2)
        self.assertIn("budget_exhausted", _unresolved_reasons(result))

    def test_depth_truncation_is_reported(self) -> None:
        support.write_snapshot(self.env, "snap-chain", support.chain_graph(length=6))
        support.import_snapshot(self.env, self.workspace, "snap-chain", repo_id="uapi")
        result = self._query("uapi:chain_0", "uapi:chain_5", max_depth=2)
        self.assertTrue(result["truncated"])
        self.assertIn("depth_exhausted", _unresolved_reasons(result))

    def test_reference_candidates_are_not_fabricated_as_calls(self) -> None:
        result = self._query("umd:fn_main", "umd:fn_handler")
        self.assertEqual(_functions_edges(result), [])
        self.assertNotIn("fn_handler", [edge["to_ref"] for edge in result["edges"]])
        self.assertIn("target_not_reachable", _unresolved_reasons(result))

    def test_valid_result_reports_stale_freshness(self) -> None:
        self.workspace["revision"] = 2
        result = self._query("umd:fn_main", "umd:fn_ioctl")
        self.assertEqual(result["freshness"], "stale")

    # -- request validation ---------------------------------------------
    def test_path_argument_validation(self) -> None:
        self._expect_error("NOT_FOUND", lambda: self._query("umd:no_such_function", "umd:fn_ioctl"))
        self._expect_error("NOT_FOUND", lambda: self._query("uapi:chain_0", "uapi:chain_1"))
        self._expect_error("INVALID_ARGUMENT", lambda: self._query(None, "umd:fn_ioctl"))
        self._expect_error("INVALID_ARGUMENT", lambda: self._query("umd:fn_main", "umd:fn_ioctl", budget=0))
        self._expect_error("INVALID_ARGUMENT", lambda: self._query("umd:fn_main", "umd:fn_ioctl", budget=10001))
        self._expect_error("INVALID_ARGUMENT", lambda: self._query("umd:fn_main", "umd:fn_ioctl", max_depth=0))
        self._expect_error("INVALID_ARGUMENT", lambda: self._query("umd:fn_main", "umd:fn_ioctl", max_depth=101))
        self._expect_error(
            "INVALID_ARGUMENT", lambda: self._query("umd:fn_main", "umd:fn_ioctl", direction="sideways")
        )
        with self.assertRaises(CodeLearningError) as context:
            paths.query_path(
                self.env.state, self.workspace_id, "unknown-variant", "umd:fn_main", "umd:fn_ioctl"
            )
        self.assertEqual(context.exception.code, "NOT_FOUND")


class CrossRepoPathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="cl-cross-paths-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.env = helpers.make_bootstrap(self.tmp)
        self.workspace = support.make_workspace(
            variant_ids=(support.VARIANT_ID, support.SECOND_VARIANT_ID)
        )
        support.install_workspace(self.env, self.workspace)
        self._patch = support.patch_workspace(self.workspace)
        self._patch.__enter__()
        self.addCleanup(self._patch.__exit__, None, None, None)

        umd_graph = support.graph_payload(
            functions=[
                support.function("fn_main", "main", file="umd/src/main.c", line=3),
                support.function("fn_submit", "job_submit", file="umd/src/job_submit.c", line=8),
                support.function("fn_ioctl", "__x64_sys_ioctl", file="umd/src/sys_ioctl.c", line=21),
            ],
            call_targets=[
                support.call_target(
                    "ct_main_submit",
                    callsite="cs_main",
                    source="fn_main",
                    target="fn_submit",
                    certainty="exact",
                    evidence=["ev_main"],
                ),
            ],
            callsites=[support.callsite("cs_main", owner="fn_main", file="umd/src/main.c", line=6)],
            evidence=[support.evidence("ev_main", file="umd/src/main.c", line=6)],
        )
        kmd_graph = support.graph_payload(
            functions=[
                support.function("fn_dispatch", "job_dispatch", file="kmd/src/job_queue.c", line=10),
                support.function("fn_enqueue", "job_enqueue", file="kmd/src/job_queue.c", line=22),
                support.function("fn_complete", "job_complete", file="kmd/src/job_queue.c", line=30),
                # Same display name as the UMD entry point: a same-named static-ish
                # symbol in another repository must never satisfy the UMD endpoint.
                support.function("fn_submit_shadow", "job_submit", file="kmd/src/legacy.c", line=4),
            ],
            call_targets=[
                support.call_target(
                    "ct_dispatch_enqueue",
                    callsite="cs_dispatch",
                    source="fn_dispatch",
                    target="fn_enqueue",
                    certainty="exact",
                    evidence=["ev_dispatch"],
                ),
                support.call_target(
                    "ct_dispatch_complete",
                    callsite="cs_dispatch2",
                    source="fn_dispatch",
                    target="fn_complete",
                    certainty="may",
                    evidence=["ev_dispatch2"],
                ),
            ],
            callsites=[
                support.callsite("cs_dispatch", owner="fn_dispatch", file="kmd/src/job_queue.c", line=15),
                support.callsite("cs_dispatch2", owner="fn_dispatch", file="kmd/src/job_queue.c", line=18),
            ],
            evidence=[
                support.evidence("ev_dispatch", file="kmd/src/job_queue.c", line=15),
                support.evidence("ev_dispatch2", file="kmd/src/job_queue.c", line=18),
            ],
        )
        support.write_snapshot(self.env, "snap-umd", umd_graph)
        support.import_snapshot(self.env, self.workspace, "snap-umd", repo_id="umd")
        support.write_snapshot(self.env, "snap-kmd", kmd_graph)
        support.import_snapshot(self.env, self.workspace, "snap-kmd", repo_id="kmd")

        evaluated = bindings.evaluate_bindings(self.workspace, [helpers.binding()])
        self.assertEqual(evaluated[0]["status"], "supported")
        self.workspace["bindings"] = evaluated

    @property
    def workspace_id(self) -> str:
        return self.workspace["workspace_id"]

    def _query(self, from_ref, to_ref, **kwargs):
        return paths.query_path(
            self.env.state,
            self.workspace_id,
            support.VARIANT_ID,
            from_ref,
            to_ref,
            **kwargs,
        )

    def test_supported_binding_produces_may_abi_bridge(self) -> None:
        result = self._query("umd:job_submit", "kmd:job_enqueue")
        self.assertEqual(result["snapshot_refs"], ["snap-umd", "snap-kmd"])
        self.assertEqual(result["freshness"], "fresh")
        self.assertEqual(set(result["coverage"]), {"snap-umd", "snap-kmd"})

        bridges = _bridge_edges(result)
        self.assertEqual(len(bridges), 1)
        bridge = bridges[0]
        self.assertEqual(bridge["certainty"], "may")
        self.assertEqual(bridge["origin"], "derived")
        self.assertEqual(bridge["relation"], "abi_bridge")
        self.assertIn("snap-umd", bridge["from_ref"])
        self.assertIn("snap-kmd", bridge["to_ref"])
        self.assertTrue(bridge["from_ref"].endswith("/fn_submit"))
        self.assertTrue(bridge["to_ref"].endswith("/fn_dispatch"))
        self.assertTrue(bridge["evidence_refs"])

        call_edges = _functions_edges(result)
        self.assertEqual([edge["edge_id"] for edge in call_edges], ["ct_dispatch_enqueue"])
        self.assertIn("fn_submit", [node["id"] for node in result["nodes"]])
        self.assertIn("fn_dispatch", [node["id"] for node in result["nodes"]])
        self.assertIn("fn_enqueue", [node["id"] for node in result["nodes"]])
        # No fabricated call edge may cross the repository boundary.
        for edge in call_edges:
            from_snapshot = edge["from_ref"].split("/")[3]
            to_snapshot = edge["to_ref"].split("/")[3]
            self.assertEqual(from_snapshot, to_snapshot)

    def test_incomplete_conflicting_stale_bindings_block_the_path(self) -> None:
        blocked = []
        for index, status in enumerate(("incomplete", "conflicting", "stale")):
            item = helpers.binding(binding_id=f"job-ioctl-blocked-{index}")
            item["status"] = status
            blocked.append(item)
        self.workspace["bindings"] = blocked

        result = self._query("umd:job_submit", "kmd:job_enqueue")
        self.assertEqual(_bridge_edges(result), [])
        reasons = _unresolved_reasons(result)
        for status in ("incomplete", "conflicting", "stale"):
            self.assertIn(f"binding_{status}", reasons)

    def test_opposite_direction_binding_is_not_used(self) -> None:
        opposite = helpers.binding(binding_id="kmd-to-umd", from_repo="kmd", to_repo="umd")
        opposite["status"] = "supported"
        opposite["from"]["interface_ref"] = "job_dispatch"
        opposite["to"]["interface_ref"] = "job_submit"
        self.workspace["bindings"] = [opposite]

        result = self._query("umd:job_submit", "kmd:job_enqueue")
        self.assertEqual(_bridge_edges(result), [])
        self.assertIn("no_supported_binding", _unresolved_reasons(result))

    def test_binding_for_other_variant_is_not_used(self) -> None:
        other = helpers.binding(binding_id="other-variant")
        other["status"] = "supported"
        other["from"]["variant_id"] = support.SECOND_VARIANT_ID
        other["to"]["variant_id"] = support.SECOND_VARIANT_ID
        other["applicable_variant_pairs"] = [
            {"from_variant": support.SECOND_VARIANT_ID, "to_variant": support.SECOND_VARIANT_ID}
        ]
        self.workspace["bindings"] = [other]

        result = self._query("umd:job_submit", "kmd:job_enqueue")
        self.assertEqual(_bridge_edges(result), [])
        self.assertIn("no_supported_binding", _unresolved_reasons(result))

    def test_binding_interface_missing_is_unresolved(self) -> None:
        broken = helpers.binding(binding_id="missing-interface")
        broken["status"] = "supported"
        broken["from"]["interface_ref"] = "job_submit_missing"
        self.workspace["bindings"] = [broken]

        result = self._query("umd:job_submit", "kmd:job_enqueue")
        self.assertEqual(_bridge_edges(result), [])
        self.assertIn("binding_interface_not_found", _unresolved_reasons(result))

    def test_same_named_symbol_is_not_merged_across_repos(self) -> None:
        result = self._query("umd:job_submit", "kmd:job_dispatch")
        node_refs = [node["node_ref"] for node in result["nodes"]]
        self.assertTrue(any("snap-umd" in ref and ref.endswith("/fn_submit") for ref in node_refs))
        self.assertFalse(any(ref.endswith("/fn_submit_shadow") for ref in node_refs))

    def test_cross_repo_requires_both_snapshots(self) -> None:
        with self.assertRaises(CodeLearningError) as context:
            self._query("umd:job_submit", "uapi:symbol")
        self.assertEqual(context.exception.code, "NOT_FOUND")


class RelationQueryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="cl-relations-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.env = helpers.make_bootstrap(self.tmp)
        self.workspace = support.make_workspace()
        support.install_workspace(self.env, self.workspace)
        self._patch = support.patch_workspace(self.workspace)
        self._patch.__enter__()
        self.addCleanup(self._patch.__exit__, None, None, None)

        flow_edges = [
            {
                "id": "fl_request_local",
                "owner": "fn_submit",
                "sources": ["request"],
                "target": "local",
                "expression": "*request",
                "relation": "argument_binding",
                "certainty": "may",
                "origin": "deterministic_analysis",
                "evidence_ids": ["ev_flow"],
                "callsite": "cs_submit",
                "limitations": ["path_insensitive", "alias_not_solved"],
            },
            {
                "id": "fl_local_ioctl",
                "owner": "fn_submit",
                "sources": ["local"],
                "target": "ioctl",
                "relation": "argument_binding",
                "certainty": "may",
                "origin": "deterministic_analysis",
                "evidence_ids": ["ev_flow"],
                "callsite": "cs_submit",
                "limitations": ["path_insensitive"],
            },
        ]
        graph = support.graph_payload(
            functions=[support.function("fn_submit", "job_submit", file="umd/src/job_submit.c", line=8)],
            callsites=[support.callsite("cs_submit", owner="fn_submit", file="umd/src/job_submit.c", line=11)],
            evidence=[support.evidence("ev_flow", kind="data", file="umd/src/job_submit.c", line=11)],
            flow_edges=flow_edges,
        )
        support.write_snapshot(
            self.env,
            "snap-flow",
            graph,
            manifest_overrides={"coverage": _coverage_overrides()},
        )
        support.import_snapshot(self.env, self.workspace, "snap-flow", repo_id="umd")

        plain = support.graph_payload(
            functions=[support.function("fn_plain", "plain", file="kmd/src/plain.c", line=1)],
        )
        support.write_snapshot(self.env, "snap-plain", plain)
        support.import_snapshot(self.env, self.workspace, "snap-plain", repo_id="kmd")

        locked = support.graph_payload(
            functions=[support.function("fn_lock", "locker", file="uapi/src/lock.c", line=1)],
            extra={
                "locks": [
                    {
                        "id": "lk_queue",
                        "object_id": "job_queue",
                        "lock_id": "queue_lock",
                        "relation": "protects",
                        "origin": "deterministic_analysis",
                        "certainty": "may",
                        "evidence_ids": ["ev_lock"],
                        "limitations": ["static_analysis_only"],
                    }
                ]
            },
        )
        support.write_snapshot(
            self.env,
            "snap-locks",
            locked,
            manifest_overrides={"coverage": _coverage_overrides({"locks": "ready", "cfg": "unsupported"})},
        )
        support.import_snapshot(self.env, self.workspace, "snap-locks", repo_id="uapi")

    @property
    def workspace_id(self) -> str:
        return self.workspace["workspace_id"]

    def _relation(self, snapshot_ref, mode, **selectors):
        return paths.query_relation(
            self.env.state, self.workspace_id, snapshot_ref, mode, **selectors
        )

    def _expect_error(self, code, callable_):
        with self.assertRaises(CodeLearningError) as context:
            callable_()
        self.assertEqual(context.exception.code, code, context.exception.message)
        return context.exception

    # -- flow_legacy ----------------------------------------------------
    def test_flow_legacy_projects_flow_edges(self) -> None:
        result = self._relation(
            "snap-flow", "flow_legacy", symbol_ref="request", budget=2000, max_items=200
        )
        self.assertEqual(result["schema_version"], 1)
        self.assertEqual(result["mode"], "flow_legacy")
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["capability"]["available"])
        self.assertEqual(result["snapshot"]["snapshot_id"], "snap-flow")
        self.assertEqual([item["item_id"] for item in result["items"]], ["fl_request_local", "fl_local_ioctl"])
        for item in result["items"]:
            self.assertEqual(item["certainty"], "may")
            self.assertEqual(item["origin"], "deterministic_analysis")
            self.assertEqual(item["evidence_refs"], ["ev_flow"])
        self.assertIn("path_insensitive", result["limitations"])
        self.assertIn("alias_not_solved", result["limitations"])
        self.assertFalse(result["truncated"])
        self.assertIn("items_emitted", result["budget_used"])
        self.assertTrue(result["query_digest"])

    def test_flow_legacy_budget_and_max_items_truncation(self) -> None:
        budget = self._relation("snap-flow", "flow_legacy", symbol_ref="request", budget=1)
        self.assertTrue(budget["truncated"])
        self.assertEqual(budget["status"], "partial")
        self.assertLessEqual(len(budget["items"]), 1)
        self.assertIn("budget_exhausted", {unknown["reason"] for unknown in budget["unknowns"]})

        capped = self._relation("snap-flow", "flow_legacy", symbol_ref="request", max_items=1)
        self.assertTrue(capped["truncated"])
        self.assertEqual(len(capped["items"]), 1)
        self.assertIn("max_items", " ".join(sorted({u["reason"] for u in capped["unknowns"]})))

    def test_flow_legacy_without_flow_edges_is_unavailable(self) -> None:
        result = self._relation("snap-plain", "flow_legacy", symbol_ref="symbol")
        self.assertEqual(result["status"], "unavailable")
        self.assertFalse(result["capability"]["available"])
        self.assertTrue(result["unknowns"])

    def test_flow_legacy_selector_validation(self) -> None:
        self._expect_error("INVALID_ARGUMENT", lambda: self._relation("snap-flow", "flow_legacy"))
        self._expect_error(
            "INVALID_ARGUMENT",
            lambda: self._relation("snap-flow", "flow_legacy", symbol_ref="x", function_ref="fn_submit"),
        )
        self._expect_error(
            "INVALID_ARGUMENT",
            lambda: self._relation("snap-flow", "flow_legacy", symbol_ref="x", direction="backward"),
        )

    # -- flow_cfg -------------------------------------------------------
    def test_flow_cfg_without_cfg_capability_is_unavailable_not_legacy(self) -> None:
        result = self._relation(
            "snap-flow", "flow_cfg", function_ref="fn_submit", parameter_ref="request"
        )
        self.assertEqual(result["status"], "unavailable")
        self.assertFalse(result["capability"]["available"])
        self.assertEqual(result["items"], [])
        self.assertTrue(result["unknowns"])
        self.assertEqual(result["mode"], "flow_cfg")

    def test_flow_cfg_selector_validation(self) -> None:
        self._expect_error(
            "INVALID_ARGUMENT", lambda: self._relation("snap-flow", "flow_cfg", function_ref="fn_submit")
        )
        self._expect_error(
            "INVALID_ARGUMENT",
            lambda: self._relation(
                "snap-flow",
                "flow_cfg",
                function_ref="fn_submit",
                parameter_ref="request",
                value_ref="value",
            ),
        )
        self._expect_error(
            "INVALID_ARGUMENT",
            lambda: self._relation(
                "snap-flow",
                "flow_cfg",
                function_ref="fn_submit",
                parameter_ref="request",
                symbol_ref="symbol",
            ),
        )

    # -- locks / aliases ------------------------------------------------
    def test_locks_unavailable_without_lock_analysis(self) -> None:
        result = self._relation("snap-flow", "locks", object_ref="job_queue")
        self.assertEqual(result["status"], "unavailable")
        self.assertFalse(result["capability"]["available"])
        self.assertTrue(result["unknowns"])

    def test_locks_project_existing_lock_evidence(self) -> None:
        result = self._relation("snap-locks", "locks", object_ref="job_queue")
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["capability"]["available"])
        self.assertEqual([item["item_id"] for item in result["items"]], ["lk_queue"])
        self.assertEqual(result["items"][0]["certainty"], "may")

        empty = self._relation("snap-locks", "locks", object_ref="no_such_object")
        self.assertEqual(empty["status"], "ok")
        self.assertEqual(empty["items"], [])
        self.assertTrue(empty["unknowns"], "an empty lock match must not prove absence")

    def test_aliases_unavailable_without_alias_analysis(self) -> None:
        result = self._relation("snap-flow", "aliases", function_ref="fn_submit")
        self.assertEqual(result["status"], "unavailable")
        self.assertFalse(result["capability"]["available"])
        self.assertTrue(result["unknowns"])

    def test_locks_selector_validation(self) -> None:
        self._expect_error("INVALID_ARGUMENT", lambda: self._relation("snap-flow", "locks"))
        self._expect_error(
            "INVALID_ARGUMENT", lambda: self._relation("snap-flow", "locks", object_ref="obj", direction="forward")
        )
        self._expect_error(
            "INVALID_ARGUMENT", lambda: self._relation("snap-flow", "locks", object_ref="obj", function_ref="fn_submit")
        )

    def test_aliases_selector_validation(self) -> None:
        self._expect_error("INVALID_ARGUMENT", lambda: self._relation("snap-flow", "aliases"))
        self._expect_error(
            "INVALID_ARGUMENT", lambda: self._relation("snap-flow", "aliases", object_ref="obj", lock_ref="lock")
        )
        self._expect_error(
            "INVALID_ARGUMENT",
            lambda: self._relation("snap-flow", "aliases", function_ref="fn_submit", symbol_ref="symbol"),
        )

    # -- generic validation ---------------------------------------------
    def test_invalid_mode_and_unknown_selector(self) -> None:
        self._expect_error("INVALID_ARGUMENT", lambda: self._relation("snap-flow", "magic"))
        self._expect_error(
            "INVALID_ARGUMENT",
            lambda: self._relation("snap-flow", "flow_legacy", symbol_ref="x", bogus="value"),
        )

    def test_budget_limits_validation(self) -> None:
        self._expect_error(
            "INVALID_ARGUMENT", lambda: self._relation("snap-flow", "flow_legacy", symbol_ref="x", budget=0)
        )
        self._expect_error(
            "INVALID_ARGUMENT", lambda: self._relation("snap-flow", "flow_legacy", symbol_ref="x", budget=10001)
        )
        self._expect_error(
            "INVALID_ARGUMENT", lambda: self._relation("snap-flow", "flow_legacy", symbol_ref="x", max_items=0)
        )
        self._expect_error(
            "INVALID_ARGUMENT",
            lambda: self._relation("snap-flow", "flow_legacy", symbol_ref="x", max_items=2001),
        )


if __name__ == "__main__":
    unittest.main()
