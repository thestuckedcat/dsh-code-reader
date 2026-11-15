"""Read-only five-view read model (CL-VIEW-T2 / stage S2a).

Implements the engine side of ``docs/five-view-contract.md`` sections 1-3:

* :func:`coupling` -- resource relationship graph plus the left-rail global
  resource list (scope ``entry_neighborhood`` or ``snapshot``),
* :func:`tree` -- collapsible text tree from one entry (DFS pre-order),
* :func:`end_to_end` -- deterministic single-entry end-to-end graph,
* :func:`file_tree` -- the files referenced by the snapshot evidence,
* :func:`file_read` -- one bounded read-only source window with line numbers,
* :func:`sequence_static` -- statically predicted sequence (the only S2a mode).

Every projection is derived from a re-verified Atlas snapshot
(:func:`snapshot.load_snapshot_bundle`) and registered source roots only.  The
shared Selection, evidence grading (``exact``/``may``/``unknown``), path mapping
and gap rules from :mod:`code_learning.views` are reused; no absolute or
state/bootstrap path is ever emitted.  Missing layers stay explicit ``gaps``;
no empty array is used to pretend "no relations".  All node/edge/resource ids
are derived from the snapshot's own stable ids.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from . import atlas, scope, source
from . import views as readmodel
from .errors import CodeLearningError, fail
from .util import check_id, safe_relative_path, utc_now_iso
from .validation import expect_int, expect_str, one_of

SCHEMA_VERSION = 1

#: Contract section 1 budgets.
MAX_COUPLING_RESOURCES = 100
MAX_COUPLING_ACCESSES = 400
MAX_COUPLING_REACHABLE = 200
MAX_COUPLING_FUNCTIONS = 300
MAX_COUPLING_EXTERNALS = 100
MAX_TREE_NODES = 500
MAX_TREE_DEPTH = 8
MAX_E2E_NODES = 120
MAX_E2E_EDGES = 240
MAX_E2E_FUNCTIONS = 100
MAX_E2E_DEPTH = 6
MAX_SEQ_MESSAGES = 200
MAX_SEQ_DEPTH = 8
MAX_FILE_TREE_FILES = 2000
MAX_FILE_READ_BYTES = 64 * 1024
MAX_FILE_READ_LINES = 2000
MAX_EVIDENCE_SPAN = scope.MAX_EVIDENCE_SPAN

#: S2b (contract section 10) limits.
MAX_GROUPS = 50
MAX_BREADCRUMB_HOPS = 20
MAX_INTERFACES = 100
MAX_INTERFACE_CALLERS = 50
MAX_INTERFACE_EFFECTS = 32
MAX_INTERFACE_GUARDS = 16
MAX_INTERFACE_EXTERNAL_BOUNDARIES = 100

#: Access / certainty vocabularies shared with the read model.
ACCESS_VALUES = readmodel.ACCESS_VALUES
CERTAINTY_VALUES = readmodel.CERTAINTY_VALUES
_WRITE_ACCESSES = frozenset(ACCESS_VALUES - {"read"})
_NEGATIVE_LITERAL = re.compile(r"^-\d+$")
_CALLSITE_EXPRESSION_LIMIT = 120
_GUARD_LABEL_LIMIT = 160
_TREE_GUARD_LIMIT = 2048

#: Product capabilities deliberately not provided in this slice (verbatim).
_DEFERRED_GAPS: Dict[str, Tuple[str, str]] = {
    "ai_summary": (
        "unavailable",
        "S2b：AI 归纳（≤500 字）未接入；本切片不伪造说明文本",
    ),
    "run_observation": (
        "unavailable",
        "本切片无运行观测；场景执行/轨迹导入在 CW-T3",
    ),
    "scenario_execution": (
        "unavailable",
        "本切片未提供场景执行/打桩/回退（CW-T3）",
    ),
}

_ACCESS_LABELS = {
    "read": "读取",
    "write": "写入",
    "rmw": "读改写",
    "init": "初始化",
    "deinit": "反初始化",
    "alloc": "分配",
    "free": "释放",
    "acquire": "加锁",
    "release": "解锁",
}

_LEGEND = [
    {"key": "exact", "label": "静态确定"},
    {"key": "may", "label": "候选"},
    {"key": "unknown", "label": "未知"},
    {"key": "error", "label": "异常返回"},
    {"key": "boundary", "label": "分析域边界"},
]


# ---------------------------------------------------------------------------
# small shared helpers
# ---------------------------------------------------------------------------
def _bounded(value: Any, limit: int) -> Optional[str]:
    return readmodel._bounded_text(value, limit)


def _strings(value: Any) -> List[str]:
    return readmodel._string_list(value)


def _optional_int(value: Any) -> Optional[int]:
    return readmodel._optional_int(value)


def _one_line(text: Optional[str], limit: int) -> Optional[str]:
    if not isinstance(text, str) or not text:
        return None
    collapsed = " ".join(text.split())
    return collapsed if len(collapsed) <= limit else collapsed[:limit]


def _certainty(value: Any) -> str:
    return value if value in CERTAINTY_VALUES else "unknown"


def _merge_certainties(values: Iterable[str]) -> str:
    """Merged evidence grade for a merged node: exact only when all are exact."""
    unique = {value for value in values if value in CERTAINTY_VALUES}
    if not unique:
        return "unknown"
    if unique == {"exact"}:
        return "exact"
    if "may" in unique:
        return "may"
    if "unknown" in unique:
        return "unknown"
    return "may"


def _access_kind(value: Any) -> str:
    return value if value in ACCESS_VALUES else "unknown"


def _deferred_gaps(*codes: str) -> List[Dict[str, Any]]:
    gaps: List[Dict[str, Any]] = []
    for code in codes:
        status, reason = _DEFERRED_GAPS[code]
        gaps.append({"code": code, "status": status, "reason": reason})
    return gaps


def _selection_ext(
    ctx: "_Context",
    function: Optional[Dict[str, Any]] = None,
    *,
    resource_ids: Optional[Sequence[str]] = None,
    resource_status: str = "unavailable",
    evidence_ids: Optional[Sequence[str]] = None,
    focus_resource_id: Optional[str] = None,
    focus_callsite_id: Optional[str] = None,
    group_id: Optional[str] = None,
    interface_id: Optional[str] = None,
    subflow_root_id: Optional[str] = None,
) -> Dict[str, Any]:
    selection = readmodel._selection(
        ctx.workspace,
        ctx.bundle,
        function,
        resource_ids=resource_ids,
        resource_status=resource_status,
        evidence_ids=evidence_ids,
    )
    selection["focus_resource_id"] = focus_resource_id
    selection["focus_callsite_id"] = focus_callsite_id
    # S2b shared-selection extension (contract section 10.3): group/interface/
    # subflow identity is client view state; the engine only reserves the
    # stable fields so every view reports the same Selection shape.
    selection["group_id"] = group_id
    selection["interface_id"] = interface_id
    selection["subflow_root_id"] = subflow_root_id
    return selection


def _snapshot_prefix(
    ctx: "_Context",
    selection: Dict[str, Any],
    gaps: List[Dict[str, Any]],
    truncated: bool,
    **extra: Any,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "snapshot": readmodel._snapshot_block(ctx.bundle),
        "selection": selection,
    }
    payload.update(extra)
    payload["gaps"] = gaps
    payload["truncated"] = bool(truncated)
    return payload


# ---------------------------------------------------------------------------
# verified snapshot context
# ---------------------------------------------------------------------------
class _Context:
    """One verified snapshot plus the derived indexes every view shares."""

    def __init__(self, state: Any, workspace: Dict[str, Any], bundle: Dict[str, Any]) -> None:
        self.state = state
        self.workspace = workspace
        self.bundle = bundle
        self.graph: Dict[str, Any] = bundle["graph"]
        self.evidence = atlas.evidence_by_id(self.graph)
        self.functions = atlas.functions_by_id(self.graph)
        self.roots = readmodel._repo_roots(state, workspace)
        self.repo_id = readmodel._bundle_repo_id(bundle)
        self.callsites: Dict[str, Dict[str, Any]] = readmodel._callsites_by_id(self.graph)
        self.objects: Dict[str, Dict[str, Any]] = {
            entity["id"]: entity
            for entity in self.graph.get("objects") or []
            if isinstance(entity, dict) and isinstance(entity.get("id"), str)
        }
        self._function_info: Dict[str, Dict[str, Any]] = {}
        self._callsite_info: Dict[str, Dict[str, Any]] = {}
        self._function_names: Dict[str, List[str]] = {}
        for function in self.functions.values():
            name = function.get("name")
            if isinstance(name, str) and name:
                self._function_names.setdefault(name, []).append(function["id"])
        self._build_call_indexes()
        self._build_accesses()
        self._build_returns()

    # -- functions -----------------------------------------------------
    def function_info(self, function_id: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(function_id, str) or function_id not in self.functions:
            return None
        cached = self._function_info.get(function_id)
        if cached is not None:
            return cached
        function = self.functions[function_id]
        raw_file, line = atlas.function_location(self.graph, function, self.evidence)
        relative, _file_repo = readmodel._map_file(self.roots, self.repo_id, raw_file)
        info = {
            "function_id": function_id,
            "name": _bounded(function.get("name"), 512),
            "display_name": _bounded(function.get("display_name"), 512),
            "signature": _bounded(function.get("signature"), 512),
            "storage": function.get("storage")
            if isinstance(function.get("storage"), str)
            else None,
            "kind": function.get("kind") if isinstance(function.get("kind"), str) else None,
            "file": relative,
            "line": line,
            "evidence_ids": _strings(function.get("evidence_ids")),
        }
        self._function_info[function_id] = info
        return info

    def function_id_by_name(self, name: Any) -> Optional[str]:
        if not isinstance(name, str):
            return None
        matches = self._function_names.get(name) or []
        return matches[0] if len(matches) == 1 else None

    # -- callsites / calls --------------------------------------------
    def _build_call_indexes(self) -> None:
        self.call_targets_by_source: Dict[str, List[Dict[str, Any]]] = {}
        self.call_targets_by_callsite: Dict[str, List[Dict[str, Any]]] = {}
        for target in self.graph.get("call_targets") or []:
            if not isinstance(target, dict):
                continue
            source = target.get("source")
            callsite = target.get("callsite")
            if not isinstance(source, str) or not isinstance(callsite, str):
                continue
            self.call_targets_by_source.setdefault(source, []).append(target)
            self.call_targets_by_callsite.setdefault(callsite, []).append(target)
        self.callsites_by_owner: Dict[str, List[Dict[str, Any]]] = {}
        for callsite in self.callsites.values():
            owner = callsite.get("owner")
            if isinstance(owner, str):
                self.callsites_by_owner.setdefault(owner, []).append(callsite)
        for rows in self.callsites_by_owner.values():
            rows.sort(key=self.callsite_sort_key)
        for rows in self.call_targets_by_source.values():
            rows.sort(key=self.call_target_sort_key)
        for rows in self.call_targets_by_callsite.values():
            rows.sort(key=lambda item: str(item.get("target")))

    def callsite_info(self, callsite: Dict[str, Any]) -> Dict[str, Any]:
        callsite_id = callsite.get("id")
        cached = self._callsite_info.get(callsite_id) if isinstance(callsite_id, str) else None
        if cached is not None:
            return cached
        raw_file = callsite.get("file")
        line = _optional_int(callsite.get("line"))
        if not isinstance(raw_file, str) or not raw_file:
            raw_file, line = readmodel._evidence_location(
                self.evidence, callsite.get("evidence_ids")
            )
        relative, _file_repo = readmodel._map_file(self.roots, self.repo_id, raw_file)
        guards: List[Dict[str, Any]] = []
        for guard in callsite.get("guards") or []:
            if not isinstance(guard, dict):
                continue
            item: Dict[str, Any] = {}
            for key, value in guard.items():
                if isinstance(value, str) and len(value) > _TREE_GUARD_LIMIT:
                    item[key] = value[:_TREE_GUARD_LIMIT]
                else:
                    item[key] = value
            guards.append(item)
        info = {
            "callsite_id": callsite_id if isinstance(callsite_id, str) else None,
            "owner": callsite.get("owner") if isinstance(callsite.get("owner"), str) else None,
            "callee": _bounded(callsite.get("callee"), 512),
            "expression": _bounded(callsite.get("expression"), 512),
            "file": relative,
            "line": line,
            "guards": guards,
            "evidence_ids": _strings(callsite.get("evidence_ids")),
            "unknown_target_possible": callsite.get("unknown_target_possible")
            if isinstance(callsite.get("unknown_target_possible"), bool)
            else None,
        }
        if isinstance(callsite_id, str):
            self._callsite_info[callsite_id] = info
        return info

    def callsite_sort_key(self, callsite: Dict[str, Any]) -> Tuple[Any, ...]:
        info = self.callsite_info(callsite)
        return (
            info["file"] if isinstance(info["file"], str) else "\uffff",
            info["line"] if isinstance(info["line"], int) else 1 << 60,
            info["callsite_id"] or "",
        )

    def call_target_sort_key(self, target: Dict[str, Any]) -> Tuple[Any, ...]:
        callsite = self.callsites.get(target.get("callsite"))
        key = self.callsite_sort_key(callsite) if isinstance(callsite, dict) else ("\uffff", 1 << 60, "")
        return key + (str(target.get("target") or ""), str(target.get("id") or ""))

    # -- field accesses / resources -----------------------------------
    def _build_accesses(self) -> None:
        records: List[Dict[str, Any]] = []
        for access in self.graph.get("field_accesses") or []:
            if not isinstance(access, dict):
                continue
            owner_id = access.get("owner")
            owner = self.function_info(owner_id) if isinstance(owner_id, str) else None
            raw_file, line = readmodel._evidence_location(
                self.evidence, access.get("evidence_ids")
            )
            relative, _file_repo = readmodel._map_file(self.roots, self.repo_id, raw_file)
            limitations = _strings(access.get("limitations"))
            access_value = _access_kind(access.get("access"))
            if access_value == "unknown":
                limitations = list(
                    dict.fromkeys(limitations + ["access_value_outside_contract_enum"])
                )
            records.append(
                {
                    "access_id": access.get("id") if isinstance(access.get("id"), str) else None,
                    "access": access_value,
                    "certainty": _certainty(access.get("certainty")),
                    "owner_id": owner_id if isinstance(owner_id, str) else None,
                    "owner": owner,
                    "field_id": access.get("field_id")
                    if isinstance(access.get("field_id"), str)
                    else None,
                    "field_name": _bounded(access.get("field_name"), 256),
                    "field_path": _strings(access.get("field_path")),
                    "expression": _bounded(access.get("expression"), 512),
                    "object_ids": _strings(access.get("object_ids")),
                    "evidence_ids": _strings(access.get("evidence_ids")),
                    "limitations": limitations,
                    "location": {"file": relative, "line": line},
                }
            )
        self.accesses = records
        by_owner: Dict[str, List[Dict[str, Any]]] = {}
        for record in records:
            owner_id = record.get("owner_id")
            if isinstance(owner_id, str):
                by_owner.setdefault(owner_id, []).append(record)
        for rows in by_owner.values():
            rows.sort(key=self.access_sort_key)
        self.accesses_by_owner = by_owner

    def access_sort_key(self, record: Dict[str, Any]) -> Tuple[Any, ...]:
        owner = record.get("owner") or {}
        location = record.get("location") or {}
        return (
            owner.get("file") if isinstance(owner.get("file"), str) else "\uffff",
            owner.get("line") if isinstance(owner.get("line"), int) else 1 << 60,
            location.get("line") if isinstance(location.get("line"), int) else 1 << 60,
            str(record.get("access_id") or ""),
        )

    def object_name(self, object_id: str) -> Optional[str]:
        entity = self.objects.get(object_id)
        if not isinstance(entity, dict):
            return None
        name = entity.get("name")
        return name if isinstance(name, str) and name else None

    # -- flow returns --------------------------------------------------
    def _build_returns(self) -> None:
        self.returns_by_owner: Dict[str, List[Dict[str, Any]]] = {}
        for edge in self.graph.get("flow_edges") or []:
            if not isinstance(edge, dict) or edge.get("relation") != "return":
                continue
            owner = edge.get("owner")
            if not isinstance(owner, str):
                continue
            raw_file, line = readmodel._evidence_location(
                self.evidence, edge.get("evidence_ids")
            )
            relative, _file_repo = readmodel._map_file(self.roots, self.repo_id, raw_file)
            self.returns_by_owner.setdefault(owner, []).append(
                {
                    "flow_edge_id": edge.get("id")
                    if isinstance(edge.get("id"), str)
                    else None,
                    "expression": _bounded(edge.get("expression"), 512),
                    "certainty": _certainty(edge.get("certainty")),
                    "origin": edge.get("origin")
                    if isinstance(edge.get("origin"), str)
                    else "unknown",
                    "evidence_ids": _strings(edge.get("evidence_ids")),
                    "limitations": _strings(edge.get("limitations")),
                    "location": {"file": relative, "line": line},
                }
            )
        for rows in self.returns_by_owner.values():
            rows.sort(
                key=lambda item: (
                    (item.get("location") or {}).get("line")
                    if isinstance((item.get("location") or {}).get("line"), int)
                    else 1 << 60,
                    str(item.get("flow_edge_id") or ""),
                )
            )

    def returns_for(self, function_id: Any) -> List[Dict[str, Any]]:
        if not isinstance(function_id, str):
            return []
        return self.returns_by_owner.get(function_id, [])

    # -- downward reachability ----------------------------------------
    def downward_reachable(
        self, entry_id: str, *, limit: int, max_depth: Optional[int] = None
    ) -> Tuple[List[str], bool]:
        order: List[str] = []
        seen: Set[str] = set()
        queue: List[Tuple[str, int]] = [(entry_id, 0)]
        truncated = False
        while queue:
            function_id, depth = queue.pop(0)
            if function_id in seen:
                continue
            if len(order) >= limit:
                truncated = True
                break
            seen.add(function_id)
            order.append(function_id)
            if max_depth is not None and depth >= max_depth:
                if self.call_targets_by_source.get(function_id):
                    truncated = True
                continue
            for target in self.call_targets_by_source.get(function_id, []):
                target_id = target.get("target")
                if isinstance(target_id, str) and target_id in self.functions and target_id not in seen:
                    queue.append((target_id, depth + 1))
        return order, truncated


def _load_context(state: Any, workspace_ref: Any, snapshot_ref: Any) -> _Context:
    workspace = readmodel._workspace_or_fail(state, workspace_ref)
    bundle = readmodel._bundle_or_fail(state, workspace["workspace_id"], snapshot_ref)
    return _Context(state, workspace, bundle)


def _resolve_entry(ctx: _Context, entry_ref: Any) -> Dict[str, Any]:
    if not isinstance(entry_ref, str) or not entry_ref:
        fail("INVALID_ARGUMENT", "entry must be a non-empty string")
    entry = expect_str(entry_ref, "entry", max_len=512)
    return atlas.resolve_function(ctx.graph, entry, "entry")


def _entry_header(ctx: _Context, function: Dict[str, Any]) -> Dict[str, Any]:
    info = ctx.function_info(function.get("id")) or {}
    return {
        "entry_id": info.get("function_id"),
        "name": info.get("name"),
        "file": info.get("file"),
        "line": info.get("line"),
        "signature": info.get("signature"),
    }


def _boundary_function_ids(ctx: _Context, entry_file: Optional[str]) -> Set[str]:
    """Cross-file call-graph leaves are analysis-domain boundaries.

    S2a has one workspace repository, so a file-level domain handoff (e.g.
    ``platform.c`` reached from ``bus.c``) is the only available boundary
    signal: a callee whose file differs from the entry file and which has no
    *resolved* outgoing call is treated as a device/library boundary.  This is
    an explicit read-model heuristic (reported as a limitation), not an Atlas
    fact; unresolved callees are boundaries unconditionally per the contract.
    """
    if not entry_file:
        return set()
    boundary: Set[str] = set()
    for function_id in ctx.functions:
        info = ctx.function_info(function_id)
        if info is None or info.get("file") is None:
            continue
        if info["file"] == entry_file:
            continue
        if ctx.call_targets_by_source.get(function_id):
            continue
        boundary.add(function_id)
    return boundary


# ---------------------------------------------------------------------------
# 1) coupling -- resource relationship graph + global resource rail
# ---------------------------------------------------------------------------
def _resource_sort_key(ctx: _Context, object_id: str) -> Tuple[Any, ...]:
    entity = ctx.objects.get(object_id) or {}
    raw_file, line = atlas.function_location(ctx.graph, entity, ctx.evidence)
    relative, _file_repo = readmodel._map_file(ctx.roots, ctx.repo_id, raw_file)
    name = entity.get("name") if isinstance(entity.get("name"), str) else ""
    return (
        relative if isinstance(relative, str) else "\uffff",
        line if isinstance(line, int) else 1 << 60,
        name,
        object_id,
    )


def _function_sort_key(ctx: _Context, function_id: str) -> Tuple[Any, ...]:
    info = ctx.function_info(function_id) or {}
    return (
        info.get("file") if isinstance(info.get("file"), str) else "\uffff",
        info.get("line") if isinstance(info.get("line"), int) else 1 << 60,
        info.get("name") or "",
        function_id,
    )


def _coupling_record_resources(
    record: Dict[str, Any],
    resource_ids: Set[str],
    field_ids_by_resource: Dict[str, Set[str]],
) -> Set[str]:
    """Resources one access references, including field-identity candidates.

    Real Atlas field accesses may carry no resolved ``object_ids`` at all (the
    base pointer is unresolved: ``unresolved_or_multiple_base_objects``).  When
    the access still carries a ``field_id`` that is known to belong to a
    projected resource through a resolved access, the access is attributed to
    that resource as a *candidate*: the original empty ``object_ids`` and
    limitations are preserved in the DTO, so the evidence grade stays honest.
    """
    found = {
        object_id
        for object_id in record.get("object_ids") or []
        if object_id in resource_ids
    }
    if found or record.get("object_ids"):
        return found
    field_id = record.get("field_id")
    if not isinstance(field_id, str) or not field_id:
        return found
    return {
        resource_id
        for resource_id in resource_ids
        if field_id in field_ids_by_resource.get(resource_id, set())
    }


def _coupling_accesses_in_scope(
    ctx: _Context,
    resource_ids: Set[str],
    field_ids_by_resource: Dict[str, Set[str]],
) -> List[Dict[str, Any]]:
    return [
        record
        for record in ctx.accesses
        if _coupling_record_resources(record, resource_ids, field_ids_by_resource)
    ]


def _coupling_external_nodes(
    ctx: _Context, participants: Set[str], truncated_flag: List[bool]
) -> List[Dict[str, Any]]:
    boundary_by_callsite: Dict[str, Dict[str, Any]] = {}
    for boundary in ctx.graph.get("boundaries") or []:
        if isinstance(boundary, dict) and isinstance(boundary.get("callsite"), str):
            boundary_by_callsite[boundary["callsite"]] = boundary
    issue_by_subject: Dict[str, Dict[str, Any]] = {}
    for issue in ctx.graph.get("issues") or []:
        if (
            isinstance(issue, dict)
            and issue.get("kind") == "external_boundary"
            and isinstance(issue.get("subject_id"), str)
        ):
            issue_by_subject[issue["subject_id"]] = issue
    externals: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    for function_id in sorted(participants, key=lambda fid: _function_sort_key(ctx, fid)):
        for callsite in ctx.callsites_by_owner.get(function_id, []):
            callsite_info = ctx.callsite_info(callsite)
            callsite_id = callsite_info["callsite_id"]
            if not callsite_id or callsite_id in seen:
                continue
            if ctx.call_targets_by_callsite.get(callsite_id):
                continue
            callee = callsite_info["callee"]
            if not callee:
                continue
            if ctx.function_id_by_name(callee) is not None:
                # The name resolves to a function but the edge is unresolved:
                # report a candidate boundary rather than inventing a target.
                kind = "candidate"
                certainty = "unknown"
                reason = "callsite_target_unresolved"
            elif callee in ctx._function_names:
                kind = "candidate"
                certainty = "unknown"
                reason = "ambiguous_callee_name"
            else:
                kind = "external"
                certainty = "may"
                boundary = boundary_by_callsite.get(callsite_id)
                if isinstance(boundary, dict) and isinstance(boundary.get("kind"), str):
                    reason = boundary["kind"]
                elif callsite_id in issue_by_subject:
                    reason = "external_boundary"
                else:
                    reason = "implementation_not_found"
            seen.add(callsite_id)
            externals.append(
                {
                    "function_id": None,
                    "name": callee,
                    "kind": kind,
                    "callsite_id": callsite_id,
                    "file": callsite_info["file"],
                    "line": callsite_info["line"],
                    "certainty": certainty,
                    "reason": reason,
                }
            )
            if len(externals) >= MAX_COUPLING_EXTERNALS:
                truncated_flag[0] = True
                return externals
    externals.sort(
        key=lambda item: (
            item.get("file") if isinstance(item.get("file"), str) else "\uffff",
            item.get("line") if isinstance(item.get("line"), int) else 1 << 60,
            str(item.get("callsite_id") or ""),
        )
    )
    return externals


def _resource_fields(accesses: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    fields: List[Dict[str, Any]] = []
    seen: Set[Tuple[str, str]] = set()
    for record in accesses:
        field_name = record.get("field_name")
        field_path = _strings(record.get("field_path"))
        key = (record.get("field_id") or "", field_name or " ".join(field_path))
        if key in seen:
            continue
        seen.add(key)
        fields.append(
            {
                "field_id": record.get("field_id"),
                "field_name": field_name,
                "field_path": field_path,
            }
        )
    fields.sort(key=lambda item: (item.get("field_name") or "", item.get("field_id") or ""))
    return fields


def coupling(
    state: Any, workspace_ref: Any, snapshot_ref: Any, entry_ref: Any = None
) -> Dict[str, Any]:
    """Resource relationship graph and the global-resource rail projection."""
    ctx = _load_context(state, workspace_ref, snapshot_ref)
    entry_function = _resolve_entry(ctx, entry_ref) if entry_ref is not None else None
    truncated_flags = {"resources": False, "accesses": False, "functions": False, "externals": False, "reachable": False}
    gaps = readmodel._snapshot_gaps(ctx.bundle)
    if not readmodel._has_resource_layer(ctx.graph):
        gaps.append(
            {
                "code": "resource_graph",
                "status": "unavailable",
                "reason": "atlas_snapshot_has_no_resource_layer",
            }
        )
    gaps.extend(_deferred_gaps("ai_summary", "run_observation"))

    if entry_function is not None:
        scope_mode = "entry_neighborhood"
        entry_id = entry_function.get("id")
        reachable, reachable_truncated = ctx.downward_reachable(
            entry_id, limit=MAX_COUPLING_REACHABLE
        )
        truncated_flags["reachable"] = reachable_truncated
        reachable_set = set(reachable)
        seed_accesses = [record for record in ctx.accesses if record.get("owner_id") in reachable_set]
    else:
        scope_mode = "snapshot"
        entry_id = None
        reachable_set = set()
        seed_accesses = list(ctx.accesses)

    seed_object_order: List[str] = []
    seen_objects: Set[str] = set()
    for record in seed_accesses:
        for object_id in record.get("object_ids") or []:
            if object_id in seen_objects:
                continue
            if object_id not in ctx.objects:
                continue
            seen_objects.add(object_id)
            seed_object_order.append(object_id)
    seed_object_order.sort(key=lambda object_id: _resource_sort_key(ctx, object_id))
    if len(seed_object_order) > MAX_COUPLING_RESOURCES:
        seed_object_order = seed_object_order[:MAX_COUPLING_RESOURCES]
        truncated_flags["resources"] = True
    resource_ids = set(seed_object_order)
    field_ids_by_resource: Dict[str, Set[str]] = {}
    for record in ctx.accesses:
        field_id = record.get("field_id")
        if not isinstance(field_id, str) or not field_id:
            continue
        for object_id in record.get("object_ids") or []:
            if object_id in resource_ids:
                field_ids_by_resource.setdefault(object_id, set()).add(field_id)

    scope_accesses = _coupling_accesses_in_scope(ctx, resource_ids, field_ids_by_resource)
    participants = {
        record["owner_id"]
        for record in scope_accesses
        if isinstance(record.get("owner_id"), str)
    }
    if len(scope_accesses) > MAX_COUPLING_ACCESSES:
        scope_accesses = scope_accesses[:MAX_COUPLING_ACCESSES]
        truncated_flags["accesses"] = True
    participant_order = sorted(participants, key=lambda fid: _function_sort_key(ctx, fid))
    if len(participant_order) > MAX_COUPLING_FUNCTIONS:
        participant_order = participant_order[:MAX_COUPLING_FUNCTIONS]
        truncated_flags["functions"] = True

    # What did the entry-reachable seed actually touch (for availability gaps)?
    if not resource_ids:
        gaps.append(
            {
                "code": "resource_graph",
                "status": "unavailable",
                "reason": (
                    "no_resource_access_in_entry_neighborhood"
                    if scope_mode == "entry_neighborhood"
                    else "no_resource_access_in_snapshot"
                ),
            }
        )

    accesses_by_resource: Dict[str, List[Dict[str, Any]]] = {}
    for record in scope_accesses:
        for object_id in _coupling_record_resources(
            record, resource_ids, field_ids_by_resource
        ):
            accesses_by_resource.setdefault(object_id, []).append(record)
    for rows in accesses_by_resource.values():
        rows.sort(key=ctx.access_sort_key)

    resources: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []
    for object_id in seed_object_order:
        entity = ctx.objects.get(object_id) or {}
        raw_file, line = atlas.function_location(ctx.graph, entity, ctx.evidence)
        relative, _file_repo = readmodel._map_file(ctx.roots, ctx.repo_id, raw_file)
        related = accesses_by_resource.get(object_id, [])
        write_count = sum(1 for record in related if record.get("access") in _WRITE_ACCESSES)
        read_count = sum(1 for record in related if record.get("access") == "read")
        related_function_ids = sorted(
            {
                record["owner_id"]
                for record in related
                if isinstance(record.get("owner_id"), str)
            },
            key=lambda fid: _function_sort_key(ctx, fid),
        )
        resources.append(
            {
                "resource_id": object_id,
                "name": _bounded(entity.get("name"), 512),
                "type": _bounded(entity.get("type"), 512),
                "storage": _bounded(entity.get("storage"), 64),
                "lifetime": _bounded(entity.get("lifetime"), 64),
                "file": relative,
                "line": line,
                "evidence_ids": _strings(entity.get("evidence_ids")),
                "fields": _resource_fields(related),
                "write_count": write_count,
                "read_count": read_count,
                "related_function_ids": related_function_ids,
                "accesses": [
                    {
                        "access_id": record.get("access_id"),
                        "access": record.get("access"),
                        "certainty": record.get("certainty"),
                        "function_id": record.get("owner_id"),
                        "function_name": (record.get("owner") or {}).get("name"),
                        "function_file": (record.get("owner") or {}).get("file"),
                        "function_line": (record.get("owner") or {}).get("line"),
                        "location": dict(record.get("location") or {}),
                        "field_name": record.get("field_name"),
                        "expression": record.get("expression"),
                        "object_ids": list(record.get("object_ids") or []),
                        "evidence_ids": list(record.get("evidence_ids") or []),
                        "limitations": list(record.get("limitations") or []),
                    }
                    for record in related
                ],
            }
        )
        for record in related:
            edges.append(
                {
                    "edge_id": f"access:{record.get('access_id')}:{object_id}",
                    "from_function": record.get("owner_id"),
                    "to_resource": object_id,
                    "access": record.get("access"),
                    "certainty": record.get("certainty"),
                    "field_name": record.get("field_name"),
                    "location": dict(record.get("location") or {}),
                    "evidence_ids": list(record.get("evidence_ids") or []),
                    "limitations": list(record.get("limitations") or []),
                }
            )
    edges.sort(
        key=lambda item: (
            str(item.get("to_resource") or ""),
            str(item.get("from_function") or ""),
            (item.get("location") or {}).get("line")
            if isinstance((item.get("location") or {}).get("line"), int)
            else 1 << 60,
            str(item.get("edge_id") or ""),
        )
    )

    functions: List[Dict[str, Any]] = []
    for function_id in participant_order:
        info = ctx.function_info(function_id) or {}
        related = [
            record
            for record in scope_accesses
            if record.get("owner_id") == function_id
        ]
        has_write = any(record.get("access") in _WRITE_ACCESSES for record in related)
        has_read = any(record.get("access") == "read" for record in related)
        role = "both" if has_write and has_read else ("writer" if has_write else "reader")
        summary = {"exact": 0, "may": 0, "unknown": 0}
        for record in related:
            summary[record.get("certainty") or "unknown"] += 1
        functions.append(
            {
                "function_id": function_id,
                "name": info.get("name"),
                "file": info.get("file"),
                "line": info.get("line"),
                "role": role,
                "is_entry": function_id == entry_id,
                "access_summary": summary,
            }
        )

    external_flags = [False]
    external_nodes = _coupling_external_nodes(ctx, participants, external_flags)
    truncated_flags["externals"] = external_flags[0]
    if truncated_flags["externals"]:
        gaps.append(
            {
                "code": "coupling_external_truncated",
                "status": "degraded",
                "reason": f"external call sites were capped at {MAX_COUPLING_EXTERNALS}",
            }
        )
    if truncated_flags["reachable"]:
        gaps.append(
            {
                "code": "coupling_reachable_truncated",
                "status": "degraded",
                "reason": f"entry-reachable functions were capped at {MAX_COUPLING_REACHABLE}",
            }
        )
    for key, limit in (
        ("resources", MAX_COUPLING_RESOURCES),
        ("accesses", MAX_COUPLING_ACCESSES),
        ("functions", MAX_COUPLING_FUNCTIONS),
    ):
        if truncated_flags[key]:
            gaps.append(
                {
                    "code": f"coupling_{key}_truncated",
                    "status": "degraded",
                    "reason": f"coupling {key} were capped at {limit}",
                }
            )

    resource_status = "unavailable"
    if resources:
        certainties = {
            record.get("certainty")
            for record in scope_accesses
            if any(object_id in resource_ids for object_id in record.get("object_ids") or [])
        }
        resource_status = "ready" if certainties == {"exact"} else "partial"
    selection = _selection_ext(
        ctx,
        entry_function,
        resource_status=resource_status,
        evidence_ids=_strings(entry_function.get("evidence_ids")) if entry_function else [],
    )
    truncated = any(truncated_flags.values())
    return _snapshot_prefix(
        ctx,
        selection,
        gaps,
        truncated,
        scope={"mode": scope_mode, "entry_id": entry_id},
        resources=resources,
        functions=functions,
        edges=edges,
        external_nodes=external_nodes,
    )


# ---------------------------------------------------------------------------
# 2) tree -- collapsible text tree from one entry
# ---------------------------------------------------------------------------
def _tree_external_reason(
    ctx: _Context, callsite_info: Dict[str, Any]
) -> Tuple[str, str]:
    callsite_id = callsite_info.get("callsite_id")
    for boundary in ctx.graph.get("boundaries") or []:
        if isinstance(boundary, dict) and boundary.get("callsite") == callsite_id:
            kind = boundary.get("kind")
            if isinstance(kind, str):
                return "external", kind
    return "external", "implementation_not_found"


def tree(state: Any, workspace_ref: Any, snapshot_ref: Any, entry_ref: Any) -> Dict[str, Any]:
    """Entry-call text tree: DFS pre-order, callsite-ordered, cycle-marked."""
    ctx = _load_context(state, workspace_ref, snapshot_ref)
    entry_function = _resolve_entry(ctx, entry_ref)
    entry_id = entry_function.get("id")
    data_truncated = False
    depth_truncated = False
    nodes: List[Dict[str, Any]] = []

    def add_node(node: Dict[str, Any]) -> bool:
        nonlocal data_truncated
        if len(nodes) >= MAX_TREE_NODES:
            data_truncated = True
            return False
        nodes.append(node)
        return True

    def tree_children(function_id: str) -> List[Tuple[str, Dict[str, Any], Optional[Dict[str, Any]]]]:
        children: List[Tuple[str, Dict[str, Any], Optional[Dict[str, Any]]]] = []
        for callsite in ctx.callsites_by_owner.get(function_id, []):
            info = ctx.callsite_info(callsite)
            callsite_id = info["callsite_id"]
            targets = [
                target
                for target in ctx.call_targets_by_callsite.get(callsite_id, [])
                if target.get("source") == function_id
            ]
            if targets:
                for target in targets:
                    target_function = ctx.functions.get(target.get("target"))
                    children.append(("call", info, target_function))
            else:
                callee = info.get("callee")
                if callee and ctx.function_id_by_name(callee) is None:
                    children.append(("external", info, None))
                elif callee:
                    children.append(("candidate", info, None))
        children.sort(
            key=lambda item: (
                item[1].get("file") if isinstance(item[1].get("file"), str) else "\uffff",
                item[1].get("line")
                if isinstance(item[1].get("line"), int)
                else 1 << 60,
                str(item[1].get("callsite_id") or ""),
            )
        )
        return children

    def make_node(
        *,
        node_id: str,
        parent_node_id: Optional[str],
        depth: int,
        kind: str,
        function: Optional[Dict[str, Any]],
        callsite: Optional[Dict[str, Any]],
        children_count: int,
        expandable: bool,
        cycle: bool = False,
        limitations: Optional[List[str]] = None,
        external_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        if function is not None:
            info = ctx.function_info(function.get("id")) or {}
            symbol = {
                "function_id": info.get("function_id"),
                "name": info.get("name"),
                "file": info.get("file"),
                "line": info.get("line"),
                "signature": info.get("signature"),
                "storage": info.get("storage"),
            }
            returns = [
                {
                    "expression": item.get("expression"),
                    "certainty": item.get("certainty"),
                    "limitations": list(item.get("limitations") or []),
                }
                for item in ctx.returns_for(function.get("id"))
            ]
        else:
            symbol = {
                "function_id": None,
                "name": external_name,
                "file": callsite.get("file") if callsite else None,
                "line": callsite.get("line") if callsite else None,
                "signature": None,
                "storage": None,
            }
            returns = []
        return {
            "node_id": node_id,
            "parent_node_id": parent_node_id,
            "depth": depth,
            "kind": kind,
            "symbol": symbol,
            "callsite": (
                {
                    "callsite_id": callsite.get("callsite_id"),
                    "file": callsite.get("file"),
                    "line": callsite.get("line"),
                    "expression": callsite.get("expression"),
                }
                if callsite
                else None
            ),
            "guards": list(callsite.get("guards") or []) if callsite else [],
            "returns": returns,
            "children_count": children_count,
            "expandable": expandable,
            "cycle": cycle,
            "limitations": list(limitations or []),
        }

    entry_info = ctx.function_info(entry_id) or {}
    entry_children = tree_children(entry_id)
    root_node_id = f"n:{entry_id}"
    add_node(
        make_node(
            node_id=root_node_id,
            parent_node_id=None,
            depth=0,
            kind="entry",
            function=entry_function,
            callsite=None,
            children_count=len(entry_children),
            expandable=bool(entry_children) and len(entry_children) > 0,
        )
    )

    def visit(
        function_id: str,
        parent_node_id: str,
        depth: int,
        path: Tuple[str, ...],
    ) -> None:
        nonlocal depth_truncated
        children = tree_children(function_id)
        for kind_hint, callsite_info, target_function in children:
            callsite_id = str(callsite_info.get("callsite_id") or "")
            if target_function is None:
                reason_kind, reason = _tree_external_reason(ctx, callsite_info)
                kind = "external" if kind_hint == "external" else "external"
                node_id = (
                    f"{parent_node_id}/{callsite_id}>external:"
                    f"{callsite_info.get('callee') or 'unknown'}"
                )
                node = make_node(
                    node_id=node_id,
                    parent_node_id=parent_node_id,
                    depth=depth + 1,
                    kind=kind,
                    function=None,
                    callsite=callsite_info,
                    children_count=0,
                    expandable=False,
                    limitations=[reason],
                    external_name=callsite_info.get("callee"),
                )
                # External leaves are always leaves; the reason is a node-level
                # limitation so the UI can show why the branch stops.
                node["external_kind"] = reason_kind
                node["external_reason"] = reason
                if not add_node(node):
                    return
                continue
            target_id = target_function.get("id")
            node_id = f"{parent_node_id}/{callsite_id}>{target_id}"
            if target_id in path:
                add_node(
                    make_node(
                        node_id=node_id,
                        parent_node_id=parent_node_id,
                        depth=depth + 1,
                        kind="recursion",
                        function=target_function,
                        callsite=callsite_info,
                        children_count=0,
                        expandable=False,
                        cycle=True,
                        limitations=["recursive_reference"],
                    )
                )
                if len(nodes) >= MAX_TREE_NODES:
                    return
                continue
            grand_children = tree_children(target_id)
            at_depth_limit = depth + 1 >= MAX_TREE_DEPTH
            limitations: List[str] = []
            if at_depth_limit and grand_children:
                depth_truncated = True
                limitations.append("depth_limit")
            node = make_node(
                node_id=node_id,
                parent_node_id=parent_node_id,
                depth=depth + 1,
                kind="call",
                function=target_function,
                callsite=callsite_info,
                children_count=len(grand_children),
                expandable=bool(grand_children) and not at_depth_limit,
                limitations=limitations,
            )
            if not add_node(node):
                return
            if grand_children and not at_depth_limit:
                visit(target_id, node_id, depth + 1, path + (target_id,))
                if len(nodes) >= MAX_TREE_NODES:
                    return

    visit(entry_id, root_node_id, 0, (entry_id,))

    gaps = readmodel._snapshot_gaps(ctx.bundle)
    gaps.extend(_deferred_gaps("ai_summary"))
    if data_truncated:
        gaps.append(
            {
                "code": "tree_truncated",
                "status": "degraded",
                "reason": f"tree nodes were capped at {MAX_TREE_NODES}",
            }
        )
    if depth_truncated:
        gaps.append(
            {
                "code": "tree_depth_truncated",
                "status": "degraded",
                "reason": f"tree expansion was capped at depth {MAX_TREE_DEPTH}",
            }
        )
    selection = _selection_ext(
        ctx,
        entry_function,
        evidence_ids=entry_info.get("evidence_ids") or [],
    )
    return _snapshot_prefix(
        ctx,
        selection,
        gaps,
        data_truncated or depth_truncated,
        entry=_entry_header(ctx, entry_function),
        nodes=nodes,
        max_depth=MAX_TREE_DEPTH,
    )


# ---------------------------------------------------------------------------
# 3) end_to_end -- deterministic single-entry graph
# ---------------------------------------------------------------------------
def _edge_style(certainty: str, role: str = "normal") -> Dict[str, str]:
    if role == "error":
        return {"line": "solid", "color": "exception"}
    if certainty == "exact":
        return {"line": "solid", "color": "normal"}
    return {"line": "dashed", "color": "normal"}


def _resolve_named_function(ctx: _Context, ref: Any, label: str) -> Dict[str, Any]:
    if not isinstance(ref, str) or not ref:
        fail("INVALID_ARGUMENT", f"{label} must be a non-empty string")
    text = expect_str(ref, label, max_len=512)
    return atlas.resolve_function(ctx.graph, text, label)


def _shortest_call_path(
    ctx: _Context, start_id: str, goal_id: str, max_hops: int = MAX_BREADCRUMB_HOPS
) -> Tuple[List[str], List[Optional[str]]]:
    """Shortest resolved call path ``start_id -> goal_id`` (BFS, <= max_hops).

    Returns ``(function_ids, callsite_ids)`` where ``callsite_ids[i]`` is the
    call site used from ``function_ids[i - 1]`` to ``function_ids[i]`` (the
    first element is ``None``).  An unreachable/no-path result is ``([], [])``.
    """
    from collections import deque

    queue: deque = deque([(start_id, [start_id], [None])])
    visited: Set[str] = {start_id}
    while queue:
        function_id, path, sites = queue.popleft()
        if len(path) - 1 >= max_hops:
            continue
        for call_target in ctx.call_targets_by_source.get(function_id, []):
            target_id = call_target.get("target")
            if (
                not isinstance(target_id, str)
                or target_id not in ctx.functions
                or target_id in visited
            ):
                continue
            next_path = path + [target_id]
            next_sites = sites + [call_target.get("callsite")]
            if target_id == goal_id:
                return next_path, next_sites
            visited.add(target_id)
            queue.append((target_id, next_path, next_sites))
    return [], []


def _breadcrumb_items(
    ctx: _Context, function_ids: Sequence[str], callsite_ids: Sequence[Optional[str]]
) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    for index, function_id in enumerate(function_ids):
        info = ctx.function_info(function_id) or {}
        item: Dict[str, Any] = {
            "function_id": function_id,
            "name": info.get("name"),
            "file": info.get("file"),
            "line": info.get("line"),
        }
        callsite_id = callsite_ids[index] if index < len(callsite_ids) else None
        if index > 0 and isinstance(callsite_id, str):
            item["callsite_id"] = callsite_id
        items.append(item)
    return items


def end_to_end(
    state: Any,
    workspace_ref: Any,
    snapshot_ref: Any,
    entry_ref: Any,
    root_ref: Any = None,
) -> Dict[str, Any]:
    """Deterministic end-to-end graph for one entry (contract sections 3/10.1)."""
    ctx = _load_context(state, workspace_ref, snapshot_ref)
    entry_function = _resolve_entry(ctx, entry_ref)
    entry_id = entry_function.get("id")
    entry_info = ctx.function_info(entry_id) or {}
    entry_file = entry_info.get("file")
    # S2b (contract section 10.3): optional subflow root -> breadcrumb path.
    root_function: Optional[Dict[str, Any]] = None
    root_id: Optional[str] = None
    subflow_root_id: Optional[str] = None
    breadcrumb: List[Dict[str, Any]] = []
    breadcrumb_unavailable = False
    if root_ref is not None:
        root_function = _resolve_named_function(ctx, root_ref, "root")
        root_id = root_function.get("id")
        if root_id != entry_id:
            subflow_root_id = root_id
            path_ids, path_sites = _shortest_call_path(ctx, root_id, entry_id)
            if path_ids:
                breadcrumb = _breadcrumb_items(ctx, path_ids, path_sites)
            else:
                breadcrumb_unavailable = True
    boundary_ids = _boundary_function_ids(ctx, entry_file)
    function_names = {
        function.get("name")
        for function in ctx.functions.values()
        if isinstance(function.get("name"), str)
    }

    def display_label(function_id: Any) -> str:
        info = ctx.function_info(function_id) or {}
        return info.get("name") or "unknown"

    nodes: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []
    exits: List[Dict[str, Any]] = []
    node_ids: Set[str] = set()
    edge_ids: Set[str] = set()
    truncated_flags = {
        "nodes": False,
        "edges": False,
        "functions": False,
        "depth": False,
    }

    def add_node(node: Dict[str, Any]) -> bool:
        if node["node_id"] in node_ids:
            return True
        if len(nodes) >= MAX_E2E_NODES:
            truncated_flags["nodes"] = True
            return False
        node_ids.add(node["node_id"])
        nodes.append(node)
        return True

    def add_edge(edge: Dict[str, Any]) -> bool:
        if edge["edge_id"] in edge_ids:
            return True
        if len(edges) >= MAX_E2E_EDGES:
            truncated_flags["edges"] = True
            return False
        edge_ids.add(edge["edge_id"])
        edges.append(edge)
        return True

    def process_node_id(function_id: str) -> str:
        return f"entry:{function_id}" if function_id == entry_id else f"fn:{function_id}"

    def function_node(function_id: str, node_id: str, kind: str) -> Dict[str, Any]:
        info = ctx.function_info(function_id) or {}
        return {
            "node_id": node_id,
            "kind": kind,
            "label": info.get("name") or "unknown",
            "sublabel": (
                f"{info.get('file')}:{info.get('line')}"
                if isinstance(info.get("file"), str)
                else None
            ),
            "file": info.get("file"),
            "line": info.get("line"),
            "function_id": function_id,
            "callsite_id": None,
            "shape": "ellipse" if kind == "entry" else "rect",
            "role": "normal",
            "certainty": "exact",
            "evidence_ids": list(info.get("evidence_ids") or []),
        }

    # Rule 1 + 2: entry ellipse and one process rectangle per reachable function.
    add_node(function_node(entry_id, f"entry:{entry_id}", "entry"))
    process_order: List[str] = [entry_id]
    process: Set[str] = {entry_id}
    queue: List[Tuple[str, int]] = [(entry_id, 0)]
    while queue:
        function_id, depth = queue.pop(0)
        if depth >= MAX_E2E_DEPTH:
            if ctx.call_targets_by_source.get(function_id):
                truncated_flags["depth"] = True
            continue
        for target in ctx.call_targets_by_source.get(function_id, []):
            target_id = target.get("target")
            if not isinstance(target_id, str) or target_id not in ctx.functions:
                continue
            if target_id in boundary_ids or target_id in process:
                continue
            if len(process) >= MAX_E2E_FUNCTIONS:
                truncated_flags["functions"] = True
                break
            process.add(target_id)
            process_order.append(target_id)
            queue.append((target_id, depth + 1))

    for function_id in process_order:
        if function_id == entry_id:
            continue
        node = function_node(function_id, process_node_id(function_id), "process")
        info = ctx.function_info(function_id) or {}
        returns = ctx.returns_for(function_id)
        if returns:
            node["returns_count"] = len(returns)
            node["sublabel"] = (
                f"{info.get('file')}:{info.get('line')} · {len(returns)} 个返回"
                if isinstance(info.get("file"), str)
                else f"{len(returns)} 个返回"
            )
        add_node(node)

    def add_decision(callsite_info: Dict[str, Any], certainty: str) -> Optional[str]:
        callsite_id = callsite_info.get("callsite_id")
        node_id = f"decision:{callsite_id}"
        if node_id in node_ids:
            return node_id
        guard_labels = [
            _one_line(guard.get("expression"), _GUARD_LABEL_LIMIT)
            for guard in callsite_info.get("guards") or []
            if isinstance(guard, dict)
        ]
        guard_labels = [label for label in guard_labels if label]
        node = {
            "node_id": node_id,
            "kind": "decision",
            "label": " / ".join(guard_labels)[:_GUARD_LABEL_LIMIT] or "条件判断",
            "sublabel": (
                f"{callsite_info.get('file')}:{callsite_info.get('line')}"
                if isinstance(callsite_info.get("file"), str)
                else None
            ),
            "file": callsite_info.get("file"),
            "line": callsite_info.get("line"),
            "function_id": callsite_info.get("owner"),
            "callsite_id": callsite_id,
            "shape": "diamond",
            "role": "normal",
            "certainty": certainty,
            "evidence_ids": list(callsite_info.get("evidence_ids") or []),
        }
        if not add_node(node):
            return None
        return node_id

    def add_guard_edge(
        callsite_info: Dict[str, Any],
        source_node: str,
        decision_node: str,
        certainty: str,
    ) -> None:
        callsite_id = callsite_info.get("callsite_id")
        guard_labels = [
            _one_line(guard.get("expression"), _GUARD_LABEL_LIMIT)
            for guard in callsite_info.get("guards") or []
            if isinstance(guard, dict)
        ]
        guard_label = " / ".join(label for label in guard_labels if label)
        add_edge(
            {
                "edge_id": f"guard:{callsite_id}",
                "from": source_node,
                "to": decision_node,
                "kind": "guard",
                "label": guard_label[:_GUARD_LABEL_LIMIT] or "条件判断",
                "certainty": certainty,
                "origin": "deterministic_analysis",
                "callsite_id": callsite_id,
                "evidence_ids": list(callsite_info.get("evidence_ids") or []),
                "limitations": [],
                "style": {"line": "solid", "color": "normal"},
            }
        )

    # External boundaries are merged per callee name (one node per external
    # callee); every call site still keeps its own edge with callsite/evidence.
    external_nodes: Dict[str, Dict[str, Any]] = {}
    external_meta: Dict[str, Dict[str, Any]] = {}

    def add_external_node(
        callee_name: str,
        callsite_info: Dict[str, Any],
        *,
        function_id: Optional[str] = None,
        certainty: str = "may",
    ) -> Optional[str]:
        name = callee_name or "external"
        node_id = f"external:callee:{name}"
        meta = external_meta.setdefault(
            name,
            {
                "handoffs": 0,
                "callers": set(),
                "callsite_ids": [],
                "certainties": set(),
                "evidence": [],
                "function_id": None,
                "best_location": None,
            },
        )
        info = ctx.function_info(function_id) if isinstance(function_id, str) else None
        meta["handoffs"] += 1
        owner = callsite_info.get("owner")
        if isinstance(owner, str):
            meta["callers"].add(owner)
        callsite_id = callsite_info.get("callsite_id")
        if isinstance(callsite_id, str) and callsite_id not in meta["callsite_ids"]:
            meta["callsite_ids"].append(callsite_id)
        meta["certainties"].add(certainty)
        for evidence_id in callsite_info.get("evidence_ids") or []:
            if isinstance(evidence_id, str) and evidence_id not in meta["evidence"]:
                meta["evidence"].append(evidence_id)
        if isinstance(function_id, str) and meta["function_id"] is None:
            meta["function_id"] = function_id
        line = callsite_info.get("line")
        location = (
            callsite_info.get("file") if isinstance(callsite_info.get("file"), str) else "\uffff",
            line if isinstance(line, int) else 1 << 60,
            str(callsite_id or ""),
        )
        if meta["best_location"] is None or location < meta["best_location"]:
            meta["best_location"] = location
        node = external_nodes.get(name)
        if node is None:
            if len(nodes) >= MAX_E2E_NODES:
                truncated_flags["nodes"] = True
                return None
            node = {
                "node_id": node_id,
                "kind": "external",
                "label": name,
                "sublabel": None,
                "file": None,
                "line": None,
                "function_id": None,
                "callsite_id": None,
                "shape": "rectangle",
                "role": "boundary",
                "certainty": certainty,
                "evidence_ids": [],
                "callsite_count": 0,
                "caller_function_ids": [],
                "callsite_ids": [],
                "function_file": info.get("file") if info else None,
                "function_line": info.get("line") if info else None,
            }
            if not add_node(node):
                return None
            external_nodes[name] = node
        location_file, location_line, _callsite_key = meta["best_location"]
        node.update(
            {
                "sublabel": (
                    f"{location_file}:{location_line}"
                    if isinstance(location_file, str) and location_file != "\uffff"
                    else None
                ),
                "file": location_file if location_file != "\uffff" else None,
                "line": location_line if location_line != 1 << 60 else None,
                "function_id": meta["function_id"],
                "callsite_id": meta["callsite_ids"][0] if meta["callsite_ids"] else None,
                "callsite_count": meta["handoffs"],
                "caller_function_ids": sorted(
                    meta["callers"], key=lambda fid: _function_sort_key(ctx, fid)
                )[:20],
                "callsite_ids": list(meta["callsite_ids"]),
                "evidence_ids": list(meta["evidence"])[:32],
                "certainty": _merge_certainties(meta["certainties"]),
                "function_file": info.get("file") if info else node.get("function_file"),
                "function_line": info.get("line") if info else node.get("function_line"),
            }
        )
        return node_id

    # Rule 3 + 4: call edges, guard decisions and external boundaries.
    guarded_callsite_seen = False
    for function_id in process_order:
        source_node = process_node_id(function_id)
        for callsite in ctx.callsites_by_owner.get(function_id, []):
            callsite_info = ctx.callsite_info(callsite)
            callsite_id = callsite_info.get("callsite_id")
            has_guards = bool(callsite_info.get("guards"))
            if has_guards:
                guarded_callsite_seen = True
            targets = [
                target
                for target in ctx.call_targets_by_callsite.get(callsite_id, [])
                if target.get("source") == function_id
            ]
            if not targets:
                callee = callsite_info.get("callee")
                if callee and callee not in function_names:
                    decision_node: Optional[str] = None
                    if has_guards:
                        decision_node = add_decision(callsite_info, "may")
                        if decision_node is None:
                            continue
                        add_guard_edge(callsite_info, source_node, decision_node, "may")
                    target_node = add_external_node(callee, callsite_info, certainty="may")
                    if target_node:
                        add_edge(
                            {
                                "edge_id": f"external:{callsite_id}",
                                "from": decision_node or source_node,
                                "to": target_node,
                                "kind": "external",
                                "label": _one_line(callsite_info.get("expression"), _CALLSITE_EXPRESSION_LIMIT)
                                or callee,
                                "certainty": "may",
                                "origin": "callsite_only",
                                "callsite_id": callsite_id,
                                "evidence_ids": list(callsite_info.get("evidence_ids") or []),
                                "limitations": ["implementation_not_found", "external_boundary"],
                                "style": {"line": "dashed", "color": "normal"},
                            }
                        )
                continue
            decision_node = None
            if has_guards:
                decision_certainty = _certainty(targets[0].get("certainty"))
                decision_node = add_decision(callsite_info, decision_certainty)
                if decision_node is None:
                    continue
                add_guard_edge(
                    callsite_info, source_node, decision_node, decision_certainty
                )
            for target in targets:
                target_id = target.get("target")
                certainty = _certainty(target.get("certainty"))
                if target_id in boundary_ids:
                    target_node = add_external_node(
                        display_label(target_id),
                        callsite_info,
                        function_id=target_id,
                        certainty=certainty,
                    )
                    if target_node is None:
                        continue
                    add_edge(
                        {
                            "edge_id": f"external:{target.get('id')}",
                            "from": decision_node or source_node,
                            "to": target_node,
                            "kind": "external",
                            "label": _one_line(callsite_info.get("expression"), _CALLSITE_EXPRESSION_LIMIT)
                            or display_label(target_id),
                            "certainty": certainty,
                            "origin": target.get("origin")
                            if isinstance(target.get("origin"), str)
                            else "deterministic_analysis",
                            "callsite_id": callsite_id,
                            "evidence_ids": _strings(target.get("evidence_ids")),
                            "limitations": _strings(target.get("limitations")),
                            "style": {"line": "dashed", "color": "normal"},
                        }
                    )
                    continue
                if target_id not in process:
                    continue
                edge = {
                    "edge_id": f"call:{target.get('id')}",
                    "from": decision_node or source_node,
                    "to": process_node_id(target_id),
                    "kind": "call",
                    "label": _one_line(callsite_info.get("expression"), _CALLSITE_EXPRESSION_LIMIT)
                    or display_label(target_id),
                    "certainty": certainty,
                    "origin": target.get("origin")
                    if isinstance(target.get("origin"), str)
                    else "deterministic_analysis",
                    "callsite_id": callsite_id,
                    "evidence_ids": _strings(target.get("evidence_ids")),
                    "limitations": _strings(target.get("limitations")),
                    "style": _edge_style(certainty),
                }
                add_edge(edge)

    # Rule 5: entry returns become exit nodes; callee returns are summarized.
    entry_returns = ctx.returns_for(entry_id)
    for item in entry_returns:
        expression = item.get("expression") or "return"
        is_error = bool(_NEGATIVE_LITERAL.match(str(expression).strip()))
        role = "error" if is_error else "normal"
        node_id = f"exit:{entry_id}:return:{item.get('flow_edge_id')}"
        certainty = item.get("certainty") or "unknown"
        exit_node = {
            "node_id": node_id,
            "kind": "exit",
            "label": f"返回 {expression}",
            "sublabel": (
                f"{(item.get('location') or {}).get('file')}:{(item.get('location') or {}).get('line')}"
                if (item.get("location") or {}).get("file")
                else None
            ),
            "file": (item.get("location") or {}).get("file"),
            "line": (item.get("location") or {}).get("line"),
            "function_id": entry_id,
            "callsite_id": None,
            "shape": "ellipse",
            "role": role,
            "certainty": certainty,
            "evidence_ids": list(item.get("evidence_ids") or []),
        }
        if not add_node(exit_node):
            break
        exits.append(
            {
                "node_id": node_id,
                "label": exit_node["label"],
                "expression": expression,
                "role": role,
                "certainty": certainty,
            }
        )
        add_edge(
            {
                "edge_id": f"return:{item.get('flow_edge_id')}",
                "from": f"entry:{entry_id}",
                "to": node_id,
                "kind": "return",
                "label": f"返回 {expression}",
                "certainty": certainty,
                "origin": item.get("origin") or "unknown",
                "callsite_id": None,
                "evidence_ids": list(item.get("evidence_ids") or []),
                "limitations": list(item.get("limitations") or []),
                "style": _edge_style(certainty, role),
            }
        )

    # S2b rule 10.1: private-callee subflow groups. Groups are a client-side
    # folding projection only: original nodes/edges and their ids stay intact.
    all_call_targets = [
        target
        for target in ctx.graph.get("call_targets") or []
        if isinstance(target, dict)
    ]
    projected_callers: Dict[str, Set[str]] = {}
    for call_target in all_call_targets:
        source_id = call_target.get("source")
        target_id = call_target.get("target")
        if not isinstance(source_id, str) or not isinstance(target_id, str):
            continue
        if source_id in process:
            projected_callers.setdefault(target_id, set()).add(source_id)
    candidate_groups: List[Tuple[Tuple[Any, ...], Dict[str, Any]]] = []
    for function_id in process_order:
        if function_id == entry_id:
            continue
        private_callees: List[Tuple[Dict[str, Any], str]] = []
        seen_callees: Set[str] = set()
        for call_target in ctx.call_targets_by_source.get(function_id, []):
            target_id = call_target.get("target")
            if not isinstance(target_id, str) or target_id in seen_callees:
                continue
            if target_id == entry_id or target_id not in process:
                continue
            if projected_callers.get(target_id) != {function_id}:
                continue
            if process_node_id(target_id) not in node_ids:
                continue
            seen_callees.add(target_id)
            private_callees.append((call_target, target_id))
        if len(private_callees) < 2:
            continue
        private_callees.sort(key=lambda item: ctx.call_target_sort_key(item[0]))
        member_function_ids = [target_id for _target, target_id in private_callees]
        member_node_ids = [process_node_id(target_id) for target_id in member_function_ids]
        member_node_set = set(member_node_ids)
        member_set = set(member_function_ids)
        # Entry/exit ports are derived from the *rendered* edges (calls, guards,
        # external handoffs, returns): a member touched by an edge from outside
        # the group is an entry port; a member whose edge leaves the group is an
        # exit port.  Groups never merge or rewrite those edges.
        entry_candidates: Set[str] = set()
        exit_candidates: Set[str] = set()
        for edge in edges:
            edge_from = edge.get("from")
            edge_to = edge.get("to")
            if not isinstance(edge_from, str) or not isinstance(edge_to, str):
                continue
            if edge_from in member_node_set and edge_to not in member_node_set:
                exit_candidates.add(edge_from)
            if edge_to in member_node_set and edge_from not in member_node_set:
                entry_candidates.add(edge_to)
        entry_node_ids = [
            node_id for node_id in member_node_ids if node_id in entry_candidates
        ]
        exit_node_ids = [
            node_id for node_id in member_node_ids if node_id in exit_candidates
        ]
        evidence_ids: List[str] = []
        for call_target, _target_id in private_callees:
            for evidence_id in _strings(call_target.get("evidence_ids")):
                if evidence_id not in evidence_ids:
                    evidence_ids.append(evidence_id)
        owner_info = ctx.function_info(function_id) or {}
        owner_name = owner_info.get("name") or function_id
        member_names = [
            (ctx.function_info(member_id) or {}).get("name") or member_id
            for member_id in member_function_ids
        ]
        short_hash = hashlib.sha256(
            "\0".join(sorted(member_function_ids)).encode("utf-8")
        ).hexdigest()[:8]
        group = {
            "group_id": f"group:{function_id}:{short_hash}",
            "parent_group_id": None,
            "label": f"{owner_name} 下游子流程",
            "description": (
                f"由 {'、'.join(member_names)} 组成（仅被 {owner_name} 调用）"
            ),
            "member_node_ids": member_node_ids,
            "member_function_ids": member_function_ids,
            "entry_node_ids": entry_node_ids,
            "exit_node_ids": exit_node_ids,
            "collapsed_default": True,
            "origin": "structural_heuristic",
            "evidence_ids": evidence_ids[:32],
            "limitations": ["group_structural_heuristic", "group_name_not_semantic"],
        }
        candidate_groups.append(
            (
                (
                    owner_info.get("file") if isinstance(owner_info.get("file"), str) else "\uffff",
                    owner_info.get("line")
                    if isinstance(owner_info.get("line"), int)
                    else 1 << 60,
                    group["group_id"],
                ),
                (function_id, group),
            )
        )
    candidate_groups.sort(key=lambda item: item[0])
    groups: List[Dict[str, Any]] = []
    groups_truncated = False
    member_owner_map: Dict[str, str] = {}
    total_members = 0
    for _sort_key, (owner_id, group) in candidate_groups:
        if len(groups) >= MAX_GROUPS:
            groups_truncated = True
            break
        if total_members + len(group["member_function_ids"]) > len(nodes):
            groups_truncated = True
            break
        total_members += len(group["member_function_ids"])
        for member_id in group["member_function_ids"]:
            member_owner_map.setdefault(member_id, group["group_id"])
        groups.append(group)
    kept_group_ids = {group["group_id"] for group in groups}
    for group in groups:
        owner_id = group["group_id"].split(":")[1]
        parent_group_id = member_owner_map.get(owner_id)
        group["parent_group_id"] = (
            parent_group_id
            if parent_group_id in kept_group_ids and parent_group_id != group["group_id"]
            else None
        )
    grouping_gaps: List[Dict[str, Any]] = []
    if groups:
        grouping_gaps.append(
            {
                "code": "group_semantics",
                "status": "degraded",
                "reason": (
                    "组由单入口私有子图结构产生，名称/描述为结构归纳而非语义理解，"
                    "可由用户修订"
                ),
            }
        )
    if groups_truncated:
        grouping_gaps.append(
            {
                "code": "groups_truncated",
                "status": "degraded",
                "reason": f"组数/成员数超出预算（组≤{MAX_GROUPS}、成员≤节点数），已截断",
            }
        )
    grouping = {
        "algorithm": "private_callee_subflow",
        "groups": len(groups),
        "members": sum(len(group["member_function_ids"]) for group in groups),
        "gaps": grouping_gaps,
    }

    gaps = readmodel._snapshot_gaps(ctx.bundle)
    gaps.extend(_deferred_gaps("ai_summary", "run_observation"))
    callee_return_count = sum(
        len(ctx.returns_for(function_id))
        for function_id in process_order
        if function_id != entry_id
    )
    if callee_return_count:
        gaps.append(
            {
                "code": "callee_returns_summarized",
                "status": "degraded",
                "reason": (
                    f"非入口函数共 {callee_return_count} 条 return 汇总到 process 节点 "
                    "returns_count，未单独展开"
                ),
            }
        )
    if boundary_ids:
        gaps.append(
            {
                "code": "domain_boundary_heuristic",
                "status": "degraded",
                "reason": (
                    "跨文件且无已解析出边的函数按分析域边界（设备/库）显示；"
                    "这是读模型启发式，不是 Atlas 事实"
                ),
            }
        )
    if guarded_callsite_seen:
        gaps.append(
            {
                "code": "branch_conditions_partial",
                "status": "degraded",
                "reason": (
                    "分支条件仅来自带调用点的 callsite guard；无调用点的源码分支未建模"
                    "（需 CFG，CW-T4）"
                ),
            }
        )
    if breadcrumb_unavailable:
        gaps.append(
            {
                "code": "breadcrumb_unavailable",
                "status": "unavailable",
                "reason": (
                    "root 到 entry 之间没有 ≤"
                    f"{MAX_BREADCRUMB_HOPS} 跳的已解析调用路径；"
                    "面包屑为空，子流程仍按 entry 独立投影"
                ),
            }
        )
    if groups_truncated:
        gaps.append(
            {
                "code": "groups_truncated",
                "status": "degraded",
                "reason": f"组数/成员数超出预算（组≤{MAX_GROUPS}、成员≤节点数），已截断",
            }
        )
    for key, limit in (
        ("nodes", MAX_E2E_NODES),
        ("edges", MAX_E2E_EDGES),
        ("functions", MAX_E2E_FUNCTIONS),
        ("depth", MAX_E2E_DEPTH),
    ):
        if truncated_flags[key]:
            gaps.append(
                {
                    "code": f"end_to_end_{key}_truncated",
                    "status": "degraded",
                    "reason": f"end-to-end {key} were capped at {limit}",
                }
            )
    selection = _selection_ext(
        ctx,
        entry_function,
        evidence_ids=entry_info.get("evidence_ids") or [],
        subflow_root_id=subflow_root_id,
    )
    return _snapshot_prefix(
        ctx,
        selection,
        gaps,
        any(truncated_flags.values()) or groups_truncated,
        entry=_entry_header(ctx, entry_function),
        nodes=nodes,
        edges=edges,
        exits=exits,
        groups=groups,
        grouping=grouping,
        breadcrumb=breadcrumb,
        root=root_id,
        subflow_root_id=subflow_root_id,
        legend=[dict(item) for item in _LEGEND],
        layout={"direction": "DOWN", "edge_routing": "ORTHOGONAL"},
    )


# ---------------------------------------------------------------------------
# 3b) interfaces -- rule-based basic interface library (contract section 10.2)
# ---------------------------------------------------------------------------
_INTERFACE_CANDIDATE_LIMITATION = "candidate_rule_based_not_semantic"


def _side_effect_location(
    ctx: _Context, evidence_ids: Any
) -> Dict[str, Any]:
    raw_file, line = readmodel._evidence_location(ctx.evidence, evidence_ids)
    relative, _file_repo = readmodel._map_file(ctx.roots, ctx.repo_id, raw_file)
    return {"file": relative, "line": line}


def _interface_side_effects(
    ctx: _Context, function_id: str
) -> List[Dict[str, Any]]:
    """Field/global-state side effects of one candidate (field + shared + state)."""
    effects: List[Dict[str, Any]] = []
    seen: Set[Tuple[Any, ...]] = set()

    def add(
        access: Any,
        field_name: Any,
        certainty: Any,
        evidence_ids: Any,
        limitations: Any,
    ) -> None:
        record = {
            "access": _access_kind(access),
            "field_name": _bounded(field_name, 256),
            "certainty": _certainty(certainty),
            "location": _side_effect_location(ctx, evidence_ids),
            "limitations": _strings(limitations),
        }
        location = record["location"] or {}
        key = (
            record["access"],
            record["field_name"],
            location.get("file"),
            location.get("line"),
        )
        if key in seen:
            return
        seen.add(key)
        effects.append(record)

    for record in ctx.accesses_by_owner.get(function_id, []):
        add(
            record.get("access"),
            record.get("field_name"),
            record.get("certainty"),
            record.get("evidence_ids"),
            record.get("limitations"),
        )
    for shared in ctx.graph.get("shared_accesses") or []:
        if not isinstance(shared, dict) or shared.get("owner") != function_id:
            continue
        object_id = shared.get("object_id")
        field_name = ctx.object_name(object_id) if isinstance(object_id, str) else None
        add(
            shared.get("access"),
            field_name,
            shared.get("certainty"),
            shared.get("evidence_ids"),
            shared.get("limitations"),
        )
    for event in ctx.graph.get("state_events") or []:
        if not isinstance(event, dict) or event.get("owner") != function_id:
            continue
        kind = event.get("kind")
        if kind in ("write", "write_or_initialize"):
            access = "write"
        elif kind in ("read", "reference"):
            access = "read"
        else:
            continue
        object_id = event.get("object_id")
        field_name = ctx.object_name(object_id) if isinstance(object_id, str) else None
        add(access, field_name, event.get("certainty"), event.get("evidence_ids"), [])
    effects.sort(
        key=lambda item: (
            (item.get("location") or {}).get("file")
            if isinstance((item.get("location") or {}).get("file"), str)
            else "\uffff",
            (item.get("location") or {}).get("line")
            if isinstance((item.get("location") or {}).get("line"), int)
            else 1 << 60,
            item.get("access") or "",
            item.get("field_name") or "",
        )
    )
    return effects[:MAX_INTERFACE_EFFECTS]


def _interface_external_boundaries(
    ctx: _Context, scope_functions: Set[str]
) -> List[Dict[str, Any]]:
    function_names = {
        function.get("name")
        for function in ctx.functions.values()
        if isinstance(function.get("name"), str)
    }
    grouped: Dict[str, List[str]] = {}
    for function_id in sorted(scope_functions, key=lambda fid: _function_sort_key(ctx, fid)):
        for callsite in ctx.callsites_by_owner.get(function_id, []):
            callsite_info = ctx.callsite_info(callsite)
            callsite_id = callsite_info.get("callsite_id")
            if not isinstance(callsite_id, str):
                continue
            if ctx.call_targets_by_callsite.get(callsite_id):
                continue
            callee = callsite_info.get("callee")
            if not callee or callee in function_names:
                continue
            bucket = grouped.setdefault(callee, [])
            if callsite_id not in bucket:
                bucket.append(callsite_id)
    boundaries = [
        {
            "callee": callee,
            "call_count": len(callsite_ids),
            "callsite_ids": list(callsite_ids),
        }
        for callee, callsite_ids in sorted(grouped.items())
    ]
    return boundaries[:MAX_INTERFACE_EXTERNAL_BOUNDARIES]


def interfaces(
    state: Any,
    workspace_ref: Any,
    snapshot_ref: Any,
    entry_ref: Any = None,
) -> Dict[str, Any]:
    """Rule-based interface-library candidates for one verified snapshot."""
    ctx = _load_context(state, workspace_ref, snapshot_ref)
    entry_function: Optional[Dict[str, Any]] = None
    scope_functions: Set[str] = set(ctx.functions)
    gaps = readmodel._snapshot_gaps(ctx.bundle)
    if entry_ref is not None:
        entry_function = _resolve_entry(ctx, entry_ref)
        entry_id = entry_function.get("id")
        reachable, scope_truncated = ctx.downward_reachable(
            entry_id, limit=MAX_COUPLING_REACHABLE
        )
        scope_functions = set(reachable)
        if scope_truncated:
            gaps.append(
                {
                    "code": "interfaces_scope_truncated",
                    "status": "degraded",
                    "reason": f"入口邻域函数被截断到 {MAX_COUPLING_REACHABLE} 个",
                }
            )
    entry_id = entry_function.get("id") if entry_function else None

    incoming_by_target: Dict[str, List[Dict[str, Any]]] = {}
    for call_target in ctx.graph.get("call_targets") or []:
        if not isinstance(call_target, dict):
            continue
        target_id = call_target.get("target")
        if isinstance(target_id, str):
            incoming_by_target.setdefault(target_id, []).append(call_target)
    for rows in incoming_by_target.values():
        rows.sort(key=ctx.call_target_sort_key)

    candidates: List[Dict[str, Any]] = []
    callers_truncated = False
    for function_id in sorted(ctx.functions, key=lambda fid: _function_sort_key(ctx, fid)):
        if entry_id is not None and function_id == entry_id:
            continue
        if function_id not in scope_functions:
            continue
        incoming = incoming_by_target.get(function_id, [])
        if not incoming:
            continue
        function = ctx.functions[function_id]
        info = ctx.function_info(function_id) or {}
        signature = function.get("signature")
        return_type = function.get("return_type")
        if not isinstance(signature, str) or not signature:
            continue
        if not isinstance(return_type, str) or not return_type:
            continue
        side_effects = _interface_side_effects(ctx, function_id)
        has_write = any(item.get("access") in _WRITE_ACCESSES for item in side_effects)
        leaf = not bool(ctx.call_targets_by_source.get(function_id))
        callers: List[Dict[str, Any]] = []
        input_guards: List[Dict[str, Any]] = []
        guard_seen: Set[str] = set()
        cross_file = False
        evidence_ids: List[str] = list(info.get("evidence_ids") or [])
        for call_target in incoming:
            source_id = call_target.get("source")
            caller_info = (
                (ctx.function_info(source_id) or {})
                if isinstance(source_id, str)
                else {}
            )
            callsite_id = call_target.get("callsite")
            callsite_info = (
                ctx.callsite_info(ctx.callsites.get(callsite_id, {}))
                if isinstance(callsite_id, str)
                else ctx.callsite_info({})
            )
            caller_file = caller_info.get("file")
            if (
                isinstance(caller_file, str)
                and isinstance(info.get("file"), str)
                and caller_file != info.get("file")
            ):
                cross_file = True
            if len(callers) < MAX_INTERFACE_CALLERS:
                callers.append(
                    {
                        "function_id": source_id if isinstance(source_id, str) else None,
                        "name": caller_info.get("name"),
                        "file": caller_file,
                        "line": caller_info.get("line"),
                        "callsite_id": callsite_id if isinstance(callsite_id, str) else None,
                        "location": {
                            "file": callsite_info.get("file"),
                            "line": callsite_info.get("line"),
                        },
                    }
                )
            else:
                callers_truncated = True
            callsite_guards = callsite_info.get("guards") or []
            if callsite_guards and isinstance(callsite_id, str) and callsite_id not in guard_seen:
                guard_seen.add(callsite_id)
                guard_text = " / ".join(
                    filter(
                        None,
                        [
                            _one_line(guard.get("expression"), _GUARD_LABEL_LIMIT)
                            for guard in callsite_guards
                            if isinstance(guard, dict)
                        ],
                    )
                )
                input_guards.append(
                    {
                        "callsite_id": callsite_id,
                        "file": callsite_info.get("file"),
                        "line": callsite_info.get("line"),
                        "expression": guard_text[:_GUARD_LABEL_LIMIT] or None,
                    }
                )
            for evidence_id in _strings(call_target.get("evidence_ids")):
                if evidence_id not in evidence_ids:
                    evidence_ids.append(evidence_id)
        for record in ctx.accesses_by_owner.get(function_id, []):
            for evidence_id in record.get("evidence_ids") or []:
                if evidence_id not in evidence_ids:
                    evidence_ids.append(evidence_id)
        for shared in ctx.graph.get("shared_accesses") or []:
            if isinstance(shared, dict) and shared.get("owner") == function_id:
                for evidence_id in _strings(shared.get("evidence_ids")):
                    if evidence_id not in evidence_ids:
                        evidence_ids.append(evidence_id)

        if leaf and not has_write:
            decoupling = "independent"
        elif has_write or not leaf:
            decoupling = "mixed"
        else:
            decoupling = "unknown"
        reasons: List[Dict[str, Any]] = []
        if leaf:
            reasons.append({"code": "leaf_callee", "label": "无已解析出边"})
        if cross_file:
            reasons.append({"code": "cross_file_boundary", "label": "跨文件被调用"})
        reasons.append({"code": "stable_signature", "label": "签名/入参/返回值完整"})
        if has_write:
            reasons.append(
                {"code": "side_effects_present", "label": "存在字段写副作用"}
            )
        if input_guards:
            reasons.append(
                {"code": "input_guards_present", "label": "调用点带条件 guard"}
            )
        if len(incoming) >= 2:
            reasons.append({"code": "multiple_callers", "label": "被多个调用点调用"})
        score = 0
        if decoupling == "independent":
            score += 5
        if cross_file:
            score += 3
        if len(incoming) >= 2:
            score += 2
        if not side_effects:
            score += 2
        if has_write:
            score -= 1
        parameters = [
            {
                "name": _bounded(parameter.get("name"), 256),
                "type": _bounded(parameter.get("type"), 512),
            }
            for parameter in function.get("parameters") or []
            if isinstance(parameter, dict)
        ]
        candidates.append(
            {
                "interface_id": f"iface:{function_id}",
                "function_id": function_id,
                "name": info.get("name"),
                "file": info.get("file"),
                "line": info.get("line"),
                "signature": _bounded(signature, 512),
                "parameters": parameters,
                "return_type": _bounded(return_type, 512),
                "call_count": len(incoming),
                "callers": callers,
                "leaf": leaf,
                "cross_file": cross_file,
                "field_accesses": side_effects,
                "input_guards": input_guards[:MAX_INTERFACE_GUARDS],
                "decoupling": decoupling,
                "reasons": reasons,
                "score": score,
                "certainty": "may",
                "evidence_ids": evidence_ids[:32],
                "limitations": [_INTERFACE_CANDIDATE_LIMITATION],
            }
        )
    candidates.sort(key=lambda item: (-item["score"], item["name"] or "", item["function_id"]))
    truncated = len(candidates) > MAX_INTERFACES
    candidates = candidates[:MAX_INTERFACES]
    if not candidates:
        gaps.append(
            {
                "code": "interface_candidates",
                "status": "unavailable",
                "reason": "no_rule_based_interface_candidate_in_scope",
            }
        )
    if truncated:
        gaps.append(
            {
                "code": "interfaces_truncated",
                "status": "degraded",
                "reason": f"interface candidates were capped at {MAX_INTERFACES}",
            }
        )
    if callers_truncated:
        gaps.append(
            {
                "code": "interface_callers_truncated",
                "status": "degraded",
                "reason": f"per-candidate callers were capped at {MAX_INTERFACE_CALLERS}",
            }
        )
    external_boundaries = _interface_external_boundaries(ctx, scope_functions)
    selection = _selection_ext(
        ctx,
        entry_function,
        evidence_ids=_strings(entry_function.get("evidence_ids")) if entry_function else [],
    )
    return _snapshot_prefix(
        ctx,
        selection,
        gaps,
        truncated,
        candidates=candidates,
        external_boundaries=external_boundaries,
    )


# ---------------------------------------------------------------------------
# 4) file_tree -- snapshot evidence files
# ---------------------------------------------------------------------------
def file_tree(state: Any, workspace_ref: Any, snapshot_ref: Any) -> Dict[str, Any]:
    """Files referenced by the snapshot evidence, grouped per repository."""
    ctx = _load_context(state, workspace_ref, snapshot_ref)
    gaps = readmodel._snapshot_gaps(ctx.bundle)
    mapping: Dict[Tuple[str, str], Dict[str, Any]] = {}
    unmapped = 0
    for entity in ctx.graph.get("evidence") or []:
        if not isinstance(entity, dict):
            continue
        raw_file = entity.get("file")
        relative, file_repo = readmodel._map_file(ctx.roots, ctx.repo_id, raw_file)
        if relative is None or file_repo is None:
            if isinstance(raw_file, str) and raw_file:
                unmapped += 1
            continue
        record = mapping.setdefault(
            (file_repo, relative), {"hashes": set(), "evidence_ids": []}
        )
        file_hash = entity.get("hash")
        if isinstance(file_hash, str) and file_hash:
            record["hashes"].add(file_hash)
        evidence_id = entity.get("id")
        if isinstance(evidence_id, str):
            record["evidence_ids"].append(evidence_id)

    repo_order: List[str] = []
    roles: Dict[str, Any] = {}
    for repository in ctx.workspace.get("repositories") or []:
        if isinstance(repository, dict) and isinstance(repository.get("repo_id"), str):
            repo_order.append(repository["repo_id"])
            roles[repository["repo_id"]] = repository.get("role")
    extra_repos = sorted({repo_id for repo_id, _path in mapping if repo_id not in roles})
    for repo_id in extra_repos:
        repo_order.append(repo_id)
        roles[repo_id] = None

    files_by_repo: Dict[str, List[Dict[str, Any]]] = {repo_id: [] for repo_id in repo_order}
    unavailable = 0
    hash_conflicts = 0
    for (repo_id, relative), record in mapping.items():
        hashes = sorted(record["hashes"])
        if len(hashes) > 1:
            hash_conflicts += 1
        file_bytes: Optional[int] = None
        try:
            path = scope.resolve_repo_file(
                state, ctx.workspace, repo_id, relative, must_exist=True
            )
            file_bytes = path.stat().st_size
        except CodeLearningError:
            unavailable += 1
        files_by_repo.setdefault(repo_id, []).append(
            {
                "path": relative,
                "bytes": file_bytes,
                "sha256": hashes[0] if hashes else None,
                "has_evidence": True,
            }
        )
    for repo_id in files_by_repo:
        files_by_repo[repo_id].sort(key=lambda item: item["path"])

    total = sum(len(files) for files in files_by_repo.values())
    per_repo_truncated: Set[str] = set()
    global_truncated = False
    remaining = MAX_FILE_TREE_FILES
    for repo_id in repo_order:
        files = files_by_repo.get(repo_id, [])
        if len(files) > remaining:
            files_by_repo[repo_id] = files[:remaining]
            per_repo_truncated.add(repo_id)
            global_truncated = True
        remaining -= len(files_by_repo.get(repo_id, []))
        if remaining <= 0:
            remaining = 0

    repos: List[Dict[str, Any]] = []
    for repo_id in repo_order:
        if not any(key[0] == repo_id for key in mapping):
            # Repositories with no snapshot-referenced file carry no tree entry.
            continue
        files = files_by_repo.get(repo_id, [])
        repos.append(
            {
                "repo_id": repo_id,
                "role": roles.get(repo_id),
                "files": files,
                "truncated": repo_id in per_repo_truncated,
            }
        )
    if not repos or total == 0:
        gaps.append(
            {
                "code": "snapshot_evidence_files_missing",
                "status": "unavailable",
                "reason": "atlas_snapshot_has_no_evidence_file",
            }
        )
    if unmapped:
        gaps.append(
            {
                "code": "file_unmapped",
                "status": "degraded",
                "reason": f"{unmapped} evidence file(s) could not be mapped to a registered repository root",
            }
        )
    if unavailable:
        gaps.append(
            {
                "code": "file_source_unavailable",
                "status": "degraded",
                "reason": f"{unavailable} referenced source file(s) are not readable",
            }
        )
    if hash_conflicts:
        gaps.append(
            {
                "code": "file_evidence_hash_conflict",
                "status": "degraded",
                "reason": f"{hash_conflicts} file(s) have inconsistent evidence hashes in the snapshot",
            }
        )
    if global_truncated:
        gaps.append(
            {
                "code": "file_tree_truncated",
                "status": "degraded",
                "reason": f"file tree entries were capped at {MAX_FILE_TREE_FILES}",
            }
        )
    selection = _selection_ext(ctx)
    return _snapshot_prefix(
        ctx, selection, gaps, global_truncated, repos=repos
    )


# ---------------------------------------------------------------------------
# 5) file_read -- bounded read-only source window
# ---------------------------------------------------------------------------
def _read_verified_file(
    state: Any,
    workspace: Dict[str, Any],
    repo_id: str,
    relative: str,
    expected_sha256: str,
    max_lines: int,
) -> Dict[str, Any]:
    """Read one bounded window; verify the snapshot hash and count all lines."""
    path = scope.resolve_repo_file(state, workspace, repo_id, relative, must_exist=True)
    hasher = hashlib.sha256()
    newline_count = 0
    size = 0
    prefix = bytearray()
    last_byte = b""
    try:
        with open(path, "rb") as handle:
            while True:
                chunk = handle.read(1 << 20)
                if not chunk:
                    break
                size += len(chunk)
                hasher.update(chunk)
                newline_count += chunk.count(b"\n")
                last_byte = chunk[-1:]
                if len(prefix) < MAX_FILE_READ_BYTES:
                    prefix.extend(chunk[: MAX_FILE_READ_BYTES - len(prefix)])
    except OSError:
        fail("DEPENDENCY_UNAVAILABLE", "source file is not readable")
    actual_sha = hasher.hexdigest()
    if actual_sha != expected_sha256:
        fail(
            "STALE_SOURCE",
            "source file content hash does not match the snapshot evidence hash",
            details={"path": relative},
        )
    total_lines = 0 if size == 0 else newline_count + (0 if last_byte == b"\n" else 1)

    raw_prefix = bytes(prefix)
    if size <= len(raw_prefix):
        window = raw_prefix
        fully_read = True
    else:
        fully_read = False
        cut = raw_prefix.rfind(b"\n")
        window = raw_prefix[: cut + 1] if cut >= 0 else raw_prefix
        while window and (window[-1] & 0xC0) == 0x80:
            window = window[:-1]
    text: Optional[str] = None
    status = "ok"
    reason: Optional[str] = None
    if b"\x00" in window:
        status, reason = "ref_only", "binary"
    else:
        try:
            text = window.decode("utf-8")
        except UnicodeDecodeError:
            status, reason = "ref_only", "binary"
        else:
            if source._secret_like(text) or source._secret_file_name(relative):
                status, reason = "ref_only", "secret_suspected"
                text = None
    lines: List[Dict[str, Any]] = []
    line_end = 0
    byte_end = len(window)
    if text is not None and status == "ok":
        pieces = text.split("\n")
        if pieces and pieces[-1] == "":
            pieces.pop()
        truncated_by_lines = len(pieces) > max_lines
        if truncated_by_lines:
            pieces = pieces[:max_lines]
        lines = [
            {"n": index + 1, "text": piece.rstrip("\r")}
            for index, piece in enumerate(pieces)
        ]
        line_end = len(lines)
        if truncated_by_lines:
            consumed = sum(len(piece.encode("utf-8")) + 1 for piece in pieces)
            byte_end = min(byte_end, consumed)
    truncated = (not fully_read) or (status == "ok" and line_end < total_lines)
    return {
        "path": path,
        "sha256": actual_sha,
        "bytes": size,
        "total_lines": total_lines,
        "status": status,
        "reason": reason,
        "lines": lines,
        "line_end": line_end,
        "byte_end": byte_end,
        "truncated": truncated,
    }


def _read_evidence_refs(
    ctx: _Context,
    repo_id: str,
    relative: str,
    sha256: str,
    window: Dict[str, Any],
) -> Tuple[Optional[str], List[Dict[str, Any]]]:
    """Sign evidence refs chunked at line boundaries (each <= 16 KiB)."""
    variant_id = ctx.bundle.get("variant_id")
    observed_at = utc_now_iso()

    def sign(byte_start: int, byte_end: int, line_start: int, line_end: int) -> Optional[str]:
        if byte_end <= byte_start:
            return None
        try:
            return scope.sign_evidence_ref(
                ctx.state,
                workspace_id=ctx.workspace["workspace_id"],
                repo_id=repo_id,
                variant_id=variant_id,
                relative_path=relative,
                source_sha256=sha256,
                byte_start=byte_start,
                byte_end=byte_end,
                line_start=line_start,
                line_end=line_end,
                observed_at=observed_at,
            )
        except CodeLearningError:
            return None

    if window["status"] != "ok" or not window["lines"]:
        ref = sign(0, min(window["byte_end"], MAX_EVIDENCE_SPAN), 1, 1)
        return ref, ([{"byte_start": 0, "byte_end": min(window["byte_end"], MAX_EVIDENCE_SPAN), "line_start": 1, "line_end": 1, "evidence_ref": ref}] if ref else [])
    chunks: List[Dict[str, Any]] = []
    offset = 0
    chunk_start = 0
    chunk_line_start = 1
    for line in window["lines"]:
        piece = line["text"]
        line_bytes = len(piece.encode("utf-8")) + 1
        if offset + line_bytes - chunk_start > MAX_EVIDENCE_SPAN and offset > chunk_start:
            ref = sign(chunk_start, offset, chunk_line_start, line["n"] - 1)
            if ref:
                chunks.append(
                    {
                        "byte_start": chunk_start,
                        "byte_end": offset,
                        "line_start": chunk_line_start,
                        "line_end": line["n"] - 1,
                        "evidence_ref": ref,
                    }
                )
            chunk_start = offset
            chunk_line_start = line["n"]
        offset += line_bytes
    final_start = chunk_start
    final_end = min(offset, window["byte_end"])
    if final_end > final_start:
        final_line_start = chunk_line_start
        final_line = 1 + len(window["lines"]) - 1
        ref = sign(final_start, final_end, final_line_start, final_line)
        if ref:
            chunks.append(
                {
                    "byte_start": final_start,
                    "byte_end": final_end,
                    "line_start": final_line_start,
                    "line_end": final_line,
                    "evidence_ref": ref,
                }
            )
    return (chunks[0]["evidence_ref"] if chunks else None), chunks


def file_read(
    state: Any,
    workspace_ref: Any,
    snapshot_ref: Any,
    repo_id: Any,
    path_ref: Any,
    max_lines: int = MAX_FILE_READ_LINES,
) -> Dict[str, Any]:
    """Read one repository-relative source window referenced by the snapshot."""
    ctx = _load_context(state, workspace_ref, snapshot_ref)
    repo = check_id(expect_str(repo_id, "repo", max_len=64), "repo")
    path_text = expect_str(path_ref, "path", max_len=512)
    relative = safe_relative_path(path_text, "path")
    lines_limit = expect_int(max_lines, "max_lines", low=1, high=MAX_FILE_READ_LINES)
    # The file must be referenced by snapshot evidence, and its recorded hash is
    # the expected content hash (single authority for staleness).
    hashes: Set[str] = set()
    referenced = False
    for entity in ctx.graph.get("evidence") or []:
        if not isinstance(entity, dict):
            continue
        raw_file = entity.get("file")
        mapped, file_repo = readmodel._map_file(ctx.roots, ctx.repo_id, raw_file)
        if mapped != relative or file_repo != repo:
            continue
        referenced = True
        file_hash = entity.get("hash")
        if isinstance(file_hash, str) and file_hash:
            hashes.add(file_hash)
    if not referenced:
        fail(
            "NOT_FOUND",
            "file is not referenced by this snapshot's evidence",
            details={"repo_id": repo},
        )
    if len(hashes) != 1:
        fail(
            "STALE_SOURCE",
            "snapshot evidence has no consistent content hash for this file",
            details={"repo_id": repo},
        )
    expected_sha = next(iter(hashes))
    window = _read_verified_file(
        state, ctx.workspace, repo, relative, expected_sha, lines_limit
    )
    evidence_ref, evidence_refs = _read_evidence_refs(
        ctx, repo, relative, expected_sha, window
    )
    gaps = readmodel._snapshot_gaps(ctx.bundle)
    if window["truncated"]:
        gaps.append(
            {
                "code": "file_read_truncated",
                "status": "degraded",
                "reason": (
                    f"file window is bounded to {MAX_FILE_READ_BYTES} bytes / "
                    f"{MAX_FILE_READ_LINES} lines"
                ),
            }
        )
    selection = _selection_ext(ctx)
    return _snapshot_prefix(
        ctx,
        selection,
        gaps,
        window["truncated"],
        repo_id=repo,
        path=relative,
        sha256=window["sha256"],
        bytes=window["bytes"],
        total_lines=window["total_lines"],
        line_start=1,
        line_end=window["line_end"],
        lines=window["lines"],
        evidence_ref=evidence_ref,
        evidence_refs=evidence_refs,
        status=window["status"],
        reason=window["reason"],
    )


# ---------------------------------------------------------------------------
# 6) sequence_static -- statically predicted sequence (S2a only mode)
# ---------------------------------------------------------------------------
_PARTICIPANT_LABELS = {
    "caller": "调用方",
    "driver": "驱动",
    "resource": "全局资源",
    "platform": "设备/库边界",
    "external": "未解析外部边界",
}
_PARTICIPANT_ORDER = ["caller", "driver", "resource", "platform", "external"]
_SEQUENCE_WARNING = "静态预测：无运行观测，不表示实际执行顺序或取值"


def _participant_for(
    ctx: _Context, function_id: Optional[str], entry_file: Optional[str]
) -> str:
    if not isinstance(function_id, str):
        return "external"
    info = ctx.function_info(function_id) or {}
    file_value = info.get("file")
    if entry_file and isinstance(file_value, str) and file_value != entry_file:
        return "platform"
    return "driver"


def sequence_static(
    state: Any, workspace_ref: Any, snapshot_ref: Any, entry_ref: Any, mode: str = "static"
) -> Dict[str, Any]:
    """Statically predicted sequence: DFS pre-order calls plus resource accesses."""
    selected_mode = one_of(mode, ("static",), "mode")
    ctx = _load_context(state, workspace_ref, snapshot_ref)
    entry_function = _resolve_entry(ctx, entry_ref)
    entry_id = entry_function.get("id")
    entry_info = ctx.function_info(entry_id) or {}
    entry_file = entry_info.get("file")
    function_names = {
        function.get("name")
        for function in ctx.functions.values()
        if isinstance(function.get("name"), str)
    }
    messages: List[Dict[str, Any]] = []
    truncated = False
    depth_truncated = False
    used_participants: Set[str] = {"caller", "driver"}

    def add_message(
        *,
        kind: str,
        from_participant: str,
        to_participant: str,
        label: Optional[str],
        function_id: Optional[str],
        callsite_id: Optional[str],
        depth: int,
        certainty: str,
        evidence_ids: Sequence[str],
        limitations: Sequence[str],
    ) -> bool:
        nonlocal truncated
        if len(messages) >= MAX_SEQ_MESSAGES:
            truncated = True
            return False
        used_participants.add(from_participant)
        used_participants.add(to_participant)
        messages.append(
            {
                "message_id": f"m_{len(messages) + 1}",
                "index": len(messages) + 1,
                "kind": kind,
                "from": from_participant,
                "to": to_participant,
                "label": label,
                "function_id": function_id,
                "callsite_id": callsite_id,
                "entry_id": entry_id,
                "depth": depth,
                "certainty": certainty,
                "evidence_ids": list(evidence_ids),
                "limitations": list(limitations),
            }
        )
        return True

    add_message(
        kind="call",
        from_participant="caller",
        to_participant=_participant_for(ctx, entry_id, entry_file),
        label=_bounded(entry_info.get("display_name") or entry_info.get("name"), _CALLSITE_EXPRESSION_LIMIT),
        function_id=entry_id,
        callsite_id=None,
        depth=0,
        certainty="exact",
        evidence_ids=entry_info.get("evidence_ids") or [],
        limitations=[],
    )

    def visit(function_id: str, depth: int, path: Tuple[str, ...]) -> None:
        nonlocal depth_truncated
        if truncated or function_id in path:
            return
        path = path + (function_id,)
        from_participant = _participant_for(ctx, function_id, entry_file)
        for record in ctx.accesses_by_owner.get(function_id, []):
            object_names = [
                name
                for name in (ctx.object_name(object_id) for object_id in record.get("object_ids") or [])
                if name
            ]
            if record.get("expression"):
                label = f"{_ACCESS_LABELS.get(record['access'], record['access'])} {record['expression']}"
            else:
                target = ".".join(object_names[:1] + [record.get("field_name") or ""]).strip(".")
                label = f"{_ACCESS_LABELS.get(record['access'], record['access'])} {target or '资源'}"
            add_message(
                kind="access",
                from_participant=from_participant,
                to_participant="resource",
                label=_one_line(label, _GUARD_LABEL_LIMIT),
                function_id=function_id,
                callsite_id=None,
                depth=depth,
                certainty=record.get("certainty") or "unknown",
                evidence_ids=record.get("evidence_ids") or [],
                limitations=record.get("limitations") or [],
            )
        if depth > MAX_SEQ_DEPTH:
            depth_truncated = True
            return
        for callsite in ctx.callsites_by_owner.get(function_id, []):
            callsite_info = ctx.callsite_info(callsite)
            callsite_id = callsite_info.get("callsite_id")
            targets = [
                target
                for target in ctx.call_targets_by_callsite.get(callsite_id, [])
                if target.get("source") == function_id
            ]
            label = _one_line(
                callsite_info.get("expression") or callsite_info.get("callee"),
                _CALLSITE_EXPRESSION_LIMIT,
            )
            if not targets:
                callee = callsite_info.get("callee")
                if callee and callee not in function_names:
                    if not add_message(
                        kind="external",
                        from_participant=from_participant,
                        to_participant="external",
                        label=label or callee,
                        function_id=function_id,
                        callsite_id=callsite_id,
                        depth=depth + 1,
                        certainty="may",
                        evidence_ids=callsite_info.get("evidence_ids") or [],
                        limitations=["implementation_not_found", "external_boundary"],
                    ):
                        return
                continue
            for target in targets:
                target_id = target.get("target")
                certainty = _certainty(target.get("certainty"))
                target_participant = _participant_for(ctx, target_id, entry_file)
                limitations = _strings(target.get("limitations"))
                if target_id in path:
                    add_message(
                        kind="call",
                        from_participant=from_participant,
                        to_participant=target_participant,
                        label=label,
                        function_id=target_id,
                        callsite_id=callsite_id,
                        depth=depth + 1,
                        certainty=certainty,
                        evidence_ids=_strings(target.get("evidence_ids")),
                        limitations=list(dict.fromkeys(limitations + ["recursive_reference"])),
                    )
                    continue
                if target_participant == "platform":
                    add_message(
                        kind="external",
                        from_participant=from_participant,
                        to_participant="platform",
                        label=label,
                        function_id=target_id,
                        callsite_id=callsite_id,
                        depth=depth + 1,
                        certainty=certainty,
                        evidence_ids=_strings(target.get("evidence_ids")),
                        limitations=limitations,
                    )
                    continue
                if not add_message(
                    kind="call",
                    from_participant=from_participant,
                    to_participant=target_participant,
                    label=label,
                    function_id=target_id,
                    callsite_id=callsite_id,
                    depth=depth + 1,
                    certainty=certainty,
                    evidence_ids=_strings(target.get("evidence_ids")),
                    limitations=limitations,
                ):
                    return
                visit(target_id, depth + 1, path)

    visit(entry_id, 0, ())
    if depth_truncated:
        gaps_depth = True
    else:
        gaps_depth = False
    participants = [
        {"participant_id": participant_id, "label": _PARTICIPANT_LABELS[participant_id]}
        for participant_id in _PARTICIPANT_ORDER
        if participant_id in used_participants
    ]
    gaps = readmodel._snapshot_gaps(ctx.bundle)
    gaps.append(
        {
            "code": "run_observation",
            "status": "unavailable",
            "reason": "S2a 无运行观测；场景/轨迹导入在 CW-T3",
        }
    )
    gaps.extend(_deferred_gaps("scenario_execution"))
    if truncated:
        gaps.append(
            {
                "code": "sequence_truncated",
                "status": "degraded",
                "reason": f"sequence messages were capped at {MAX_SEQ_MESSAGES}",
            }
        )
    if gaps_depth:
        gaps.append(
            {
                "code": "sequence_depth_truncated",
                "status": "degraded",
                "reason": f"sequence recursion was capped at depth {MAX_SEQ_DEPTH}",
            }
        )
    selection = _selection_ext(
        ctx, entry_function, evidence_ids=entry_info.get("evidence_ids") or []
    )
    return _snapshot_prefix(
        ctx,
        selection,
        gaps,
        truncated or gaps_depth,
        mode=selected_mode,
        observed=False,
        warning=_SEQUENCE_WARNING,
        participants=participants,
        messages=messages,
    )
