"""Shared synthetic fixtures for the records/invalidation suites (rec-agent).

These helpers build a workspace registration in the internal shape documented
by ``implementation-contract.md`` §3/§5 and sign ``SourceEvidence``-style
tokens with the real :class:`code_learning.state.State` signer.

They deliberately do **not** import ``code_learning.workspace`` (owned by
another agent and written in parallel).  ``records.py`` / ``invalidation.py``
must be able to work from the persisted registration alone; integration with
``workspace.load_workspace`` is the Lead's cross-module check.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from code_learning import learning
from code_learning.util import sha256_bytes, sha256_file, sha256_text

WORKSPACE_ID = "synthetic-linux-ioctl"
OTHER_WORKSPACE_ID = "synthetic-other"
VARIANT_ID = "source-only-x86_64"
SCOPE_REF = "local"
SCOPE_GENERATION = 1

FIXTURE_DIR = Path(__file__).resolve().parent

#: (repo_id, root_ref, role) for the synthetic three-repo tree.
REPOS: Tuple[Tuple[str, str, str], ...] = (
    ("umd", "synthetic-root", "umd"),
    ("uapi", "synthetic-root", "uapi"),
    ("kmd", "synthetic-root", "kmd"),
)

_OPERATION_COUNTER = itertools.count(1)


# ---------------------------------------------------------------------------
# workspace registration fixture
# ---------------------------------------------------------------------------
def repo_path(env: Any, repo_id: str) -> Path:
    return Path(getattr(env, repo_id))


def resolve_ref(env: Any, ref: str) -> Path:
    repo_id, relative = ref.split(":", 1)
    return repo_path(env, repo_id) / relative


def ref_digest(env: Any, ref: str) -> str:
    return sha256_file(resolve_ref(env, ref))


def source_manifest_digest(env: Any) -> str:
    """Independent oracle for the contract §5 stream.

    Sorted ``relpath\\0size\\0mtime_ns\\n`` entries across the registered repo
    roots (skipping ``.git``/``node_modules``/``__pycache__``), grouped by repo
    id.  The implementation tries several equivalent orderings so a small
    cross-module formatting difference does not fabricate staleness.
    """
    entries: List[Tuple[Tuple[str, str], str]] = []
    for repo_id, _root_ref, _role in REPOS:
        root = repo_path(env, repo_id)
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(
                name for name in dirnames if name not in {".git", "node_modules", "__pycache__"}
            )
            for name in filenames:
                path = Path(dirpath) / name
                if path.is_symlink() or not path.is_file():
                    continue
                relative = path.relative_to(root).as_posix()
                stat = path.stat()
                entries.append(
                    ((repo_id, relative), f"{relative}\0{stat.st_size}\0{stat.st_mtime_ns}\n")
                )
    entries.sort(key=lambda item: item[0])
    hasher = hashlib.sha256()
    for _key, line in entries:
        hasher.update(line.encode("utf-8"))
    return hasher.hexdigest()


def build_workspace(
    env: Any,
    *,
    revision: int = 1,
    identity_overrides: Optional[Dict[str, Any]] = None,
    variant_overrides: Optional[Dict[str, Any]] = None,
    build_identity: bool = True,
) -> Dict[str, Any]:
    """Return the internal ``registration["workspace"]`` dict for the fixture."""
    compdb_refs = ["umd:compile_commands.json", "kmd:compile_commands.json"]
    config_refs = ["kmd:.config"]
    generated_refs = ["kmd:include/generated/autoconf.h"]
    identity: Dict[str, Any] = {
        "workspace_revision": revision,
        "variant_id": VARIANT_ID,
        "roots_digest": sha256_text("roots:" + str(Path(env.root).resolve())),
        "source_manifest_digest": source_manifest_digest(env),
        "compdb_digests": {ref: ref_digest(env, ref) for ref in compdb_refs},
        "config_digests": {ref: ref_digest(env, ref) for ref in config_refs},
        "generated_header_digests": {ref: ref_digest(env, ref) for ref in generated_refs},
        "toolchain_digest": None,
        "atlas_lock_digest": None,
        "sysroot_manifest_digest": None,
        "binding_digest": sha256_text("bindings:none"),
    }
    if identity_overrides:
        identity.update(identity_overrides)
    variant: Dict[str, Any] = {
        "variant_id": VARIANT_ID,
        "analysis_mode": "source_only",
        "architecture": "x86_64",
        "target_triple": None,
        "config_refs": config_refs,
        "compdb_refs": compdb_refs,
        "generated_header_sets": generated_refs,
        "toolchain_ref": None,
        "sysroot_ref": None,
        "include_root_refs": [],
        "link_evidence_refs": [],
        "uapi_revision_refs": [],
        "execution_profile_ref": None,
        "semantic_status": "blocked",
        "missing_inputs": ["compiler_build_context"],
        "diagnostics": [],
    }
    if build_identity:
        variant["build_identity"] = identity
    if variant_overrides:
        variant.update(variant_overrides)
    repositories = []
    for repo_id, root_ref, role in REPOS:
        root = repo_path(env, repo_id)
        repositories.append(
            {
                "repo_id": repo_id,
                "root_ref": root_ref,
                "relative_path": repo_id,
                "absolute_path": str(root),
                "role": role,
                "vcs": {"kind": "none", "commit": None},
            }
        )
    workspace = {
        "workspace_id": WORKSPACE_ID,
        "revision": revision,
        "scope_ref": SCOPE_REF,
        "scope_generation": SCOPE_GENERATION,
        "created_at": "2026-11-07T00:00:00Z",
        "updated_at": "2026-11-07T00:00:00Z",
        "manifest_name": "workspace.json",
        "manifest_sha256": sha256_text("synthetic workspace manifest"),
        "source_manifest_digest": identity["source_manifest_digest"],
        "roots_digest": identity["roots_digest"],
        "repositories": repositories,
        "variants": [variant],
        "bindings": [],
        "toolchains": [],
    }
    return workspace


def write_workspace(env: Any, workspace: Dict[str, Any], workspace_id: str = WORKSPACE_ID) -> None:
    env.state.write_registration(workspace_id, {"schema_version": 1, "workspace": workspace})


def make_env(tmp_path: Path, **workspace_kwargs: Any) -> Tuple[Any, Dict[str, Any]]:
    """Create the synthetic tree + bootstrap + one registered workspace."""
    import helpers

    env = helpers.make_bootstrap(Path(tmp_path))
    workspace = build_workspace(env, **workspace_kwargs)
    write_workspace(env, workspace)
    return env, workspace


def make_other_workspace(env: Any, workspace: Dict[str, Any]) -> Dict[str, Any]:
    """Register a second workspace so cross-workspace record access can be tested."""
    other = json.loads(json.dumps(workspace))
    other["workspace_id"] = OTHER_WORKSPACE_ID
    write_workspace(env, other, OTHER_WORKSPACE_ID)
    return other


def bump_workspace_revision(env: Any, workspace: Dict[str, Any]) -> Dict[str, Any]:
    """Advance registration revision while keeping every digest unchanged."""
    workspace["revision"] = int(workspace["revision"]) + 1
    variant = workspace["variants"][0]
    if isinstance(variant.get("build_identity"), dict):
        variant["build_identity"]["workspace_revision"] = workspace["revision"]
    workspace["updated_at"] = "2026-11-07T00:00:01Z"
    write_workspace(env, workspace)
    return workspace


# ---------------------------------------------------------------------------
# signed evidence refs
# ---------------------------------------------------------------------------
def evidence_ref(
    env: Any,
    *,
    repo_id: str = "umd",
    relpath: str = "src/job_submit.c",
    byte_start: int = 0,
    byte_end: Optional[int] = None,
    variant_id: str = VARIANT_ID,
    workspace_id: str = WORKSPACE_ID,
    payload_overrides: Optional[Dict[str, Any]] = None,
) -> str:
    """Sign the SourceEvidence-shaped token used by source.py (contract §6)."""
    path = repo_path(env, repo_id) / relpath
    data = path.read_bytes() if path.is_file() else b""
    if byte_end is None:
        byte_end = max(1, min(len(data), 4096))
    payload: Dict[str, Any] = {
        "kind": "source",
        "w": workspace_id,
        "r": repo_id,
        "p": relpath,
        "s": sha256_bytes(data) if path.is_file() else sha256_text("absent"),
        "b": int(byte_start),
        "e": int(byte_end),
        "v": variant_id,
        "g": SCOPE_GENERATION,
    }
    if payload_overrides:
        payload.update(payload_overrides)
    return env.state.sign(payload)


def forged_evidence_ref(env: Any, **payload_overrides: Any) -> str:
    """Sign a syntactically valid token that may not match any real file."""
    payload: Dict[str, Any] = {
        "kind": "source",
        "w": WORKSPACE_ID,
        "r": "umd",
        "p": "src/job_submit.c",
        "s": sha256_text("forged"),
        "b": 0,
        "e": 16,
        "v": VARIANT_ID,
        "g": SCOPE_GENERATION,
    }
    payload.update(payload_overrides)
    return env.state.sign(payload)


# ---------------------------------------------------------------------------
# record drafts / saves
# ---------------------------------------------------------------------------
def default_goal(question: Optional[str] = None) -> Dict[str, Any]:
    return {
        "question": question or "从用户库提交任务到驱动排队发生什么？",
        "level": "K2",
        "nature": ["F", "G"],
    }


def make_draft(
    workspace: Dict[str, Any],
    *,
    evidence_refs: Optional[Iterable[str]] = None,
    **overrides: Any,
) -> Dict[str, Any]:
    draft = learning.default_record(workspace, default_goal())
    if evidence_refs is not None:
        draft["evidence_refs"] = list(evidence_refs)
        draft["cursor"]["read_evidence_refs"] = list(evidence_refs)
    draft.update(overrides)
    return draft


def new_operation_id() -> str:
    return f"11111111-2222-4333-8444-{next(_OPERATION_COUNTER):012d}"


def save(
    env: Any,
    workspace: Dict[str, Any],
    draft: Optional[Dict[str, Any]] = None,
    *,
    expected_generation: int = 0,
    operation_id: Optional[str] = None,
    workspace_ref: Optional[str] = None,
):
    from code_learning import records

    if draft is None:
        draft = make_draft(workspace)
    if workspace_ref is None:
        workspace_ref = workspace["workspace_id"]
    if operation_id is None:
        operation_id = new_operation_id()
    return records.save_record(env.state, workspace_ref, draft, expected_generation, operation_id)


def save_record_with_evidence(
    env: Any,
    workspace: Dict[str, Any],
    *,
    repo_id: str = "umd",
    relpath: str = "src/job_submit.c",
    **overrides: Any,
):
    ref = evidence_ref(env, repo_id=repo_id, relpath=relpath)
    return save(env, workspace, make_draft(workspace, evidence_refs=[ref], **overrides)), ref


# ---------------------------------------------------------------------------
# capability-event fixtures
# ---------------------------------------------------------------------------
def load_event(name: str, **overrides: Any) -> Dict[str, Any]:
    """Load one JSON event fixture and apply test-specific overrides."""
    data = json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))
    data.update(overrides)
    return data


def consume_event(env: Any, event: Dict[str, Any], workspace_ref: str = WORKSPACE_ID):
    from code_learning import invalidation

    return invalidation.consume_event(env.state, workspace_ref, event)


# ---------------------------------------------------------------------------
# database inspection helpers
# ---------------------------------------------------------------------------
def db(env: Any) -> sqlite3.Connection:
    connection = sqlite3.connect(str(env.state.learning_db_path()))
    connection.row_factory = sqlite3.Row
    return connection


def record_row(env: Any, record_id: str) -> Optional[sqlite3.Row]:
    connection = db(env)
    try:
        return connection.execute(
            "SELECT * FROM records WHERE record_id = ?", (record_id,)
        ).fetchone()
    finally:
        connection.close()


def event_count(env: Any) -> int:
    connection = db(env)
    try:
        return int(connection.execute("SELECT COUNT(*) FROM event_inbox").fetchone()[0])
    finally:
        connection.close()


def cursor_row(env: Any, source: str) -> Optional[sqlite3.Row]:
    connection = db(env)
    try:
        return connection.execute(
            "SELECT * FROM consumer_cursors WHERE source = ?", (source,)
        ).fetchone()
    finally:
        connection.close()


def record_body_path(env: Any, record_id: str, generation: int) -> Path:
    return env.state.state_root / "records" / record_id / f"{generation}.json"


def read_record_body(env: Any, record_id: str, generation: int) -> Dict[str, Any]:
    return json.loads(record_body_path(env, record_id, generation).read_text(encoding="utf-8"))


def append_text(path: Path, text: str) -> None:
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
