"""Lead-owned robustness tests for cross-cutting local I/O behaviour.

These are intentionally small: they pin two Windows-friendly behaviours the
field journey relies on (UTF-8 BOM tolerance for local JSON written by common
editors/PowerShell) without widening the strict JSON contract elsewhere.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from code_learning.state import load_bootstrap_data
from code_learning.util import read_json


class LocalJsonEncodingTest(unittest.TestCase):
    def test_read_json_accepts_utf8_bom(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "draft.json"
            payload = {"schema_version": 1, "question": "为什么 ioctl 会进队列？"}
            path.write_bytes(b"\xef\xbb\xbf" + json.dumps(payload, ensure_ascii=False).encode("utf-8"))
            self.assertEqual(read_json(path), payload)

    def test_bootstrap_accepts_utf8_bom(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "root"
            root.mkdir()
            bootstrap = {
                "schema_version": 1,
                "profile_ref": "unittest",
                "scope_ref": "local",
                "scope_generation": 1,
                "state_dir": str(Path(tmp) / "state"),
                "import_inbox_dir": str(Path(tmp) / "inbox"),
                "output_root": str(Path(tmp) / "output"),
                "candidate_roots": [
                    {"root_ref": "root", "absolute_path": str(root), "read_grant_ref": "grant"}
                ],
            }
            path = Path(tmp) / "bootstrap.json"
            path.write_bytes(b"\xef\xbb\xbf" + json.dumps(bootstrap).encode("utf-8"))
            loaded = load_bootstrap_data(path)
            self.assertEqual(loaded["scope_ref"], "local")
            self.assertEqual(loaded["candidate_roots"][0]["root_ref"], "root")

    def test_read_json_still_rejects_invalid_json(self) -> None:
        from code_learning.errors import CodeLearningError

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "broken.json"
            path.write_text("{not json", encoding="utf-8")
            with self.assertRaises(CodeLearningError) as caught:
                read_json(path)
            self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")


if __name__ == "__main__":
    unittest.main()
