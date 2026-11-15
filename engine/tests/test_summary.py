"""S4-prep AI summary cache tests (contract docs/ai-summary-perf-contract.md §1).

Covers the engine side of the summary store:

* strict typed payload validation (subject/text/facts/generator/labels, text
  code-point and control-character limits, safe refs, from_observation guard);
* verified snapshot binding and function-subject existence checks;
* one signed record per subject with overwrite (no history) and signature
  integrity on read;
* ``view-summary`` listing/filtering, staleness against the current verified
  snapshot graph hash, gaps for missing records, no absolute paths;
* CLI round-trip through ``summary-put`` / ``view-summary``.

A real bus snapshot from ``evidence/code-view-slice`` is imported into a temp
repository; the summary writer here simulates an Agent (the plugin never calls a
model).
"""

from __future__ import annotations

import base64
import json
import re
import shutil
import tempfile
import unittest
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest import mock

from tests import helpers

from code_learning import snapshot as snapshot_module, summary, util, workspace
from code_learning.errors import CodeLearningError

REPO_ROOT = Path(__file__).resolve().parents[2]
SLICE_EVIDENCE = REPO_ROOT / "evidence" / "code-view-slice"
WORKSPACE_ID = "code-view-bus-demo"
VARIANT_ID = "semantic-x86_64"
REPO_ID = "bus"
SNAPSHOT_ID = "ed326d554334432b907de21297207eb8"
BUS_SEND_ID = "f_afa8298f2d197e5fd110e49a"
BUS_REGISTER_ID = "f_5aad5c091d5772eb2dada479"
GRAPH_SHA = "unknown-graph-sha"
EMPTY_GRAPH_SHA = "f" * 64

_ABS_RE = re.compile(r"^(?:[A-Za-z]:[\\/]|//|/[A-Za-z0-9._~])")


def _looks_absolute(value: str) -> bool:
    return bool(_ABS_RE.match(value))


def _iter_strings(node: Any, key: Optional[str] = None):
    if isinstance(node, dict):
        for name, value in node.items():
            yield from _iter_strings(value, name)
    elif isinstance(node, list):
        for item in node:
            yield from _iter_strings(item, key)
    elif isinstance(node, str):
        yield key, node


def _rewrite_under(value: str, old_root: str, new_root: str) -> str:
    text = value.replace("\\", "/")
    old = old_root.replace("\\", "/").rstrip("/")
    if old and text.lower().startswith(old.lower()):
        suffix = text[len(old) :].lstrip("/")
        return str(Path(new_root) / suffix) if suffix else str(new_root)
    return value


class SummaryTestBase(unittest.TestCase):
    """Temp bootstrap + registered workspace + imported real bus snapshot."""

    def setUp(self) -> None:
        if not SLICE_EVIDENCE.is_dir():
            self.skipTest("real Atlas snapshot evidence is missing")
        self.tmp = Path(tempfile.mkdtemp(prefix="cl-summary-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.env = helpers.make_bootstrap(self.tmp)
        self.repository = self.env.root / "repo"
        self.repository.mkdir(parents=True, exist_ok=True)
        for name in ("bus.c", "platform.c", "compile_commands.json"):
            shutil.copyfile(SLICE_EVIDENCE / "repo" / name, self.repository / name)
        manifest = {
            "schema_version": 1,
            "workspace_id": WORKSPACE_ID,
            "scope_ref": "local",
            "repositories": [
                {
                    "repo_id": REPO_ID,
                    "root_ref": "synthetic-root",
                    "relative_path": "repo",
                    "role": "other",
                    "vcs": {"kind": "none", "commit": None},
                }
            ],
            "variants": [{"variant_id": VARIANT_ID, "analysis_mode": "semantic"}],
            "toolchains": [],
            "allowed_read_roots": ["synthetic-root"],
            "output_root_ref": "synthetic-root",
            "cross_repo_bindings": [],
        }
        helpers.write_manifest(self.env, manifest, "workspace.json")
        workspace.import_workspace(self.env.state, "workspace.json", 0, str(uuid.uuid4()))
        self.snapshot_id = self._import_real_snapshot()
        self.graph_sha = snapshot_module.load_snapshot_bundle(
            self.env.state, WORKSPACE_ID, self.snapshot_id
        )["graph_sha256"]

    def _import_real_snapshot(self) -> str:
        snapshot_dir = next((SLICE_EVIDENCE / "snapshot").iterdir())
        graph_document = json.loads(
            (snapshot_dir / "graph.json").read_text(encoding="utf-8")
        )
        manifest_document = json.loads(
            (snapshot_dir / "analysis_manifest.json").read_text(encoding="utf-8")
        )
        old_root = manifest_document["payload"]["workspace_roots"][0]
        payload = json.loads(json.dumps(graph_document["payload"]))
        for entity in payload.get("evidence") or []:
            if isinstance(entity.get("file"), str):
                entity["file"] = _rewrite_under(
                    entity["file"], old_root, str(self.repository)
                )
        overrides = {
            "snapshot_id": manifest_document["payload"]["snapshot_id"],
            "analysis_id": manifest_document["payload"]["analysis_id"],
            "input_files": {},
            "workspace_roots": [str(self.repository)],
            "workspace_revisions": {str(self.repository): "fixture-revision"},
            "coverage": json.loads(json.dumps(manifest_document["payload"]["coverage"])),
            "scope": {"mode": "interface", "interface": "submit", "direction": "down"},
        }
        helpers.write_snapshot_dir(
            self.env.inbox_dir / "bus-snapshot", payload, overrides
        )
        projection = snapshot_module.import_snapshot(
            self.env.state,
            WORKSPACE_ID,
            VARIANT_ID,
            REPO_ID,
            "bus-snapshot",
            str(uuid.uuid4()),
        )
        return projection["snapshot_id"]

    # -- helpers -------------------------------------------------------
    def payload(
        self,
        *,
        subject_type: str = "function",
        subject_id: str = BUS_SEND_ID,
        text: str = "bus_send 依次查表、校验长度、加锁、搬运并通知平台；返回 0 表示成功。",
        facts: Optional[List[Dict[str, str]]] = None,
        generator: Optional[Dict[str, Any]] = None,
        inference_labels: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        return {
            "subject": {"type": subject_type, "id": subject_id},
            "text": text,
            "facts": facts
            if facts is not None
            else [
                {"kind": "evidence", "ref": "e_bus_send_entry"},
                {"kind": "node", "ref": "f_afa8298f2d197e5fd110e49a"},
            ],
            "generator": generator
            if generator is not None
            else {"kind": "agent", "ref": "skill:test-summary"},
            "inference_labels": inference_labels
            if inference_labels is not None
            else ["from_static_structure"],
        }

    def put(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return summary.summary_put(
            self.env.state,
            WORKSPACE_ID,
            self.snapshot_id,
            base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii"),
        )

    def view(
        self,
        subject_type: Optional[str] = None,
        subject_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return summary.view_summary(
            self.env.state,
            WORKSPACE_ID,
            self.snapshot_id,
            subject_type,
            subject_id,
        )

    def expect_error(self, code: str, callable_) -> CodeLearningError:
        with self.assertRaises(CodeLearningError) as context:
            callable_()
        self.assertEqual(code, context.exception.code, context.exception.message)
        return context.exception

    def stored_path(self, subject_type: str, subject_id: str) -> Path:
        digest = util.sha256_text(subject_id)
        return (
            self.env.state.state_root
            / "summaries"
            / WORKSPACE_ID
            / self.snapshot_id
            / f"{subject_type}_{digest[:32]}.json"
        )

    def write_observation_ledger(self) -> None:
        scenario_id = "scn_000000000000"
        helpers.write_json(
            self.env.state.state_root
            / "scenarios"
            / scenario_id
            / "current.json",
            {
                "schema_version": 1,
                "scenario_id": scenario_id,
                "generation": 1,
                "workspace_id": WORKSPACE_ID,
                "snapshot_id": self.snapshot_id,
                "records_digest": "0" * 64,
                "step_count": 1,
                "created_at": "2026-11-15T00:00:00Z",
                "updated_at": "2026-11-15T00:00:00Z",
            },
        )

    def cli_json(self, *args: str, expect: int = 0) -> Dict[str, Any]:
        return helpers.cli_json(self.env.bootstrap_path, *args, expect=expect)

    def assert_no_absolute_paths(self, payload: Any) -> None:
        tmp_text = str(self.tmp).replace("\\", "/")
        for _key, value in _iter_strings(payload):
            if len(value) > 4096:
                continue
            self.assertFalse(
                _looks_absolute(value), f"absolute path leaked into payload: {value!r}"
            )
            self.assertNotIn(tmp_text, value.replace("\\", "/"))


class SummaryStoreTest(SummaryTestBase):
    def test_put_function_summary_and_view(self) -> None:
        projection = self.put(self.payload())
        self.assertEqual(1, projection["schema_version"])
        self.assertEqual(WORKSPACE_ID, projection["workspace_id"])
        self.assertEqual(self.snapshot_id, projection["snapshot_id"])
        self.assertEqual(
            {"type": "function", "id": BUS_SEND_ID}, projection["subject"]
        )
        self.assertTrue(projection["text"].startswith("bus_send"))
        self.assertEqual(
            [
                {"kind": "evidence", "ref": "e_bus_send_entry"},
                {"kind": "node", "ref": BUS_SEND_ID},
            ],
            projection["facts"],
        )
        self.assertEqual(
            {"kind": "agent", "ref": "skill:test-summary", "model_ref": None},
            projection["generator"],
        )
        self.assertEqual(["from_static_structure"], projection["inference_labels"])
        self.assertTrue(projection["generated_at"].endswith("Z"))
        self.assertEqual(self.graph_sha, projection["snapshot_graph_sha256"])
        self.assertFalse(projection["stale"])
        self.assertEqual([], projection["limitations"])
        self.assertNotIn("signature", projection)
        self.assert_no_absolute_paths(projection)

        stored = json.loads(self.stored_path("function", BUS_SEND_ID).read_text(encoding="utf-8"))
        self.assertIn("signature", stored)
        self.assertEqual(projection["text"], stored["text"])

        listing = self.view()
        self.assertEqual(1, listing["schema_version"])
        self.assertEqual(1, len(listing["summaries"]))
        self.assertEqual(0, listing["stale_count"])
        self.assertEqual([], listing["gaps"])
        self.assertEqual(projection, listing["summaries"][0])
        self.assert_no_absolute_paths(listing)

        repeated = self.view()
        self.assertEqual(
            json.dumps(listing, ensure_ascii=False, sort_keys=True),
            json.dumps(repeated, ensure_ascii=False, sort_keys=True),
        )

    def test_overwrite_keeps_single_latest_record(self) -> None:
        first = self.put(self.payload(text="第一版归纳。"))
        second = self.put(
            self.payload(
                text="第二版归纳，覆盖旧文本且保留同 subject 唯一记录。",
                facts=[{"kind": "selection", "ref": "f_afa8298f2d197e5fd110e49a|entry"}],
                generator={"kind": "user", "ref": "user:reviewer", "model_ref": "deepseek-chat"},
                inference_labels=["from_source_text", "may_speculative"],
            )
        )
        self.assertNotEqual(first["text"], second["text"])
        self.assertEqual("user", second["generator"]["kind"])
        self.assertEqual("deepseek-chat", second["generator"]["model_ref"])
        listing = self.view("function", BUS_SEND_ID)
        self.assertEqual(1, len(listing["summaries"]))
        self.assertEqual(second["text"], listing["summaries"][0]["text"])
        self.assertEqual(1, len(list(self.stored_path("function", BUS_SEND_ID).parent.glob("*.json"))))

    def test_group_and_entry_subjects_skip_existence_check(self) -> None:
        group = self.put(
            self.payload(
                subject_type="group",
                subject_id="group:bus-pipeline",
                text="组归纳：入口通道经查表与长度校验后进入搬运路径。",
                inference_labels=["from_static_structure"],
            )
        )
        self.assertEqual([summary.LIMITATION_NO_EXISTENCE_CHECK], group["limitations"])
        entry = self.put(
            self.payload(
                subject_type="entry",
                subject_id="entry:bus_send",
                text="入口归纳：调用方触发入口执行。",
                inference_labels=["from_static_structure"],
            )
        )
        self.assertEqual([summary.LIMITATION_NO_EXISTENCE_CHECK], entry["limitations"])

        all_summaries = self.view()
        self.assertEqual(2, len(all_summaries["summaries"]))
        self.assertEqual(
            ["entry", "group"],
            [item["subject"]["type"] for item in all_summaries["summaries"]],
        )
        only_group = self.view("group", "group:bus-pipeline")
        self.assertEqual(1, len(only_group["summaries"]))
        self.assertEqual("group:bus-pipeline", only_group["summaries"][0]["subject"]["id"])
        self.assertEqual([], only_group["gaps"])

    def test_validation_errors(self) -> None:
        def expect_put_invalid(code: str, mutate) -> None:
            payload = self.payload()
            mutate(payload)
            self.expect_error(code, lambda: self.put(payload))

        expect_put_invalid("INVALID_ARGUMENT", lambda payload: payload.update({"text": ""}))
        expect_put_invalid(
            "LIMIT_EXCEEDED", lambda payload: payload.update({"text": "长" * 501})
        )
        expect_put_invalid(
            "INVALID_ARGUMENT", lambda payload: payload.update({"text": "换行\n注入"})
        )
        expect_put_invalid(
            "INVALID_ARGUMENT", lambda payload: payload.update({"text": "制表\t符"})
        )
        expect_put_invalid(
            "INVALID_ARGUMENT", lambda payload: payload.update({"text": "控制\x00符"})
        )
        expect_put_invalid(
            "INVALID_ARGUMENT", lambda payload: payload.update({"text": "删除\x7f符"})
        )
        expect_put_invalid(
            "INVALID_ARGUMENT", lambda payload: payload.update({"text": "C1\u0085符"})
        )
        expect_put_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload.update(
                {"facts": [{"kind": "evidence", "ref": f"e_{index}"} for index in range(33)]}
            ),
        )
        expect_put_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload.update({"facts": [{"kind": "trace", "ref": "e_x"}]}),
        )
        expect_put_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload.update({"facts": [{"kind": "evidence", "ref": "C:\\secret\\e"}]}),
        )
        expect_put_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload.update({"facts": [{"kind": "evidence", "ref": "e has space"}]}),
        )
        expect_put_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload.update(
                {"facts": [{"kind": "evidence", "ref": "e" * 513}]}
            ),
        )
        expect_put_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload.update({"facts": [{"kind": "evidence", "ref": "e_x", "extra": 1}]}),
        )
        expect_put_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload.update({"generator": {"kind": "model", "ref": "x"}}),
        )
        expect_put_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload.update({"generator": {"kind": "agent", "ref": "/abs/ref"}}),
        )
        expect_put_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload.update({"generator": {"kind": "agent", "ref": "a" * 257}}),
        )
        expect_put_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload.update(
                {"generator": {"kind": "agent", "ref": "x", "model_ref": "m" * 129}}
            ),
        )
        expect_put_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload.update({"inference_labels": ["from_imagination"]}),
        )
        expect_put_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload.update(
                {"inference_labels": ["from_static_structure"] * 9}
            ),
        )
        expect_put_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload.update(
                {"subject": {"type": "case", "id": BUS_SEND_ID}}
            ),
        )
        expect_put_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload.update({"subject": {"type": "function", "id": ""}}),
        )
        expect_put_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload.update(
                {"subject": {"type": "function", "id": "f_missing_function"}}
            ),
        )
        expect_put_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload.update({"subject": {"type": "function", "id": "C:\\abs"}}),
        )
        expect_put_invalid("INVALID_ARGUMENT", lambda payload: payload.update({"extra": 1}))

        boundary = self.put(self.payload(text="归" * 500))
        self.assertEqual(500, len(boundary["text"]))

        # from_observation requires an existing run/import ledger.
        self.expect_error(
            "INVALID_ARGUMENT",
            lambda: self.put(
                self.payload(inference_labels=["from_observation", "from_static_structure"])
            ),
        )
        self.write_observation_ledger()
        allowed = self.put(
            self.payload(
                text="基于运行观测的归纳：bus_send 返回 0。",
                inference_labels=["from_observation"],
            )
        )
        self.assertEqual(["from_observation"], allowed["inference_labels"])

    def test_payload_and_workspace_errors(self) -> None:
        self.expect_error(
            "INVALID_ARGUMENT",
            lambda: summary.summary_put(self.env.state, WORKSPACE_ID, self.snapshot_id, "!!!"),
        )
        oversized = json.dumps(
            {
                "subject": {"type": "function", "id": BUS_SEND_ID},
                "text": "a" * 70000,
                "facts": [],
                "generator": {"kind": "agent", "ref": "x"},
                "inference_labels": [],
            }
        )
        self.expect_error(
            "LIMIT_EXCEEDED",
            lambda: summary.summary_put(
                self.env.state,
                WORKSPACE_ID,
                self.snapshot_id,
                base64.b64encode(oversized.encode()).decode(),
            ),
        )
        self.expect_error(
            "NOT_FOUND",
            lambda: summary.summary_put(
                self.env.state,
                WORKSPACE_ID,
                "ffffffffffffffffffffffffffffffff",
                base64.b64encode(json.dumps(self.payload()).encode()).decode(),
            ),
        )
        self.expect_error(
            "NOT_FOUND",
            lambda: summary.view_summary(
                self.env.state, "no-such-workspace", self.snapshot_id
            ),
        )

    def test_stale_against_current_snapshot_graph(self) -> None:
        self.put(self.payload())
        with mock.patch.object(
            summary, "_bundle_graph_sha", lambda bundle: EMPTY_GRAPH_SHA
        ):
            listing = self.view()
        self.assertEqual(1, len(listing["summaries"]))
        self.assertEqual(1, listing["stale_count"])
        stale_summary = listing["summaries"][0]
        self.assertTrue(stale_summary["stale"])
        self.assertIn(summary.LIMITATION_STALE, stale_summary["limitations"])
        self.assert_no_absolute_paths(listing)

        fresh = self.view()
        self.assertFalse(fresh["summaries"][0]["stale"])
        self.assertEqual(0, fresh["stale_count"])
        self.assertNotIn(summary.LIMITATION_STALE, fresh["summaries"][0]["limitations"])

    def test_gaps_and_subject_filter_validation(self) -> None:
        empty = self.view()
        self.assertEqual([], empty["summaries"])
        self.assertEqual([summary.GAP_NOT_GENERATED], [gap["code"] for gap in empty["gaps"]])
        self.assertEqual(0, empty["stale_count"])
        self.assert_no_absolute_paths(empty)

        self.expect_error(
            "INVALID_ARGUMENT", lambda: self.view("function", None)
        )
        self.expect_error(
            "INVALID_ARGUMENT", lambda: self.view(None, BUS_SEND_ID)
        )
        self.expect_error(
            "INVALID_ARGUMENT", lambda: self.view("not-a-type", BUS_SEND_ID)
        )
        self.expect_error(
            "INVALID_ARGUMENT", lambda: self.view("function", "bad id with space")
        )
        self.assertEqual([], self.view("function", BUS_SEND_ID)["summaries"])

    def test_tampered_record_is_rejected(self) -> None:
        self.put(self.payload())
        path = self.stored_path("function", BUS_SEND_ID)
        record = json.loads(path.read_text(encoding="utf-8"))
        record["text"] = "tampered text"
        path.write_text(json.dumps(record), encoding="utf-8")
        self.expect_error("SCOPE_DENIED", lambda: self.view())


class SummaryCliTest(SummaryTestBase):
    def test_cli_round_trip(self) -> None:
        payload = self.payload()
        encoded = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
        projection = self.cli_json(
            "summary-put",
            "--workspace",
            WORKSPACE_ID,
            "--snapshot",
            self.snapshot_id,
            "--payload-json",
            encoded,
        )
        self.assertEqual(BUS_SEND_ID, projection["subject"]["id"])
        self.assertFalse(projection["stale"])

        listing = self.cli_json(
            "view-summary",
            "--workspace",
            WORKSPACE_ID,
            "--snapshot",
            self.snapshot_id,
        )
        self.assertEqual(1, len(listing["summaries"]))
        self.assertEqual(payload["text"], listing["summaries"][0]["text"])

        filtered = self.cli_json(
            "view-summary",
            "--workspace",
            WORKSPACE_ID,
            "--snapshot",
            self.snapshot_id,
            "--subject-type",
            "function",
            "--subject-id",
            BUS_SEND_ID,
        )
        self.assertEqual(1, len(filtered["summaries"]))
        self.assertEqual(0, filtered["stale_count"])
        self.assert_no_absolute_paths(filtered)

        completed = helpers.run_cli(
            self.env.bootstrap_path,
            "view-summary",
            "--workspace",
            WORKSPACE_ID,
            "--snapshot",
            self.snapshot_id,
            "--subject-type",
            "group",
            expect=2,
        )
        self.assertEqual(
            "INVALID_ARGUMENT", json.loads(completed.stdout)["error"]["code"]
        )


if __name__ == "__main__":
    unittest.main()
