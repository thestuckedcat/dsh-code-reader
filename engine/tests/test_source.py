"""CL-001-A: bounded source-only find/read/evidence entry tests.

Negative cases covered here:
* path_ref/evidence_ref MAC tampering, cross-workspace and cross-root refs,
  forged-but-signed traversal paths, repository escape through symlink/junction
  directories;
* file hash mismatch, byte-range bounds, UTF-8 boundary adjustment, binary and
  suspected-secret content returning ``ref_only`` instead of text;
* find hit/file budgets producing a signed cursor that is scrolled to
  completion and invalidated (STALE_SOURCE) once a matching file changes;
* source changes invalidating a previously issued evidence_ref.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

from code_learning import scope
from code_learning.errors import CodeLearningError
from code_learning.source import find_source, read_evidence, read_source
from code_learning.workspace import import_workspace
from tests.helpers import base_manifest, make_bootstrap, sha256_file, write_bytes, write_json, write_text


def make_dir_link(link: Path, target: Path) -> bool:
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


class SourceTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="cl-src-")
        self.tmp_path = Path(self._tmp.name)
        self.env = make_bootstrap(self.tmp_path)
        self.state = self.env.state
        self.umd = self.env.umd
        self.uapi = self.env.uapi
        self.wid = "synthetic-linux-ioctl"
        write_json(self.env.inbox_dir / "workspace.json", base_manifest())
        self.projection = import_workspace(self.state, "workspace.json", 0, f"op-{uuid.uuid4().hex}")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    # -- helpers -------------------------------------------------------
    def find(self, repo_id: str, relative_glob: str, *, cursor=None, workspace=None, **selector):
        return find_source(
            self.state,
            workspace or self.wid,
            repo_id,
            relative_glob,
            cursor=cursor,
            **selector,
        )

    def sign_path(self, relative_path: str, repo_id: str = "umd", sha: str | None = None) -> tuple[str, str]:
        path = (self.umd if repo_id == "umd" else self.uapi) / relative_path
        content_sha = sha or sha256_file(path)
        token = scope.sign_path_ref(
            self.state,
            workspace_id=self.wid,
            repo_id=repo_id,
            relative_path=relative_path,
            source_sha256=content_sha,
        )
        return token, content_sha

    def read(self, token: str, sha: str, start: int, end: int):
        return read_source(self.state, self.wid, token, sha, start, end)

    # -- find: selectors and globs -------------------------------------
    def test_find_literal_returns_bounded_match_with_context(self) -> None:
        result = self.find("umd", "**/*.c", literal="memcpy")
        self.assertEqual(result["schema_version"], 1)
        self.assertEqual(result["semantic_status"], "blocked")
        self.assertIn("text_only_not_compiler_fact", result["limitations"])
        self.assertFalse(result["truncated"])
        self.assertIsNone(result["next_cursor"])
        self.assertGreaterEqual(result["scanned_files"], 1)
        self.assertGreater(result["scanned_bytes"], 0)
        self.assertEqual(len(result["matches"]), 1)
        match = result["matches"][0]
        self.assertEqual(
            set(match),
            {
                "path_ref",
                "evidence_ref",
                "source_sha256",
                "byte_start",
                "byte_end",
                "line_start",
                "line_end",
                "safe_preview",
            },
        )
        source_path = self.umd / "src" / "job_submit.c"
        raw = source_path.read_bytes()
        offset = raw.index(b"memcpy")
        self.assertEqual(match["source_sha256"], sha256_file(source_path))
        self.assertEqual(match["byte_start"], offset)
        self.assertEqual(match["byte_end"], offset + len(b"memcpy"))
        self.assertEqual(match["line_start"], raw[:offset].count(b"\n") + 1)
        self.assertEqual(match["line_start"], match["line_end"])
        self.assertIn("memcpy(&local", match["safe_preview"])

        payload = scope.verify_path_ref(self.state, match["path_ref"], workspace_id=self.wid)
        self.assertEqual(payload["p"], "src/job_submit.c")
        self.assertEqual(payload["r"], "umd")
        self.assertEqual(payload["s"], match["source_sha256"])
        evidence_payload = scope.verify_evidence_ref(
            self.state, match["evidence_ref"], workspace_id=self.wid
        )
        self.assertEqual(evidence_payload["b"], match["byte_start"])
        self.assertEqual(evidence_payload["e"], match["byte_end"])
        self.assertEqual(evidence_payload["v"], "source-only-x86_64")

        read = self.read(match["path_ref"], match["source_sha256"], match["byte_start"], match["byte_end"])
        self.assertEqual(read["safe_text"], "memcpy")
        self.assertEqual(read["actual_byte_start"], match["byte_start"])
        self.assertEqual(read["actual_byte_end"], match["byte_end"])
        self.assertEqual(read["evidence"]["evidence_ref"], match["evidence_ref"])

    def test_find_filename_selector(self) -> None:
        result = self.find("umd", "**/*.c", filename="job_submit.c")
        self.assertEqual(len(result["matches"]), 1)
        match = result["matches"][0]
        payload = scope.verify_path_ref(self.state, match["path_ref"], workspace_id=self.wid)
        self.assertEqual(payload["p"], "src/job_submit.c")
        self.assertIsNotNone(match["safe_preview"])
        self.assertIn("stdio", match["safe_preview"])
        self.assertLess(match["byte_start"], match["byte_end"])

        none = self.find("umd", "include/*.h", filename="job_submit.c")
        self.assertEqual(none["matches"], [])

    def test_find_selector_and_glob_validation(self) -> None:
        expect_code(self, "INVALID_ARGUMENT", self.find, "umd", "**/*.c")
        expect_code(self, "INVALID_ARGUMENT", self.find, "umd", "**/*.c", literal="a", filename="b")
        expect_code(self, "INVALID_ARGUMENT", self.find, "umd", "**/*.c", literal="")
        expect_code(self, "INVALID_ARGUMENT", self.find, "umd", "**/*.c", literal="x" * 257)
        expect_code(self, "INVALID_ARGUMENT", self.find, "umd", "**/*.c", literal="two\nlines")
        expect_code(self, "INVALID_ARGUMENT", self.find, "umd", "**/*.c", filename="a/b.c")
        expect_code(self, "INVALID_ARGUMENT", self.find, "umd", "src/[ab].c", literal="int")
        expect_code(self, "INVALID_ARGUMENT", self.find, "umd", "../**/*.c", literal="int")
        expect_code(self, "INVALID_ARGUMENT", self.find, "umd", "/abs/*.c", literal="int")
        expect_code(self, "INVALID_ARGUMENT", self.find, "umd", "src/**bad/*.c", literal="int")
        expect_code(self, "INVALID_ARGUMENT", self.find, "umd", "", literal="int")
        expect_code(self, "NOT_FOUND", self.find, "nope", "**/*.c", literal="int")
        expect_code(self, "NOT_FOUND", self.find, "umd", "**/*.c", literal="int", workspace="unknown-ws")

    def test_find_glob_semantics(self) -> None:
        source_glob = self.find("umd", "src/*.c", literal="int")
        names = {
            scope.verify_path_ref(self.state, match["path_ref"], workspace_id=self.wid)["p"]
            for match in source_glob["matches"]
        }
        self.assertEqual(names, {"src/job_submit.c", "src/main.c"})

        headers = self.find("umd", "**/*.h", literal="job_submit")
        self.assertEqual(len(headers["matches"]), 1)
        payload = scope.verify_path_ref(self.state, headers["matches"][0]["path_ref"], workspace_id=self.wid)
        self.assertEqual(payload["p"], "include/job_client.h")

        top_level = self.find("uapi", "*.h", literal="struct")
        self.assertEqual(top_level["matches"], [])

        recursive = self.find("uapi", "**/*.h", literal="JOB_IOCTL")
        # header guard (#ifndef/#define JOB_IOCTL_H) plus the two ioctl commands
        self.assertEqual(len(recursive["matches"]), 4)

    # -- find: budgets and cursors -------------------------------------
    def test_find_hit_budget_returns_cursor_and_scrolls(self) -> None:
        lines = "".join(f"NEEDLE line {index}\n" for index in range(250))
        write_text(self.umd / "src" / "needles.txt", lines)
        first = self.find("umd", "src/needles.txt", literal="NEEDLE")
        self.assertEqual(len(first["matches"]), 200)
        self.assertTrue(first["truncated"])
        self.assertIsInstance(first["next_cursor"], str)
        self.assertEqual([match["line_start"] for match in first["matches"]], list(range(1, 201)))

        second = self.find("umd", "src/needles.txt", literal="NEEDLE", cursor=first["next_cursor"])
        self.assertEqual(len(second["matches"]), 50)
        self.assertFalse(second["truncated"])
        self.assertIsNone(second["next_cursor"])
        self.assertEqual([match["line_start"] for match in second["matches"]], list(range(201, 251)))

    def test_find_file_budget_returns_cursor_and_scrolls(self) -> None:
        for index in range(130):
            write_text(self.umd / "gen" / f"f{index:03d}.txt", f"plain {index}\n")
        write_text(self.umd / "gen" / "f129.txt", "NEEDLE at the end\n")
        first = self.find("umd", "gen/*.txt", literal="NEEDLE")
        self.assertEqual(first["matches"], [])
        self.assertEqual(first["scanned_files"], 128)
        self.assertTrue(first["truncated"])
        self.assertIsInstance(first["next_cursor"], str)

        second = self.find("umd", "gen/*.txt", literal="NEEDLE", cursor=first["next_cursor"])
        self.assertEqual(len(second["matches"]), 1)
        self.assertEqual(second["scanned_files"], 2)
        self.assertFalse(second["truncated"])
        self.assertIsNone(second["next_cursor"])

    def test_find_cursor_invalidated_by_file_changes(self) -> None:
        for index in range(130):
            write_text(self.umd / "gen" / f"f{index:03d}.txt", f"plain {index}\n")
        write_text(self.umd / "gen" / "f129.txt", "NEEDLE at the end\n")
        first = self.find("umd", "gen/*.txt", literal="NEEDLE")
        write_text(self.umd / "gen" / "f000.txt", "plain 0 changed content\n")
        expect_code(
            self,
            "STALE_SOURCE",
            self.find,
            "umd",
            "gen/*.txt",
            literal="NEEDLE",
            cursor=first["next_cursor"],
        )

    def test_find_cursor_is_bound_to_query_workspace_and_integrity(self) -> None:
        lines = "".join(f"NEEDLE line {index}\n" for index in range(250))
        write_text(self.umd / "src" / "needles.txt", lines)
        first = self.find("umd", "src/needles.txt", literal="NEEDLE")
        cursor = first["next_cursor"]

        expect_code(
            self, "INVALID_ARGUMENT", self.find, "umd", "src/needles.txt", literal="OTHER", cursor=cursor
        )
        expect_code(self, "INVALID_ARGUMENT", self.find, "umd", "src/*.txt", literal="NEEDLE", cursor=cursor)

        tampered = cursor[:-2] + ("A" if cursor[-2] != "A" else "B") + cursor[-1]
        expect_code(self, "SCOPE_DENIED", self.find, "umd", "src/needles.txt", literal="NEEDLE", cursor=tampered)

        write_json(self.env.inbox_dir / "other.json", base_manifest(workspace_id="other-workspace"))
        import_workspace(self.state, "other.json", 0, f"op-{uuid.uuid4().hex}")
        expect_code(
            self,
            "SCOPE_DENIED",
            self.find,
            "umd",
            "src/needles.txt",
            literal="NEEDLE",
            cursor=cursor,
            workspace="other-workspace",
        )

    def test_find_skips_ignored_directories_and_links(self) -> None:
        write_text(self.umd / ".git" / "cached.txt", "ZZTOP ignored\n")
        write_text(self.umd / "node_modules" / "mod.txt", "ZZTOP ignored\n")
        write_text(self.umd / "__pycache__" / "cache.txt", "ZZTOP ignored\n")
        outside = self.tmp_path / "outside"
        write_text(outside / "leak.txt", "ZZTOP outside\n")
        if make_dir_link(self.umd / "linked-out", outside):
            result = self.find("umd", "**/*.txt", literal="ZZTOP")
            self.assertEqual(result["matches"], [])
            # The scanner must also not report files behind the junction when
            # enumerating a broader pattern.
            self.assertEqual(self.find("umd", "**/*", literal="ZZTOP")["matches"], [])

    # -- read: happy path ----------------------------------------------
    def test_read_source_success_returns_source_evidence(self) -> None:
        token, sha = self.sign_path("src/job_submit.c")
        result = self.read(token, sha, 0, 19)
        evidence = result["evidence"]
        self.assertEqual(
            set(evidence),
            {
                "evidence_ref",
                "repo_id",
                "variant_id",
                "snapshot_id",
                "source_ref",
                "source_sha256",
                "byte_start",
                "byte_end",
                "line_start",
                "line_end",
                "origin",
                "semantic_status",
                "limitations",
                "observed_at",
            },
        )
        self.assertEqual(evidence["repo_id"], "umd")
        self.assertEqual(evidence["variant_id"], "source-only-x86_64")
        self.assertIsNone(evidence["snapshot_id"])
        self.assertEqual(evidence["source_ref"], "umd:src/job_submit.c")
        self.assertEqual(evidence["source_sha256"], sha)
        self.assertEqual(evidence["origin"], "source_text")
        self.assertEqual(evidence["semantic_status"], "blocked")
        self.assertEqual(evidence["limitations"], ["text_only_not_compiler_fact"])
        self.assertEqual(evidence["byte_start"], result["actual_byte_start"])
        self.assertEqual(evidence["byte_end"], result["actual_byte_end"])
        self.assertEqual(evidence["line_start"], 1)
        self.assertEqual(result["schema_version"], 1)
        self.assertIn("include <stdio.h>", result["safe_text"])
        self.assertEqual(result["actual_byte_start"], 0)
        self.assertEqual(result["actual_byte_end"], 19)

        verified = scope.verify_evidence_ref(self.state, evidence["evidence_ref"], workspace_id=self.wid)
        self.assertEqual(verified["s"], sha)
        self.assertEqual(verified["b"], evidence["byte_start"])
        self.assertEqual(verified["e"], evidence["byte_end"])
        self.assertEqual(verified["t"], evidence["observed_at"])

    # -- read: hash and range errors -----------------------------------
    def test_read_source_hash_mismatch_and_stale(self) -> None:
        token, sha = self.sign_path("src/job_submit.c")
        expect_code(self, "INVALID_ARGUMENT", self.read, token, "0" * 64, 0, 4)
        expect_code(self, "INVALID_ARGUMENT", self.read, token, "not-a-hash", 0, 4)

        write_text(self.umd / "src" / "job_submit.c", "int changed(void) { return 0; }\n")
        expect_code(self, "STALE_SOURCE", self.read, token, sha, 0, 4)

    def test_read_source_byte_range_validation_and_utf8_adjustment(self) -> None:
        content = "aé中b\n"
        path = write_text(self.umd / "src" / "utf8.txt", content)
        raw = path.read_bytes()
        token, sha = self.sign_path("src/utf8.txt")
        self.assertEqual(raw, b"a\xc3\xa9\xe4\xb8\xadb\n")

        first = self.read(token, sha, 2, 3)
        self.assertEqual(first["safe_text"], "é")
        self.assertEqual((first["actual_byte_start"], first["actual_byte_end"]), (1, 3))

        second = self.read(token, sha, 3, 4)
        self.assertEqual(second["safe_text"], "中")
        self.assertEqual((second["actual_byte_start"], second["actual_byte_end"]), (3, 6))

        third = self.read(token, sha, 0, 2)
        self.assertEqual(third["safe_text"], "aé")
        self.assertEqual((third["actual_byte_start"], third["actual_byte_end"]), (0, 3))

        expect_code(self, "INVALID_ARGUMENT", self.read, token, sha, 3, 3)
        expect_code(self, "INVALID_ARGUMENT", self.read, token, sha, -1, 2)
        expect_code(self, "INVALID_ARGUMENT", self.read, token, sha, 0, len(raw) + 5)
        expect_code(self, "INVALID_ARGUMENT", self.read, token, sha, 4, 3)

        big = write_text(self.umd / "src" / "big.txt", "x" * 40000)
        big_token, big_sha = self.sign_path("src/big.txt")
        expect_code(self, "LIMIT_EXCEEDED", self.read, big_token, big_sha, 0, 17000)

    # -- read: binary / secret -----------------------------------------
    def test_binary_content_returns_ref_only(self) -> None:
        write_bytes(self.umd / "src" / "blob.bin", b"\x00\x01\x02binary\xffdata")
        found = self.find("umd", "**/blob.bin", filename="blob.bin")
        self.assertEqual(len(found["matches"]), 1)
        match = found["matches"][0]
        self.assertIsNone(match["safe_preview"])
        self.assertEqual(match["reason"], "binary_file")
        read = self.read(match["path_ref"], match["source_sha256"], match["byte_start"], match["byte_end"])
        self.assertNotIn("safe_text", read)
        self.assertEqual(read["ref_only"]["reason"], "binary")
        self.assertEqual(read["evidence"]["byte_start"], 0)

    def test_suspected_secret_returns_ref_only(self) -> None:
        write_text(
            self.umd / "src" / "secrets.env",
            "API_KEY=sk-live-1234567890abcdef\nOTHER=plain\n",
        )
        found = self.find("umd", "**/secrets.env", filename="secrets.env")
        self.assertEqual(len(found["matches"]), 1)
        match = found["matches"][0]
        self.assertIsNone(match["safe_preview"])
        self.assertEqual(match["reason"], "secret_suspected")
        read = self.read(match["path_ref"], match["source_sha256"], match["byte_start"], match["byte_end"])
        self.assertNotIn("safe_text", read)
        self.assertEqual(read["ref_only"]["reason"], "secret_suspected")

        literal = self.find("umd", "src/secrets.env", literal="sk-live")
        self.assertEqual(len(literal["matches"]), 1)
        self.assertIsNone(literal["matches"][0]["safe_preview"])
        self.assertEqual(literal["matches"][0]["reason"], "secret_suspected")

    # -- read: reference forgery / scope -------------------------------
    def test_path_ref_tampering_and_forgery_rejected(self) -> None:
        token, sha = self.sign_path("src/job_submit.c")
        tampered = token[:-2] + ("A" if token[-2] != "A" else "B") + token[-1]
        expect_code(self, "SCOPE_DENIED", self.read, tampered, sha, 0, 4)
        expect_code(self, "SCOPE_DENIED", self.read, token + "x", sha, 0, 4)
        expect_code(self, "SCOPE_DENIED", self.read, "garbage", sha, 0, 4)

        wrong_kind = self.state.sign(
            {"kind": "source", "w": self.wid, "r": "umd", "p": "src/job_submit.c", "s": sha, "g": 1}
        )
        expect_code(self, "SCOPE_DENIED", self.read, wrong_kind, sha, 0, 4)

        traversal = self.state.sign(
            {"kind": "path", "w": self.wid, "r": "umd", "p": "../uapi/include/job_ioctl.h", "s": sha, "g": 1}
        )
        expect_code(self, "INVALID_ARGUMENT", self.read, traversal, sha, 0, 4)

        absolute = self.state.sign(
            {"kind": "path", "w": self.wid, "r": "umd", "p": "/etc/passwd", "s": sha, "g": 1}
        )
        expect_code(self, "INVALID_ARGUMENT", self.read, absolute, sha, 0, 4)

    def test_cross_workspace_path_and_evidence_refs_rejected(self) -> None:
        token, sha = self.sign_path("src/job_submit.c")
        write_json(self.env.inbox_dir / "other.json", base_manifest(workspace_id="other-workspace"))
        import_workspace(self.state, "other.json", 0, f"op-{uuid.uuid4().hex}")
        expect_code(self, "SCOPE_DENIED", read_source, self.state, "other-workspace", token, sha, 4, 20)

        match = self.find("umd", "**/*.c", literal="memcpy")["matches"][0]
        expect_code(
            self,
            "SCOPE_DENIED",
            read_evidence,
            self.state,
            "other-workspace",
            match["evidence_ref"],
        )

    def test_cross_root_repository_escape_rejected(self) -> None:
        outside = self.tmp_path / "outside"
        write_text(outside / "leak.txt", "int leak = 1;\n")
        link = self.umd / "linked-out"
        if not make_dir_link(link, outside):
            self.skipTest("directory links are not available on this platform")
        token = scope.sign_path_ref(
            self.state,
            workspace_id=self.wid,
            repo_id="umd",
            relative_path="linked-out/leak.txt",
            source_sha256=sha256_file(outside / "leak.txt"),
        )
        expect_code(
            self, "SCOPE_DENIED", self.read, token, sha256_file(outside / "leak.txt"), 0, 4
        )

    # -- evidence read -------------------------------------------------
    def test_read_evidence_roundtrip_limits_and_staleness(self) -> None:
        match = self.find("umd", "**/*.c", literal="memcpy")["matches"][0]
        result = read_evidence(self.state, self.wid, match["evidence_ref"])
        self.assertEqual(result["evidence"]["source_sha256"], match["source_sha256"])
        self.assertEqual(result["safe_text"], "memcpy")
        self.assertEqual(result["actual_byte_start"], match["byte_start"])
        self.assertEqual(result["actual_byte_end"], match["byte_end"])

        expect_code(self, "LIMIT_EXCEEDED", read_evidence, self.state, self.wid, match["evidence_ref"], 1)
        expect_code(self, "INVALID_ARGUMENT", read_evidence, self.state, self.wid, match["evidence_ref"], 0)

        tampered = match["evidence_ref"][:-2] + ("A" if match["evidence_ref"][-2] != "A" else "B") + match["evidence_ref"][-1]
        expect_code(self, "SCOPE_DENIED", read_evidence, self.state, self.wid, tampered)

        write_text(self.umd / "src" / "job_submit.c", "int changed(void) { return 0; }\n")
        expect_code(self, "STALE_SOURCE", read_evidence, self.state, self.wid, match["evidence_ref"])

    def test_read_evidence_of_forged_range_rejected(self) -> None:
        sha = sha256_file(self.umd / "src" / "job_submit.c")
        forged = self.state.sign(
            {
                "kind": "source",
                "w": self.wid,
                "r": "umd",
                "p": "src/job_submit.c",
                "s": sha,
                "b": 0,
                "e": 999999,
                "v": "source-only-x86_64",
                "t": "2026-01-01T00:00:00Z",
                "g": 1,
            }
        )
        expect_code(self, "INVALID_ARGUMENT", read_evidence, self.state, self.wid, forged)

    def test_read_source_rejects_other_repo_file_ownership(self) -> None:
        sha = sha256_file(self.uapi / "include" / "job_ioctl.h")
        token = self.state.sign(
            {
                "kind": "path",
                "w": self.wid,
                "r": "umd",
                "p": "../uapi/include/job_ioctl.h",
                "s": sha,
                "g": 1,
            }
        )
        expect_code(self, "INVALID_ARGUMENT", self.read, token, sha, 0, 4)

    def test_find_and_read_unknown_workspace_or_repo(self) -> None:
        expect_code(self, "NOT_FOUND", read_source, self.state, "unknown-ws", "v1.x.y", "0" * 64, 0, 4)
        match = self.find("umd", "**/*.c", literal="memcpy")["matches"][0]
        other_repo_token = scope.sign_path_ref(
            self.state,
            workspace_id=self.wid,
            repo_id="kmd",
            relative_path="src/job_submit.c",
            source_sha256=match["source_sha256"],
        )
        expect_code(self, "NOT_FOUND", self.read, other_repo_token, match["source_sha256"], 0, 4)


if __name__ == "__main__":
    unittest.main()
