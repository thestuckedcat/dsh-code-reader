"""Immutable Atlas 0.1 snapshot import, verification and freshness projection.

Import copies a verified ``graph.json``/``analysis_manifest.json`` pair from the
trusted inbox into ``state.snapshot_dir(snapshot_id)`` and records hashes in
``import.json``/``current.json`` plus the state snapshot index.  Every later
read recomputes both file hashes and re-validates the Atlas schema, so a
tampered copy is refused instead of being served as compiler evidence.

Files under ``state.snapshots`` are a read-only learning copy; inbox drift and
``current.json`` drift never change what a loaded snapshot says.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import atlas, util
from .errors import CodeLearningError, fail

SNAPSHOT_META_NAME = "import.json"
SNAPSHOT_CURRENT_NAME = "current.json"
GRAPH_FILE = "graph.json"
MANIFEST_FILE = "analysis_manifest.json"

_MAX_GRAPH_BYTES = 128 * 1024 * 1024
_MAX_MANIFEST_BYTES = 32 * 1024 * 1024
_MAX_SNAPSHOT_ID = 128
_UNKNOWN_FILE_ERRORS = frozenset({"NOT_FOUND", "SCOPE_DENIED", "LIMIT_EXCEEDED", "DEPENDENCY_UNAVAILABLE"})


# ---------------------------------------------------------------------------
# workspace resolution (workspace.py owns the real implementation)
# ---------------------------------------------------------------------------
def load_workspace_registration(state: Any, workspace_ref: str) -> Dict[str, Any]:
    """Return the internal ``registration['workspace']`` dict for a workspace.

    Uses ``workspace.load_workspace`` per the cross-module contract.  While that
    module is being written in parallel, a read-only registration lookup keeps
    the snapshot engine testable; the registered shape is the same contract §3
    object either way.
    """
    try:
        from .workspace import load_workspace as _load_workspace
    except ImportError:  # pragma: no cover - only before workspace.py lands
        _load_workspace = None
    if _load_workspace is not None:
        workspace = _load_workspace(state, workspace_ref)
        if not isinstance(workspace, dict):
            fail("UNSUPPORTED_SCHEMA", "workspace registration is not supported")
        return workspace
    if not isinstance(workspace_ref, str) or not workspace_ref:
        fail("INVALID_ARGUMENT", "workspace_ref must be a non-empty string")
    registration = state.read_registration(workspace_ref)
    if registration is None:
        fail("NOT_FOUND", "workspace is not registered")
    workspace = registration.get("workspace")
    if not isinstance(workspace, dict):
        fail("UNSUPPORTED_SCHEMA", "workspace registration is not supported")
    return workspace


def _workspace_id(workspace: Dict[str, Any]) -> str:
    value = workspace.get("workspace_id")
    if not isinstance(value, str) or not value:
        fail("UNSUPPORTED_SCHEMA", "workspace registration is missing workspace_id")
    return value


def _workspace_revision(workspace: Dict[str, Any]) -> Optional[int]:
    value = workspace.get("revision")
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return None


def _find_variant(workspace: Dict[str, Any], variant_id: str) -> Dict[str, Any]:
    for variant in workspace.get("variants") or []:
        if isinstance(variant, dict) and variant.get("variant_id") == variant_id:
            return variant
    fail("NOT_FOUND", "variant is not registered in this workspace")


def _find_repository(workspace: Dict[str, Any], repo_id: str) -> Dict[str, Any]:
    for repository in workspace.get("repositories") or []:
        if isinstance(repository, dict) and repository.get("repo_id") == repo_id:
            return repository
    fail("NOT_FOUND", "repository is not registered in this workspace")


def _build_identity_digest(workspace: Dict[str, Any], variant: Dict[str, Any]) -> Optional[str]:
    identity = variant.get("build_identity")
    if isinstance(identity, dict):
        try:
            return util.digest(identity)
        except (TypeError, ValueError):
            return None
    return None


# ---------------------------------------------------------------------------
# argument validation
# ---------------------------------------------------------------------------
def _require_component(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or len(value) > _MAX_SNAPSHOT_ID:
        fail("INVALID_ARGUMENT", f"{label} must be a bounded non-empty string")
    if value in (".", "..") or "/" in value or "\\" in value or "\x00" in value:
        fail("INVALID_ARGUMENT", f"{label} must be a single path segment")
    return value


def _require_operation_id(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 256:
        fail("INVALID_ARGUMENT", "operation_id must be a bounded non-empty string")
    return value


# ---------------------------------------------------------------------------
# file helpers
# ---------------------------------------------------------------------------
def _read_regular_file(path: Path, label: str, max_bytes: int) -> bytes:
    path = Path(path)
    if not path.exists():
        fail("NOT_FOUND", f"{label} is missing")
    if path.is_symlink() or not path.is_file():
        fail("SCOPE_DENIED", f"{label} must be a regular non-symlink file")
    try:
        size = path.stat().st_size
    except OSError:
        fail("DEPENDENCY_UNAVAILABLE", f"{label} is not readable")
    if size <= 0 or size > max_bytes:
        fail("LIMIT_EXCEEDED", f"{label} size is outside the accepted range")
    try:
        return path.read_bytes()
    except OSError:
        fail("DEPENDENCY_UNAVAILABLE", f"{label} is not readable")


def _read_inbox_snapshot_file(source_dir: Path, name: str, max_bytes: int) -> bytes:
    raw = _read_regular_file(Path(source_dir) / name, f"inbox snapshot {name}", max_bytes)
    real_path = Path(os.path.realpath(str(Path(source_dir) / name)))
    real_dir = Path(os.path.realpath(str(source_dir)))
    if os.path.normcase(str(real_path.parent)) != os.path.normcase(str(real_dir)):
        fail("SCOPE_DENIED", f"inbox snapshot {name} resolves outside its import directory")
    return raw


def _write_verified_copy(destination: Path, name: str, raw: bytes, expected_hash: str) -> None:
    target = Path(destination) / name
    util.atomic_write(target, raw)
    if util.sha256_file(target) != expected_hash:  # pragma: no cover - defensive
        fail("INTERNAL_ERROR", f"snapshot copy {name} failed its own hash check")


# ---------------------------------------------------------------------------
# index helpers
# ---------------------------------------------------------------------------
def _matching_entries(state: Any, workspace_id: str, snapshot_id: str) -> List[Dict[str, Any]]:
    index = state.snapshots_index()
    entries = index.get("entries")
    if not isinstance(entries, list):
        fail("UNSUPPORTED_SCHEMA", "snapshot index entries are not supported")
    matched: List[Dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if entry.get("workspace_id") != workspace_id or entry.get("snapshot_id") != snapshot_id:
            continue
        matched.append(entry)
    return matched


def _variant_snapshot_map(state: Any, workspace_id: str, variant_id: str) -> Dict[str, str]:
    index = state.snapshots_index()
    entries = index.get("entries")
    if not isinstance(entries, list):
        fail("UNSUPPORTED_SCHEMA", "snapshot index entries are not supported")
    result: Dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if entry.get("workspace_id") != workspace_id or entry.get("variant_id") != variant_id:
            continue
        repo_id = entry.get("repo_id")
        snapshot_id = entry.get("snapshot_id")
        if isinstance(repo_id, str) and isinstance(snapshot_id, str):
            result[repo_id] = snapshot_id
    return result


def _upsert_index(state: Any, entry: Dict[str, Any]) -> None:
    index = state.snapshots_index()
    entries = [item for item in index.get("entries") or [] if isinstance(item, dict)]
    key = (entry["workspace_id"], entry["variant_id"], entry["repo_id"], entry["snapshot_id"])
    kept = [
        item
        for item in entries
        if (
            item.get("workspace_id"),
            item.get("variant_id"),
            item.get("repo_id"),
            item.get("snapshot_id"),
        )
        != key
    ]
    state.write_snapshots_index({"schema_version": 1, "entries": kept + [entry]})


def _index_entry(
    *,
    snapshot_id: str,
    workspace: Dict[str, Any],
    variant_id: str,
    repo_id: str,
    graph_sha256: str,
    manifest_sha256: str,
    build_identity_digest: Optional[str],
    tool_version: Optional[str],
    analysis_id: Optional[str],
    imported_at: str,
) -> Dict[str, Any]:
    return {
        "schema_version": 1,
        "snapshot_id": snapshot_id,
        "snapshot_ref": snapshot_id,
        "workspace_id": _workspace_id(workspace),
        "workspace_revision": _workspace_revision(workspace),
        "variant_id": variant_id,
        "repo_id": repo_id,
        "graph_sha256": graph_sha256,
        "manifest_sha256": manifest_sha256,
        "build_identity_digest": build_identity_digest,
        "atlas_schema": atlas.ATLAS_SCHEMA_VERSION,
        "tool_version": tool_version,
        "analysis_id": analysis_id,
        "imported_at": imported_at,
    }


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------
def import_snapshot(
    state: Any,
    workspace_ref: str,
    variant_id: str,
    repo_id: str,
    snapshot_name: str,
    operation_id: str,
) -> Dict[str, Any]:
    """Validate and copy one Atlas 0.1 snapshot pair into immutable local state."""
    _require_operation_id(operation_id)
    _require_component(snapshot_name, "snapshot_name")
    _require_component(variant_id, "variant_id")
    _require_component(repo_id, "repo_id")
    if not isinstance(workspace_ref, str) or not workspace_ref:
        fail("INVALID_ARGUMENT", "workspace_ref must be a non-empty string")

    request_digest = util.digest(
        {
            "operation": "snapshot-import",
            "workspace_ref": workspace_ref,
            "variant_id": variant_id,
            "repo_id": repo_id,
            "snapshot_name": snapshot_name,
        }
    )
    existing_operation = state.operation_get(operation_id)
    if existing_operation is not None:
        if existing_operation.get("request_digest") != request_digest:
            fail("OPERATION_CONFLICT", "operation_id was already used for a different snapshot import")
        stored = existing_operation.get("result")
        if not isinstance(stored, dict):
            fail("OPERATION_CONFLICT", "stored operation result is not a snapshot projection")
        return stored

    workspace = load_workspace_registration(state, workspace_ref)
    workspace_id = _workspace_id(workspace)
    variant = _find_variant(workspace, variant_id)
    _find_repository(workspace, repo_id)

    source_dir = state.inbox_dir_entry(snapshot_name)
    graph_raw = _read_inbox_snapshot_file(source_dir, GRAPH_FILE, _MAX_GRAPH_BYTES)
    manifest_raw = _read_inbox_snapshot_file(source_dir, MANIFEST_FILE, _MAX_MANIFEST_BYTES)

    graph_payload = atlas.validate_graph_payload(atlas.parse_envelope(graph_raw, atlas.GRAPH_RECORD_KIND))
    manifest_payload = atlas.validate_manifest_payload(
        atlas.parse_envelope(manifest_raw, atlas.MANIFEST_RECORD_KIND)
    )
    graph_sha256 = atlas.graph_hash(graph_raw)
    manifest_sha256 = util.sha256_bytes(manifest_raw)
    if manifest_payload["graph_hash"] != graph_sha256:
        fail(
            "INVALID_ARGUMENT",
            "analysis_manifest.graph_hash does not match the raw graph.json bytes",
        )
    atlas.project_coverage(manifest_payload["coverage"], "analysis_manifest.coverage")

    snapshot_id = manifest_payload["snapshot_id"]
    _require_component(snapshot_id, "manifest snapshot_id")
    build_identity_digest = _build_identity_digest(workspace, variant)
    imported_at = util.utc_now_iso()
    index_entry = _index_entry(
        snapshot_id=snapshot_id,
        workspace=workspace,
        variant_id=variant_id,
        repo_id=repo_id,
        graph_sha256=graph_sha256,
        manifest_sha256=manifest_sha256,
        build_identity_digest=build_identity_digest,
        tool_version=manifest_payload.get("tool_version"),
        analysis_id=manifest_payload.get("analysis_id"),
        imported_at=imported_at,
    )

    with state.workspace_lock(workspace_id):
        destination = state.snapshot_dir(snapshot_id)
        existing_import = _read_import_record(destination)
        if destination.exists() and existing_import is not None:
            if (
                existing_import.get("graph_sha256") != graph_sha256
                or existing_import.get("manifest_sha256") != manifest_sha256
            ):
                fail("STATE_CONFLICT", "snapshot_id is already imported with different content")

        util.ensure_dir(destination)
        _ensure_verified_copy(destination, GRAPH_FILE, graph_raw, graph_sha256)
        _ensure_verified_copy(destination, MANIFEST_FILE, manifest_raw, manifest_sha256)
        if existing_import is None:
            import_record = _import_record(
                snapshot_id=snapshot_id,
                snapshot_name=snapshot_name,
                workspace=workspace,
                variant_id=variant_id,
                repo_id=repo_id,
                graph_sha256=graph_sha256,
                manifest_sha256=manifest_sha256,
                build_identity_digest=build_identity_digest,
                manifest_payload=manifest_payload,
                imported_at=imported_at,
            )
            util.atomic_write_json(destination / SNAPSHOT_META_NAME, import_record)
        current_path = destination / SNAPSHOT_CURRENT_NAME
        if not current_path.exists():
            util.atomic_write_json(
                current_path,
                {"snapshot_id": snapshot_id, "manifest_hash": manifest_sha256},
            )

        _upsert_index(state, index_entry)
        result = snapshot_evidence(state, workspace_ref, snapshot_id)
        state.operation_put(operation_id, request_digest, result)
        return result


def _import_record(
    *,
    snapshot_id: str,
    snapshot_name: str,
    workspace: Dict[str, Any],
    variant_id: str,
    repo_id: str,
    graph_sha256: str,
    manifest_sha256: str,
    build_identity_digest: Optional[str],
    manifest_payload: Dict[str, Any],
    imported_at: str,
) -> Dict[str, Any]:
    return {
        "schema_version": 1,
        "snapshot_id": snapshot_id,
        "snapshot_ref": snapshot_id,
        "snapshot_name": snapshot_name,
        "workspace_id": _workspace_id(workspace),
        "workspace_revision": _workspace_revision(workspace),
        "source_manifest_digest": workspace.get("source_manifest_digest"),
        "variant_id": variant_id,
        "repo_id": repo_id,
        "graph_sha256": graph_sha256,
        "manifest_sha256": manifest_sha256,
        "build_identity_digest": build_identity_digest,
        "atlas_schema": atlas.ATLAS_SCHEMA_VERSION,
        "tool_version": manifest_payload.get("tool_version"),
        "analysis_id": manifest_payload.get("analysis_id"),
        "imported_at": imported_at,
    }


def _read_import_record(destination: Path) -> Optional[Dict[str, Any]]:
    path = Path(destination) / SNAPSHOT_META_NAME
    if not path.exists():
        return None
    try:
        record = util.read_json(path)
    except CodeLearningError:
        return None
    return record if isinstance(record, dict) else None


def _ensure_verified_copy(destination: Path, name: str, raw: bytes, expected_hash: str) -> None:
    """Ensure the immutable copy exists with exactly the verified bytes.

    A pre-existing file with a different hash is a tampered/inconsistent
    snapshot (``STATE_CONFLICT``); a missing file is repaired from the verified
    inbox bytes, which keeps a re-import idempotent and usable.
    """
    target = Path(destination) / name
    if target.exists():
        if target.is_symlink() or not target.is_file():
            fail("SCOPE_DENIED", f"existing snapshot copy {name} must be a regular file")
        try:
            actual = util.sha256_file(target)
        except OSError:
            fail("DEPENDENCY_UNAVAILABLE", "existing snapshot copy is not readable")
        if actual != expected_hash:
            fail("STATE_CONFLICT", "snapshot_id is already imported with different content")
        return
    _write_verified_copy(destination, name, raw, expected_hash)


def load_snapshot_bundle(state: Any, workspace_ref: str, snapshot_ref: str) -> Dict[str, Any]:
    """Load one snapshot after re-verifying file hashes and Atlas schema.

    Returns the internal bundle (graph payload, manifest payload, coverage,
    freshness, hashes).  Missing/unreadable files yield ``freshness='unknown'``;
    a hash/schema mismatch (tampering) raises ``STALE_SNAPSHOT``.
    """
    _require_component(snapshot_ref, "snapshot_ref")
    workspace = load_workspace_registration(state, workspace_ref)
    workspace_id = _workspace_id(workspace)
    entries = _matching_entries(state, workspace_id, snapshot_ref)
    if not entries:
        fail("NOT_FOUND", "snapshot is not imported for this workspace")

    hashes = {entry.get("graph_sha256") for entry in entries}
    manifest_hashes = {entry.get("manifest_sha256") for entry in entries}
    if len(hashes) > 1 or len(manifest_hashes) > 1:
        fail("STATE_CONFLICT", "snapshot index contains inconsistent hashes for this snapshot_id")
    entry = entries[-1]
    graph_sha256 = entry.get("graph_sha256")
    manifest_sha256 = entry.get("manifest_sha256")
    if not isinstance(graph_sha256, str) or not isinstance(manifest_sha256, str):
        fail("UNSUPPORTED_SCHEMA", "snapshot index entry is missing verified hashes")

    destination = state.snapshot_dir(snapshot_ref)
    import_record = _read_import_record(destination)
    bundle: Dict[str, Any] = {
        "schema_version": 1,
        "snapshot_ref": snapshot_ref,
        "snapshot_id": snapshot_ref,
        "workspace_id": workspace_id,
        "variant_id": entry.get("variant_id"),
        "repo_id": entry.get("repo_id"),
        "entry": entry,
        "import": import_record,
        "graph": None,
        "manifest": None,
        "graph_document": None,
        "manifest_document": None,
        "graph_sha256": graph_sha256,
        "manifest_sha256": manifest_sha256,
        "coverage": {},
        "capabilities": {},
        "limitations": [],
        "missing_files": [],
        "freshness": "unknown",
    }

    missing_files: List[str] = []
    raw_files: Dict[str, bytes] = {}
    for name, max_bytes, label in (
        (GRAPH_FILE, _MAX_GRAPH_BYTES, "snapshot graph.json"),
        (MANIFEST_FILE, _MAX_MANIFEST_BYTES, "snapshot analysis_manifest.json"),
    ):
        try:
            raw_files[name] = _read_regular_file(destination / name, label, max_bytes)
        except CodeLearningError as error:
            if error.code not in _UNKNOWN_FILE_ERRORS:
                raise
            missing_files.append(name)
    if missing_files:
        bundle["missing_files"] = missing_files
        bundle["limitations"] = ["snapshot_file_missing"]
        return bundle
    graph_raw = raw_files[GRAPH_FILE]
    manifest_raw = raw_files[MANIFEST_FILE]

    actual_graph_hash = atlas.graph_hash(graph_raw)
    actual_manifest_hash = util.sha256_bytes(manifest_raw)
    if actual_graph_hash != graph_sha256 or actual_manifest_hash != manifest_sha256:
        fail("STALE_SNAPSHOT", "snapshot files no longer match the verified import hashes")
    if import_record is not None:
        if (
            import_record.get("graph_sha256") != graph_sha256
            or import_record.get("manifest_sha256") != manifest_sha256
        ):
            fail("STALE_SNAPSHOT", "snapshot import metadata does not match the verified hashes")

    graph_document = _parse_document(graph_raw, "graph.json")
    manifest_document = _parse_document(manifest_raw, "analysis_manifest.json")
    graph_payload = atlas.validate_graph_payload(
        atlas.validate_envelope(graph_document, atlas.GRAPH_RECORD_KIND, "graph.json")
    )
    manifest_payload = atlas.validate_manifest_payload(
        atlas.validate_envelope(manifest_document, atlas.MANIFEST_RECORD_KIND, "analysis_manifest.json")
    )
    if manifest_payload.get("graph_hash") != actual_graph_hash:
        fail("STALE_SNAPSHOT", "snapshot manifest graph_hash no longer matches graph.json")
    if manifest_payload.get("snapshot_id") != snapshot_ref:
        fail("STALE_SNAPSHOT", "snapshot manifest_id does not match the imported snapshot_id")

    coverage = atlas.project_coverage(manifest_payload.get("coverage"))
    bundle.update(
        {
            "graph": graph_payload,
            "manifest": manifest_payload,
            "graph_document": graph_document,
            "manifest_document": manifest_document,
            "coverage": coverage,
            "capabilities": atlas.capabilities_of(manifest_payload.get("coverage")),
            "limitations": atlas.manifest_limitations(manifest_payload)
            + atlas.coverage_limitations(manifest_payload.get("coverage")),
            "freshness": _snapshot_freshness(workspace, import_record),
        }
    )
    return bundle


def _parse_document(raw: bytes, name: str) -> Dict[str, Any]:
    try:
        return util.read_json_bytes(raw, name)
    except CodeLearningError as error:
        if error.code == "INVALID_ARGUMENT":
            fail("STALE_SNAPSHOT", f"{name} is no longer valid JSON")
        raise


def _snapshot_freshness(workspace: Dict[str, Any], import_record: Optional[Dict[str, Any]]) -> str:
    if import_record is None:
        return "unknown"
    stored_revision = import_record.get("workspace_revision")
    stored_digest = import_record.get("source_manifest_digest")
    if stored_revision is None or stored_digest is None:
        return "unknown"
    if _workspace_revision(workspace) != stored_revision:
        return "stale"
    if workspace.get("source_manifest_digest") != stored_digest:
        return "stale"
    return "fresh"


def snapshot_evidence(state: Any, workspace_ref: str, snapshot_ref: str) -> Dict[str, Any]:
    """Public SnapshotEvidenceV1 projection (design §4.2) for a snapshot."""
    return _evidence_from_bundle(load_snapshot_bundle(state, workspace_ref, snapshot_ref))


def load_snapshot(state: Any, workspace_ref: str, snapshot_ref: str) -> Dict[str, Any]:
    """Verified read of one snapshot as its public SnapshotEvidenceV1 projection.

    ``load_snapshot`` and ``snapshot_evidence`` are two names for this public
    contract; callers that need the graph payload (paths.py) use the internal
    :func:`load_snapshot_bundle`.
    """
    return snapshot_evidence(state, workspace_ref, snapshot_ref)


def _evidence_from_bundle(bundle: Dict[str, Any]) -> Dict[str, Any]:
    import_record = bundle.get("import") or {}
    manifest = bundle.get("manifest")
    coverage = bundle.get("coverage") or {}
    return {
        "schema_version": 1,
        "snapshot_ref": bundle["snapshot_ref"],
        "snapshot_id": bundle["snapshot_id"],
        "atlas_schema": atlas.ATLAS_SCHEMA_VERSION,
        "tool_version": manifest.get("tool_version") if isinstance(manifest, dict) else None,
        "analysis_id": manifest.get("analysis_id") if isinstance(manifest, dict) else None,
        "manifest_sha256": bundle.get("manifest_sha256"),
        "graph_sha256": bundle.get("graph_sha256"),
        "build_identity": {
            "workspace_revision": import_record.get("workspace_revision"),
            "variant_id": import_record.get("variant_id"),
            "digest": import_record.get("build_identity_digest"),
        },
        "coverage": coverage,
        "failed_count": coverage.get("failed_count") if coverage else None,
        "freshness": bundle.get("freshness", "unknown"),
        "capabilities": bundle.get("capabilities") or {},
        "limitations": list(bundle.get("limitations") or []),
        "workspace_id": bundle.get("workspace_id"),
        "variant_id": bundle.get("variant_id"),
        "repo_id": bundle.get("repo_id"),
        "imported_at": import_record.get("imported_at"),
    }


def snapshot_for_repo(state: Any, workspace_ref: str, variant_id: str, repo_id: str) -> Optional[str]:
    """Latest imported snapshot_id for ``(workspace, variant, repo)`` or None."""
    _require_component(variant_id, "variant_id")
    _require_component(repo_id, "repo_id")
    workspace = load_workspace_registration(state, workspace_ref)
    mapping = _variant_snapshot_map(state, _workspace_id(workspace), variant_id)
    return mapping.get(repo_id)


def variant_snapshot_map(state: Any, workspace_id: str, variant_id: str) -> Dict[str, str]:
    """Internal helper for paths.py: repo_id -> latest imported snapshot_id."""
    return _variant_snapshot_map(state, workspace_id, variant_id)
