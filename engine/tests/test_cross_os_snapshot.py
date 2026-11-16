"""Cross-OS Atlas snapshot root mapping (bootstrap ``path_aliases``).

Snapshots built on Linux record the analyzed root as a POSIX absolute path;
the plugin may run on Windows where the same repository is mounted under a
different local candidate root.  These tests pin the explicit, auditable
mapping: a candidate root may declare trusted foreign path aliases, aliases
only participate in snapshot identity matching, and an alias on the wrong
root_ref must not satisfy the target-repository check.
"""

from __future__ import annotations

import unittest
from pathlib import Path

from code_learning.errors import CodeLearningError
from code_learning.snapshot import _check_manifest_provenance
from code_learning.state import validate_bootstrap


class _FakeState:
    def __init__(self, aliases):
        self._aliases = aliases

    def candidate_root_aliases(self):
        return self._aliases


WORKSPACE = {
    "workspace_id": "code-view-bus-demo",
    "repositories": [
        {
            "repo_id": "bus",
            "root_ref": "slice-root",
            "relative_path": "repo",
            "absolute_path": "E:\\dsh\\plugin\\04-code-learning\\evidence\\code-view-slice\\repo",
        },
        {"repo_id": "platform", "root_ref": "platform-root", "relative_path": "platform"},
    ],
}
MANIFEST = {"workspace_roots": ["/root/atlas-demo/repo"]}


class CrossOsSnapshotRootTest(unittest.TestCase):
    def test_foreign_root_without_alias_is_rejected(self) -> None:
        with self.assertRaises(CodeLearningError) as caught:
            _check_manifest_provenance(_FakeState({}), WORKSPACE, MANIFEST, "bus")
        self.assertEqual("INVALID_ARGUMENT", caught.exception.code)

    def test_alias_on_target_root_accepts_foreign_root(self) -> None:
        _check_manifest_provenance(
            _FakeState({"slice-root": ["/root/atlas-demo/repo"]}), WORKSPACE, MANIFEST, "bus"
        )

    def test_alias_on_other_root_does_not_satisfy_target(self) -> None:
        with self.assertRaises(CodeLearningError) as caught:
            _check_manifest_provenance(
                _FakeState({"platform-root": ["/root/atlas-demo/repo"]}),
                WORKSPACE,
                MANIFEST,
                "bus",
            )
        self.assertEqual("INVALID_ARGUMENT", caught.exception.code)
        self.assertIn("target repository", caught.exception.message)

    def test_local_absolute_root_still_matches_without_alias(self) -> None:
        manifest = {"workspace_roots": [str(Path(WORKSPACE["repositories"][0]["absolute_path"]))]}
        _check_manifest_provenance(_FakeState({}), WORKSPACE, manifest, "bus")


def _bootstrap(aliases) -> dict:
    base = Path.cwd() / "cross-os-fixture"
    root = {"root_ref": "slice-root", "absolute_path": str(base / "slice"), "read_grant_ref": "grant-slice"}
    if aliases is not None:
        root["path_aliases"] = aliases
    return {
        "schema_version": 1,
        "profile_ref": "unittest",
        "scope_ref": "local",
        "scope_generation": 1,
        "state_dir": str(base / "state"),
        "import_inbox_dir": str(base / "inbox"),
        "output_root": str(base / "state"),
        "candidate_roots": [root],
    }


class BootstrapPathAliasTest(unittest.TestCase):
    def test_posix_aliases_are_accepted_and_preserved(self) -> None:
        normalized = validate_bootstrap(_bootstrap(["/root/atlas-demo/repo", "D:\\builds\\repo\\"]))
        aliases = normalized["candidate_roots"][0]["path_aliases"]
        self.assertEqual(["/root/atlas-demo/repo", "D:\\builds\\repo\\"], aliases)

    def test_default_has_no_aliases(self) -> None:
        normalized = validate_bootstrap(_bootstrap(None))
        self.assertEqual([], normalized["candidate_roots"][0]["path_aliases"])

    def test_relative_alias_is_rejected(self) -> None:
        with self.assertRaises(CodeLearningError) as caught:
            validate_bootstrap(_bootstrap(["relative/path"]))
        self.assertEqual("INVALID_ARGUMENT", caught.exception.code)

    def test_duplicate_or_oversized_aliases_are_rejected(self) -> None:
        with self.assertRaises(CodeLearningError):
            validate_bootstrap(_bootstrap(["/root/repo", "/root/repo/"]))
        with self.assertRaises(CodeLearningError):
            validate_bootstrap(_bootstrap([f"/root/{index}" for index in range(17)]))
        with self.assertRaises(CodeLearningError):
            validate_bootstrap(_bootstrap(["/root/with\x00nul"]))


if __name__ == "__main__":
    unittest.main()
