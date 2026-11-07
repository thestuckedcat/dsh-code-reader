"""Strict, dependency-free validation helpers shared by all modules.

Every helper raises :class:`CodeLearningError` with ``INVALID_ARGUMENT``; none
of them mutate input.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional, Sequence

from .errors import CodeLearningError

_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def fail(code: str, message: str, **kwargs: Any) -> "None":
    raise CodeLearningError(code, message, **kwargs)


def expect_object(value: Any, where: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        fail("INVALID_ARGUMENT", f"{where} must be an object")
    return value


def expect_array(value: Any, where: str, *, min_items: int = 0, max_items: int = 10000) -> List[Any]:
    if not isinstance(value, list):
        fail("INVALID_ARGUMENT", f"{where} must be an array")
    if len(value) < min_items or len(value) > max_items:
        fail("INVALID_ARGUMENT", f"{where} must contain between {min_items} and {max_items} items")
    return value


def expect_bool(value: Any, where: str) -> bool:
    if not isinstance(value, bool):
        fail("INVALID_ARGUMENT", f"{where} must be a boolean")
    return value


def expect_int(value: Any, where: str, *, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        fail("INVALID_ARGUMENT", f"{where} must be an integer")
    if value < low or value > high:
        fail("INVALID_ARGUMENT", f"{where} must be between {low} and {high}")
    return value


def expect_str(
    value: Any,
    where: str,
    *,
    min_len: int = 1,
    max_len: int = 256,
    pattern: Optional[re.Pattern] = None,
    allow_empty: bool = False,
) -> str:
    if not isinstance(value, str):
        fail("INVALID_ARGUMENT", f"{where} must be a string")
    if not allow_empty and len(value) < min_len:
        fail("INVALID_ARGUMENT", f"{where} must be at least {min_len} characters")
    if len(value) > max_len:
        fail("INVALID_ARGUMENT", f"{where} must be at most {max_len} characters")
    if _CONTROL_RE.search(value):
        fail("INVALID_ARGUMENT", f"{where} contains control characters")
    if pattern is not None and not pattern.match(value):
        fail("INVALID_ARGUMENT", f"{where} has an unsupported format")
    return value


def reject_unknown(value: Dict[str, Any], allowed: Iterable[str], where: str) -> None:
    unknown = sorted(set(value) - set(allowed))
    if unknown:
        fail("INVALID_ARGUMENT", f"{where} contains unknown fields: {', '.join(unknown)}")


def require_keys(value: Dict[str, Any], keys: Sequence[str], where: str) -> None:
    missing = [key for key in keys if key not in value]
    if missing:
        fail("INVALID_ARGUMENT", f"{where} is missing required fields: {', '.join(missing)}")


def optional_keys(value: Dict[str, Any], keys: Sequence[str], where: str) -> None:
    present = [key for key in keys if key in value]
    if len(present) > 1:
        fail("INVALID_ARGUMENT", f"{where} accepts at most one of: {', '.join(keys)}")


def one_of(value: Any, choices: Sequence[str], where: str) -> str:
    if not isinstance(value, str) or value not in choices:
        fail("INVALID_ARGUMENT", f"{where} must be one of: {', '.join(choices)}")
    return value


def hash_hex(value: Any, where: str) -> str:
    if not isinstance(value, str) or not _HASH_RE.match(value):
        fail("INVALID_ARGUMENT", f"{where} must be a lowercase SHA256 hex string")
    return value


def nullable_hash(value: Any, where: str) -> Optional[str]:
    if value is None:
        return None
    return hash_hex(value, where)


def ref_path(value: Any, where: str) -> str:
    """Validate a manifest ``repo_id:relative/path`` reference."""
    from .util import check_id, safe_relative_path

    if not isinstance(value, str) or value.count(":") != 1:
        fail("INVALID_ARGUMENT", f"{where} must use the '<repo_id>:<relative/path>' form")
    repo_id, relative = value.split(":", 1)
    check_id(repo_id, f"{where} repo_id")
    safe_relative_path(relative, f"{where} path")
    return value


def normalized_utc(value: Any, where: str) -> str:
    from .util import parse_utc

    if not isinstance(value, str):
        fail("INVALID_ARGUMENT", f"{where} must be an RFC3339 string")
    try:
        parse_utc(value)
    except ValueError:
        fail("INVALID_ARGUMENT", f"{where} must be an RFC3339 timestamp with timezone")
    return value
