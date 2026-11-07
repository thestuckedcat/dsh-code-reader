"""Local trusted bootstrap configuration, state layout and signed references.

Everything that decides *where* data may be read or written is resolved here
from a human/Host-owned bootstrap file.  Tool payloads never contribute an
absolute path, a state directory or a secret key.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import hmac
import json
import os
import stat as stat_module
import time
from pathlib import Path
from typing import Any, Dict, Iterator, Optional, Tuple

from .errors import CodeLearningError, fail
from .util import (
    atomic_write,
    atomic_write_json,
    ensure_dir,
    read_json,
    sha256_text,
    utc_now_iso,
)

BOOTSTRAP_ENV = "CODE_READER_BOOTSTRAP"
TOKEN_PREFIX = "v1"
_MAX_JSON_BYTES = 16 * 1024 * 1024
_LOCK_TIMEOUT_S = 10.0
_LOCK_STALE_S = 120.0
_FILE_ATTRIBUTE_REPARSE_POINT = 0x400


def _is_reparse_path(path: Path) -> bool:
    """True for a symlink or Windows junction (reparse point) path itself."""
    try:
        info = os.lstat(str(path))
    except OSError:
        return False
    if stat_module.S_ISLNK(info.st_mode):
        return True
    return bool(getattr(info, "st_file_attributes", 0) & _FILE_ATTRIBUTE_REPARSE_POINT)


def default_dsh_home() -> Path:
    configured = os.environ.get("DSH_HOME")
    if configured:
        return Path(configured)
    return Path.home() / ".dsh"


def default_bootstrap_path() -> Path:
    return default_dsh_home() / "code-reader" / "bootstrap.json"


def resolve_bootstrap_path(explicit: Optional[str] = None) -> Path:
    if explicit:
        return Path(explicit)
    configured = os.environ.get(BOOTSTRAP_ENV)
    if configured:
        return Path(configured)
    return default_bootstrap_path()


def _require_abs_path(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        fail("INVALID_ARGUMENT", f"bootstrap {label} must be a non-empty path string")
    path = Path(value)
    if not path.is_absolute():
        fail("INVALID_ARGUMENT", f"bootstrap {label} must be absolute")
    return os.path.normpath(str(path))


def validate_bootstrap(data: Any) -> Dict[str, Any]:
    """Validate BootstrapConfigV1 and return a normalized copy."""
    if not isinstance(data, dict):
        fail("INVALID_ARGUMENT", "bootstrap must be a JSON object")
    allowed = {
        "schema_version",
        "profile_ref",
        "scope_ref",
        "scope_generation",
        "state_dir",
        "import_inbox_dir",
        "output_root",
        "candidate_roots",
    }
    unknown = sorted(set(data) - allowed)
    if unknown:
        fail("INVALID_ARGUMENT", "bootstrap contains unknown fields", details={"fields": unknown})
    if data.get("schema_version") != 1:
        fail("UNSUPPORTED_SCHEMA", "bootstrap schema_version must be 1")
    for key in ("profile_ref", "scope_ref"):
        value = data.get(key)
        if not isinstance(value, str) or not value or len(value) > 128:
            fail("INVALID_ARGUMENT", f"bootstrap {key} must be a bounded string")
    generation = data.get("scope_generation")
    if isinstance(generation, bool) or not isinstance(generation, int) or generation < 1:
        fail("INVALID_ARGUMENT", "bootstrap scope_generation must be a positive integer")
    state_dir = _require_abs_path(data.get("state_dir"), "state_dir")
    inbox_dir = _require_abs_path(data.get("import_inbox_dir"), "import_inbox_dir")
    output_root = _require_abs_path(data.get("output_root"), "output_root")
    roots = data.get("candidate_roots")
    if not isinstance(roots, list) or not roots:
        fail("INVALID_ARGUMENT", "bootstrap candidate_roots must be a non-empty list")
    normalized_roots = []
    seen = set()
    for index, root in enumerate(roots):
        if not isinstance(root, dict):
            fail("INVALID_ARGUMENT", f"candidate_roots[{index}] must be an object")
        allowed_root = {"root_ref", "absolute_path", "read_grant_ref"}
        extra = sorted(set(root) - allowed_root)
        if extra:
            fail("INVALID_ARGUMENT", "candidate root contains unknown fields", details={"index": index, "fields": extra})
        root_ref = root.get("root_ref")
        if not isinstance(root_ref, str) or not root_ref or len(root_ref) > 128:
            fail("INVALID_ARGUMENT", f"candidate_roots[{index}].root_ref must be a bounded string")
        if root_ref in seen:
            fail("INVALID_ARGUMENT", "candidate root_ref values must be unique")
        seen.add(root_ref)
        grant = root.get("read_grant_ref")
        if not isinstance(grant, str) or not grant:
            fail("INVALID_ARGUMENT", f"candidate_roots[{index}].read_grant_ref must be a string")
        absolute = _require_abs_path(root.get("absolute_path"), f"candidate_roots[{index}].absolute_path")
        normalized_roots.append(
            {"root_ref": root_ref, "absolute_path": absolute, "read_grant_ref": grant}
        )
    return {
        "schema_version": 1,
        "profile_ref": data["profile_ref"],
        "scope_ref": data["scope_ref"],
        "scope_generation": generation,
        "state_dir": state_dir,
        "import_inbox_dir": inbox_dir,
        "output_root": output_root,
        "candidate_roots": normalized_roots,
    }


def load_bootstrap_data(path: Path) -> Dict[str, Any]:
    try:
        raw = Path(path).read_bytes()
    except FileNotFoundError:
        fail(
            "CONFIG_UNAVAILABLE",
            "code-learning bootstrap configuration is missing; run bootstrap-init first",
        )
    if len(raw) > 1 << 20:
        fail("INVALID_ARGUMENT", "bootstrap file is unexpectedly large")
    try:
        data = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("INVALID_ARGUMENT", "bootstrap file is not valid UTF-8 JSON")
    return validate_bootstrap(data)


def init_bootstrap(
    out_path: Path,
    state_dir: Path,
    inbox_dir: Path,
    output_root: Path,
    roots: Dict[str, Path],
    profile_ref: str = "desktop",
    scope_ref: str = "local",
    scope_generation: int = 1,
) -> Dict[str, Any]:
    """Create the trusted bootstrap file plus its directories and secret."""
    if not roots:
        fail("INVALID_ARGUMENT", "at least one candidate root is required")
    normalized_roots = []
    for name, path in roots.items():
        path = Path(path).expanduser()
        if not path.is_absolute():
            fail("INVALID_ARGUMENT", "candidate roots must be absolute paths")
        path = Path(os.path.normpath(str(path)))
        if not path.exists() or not path.is_dir():
            fail("INVALID_ARGUMENT", "candidate root must be an existing directory")
        normalized_roots.append(
            {"root_ref": name, "absolute_path": str(path), "read_grant_ref": f"grant-{name}"}
        )
    data = {
        "schema_version": 1,
        "profile_ref": profile_ref,
        "scope_ref": scope_ref,
        "scope_generation": scope_generation,
        "state_dir": os.path.normpath(str(Path(state_dir).absolute())),
        "import_inbox_dir": os.path.normpath(str(Path(inbox_dir).absolute())),
        "output_root": os.path.normpath(str(Path(output_root).absolute())),
        "candidate_roots": normalized_roots,
    }
    # Extra keys are rejected by validate_bootstrap; validate before writing.
    normalized = validate_bootstrap(data)
    out_path = Path(out_path).absolute()
    for directory in (normalized["state_dir"], normalized["import_inbox_dir"], normalized["output_root"]):
        ensure_dir(Path(directory))
    ensure_dir(out_path.parent)
    if out_path.exists():
        fail("STATE_CONFLICT", "bootstrap output already exists; remove it explicitly to reinitialize")
    atomic_write_json(out_path, normalized)
    state = State(normalized, out_path)
    state.secret  # create the signing key before first use
    ensure_dir(state.state_root / "workspaces")
    ensure_dir(state.state_root / "snapshots")
    ensure_dir(state.state_root / "operations")
    ensure_dir(state.state_root / "exports")
    ensure_dir(state.state_root / "locks")
    return normalized


def _urlsafe_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _urlsafe_decode(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    try:
        return base64.urlsafe_b64decode(text + padding)
    except (ValueError, TypeError):
        fail("SCOPE_DENIED", "signed reference is malformed")


class _FileLock:
    def __init__(self, path: Path, timeout: float = _LOCK_TIMEOUT_S) -> None:
        self.path = Path(path)
        self.timeout = timeout
        self.acquired = False

    def __enter__(self) -> "_FileLock":
        ensure_dir(self.path.parent)
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(f"{os.getpid()}\n{time.time()}\n")
                self.acquired = True
                return self
            except FileExistsError:
                try:
                    age = time.time() - self.path.stat().st_mtime
                except OSError:
                    age = 0.0
                if age > _LOCK_STALE_S:
                    try:
                        self.path.unlink()
                        continue
                    except OSError:
                        pass
                if time.monotonic() >= deadline:
                    fail("STATE_CONFLICT", "another writer holds this workspace lock")
                time.sleep(0.05)

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if self.acquired:
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass
            self.acquired = False


class State:
    """Resolved local state for one bootstrap scope."""

    def __init__(self, bootstrap: Dict[str, Any], bootstrap_path: Optional[Path] = None) -> None:
        self.bootstrap = validate_bootstrap(bootstrap)
        self.bootstrap_path = Path(bootstrap_path) if bootstrap_path else None
        self._secret: Optional[bytes] = None

    # --- layout -------------------------------------------------------
    @property
    def state_root(self) -> Path:
        return Path(self.bootstrap["state_dir"])

    @property
    def inbox_dir(self) -> Path:
        return Path(self.bootstrap["import_inbox_dir"])

    @property
    def output_root(self) -> Path:
        return Path(self.bootstrap["output_root"])

    @property
    def scope_ref(self) -> str:
        return self.bootstrap["scope_ref"]

    @property
    def scope_generation(self) -> int:
        return self.bootstrap["scope_generation"]

    def exports_dir(self) -> Path:
        return ensure_dir(self.state_root / "exports")

    def learning_db_path(self) -> Path:
        return self.state_root / "learning.sqlite3"

    def workspace_dir(self, workspace_id: str) -> Path:
        return self.state_root / "workspaces" / workspace_id

    def snapshot_dir(self, snapshot_id: str) -> Path:
        return self.state_root / "snapshots" / snapshot_id

    # --- signing ------------------------------------------------------
    @property
    def secret(self) -> bytes:
        if self._secret is None:
            path = self.state_root / "secret.key"
            ensure_dir(self.state_root)
            if path.exists():
                data = path.read_bytes()
                if len(data) < 32:
                    fail("DEPENDENCY_UNAVAILABLE", "local signing key is malformed")
                self._secret = data
            else:
                key = os.urandom(32)
                fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                try:
                    os.write(fd, key)
                    os.fsync(fd)
                finally:
                    os.close(fd)
                self._secret = key
        return self._secret

    def sign(self, payload: Dict[str, Any]) -> str:
        body = canonical_bytes(payload)
        encoded = _urlsafe_encode(body)
        mac = hmac.new(self.secret, encoded.encode("ascii"), hashlib.sha256).digest()
        return f"{TOKEN_PREFIX}.{encoded}.{_urlsafe_encode(mac)}"

    def verify(self, token: str, *, kind: Optional[str] = None, max_age_s: Optional[int] = None) -> Dict[str, Any]:
        if not isinstance(token, str) or len(token) > 8192:
            fail("SCOPE_DENIED", "signed reference is malformed")
        parts = token.split(".")
        if len(parts) != 3 or parts[0] != TOKEN_PREFIX:
            fail("SCOPE_DENIED", "signed reference is malformed")
        encoded, mac_text = parts[1], parts[2]
        expected = hmac.new(self.secret, encoded.encode("ascii"), hashlib.sha256).digest()
        try:
            actual = _urlsafe_decode(mac_text)
        except CodeLearningError:
            raise
        if not hmac.compare_digest(expected, actual):
            fail("SCOPE_DENIED", "signed reference failed integrity check")
        try:
            payload = json.loads(_urlsafe_decode(encoded).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            fail("SCOPE_DENIED", "signed reference payload is malformed")
        if not isinstance(payload, dict):
            fail("SCOPE_DENIED", "signed reference payload is malformed")
        if kind is not None and payload.get("kind") != kind:
            fail("SCOPE_DENIED", "signed reference kind does not match this operation")
        expires = payload.get("exp")
        if expires is not None:
            if not isinstance(expires, (int, float)):
                fail("SCOPE_DENIED", "signed reference expiry is malformed")
            if time.time() > float(expires):
                fail("STALE_SOURCE", "signed reference has expired")
        if max_age_s is not None:
            issued = payload.get("iat")
            if isinstance(issued, (int, float)) and time.time() - float(issued) > max_age_s:
                fail("STALE_SOURCE", "signed reference is too old for this operation")
        if payload.get("g") != self.scope_generation:
            fail("SCOPE_DENIED", "signed reference belongs to another scope generation")
        return payload

    # --- scope --------------------------------------------------------
    def candidate_roots(self) -> Dict[str, Path]:
        return {root["root_ref"]: Path(root["absolute_path"]) for root in self.bootstrap["candidate_roots"]}

    def resolve_root(self, root_ref: str) -> Path:
        roots = self.candidate_roots()
        if root_ref not in roots:
            fail("SCOPE_DENIED", "requested root is not registered in the bootstrap configuration")
        return roots[root_ref]

    def require_in_root(self, path: Path, root: Optional[Path] = None) -> Path:
        path = Path(path)
        if _is_reparse_path(path):
            fail("SCOPE_DENIED", "path must not be a symlink or junction")
        roots = [root] if root is not None else list(self.candidate_roots().values())
        real = Path(os.path.realpath(str(path)))
        for base in roots:
            base_real = Path(os.path.realpath(str(base)))
            try:
                common = Path(os.path.commonpath([str(real), str(base_real)]))
            except ValueError:
                continue
            if common == base_real:
                return real
        fail("SCOPE_DENIED", "path falls outside the registered read roots")

    # --- workspaces ---------------------------------------------------
    def read_registration(self, workspace_id: str) -> Optional[Dict[str, Any]]:
        path = self.workspace_dir(workspace_id) / "registration.json"
        if not path.exists():
            return None
        try:
            data = read_json(path)
        except CodeLearningError:
            fail("DEPENDENCY_UNAVAILABLE", "workspace registration is not readable")
        if not isinstance(data, dict) or data.get("schema_version") != 1:
            fail("UNSUPPORTED_SCHEMA", "workspace registration schema is not supported")
        return data

    def write_registration(self, workspace_id: str, registration: Dict[str, Any]) -> None:
        directory = ensure_dir(self.workspace_dir(workspace_id))
        atomic_write_json(directory / "registration.json", registration)

    def list_workspaces(self) -> list:
        base = self.state_root / "workspaces"
        if not base.exists():
            return []
        return sorted(
            entry.name
            for entry in base.iterdir()
            if entry.is_dir() and (entry / "registration.json").exists()
        )

    @contextlib.contextmanager
    def workspace_lock(self, workspace_id: str) -> Iterator[None]:
        with _FileLock(self.state_root / "locks" / f"{workspace_id}.lock"):
            yield

    # --- idempotent operations ---------------------------------------
    def _operation_path(self, operation_id: str) -> Path:
        digest = hashlib.sha256(operation_id.encode("utf-8")).hexdigest()
        return self.state_root / "operations" / f"{digest}.json"

    def operation_get(self, operation_id: str) -> Optional[Dict[str, Any]]:
        path = self._operation_path(operation_id)
        if not path.exists():
            return None
        return read_json(path)

    def operation_put(self, operation_id: str, request_digest: str, result: Dict[str, Any]) -> None:
        atomic_write_json(
            self._operation_path(operation_id),
            {
                "schema_version": 1,
                "operation_id": operation_id,
                "request_digest": request_digest,
                "result": result,
                "recorded_at": utc_now_iso(),
            },
        )

    # --- inbox --------------------------------------------------------
    def inbox_file(self, name: str, *, max_bytes: int = _MAX_JSON_BYTES) -> Path:
        if not isinstance(name, str) or not name or "/" in name or "\\" in name or name in (".", ".."):
            fail("INVALID_ARGUMENT", "inbox resource name must be a single filename")
        path = self.inbox_dir / name
        if not path.exists():
            fail("NOT_FOUND", "inbox resource does not exist")
        if not path.is_file() or path.is_symlink():
            fail("SCOPE_DENIED", "inbox resource must be a regular file")
        size = path.stat().st_size
        if size <= 0 or size > max_bytes:
            fail("LIMIT_EXCEEDED", "inbox resource size is outside the accepted range")
        real = Path(os.path.realpath(str(path)))
        if not _same_parent(real, self.inbox_dir):
            fail("SCOPE_DENIED", "inbox resource resolves outside the inbox")
        return path

    def inbox_json(self, name: str, *, max_bytes: int = _MAX_JSON_BYTES) -> Tuple[Path, Any]:
        path = self.inbox_file(name, max_bytes=max_bytes)
        data = read_json(path)
        return path, data

    def inbox_dir_entry(self, name: str) -> Path:
        if not isinstance(name, str) or not name or "/" in name or "\\" in name or name in (".", ".."):
            fail("INVALID_ARGUMENT", "inbox directory name must be a single segment")
        path = self.inbox_dir / name
        if not path.exists():
            fail("NOT_FOUND", "inbox directory does not exist")
        if path.is_symlink() or not path.is_dir():
            fail("SCOPE_DENIED", "inbox entry must be a regular directory")
        real = Path(os.path.realpath(str(path)))
        if not _same_parent(real, self.inbox_dir):
            fail("SCOPE_DENIED", "inbox entry resolves outside the inbox")
        return path

    # --- snapshots ----------------------------------------------------
    def snapshots_index(self) -> Dict[str, Any]:
        path = self.state_root / "snapshots" / "index.json"
        if not path.exists():
            return {"schema_version": 1, "entries": []}
        data = read_json(path)
        if not isinstance(data, dict) or data.get("schema_version") != 1 or not isinstance(data.get("entries"), list):
            fail("UNSUPPORTED_SCHEMA", "snapshot index is not supported")
        return data

    def write_snapshots_index(self, index: Dict[str, Any]) -> None:
        atomic_write_json(self.state_root / "snapshots" / "index.json", index)

    def find_snapshot_entry(self, workspace_id: str, variant_id: str, repo_id: str) -> Optional[Dict[str, Any]]:
        for entry in self.snapshots_index()["entries"]:
            if (
                entry.get("workspace_id") == workspace_id
                and entry.get("variant_id") == variant_id
                and entry.get("repo_id") == repo_id
            ):
                return entry
        return None


def _same_parent(path: Path, parent: Path) -> bool:
    return os.path.normcase(os.path.dirname(os.path.realpath(str(path)))) == os.path.normcase(
        os.path.realpath(str(parent))
    )


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def load_state(bootstrap_path: Optional[str] = None) -> State:
    path = resolve_bootstrap_path(bootstrap_path)
    data = load_bootstrap_data(path)
    return State(data, path)


def request_digest(payload: Any) -> str:
    return sha256_text(canonical_bytes(payload).decode("utf-8"))
