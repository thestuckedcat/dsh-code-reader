"""JSON CLI for the code-learning engine.

The CLI is the only process entry point used by the DSH Host bridge and the
learning skill.  Contract:

* ``stdout`` carries exactly one JSON object: either the tool result or the
  public failure payload, both carrying ``schema_version: 1``,
* diagnostics go to ``stderr``,
* exit codes: ``0`` valid tool result, ``2`` input/scope/capability block,
  ``3`` execution failure, ``4`` result unknown (all mapped by
  :mod:`code_learning.errors`).

Absolute paths are never accepted from command arguments except for the
explicit local setup command ``bootstrap-init`` (where the human supplies the
trusted bootstrap/state/inbox locations).
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from typing import Any, Dict, List, Optional, Sequence

from . import service
from .errors import EXIT_FAILED, EXIT_OK, CodeLearningError
from .state import load_state

PROG = "python -m code_learning.cli"


class _ArgumentParser(argparse.ArgumentParser):
    """Argparse variant that reports usage errors through the JSON contract."""

    def error(self, message: str) -> "None":  # type: ignore[override]
        raise CodeLearningError("INVALID_ARGUMENT", f"invalid command line: {message}")


def build_parser() -> argparse.ArgumentParser:
    parser = _ArgumentParser(prog=PROG, description="Local code-learning engine (JSON CLI).")
    parser.add_argument(
        "--bootstrap",
        metavar="PATH",
        default=None,
        help="Trusted bootstrap configuration path (defaults to CODE_READER_BOOTSTRAP or $DSH_HOME).",
    )
    subparsers = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")

    # -- local trusted setup -------------------------------------------------
    bootstrap = subparsers.add_parser(
        "bootstrap-init", help="Create the trusted BootstrapConfigV1 file and state directories."
    )
    bootstrap.add_argument("--out", required=True, metavar="PATH", help="Bootstrap JSON output path.")
    bootstrap.add_argument("--state-dir", dest="state_dir", required=True, metavar="DIR")
    bootstrap.add_argument("--import-inbox", dest="import_inbox", required=True, metavar="DIR")
    bootstrap.add_argument(
        "--root",
        dest="roots",
        action="append",
        required=True,
        metavar="NAME=PATH",
        help="Candidate read root (repeatable).",
    )
    bootstrap.add_argument("--profile-ref", dest="profile_ref", default="desktop")
    bootstrap.add_argument("--scope-ref", dest="scope_ref", default="local")
    bootstrap.add_argument("--scope-generation", dest="scope_generation", type=int, default=1)

    # -- workspace -----------------------------------------------------------
    workspace_import = subparsers.add_parser("workspace-import", help="Import a WorkspaceManifestV1 from the inbox.")
    workspace_import.add_argument("--manifest", required=True, metavar="NAME")
    workspace_import.add_argument(
        "--expected-revision", dest="expected_revision", type=int, required=True, metavar="N"
    )
    workspace_import.add_argument("--operation-id", dest="operation_id", required=True, metavar="UUID")

    workspace_validate = subparsers.add_parser("workspace-validate", help="Re-validate a registered workspace.")
    workspace_validate.add_argument("--workspace", default=None, metavar="WID")

    status = subparsers.add_parser("status", help="Show workspace registration status.")
    status.add_argument("--workspace", required=True, metavar="WID")

    overview = subparsers.add_parser("overview", help="Bounded workspace/variant overview.")
    overview.add_argument("--workspace", required=True, metavar="WID")
    overview.add_argument("--variant", required=True, metavar="VID")
    overview.add_argument("--snapshot", default=None, metavar="SID")
    overview.add_argument("--max-components", dest="max_components", type=int, default=20, metavar="N")

    # -- source --------------------------------------------------------------
    source_find = subparsers.add_parser("source-find", help="Literal/filename search inside one registered repo.")
    source_find.add_argument("--workspace", required=True, metavar="WID")
    source_find.add_argument("--repo", required=True, metavar="RID")
    source_find.add_argument("--relative-glob", dest="relative_glob", required=True, metavar="GLOB")
    selector = source_find.add_mutually_exclusive_group(required=True)
    selector.add_argument("--literal", default=None, metavar="TEXT")
    selector.add_argument("--filename", default=None, metavar="TEXT")
    source_find.add_argument("--cursor", default=None, metavar="REF")

    source_read = subparsers.add_parser("source-read", help="Read a bounded, signed source range.")
    source_read.add_argument("--workspace", required=True, metavar="WID")
    source_read.add_argument("--path", dest="path_ref", required=True, metavar="REF")
    source_read.add_argument("--expected-sha256", dest="expected_sha256", required=True, metavar="HASH")
    source_read.add_argument("--byte-start", dest="byte_start", type=int, required=True, metavar="N")
    source_read.add_argument("--byte-end", dest="byte_end", type=int, required=True, metavar="N")

    source_evidence = subparsers.add_parser("source", help="Project a previously issued source evidence ref.")
    source_evidence.add_argument("--workspace", required=True, metavar="WID")
    source_evidence.add_argument("--evidence", dest="evidence_ref", required=True, metavar="REF")
    source_evidence.add_argument("--max-bytes", dest="max_bytes", type=int, default=16384, metavar="N")

    # -- snapshots -----------------------------------------------------------
    snapshot_import = subparsers.add_parser("snapshot-import", help="Import an Atlas 0.1 snapshot pair from the inbox.")
    snapshot_import.add_argument("--workspace", required=True, metavar="WID")
    snapshot_import.add_argument("--variant", required=True, metavar="VID")
    snapshot_import.add_argument("--repo", required=True, metavar="RID")
    snapshot_import.add_argument("--snapshot", dest="snapshot_name", required=True, metavar="NAME")
    snapshot_import.add_argument("--operation-id", dest="operation_id", required=True, metavar="UUID")

    snapshot_load = subparsers.add_parser("snapshot", help="Load a verified snapshot evidence projection.")
    snapshot_load.add_argument("--workspace", required=True, metavar="WID")
    snapshot_load.add_argument("--snapshot", dest="snapshot_ref", required=True, metavar="SID")

    # -- read-only workbench views -------------------------------------------
    subparsers.add_parser(
        "view-snapshots", help="Registered workspaces and re-verified imported Atlas snapshots."
    )

    view_entries = subparsers.add_parser(
        "view-entries", help="Entry/function list of one verified snapshot."
    )
    view_entries.add_argument("--workspace", required=True, metavar="WID")
    view_entries.add_argument("--snapshot", dest="snapshot_ref", required=True, metavar="SID")

    view_entry = subparsers.add_parser(
        "view-entry", help="One entry with source window, call edges, evidence and resources."
    )
    view_entry.add_argument("--workspace", required=True, metavar="WID")
    view_entry.add_argument("--snapshot", dest="snapshot_ref", required=True, metavar="SID")
    view_entry.add_argument("--entry", dest="entry_ref", required=True, metavar="ENTRY")

    # -- read-only five views (S2a) ------------------------------------------
    view_coupling = subparsers.add_parser(
        "view-coupling", help="Resource relationship graph and the global resource rail."
    )
    view_coupling.add_argument("--workspace", required=True, metavar="WID")
    view_coupling.add_argument("--snapshot", dest="snapshot_ref", required=True, metavar="SID")
    view_coupling.add_argument("--entry", dest="entry_ref", default=None, metavar="ENTRY")

    view_tree = subparsers.add_parser(
        "view-tree", help="Collapsible entry call tree of one verified snapshot."
    )
    view_tree.add_argument("--workspace", required=True, metavar="WID")
    view_tree.add_argument("--snapshot", dest="snapshot_ref", required=True, metavar="SID")
    view_tree.add_argument("--entry", dest="entry_ref", required=True, metavar="ENTRY")

    view_end_to_end = subparsers.add_parser(
        "view-end-to-end", help="Deterministic single-entry end-to-end graph."
    )
    view_end_to_end.add_argument("--workspace", required=True, metavar="WID")
    view_end_to_end.add_argument("--snapshot", dest="snapshot_ref", required=True, metavar="SID")
    view_end_to_end.add_argument("--entry", dest="entry_ref", required=True, metavar="ENTRY")
    view_end_to_end.add_argument(
        "--root",
        dest="root_ref",
        default=None,
        metavar="ROOT",
        help="Optional subflow root function ref; adds a root->entry breadcrumb.",
    )

    view_interfaces = subparsers.add_parser(
        "view-interfaces",
        help="Rule-based basic interface library candidates (S2b).",
    )
    view_interfaces.add_argument("--workspace", required=True, metavar="WID")
    view_interfaces.add_argument("--snapshot", dest="snapshot_ref", required=True, metavar="SID")
    view_interfaces.add_argument("--entry", dest="entry_ref", default=None, metavar="ENTRY")

    view_file_tree = subparsers.add_parser(
        "view-file-tree", help="Files referenced by the snapshot evidence."
    )
    view_file_tree.add_argument("--workspace", required=True, metavar="WID")
    view_file_tree.add_argument("--snapshot", dest="snapshot_ref", required=True, metavar="SID")

    view_file_read = subparsers.add_parser(
        "view-file-read", help="Bounded read-only source window with line numbers."
    )
    view_file_read.add_argument("--workspace", required=True, metavar="WID")
    view_file_read.add_argument("--snapshot", dest="snapshot_ref", required=True, metavar="SID")
    view_file_read.add_argument("--repo", dest="repo_id", required=True, metavar="RID")
    view_file_read.add_argument("--path", dest="path_ref", required=True, metavar="PATH")
    view_file_read.add_argument(
        "--max-lines", dest="max_lines", type=int, default=2000, metavar="N"
    )

    view_sequence = subparsers.add_parser(
        "view-sequence", help="Static predicted sequence for one entry (S2a only mode)."
    )
    view_sequence.add_argument("--workspace", required=True, metavar="WID")
    view_sequence.add_argument("--snapshot", dest="snapshot_ref", required=True, metavar="SID")
    view_sequence.add_argument("--entry", dest="entry_ref", required=True, metavar="ENTRY")
    view_sequence.add_argument(
        "--mode", choices=("static",), default="static", metavar="MODE"
    )

    view_first_screen = subparsers.add_parser(
        "view-first-screen",
        help="Batch first-screen payload: entry + interfaces + one view (S4-prep).",
    )
    view_first_screen.add_argument("--workspace", required=True, metavar="WID")
    view_first_screen.add_argument("--snapshot", dest="snapshot_ref", required=True, metavar="SID")
    view_first_screen.add_argument("--entry", dest="entry_ref", required=True, metavar="ENTRY")
    view_first_screen.add_argument(
        "--view",
        dest="view",
        default="coupling",
        metavar="VIEW",
        help="coupling|tree|end_to_end|sequence|file (default coupling; file -> file tree)",
    )

    # -- controlled scenarios (S3a) ------------------------------------------
    sim_profile_import = subparsers.add_parser(
        "sim-profile-import",
        help="Verify a trusted inbox Wasm simulation profile and register it.",
    )
    sim_profile_import.add_argument("--workspace", required=True, metavar="WID")
    sim_profile_import.add_argument("--variant", required=True, metavar="VID")
    sim_profile_import.add_argument("--repo", required=True, metavar="RID")
    sim_profile_import.add_argument("--profile", dest="profile_name", required=True, metavar="NAME")
    sim_profile_import.add_argument(
        "--operation-id", dest="operation_id", required=True, metavar="ID"
    )

    sim_profile_list = subparsers.add_parser(
        "sim-profile-list", help="Registered Wasm simulation profiles of one workspace."
    )
    sim_profile_list.add_argument("--workspace", required=True, metavar="WID")

    scenario_plan = subparsers.add_parser(
        "scenario-plan", help="Validate a scenario and sign a TTL plan (never executes)."
    )
    scenario_plan.add_argument("--workspace", required=True, metavar="WID")
    scenario_plan.add_argument("--snapshot", dest="snapshot_ref", required=True, metavar="SID")
    scenario_plan.add_argument("--profile", dest="profile_ref", required=True, metavar="PROFILE")
    scenario_plan.add_argument(
        "--scenario-json", dest="scenario_json", required=True, metavar="B64"
    )
    scenario_plan.add_argument(
        "--expected-generation", dest="expected_generation", type=int, default=None, metavar="N"
    )

    scenario_module = subparsers.add_parser(
        "scenario-module", help="Isolated-worker payload for one signed scenario plan."
    )
    scenario_module.add_argument("--plan", dest="plan_id", required=True, metavar="PLAN")

    scenario_record = subparsers.add_parser(
        "scenario-record", help="Validate worker records and append one ledger generation."
    )
    scenario_record.add_argument("--plan", dest="plan_id", required=True, metavar="PLAN")
    scenario_record.add_argument(
        "--records-json", dest="records_json", required=True, metavar="B64"
    )
    scenario_record.add_argument(
        "--operation-id", dest="operation_id", required=True, metavar="ID"
    )

    scenario_list = subparsers.add_parser(
        "scenario-list", help="Scenario ledger summaries of one workspace."
    )
    scenario_list.add_argument("--workspace", required=True, metavar="WID")

    scenario_get = subparsers.add_parser(
        "scenario-get", help="Current immutable generation of one scenario ledger."
    )
    scenario_get.add_argument("--workspace", required=True, metavar="WID")
    scenario_get.add_argument("--scenario", dest="scenario_ref", required=True, metavar="SCN")

    view_sequence_observed = subparsers.add_parser(
        "view-sequence-observed", help="Observed timing DTO built from a scenario ledger."
    )
    view_sequence_observed.add_argument("--workspace", required=True, metavar="WID")
    view_sequence_observed.add_argument(
        "--scenario", dest="scenario_ref", required=True, metavar="SCN"
    )

    scenario_undo_plan = subparsers.add_parser(
        "scenario-undo-plan",
        help="Validate an undo-tail replay and sign a prefix undo plan (never executes).",
    )
    scenario_undo_plan.add_argument("--workspace", required=True, metavar="WID")
    scenario_undo_plan.add_argument("--scenario", dest="scenario_ref", required=True, metavar="SCN")
    scenario_undo_plan.add_argument("--count", dest="count", type=int, required=True, metavar="N")
    scenario_undo_plan.add_argument(
        "--expected-generation", dest="expected_generation", type=int, required=True, metavar="G"
    )

    scenario_undo_record = subparsers.add_parser(
        "scenario-undo-record",
        help="Verify a replayed prefix state digest and publish the prefix generation.",
    )
    scenario_undo_record.add_argument(
        "--plan", dest="plan_id", required=True, metavar="UNDO_PLAN"
    )
    scenario_undo_record.add_argument(
        "--records-json", dest="records_json", required=True, metavar="B64"
    )
    scenario_undo_record.add_argument(
        "--operation-id", dest="operation_id", required=True, metavar="ID"
    )

    trace_import_parser = subparsers.add_parser(
        "trace-import", help="Validate a trusted inbox trace file as a read-only imported ledger."
    )
    trace_import_parser.add_argument("--workspace", required=True, metavar="WID")
    trace_import_parser.add_argument("--snapshot", dest="snapshot_ref", required=True, metavar="SID")
    trace_import_parser.add_argument("--input", dest="input_name", required=True, metavar="NAME")
    trace_import_parser.add_argument(
        "--operation-id", dest="operation_id", required=True, metavar="ID"
    )

    summary_put = subparsers.add_parser(
        "summary-put",
        help="Validate and store one signed AI summary record for a snapshot subject.",
    )
    summary_put.add_argument("--workspace", required=True, metavar="WID")
    summary_put.add_argument("--snapshot", dest="snapshot_ref", required=True, metavar="SID")
    summary_put.add_argument(
        "--payload-json", dest="payload_json", required=True, metavar="B64"
    )

    view_summary = subparsers.add_parser(
        "view-summary",
        help="Cached AI summaries of one snapshot (with gaps and staleness).",
    )
    view_summary.add_argument("--workspace", required=True, metavar="WID")
    view_summary.add_argument("--snapshot", dest="snapshot_ref", required=True, metavar="SID")
    view_summary.add_argument("--subject-type", dest="subject_type", default=None, metavar="T")
    view_summary.add_argument("--subject-id", dest="subject_id", default=None, metavar="ID")

    # -- paths and relations -------------------------------------------------
    query_path = subparsers.add_parser("path", help="Bounded call-path query inside one variant.")
    query_path.add_argument("--workspace", required=True, metavar="WID")
    query_path.add_argument("--variant", required=True, metavar="VID")
    query_path.add_argument("--from", dest="from_ref", required=True, metavar="REF")
    query_path.add_argument("--to", dest="to_ref", required=True, metavar="REF")
    query_path.add_argument("--budget", type=int, default=2000, metavar="N")
    query_path.add_argument("--max-depth", dest="max_depth", type=int, default=30, metavar="N")
    query_path.add_argument("--direction", choices=("down", "up"), default="down")

    query_relation = subparsers.add_parser("relation", help="Flow/lock/alias relation query (never fabricated).")
    query_relation.add_argument("--workspace", required=True, metavar="WID")
    query_relation.add_argument("--snapshot", dest="snapshot_ref", required=True, metavar="SID")
    query_relation.add_argument(
        "--mode", required=True, choices=("flow_cfg", "flow_legacy", "locks", "aliases")
    )
    query_relation.add_argument("--function", dest="function_ref", default=None, metavar="REF")
    query_relation.add_argument("--parameter", dest="parameter_ref", default=None, metavar="REF")
    query_relation.add_argument("--value", dest="value_ref", default=None, metavar="REF")
    query_relation.add_argument("--symbol", dest="symbol_ref", default=None, metavar="REF")
    query_relation.add_argument("--object", dest="object_ref", default=None, metavar="REF")
    query_relation.add_argument("--lock", dest="lock_ref", default=None, metavar="REF")
    query_relation.add_argument("--direction", choices=("forward", "backward"), default=None)
    query_relation.add_argument("--budget", type=int, default=2000, metavar="N")
    query_relation.add_argument("--max-items", dest="max_items", type=int, default=200, metavar="N")

    # -- plan / run ----------------------------------------------------------
    plan = subparsers.add_parser("plan", help="Build a frozen, non-executing RunPlan.")
    plan.add_argument("--workspace", required=True, metavar="WID")
    plan.add_argument("--variant", required=True, metavar="VID")
    plan.add_argument("--goal-file", dest="goal_file", required=True, metavar="NAME")

    run = subparsers.add_parser("run", help="Attempt to execute a plan (blocked in this version).")
    run.add_argument("--plan", dest="plan_id", required=True, metavar="PLAN_ID")
    run.add_argument("--operation-id", dest="operation_id", required=True, metavar="UUID")

    # -- learning records ----------------------------------------------------
    record_save = subparsers.add_parser("record-save", help="Save a LearningRecordV1 draft with CAS.")
    record_save.add_argument("--workspace", required=True, metavar="WID")
    record_save.add_argument("--input", dest="input_name", required=True, metavar="NAME")
    record_save.add_argument(
        "--expected-generation", dest="expected_generation", type=int, required=True, metavar="N"
    )
    record_save.add_argument("--operation-id", dest="operation_id", required=True, metavar="UUID")

    record_get = subparsers.add_parser("record-get", help="Read one learning record revision.")
    record_get.add_argument("--workspace", required=True, metavar="WID")
    record_get.add_argument("--record", dest="record_ref", required=True, metavar="RID")

    resume = subparsers.add_parser("resume", help="Recheck a paused record against current inputs.")
    resume.add_argument("--workspace", required=True, metavar="WID")
    resume.add_argument("--record", dest="record_ref", required=True, metavar="RID")

    export = subparsers.add_parser("export", help="Export one record locally (markdown or json).")
    export.add_argument("--workspace", required=True, metavar="WID")
    export.add_argument("--record", dest="record_ref", required=True, metavar="RID")
    export.add_argument("--format", dest="fmt", required=True, choices=("markdown", "json"))

    consume = subparsers.add_parser("consume-event", help="Consume an optional capability-03 invalidation event.")
    consume.add_argument("--workspace", required=True, metavar="WID")
    consume.add_argument("--event-file", dest="event_file", required=True, metavar="NAME")

    return parser


# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------
def _parse_roots(values: Sequence[str]) -> List[Any]:
    parsed: List[Any] = []
    seen = set()
    for raw in values:
        name, separator, path = raw.partition("=")
        if not separator or not name or not path:
            raise CodeLearningError("INVALID_ARGUMENT", "--root must use the NAME=PATH form")
        if name in seen:
            raise CodeLearningError("INVALID_ARGUMENT", "candidate root names must be unique")
        seen.add(name)
        parsed.append((name, path))
    return parsed


def _dispatch(args: argparse.Namespace, state: Any) -> Dict[str, Any]:
    command = args.command
    if command == "workspace-import":
        return service.workspace_import(
            state, args.manifest, args.expected_revision, args.operation_id
        )
    if command == "workspace-validate":
        return service.workspace_validate(state, args.workspace)
    if command == "status":
        return service.status(state, args.workspace)
    if command == "overview":
        return service.overview(
            state,
            args.workspace,
            args.variant,
            snapshot_ref=args.snapshot,
            max_components=args.max_components,
        )
    if command == "source-find":
        return service.source_find(
            state,
            args.workspace,
            args.repo,
            args.relative_glob,
            literal=args.literal,
            filename=args.filename,
            cursor=args.cursor,
        )
    if command == "source-read":
        return service.source_read(
            state,
            args.workspace,
            args.path_ref,
            args.expected_sha256,
            args.byte_start,
            args.byte_end,
        )
    if command == "source":
        return service.read_evidence(
            state, args.workspace, args.evidence_ref, max_bytes=args.max_bytes
        )
    if command == "snapshot-import":
        return service.snapshot_import(
            state,
            args.workspace,
            args.variant,
            args.repo,
            args.snapshot_name,
            args.operation_id,
        )
    if command == "snapshot":
        return service.snapshot_load(state, args.workspace, args.snapshot_ref)
    if command == "view-snapshots":
        from . import views

        return views.list_snapshots(state)
    if command == "view-entries":
        from . import views

        return views.list_entries(state, args.workspace, args.snapshot_ref)
    if command == "view-entry":
        from . import views

        return views.entry_detail(
            state, args.workspace, args.snapshot_ref, args.entry_ref
        )
    if command in (
        "view-coupling",
        "view-tree",
        "view-end-to-end",
        "view-file-tree",
        "view-file-read",
        "view-sequence",
        "view-interfaces",
        "view-first-screen",
    ):
        from . import five_views

        if command == "view-coupling":
            return five_views.coupling(
                state, args.workspace, args.snapshot_ref, args.entry_ref
            )
        if command == "view-tree":
            return five_views.tree(
                state, args.workspace, args.snapshot_ref, args.entry_ref
            )
        if command == "view-end-to-end":
            return five_views.end_to_end(
                state,
                args.workspace,
                args.snapshot_ref,
                args.entry_ref,
                root_ref=args.root_ref,
            )
        if command == "view-file-tree":
            return five_views.file_tree(state, args.workspace, args.snapshot_ref)
        if command == "view-file-read":
            return five_views.file_read(
                state,
                args.workspace,
                args.snapshot_ref,
                args.repo_id,
                args.path_ref,
                max_lines=args.max_lines,
            )
        if command == "view-interfaces":
            return five_views.interfaces(
                state, args.workspace, args.snapshot_ref, args.entry_ref
            )
        if command == "view-first-screen":
            return five_views.first_screen(
                state,
                args.workspace,
                args.snapshot_ref,
                args.entry_ref,
                view=args.view,
            )
        return five_views.sequence_static(
            state,
            args.workspace,
            args.snapshot_ref,
            args.entry_ref,
            mode=args.mode,
        )
    if command in (
        "sim-profile-import",
        "sim-profile-list",
        "scenario-plan",
        "scenario-module",
        "scenario-record",
        "scenario-list",
        "scenario-get",
        "view-sequence-observed",
        "scenario-undo-plan",
        "scenario-undo-record",
        "trace-import",
    ):
        from . import scenario

        if command == "sim-profile-import":
            return scenario.sim_profile_import(
                state,
                args.workspace,
                args.variant,
                args.repo,
                args.profile_name,
                args.operation_id,
            )
        if command == "sim-profile-list":
            return scenario.sim_profile_list(state, args.workspace)
        if command == "scenario-plan":
            return scenario.scenario_plan(
                state,
                args.workspace,
                args.snapshot_ref,
                args.profile_ref,
                args.scenario_json,
                expected_generation=args.expected_generation,
            )
        if command == "scenario-module":
            return scenario.scenario_module(state, args.plan_id)
        if command == "scenario-record":
            return scenario.scenario_record(
                state, args.plan_id, args.records_json, args.operation_id
            )
        if command == "scenario-list":
            return scenario.scenario_list(state, args.workspace)
        if command == "scenario-get":
            return scenario.scenario_get(state, args.workspace, args.scenario_ref)
        if command == "scenario-undo-plan":
            return scenario.scenario_undo_plan(
                state,
                args.workspace,
                args.scenario_ref,
                args.count,
                args.expected_generation,
            )
        if command == "scenario-undo-record":
            return scenario.scenario_undo_record(
                state, args.plan_id, args.records_json, args.operation_id
            )
        if command == "trace-import":
            return scenario.trace_import(
                state,
                args.workspace,
                args.snapshot_ref,
                args.input_name,
                args.operation_id,
            )
        return scenario.view_sequence_observed(
            state, args.workspace, args.scenario_ref
        )
    if command in ("summary-put", "view-summary"):
        from . import summary

        if command == "summary-put":
            return summary.summary_put(
                state,
                args.workspace,
                args.snapshot_ref,
                args.payload_json,
            )
        return summary.view_summary(
            state,
            args.workspace,
            args.snapshot_ref,
            args.subject_type,
            args.subject_id,
        )
    if command == "path":
        return service.query_path(
            state,
            args.workspace,
            args.variant,
            args.from_ref,
            args.to_ref,
            budget=args.budget,
            max_depth=args.max_depth,
            direction=args.direction,
        )
    if command == "relation":
        return service.query_relation(
            state,
            args.workspace,
            args.snapshot_ref,
            args.mode,
            function_ref=args.function_ref,
            parameter_ref=args.parameter_ref,
            value_ref=args.value_ref,
            symbol_ref=args.symbol_ref,
            object_ref=args.object_ref,
            lock_ref=args.lock_ref,
            direction=args.direction,
            budget=args.budget,
            max_items=args.max_items,
        )
    if command == "plan":
        return service.plan(state, args.workspace, args.variant, args.goal_file)
    if command == "run":
        return service.run(state, args.plan_id, args.operation_id)
    if command == "record-save":
        return service.record_save(
            state, args.workspace, args.input_name, args.expected_generation, args.operation_id
        )
    if command == "record-get":
        return service.record_get(state, args.workspace, args.record_ref)
    if command == "resume":
        return service.resume(state, args.workspace, args.record_ref)
    if command == "export":
        return service.export_record(state, args.workspace, args.record_ref, args.fmt)
    if command == "consume-event":
        return service.consume_event(state, args.workspace, args.event_file)
    raise CodeLearningError("INVALID_ARGUMENT", f"unknown command: {command}")


# ---------------------------------------------------------------------------
# output contract
# ---------------------------------------------------------------------------
def _envelope(result: Any) -> Dict[str, Any]:
    if not isinstance(result, dict):
        raise CodeLearningError("INTERNAL_ERROR", "engine produced a non-object result")
    if "schema_version" not in result:
        result = {"schema_version": 1, **result}
    return result


def _emit(value: Any) -> None:
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write(text + "\n")
    sys.stdout.flush()


def _diagnostic(error: CodeLearningError) -> None:
    try:
        sys.stderr.write(f"code-learning: {error.code}: {error.message}\n")
        sys.stderr.flush()
    except OSError:  # pragma: no cover - stderr may be closed by the caller
        pass


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
        if args.command == "bootstrap-init":
            result = service.bootstrap_init(
                out=args.out,
                state_dir=args.state_dir,
                import_inbox=args.import_inbox,
                roots=_parse_roots(args.roots),
                profile_ref=args.profile_ref,
                scope_ref=args.scope_ref,
                scope_generation=args.scope_generation,
            )
        else:
            state = load_state(args.bootstrap)
            result = _dispatch(args, state)
        _emit(_envelope(result))
        return EXIT_OK
    except CodeLearningError as error:
        _emit(error.payload())
        _diagnostic(error)
        return error.exit_code
    except Exception:  # noqa: BLE001 - the CLI boundary must stay JSON-only
        traceback.print_exc(file=sys.stderr)
        _emit(
            {
                "schema_version": 1,
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": "unexpected internal failure",
                    "details_ref": None,
                    "retryable": False,
                },
                "operation_id": None,
            }
        )
        return EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main())
