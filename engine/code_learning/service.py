"""Composition and input validation between the JSON CLI and the domain modules.

This module is deliberately thin.  It owns three things only:

* CLI-level input validation (bounded strings, bounded integers, enums, UUIDs),
* cross-module composition for the few operations no single module owns
  (``plan``/``run``), and
* the fixed shape of a ``RunPlan`` for the current non-executing version.

Every domain rule (root registration, snapshots, path queries, learning
records, invalidation) lives in the dedicated modules.  No shell, no network,
and no absolute path is ever accepted from CLI arguments: absolute locations
come from the trusted ``State``/bootstrap registration only.  A plan contains
reference strings and is never executed; ``run`` is blocked in this version.
"""

from __future__ import annotations

import importlib
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .errors import CodeLearningError
from .state import init_bootstrap
from .util import check_id, digest, utc_now
from .validation import (
    expect_int,
    expect_object,
    expect_str,
    hash_hex,
    one_of,
    reject_unknown,
    require_keys,
)

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

MAX_REF_CHARS = 8192
PLAN_TTL_SECONDS = 600
DEFAULT_BUDGETS: Dict[str, int] = {
    "max_tu": 128,
    "tu_timeout_s": 120,
    "total_timeout_s": 1200,
}

_BUDGET_LIMITS = {
    "max_tu": (1, 4096),
    "tu_timeout_s": (1, 3600),
    "total_timeout_s": (1, 86400),
}

RELATION_MODES = ("flow_cfg", "flow_legacy", "locks", "aliases")
RELATION_SELECTORS = (
    "function_ref",
    "parameter_ref",
    "value_ref",
    "symbol_ref",
    "object_ref",
    "lock_ref",
)


# ---------------------------------------------------------------------------
# lazy subsystem loading
# ---------------------------------------------------------------------------
def _module(name: str) -> Any:
    """Import a sibling domain module on first use.

    Keeping the import lazy means a CLI invocation only loads the subsystem it
    actually needs, and a broken/unusable subsystem is reported through the
    normal JSON error contract at the boundary instead of aborting argument
    parsing.
    """
    package = __package__ or "code_learning"
    return importlib.import_module(f"{package}.{name}")


# ---------------------------------------------------------------------------
# small validators
# ---------------------------------------------------------------------------
def _workspace_id(value: str) -> str:
    return check_id(value, "workspace")


def _variant_id(value: str) -> str:
    return check_id(value, "variant_id")


def _repo_id(value: str) -> str:
    return check_id(value, "repo_id")


def _operation_id(value: str) -> str:
    if not isinstance(value, str) or not UUID_RE.match(value):
        raise CodeLearningError("INVALID_ARGUMENT", "operation_id must be a UUID")
    return value.lower()


def _ref(value: str, label: str, *, max_len: int = 1024) -> str:
    return expect_str(value, label, max_len=max_len)


def _utc_iso(moment: datetime) -> str:
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# bootstrap-init
# ---------------------------------------------------------------------------
def bootstrap_init(
    *,
    out: str,
    state_dir: str,
    import_inbox: str,
    roots: Sequence[Tuple[str, str]],
    profile_ref: str = "desktop",
    scope_ref: str = "local",
    scope_generation: int = 1,
) -> Dict[str, Any]:
    """Create the trusted BootstrapConfigV1 file and its directories.

    ``output_root`` is not an argument of the contract's ``bootstrap-init``
    command, so it is declared as the state directory itself: this version
    writes exports under ``state_root/exports`` and never writes into a source
    repository.  The declared output boundary therefore stays inside the
    trusted local state root.
    """
    out_text = expect_str(out, "out", max_len=4096)
    state_text = expect_str(state_dir, "state_dir", max_len=4096)
    inbox_text = expect_str(import_inbox, "import_inbox", max_len=4096)
    profile = expect_str(profile_ref, "profile_ref", max_len=128)
    scope = expect_str(scope_ref, "scope_ref", max_len=128)
    generation = expect_int(scope_generation, "scope_generation", low=1, high=10**9)
    if not roots:
        raise CodeLearningError("INVALID_ARGUMENT", "at least one --root NAME=PATH is required")
    normalized: Dict[str, str] = {}
    for index, pair in enumerate(roots):
        if not isinstance(pair, (tuple, list)) or len(pair) != 2:
            raise CodeLearningError("INVALID_ARGUMENT", "--root must use the NAME=PATH form")
        name, path_text = pair
        name = expect_str(name, f"roots[{index}] name", max_len=128)
        if name in normalized:
            raise CodeLearningError("INVALID_ARGUMENT", "candidate root names must be unique")
        normalized[name] = expect_str(path_text, f"roots[{index}] path", max_len=4096)
    return init_bootstrap(
        out_path=out_text,
        state_dir=state_text,
        inbox_dir=inbox_text,
        output_root=state_text,
        roots=normalized,
        profile_ref=profile,
        scope_ref=scope,
        scope_generation=generation,
    )


# ---------------------------------------------------------------------------
# workspace
# ---------------------------------------------------------------------------
def workspace_import(
    state: Any,
    manifest_name: str,
    expected_revision: int,
    operation_id: str,
) -> Dict[str, Any]:
    manifest = expect_str(manifest_name, "manifest", max_len=256)
    expected = expect_int(expected_revision, "expected_revision", low=0, high=10**9)
    operation = _operation_id(operation_id)
    return _module("workspace").import_workspace(state, manifest, expected, operation)


def workspace_validate(state: Any, workspace_ref: Optional[str] = None) -> Dict[str, Any]:
    """Re-validate a manifest/workspace without executing compilers.

    ``--workspace`` is optional in the contract, so without it the single
    registered workspace is validated; zero or several registered workspaces
    stay an explicit INVALID_ARGUMENT from the domain module.
    """
    workspace_module = _module("workspace")
    if workspace_ref is not None:
        return workspace_module.validate_workspace(state, workspace_ref=_workspace_id(workspace_ref))
    registered = state.list_workspaces()
    if len(registered) == 1:
        return workspace_module.validate_workspace(state, workspace_ref=registered[0])
    return workspace_module.validate_workspace(state)


def status(state: Any, workspace_ref: str) -> Dict[str, Any]:
    return _module("workspace").workspace_status(state, _workspace_id(workspace_ref))


def overview(
    state: Any,
    workspace_ref: str,
    variant_id: str,
    snapshot_ref: Optional[str] = None,
    max_components: int = 20,
) -> Dict[str, Any]:
    workspace = _workspace_id(workspace_ref)
    variant = _variant_id(variant_id)
    limit = expect_int(max_components, "max_components", low=1, high=100)
    snapshot = None if snapshot_ref is None else _ref(snapshot_ref, "snapshot_ref", max_len=256)
    return _module("workspace").overview(
        state, workspace, variant, snapshot_ref=snapshot, max_components=limit
    )


# ---------------------------------------------------------------------------
# source
# ---------------------------------------------------------------------------
def source_find(
    state: Any,
    workspace_ref: str,
    repo_id: str,
    relative_glob: str,
    literal: Optional[str] = None,
    filename: Optional[str] = None,
    cursor: Optional[str] = None,
) -> Dict[str, Any]:
    workspace = _workspace_id(workspace_ref)
    repo = _repo_id(repo_id)
    glob = expect_str(relative_glob, "relative_glob", max_len=512)
    if (literal is None) == (filename is None):
        raise CodeLearningError(
            "INVALID_ARGUMENT", "exactly one of literal or filename must be provided"
        )
    literal_text = None if literal is None else expect_str(literal, "literal", max_len=256)
    filename_text = None if filename is None else expect_str(filename, "filename", max_len=256)
    cursor_text = None if cursor is None else _ref(cursor, "cursor", max_len=MAX_REF_CHARS)
    return _module("source").find_source(
        state,
        workspace,
        repo,
        glob,
        literal=literal_text,
        filename=filename_text,
        cursor=cursor_text,
    )


def source_read(
    state: Any,
    workspace_ref: str,
    path_ref: str,
    expected_sha256: str,
    byte_start: int,
    byte_end: int,
) -> Dict[str, Any]:
    workspace = _workspace_id(workspace_ref)
    path = _ref(path_ref, "path_ref", max_len=MAX_REF_CHARS)
    expected = hash_hex(expected_sha256, "expected_sha256")
    start = expect_int(byte_start, "byte_start", low=0, high=1 << 40)
    end = expect_int(byte_end, "byte_end", low=1, high=1 << 40)
    if end <= start:
        raise CodeLearningError("INVALID_ARGUMENT", "byte_end must be greater than byte_start")
    if end - start > 16384:
        raise CodeLearningError("INVALID_ARGUMENT", "source-read range must not exceed 16384 bytes")
    return _module("source").read_source(state, workspace, path, expected, start, end)


def read_evidence(
    state: Any, workspace_ref: str, evidence_ref: str, max_bytes: int = 16384
) -> Dict[str, Any]:
    workspace = _workspace_id(workspace_ref)
    evidence = _ref(evidence_ref, "evidence_ref", max_len=MAX_REF_CHARS)
    limit = expect_int(max_bytes, "max_bytes", low=1, high=16384)
    return _module("source").read_evidence(state, workspace, evidence, max_bytes=limit)


# ---------------------------------------------------------------------------
# snapshots
# ---------------------------------------------------------------------------
def snapshot_import(
    state: Any,
    workspace_ref: str,
    variant_id: str,
    repo_id: str,
    snapshot_name: str,
    operation_id: str,
) -> Dict[str, Any]:
    workspace = _workspace_id(workspace_ref)
    variant = _variant_id(variant_id)
    repo = _repo_id(repo_id)
    name = expect_str(snapshot_name, "snapshot", max_len=256)
    operation = _operation_id(operation_id)
    return _module("snapshot").import_snapshot(
        state, workspace, variant, repo, name, operation
    )


def snapshot_load(state: Any, workspace_ref: str, snapshot_ref: str) -> Dict[str, Any]:
    workspace = _workspace_id(workspace_ref)
    snapshot = _ref(snapshot_ref, "snapshot_ref", max_len=MAX_REF_CHARS)
    return _module("snapshot").load_snapshot(state, workspace, snapshot)


# ---------------------------------------------------------------------------
# paths and relations
# ---------------------------------------------------------------------------
def query_path(
    state: Any,
    workspace_ref: str,
    variant_id: str,
    from_ref: str,
    to_ref: str,
    budget: int = 2000,
    max_depth: int = 30,
    direction: str = "down",
) -> Dict[str, Any]:
    workspace = _workspace_id(workspace_ref)
    variant = _variant_id(variant_id)
    source = _ref(from_ref, "from_ref", max_len=1024)
    target = _ref(to_ref, "to_ref", max_len=1024)
    edge_budget = expect_int(budget, "budget", low=1, high=10000)
    depth = expect_int(max_depth, "max_depth", low=1, high=100)
    heading = one_of(direction, ("down", "up"), "direction")
    return _module("paths").query_path(
        state,
        workspace,
        variant,
        source,
        target,
        budget=edge_budget,
        max_depth=depth,
        direction=heading,
    )


def query_relation(
    state: Any,
    workspace_ref: str,
    snapshot_ref: str,
    mode: str,
    *,
    function_ref: Optional[str] = None,
    parameter_ref: Optional[str] = None,
    value_ref: Optional[str] = None,
    symbol_ref: Optional[str] = None,
    object_ref: Optional[str] = None,
    lock_ref: Optional[str] = None,
    direction: Optional[str] = None,
    budget: int = 2000,
    max_items: int = 200,
) -> Dict[str, Any]:
    workspace = _workspace_id(workspace_ref)
    snapshot = _ref(snapshot_ref, "snapshot_ref", max_len=MAX_REF_CHARS)
    relation_mode = one_of(mode, RELATION_MODES, "mode")
    edge_budget = expect_int(budget, "budget", low=1, high=10000)
    items = expect_int(max_items, "max_items", low=1, high=2000)
    selectors: Dict[str, Any] = {}
    provided = {
        "function_ref": function_ref,
        "parameter_ref": parameter_ref,
        "value_ref": value_ref,
        "symbol_ref": symbol_ref,
        "object_ref": object_ref,
        "lock_ref": lock_ref,
    }
    for name, value in provided.items():
        if value is not None:
            selectors[name] = _ref(value, name, max_len=512)
    if direction is not None:
        selectors["direction"] = one_of(direction, ("forward", "backward"), "direction")
    selectors["budget"] = edge_budget
    selectors["max_items"] = items
    return _module("paths").query_relation(state, workspace, snapshot, relation_mode, **selectors)


# ---------------------------------------------------------------------------
# plan / run
# ---------------------------------------------------------------------------
def _load_goal(state: Any, goal_file: str) -> Tuple[Dict[str, str], Dict[str, int]]:
    name = expect_str(goal_file, "goal_file", max_len=256)
    _path, data = state.inbox_json(name, max_bytes=64 * 1024)
    goal = expect_object(data, "goal")
    reject_unknown(goal, ("question", "interface", "budgets"), "goal")
    require_keys(goal, ("question", "interface"), "goal")
    question = expect_str(goal["question"], "goal.question", max_len=4096)
    interface = expect_str(goal["interface"], "goal.interface", max_len=512)
    budgets = dict(DEFAULT_BUDGETS)
    if "budgets" in goal:
        raw = expect_object(goal["budgets"], "goal.budgets")
        reject_unknown(raw, tuple(_BUDGET_LIMITS), "goal.budgets")
        for key, (low, high) in _BUDGET_LIMITS.items():
            if key in raw:
                budgets[key] = expect_int(raw[key], f"goal.budgets.{key}", low=low, high=high)
    return {"question": question, "interface": interface}, budgets


def _repo_reference(repo: Mapping[str, Any]) -> str:
    root_ref = repo.get("root_ref")
    relative = repo.get("relative_path")
    if not isinstance(root_ref, str) or not isinstance(relative, str):
        raise CodeLearningError("UNSUPPORTED_SCHEMA", "workspace repository entry is incomplete")
    return f"ref:{root_ref}/{relative}"


def _build_atlas_argv(
    workspace: Mapping[str, Any],
    variant: Mapping[str, Any],
    goal: Mapping[str, str],
    budgets: Mapping[str, int],
    out_ref: str,
) -> List[str]:
    """Fixed Atlas 0.8 CLI shape, expressed with references.

    This version has no locked Atlas runtime and never executes the plan, so
    the values stay references (resolved by a future isolated runner) instead
    of absolute host paths.  The flag shape mirrors ``sdk_atlas.py run``:
    ``--repo`` for user-space/UMD-like repositories and ``--root`` for kernel
    roots, then ``--compdb``, ``--out``, ``--interface``, ``--max-tu``,
    ``--tu-timeout``, ``--dataflow`` and ``--html``.
    """
    argv: List[str] = ["<locked-python>", "runtime/atlas/scripts/sdk_atlas.py", "run"]
    repositories = workspace.get("repositories") or []
    if not isinstance(repositories, list) or not repositories:
        raise CodeLearningError("UNSUPPORTED_SCHEMA", "workspace registration has no repositories")
    for repo in repositories:
        if not isinstance(repo, Mapping):
            raise CodeLearningError("UNSUPPORTED_SCHEMA", "workspace repository entry is malformed")
        role = repo.get("role")
        flag = "--repo" if role in ("umd", "library", "other") else "--root"
        argv.extend([flag, _repo_reference(repo)])
    compdb_refs = variant.get("compdb_refs") or []
    if isinstance(compdb_refs, list):
        for ref in compdb_refs:
            if isinstance(ref, str):
                argv.extend(["--compdb", f"ref:{ref}"])
    argv.extend(
        [
            "--out",
            out_ref,
            "--interface",
            goal["interface"],
            "--max-tu",
            str(budgets["max_tu"]),
            "--tu-timeout",
            str(budgets["tu_timeout_s"]),
            "--dataflow",
            "off",
            "--html",
            f"{out_ref}/overview.html",
        ]
    )
    return argv


def plan(
    state: Any,
    workspace_ref: str,
    variant_id: str,
    goal_file: str,
) -> Dict[str, Any]:
    """Build a frozen, non-executing RunPlan (reference-only argv)."""
    workspace_id = _workspace_id(workspace_ref)
    variant_ref = _variant_id(variant_id)
    workspace = _module("workspace").load_workspace(state, workspace_id)
    if not isinstance(workspace, Mapping):
        raise CodeLearningError("UNSUPPORTED_SCHEMA", "workspace registration is malformed")
    variants = workspace.get("variants") or []
    if not isinstance(variants, list):
        raise CodeLearningError("UNSUPPORTED_SCHEMA", "workspace variants are malformed")
    variant = next(
        (item for item in variants if isinstance(item, Mapping) and item.get("variant_id") == variant_ref),
        None,
    )
    if variant is None:
        raise CodeLearningError("NOT_FOUND", "variant is not declared by this workspace")
    revision = workspace.get("revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        raise CodeLearningError("UNSUPPORTED_SCHEMA", "workspace registration revision is unusable")
    goal, budgets = _load_goal(state, goal_file)
    build_identity = _module("workspace").build_identity(workspace, variant_ref)
    if not isinstance(build_identity, Mapping):
        raise CodeLearningError("UNSUPPORTED_SCHEMA", "build identity is not an object")
    plan_uid = f"plan_{uuid.uuid4().hex}"
    out_ref = f"ref:exports/runs/{plan_uid}"
    read_roots: List[str] = []
    repositories = workspace.get("repositories") or []
    for repo in repositories:
        if isinstance(repo, Mapping) and isinstance(repo.get("root_ref"), str):
            if repo["root_ref"] not in read_roots:
                read_roots.append(repo["root_ref"])
    required_capabilities = ["atlas_cli", "forced_isolation_profile"]
    if variant.get("analysis_mode") == "semantic":
        required_capabilities.insert(1, "compiler_build_context")
    execution_profile_ref = variant.get("execution_profile_ref")
    if not isinstance(execution_profile_ref, str):
        execution_profile_ref = None
    argv = _build_atlas_argv(workspace, variant, goal, budgets, out_ref)
    request_digest = digest(
        {
            "workspace_id": workspace_id,
            "workspace_revision": revision,
            "variant_id": variant_ref,
            "build_identity": build_identity,
            "goal": goal,
            "argv": argv,
            "cwd_ref": f"{out_ref}/cwd",
            "env_profile_ref": None,
            "read_roots": read_roots,
            "write_root_ref": "ref:exports",
            "required_capabilities": required_capabilities,
            "execution_profile_ref": execution_profile_ref,
            "budgets": budgets,
        }
    )
    now = utc_now()
    expires_at = now + timedelta(seconds=PLAN_TTL_SECONDS)
    plan_id = state.sign(
        {
            "kind": "plan",
            "g": state.bootstrap["scope_generation"],
            "id": plan_uid,
            "w": workspace_id,
            "v": variant_ref,
            "rev": revision,
            "digest": request_digest,
            "iat": int(now.timestamp()),
            "exp": int(expires_at.timestamp()),
        }
    )
    return {
        "schema_version": 1,
        "plan_id": plan_id,
        "workspace_id": workspace_id,
        "workspace_revision": revision,
        "variant_id": variant_ref,
        "build_identity": dict(build_identity),
        "goal": goal,
        "argv": argv,
        "cwd_ref": f"{out_ref}/cwd",
        "env_profile_ref": None,
        "read_roots": read_roots,
        "write_root_ref": "ref:exports",
        "required_capabilities": required_capabilities,
        "execution_profile_ref": execution_profile_ref,
        "request_digest": request_digest,
        "budgets": dict(budgets),
        "expires_at": _utc_iso(expires_at),
        "limitations": [
            "execution_disabled_no_forced_isolation_profile",
            "argv_is_not_executed_in_this_version",
            "paths_are_references_resolved_by_a_future_runner",
        ],
    }


def run(state: Any, plan_id: str, operation_id: str) -> Dict[str, Any]:
    """Validate the frozen plan reference, then refuse to execute it."""
    operation = _operation_id(operation_id)
    token = _ref(plan_id, "plan_id", max_len=MAX_REF_CHARS)
    payload = state.verify(token, kind="plan", max_age_s=PLAN_TTL_SECONDS)
    raise CodeLearningError(
        "EXECUTION_BLOCKED",
        "execution is blocked: no forced-isolation execution profile is provisioned",
        details={
            "reason": "forced_isolation_profile_unavailable",
            "plan_ref": payload.get("id"),
        },
        operation_id=operation,
    )


# ---------------------------------------------------------------------------
# learning records
# ---------------------------------------------------------------------------
def record_save(
    state: Any,
    workspace_ref: str,
    input_name: str,
    expected_generation: int,
    operation_id: str,
) -> Dict[str, Any]:
    workspace = _workspace_id(workspace_ref)
    name = expect_str(input_name, "input", max_len=256)
    expected = expect_int(expected_generation, "expected_generation", low=0, high=10**9)
    operation = _operation_id(operation_id)
    _path, draft = state.inbox_json(name)
    draft = expect_object(draft, "record draft")
    return _module("records").save_record(state, workspace, draft, expected, operation)


def record_get(state: Any, workspace_ref: str, record_ref: str) -> Dict[str, Any]:
    workspace = _workspace_id(workspace_ref)
    record = _ref(record_ref, "record_ref", max_len=MAX_REF_CHARS)
    return _module("records").get_record(state, workspace, record)


def resume(state: Any, workspace_ref: str, record_ref: str) -> Dict[str, Any]:
    workspace = _workspace_id(workspace_ref)
    record = _ref(record_ref, "record_ref", max_len=MAX_REF_CHARS)
    return _module("records").resume_record(state, workspace, record)


def export_record(
    state: Any, workspace_ref: str, record_ref: str, fmt: str = "markdown"
) -> Dict[str, Any]:
    workspace = _workspace_id(workspace_ref)
    record = _ref(record_ref, "record_ref", max_len=MAX_REF_CHARS)
    output_format = one_of(fmt, ("markdown", "json"), "format")
    return _module("records").export_record(state, workspace, record, fmt=output_format)


def consume_event(state: Any, workspace_ref: str, event_file: str) -> Dict[str, Any]:
    workspace = _workspace_id(workspace_ref)
    name = expect_str(event_file, "event_file", max_len=256)
    _path, event = state.inbox_json(name)
    event = expect_object(event, "event")
    return _module("invalidation").consume_event(state, workspace, event)
