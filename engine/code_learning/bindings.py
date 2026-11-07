"""CrossRepoBindingV1 validation and evidence-driven status recomputation.

A binding is explicit, author/agent-declared metadata: it can never become a
compiler call fact.  ``status`` is always recomputed from the recorded
evidence and the previous evaluated revision, never trusted from the input:

* missing interface revision, shared definition, one-end source evidence or
  selector value evidence -> ``incomplete``;
* mutually exclusive bindings (same from + selector + variant pair pointing at
  different targets) or non-contiguous duplicate revisions -> ``conflicting``;
* changed identity or evidence summary compared with the previously evaluated
  revision -> ``stale``;
* every piece of evidence present -> ``supported``, which paths.py may turn
  into an ``abi_bridge`` edge with certainty ``may`` only.

The authoring JSON Schema requires at least one evidence ref; this runtime
evaluator intentionally accepts an empty array and classifies ``incomplete``
instead, because "missing evidence" is a reportable evaluation state.
"""

from __future__ import annotations

import copy
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from . import util
from .errors import fail

BINDING_KINDS = ("uapi_ioctl", "shared_abi", "protocol_message", "shared_header")
BINDING_ORIGINS = ("source_derived", "agent", "user_note")
BINDING_STATUSES = ("candidate", "supported", "incomplete", "conflicting", "stale")
SELECTOR_KINDS = ("ioctl_command", "message_id", "symbol_contract")
ENDIANNESS = ("little", "big", None)
POINTER_BITS = (32, 64, None)
COMPAT_MODES = ("native", "compat32", "unknown")

_BINDING_FIELDS = (
    "schema_version",
    "binding_id",
    "revision",
    "kind",
    "from",
    "to",
    "applicable_variant_pairs",
    "abi",
    "selector",
    "shared_definition_evidence_refs",
    "origin",
    "status",
    "assumptions",
    "limitations",
)
_ENDPOINT_FIELDS = (
    "repo_id",
    "variant_id",
    "interface_ref",
    "source_evidence_refs",
    "interface_revision_ref",
    "snapshot_ref",
)
_ABI_FIELDS = ("architecture", "endianness", "pointer_bits", "compat_mode", "layout_evidence_refs")
_SELECTOR_FIELDS = ("kind", "declared_value", "value_evidence_refs")
_PAIR_FIELDS = ("from_variant", "to_variant")

_SPEC_DIGEST_FIELDS = (
    "schema_version",
    "binding_id",
    "revision",
    "kind",
    "from",
    "to",
    "applicable_variant_pairs",
    "abi",
    "selector",
    "shared_definition_evidence_refs",
    "origin",
    "status",
    "assumptions",
    "limitations",
)

_MAX_EVIDENCE_REFS = 256
_MAX_EVIDENCE_REF_LEN = 512
_MAX_ASSUMPTIONS = 64
_MAX_TEXT = 512
_MAX_BINDINGS = 512


# ---------------------------------------------------------------------------
# validation helpers
# ---------------------------------------------------------------------------
def _expect_mapping(value: Any, where: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        fail("INVALID_ARGUMENT", f"{where} must be an object")
    return value


def _reject_unknown(value: Dict[str, Any], allowed: Iterable[str], where: str) -> None:
    unknown = sorted(set(value) - set(allowed))
    if unknown:
        fail("INVALID_ARGUMENT", f"{where} contains unknown fields: {', '.join(unknown)}")


def _expect_text(value: Any, where: str, *, max_len: int = _MAX_TEXT, allow_none: bool = False) -> Optional[str]:
    if value is None and allow_none:
        return None
    if not isinstance(value, str) or not value or len(value) > max_len:
        fail("INVALID_ARGUMENT", f"{where} must be a bounded non-empty string")
    return value


def _expect_int(value: Any, where: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        fail("INVALID_ARGUMENT", f"{where} must be a positive integer")
    return value


def _expect_string_list(
    value: Any,
    where: str,
    *,
    allow_empty: bool = True,
    max_items: int = _MAX_EVIDENCE_REFS,
    max_len: int = _MAX_TEXT,
) -> List[str]:
    if not isinstance(value, list):
        fail("INVALID_ARGUMENT", f"{where} must be an array")
    if len(value) > max_items:
        fail("INVALID_ARGUMENT", f"{where} contains too many entries")
    if not allow_empty and not value:
        fail("INVALID_ARGUMENT", f"{where} must not be empty")
    result: List[str] = []
    for index, item in enumerate(value):
        if not isinstance(item, str) or not item or len(item) > max_len:
            fail("INVALID_ARGUMENT", f"{where}[{index}] must be a bounded non-empty string")
        result.append(item)
    if len(set(result)) != len(result):
        fail("INVALID_ARGUMENT", f"{where} contains duplicate entries")
    return result


def _registered_repos(workspace: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    repositories = workspace.get("repositories")
    if not isinstance(repositories, list):
        fail("INVALID_ARGUMENT", "workspace registration is missing repositories")
    result: Dict[str, Dict[str, Any]] = {}
    for repository in repositories:
        if isinstance(repository, dict) and isinstance(repository.get("repo_id"), str):
            result[repository["repo_id"]] = repository
    return result


def _registered_variants(workspace: Dict[str, Any]) -> set:
    variants = workspace.get("variants")
    if not isinstance(variants, list):
        fail("INVALID_ARGUMENT", "workspace registration is missing variants")
    return {
        variant["variant_id"]
        for variant in variants
        if isinstance(variant, dict) and isinstance(variant.get("variant_id"), str)
    }


def _validate_endpoint(
    value: Any,
    where: str,
    *,
    repos: Dict[str, Dict[str, Any]],
    variants: set,
) -> Dict[str, Any]:
    endpoint = _expect_mapping(value, where)
    _reject_unknown(endpoint, _ENDPOINT_FIELDS, where)
    for field in _ENDPOINT_FIELDS:
        if field not in endpoint:
            fail("INVALID_ARGUMENT", f"{where} is missing required field {field}")
    repo_id = _expect_text(endpoint.get("repo_id"), f"{where}.repo_id", max_len=128)
    if repo_id not in repos:
        fail("INVALID_ARGUMENT", f"{where}.repo_id is not registered in this workspace")
    variant_id = _expect_text(endpoint.get("variant_id"), f"{where}.variant_id", max_len=128)
    if variant_id not in variants:
        fail("INVALID_ARGUMENT", f"{where}.variant_id is not registered in this workspace")
    _expect_text(endpoint.get("interface_ref"), f"{where}.interface_ref", max_len=512)
    _expect_string_list(
        endpoint.get("source_evidence_refs"),
        f"{where}.source_evidence_refs",
        allow_empty=True,
        max_items=_MAX_EVIDENCE_REFS,
        max_len=_MAX_EVIDENCE_REF_LEN,
    )
    revision_ref = endpoint.get("interface_revision_ref")
    if revision_ref is not None:
        _expect_text(revision_ref, f"{where}.interface_revision_ref", max_len=256)
    snapshot_ref = endpoint.get("snapshot_ref")
    if snapshot_ref is not None:
        _expect_text(snapshot_ref, f"{where}.snapshot_ref", max_len=256)
    return endpoint


def _validate_binding(binding: Any, workspace: Dict[str, Any]) -> Dict[str, Any]:
    entry = _expect_mapping(binding, "binding")
    _reject_unknown(entry, _BINDING_FIELDS, "binding")
    for field in _BINDING_FIELDS:
        if field not in entry:
            fail("INVALID_ARGUMENT", f"binding is missing required field {field}")
    if entry.get("schema_version") != 1:
        fail("INVALID_ARGUMENT", "binding.schema_version must be 1")
    binding_id = entry.get("binding_id")
    if not isinstance(binding_id, str):
        fail("INVALID_ARGUMENT", "binding.binding_id must be a string")
    util.check_id(binding_id, "binding.binding_id")
    _expect_int(entry.get("revision"), "binding.revision")
    if entry.get("kind") not in BINDING_KINDS:
        fail("INVALID_ARGUMENT", f"binding.kind must be one of: {', '.join(BINDING_KINDS)}")

    repos = _registered_repos(workspace)
    variants = _registered_variants(workspace)
    from_endpoint = _validate_endpoint(entry.get("from"), "binding.from", repos=repos, variants=variants)
    to_endpoint = _validate_endpoint(entry.get("to"), "binding.to", repos=repos, variants=variants)
    if from_endpoint["repo_id"] == to_endpoint["repo_id"]:
        fail("INVALID_ARGUMENT", "binding endpoints must belong to two different repositories")

    pairs = entry.get("applicable_variant_pairs")
    if not isinstance(pairs, list) or not pairs:
        fail("INVALID_ARGUMENT", "binding.applicable_variant_pairs must be a non-empty array")
    if len(pairs) > _MAX_BINDINGS:
        fail("INVALID_ARGUMENT", "binding.applicable_variant_pairs contains too many entries")
    pair_set: set = set()
    for index, pair in enumerate(pairs):
        where = f"binding.applicable_variant_pairs[{index}]"
        pair = _expect_mapping(pair, where)
        _reject_unknown(pair, _PAIR_FIELDS, where)
        for field in _PAIR_FIELDS:
            if field not in pair:
                fail("INVALID_ARGUMENT", f"{where} is missing required field {field}")
            value = _expect_text(pair[field], f"{where}.{field}", max_len=128)
            if value not in variants:
                fail("INVALID_ARGUMENT", f"{where}.{field} is not registered in this workspace")
        pair_set.add((pair["from_variant"], pair["to_variant"]))
    endpoint_pair = (from_endpoint["variant_id"], to_endpoint["variant_id"])
    if endpoint_pair not in pair_set:
        fail(
            "INVALID_ARGUMENT",
            "binding.applicable_variant_pairs does not match the endpoint variant combination",
        )

    abi = _expect_mapping(entry.get("abi"), "binding.abi")
    _reject_unknown(abi, _ABI_FIELDS, "binding.abi")
    for field in _ABI_FIELDS:
        if field not in abi:
            fail("INVALID_ARGUMENT", f"binding.abi is missing required field {field}")
    architecture = abi.get("architecture")
    if architecture is not None:
        _expect_text(architecture, "binding.abi.architecture", max_len=128)
    if abi.get("endianness") not in ENDIANNESS:
        fail("INVALID_ARGUMENT", "binding.abi.endianness must be little|big|null")
    if abi.get("pointer_bits") not in POINTER_BITS:
        fail("INVALID_ARGUMENT", "binding.abi.pointer_bits must be 32|64|null")
    if abi.get("compat_mode") not in COMPAT_MODES:
        fail("INVALID_ARGUMENT", f"binding.abi.compat_mode must be one of: {', '.join(COMPAT_MODES)}")
    _expect_string_list(
        abi.get("layout_evidence_refs"),
        "binding.abi.layout_evidence_refs",
        max_items=_MAX_EVIDENCE_REFS,
        max_len=_MAX_EVIDENCE_REF_LEN,
    )

    selector = _expect_mapping(entry.get("selector"), "binding.selector")
    _reject_unknown(selector, _SELECTOR_FIELDS, "binding.selector")
    for field in _SELECTOR_FIELDS:
        if field not in selector:
            fail("INVALID_ARGUMENT", f"binding.selector is missing required field {field}")
    if selector.get("kind") not in SELECTOR_KINDS:
        fail("INVALID_ARGUMENT", f"binding.selector.kind must be one of: {', '.join(SELECTOR_KINDS)}")
    _expect_text(selector.get("declared_value"), "binding.selector.declared_value", max_len=128)
    _expect_string_list(
        selector.get("value_evidence_refs"),
        "binding.selector.value_evidence_refs",
        max_items=_MAX_EVIDENCE_REFS,
        max_len=_MAX_EVIDENCE_REF_LEN,
    )

    _expect_string_list(
        entry.get("shared_definition_evidence_refs"),
        "binding.shared_definition_evidence_refs",
        max_items=_MAX_EVIDENCE_REFS,
        max_len=_MAX_EVIDENCE_REF_LEN,
    )
    if entry.get("origin") not in BINDING_ORIGINS:
        fail("INVALID_ARGUMENT", f"binding.origin must be one of: {', '.join(BINDING_ORIGINS)}")
    if entry.get("status") not in BINDING_STATUSES:
        fail("INVALID_ARGUMENT", f"binding.status must be one of: {', '.join(BINDING_STATUSES)}")
    _expect_string_list(entry.get("assumptions"), "binding.assumptions", max_items=_MAX_ASSUMPTIONS)
    _expect_string_list(entry.get("limitations"), "binding.limitations", max_items=_MAX_ASSUMPTIONS)
    return entry


# ---------------------------------------------------------------------------
# evidence/identity summaries
# ---------------------------------------------------------------------------
def _endpoint_identity(endpoint: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "repo_id": endpoint.get("repo_id"),
        "variant_id": endpoint.get("variant_id"),
        "interface_ref": endpoint.get("interface_ref"),
        "interface_revision_ref": endpoint.get("interface_revision_ref"),
    }


def _endpoint_evidence(endpoint: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "source_evidence_refs": sorted(endpoint.get("source_evidence_refs") or []),
        "snapshot_ref": endpoint.get("snapshot_ref"),
    }


def _pair_tuples(entry: Dict[str, Any]) -> List[Tuple[str, str]]:
    pairs = entry.get("applicable_variant_pairs")
    result: List[Tuple[str, str]] = []
    if isinstance(pairs, list):
        for pair in pairs:
            if isinstance(pair, dict) and isinstance(pair.get("from_variant"), str) and isinstance(
                pair.get("to_variant"), str
            ):
                result.append((pair["from_variant"], pair["to_variant"]))
    return sorted(result)


def _identity_digest(entry: Dict[str, Any]) -> str:
    abi = entry.get("abi") if isinstance(entry.get("abi"), dict) else {}
    selector = entry.get("selector") if isinstance(entry.get("selector"), dict) else {}
    identity = {
        "kind": entry.get("kind"),
        "from": _endpoint_identity(entry.get("from") or {}),
        "to": _endpoint_identity(entry.get("to") or {}),
        "applicable_variant_pairs": _pair_tuples(entry),
        "selector": {"kind": selector.get("kind"), "declared_value": selector.get("declared_value")},
        "abi": {
            "architecture": abi.get("architecture"),
            "endianness": abi.get("endianness"),
            "pointer_bits": abi.get("pointer_bits"),
            "compat_mode": abi.get("compat_mode"),
        },
    }
    return util.digest(identity)


def _evidence_digest(entry: Dict[str, Any]) -> str:
    selector = entry.get("selector") if isinstance(entry.get("selector"), dict) else {}
    abi = entry.get("abi") if isinstance(entry.get("abi"), dict) else {}
    evidence = {
        "from": _endpoint_evidence(entry.get("from") or {}),
        "to": _endpoint_evidence(entry.get("to") or {}),
        "shared_definition_evidence_refs": sorted(entry.get("shared_definition_evidence_refs") or []),
        "selector_value_evidence_refs": sorted(selector.get("value_evidence_refs") or []),
        "layout_evidence_refs": sorted(abi.get("layout_evidence_refs") or []),
    }
    return util.digest(evidence)


def _spec_payload(entry: Dict[str, Any], status: Optional[str] = None) -> Dict[str, Any]:
    payload: Dict[str, Any] = {}
    for field in _SPEC_DIGEST_FIELDS:
        if field in entry:
            payload[field] = copy.deepcopy(entry[field])
    payload["status"] = status if status is not None else entry.get("status")
    return payload


def _incomplete_reasons(entry: Dict[str, Any]) -> List[str]:
    from_endpoint = entry.get("from") or {}
    to_endpoint = entry.get("to") or {}
    selector = entry.get("selector") or {}
    reasons: List[str] = []
    if not from_endpoint.get("source_evidence_refs"):
        reasons.append("missing_from_source_evidence")
    if not to_endpoint.get("source_evidence_refs"):
        reasons.append("missing_to_source_evidence")
    if from_endpoint.get("interface_revision_ref") is None:
        reasons.append("missing_from_interface_revision")
    if to_endpoint.get("interface_revision_ref") is None:
        reasons.append("missing_to_interface_revision")
    if not entry.get("shared_definition_evidence_refs"):
        reasons.append("missing_shared_definition_evidence")
    if not selector.get("value_evidence_refs"):
        reasons.append("missing_selector_value_evidence")
    return reasons


def _bridge_candidate(entry: Dict[str, Any], status: str, incomplete_reasons: Sequence[str]) -> Dict[str, Any]:
    supported = status == "supported"
    abi = entry.get("abi") if isinstance(entry.get("abi"), dict) else {}
    limitations = list(entry.get("limitations") or [])
    if supported:
        limitations.append("static_contract_not_runtime_call")
        if not abi.get("layout_evidence_refs"):
            limitations.append("layout_not_verified")
    return {
        "can_bridge": supported,
        "relation": "abi_bridge",
        "certainty": "may" if supported else None,
        "origin": "derived" if supported else None,
        "reason": None if supported else status,
        "incomplete_reasons": list(incomplete_reasons),
        "from_interface_ref": (entry.get("from") or {}).get("interface_ref"),
        "to_interface_ref": (entry.get("to") or {}).get("interface_ref"),
        "assumptions": list(entry.get("assumptions") or []),
        "limitations": limitations,
    }


def _previous_bindings(workspace: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Previously evaluated bindings used for identity/evidence stale detection.

    ``bindings`` is the contract §3 registration key.  ``previous_bindings`` is
    accepted as an explicit hand-off for callers that rebuild the workspace
    dict from a new manifest and still want the old evaluated set compared.
    """
    previous: List[Dict[str, Any]] = []
    seen: set = set()
    for key in ("bindings", "previous_bindings"):
        raw = workspace.get(key)
        if not isinstance(raw, list):
            continue
        for item in raw:
            if not isinstance(item, dict):
                continue
            binding_id = item.get("binding_id")
            if not isinstance(binding_id, str) or binding_id in seen:
                continue
            if not isinstance(item.get("from"), dict) or not isinstance(item.get("to"), dict):
                continue
            seen.add(binding_id)
            previous.append(item)
    return previous


def _duplicate_binding_ids(entries: Sequence[Dict[str, Any]]) -> set:
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for entry in entries:
        grouped.setdefault(entry["binding_id"], []).append(entry)
    conflicting: set = set()
    for binding_id, group in grouped.items():
        if len(group) < 2:
            continue
        revisions = sorted({entry.get("revision") for entry in group if isinstance(entry.get("revision"), int)})
        if not revisions or revisions != list(range(revisions[0], revisions[0] + len(revisions))):
            conflicting.add(binding_id)
    return conflicting


def _effective_bindings(entries: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """One current entry per binding_id (highest revision); first-use order kept."""
    order: List[str] = []
    latest: Dict[str, Dict[str, Any]] = {}
    for entry in entries:
        binding_id = entry["binding_id"]
        if binding_id not in latest:
            order.append(binding_id)
            latest[binding_id] = entry
            continue
        if entry.get("revision", 0) > latest[binding_id].get("revision", 0):
            latest[binding_id] = entry
    return [latest[binding_id] for binding_id in order]


def _version_conflicting(entries: Sequence[Dict[str, Any]]) -> set:
    """binding_ids whose two endpoint interface revisions contradict each other."""
    conflicting: set = set()
    for entry in entries:
        from_endpoint = entry.get("from") if isinstance(entry.get("from"), dict) else {}
        to_endpoint = entry.get("to") if isinstance(entry.get("to"), dict) else {}
        from_revision = from_endpoint.get("interface_revision_ref")
        to_revision = to_endpoint.get("interface_revision_ref")
        if isinstance(from_revision, str) and isinstance(to_revision, str) and from_revision != to_revision:
            conflicting.add(entry["binding_id"])
    return conflicting


def _mutually_conflicting(entries: Sequence[Dict[str, Any]]) -> set:
    """binding_ids whose from+selector+variant-pairs point at different targets."""
    grouped: Dict[Any, set] = {}
    members: Dict[Any, List[str]] = {}
    for entry in entries:
        from_endpoint = entry.get("from") or {}
        selector = entry.get("selector") or {}
        to_endpoint = entry.get("to") or {}
        key = (
            from_endpoint.get("repo_id"),
            from_endpoint.get("interface_ref"),
            selector.get("kind"),
            selector.get("declared_value"),
            tuple(_pair_tuples(entry)),
        )
        grouped.setdefault(key, set()).add((to_endpoint.get("repo_id"), to_endpoint.get("interface_ref")))
        members.setdefault(key, []).append(entry["binding_id"])
    conflicting: set = set()
    for key, targets in grouped.items():
        if len(targets) > 1:
            conflicting.update(members[key])
    return conflicting


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------
def evaluate_bindings(workspace: Any, manifest_bindings: Any) -> List[Dict[str, Any]]:
    """Strictly validate bindings and recompute ``status`` from evidence."""
    if not isinstance(workspace, dict):
        fail("INVALID_ARGUMENT", "workspace registration must be an object")
    if manifest_bindings is None:
        return []
    if not isinstance(manifest_bindings, list):
        fail("INVALID_ARGUMENT", "cross-repo bindings must be an array")
    if len(manifest_bindings) > _MAX_BINDINGS:
        fail("INVALID_ARGUMENT", "too many cross-repo bindings")

    entries = [_validate_binding(item, workspace) for item in manifest_bindings]
    evaluations = _evaluate_entries(workspace, entries)
    return evaluations


def _evaluate_entries(workspace: Dict[str, Any], entries: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    previous = _previous_bindings(workspace)
    previous_by_id: Dict[str, Dict[str, Any]] = {}
    for item in previous:
        previous_by_id.setdefault(item["binding_id"], item)

    duplicate_conflicts = _duplicate_binding_ids(entries)
    effective = _effective_bindings(entries)
    mutually_conflicting = _mutually_conflicting(effective) | _version_conflicting(effective)

    results: List[Dict[str, Any]] = []
    for entry in effective:
        binding_id = entry["binding_id"]
        status: str
        incomplete_reasons = _incomplete_reasons(entry)
        if binding_id in duplicate_conflicts or binding_id in mutually_conflicting:
            status = "conflicting"
        elif _is_stale(entry, previous_by_id.get(binding_id)):
            status = "stale"
        elif incomplete_reasons:
            status = "incomplete"
        else:
            status = "supported"

        result = copy.deepcopy(entry)
        result["status"] = status
        result["bridge_candidate"] = _bridge_candidate(entry, status, incomplete_reasons)
        result["binding_digest"] = util.digest(_spec_payload(entry, status))
        results.append(result)
    return results


def _is_stale(entry: Dict[str, Any], previous: Optional[Dict[str, Any]]) -> bool:
    if previous is None:
        return False
    return _identity_digest(entry) != _identity_digest(previous) or _evidence_digest(
        entry
    ) != _evidence_digest(previous)


def binding_digest(bindings: Any) -> str:
    """Canonical digest of a binding set for BuildIdentity.binding_digest."""
    if not isinstance(bindings, list):
        fail("INVALID_ARGUMENT", "bindings must be an array")
    payloads = []
    for item in bindings:
        if not isinstance(item, dict):
            fail("INVALID_ARGUMENT", "bindings must contain objects")
        payloads.append(_spec_payload(item))
    payloads.sort(key=lambda payload: (str(payload.get("binding_id")), payload.get("revision") or 0))
    return util.digest(payloads)
