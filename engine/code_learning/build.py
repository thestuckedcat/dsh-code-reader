"""Read-only compiler build-context preflight (contract section 6).

``preflight_variant`` never executes a compiler, wrapper, script, CMake or
shell.  It reads declared ``compile_commands.json`` files plus config/generated
header/toolchain declarations and:

* requires the full semantic input set (compdb, toolchain, config, generated
  headers); a ``source_only`` variant is always ``semantic_status='blocked'``
  with ``missing_inputs=['compiler_build_context']``;
* rejects command chains/redirections/env-assignment wrappers, shells/unknown
  wrappers and non-absolute compilers;
* rejects plugin loading, VFS overlays and include/sysroot/resource-dir/
  ``-include``/``-imacros`` paths outside the registered read roots;
* expands response files recursively (max depth 8, max 1 MiB total) without
  following paths outside the registered roots.

Any problem degrades the variant to ``blocked`` with diagnostics; nothing is
silently dropped or rewritten.
"""

from __future__ import annotations

import json
import os
import re
import shlex
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set

from . import scope
from .errors import CodeLearningError
from .util import digest
from .validation import expect_int, hash_hex

_MAX_COMPDB_BYTES = 16 * 1024 * 1024
_MAX_COMPDB_ENTRIES = 200_000
_MAX_RESPONSE_BYTES = 1024 * 1024
_MAX_RESPONSE_DEPTH = 8

#: Shell chaining/redirection/command-substitution characters.  A compdb
#: ``command`` string is rejected when any of these appears; an ``arguments``
#: list is passed literally, so only per-token rules apply there.
_SHELL_META = re.compile(r"[;&|<>`$]|[\r\n]")
_ENV_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_DRIVE_ABS = re.compile(r"^[A-Za-z]:[\\/]")

#: Executables that would turn a literal argv into an indirect execution path.
_SHELL_EXECUTABLES = frozenset(
    {
        "sh",
        "bash",
        "dash",
        "zsh",
        "ksh",
        "csh",
        "cmd",
        "cmd.exe",
        "powershell",
        "powershell.exe",
        "pwsh",
        "pwsh.exe",
        "env",
        "sudo",
        "doas",
        "nice",
        "nohup",
        "xargs",
        "python",
        "python3",
        "perl",
        "ruby",
    }
)
_REGISTERED_WRAPPERS = frozenset({"ccache", "sccache"})
_PLUGIN_FLAGS = (
    "-fplugin",
    "-fpass-plugin",
    "-fvfs",
    "-ivfsoverlay",
    "-vfsoverlay",
    "-fmodules",
    "-fcxx-modules",
    "-fmodule-map-file",
    "-fmodule-file",
    "-include-pch",
    "-load",
    "-plugin",
    "-add-plugin",
)

#: Flags whose next token (or attached suffix) is a read root that must stay
#: inside the registered roots.
_NEXT_PATH_FLAGS = (
    "-I",
    "-isystem",
    "-iquote",
    "-idirafter",
    "--sysroot",
    "-isysroot",
    "-resource-dir",
    "-include",
    "-imacros",
)
_ATTACHED_PATH_PREFIXES = ("-I", "-isystem", "-iquote", "-idirafter", "-isysroot")


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------
def _is_abs_path(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    return (
        value.startswith("/")
        or value.startswith("\\\\")
        or bool(_DRIVE_ABS.match(value))
    )


def _normalized(value: Any) -> str:
    text = str(value).replace("/", os.sep).replace("\\", os.sep)
    return os.path.normcase(os.path.normpath(text))


def _basename(value: str) -> str:
    return os.path.basename(value.replace("\\", "/")).lower()


def _inside_any(candidate: Any, roots: Sequence[Path]) -> bool:
    if not _is_abs_path(candidate) and not candidate.startswith("/"):
        return False
    target = _normalized(candidate)
    for root in roots:
        root_text = _normalized(root)
        try:
            common = os.path.commonpath([target, root_text])
        except ValueError:
            continue
        if common == root_text:
            return True
    return False


class _Diagnostics:
    def __init__(self, variant_id: Optional[str] = None) -> None:
        self.items: List[Dict[str, Any]] = []
        self.variant_id = variant_id

    def add(self, code: str, message: str, *, ref: Optional[str] = None) -> None:
        item: Dict[str, Any] = {"code": code, "severity": "error", "message": message}
        if ref is not None:
            item["ref"] = ref
        if self.variant_id is not None:
            item["variant_id"] = self.variant_id
        self.items.append(item)


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------
def preflight_variant(state, workspace: Dict[str, Any], variant_id: str) -> Dict[str, Any]:
    """Validate one variant's declared build context without executing anything."""
    variant = scope.find_variant(workspace, variant_id)
    mode = variant.get("analysis_mode")
    if mode not in ("source_only", "semantic"):
        raise CodeLearningError("INVALID_ARGUMENT", "variant analysis_mode is not supported")
    diagnostics = _Diagnostics(variant_id)
    missing: Set[str] = set()

    compdb_digests: Dict[str, Optional[str]] = {}
    config_digests: Dict[str, Optional[str]] = {}
    generated_header_digests: Dict[str, Optional[str]] = {}
    toolchain_digest: Optional[str] = None

    # 1. Repository roots must still be resolvable right now.
    allowed_roots: List[Path] = []
    for repo in workspace.get("repositories") or []:
        try:
            allowed_roots.append(scope.repo_root(state, workspace, repo["repo_id"]))
        except CodeLearningError as error:
            diagnostics.add("workspace_root_unavailable", error.message, ref=repo.get("repo_id"))
            missing.add("repositories")

    # 2. Toolchain declaration (never probed, only structurally validated).
    toolchains = {
        item.get("toolchain_ref"): item
        for item in (workspace.get("toolchains") or [])
        if isinstance(item, dict)
    }
    toolchain: Optional[Dict[str, Any]] = None
    toolchain_ref = variant.get("toolchain_ref")
    if toolchain_ref is not None:
        toolchain = toolchains.get(toolchain_ref)
        if toolchain is None:
            missing.add("toolchain_ref")
            diagnostics.add(
                "toolchain_missing",
                f"toolchain_ref {toolchain_ref!r} is not declared in workspace toolchains",
            )
        elif _validate_toolchain(toolchain, diagnostics):
            toolchain_digest = digest(toolchain)
        else:
            missing.add("toolchain_ref")
    elif mode == "semantic":
        missing.add("toolchain_ref")

    # 3. Extra registered read roots (sysroot/include) and toolchain builtin roots.
    extra_roots: List[Path] = []
    for root_ref in variant.get("include_root_refs") or []:
        try:
            extra_roots.append(state.resolve_root(root_ref))
        except CodeLearningError as error:
            missing.add("include_root_refs")
            diagnostics.add("include_root_unavailable", error.message, ref=root_ref)
    sysroot_ref = variant.get("sysroot_ref")
    if sysroot_ref is not None:
        try:
            extra_roots.append(state.resolve_root(sysroot_ref))
        except CodeLearningError as error:
            missing.add("sysroot_ref")
            diagnostics.add("sysroot_unavailable", error.message, ref=sysroot_ref)
    if toolchain is not None:
        for builtin_root in toolchain.get("builtin_roots") or []:
            if isinstance(builtin_root, str) and builtin_root:
                extra_roots.append(Path(builtin_root))
    allowed_roots.extend(extra_roots)

    # 4. Declared reference inputs: digest, existence, compdb argv preflight.
    categories = (
        ("compdb_refs", compdb_digests),
        ("config_refs", config_digests),
        ("generated_header_sets", generated_header_digests),
    )
    for field, bucket in categories:
        refs = variant.get(field) or []
        if mode == "semantic" and not refs:
            missing.add(field)
            continue
        for ref in refs:
            try:
                path = scope.resolve_ref_file(state, workspace, ref)
            except CodeLearningError as error:
                bucket[ref] = None
                missing.add(field)
                diagnostics.add(
                    f"{field}_unavailable",
                    f"{field} reference {ref!r} is not readable: {error.message}",
                    ref=ref,
                )
                continue
            try:
                bucket[ref] = scope.file_digest(path)
            except CodeLearningError as error:
                bucket[ref] = None
                missing.add(field)
                diagnostics.add(
                    f"{field}_unavailable",
                    f"{field} reference {ref!r} is not readable: {error.message}",
                    ref=ref,
                )
                continue
            if field == "compdb_refs":
                if not _validate_compdb(
                    workspace, ref, path, allowed_roots, toolchain, diagnostics
                ):
                    missing.add(field)

    # 5. Mode-specific status.
    if mode == "source_only":
        diagnostics.add(
            "semantic_status_blocked",
            "source_only variant has no compiler build context; only text evidence is available",
        )
        return {
            "semantic_status": "blocked",
            "missing_inputs": ["compiler_build_context"],
            "diagnostics": diagnostics.items,
            "compdb_digests": compdb_digests,
            "config_digests": config_digests,
            "generated_header_digests": generated_header_digests,
            "toolchain_digest": toolchain_digest,
        }

    if missing and not any(item["severity"] == "error" for item in diagnostics.items):
        diagnostics.add(
            "semantic_status_blocked",
            "semantic variant is missing build inputs: " + ", ".join(sorted(missing)),
        )
    semantic_status = "ready" if not missing else "blocked"
    return {
        "semantic_status": semantic_status,
        "missing_inputs": sorted(missing),
        "diagnostics": diagnostics.items,
        "compdb_digests": compdb_digests,
        "config_digests": config_digests,
        "generated_header_digests": generated_header_digests,
        "toolchain_digest": toolchain_digest,
    }


# ---------------------------------------------------------------------------
# toolchain
# ---------------------------------------------------------------------------
def _validate_toolchain(toolchain: Dict[str, Any], diagnostics: _Diagnostics) -> bool:
    ok = True
    compiler = toolchain.get("compiler_path")
    if not _is_abs_path(compiler):
        diagnostics.add(
            "toolchain_compiler_not_absolute",
            "toolchain compiler_path must be an absolute path",
            ref=toolchain.get("toolchain_ref"),
        )
        ok = False
    elif _SHELL_META.search(compiler) or _basename(compiler) in _SHELL_EXECUTABLES:
        diagnostics.add(
            "toolchain_compiler_untrusted",
            "toolchain compiler_path contains shell metacharacters or is an interpreter",
            ref=toolchain.get("toolchain_ref"),
        )
        ok = False
    try:
        hash_hex(toolchain.get("compiler_sha256"), "toolchain compiler_sha256") if toolchain.get(
            "compiler_sha256"
        ) is not None else None
    except CodeLearningError:
        diagnostics.add(
            "toolchain_compiler_hash_invalid",
            "toolchain compiler_sha256 must be a lowercase SHA256 hex string",
            ref=toolchain.get("toolchain_ref"),
        )
        ok = False
    wrapper = toolchain.get("wrapper_policy", "none")
    if wrapper not in ("none", "ccache", "sccache"):
        diagnostics.add(
            "toolchain_wrapper_invalid",
            "toolchain wrapper_policy must be one of none/ccache/sccache",
            ref=toolchain.get("toolchain_ref"),
        )
        ok = False
    for builtin_root in toolchain.get("builtin_roots") or []:
        if not _is_abs_path(builtin_root):
            diagnostics.add(
                "toolchain_builtin_root_invalid",
                "toolchain builtin_roots entries must be absolute paths",
                ref=toolchain.get("toolchain_ref"),
            )
            ok = False
    return ok


# ---------------------------------------------------------------------------
# compdb validation
# ---------------------------------------------------------------------------
def _validate_compdb(
    workspace: Dict[str, Any],
    ref: str,
    path: Path,
    allowed_roots: Sequence[Path],
    toolchain: Optional[Dict[str, Any]],
    diagnostics: _Diagnostics,
) -> bool:
    try:
        raw = path.read_bytes()
    except OSError:
        diagnostics.add("compdb_unreadable", f"compdb {ref!r} is not readable", ref=ref)
        return False
    if len(raw) > _MAX_COMPDB_BYTES:
        diagnostics.add(
            "compdb_too_large",
            f"compdb {ref!r} exceeds the 16 MiB preflight limit",
            ref=ref,
        )
        return False
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        diagnostics.add("compdb_json_invalid", f"compdb {ref!r} is not UTF-8 JSON", ref=ref)
        return False
    if not isinstance(data, list):
        diagnostics.add("compdb_json_invalid", f"compdb {ref!r} must be a JSON array", ref=ref)
        return False
    if not data:
        diagnostics.add("compdb_empty", f"compdb {ref!r} has no compilation entries", ref=ref)
        return False
    if len(data) > _MAX_COMPDB_ENTRIES:
        diagnostics.add(
            "compdb_too_many_entries",
            f"compdb {ref!r} exceeds the preflight entry limit",
            ref=ref,
        )
        return False
    ok = True
    for index, entry in enumerate(data):
        if not _validate_compdb_entry(
            entry, index, ref, allowed_roots, toolchain, diagnostics
        ):
            ok = False
    return ok


def _validate_compdb_entry(
    entry: Any,
    index: int,
    ref: str,
    allowed_roots: Sequence[Path],
    toolchain: Optional[Dict[str, Any]],
    diagnostics: _Diagnostics,
) -> bool:
    label = f"compdb {ref!r} entry {index}"
    if not isinstance(entry, dict):
        diagnostics.add("compdb_entry_invalid", f"{label} must be an object", ref=ref)
        return False
    directory = entry.get("directory")
    if not isinstance(directory, str) or not directory:
        diagnostics.add("compdb_entry_invalid", f"{label} has no directory", ref=ref)
        return False
    if not _is_abs_path(directory):
        diagnostics.add(
            "compdb_entry_invalid",
            f"{label} directory must be an absolute build directory",
            ref=ref,
        )
        return False
    if not _inside_any(directory, allowed_roots):
        diagnostics.add(
            "compdb_directory_outside_root",
            f"{label} directory is outside the registered read roots",
            ref=ref,
        )
        return False
    source_file = entry.get("file")
    if not isinstance(source_file, str) or not source_file:
        diagnostics.add("compdb_entry_invalid", f"{label} has no source file", ref=ref)
        return False
    resolved_file = (
        source_file if _is_abs_path(source_file) else os.path.join(directory, source_file)
    )
    if not _inside_any(resolved_file, allowed_roots):
        diagnostics.add(
            "compdb_file_outside_root",
            f"{label} source file is outside the registered read roots",
            ref=ref,
        )
        return False

    arguments = entry.get("arguments")
    command = entry.get("command")
    if arguments is not None:
        if (
            not isinstance(arguments, list)
            or not arguments
            or not all(isinstance(item, str) and item and "\x00" not in item for item in arguments)
        ):
            diagnostics.add(
                "compdb_argv_invalid",
                f"{label} arguments must be a non-empty array of strings",
                ref=ref,
            )
            return False
        return _scan_tokens(
            arguments,
            directory,
            allowed_roots,
            toolchain,
            diagnostics,
            label,
            depth=0,
            response_budget=[0],
            seen=set(),
        )
    if command is not None:
        if not isinstance(command, str) or not command:
            diagnostics.add("compdb_command_rejected", f"{label} command is empty", ref=ref)
            return False
        if _SHELL_META.search(command):
            diagnostics.add(
                "compdb_command_rejected",
                f"{label} command contains shell metacharacters (chaining/redirection) and is rejected",
                ref=ref,
            )
            return False
        try:
            tokens = shlex.split(command, posix=True)
        except ValueError:
            diagnostics.add(
                "compdb_command_rejected", f"{label} command cannot be parsed safely", ref=ref
            )
            return False
        if not tokens:
            diagnostics.add("compdb_command_rejected", f"{label} command is empty", ref=ref)
            return False
        return _scan_tokens(
            tokens,
            directory,
            allowed_roots,
            toolchain,
            diagnostics,
            label,
            depth=0,
            response_budget=[0],
            seen=set(),
        )
    diagnostics.add(
        "compdb_entry_missing_argv",
        f"{label} must declare arguments or a command",
        ref=ref,
    )
    return False


def _scan_tokens(
    tokens: List[str],
    directory: str,
    allowed_roots: Sequence[Path],
    toolchain: Optional[Dict[str, Any]],
    diagnostics: _Diagnostics,
    label: str,
    *,
    depth: int,
    response_budget: List[int],
    seen: Set[str],
) -> bool:
    if depth > _MAX_RESPONSE_DEPTH:
        diagnostics.add(
            "compdb_response_depth_exceeded",
            f"{label} response files are nested too deeply",
        )
        return False
    ok = True
    compiler = tokens[0]
    if _ENV_ASSIGN.match(compiler):
        diagnostics.add(
            "compdb_command_rejected",
            f"{label} uses an environment assignment wrapper around the compiler",
        )
        return False
    if _SHELL_META.search(compiler):
        diagnostics.add(
            "compdb_command_rejected",
            f"{label} compiler token contains shell metacharacters",
        )
        return False
    start = 1
    base = _basename(compiler)
    if base in _SHELL_EXECUTABLES:
        diagnostics.add(
            "compdb_command_rejected",
            f"{label} compiler token is a shell/interpreter ({base}), not a compiler",
        )
        return False
    wrapper_policy = "none"
    registered_compiler: Optional[str] = None
    if toolchain is not None:
        wrapper_policy = toolchain.get("wrapper_policy", "none")
        registered_compiler = toolchain.get("compiler_path")
    if base in _REGISTERED_WRAPPERS:
        if wrapper_policy != base:
            diagnostics.add(
                "compdb_wrapper_unregistered",
                f"{label} uses wrapper {base!r} which is not registered for this toolchain",
            )
            return False
        if len(tokens) < 2:
            diagnostics.add(
                "compdb_command_rejected", f"{label} wrapper has no compiler argument"
            )
            return False
        compiler = tokens[1]
        start = 2
    if not _is_abs_path(compiler):
        diagnostics.add(
            "compdb_compiler_not_absolute",
            f"{label} compiler path must be absolute, got {compiler!r}",
        )
        ok = False
    elif _SHELL_META.search(compiler) or _basename(compiler) in _SHELL_EXECUTABLES:
        diagnostics.add(
            "compdb_compiler_untrusted",
            f"{label} compiler path contains shell metacharacters or is an interpreter",
        )
        ok = False
    elif registered_compiler is not None and _normalized(compiler) != _normalized(
        registered_compiler
    ):
        diagnostics.add(
            "compdb_compiler_unregistered",
            f"{label} compiler {compiler!r} does not match the registered toolchain compiler",
        )
        ok = False
    if toolchain is None:
        diagnostics.add(
            "compdb_toolchain_missing",
            f"{label} cannot be validated without a declared toolchain",
        )
        ok = False
    if not _scan_arguments(
        tokens[start:],
        directory,
        allowed_roots,
        diagnostics,
        label,
        depth=depth,
        response_budget=response_budget,
        seen=seen,
    ):
        ok = False
    return ok


def _scan_arguments(
    tokens: List[str],
    directory: str,
    allowed_roots: Sequence[Path],
    diagnostics: _Diagnostics,
    label: str,
    *,
    depth: int,
    response_budget: List[int],
    seen: Set[str],
) -> bool:
    ok = True
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token.startswith("@"):
            expanded = _expand_response(
                token[1:],
                directory,
                allowed_roots,
                diagnostics,
                label,
                depth=depth + 1,
                response_budget=response_budget,
                seen=seen,
            )
            if expanded is None:
                ok = False
            elif not _scan_arguments(
                expanded,
                directory,
                allowed_roots,
                diagnostics,
                label,
                depth=depth + 1,
                response_budget=response_budget,
                seen=seen,
            ):
                ok = False
            index += 1
            continue

        lowered = token.split("=", 1)[0]
        if token == "-Xclang":
            following = tokens[index + 1] if index + 1 < len(tokens) else ""
            if (
                following.startswith("-load")
                or following.startswith("-plugin")
                or following.startswith("-add-plugin")
                or following.startswith("-ivfsoverlay")
                or following.startswith("-vfsoverlay")
            ):
                diagnostics.add(
                    "compdb_plugin_rejected",
                    f"{label} requests plugin loading or a VFS overlay",
                )
                ok = False
            index += 2
            continue
        if token.startswith(_PLUGIN_FLAGS) or lowered.startswith(_PLUGIN_FLAGS):
            diagnostics.add(
                "compdb_plugin_rejected",
                f"{label} requests plugin loading, modules or a VFS overlay",
            )
            ok = False
            index += 1
            continue

        # Path-bearing flags must point inside the registered read roots.
        consumed, value = _path_flag(token, tokens, index)
        if consumed is not None:
            if value is not None:
                resolved = value if _is_abs_path(value) else os.path.join(directory, value)
                if not _inside_any(resolved, allowed_roots):
                    diagnostics.add(
                        "compdb_include_outside_root",
                        f"{label} include/sysroot path {value!r} is outside the registered read roots",
                    )
                    ok = False
            index += consumed
            continue
        index += 1
    return ok


def _path_flag(token: str, tokens: List[str], index: int):
    """Return ``(consumed_tokens, value_or_None)`` for a path-bearing flag."""
    next_token = tokens[index + 1] if index + 1 < len(tokens) else None
    for flag in _NEXT_PATH_FLAGS:
        if token == flag:
            return 2 if next_token is not None else 1, next_token
    for prefix in _ATTACHED_PATH_PREFIXES:
        if token.startswith(prefix) and len(token) > len(prefix):
            return 1, token[len(prefix):]
    if token.startswith("--sysroot="):
        return 1, token[len("--sysroot="):]
    if token.startswith("-resource-dir="):
        return 1, token[len("-resource-dir="):]
    return None, None


def _expand_response(
    value: str,
    directory: str,
    allowed_roots: Sequence[Path],
    diagnostics: _Diagnostics,
    label: str,
    *,
    depth: int,
    response_budget: List[int],
    seen: Set[str],
) -> Optional[List[str]]:
    if depth > _MAX_RESPONSE_DEPTH:
        diagnostics.add(
            "compdb_response_depth_exceeded",
            f"{label} response files are nested more than {_MAX_RESPONSE_DEPTH} levels",
        )
        return None
    resolved = value if _is_abs_path(value) else os.path.join(directory, value)
    if not _inside_any(resolved, allowed_roots):
        diagnostics.add(
            "compdb_response_outside_root",
            f"{label} response file {value!r} is outside the registered read roots",
        )
        return None
    try:
        real = os.path.realpath(resolved)
    except OSError:
        real = resolved
    if real in seen:
        diagnostics.add(
            "compdb_response_cycle",
            f"{label} response files contain a cycle",
        )
        return None
    seen.add(real)
    try:
        path = Path(resolved)
        if scope.is_reparse_point(path):
            diagnostics.add(
                "compdb_response_outside_root",
                f"{label} response file is a symlink or junction",
            )
            return None
        raw = path.read_bytes()
    except OSError:
        diagnostics.add(
            "compdb_response_unreadable", f"{label} response file {value!r} is not readable"
        )
        return None
    response_budget[0] += len(raw)
    if response_budget[0] > _MAX_RESPONSE_BYTES:
        diagnostics.add(
            "compdb_response_too_large",
            f"{label} expanded response files exceed the 1 MiB preflight limit",
        )
        return None
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        diagnostics.add(
            "compdb_response_unreadable", f"{label} response file is not UTF-8 text"
        )
        return None
    return text.split()
