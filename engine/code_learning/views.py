"""Read-only workbench read model over verified Atlas 0.1 snapshots (CL-VIEW-T1).

Implements the engine slice of ``docs/readonly-workbench-contract.md`` sections
2, 3 and 5:

* :func:`list_snapshots` -- registered workspaces plus every imported snapshot.
  Each snapshot is re-verified through :func:`snapshot.load_snapshot_bundle`;
  one corrupt snapshot is reported as ``status='invalid'`` with an ``error``
  object and never aborts the whole listing.
* :func:`list_entries` -- the function/entry list of one verified snapshot,
  sorted entry-first and bounded to 2000 rows.
* :func:`entry_detail` -- one entry with its source window, direct call edges,
  evidence documents and the Atlas ``objects``/``field_accesses`` resource
  projection.

Boundaries shared with the rest of the engine: snapshots are re-verified before
every use, repository-relative paths are derived from the *registered* roots
(never from the graph's absolute paths), absolute/state/bootstrap paths never
enter the payload, and an unavailable source or resource projection degrades
with an explicit ``status``/``reason`` instead of failing the whole request.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from . import atlas, scope, snapshot, source
from .errors import CodeLearningError, fail
from .util import check_id, safe_relative_path, utc_now_iso
from .validation import expect_str

SCHEMA_VERSION = 1

#: Bounded list sizes fixed by the contract.
MAX_ENTRIES = 2000
MAX_EDGES = 100
MAX_FIELD_ACCESSES = 100
MAX_EVIDENCE_ITEMS = 200

#: One source projection is bounded to 16384 bytes / 400 lines.
MAX_SOURCE_BYTES = 16384
MAX_SOURCE_LINES = 400

#: Text bounds for untrusted graph strings (never user-visible evidence facts).
MAX_NAME = 4096
MAX_EVIDENCE_TEXT = 512
MAX_EXPRESSION = 512

#: Allowed Atlas access facts; anything else is reported as ``unknown`` and
#: flagged with a limitation instead of being invented.
ACCESS_VALUES = frozenset(
    {"read", "write", "rmw", "init", "deinit", "alloc", "free", "acquire", "release"}
)
CERTAINTY_VALUES = frozenset({"exact", "may", "unknown"})

_DRIVE_RE = re.compile(r"^[A-Za-z]:[\\/]")
_ABS_UNIX_RE = re.compile(r"^/(?!/)")


# ---------------------------------------------------------------------------
# small value helpers
# ---------------------------------------------------------------------------
def _bounded_text(value: Any, limit: int = MAX_NAME) -> Optional[str]:
    if not isinstance(value, str) or not value:
        return None
    return value if len(value) <= limit else value[:limit]


def _string_list(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item]


def _optional_int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _counts(adjacency: Dict[str, List[Any]]) -> Dict[str, int]:
    return {node: len(rows) for node, rows in adjacency.items()}


# ---------------------------------------------------------------------------
# input loading / verification
# ---------------------------------------------------------------------------
def _workspace_or_fail(state: Any, workspace_ref: Any) -> Dict[str, Any]:
    if not isinstance(workspace_ref, str) or not workspace_ref:
        fail("INVALID_ARGUMENT", "workspace must be a non-empty string")
    if len(workspace_ref) > 128:
        fail("INVALID_ARGUMENT", "workspace must be at most 128 characters")
    check_id(workspace_ref, "workspace")
    return snapshot.load_workspace_registration(state, workspace_ref)


def _bundle_or_fail(state: Any, workspace_ref: str, snapshot_ref: Any) -> Dict[str, Any]:
    if not isinstance(snapshot_ref, str) or not snapshot_ref:
        fail("INVALID_ARGUMENT", "snapshot must be a non-empty string")
    if len(snapshot_ref) > 128:
        fail("INVALID_ARGUMENT", "snapshot must be at most 128 characters")
    bundle = snapshot.load_snapshot_bundle(state, workspace_ref, snapshot_ref)
    if bundle.get("freshness") == "unknown" or not isinstance(bundle.get("graph"), dict):
        fail(
            "STALE_SNAPSHOT",
            "snapshot files are missing or unreadable; re-import the snapshot before querying",
            details={"snapshot_ref": snapshot_ref},
        )
    return bundle


def _bundle_repo_id(bundle: Dict[str, Any]) -> Optional[str]:
    value = bundle.get("repo_id")
    return value if isinstance(value, str) and value else None


def _snapshot_block(bundle: Dict[str, Any]) -> Dict[str, Any]:
    manifest = bundle.get("manifest") if isinstance(bundle.get("manifest"), dict) else {}
    import_record = bundle.get("import") if isinstance(bundle.get("import"), dict) else {}
    return {
        "workspace_id": bundle.get("workspace_id"),
        "snapshot_id": bundle.get("snapshot_id"),
        "variant_id": bundle.get("variant_id"),
        "repo_id": bundle.get("repo_id"),
        "status": "verified",
        "freshness": bundle.get("freshness", "unknown"),
        "tool_version": manifest.get("tool_version"),
        "atlas_schema": atlas.ATLAS_SCHEMA_VERSION,
        "graph_sha256": bundle.get("graph_sha256"),
        "manifest_sha256": bundle.get("manifest_sha256"),
        "imported_at": import_record.get("imported_at"),
        "coverage": bundle.get("coverage") or {},
        "capabilities": bundle.get("capabilities") or {},
        "limitations": list(bundle.get("limitations") or []),
    }


def _snapshot_gaps(bundle: Dict[str, Any]) -> List[Dict[str, Any]]:
    gaps: List[Dict[str, Any]] = []
    if bundle.get("freshness") == "stale":
        gaps.append(
            {
                "code": "snapshot_stale",
                "status": "stale",
                "reason": "the registered workspace changed after this snapshot was imported; re-import it before trusting exact edges",
            }
        )
    return gaps


# ---------------------------------------------------------------------------
# repository-relative path mapping
# ---------------------------------------------------------------------------
def _looks_absolute(text: str) -> bool:
    return (
        bool(_DRIVE_RE.match(text))
        or text.startswith("//")
        or bool(_ABS_UNIX_RE.match(text))
        or os.path.isabs(text)
    )


def _relative_within(candidate_text: str, root: Optional[Path]) -> Optional[str]:
    """Return the POSIX relative path of ``candidate_text`` inside ``root``.

    Windows comparison is case-insensitive (``os.path.normcase``), separators
    are normalized, and paths that are not strictly below the root return
    ``None`` so an absolute graph path can never leak into the payload.
    """
    if root is None:
        return None
    try:
        root_abs = os.path.abspath(os.path.normpath(str(root)))
        candidate_abs = os.path.abspath(os.path.normpath(candidate_text))
    except (OSError, ValueError):
        return None
    root_key = os.path.normcase(root_abs)
    candidate_key = os.path.normcase(candidate_abs)
    if candidate_key == root_key:
        return None
    try:
        common = os.path.commonpath([candidate_key, root_key])
    except ValueError:
        return None
    if common != root_key:
        return None
    relative = os.path.relpath(candidate_abs, root_abs).replace("\\", "/")
    if relative in ("", ".", "..") or relative.startswith("../"):
        return None
    try:
        return safe_relative_path(relative, "repository-relative file path")
    except CodeLearningError:
        return None


def _repo_roots(state: Any, workspace: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Map ``repo_id`` to the registered repository root (never emitted).

    Each entry may also carry ``foreign_roots`` from the bootstrap
    ``path_aliases``: analyzed roots recorded by the machine that built the
    Atlas snapshot.  They are only used to relativize graph/evidence paths; all
    local reads still happen under the registered local root.
    """
    roots: Dict[str, Dict[str, Any]] = {}
    try:
        aliases_by_root = state.candidate_root_aliases()
    except AttributeError:
        aliases_by_root = {}
    for repository in workspace.get("repositories") or []:
        if not isinstance(repository, dict):
            continue
        repo_id = repository.get("repo_id")
        if not isinstance(repo_id, str) or not repo_id:
            continue
        relative = repository.get("relative_path")
        root: Optional[Path] = None
        root_ref = repository.get("root_ref")
        if isinstance(root_ref, str) and isinstance(relative, str) and relative:
            try:
                base = state.resolve_root(root_ref)
            except CodeLearningError:
                base = None
            if base is not None:
                root = Path(os.path.normpath(os.path.join(str(base), *relative.split("/"))))
        if root is None:
            stored = repository.get("absolute_path")
            if isinstance(stored, str) and stored:
                root = Path(stored)
        foreign_roots = [
            Path(alias)
            for alias in (aliases_by_root.get(root_ref) if isinstance(root_ref, str) else None) or []
            if isinstance(alias, str) and alias
        ]
        roots[repo_id] = {
            "root": root,
            "relative_path": relative if isinstance(relative, str) else "",
            "foreign_roots": foreign_roots,
        }
    return roots


def _map_file(
    roots: Dict[str, Dict[str, Any]], prefer_repo_id: Optional[str], raw_file: Any
) -> Tuple[Optional[str], Optional[str]]:
    """Map one graph-provided file value to ``(repo_relative_path, repo_id)``.

    Real Atlas graph/evidence records carry absolute analyzed paths; synthetic
    fixtures sometimes carry workspace-root-relative paths
    (``<repo_relative_path>/src/file.c``).  Absolute values are relativized
    against the registered roots; relative values are stripped of a matching
    registered repository prefix.  Anything unmappable returns ``(None, None)``
    and the caller reports ``path_unresolved``.
    """
    if not isinstance(raw_file, str) or not raw_file:
        return None, None
    text = raw_file.replace("\\", "/")
    ordered = sorted(
        roots.items(), key=lambda item: (item[0] != prefer_repo_id, item[0])
    )
    if _looks_absolute(text):
        for repo_id, info in ordered:
            relative = _relative_within(text, info["root"])
            if relative is not None:
                return relative, repo_id
            for foreign_root in info.get("foreign_roots") or []:
                relative = _relative_within(text, foreign_root)
                if relative is not None:
                    return relative, repo_id
        return None, None
    for repo_id, info in ordered:
        prefix = info["relative_path"].strip("/")
        if prefix and text.startswith(prefix + "/"):
            remainder = text[len(prefix) + 1 :]
            try:
                return safe_relative_path(remainder, "repository-relative file path"), repo_id
            except CodeLearningError:
                continue
    candidate = text.lstrip("/")
    try:
        return safe_relative_path(candidate, "repository-relative file path"), prefer_repo_id
    except CodeLearningError:
        return None, None


def _evidence_location(
    evidence_index: Dict[str, Dict[str, Any]], evidence_ids: Any
) -> Tuple[Optional[str], Optional[int]]:
    """Location of the evidence with the smallest ``start`` among ``evidence_ids``."""
    candidates: List[Tuple[int, int, str]] = []
    for evidence_id in _string_list(evidence_ids):
        entity = evidence_index.get(evidence_id)
        if not isinstance(entity, dict):
            continue
        file_value = entity.get("file")
        line = entity.get("line")
        if not isinstance(file_value, str) or not file_value:
            continue
        if not isinstance(line, int) or isinstance(line, bool):
            continue
        start = entity.get("start")
        order = start if isinstance(start, int) and not isinstance(start, bool) else 1 << 60
        candidates.append((order, line, file_value))
    if not candidates:
        return None, None
    candidates.sort(key=lambda item: (item[0], item[1], item[2]))
    return candidates[0][2], candidates[0][1]


def _function_projection(
    graph: Dict[str, Any],
    function: Optional[Dict[str, Any]],
    evidence_index: Dict[str, Dict[str, Any]],
    roots: Dict[str, Dict[str, Any]],
    repo_id: Optional[str],
) -> Dict[str, Any]:
    """``{entry_id,name,file,line}`` projection used by call edges and owners."""
    if not isinstance(function, dict):
        return {"entry_id": None, "name": None, "file": None, "line": None}
    function_id = function.get("id")
    raw_file, line = atlas.function_location(graph, function, evidence_index)
    relative, _file_repo = _map_file(roots, repo_id, raw_file)
    return {
        "entry_id": function_id if isinstance(function_id, str) else None,
        "name": _bounded_text(function.get("name")),
        "file": relative,
        "line": _optional_int(line),
    }


# ---------------------------------------------------------------------------
# view-snapshots
# ---------------------------------------------------------------------------
def _workspace_semantic_status(workspace: Dict[str, Any]) -> str:
    variants = [item for item in workspace.get("variants") or [] if isinstance(item, dict)]
    if any(variant.get("semantic_status") == "ready" for variant in variants):
        return "semantic"
    if any(variant.get("analysis_mode") == "semantic" for variant in variants):
        return "semantic"
    if variants:
        return "source_only"
    return "unknown"


def _snapshot_item_fields(entry: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "snapshot_id": entry.get("snapshot_id"),
        "variant_id": entry.get("variant_id"),
        "repo_id": entry.get("repo_id"),
        "graph_sha256": entry.get("graph_sha256"),
        "manifest_sha256": entry.get("manifest_sha256"),
        "tool_version": entry.get("tool_version"),
    }


def _invalid_snapshot_item(
    entry: Dict[str, Any], code: str, message: str, freshness: str = "unknown"
) -> Dict[str, Any]:
    item = _snapshot_item_fields(entry)
    item.update(
        {
            "status": "invalid",
            "freshness": freshness,
            "atlas_schema": atlas.ATLAS_SCHEMA_VERSION,
            "imported_at": None,
            "entry_count": None,
            "coverage": None,
            "capabilities": {},
            "limitations": [],
            "error": {"code": code, "message": message},
        }
    )
    return item


def _verified_snapshot_item(entry: Dict[str, Any], bundle: Dict[str, Any]) -> Dict[str, Any]:
    item = _snapshot_item_fields(entry)
    coverage = bundle.get("coverage") if isinstance(bundle.get("coverage"), dict) else {}
    failed = coverage.get("failed") if isinstance(coverage.get("failed"), list) else []
    pending = (
        coverage.get("pending_units")
        if isinstance(coverage.get("pending_units"), list)
        else []
    )
    whole = coverage.get("whole_program_complete")
    manifest = bundle.get("manifest") if isinstance(bundle.get("manifest"), dict) else {}
    import_record = bundle.get("import") if isinstance(bundle.get("import"), dict) else {}
    graph = bundle.get("graph") if isinstance(bundle.get("graph"), dict) else {}
    functions = graph.get("functions") if isinstance(graph.get("functions"), list) else []
    item.update(
        {
            "status": "verified",
            "freshness": bundle.get("freshness", "unknown"),
            "graph_sha256": bundle.get("graph_sha256") or item["graph_sha256"],
            "manifest_sha256": bundle.get("manifest_sha256") or item["manifest_sha256"],
            "tool_version": manifest.get("tool_version") or item["tool_version"],
            "atlas_schema": atlas.ATLAS_SCHEMA_VERSION,
            "imported_at": import_record.get("imported_at"),
            "entry_count": len(functions),
            "coverage": {
                "failed_count": len(failed),
                "pending_count": len(pending),
                "whole_program_complete": whole if isinstance(whole, bool) else False,
            },
            "capabilities": bundle.get("capabilities") or {},
            "limitations": list(bundle.get("limitations") or []),
            "error": None,
        }
    )
    return item


def list_snapshots(state: Any) -> Dict[str, Any]:
    """All registered workspaces with every imported snapshot re-verified."""
    index = state.snapshots_index()
    index_entries = [
        entry for entry in index.get("entries") or [] if isinstance(entry, dict)
    ]
    cache: Dict[str, Tuple[Optional[Dict[str, Any]], Optional[CodeLearningError]]] = {}
    workspaces: List[Dict[str, Any]] = []
    gaps: List[Dict[str, Any]] = []
    snapshot_total = 0

    def bundle_for(workspace_ref: str, snapshot_id: str) -> Tuple[Optional[Dict[str, Any]], Optional[CodeLearningError]]:
        cached = cache.get(snapshot_id)
        if cached is None:
            try:
                cached = (snapshot.load_snapshot_bundle(state, workspace_ref, snapshot_id), None)
            except CodeLearningError as error:
                cached = (None, error)
            cache[snapshot_id] = cached
        return cached

    for workspace_dir in state.list_workspaces():
        workspace_id = workspace_dir
        try:
            workspace = snapshot.load_workspace_registration(state, workspace_dir)
        except CodeLearningError as error:
            gaps.append(
                {
                    "code": "workspace_unavailable",
                    "status": "unavailable",
                    "reason": error.code,
                }
            )
            snapshots = [
                _invalid_snapshot_item(
                    entry,
                    "UNSUPPORTED_SCHEMA",
                    "workspace registration is not usable; the imported snapshot cannot be re-verified",
                )
                for entry in index_entries
                if entry.get("workspace_id") == workspace_id
            ]
            snapshot_total += len(snapshots)
            workspaces.append(
                {
                    "workspace_id": workspace_id,
                    "revision": None,
                    "semantic_status": "unknown",
                    "repositories": [],
                    "variants": [],
                    "snapshots": snapshots,
                }
            )
            continue

        workspace_id = workspace.get("workspace_id", workspace_dir)
        snapshots = []
        for entry in index_entries:
            if entry.get("workspace_id") != workspace_id:
                continue
            snapshot_id = entry.get("snapshot_id")
            if not isinstance(snapshot_id, str) or not snapshot_id:
                snapshots.append(
                    _invalid_snapshot_item(
                        entry,
                        "UNSUPPORTED_SCHEMA",
                        "snapshot index entry has no usable snapshot_id",
                    )
                )
                snapshot_total += 1
                continue
            bundle, error = bundle_for(workspace_id, snapshot_id)
            if error is not None:
                snapshots.append(
                    _invalid_snapshot_item(entry, error.code, error.message)
                )
            elif bundle is None or bundle.get("missing_files"):
                missing = ", ".join((bundle or {}).get("missing_files") or [])
                snapshots.append(
                    _invalid_snapshot_item(
                        entry,
                        "NOT_FOUND",
                        "snapshot files are missing"
                        + (f": {missing}" if missing else ""),
                    )
                )
            elif not isinstance(bundle.get("graph"), dict):
                snapshots.append(
                    _invalid_snapshot_item(
                        entry,
                        "STALE_SNAPSHOT",
                        "snapshot files are no longer valid Atlas JSON",
                    )
                )
            else:
                snapshots.append(_verified_snapshot_item(entry, bundle))
            snapshot_total += 1

        workspaces.append(
            {
                "workspace_id": workspace_id,
                "revision": workspace.get("revision"),
                "semantic_status": _workspace_semantic_status(workspace),
                "repositories": [
                    {
                        "repo_id": repository.get("repo_id"),
                        "role": repository.get("role"),
                        "root_ref": repository.get("root_ref"),
                        "relative_path": repository.get("relative_path"),
                    }
                    for repository in workspace.get("repositories") or []
                    if isinstance(repository, dict)
                ],
                "variants": [
                    {
                        "variant_id": variant.get("variant_id"),
                        "analysis_mode": variant.get("analysis_mode"),
                    }
                    for variant in workspace.get("variants") or []
                    if isinstance(variant, dict)
                ],
                "snapshots": snapshots,
            }
        )

    if not workspaces:
        gaps.append(
            {
                "code": "workspace",
                "status": "unavailable",
                "reason": "no_registered_workspace",
            }
        )
    if snapshot_total == 0:
        gaps.append(
            {
                "code": "snapshot",
                "status": "unavailable",
                "reason": "no_imported_snapshot_for_any_registered_workspace",
            }
        )
    return {
        "schema_version": SCHEMA_VERSION,
        "host": {
            "engine": "code-learning",
            "scope_ref": state.scope_ref,
            "scope_generation": state.scope_generation,
            "profile_ref": state.bootstrap.get("profile_ref"),
        },
        "workspaces": workspaces,
        "gaps": gaps,
    }


# ---------------------------------------------------------------------------
# shared adjacency / resource-layer helpers
# ---------------------------------------------------------------------------
def _call_adjacency(
    graph: Dict[str, Any]
) -> Tuple[Dict[str, List[Dict[str, Any]]], Dict[str, List[Dict[str, Any]]]]:
    outgoing: Dict[str, List[Dict[str, Any]]] = {}
    incoming: Dict[str, List[Dict[str, Any]]] = {}
    for target in graph.get("call_targets") or []:
        if not isinstance(target, dict):
            continue
        source_id = target.get("source")
        target_id = target.get("target")
        if not isinstance(source_id, str) or not isinstance(target_id, str):
            continue
        outgoing.setdefault(source_id, []).append(target)
        incoming.setdefault(target_id, []).append(target)
    return outgoing, incoming


def _has_resource_layer(graph: Dict[str, Any]) -> bool:
    objects = graph.get("objects")
    accesses = graph.get("field_accesses")
    return bool(isinstance(objects, list) and objects) or bool(
        isinstance(accesses, list) and accesses
    )


def _selection(
    workspace: Dict[str, Any],
    bundle: Dict[str, Any],
    function: Optional[Dict[str, Any]] = None,
    *,
    resource_ids: Optional[Sequence[str]] = None,
    resource_status: str = "unavailable",
    evidence_ids: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    symbol_id = None
    entry_id = None
    if isinstance(function, dict):
        entry_id = function.get("id") if isinstance(function.get("id"), str) else None
        symbol_id = (
            function.get("base_id")
            if isinstance(function.get("base_id"), str) and function.get("base_id")
            else None
        )
    return {
        "workspace_id": workspace.get("workspace_id"),
        "variant_id": bundle.get("variant_id"),
        "snapshot_id": bundle.get("snapshot_id"),
        "repo_id": bundle.get("repo_id"),
        "entry_id": entry_id,
        "symbol_id": symbol_id,
        "callsite_ids": [],
        "callsite_path": [],
        "resource_ids": list(dict.fromkeys(resource_ids or [])),
        "resource_status": resource_status,
        "evidence_ids": list(dict.fromkeys(evidence_ids or [])),
        "run_id": None,
        "event_id": None,
    }


# ---------------------------------------------------------------------------
# view-entries
# ---------------------------------------------------------------------------
def _entry_sort_key(item: Dict[str, Any]) -> Tuple[Any, ...]:
    file_value = item.get("file")
    line_value = item.get("line")
    return (
        0 if item.get("is_entry") else 1,
        file_value if isinstance(file_value, str) else "\uffff",
        line_value if isinstance(line_value, int) else 1 << 60,
        item.get("name") or "",
    )


def _entry_row(
    graph: Dict[str, Any],
    function: Dict[str, Any],
    evidence_index: Dict[str, Dict[str, Any]],
    roots: Dict[str, Dict[str, Any]],
    repo_id: Optional[str],
    incoming: Dict[str, int],
    outgoing: Dict[str, int],
) -> Dict[str, Any]:
    function_id = function.get("id")
    raw_file, line = atlas.function_location(graph, function, evidence_index)
    relative, _file_repo = _map_file(roots, repo_id, raw_file)
    symbol_id = function.get("base_id")
    storage = function.get("storage")
    return {
        "entry_id": function_id,
        "symbol_id": symbol_id if isinstance(symbol_id, str) and symbol_id else None,
        "name": _bounded_text(function.get("name")),
        "display_name": _bounded_text(function.get("display_name")),
        "kind": function.get("kind") if isinstance(function.get("kind"), str) else "function",
        "storage": storage if isinstance(storage, str) and storage else "unknown",
        "signature": _bounded_text(function.get("signature")),
        "file": relative,
        "line": _optional_int(line),
        "is_entry": function_id not in incoming,
        "callers": incoming.get(function_id, 0) if isinstance(function_id, str) else 0,
        "callees": outgoing.get(function_id, 0) if isinstance(function_id, str) else 0,
        "file_status": "ok" if relative is not None else "path_unresolved",
    }


def list_entries(
    state: Any, workspace_ref: Any, snapshot_ref: Any
) -> Dict[str, Any]:
    """Entry/function list for one verified snapshot."""
    workspace = _workspace_or_fail(state, workspace_ref)
    bundle = _bundle_or_fail(state, workspace["workspace_id"], snapshot_ref)
    graph = bundle["graph"]
    evidence_index = atlas.evidence_by_id(graph)
    functions = atlas.functions_of(graph)
    roots = _repo_roots(state, workspace)
    repo_id = _bundle_repo_id(bundle)
    outgoing, incoming = _call_adjacency(graph)
    incoming_counts = _counts(incoming)
    outgoing_counts = _counts(outgoing)

    rows = [
        _entry_row(
            graph,
            function,
            evidence_index,
            roots,
            repo_id,
            incoming_counts,
            outgoing_counts,
        )
        for function in functions
    ]
    rows.sort(key=_entry_sort_key)
    truncated = len(rows) > MAX_ENTRIES
    rows = rows[:MAX_ENTRIES]

    gaps = _snapshot_gaps(bundle)
    if not _has_resource_layer(graph):
        gaps.append(
            {
                "code": "resource_graph",
                "status": "unavailable",
                "reason": "atlas_snapshot_has_no_resource_layer",
            }
        )
    unresolved = sum(1 for row in rows if row["file"] is None)
    if unresolved:
        gaps.append(
            {
                "code": "path_unresolved",
                "status": "degraded",
                "reason": (
                    f"{unresolved} function location(s) could not be mapped to a "
                    "registered repository root"
                ),
            }
        )

    return {
        "schema_version": SCHEMA_VERSION,
        "snapshot": _snapshot_block(bundle),
        "selection": _selection(workspace, bundle),
        "entries": rows,
        "external_nodes": [],
        "gaps": gaps,
        "truncated": truncated,
    }


# ---------------------------------------------------------------------------
# view-entry: call edges, evidence, source
# ---------------------------------------------------------------------------
def _callsites_by_id(graph: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {
        site["id"]: site
        for site in graph.get("callsites") or []
        if isinstance(site, dict) and isinstance(site.get("id"), str)
    }


def _callsite_projection(
    site: Optional[Dict[str, Any]],
    evidence_index: Dict[str, Dict[str, Any]],
    roots: Dict[str, Dict[str, Any]],
    repo_id: Optional[str],
) -> Dict[str, Any]:
    if not isinstance(site, dict):
        return {"file": None, "line": None, "expression": None}
    raw_file = site.get("file")
    line: Optional[int] = _optional_int(site.get("line"))
    if not isinstance(raw_file, str) or not raw_file:
        raw_file, line = _evidence_location(evidence_index, site.get("evidence_ids"))
    relative, _file_repo = _map_file(roots, repo_id, raw_file)
    expression = _bounded_text(site.get("expression"), MAX_EXPRESSION)
    return {"file": relative, "line": line, "expression": expression}


def _edge_item(
    edge: Dict[str, Any],
    other_function_id: Any,
    functions: Dict[str, Dict[str, Any]],
    callsites: Dict[str, Dict[str, Any]],
    evidence_index: Dict[str, Dict[str, Any]],
    roots: Dict[str, Dict[str, Any]],
    repo_id: Optional[str],
    graph: Dict[str, Any],
) -> Dict[str, Any]:
    callsite_id = edge.get("callsite")
    site = callsites.get(callsite_id) if isinstance(callsite_id, str) else None
    other = functions.get(other_function_id) if isinstance(other_function_id, str) else None
    certainty = edge.get("certainty")
    origin = edge.get("origin")
    return {
        "edge_id": edge.get("id") if isinstance(edge.get("id"), str) else None,
        "callsite_id": callsite_id if isinstance(callsite_id, str) else None,
        "callsite": _callsite_projection(site, evidence_index, roots, repo_id),
        "target": _function_projection(graph, other, evidence_index, roots, repo_id),
        "certainty": certainty if certainty in CERTAINTY_VALUES else "unknown",
        "origin": origin if isinstance(origin, str) and origin else "unknown",
        "evidence_ids": _string_list(edge.get("evidence_ids")),
        "limitations": _string_list(edge.get("limitations")),
    }


def _project_edges(
    edges: Sequence[Dict[str, Any]],
    direction: str,
    functions: Dict[str, Dict[str, Any]],
    callsites: Dict[str, Dict[str, Any]],
    evidence_index: Dict[str, Dict[str, Any]],
    roots: Dict[str, Dict[str, Any]],
    repo_id: Optional[str],
    graph: Dict[str, Any],
) -> Tuple[List[Dict[str, Any]], bool]:
    items: List[Dict[str, Any]] = []
    for edge in edges:
        other = edge.get("target") if direction == "calls" else edge.get("source")
        items.append(
            _edge_item(
                edge,
                other,
                functions,
                callsites,
                evidence_index,
                roots,
                repo_id,
                graph,
            )
        )
    truncated = len(items) > MAX_EDGES
    return items[:MAX_EDGES], truncated


def _project_evidence(
    evidence_index: Dict[str, Dict[str, Any]],
    roots: Dict[str, Dict[str, Any]],
    repo_id: Optional[str],
    evidence_ids: Iterable[str],
) -> Tuple[List[Dict[str, Any]], bool]:
    items: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    for evidence_id in evidence_ids:
        if not isinstance(evidence_id, str) or not evidence_id or evidence_id in seen:
            continue
        seen.add(evidence_id)
        entity = evidence_index.get(evidence_id)
        if not isinstance(entity, dict):
            items.append(
                {
                    "evidence_id": evidence_id,
                    "kind": "unknown",
                    "file": None,
                    "line": None,
                    "text": None,
                    "truncated": False,
                }
            )
            continue
        raw_file = entity.get("file")
        relative, _file_repo = _map_file(roots, repo_id, raw_file)
        text = entity.get("text")
        bounded = _bounded_text(text, MAX_EVIDENCE_TEXT) if text is not None else None
        items.append(
            {
                "evidence_id": evidence_id,
                "kind": (
                    entity.get("kind")
                    if isinstance(entity.get("kind"), str) and entity.get("kind")
                    else "unknown"
                ),
                "file": relative,
                "line": _optional_int(entity.get("line")),
                "text": bounded,
                "truncated": bool(isinstance(text, str) and len(text) > MAX_EVIDENCE_TEXT),
            }
        )
    truncated = len(items) > MAX_EVIDENCE_ITEMS
    return items[:MAX_EVIDENCE_ITEMS], truncated


def _definition_evidence(
    function: Dict[str, Any], evidence_index: Dict[str, Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    """The function definition evidence with the smallest ``start`` byte offset."""
    candidates: List[Tuple[int, str, Dict[str, Any]]] = []
    for evidence_id in _string_list(function.get("evidence_ids")):
        entity = evidence_index.get(evidence_id)
        if not isinstance(entity, dict):
            continue
        start = entity.get("start")
        if isinstance(start, bool) or not isinstance(start, int):
            continue
        candidates.append((start, evidence_id, entity))
    if not candidates:
        return None
    candidates.sort(key=lambda item: (item[0], item[1]))
    return candidates[0][2]


def _window_lines(text: str) -> List[str]:
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return [line.rstrip("\r") for line in lines]


def _empty_source(
    *, path: Optional[str] = None, sha256: Optional[str] = None, reason: Optional[str] = None
) -> Dict[str, Any]:
    return {
        "status": "unavailable",
        "path": path,
        "sha256": sha256,
        "path_ref": None,
        "evidence_ref": None,
        "byte_start": None,
        "byte_end": None,
        "line_start": None,
        "line_end": None,
        "lines": [],
        "highlight": None,
        "truncated": False,
        "reason": reason,
    }


def _project_source(
    state: Any,
    workspace: Dict[str, Any],
    bundle: Dict[str, Any],
    function: Dict[str, Any],
    evidence_index: Dict[str, Dict[str, Any]],
    roots: Dict[str, Dict[str, Any]],
    repo_id: Optional[str],
) -> Dict[str, Any]:
    """Read the definition evidence byte window through the signed source path."""
    entity = _definition_evidence(function, evidence_index)
    if entity is None:
        return _empty_source(reason="definition_evidence_missing")
    raw_file = entity.get("file")
    start = _optional_int(entity.get("start"))
    end = _optional_int(entity.get("end"))
    expected_sha = entity.get("hash")
    relative, file_repo = _map_file(roots, repo_id, raw_file)
    if relative is None:
        return _empty_source(reason="path_unresolved")
    if start is None or end is None or start < 0 or end <= start:
        return _empty_source(path=relative, reason="definition_evidence_interval_unavailable")
    if not isinstance(expected_sha, str) or not re.match(r"^[0-9a-f]{64}$", expected_sha):
        return _empty_source(path=relative, reason="definition_evidence_hash_unavailable")
    if file_repo is None:
        file_repo = repo_id
    clamped_end = min(end, start + MAX_SOURCE_BYTES)
    byte_truncated = clamped_end < end
    try:
        interval = source._read_interval(
            state, workspace, file_repo, relative, expected_sha, start, clamped_end
        )
    except CodeLearningError as error:
        result = _empty_source(path=relative, sha256=expected_sha, reason=error.code)
        return result
    if interval.get("outcome") != "text" or not isinstance(interval.get("text"), str):
        result = _empty_source(
            path=relative,
            sha256=interval.get("sha") or expected_sha,
            reason=interval.get("reason") or "binary",
        )
        return result

    text = interval["text"]
    actual_start = interval["actual_start"]
    actual_end = interval["actual_end"]
    line_start = interval["line_start"]
    line_end = interval["line_end"]
    lines = _window_lines(text)
    line_truncated = len(lines) > MAX_SOURCE_LINES
    if line_truncated:
        lines = lines[:MAX_SOURCE_LINES]
        consumed = sum(len(line.encode("utf-8")) + 1 for line in lines)
        final_end = actual_start + consumed
        final_line_end = line_start + len(lines) - 1
    else:
        final_end = actual_end
        final_line_end = line_end

    observed_at = utc_now_iso()
    variant_id = bundle.get("variant_id")
    try:
        path_ref = scope.sign_path_ref(
            state,
            workspace_id=workspace["workspace_id"],
            repo_id=file_repo,
            relative_path=relative,
            source_sha256=interval["sha"],
        )
        evidence_ref = scope.sign_evidence_ref(
            state,
            workspace_id=workspace["workspace_id"],
            repo_id=file_repo,
            variant_id=variant_id,
            relative_path=relative,
            source_sha256=interval["sha"],
            byte_start=actual_start,
            byte_end=final_end,
            line_start=line_start,
            line_end=final_line_end,
            observed_at=observed_at,
        )
    except CodeLearningError as error:  # e.g. a malformed index variant_id
        return _empty_source(
            path=relative, sha256=interval.get("sha") or expected_sha, reason=error.code
        )

    return {
        "status": "ok",
        "path": relative,
        "sha256": interval["sha"],
        "path_ref": path_ref,
        "evidence_ref": evidence_ref,
        "byte_start": actual_start,
        "byte_end": final_end,
        "line_start": line_start,
        "line_end": final_line_end,
        "lines": [
            {"n": line_start + index, "text": line}
            for index, line in enumerate(lines)
        ],
        "highlight": {"line_start": line_start, "line_end": final_line_end},
        "truncated": bool(byte_truncated or line_truncated),
        "reason": None,
    }


# ---------------------------------------------------------------------------
# view-entry: resource projection (objects / field_accesses)
# ---------------------------------------------------------------------------
def _object_projection(
    graph: Dict[str, Any],
    entity: Optional[Dict[str, Any]],
    resource_id: str,
    evidence_index: Dict[str, Dict[str, Any]],
    roots: Dict[str, Dict[str, Any]],
    repo_id: Optional[str],
) -> Dict[str, Any]:
    if not isinstance(entity, dict):
        return {
            "resource_id": resource_id,
            "name": None,
            "type": None,
            "storage": None,
            "lifetime": None,
            "file": None,
            "line": None,
            "evidence_ids": [],
        }
    raw_file, line = atlas.function_location(graph, entity, evidence_index)
    relative, _file_repo = _map_file(roots, repo_id, raw_file)
    return {
        "resource_id": resource_id,
        "name": _bounded_text(entity.get("name"), 512),
        "type": _bounded_text(entity.get("type"), 512),
        "storage": _bounded_text(entity.get("storage"), 64),
        "lifetime": _bounded_text(entity.get("lifetime"), 64),
        "file": relative,
        "line": _optional_int(line),
        "evidence_ids": _string_list(entity.get("evidence_ids")),
    }


def _project_resources(
    graph: Dict[str, Any],
    function: Dict[str, Any],
    neighbors: Set[str],
    functions: Dict[str, Dict[str, Any]],
    evidence_index: Dict[str, Dict[str, Any]],
    roots: Dict[str, Dict[str, Any]],
    repo_id: Optional[str],
) -> Tuple[Dict[str, Any], List[str], str]:
    """Project field accesses owned by the entry or a one-hop direct neighbor."""
    entry_id = function.get("id") if isinstance(function.get("id"), str) else ""
    allowed_owners = {entry_id} | {item for item in neighbors if isinstance(item, str)}
    object_by_id = {
        entity["id"]: entity
        for entity in graph.get("objects") or []
        if isinstance(entity, dict) and isinstance(entity.get("id"), str)
    }
    accesses = [
        access
        for access in graph.get("field_accesses") or []
        if isinstance(access, dict)
        and isinstance(access.get("owner"), str)
        and access.get("owner") in allowed_owners
    ]
    accesses.sort(key=lambda item: (item.get("owner") or "", item.get("id") or ""))
    truncated = len(accesses) > MAX_FIELD_ACCESSES
    accesses = accesses[:MAX_FIELD_ACCESSES]

    object_order: List[str] = []
    seen_objects: Set[str] = set()
    for access in accesses:
        for object_id in _string_list(access.get("object_ids")):
            if object_id not in seen_objects:
                seen_objects.add(object_id)
                object_order.append(object_id)

    objects: List[Dict[str, Any]] = []
    unresolved_object_paths = 0
    unresolved_object_candidates = 0
    for object_id in object_order:
        entity = object_by_id.get(object_id)
        if entity is None:
            # Real Atlas field accesses may reference a *candidate* base object
            # id that is not part of ``graph.objects`` (see the
            # ``unresolved_or_multiple_base_objects`` limitation).  It is not a
            # projected resource; report the projection gap instead of
            # pretending it is an object with unknown fields.
            unresolved_object_candidates += 1
            continue
        item = _object_projection(
            graph, entity, object_id, evidence_index, roots, repo_id
        )
        if item["file"] is None:
            unresolved_object_paths += 1
        objects.append(item)

    field_accesses: List[Dict[str, Any]] = []
    access_certainties: Set[str] = set()
    unresolved_access_paths = 0
    for access in accesses:
        object_ids = _string_list(access.get("object_ids"))
        object_names = [
            object_by_id[object_id].get("name")
            for object_id in object_ids
            if object_id in object_by_id and isinstance(object_by_id[object_id].get("name"), str)
        ]
        owner_id = access.get("owner")
        owner = functions.get(owner_id) if isinstance(owner_id, str) else None
        raw_file, line = _evidence_location(evidence_index, access.get("evidence_ids"))
        relative, _file_repo = _map_file(roots, repo_id, raw_file)
        if relative is None:
            unresolved_access_paths += 1
        access_value = access.get("access")
        limitations = _string_list(access.get("limitations"))
        if access_value not in ACCESS_VALUES:
            access_value = "unknown"
            limitations = limitations + ["access_value_outside_contract_enum"]
        certainty = access.get("certainty")
        if certainty not in CERTAINTY_VALUES:
            certainty = "unknown"
        access_certainties.add(certainty)
        field_accesses.append(
            {
                "access_id": access.get("id") if isinstance(access.get("id"), str) else None,
                "object_ids": object_ids,
                "object_names": object_names,
                "field_name": _bounded_text(access.get("field_name"), 256),
                "field_path": _string_list(access.get("field_path")),
                "expression": _bounded_text(access.get("expression"), MAX_EXPRESSION),
                "access": access_value,
                "certainty": certainty,
                "owner": _function_projection(graph, owner, evidence_index, roots, repo_id),
                "location": {"file": relative, "line": _optional_int(line)},
                "evidence_ids": _string_list(access.get("evidence_ids")),
                "limitations": list(dict.fromkeys(limitations)),
            }
        )

    resource_gaps: List[Dict[str, Any]] = []
    if not field_accesses:
        status = "unavailable"
        reason = (
            "atlas_snapshot_has_no_resource_layer"
            if not _has_resource_layer(graph)
            else "no_field_access_for_this_entry_or_its_direct_neighbors"
        )
    else:
        status = "ready" if access_certainties == {"exact"} else "partial"
        reason = None
    if unresolved_object_candidates:
        resource_gaps.append(
            {
                "code": "resource_object_unresolved",
                "status": "degraded",
                "reason": (
                    f"{unresolved_object_candidates} candidate object id(s) referenced "
                    "by field accesses are not present in the snapshot object layer"
                ),
            }
        )
    if unresolved_object_paths:
        resource_gaps.append(
            {
                "code": "resource_path_unresolved",
                "status": "degraded",
                "reason": (
                    f"{unresolved_object_paths} resource object(s) have no "
                    "repository-relative location"
                ),
            }
        )
    if unresolved_access_paths:
        resource_gaps.append(
            {
                "code": "field_access_location_unresolved",
                "status": "degraded",
                "reason": (
                    f"{unresolved_access_paths} field access location(s) have no "
                    "repository-relative location"
                ),
            }
        )
    return (
        {
            "status": status,
            "reason": reason,
            "objects": objects,
            "field_accesses": field_accesses,
            "gaps": resource_gaps,
            "truncated": truncated,
        },
        [item["resource_id"] for item in objects],
        status,
    )


# ---------------------------------------------------------------------------
# view-entry: public projection
# ---------------------------------------------------------------------------
def _entry_object(
    graph: Dict[str, Any],
    function: Dict[str, Any],
    evidence_index: Dict[str, Dict[str, Any]],
    roots: Dict[str, Dict[str, Any]],
    repo_id: Optional[str],
    incoming: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    function_id = function.get("id")
    raw_file, line = atlas.function_location(graph, function, evidence_index)
    relative, _file_repo = _map_file(roots, repo_id, raw_file)
    symbol_id = function.get("base_id")
    storage = function.get("storage")
    kind = function.get("kind")
    parameters: List[Dict[str, Any]] = []
    for parameter in function.get("parameters") or []:
        if not isinstance(parameter, dict):
            continue
        parameters.append(
            {
                "name": _bounded_text(parameter.get("name"), 256),
                "type": _bounded_text(parameter.get("type"), 512),
            }
        )
    summary_origin = function.get("summary_origin")
    if not isinstance(summary_origin, str) or not summary_origin:
        summary_origin = "missing"
    summary = None
    if summary_origin != "missing":
        summary = _bounded_text(function.get("summary"))
    return {
        "entry_id": function_id,
        "symbol_id": symbol_id if isinstance(symbol_id, str) and symbol_id else None,
        "name": _bounded_text(function.get("name")),
        "display_name": _bounded_text(function.get("display_name")),
        "kind": kind if isinstance(kind, str) and kind else "function",
        "storage": storage if isinstance(storage, str) and storage else "unknown",
        "signature": _bounded_text(function.get("signature")),
        "return_type": _bounded_text(function.get("return_type"), 512),
        "parameters": parameters,
        "file": relative,
        "line": _optional_int(line),
        "is_entry": function_id not in incoming,
        "summary": summary,
        "summary_origin": summary_origin,
    }


def entry_detail(
    state: Any, workspace_ref: Any, snapshot_ref: Any, entry_ref: Any
) -> Dict[str, Any]:
    """One entry with source window, direct call edges, evidence and resources."""
    workspace = _workspace_or_fail(state, workspace_ref)
    bundle = _bundle_or_fail(state, workspace["workspace_id"], snapshot_ref)
    if not isinstance(entry_ref, str) or not entry_ref:
        fail("INVALID_ARGUMENT", "entry must be a non-empty string")
    entry_ref = expect_str(entry_ref, "entry", max_len=512)
    graph = bundle["graph"]
    evidence_index = atlas.evidence_by_id(graph)
    functions = atlas.functions_by_id(graph)
    callsites = _callsites_by_id(graph)
    function = atlas.resolve_function(graph, entry_ref, "entry")
    function_id = function.get("id")
    repo_id = _bundle_repo_id(bundle)
    roots = _repo_roots(state, workspace)
    outgoing, incoming = _call_adjacency(graph)
    out_edges = outgoing.get(function_id, [])
    in_edges = incoming.get(function_id, [])

    calls, calls_truncated = _project_edges(
        out_edges,
        "calls",
        functions,
        callsites,
        evidence_index,
        roots,
        repo_id,
        graph,
    )
    callers, callers_truncated = _project_edges(
        in_edges,
        "callers",
        functions,
        callsites,
        evidence_index,
        roots,
        repo_id,
        graph,
    )
    neighbors = {
        edge.get("source") for edge in in_edges if isinstance(edge.get("source"), str)
    } | {
        edge.get("target") for edge in out_edges if isinstance(edge.get("target"), str)
    }
    entry_object = _entry_object(
        graph, function, evidence_index, roots, repo_id, incoming
    )
    resources, resource_ids, resource_status = _project_resources(
        graph,
        function,
        neighbors,
        functions,
        evidence_index,
        roots,
        repo_id,
    )
    source_projection = _project_source(
        state, workspace, bundle, function, evidence_index, roots, repo_id
    )

    evidence_ids: List[str] = []
    evidence_ids.extend(_string_list(function.get("evidence_ids")))
    for item in calls + callers:
        evidence_ids.extend(item["evidence_ids"])
    for item in resources["field_accesses"]:
        evidence_ids.extend(item["evidence_ids"])
    for item in resources["objects"]:
        evidence_ids.extend(item["evidence_ids"])
    evidence_items, evidence_truncated = _project_evidence(
        evidence_index, roots, repo_id, evidence_ids
    )

    gaps = _snapshot_gaps(bundle)
    if entry_object["file"] is None:
        gaps.append(
            {
                "code": "entry_location_unresolved",
                "status": "degraded",
                "reason": "entry function location could not be mapped to a registered repository root",
            }
        )
    elif entry_object["line"] is None:
        gaps.append(
            {
                "code": "entry_line_unknown",
                "status": "degraded",
                "reason": "entry function has no evidence line in this snapshot",
            }
        )
    if source_projection["status"] != "ok":
        gaps.append(
            {
                "code": "source_unavailable",
                "status": "unavailable",
                "reason": source_projection["reason"] or "unknown_source_failure",
            }
        )
    if resources["status"] == "unavailable":
        gaps.append(
            {
                "code": "resource_graph",
                "status": "unavailable",
                "reason": resources["reason"],
            }
        )
    gaps.extend(resources["gaps"])
    truncated = bool(
        calls_truncated
        or callers_truncated
        or evidence_truncated
        or resources["truncated"]
        or source_projection["truncated"]
    )

    return {
        "schema_version": SCHEMA_VERSION,
        "snapshot": _snapshot_block(bundle),
        "selection": _selection(
            workspace,
            bundle,
            function,
            resource_ids=resource_ids,
            resource_status=resource_status,
            evidence_ids=_string_list(function.get("evidence_ids")),
        ),
        "entry": entry_object,
        "source": source_projection,
        "calls": calls,
        "callers": callers,
        "evidence": evidence_items,
        "resources": resources,
        "coverage": bundle.get("coverage") or {},
        "capabilities": bundle.get("capabilities") or {},
        "limitations": list(bundle.get("limitations") or []),
        "gaps": gaps,
        "truncated": truncated,
    }
