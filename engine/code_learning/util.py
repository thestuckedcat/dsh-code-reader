"""Small pure helpers: hashing, canonical JSON, atomic writes, UTF-8 ranges."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, Tuple

from .errors import CodeLearningError

_UNSAFE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_SECRET_KEY_NAME = "secret.key"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_now_iso() -> str:
    return utc_now().isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_utc(value: str) -> datetime:
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError("timestamp must carry a timezone")
    return parsed.astimezone(timezone.utc)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def sha256_file(path: Path, limit: Optional[int] = None) -> str:
    hasher = hashlib.sha256()
    remaining = limit
    with open(path, "rb") as handle:
        while True:
            chunk_size = 1 << 20
            if remaining is not None:
                if remaining <= 0:
                    break
                chunk_size = min(chunk_size, remaining)
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            hasher.update(chunk)
            if remaining is not None:
                remaining -= len(chunk)
    return hasher.hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: Any) -> str:
    return sha256_text(canonical_json(value))


def ensure_dir(path: Path) -> Path:
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    return path


def atomic_write(path: Path, data: bytes) -> None:
    """Write bytes through a same-directory temp file and fsync before replace."""
    path = Path(path)
    ensure_dir(path.parent)
    fd, temp_name = tempfile.mkstemp(prefix=".tmp-", dir=str(path.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        if temp_path.exists():
            try:
                temp_path.unlink()
            except OSError:
                pass


def atomic_write_json(path: Path, value: Any) -> None:
    atomic_write(path, (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))


def read_json(path: Path) -> Any:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        raise CodeLearningError("NOT_FOUND", "JSON resource is not present")
    except (OSError, UnicodeDecodeError):
        raise CodeLearningError("DEPENDENCY_UNAVAILABLE", "JSON resource is not readable")
    except json.JSONDecodeError:
        raise CodeLearningError("INVALID_ARGUMENT", "resource is not valid JSON")


def read_json_bytes(data: bytes, label: str = "document") -> Any:
    try:
        return json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise CodeLearningError("INVALID_ARGUMENT", f"{label} is not valid UTF-8 JSON")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def check_id(value: str, label: str) -> str:
    if not isinstance(value, str) or not _UNSAFE_ID.match(value):
        raise CodeLearningError(
            "INVALID_ARGUMENT",
            f"{label} must match [a-z0-9][a-z0-9._-]{{0,63}}",
        )
    return value


def safe_relative_path(value: str, label: str = "path") -> str:
    """Validate a POSIX relative path without traversal or absolute form."""
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise CodeLearningError("INVALID_ARGUMENT", f"{label} must be a non-empty bounded string")
    if "\x00" in value or "\\" in value:
        raise CodeLearningError("INVALID_ARGUMENT", f"{label} must use POSIX separators")
    if value.startswith("/") or value.startswith("./") or value.endswith("/"):
        raise CodeLearningError("INVALID_ARGUMENT", f"{label} must be a normalized relative path")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise CodeLearningError("INVALID_ARGUMENT", f"{label} must not contain empty, '.' or '..' segments")
    return value


def is_inside(child: Path, parent: Path) -> bool:
    """True when ``child`` is ``parent`` or below it after realpath resolution."""
    try:
        child_real = os.path.realpath(str(child))
        parent_real = os.path.realpath(str(parent))
    except OSError:
        return False
    common = os.path.commonpath([child_real, parent_real])
    return common == parent_real


def local_path_from_ref(ref: str, label: str) -> str:
    """Refs are repo-relative POSIX paths; reject absolute/unnormalized input."""
    return safe_relative_path(ref, label)


def decode_utf8_boundary(raw: bytes, start: int, end: int) -> Tuple[int, int]:
    """Widen ``[start, end)`` to UTF-8 character boundaries inside ``raw``.

    ``end`` moves forward past continuation bytes, ``start`` moves backward to
    the leading byte of its character. The returned range is always a subset of
    the original file bytes and stays inside ``[0, len(raw)]``.
    """
    if not 0 <= start < end <= len(raw):
        raise CodeLearningError("INVALID_ARGUMENT", "byte range is outside the file")
    left = start
    while left > 0 and (raw[left] & 0xC0) == 0x80:
        left -= 1
    right = end
    while right < len(raw) and (raw[right] & 0xC0) == 0x80:
        right += 1
    if right > len(raw):  # pragma: no cover - defensive
        right = len(raw)
    return left, right


def clamp_int(value: Any, low: int, high: int, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise CodeLearningError("INVALID_ARGUMENT", f"{label} must be an integer")
    if value < low or value > high:
        raise CodeLearningError("INVALID_ARGUMENT", f"{label} must be between {low} and {high}")
    return value


def now_epoch() -> float:
    return utc_now().timestamp()
