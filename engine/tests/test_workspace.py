"""CL-001-A: workspace registration, build identity, status and overview bounds.

Negative cases covered here:
* unknown candidate root, repository root that is a symlink/junction, a
  repository root that resolves into a *different* registered root, nested or
  duplicate repository roots, and strict manifest validation errors;
* revision CAS for repeated imports and operation-id idempotency/conflict;
* source-only works without any compdb/config/toolchain input;
* semantic variants stay ``blocked`` unless real compdb/config/generated-header/
  toolchain inputs pass the read-only argv preflight (shell chaining, relative
  compilers, plugin loading and out-of-root includes are rejected);
* source/config/compdb digests and workspace freshness change when files change.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

from code_learning.errors import CodeLearningError
from code_learning.state import init_bootstrap
from code_learning.workspace import (
    build_identity,
    import_workspace,
    load_workspace,
    overview,
    public_projection,
    source_manifest_digest,
    validate_workspace,
    workspace_status,
)
from tests.helpers import (
    KMD_CONFIG,
    base_manifest,
    make_bootstrap,
    sha256_file,
    write_json,
    write_text,
)


def make_dir_link(link: Path, target: Path) -> bool:
    """Create a directory symlink (POSIX) or junction (Windows) for testing."""
    link = Path(link)
    target = Path(target)
    try:
        os.symlink(str(target), str(link), target_is_directory=True)
        return True
    except (OSError, NotImplementedError):
        pass
    if os.name == "nt":
        completed = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True,
            text=True,
        )
        return completed.returncode == 0
    return False


def expect_code(testcase: unittest.TestCase, code: str, function, *args, **kwargs):
    with testcase.assertRaises(CodeLearningError) as caught:
        function(*args, **kwargs)
    testcase.assertEqual(caught.exception.code, code, str(caught.exception))
    return caught.exception


class WorkspaceTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="cl-ws-")
        self.tmp_path = Path(self._tmp.name)
        self.env = make_bootstrap(self.tmp_path)
        self.state = self.env.state
        self.root = self.env.root
        self.umd = self.env.umd
        self.kmd = self.env.kmd

    def tearDown(self) -> None:
        self._tmp.cleanup()

    # -- helpers -------------------------------------------------------
    def write_manifest(self, manifest=None, name: str = "workspace.json") -> str:
        write_json(self.env.inbox_dir / name, base_manifest() if manifest is None else manifest)
        return name

    def import_ok(self, manifest=None, *, expected_revision: int = 0, name: str = "workspace.json"):
        self.write_manifest(manifest, name=name)
        operation_id = f"op-{uuid.uuid4().hex}"
        return import_workspace(self.state, name, expected_revision, operation_id)

    def import_ok_op(self, operation_id: str, manifest=None, *, expected_revision: int = 0):
        self.write_manifest(manifest)
        return import_workspace(self.state, "workspace.json", expected_revision, operation_id)

    # -- happy path ----------------------------------------------------
    def test_first_import_returns_public_projection(self) -> None:
        result = self.import_ok()
        self.assertEqual(result["schema_version"], 1)
        self.assertEqual(result["workspace_id"], "synthetic-linux-ioctl")
        self.assertEqual(result["workspace_revision"], 1)
        self.assertEqual(result["scope_ref"], "local")
        self.assertEqual(result["scope_generation"], 1)
        self.assertEqual(result["freshness"], "fresh")
        self.assertEqual(len(result["manifest_digest"]), 64)
        self.assertEqual([repo["repo_id"] for repo in result["repositories"]], ["umd", "uapi", "kmd"])
        for repo in result["repositories"]:
            self.assertEqual(
                set(repo), {"repo_id", "root_ref", "role", "vcs"}
            )
        variant = result["variants"][0]
        self.assertEqual(variant["variant_id"], "source-only-x86_64")
        self.assertEqual(variant["analysis_mode"], "source_only")
        self.assertEqual(variant["semantic_status"], "blocked")
        self.assertEqual(variant["missing_inputs"], ["compiler_build_context"])
        self.assertIsInstance(variant["build_identity"], dict)
        self.assertEqual(result["semantic_status_by_variant"], {"source-only-x86_64": "blocked"})
        self.assertEqual(result["missing_inputs"], ["compiler_build_context"])
        self.assertEqual(result["bindings"], [])
        serialized = json.dumps(result)
        self.assertNotIn("absolute_path", serialized)
        self.assertNotIn(str(self.root), serialized)

    def test_registration_internal_fields_and_load_workspace(self) -> None:
        self.import_ok()
        registration = self.state.read_registration("synthetic-linux-ioctl")
        self.assertEqual(registration["schema_version"], 1)
        workspace = registration["workspace"]
        for key in (
            "workspace_id",
            "revision",
            "scope_ref",
            "scope_generation",
            "created_at",
            "updated_at",
            "manifest_name",
            "manifest_sha256",
            "source_manifest_digest",
            "roots_digest",
            "repositories",
            "variants",
            "bindings",
            "toolchains",
        ):
            self.assertIn(key, workspace)
        self.assertEqual(workspace["manifest_name"], "workspace.json")
        self.assertEqual(workspace["manifest_sha256"], sha256_file(self.env.inbox_dir / "workspace.json"))
        repo = workspace["repositories"][0]
        self.assertTrue(repo["absolute_path"].endswith("umd"))
        variant = workspace["variants"][0]
        self.assertIn("build_identity", variant)
        variant_identity = variant["build_identity"]
        self.assertEqual(variant_identity["workspace_revision"], 1)
        self.assertEqual(variant_identity["variant_id"], "source-only-x86_64")

        loaded = load_workspace(self.state, "synthetic-linux-ioctl")
        self.assertEqual(loaded["revision"], 1)
        self.assertEqual(loaded["workspace_id"], "synthetic-linux-ioctl")

    def test_import_operation_idempotent_and_operation_conflict(self) -> None:
        manifest = base_manifest()
        first = self.import_ok_op("op-idempotent-1", manifest, expected_revision=0)
        second = self.import_ok_op("op-idempotent-1", manifest, expected_revision=0)
        self.assertEqual(first, second)
        self.assertEqual(load_workspace(self.state, "synthetic-linux-ioctl")["revision"], 1)

        # Changing the request (other manifest bytes) under the same operation id
        # must be refused instead of returning the old result.
        changed = base_manifest()
        changed["repositories"][0]["vcs"] = {"kind": "git", "commit": "deadbeef"}
        expect_code(
            self,
            "OPERATION_CONFLICT",
            self.import_ok_op,
            "op-idempotent-1",
            changed,
            expected_revision=1,
        )

    def test_revision_cas_rejects_stale_expected_revision(self) -> None:
        self.import_ok(expected_revision=0)
        changed = base_manifest()
        changed["repositories"][0]["vcs"] = {"kind": "git", "commit": "cafe"}
        with self.assertRaises(CodeLearningError) as caught:
            self.import_ok(changed, expected_revision=0)
        self.assertEqual(caught.exception.code, "STATE_CONFLICT")
        self.assertEqual(caught.exception.details.get("current_revision"), 1)

        result = self.import_ok(changed, expected_revision=1)
        self.assertEqual(result["workspace_revision"], 2)
        self.assertEqual(load_workspace(self.state, "synthetic-linux-ioctl")["revision"], 2)

    def test_manifest_scope_and_schema_errors(self) -> None:
        manifest = base_manifest()
        manifest["scope_ref"] = "some-other-scope"
        expect_code(self, "SCOPE_DENIED", self.import_ok, manifest)

        manifest = base_manifest()
        manifest["schema_version"] = 2
        expect_code(self, "UNSUPPORTED_SCHEMA", self.import_ok, manifest)

        manifest = base_manifest()
        manifest["surprise"] = True
        expect_code(self, "INVALID_ARGUMENT", self.import_ok, manifest)

        manifest = base_manifest()
        manifest["repositories"][0]["role"] = "rootkit"
        expect_code(self, "INVALID_ARGUMENT", self.import_ok, manifest)

        manifest = base_manifest()
        manifest["repositories"][1]["repo_id"] = "umd"
        expect_code(self, "INVALID_ARGUMENT", self.import_ok, manifest)

        manifest = base_manifest()
        manifest["repositories"][0]["relative_path"] = "../outside"
        expect_code(self, "INVALID_ARGUMENT", self.import_ok, manifest)

        manifest = base_manifest()
        manifest["repositories"][0]["relative_path"] = "/abs/path"
        expect_code(self, "INVALID_ARGUMENT", self.import_ok, manifest)

        manifest = base_manifest()
        manifest["variants"][0]["toolchain_ref"] = "not-registered"
        expect_code(self, "INVALID_ARGUMENT", self.import_ok, manifest)

        manifest = base_manifest()
        manifest["variants"][0]["compdb_refs"] = ["umd"]  # missing ':' form
        expect_code(self, "INVALID_ARGUMENT", self.import_ok, manifest)

    def test_unknown_root_rejected(self) -> None:
        manifest = base_manifest()
        manifest["repositories"][0]["root_ref"] = "root-that-was-never-registered"
        expect_code(self, "SCOPE_DENIED", self.import_ok, manifest)

    def test_missing_and_file_repository_roots_rejected(self) -> None:
        manifest = base_manifest()
        manifest["repositories"] = [
            {"repo_id": "umd", "root_ref": "synthetic-root", "relative_path": "nope", "role": "umd"}
        ]
        expect_code(self, "NOT_FOUND", self.import_ok, manifest)

        manifest = base_manifest()
        manifest["repositories"] = [
            {
                "repo_id": "umd",
                "root_ref": "synthetic-root",
                "relative_path": "umd/src/job_submit.c",
                "role": "umd",
            }
        ]
        expect_code(self, "INVALID_ARGUMENT", self.import_ok, manifest)

    def test_nested_and_duplicate_repository_roots_rejected(self) -> None:
        manifest = base_manifest()
        manifest["repositories"] = [
            {"repo_id": "umd", "root_ref": "synthetic-root", "relative_path": "umd", "role": "umd"},
            {"repo_id": "uapi", "root_ref": "synthetic-root", "relative_path": "umd/src", "role": "uapi"},
        ]
        expect_code(self, "INVALID_ARGUMENT", self.import_ok, manifest)

        manifest = base_manifest()
        manifest["repositories"] = [
            {"repo_id": "umd", "root_ref": "synthetic-root", "relative_path": "umd", "role": "umd"},
            {"repo_id": "uapi", "root_ref": "synthetic-root", "relative_path": "umd", "role": "uapi"},
        ]
        expect_code(self, "INVALID_ARGUMENT", self.import_ok, manifest)

    def test_symlinked_repository_root_rejected(self) -> None:
        link = self.root / "linked-umd"
        if not make_dir_link(link, self.umd):
            self.skipTest("directory links are not available on this platform")
        manifest = base_manifest()
        manifest["repositories"] = [
            {"repo_id": "umd", "root_ref": "synthetic-root", "relative_path": "linked-umd", "role": "umd"}
        ]
        expect_code(self, "SCOPE_DENIED", self.import_ok, manifest)

    def test_cross_root_escape_with_junction_rejected(self) -> None:
        """A repo rooted under root A must not resolve into another candidate root."""
        cross_root = self.tmp_path / "root-a"
        other_root = self.tmp_path / "root-b"
        cross_root.mkdir()
        (other_root / "src").mkdir(parents=True)
        write_text(other_root / "src" / "file.c", "int other(void) { return 0; }\n")
        bootstrap = init_bootstrap(
            out_path=self.tmp_path / "cross-bootstrap.json",
            state_dir=self.tmp_path / "cross-state",
            inbox_dir=self.tmp_path / "cross-inbox",
            output_root=self.tmp_path / "cross-output",
            roots={"root-a": cross_root, "root-b": other_root},
            profile_ref="unittest",
        )
        from code_learning.state import State

        state = State(bootstrap, self.tmp_path / "cross-bootstrap.json")
        link = cross_root / "repo-from-b"
        if not make_dir_link(link, other_root):
            self.skipTest("directory links are not available on this platform")
        manifest = base_manifest()
        manifest["repositories"] = [
            {"repo_id": "umd", "root_ref": "root-a", "relative_path": "repo-from-b", "role": "library"}
        ]
        manifest["allowed_read_roots"] = ["root-a", "root-b"]
        write_json(state.inbox_dir / "workspace.json", manifest)
        with self.assertRaises(CodeLearningError) as caught:
            import_workspace(state, "workspace.json", 0, f"op-{uuid.uuid4().hex}")
        self.assertEqual(caught.exception.code, "SCOPE_DENIED")

    def test_import_missing_manifest_rejected(self) -> None:
        expect_code(self, "NOT_FOUND", import_workspace, self.state, "unknown.json", 0, "op-x")

    # -- source only vs semantic --------------------------------------
    def test_source_only_without_build_inputs_is_allowed(self) -> None:
        manifest = base_manifest()
        validation = validate_workspace(self.state, manifest_ref=self.write_manifest(manifest))
        self.assertTrue(validation["valid"])
        self.assertEqual(validation["workspace_revision"], 0)
        self.assertEqual(validation["freshness"], "fresh")
        self.assertEqual(validation["semantic_status_by_variant"], {"source-only-x86_64": "blocked"})
        self.assertIn("compiler_build_context", validation["missing_inputs"])
        self.assertTrue(
            any(diagnostic["code"] == "semantic_status_blocked" for diagnostic in validation["diagnostics"])
        )

        result = self.import_ok(manifest)
        self.assertEqual(result["variants"][0]["semantic_status"], "blocked")

    def test_semantic_variant_requires_all_build_inputs(self) -> None:
        manifest = base_manifest()
        manifest["variants"][0]["analysis_mode"] = "semantic"
        result = self.import_ok(manifest)
        variant = result["variants"][0]
        self.assertEqual(variant["semantic_status"], "blocked")
        self.assertEqual(
            set(variant["missing_inputs"]),
            {"compdb_refs", "toolchain_ref", "config_refs", "generated_header_sets"},
        )

    def test_semantic_variant_ready_with_fixture_build_context(self) -> None:
        manifest = base_manifest(analysis_mode="semantic", with_build=True)
        validation = validate_workspace(self.state, manifest_ref=self.write_manifest(manifest))
        self.assertTrue(validation["valid"])
        self.assertEqual(validation["semantic_status_by_variant"], {"defconfig-x86_64": "ready"})
        self.assertEqual(validation["missing_inputs"], [])
        self.assertEqual(validation["diagnostics"], [])

        result = self.import_ok(manifest)
        variant = result["variants"][0]
        self.assertEqual(variant["variant_id"], "defconfig-x86_64")
        self.assertEqual(variant["semantic_status"], "ready")
        self.assertIsNotNone(variant["build_identity"]["compdb_digests"]["umd:compile_commands.json"])
        self.assertIsNotNone(variant["build_identity"]["config_digests"]["kmd:.config"])
        self.assertEqual(len(variant["build_identity"]["toolchain_digest"]), 64)

        status = workspace_status(self.state, "synthetic-linux-ioctl")
        self.assertEqual(status["freshness"], "fresh")
        self.assertEqual(status["capabilities"]["compiler_evidence"], "ready")

    def test_semantic_variant_blocked_for_untrusted_compdb(self) -> None:
        bad_compdb = self.umd / "bad_compile_commands.json"
        cases = [
            (
                {
                    "directory": str(self.umd),
                    "file": str(self.umd / "src" / "job_submit.c"),
                    "command": "/usr/bin/clang -c src/job_submit.c; rm -rf measured",
                },
                "shell",
            ),
            (
                {
                    "directory": str(self.umd),
                    "file": str(self.umd / "src" / "job_submit.c"),
                    "arguments": ["clang", "-c", "src/job_submit.c"],
                },
                "absolute",
            ),
            (
                {
                    "directory": str(self.umd),
                    "file": str(self.umd / "src" / "job_submit.c"),
                    "arguments": [
                        "/usr/bin/clang",
                        "-Xclang",
                        "-load",
                        "/tmp/evil.so",
                        "-c",
                        "src/job_submit.c",
                    ],
                },
                "plugin",
            ),
            (
                {
                    "directory": str(self.umd),
                    "file": str(self.umd / "src" / "job_submit.c"),
                    "arguments": ["/usr/bin/clang", "-I/etc", "-c", "src/job_submit.c"],
                },
                "root",
            ),
            (
                {
                    "directory": str(self.umd),
                    "file": "/etc/passwd",
                    "arguments": ["/usr/bin/clang", "-c", "/etc/passwd"],
                },
                "root",
            ),
        ]
        for index, (entry, expected_word) in enumerate(cases):
            write_json(bad_compdb, [entry])
            manifest = base_manifest(analysis_mode="semantic", with_build=True)
            manifest["variants"][0]["compdb_refs"] = ["umd:bad_compile_commands.json"]
            result = self.import_ok(manifest, expected_revision=index)
            variant = result["variants"][0]
            self.assertEqual(variant["semantic_status"], "blocked", entry)
            validation = validate_workspace(self.state, manifest_ref="workspace.json")
            messages = " ".join(
                diagnostic["message"].lower() for diagnostic in validation["diagnostics"]
            )
            self.assertIn(expected_word, messages, entry)

    def test_build_identity_digests_change_with_config_compdb_and_source(self) -> None:
        manifest = base_manifest(analysis_mode="semantic", with_build=True)
        self.import_ok(manifest)
        workspace = load_workspace(self.state, "synthetic-linux-ioctl")
        first = build_identity(workspace, "defconfig-x86_64")
        self.assertEqual(first["variant_id"], "defconfig-x86_64")
        self.assertEqual(first["workspace_revision"], 1)
        self.assertIsNone(first["atlas_lock_digest"])
        self.assertIsNone(first["sysroot_manifest_digest"])
        self.assertEqual(len(first["binding_digest"]), 64)
        self.assertEqual(
            first["config_digests"].keys(), {"kmd:.config"}
        )

        config_path = self.kmd / ".config"
        write_text(config_path, KMD_CONFIG + "CONFIG_EXTRA=y\n")
        second_result = self.import_ok(base_manifest(analysis_mode="semantic", with_build=True), expected_revision=1)
        self.assertEqual(second_result["workspace_revision"], 2)
        workspace = load_workspace(self.state, "synthetic-linux-ioctl")
        second = build_identity(workspace, "defconfig-x86_64")
        self.assertNotEqual(first["config_digests"]["kmd:.config"], second["config_digests"]["kmd:.config"])
        self.assertNotEqual(first["source_manifest_digest"], second["source_manifest_digest"])

        compdb_path = self.umd / "compile_commands.json"
        entry = json.loads(compdb_path.read_text(encoding="utf-8"))[0]
        entry["arguments"] = entry["arguments"] + ["-DEXTRA=1"]
        write_json(compdb_path, [entry])
        third_result = self.import_ok(base_manifest(analysis_mode="semantic", with_build=True), expected_revision=2)
        self.assertEqual(third_result["workspace_revision"], 3)
        workspace = load_workspace(self.state, "synthetic-linux-ioctl")
        third = build_identity(workspace, "defconfig-x86_64")
        self.assertNotEqual(
            second["compdb_digests"]["umd:compile_commands.json"],
            third["compdb_digests"]["umd:compile_commands.json"],
        )

        write_text(self.umd / "src" / "job_submit.c", "int changed(void) { return 1; }\n")
        fourth_result = self.import_ok(base_manifest(analysis_mode="semantic", with_build=True), expected_revision=3)
        workspace = load_workspace(self.state, "synthetic-linux-ioctl")
        fourth = build_identity(workspace, "defconfig-x86_64")
        self.assertNotEqual(third["source_manifest_digest"], fourth["source_manifest_digest"])
        self.assertEqual(
            fourth_result["semantic_status_by_variant"], {"defconfig-x86_64": "ready"}
        )

    def test_source_manifest_digest_is_conservative(self) -> None:
        tree = self.tmp_path / "digest-tree"
        write_text(tree / "a.c", "int a;\n")
        write_text(tree / "sub" / "b.c", "int b;\n")
        first = source_manifest_digest(tree)
        self.assertEqual(len(first), 64)
        self.assertEqual(first, source_manifest_digest(tree))

        write_text(tree / "sub" / "new.c", "int c;\n")
        second = source_manifest_digest(tree)
        self.assertNotEqual(first, second)

        os.utime(tree / "a.c", ns=(1234567890123456789, 1234567890123456789))
        third = source_manifest_digest(tree)
        self.assertNotEqual(second, third)

        write_text(tree / "sub" / "new.c", "int c;\n")
        os.utime(tree / "sub" / "new.c", ns=(2234567890123456789, 2234567890123456789))
        fourth = source_manifest_digest(tree)
        self.assertNotEqual(third, fourth)

        expect_code(self, "LIMIT_EXCEEDED", source_manifest_digest, tree, limit=2)
        expect_code(self, "INVALID_ARGUMENT", source_manifest_digest, self.tmp_path / "missing-dir")

    # -- status / validate freshness -----------------------------------
    def test_workspace_status_freshness_after_source_and_config_changes(self) -> None:
        self.import_ok()
        status = workspace_status(self.state, "synthetic-linux-ioctl")
        self.assertEqual(status["schema_version"], 1)
        self.assertEqual(status["workspace_revision"], 1)
        self.assertEqual(status["freshness"], "fresh")
        self.assertEqual(status["active_runs"], [])
        self.assertEqual(status["missing_inputs"], ["compiler_build_context"])
        self.assertEqual(status["capabilities"]["source_text"], "ready")
        self.assertEqual(status["capabilities"]["compiler_evidence"], "blocked")
        self.assertIsInstance(status["variants"], list)
        self.assertIn("build_identity", status["variants"][0])

        write_text(self.umd / "src" / "job_submit.c", "#include <stdio.h>\nint changed;\n")
        status = workspace_status(self.state, "synthetic-linux-ioctl")
        self.assertEqual(status["freshness"], "stale")
        self.assertIn("source_manifest_changed", [item["code"] for item in status["diagnostics"]])

        self.import_ok(base_manifest(), expected_revision=1)
        self.assertEqual(workspace_status(self.state, "synthetic-linux-ioctl")["freshness"], "fresh")
        write_text(self.umd / "src" / "added_file.c", "int added;\n")
        self.assertEqual(workspace_status(self.state, "synthetic-linux-ioctl")["freshness"], "stale")

    def test_validate_workspace_detects_manifest_drift(self) -> None:
        self.import_ok()
        validation = validate_workspace(self.state, workspace_ref="synthetic-linux-ioctl")
        self.assertTrue(validation["valid"])
        self.assertEqual(validation["freshness"], "fresh")
        self.assertEqual(validation["workspace_revision"], 1)
        self.assertEqual(validation["semantic_status_by_variant"], {"source-only-x86_64": "blocked"})

        manifest_path = self.env.inbox_dir / "workspace.json"
        manifest_path.write_text(manifest_path.read_text(encoding="utf-8") + "\n", encoding="utf-8")
        validation = validate_workspace(self.state, workspace_ref="synthetic-linux-ioctl")
        self.assertEqual(validation["freshness"], "stale")
        self.assertIn("manifest_changed", [item["code"] for item in validation["diagnostics"]])

        manifest_path.unlink()
        validation = validate_workspace(self.state, workspace_ref="synthetic-linux-ioctl")
        self.assertEqual(validation["freshness"], "unknown")
        self.assertIn("manifest_unavailable", [item["code"] for item in validation["diagnostics"]])

    def test_validate_workspace_argument_rules(self) -> None:
        expect_code(self, "INVALID_ARGUMENT", validate_workspace, self.state)
        self.write_manifest(base_manifest())
        expect_code(
            self,
            "INVALID_ARGUMENT",
            validate_workspace,
            self.state,
            "workspace.json",
            "synthetic-linux-ioctl",
        )
        expect_code(self, "NOT_FOUND", validate_workspace, self.state, workspace_ref="nope")

    def test_load_workspace_unknown_and_traversal(self) -> None:
        expect_code(self, "NOT_FOUND", load_workspace, self.state, "unknown-workspace")
        expect_code(self, "INVALID_ARGUMENT", load_workspace, self.state, "../escape")
        expect_code(self, "INVALID_ARGUMENT", load_workspace, self.state, "Bad/Id")

    # -- projection / identity / overview ------------------------------
    def test_public_projection_and_build_identity_from_synthetic_workspace(self) -> None:
        identity = {
            "workspace_revision": 3,
            "variant_id": "v1",
            "roots_digest": "1" * 64,
            "source_manifest_digest": "2" * 64,
            "compdb_digests": {},
            "config_digests": {},
            "generated_header_digests": {},
            "toolchain_digest": None,
            "atlas_lock_digest": None,
            "sysroot_manifest_digest": None,
            "binding_digest": "3" * 64,
        }
        workspace = {
            "workspace_id": "synthetic-ws",
            "revision": 3,
            "scope_ref": "local",
            "scope_generation": 1,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
            "manifest_name": "m.json",
            "manifest_sha256": "a" * 64,
            "source_manifest_digest": "2" * 64,
            "roots_digest": "1" * 64,
            "repositories": [
                {
                    "repo_id": "umd",
                    "root_ref": "synthetic-root",
                    "relative_path": "umd",
                    "absolute_path": str(self.umd),
                    "role": "umd",
                    "vcs": {"kind": "none", "commit": None},
                }
            ],
            "variants": [
                {
                    "variant_id": "v1",
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
                    "build_identity": identity,
                }
            ],
            "bindings": [
                {
                    "binding_id": "b1",
                    "revision": 2,
                    "kind": "uapi_ioctl",
                    "from": {"repo_id": "umd"},
                    "to": {"repo_id": "kmd"},
                    "status": "incomplete",
                    "bridge_candidate": True,
                }
            ],
            "toolchains": [],
        }
        projection = public_projection(workspace)
        self.assertEqual(projection["workspace_revision"], 3)
        self.assertEqual(projection["manifest_digest"], "a" * 64)
        self.assertEqual(projection["semantic_status_by_variant"], {"v1": "blocked"})
        self.assertEqual(projection["missing_inputs"], ["compiler_build_context"])
        self.assertEqual(
            projection["bindings"],
            [
                {
                    "binding_id": "b1",
                    "revision": 2,
                    "kind": "uapi_ioctl",
                    "from_repo_id": "umd",
                    "to_repo_id": "kmd",
                    "status": "incomplete",
                }
            ],
        )
        self.assertNotIn("absolute_path", json.dumps(projection))
        # The stored identity is authoritative for the projection.
        self.assertEqual(projection["variants"][0]["build_identity"], identity)

        computed = build_identity(workspace, "v1")
        self.assertEqual(
            set(computed),
            {
                "workspace_revision",
                "variant_id",
                "roots_digest",
                "source_manifest_digest",
                "compdb_digests",
                "config_digests",
                "generated_header_digests",
                "toolchain_digest",
                "atlas_lock_digest",
                "sysroot_manifest_digest",
                "binding_digest",
            },
        )
        self.assertEqual(computed["workspace_revision"], 3)
        self.assertEqual(computed["variant_id"], "v1")
        self.assertEqual(computed["roots_digest"], "1" * 64)
        self.assertEqual(computed["source_manifest_digest"], "2" * 64)
        self.assertIsNone(computed["toolchain_digest"])
        self.assertIsNone(computed["atlas_lock_digest"])
        self.assertIsNone(computed["sysroot_manifest_digest"])
        self.assertEqual(len(computed["binding_digest"]), 64)
        expect_code(self, "NOT_FOUND", build_identity, workspace, "missing-variant")

        changed = json.loads(json.dumps(workspace))
        changed["bindings"][0]["status"] = "supported"
        changed_identity = build_identity(changed, "v1")
        self.assertNotEqual(computed["binding_digest"], changed_identity["binding_digest"])

    def test_overview_source_only_is_bounded_and_declares_unknowns(self) -> None:
        self.import_ok()
        result = overview(self.state, "synthetic-linux-ioctl", "source-only-x86_64", max_components=20)
        self.assertEqual(result["schema_version"], 1)
        self.assertEqual(result["workspace_revision"], 1)
        self.assertEqual(result["semantic_status"], "blocked")
        self.assertEqual(result["missing_inputs"], ["compiler_build_context"])
        self.assertEqual(len(result["components"]), 3)
        self.assertFalse(result["truncated"])
        component = result["components"][0]
        self.assertIn("repo_id", component)
        self.assertEqual(component["origin"], "declared")
        self.assertEqual(result["interface_candidates"], [])
        self.assertTrue(result["unknown_boundaries"])
        self.assertTrue(any("compiler_build_context" in item["reason"] for item in result["unknown_boundaries"]))

        limited = overview(self.state, "synthetic-linux-ioctl", "source-only-x86_64", max_components=1)
        self.assertEqual(len(limited["components"]), 1)
        self.assertTrue(limited["truncated"])

        expect_code(self, "NOT_FOUND", overview, self.state, "synthetic-linux-ioctl", "nope")
        expect_code(self, "INVALID_ARGUMENT", overview, self.state, "synthetic-linux-ioctl", "source-only-x86_64", None, 0)
        expect_code(self, "INVALID_ARGUMENT", overview, self.state, "synthetic-linux-ioctl", "source-only-x86_64", None, 500)
        expect_code(self, "NOT_FOUND", overview, self.state, "unknown-ws", "source-only-x86_64")


if __name__ == "__main__":
    unittest.main()
