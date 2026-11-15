"""AI summary cache for the code-learning workbench (S4-prep contract section 1).

The engine never generates summary text: an Agent (or a user through the Host
tool ``code_summary``) writes a typed payload and the engine verifies it against
the trusted snapshot and stores one signed JSON record per subject.  Reading is
cheap, re-verifies the snapshot graph hash, and marks records stale when the
current verified snapshot no longer matches the graph hash captured at write
time.

Storage layout::

    state/summaries/<workspace_id>/<snapshot_id>/<type>_<sha256(id)[:32]>.json

Each record contains the public Summary projection plus a signature over its
identity fields (workspace/snapshot/subject/text/generator/labels/facts and the
generated-at / graph-hash pair).  Only the latest record per subject is kept
(overwrite, no generation history).  No paths are ever stored in the record or
returned by the CLI.
"""

from __future__ import annotations

import base64
import binascii
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from . import atlas, snapshot, util
from . import views as readmodel
from .errors import CodeLearningError, fail
from .validation import (
    expect_array,
    expect_int,
    expect_object,
    expect_str,
    hash_hex,
    one_of,
    reject_unknown,
)

SCHEMA_VERSION = 1

SUBJECT_TYPES = ("function", "group", "entry")
FACT_KINDS = ("evidence", "node", "selection")
GENERATOR_KINDS = ("agent", "user")
INFERENCE_LABELS = (
    "from_static_structure",
    "from_source_text",
    "may_speculative",
    "from_observation",
)

MAX_TEXT_CODEPOINTS = 500
MAX_FACTS = 32
MAX_FACT_REF = 512
MAX_GENERATOR_REF = 256
MAX_MODEL_REF = 128
MAX_INFERENCE_LABELS = 8
MAX_SUBJECT_ID = 512
MAX_PAYLOAD_JSON_BYTES = 64 * 1024
MAX_SUBJECT_TEXT = 256

_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_SUBJECT_ID_RE = re.compile(r"^[A-Za-z0-9_$][A-Za-z0-9_$.:+/@#-]{0,511}$")
_FACT_REF_RE = re.compile(r"^[A-Za-z0-9_$][A-Za-z0-9_$.:+/@#|-]{0,511}$")
_ABSOLUTE_RE = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\\\\\|//|/[A-Za-z0-9._~])")

_SUMMARY_KEYS = frozenset(
    {
        "schema_version",
        "workspace_id",
        "snapshot_id",
        "subject",
        "text",
        "facts",
        "generator",
        "inference_labels",
        "generated_at",
        "snapshot_graph_sha256",
        "limitations",
        "signature",
    }
)
_PAYLOAD_KEYS = frozenset({"subject", "text", "facts", "generator", "inference_labels"})
_SUBJECT_KEYS = frozenset({"type", "id"})
_FACT_KEYS = frozenset({"kind", "ref"})
_GENERATOR_KEYS = frozenset({"kind", "ref", "model_ref"})

GAP_NOT_GENERATED = "ai_summary_not_generated"
LIMITATION_STALE = "summary_stale_against_current_snapshot"
LIMITATION_NO_EXISTENCE_CHECK = "subject_existence_not_verified"


# ---------------------------------------------------------------------------
# small validation helpers
# ---------------------------------------------------------------------------
def _reject_absolute_text(value: str, where: str) -> str:
    if _ABSOLUTE_RE.match(value.strip()):
        fail("INVALID_ARGUMENT", f"{where} must not contain an absolute path")
    return value


def _safe_ref(value: Any, where: str, *, max_len: int) -> str:
    ref = expect_str(value, where, max_len=max_len)
    return _reject_absolute_text(ref, where)


def _validate_subject(subject: Any) -> Dict[str, str]:
    expect_object(subject, "subject")
    reject_unknown(subject, _SUBJECT_KEYS, "subject")
    subject_type = one_of(subject.get("type"), SUBJECT_TYPES, "subject.type")
    raw_id = expect_str(subject.get("id"), "subject.id", max_len=MAX_SUBJECT_ID)
    if not _SUBJECT_ID_RE.match(raw_id):
        fail(
            "INVALID_ARGUMENT",
            "subject.id must be a bounded safe id (letters/digits/_$.:+/@#-)",
        )
    if ".." in raw_id.split("/"):
        fail("INVALID_ARGUMENT", "subject.id must not contain parent-directory segments")
    _reject_absolute_text(raw_id, "subject.id")
    return {"type": subject_type, "id": raw_id}


def _validate_text(text: Any) -> str:
    if not isinstance(text, str):
        fail("INVALID_ARGUMENT", "text must be a string")
    length = len(text)
    if length < 1:
        fail("INVALID_ARGUMENT", "text must contain at least 1 Unicode code point")
    if length > MAX_TEXT_CODEPOINTS:
        fail(
            "LIMIT_EXCEEDED",
            f"text must contain at most {MAX_TEXT_CODEPOINTS} Unicode code points",
            details={"codepoints": length, "limit": MAX_TEXT_CODEPOINTS},
        )
    if _CONTROL_RE.search(text):
        fail("INVALID_ARGUMENT", "text must not contain control characters")
    return text


def _validate_facts(facts: Any) -> List[Dict[str, str]]:
    raw = expect_array(facts, "facts", max_items=MAX_FACTS)
    normalized: List[Dict[str, str]] = []
    for index, fact in enumerate(raw):
        where = f"facts[{index}]"
        expect_object(fact, where)
        reject_unknown(fact, _FACT_KEYS, where)
        kind = one_of(fact.get("kind"), FACT_KINDS, f"{where}.kind")
        ref = expect_str(fact.get("ref"), f"{where}.ref", max_len=MAX_FACT_REF)
        if not _FACT_REF_RE.match(ref):
            fail("INVALID_ARGUMENT", f"{where}.ref contains unsupported characters")
        _reject_absolute_text(ref, f"{where}.ref")
        normalized.append({"kind": kind, "ref": ref})
    return normalized


def _validate_generator(generator: Any) -> Dict[str, Any]:
    expect_object(generator, "generator")
    reject_unknown(generator, _GENERATOR_KEYS, "generator")
    kind = one_of(generator.get("kind"), GENERATOR_KINDS, "generator.kind")
    ref = _safe_ref(generator.get("ref"), "generator.ref", max_len=MAX_GENERATOR_REF)
    model_ref: Optional[str] = None
    if "model_ref" in generator and generator.get("model_ref") is not None:
        model_ref = _safe_ref(
            generator.get("model_ref"), "generator.model_ref", max_len=MAX_MODEL_REF
        )
    return {"kind": kind, "ref": ref, "model_ref": model_ref}


def _validate_inference_labels(labels: Any) -> List[str]:
    raw = expect_array(labels, "inference_labels", max_items=MAX_INFERENCE_LABELS)
    normalized: List[str] = []
    for index, label in enumerate(raw):
        normalized.append(
            one_of(label, INFERENCE_LABELS, f"inference_labels[{index}]")
        )
    return normalized


# ---------------------------------------------------------------------------
# snapshot / observation helpers
# ---------------------------------------------------------------------------
def _bundle_graph_sha(bundle: Dict[str, Any]) -> str:
    return hash_hex(bundle.get("graph_sha256"), "snapshot graph_sha256")


def _load_verified_snapshot(
    state: Any, workspace_ref: str, snapshot_ref: str
) -> Dict[str, Any]:
    bundle = snapshot.load_snapshot_bundle(state, workspace_ref, snapshot_ref)
    if bundle.get("freshness") == "unknown" or not isinstance(
        bundle.get("graph"), dict
    ):
        fail(
            "STALE_SNAPSHOT",
            "summary snapshot files are missing or unreadable",
        )
    _bundle_graph_sha(bundle)
    return bundle


def _workspace_has_observation(state: Any, workspace_id: str) -> bool:
    """True when at least one imported/executed scenario ledger exists."""
    base = state.state_root / "scenarios"
    if not base.is_dir():
        return False
    try:
        entries = sorted(entry for entry in base.iterdir() if entry.is_dir())
    except OSError:
        return False
    for entry in entries:
        current_path = entry / "current.json"
        if not current_path.is_file():
            continue
        try:
            current = util.read_json(current_path)
        except (CodeLearningError, OSError, ValueError):
            continue
        if not isinstance(current, dict):
            continue
        if current.get("workspace_id") != workspace_id:
            continue
        generation = current.get("generation")
        if isinstance(generation, bool) or not isinstance(generation, int):
            continue
        if generation >= 1:
            return True
    return False


# ---------------------------------------------------------------------------
# storage
# ---------------------------------------------------------------------------
def _summary_root(state: Any, workspace_id: str, snapshot_id: str) -> Path:
    return state.state_root / "summaries" / workspace_id / snapshot_id


def _summary_path(
    state: Any, workspace_id: str, snapshot_id: str, subject: Dict[str, str]
) -> Path:
    digest = util.sha256_text(subject["id"])
    return (
        _summary_root(state, workspace_id, snapshot_id)
        / f"{subject['type']}_{digest[:32]}.json"
    )


def _summary_content_digest(record: Dict[str, Any]) -> str:
    return util.digest(
        {
            "workspace_id": record["workspace_id"],
            "snapshot_id": record["snapshot_id"],
            "subject": record["subject"],
            "text": record["text"],
            "facts": record["facts"],
            "generator": record["generator"],
            "inference_labels": record["inference_labels"],
            "generated_at": record["generated_at"],
            "snapshot_graph_sha256": record["snapshot_graph_sha256"],
            "limitations": record["limitations"],
        }
    )


def _summary_signature_payload(
    record: Dict[str, Any], scope_generation: int
) -> Dict[str, Any]:
    subject = record["subject"]
    return {
        "kind": "ai_summary",
        "w": record["workspace_id"],
        "s": record["snapshot_id"],
        "t": subject["type"],
        "i": subject["id"],
        "a": record["generated_at"],
        "h": record["snapshot_graph_sha256"],
        "d": _summary_content_digest(record),
        "g": scope_generation,
    }


def _sign_summary(state: Any, record: Dict[str, Any]) -> str:
    return state.sign(_summary_signature_payload(record, state.scope_generation))


def _verify_summary(state: Any, record: Dict[str, Any], path_label: str) -> None:
    signature = record.get("signature")
    if not isinstance(signature, str) or not signature:
        fail("SCOPE_DENIED", f"{path_label} is not signed")
    try:
        payload = state.verify(signature, kind="ai_summary")
    except CodeLearningError as error:
        fail("SCOPE_DENIED", f"{path_label} signature is not trusted: {error.code}")
    expected = _summary_signature_payload(record, state.scope_generation)
    for key, value in expected.items():
        if payload.get(key) != value:
            fail("SCOPE_DENIED", f"{path_label} does not match its signature")


def _summary_projection(
    record: Dict[str, Any],
    *,
    current_graph_sha: str,
) -> Dict[str, Any]:
    stale = record.get("snapshot_graph_sha256") != current_graph_sha
    limitations = list(record.get("limitations") or [])
    if stale and LIMITATION_STALE not in limitations:
        limitations.append(LIMITATION_STALE)
    return {
        "schema_version": SCHEMA_VERSION,
        "workspace_id": record["workspace_id"],
        "snapshot_id": record["snapshot_id"],
        "subject": {"type": record["subject"]["type"], "id": record["subject"]["id"]},
        "text": record["text"],
        "facts": [dict(fact) for fact in record["facts"]],
        "generator": dict(record["generator"]),
        "inference_labels": list(record["inference_labels"]),
        "generated_at": record["generated_at"],
        "snapshot_graph_sha256": record["snapshot_graph_sha256"],
        "stale": stale,
        "limitations": limitations,
    }


def _read_summary(
    state: Any, workspace_id: str, snapshot_id: str, path: Path
) -> Dict[str, Any]:
    try:
        record = util.read_json(path)
    except CodeLearningError:
        fail("SCOPE_DENIED", "summary record is not readable")
    except (OSError, ValueError):
        fail("SCOPE_DENIED", "summary record is not readable")
    expect_object(record, "summary record")
    reject_unknown(record, _SUMMARY_KEYS, "summary record")
    if record.get("schema_version") != SCHEMA_VERSION:
        fail("UNSUPPORTED_SCHEMA", "summary record schema is not supported")
    if record.get("workspace_id") != workspace_id or record.get("snapshot_id") != snapshot_id:
        fail("SCOPE_DENIED", "summary record belongs to another workspace/snapshot")
    subject = _validate_subject(record.get("subject"))
    if _summary_path(state, workspace_id, snapshot_id, subject) != path:
        fail("SCOPE_DENIED", "summary record filename does not match its subject")
    _validate_text(record.get("text"))
    _validate_facts(record.get("facts"))
    _validate_generator(record.get("generator"))
    _validate_inference_labels(record.get("inference_labels"))
    expect_str(record.get("generated_at"), "generated_at", max_len=64)
    hash_hex(record.get("snapshot_graph_sha256"), "snapshot_graph_sha256")
    limitations = expect_array(record.get("limitations"), "limitations", max_items=16)
    for index, limitation in enumerate(limitations):
        expect_str(limitation, f"limitations[{index}]", max_len=128)
    _verify_summary(state, record, "summary record")
    return record


# ---------------------------------------------------------------------------
# public engine API (contract sections 1.2)
# ---------------------------------------------------------------------------
def summary_put(
    state: Any,
    workspace_ref: str,
    snapshot_ref: str,
    payload_json: str,
) -> Dict[str, Any]:
    """Validate one Agent/user summary payload and overwrite the subject record."""
    workspace = readmodel._workspace_or_fail(state, workspace_ref)
    workspace_id = workspace["workspace_id"]
    snapshot_id = expect_str(snapshot_ref, "snapshot", max_len=128)
    bundle = _load_verified_snapshot(state, workspace_ref, snapshot_id)
    graph_sha = _bundle_graph_sha(bundle)

    raw = _decode_base64(payload_json, "payload-json", MAX_PAYLOAD_JSON_BYTES)
    payload = _json_document(raw, "payload-json")
    reject_unknown(payload, _PAYLOAD_KEYS, "payload")
    subject = _validate_subject(payload.get("subject"))
    text = _validate_text(payload.get("text"))
    facts = _validate_facts(payload.get("facts", []))
    generator = _validate_generator(payload.get("generator"))
    inference_labels = _validate_inference_labels(
        payload.get("inference_labels", [])
    )

    if subject["type"] not in ("group", "entry"):
        functions = atlas.functions_by_id(bundle["graph"])
        if subject["id"] not in functions:
            fail(
                "INVALID_ARGUMENT",
                "subject function is not present in the verified snapshot graph",
                details={"subject_type": subject["type"]},
            )
    if "from_observation" in inference_labels and not _workspace_has_observation(
        state, workspace_id
    ):
        fail(
            "INVALID_ARGUMENT",
            "inference label from_observation requires an existing scenario ledger",
            details={"label": "from_observation"},
        )

    limitations: List[str] = []
    if subject["type"] in ("group", "entry"):
        limitations.append(LIMITATION_NO_EXISTENCE_CHECK)

    generated_at = util.utc_now_iso()
    record: Dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "workspace_id": workspace_id,
        "snapshot_id": snapshot_id,
        "subject": subject,
        "text": text,
        "facts": facts,
        "generator": generator,
        "inference_labels": inference_labels,
        "generated_at": generated_at,
        "snapshot_graph_sha256": graph_sha,
        "limitations": limitations,
    }
    record["signature"] = _sign_summary(state, record)
    path = _summary_path(state, workspace_id, snapshot_id, subject)
    with state.workspace_lock(workspace_id):
        util.ensure_dir(path.parent)
        util.atomic_write_json(path, record)
    return _summary_projection(record, current_graph_sha=graph_sha)


def view_summary(
    state: Any,
    workspace_ref: str,
    snapshot_ref: str,
    subject_type: Optional[str] = None,
    subject_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Return the cached summaries of one snapshot plus gaps/staleness."""
    workspace = readmodel._workspace_or_fail(state, workspace_ref)
    workspace_id = workspace["workspace_id"]
    snapshot_id = expect_str(snapshot_ref, "snapshot", max_len=128)
    bundle = _load_verified_snapshot(state, workspace_ref, snapshot_id)
    graph_sha = _bundle_graph_sha(bundle)

    filter_subject: Optional[Dict[str, str]] = None
    if (subject_type is None) != (subject_id is None):
        fail(
            "INVALID_ARGUMENT",
            "--subject-type and --subject-id must be provided together",
        )
    if subject_type is not None:
        filter_subject = _validate_subject(
            {"type": subject_type, "id": subject_id}
        )

    root = _summary_root(state, workspace_id, snapshot_id)
    records: List[Dict[str, Any]] = []
    if root.is_dir():
        try:
            paths = sorted(root.glob("*.json"))
        except OSError:
            paths = []
        for path in paths:
            record = _read_summary(state, workspace_id, snapshot_id, path)
            if filter_subject is not None and record["subject"] != filter_subject:
                continue
            records.append(record)
    records.sort(key=lambda item: (item["subject"]["type"], item["subject"]["id"]))

    summaries = [
        _summary_projection(record, current_graph_sha=graph_sha) for record in records
    ]
    stale_count = sum(1 for item in summaries if item["stale"])
    gaps: List[Dict[str, Any]] = []
    if not summaries:
        gaps.append(
            {
                "code": GAP_NOT_GENERATED,
                "status": "unavailable",
                "reason": "AI summary has not been generated; an Agent may write one through code_summary",
            }
        )
    return {
        "schema_version": SCHEMA_VERSION,
        "workspace_id": workspace_id,
        "snapshot_id": snapshot_id,
        "summaries": summaries,
        "gaps": gaps,
        "stale_count": stale_count,
    }


# ---------------------------------------------------------------------------
# payload decoding (strict base64 + JSON object)
# ---------------------------------------------------------------------------
def _decode_base64(value: Any, label: str, max_bytes: int) -> bytes:
    text = expect_str(value, label, max_len=4 * max_bytes + 8)
    try:
        raw = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        fail("INVALID_ARGUMENT", f"{label} must be valid base64")
    if len(raw) > max_bytes:
        fail(
            "LIMIT_EXCEEDED",
            f"{label} must decode to at most {max_bytes} bytes",
            details={"bytes": len(raw), "limit": max_bytes},
        )
    return raw


def _json_document(raw: bytes, label: str) -> Dict[str, Any]:
    try:
        value = util.read_json_bytes(raw, label)
    except CodeLearningError as error:
        if error.code == "INVALID_ARGUMENT":
            fail("INVALID_ARGUMENT", f"{label} must be a valid JSON document")
        raise
    return expect_object(value, label)
