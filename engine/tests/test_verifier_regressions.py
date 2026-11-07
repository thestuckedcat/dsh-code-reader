"""Regression tests for the independent verifier findings (2026-11-07).

Findings addressed here:

* BLOCKING B1 — ``resume`` followed a Windows junction inside a repository and
  could walk an outside tree (unbounded/wrong source-manifest digest).
* BLOCKING B2 — ``record-save`` accepted execution/observation claims with
  fabricated strings, and stored unsigned evidence refs as ``fresh``.
* N1 — a snapshot's ``workspace_roots`` were not tied to the registered
  workspace (wrong-repo attribution of ``exact`` edges).
* N2 — the Host bridge accepted any Python 3.x instead of 3.11+ (covered in
  ``tests/node/bridge.test.mjs``).
* N3 — bounded issue/unresolved projections truncated silently.
* N4 — ``State.require_in_root`` accepted a final symlink/junction.
* N5 — ``source-find`` read only an 8 MiB prefix of a large file but reported
  ``truncated=false``.

These tests intentionally use the public module functions (not the CLI) to keep
the failure modes obvious; the CLI journey is covered by ``test_cli_journey``.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

from code_learning import atlas, invalidation, learning, records, snapshot, source, state as state_module, workspace
from code_learning.errors import CodeLearningError
from tests import helpers

WORKSPACE_ID = "synthetic-linux-ioctl"
VARIANT_ID = "source-only-x86_64"


def _uuid() -> str:
    return str(uuid.uuid4())


class _RegressionBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="cl-verifier-")
        self.addCleanup(self._tmp.cleanup)
        self.env = helpers.make_bootstrap(Path(self._tmp.name))
        manifest_name = helpers.write_manifest(self.env, helpers.base_manifest())
        workspace.import_workspace(self.env.state, manifest_name, 0, _uuid())
        self.ws = workspace.load_workspace(self.env.state, WORKSPACE_ID)

    def new_draft(self, **overrides):
        draft = learning.default_record(
            self.ws, {"question": "Why does job_submit reach the driver queue?", "level": "K2", "nature": ["F"]}
        )
        draft.update(overrides)
        return draft

    def save(self, **overrides):
        return records.save_record(self.env.state, WORKSPACE_ID, self.new_draft(**overrides), 0, _uuid())

    def read_evidence(self) -> str:
        found = source.find_source(
            self.env.state, WORKSPACE_ID, "umd", "src/*.c", literal="JOB_IOCTL_SUBMIT"
        )
        match = found["matches"][0]
        read = source.read_source(
            self.env.state,
            WORKSPACE_ID,
            match["path_ref"],
            match["source_sha256"],
            match["byte_start"],
            match["byte_end"],
        )
        return read["evidence"]["evidence_ref"]


def _make_junction(link: Path, target: Path) -> None:
    """Create a Windows directory junction (raises ``AssertionError`` on failure)."""
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise AssertionError(f"mklink /J failed: {result.stdout} {result.stderr}")


def _remove_junction(link: Path) -> None:
    if link.exists() or link.is_symlink():
        try:
            os.rmdir(link)
        except OSError:
            pass


class SourceManifestJunctionTest(_RegressionBase):
    """B1: resume must never walk through a junction out of a repo."""

    @unittest.skipUnless(os.name == "nt", "Windows junction regression")
    def test_resume_ignores_junction_inside_repository(self) -> None:
        saved = self.save()  # no evidence refs: freshness comes from digests/identity
        outside = Path(self._tmp.name) / "outside-tree"
        outside.mkdir()
        (outside / "leaked-secret.c").write_text("int leaked;\n", encoding="utf-8")
        junction = self.env.umd / "escape"
        _make_junction(junction, outside)
        try:
            resumed = invalidation.resume_record(self.env.state, WORKSPACE_ID, saved["record_id"])
        finally:
            _remove_junction(junction)
        # The junction is not part of the registered repo: the conservative
        # digest must be identical to the saved one, so the record stays fresh.
        self.assertEqual("fresh", resumed["freshness"], resumed.get("changed_inputs"))
        self.assertEqual([], resumed["changed_inputs"])


class RecordClaimTest(_RegressionBase):
    """B2: unverifiable execution/observation claims must not be published."""

    def test_executed_experiment_is_rejected_without_execution_backend(self) -> None:
        draft = self.new_draft(
            experiment={"status": "executed", "run_ref": "made-up-run"},
            observation={"status": "observed", "evidence_refs": [self.read_evidence()]},
        )
        with self.assertRaises(CodeLearningError) as caught:
            records.save_record(self.env.state, WORKSPACE_ID, draft, 0, _uuid())
        self.assertEqual("CAPABILITY_UNAVAILABLE", caught.exception.code)

    def test_planned_experiment_requires_signed_plan_reference(self) -> None:
        draft = self.new_draft(experiment={"status": "planned", "plan_ref": "not-a-plan"})
        with self.assertRaises(CodeLearningError) as caught:
            records.save_record(self.env.state, WORKSPACE_ID, draft, 0, _uuid())
        self.assertEqual("SCOPE_DENIED", caught.exception.code)

    def test_unsigned_evidence_is_not_stored_as_fresh(self) -> None:
        saved = self.save(evidence_refs=["made-up-evidence"])
        stored = records.get_record(self.env.state, WORKSPACE_ID, saved["record_id"])
        self.assertEqual("unknown", stored["freshness"])
        self.assertTrue(stored["invalidation_reasons"])

    def test_valid_signed_evidence_stays_fresh(self) -> None:
        saved = self.save(evidence_refs=[self.read_evidence()])
        stored = records.get_record(self.env.state, WORKSPACE_ID, saved["record_id"])
        self.assertEqual("fresh", stored["freshness"])

    def test_agent_explanation_cannot_be_a_user_claim(self) -> None:
        draft = self.new_draft(
            mental_model={"status": "user_provided", "text": "I already understand this.", "author": "agent"}
        )
        with self.assertRaises(CodeLearningError) as caught:
            records.save_record(self.env.state, WORKSPACE_ID, draft, 0, _uuid())
        self.assertIn(caught.exception.code, {"INVALID_ARGUMENT", "SCOPE_DENIED"})


class SnapshotProvenanceTest(_RegressionBase):
    """N1: a self-consistent snapshot for another workspace must be refused."""

    def test_snapshot_workspace_roots_must_match_registered_workspace(self) -> None:
        helpers.write_snapshot_dir(
            self.env.inbox_dir / "snapshot-foreign",
            helpers.simple_graph_payload(),
            {"workspace_roots": ["/definitely/not/this/workspace"]},
        )
        with self.assertRaises(CodeLearningError) as caught:
            snapshot.import_snapshot(
                self.env.state, WORKSPACE_ID, VARIANT_ID, "umd", "snapshot-foreign", _uuid()
            )
        self.assertEqual("INVALID_ARGUMENT", caught.exception.code)

    def test_matching_workspace_root_still_imports(self) -> None:
        fixtures = helpers.make_snapshot_fixture(self.env)
        evidence = snapshot.import_snapshot(
            self.env.state, WORKSPACE_ID, VARIANT_ID, "umd", "snapshot-umd", _uuid()
        )
        self.assertEqual("fresh", evidence["freshness"])
        self.assertEqual("0.1", evidence["atlas_schema"])
        self.assertTrue(fixtures["umd"]["graph_hash"] == evidence["graph_sha256"])


class BoundedProjectionTest(_RegressionBase):
    """N3/N5: truncation must be reported, never silent."""

    def test_issue_projection_reports_truncation_and_cut_text(self) -> None:
        payload = {
            "issues": [
                {"id": f"issue-{index}", "kind": "semantic_unresolved", "detail": "x" * 5000}
                for index in range(150)
            ]
        }
        summaries = atlas.issue_summaries(payload)
        self.assertEqual(atlas.MAX_ISSUE_PROJECTIONS + 1, len(summaries))
        self.assertEqual("issue_projection_truncated", summaries[-1]["reason"])
        self.assertIn("issue_detail_truncated", summaries[0]["limitations"])
        self.assertLessEqual(len(summaries[0]["detail"]), 4096)

    def test_find_reports_prefix_only_scan_as_truncated(self) -> None:
        big = self.env.umd / "big.c"
        big.write_bytes(b"needle\n" + b"x" * (9 * 1024 * 1024))
        try:
            result = source.find_source(
                self.env.state, WORKSPACE_ID, "umd", "big.c", literal="needle"
            )
        finally:
            big.unlink()
        self.assertIn("large_file_prefix_only", result["limitations"])
        self.assertTrue(result["truncated"])


class RequireInRootTest(_RegressionBase):
    """N4: the contract says the final path itself must not be a link."""

    def test_plain_path_inside_root_is_accepted(self) -> None:
        resolved = self.env.state.require_in_root(self.env.root)
        self.assertTrue(str(resolved).endswith(os.path.basename(str(self.env.root))) or resolved.exists())

    @unittest.skipUnless(os.name == "nt", "Windows junction regression")
    def test_final_junction_is_rejected(self) -> None:
        target = self.env.root / "inside-target"
        target.mkdir()
        junction = self.env.root / "link-target"
        _make_junction(junction, target)
        try:
            with self.assertRaises(CodeLearningError) as caught:
                self.env.state.require_in_root(junction)
        finally:
            _remove_junction(junction)
        self.assertEqual("SCOPE_DENIED", caught.exception.code)


if __name__ == "__main__":
    unittest.main()
