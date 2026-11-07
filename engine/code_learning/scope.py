"""Signed path/evidence references and safe repository path resolution.

Contract surface (docs/implementation-contract.md section 4/6):

* ``path_ref`` = ``state.sign({"kind":"path","w":wid,"r":repo,"p":relpath,
  "s":sha,"g":scope_generation})`` -- a service-issued reference to one
  repo-relative file plus its content SHA256.
* ``evidence_ref`` (kind ``source``) additionally carries the byte interval,
  line span, variant and observation timestamp.
* Repository paths are always resolved from *registered* roots: the declared
  candidate root in the bootstrap, the repository ``relative_path`` and the
  internal registration ``absolute_path`` must agree, every component must be
  a plain directory/file (no symlink or Windows junction), and the final file
  must stay inside its repository root.

Nothing here reads a bootstrap file or takes an absolute path from a tool
payload.  ``build.py``/``source.py`` never resolve user-provided paths directly.
"""

from __future__ import annotations

import os
import stat as stat_module
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

from .errors import CodeLearningError, fail
from .util import check_id, digest, safe_relative_path, sha256_file
from .validation import expect_int, expect_str, hash_hex

#: Directories never traversed when building a conservative source manifest,
#: scanning for text, or resolving a repository file.
IGNORED_DIRECTORIES = frozenset({".git", "node_modules", "__pycache__"})

#: Windows reparse point attribute (symlinks and junctions).
_FILE_ATTRIBUTE_REPARSE_POINT = 0x400

#: Evidence intervals are bounded like one source-read projection.
MAX_EVIDENCE_SPAN = 16 * 1024

#: Reference files (compdb/config/generated headers) use content hashes up to
#: this size; larger files fall back to a size+mtime digest (contract section 5).
REFERENCE_DIGEST_LIMIT = 16 * 1024 * 1024


# ---------------------------------------------------------------------------
# low level path helpers
# ---------------------------------------------------------------------------
def _normalized(path: Any) -> str:
    return os.path.normcase(os.path.normpath(str(path)))


def is_reparse_point(path: Path) -> bool:
    """True for symlinks and Windows junctions (reparse points)."""
    candidate = Path(path)
    try:
        info = os.stat(str(candidate), follow_symlinks=False)
    except OSError:
        return False
    if os.path.islink(str(candidate)):
        return True
    attributes = getattr(info, "st_file_attributes", 0)
    return bool(attributes & _FILE_ATTRIBUTE_REPARSE_POINT)


def _real(path: Path) -> Path:
    return Path(os.path.realpath(str(path)))


def _same_path(left: Path, right: Path) -> bool:
    return _normalized(left) == _normalized(right)


def _is_inside(child: Path, parent: Path) -> bool:
    try:
        common = os.path.commonpath([_normalized(child), _normalized(parent)])
    except ValueError:
        return False
    return common == _normalized(parent)


def _plain_dir(path: Path, label: str) -> Path:
    """Return ``path`` if it is an existing, non-reparse real directory."""
    candidate = Path(path)
    if not candidate.exists():
        fail("NOT_FOUND", f"{label} does not exist")
    if not candidate.is_dir():
        fail("INVALID_ARGUMENT", f"{label} must be a directory")
    if is_reparse_point(candidate):
        fail("SCOPE_DENIED", f"{label} must not be a symlink or junction")
    if not _same_path(_real(candidate), candidate):
        fail("SCOPE_DENIED", f"{label} must resolve to its registered path")
    return candidate


def _plain_file(path: Path, label: str) -> Path:
    candidate = Path(path)
    if not candidate.exists():
        fail("NOT_FOUND", f"{label} does not exist")
    if is_reparse_point(candidate):
        fail("SCOPE_DENIED", f"{label} must not be a symlink or junction")
    try:
        info = os.stat(str(candidate), follow_symlinks=False)
    except OSError:
        fail("DEPENDENCY_UNAVAILABLE", f"{label} is not readable")
    if not stat_module.S_ISREG(info.st_mode):
        fail("INVALID_ARGUMENT", f"{label} must be a regular file")
    return candidate


def iter_regular_files(root: Path) -> Iterator[Tuple[Path, os.stat_result]]:
    """Yield ``(path, stat)`` for regular files below ``root``.

    Directories in :data:`IGNORED_DIRECTORIES`, symlinks and junctions are
    skipped; the walk is deterministic (sorted names).
    """
    base = Path(root)
    for dirpath, dirnames, filenames in os.walk(str(base), followlinks=False):
        dirnames[:] = sorted(
            name
            for name in dirnames
            if name not in IGNORED_DIRECTORIES and not is_reparse_point(Path(dirpath) / name)
        )
        for name in sorted(filenames):
            full = Path(dirpath) / name
            if is_reparse_point(full):
                continue
            try:
                info = os.stat(str(full), follow_symlinks=False)
            except OSError:
                continue
            if stat_module.S_ISREG(info.st_mode):
                yield full, info


# ---------------------------------------------------------------------------
# workspace repository lookup
# ---------------------------------------------------------------------------
def repositories(workspace: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw = workspace.get("repositories")
    if not isinstance(raw, list) or not raw:
        fail("UNSUPPORTED_SCHEMA", "workspace registration has no repositories")
    return raw


def find_repository(workspace: Dict[str, Any], repo_id: str) -> Dict[str, Any]:
    for repo in repositories(workspace):
        if repo.get("repo_id") == repo_id:
            return repo
    fail("NOT_FOUND", "repository is not registered in this workspace")


def repo_ids(workspace: Dict[str, Any]) -> List[str]:
    return [repo["repo_id"] for repo in repositories(workspace)]


def _declared_root(workspace: Dict[str, Any], repo_id: str) -> Tuple[Dict[str, Any], Path, str]:
    repo = find_repository(workspace, repo_id)
    relative = safe_relative_path(repo.get("relative_path"), f"repository {repo_id} relative_path")
    stored = repo.get("absolute_path")
    if not isinstance(stored, str) or not stored:
        fail("UNSUPPORTED_SCHEMA", "workspace registration repository has no absolute_path")
    return repo, Path(stored), relative


def repo_root_registered(workspace: Dict[str, Any], repo_id: str) -> Path:
    """Resolve a repository root using only the registration (no bootstrap)."""
    _, root, relative = _declared_root(workspace, repo_id)
    if not root.exists() or not root.is_dir():
        fail("NOT_FOUND", "registered repository root is not available")
    if is_reparse_point(root):
        fail("SCOPE_DENIED", "registered repository root must not be a symlink or junction")
    if not _same_path(_real(root), root):
        fail("SCOPE_DENIED", "registered repository root resolves elsewhere")
    return root


def repo_root(state, workspace: Dict[str, Any], repo_id: str) -> Path:
    """Resolve a repository root and re-verify it against the live bootstrap."""
    repo, stored, relative = _declared_root(workspace, repo_id)
    root_ref = repo.get("root_ref")
    if not isinstance(root_ref, str) or not root_ref:
        fail("UNSUPPORTED_SCHEMA", "workspace registration repository has no root_ref")
    candidate = state.resolve_root(root_ref)
    _plain_dir(candidate, "registered candidate root")
    expected = Path(os.path.normpath(os.path.join(str(candidate), *relative.split("/"))))
    if not _same_path(stored, expected):
        fail("SCOPE_DENIED", "repository root no longer matches its registered root")
    return _plain_dir(expected, f"repository {repo_id} root")


def _walk_repo_components(root: Path, relative: str) -> Path:
    current = root
    for part in relative.split("/"):
        current = current / part
        if is_reparse_point(current):
            fail("SCOPE_DENIED", "path must not traverse a symlink or junction")
    if not _is_inside(_real(current), root):
        fail("SCOPE_DENIED", "path leaves the registered repository root")
    return current


def resolve_repo_file(
    state,
    workspace: Dict[str, Any],
    repo_id: str,
    relative_path: str,
    *,
    must_exist: bool = True,
) -> Path:
    relative = safe_relative_path(relative_path, "repository path")
    root = repo_root(state, workspace, repo_id)
    candidate = _walk_repo_components(root, relative)
    if must_exist:
        return _plain_file(candidate, "source file")
    return candidate


def resolve_registered_repo_file(
    workspace: Dict[str, Any],
    repo_id: str,
    relative_path: str,
    *,
    must_exist: bool = True,
) -> Path:
    relative = safe_relative_path(relative_path, "repository path")
    root = repo_root_registered(workspace, repo_id)
    candidate = _walk_repo_components(root, relative)
    if must_exist:
        return _plain_file(candidate, "source file")
    return candidate


def split_ref(ref: str) -> Tuple[str, str]:
    if not isinstance(ref, str) or ref.count(":") != 1:
        fail("INVALID_ARGUMENT", "reference must use the '<repo_id>:<relative/path>' form")
    repo_id, relative = ref.split(":", 1)
    check_id(repo_id, "reference repo_id")
    safe_relative_path(relative, "reference path")
    return repo_id, relative


def resolve_ref_file(state, workspace: Dict[str, Any], ref: str) -> Path:
    repo_id, relative = split_ref(ref)
    return resolve_repo_file(state, workspace, repo_id, relative, must_exist=True)


def resolve_registered_ref_file(workspace: Dict[str, Any], ref: str) -> Path:
    repo_id, relative = split_ref(ref)
    return resolve_registered_repo_file(workspace, repo_id, relative, must_exist=True)


def file_digest(path: Path, *, limit: int = REFERENCE_DIGEST_LIMIT) -> str:
    """Content SHA256 (<= limit) or a size+mtime digest for larger files."""
    candidate = _plain_file(path, "reference file")
    info = candidate.stat()
    if info.st_size > limit:
        return digest({"size": info.st_size, "mtime_ns": info.st_mtime_ns})
    return sha256_file(candidate)


def ref_file_digest(state, workspace: Dict[str, Any], ref: str) -> str:
    return file_digest(resolve_ref_file(state, workspace, ref))


def ref_file_digest_registered(workspace: Dict[str, Any], ref: str) -> str:
    return file_digest(resolve_registered_ref_file(workspace, ref))


# ---------------------------------------------------------------------------
# signed path references
# ---------------------------------------------------------------------------
def sign_path_ref(
    state,
    *,
    workspace_id: str,
    repo_id: str,
    relative_path: str,
    source_sha256: str,
) -> str:
    check_id(workspace_id, "workspace_id")
    check_id(repo_id, "repo_id")
    relative = safe_relative_path(relative_path, "relative_path")
    sha = hash_hex(source_sha256, "source_sha256")
    return state.sign(
        {
            "kind": "path",
            "w": workspace_id,
            "r": repo_id,
            "p": relative,
            "s": sha,
            "g": int(state.scope_generation),
        }
    )


def verify_path_ref(state, path_ref: str, *, workspace_id: Optional[str] = None) -> Dict[str, Any]:
    payload = state.verify(path_ref, kind="path")
    workspace = payload.get("w")
    repo_id = payload.get("r")
    if not isinstance(workspace, str) or not isinstance(repo_id, str):
        fail("INVALID_ARGUMENT", "path reference payload is malformed")
    if workspace_id is not None and workspace != workspace_id:
        fail("SCOPE_DENIED", "path reference belongs to another workspace")
    check_id(workspace, "path reference workspace")
    check_id(repo_id, "path reference repository")
    relative = safe_relative_path(payload.get("p"), "path reference path")
    sha = hash_hex(payload.get("s"), "path reference hash")
    return {"w": workspace, "r": repo_id, "p": relative, "s": sha}


# ---------------------------------------------------------------------------
# signed source evidence references
# ---------------------------------------------------------------------------
def sign_evidence_ref(
    state,
    *,
    workspace_id: str,
    repo_id: str,
    variant_id: str,
    relative_path: str,
    source_sha256: str,
    byte_start: int,
    byte_end: int,
    line_start: int,
    line_end: int,
    observed_at: str,
) -> str:
    check_id(workspace_id, "workspace_id")
    check_id(repo_id, "repo_id")
    check_id(variant_id, "variant_id")
    relative = safe_relative_path(relative_path, "relative_path")
    sha = hash_hex(source_sha256, "source_sha256")
    start = expect_int(byte_start, "byte_start", low=0, high=1 << 40)
    end = expect_int(byte_end, "byte_end", low=0, high=1 << 40)
    if not 0 <= start < end <= MAX_EVIDENCE_SPAN + start:
        fail("INVALID_ARGUMENT", "evidence byte interval must be positive and non-empty")
    span = end - start
    if span > MAX_EVIDENCE_SPAN:
        fail("LIMIT_EXCEEDED", "evidence byte interval exceeds the bounded source projection")
    first_line = expect_int(line_start, "line_start", low=1, high=1 << 31)
    last_line = expect_int(line_end, "line_end", low=1, high=1 << 31)
    if last_line < first_line:
        fail("INVALID_ARGUMENT", "line_end must not be smaller than line_start")
    observed = expect_str(observed_at, "observed_at", max_len=64)
    return state.sign(
        {
            "kind": "source",
            "w": workspace_id,
            "r": repo_id,
            "p": relative,
            "s": sha,
            "b": start,
            "e": end,
            "v": variant_id,
            "ls": first_line,
            "le": last_line,
            "t": observed,
            "g": int(state.scope_generation),
        }
    )


def verify_evidence_ref(
    state, evidence_ref: str, *, workspace_id: Optional[str] = None
) -> Dict[str, Any]:
    payload = state.verify(evidence_ref, kind="source")
    workspace = payload.get("w")
    repo_id = payload.get("r")
    variant_id = payload.get("v")
    if not all(isinstance(value, str) for value in (workspace, repo_id, variant_id)):
        fail("INVALID_ARGUMENT", "evidence reference payload is malformed")
    if workspace_id is not None and workspace != workspace_id:
        fail("SCOPE_DENIED", "evidence reference belongs to another workspace")
    check_id(workspace, "evidence workspace")
    check_id(repo_id, "evidence repository")
    check_id(variant_id, "evidence variant")
    relative = safe_relative_path(payload.get("p"), "evidence path")
    sha = hash_hex(payload.get("s"), "evidence source hash")
    start = payload.get("b")
    end = payload.get("e")
    if isinstance(start, bool) or not isinstance(start, int) or start < 0:
        fail("INVALID_ARGUMENT", "evidence byte_start is malformed")
    if isinstance(end, bool) or not isinstance(end, int):
        fail("INVALID_ARGUMENT", "evidence byte_end is malformed")
    if not 0 <= start < end:
        fail("INVALID_ARGUMENT", "evidence byte interval is malformed")
    if end - start > MAX_EVIDENCE_SPAN:
        fail("INVALID_ARGUMENT", "evidence byte interval exceeds the bounded projection")
    first_line = expect_int(payload.get("ls"), "evidence line_start", low=1, high=1 << 31)
    last_line = expect_int(payload.get("le"), "evidence line_end", low=1, high=1 << 31)
    if last_line < first_line:
        fail("INVALID_ARGUMENT", "evidence line span is malformed")
    observed_at = expect_str(payload.get("t"), "evidence observed_at", max_len=64)
    return {
        "w": workspace,
        "r": repo_id,
        "p": relative,
        "s": sha,
        "b": start,
        "e": end,
        "v": variant_id,
        "ls": first_line,
        "le": last_line,
        "t": observed_at,
    }


def source_evidence_document(payload: Dict[str, Any], evidence_ref: str) -> Dict[str, Any]:
    """Project a verified evidence payload into ``SourceEvidence``."""
    return {
        "evidence_ref": evidence_ref,
        "repo_id": payload["r"],
        "variant_id": payload["v"],
        "snapshot_id": None,
        "source_ref": f"{payload['r']}:{payload['p']}",
        "source_sha256": payload["s"],
        "byte_start": payload["b"],
        "byte_end": payload["e"],
        "line_start": payload["ls"],
        "line_end": payload["le"],
        "origin": "source_text",
        "semantic_status": "blocked",
        "limitations": ["text_only_not_compiler_fact"],
        "observed_at": payload["t"],
    }


# ---------------------------------------------------------------------------
# workspace helpers
# ---------------------------------------------------------------------------
def ensure_plain_directory(path: Any, label: str) -> Path:
    """Public wrapper: existing, real (non-reparse) directory."""
    return _plain_dir(Path(path), label)


def ensure_plain_file(path: Any, label: str) -> Path:
    """Public wrapper: existing, real (non-reparse) regular file."""
    return _plain_file(Path(path), label)


def paths_overlap(left: Any, right: Any) -> bool:
    """True when either real path contains the other (identity or nesting)."""
    try:
        left_real = _real(Path(left))
        right_real = _real(Path(right))
    except OSError:
        return False
    return _is_inside(left_real, right_real) or _is_inside(right_real, left_real)


def find_variant(workspace: Dict[str, Any], variant_id: str) -> Dict[str, Any]:
    for variant in workspace.get("variants") or []:
        if isinstance(variant, dict) and variant.get("variant_id") == variant_id:
            return variant
    fail("NOT_FOUND", "variant is not registered in this workspace")


def source_variant_id(workspace: Dict[str, Any]) -> str:
    """Deterministic variant for source-text evidence.

    Source text is not compiler-derived; if a ``source_only`` variant exists it
    is the natural owner of text evidence, otherwise the first variant is used.
    """
    variants = workspace.get("variants") or []
    for variant in variants:
        if isinstance(variant, dict) and variant.get("analysis_mode") == "source_only":
            return variant["variant_id"]
    if not variants:
        fail("UNSUPPORTED_SCHEMA", "workspace registration has no variants")
    return variants[0]["variant_id"]
