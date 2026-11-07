"""WorkspaceManifestV1 registration, build identity, status and overview.

Contract surface (docs/implementation-contract.md sections 4-5):

* :func:`validate_workspace` -- strict manifest validation plus per-variant
  semantic status; never executes a probe and never mutates state.
* :func:`import_workspace` -- revision CAS + operation-id idempotency, atomic
  internal registration write inside the workspace lock.
* :func:`load_workspace` / :func:`workspace_status` / :func:`overview`.
* :func:`build_identity` / :func:`source_manifest_digest` /
  :func:`public_projection`.

Security boundaries enforced here: manifests only reference ``root_ref`` values
from the trusted bootstrap, roots must be real (non symlink/junction)
directories that resolve exactly to ``candidate_root / relative_path``, roots
may not nest or duplicate, and registered source roots must stay outside the
state/inbox/output directories.  Absolute paths never enter the public
projection.
"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import build, scope
from .errors import CodeLearningError, fail
from .util import check_id, digest, read_json_bytes, safe_relative_path, sha256_bytes, sha256_file, utc_now_iso
from .validation import (
    expect_array,
    expect_int,
    expect_object,
    expect_str,
    nullable_hash,
    one_of,
    ref_path,
    reject_unknown,
    require_keys,
)

#: Conservative bound on files hashed for one workspace's source manifest.
_SOURCE_MANIFEST_FILE_LIMIT = 20000

#: Hard bound used by :func:`source_manifest_digest`.
DEFAULT_SOURCE_MANIFEST_LIMIT = 20000

_MANIFEST_FIELDS = frozenset(
    {
        "schema_version",
        "workspace_id",
        "scope_ref",
        "repositories",
        "variants",
        "toolchains",
        "allowed_read_roots",
        "output_root_ref",
        "cross_repo_bindings",
    }
)
_MANIFEST_REQUIRED = (
    "schema_version",
    "workspace_id",
    "scope_ref",
    "repositories",
    "variants",
    "allowed_read_roots",
    "output_root_ref",
)
_REPOSITORY_FIELDS = frozenset({"repo_id", "root_ref", "relative_path", "role", "vcs"})
_VCS_FIELDS = frozenset({"kind", "commit", "dirty_digest", "untracked_digest"})
_VARIANT_FIELDS = frozenset(
    {
        "variant_id",
        "analysis_mode",
        "architecture",
        "target_triple",
        "config_refs",
        "compdb_refs",
        "generated_header_sets",
        "toolchain_ref",
        "sysroot_ref",
        "include_root_refs",
        "link_evidence_refs",
        "uapi_revision_refs",
        "execution_profile_ref",
    }
)
_TOOLCHAIN_FIELDS = frozenset(
    {
        "toolchain_ref",
        "compiler_path",
        "compiler_sha256",
        "version_evidence_ref",
        "wrapper_policy",
        "resource_dir_ref",
        "builtin_roots",
        "allowed_probe_argv",
        "native_extractor_ref",
    }
)
_COMPILER_META = re.compile(r"[;&|<>`$'\"]|[\r\n]")
_LOCAL_ABS = re.compile(r"^(/|[A-Za-z]:[\\/]|\\\\)")


# ---------------------------------------------------------------------------
# manifest normalization
# ---------------------------------------------------------------------------
def _is_abs_path(value: Any) -> bool:
    return isinstance(value, str) and bool(value) and bool(_LOCAL_ABS.match(value))


def _optional_str(value: Any, where: str, *, max_len: int) -> Optional[str]:
    if value is None:
        return None
    return expect_str(value, where, max_len=max_len)


def _root_ref(state, value: Any, where: str) -> str:
    ref = expect_str(value, where, max_len=128)
    if ref not in state.candidate_roots():
        fail("SCOPE_DENIED", f"{where} is not registered in the bootstrap candidate roots")
    return ref


def _root_ref_list(state, value: Any, where: str, *, max_items: int = 32) -> List[str]:
    items = expect_array(value, where, max_items=max_items)
    result: List[str] = []
    seen = set()
    for index, item in enumerate(items):
        ref = _root_ref(state, item, f"{where}[{index}]")
        if ref in seen:
            fail("INVALID_ARGUMENT", f"{where} must not contain duplicates")
        seen.add(ref)
        result.append(ref)
    return result


def _ref_list(value: Any, where: str, repository_ids: Sequence[str]) -> List[str]:
    items = expect_array(value, where, max_items=64)
    result: List[str] = []
    for index, item in enumerate(items):
        ref = ref_path(item, f"{where}[{index}]")
        repo_id = ref.split(":", 1)[0]
        if repo_id not in repository_ids:
            fail(
                "INVALID_ARGUMENT",
                f"{where}[{index}] references repository {repo_id!r} which is not registered in this workspace",
            )
        result.append(ref)
    return result


def _normalize_vcs(value: Any, index: int) -> Dict[str, Any]:
    where = f"repositories[{index}].vcs"
    if value is None:
        return {"kind": "none", "commit": None, "dirty_digest": None, "untracked_digest": None}
    expect_object(value, where)
    reject_unknown(value, _VCS_FIELDS, where)
    kind = one_of(value.get("kind", "none"), ("git", "none", "unknown"), f"{where}.kind")
    commit = _optional_str(value.get("commit"), f"{where}.commit", max_len=160)
    dirty_digest = nullable_hash(value.get("dirty_digest"), f"{where}.dirty_digest")
    untracked_digest = nullable_hash(value.get("untracked_digest"), f"{where}.untracked_digest")
    if kind == "none" and commit is not None:
        fail("INVALID_ARGUMENT", f"{where}.commit must be null when vcs.kind is 'none'")
    return {
        "kind": kind,
        "commit": commit,
        "dirty_digest": dirty_digest,
        "untracked_digest": untracked_digest,
    }


def _normalize_repositories(state, raw_list: List[Any]) -> List[Dict[str, Any]]:
    candidate_roots = state.candidate_roots()
    seen_ids = set()
    repositories: List[Dict[str, Any]] = []
    for index, raw in enumerate(raw_list):
        where = f"repositories[{index}]"
        expect_object(raw, where)
        reject_unknown(raw, _REPOSITORY_FIELDS, where)
        require_keys(raw, ("repo_id", "root_ref", "relative_path", "role"), where)
        repo_id = check_id(raw["repo_id"], f"{where}.repo_id")
        if repo_id in seen_ids:
            fail("INVALID_ARGUMENT", "workspace repositories must have unique repo_id values")
        seen_ids.add(repo_id)
        root_ref = expect_str(raw["root_ref"], f"{where}.root_ref", max_len=128)
        if root_ref not in candidate_roots:
            fail("SCOPE_DENIED", "repository root_ref is not registered in the bootstrap configuration")
        relative = safe_relative_path(raw["relative_path"], f"{where}.relative_path")
        role = one_of(
            raw["role"], ("umd", "uapi", "kmd", "library", "other"), f"{where}.role"
        )
        vcs = _normalize_vcs(raw.get("vcs"), index)
        candidate = candidate_roots[root_ref]
        scope.ensure_plain_directory(candidate, "registered candidate root")
        expected = Path(
            os.path.normpath(os.path.join(str(candidate), *relative.split("/")))
        )
        root = scope.ensure_plain_directory(expected, f"repository {repo_id} root")
        _ensure_separated_from_state(state, root, repo_id)
        repositories.append(
            {
                "repo_id": repo_id,
                "root_ref": root_ref,
                "relative_path": relative,
                "absolute_path": str(root),
                "role": role,
                "vcs": vcs,
            }
        )
    for left_index in range(len(repositories)):
        for right_index in range(left_index + 1, len(repositories)):
            left = repositories[left_index]
            right = repositories[right_index]
            if scope.paths_overlap(Path(left["absolute_path"]), Path(right["absolute_path"])):
                fail(
                    "INVALID_ARGUMENT",
                    "repository roots must be disjoint and non-nested "
                    f"({left['repo_id']!r} overlaps {right['repo_id']!r})",
                )
    return repositories


def _ensure_separated_from_state(state, root: Path, repo_id: str) -> None:
    guarded = (
        ("state", state.state_root),
        ("import inbox", state.inbox_dir),
        ("output", state.output_root),
    )
    for label, path in guarded:
        if scope.paths_overlap(root, path):
            fail(
                "INVALID_ARGUMENT",
                f"repository {repo_id!r} root must be outside the {label} directory",
            )


def _normalize_variants(
    state, raw_list: List[Any], toolchain_refs: Sequence[str], repository_ids: Sequence[str]
) -> List[Dict[str, Any]]:
    candidate_roots = state.candidate_roots()
    seen_ids = set()
    variants: List[Dict[str, Any]] = []
    for index, raw in enumerate(raw_list):
        where = f"variants[{index}]"
        expect_object(raw, where)
        reject_unknown(raw, _VARIANT_FIELDS, where)
        require_keys(raw, ("variant_id", "analysis_mode"), where)
        variant_id = check_id(raw["variant_id"], f"{where}.variant_id")
        if variant_id in seen_ids:
            fail("INVALID_ARGUMENT", "workspace variants must have unique variant_id values")
        seen_ids.add(variant_id)
        analysis_mode = one_of(
            raw["analysis_mode"], ("source_only", "semantic"), f"{where}.analysis_mode"
        )
        architecture = _optional_str(raw.get("architecture"), f"{where}.architecture", max_len=64)
        target_triple = _optional_str(raw.get("target_triple"), f"{where}.target_triple", max_len=256)
        toolchain_ref = _optional_str(raw.get("toolchain_ref"), f"{where}.toolchain_ref", max_len=128)
        if toolchain_ref is not None and toolchain_ref not in toolchain_refs:
            fail(
                "INVALID_ARGUMENT",
                f"{where}.toolchain_ref does not reference a declared toolchain",
            )
        sysroot_ref = _optional_str(raw.get("sysroot_ref"), f"{where}.sysroot_ref", max_len=128)
        if sysroot_ref is not None and sysroot_ref not in candidate_roots:
            fail("SCOPE_DENIED", f"{where}.sysroot_ref is not a registered candidate root")
        execution_profile_ref = _optional_str(
            raw.get("execution_profile_ref"), f"{where}.execution_profile_ref", max_len=128
        )
        variants.append(
            {
                "variant_id": variant_id,
                "analysis_mode": analysis_mode,
                "architecture": architecture,
                "target_triple": target_triple,
                "config_refs": _ref_list(raw.get("config_refs", []), f"{where}.config_refs", repository_ids),
                "compdb_refs": _ref_list(raw.get("compdb_refs", []), f"{where}.compdb_refs", repository_ids),
                "generated_header_sets": _ref_list(
                    raw.get("generated_header_sets", []),
                    f"{where}.generated_header_sets",
                    repository_ids,
                ),
                "toolchain_ref": toolchain_ref,
                "sysroot_ref": sysroot_ref,
                "include_root_refs": _root_ref_list(
                    state, raw.get("include_root_refs", []), f"{where}.include_root_refs"
                ),
                "link_evidence_refs": _ref_list(
                    raw.get("link_evidence_refs", []),
                    f"{where}.link_evidence_refs",
                    repository_ids,
                ),
                "uapi_revision_refs": _ref_list(
                    raw.get("uapi_revision_refs", []),
                    f"{where}.uapi_revision_refs",
                    repository_ids,
                ),
                "execution_profile_ref": execution_profile_ref,
            }
        )
    return variants


def _normalize_toolchains(raw_list: List[Any]) -> List[Dict[str, Any]]:
    seen = set()
    toolchains: List[Dict[str, Any]] = []
    for index, raw in enumerate(raw_list):
        where = f"toolchains[{index}]"
        expect_object(raw, where)
        reject_unknown(raw, _TOOLCHAIN_FIELDS, where)
        require_keys(raw, ("toolchain_ref", "compiler_path"), where)
        toolchain_ref = expect_str(raw["toolchain_ref"], f"{where}.toolchain_ref", max_len=128)
        if toolchain_ref in seen:
            fail("INVALID_ARGUMENT", "toolchains must have unique toolchain_ref values")
        seen.add(toolchain_ref)
        compiler_path = expect_str(raw["compiler_path"], f"{where}.compiler_path", max_len=1024)
        if not _is_abs_path(compiler_path):
            fail("INVALID_ARGUMENT", f"{where}.compiler_path must be an absolute path")
        if _COMPILER_META.search(compiler_path):
            fail("INVALID_ARGUMENT", f"{where}.compiler_path contains shell metacharacters")
        compiler_sha256 = nullable_hash(raw.get("compiler_sha256"), f"{where}.compiler_sha256")
        version_evidence_ref = _optional_str(
            raw.get("version_evidence_ref"), f"{where}.version_evidence_ref", max_len=512
        )
        wrapper_policy = one_of(
            raw.get("wrapper_policy", "none"),
            ("none", "ccache", "sccache"),
            f"{where}.wrapper_policy",
        )
        resource_dir_ref = _optional_str(
            raw.get("resource_dir_ref"), f"{where}.resource_dir_ref", max_len=1024
        )
        builtin_roots = expect_array(raw.get("builtin_roots", []), f"{where}.builtin_roots", max_items=32)
        normalized_builtin_roots = []
        for root_index, item in enumerate(builtin_roots):
            root = expect_str(item, f"{where}.builtin_roots[{root_index}]", max_len=1024)
            if not _is_abs_path(root):
                fail(
                    "INVALID_ARGUMENT",
                    f"{where}.builtin_roots[{root_index}] must be an absolute path",
                )
            normalized_builtin_roots.append(root)
        probe_argv = expect_array(
            raw.get("allowed_probe_argv", []), f"{where}.allowed_probe_argv", max_items=32
        )
        normalized_probe = []
        for argv_index, argv in enumerate(probe_argv):
            entries = expect_array(
                argv, f"{where}.allowed_probe_argv[{argv_index}]", max_items=64
            )
            normalized_probe.append(
                [
                    expect_str(
                        item,
                        f"{where}.allowed_probe_argv[{argv_index}][{entry_index}]",
                        max_len=1024,
                    )
                    for entry_index, item in enumerate(entries)
                ]
            )
        native_extractor_ref = _optional_str(
            raw.get("native_extractor_ref"), f"{where}.native_extractor_ref", max_len=512
        )
        toolchains.append(
            {
                "toolchain_ref": toolchain_ref,
                "compiler_path": compiler_path,
                "compiler_sha256": compiler_sha256,
                "version_evidence_ref": version_evidence_ref,
                "wrapper_policy": wrapper_policy,
                "resource_dir_ref": resource_dir_ref,
                "builtin_roots": normalized_builtin_roots,
                "allowed_probe_argv": normalized_probe,
                "native_extractor_ref": native_extractor_ref,
            }
        )
    return toolchains


def _validate_bindings_shape(raw_bindings: List[Any]) -> List[Dict[str, Any]]:
    result: List[Dict[str, Any]] = []
    for index, item in enumerate(raw_bindings):
        where = f"cross_repo_bindings[{index}]"
        expect_object(item, where)
        if item.get("schema_version") != 1:
            fail("UNSUPPORTED_SCHEMA", f"{where}.schema_version must be 1")
        check_id(item.get("binding_id"), f"{where}.binding_id")
        expect_int(item.get("revision"), f"{where}.revision", low=1, high=1 << 31)
        one_of(
            item.get("kind"),
            ("uapi_ioctl", "shared_abi", "protocol_message", "shared_header"),
            f"{where}.kind",
        )
        for endpoint_field in ("from", "to"):
            endpoint = item.get(endpoint_field)
            expect_object(endpoint, f"{where}.{endpoint_field}")
            require_keys(
                endpoint,
                (
                    "repo_id",
                    "variant_id",
                    "interface_ref",
                    "source_evidence_refs",
                    "interface_revision_ref",
                    "snapshot_ref",
                ),
                f"{where}.{endpoint_field}",
            )
        result.append(dict(item))
    return result


def _validate_manifest(state, manifest: Any) -> Dict[str, Any]:
    expect_object(manifest, "workspace manifest")
    reject_unknown(manifest, _MANIFEST_FIELDS, "workspace manifest")
    missing = [key for key in _MANIFEST_REQUIRED if key not in manifest]
    if missing:
        fail("INVALID_ARGUMENT", "workspace manifest is missing required fields: " + ", ".join(missing))
    if manifest["schema_version"] != 1:
        fail("UNSUPPORTED_SCHEMA", "workspace manifest schema_version must be 1")
    workspace_id = check_id(manifest["workspace_id"], "workspace manifest workspace_id")
    manifest_scope = expect_str(manifest["scope_ref"], "workspace manifest scope_ref", max_len=128)
    if manifest_scope != state.scope_ref:
        fail("SCOPE_DENIED", "workspace manifest scope_ref does not match the active bootstrap scope")
    raw_repositories = expect_array(
        manifest["repositories"], "workspace manifest repositories", min_items=1, max_items=64
    )
    repositories = _normalize_repositories(state, raw_repositories)
    repository_ids = [repo["repo_id"] for repo in repositories]
    raw_toolchains = expect_array(
        manifest.get("toolchains", []), "workspace manifest toolchains", max_items=16
    )
    toolchains = _normalize_toolchains(raw_toolchains)
    toolchain_refs = [item["toolchain_ref"] for item in toolchains]
    raw_variants = expect_array(
        manifest["variants"], "workspace manifest variants", min_items=1, max_items=32
    )
    variants = _normalize_variants(state, raw_variants, toolchain_refs, repository_ids)
    allowed_read_roots = _root_ref_list(
        state, manifest["allowed_read_roots"], "workspace manifest allowed_read_roots"
    )
    for repository in repositories:
        if repository["root_ref"] not in allowed_read_roots:
            fail(
                "INVALID_ARGUMENT",
                "workspace manifest allowed_read_roots must include every repository root_ref",
            )
    output_root_ref = _root_ref(
        state, manifest["output_root_ref"], "workspace manifest output_root_ref"
    )
    raw_bindings = expect_array(
        manifest.get("cross_repo_bindings", []),
        "workspace manifest cross_repo_bindings",
        max_items=64,
    )
    bindings = _validate_bindings_shape(raw_bindings)
    return {
        "workspace_id": workspace_id,
        "repositories": repositories,
        "toolchains": toolchains,
        "variants": variants,
        "allowed_read_roots": allowed_read_roots,
        "output_root_ref": output_root_ref,
        "bindings": bindings,
    }


# ---------------------------------------------------------------------------
# digests / build identity
# ---------------------------------------------------------------------------
def source_manifest_digest(root: Path, limit: int = DEFAULT_SOURCE_MANIFEST_LIMIT) -> str:
    """Conservative source-tree change probe.

    Streams ``relpath\\0size\\0mtime_ns\\n`` for sorted regular files below
    ``root`` (io-walk skipping ``.git``/``node_modules``/``__pycache__`` and
    reparse points).  This is a change detector, not a content hash.
    """
    root = Path(root)
    expect_int(limit, "limit", low=1, high=1 << 31)
    if not root.exists():
        fail("INVALID_ARGUMENT", "source manifest root must be an existing directory")
    if not root.is_dir():
        fail("INVALID_ARGUMENT", "source manifest root must be an existing directory")
    if scope.is_reparse_point(root):
        fail("SCOPE_DENIED", "source manifest root must not be a symlink or junction")
    entries: List[Tuple[str, int, int]] = []
    for full, info in scope.iter_regular_files(root):
        relative = full.relative_to(root).as_posix()
        entries.append((relative, info.st_size, info.st_mtime_ns))
        if len(entries) > limit:
            fail(
                "LIMIT_EXCEEDED",
                "source manifest exceeds the conservative file-scan limit",
                details={"limit": limit},
            )
    entries.sort()
    hasher = hashlib.sha256()
    for relative, size, mtime_ns in entries:
        hasher.update(f"{relative}\0{size}\0{mtime_ns}\n".encode("utf-8"))
    return hasher.hexdigest()


def _workspace_source_digest(repositories: Sequence[Dict[str, Any]]) -> str:
    entries: List[Tuple[str, str, int, int]] = []
    for repository in repositories:
        root = Path(repository["absolute_path"])
        if not root.exists() or not root.is_dir():
            fail("NOT_FOUND", "registered repository root is not available")
        for full, info in scope.iter_regular_files(root):
            relative = full.relative_to(root).as_posix()
            entries.append((repository["repo_id"], relative, info.st_size, info.st_mtime_ns))
            if len(entries) > _SOURCE_MANIFEST_FILE_LIMIT:
                fail(
                    "LIMIT_EXCEEDED",
                    "workspace source manifest exceeds the conservative file-scan limit",
                    details={"limit": _SOURCE_MANIFEST_FILE_LIMIT},
                )
    entries.sort()
    hasher = hashlib.sha256()
    for repo_id, relative, size, mtime_ns in entries:
        hasher.update(f"{repo_id}\0{relative}\0{size}\0{mtime_ns}\n".encode("utf-8"))
    return hasher.hexdigest()


def _ref_digests(workspace: Dict[str, Any], refs: Sequence[Any]) -> Dict[str, Optional[str]]:
    result: Dict[str, Optional[str]] = {}
    for ref in refs:
        if not isinstance(ref, str):
            continue
        try:
            result[ref] = scope.ref_file_digest_registered(workspace, ref)
        except CodeLearningError:
            result[ref] = None
    return result


def _toolchain_digest(workspace: Dict[str, Any], toolchain_ref: Any) -> Optional[str]:
    if not isinstance(toolchain_ref, str):
        return None
    for toolchain in workspace.get("toolchains") or []:
        if isinstance(toolchain, dict) and toolchain.get("toolchain_ref") == toolchain_ref:
            return digest(toolchain)
    return None


def _binding_summary(binding: Dict[str, Any]) -> Dict[str, Any]:
    def endpoint(value: Any) -> Dict[str, Any]:
        if not isinstance(value, dict):
            return {}
        return {
            "repo_id": value.get("repo_id"),
            "variant_id": value.get("variant_id"),
            "interface_ref": value.get("interface_ref"),
            "interface_revision_ref": value.get("interface_revision_ref"),
        }

    return {
        "binding_id": binding.get("binding_id"),
        "revision": binding.get("revision"),
        "kind": binding.get("kind"),
        "from": endpoint(binding.get("from")),
        "to": endpoint(binding.get("to")),
        "selector": binding.get("selector"),
        "status": binding.get("status"),
    }


def _binding_digest(workspace: Dict[str, Any]) -> str:
    summaries = [
        _binding_summary(item)
        for item in (workspace.get("bindings") or [])
        if isinstance(item, dict)
    ]
    summaries.sort(key=lambda item: str(item.get("binding_id")))
    return digest(summaries)


def build_identity(workspace: Dict[str, Any], variant_id: str) -> Dict[str, Any]:
    variant = scope.find_variant(workspace, variant_id)
    return {
        "workspace_revision": workspace.get("revision"),
        "variant_id": variant_id,
        "roots_digest": workspace.get("roots_digest"),
        "source_manifest_digest": workspace.get("source_manifest_digest"),
        "compdb_digests": _ref_digests(workspace, variant.get("compdb_refs") or []),
        "config_digests": _ref_digests(workspace, variant.get("config_refs") or []),
        "generated_header_digests": _ref_digests(
            workspace, variant.get("generated_header_sets") or []
        ),
        "toolchain_digest": _toolchain_digest(workspace, variant.get("toolchain_ref")),
        "atlas_lock_digest": None,
        "sysroot_manifest_digest": None,
        "binding_digest": _binding_digest(workspace),
    }


# ---------------------------------------------------------------------------
# import / load
# ---------------------------------------------------------------------------
def _bindings_evaluate(workspace: Dict[str, Any], raw_bindings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not raw_bindings:
        return []
    try:
        from .bindings import evaluate_bindings  # type: ignore[import-not-found]
    except (ImportError, AttributeError):
        fail(
            "DEPENDENCY_UNAVAILABLE",
            "cross-repository binding evaluation module is not available in this build",
        )
    try:
        evaluated = evaluate_bindings(workspace, [dict(item) for item in raw_bindings])
    except CodeLearningError:
        raise
    except Exception as error:  # pragma: no cover - defensive integration boundary
        fail(
            "DEPENDENCY_UNAVAILABLE",
            f"cross-repository binding evaluation failed: {type(error).__name__}",
        )
    if not isinstance(evaluated, list) or not all(isinstance(item, dict) for item in evaluated):
        fail("DEPENDENCY_UNAVAILABLE", "cross-repository binding evaluation returned an invalid result")
    return [dict(item) for item in evaluated]


def _build_registration(
    state,
    normalized: Dict[str, Any],
    manifest_name: str,
    manifest_sha256: str,
    revision: int,
    created_at: Optional[str],
) -> Dict[str, Any]:
    now = utc_now_iso()
    workspace: Dict[str, Any] = {
        "workspace_id": normalized["workspace_id"],
        "revision": revision,
        "scope_ref": state.scope_ref,
        "scope_generation": int(state.scope_generation),
        "created_at": created_at or now,
        "updated_at": now,
        "manifest_name": manifest_name,
        "manifest_sha256": manifest_sha256,
        "source_manifest_digest": _workspace_source_digest(normalized["repositories"]),
        "roots_digest": digest(
            sorted(
                [
                    {"repo_id": repo["repo_id"], "realpath": os.path.normcase(repo["absolute_path"])}
                    for repo in normalized["repositories"]
                ],
                key=lambda item: item["repo_id"],
            )
        ),
        "repositories": [dict(repo) for repo in normalized["repositories"]],
        "variants": [dict(variant) for variant in normalized["variants"]],
        "bindings": [],
        "toolchains": [dict(toolchain) for toolchain in normalized["toolchains"]],
    }
    workspace["bindings"] = _bindings_evaluate(workspace, normalized["bindings"])
    for variant in workspace["variants"]:
        preflight = build.preflight_variant(state, workspace, variant["variant_id"])
        variant["semantic_status"] = preflight["semantic_status"]
        variant["missing_inputs"] = list(preflight["missing_inputs"])
        variant["diagnostics"] = list(preflight["diagnostics"])
        variant["build_identity"] = None
    for variant in workspace["variants"]:
        variant["build_identity"] = build_identity(workspace, variant["variant_id"])
    return {"schema_version": 1, "workspace": workspace}


def _read_manifest(state, manifest_ref: str) -> Tuple[Path, bytes, Any]:
    expect_str(manifest_ref, "manifest_ref", max_len=256)
    path = state.inbox_file(manifest_ref)
    try:
        raw = path.read_bytes()
    except OSError:
        fail("DEPENDENCY_UNAVAILABLE", "inbox manifest is not readable")
    manifest = read_json_bytes(raw, "workspace manifest")
    return path, raw, manifest


def _request_digest(manifest_name: str, expected_revision: int, manifest_sha256: str) -> str:
    return digest(
        {
            "action": "workspace-import",
            "manifest_name": manifest_name,
            "manifest_sha256": manifest_sha256,
            "expected_revision": expected_revision,
        }
    )


def load_workspace(state, workspace_ref: str) -> Dict[str, Any]:
    workspace_id = check_id(workspace_ref, "workspace_ref")
    registration = state.read_registration(workspace_id)
    if registration is None:
        fail("NOT_FOUND", "workspace is not registered in this scope")
    workspace = registration.get("workspace")
    if not isinstance(workspace, dict):
        fail("UNSUPPORTED_SCHEMA", "workspace registration is not supported")
    if workspace.get("workspace_id") != workspace_id:
        fail("UNSUPPORTED_SCHEMA", "workspace registration identity does not match its directory")
    if workspace.get("scope_ref") != state.scope_ref:
        fail("SCOPE_DENIED", "workspace belongs to another scope")
    if workspace.get("scope_generation") != state.scope_generation:
        fail("SCOPE_DENIED", "workspace belongs to another scope generation")
    revision = workspace.get("revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        fail("UNSUPPORTED_SCHEMA", "workspace registration revision is not supported")
    return workspace


def import_workspace(state, manifest_name: str, expected_revision: int, operation_id: str) -> Dict[str, Any]:
    expect_str(manifest_name, "manifest_name", max_len=256)
    expected_revision = expect_int(expected_revision, "expected_revision", low=0, high=1 << 31)
    operation_id = expect_str(operation_id, "operation_id", max_len=128)
    _path, raw, manifest = _read_manifest(state, manifest_name)
    manifest_sha256 = sha256_bytes(raw)
    request_digest = _request_digest(manifest_name, expected_revision, manifest_sha256)

    existing = state.operation_get(operation_id)
    if existing is not None:
        if existing.get("request_digest") == request_digest:
            return existing.get("result")
        fail(
            "OPERATION_CONFLICT",
            "operation_id was already used for a different workspace import request",
            details={"operation_id": operation_id},
        )

    normalized = _validate_manifest(state, manifest)
    workspace_id = normalized["workspace_id"]
    with state.workspace_lock(workspace_id):
        registration = state.read_registration(workspace_id)
        current_revision = 0
        created_at: Optional[str] = None
        if registration is not None:
            current_workspace = registration.get("workspace") or {}
            stored_revision = current_workspace.get("revision")
            if isinstance(stored_revision, bool) or not isinstance(stored_revision, int):
                fail("UNSUPPORTED_SCHEMA", "workspace registration revision is not supported")
            current_revision = stored_revision
            created_at = current_workspace.get("created_at")
        if expected_revision != current_revision:
            fail(
                "STATE_CONFLICT",
                "workspace revision does not match the expected revision",
                retryable=True,
                details={"current_revision": current_revision},
            )
        # Re-check the operation inside the write lock to keep retries idempotent.
        existing = state.operation_get(operation_id)
        if existing is not None:
            if existing.get("request_digest") == request_digest:
                return existing.get("result")
            fail(
                "OPERATION_CONFLICT",
                "operation_id was already used for a different workspace import request",
                details={"operation_id": operation_id},
            )
        registration = _build_registration(
            state, normalized, manifest_name, manifest_sha256, current_revision + 1, created_at
        )
        result = public_projection(registration["workspace"])
        state.write_registration(workspace_id, registration)
        state.operation_put(operation_id, request_digest, result)
        return result


# ---------------------------------------------------------------------------
# projection / status / validate / overview
# ---------------------------------------------------------------------------
def _missing_inputs(workspace: Dict[str, Any]) -> List[str]:
    missing = set()
    for variant in workspace.get("variants") or []:
        for item in variant.get("missing_inputs") or []:
            if isinstance(item, str):
                missing.add(item)
    return sorted(missing)


def _semantic_status_by_variant(workspace: Dict[str, Any]) -> Dict[str, str]:
    return {
        variant["variant_id"]: variant.get("semantic_status", "blocked")
        for variant in workspace.get("variants") or []
    }


def public_projection(workspace: Dict[str, Any]) -> Dict[str, Any]:
    variants: List[Dict[str, Any]] = []
    for variant in workspace.get("variants") or []:
        variants.append(
            {
                "variant_id": variant.get("variant_id"),
                "analysis_mode": variant.get("analysis_mode"),
                "architecture": variant.get("architecture"),
                "target_triple": variant.get("target_triple"),
                "semantic_status": variant.get("semantic_status", "blocked"),
                "missing_inputs": list(variant.get("missing_inputs") or []),
                "build_identity": variant.get("build_identity") or {},
            }
        )
    bindings: List[Dict[str, Any]] = []
    for item in workspace.get("bindings") or []:
        if not isinstance(item, dict):
            continue
        from_endpoint = item.get("from") if isinstance(item.get("from"), dict) else {}
        to_endpoint = item.get("to") if isinstance(item.get("to"), dict) else {}
        bindings.append(
            {
                "binding_id": item.get("binding_id"),
                "revision": item.get("revision"),
                "kind": item.get("kind"),
                "from_repo_id": from_endpoint.get("repo_id"),
                "to_repo_id": to_endpoint.get("repo_id"),
                "status": item.get("status"),
            }
        )
    repositories = []
    for repo in workspace.get("repositories") or []:
        repositories.append(
            {
                "repo_id": repo.get("repo_id"),
                "root_ref": repo.get("root_ref"),
                "role": repo.get("role"),
                "vcs": repo.get("vcs") or {"kind": "none", "commit": None},
            }
        )
    return {
        "schema_version": 1,
        "workspace_id": workspace.get("workspace_id"),
        "workspace_revision": workspace.get("revision"),
        "scope_ref": workspace.get("scope_ref"),
        "scope_generation": workspace.get("scope_generation"),
        "manifest_digest": workspace.get("manifest_sha256"),
        "repositories": repositories,
        "variants": variants,
        "bindings": bindings,
        "semantic_status_by_variant": _semantic_status_by_variant(workspace),
        "missing_inputs": _missing_inputs(workspace),
        "freshness": "fresh",
    }


def _check_freshness(
    state, workspace: Dict[str, Any]
) -> Tuple[str, bool, List[Dict[str, Any]]]:
    diagnostics: List[Dict[str, Any]] = []
    valid = True
    unknown = False
    stale = False
    roots_ok = True
    for repository in workspace.get("repositories") or []:
        try:
            scope.repo_root(state, workspace, repository["repo_id"])
        except CodeLearningError as error:
            roots_ok = False
            valid = False
            unknown = True
            diagnostics.append(
                {
                    "code": "repository_unavailable",
                    "severity": "error",
                    "message": f"repository {repository.get('repo_id')!r} is not readable: {error.message}",
                }
            )
    manifest_name = workspace.get("manifest_name")
    manifest_path = None
    if isinstance(manifest_name, str) and manifest_name:
        try:
            manifest_path = state.inbox_file(manifest_name)
        except CodeLearningError:
            manifest_path = None
            unknown = True
            diagnostics.append(
                {
                    "code": "manifest_unavailable",
                    "severity": "warning",
                    "message": "the registered inbox manifest is no longer available; revalidate before trusting variant status",
                }
            )
    if manifest_path is not None:
        try:
            current_sha = sha256_file(manifest_path)
        except OSError:
            unknown = True
            diagnostics.append(
                {"code": "manifest_unavailable", "severity": "warning", "message": "the registered inbox manifest is not readable"}
            )
        else:
            if current_sha != workspace.get("manifest_sha256"):
                stale = True
                diagnostics.append(
                    {
                        "code": "manifest_changed",
                        "severity": "warning",
                        "message": "the inbox manifest changed after registration; import a new revision to refresh it",
                    }
                )
    if roots_ok:
        try:
            current_source = _workspace_source_digest(workspace.get("repositories") or [])
        except CodeLearningError as error:
            unknown = True
            diagnostics.append(
                {"code": "source_manifest_unavailable", "severity": "warning", "message": str(error)}
            )
        else:
            if current_source != workspace.get("source_manifest_digest"):
                stale = True
                diagnostics.append(
                    {
                        "code": "source_manifest_changed",
                        "severity": "warning",
                        "message": "registered source files changed after this revision; revalidate before relying on it",
                    }
                )
    freshness = "unknown" if unknown else ("stale" if stale else "fresh")
    return freshness, valid, diagnostics


def workspace_status(state, workspace_ref: str) -> Dict[str, Any]:
    workspace = load_workspace(state, workspace_ref)
    freshness, valid, diagnostics = _check_freshness(state, workspace)
    variants: List[Dict[str, Any]] = []
    compiler_ready = False
    for variant in workspace.get("variants") or []:
        semantic_status = variant.get("semantic_status", "blocked")
        if semantic_status == "ready":
            compiler_ready = True
        variants.append(
            {
                "variant_id": variant.get("variant_id"),
                "analysis_mode": variant.get("analysis_mode"),
                "semantic_status": semantic_status,
                "missing_inputs": list(variant.get("missing_inputs") or []),
                "build_identity": variant.get("build_identity") or {},
            }
        )
    try:
        snapshot_entries = [
            entry
            for entry in state.snapshots_index().get("entries", [])
            if entry.get("workspace_id") == workspace["workspace_id"]
        ]
    except CodeLearningError:  # pragma: no cover - defensive
        snapshot_entries = []
    capabilities = {
        "source_text": "ready",
        "compiler_evidence": "ready" if compiler_ready else "blocked",
        "snapshot_query": "ready" if snapshot_entries else "unavailable",
    }
    return {
        "schema_version": 1,
        "workspace_id": workspace["workspace_id"],
        "workspace_revision": workspace["revision"],
        "scope_ref": workspace.get("scope_ref"),
        "scope_generation": workspace.get("scope_generation"),
        "manifest_digest": workspace.get("manifest_sha256"),
        "freshness": freshness,
        "valid": valid,
        "variants": variants,
        "semantic_status_by_variant": _semantic_status_by_variant(workspace),
        "missing_inputs": _missing_inputs(workspace),
        "capabilities": capabilities,
        "diagnostics": diagnostics,
        "active_runs": [],
    }


def validate_workspace(state, manifest_ref: Optional[str] = None, workspace_ref: Optional[str] = None) -> Dict[str, Any]:
    if (manifest_ref is None) == (workspace_ref is None):
        fail("INVALID_ARGUMENT", "exactly one of manifest_ref or workspace_ref must be provided")
    if manifest_ref is not None:
        _path, raw, manifest = _read_manifest(state, manifest_ref)
        normalized = _validate_manifest(state, manifest)
        stub = {
            "workspace_id": normalized["workspace_id"],
            "revision": 0,
            "scope_ref": state.scope_ref,
            "scope_generation": int(state.scope_generation),
            "manifest_sha256": sha256_bytes(raw),
            "repositories": normalized["repositories"],
            "variants": normalized["variants"],
            "toolchains": normalized["toolchains"],
            "bindings": [],
        }
        semantic: Dict[str, str] = {}
        missing = set()
        diagnostics: List[Dict[str, Any]] = []
        for variant in stub["variants"]:
            preflight = build.preflight_variant(state, stub, variant["variant_id"])
            semantic[variant["variant_id"]] = preflight["semantic_status"]
            missing.update(preflight["missing_inputs"])
            diagnostics.extend(preflight["diagnostics"])
        revision = 0
        registration = state.read_registration(normalized["workspace_id"])
        if registration is not None:
            stored = registration.get("workspace") or {}
            if isinstance(stored.get("revision"), int):
                revision = stored["revision"]
        return {
            "schema_version": 1,
            "workspace_id": normalized["workspace_id"],
            "workspace_revision": revision,
            "manifest_digest": sha256_bytes(raw),
            "scope_ref": state.scope_ref,
            "scope_generation": int(state.scope_generation),
            "valid": True,
            "semantic_status_by_variant": semantic,
            "missing_inputs": sorted(missing),
            "diagnostics": diagnostics,
            "freshness": "fresh",
        }
    workspace = load_workspace(state, workspace_ref)
    freshness, valid, diagnostics = _check_freshness(state, workspace)
    return {
        "schema_version": 1,
        "workspace_id": workspace["workspace_id"],
        "workspace_revision": workspace["revision"],
        "manifest_digest": workspace.get("manifest_sha256"),
        "scope_ref": workspace.get("scope_ref"),
        "scope_generation": workspace.get("scope_generation"),
        "valid": valid,
        "semantic_status_by_variant": _semantic_status_by_variant(workspace),
        "missing_inputs": _missing_inputs(workspace),
        "diagnostics": diagnostics,
        "freshness": freshness,
    }


def overview(
    state,
    workspace_ref: str,
    variant_id: str,
    snapshot_ref: Optional[str] = None,
    max_components: int = 20,
) -> Dict[str, Any]:
    workspace = load_workspace(state, workspace_ref)
    variant = scope.find_variant(workspace, variant_id)
    limit = expect_int(max_components, "max_components", low=1, high=100)

    components = []
    for repository in workspace.get("repositories") or []:
        components.append(
            {
                "component_ref": repository.get("repo_id"),
                "repo_id": repository.get("repo_id"),
                "root_ref": repository.get("root_ref"),
                "role": repository.get("role"),
                "vcs": repository.get("vcs"),
                "origin": "declared",
                "certainty": "declared",
                "limitations": ["declared_role_or_boundary_from_manifest"],
            }
        )
    truncated = len(components) > limit
    components = components[:limit]

    interface_candidates: List[Dict[str, Any]] = []
    for binding in workspace.get("bindings") or []:
        if not isinstance(binding, dict):
            continue
        for endpoint in (binding.get("from"), binding.get("to")):
            if not isinstance(endpoint, dict) or not endpoint.get("repo_id"):
                continue
            interface_candidates.append(
                {
                    "ref": f"{endpoint.get('repo_id')}:{endpoint.get('interface_ref')}",
                    "repo_id": endpoint.get("repo_id"),
                    "variant_id": endpoint.get("variant_id"),
                    "interface_ref": endpoint.get("interface_ref"),
                    "binding_id": binding.get("binding_id"),
                    "kind": "binding_endpoint",
                    "origin": "declared",
                    "certainty": "may",
                }
            )
    if len(interface_candidates) > 200:
        interface_candidates = interface_candidates[:200]
        truncated = True

    unknown_boundaries: List[Dict[str, Any]] = []
    if variant.get("semantic_status") != "ready":
        for item in variant.get("missing_inputs") or ["compiler_build_context"]:
            unknown_boundaries.append(
                {
                    "reason": f"semantic_status_blocked:{item}",
                    "limitations": ["text_only_not_compiler_fact"],
                }
            )
        unknown_boundaries.append(
            {
                "reason": "compiler_facts_unavailable",
                "limitations": ["no_verified_snapshot_for_this_variant"],
            }
        )
    result: Dict[str, Any] = {
        "schema_version": 1,
        "workspace_id": workspace["workspace_id"],
        "workspace_revision": workspace["revision"],
        "variant_id": variant_id,
        "semantic_status": variant.get("semantic_status", "blocked"),
        "missing_inputs": list(variant.get("missing_inputs") or []),
        "components": components,
        "interface_candidates": interface_candidates,
        "evidence_refs": [],
        "unknown_boundaries": unknown_boundaries,
        "truncated": truncated,
        "snapshot_ref": snapshot_ref,
    }
    if snapshot_ref is not None:
        try:
            from .snapshot import load_snapshot  # type: ignore[import-not-found]
        except (ImportError, AttributeError):
            fail(
                "DEPENDENCY_UNAVAILABLE",
                "snapshot reading module is not available in this build",
            )
        try:
            snapshot = load_snapshot(state, workspace["workspace_id"], snapshot_ref)
        except CodeLearningError:
            raise
        result["snapshot"] = snapshot
        result["evidence_refs"] = [snapshot.get("snapshot_ref") or snapshot_ref]
        if snapshot.get("freshness") != "fresh":
            result["unknown_boundaries"].append(
                {
                    "reason": "snapshot_not_fresh",
                    "limitations": [f"freshness={snapshot.get('freshness')}"],
                }
            )
        else:
            result["unknown_boundaries"] = [
                boundary
                for boundary in result["unknown_boundaries"]
                if boundary.get("reason") != "compiler_facts_unavailable"
            ]
    return result
