"""Stable error taxonomy shared by every code-learning surface.

The design lists minimum error codes; this module is the single place that
maps them to CLI exit codes.  Domain code never invents an exit code itself.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

EXIT_OK = 0
EXIT_BLOCKED = 2
EXIT_FAILED = 3
EXIT_UNKNOWN = 4

#: Codes that mean "the input, scope or capability boundary blocked the call".
BLOCKED_CODES = frozenset(
    {
        "INVALID_ARGUMENT",
        "NOT_FOUND",
        "SCOPE_DENIED",
        "STALE_PLAN",
        "STALE_SNAPSHOT",
        "STALE_SOURCE",
        "AMBIGUOUS_SYMBOL",
        "CAPABILITY_UNAVAILABLE",
        "UNTRUSTED_COMPILER",
        "EXECUTION_BLOCKED",
        "DEPENDENCY_UNAVAILABLE",
        "UNSUPPORTED_SCHEMA",
        "STATE_CONFLICT",
        "OPERATION_CONFLICT",
        "LIMIT_EXCEEDED",
        "CONFIG_UNAVAILABLE",
    }
)

#: Codes that mean the tool ran but the true outcome cannot be observed.
UNKNOWN_CODES = frozenset({"OUTCOME_UNKNOWN"})


class CodeLearningError(Exception):
    """A structured, model-safe failure.

    ``details`` must stay small and non-secret: it is rendered into tool
    output.  Absolute paths never enter ``message`` for scope-sensitive errors.
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        details: Optional[Dict[str, Any]] = None,
        operation_id: Optional[str] = None,
    ) -> None:
        if not isinstance(code, str) or not code:
            raise ValueError("error code must be a non-empty string")
        self.code = code
        self.message = str(message)
        self.retryable = bool(retryable)
        self.details = details
        self.operation_id = operation_id
        super().__init__(f"{code}: {self.message}")

    @property
    def exit_code(self) -> int:
        if self.code in UNKNOWN_CODES:
            return EXIT_UNKNOWN
        if self.code == "INTERNAL_ERROR":
            return EXIT_FAILED
        if self.code in BLOCKED_CODES:
            return EXIT_BLOCKED
        return EXIT_FAILED

    def payload(self, operation_id: Optional[str] = None) -> Dict[str, Any]:
        error: Dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "details_ref": None,
            "retryable": self.retryable,
        }
        if self.details is not None:
            error["details"] = self.details
        return {
            "schema_version": 1,
            "error": error,
            "operation_id": operation_id if operation_id is not None else self.operation_id,
        }


def fail(code: str, message: str, **kwargs: Any) -> "None":
    """Raise a :class:`CodeLearningError`; typed as None for callers."""
    raise CodeLearningError(code, message, **kwargs)
