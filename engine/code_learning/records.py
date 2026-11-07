"""Atomic, versioned learning-record storage with CAS and local exports.

Storage contract (design §4.3, implementation-contract §8):

* SQLite at ``state.learning_db_path()`` with ``PRAGMA user_version=1`` and WAL;
  tables ``workspaces``/``records``/``revisions``/``operations``/
  ``event_inbox``/``consumer_cursors`` (plus the empty ``runs`` ledger).
* Immutable revision bodies as JSON under
  ``state.state_root/'records'/<record_id>/<generation>.json`` written through
  the shared temp+fsync+rename helper; the body is written before the single
  transaction publishes the revision/record/operation rows, so a crash can
  only leave an unpublished orphan body, never a published record without
  content.
* CAS on generation -> ``STATE_CONFLICT``; ``operation_id`` idempotency by
  request digest -> ``OPERATION_CONFLICT`` on a different digest.
* Exports are local files under ``state.exports_dir()``; nothing is uploaded or
  synchronized.

``resume_record`` lives in :mod:`code_learning.invalidation` (local recheck);
this module re-exports it so the service layer has one record entry point.
"""

from __future__ import annotations

import contextlib
import json
import sqlite3
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

from . import learning
from .errors import CodeLearningError, fail
from .util import (
    atomic_write,
    canonical_json,
    check_id,
    digest,
    ensure_dir,
    sha256_bytes,
    utc_now_iso,
)
from .validation import expect_int, expect_object, expect_str, one_of

DB_USER_VERSION = 1
CALLER = "record-save"
FRESHNESS_RANK = {"fresh": 0, "stale": 1, "unknown": 2}
_MAX_OPERATION_ID = 128
_RECORDS_DIR = "records"

_SCHEMA_STATEMENTS: Tuple[str, ...] = (
    """
    CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        manifest_ref TEXT,
        manifest_sha256 TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS records (
        record_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        current_revision_ref TEXT NOT NULL,
        freshness TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        tombstoned INTEGER NOT NULL DEFAULT 0
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_records_workspace_freshness ON records(workspace_id, freshness)",
    """
    CREATE TABLE IF NOT EXISTS revisions (
        record_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (record_id, generation)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS operations (
        caller TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        result_ref TEXT NOT NULL,
        PRIMARY KEY (caller, operation_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        workspace_id TEXT,
        variant_id TEXT,
        plan_ref TEXT,
        generation INTEGER,
        state TEXT,
        worker_identity_ref TEXT,
        snapshot_ref TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        heartbeat_at TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS event_inbox (
        event_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        generation INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        affected_digest TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS consumer_cursors (
        source TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL DEFAULT 0,
        generation INTEGER NOT NULL DEFAULT 0,
        gap_detected INTEGER NOT NULL DEFAULT 0
    )
    """,
)


# ---------------------------------------------------------------------------
# database lifecycle
# ---------------------------------------------------------------------------
def connect_learning_db(state: Any) -> sqlite3.Connection:
    """Open the learning database, enforcing ``user_version=1`` and WAL."""
    path = Path(state.learning_db_path())
    try:
        ensure_dir(path.parent)
        connection = sqlite3.connect(str(path), timeout=10.0, isolation_level=None)
    except (sqlite3.Error, OSError):
        fail("DEPENDENCY_UNAVAILABLE", "learning record database is not available")
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        if version == 0:
            _initialize_schema(connection)
        elif version != DB_USER_VERSION:
            fail("UNSUPPORTED_SCHEMA", "learning record database schema version is not supported")
        return connection
    except CodeLearningError:
        connection.close()
        raise
    except sqlite3.Error:
        connection.close()
        fail("DEPENDENCY_UNAVAILABLE", "learning record database is not readable")


def _initialize_schema(connection: sqlite3.Connection) -> None:
    try:
        connection.execute("BEGIN IMMEDIATE")
        for statement in _SCHEMA_STATEMENTS:
            connection.execute(statement)
        connection.execute("COMMIT")
        connection.execute(f"PRAGMA user_version={DB_USER_VERSION}")
    except sqlite3.Error:
        try:
            connection.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        fail("DEPENDENCY_UNAVAILABLE", "learning record database schema could not be created")


@contextlib.contextmanager
def transaction(connection: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """A serialized write transaction (``BEGIN IMMEDIATE``)."""
    connection.execute("BEGIN IMMEDIATE")
    try:
        yield connection
    except BaseException:
        try:
            connection.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    try:
        connection.execute("COMMIT")
    except sqlite3.Error:
        try:
            connection.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise


# ---------------------------------------------------------------------------
# workspace registration (written by workspace.py; consumed here read-only)
# ---------------------------------------------------------------------------
def load_workspace_registration(state: Any, workspace_ref: str) -> Dict[str, Any]:
    """Return ``registration["workspace"]`` for an already registered workspace."""
    workspace_id = check_id(workspace_ref, "workspace_ref")
    registration = state.read_registration(workspace_id)
    if registration is None:
        fail("NOT_FOUND", "workspace is not registered")
    workspace = registration.get("workspace")
    if not isinstance(workspace, dict):
        fail("DEPENDENCY_UNAVAILABLE", "workspace registration is malformed")
    if workspace.get("workspace_id") != workspace_id:
        fail("DEPENDENCY_UNAVAILABLE", "workspace registration identity is inconsistent")
    revision = workspace.get("revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        fail("DEPENDENCY_UNAVAILABLE", "workspace registration revision is invalid")
    if not isinstance(workspace.get("variants"), list) or not workspace["variants"]:
        fail("DEPENDENCY_UNAVAILABLE", "workspace registration has no variants")
    if not isinstance(workspace.get("repositories"), list):
        fail("DEPENDENCY_UNAVAILABLE", "workspace registration has no repositories")
    scope = workspace.get("scope_ref")
    if scope != state.scope_ref:
        fail("SCOPE_DENIED", "workspace registration belongs to another scope")
    scope_generation = workspace.get("scope_generation")
    if scope_generation is not None and scope_generation != state.scope_generation:
        fail("SCOPE_DENIED", "workspace registration belongs to another scope generation")
    return workspace


def _workspace_manifest_fields(workspace: Dict[str, Any]) -> Tuple[Optional[str], Optional[str]]:
    manifest_ref = workspace.get("manifest_name")
    manifest_sha = workspace.get("manifest_sha256")
    return (
        manifest_ref if isinstance(manifest_ref, str) else None,
        manifest_sha if isinstance(manifest_sha, str) else None,
    )


# ---------------------------------------------------------------------------
# row helpers (shared with invalidation.py)
# ---------------------------------------------------------------------------
def fetch_record_row(connection: sqlite3.Connection, record_id: str) -> Optional[sqlite3.Row]:
    return connection.execute("SELECT * FROM records WHERE record_id = ?", (record_id,)).fetchone()


def fetch_workspace_records(connection: sqlite3.Connection, workspace_id: str) -> List[sqlite3.Row]:
    return list(
        connection.execute(
            "SELECT * FROM records WHERE workspace_id = ? AND tombstoned = 0 ORDER BY record_id",
            (workspace_id,),
        ).fetchall()
    )


def conservative_freshness(*values: Any) -> str:
    """Combine stored freshness values, never reporting something fresher."""
    result = "fresh"
    for value in values:
        if value is None:
            continue
        rank = FRESHNESS_RANK.get(value)
        if rank is None:
            return "unknown"
        if rank > FRESHNESS_RANK[result]:
            result = value
    return result


def escalate_record_freshness(connection: sqlite3.Connection, record_id: str, target: str) -> bool:
    """Raise a record's stored freshness; never lower it. Returns True on change."""
    if target not in FRESHNESS_RANK:
        fail("INVALID_ARGUMENT", "unsupported freshness value")
    row = fetch_record_row(connection, record_id)
    if row is None:
        return False
    current = row["freshness"]
    if FRESHNESS_RANK.get(current, 2) >= FRESHNESS_RANK[target]:
        return False
    connection.execute(
        "UPDATE records SET freshness = ? WHERE record_id = ?", (target, record_id)
    )
    return True


# ---------------------------------------------------------------------------
# immutable revision bodies
# ---------------------------------------------------------------------------
def _revision_relative_path(record_id: str, generation: int) -> str:
    return f"{_RECORDS_DIR}/{record_id}/{generation}.json"


def _revision_body_path(state: Any, record_id: str, generation: int) -> Path:
    return Path(state.state_root) / _RECORDS_DIR / record_id / f"{generation}.json"


def _write_revision_body(path: Path, data: bytes, expected_sha: str) -> None:
    """Write a body exactly once; an identical orphan from a crash is reused."""
    ensure_dir(path.parent)
    if path.exists():
        try:
            existing = path.read_bytes()
        except OSError:
            fail("DEPENDENCY_UNAVAILABLE", "existing record revision body is not readable")
        if existing == data:
            return
        fail("STATE_CONFLICT", "record revision body already exists with different content")
    atomic_write(path, data)


def _read_published_revision(
    state: Any,
    record_id: str,
    generation: int,
    relative_path: Any,
    expected_sha: Any,
    workspace_id: str,
) -> Tuple[bytes, Dict[str, Any]]:
    """Read and verify one immutable revision body from the state root."""
    expected_relative = _revision_relative_path(record_id, generation)
    if relative_path != expected_relative:
        fail("DEPENDENCY_UNAVAILABLE", "learning record revision path is inconsistent")
    path = _revision_body_path(state, record_id, generation)
    try:
        content = path.read_bytes()
    except FileNotFoundError:
        fail("DEPENDENCY_UNAVAILABLE", "learning record revision body is missing")
    except OSError:
        fail("DEPENDENCY_UNAVAILABLE", "learning record revision body is not readable")
    actual_sha = sha256_bytes(content)
    if actual_sha != expected_sha:
        fail("DEPENDENCY_UNAVAILABLE", "learning record revision body failed its integrity check")
    try:
        record = json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("DEPENDENCY_UNAVAILABLE", "learning record revision body is not valid JSON")
    if not isinstance(record, dict) or record.get("schema_version") != 1:
        fail("UNSUPPORTED_SCHEMA", "learning record revision schema is not supported")
    if record.get("record_id") != record_id or record.get("generation") != generation:
        fail("DEPENDENCY_UNAVAILABLE", "learning record revision identity is inconsistent")
    if record.get("workspace_id") != workspace_id:
        fail("SCOPE_DENIED", "learning record revision belongs to another workspace")
    return content, record


def load_record_revision(state: Any, workspace_ref: str, record_ref: str) -> Dict[str, Any]:
    """Load one published record revision, verifying body hash and identity.

    Returned dict: ``record`` (parsed body), ``record_id``, ``generation``,
    ``revision_ref``, ``sha256``, ``content`` (exact body bytes),
    ``stored_freshness`` (DB row) and ``record_freshness`` (body).
    """
    workspace = load_workspace_registration(state, workspace_ref)
    record_id = check_id(record_ref, "record_ref")
    connection = connect_learning_db(state)
    try:
        row = fetch_record_row(connection, record_id)
        if row is None:
            fail("NOT_FOUND", "learning record is not present in this workspace")
        revision = connection.execute(
            "SELECT sha256, relative_path FROM revisions WHERE record_id = ? AND generation = ?",
            (record_id, row["generation"]),
        ).fetchone()
    finally:
        connection.close()
    if row["workspace_id"] != workspace["workspace_id"]:
        fail("SCOPE_DENIED", "learning record belongs to another workspace")
    if row["tombstoned"]:
        fail("NOT_FOUND", "learning record has been tombstoned")
    generation = int(row["generation"])
    if revision is None:
        fail("DEPENDENCY_UNAVAILABLE", "learning record revision index is missing")
    content, record = _read_published_revision(
        state,
        record_id,
        generation,
        revision["relative_path"],
        revision["sha256"],
        workspace["workspace_id"],
    )
    return {
        "record": record,
        "record_id": record_id,
        "generation": generation,
        "revision_ref": _revision_relative_path(record_id, generation),
        "sha256": revision["sha256"],
        "content": content,
        "stored_freshness": row["freshness"],
        "record_freshness": record.get("freshness"),
    }


# ---------------------------------------------------------------------------
# save_record
# ---------------------------------------------------------------------------
def _operation_id(value: Any) -> str:
    return expect_str(value, "operation_id", max_len=_MAX_OPERATION_ID)


def _decode_operation_result(result_ref: Any) -> Dict[str, Any]:
    try:
        value = json.loads(result_ref)
    except (TypeError, json.JSONDecodeError):
        fail("DEPENDENCY_UNAVAILABLE", "stored operation result is not readable")
    if not isinstance(value, dict):
        fail("DEPENDENCY_UNAVAILABLE", "stored operation result is malformed")
    return value


def _prepare_draft(state: Any, workspace: Dict[str, Any], draft: Dict[str, Any]) -> Dict[str, Any]:
    """Inject authoritative workspace identity into a draft, rejecting spoofing."""
    data = dict(draft)
    workspace_id = workspace["workspace_id"]
    scope_ref = workspace["scope_ref"]
    revision = workspace["revision"]
    if "workspace_id" in data and data["workspace_id"] != workspace_id:
        fail("SCOPE_DENIED", "record draft workspace_id does not match the registered workspace")
    data["workspace_id"] = workspace_id
    if "scope_ref" in data and data["scope_ref"] != scope_ref:
        fail("SCOPE_DENIED", "record draft scope_ref does not match the registered workspace")
    data["scope_ref"] = scope_ref
    if "workspace_revision" in data:
        provided = data["workspace_revision"]
        if isinstance(provided, bool) or not isinstance(provided, int) or provided != revision:
            fail(
                "STATE_CONFLICT",
                "record draft was built for a different workspace revision",
                details={"draft_revision": provided if isinstance(provided, int) else None,
                         "current_revision": revision},
            )
    data["workspace_revision"] = revision
    variants = [variant for variant in workspace.get("variants", []) if isinstance(variant, dict)]
    known_variants = [variant.get("variant_id") for variant in variants]
    if "variant_ids" in data:
        raw_variants = data["variant_ids"]
        if not isinstance(raw_variants, list) or not raw_variants:
            fail("INVALID_ARGUMENT", "variant_ids must be a non-empty array")
        selected = []
        for index, variant_id in enumerate(raw_variants):
            variant_id = check_id(variant_id, f"variant_ids[{index}]")
            if variant_id not in known_variants:
                fail("INVALID_ARGUMENT", "record draft references an unregistered variant")
            if variant_id in selected:
                fail("INVALID_ARGUMENT", "variant_ids must be unique")
            selected.append(variant_id)
        data["variant_ids"] = selected
    else:
        # A minimal draft (goal + user fields) covers every registered variant.
        data["variant_ids"] = [variant_id for variant_id in known_variants if isinstance(variant_id, str)]
    if "build_identities" not in data:
        selected_ids = set(data.get("variant_ids") or [])
        identities: List[Dict[str, Any]] = []
        for variant in variants:
            variant_id = variant.get("variant_id")
            if variant_id not in selected_ids:
                continue
            identity = variant.get("build_identity")
            if isinstance(identity, dict):
                stored = dict(identity)
                stored.setdefault("variant_id", variant_id)
                stored.setdefault("workspace_revision", revision)
                identities.append(stored)
        data["build_identities"] = identities
    return data


def _new_record_result(record: Dict[str, Any], sha256: str, revision_ref: str) -> Dict[str, Any]:
    return {
        "schema_version": 1,
        "record_id": record["record_id"],
        "generation": record["generation"],
        "revision_ref": revision_ref,
        "sha256": sha256,
        "workspace_id": record["workspace_id"],
        "workspace_revision": record["workspace_revision"],
        "freshness": record["freshness"],
        "updated_at": record["updated_at"],
    }


def save_record(
    state: Any,
    workspace_ref: str,
    draft: Dict[str, Any],
    expected_generation: int,
    operation_id: str,
) -> Dict[str, Any]:
    """CAS-save one LearningRecordV1 revision.

    ``expected_generation == 0`` creates the record; a matching current
    generation appends ``current + 1``.  An already applied ``operation_id``
    with the same request digest replays the stored result.
    """
    operation = _operation_id(operation_id)
    expected = expect_int(expected_generation, "expected_generation", low=0, high=10**9)
    draft_data = expect_object(draft, "record draft")
    workspace = load_workspace_registration(state, workspace_ref)
    try:
        request_sha = digest(
            {
                "operation": CALLER,
                "workspace_id": workspace["workspace_id"],
                "expected_generation": expected,
                "draft": draft_data,
            }
        )
    except (TypeError, ValueError):
        fail("INVALID_ARGUMENT", "record draft is not plain JSON")
    connection = connect_learning_db(state)
    try:
        with transaction(connection):
            previous_operation = connection.execute(
                "SELECT request_sha256, result_ref FROM operations WHERE caller = ? AND operation_id = ?",
                (CALLER, operation),
            ).fetchone()
            if previous_operation is not None:
                if previous_operation["request_sha256"] != request_sha:
                    fail(
                        "OPERATION_CONFLICT",
                        "operation_id was already used with a different request digest",
                    )
                return _decode_operation_result(previous_operation["result_ref"])

            prepared = _prepare_draft(state, workspace, draft_data)
            record = learning.validate_record_draft(prepared)
            record_id = record["record_id"]
            row = fetch_record_row(connection, record_id)
            if row is not None:
                if row["workspace_id"] != workspace["workspace_id"]:
                    fail("SCOPE_DENIED", "learning record belongs to another workspace")
                if row["tombstoned"]:
                    fail("STATE_CONFLICT", "learning record has been tombstoned")
                if row["archived"]:
                    fail(
                        "STATE_CONFLICT",
                        "learning record is archived; restore it before saving a new generation",
                    )
                current_generation = int(row["generation"])
            else:
                current_generation = 0
            if expected != current_generation:
                fail(
                    "STATE_CONFLICT",
                    "record generation changed since the draft was read",
                    details={
                        "expected_generation": expected,
                        "current_generation": current_generation,
                    },
                )
            new_generation = current_generation + 1
            if row is not None:
                previous_revision = connection.execute(
                    "SELECT sha256, relative_path FROM revisions "
                    "WHERE record_id = ? AND generation = ?",
                    (record_id, current_generation),
                ).fetchone()
                if previous_revision is None:
                    fail(
                        "DEPENDENCY_UNAVAILABLE",
                        "previous learning record revision index is missing",
                    )
                _content, previous_record = _read_published_revision(
                    state,
                    record_id,
                    current_generation,
                    previous_revision["relative_path"],
                    previous_revision["sha256"],
                    workspace["workspace_id"],
                )
                created_at = previous_record.get("created_at") or record["created_at"]
            else:
                created_at = record["created_at"]
            record["generation"] = new_generation
            record["created_at"] = created_at
            record["updated_at"] = utc_now_iso()
            record["workspace_id"] = workspace["workspace_id"]
            record["workspace_revision"] = workspace["revision"]
            record["scope_ref"] = workspace["scope_ref"]
            record["archived"] = bool(record["archived"])
            record.pop("generation", None)
            record["generation"] = new_generation

            body = json.dumps(record, sort_keys=True, indent=2, ensure_ascii=False) + "\n"
            body_bytes = body.encode("utf-8")
            body_sha = sha256_bytes(body_bytes)
            revision_ref = _revision_relative_path(record_id, new_generation)
            _write_revision_body(
                _revision_body_path(state, record_id, new_generation), body_bytes, body_sha
            )
            connection.execute(
                "INSERT INTO revisions(record_id, generation, sha256, relative_path, created_at) "
                "VALUES(?, ?, ?, ?, ?)",
                (record_id, new_generation, body_sha, revision_ref, record["updated_at"]),
            )
            if row is None:
                connection.execute(
                    "INSERT INTO records(record_id, workspace_id, generation, current_revision_ref, "
                    "freshness, archived, tombstoned) VALUES(?, ?, ?, ?, ?, ?, 0)",
                    (
                        record_id,
                        workspace["workspace_id"],
                        new_generation,
                        revision_ref,
                        record["freshness"],
                        int(record["archived"]),
                    ),
                )
            else:
                connection.execute(
                    "UPDATE records SET workspace_id = ?, generation = ?, current_revision_ref = ?, "
                    "freshness = ?, archived = ? WHERE record_id = ?",
                    (
                        workspace["workspace_id"],
                        new_generation,
                        revision_ref,
                        record["freshness"],
                        int(record["archived"]),
                        record_id,
                    ),
                )
            manifest_ref, manifest_sha = _workspace_manifest_fields(workspace)
            connection.execute(
                "INSERT INTO workspaces(workspace_id, revision, manifest_ref, manifest_sha256) "
                "VALUES(?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET "
                "revision = excluded.revision, manifest_ref = excluded.manifest_ref, "
                "manifest_sha256 = excluded.manifest_sha256",
                (workspace["workspace_id"], workspace["revision"], manifest_ref, manifest_sha),
            )
            result = _new_record_result(record, body_sha, revision_ref)
            connection.execute(
                "INSERT INTO operations(caller, operation_id, request_sha256, result_ref) "
                "VALUES(?, ?, ?, ?)",
                (CALLER, operation, request_sha, canonical_json(result)),
            )
            return result
    finally:
        connection.close()


# ---------------------------------------------------------------------------
# get_record
# ---------------------------------------------------------------------------
def get_record(state: Any, workspace_ref: str, record_ref: str) -> Dict[str, Any]:
    """Return the current record revision with its *effective* freshness.

    The immutable body keeps the freshness it was saved with; event-driven
    invalidation raises the DB row without rewriting history.  Reads therefore
    merge the two conservatively.
    """
    loaded = load_record_revision(state, workspace_ref, record_ref)
    record = dict(loaded["record"])
    record["freshness"] = conservative_freshness(
        loaded["record_freshness"], loaded["stored_freshness"]
    )
    return record


# ---------------------------------------------------------------------------
# export_record
# ---------------------------------------------------------------------------
def _markdown_lines(record: Dict[str, Any], freshness: str, loaded: Dict[str, Any]) -> List[str]:
    lines: List[str] = []

    def add(text: str = "") -> None:
        lines.append(text)

    add(f"# Learning record {record.get('record_id')}")
    add()
    add(f"- generation: {loaded['generation']}")
    add(f"- record_id: {record.get('record_id')}")
    add(f"- workspace: {record.get('workspace_id')} (workspace_revision {record.get('workspace_revision')})")
    add(f"- scope: {record.get('scope_ref')}")
    add(f"- variant_ids: {', '.join(record.get('variant_ids') or [])}")
    add(f"- freshness: {freshness}")
    if freshness != "fresh":
        add()
        add(
            f"> WARNING: this record is `{freshness}`. Re-verify every cited evidence "
            "reference against the current source before trusting any conclusion or "
            "line number."
        )
    add(f"- decision: {record.get('decision') if record.get('decision') is not None else 'null'}")
    add(f"- archived: {'true' if record.get('archived') else 'false'}")
    add(f"- updated_at: {record.get('updated_at')}")
    reasons = record.get("invalidation_reasons") or []
    if reasons:
        add(f"- invalidation_reasons: {', '.join(reasons)}")
    add()
    goal = record.get("goal") or {}
    add("## Goal")
    add(f"- question: {goal.get('question', '')}")
    add(f"- level: {goal.get('level', '')}")
    add(f"- nature: {', '.join(goal.get('nature') or [])}")
    add()
    mental_model = record.get("mental_model") or {}
    add("## Mental model (agent explanation — never a user claim)")
    add(f"- status: {mental_model.get('status')}")
    if mental_model.get("author"):
        add(f"- author: {mental_model['author']}")
    if mental_model.get("text"):
        add(f"- text: {mental_model['text']}")
    add()
    prediction = record.get("prediction") or {}
    add("## Prediction (user-provided field)")
    if prediction.get("status") == "pending":
        add("- status: pending — the user has not provided a prediction; do not fill it in for them.")
    else:
        add(f"- status: {prediction.get('status')}")
        add(f"- text: {prediction.get('text', '')}")
        add(f"- provided_at: {prediction.get('provided_at', '')}")
    add()
    experiment = record.get("experiment") or {}
    add("## Experiment")
    add(f"- status: {experiment.get('status')}")
    if experiment.get("plan_ref"):
        add(f"- plan_ref: {experiment['plan_ref']}")
    if experiment.get("run_ref"):
        add(f"- run_ref: {experiment['run_ref']}")
    add()
    observation = record.get("observation") or {}
    add("## Observation")
    add(f"- status: {observation.get('status')}")
    if observation.get("status") == "pending":
        add("- pending: no executed experiment evidence has been recorded yet.")
    if observation.get("text"):
        add(f"- text: {observation['text']}")
    observation_evidence = observation.get("evidence_refs") or []
    if observation_evidence:
        add("- evidence_refs:")
        for ref in observation_evidence:
            add(f"  - {ref}")
    add()
    difference = record.get("difference") or {}
    add("## Difference")
    add(f"- status: {difference.get('status')}")
    if difference.get("text"):
        add(f"- text: {difference['text']}")
    add()
    rules = record.get("rules") or []
    add("## Rules (candidate | supported)")
    if not rules:
        add("- none recorded")
    for rule in rules:
        add(f"- [{rule.get('status')}] {rule.get('text')} (scope: {rule.get('applicable_scope')})")
        for ref in rule.get("evidence_refs") or []:
            add(f"  - evidence: {ref}")
    add()
    unknowns = record.get("unknowns") or []
    add("## Unknowns")
    if not unknowns:
        add("- none recorded")
    for unknown in unknowns:
        add(f"- {unknown}")
    add()
    add("## Next action (at most one)")
    next_action = record.get("next_action")
    if next_action is None:
        add("- none")
    else:
        add(f"- text: {next_action.get('text')}")
        add(f"- estimated_minutes: {next_action.get('estimated_minutes')}")
        add(f"- completion_criterion: {next_action.get('completion_criterion')}")
    add()
    cursor = record.get("cursor") or {}
    add("## Cursor")
    add(f"- current_question: {cursor.get('current_question', '')}")
    add(f"- chosen_path_ref: {cursor.get('chosen_path_ref')}")
    add(f"- pending_choice: {cursor.get('pending_choice')}")
    read_refs = cursor.get("read_evidence_refs") or []
    add(f"- read_evidence_refs: {len(read_refs)}")
    add()
    add("## Evidence references")
    evidence_refs = record.get("evidence_refs") or []
    if not evidence_refs:
        add("- none recorded")
    for ref in evidence_refs:
        add(f"- {ref}")
    add()
    add("## Build identities")
    identities = record.get("build_identities") or []
    if not identities:
        add("- none recorded")
    for identity in identities:
        add(
            f"- variant: {identity.get('variant_id')} | workspace_revision: "
            f"{identity.get('workspace_revision')} | source_manifest_digest: "
            f"{identity.get('source_manifest_digest')}"
        )
    return lines


def render_markdown(record: Dict[str, Any], freshness: str, loaded: Dict[str, Any]) -> str:
    return "\n".join(_markdown_lines(record, freshness, loaded)) + "\n"


def export_record(
    state: Any,
    workspace_ref: str,
    record_ref: str,
    fmt: str = "markdown",
) -> Dict[str, Any]:
    """Write a local export under ``state.exports_dir()``; never uploads."""
    output_format = one_of(fmt, ("markdown", "json"), "format")
    loaded = load_record_revision(state, workspace_ref, record_ref)
    record = loaded["record"]
    effective = conservative_freshness(
        loaded["record_freshness"], loaded["stored_freshness"]
    )
    if output_format == "json":
        data = loaded["content"]
        sha = loaded["sha256"]
        name = f"{record['record_id']}.g{loaded['generation']}.json"
    else:
        data = render_markdown(record, effective, loaded).encode("utf-8")
        sha = sha256_bytes(data)
        name = f"{record['record_id']}.g{loaded['generation']}.md"
    path = state.exports_dir() / name
    atomic_write(path, data)
    return {
        "schema_version": 1,
        "format": output_format,
        "record_id": record["record_id"],
        "generation": loaded["generation"],
        "export_ref": name,
        "sha256": sha,
        "bytes": len(data),
        "freshness": effective,
        "uploaded": False,
    }


# ---------------------------------------------------------------------------
# resume_record (implementation in invalidation.py; service calls it here)
# ---------------------------------------------------------------------------
def resume_record(state: Any, workspace_ref: str, record_ref: str) -> Dict[str, Any]:
    """Delegate to :func:`code_learning.invalidation.resume_record`.

    Kept here because the service layer's record entry point is ``records``;
    the actual workspace/build/evidence recheck lives in ``invalidation.py``.
    """
    from .invalidation import resume_record as _resume_record

    return _resume_record(state, workspace_ref, record_ref)
