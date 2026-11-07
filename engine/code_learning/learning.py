"""Learning-path defaults and strict ``LearningRecordV1`` draft validation.

The record is the only place where a learner's *own* prediction, mental model,
observation and difference are persisted.  The hard rule encoded here (design
§4.3/§8, contract §8) is:

* an Agent explanation has ``mental_model.author='agent'`` and never becomes a
  user claim;
* ``prediction.status`` is ``pending`` until the user actually provides one;
* ``observation.observed`` needs non-empty evidence refs *and* an executed
  experiment;
* ``decision=DONE-APPLIED`` needs real executed evidence;
* ``next_action`` is at most one item with text, estimate and completion
  criterion.

``records.py`` calls :func:`validate_record_draft`; everything here is pure
data handling with no I/O and no storage knowledge.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Optional

from .errors import fail
from .util import check_id, new_id, utc_now_iso
from .validation import (
    expect_array,
    expect_bool,
    expect_int,
    expect_object,
    expect_str,
    normalized_utc,
    one_of,
    reject_unknown,
    require_keys,
)

SCHEMA_VERSION = 1
MAX_REF_CHARS = 8192
MAX_EVIDENCE_REFS = 128
LEVELS: tuple = ("K0", "K1", "K2", "K3")
NATURES: tuple = ("F", "G", "E", "Q")
FRESHNESS: tuple = ("fresh", "stale", "unknown")
DECISIONS: tuple = ("DONE-KNOW", "DONE-APPLIED", "CONTINUE", "QUESTION", "STOP")
MENTAL_MODEL_STATES: tuple = ("pending", "user_provided", "agent_explanation")
EXPERIMENT_STATES: tuple = ("pending", "planned", "executed")

#: Every persisted ``LearningRecordV1`` field.  ``generation`` is excluded from
#: drafts: it is assigned by ``save_record`` under the CAS transaction.
RECORD_FIELDS: tuple = (
    "schema_version",
    "record_id",
    "generation",
    "workspace_id",
    "workspace_revision",
    "variant_ids",
    "scope_ref",
    "goal",
    "snapshot_refs",
    "build_identities",
    "evidence_refs",
    "path_refs",
    "mental_model",
    "prediction",
    "experiment",
    "observation",
    "difference",
    "rules",
    "unknowns",
    "next_action",
    "cursor",
    "freshness",
    "invalidation_reasons",
    "decision",
    "created_at",
    "updated_at",
    "archived",
)

DRAFT_FIELDS: frozenset = frozenset(RECORD_FIELDS) - {"generation"}


# ---------------------------------------------------------------------------
# small structural helpers
# ---------------------------------------------------------------------------
def _struct(value: Any, allowed: Iterable[str], where: str) -> Dict[str, Any]:
    data = expect_object(value, where)
    reject_unknown(data, allowed, where)
    return data


def _string(value: Any, where: str, *, max_len: int = 256, allow_empty: bool = False) -> str:
    return expect_str(value, where, max_len=max_len, allow_empty=allow_empty)


def _nullable_string(value: Any, where: str, *, max_len: int = 512) -> Optional[str]:
    if value is None:
        return None
    return _string(value, where, max_len=max_len)


def _string_array(
    value: Any,
    where: str,
    *,
    min_items: int = 0,
    max_items: int = 128,
    max_len: int = 512,
) -> List[str]:
    items = expect_array(value, where, min_items=min_items, max_items=max_items)
    normalized: List[str] = []
    for index, item in enumerate(items):
        normalized.append(_string(item, f"{where}[{index}]", max_len=max_len))
    return normalized


# ---------------------------------------------------------------------------
# goal
# ---------------------------------------------------------------------------
def validate_goal(goal: Any) -> Dict[str, Any]:
    data = _struct(goal, {"question", "level", "nature"}, "goal")
    require_keys(data, ("question", "level", "nature"), "goal")
    question = _string(data["question"], "goal.question", max_len=4096)
    level = one_of(data["level"], LEVELS, "goal.level")
    raw_nature = expect_array(data["nature"], "goal.nature", max_items=len(NATURES))
    nature: List[str] = []
    for index, item in enumerate(raw_nature):
        value = one_of(item, NATURES, f"goal.nature[{index}]")
        if value in nature:
            fail("INVALID_ARGUMENT", f"goal.nature[{index}] duplicates nature {value}")
        nature.append(value)
    return {"question": question, "level": level, "nature": nature}


# ---------------------------------------------------------------------------
# default record
# ---------------------------------------------------------------------------
def default_record(workspace: Dict[str, Any], goal: Dict[str, Any]) -> Dict[str, Any]:
    """Return a complete draft for a newly opened learning record.

    Every user/evidence-owned field starts ``pending``/empty.  ``workspace`` is
    the internal registration projection written by ``workspace.py``; the
    record identity and build identities are copied so a later ``resume`` can
    recheck them.
    """
    workspace_data = expect_object(workspace, "workspace")
    workspace_id = check_id(workspace_data.get("workspace_id"), "workspace_id")
    revision = expect_int(workspace_data.get("revision"), "workspace.revision", low=1, high=10**9)
    scope_ref = _string(workspace_data.get("scope_ref"), "workspace.scope_ref", max_len=128)
    variants = expect_array(workspace_data.get("variants"), "workspace.variants", min_items=1, max_items=64)
    variant_ids: List[str] = []
    build_identities: List[Dict[str, Any]] = []
    for index, variant in enumerate(variants):
        variant_data = expect_object(variant, f"workspace.variants[{index}]")
        variant_id = check_id(variant_data.get("variant_id"), f"workspace.variants[{index}].variant_id")
        variant_ids.append(variant_id)
        identity = variant_data.get("build_identity")
        if isinstance(identity, dict):
            stored = dict(identity)
            stored.setdefault("variant_id", variant_id)
            stored.setdefault("workspace_revision", revision)
            build_identities.append(stored)
    if not variant_ids:  # pragma: no cover - expect_array already enforces min 1
        fail("INVALID_ARGUMENT", "workspace has no analyzable variant")
    if len(set(variant_ids)) != len(variant_ids):
        fail("INVALID_ARGUMENT", "workspace variant_ids must be unique")
    validated_goal = validate_goal(goal)
    now = utc_now_iso()
    return {
        "schema_version": SCHEMA_VERSION,
        "record_id": new_id("rec"),
        "workspace_id": workspace_id,
        "workspace_revision": revision,
        "variant_ids": variant_ids,
        "scope_ref": scope_ref,
        "goal": validated_goal,
        "snapshot_refs": [],
        "build_identities": build_identities,
        "evidence_refs": [],
        "path_refs": [],
        "mental_model": {"status": "pending"},
        "prediction": {"status": "pending"},
        "experiment": {"status": "pending"},
        "observation": {"status": "pending", "evidence_refs": []},
        "difference": {"status": "pending"},
        "rules": [],
        "unknowns": [],
        "next_action": None,
        "cursor": {
            "current_question": validated_goal["question"],
            "read_evidence_refs": [],
            "chosen_path_ref": None,
            "pending_choice": None,
        },
        "freshness": "fresh",
        "invalidation_reasons": [],
        "decision": None,
        "created_at": now,
        "updated_at": now,
        "archived": False,
    }


# ---------------------------------------------------------------------------
# nested field validators
# ---------------------------------------------------------------------------
def _validate_mental_model(value: Any) -> Dict[str, Any]:
    data = _struct(value, {"status", "text", "author"}, "mental_model")
    require_keys(data, ("status",), "mental_model")
    status = one_of(data["status"], MENTAL_MODEL_STATES, "mental_model.status")
    text = data.get("text")
    author = data.get("author")
    if status == "pending":
        if text is not None or author is not None:
            fail("INVALID_ARGUMENT", "mental_model is pending; it must not carry text or an author")
        return {"status": "pending"}
    text = _string(text, "mental_model.text", max_len=16384)
    if status == "agent_explanation":
        if author is None:
            author = "agent"
        if author != "agent":
            fail(
                "INVALID_ARGUMENT",
                "an agent explanation must be authored by the agent and can never be a user claim",
            )
        return {"status": status, "text": text, "author": "agent"}
    # status == user_provided
    if author != "user":
        fail("INVALID_ARGUMENT", "a user-provided mental model must be authored by the user")
    return {"status": status, "text": text, "author": "user"}


def _validate_prediction(value: Any) -> Dict[str, Any]:
    data = _struct(value, {"status", "text", "provided_at"}, "prediction")
    require_keys(data, ("status",), "prediction")
    status = one_of(data["status"], ("pending", "user_provided"), "prediction.status")
    text = data.get("text")
    provided_at = data.get("provided_at")
    if status == "pending":
        if text is not None or provided_at is not None:
            fail(
                "INVALID_ARGUMENT",
                "prediction is pending; the Agent must not fill in a prediction for the user",
            )
        return {"status": "pending"}
    normalized = {
        "status": "user_provided",
        "text": _string(text, "prediction.text", max_len=4096),
        "provided_at": normalized_utc(provided_at, "prediction.provided_at"),
    }
    return normalized


def _validate_experiment(value: Any) -> Dict[str, Any]:
    data = _struct(value, {"status", "plan_ref", "run_ref"}, "experiment")
    require_keys(data, ("status",), "experiment")
    status = one_of(data["status"], EXPERIMENT_STATES, "experiment.status")
    plan_ref = _nullable_string(data.get("plan_ref"), "experiment.plan_ref", max_len=512)
    run_ref = _nullable_string(data.get("run_ref"), "experiment.run_ref", max_len=512)
    if status == "pending":
        if plan_ref is not None or run_ref is not None:
            fail("INVALID_ARGUMENT", "a pending experiment must not carry plan_ref/run_ref")
        return {"status": "pending"}
    if status == "planned":
        if plan_ref is None:
            fail("INVALID_ARGUMENT", "a planned experiment requires plan_ref")
        return {"status": "planned", "plan_ref": plan_ref}
    if run_ref is None:
        fail(
            "INVALID_ARGUMENT",
            "experiment cannot be executed without a run_ref; indexing success is not execution evidence",
        )
    return {"status": "executed", "run_ref": run_ref}


def _validate_observation(value: Any, experiment: Dict[str, Any]) -> Dict[str, Any]:
    data = _struct(value, {"status", "text", "evidence_refs"}, "observation")
    require_keys(data, ("status", "evidence_refs"), "observation")
    status = one_of(data["status"], ("pending", "observed"), "observation.status")
    evidence_refs = _string_array(
        data["evidence_refs"], "observation.evidence_refs", max_items=MAX_EVIDENCE_REFS, max_len=MAX_REF_CHARS
    )
    text = data.get("text")
    if status == "pending":
        if evidence_refs or text is not None:
            fail("INVALID_ARGUMENT", "a pending observation must not carry text or evidence_refs")
        return {"status": "pending", "evidence_refs": []}
    if not evidence_refs:
        fail("INVALID_ARGUMENT", "observation.observed requires non-empty evidence_refs")
    if experiment.get("status") != "executed":
        fail(
            "INVALID_ARGUMENT",
            "observation.observed requires experiment.status='executed'; static reading is not an observation",
        )
    normalized: Dict[str, Any] = {"status": "observed", "evidence_refs": evidence_refs}
    if text is not None:
        normalized["text"] = _string(text, "observation.text", max_len=16384)
    return normalized


def _validate_difference(value: Any) -> Dict[str, Any]:
    data = _struct(value, {"status", "text"}, "difference")
    require_keys(data, ("status",), "difference")
    status = one_of(data["status"], ("pending", "compared"), "difference.status")
    text = data.get("text")
    if status == "pending":
        if text is not None:
            fail("INVALID_ARGUMENT", "a pending difference must not carry text")
        return {"status": "pending"}
    return {"status": "compared", "text": _string(text, "difference.text", max_len=16384)}


def _validate_rule(value: Any, index: int) -> Dict[str, Any]:
    where = f"rules[{index}]"
    data = _struct(value, {"text", "evidence_refs", "applicable_scope", "status"}, where)
    require_keys(data, ("text", "evidence_refs", "applicable_scope", "status"), where)
    status = one_of(data["status"], ("candidate", "supported"), f"{where}.status")
    evidence_refs = _string_array(
        data["evidence_refs"], f"{where}.evidence_refs", max_items=64, max_len=MAX_REF_CHARS
    )
    if status == "supported" and not evidence_refs:
        fail("INVALID_ARGUMENT", f"{where} is supported but has no evidence_refs")
    return {
        "text": _string(data["text"], f"{where}.text", max_len=1024),
        "evidence_refs": evidence_refs,
        "applicable_scope": _string(data["applicable_scope"], f"{where}.applicable_scope", max_len=256),
        "status": status,
    }


def _validate_next_action(value: Any) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    data = _struct(
        value, {"text", "estimated_minutes", "completion_criterion"}, "next_action"
    )
    require_keys(data, ("text", "estimated_minutes", "completion_criterion"), "next_action")
    return {
        "text": _string(data["text"], "next_action.text", max_len=1024),
        "estimated_minutes": expect_int(
            data["estimated_minutes"], "next_action.estimated_minutes", low=1, high=240
        ),
        "completion_criterion": _string(
            data["completion_criterion"], "next_action.completion_criterion", max_len=1024
        ),
    }


def _validate_cursor(value: Any, goal: Dict[str, Any]) -> Dict[str, Any]:
    data = _struct(
        value,
        {"current_question", "read_evidence_refs", "chosen_path_ref", "pending_choice"},
        "cursor",
    )
    require_keys(data, ("current_question", "read_evidence_refs"), "cursor")
    return {
        "current_question": _string(
            data["current_question"], "cursor.current_question", max_len=4096, allow_empty=True
        ),
        "read_evidence_refs": _string_array(
            data["read_evidence_refs"],
            "cursor.read_evidence_refs",
            max_items=MAX_EVIDENCE_REFS,
            max_len=MAX_REF_CHARS,
        ),
        "chosen_path_ref": _nullable_string(data.get("chosen_path_ref"), "cursor.chosen_path_ref", max_len=512),
        "pending_choice": _nullable_string(data.get("pending_choice"), "cursor.pending_choice", max_len=512),
    }


def _validate_build_identities(value: Any) -> List[Dict[str, Any]]:
    items = expect_array(value, "build_identities", max_items=16)
    normalized: List[Dict[str, Any]] = []
    for index, item in enumerate(items):
        identity = expect_object(item, f"build_identities[{index}]")
        if "variant_id" in identity:
            check_id(identity["variant_id"], f"build_identities[{index}].variant_id")
        try:
            encoded = json.dumps(identity, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        except (TypeError, ValueError):
            fail("INVALID_ARGUMENT", f"build_identities[{index}] must be plain JSON")
        if len(encoded) > 65536:
            fail("INVALID_ARGUMENT", f"build_identities[{index}] is too large")
        normalized.append(identity)
    return normalized


# ---------------------------------------------------------------------------
# draft validation
# ---------------------------------------------------------------------------
def validate_record_draft(draft: Dict[str, Any]) -> Dict[str, Any]:
    """Strictly validate and normalize a draft; fill service-owned defaults.

    Returns a new dict *without* ``generation``; ``save_record`` assigns that
    under the CAS transaction.  Unknown fields, Agent-authored user claims and
    observations without executed evidence are rejected with
    ``INVALID_ARGUMENT``.
    """
    data = expect_object(draft, "record draft")
    if "generation" in data:
        fail(
            "INVALID_ARGUMENT",
            "record draft must not set generation; save_record assigns it from expected_generation",
        )
    reject_unknown(data, DRAFT_FIELDS, "record draft")
    if "goal" not in data:
        fail("INVALID_ARGUMENT", "record draft is missing the required field: goal")
    goal = validate_goal(data["goal"])
    record: Dict[str, Any] = dict(data)

    schema_version = record.setdefault("schema_version", SCHEMA_VERSION)
    if isinstance(schema_version, bool) or schema_version != SCHEMA_VERSION:
        fail("UNSUPPORTED_SCHEMA", "record draft schema_version must be 1")
    record["schema_version"] = SCHEMA_VERSION

    if "record_id" in record:
        record["record_id"] = check_id(record["record_id"], "record_id")
    else:
        record["record_id"] = new_id("rec")
    record["workspace_id"] = check_id(record.get("workspace_id"), "workspace_id")
    record["workspace_revision"] = expect_int(
        record.get("workspace_revision"), "workspace_revision", low=1, high=10**9
    )
    raw_variants = record.get("variant_ids")
    variant_ids = [check_id(item, f"variant_ids[{index}]") for index, item in enumerate(
        expect_array(raw_variants, "variant_ids", min_items=1, max_items=64)
    )]
    if len(set(variant_ids)) != len(variant_ids):
        fail("INVALID_ARGUMENT", "variant_ids must be unique")
    record["variant_ids"] = variant_ids
    record["scope_ref"] = _string(record.get("scope_ref"), "scope_ref", max_len=128)

    record["goal"] = goal
    record["snapshot_refs"] = _string_array(
        record.get("snapshot_refs", []), "snapshot_refs", max_items=64, max_len=512
    )
    record["build_identities"] = _validate_build_identities(record.get("build_identities", []))
    record["evidence_refs"] = _string_array(
        record.get("evidence_refs", []),
        "evidence_refs",
        max_items=MAX_EVIDENCE_REFS,
        max_len=MAX_REF_CHARS,
    )
    record["path_refs"] = _string_array(
        record.get("path_refs", []), "path_refs", max_items=64, max_len=512
    )
    record["unknowns"] = _string_array(record.get("unknowns", []), "unknowns", max_items=64, max_len=1024)
    record["invalidation_reasons"] = _string_array(
        record.get("invalidation_reasons", []),
        "invalidation_reasons",
        max_items=64,
        max_len=512,
    )

    now = utc_now_iso()
    record["created_at"] = normalized_utc(record.get("created_at", now), "created_at")
    record["updated_at"] = normalized_utc(record.get("updated_at", now), "updated_at")

    mental_model = _validate_mental_model(record.get("mental_model", {"status": "pending"}))
    record["mental_model"] = mental_model
    prediction = _validate_prediction(record.get("prediction", {"status": "pending"}))
    record["prediction"] = prediction
    experiment = _validate_experiment(record.get("experiment", {"status": "pending"}))
    record["experiment"] = experiment
    record["observation"] = _validate_observation(
        record.get("observation", {"status": "pending", "evidence_refs": []}), experiment
    )
    record["difference"] = _validate_difference(record.get("difference", {"status": "pending"}))

    raw_rules = expect_array(record.get("rules", []), "rules", max_items=64)
    record["rules"] = [_validate_rule(item, index) for index, item in enumerate(raw_rules)]

    record["next_action"] = _validate_next_action(record.get("next_action"))
    record["cursor"] = _validate_cursor(
        record.get("cursor", {"current_question": goal["question"], "read_evidence_refs": []}), goal
    )
    record["freshness"] = one_of(record.get("freshness", "fresh"), FRESHNESS, "freshness")
    decision = record.get("decision")
    if decision is None:
        record["decision"] = None
    else:
        record["decision"] = one_of(decision, DECISIONS, "decision")
    record["archived"] = expect_bool(record.get("archived", False), "archived")

    if record["decision"] == "DONE-APPLIED":
        observation = record["observation"]
        if observation["status"] != "observed" or not observation["evidence_refs"]:
            fail(
                "INVALID_ARGUMENT",
                "decision=DONE-APPLIED requires an observed result with real evidence_refs",
            )
        if record["experiment"].get("status") != "executed":
            fail("INVALID_ARGUMENT", "decision=DONE-APPLIED requires experiment.status='executed'")
        if not record["evidence_refs"]:
            fail(
                "INVALID_ARGUMENT",
                "decision=DONE-APPLIED requires record-level evidence_refs from the completed application",
            )

    record.pop("generation", None)
    return record
