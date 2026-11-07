"""Bounded, source-only read entry points (contract section 6).

``find_source`` performs literal-text or exact-filename search inside one
explicit repo-relative glob (``*``/``**``/``?`` only, never a regex), with hard
budgets (128 files / 32 MiB / 200 hits per call).  When a budget is exhausted a
signed cursor is returned; the cursor is bound to the workspace revision, the
query and a digest of the scanned file list, so any source change invalidates it
with ``STALE_SOURCE``.

``read_source`` accepts only a service-issued ``path_ref`` plus its SHA256 and a
byte interval (<= 16 KiB), verifies the MAC, workspace/scope, repository
ownership, file hash and before/after read stability, widens the interval to
UTF-8 character boundaries, and returns a ``SourceEvidence`` projection or
``ref_only`` for binary/suspected-secret content.

``read_evidence`` replays a signed source evidence reference under the same
checks.  Nothing here follows links or leaves a registered repository root, and
source text is always ``semantic_status='blocked'`` (never a compiler fact).
"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import scope
from .errors import CodeLearningError, fail
from .util import decode_utf8_boundary, digest, sha256_bytes, sha256_file, utc_now_iso
from .validation import expect_int, expect_str, hash_hex
from .workspace import load_workspace

#: Per-call find budgets (contract section 2 defaults).
MAX_FIND_FILES = 128
MAX_FIND_BYTES = 32 * 1024 * 1024
MAX_FIND_HITS = 200

#: A single file larger than this is scanned by prefix and reported as limited.
MAX_SCAN_FILE_BYTES = 8 * 1024 * 1024

#: One safe preview / source projection is bounded.
MAX_PREVIEW_CHARS = 240
MAX_READ_BYTES = 16 * 1024

_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_SECRET_PATTERNS = (
    re.compile(
        r"(?i)\b(password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|"
        r"auth[_-]?token|client[_-]?secret|bearer)\b\s*[:=]?\s*\S+"
    ),
    re.compile(r"(?i)\b[A-Z0-9_]*(PASSWORD|SECRET|TOKEN|API[_-]?KEY)[A-Z0-9_]*\s*=\s*\S+"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
)
_SECRET_FILENAMES = frozenset(
    {".env", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "authorized_keys", "credentials"}
)


# ---------------------------------------------------------------------------
# selector / glob validation
# ---------------------------------------------------------------------------
def _validate_selectors(literal: Any, filename: Any) -> Tuple[Optional[str], Optional[str], Optional[bytes]]:
    if (literal is None) == (filename is None):
        fail("INVALID_ARGUMENT", "exactly one of literal or filename must be provided")
    if literal is not None:
        text = expect_str(literal, "literal", max_len=256)
        if re.search(r"[\r\n]", text):
            fail("INVALID_ARGUMENT", "literal must not contain line breaks")
        return text, None, text.encode("utf-8")
    name = expect_str(filename, "filename", max_len=256)
    if "/" in name or "\\" in name or name in (".", ".."):
        fail("INVALID_ARGUMENT", "filename must be a single file name, not a path")
    return None, name, None


def _compile_glob(relative_glob: Any) -> re.Pattern:
    if not isinstance(relative_glob, str) or not relative_glob or len(relative_glob) > 1024:
        fail("INVALID_ARGUMENT", "relative_glob must be a non-empty bounded string")
    if "\x00" in relative_glob or "\\" in relative_glob or re.search(r"[\r\n]", relative_glob):
        fail("INVALID_ARGUMENT", "relative_glob must use POSIX separators without control characters")
    if relative_glob.startswith("/") or relative_glob.endswith("/"):
        fail("INVALID_ARGUMENT", "relative_glob must be a normalized repo-relative pattern")
    parts = relative_glob.split("/")
    if any(part in ("", ".", "..") for part in parts):
        fail("INVALID_ARGUMENT", "relative_glob must not contain empty, '.' or '..' segments")
    tokens: List[str] = []
    for index, part in enumerate(parts):
        last = index == len(parts) - 1
        if part == "**":
            tokens.append("(?:[^/]+/)*[^/]+" if last else "(?:[^/]+/)*")
            continue
        if "**" in part:
            fail("INVALID_ARGUMENT", "'**' must be a whole path segment in relative_glob")
        segment: List[str] = []
        for char in part:
            if char == "*":
                segment.append("[^/]*")
            elif char == "?":
                segment.append("[^/]")
            elif char in "[]{}":
                fail("INVALID_ARGUMENT", "relative_glob only supports '*', '**' and '?' wildcards")
            else:
                segment.append(re.escape(char))
        tokens.append("".join(segment) + ("" if last else "/"))
    return re.compile("^" + "".join(tokens) + "$")


# ---------------------------------------------------------------------------
# candidate enumeration / scan digests / cursors
# ---------------------------------------------------------------------------
def _candidate_files(
    repo_root: Path, pattern: re.Pattern, filename: Optional[str]
) -> List[Dict[str, Any]]:
    candidates: List[Dict[str, Any]] = []
    for full, info in scope.iter_regular_files(repo_root):
        relative = full.relative_to(repo_root).as_posix()
        if not pattern.match(relative):
            continue
        if filename is not None and os.path.basename(relative) != filename:
            continue
        candidates.append(
            {
                "rel": relative,
                "path": full,
                "size": info.st_size,
                "mtime_ns": info.st_mtime_ns,
            }
        )
    candidates.sort(key=lambda item: item["rel"])
    return candidates


def _scan_digest(candidates: List[Dict[str, Any]]) -> str:
    hasher = hashlib.sha256()
    for item in candidates:
        hasher.update(f"{item['rel']}\0{item['size']}\0{item['mtime_ns']}\n".encode("utf-8"))
    return hasher.hexdigest()


def _query_digest(
    literal: Optional[str], filename: Optional[str], relative_glob: str, repo_id: str
) -> str:
    return digest(
        {"literal": literal, "filename": filename, "glob": relative_glob, "repo": repo_id}
    )


def _sign_cursor(
    state,
    *,
    workspace_id: str,
    repo_id: str,
    query_digest: str,
    scan_digest: str,
    workspace_revision: int,
    offset: int,
    pos: int,
    file_sha: Optional[str],
) -> str:
    return state.sign(
        {
            "kind": "cursor",
            "w": workspace_id,
            "r": repo_id,
            "q": query_digest,
            "dg": scan_digest,
            "rev": workspace_revision,
            "o": offset,
            "p": pos,
            "fh": file_sha,
            "g": int(state.scope_generation),
        }
    )


def _load_cursor(
    state,
    cursor: str,
    *,
    workspace: Dict[str, Any],
    repo_id: str,
    query_digest: str,
    scan_digest: str,
    candidates: List[Dict[str, Any]],
) -> Tuple[int, int, Optional[str]]:
    payload = state.verify(cursor, kind="cursor")
    workspace_id = workspace["workspace_id"]
    if payload.get("w") != workspace_id:
        fail("SCOPE_DENIED", "cursor belongs to another workspace")
    if payload.get("r") != repo_id:
        fail("INVALID_ARGUMENT", "cursor belongs to another repository")
    if payload.get("q") != query_digest:
        fail("INVALID_ARGUMENT", "cursor belongs to another source query")
    if payload.get("rev") != workspace.get("revision"):
        fail("STALE_SOURCE", "cursor was issued for another workspace revision")
    if payload.get("dg") != scan_digest:
        fail("STALE_SOURCE", "scanned source files changed since the cursor was issued")
    offset = expect_int(payload.get("o"), "cursor offset", low=0, high=len(candidates))
    pos = expect_int(payload.get("p"), "cursor position", low=0, high=1 << 40)
    file_sha = payload.get("fh")
    if file_sha is not None:
        file_sha = hash_hex(file_sha, "cursor file hash")
    if offset < len(candidates):
        if pos > candidates[offset]["size"]:
            fail("STALE_SOURCE", "cursor position is outside the changed source file")
    elif pos:
        fail("STALE_SOURCE", "cursor position does not match the current source files")
    return offset, pos, file_sha


# ---------------------------------------------------------------------------
# previews / secret classification
# ---------------------------------------------------------------------------
def _line_text(raw: bytes, position: int) -> str:
    line_start = raw.rfind(b"\n", 0, position) + 1
    line_end = raw.find(b"\n", position)
    if line_end < 0:
        line_end = len(raw)
    piece = raw[line_start:line_end]
    return piece.decode("utf-8", "replace").rstrip("\r")


def _line_span(raw: bytes, start: int, end: int) -> Tuple[int, int]:
    line_start = raw.count(b"\n", 0, start) + 1
    last = end - 1 if end > start else start
    line_end = raw.count(b"\n", 0, last) + 1
    return line_start, line_end


def _secret_like(text: str) -> bool:
    if not text:
        return False
    for pattern in _SECRET_PATTERNS:
        if pattern.search(text):
            return True
    return False


def _secret_file_name(relative: str) -> bool:
    name = os.path.basename(relative).lower()
    if name in _SECRET_FILENAMES:
        return True
    return name.endswith((".pem", ".key", ".p12", ".pfx"))


def _preview(text: str) -> str:
    clean = _CONTROL_RE.sub("", text).replace("\t", " ").strip()
    if len(clean) > MAX_PREVIEW_CHARS:
        clean = clean[:MAX_PREVIEW_CHARS] + "..."
    return clean


def _match_document(
    state,
    *,
    workspace: Dict[str, Any],
    repo_id: str,
    variant_id: str,
    relative: str,
    source_sha256: str,
    byte_start: int,
    byte_end: int,
    line_start: int,
    line_end: int,
    preview: Optional[str],
    observed_at: str,
    reason: Optional[str],
) -> Dict[str, Any]:
    path_ref = scope.sign_path_ref(
        state,
        workspace_id=workspace["workspace_id"],
        repo_id=repo_id,
        relative_path=relative,
        source_sha256=source_sha256,
    )
    evidence_ref = scope.sign_evidence_ref(
        state,
        workspace_id=workspace["workspace_id"],
        repo_id=repo_id,
        variant_id=variant_id,
        relative_path=relative,
        source_sha256=source_sha256,
        byte_start=byte_start,
        byte_end=byte_end,
        line_start=line_start,
        line_end=line_end,
        observed_at=observed_at,
    )
    item: Dict[str, Any] = {
        "path_ref": path_ref,
        "evidence_ref": evidence_ref,
        "source_sha256": source_sha256,
        "byte_start": byte_start,
        "byte_end": byte_end,
        "line_start": line_start,
        "line_end": line_end,
        "safe_preview": preview,
    }
    if reason is not None:
        item["reason"] = reason
    return item


# ---------------------------------------------------------------------------
# find_source
# ---------------------------------------------------------------------------
def find_source(
    state,
    workspace_ref: str,
    repo_id: str,
    relative_glob: str,
    literal: Optional[str] = None,
    filename: Optional[str] = None,
    cursor: Optional[str] = None,
) -> Dict[str, Any]:
    workspace = load_workspace(state, workspace_ref)
    scope.find_repository(workspace, repo_id)
    literal_text, filename_text, literal_bytes = _validate_selectors(literal, filename)
    pattern = _compile_glob(relative_glob)
    repo_root = scope.repo_root(state, workspace, repo_id)
    candidates = _candidate_files(repo_root, pattern, filename_text)
    scan_digest = _scan_digest(candidates)
    query_digest = _query_digest(literal_text, filename_text, relative_glob, repo_id)
    workspace_revision = workspace["revision"]
    variant_id = scope.source_variant_id(workspace)

    offset = 0
    pos = 0
    file_sha: Optional[str] = None
    if cursor is not None:
        expect_str(cursor, "cursor", max_len=8192)
        offset, pos, file_sha = _load_cursor(
            state,
            cursor,
            workspace=workspace,
            repo_id=repo_id,
            query_digest=query_digest,
            scan_digest=scan_digest,
            candidates=candidates,
        )

    observed_at = utc_now_iso()
    matches: List[Dict[str, Any]] = []
    scanned_files = 0
    scanned_bytes = 0
    truncated = False
    next_cursor: Optional[str] = None
    limitations = ["text_only_not_compiler_fact"]
    index = offset
    while index < len(candidates):
        candidate = candidates[index]
        full = candidate["path"]
        if scanned_files >= MAX_FIND_FILES:
            truncated = True
            next_cursor = _sign_cursor(
                state,
                workspace_id=workspace["workspace_id"],
                repo_id=repo_id,
                query_digest=query_digest,
                scan_digest=scan_digest,
                workspace_revision=workspace_revision,
                offset=index,
                pos=0,
                file_sha=None,
            )
            break
        read_length = min(candidate["size"], MAX_SCAN_FILE_BYTES)
        if scanned_bytes + read_length > MAX_FIND_BYTES and scanned_files > 0:
            truncated = True
            next_cursor = _sign_cursor(
                state,
                workspace_id=workspace["workspace_id"],
                repo_id=repo_id,
                query_digest=query_digest,
                scan_digest=scan_digest,
                workspace_revision=workspace_revision,
                offset=index,
                pos=0,
                file_sha=None,
            )
            break
        try:
            with open(full, "rb") as handle:
                raw = handle.read(read_length)
        except OSError:
            index += 1
            pos = 0
            file_sha = None
            continue
        scanned_files += 1
        scanned_bytes += len(raw)
        if len(raw) < candidate["size"]:
            # The per-file read window is bounded (8 MiB); searching only a
            # prefix is an incomplete scan and must be reported, not hidden.
            limitations.append("large_file_prefix_only")
            truncated = True
        if index == offset and pos and file_sha is not None:
            if sha256_bytes(raw) != file_sha:
                fail("STALE_SOURCE", "source file changed since the cursor was issued")
        complete = len(raw) >= candidate["size"]
        binary = b"\x00" in raw or _decode_text(raw, complete) is None
        source_sha = sha256_file(full)

        if literal_bytes is not None:
            search_pos = pos if (index == offset and pos) else 0
            found = raw.find(literal_bytes, search_pos)
            if binary:
                while found >= 0:
                    if len(matches) >= MAX_FIND_HITS:
                        truncated = True
                        next_cursor = _sign_cursor(
                            state,
                            workspace_id=workspace["workspace_id"],
                            repo_id=repo_id,
                            query_digest=query_digest,
                            scan_digest=scan_digest,
                            workspace_revision=workspace_revision,
                            offset=index,
                            pos=found,
                            file_sha=sha256_bytes(raw),
                        )
                        break
                    line_start, line_end = _line_span(raw, found, found + len(literal_bytes))
                    matches.append(
                        _match_document(
                            state,
                            workspace=workspace,
                            repo_id=repo_id,
                            variant_id=variant_id,
                            relative=candidate["rel"],
                            source_sha256=source_sha,
                            byte_start=found,
                            byte_end=found + len(literal_bytes),
                            line_start=line_start,
                            line_end=line_end,
                            preview=None,
                            observed_at=observed_at,
                            reason="binary_file",
                        )
                    )
                    found = raw.find(literal_bytes, found + len(literal_bytes))
            else:
                while found >= 0:
                    if len(matches) >= MAX_FIND_HITS:
                        truncated = True
                        next_cursor = _sign_cursor(
                            state,
                            workspace_id=workspace["workspace_id"],
                            repo_id=repo_id,
                            query_digest=query_digest,
                            scan_digest=scan_digest,
                            workspace_revision=workspace_revision,
                            offset=index,
                            pos=found,
                            file_sha=sha256_bytes(raw),
                        )
                        break
                    line_text = _line_text(raw, found)
                    secret = _secret_like(line_text) or _secret_file_name(candidate["rel"])
                    line_start, line_end = _line_span(raw, found, found + len(literal_bytes))
                    matches.append(
                        _match_document(
                            state,
                            workspace=workspace,
                            repo_id=repo_id,
                            variant_id=variant_id,
                            relative=candidate["rel"],
                            source_sha256=source_sha,
                            byte_start=found,
                            byte_end=found + len(literal_bytes),
                            line_start=line_start,
                            line_end=line_end,
                            preview=None if secret else _preview(line_text),
                            observed_at=observed_at,
                            reason="secret_suspected" if secret else None,
                        )
                    )
                    found = raw.find(literal_bytes, found + len(literal_bytes))
            if truncated:
                break
        else:
            # Exact filename match: evidence points at the first (bounded) line.
            if len(matches) >= MAX_FIND_HITS:
                truncated = True
                if index + 1 < len(candidates):
                    next_cursor = _sign_cursor(
                        state,
                        workspace_id=workspace["workspace_id"],
                        repo_id=repo_id,
                        query_digest=query_digest,
                        scan_digest=scan_digest,
                        workspace_revision=workspace_revision,
                        offset=index + 1,
                        pos=0,
                        file_sha=None,
                    )
                break
            secret = _secret_file_name(candidate["rel"])
            if binary:
                byte_end = min(len(raw), 512)
                if byte_end <= 0:
                    index += 1
                    continue
                matches.append(
                    _match_document(
                        state,
                        workspace=workspace,
                        repo_id=repo_id,
                        variant_id=variant_id,
                        relative=candidate["rel"],
                        source_sha256=source_sha,
                        byte_start=0,
                        byte_end=byte_end,
                        line_start=1,
                        line_end=1,
                        preview=None,
                        observed_at=observed_at,
                        reason="binary_file",
                    )
                )
            else:
                first_newline = raw.find(b"\n")
                byte_end = first_newline + 1 if first_newline >= 0 else len(raw)
                byte_end = min(byte_end, MAX_READ_BYTES)
                if byte_end <= 0:
                    index += 1
                    continue
                line_text = _line_text(raw, 0)
                secret = secret or _secret_like(line_text)
                matches.append(
                    _match_document(
                        state,
                        workspace=workspace,
                        repo_id=repo_id,
                        variant_id=variant_id,
                        relative=candidate["rel"],
                        source_sha256=source_sha,
                        byte_start=0,
                        byte_end=byte_end,
                        line_start=1,
                        line_end=1,
                        preview=None if secret else _preview(line_text),
                        observed_at=observed_at,
                        reason="secret_suspected" if secret else None,
                    )
                )
        index += 1
        pos = 0
        file_sha = None

    return {
        "schema_version": 1,
        "matches": matches,
        "next_cursor": next_cursor,
        "scanned_files": scanned_files,
        "scanned_bytes": scanned_bytes,
        "truncated": truncated,
        "semantic_status": "blocked",
        "limitations": limitations,
    }


def _decode_text(raw: bytes, complete: bool) -> Optional[str]:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        if complete:
            return None
        for trim in range(1, 4):
            if trim >= len(raw):
                break
            try:
                return raw[:-trim].decode("utf-8")
            except UnicodeDecodeError:
                continue
        return None


# ---------------------------------------------------------------------------
# interval reading (shared by read_source / read_evidence)
# ---------------------------------------------------------------------------
def _line_span_file(path: Path, start: int, end: int) -> Tuple[int, int]:
    counts = _count_newlines(path, (start, end - 1 if end > start else start))
    return counts[0] + 1, counts[1] + 1


def _count_newlines(path: Path, targets: Tuple[int, int]) -> Tuple[int, int]:
    counts = [0, 0]
    position = 0
    max_target = max(targets)
    with open(path, "rb") as handle:
        while position <= max_target:
            chunk = handle.read(1 << 20)
            if not chunk:
                break
            chunk_start = position
            chunk_end = chunk_start + len(chunk)
            for index, target in enumerate(targets):
                if target <= chunk_start or target > chunk_end:
                    continue
                counts[index] += chunk[: target - chunk_start].count(b"\n")
            position = chunk_end
            if chunk_end > max_target:
                break
    return counts[0], counts[1]


def _read_interval(
    state,
    workspace: Dict[str, Any],
    repo_id: str,
    relative_path: str,
    expected_sha256: str,
    start: int,
    end: int,
) -> Dict[str, Any]:
    path = scope.resolve_repo_file(state, workspace, repo_id, relative_path, must_exist=True)
    try:
        initial = path.stat()
    except OSError:
        fail("NOT_FOUND", "source file is not available")
    size = initial.st_size
    hasher = hashlib.sha256()
    with open(path, "rb") as handle:
        before = os.fstat(handle.fileno())
        while True:
            chunk = handle.read(1 << 20)
            if not chunk:
                break
            hasher.update(chunk)
        context_start = min(max(0, start - 4), size)
        context_end = min(size, max(context_start, end + 4))
        handle.seek(context_start)
        window = handle.read(context_end - context_start)
        after = os.fstat(handle.fileno())
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        fail("STALE_SOURCE", "source file changed while it was being read")
    actual_sha = hasher.hexdigest()
    if actual_sha != expected_sha256:
        fail("STALE_SOURCE", "source file content hash does not match the reference")
    if start >= size or end > size:
        fail("INVALID_ARGUMENT", "byte range is outside the file")
    left, right = decode_utf8_boundary(window, start - context_start, end - context_start)
    actual_start = context_start + left
    actual_end = context_start + right
    snippet = window[left:right]
    outcome = "text"
    reason: Optional[str] = None
    text: Optional[str] = None
    if b"\x00" not in snippet:
        try:
            text = snippet.decode("utf-8")
        except UnicodeDecodeError:
            text = None
    if text is None:
        outcome = "ref_only"
        reason = "binary"
    elif _secret_like(text):
        outcome = "ref_only"
        reason = "secret_suspected"
    line_start, line_end = _line_span_file(path, actual_start, actual_end)
    return {
        "path": path,
        "size": size,
        "sha": actual_sha,
        "text": text,
        "outcome": outcome,
        "reason": reason,
        "actual_start": actual_start,
        "actual_end": actual_end,
        "line_start": line_start,
        "line_end": line_end,
    }


# ---------------------------------------------------------------------------
# read_source / read_evidence
# ---------------------------------------------------------------------------
def read_source(
    state,
    workspace_ref: str,
    path_ref: str,
    expected_sha256: str,
    byte_start: int,
    byte_end: int,
) -> Dict[str, Any]:
    workspace = load_workspace(state, workspace_ref)
    payload = scope.verify_path_ref(state, path_ref, workspace_id=workspace["workspace_id"])
    expected = hash_hex(expected_sha256, "expected_sha256")
    if payload["s"] != expected:
        fail("INVALID_ARGUMENT", "expected_sha256 does not match the path reference")
    start = expect_int(byte_start, "byte_start", low=0, high=1 << 40)
    end = expect_int(byte_end, "byte_end", low=0, high=1 << 40)
    if start >= end:
        fail("INVALID_ARGUMENT", "byte range must satisfy 0 <= byte_start < byte_end")
    if end - start > MAX_READ_BYTES:
        fail(
            "LIMIT_EXCEEDED",
            "source projection is limited to 16384 bytes",
            details={"limit": MAX_READ_BYTES},
        )
    interval = _read_interval(
        state, workspace, payload["r"], payload["p"], payload["s"], start, end
    )
    observed_at = utc_now_iso()
    variant_id = scope.source_variant_id(workspace)
    evidence_ref = scope.sign_evidence_ref(
        state,
        workspace_id=workspace["workspace_id"],
        repo_id=payload["r"],
        variant_id=variant_id,
        relative_path=payload["p"],
        source_sha256=payload["s"],
        byte_start=interval["actual_start"],
        byte_end=interval["actual_end"],
        line_start=interval["line_start"],
        line_end=interval["line_end"],
        observed_at=observed_at,
    )
    evidence_payload = {
        "r": payload["r"],
        "p": payload["p"],
        "s": payload["s"],
        "v": variant_id,
        "b": interval["actual_start"],
        "e": interval["actual_end"],
        "ls": interval["line_start"],
        "le": interval["line_end"],
        "t": observed_at,
    }
    result: Dict[str, Any] = {
        "schema_version": 1,
        "evidence": scope.source_evidence_document(evidence_payload, evidence_ref),
        "actual_byte_start": interval["actual_start"],
        "actual_byte_end": interval["actual_end"],
    }
    if interval["outcome"] == "text":
        result["safe_text"] = interval["text"]
    else:
        result["ref_only"] = {"reason": interval["reason"]}
        result["reason"] = interval["reason"]
    return result


def read_evidence(
    state,
    workspace_ref: str,
    evidence_ref: str,
    max_bytes: int = MAX_READ_BYTES,
) -> Dict[str, Any]:
    workspace = load_workspace(state, workspace_ref)
    payload = scope.verify_evidence_ref(
        state, evidence_ref, workspace_id=workspace["workspace_id"]
    )
    limit = expect_int(max_bytes, "max_bytes", low=1, high=MAX_READ_BYTES)
    span = payload["e"] - payload["b"]
    if span > limit:
        fail(
            "LIMIT_EXCEEDED",
            "evidence byte interval exceeds max_bytes",
            details={"limit": limit, "span": span},
        )
    interval = _read_interval(
        state, workspace, payload["r"], payload["p"], payload["s"], payload["b"], payload["e"]
    )
    evidence = scope.source_evidence_document(payload, evidence_ref)
    result: Dict[str, Any] = {
        "schema_version": 1,
        "evidence": evidence,
        "actual_byte_start": interval["actual_start"],
        "actual_byte_end": interval["actual_end"],
    }
    if interval["outcome"] == "text":
        result["safe_text"] = interval["text"]
    else:
        result["ref_only"] = {"reason": interval["reason"]}
        result["reason"] = interval["reason"]
    return result
