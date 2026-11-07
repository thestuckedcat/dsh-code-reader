"""Read-only validation and projection of SDK Code Atlas 0.1 records.

Atlas keeps ``schema_version='0.1'``; this module never mixes in the engine's
own ``schema_version=1`` objects.  It validates the envelope, the payload
shapes of ``graph``/``analysis_manifest`` records and the cross references
inside a graph (callsites/evidence/function ids).  It does not execute Atlas,
does not contact the network and never rewrites Atlas facts.

Coverage semantics are preserved verbatim: ``failed`` stays an array of TU
objects and ``pending_units`` an array of repository-relative paths; this
module only adds ``failed_count=len(failed)`` so summaries never silently
coerce those arrays into integers.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, Iterable, List, Optional

from .errors import fail

ATLAS_SCHEMA_VERSION = "0.1"
GRAPH_RECORD_KIND = "graph"
MANIFEST_RECORD_KIND = "analysis_manifest"

GRAPH_KEYS = ("functions", "types", "objects", "callsites", "call_targets", "evidence", "issues", "coverage", "scope")
MANIFEST_KEYS = (
    "snapshot_id",
    "analysis_id",
    "input_files",
    "workspace_roots",
    "workspace_revisions",
    "scope",
    "coverage",
    "schema_version",
    "tool_version",
    "graph_hash",
)

CALL_CERTAINTIES = frozenset({"exact", "may"})
FLOW_CERTAINTIES = frozenset({"exact", "may", "unknown"})
UNRESOLVED_ISSUE_KINDS = frozenset({"semantic_unresolved", "external_boundary"})
TRUTHY_CAPABILITY_STATUSES = frozenset({"ready", "available", "supported", "complete"})

_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_MAX_ID = 512
_MAX_TEXT = 4096
_MAX_ENTITIES = 1_000_000
_MAX_COVERAGE_ITEMS = 250_000

#: Hard safety bounds used by bounded projections (not user-facing budgets).
MAX_ISSUE_PROJECTIONS = 100


def _bounded_text(value: Any, where: str, *, max_len: int = _MAX_TEXT) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        fail("UNSUPPORTED_SCHEMA", f"{where} must be a string")
    if len(value) > max_len:
        return value[:max_len]
    return value


def _expect_payload_array(payload: Dict[str, Any], key: str, label: str) -> List[Any]:
    value = payload.get(key)
    if not isinstance(value, list):
        fail("UNSUPPORTED_SCHEMA", f"{label}.{key} must be an array")
    if len(value) > _MAX_ENTITIES:
        fail("LIMIT_EXCEEDED", f"{label}.{key} exceeds the deterministic safety bound")
    return value


def _validate_entity_list(payload: Dict[str, Any], key: str, label: str) -> Dict[str, Dict[str, Any]]:
    entries = _expect_payload_array(payload, key, label)
    by_id: Dict[str, Dict[str, Any]] = {}
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            fail("UNSUPPORTED_SCHEMA", f"{label}.{key}[{index}] must be an object")
        entity_id = entry.get("id")
        if not isinstance(entity_id, str) or not entity_id or len(entity_id) > _MAX_ID:
            fail("UNSUPPORTED_SCHEMA", f"{label}.{key}[{index}].id must be a non-empty string")
        if entity_id in by_id:
            fail("UNSUPPORTED_SCHEMA", f"{label}.{key} contains a duplicate id")
        by_id[entity_id] = entry
    return by_id


# ---------------------------------------------------------------------------
# envelope
# ---------------------------------------------------------------------------
def graph_hash(raw: bytes) -> str:
    """SHA256 over the raw ``graph.json`` bytes (the manifest's graph_hash)."""
    import hashlib

    return hashlib.sha256(raw).hexdigest()


def parse_envelope(raw: bytes, expected_kind: str, label: str = "snapshot record") -> Dict[str, Any]:
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("INVALID_ARGUMENT", f"{label} is not valid UTF-8 JSON")
    return validate_envelope(document, expected_kind, label)


def validate_envelope(document: Any, expected_kind: str, label: str = "snapshot record") -> Dict[str, Any]:
    if not isinstance(document, dict):
        fail("UNSUPPORTED_SCHEMA", f"{label} envelope must be a JSON object")
    schema_version = document.get("schema_version")
    if schema_version != ATLAS_SCHEMA_VERSION:
        fail("UNSUPPORTED_SCHEMA", f"{label} envelope schema_version must be '0.1'")
    record_kind = document.get("record_kind")
    if record_kind != expected_kind:
        fail("UNSUPPORTED_SCHEMA", f"{label} envelope record_kind must be '{expected_kind}'")
    record_id = document.get("record_id")
    if not isinstance(record_id, str) or not record_id or len(record_id) > _MAX_ID:
        fail("UNSUPPORTED_SCHEMA", f"{label} envelope record_id must be a bounded non-empty string")
    payload = document.get("payload")
    if not isinstance(payload, dict):
        fail("UNSUPPORTED_SCHEMA", f"{label} envelope payload must be an object")
    provenance = document.get("provenance")
    if not isinstance(provenance, dict):
        fail("UNSUPPORTED_SCHEMA", f"{label} envelope provenance must be an object")
    return payload


# ---------------------------------------------------------------------------
# graph payload
# ---------------------------------------------------------------------------
def validate_graph_payload(payload: Any, label: str = "graph payload") -> Dict[str, Any]:
    if not isinstance(payload, dict):
        fail("UNSUPPORTED_SCHEMA", f"{label} must be an object")
    for key in GRAPH_KEYS:
        if key not in payload:
            fail("UNSUPPORTED_SCHEMA", f"{label} is missing required field {key}")
    functions = _validate_entity_list(payload, "functions", label)
    _validate_entity_list(payload, "types", label)
    _validate_entity_list(payload, "objects", label)
    callsites = _validate_entity_list(payload, "callsites", label)
    _validate_entity_list(payload, "evidence", label)
    _validate_entity_list(payload, "issues", label)
    if not isinstance(payload.get("coverage"), dict):
        fail("UNSUPPORTED_SCHEMA", f"{label}.coverage must be an object")
    if not isinstance(payload.get("scope"), dict):
        fail("UNSUPPORTED_SCHEMA", f"{label}.scope must be an object")

    call_targets = _expect_payload_array(payload, "call_targets", label)
    seen_target_ids: set = set()
    evidence_ids = {entry["id"] for entry in payload.get("evidence", []) if isinstance(entry, dict)}
    for index, target in enumerate(call_targets):
        where = f"{label}.call_targets[{index}]"
        if not isinstance(target, dict):
            fail("UNSUPPORTED_SCHEMA", f"{where} must be an object")
        for field in ("id", "callsite", "source", "target", "origin"):
            value = target.get(field)
            if not isinstance(value, str) or not value or len(value) > _MAX_ID:
                fail("UNSUPPORTED_SCHEMA", f"{where}.{field} must be a bounded non-empty string")
        target_id = target["id"]
        if target_id in seen_target_ids:
            fail("UNSUPPORTED_SCHEMA", f"{label}.call_targets contains a duplicate id")
        seen_target_ids.add(target_id)
        if target.get("certainty") not in CALL_CERTAINTIES:
            fail("UNSUPPORTED_SCHEMA", f"{where}.certainty must be one of exact|may")
        evidence_refs = target.get("evidence_ids")
        if not isinstance(evidence_refs, list) or not all(
            isinstance(item, str) and item for item in evidence_refs
        ):
            fail("UNSUPPORTED_SCHEMA", f"{where}.evidence_ids must be an array of ids")
        if len(set(evidence_refs)) != len(evidence_refs):
            fail("UNSUPPORTED_SCHEMA", f"{where}.evidence_ids contains duplicates")
        missing_evidence = [item for item in evidence_refs if item not in evidence_ids]
        if missing_evidence:
            fail("UNSUPPORTED_SCHEMA", f"{where}.evidence_ids references unknown evidence")
        if target["callsite"] not in callsites:
            fail("UNSUPPORTED_SCHEMA", f"{where}.callsite references an unknown callsite")
        if target["source"] not in functions:
            fail("UNSUPPORTED_SCHEMA", f"{where}.source references an unknown function")
        if target["target"] not in functions:
            fail("UNSUPPORTED_SCHEMA", f"{where}.target references an unknown function")

    for index, site in enumerate(payload.get("callsites", [])):
        owner = site.get("owner")
        if owner is not None and owner not in functions:
            fail("UNSUPPORTED_SCHEMA", f"{label}.callsites[{index}].owner references an unknown function")

    if "flow_edges" in payload:
        flow_edges = payload["flow_edges"]
        if not isinstance(flow_edges, list):
            fail("UNSUPPORTED_SCHEMA", f"{label}.flow_edges must be an array")
        if len(flow_edges) > _MAX_ENTITIES:
            fail("LIMIT_EXCEEDED", f"{label}.flow_edges exceeds the deterministic safety bound")
        seen_flow_ids: set = set()
        for index, edge in enumerate(flow_edges):
            where = f"{label}.flow_edges[{index}]"
            if not isinstance(edge, dict):
                fail("UNSUPPORTED_SCHEMA", f"{where} must be an object")
            for field in ("id", "owner", "target", "relation", "origin"):
                value = edge.get(field)
                if not isinstance(value, str) or not value or len(value) > _MAX_ID:
                    fail("UNSUPPORTED_SCHEMA", f"{where}.{field} must be a bounded non-empty string")
            if edge["id"] in seen_flow_ids:
                fail("UNSUPPORTED_SCHEMA", f"{label}.flow_edges contains a duplicate id")
            seen_flow_ids.add(edge["id"])
            sources = edge.get("sources")
            if not isinstance(sources, list) or not sources or not all(
                isinstance(item, str) and item for item in sources
            ):
                fail("UNSUPPORTED_SCHEMA", f"{where}.sources must be a non-empty array of ids")
            if edge.get("certainty") not in FLOW_CERTAINTIES:
                fail("UNSUPPORTED_SCHEMA", f"{where}.certainty is not a supported value")
            edge_evidence = edge.get("evidence_ids", [])
            if not isinstance(edge_evidence, list) or not all(
                isinstance(item, str) and item for item in edge_evidence
            ):
                fail("UNSUPPORTED_SCHEMA", f"{where}.evidence_ids must be an array of ids")
            limitations = edge.get("limitations", [])
            if not isinstance(limitations, list) or not all(isinstance(item, str) for item in limitations):
                fail("UNSUPPORTED_SCHEMA", f"{where}.limitations must be an array of strings")

    if "boundaries" in payload:
        boundaries = payload["boundaries"]
        if not isinstance(boundaries, list):
            fail("UNSUPPORTED_SCHEMA", f"{label}.boundaries must be an array")
        for index, boundary in enumerate(boundaries):
            where = f"{label}.boundaries[{index}]"
            if not isinstance(boundary, dict):
                fail("UNSUPPORTED_SCHEMA", f"{where} must be an object")
            for field in ("owner", "callsite", "kind"):
                value = boundary.get(field)
                if not isinstance(value, str) or not value:
                    fail("UNSUPPORTED_SCHEMA", f"{where}.{field} must be a non-empty string")

    return payload


# ---------------------------------------------------------------------------
# analysis manifest payload
# ---------------------------------------------------------------------------
def validate_manifest_payload(payload: Any, label: str = "analysis manifest payload") -> Dict[str, Any]:
    if not isinstance(payload, dict):
        fail("UNSUPPORTED_SCHEMA", f"{label} must be an object")
    for key in MANIFEST_KEYS:
        if key not in payload:
            fail("UNSUPPORTED_SCHEMA", f"{label} is missing required field {key}")
    if payload.get("schema_version") != ATLAS_SCHEMA_VERSION:
        fail("UNSUPPORTED_SCHEMA", f"{label}.schema_version must be '0.1'")
    for field in ("snapshot_id", "analysis_id", "tool_version"):
        value = payload.get(field)
        if not isinstance(value, str) or not value or len(value) > _MAX_ID:
            fail("UNSUPPORTED_SCHEMA", f"{label}.{field} must be a bounded non-empty string")
    graph_digest = payload.get("graph_hash")
    if not isinstance(graph_digest, str) or not _HASH_RE.match(graph_digest):
        fail("UNSUPPORTED_SCHEMA", f"{label}.graph_hash must be a lowercase SHA256")
    roots = payload.get("workspace_roots")
    if not isinstance(roots, list) or not roots or not all(
        isinstance(item, str) and item for item in roots
    ):
        fail("UNSUPPORTED_SCHEMA", f"{label}.workspace_roots must be a non-empty array of strings")
    input_files = payload.get("input_files")
    if not isinstance(input_files, dict):
        fail("UNSUPPORTED_SCHEMA", f"{label}.input_files must be an object")
    for key, value in input_files.items():
        if not isinstance(key, str) or not isinstance(value, (str, type(None))):
            fail("UNSUPPORTED_SCHEMA", f"{label}.input_files values must be string|null")
    revisions = payload.get("workspace_revisions")
    if not isinstance(revisions, dict) or not all(
        isinstance(value, (str, type(None))) for value in revisions.values()
    ):
        fail("UNSUPPORTED_SCHEMA", f"{label}.workspace_revisions values must be string|null")
    if not isinstance(payload.get("scope"), dict):
        fail("UNSUPPORTED_SCHEMA", f"{label}.scope must be an object")
    _validate_coverage_shape(payload.get("coverage"), f"{label}.coverage")
    return payload


def _validate_coverage_shape(coverage: Any, label: str) -> Dict[str, Any]:
    if not isinstance(coverage, dict):
        fail("UNSUPPORTED_SCHEMA", f"{label} must be an object")
    failed = coverage.get("failed", [])
    if not isinstance(failed, list):
        fail(
            "UNSUPPORTED_SCHEMA",
            f"{label}.failed must be an array of TU objects; a count is not a preserved coverage value",
        )
    if len(failed) > _MAX_COVERAGE_ITEMS:
        fail("LIMIT_EXCEEDED", f"{label}.failed exceeds the deterministic safety bound")
    pending = coverage.get("pending_units", [])
    if not isinstance(pending, list):
        fail(
            "UNSUPPORTED_SCHEMA",
            f"{label}.pending_units must be an array of paths; a count is not a preserved coverage value",
        )
    if len(pending) > _MAX_COVERAGE_ITEMS:
        fail("LIMIT_EXCEEDED", f"{label}.pending_units exceeds the deterministic safety bound")
    for index, entry in enumerate(pending):
        if not isinstance(entry, str) or not entry or len(entry) > _MAX_TEXT:
            fail("UNSUPPORTED_SCHEMA", f"{label}.pending_units[{index}] must be a bounded path string")
    for counter in ("parsed", "reused", "total_available_units", "processed_units"):
        if counter in coverage:
            value = coverage[counter]
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                fail("UNSUPPORTED_SCHEMA", f"{label}.{counter} must be a non-negative integer")
    for flag in ("whole_program_complete", "requested_scope_complete", "complete_call_chain"):
        if flag in coverage and not isinstance(coverage[flag], bool):
            fail("UNSUPPORTED_SCHEMA", f"{label}.{flag} must be a boolean")
    capabilities = coverage.get("capabilities")
    if capabilities is not None and not isinstance(capabilities, dict):
        fail("UNSUPPORTED_SCHEMA", f"{label}.capabilities must be an object")
    limitations = coverage.get("limitations")
    if limitations is not None and not (
        isinstance(limitations, list) and all(isinstance(item, str) for item in limitations)
    ):
        fail("UNSUPPORTED_SCHEMA", f"{label}.limitations must be an array of strings")
    return coverage


# ---------------------------------------------------------------------------
# projections
# ---------------------------------------------------------------------------
def project_coverage(coverage: Any, label: str = "coverage") -> Dict[str, Any]:
    """Deep-copy Atlas coverage, preserving failed/pending arrays verbatim."""
    _validate_coverage_shape(coverage, label)
    try:
        projected = json.loads(json.dumps(coverage))
    except (TypeError, ValueError):
        fail("UNSUPPORTED_SCHEMA", f"{label} is not JSON-serializable")
    assert isinstance(projected, dict)
    projected["failed"] = list(projected.get("failed") or [])
    projected["pending_units"] = list(projected.get("pending_units") or [])
    projected["failed_count"] = len(projected["failed"])
    return projected


def capabilities_of(coverage: Dict[str, Any]) -> Dict[str, str]:
    """Flatten ``coverage.capabilities`` into a bounded name->status mapping."""
    raw = coverage.get("capabilities")
    result: Dict[str, str] = {}
    if not isinstance(raw, dict):
        return result
    for name, value in raw.items():
        if not isinstance(name, str) or not name or len(name) > 64:
            continue
        if isinstance(value, bool):
            result[name] = "ready" if value else "unsupported"
        elif isinstance(value, str):
            result[name] = value[:64]
        elif isinstance(value, dict):
            status = value.get("status")
            result[name] = status[:64] if isinstance(status, str) else "unknown"
    return result


def capability_status(coverage: Dict[str, Any], name: str) -> str:
    return capabilities_of(coverage).get(name, "unknown")


def capability_available(coverage: Dict[str, Any], name: str) -> bool:
    return capability_status(coverage, name) in TRUTHY_CAPABILITY_STATUSES


def coverage_limitations(coverage: Dict[str, Any]) -> List[str]:
    raw = coverage.get("limitations")
    if isinstance(raw, list):
        return [item[:512] for item in raw if isinstance(item, str)]
    return []


def manifest_limitations(payload: Dict[str, Any]) -> List[str]:
    raw = payload.get("limitations")
    if isinstance(raw, list):
        return [item[:512] for item in raw if isinstance(item, str)]
    return []


def issue_summaries(payload: Dict[str, Any], kinds: Iterable[str] = UNRESOLVED_ISSUE_KINDS) -> List[Dict[str, Any]]:
    """Bounded, model-safe projections of unresolved issue records."""
    wanted = set(kinds)
    summaries: List[Dict[str, Any]] = []
    for issue in payload.get("issues", []):
        if len(summaries) >= MAX_ISSUE_PROJECTIONS:
            break
        if not isinstance(issue, dict):
            continue
        kind = issue.get("kind")
        if kind not in wanted:
            continue
        evidence_ids = issue.get("evidence_ids")
        summaries.append(
            {
                "reason": kind,
                "issue_id": _bounded_text(issue.get("id"), "issue.id", max_len=_MAX_ID),
                "detail": _bounded_text(
                    issue.get("detail") or issue.get("message") or issue.get("reason"), "issue.detail"
                ),
                "symbol": _bounded_text(issue.get("symbol") or issue.get("target"), "issue.symbol"),
                "evidence_ids": [
                    item for item in (evidence_ids if isinstance(evidence_ids, list) else [])
                    if isinstance(item, str) and item
                ],
            }
        )
    return summaries


# ---------------------------------------------------------------------------
# entity helpers
# ---------------------------------------------------------------------------
def functions_of(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    entries = payload.get("functions", [])
    return [entry for entry in entries if isinstance(entry, dict) and isinstance(entry.get("id"), str)]


def functions_by_id(payload: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {entry["id"]: entry for entry in functions_of(payload)}


def function_choice(function: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": function.get("id"),
        "name": _bounded_text(function.get("name"), "function.name"),
        "display_name": _bounded_text(function.get("display_name"), "function.display_name"),
        "file": _bounded_text(function.get("file"), "function.file"),
        "line": function.get("line") if isinstance(function.get("line"), int) else None,
    }


def match_functions(payload: Dict[str, Any], ref: str) -> List[Dict[str, Any]]:
    """Exact function-id match first; otherwise name/display_name matches."""
    functions = functions_of(payload)
    exact = [entry for entry in functions if entry.get("id") == ref]
    if exact:
        return exact
    return [
        entry
        for entry in functions
        if entry.get("name") == ref or entry.get("display_name") == ref
    ]


def resolve_function(payload: Dict[str, Any], ref: str, label: str = "function_ref") -> Dict[str, Any]:
    matches = match_functions(payload, ref)
    if not matches:
        fail("NOT_FOUND", f"{label} does not match any function in the selected snapshot")
    if len(matches) > 1:
        fail(
            "AMBIGUOUS_SYMBOL",
            f"{label} matches multiple functions; choose a function id",
            details={"choices": [function_choice(entry) for entry in matches]},
        )
    return matches[0]
