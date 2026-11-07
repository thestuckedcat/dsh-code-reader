"""Constructed fixtures shared by test_snapshot/test_paths/test_bindings.

These fixtures deliberately avoid the real ``workspace.py`` implementation: the
snapshot/path/binding tests are unit tests of the snapshot contract and must be
runnable while workspace.py is still being written in parallel.  A small
integration test in test_snapshot.py exercises the real import path when the
workspace backend is available.
"""

from __future__ import annotations

import contextlib
import uuid
from typing import Any, Dict, Iterable, List, Optional

from unittest import mock

from tests import helpers
from code_learning import snapshot as snapshot_module

VARIANT_ID = "source-only-x86_64"
SECOND_VARIANT_ID = "defconfig-x86_64"
WORKSPACE_ID = "fixture-workspace"

_ROLE_BY_REPO = {"umd": "umd", "uapi": "uapi", "kmd": "kmd"}


def make_variant(
    variant_id: str = VARIANT_ID,
    *,
    revision: int = 1,
    source_manifest_digest: str = "source-digest-1",
) -> Dict[str, Any]:
    """One internal-registration variant entry (contract §3)."""
    return {
        "variant_id": variant_id,
        "analysis_mode": "source_only",
        "architecture": "x86_64",
        "target_triple": None,
        "config_refs": [],
        "compdb_refs": [],
        "generated_header_sets": [],
        "toolchain_ref": None,
        "sysroot_ref": None,
        "include_root_refs": [],
        "link_evidence_refs": [],
        "uapi_revision_refs": [],
        "execution_profile_ref": None,
        "semantic_status": "blocked",
        "missing_inputs": ["compiler_build_context"],
        "diagnostics": [],
        "build_identity": {
            "workspace_revision": revision,
            "variant_id": variant_id,
            "roots_digest": "0" * 64,
            "source_manifest_digest": source_manifest_digest,
            "compdb_digests": {},
            "config_digests": {},
            "generated_header_digests": {},
            "toolchain_digest": None,
            "atlas_lock_digest": None,
            "sysroot_manifest_digest": None,
            "binding_digest": "1" * 64,
        },
    }


def make_workspace(
    *,
    workspace_id: str = WORKSPACE_ID,
    revision: int = 1,
    source_manifest_digest: str = "source-digest-1",
    repos: Iterable[str] = ("umd", "uapi", "kmd"),
    variant_ids: Iterable[str] = (VARIANT_ID,),
    bindings: Optional[List[Dict[str, Any]]] = None,
    root: str = "C:/synthetic-root",
) -> Dict[str, Any]:
    """An internal registration ``workspace`` dict (contract §3), no state needed."""
    variant_ids = list(variant_ids)
    repositories = []
    for repo_id in repos:
        repositories.append(
            {
                "repo_id": repo_id,
                "root_ref": "synthetic-root",
                "relative_path": repo_id,
                "absolute_path": f"{root}/{repo_id}",
                "role": _ROLE_BY_REPO.get(repo_id, "other"),
                "vcs": {"kind": "none", "commit": None},
            }
        )
    return {
        "workspace_id": workspace_id,
        "revision": revision,
        "scope_ref": "local",
        "scope_generation": 1,
        "created_at": "2026-11-07T00:00:00Z",
        "updated_at": "2026-11-07T00:00:00Z",
        "manifest_name": "workspace.json",
        "manifest_sha256": "2" * 64,
        "source_manifest_digest": source_manifest_digest,
        "roots_digest": "3" * 64,
        "repositories": repositories,
        "variants": [make_variant(v, revision=revision, source_manifest_digest=source_manifest_digest) for v in variant_ids],
        "bindings": list(bindings or []),
        "toolchains": [],
    }


def install_workspace(env: Any, workspace: Dict[str, Any]) -> Dict[str, Any]:
    """Write the registration file so state-level lookups behave realistically."""
    env.state.write_registration(
        workspace["workspace_id"],
        {"schema_version": 1, "workspace": workspace},
    )
    return workspace


@contextlib.contextmanager
def patch_workspace(workspace: Dict[str, Any]):
    """Replace the lazy workspace resolver while the real backend is absent."""
    with mock.patch.object(snapshot_module, "load_workspace_registration", return_value=workspace):
        yield workspace


def import_snapshot(
    env: Any,
    workspace: Dict[str, Any],
    snapshot_name: str,
    *,
    repo_id: str = "umd",
    variant_id: str = VARIANT_ID,
    operation_id: Optional[str] = None,
) -> Dict[str, Any]:
    with patch_workspace(workspace):
        return snapshot_module.import_snapshot(
            env.state,
            workspace["workspace_id"],
            variant_id,
            repo_id,
            snapshot_name,
            operation_id or uuid.uuid4().hex,
        )


def write_snapshot(
    env: Any,
    name: str,
    graph_payload: Optional[Dict[str, Any]] = None,
    manifest_overrides: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    payload = graph_payload if graph_payload is not None else helpers.simple_graph_payload()
    return helpers.write_snapshot_dir(env.inbox_dir / name, payload, manifest_overrides)


def graph_payload(
    *,
    functions: Optional[List[Dict[str, Any]]] = None,
    call_targets: Optional[List[Dict[str, Any]]] = None,
    callsites: Optional[List[Dict[str, Any]]] = None,
    evidence: Optional[List[Dict[str, Any]]] = None,
    issues: Optional[List[Dict[str, Any]]] = None,
    flow_edges: Optional[List[Dict[str, Any]]] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Minimal Atlas-schema-shaped graph payload with caller-provided entities."""
    payload: Dict[str, Any] = {
        "functions": list(functions or []),
        "types": [],
        "objects": [],
        "callsites": list(callsites or []),
        "call_targets": list(call_targets or []),
        "flow_edges": list(flow_edges or []),
        "evidence": list(evidence or []),
        "issues": list(issues or []),
        "coverage": {},
        "scope": {},
    }
    if extra:
        payload.update(extra)
    return payload


def function(
    function_id: str,
    name: str,
    *,
    file: str = "src/file.c",
    line: int = 1,
    kind: str = "function",
    display_name: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        "id": function_id,
        "name": name,
        "display_name": display_name if display_name is not None else name,
        "file": file,
        "line": line,
        "kind": kind,
    }


def call_target(
    target_id: str,
    *,
    callsite: str,
    source: str,
    target: str,
    certainty: str = "exact",
    origin: str = "deterministic_analysis",
    evidence: Optional[List[str]] = None,
    **extra: Any,
) -> Dict[str, Any]:
    entry = {
        "id": target_id,
        "callsite": callsite,
        "source": source,
        "target": target,
        "origin": origin,
        "certainty": certainty,
        "evidence_ids": list(evidence or []),
    }
    entry.update(extra)
    return entry


def callsite(callsite_id: str, *, owner: str, file: str = "src/file.c", line: int = 1) -> Dict[str, Any]:
    return {"id": callsite_id, "owner": owner, "file": file, "line": line}


def evidence(evidence_id: str, *, kind: str = "call", file: str = "src/file.c", line: int = 1) -> Dict[str, Any]:
    return {"id": evidence_id, "kind": kind, "file": file, "line": line}


def chain_graph(
    length: int = 5,
    *,
    prefix: str = "uapi",
) -> Dict[str, Any]:
    """A simple ``f0 -> f1 -> ...`` call chain used for budget/depth tests."""
    functions = [
        function(f"fn_chain_{index}", f"chain_{index}", file=f"{prefix}/src/chain.c", line=index + 1)
        for index in range(length)
    ]
    call_targets = [
        call_target(
            f"ct_chain_{index}",
            callsite=f"cs_chain_{index}",
            source=f"fn_chain_{index}",
            target=f"fn_chain_{index + 1}",
            certainty="exact",
            evidence=[f"ev_chain_{index}"],
        )
        for index in range(length - 1)
    ]
    callsites = [
        callsite(f"cs_chain_{index}", owner=f"fn_chain_{index}", file=f"{prefix}/src/chain.c", line=index + 1)
        for index in range(length - 1)
    ]
    evidence_entries = [
        evidence(f"ev_chain_{index}", file=f"{prefix}/src/chain.c", line=index + 1)
        for index in range(length - 1)
    ]
    return graph_payload(
        functions=functions,
        call_targets=call_targets,
        callsites=callsites,
        evidence=evidence_entries,
    )
