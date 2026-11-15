"""S3a controlled scenario: Wasm sim profiles, plans, run ledger and observed timing.

Implements the engine side of ``docs/scenario-contract.md`` sections 1-3, 6 and
9:

* :func:`sim_profile_import` / :func:`sim_profile_list` -- verify a trusted
  inbox Wasm simulation profile (module sha256/size, interface contract, event
  table, snapshot-bound object references), copy it into the read-only
  ``state/sim/`` area and sign the registration;
* :func:`scenario_plan` -- strict scenario validation (steps, per-parameter
  type/range, generation CAS, byte budget) and a signed TTL plan, without
  executing anything;
* :func:`scenario_module` -- the Host worker payload (module bytes + profile
  binding), never a filesystem path;
* :func:`scenario_record` -- align worker records with the plan, derive
  ``affected_resources`` from the profile event table, and append one immutable
  ledger generation (CAS + operation idempotency);
* :func:`scenario_list` / :func:`scenario_get` -- ledger summaries / the current
  generation projection;
* :func:`view_sequence_observed` -- the observed timing DTO for the ledger.

The engine never executes Wasm and never accepts a path, module URL or argv from
a caller: profile modules are copied from the trusted import inbox only, and all
outputs stay free of absolute/state paths.
"""

from __future__ import annotations

import base64
import binascii
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from . import atlas, snapshot, util
from . import views as readmodel
from .errors import CodeLearningError, fail
from .validation import (
    expect_array,
    expect_bool,
    expect_int,
    expect_object,
    expect_str,
    hash_hex,
    one_of,
    reject_unknown,
)

SCHEMA_VERSION = 1

#: Profile / module limits (contract section 2).
MAX_MODULE_BYTES = 1024 * 1024
MAX_PROFILE_FILE_BYTES = 256 * 1024
MAX_INTERFACES = 32
MAX_PARAMS = 8
MAX_EVENTS = 64
MAX_EVENT_RESOURCES = 256
MAX_ASYNC_EVENTS = 16
MAX_LIMITATIONS = 16

#: Scenario / plan / record limits (contract section 3).
MAX_STEPS = 20
MAX_ARGS_BYTES = 4096
MAX_SCENARIO_JSON_BYTES = 8 * 1024
MAX_RECORDS_JSON_BYTES = 32 * 1024
MAX_EVENTS_PER_STEP = 256
PLAN_TTL_SECONDS = 600
PLAN_TIMEOUT_MS = 10_000
MAX_OBSERVED_MESSAGES = 1200

#: S3b (scenario-s3b-contract sections 1/2) limits.
MAX_UNDO_PLAN_STEPS = MAX_STEPS
MAX_IMPORTED_TRACE_BYTES = 64 * 1024
MAX_IMPORTED_TRACE_STEPS = 200
MAX_TRACE_METADATA_KEYS = 16
MAX_TRACE_METADATA_STRING = 256

INT32_MIN = -(1 << 31)
INT32_MAX = (1 << 31) - 1
UINT32_MAX = (1 << 32) - 1

PROFILE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
INTERFACE_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
EVENT_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
SCENARIO_ID_RE = re.compile(r"^scn_[0-9a-f]{12}$")
PLAN_REF_RE = re.compile(r"^(?:plan|undo)_([0-9a-f]{32})$")
MEMORY_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
METADATA_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]{0,63}$")
ABSOLUTE_PATH_RE = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\|//|/[A-Za-z0-9._~])")

ACCESS_VALUES = readmodel.ACCESS_VALUES
TRACE_SIGNATURE_TYPES = frozenset({"i32", "u32", "i64", "f32", "f64"})

_PROFILE_KEYS = frozenset(
    {
        "schema_version",
        "profile_id",
        "label",
        "kind",
        "binding",
        "module",
        "interfaces",
        "trace",
        "event_resources",
        "limitations",
        "async_events",
    }
)
_BINDING_KEYS = frozenset({"workspace_id", "variant_id", "repo_id", "snapshot_id"})
_MODULE_KEYS = frozenset({"file", "sha256"})
_INTERFACE_KEYS = frozenset({"name", "params", "returns", "role", "entry_id"})
_PARAM_KEYS = frozenset({"name", "type", "min", "max"})
_TRACE_KEYS = frozenset({"import", "signature", "events"})
_TRACE_IMPORT_KEYS = frozenset({"module", "field"})
_EVENT_RESOURCE_KEYS = frozenset({"resource_id", "name", "access", "field"})
_SCENARIO_KEYS = frozenset({"generation", "stop_on_error", "steps"})
_STEP_KEYS = frozenset({"interface", "args"})
_PLAN_KEYS = frozenset(
    {
        "schema_version",
        "plan_sha256",
        "profile_id",
        "module_sha256",
        "scenario_id",
        "scenario_digest",
        "generation",
        "kind",
        "steps",
        "trace",
        "limits",
        "created_at",
        "expires_at",
        "signature",
        "source",
        "count",
        "prefix",
        "expected_prefix",
        "undo_plan_id",
        "workspace_id",
        "snapshot_id",
        "variant_id",
        "repo_id",
        "limitations",
    }
)
_PLAN_STEP_KEYS = frozenset({"index", "interface", "role", "args"})
_RECORDS_DOC_KEYS = frozenset({"records"})
_RECORD_KEYS = frozenset(
    {
        "step_index",
        "interface",
        "args",
        "status",
        "result",
        "memory_digest",
        "elapsed_ms",
        "events",
    }
)
_EVENT_KEYS = frozenset({"event", "code", "a", "b", "c", "line"})
_IMPORTED_TRACE_KEYS = frozenset(
    {"schema_version", "kind", "label", "profile_id", "snapshot_id", "metadata", "steps", "async_events"}
)
_TRACE_STEP_KEYS = frozenset(
    {"interface", "args", "status", "result", "events", "memory_digest", "elapsed_ms"}
)
_LEDGER_KEYS = frozenset(
    {
        "schema_version",
        "scenario_id",
        "generation",
        "profile_id",
        "workspace_id",
        "snapshot_id",
        "variant_id",
        "repo_id",
        "scenario_digest",
        "records_digest",
        "plan_id",
        "module_sha256",
        "observed",
        "created_at",
        "records",
        "limitations",
        "signature",
        "undo",
        "imported",
        "source",
        "label",
        "metadata",
        "async_events",
    }
)


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------
def _int32(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        fail("INVALID_ARGUMENT", f"{label} must be a 32-bit signed integer")
    if value < INT32_MIN or value > INT32_MAX:
        fail("INVALID_ARGUMENT", f"{label} must be a 32-bit signed integer")
    return value


def _optional_int32(value: Any, label: str) -> Optional[int]:
    if value is None:
        return None
    return _int32(value, label)


def _decode_base64(value: Any, label: str, max_bytes: int) -> bytes:
    text = expect_str(value, label, max_len=4 * max_bytes + 8)
    try:
        raw = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        fail("INVALID_ARGUMENT", f"{label} must be valid base64")
    if len(raw) > max_bytes:
        fail(
            "LIMIT_EXCEEDED",
            f"{label} decodes to more than {max_bytes} bytes",
            details={"limit": max_bytes, "actual": len(raw)},
        )
    return raw


def _json_bytes(raw: bytes, label: str) -> Dict[str, Any]:
    try:
        value = util.read_json_bytes(raw, label)
    except CodeLearningError:
        raise
    return expect_object(value, label)


def _single_file_name(value: Any, label: str) -> str:
    text = expect_str(value, label, max_len=256)
    if text in (".", "..") or "/" in text or "\\" in text or "\x00" in text:
        fail("INVALID_ARGUMENT", f"{label} must be a single plain file name")
    return text


def _sim_root(state: Any) -> Path:
    return Path(state.state_root) / "sim"


def _sim_profile_dir(state: Any, profile_id: str) -> Path:
    return _sim_root(state) / profile_id


def _sim_index_path(state: Any) -> Path:
    return _sim_root(state) / "index.json"


def _scenario_root(state: Any) -> Path:
    return Path(state.state_root) / "scenarios"


def _scenario_dir(state: Any, scenario_id: str) -> Path:
    return _scenario_root(state) / scenario_id


def _plan_root(state: Any) -> Path:
    return Path(state.state_root) / "plans"


def _read_json_file(path: Path, label: str) -> Dict[str, Any]:
    try:
        value = util.read_json(path)
    except CodeLearningError as error:
        if error.code == "NOT_FOUND":
            fail("NOT_FOUND", f"{label} is not present")
        raise
    return expect_object(value, label)


def _atomic_write_json(path: Path, value: Any) -> None:
    util.atomic_write_json(Path(path), value)


def _safe_regular_file(path: Path, label: str) -> Path:
    candidate = Path(path)
    if candidate.is_symlink():
        fail("SCOPE_DENIED", f"{label} must not be a symlink")
    if not candidate.is_file():
        fail("NOT_FOUND", f"{label} is not a regular file")
    return candidate


def _digest_or_fail(value: Any, label: str) -> str:
    try:
        return util.digest(value)
    except (TypeError, ValueError):
        fail("INVALID_ARGUMENT", f"{label} is not canonicalizable")


# ---------------------------------------------------------------------------
# profile validation
# ---------------------------------------------------------------------------
def _validate_variant(workspace: Dict[str, Any], variant_id: str) -> Dict[str, Any]:
    for variant in workspace.get("variants") or []:
        if isinstance(variant, dict) and variant.get("variant_id") == variant_id:
            return variant
    fail("NOT_FOUND", "variant is not registered in this workspace")


def _validate_repo(workspace: Dict[str, Any], repo_id: str) -> Dict[str, Any]:
    for repo in workspace.get("repositories") or []:
        if isinstance(repo, dict) and repo.get("repo_id") == repo_id:
            return repo
    fail("NOT_FOUND", "repository is not registered in this workspace")


def _load_binding_bundle(
    state: Any, workspace_id: str, binding: Dict[str, Any]
) -> Dict[str, Any]:
    bundle = snapshot.load_snapshot_bundle(state, workspace_id, binding["snapshot_id"])
    if bundle.get("freshness") == "unknown" or not isinstance(bundle.get("graph"), dict):
        fail(
            "STALE_SNAPSHOT",
            "profile snapshot files are missing or unreadable; re-import the snapshot first",
        )
    if bundle.get("repo_id") != binding["repo_id"]:
        fail(
            "INVALID_ARGUMENT",
            "profile binding repo_id does not match the imported snapshot repository",
        )
    if bundle.get("variant_id") != binding["variant_id"]:
        fail(
            "INVALID_ARGUMENT",
            "profile binding variant_id does not match the imported snapshot variant",
        )
    return bundle


def _validate_param(param: Any, where: str) -> Dict[str, Any]:
    expect_object(param, where)
    reject_unknown(param, _PARAM_KEYS, where)
    name = expect_str(param.get("name"), f"{where}.name", max_len=64)
    if not INTERFACE_NAME_RE.match(name):
        fail("INVALID_ARGUMENT", f"{where}.name has an unsupported format")
    param_type = one_of(param.get("type"), ("u32", "i32"), f"{where}.type")
    low, high = (0, UINT32_MAX) if param_type == "u32" else (INT32_MIN, INT32_MAX)
    minimum = expect_int(param.get("min"), f"{where}.min", low=low, high=high)
    maximum = expect_int(param.get("max"), f"{where}.max", low=low, high=high)
    if minimum > maximum:
        fail("INVALID_ARGUMENT", f"{where}.min must not exceed {where}.max")
    return {"name": name, "type": param_type, "min": minimum, "max": maximum}


def _validate_interface(
    interface: Any, index: int, graph: Dict[str, Any]
) -> Dict[str, Any]:
    where = f"interfaces[{index}]"
    expect_object(interface, where)
    reject_unknown(interface, _INTERFACE_KEYS, where)
    name = expect_str(interface.get("name"), f"{where}.name", max_len=64)
    if not INTERFACE_NAME_RE.match(name):
        fail("INVALID_ARGUMENT", f"{where}.name has an unsupported format")
    raw_params = expect_array(interface.get("params", []), f"{where}.params", max_items=MAX_PARAMS)
    params = [_validate_param(param, f"{where}.params[{pindex}]") for pindex, param in enumerate(raw_params)]
    returns = one_of(interface.get("returns"), ("i32", "void"), f"{where}.returns")
    role = one_of(interface.get("role"), ("entry", "stub_control", "util"), f"{where}.role")
    entry_id = interface.get("entry_id")
    if role == "entry":
        if not isinstance(entry_id, str) or not entry_id:
            fail("INVALID_ARGUMENT", f"{where}.entry_id is required for an entry interface")
        entry_id = expect_str(entry_id, f"{where}.entry_id", max_len=512)
        if entry_id not in atlas.functions_by_id(graph):
            fail("INVALID_ARGUMENT", f"{where}.entry_id does not exist in the bound snapshot")
    elif entry_id is not None:
        entry_id = expect_str(entry_id, f"{where}.entry_id", max_len=512)
        if entry_id not in atlas.functions_by_id(graph):
            fail("INVALID_ARGUMENT", f"{where}.entry_id does not exist in the bound snapshot")
    return {
        "name": name,
        "params": params,
        "returns": returns,
        "role": role,
        "entry_id": entry_id,
    }


def _validate_interfaces(interfaces: Any, graph: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw = expect_array(interfaces, "interfaces", min_items=1, max_items=MAX_INTERFACES)
    validated: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    for index, interface in enumerate(raw):
        item = _validate_interface(interface, index, graph)
        if item["name"] in seen:
            fail("INVALID_ARGUMENT", "profile interface names must be unique")
        seen.add(item["name"])
        validated.append(item)
    return validated


def _validate_trace(trace: Any) -> Dict[str, Any]:
    expect_object(trace, "trace")
    reject_unknown(trace, _TRACE_KEYS, "trace")
    raw_import = expect_object(trace.get("import"), "trace.import")
    reject_unknown(raw_import, _TRACE_IMPORT_KEYS, "trace.import")
    module = expect_str(raw_import.get("module"), "trace.import.module", max_len=64)
    field = expect_str(raw_import.get("field"), "trace.import.field", max_len=64)
    signature = expect_array(
        trace.get("signature"), "trace.signature", min_items=1, max_items=16
    )
    normalized_signature = [
        one_of(item, tuple(TRACE_SIGNATURE_TYPES), f"trace.signature[{index}]")
        for index, item in enumerate(signature)
    ]
    raw_events = expect_object(trace.get("events"), "trace.events")
    if len(raw_events) > MAX_EVENTS:
        fail("LIMIT_EXCEEDED", f"trace.events is limited to {MAX_EVENTS} entries")
    events: Dict[str, int] = {}
    codes: Set[int] = set()
    for name, code in raw_events.items():
        if not isinstance(name, str) or not EVENT_RE.match(name):
            fail("INVALID_ARGUMENT", "trace.events keys must be upper-case identifiers")
        if isinstance(code, bool) or not isinstance(code, int) or code < 0 or code > INT32_MAX:
            fail("INVALID_ARGUMENT", f"trace.events[{name}] must be a non-negative integer code")
        if code in codes:
            fail("INVALID_ARGUMENT", "trace.events codes must be unique")
        codes.add(code)
        events[name] = code
    return {
        "import": {"module": module, "field": field},
        "signature": normalized_signature,
        "events": events,
    }


def _validate_async_event_names(
    value: Any, known: Set[str], where: str
) -> List[str]:
    """Validate an optional ``async_events`` declaration (contract section 11).

    Order is preserved; duplicates and names that are not declared by the
    profile trace table (or by the imported trace steps) are rejected.
    """
    raw = expect_array(value, where, max_items=MAX_ASYNC_EVENTS)
    normalized: List[str] = []
    seen: Set[str] = set()
    for index, item in enumerate(raw):
        name = expect_str(item, f"{where}[{index}]", max_len=64)
        if name not in known:
            fail(
                "INVALID_ARGUMENT",
                f"{where}[{index}] is not a declared event name",
            )
        if name in seen:
            fail("INVALID_ARGUMENT", f"{where}[{index}] is a duplicate event name")
        seen.add(name)
        normalized.append(name)
    return normalized


def _validate_event_resources(
    event_resources: Any, events: Dict[str, int], graph: Dict[str, Any]
) -> Dict[str, List[Dict[str, Any]]]:
    expect_object(event_resources, "event_resources")
    objects = {
        entity["id"]: entity
        for entity in graph.get("objects") or []
        if isinstance(entity, dict) and isinstance(entity.get("id"), str)
    }
    normalized: Dict[str, List[Dict[str, Any]]] = {}
    total = 0
    for event_name, raw_entries in event_resources.items():
        if not isinstance(event_name, str) or event_name not in events:
            fail(
                "INVALID_ARGUMENT",
                "event_resources keys must reference profile trace events",
            )
        entries = expect_array(
            raw_entries, f"event_resources[{event_name}]", max_items=MAX_EVENT_RESOURCES
        )
        normalized_entries: List[Dict[str, Any]] = []
        for index, entry in enumerate(entries):
            where = f"event_resources[{event_name}][{index}]"
            expect_object(entry, where)
            reject_unknown(entry, _EVENT_RESOURCE_KEYS, where)
            resource_id = expect_str(entry.get("resource_id"), f"{where}.resource_id", max_len=512)
            if resource_id not in objects:
                fail(
                    "INVALID_ARGUMENT",
                    f"{where}.resource_id does not reference an object of the bound snapshot",
                )
            name = entry.get("name")
            if name is not None:
                name = expect_str(name, f"{where}.name", max_len=256)
                object_name = objects[resource_id].get("name")
                if isinstance(object_name, str) and object_name != name:
                    fail("INVALID_ARGUMENT", f"{where}.name does not match the snapshot object")
            access = one_of(entry.get("access"), tuple(ACCESS_VALUES), f"{where}.access")
            item: Dict[str, Any] = {
                "resource_id": resource_id,
                "name": name if isinstance(name, str) else objects[resource_id].get("name"),
                "access": access,
            }
            field = entry.get("field")
            if field is not None:
                item["field"] = expect_str(field, f"{where}.field", max_len=128)
            total += 1
            if total > MAX_EVENT_RESOURCES:
                fail("LIMIT_EXCEEDED", f"event_resources is limited to {MAX_EVENT_RESOURCES} entries")
            normalized_entries.append(item)
        if normalized_entries:
            normalized[event_name] = normalized_entries
    return normalized


def _validate_limitations(limitations: Any) -> List[str]:
    if limitations is None:
        return []
    raw = expect_array(limitations, "limitations", max_items=MAX_LIMITATIONS)
    result: List[str] = []
    for index, item in enumerate(raw):
        result.append(expect_str(item, f"limitations[{index}]", max_len=512))
    return result


def _validate_profile(
    state: Any,
    profile: Dict[str, Any],
    workspace: Dict[str, Any],
    variant_id: str,
    repo_id: str,
) -> Dict[str, Any]:
    reject_unknown(profile, _PROFILE_KEYS, "sim profile")
    if profile.get("schema_version") != 1:
        fail("UNSUPPORTED_SCHEMA", "sim profile schema_version must be 1")
    profile_id = expect_str(profile.get("profile_id"), "profile_id", max_len=64)
    if not PROFILE_ID_RE.match(profile_id):
        fail("INVALID_ARGUMENT", "profile_id has an unsupported format")
    label = expect_str(profile.get("label"), "label", max_len=256)
    kind = one_of(profile.get("kind"), ("wasm32",), "kind")
    binding = expect_object(profile.get("binding"), "binding")
    reject_unknown(binding, _BINDING_KEYS, "binding")
    binding_workspace = expect_str(binding.get("workspace_id"), "binding.workspace_id", max_len=64)
    binding_variant = expect_str(binding.get("variant_id"), "binding.variant_id", max_len=64)
    binding_repo = expect_str(binding.get("repo_id"), "binding.repo_id", max_len=64)
    binding_snapshot = expect_str(binding.get("snapshot_id"), "binding.snapshot_id", max_len=128)
    if binding_workspace != workspace["workspace_id"]:
        fail("SCOPE_DENIED", "profile binding workspace_id does not match --workspace")
    if binding_variant != variant_id:
        fail("INVALID_ARGUMENT", "profile binding variant_id does not match --variant")
    if binding_repo != repo_id:
        fail("INVALID_ARGUMENT", "profile binding repo_id does not match --repo")
    _validate_variant(workspace, variant_id)
    _validate_repo(workspace, repo_id)
    bound_bundle = _load_binding_bundle(state, workspace["workspace_id"], binding)
    graph = bound_bundle["graph"]

    module = expect_object(profile.get("module"), "module")
    reject_unknown(module, _MODULE_KEYS, "module")
    module_file = _single_file_name(module.get("file"), "module.file")
    module_sha = expect_str(module.get("sha256"), "module.sha256", max_len=64)
    hash_hex(module_sha, "module.sha256")

    interfaces = _validate_interfaces(profile.get("interfaces"), graph)
    trace = _validate_trace(profile.get("trace"))
    event_resources = _validate_event_resources(
        profile.get("event_resources", {}), trace["events"], graph
    )
    limitations = _validate_limitations(profile.get("limitations"))
    async_events = _validate_async_event_names(
        profile.get("async_events", []), set(trace["events"]), "async_events"
    )

    module_path = state.inbox_file(module_file, max_bytes=MAX_MODULE_BYTES)
    try:
        module_bytes = module_path.read_bytes()
    except OSError:
        fail("DEPENDENCY_UNAVAILABLE", "simulation module is not readable")
    if len(module_bytes) <= 0 or len(module_bytes) > MAX_MODULE_BYTES:
        fail("LIMIT_EXCEEDED", f"simulation module must be 1..{MAX_MODULE_BYTES} bytes")
    actual_sha = util.sha256_bytes(module_bytes)
    if actual_sha != module_sha:
        fail("INVALID_ARGUMENT", "simulation module sha256 does not match the profile")

    normalized_profile: Dict[str, Any] = {
        "schema_version": 1,
        "profile_id": profile_id,
        "label": label,
        "kind": kind,
        "binding": {
            "workspace_id": binding_workspace,
            "variant_id": binding_variant,
            "repo_id": binding_repo,
            "snapshot_id": binding_snapshot,
        },
        "module": {"file": module_file, "sha256": module_sha},
        "interfaces": interfaces,
        "trace": trace,
        "event_resources": event_resources,
        "limitations": limitations,
    }
    if async_events:
        normalized_profile["async_events"] = async_events
    return {
        "profile": normalized_profile,
        "module_bytes": module_bytes,
        "module_bytes_len": len(module_bytes),
        "module_sha256": module_sha,
        "module_file": module_file,
    }


# ---------------------------------------------------------------------------
# policy objects
# ---------------------------------------------------------------------------
def _profile_projection(record: Dict[str, Any]) -> Dict[str, Any]:
    profile = record["profile"]
    return {
        "schema_version": SCHEMA_VERSION,
        "profile_id": profile["profile_id"],
        "label": profile["label"],
        "kind": profile["kind"],
        "binding": dict(profile["binding"]),
        "module": {
            "sha256": record["module_sha256"],
            "bytes": record["module_bytes_len"],
        },
        "interfaces": [dict(item) for item in profile["interfaces"]],
        "trace": {
            "import": dict(profile["trace"]["import"]),
            "signature": list(profile["trace"]["signature"]),
            "events": dict(profile["trace"]["events"]),
        },
        "event_resources": {
            name: [dict(entry) for entry in entries]
            for name, entries in profile["event_resources"].items()
        },
        "limitations": list(profile["limitations"]),
        "async_events": list(profile.get("async_events") or []),
    }



def _interfaces_projection(interfaces: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Stable interface projection used by the workbench step editor."""
    projected: List[Dict[str, Any]] = []
    for interface in interfaces:
        projected.append(
            {
                "name": interface["name"],
                "params": [
                    {
                        "name": param["name"],
                        "type": param["type"],
                        "min": param["min"],
                        "max": param["max"],
                    }
                    for param in interface["params"]
                ],
                "returns": interface["returns"],
                "role": interface["role"],
                "entry_id": interface.get("entry_id"),
            }
        )
    return projected


def _profile_signature_payload(
    record: Dict[str, Any], scope_generation: int
) -> Dict[str, Any]:
    profile = record["profile"]
    binding = profile["binding"]
    return {
        "kind": "sim_profile",
        "p": profile["profile_id"],
        "h": record["module_sha256"],
        "n": record["module_bytes_len"],
        "w": binding["workspace_id"],
        "v": binding["variant_id"],
        "r": binding["repo_id"],
        "s": binding["snapshot_id"],
        "pd": record.get("profile_digest"),
        "g": scope_generation,
    }


def _load_profile_record(
    state: Any, profile_ref: str, *, workspace_id: Optional[str] = None
) -> Dict[str, Any]:
    profile_id = expect_str(profile_ref, "profile", max_len=64)
    if not PROFILE_ID_RE.match(profile_id):
        fail("INVALID_ARGUMENT", "profile has an unsupported format")
    record = _read_json_file(
        _sim_profile_dir(state, profile_id) / "profile.json", "simulation profile"
    )
    if record.get("schema_version") != 1:
        fail("UNSUPPORTED_SCHEMA", "simulation profile registration is not supported")
    profile = expect_object(record.get("profile"), "simulation profile registration")
    signature = record.get("signature")
    if not isinstance(signature, str) or not signature:
        fail("SCOPE_DENIED", "simulation profile registration is not signed")
    try:
        payload = state.verify(signature, kind="sim_profile")
    except CodeLearningError as error:
        fail("SCOPE_DENIED", f"simulation profile registration is not trusted: {error.code}")
    expected = _profile_signature_payload(record, state.scope_generation)
    for key, value in expected.items():
        if payload.get(key) != value:
            fail("SCOPE_DENIED", "simulation profile registration does not match its signature")
    if util.digest(profile) != record.get("profile_digest"):
        fail("SCOPE_DENIED", "simulation profile content no longer matches its registration")
    if workspace_id is not None and profile["binding"]["workspace_id"] != workspace_id:
        fail("SCOPE_DENIED", "simulation profile belongs to another workspace")
    return record


def _load_module_bytes(state: Any, record: Dict[str, Any]) -> bytes:
    profile = record["profile"]
    module_file = record["module_file"]
    path = _sim_profile_dir(state, profile["profile_id"]) / module_file
    if path.is_symlink() or not path.is_file():
        fail("NOT_FOUND", "registered simulation module is missing")
    try:
        raw = path.read_bytes()
    except OSError:
        fail("DEPENDENCY_UNAVAILABLE", "registered simulation module is not readable")
    if util.sha256_bytes(raw) != record["module_sha256"]:
        fail("STALE_SOURCE", "registered simulation module no longer matches its verified hash")
    return raw


def _read_sim_index(state: Any) -> Dict[str, Any]:
    path = _sim_index_path(state)
    if not path.exists():
        return {"schema_version": 1, "entries": []}
    index = _read_json_file(path, "simulation profile index")
    entries = index.get("entries")
    if not isinstance(entries, list):
        fail("UNSUPPORTED_SCHEMA", "simulation profile index entries are not supported")
    return index


def _write_sim_index(state: Any, entries: List[Dict[str, Any]]) -> None:
    _atomic_write_json(
        _sim_index_path(state),
        {"schema_version": 1, "entries": entries},
    )


# ---------------------------------------------------------------------------
# 1) sim-profile-import / sim-profile-list
# ---------------------------------------------------------------------------
def sim_profile_import(
    state: Any,
    workspace_ref: str,
    variant_id: str,
    repo_id: str,
    profile_name: str,
    operation_id: str,
) -> Dict[str, Any]:
    """Validate a trusted inbox Wasm profile and register it under ``state/sim``."""
    workspace = readmodel._workspace_or_fail(state, workspace_ref)
    workspace_id = workspace["workspace_id"]
    variant = expect_str(variant_id, "variant_id", max_len=64)
    repo = expect_str(repo_id, "repo_id", max_len=64)
    _validate_variant(workspace, variant)
    _validate_repo(workspace, repo)
    name = _single_file_name(profile_name, "profile")
    operation = expect_str(operation_id, "operation_id", max_len=128)
    request_digest = util.digest(
        {
            "operation": "sim-profile-import",
            "workspace_id": workspace_id,
            "variant_id": variant,
            "repo_id": repo,
            "profile": name,
        }
    )
    existing_operation = state.operation_get(operation)
    if existing_operation is not None:
        if existing_operation.get("request_digest") != request_digest:
            fail("OPERATION_CONFLICT", "operation_id was already used for another profile import")
        stored = existing_operation.get("result")
        if not isinstance(stored, dict):
            fail("OPERATION_CONFLICT", "stored operation result is not a profile projection")
        return stored

    profile_path = state.inbox_file(name, max_bytes=MAX_PROFILE_FILE_BYTES)
    try:
        raw_profile = profile_path.read_bytes()
    except OSError:
        fail("DEPENDENCY_UNAVAILABLE", "simulation profile is not readable")
    profile_payload = _json_bytes(raw_profile, "simulation profile")
    validated = _validate_profile(state, profile_payload, workspace, variant, repo)
    profile = validated["profile"]
    profile_id = profile["profile_id"]
    profile_digest = util.digest(profile)
    projection = _profile_projection(validated)

    with state.workspace_lock(workspace_id):
        destination = _sim_profile_dir(state, profile_id)
        existing_path = destination / "profile.json"
        if existing_path.exists():
            existing = _read_json_file(existing_path, "simulation profile")
            if (
                existing.get("profile_digest") != profile_digest
                or existing.get("module_sha256") != validated["module_sha256"]
            ):
                fail("STATE_CONFLICT", "profile_id is already imported with different content")
            stored_projection = existing.get("projection")
            if not isinstance(stored_projection, dict):
                fail("UNSUPPORTED_SCHEMA", "stored simulation profile projection is not supported")
            state.operation_put(operation, request_digest, stored_projection)
            return stored_projection

        util.ensure_dir(destination)
        module_target = destination / f"{validated['module_sha256']}.wasm"
        util.atomic_write(module_target, validated["module_bytes"])
        if util.sha256_file(module_target) != validated["module_sha256"]:
            fail("INTERNAL_ERROR", "simulation module copy failed its own hash check")
        imported_at = util.utc_now_iso()
        record = {
            "schema_version": 1,
            "profile": profile,
            "profile_digest": profile_digest,
            "module_sha256": validated["module_sha256"],
            "module_bytes_len": validated["module_bytes_len"],
            "module_file": module_target.name,
            "projection": projection,
            "imported_at": imported_at,
        }
        record["signature"] = state.sign(
            _profile_signature_payload(record, state.scope_generation)
        )
        _atomic_write_json(existing_path, record)
        index = _read_sim_index(state)
        entries = [
            dict(entry)
            for entry in index.get("entries") or []
            if isinstance(entry, dict) and entry.get("profile_id") != profile_id
        ]
        entries.append(
            {
                "profile_id": profile_id,
                "label": profile["label"],
                "workspace_id": workspace_id,
                "variant_id": variant,
                "repo_id": repo,
                "snapshot_id": profile["binding"]["snapshot_id"],
                "module_sha256": validated["module_sha256"],
                "module_bytes": validated["module_bytes_len"],
                "imported_at": imported_at,
            }
        )
        entries.sort(key=lambda item: str(item.get("profile_id")))
        _write_sim_index(state, entries)
        state.operation_put(operation, request_digest, projection)
        return projection


def sim_profile_list(state: Any, workspace_ref: str) -> Dict[str, Any]:
    """List registered simulation profiles bound to one workspace."""
    workspace = readmodel._workspace_or_fail(state, workspace_ref)
    workspace_id = workspace["workspace_id"]
    index = _read_sim_index(state)
    profiles: List[Dict[str, Any]] = []
    gaps: List[Dict[str, Any]] = []
    for entry in index.get("entries") or []:
        if not isinstance(entry, dict) or entry.get("workspace_id") != workspace_id:
            continue
        profile_id = entry.get("profile_id")
        if not isinstance(profile_id, str):
            continue
        try:
            record = _load_profile_record(state, profile_id, workspace_id=workspace_id)
            _load_module_bytes(state, record)
            profile = record["profile"]
            limitations = list(profile["limitations"])
            profiles.append(
                {
                    "profile_id": profile_id,
                    "label": profile["label"],
                    "kind": profile["kind"],
                    "binding": dict(profile["binding"]),
                    "module_sha256": record["module_sha256"],
                    "module_bytes": record["module_bytes_len"],
                    "interface_count": len(profile["interfaces"]),
                    "interfaces": _interfaces_projection(profile["interfaces"]),
                    "async_events": list(profile.get("async_events") or []),
                    "limits": _plan_limits(),
                    "trace_events": {
                        name: profile["trace"]["events"][name]
                        for name in sorted(profile["trace"]["events"])
                    },
                    "limited": bool(limitations),
                    "limitations": limitations,
                    "status": "verified",
                    "error": None,
                }
            )
        except CodeLearningError as error:
            profiles.append(
                {
                    "profile_id": profile_id,
                    "label": entry.get("label"),
                    "kind": None,
                    "binding": None,
                    "module_sha256": entry.get("module_sha256"),
                    "module_bytes": entry.get("module_bytes"),
                    "interface_count": None,
                    "interfaces": [],
                    "async_events": [],
                    "limits": _plan_limits(),
                    "trace_events": {},
                    "limited": None,
                    "limitations": [],
                    "status": "invalid",
                    "error": {"code": error.code, "message": error.message},
                }
            )
            gaps.append(
                {
                    "code": "sim_profile_invalid",
                    "status": "degraded",
                    "reason": f"profile {profile_id!r} failed re-verification: {error.code}",
                }
            )
    profiles.sort(key=lambda item: str(item.get("profile_id")))
    return {
        "schema_version": SCHEMA_VERSION,
        "workspace_id": workspace_id,
        "profiles": profiles,
        "gaps": gaps,
    }


# ---------------------------------------------------------------------------
# 2) scenario-plan / scenario-module
# ---------------------------------------------------------------------------
def _scenario_digest(profile: Dict[str, Any], scenario: Dict[str, Any]) -> str:
    binding = profile["binding"]
    return util.digest(
        {
            "kind": "scenario",
            "profile_id": profile["profile_id"],
            "module_sha256": profile["module"]["sha256"],
            "workspace_id": binding["workspace_id"],
            "variant_id": binding["variant_id"],
            "repo_id": binding["repo_id"],
            "snapshot_id": binding["snapshot_id"],
            "stop_on_error": scenario["stop_on_error"],
            "steps": [
                {"interface": step["interface"], "args": list(step["args"])}
                for step in scenario["steps"]
            ],
        }
    )


def _validate_scenario(
    state: Any,
    raw: bytes,
    profile: Dict[str, Any],
) -> Dict[str, Any]:
    scenario = _json_bytes(raw, "scenario")
    reject_unknown(scenario, _SCENARIO_KEYS, "scenario")
    generation = expect_int(scenario.get("generation"), "scenario.generation", low=0, high=1 << 31)
    stop_on_error = expect_bool(scenario.get("stop_on_error"), "scenario.stop_on_error")
    raw_steps = expect_array(
        scenario.get("steps"), "scenario.steps", max_items=MAX_STEPS
    )
    interfaces = {item["name"]: item for item in profile["interfaces"]}
    steps: List[Dict[str, Any]] = []
    for index, step in enumerate(raw_steps):
        where = f"scenario.steps[{index}]"
        expect_object(step, where)
        reject_unknown(step, _STEP_KEYS, where)
        interface_name = expect_str(step.get("interface"), f"{where}.interface", max_len=64)
        if interface_name not in interfaces:
            fail(
                "INVALID_ARGUMENT",
                f"{where}.interface is not declared by this simulation profile",
            )
        interface = interfaces[interface_name]
        raw_args = expect_array(step.get("args"), f"{where}.args", max_items=MAX_PARAMS)
        params = interface["params"]
        if len(raw_args) != len(params):
            fail(
                "INVALID_ARGUMENT",
                f"{where}.args must contain exactly {len(params)} argument(s)",
            )
        args: List[int] = []
        for arg_index, (arg, param) in enumerate(zip(raw_args, params)):
            arg_where = f"{where}.args[{arg_index}]"
            if isinstance(arg, bool) or not isinstance(arg, int):
                fail("INVALID_ARGUMENT", f"{arg_where} must be an integer")
            if arg < param["min"] or arg > param["max"]:
                fail(
                    "INVALID_ARGUMENT",
                    f"{arg_where} is outside the declared range [{param['min']}, {param['max']}]",
                )
            if param["type"] == "u32" and (arg < 0 or arg > UINT32_MAX):
                fail("INVALID_ARGUMENT", f"{arg_where} must be an unsigned 32-bit integer")
            if param["type"] == "i32" and (arg < INT32_MIN or arg > INT32_MAX):
                fail("INVALID_ARGUMENT", f"{arg_where} must be a signed 32-bit integer")
            args.append(arg)
        steps.append(
            {
                "interface": interface_name,
                "role": interface["role"],
                "args": args,
            }
        )
    args_bytes = util.canonical_json([step["args"] for step in steps]).encode("utf-8")
    if len(args_bytes) > MAX_ARGS_BYTES:
        fail(
            "LIMIT_EXCEEDED",
            f"scenario arguments are limited to {MAX_ARGS_BYTES} bytes",
            details={"limit": MAX_ARGS_BYTES, "actual": len(args_bytes)},
        )
    scenario_digest = _scenario_digest(
        profile, {"stop_on_error": stop_on_error, "steps": steps}
    )
    scenario_id = "scn_" + scenario_digest[:12]
    return {
        "generation": generation,
        "stop_on_error": stop_on_error,
        "steps": steps,
        "scenario_id": scenario_id,
        "scenario_digest": scenario_digest,
    }


def _plan_limits() -> Dict[str, int]:
    return {
        "timeout_ms": PLAN_TIMEOUT_MS,
        "steps": MAX_STEPS,
        "events_per_step": MAX_EVENTS_PER_STEP,
    }


def _plan_limitations() -> List[str]:
    return [
        "wasm_simulation_not_real_device",
        "executed_in_host_isolated_worker",
    ]


def _plan_projection(plan: Dict[str, Any], plan_id: str) -> Dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "plan_id": plan_id,
        "profile_id": plan["profile_id"],
        "module_sha256": plan["module_sha256"],
        "scenario_id": plan["scenario_id"],
        "scenario_digest": plan["scenario_digest"],
        "generation": plan["generation"],
        "steps": [
            {
                "index": step["index"],
                "interface": step["interface"],
                "role": step["role"],
                "args": list(step["args"]),
            }
            for step in plan["steps"]
        ],
        "trace": {
            "import": dict(plan["trace"]["import"]),
            "signature": list(plan["trace"]["signature"]),
            "events": dict(plan["trace"]["events"]),
        },
        "limits": dict(plan["limits"]),
        "expires_at": plan["expires_at"],
        "limitations": list(plan["limitations"]),
    }


def scenario_plan(
    state: Any,
    workspace_ref: str,
    snapshot_ref: str,
    profile_ref: str,
    scenario_json: str,
    expected_generation: Optional[int] = None,
) -> Dict[str, Any]:
    """Validate one scenario against a registered profile and sign a TTL plan."""
    workspace = readmodel._workspace_or_fail(state, workspace_ref)
    workspace_id = workspace["workspace_id"]
    snapshot_ref = expect_str(snapshot_ref, "snapshot", max_len=128)
    record = _load_profile_record(state, profile_ref, workspace_id=workspace_id)
    profile = record["profile"]
    binding = profile["binding"]
    if binding["snapshot_id"] != snapshot_ref:
        fail(
            "INVALID_ARGUMENT",
            "profile binding snapshot_id does not match --snapshot",
        )
    # The bound snapshot must still be imported and verified.
    _load_binding_bundle(state, workspace_id, binding)
    if expected_generation is not None:
        expected_generation = expect_int(
            expected_generation, "expected_generation", low=0, high=1 << 31
        )
    raw_scenario = _decode_base64(scenario_json, "scenario-json", MAX_SCENARIO_JSON_BYTES)
    scenario = _validate_scenario(state, raw_scenario, profile)
    declared_generation = scenario["generation"]
    current_generation = _current_generation(state, scenario["scenario_id"])
    if expected_generation is None:
        # Contract-style call: scenario.generation is the current ledger
        # generation (CAS); the plan will write generation current + 1.
        if declared_generation != current_generation:
            fail(
                "STATE_CONFLICT",
                "scenario generation does not match the current ledger generation",
                retryable=True,
                details={
                    "current_generation": current_generation,
                    "scenario_generation": declared_generation,
                },
            )
        plan_generation = current_generation + 1
    elif (
        expected_generation == current_generation
        and declared_generation == current_generation
    ):
        # `--expected-generation` as a CAS precondition on the current ledger.
        plan_generation = current_generation + 1
    elif (
        expected_generation == current_generation + 1
        and declared_generation == expected_generation
    ):
        # Host run path: the Host already planned generation N and re-validates
        # it right before execution; the ledger must still be at N - 1.
        plan_generation = expected_generation
    else:
        fail(
            "STATE_CONFLICT",
            "scenario generation is no longer current for this plan",
            retryable=True,
            details={
                "current_generation": current_generation,
                "expected_generation": expected_generation,
                "scenario_generation": declared_generation,
            },
        )
    now = util.utc_now()
    expires_at = now.timestamp() + PLAN_TTL_SECONDS
    plan_sha = util.digest(
        {
            "kind": "scenario_plan_body",
            "scenario_id": scenario["scenario_id"],
            "scenario_digest": scenario["scenario_digest"],
            "generation": plan_generation,
            "profile_id": profile["profile_id"],
            "module_sha256": record["module_sha256"],
            "workspace_id": workspace_id,
            "plan_nonce": util.new_id("plan"),
            "completed_at": util.utc_now_iso(),
        }
    )
    plan_document: Dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "plan_sha256": plan_sha,
        "profile_id": profile["profile_id"],
        "module_sha256": record["module_sha256"],
        "scenario_id": scenario["scenario_id"],
        "scenario_digest": scenario["scenario_digest"],
        "generation": plan_generation,
        "steps": [
            {
                "index": index,
                "interface": step["interface"],
                "role": step["role"],
                "args": list(step["args"]),
            }
            for index, step in enumerate(scenario["steps"])
        ],
        "trace": {
            "import": dict(profile["trace"]["import"]),
            "signature": list(profile["trace"]["signature"]),
            "events": dict(profile["trace"]["events"]),
        },
        "limits": _plan_limits(),
        "created_at": util.utc_now_iso(),
        "expires_at": _iso(expires_at),
        "workspace_id": workspace_id,
        "snapshot_id": binding["snapshot_id"],
        "variant_id": binding["variant_id"],
        "repo_id": binding["repo_id"],
        "limitations": _plan_limitations(),
    }
    plan_id = "plan_" + plan_sha[:32]
    plan_document["signature"] = state.sign(
        {
            "kind": "scenario_plan",
            "sha": plan_sha,
            "id": plan_id,
            "w": workspace_id,
            "p": profile["profile_id"],
            "s": scenario["scenario_id"],
            "g": state.scope_generation,
            "iat": int(now.timestamp()),
            "exp": int(time.time() + PLAN_TTL_SECONDS),
        }
    )
    plan_dir = util.ensure_dir(_plan_root(state))
    _atomic_write_json(plan_dir / f"{plan_id}.json", plan_document)
    return _plan_projection(plan_document, plan_id)


def _iso(timestamp: float) -> str:
    from datetime import datetime, timezone

    return (
        datetime.fromtimestamp(timestamp, tz=timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def _load_plan(state: Any, plan_id: Any) -> Tuple[str, Dict[str, Any]]:
    plan_ref = expect_str(plan_id, "plan", max_len=128)
    if not PLAN_REF_RE.match(plan_ref):
        fail("INVALID_ARGUMENT", "plan has an unsupported format")
    path = _plan_root(state) / f"{plan_ref}.json"
    plan = _read_json_file(path, "scenario plan")
    reject_unknown(plan, _PLAN_KEYS, "scenario plan")
    if plan.get("schema_version") != SCHEMA_VERSION:
        fail("UNSUPPORTED_SCHEMA", "scenario plan schema is not supported")
    plan_kind = plan.get("kind", "scenario")
    if plan_kind not in ("scenario", "undo"):
        fail("UNSUPPORTED_SCHEMA", "scenario plan kind is not supported")
    expected_prefix = "undo_" if plan_kind == "undo" else "plan_"
    if not plan_ref.startswith(expected_prefix):
        fail("STALE_PLAN", "scenario plan id does not match its kind")
    plan["kind"] = plan_kind
    signature = plan.get("signature")
    if not isinstance(signature, str) or not signature:
        fail("STALE_PLAN", "scenario plan is not signed")
    try:
        payload = state.verify(signature, kind="scenario_plan")
    except CodeLearningError as error:
        if error.code in ("STALE_SOURCE", "SCOPE_DENIED"):
            fail("STALE_PLAN", "scenario plan is expired or belongs to another scope")
        raise
    plan_sha = payload.get("sha")
    if not isinstance(plan_sha, str) or not re.match(r"^[0-9a-f]{64}$", plan_sha):
        fail("STALE_PLAN", "scenario plan signature is malformed")
    if payload.get("id") != plan_ref:
        fail("STALE_PLAN", "scenario plan id does not match its signature")
    if plan.get("plan_sha256") != plan_sha:
        fail("STALE_PLAN", "scenario plan file does not match its signed hash")
    if payload.get("w") != plan.get("workspace_id"):
        fail("STALE_PLAN", "scenario plan belongs to another workspace")
    if payload.get("s") != plan.get("scenario_id"):
        fail("STALE_PLAN", "scenario plan scenario id mismatch")
    if payload.get("p") != plan.get("profile_id"):
        fail("STALE_PLAN", "scenario plan profile id mismatch")
    if payload.get("k", "scenario") != plan_kind:
        fail("STALE_PLAN", "scenario plan kind does not match its signature")
    expires_at = plan.get("expires_at")
    if not isinstance(expires_at, str):
        fail("UNSUPPORTED_SCHEMA", "scenario plan expiry is not supported")
    try:
        expires = util.parse_utc(expires_at)
    except (ValueError, TypeError):
        fail("UNSUPPORTED_SCHEMA", "scenario plan expiry is not a timestamp")
    if time.time() > expires.timestamp():
        fail("STALE_PLAN", "scenario plan has expired; request a new plan")
    return plan_ref, plan


def scenario_module(state: Any, plan_ref: Any) -> Dict[str, Any]:
    """Return the isolated-worker payload for one signed plan (no file paths)."""
    token, plan = _load_plan(state, plan_ref)
    record = _load_profile_record(
        state, plan["profile_id"], workspace_id=plan["workspace_id"]
    )
    module_bytes = _load_module_bytes(state, record)
    if record["module_sha256"] != plan["module_sha256"]:
        fail("STALE_PLAN", "scenario plan module hash does not match the registered profile")
    projection = _profile_projection(record)
    return {
        "schema_version": SCHEMA_VERSION,
        "plan_id": token,
        "profile_id": plan["profile_id"],
        "module_sha256": record["module_sha256"],
        "module_bytes": record["module_bytes_len"],
        "module_b64": base64.b64encode(module_bytes).decode("ascii"),
        "profile": projection,
        "trace": {
            "import": dict(projection["trace"]["import"]),
            "signature": list(projection["trace"]["signature"]),
            "events": dict(projection["trace"]["events"]),
        },
        "event_resources": {
            name: [dict(entry) for entry in entries]
            for name, entries in projection["event_resources"].items()
        },
        "limits": dict(plan["limits"]),
        "kind": plan.get("kind", "scenario"),
        "scenario_id": plan["scenario_id"],
        "generation": plan["generation"],
        "prefix": {
            "scenario_id": plan["prefix"]["scenario_id"],
            "generation": plan["prefix"]["generation"],
            "step_count": plan["prefix"]["step_count"],
            "steps": [
                {
                    "index": step["index"],
                    "interface": step["interface"],
                    "args": list(step["args"]),
                }
                for step in plan["prefix"]["steps"]
            ],
        }
        if plan.get("kind") == "undo"
        else None,
        "expires_at": plan["expires_at"],
        "limitations": list(plan["limitations"]),
    }


# ---------------------------------------------------------------------------
# 3) ledger: scenario-record / scenario-list / scenario-get
# ---------------------------------------------------------------------------
def _current_generation(state: Any, scenario_id: str) -> int:
    if not SCENARIO_ID_RE.match(scenario_id):
        fail("INVALID_ARGUMENT", "scenario id has an unsupported format")
    path = _scenario_dir(state, scenario_id) / "current.json"
    if not path.exists():
        return 0
    current = _read_json_file(path, "scenario current generation")
    if current.get("schema_version") != SCHEMA_VERSION:
        fail("UNSUPPORTED_SCHEMA", "scenario current generation is not supported")
    if current.get("scenario_id") != scenario_id:
        fail("UNSUPPORTED_SCHEMA", "scenario current generation identity mismatch")
    return expect_int(current.get("generation"), "current generation", low=1, high=1 << 31)


def _validate_events_block(
    events: Any, profile: Dict[str, Any], where: str
) -> List[Dict[str, Any]]:
    raw = expect_array(events, f"{where}.events", max_items=MAX_EVENTS_PER_STEP)
    known = profile["trace"]["events"]
    normalized: List[Dict[str, Any]] = []
    for index, event in enumerate(raw):
        event_where = f"{where}.events[{index}]"
        expect_object(event, event_where)
        reject_unknown(event, _EVENT_KEYS, event_where)
        name = expect_str(event.get("event"), f"{event_where}.event", max_len=64)
        if name not in known:
            fail("INVALID_ARGUMENT", f"{event_where}.event is not declared by this profile")
        code = _int32(event.get("code"), f"{event_where}.code")
        a = _int32(event.get("a"), f"{event_where}.a")
        b = _int32(event.get("b"), f"{event_where}.b")
        c = _int32(event.get("c"), f"{event_where}.c")
        line = _int32(event.get("line"), f"{event_where}.line")
        normalized.append(
            {"event": name, "code": code, "a": a, "b": b, "c": c, "line": line}
        )
    return normalized


def _derive_affected_resources(
    profile: Dict[str, Any], events: Sequence[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    resources: List[Dict[str, Any]] = []
    seen: Set[Tuple[Any, ...]] = set()
    table = profile["event_resources"]
    for event in events:
        for entry in table.get(event["event"], []):
            item: Dict[str, Any] = {
                "resource_id": entry["resource_id"],
                "name": entry.get("name"),
                "access": entry["access"],
            }
            if entry.get("field") is not None:
                item["field"] = entry["field"]
            key = (item["resource_id"], item["access"], item.get("field"))
            if key in seen:
                continue
            seen.add(key)
            resources.append(item)
    return resources


def _validate_records(
    raw: bytes, plan: Dict[str, Any], profile: Dict[str, Any]
) -> List[Dict[str, Any]]:
    document = _json_bytes(raw, "records-json")
    reject_unknown(document, _RECORDS_DOC_KEYS, "records-json")
    records = expect_array(document.get("records"), "records", max_items=MAX_STEPS)
    plan_steps = plan["steps"]
    if len(records) != len(plan_steps):
        fail(
            "INVALID_ARGUMENT",
            "records must match the plan steps one-to-one",
            details={"expected": len(plan_steps), "actual": len(records)},
        )
    normalized: List[Dict[str, Any]] = []
    for index, record in enumerate(records):
        where = f"records[{index}]"
        expect_object(record, where)
        reject_unknown(record, _RECORD_KEYS, where)
        step = plan_steps[index]
        step_index = expect_int(record.get("step_index"), f"{where}.step_index", low=0, high=MAX_STEPS)
        if step_index != index:
            fail("INVALID_ARGUMENT", f"{where}.step_index must equal {index}")
        interface = expect_str(record.get("interface"), f"{where}.interface", max_len=64)
        if interface != step["interface"]:
            fail("INVALID_ARGUMENT", f"{where}.interface does not match the plan step")
        args = expect_array(record.get("args"), f"{where}.args", max_items=MAX_PARAMS)
        normalized_args: List[int] = []
        for arg_index, arg in enumerate(args):
            if isinstance(arg, bool) or not isinstance(arg, int):
                fail("INVALID_ARGUMENT", f"{where}.args[{arg_index}] must be an integer")
            _int32(arg, f"{where}.args[{arg_index}]")
            normalized_args.append(arg)
        if normalized_args != list(step["args"]):
            fail("INVALID_ARGUMENT", f"{where}.args do not match the plan step")
        status = one_of(record.get("status"), ("ok", "error"), f"{where}.status")
        result = record.get("result")
        if result is not None:
            result = _int32(result, f"{where}.result")
        memory_digest = expect_str(record.get("memory_digest"), f"{where}.memory_digest", max_len=64)
        if not MEMORY_DIGEST_RE.match(memory_digest):
            fail("INVALID_ARGUMENT", f"{where}.memory_digest must be a lowercase SHA256")
        elapsed_ms = record.get("elapsed_ms")
        if elapsed_ms is not None:
            elapsed_ms = expect_int(elapsed_ms, f"{where}.elapsed_ms", low=0, high=3_600_000)
        events = _validate_events_block(record.get("events"), profile, where)
        normalized.append(
            {
                "step_index": step_index,
                "interface": interface,
                "args": normalized_args,
                "status": status,
                "result": result,
                "memory_digest": memory_digest,
                "events": events,
                "role": step["role"],
            }
        )
    return normalized


def _scenario_ledger_payload(
    ledger: Dict[str, Any],
    generation: int,
    records_digest: str,
    created_at: str,
    scope_generation: int,
) -> Dict[str, Any]:
    return {
        "kind": "scenario_ledger",
        "s": ledger["scenario_id"],
        "n": generation,
        "d": records_digest,
        "w": ledger["workspace_id"],
        "g": scope_generation,
    }


def _sign_ledger(state: Any, ledger: Dict[str, Any]) -> str:
    payload = _scenario_ledger_payload(
        ledger,
        ledger["generation"],
        ledger["records_digest"],
        ledger["created_at"],
        state.scope_generation,
    )
    return state.sign(payload)


def _verify_ledger_signature(state: Any, ledger: Dict[str, Any]) -> None:
    signature = ledger.get("signature")
    if not isinstance(signature, str) or not signature:
        fail("SCOPE_DENIED", "scenario ledger is not signed")
    try:
        payload = state.verify(signature, kind="scenario_ledger")
    except CodeLearningError as error:
        fail("SCOPE_DENIED", f"scenario ledger signature is not trusted: {error.code}")
    expected = _scenario_ledger_payload(
        ledger,
        ledger["generation"],
        ledger["records_digest"],
        ledger["created_at"],
        state.scope_generation,
    )
    for key, value in expected.items():
        if payload.get(key) != value:
            fail("SCOPE_DENIED", "scenario ledger does not match its signature")


def _read_ledger(state: Any, scenario_ref: str) -> Dict[str, Any]:
    scenario_id = expect_str(scenario_ref, "scenario", max_len=64)
    if not SCENARIO_ID_RE.match(scenario_id):
        fail("INVALID_ARGUMENT", "scenario has an unsupported format")
    current = _read_json_file(
        _scenario_dir(state, scenario_id) / "current.json", "scenario current generation"
    )
    generation = expect_int(
        current.get("generation"), "current generation", low=1, high=1 << 31
    )
    path = _scenario_dir(state, scenario_id) / f"generation-{generation}.json"
    ledger = _read_json_file(path, "scenario ledger generation")
    reject_unknown(ledger, _LEDGER_KEYS, "scenario ledger")
    if ledger.get("schema_version") != SCHEMA_VERSION:
        fail("UNSUPPORTED_SCHEMA", "scenario ledger schema is not supported")
    if ledger.get("scenario_id") != scenario_id or ledger.get("generation") != generation:
        fail("UNSUPPORTED_SCHEMA", "scenario ledger identity mismatch")
    if util.digest(ledger.get("records")) != ledger.get("records_digest"):
        fail("STALE_SOURCE", "scenario ledger records digest does not match its records")
    _verify_ledger_signature(state, ledger)
    return ledger


def _ledger_records(
    records: Sequence[Dict[str, Any]], generation: int
) -> List[Dict[str, Any]]:
    ledger_records: List[Dict[str, Any]] = []
    for record in records:
        step_index = record["step_index"]
        ledger_records.append(
            {
                "call_id": f"call_{generation}_{step_index + 1}",
                "step_index": step_index,
                "interface": record["interface"],
                "args": list(record["args"]),
                "status": record["status"],
                "result": record["result"],
                "memory_digest": record["memory_digest"],
                "affected_resources": list(record.get("affected_resources") or []),
                "stubbed": record.get("role") == "stub_control",
                "execution_events": [
                    {
                        "event_id": f"ev_{generation}_{step_index}_{event_index}",
                        **dict(event),
                    }
                    for event_index, event in enumerate(record.get("events") or [])
                ],
            }
        )
    return ledger_records


def _publish_generation(
    state: Any,
    *,
    scenario_id: str,
    generation: int,
    profile_id: Optional[str],
    workspace_id: str,
    snapshot_id: str,
    variant_id: Optional[str],
    repo_id: Optional[str],
    scenario_digest: str,
    plan_id: Optional[str],
    module_sha256: Optional[str],
    records: Sequence[Dict[str, Any]],
    limitations: Sequence[str],
    extra_ledger: Optional[Dict[str, Any]] = None,
    current_extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Append one immutable, signed ledger generation with a CAS precondition."""
    with state.workspace_lock(workspace_id):
        current_generation = _current_generation(state, scenario_id)
        if current_generation != generation - 1:
            fail(
                "STATE_CONFLICT",
                "scenario generation is no longer current for this plan",
                retryable=True,
                details={
                    "current_generation": current_generation,
                    "plan_generation": generation,
                },
            )
        scenario_dir = util.ensure_dir(_scenario_dir(state, scenario_id))
        generation_path = scenario_dir / f"generation-{generation}.json"
        if generation_path.exists():
            fail(
                "STATE_CONFLICT",
                "scenario generation is already recorded and immutable",
                details={"generation": generation},
            )
        created_at = util.utc_now_iso()
        ledger_records = _ledger_records(records, generation)
        try:
            records_digest = util.digest(ledger_records)
        except (TypeError, ValueError):
            fail("INTERNAL_ERROR", "scenario records are not canonicalizable")
        ledger: Dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "scenario_id": scenario_id,
            "generation": generation,
            "profile_id": profile_id,
            "workspace_id": workspace_id,
            "snapshot_id": snapshot_id,
            "variant_id": variant_id,
            "repo_id": repo_id,
            "scenario_digest": scenario_digest,
            "records_digest": records_digest,
            "plan_id": plan_id,
            "module_sha256": module_sha256,
            "observed": True,
            "created_at": created_at,
            "records": ledger_records,
            "limitations": list(limitations),
        }
        if extra_ledger:
            ledger.update(extra_ledger)
        ledger["signature"] = _sign_ledger(state, ledger)
        _atomic_write_json(generation_path, ledger)
        current: Dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "scenario_id": scenario_id,
            "generation": generation,
            "profile_id": profile_id,
            "workspace_id": workspace_id,
            "snapshot_id": snapshot_id,
            "variant_id": variant_id,
            "repo_id": repo_id,
            "records_digest": records_digest,
            "step_count": len(ledger_records),
            "created_at": created_at,
            "updated_at": created_at,
        }
        if current_extra:
            current.update(current_extra)
        _atomic_write_json(scenario_dir / "current.json", current)
        return ledger


def scenario_record(
    state: Any, plan_ref: Any, records_json: str, operation_id: str
) -> Dict[str, Any]:
    """Validate worker records and append one immutable ledger generation."""
    token, plan = _load_plan(state, plan_ref)
    if plan.get("kind", "scenario") != "scenario":
        fail("INVALID_ARGUMENT", "scenario-record requires a scenario plan, not an undo plan")
    operation = expect_str(operation_id, "operation_id", max_len=128)
    raw_records = _decode_base64(records_json, "records-json", MAX_RECORDS_JSON_BYTES)
    request_digest = util.digest(
        {
            "operation": "scenario-record",
            "plan_sha256": plan["plan_sha256"],
            "records_sha256": util.sha256_bytes(raw_records),
            "generation": plan["generation"],
        }
    )
    existing_operation = state.operation_get(operation)
    if existing_operation is not None:
        if existing_operation.get("request_digest") != request_digest:
            fail("OPERATION_CONFLICT", "operation_id was already used for different records")
        stored = existing_operation.get("result")
        if not isinstance(stored, dict):
            fail("OPERATION_CONFLICT", "stored operation result is not a scenario ledger")
        return stored
    record = _load_profile_record(
        state, plan["profile_id"], workspace_id=plan["workspace_id"]
    )
    profile = record["profile"]
    if record["module_sha256"] != plan["module_sha256"]:
        fail("STALE_PLAN", "scenario plan module hash no longer matches the profile")
    normalized = _validate_records(raw_records, plan, profile)
    for item in normalized:
        item["affected_resources"] = _derive_affected_resources(profile, item["events"])
    ledger = _publish_generation(
        state,
        scenario_id=plan["scenario_id"],
        generation=plan["generation"],
        profile_id=plan["profile_id"],
        workspace_id=plan["workspace_id"],
        snapshot_id=plan["snapshot_id"],
        variant_id=plan.get("variant_id"),
        repo_id=plan.get("repo_id"),
        scenario_digest=plan["scenario_digest"],
        plan_id=token,
        module_sha256=plan["module_sha256"],
        records=normalized,
        limitations=["wasm_simulation_not_real_device"],
    )
    state.operation_put(operation, request_digest, ledger)
    return ledger


# ---------------------------------------------------------------------------
# 3b) undo tail / prefix replay (scenario-s3b-contract section 1)
# ---------------------------------------------------------------------------
def _profile_interface_roles(profile: Dict[str, Any]) -> Dict[str, str]:
    return {interface["name"]: interface["role"] for interface in profile["interfaces"]}


def _ledger_step_entries(
    ledger: Dict[str, Any], role_map: Dict[str, str]
) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []
    for index, record in enumerate(ledger["records"]):
        interface = record["interface"]
        entries.append(
            {
                "index": index,
                "interface": interface,
                "args": list(record.get("args") or []),
                "role": role_map.get(interface, "util"),
            }
        )
    return entries


def _prefix_scenario_digest(
    profile: Dict[str, Any], prefix_steps: Sequence[Dict[str, Any]]
) -> str:
    return _scenario_digest(
        profile,
        {
            "stop_on_error": True,
            "steps": [
                {"interface": step["interface"], "args": list(step["args"])}
                for step in prefix_steps
            ],
        },
    )


def _undo_limitations() -> List[str]:
    return ["replay_verified_by_memory_digest", "wasm_simulation_not_real_device"]


def scenario_undo_plan(
    state: Any,
    workspace_ref: str,
    scenario_ref: str,
    count: int,
    expected_generation: int,
) -> Dict[str, Any]:
    """Create a signed undo plan for the last ``count`` steps of one ledger."""
    workspace = readmodel._workspace_or_fail(state, workspace_ref)
    workspace_id = workspace["workspace_id"]
    ledger = _read_ledger(state, scenario_ref)
    if ledger.get("workspace_id") != workspace_id:
        fail("SCOPE_DENIED", "scenario belongs to another workspace")
    if ledger.get("imported") is True:
        fail(
            "CAPABILITY_UNAVAILABLE",
            "imported trace ledgers cannot be undone: there is no replayable simulation prefix",
        )
    expected_generation = expect_int(
        expected_generation, "expected_generation", low=1, high=1 << 31
    )
    if ledger["generation"] != expected_generation:
        fail(
            "STATE_CONFLICT",
            "scenario generation does not match --expected-generation",
            retryable=True,
            details={
                "current_generation": ledger["generation"],
                "expected_generation": expected_generation,
            },
        )
    source_records = ledger["records"]
    step_count = len(source_records)
    if step_count == 0:
        fail("CAPABILITY_UNAVAILABLE", "scenario ledger has no recorded steps to undo")
    count = expect_int(count, "count", low=1, high=step_count)
    record = _load_profile_record(
        state, ledger["profile_id"], workspace_id=workspace_id
    )
    profile = record["profile"]
    role_map = _profile_interface_roles(profile)
    all_steps = _ledger_step_entries(ledger, role_map)
    prefix_steps = all_steps[: step_count - count]
    for step in prefix_steps:
        if step["interface"] not in role_map:
            fail(
                "CAPABILITY_UNAVAILABLE",
                "the selected simulation profile does not declare a prefix interface",
            )
    prefix_digest = _prefix_scenario_digest(profile, prefix_steps)
    prefix_scenario_id = "scn_" + prefix_digest[:12]
    prefix_current = _current_generation(state, prefix_scenario_id)
    prefix_generation = prefix_current + 1
    expected_prefix = [
        {
            "step_index": index,
            "memory_digest": source_records[index].get("memory_digest"),
            "result": source_records[index].get("result"),
            "status": source_records[index].get("status"),
        }
        for index in range(len(prefix_steps))
    ]
    source = {
        "scenario_id": ledger["scenario_id"],
        "generation": ledger["generation"],
        "step_count": step_count,
    }
    now = util.utc_now()
    expires_at = _iso(now.timestamp() + PLAN_TTL_SECONDS)
    plan_sha = util.digest(
        {
            "kind": "undo_plan_body",
            "source": source,
            "count": count,
            "prefix_scenario_id": prefix_scenario_id,
            "prefix_generation": prefix_generation,
            "profile_id": profile["profile_id"],
            "module_sha256": record["module_sha256"],
            "plan_nonce": util.new_id("undo"),
            "completed_at": util.utc_now_iso(),
        }
    )
    undo_plan_id = "undo_" + plan_sha[:32]
    plan_document: Dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "kind": "undo",
        "plan_sha256": plan_sha,
        "undo_plan_id": undo_plan_id,
        "source": source,
        "count": count,
        "prefix": {
            "scenario_id": prefix_scenario_id,
            "generation": prefix_generation,
            "step_count": len(prefix_steps),
            "steps": [
                {
                    "index": step["index"],
                    "interface": step["interface"],
                    "args": list(step["args"]),
                }
                for step in prefix_steps
            ],
            "scenario_digest": prefix_digest,
            "expected_records_digest": util.digest(expected_prefix),
        },
        "expected_prefix": expected_prefix,
        "profile_id": profile["profile_id"],
        "module_sha256": record["module_sha256"],
        "scenario_id": prefix_scenario_id,
        "generation": prefix_generation,
        "workspace_id": workspace_id,
        "snapshot_id": ledger["snapshot_id"],
        "variant_id": ledger.get("variant_id"),
        "repo_id": ledger.get("repo_id"),
        "limits": _plan_limits(),
        "created_at": util.utc_now_iso(),
        "expires_at": expires_at,
        "limitations": _undo_limitations(),
    }
    plan_document["signature"] = state.sign(
        {
            "kind": "scenario_plan",
            "k": "undo",
            "sha": plan_sha,
            "id": undo_plan_id,
            "w": workspace_id,
            "p": profile["profile_id"],
            "s": prefix_scenario_id,
            "g": state.scope_generation,
            "iat": int(now.timestamp()),
            "exp": int(time.time() + PLAN_TTL_SECONDS),
        }
    )
    _atomic_write_json(_plan_root(state) / f"{undo_plan_id}.json", plan_document)
    return {
        "schema_version": SCHEMA_VERSION,
        "undo_plan_id": undo_plan_id,
        "kind": "undo",
        "source": dict(source),
        "count": count,
        "prefix": {
            "scenario_id": prefix_scenario_id,
            "generation": prefix_generation,
            "step_count": len(prefix_steps),
            "steps": [
                {
                    "index": step["index"],
                    "interface": step["interface"],
                    "args": list(step["args"]),
                }
                for step in prefix_steps
            ],
            "scenario_digest": prefix_digest,
            "expected_records_digest": util.digest(expected_prefix),
        },
        "expected_prefix": expected_prefix,
        "profile_id": profile["profile_id"],
        "module_sha256": record["module_sha256"],
        "limits": _plan_limits(),
        "expires_at": expires_at,
        "limitations": _undo_limitations(),
    }


def scenario_undo_record(
    state: Any, plan_ref: Any, records_json: str, operation_id: str
) -> Dict[str, Any]:
    """Verify the replayed prefix state digests and publish the prefix generation."""
    token, plan = _load_plan(state, plan_ref)
    if plan.get("kind") != "undo":
        fail("INVALID_ARGUMENT", "scenario-undo-record requires an undo plan")
    operation = expect_str(operation_id, "operation_id", max_len=128)
    raw_records = _decode_base64(records_json, "records-json", MAX_RECORDS_JSON_BYTES)
    request_digest = util.digest(
        {
            "operation": "scenario-undo-record",
            "plan_sha256": plan["plan_sha256"],
            "records_sha256": util.sha256_bytes(raw_records),
            "generation": plan["prefix"]["generation"],
        }
    )
    existing_operation = state.operation_get(operation)
    if existing_operation is not None:
        if existing_operation.get("request_digest") != request_digest:
            fail("OPERATION_CONFLICT", "operation_id was already used for different records")
        stored = existing_operation.get("result")
        if not isinstance(stored, dict):
            fail("OPERATION_CONFLICT", "stored operation result is not a scenario ledger")
        return stored
    record = _load_profile_record(
        state, plan["profile_id"], workspace_id=plan["workspace_id"]
    )
    profile = record["profile"]
    if record["module_sha256"] != plan["module_sha256"]:
        fail("STALE_PLAN", "undo plan module hash no longer matches the profile")
    prefix = plan["prefix"]
    role_map = _profile_interface_roles(profile)
    plan_like = {
        "steps": [
            {
                "index": step["index"],
                "interface": step["interface"],
                "args": list(step["args"]),
                "role": role_map.get(step["interface"], "util"),
            }
            for step in prefix["steps"]
        ]
    }
    normalized = _validate_records(raw_records, plan_like, profile)
    expected_prefix = plan["expected_prefix"]
    for index, item in enumerate(normalized):
        expected_digest = expected_prefix[index]["memory_digest"]
        if item["memory_digest"] != expected_digest:
            expected_chain = [
                entry["memory_digest"] for entry in expected_prefix[: index + 1]
            ]
            actual_chain = [
                normalized[prefix_index]["memory_digest"]
                for prefix_index in range(index + 1)
            ]
            fail(
                "STATE_CONFLICT",
                "replayed prefix memory digest mismatch; no ledger generation was published",
                retryable=True,
                details={
                    "code": "state_digest_mismatch",
                    "reason_code": "state_digest_mismatch",
                    "step_index": index,
                    "expected": expected_digest,
                    "actual": item["memory_digest"],
                    "expected_prefix": expected_chain,
                    "actual_prefix": actual_chain,
                },
            )
    for item in normalized:
        item["affected_resources"] = _derive_affected_resources(profile, item["events"])
    undo_meta = {
        "of_scenario_id": plan["source"]["scenario_id"],
        "of_generation": plan["source"]["generation"],
        "count": plan["count"],
        "state_digest_verified": True,
    }
    ledger = _publish_generation(
        state,
        scenario_id=prefix["scenario_id"],
        generation=prefix["generation"],
        profile_id=plan["profile_id"],
        workspace_id=plan["workspace_id"],
        snapshot_id=plan["snapshot_id"],
        variant_id=plan.get("variant_id"),
        repo_id=plan.get("repo_id"),
        scenario_digest=prefix["scenario_digest"],
        plan_id=token,
        module_sha256=plan["module_sha256"],
        records=normalized,
        limitations=_undo_limitations(),
        extra_ledger={"undo": undo_meta},
        current_extra={"undo": undo_meta},
    )
    state.operation_put(operation, request_digest, ledger)
    return ledger


# ---------------------------------------------------------------------------
# 3c) trace import (scenario-s3b-contract section 2)
# ---------------------------------------------------------------------------
def _reject_absolute_path_text(value: str, label: str) -> str:
    if ABSOLUTE_PATH_RE.match(value.strip()):
        fail("INVALID_ARGUMENT", f"{label} must not contain absolute paths")
    return value


def _validate_trace_metadata(metadata: Any) -> Dict[str, Any]:
    if metadata is None:
        return {}
    expect_object(metadata, "metadata")
    if len(metadata) > MAX_TRACE_METADATA_KEYS:
        fail("LIMIT_EXCEEDED", f"metadata is limited to {MAX_TRACE_METADATA_KEYS} keys")
    normalized: Dict[str, Any] = {}
    for key, value in metadata.items():
        if not isinstance(key, str) or not METADATA_KEY_RE.match(key):
            fail("INVALID_ARGUMENT", "metadata keys have an unsupported format")
        if value is None or isinstance(value, bool):
            normalized[key] = value
        elif isinstance(value, int):
            normalized[key] = value
        elif isinstance(value, str):
            normalized[key] = _reject_absolute_path_text(
                expect_str(value, f"metadata.{key}", max_len=MAX_TRACE_METADATA_STRING),
                f"metadata.{key}",
            )
        else:
            fail("INVALID_ARGUMENT", f"metadata.{key} must be a scalar value")
    if len(util.canonical_json(normalized).encode("utf-8")) > 2048:
        fail("LIMIT_EXCEEDED", "metadata is limited to 2048 canonical JSON bytes")
    return normalized


def _validate_imported_trace_step(step: Any, index: int) -> Dict[str, Any]:
    where = f"steps[{index}]"
    expect_object(step, where)
    reject_unknown(step, _TRACE_STEP_KEYS, where)
    interface = expect_str(step.get("interface"), f"{where}.interface", max_len=64)
    if not INTERFACE_NAME_RE.match(interface):
        fail("INVALID_ARGUMENT", f"{where}.interface has an unsupported format")
    args = expect_array(step.get("args", []), f"{where}.args", max_items=MAX_PARAMS)
    normalized_args: List[int] = []
    for arg_index, arg in enumerate(args):
        if isinstance(arg, bool) or not isinstance(arg, int):
            fail("INVALID_ARGUMENT", f"{where}.args[{arg_index}] must be an integer")
        normalized_args.append(_int32(arg, f"{where}.args[{arg_index}]"))
    status = one_of(step.get("status"), ("ok", "error"), f"{where}.status")
    result = step.get("result")
    if result is not None:
        result = _int32(result, f"{where}.result")
    memory_digest = step.get("memory_digest")
    if memory_digest is not None:
        memory_digest = expect_str(
            memory_digest, f"{where}.memory_digest", max_len=64
        )
        if not MEMORY_DIGEST_RE.match(memory_digest):
            fail("INVALID_ARGUMENT", f"{where}.memory_digest must be a lowercase SHA256")
    elapsed_ms = step.get("elapsed_ms")
    if elapsed_ms is not None:
        elapsed_ms = expect_int(
            elapsed_ms, f"{where}.elapsed_ms", low=0, high=3_600_000
        )
    raw_events = expect_array(
        step.get("events", []), f"{where}.events", max_items=MAX_EVENTS_PER_STEP
    )
    events: List[Dict[str, Any]] = []
    for event_index, event in enumerate(raw_events):
        event_where = f"{where}.events[{event_index}]"
        expect_object(event, event_where)
        reject_unknown(event, _EVENT_KEYS, event_where)
        name = expect_str(event.get("event"), f"{event_where}.event", max_len=64)
        if not EVENT_RE.match(name):
            fail("INVALID_ARGUMENT", f"{event_where}.event has an unsupported format")
        events.append(
            {
                "event": name,
                "code": _int32(event.get("code"), f"{event_where}.code"),
                "a": _int32(event.get("a"), f"{event_where}.a"),
                "b": _int32(event.get("b"), f"{event_where}.b"),
                "c": _int32(event.get("c"), f"{event_where}.c"),
                "line": _int32(event.get("line"), f"{event_where}.line"),
            }
        )
    return {
        "step_index": index,
        "interface": interface,
        "args": normalized_args,
        "status": status,
        "result": result,
        "memory_digest": memory_digest,
        "elapsed_ms": elapsed_ms,
        "events": events,
    }


def trace_import(
    state: Any,
    workspace_ref: str,
    snapshot_ref: str,
    input_name: str,
    operation_id: str,
) -> Dict[str, Any]:
    """Validate an inbox trace file and register it as a read-only imported ledger."""
    workspace = readmodel._workspace_or_fail(state, workspace_ref)
    workspace_id = workspace["workspace_id"]
    snapshot_id = expect_str(snapshot_ref, "snapshot", max_len=128)
    bundle = snapshot.load_snapshot_bundle(state, workspace_id, snapshot_id)
    if bundle.get("freshness") == "unknown" or not isinstance(bundle.get("graph"), dict):
        fail("STALE_SNAPSHOT", "imported trace snapshot is missing or unreadable")
    name = _single_file_name(input_name, "input")
    operation = expect_str(operation_id, "operation_id", max_len=128)
    path = state.inbox_file(name, max_bytes=MAX_IMPORTED_TRACE_BYTES)
    try:
        raw = path.read_bytes()
    except OSError:
        fail("DEPENDENCY_UNAVAILABLE", "imported trace file is not readable")
    document = _json_bytes(raw, "imported trace")
    reject_unknown(document, _IMPORTED_TRACE_KEYS, "imported trace")
    if document.get("schema_version") != 1:
        fail("UNSUPPORTED_SCHEMA", "imported trace schema_version must be 1")
    if document.get("kind") != "imported_trace":
        fail("INVALID_ARGUMENT", "imported trace kind must be 'imported_trace'")
    label = _reject_absolute_path_text(
        expect_str(document.get("label"), "label", max_len=256), "label"
    )
    trace_snapshot = expect_str(document.get("snapshot_id"), "snapshot_id", max_len=128)
    if trace_snapshot != snapshot_id:
        fail("INVALID_ARGUMENT", "imported trace snapshot_id does not match --snapshot")
    metadata = _validate_trace_metadata(document.get("metadata"))
    profile_id = document.get("profile_id")
    profile_record: Optional[Dict[str, Any]] = None
    if profile_id is not None:
        profile_id = expect_str(profile_id, "profile_id", max_len=64)
        if not PROFILE_ID_RE.match(profile_id):
            fail("INVALID_ARGUMENT", "profile_id has an unsupported format")
        profile_record = _load_profile_record(
            state, profile_id, workspace_id=workspace_id
        )
        if profile_record["profile"]["binding"]["snapshot_id"] != snapshot_id:
            fail(
                "INVALID_ARGUMENT",
                "imported trace profile is not bound to the requested snapshot",
            )
    raw_steps = expect_array(
        document.get("steps"), "steps", min_items=1, max_items=MAX_IMPORTED_TRACE_STEPS
    )
    steps = [
        _validate_imported_trace_step(step, index)
        for index, step in enumerate(raw_steps)
    ]
    trace_event_names: Set[str] = {
        event["event"] for step in steps for event in step["events"]
    }
    async_events = _validate_async_event_names(
        document.get("async_events", []), trace_event_names, "async_events"
    )
    digest_payload: Dict[str, Any] = {
        "kind": "imported_trace",
        "snapshot_id": snapshot_id,
        "steps": steps,
    }
    if async_events:
        digest_payload["async_events"] = async_events
    scenario_digest = util.digest(digest_payload)
    scenario_id = "scn_" + scenario_digest[:12]
    request_digest = util.digest(
        {
            "operation": "trace-import",
            "workspace_id": workspace_id,
            "snapshot_id": snapshot_id,
            "input": name,
            "scenario_id": scenario_id,
        }
    )
    existing_operation = state.operation_get(operation)
    if existing_operation is not None:
        if existing_operation.get("request_digest") != request_digest:
            fail("OPERATION_CONFLICT", "operation_id was already used for another trace import")
        stored = existing_operation.get("result")
        if not isinstance(stored, dict):
            fail("OPERATION_CONFLICT", "stored operation result is not a scenario ledger")
        return stored
    existing_generation = _current_generation(state, scenario_id)
    if existing_generation >= 1:
        ledger = _read_ledger(state, scenario_id)
        state.operation_put(operation, request_digest, ledger)
        return ledger
    for step in steps:
        step["role"] = "util"
        step["affected_resources"] = []
    limitations = [
        "imported_trace_not_executed_by_host",
        "resource_effects_unknown_for_imported_trace",
    ]
    if async_events:
        limitations.append("async_events_declared")
    ledger = _publish_generation(
        state,
        scenario_id=scenario_id,
        generation=1,
        profile_id=profile_id,
        workspace_id=workspace_id,
        snapshot_id=snapshot_id,
        variant_id=bundle.get("variant_id"),
        repo_id=bundle.get("repo_id"),
        scenario_digest=scenario_digest,
        plan_id=None,
        module_sha256=(
            profile_record["module_sha256"] if profile_record is not None else None
        ),
        records=steps,
        limitations=limitations,
        extra_ledger={
            "imported": True,
            "source": "imported_trace",
            "label": label,
            "metadata": metadata,
            **({"async_events": async_events} if async_events else {}),
        },
        current_extra={
            "imported": True,
            "source": "imported_trace",
            "label": label,
        },
    )
    state.operation_put(operation, request_digest, ledger)
    return ledger


def scenario_list(state: Any, workspace_ref: str) -> Dict[str, Any]:
    """Ledger summaries for one workspace."""
    workspace = readmodel._workspace_or_fail(state, workspace_ref)
    workspace_id = workspace["workspace_id"]
    root = _scenario_root(state)
    scenarios: List[Dict[str, Any]] = []
    gaps: List[Dict[str, Any]] = []
    if root.exists():
        for entry in sorted(root.iterdir(), key=lambda item: item.name):
            if not entry.is_dir():
                continue
            current_path = entry / "current.json"
            if not current_path.exists():
                continue
            try:
                current = _read_json_file(current_path, "scenario current generation")
                if current.get("workspace_id") != workspace_id:
                    continue
                scenarios.append(
                    {
                        "scenario_id": current.get("scenario_id"),
                        "profile_id": current.get("profile_id"),
                        "generation": expect_int(
                            current.get("generation"), "current generation", low=1, high=1 << 31
                        ),
                        "step_count": expect_int(
                            current.get("step_count", 0), "step_count", low=0, high=1 << 31
                        ),
                        "records_digest": current.get("records_digest"),
                        "snapshot_id": current.get("snapshot_id"),
                        "created_at": current.get("created_at"),
                        "updated_at": current.get("updated_at"),
                        "observed": True,
                        "imported": current.get("imported") is True,
                        "label": current.get("label"),
                        "source": current.get("source"),
                        "undo": current.get("undo"),
                    }
                )
            except CodeLearningError as error:
                gaps.append(
                    {
                        "code": "scenario_ledger_invalid",
                        "status": "degraded",
                        "reason": f"ledger entry {entry.name!r} is not usable: {error.code}",
                    }
                )
    scenarios.sort(key=lambda item: str(item.get("scenario_id")))
    return {
        "schema_version": SCHEMA_VERSION,
        "workspace_id": workspace_id,
        "scenarios": scenarios,
        "gaps": gaps,
    }


def scenario_get(state: Any, workspace_ref: str, scenario_ref: str) -> Dict[str, Any]:
    """Current immutable generation projection of one scenario ledger."""
    workspace = readmodel._workspace_or_fail(state, workspace_ref)
    ledger = _read_ledger(state, scenario_ref)
    if ledger.get("workspace_id") != workspace["workspace_id"]:
        fail("SCOPE_DENIED", "scenario belongs to another workspace")
    return ledger


# ---------------------------------------------------------------------------
# 4) view-sequence-observed
# ---------------------------------------------------------------------------
def _load_ledger_bundle(state: Any, ledger: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    try:
        bundle = snapshot.load_snapshot_bundle(
            state, ledger["workspace_id"], ledger["snapshot_id"]
        )
    except CodeLearningError:
        return None
    if bundle.get("freshness") == "unknown" or not isinstance(bundle.get("graph"), dict):
        return None
    return bundle


def _observed_source_refs(
    state: Any, ledger: Dict[str, Any], profile: Dict[str, Any]
) -> Tuple[Dict[str, Dict[str, Any]], Set[str], Dict[str, str]]:
    """Entry interface source refs, driver files and resource object files."""
    bundle = _load_ledger_bundle(state, ledger)
    if bundle is None:
        return {}, set(), {}
    graph = bundle["graph"]
    evidence = atlas.evidence_by_id(graph)
    functions = atlas.functions_by_id(graph)
    workspace = readmodel._workspace_or_fail(state, ledger["workspace_id"])
    roots = readmodel._repo_roots(state, workspace)
    repo_id = readmodel._bundle_repo_id(bundle)
    source_refs: Dict[str, Dict[str, Any]] = {}
    driver_files: Set[str] = set()
    for interface in profile["interfaces"]:
        entry_id = interface.get("entry_id")
        if not isinstance(entry_id, str) or entry_id not in functions:
            continue
        function = functions[entry_id]
        raw_file, line = atlas.function_location(graph, function, evidence)
        relative, _file_repo = readmodel._map_file(roots, repo_id, raw_file)
        source_refs[interface["name"]] = {
            "function_id": entry_id,
            "file": relative,
            "line": line,
        }
        if isinstance(relative, str):
            driver_files.add(relative)
    object_files: Dict[str, str] = {}
    for object_id, entity in (
        (entity.get("id"), entity)
        for entity in graph.get("objects") or []
        if isinstance(entity, dict)
    ):
        if not isinstance(object_id, str):
            continue
        raw_file, _line = atlas.function_location(graph, entity, evidence)
        relative, _file_repo = readmodel._map_file(roots, repo_id, raw_file)
        if isinstance(relative, str):
            object_files[object_id] = relative
    return source_refs, driver_files, object_files


def _observed_participant(
    resources: Sequence[Dict[str, Any]],
    driver_files: Set[str],
    object_files: Dict[str, str],
) -> str:
    for resource in resources:
        file_value = object_files.get(resource.get("resource_id") or "")
        if isinstance(file_value, str) and driver_files and file_value not in driver_files:
            return "platform"
    return "resource"


def view_sequence_observed(
    state: Any, workspace_ref: str, scenario_ref: str
) -> Dict[str, Any]:
    """Observed timing DTO derived from the current scenario ledger generation."""
    workspace = readmodel._workspace_or_fail(state, workspace_ref)
    ledger = _read_ledger(state, scenario_ref)
    if ledger.get("workspace_id") != workspace["workspace_id"]:
        fail("SCOPE_DENIED", "scenario belongs to another workspace")
    imported = ledger.get("imported") is True
    profile: Optional[Dict[str, Any]] = None
    profile_id = ledger.get("profile_id")
    if isinstance(profile_id, str) and profile_id:
        try:
            record = _load_profile_record(
                state, profile_id, workspace_id=ledger["workspace_id"]
            )
            profile = record["profile"]
        except CodeLearningError:
            profile = None
    if profile is not None:
        source_refs, driver_files, object_files = _observed_source_refs(
            state, ledger, profile
        )
        interface_roles = {
            item["name"]: item["role"] for item in profile["interfaces"]
        }
    else:
        source_refs, driver_files, object_files = {}, set(), {}
        interface_roles = {}
    # Contract section 11: async declarations come from the profile for
    # executed ledgers and from the imported trace document for imported ones
    # (a rev1 imported trace stays legacy S3b-shaped even if its optional
    # profile binding now declares async events).
    async_events: List[str] = []
    if imported:
        raw_async = ledger.get("async_events")
    elif profile is not None:
        raw_async = profile.get("async_events")
    else:
        raw_async = None
    if isinstance(raw_async, list):
        async_events = [
            name for name in raw_async if isinstance(name, str)
        ][:MAX_ASYNC_EVENTS]
    messages: List[Dict[str, Any]] = []
    truncated = False

    def add_message(**fields: Any) -> None:
        nonlocal truncated
        if len(messages) >= MAX_OBSERVED_MESSAGES:
            truncated = True
            return
        index = len(messages) + 1
        message: Dict[str, Any] = {
            "message_id": f"m_{index}",
            "index": index,
            "kind": fields.pop("kind"),
            "from": fields.pop("from"),
            "to": fields.pop("to"),
            "label": fields.pop("label", None),
            "call_id": fields.pop("call_id", None),
            "step_index": fields.pop("step_index", None),
            "status": fields.pop("status", None),
            "result": fields.pop("result", None),
            "observed": True,
            "event": fields.pop("event", None),
            "code": fields.pop("code", None),
            "affected_resources": fields.pop("affected_resources", []),
            "source_ref": fields.pop("source_ref", None),
            "limitations": fields.pop("limitations", []),
            "imported": fields.pop("imported", imported),
        }
        message.update(fields)
        if async_events:
            message["async"] = message.get("event") in async_events
        messages.append(message)

    for record_item in ledger["records"]:
        step_index = record_item["step_index"]
        interface = record_item["interface"]
        args = record_item["args"]
        call_id = record_item["call_id"]
        status = record_item["status"]
        result = record_item["result"]
        role = interface_roles.get(interface)
        source_ref = source_refs.get(interface)
        label = f"{interface}({', '.join(str(arg) for arg in args)})"
        add_message(
            kind="call",
            **{
                "from": "caller",
                "to": "driver",
                "label": label,
                "call_id": call_id,
                "step_index": step_index,
                "status": status,
                "result": result,
                "source_ref": source_ref,
                "stubbed": record_item.get("stubbed") is True or role == "stub_control",
            },
        )
        for event in record_item.get("execution_events") or []:
            if imported or profile is None:
                resources: List[Dict[str, Any]] = []
            else:
                resources = [
                    dict(entry)
                    for entry in _derive_affected_resources(profile, [event])
                ]
            target = _observed_participant(resources, driver_files, object_files)
            if resources:
                access_label = ", ".join(
                    f"{entry['access']} {entry.get('name') or entry['resource_id']}"
                    for entry in resources
                )
                add_message(
                    kind="access",
                    **{
                        "from": "driver",
                        "to": target,
                        "label": f"{event['event']}: {access_label}",
                        "call_id": call_id,
                        "step_index": step_index,
                        "event": event["event"],
                        "code": event["code"],
                        "affected_resources": resources,
                    },
                )
            else:
                add_message(
                    kind="event",
                    **{
                        "from": "driver",
                        "to": "platform" if event["event"] in ("WRITE", "LIBRARY") else "driver",
                        "label": event["event"],
                        "call_id": call_id,
                        "step_index": step_index,
                        "event": event["event"],
                        "code": event["code"],
                    },
                )
        is_error = status == "error" or (isinstance(result, int) and result < 0)
        add_message(
            kind="error" if is_error else "return",
            **{
                "from": "driver",
                "to": "caller",
                "label": f"返回 {result}" if result is not None else "返回 null",
                "call_id": call_id,
                "step_index": step_index,
                "status": status,
                "result": result,
                "source_ref": source_ref,
            },
        )
    gaps: List[Dict[str, Any]] = []
    if truncated:
        gaps.append(
            {
                "code": "sequence_truncated",
                "status": "degraded",
                "reason": f"observed sequence messages were capped at {MAX_OBSERVED_MESSAGES}",
            }
        )
    scenario_block: Dict[str, Any] = {
        "scenario_id": ledger["scenario_id"],
        "generation": ledger["generation"],
        "profile_id": ledger["profile_id"],
        "workspace_id": ledger["workspace_id"],
        "snapshot_id": ledger["snapshot_id"],
        "records_digest": ledger["records_digest"],
        "created_at": ledger["created_at"],
        "imported": imported,
    }
    if imported:
        scenario_block["label"] = ledger.get("label")
        scenario_block["source"] = ledger.get("source")
    result: Dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "mode": "observed",
        "observed": True,
        "imported": imported,
        "label": ledger.get("label") if imported else None,
        "scenario": scenario_block,
        "participants": [
            {"participant_id": "caller", "label": "调用方"},
            {"participant_id": "driver", "label": "驱动"},
            {"participant_id": "resource", "label": "驱动资源"},
            {"participant_id": "platform", "label": "平台/设备边界"},
        ],
        "messages": messages,
        "warning": None,
        "gaps": gaps,
        "truncated": truncated,
        "limitations": (
            list(ledger.get("limitations") or [])
            if imported
            else ["observed_wasm_simulation_not_real_device"]
        ),
    }
    if async_events:
        result["async_events"] = list(async_events)
    return result
