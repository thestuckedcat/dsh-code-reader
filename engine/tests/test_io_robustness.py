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


class SigningKeyBinaryIO(unittest.TestCase):
    """Windows CRT text-mode must not corrupt the signing key.

    Regression: ``os.open`` without ``O_BINARY`` expands 0x0A bytes into CRLF.
    A random 32-byte key contains 0x0A about 12% of the time, which made signed
    references intermittently fail with SCOPE_DENIED (profile registrations,
    ledgers, plans and summaries all stop verifying), as observed while
    verifying the S3/S4 stages.
    """

    def _bootstrap(self, root: Path) -> Path:
        root.mkdir(parents=True, exist_ok=True)
        bootstrap = {
            "schema_version": 1,
            "profile_ref": "unittest",
            "scope_ref": "local",
            "scope_generation": 1,
            "state_dir": str(root / "state"),
            "import_inbox_dir": str(root / "inbox"),
            "output_root": str(root / "output"),
            "candidate_roots": [
                {"root_ref": "root", "absolute_path": str(root), "read_grant_ref": "grant"}
            ],
        }
        path = root / "bootstrap.json"
        path.write_text(json.dumps(bootstrap), encoding="utf-8")
        return path

    def test_signing_key_round_trips_binary_bytes(self) -> None:
        from unittest import mock

        from code_learning.state import load_state

        # 32 bytes full of the two bytes a text-mode CRT would translate.
        tricky_key = bytes([0x0A, 0x0D] * 16)
        with tempfile.TemporaryDirectory() as tmp:
            bootstrap = self._bootstrap(Path(tmp))
            with mock.patch("code_learning.state.os.urandom", return_value=tricky_key):
                state = load_state(str(bootstrap))
                token = state.sign({"kind": "unittest", "value": 1, "g": 1})
            key_path = Path(tmp) / "state" / "secret.key"
            self.assertEqual(32, len(key_path.read_bytes()))
            self.assertEqual(tricky_key, key_path.read_bytes())
            reloaded = load_state(str(bootstrap))
            payload = reloaded.verify(token, kind="unittest")
            self.assertEqual(1, payload["value"])

    def test_corrupted_key_file_is_reported_not_used(self) -> None:
        from code_learning.errors import CodeLearningError
        from code_learning.state import load_state

        with tempfile.TemporaryDirectory() as tmp:
            bootstrap = self._bootstrap(Path(tmp))
            state_dir = Path(tmp) / "state"
            state_dir.mkdir(parents=True)
            (state_dir / "secret.key").write_bytes(b"x" * 33)
            state = load_state(str(bootstrap))
            with self.assertRaises(CodeLearningError) as caught:
                state.sign({"kind": "unittest"})
            self.assertEqual("DEPENDENCY_UNAVAILABLE", caught.exception.code)


if __name__ == "__main__":
    unittest.main()
