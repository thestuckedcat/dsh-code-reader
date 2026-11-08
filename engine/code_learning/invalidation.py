"""Local recheck / resume and optional capability-03 invalidation events.

``resume_record`` re-reads the trusted state instead of trusting a message:
workspace revision, recorded BuildIdentity digests, then every cited
``evidence_ref`` (MAC, file existence, file SHA256, byte range) plus
config/compdb/toolchain/generated-header digests.  Anything that changed makes
the record ``stale``; lost/unreadable inputs make it ``unknown``; a revision
change with identical digests stays ``unknown`` on purpose (conservative).

``consume_event`` accepts the narrow v1 event schema and may only raise
freshness (``fresh -> stale -> unknown``).  Events are audited by
``event_id`` and generation; out-of-order/gap events can never make a record
fresh.  A lost event stream never blocks the independent local recheck.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from . import records, scope
from .errors import CodeLearningError, fail
from .util import check_id, digest, safe_relative_path, sha256_file
from .validation import (
    expect_array,
    expect_int,
    expect_object,
    expect_str,
    normalized_utc,
    one_of,
    reject_unknown,
    require_keys,
)

EVENT_KINDS: Tuple[str, ...] = (
    "session_surface_rewound",
    "workspace_files_restored",
    "session_removed",
)
EVENT_OUTCOMES: Tuple[str, ...] = ("committed", "partial", "unknown")
EVENT_FIELDS: frozenset = frozenset(
    {
        "schema_version",
        "event_id",
        "kind",
        "source_capability",
        "scope_ref",
        "session_ref",
        "operation_id",
        "generation",
        "affected_refs",
        "outcome",
        "before_snapshot",
        "after_snapshot",
        "occurred_at",
    }
)
_EVENT_REQUIRED: Tuple[str, ...] = (
    "schema_version",
    "event_id",
    "kind",
    "source_capability",
    "scope_ref",
    "operation_id",
    "generation",
    "affected_refs",
    "outcome",
    "occurred_at",
)

#: BuildIdentity digest fields compared against the current registration.
_IDENTITY_DIGEST_FIELDS: Tuple[str, ...] = (
    "roots_digest",
    "source_manifest_digest",
    "compdb_digests",
    "config_digests",
    "generated_header_digests",
    "toolchain_digest",
    "atlas_lock_digest",
    "sysroot_manifest_digest",
    "binding_digest",
)
_REF_DIGEST_FIELDS: Tuple[str, ...] = (
    "compdb_digests",
    "config_digests",
    "generated_header_digests",
)
_MAX_CONTENT_DIGEST_BYTES = 16 * 1024 * 1024
_EVIDENCE_KINDS = frozenset({"source", "source_text"})


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------
def _unique(items: Iterable[str]) -> List[str]:
    seen: Set[str] = set()
    ordered: List[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            ordered.append(item)
    return ordered


def _repo_index(workspace: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    index: Dict[str, Dict[str, Any]] = {}
    for repo in workspace.get("repositories") or []:
        if isinstance(repo, dict) and isinstance(repo.get("repo_id"), str):
            index[repo["repo_id"]] = repo
    return index


def _repo_root(state: Any, workspace: Dict[str, Any], repo: Dict[str, Any]) -> Optional[Path]:
    absolute = repo.get("absolute_path")
    if isinstance(absolute, str) and absolute:
        return Path(absolute)
    root_ref = repo.get("root_ref")
    if not isinstance(root_ref, str):
        return None
    try:
        base = state.resolve_root(root_ref)
    except CodeLearningError:
        return None
    relative = repo.get("relative_path")
    return base / relative if isinstance(relative, str) and relative else base


def _inside(path: Path, root: Path) -> bool:
    try:
        real_path = os.path.realpath(str(path))
        real_root = os.path.realpath(str(root))
    except OSError:
        return False
    try:
        common = os.path.commonpath([real_path, real_root])
    except ValueError:
        return False
    return common == real_root


def _read_file_digest(path: Path) -> Tuple[str, Optional[str]]:
    """Return ``(status, digest)`` for a reference file (content or size+mtime)."""
    try:
        if path.is_symlink() or not path.is_file():
            return ("missing", None)
        stat = path.stat()
        if stat.st_size > _MAX_CONTENT_DIGEST_BYTES:
            return ("ok", digest({"size": int(stat.st_size), "mtime_ns": int(stat.st_mtime_ns)}))
        return ("ok", sha256_file(path))
    except FileNotFoundError:
        return ("missing", None)
    except OSError:
        return ("unreadable", None)


def _ref_file_digest(
    state: Any,
    workspace: Dict[str, Any],
    repositories: Dict[str, Dict[str, Any]],
    ref: str,
    cache: Dict[str, Tuple[str, Optional[str]]],
) -> Tuple[str, Optional[str]]:
    if ref in cache:
        return cache[ref]
    try:
        if not isinstance(ref, str) or ref.count(":") != 1:
            raise ValueError("bad ref")
        repo_id, relative = ref.split(":", 1)
        check_id(repo_id, "repo_id")
        relative = safe_relative_path(relative, "reference path")
    except (CodeLearningError, ValueError):
        cache[ref] = ("invalid_ref", None)
        return cache[ref]
    repo = repositories.get(repo_id)
    if repo is None:
        cache[ref] = ("missing_repository", None)
        return cache[ref]
    root = _repo_root(state, workspace, repo)
    if root is None:
        cache[ref] = ("missing_repository", None)
        return cache[ref]
    path = root
    for part in relative.split("/"):
        path = path / part
    if not _inside(path, root):
        cache[ref] = ("outside_root", None)
        return cache[ref]
    cache[ref] = _read_file_digest(path)
    return cache[ref]


# ---------------------------------------------------------------------------
# source manifest (BuildIdentity conservative change detector)
# ---------------------------------------------------------------------------


def _source_manifest_digest_candidates(
    state: Any, workspace: Dict[str, Any]
) -> Optional[Set[str]]:
    """Compute the contract §5 stream in several compatible orderings.

    The digest is a conservative change detector only (not a content hash).
    The contract fixes the per-entry stream ``relpath\\0size\\0mtime_ns\\n``;
    this helper hashes the same entries under the few equivalent orderings a
    sibling module may legitimately choose, and treats the tree as unchanged
    when *any* recorded ordering still matches.  A real file change alters
    every candidate, so staleness is not weakened.
    """
    repositories = _repo_index(workspace)
    entries: List[Tuple[str, str, str, int, int]] = []
    for repo_id in sorted(repositories):
        repo = repositories[repo_id]
        root = _repo_root(state, workspace, repo)
        if root is None or not root.is_dir():
            return None
        prefix = repo.get("relative_path")
        if not isinstance(prefix, str) or not prefix:
            prefix = repo_id
        repo_entries: List[Tuple[str, int, int]] = []
        try:
            # ``scope.iter_regular_files`` skips symlinks and Windows junctions
            # (reparse points) instead of descending into them: a junction inside
            # a registered repo must never pull an outside tree into the digest
            # or cause an unbounded walk during ``resume``.
            for full, info in scope.iter_regular_files(root):
                relative = full.relative_to(root).as_posix()
                repo_entries.append((relative, int(info.st_size), int(info.st_mtime_ns)))
        except OSError:
            return None
        for relative, size, mtime_ns in repo_entries:
            entries.append((repo_id, relative, prefix, size, mtime_ns))
    if not entries:
        return set()

    def hash_lines(lines: Iterable[str]) -> str:
        hasher = hashlib.sha256()
        for line in lines:
            hasher.update(line.encode("utf-8"))
        return hasher.hexdigest()

    candidates: Set[str] = set()
    grouped = sorted(entries, key=lambda item: (item[0], item[1]))
    global_by_rel = sorted(entries, key=lambda item: (item[1], item[0]))
    candidates.add(hash_lines(f"{rel}\0{size}\0{mtime}\n" for _r, rel, _p, size, mtime in grouped))
    candidates.add(hash_lines(f"{rel}\0{size}\0{mtime}\n" for _r, rel, _p, size, mtime in global_by_rel))
    candidates.add(
        hash_lines(f"{repo}/{rel}\0{size}\0{mtime}\n" for repo, rel, _p, size, mtime in grouped)
    )
    candidates.add(
        hash_lines(f"{repo}\0{rel}\0{size}\0{mtime}\n" for repo, rel, _p, size, mtime in grouped)
    )
    relative_grouped = sorted(
        ((f"{prefix}/{rel}" if prefix else rel), size, mtime, repo)
        for repo, rel, prefix, size, mtime in entries
    )
    candidates.add(
        hash_lines(f"{rel}\0{size}\0{mtime}\n" for rel, size, mtime, _repo in relative_grouped)
    )
    candidates.add(
        hash_lines(f"{repo}/{rel}\0{size}\0{mtime}\n" for rel, size, mtime, repo in relative_grouped)
    )
    return candidates


# ---------------------------------------------------------------------------
# evidence recheck
# ---------------------------------------------------------------------------
def _collect_evidence_refs(record: Dict[str, Any]) -> List[str]:
    refs: List[str] = []
    refs.extend(record.get("evidence_refs") or [])
    cursor = record.get("cursor") or {}
    refs.extend(cursor.get("read_evidence_refs") or [])
    observation = record.get("observation") or {}
    refs.extend(observation.get("evidence_refs") or [])
    for rule in record.get("rules") or []:
        if isinstance(rule, dict):
            refs.extend(rule.get("evidence_refs") or [])
    return _unique(ref for ref in refs if isinstance(ref, str))


def _payload_value(payload: Dict[str, Any], keys: Sequence[str]) -> Any:
    for key in keys:
        value = payload.get(key)
        if value is not None:
            return value
    return None


def _byte_range(payload: Dict[str, Any]) -> Tuple[Optional[int], Optional[int]]:
    start = _payload_value(payload, ("b", "byte_start", "start", "begin", "bs"))
    end = _payload_value(payload, ("e", "byte_end", "end", "be"))
    if start is None or end is None:
        raw = payload.get("range")
        if isinstance(raw, (list, tuple)) and len(raw) == 2:
            start, end = raw[0], raw[1]
        elif isinstance(raw, dict):
            start = raw.get("start", raw.get("byte_start"))
            end = raw.get("end", raw.get("byte_end"))
    return start, end


def _recheck_evidence(
    state: Any,
    workspace: Dict[str, Any],
    repositories: Dict[str, Dict[str, Any]],
    ref: str,
) -> Tuple[str, Dict[str, Any]]:
    """Recheck one signed evidence ref.  Returns ``(status, detail)``.

    ``status`` is ``ok``, ``stale`` or ``unknown``; a tampered/foreign token is
    ``unknown`` (we cannot prove anything about it), never silently fresh.
    """
    try:
        payload = state.verify(ref)
    except CodeLearningError:
        return ("unknown", {"reason": "invalid_signed_evidence"})
    if not isinstance(payload, dict):
        return ("unknown", {"reason": "invalid_signed_evidence"})
    if payload.get("kind") not in _EVIDENCE_KINDS:
        return ("unknown", {"reason": "unsupported_evidence_kind"})
    workspace_id = _payload_value(payload, ("w", "workspace_id", "ws"))
    if workspace_id is not None and workspace_id != workspace["workspace_id"]:
        return ("unknown", {"reason": "evidence_workspace_mismatch"})
    repo_id = _payload_value(payload, ("r", "repo", "repo_id"))
    relative = _payload_value(payload, ("p", "path", "relpath", "file", "source_ref"))
    recorded_sha = _payload_value(payload, ("s", "sha", "sha256", "source_sha256", "content_sha256"))
    if not all(isinstance(value, str) and value for value in (repo_id, relative, recorded_sha)):
        return ("unknown", {"reason": "unresolvable_evidence_ref"})
    variant_id = _payload_value(payload, ("v", "variant", "variant_id"))
    if variant_id is not None:
        known_variants = {
            variant.get("variant_id")
            for variant in workspace.get("variants") or []
            if isinstance(variant, dict)
        }
        if variant_id not in known_variants:
            return ("stale", {"reason": "evidence_variant_missing", "repo_id": repo_id, "path": relative})
    repo = repositories.get(repo_id)
    if repo is None:
        return ("stale", {"reason": "evidence_repository_missing", "repo_id": repo_id, "path": relative})
    root = _repo_root(state, workspace, repo)
    if root is None:
        return ("unknown", {"reason": "evidence_repository_unavailable", "repo_id": repo_id, "path": relative})
    path = root
    try:
        for part in safe_relative_path(relative, "evidence path").split("/"):
            path = path / part
    except CodeLearningError:
        return ("unknown", {"reason": "invalid_evidence_path", "repo_id": repo_id, "path": relative})
    if not _inside(path, root):
        return ("unknown", {"reason": "evidence_outside_root", "repo_id": repo_id, "path": relative})
    try:
        if path.is_symlink() or not path.is_file():
            return ("unknown", {"reason": "evidence_file_missing", "repo_id": repo_id, "path": relative})
        actual_sha = sha256_file(path)
        size = path.stat().st_size
    except FileNotFoundError:
        return ("unknown", {"reason": "evidence_file_missing", "repo_id": repo_id, "path": relative})
    except OSError:
        return ("unknown", {"reason": "evidence_file_unreadable", "repo_id": repo_id, "path": relative})
    detail = {"repo_id": repo_id, "path": relative}
    if actual_sha != recorded_sha:
        detail["reason"] = "evidence_sha256_mismatch"
        return ("stale", detail)
    start, end = _byte_range(payload)
    if start is None or end is None:
        detail["reason"] = "evidence_byte_range_missing"
        return ("unknown", detail)
    if (
        isinstance(start, bool)
        or isinstance(end, bool)
        or not isinstance(start, int)
        or not isinstance(end, int)
        or start < 0
        or end <= start
        or end > size
    ):
        detail["reason"] = "evidence_byte_range_invalid"
        return ("unknown", detail)
    return ("ok", detail)


#: Upper bound on signed evidence references validated in one record save.
MAX_RECORD_EVIDENCE_REFS = 64


def check_record_evidence(
    state: Any, workspace: Dict[str, Any], record: Dict[str, Any]
) -> List[Tuple[str, str, Dict[str, Any]]]:
    """Recheck every evidence ref a draft would publish.

    Used by ``records.save_record`` so a record can never be stored with
    fabricated/unsigned references (they would otherwise only be caught by a
    later ``resume``).  Returns ``(ref, status, detail)`` for each problem;
    ``status`` is ``stale`` or ``unknown`` exactly as in ``_recheck_evidence``.
    """
    refs = _collect_evidence_refs(record)
    if len(refs) > MAX_RECORD_EVIDENCE_REFS:
        fail(
            "LIMIT_EXCEEDED",
            "record cites too many evidence references for one save",
            details={"limit": MAX_RECORD_EVIDENCE_REFS},
        )
    repositories = _repo_index(workspace)
    problems: List[Tuple[str, str, Dict[str, Any]]] = []
    for ref in refs:
        status, detail = _recheck_evidence(state, workspace, repositories, ref)
        if status != "ok":
            problems.append((ref, status, detail))
    return problems


# ---------------------------------------------------------------------------
# resume_record
# ---------------------------------------------------------------------------
def _safe_cursor(
    record: Dict[str, Any], loaded: Dict[str, Any], workspace: Dict[str, Any], evidence_refs: List[str]
) -> Dict[str, Any]:
    bounded_refs = evidence_refs[:32]
    cursor: Dict[str, Any] = {
        "schema_version": 1,
        "record_id": record.get("record_id"),
        "generation": loaded["generation"],
        "workspace_id": workspace.get("workspace_id"),
        "workspace_revision": workspace.get("revision"),
        "record_workspace_revision": record.get("workspace_revision"),
        "reason": "recheck_evidence_first",
        "evidence_ref": evidence_refs[0] if evidence_refs else None,
        "evidence_refs": bounded_refs,
        "evidence_refs_total": len(evidence_refs),
        "evidence_refs_truncated": len(evidence_refs) > len(bounded_refs),
        "message": (
            "Recheck each cited evidence reference against the current source first; "
            "do not treat this cursor as proof of freshness, and do not reuse prior "
            "line numbers or conclusions before the recheck."
        ),
    }
    return cursor


def resume_record(state: Any, workspace_ref: str, record_ref: str) -> Dict[str, Any]:
    """Recheck one persisted record against the current workspace inputs."""
    workspace = records.load_workspace_registration(state, workspace_ref)
    loaded = records.load_record_revision(state, workspace_ref, record_ref)
    record = loaded["record"]
    changed_inputs: List[str] = []
    required_rechecks: List[Dict[str, Any]] = []
    stale_reasons: List[str] = []
    unknown_reasons: List[str] = []
    repositories = _repo_index(workspace)
    variants: Dict[str, Dict[str, Any]] = {
        variant["variant_id"]: variant
        for variant in workspace.get("variants") or []
        if isinstance(variant, dict) and isinstance(variant.get("variant_id"), str)
    }
    manifest_candidates = _source_manifest_digest_candidates(state, workspace)
    ref_digest_cache: Dict[str, Tuple[str, Optional[str]]] = {}

    # -- BuildIdentity recheck -----------------------------------------
    identities = [item for item in record.get("build_identities") or [] if isinstance(item, dict)]
    for index, identity in enumerate(identities):
        variant_id = identity.get("variant_id")
        current_variant = variants.get(variant_id) if isinstance(variant_id, str) else None
        if current_variant is None:
            unknown_reasons.append("variant_missing")
            changed_inputs.append(f"variant:{variant_id}")
            required_rechecks.append(
                {"kind": "build_identity", "variant_id": variant_id, "reason": "variant_missing"}
            )
            continue
        label = variant_id
        stored_identity = current_variant.get("build_identity")
        if isinstance(stored_identity, dict):
            for field in _IDENTITY_DIGEST_FIELDS:
                recorded_value = identity.get(field)
                current_value = stored_identity.get(field)
                if recorded_value == current_value:
                    continue
                changed_inputs.append(field)
                required_rechecks.append(
                    {"kind": "build_identity", "variant_id": label, "field": field, "reason": "digest_changed"}
                )
                if recorded_value is None or current_value is None:
                    stale_reasons.append(f"{field}_presence_changed")
                else:
                    stale_reasons.append(f"{field}_changed")
        else:
            required_rechecks.append(
                {"kind": "build_identity", "variant_id": label, "reason": "current_identity_unavailable"}
            )

        # live source_manifest_digest recomputation (unregistered file changes)
        recorded_manifest = identity.get("source_manifest_digest")
        if isinstance(recorded_manifest, str) and recorded_manifest:
            if manifest_candidates is None:
                unknown_reasons.append("source_manifest_unreadable")
                changed_inputs.append("source_manifest_digest")
                required_rechecks.append(
                    {
                        "kind": "source_manifest",
                        "variant_id": label,
                        "reason": "repository_unreadable",
                    }
                )
            elif recorded_manifest not in manifest_candidates:
                stale_reasons.append("source_manifest_digest_changed")
                changed_inputs.append("source_manifest_digest")
                required_rechecks.append(
                    {
                        "kind": "source_manifest",
                        "variant_id": label,
                        "reason": "source_tree_changed",
                    }
                )

        # config/compdb/generated-header file digests are unambiguous content hashes
        for field in _REF_DIGEST_FIELDS:
            recorded_map = identity.get(field)
            if not isinstance(recorded_map, dict):
                continue
            for ref, recorded_digest in recorded_map.items():
                status, actual_digest = _ref_file_digest(
                    state, workspace, repositories, ref, ref_digest_cache
                )
                if status != "ok":
                    unknown_reasons.append(status)
                    changed_inputs.append(ref)
                    required_rechecks.append(
                        {"kind": field, "ref": ref, "reason": status}
                    )
                    continue
                if recorded_digest is None:
                    stale_reasons.append(f"{field}_presence_changed")
                    changed_inputs.append(ref)
                    required_rechecks.append(
                        {"kind": field, "ref": ref, "reason": "digest_recorded_as_null"}
                    )
                elif recorded_digest != actual_digest:
                    stale_reasons.append(f"{field}_changed")
                    changed_inputs.append(ref)
                    required_rechecks.append(
                        {"kind": field, "ref": ref, "reason": "digest_changed"}
                    )

    # -- evidence recheck ----------------------------------------------
    evidence_refs = _collect_evidence_refs(record)
    for index, ref in enumerate(evidence_refs):
        status, detail = _recheck_evidence(state, workspace, repositories, ref)
        if status == "ok":
            continue
        label = f"evidence:{detail.get('repo_id')}:{detail.get('path')}"
        if status == "stale":
            stale_reasons.append(detail.get("reason", "evidence_changed"))
            changed_inputs.append(label)
        else:
            unknown_reasons.append(detail.get("reason", "evidence_unverifiable"))
            changed_inputs.append(label)
        required_rechecks.append(
            {
                "kind": "evidence",
                "evidence_ref": ref,
                "reason": detail.get("reason", "evidence_unverifiable"),
            }
        )

    workspace_changed = record.get("workspace_revision") != workspace.get("revision")
    freshness_reason: Optional[str] = None
    if unknown_reasons:
        freshness = "unknown"
        freshness_reason = sorted(set(unknown_reasons))[0]
    elif stale_reasons:
        freshness = "stale"
        freshness_reason = sorted(set(stale_reasons))[0]
    elif workspace_changed:
        freshness = "unknown"
        freshness_reason = "workspace_revision_changed"
        changed_inputs.append("workspace_revision")
        required_rechecks.append(
            {
                "kind": "build_identity",
                "reason": "workspace_revision_changed",
                "record_workspace_revision": record.get("workspace_revision"),
                "workspace_revision": workspace.get("revision"),
            }
        )
    else:
        freshness = "fresh"

    # stable, de-duplicated diagnostics
    deduped_inputs: List[str] = _unique(changed_inputs)
    deduped_rechecks: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    for item in required_rechecks:
        key = json.dumps(item, sort_keys=True, default=str)
        if key in seen:
            continue
        seen.add(key)
        deduped_rechecks.append(item)

    result: Dict[str, Any] = {
        "schema_version": 1,
        "record": record,
        "freshness": freshness,
        "changed_inputs": deduped_inputs,
        "required_rechecks": deduped_rechecks,
        "safe_cursor": _safe_cursor(record, loaded, workspace, evidence_refs),
    }
    if freshness_reason is not None:
        result["reason"] = freshness_reason
    return result


# ---------------------------------------------------------------------------
# capability events
# ---------------------------------------------------------------------------
def _nullable_event_string(value: Any, where: str, *, max_len: int = 512) -> Optional[str]:
    if value is None:
        return None
    return expect_str(value, where, max_len=max_len)


def validate_event(state: Any, event: Dict[str, Any]) -> Dict[str, Any]:
    """Validate ``CapabilityEventV1`` and normalize it for the consumer."""
    data = expect_object(event, "event")
    reject_unknown(data, EVENT_FIELDS, "event")
    require_keys(data, _EVENT_REQUIRED, "event")
    schema_version = data.get("schema_version")
    if isinstance(schema_version, bool) or schema_version != 1:
        fail("UNSUPPORTED_SCHEMA", "capability event schema_version must be 1")
    scope_ref = expect_str(data.get("scope_ref"), "scope_ref", max_len=128)
    if scope_ref != state.scope_ref:
        fail("SCOPE_DENIED", "capability event belongs to another scope")
    affected = expect_array(data.get("affected_refs"), "affected_refs", max_items=256)
    affected_refs = [
        expect_str(item, f"affected_refs[{index}]", max_len=512) for index, item in enumerate(affected)
    ]
    return {
        "schema_version": 1,
        "event_id": expect_str(data.get("event_id"), "event_id", max_len=128),
        "kind": one_of(data.get("kind"), EVENT_KINDS, "kind"),
        "source_capability": expect_str(
            data.get("source_capability"), "source_capability", max_len=64
        ),
        "scope_ref": scope_ref,
        "session_ref": _nullable_event_string(data.get("session_ref"), "session_ref", max_len=256),
        "operation_id": expect_str(data.get("operation_id"), "operation_id", max_len=128),
        "generation": expect_int(data.get("generation"), "generation", low=0, high=10**9),
        "affected_refs": affected_refs,
        "outcome": one_of(data.get("outcome"), EVENT_OUTCOMES, "outcome"),
        "before_snapshot": _nullable_event_string(
            data.get("before_snapshot"), "before_snapshot", max_len=512
        ),
        "after_snapshot": _nullable_event_string(
            data.get("after_snapshot"), "after_snapshot", max_len=512
        ),
        "occurred_at": normalized_utc(data.get("occurred_at"), "occurred_at"),
    }


def _record_ref_candidate(ref: str) -> Optional[str]:
    candidate = ref
    for prefix in ("record:", "record/", "records/"):
        if candidate.startswith(prefix):
            candidate = candidate[len(prefix):]
            break
    else:
        if ":" in candidate or "/" in candidate:
            return None
    candidate = candidate.strip()
    try:
        return check_id(candidate, "record_ref")
    except CodeLearningError:
        return None


def _map_event_refs(
    rows: Sequence[Any], refs: Sequence[str], workspace_id: str
) -> Tuple[List[Any], bool, List[str]]:
    by_id = {row["record_id"]: row for row in rows}
    precise: List[Any] = []
    workspace_scope = False
    unresolved: List[str] = []
    for ref in refs:
        candidate = _record_ref_candidate(ref)
        if candidate is not None:
            row = by_id.get(candidate)
            if row is not None:
                if row not in precise:
                    precise.append(row)
                continue
            unresolved.append(ref)
            continue
        if (
            ref == workspace_id
            or ref.startswith("workspace:")
            or ref.startswith("workspace/")
            or ref.startswith("scope:")
        ):
            workspace_scope = True
            continue
        unresolved.append(ref)
    return precise, workspace_scope, unresolved


def _select_event_targets(
    rows: Sequence[Any], event: Dict[str, Any], workspace_id: str
) -> Tuple[List[Any], str]:
    outcome = event["outcome"]
    kind = event["kind"]
    if kind == "workspace_files_restored":
        return list(rows), ("unknown" if outcome in ("partial", "unknown") else "stale")
    precise, workspace_scope, unresolved = _map_event_refs(rows, event["affected_refs"], workspace_id)
    imprecise = bool(unresolved) or workspace_scope or not precise
    if imprecise:
        # cannot pin the affected record: invalidate the locatable workspace scope
        return list(rows), "unknown"
    severity = "unknown" if outcome in ("partial", "unknown") else (
        "stale" if kind == "session_surface_rewound" else "unknown"
    )
    return precise, severity


def _affected_digest(event: Dict[str, Any]) -> str:
    return digest(
        {
            "kind": event["kind"],
            "outcome": event["outcome"],
            "affected_refs": list(event["affected_refs"]),
            "before_snapshot": event["before_snapshot"],
            "after_snapshot": event["after_snapshot"],
            "session_ref": event["session_ref"],
        }
    )


def _cursor_dict(row: Optional[Dict[str, Any]], source: str) -> Dict[str, Any]:
    return {
        "source": source,
        "last_sequence": int(row["last_sequence"]) if row is not None else 0,
        "generation": int(row["generation"]) if row is not None else 0,
        "gap_detected": bool(row["gap_detected"]) if row is not None else False,
    }


def _event_result(
    *,
    accepted: bool,
    stale_record_refs: List[str],
    unknown_record_refs: List[str],
    next_cursor: Dict[str, Any],
    requires_local_recheck: bool,
    gap_detected: bool,
) -> Dict[str, Any]:
    return {
        "schema_version": 1,
        "accepted": accepted,
        "stale_record_refs": sorted(stale_record_refs),
        "unknown_record_refs": sorted(unknown_record_refs),
        "next_cursor": next_cursor,
        "requires_local_recheck": requires_local_recheck,
        "gap_detected": gap_detected,
    }


def _apply_event_invalidation(
    connection: Any, workspace: Dict[str, Any], event: Dict[str, Any]
) -> Tuple[List[str], List[str]]:
    workspace_id = workspace["workspace_id"]
    rows = [
        row
        for row in records.fetch_workspace_records(connection, workspace_id)
        if not row["archived"]
    ]
    if not rows:
        return [], []
    targets, target_freshness = _select_event_targets(rows, event, workspace_id)
    stale_refs: List[str] = []
    unknown_refs: List[str] = []
    for row in targets:
        records.escalate_record_freshness(connection, row["record_id"], target_freshness)
        if target_freshness == "stale":
            stale_refs.append(row["record_id"])
        else:
            unknown_refs.append(row["record_id"])
    return stale_refs, unknown_refs


def consume_event(state: Any, workspace_ref: str, event: Dict[str, Any]) -> Dict[str, Any]:
    """Consume one optional capability-03 event; it can only invalidate.

    Idempotent by ``event_id``.  Out-of-order (older generation) events are
    audited in ``event_inbox`` but never applied and never make a record fresh.
    A generation gap is sticky and requires the independent local recheck; it
    never blocks that recheck.
    """
    workspace = records.load_workspace_registration(state, workspace_ref)
    normalized = validate_event(state, event)
    source = normalized["source_capability"]
    connection = records.connect_learning_db(state)
    try:
        with records.transaction(connection):
            duplicate = connection.execute(
                "SELECT event_id FROM event_inbox WHERE event_id = ?",
                (normalized["event_id"],),
            ).fetchone()
            cursor_row = connection.execute(
                "SELECT * FROM consumer_cursors WHERE source = ?", (source,)
            ).fetchone()
            if duplicate is not None:
                gap_detected = bool(cursor_row["gap_detected"]) if cursor_row is not None else False
                return _event_result(
                    accepted=False,
                    stale_record_refs=[],
                    unknown_record_refs=[],
                    next_cursor=_cursor_dict(cursor_row, source),
                    requires_local_recheck=gap_detected,
                    gap_detected=gap_detected,
                )
            last_sequence = int(cursor_row["last_sequence"]) if cursor_row is not None else None
            gap_detected = bool(cursor_row["gap_detected"]) if cursor_row is not None else False
            generation = normalized["generation"]
            gap = last_sequence is not None and generation > last_sequence + 1
            late = last_sequence is not None and generation < last_sequence
            if gap:
                gap_detected = True
            connection.execute(
                "INSERT INTO event_inbox(event_id, source, generation, outcome, affected_digest) "
                "VALUES(?, ?, ?, ?, ?)",
                (
                    normalized["event_id"],
                    source,
                    generation,
                    normalized["outcome"],
                    _affected_digest(normalized),
                ),
            )
            if not late:
                new_last = generation if last_sequence is None else max(last_sequence, generation)
                connection.execute(
                    "INSERT INTO consumer_cursors(source, last_sequence, generation, gap_detected) "
                    "VALUES(?, ?, ?, ?) ON CONFLICT(source) DO UPDATE SET "
                    "last_sequence = excluded.last_sequence, generation = excluded.generation, "
                    "gap_detected = excluded.gap_detected",
                    (source, new_last, new_last, int(gap_detected)),
                )
                cursor_row = {
                    "last_sequence": new_last,
                    "generation": new_last,
                    "gap_detected": int(gap_detected),
                }
            stale_refs: List[str] = []
            unknown_refs: List[str] = []
            if not late:
                stale_refs, unknown_refs = _apply_event_invalidation(
                    connection, workspace, normalized
                )
            return _event_result(
                accepted=True,
                stale_record_refs=stale_refs,
                unknown_record_refs=unknown_refs,
                next_cursor=_cursor_dict(cursor_row, source),
                requires_local_recheck=(not late) or gap_detected,
                gap_detected=gap_detected,
            )
    finally:
        connection.close()
