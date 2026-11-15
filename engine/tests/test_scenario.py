"""CL-VIEW-T3 (S3a) controlled scenario engine tests.

Covers the contract section 8 engine list:

* trusted Wasm profile import: real Demo profile (``evidence/scenario-sim``),
  module hash/size verification, envelope/interface/trace/event checks, snapshot
  object binding, tamper rejection, idempotency;
* scenario validation and signed TTL plans (step/parameter ranges, generation
  CAS, byte budgets, expiry);
* worker records alignment, event table / 32-bit fields / digest validation,
  immutable ledger generations with CAS and operation idempotency;
* observed timing DTO built from the real profile's event table.

The real bus snapshot from ``evidence/code-view-slice`` is imported into a temp
repository (paths rewritten inside the test), the profile module is copied from
the committed ``evidence/scenario-sim/inbox`` fixture, and worker records are
constructed exactly as the contract §3 describes (the actual Wasm execution
belongs to the Host worker / ``sim-runner`` tests).
"""

from __future__ import annotations

import base64
import hashlib
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
from tests.fixtures.snapshots import support

from code_learning import scenario, snapshot as snapshot_module, util, workspace
from code_learning.errors import CodeLearningError

REPO_ROOT = Path(__file__).resolve().parents[2]
SLICE_EVIDENCE = REPO_ROOT / "evidence" / "code-view-slice"
SCENARIO_EVIDENCE = REPO_ROOT / "evidence" / "scenario-sim"
WORKSPACE_ID = "code-view-bus-demo"
VARIANT_ID = "semantic-x86_64"
REPO_ID = "bus"
SNAPSHOT_ID = "ed326d554334432b907de21297207eb8"
PROFILE_ID = "bus-demo-wasm"
PROFILE_INBOX_NAME = "sim-profile.json"
MODULE_SHA = "69c8622d3522f68f90450a2db36ee11a85c859c91bdf2b5df1688fd6acd1321c"
DEFAULT_STEPS = [
    {"interface": "reset", "args": []},
    {"interface": "bus_register", "args": [1]},
    {"interface": "set_platform_stub", "args": [-5]},
    {"interface": "bus_send", "args": [1, 48]},
]

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


UNDO_STEPS = [
    {"interface": "reset", "args": []},
    {"interface": "bus_register", "args": [1]},
    {"interface": "bus_send", "args": [1, 48]},
]

class ScenarioTestBase(unittest.TestCase):
    """Temp bootstrap + real bus snapshot + imported real Wasm profile."""

    def setUp(self) -> None:
        if not SLICE_EVIDENCE.is_dir() or not (SCENARIO_EVIDENCE / "inbox").is_dir():
            self.skipTest("real Atlas snapshot / scenario-sim evidence is missing")
        self.tmp = Path(tempfile.mkdtemp(prefix="cl-scenario-"))
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
        for name in ("sim-profile.json", "bus.wasm", "trace-bus-send.json"):
            shutil.copyfile(SCENARIO_EVIDENCE / "inbox" / name, self.env.inbox_dir / name)
        self.profile = scenario.sim_profile_import(
            self.env.state,
            WORKSPACE_ID,
            VARIANT_ID,
            REPO_ID,
            PROFILE_INBOX_NAME,
            str(uuid.uuid4()),
        )

    # -- fixture helpers ------------------------------------------------
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

    def import_extra_snapshot(self) -> str:
        payload = support.graph_payload(
            functions=[support.function("f_extra", "extra_fn", file="src/extra.c", line=1)]
        )
        helpers.write_snapshot_dir(
            self.env.inbox_dir / "extra-snapshot",
            payload,
            {"snapshot_id": "1234567890abcdef1234567890abcdef"},
        )
        projection = snapshot_module.import_snapshot(
            self.env.state,
            WORKSPACE_ID,
            VARIANT_ID,
            REPO_ID,
            "extra-snapshot",
            str(uuid.uuid4()),
        )
        return projection["snapshot_id"]

    def read_profile_payload(self) -> Dict[str, Any]:
        return json.loads(
            (SCENARIO_EVIDENCE / "inbox" / PROFILE_INBOX_NAME).read_text(
                encoding="utf-8"
            )
        )

    def write_inbox_profile(self, payload: Dict[str, Any], name: str) -> str:
        helpers.write_json(self.env.inbox_dir / name, payload)
        return name

    def import_profile_variant(
        self, mutate, *, name: str = "sim-profile-variant.json"
    ) -> Dict[str, Any]:
        payload = self.read_profile_payload()
        mutate(payload)
        self.write_inbox_profile(payload, name)
        return scenario.sim_profile_import(
            self.env.state,
            WORKSPACE_ID,
            VARIANT_ID,
            REPO_ID,
            name,
            str(uuid.uuid4()),
        )

    def expect_error(self, code: str, callable_) -> CodeLearningError:
        with self.assertRaises(CodeLearningError) as context:
            callable_()
        self.assertEqual(code, context.exception.code, context.exception.message)
        return context.exception

    # -- scenario helpers ----------------------------------------------
    def scenario_b64(
        self,
        steps: Optional[List[Dict[str, Any]]] = None,
        *,
        generation: int = 0,
        stop_on_error: bool = True,
    ) -> str:
        document = {
            "generation": generation,
            "stop_on_error": stop_on_error,
            "steps": steps if steps is not None else DEFAULT_STEPS,
        }
        return base64.b64encode(json.dumps(document).encode("utf-8")).decode("ascii")

    def make_plan(
        self,
        steps: Optional[List[Dict[str, Any]]] = None,
        *,
        generation: int = 0,
        expected_generation: Optional[int] = None,
        profile_id: str = PROFILE_ID,
        snapshot_ref: Optional[str] = None,
    ) -> Dict[str, Any]:
        return scenario.scenario_plan(
            self.env.state,
            WORKSPACE_ID,
            snapshot_ref or self.snapshot_id,
            profile_id,
            self.scenario_b64(steps, generation=generation),
            expected_generation=generation if expected_generation is None else expected_generation,
        )

    @staticmethod
    def b64_json(value: Any) -> str:
        return base64.b64encode(json.dumps(value).encode("utf-8")).decode("ascii")

    def events_for(self, interface: str) -> List[Dict[str, Any]]:
        codes = self.profile["trace"]["events"]

        def event(name: str, a: int = 0, b: int = 0, c: int = 0, line: int = 1):
            return {"event": name, "code": codes[name], "a": a, "b": b, "c": c, "line": line}

        table = {
            "reset": [],
            "bus_register": [
                event("DEFAULT_ROUTE", 1, 0, 32, 57),
                event("STORE_ROUTE", 1, 0, 32, 47),
            ],
            "set_platform_stub": [],
            "bus_send": [
                event("REQUEST", 1, 48, 0, 154),
                event("LOOKUP", 1, 0, 32, 92),
                event("CHECK_LENGTH", 48, 32, 1, 99),
                event("LOCK", 1, 0, 0, 169),
                event("TRANSFER", 48, 0, 48, 146),
                event("DIRECT", 0, 48, 0, 132),
                event("ENCODE", 0, 48, 48, 106),
                event("COMMIT", 0, 48, 0, 118),
                event("DOORBELL", 4160, 48, 0, 112),
                event("WRITE", 4160, 48, 0, 113),
                event("LOCK", 0, 0, 0, 172),
            ],
        }
        return [dict(item) for item in table.get(interface, [])]

    def make_records(
        self,
        plan: Dict[str, Any],
        *,
        results: Optional[Dict[int, Optional[int]]] = None,
        statuses: Optional[Dict[int, str]] = None,
        events_by_step: Optional[Dict[int, List[Dict[str, Any]]]] = None,
        memory_digest: str = "ab" * 32,
    ) -> List[Dict[str, Any]]:
        results = results or {}
        statuses = statuses or {}
        events_by_step = events_by_step or {}
        records: List[Dict[str, Any]] = []
        for step in plan["steps"]:
            index = step["index"]
            interface = step["interface"]
            default_result = -5 if interface == "set_platform_stub" else 0
            records.append(
                {
                    "step_index": index,
                    "interface": interface,
                    "args": list(step["args"]),
                    "status": statuses.get(index, "ok"),
                    "result": results.get(index, default_result),
                    "memory_digest": memory_digest,
                    "elapsed_ms": 1,
                    "events": list(
                        events_by_step.get(index, self.events_for(interface))
                    ),
                }
            )
        return records

    def record(
        self,
        plan: Dict[str, Any],
        records: Optional[List[Dict[str, Any]]] = None,
        *,
        operation_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        payload = records if records is not None else self.make_records(plan)
        return scenario.scenario_record(
            self.env.state,
            plan["plan_id"],
            self.b64_json({"records": payload}),
            operation_id or str(uuid.uuid4()),
        )

    def cli_json(self, *args: str, expect: int = 0) -> Dict[str, Any]:
        return helpers.cli_json(self.env.bootstrap_path, *args, expect=expect)


    # -- S3b helpers ---------------------------------------------------
    def trace_payload(self) -> Dict[str, Any]:
        return json.loads(
            (SCENARIO_EVIDENCE / "inbox" / "trace-bus-send.json").read_text(
                encoding="utf-8"
            )
        )

    def write_inbox_json(self, name: str, payload: Dict[str, Any]) -> str:
        helpers.write_json(self.env.inbox_dir / name, payload)
        return name

    def import_trace(self, name: str = "trace-bus-send.json") -> Dict[str, Any]:
        return scenario.trace_import(
            self.env.state,
            WORKSPACE_ID,
            self.snapshot_id,
            name,
            str(uuid.uuid4()),
        )

    def source_scenario(
        self,
        steps: Optional[List[Dict[str, Any]]] = None,
        memory_digests: Optional[List[str]] = None,
    ):
        plan = self.make_plan(steps=steps)
        records = self.make_records(plan)
        if memory_digests is not None:
            for record, digest in zip(records, memory_digests):
                record["memory_digest"] = digest
        ledger = self.record(plan, records)
        return plan, records, ledger

    def undo_plan(
        self,
        ledger: Dict[str, Any],
        count: int,
        expected_generation: Optional[int] = None,
    ) -> Dict[str, Any]:
        return scenario.scenario_undo_plan(
            self.env.state,
            WORKSPACE_ID,
            ledger["scenario_id"],
            count,
            ledger["generation"] if expected_generation is None else expected_generation,
        )

    def undo_record(
        self,
        undo_plan: Dict[str, Any],
        records: List[Dict[str, Any]],
        *,
        operation_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return scenario.scenario_undo_record(
            self.env.state,
            undo_plan["undo_plan_id"],
            self.b64_json({"records": records}),
            operation_id or str(uuid.uuid4()),
        )

    def assert_no_absolute_paths(self, payload: Any) -> None:
        tmp_text = str(self.tmp).replace("\\", "/")
        for key, value in _iter_strings(payload):
            if key == "module_b64" or len(value) > 1024:
                continue
            self.assertFalse(
                _looks_absolute(value), f"absolute path leaked into payload: {value!r}"
            )
            normalized = value.replace("\\", "/")
            self.assertNotIn(tmp_text, normalized)


class ProfileImportTest(ScenarioTestBase):
    def test_real_profile_import_projection_and_files(self) -> None:
        projection = self.profile
        self.assertEqual(1, projection["schema_version"])
        self.assertEqual(PROFILE_ID, projection["profile_id"])
        self.assertEqual("Demo bus/platform Wasm 隔离模拟", projection["label"])
        self.assertEqual("wasm32", projection["kind"])
        self.assertEqual(
            {
                "workspace_id": WORKSPACE_ID,
                "variant_id": VARIANT_ID,
                "repo_id": REPO_ID,
                "snapshot_id": SNAPSHOT_ID,
            },
            projection["binding"],
        )
        self.assertEqual(
            {"sha256": MODULE_SHA, "bytes": 1547}, projection["module"]
        )
        self.assertEqual(7, len(projection["interfaces"]))
        interface_names = [item["name"] for item in projection["interfaces"]]
        self.assertIn("bus_send", interface_names)
        self.assertIn("set_platform_stub", interface_names)
        bus_send = next(item for item in projection["interfaces"] if item["name"] == "bus_send")
        self.assertEqual("entry", bus_send["role"])
        self.assertEqual(
            [
                {"name": "channel", "type": "u32", "min": 0, "max": 3},
                {"name": "length", "type": "u32", "min": 0, "max": 65535},
            ],
            bus_send["params"],
        )
        self.assertEqual(19, len(projection["trace"]["events"]))
        self.assertEqual(10, len(projection["event_resources"]))
        self.assertTrue(projection["limitations"])

        profile_dir = self.env.state.state_root / "sim" / PROFILE_ID
        profile_record = json.loads((profile_dir / "profile.json").read_text(encoding="utf-8"))
        self.assertIn("signature", profile_record)
        module_path = profile_dir / f"{MODULE_SHA}.wasm"
        self.assertTrue(module_path.is_file())
        self.assertEqual(1547, module_path.stat().st_size)
        self.assertEqual(
            MODULE_SHA, hashlib.sha256(module_path.read_bytes()).hexdigest()
        )
        index = json.loads((self.env.state.state_root / "sim" / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(PROFILE_ID, index["entries"][0]["profile_id"])
        self.assert_no_absolute_paths(projection)

    def test_import_is_idempotent_and_operation_conflicts(self) -> None:
        operation = str(uuid.uuid4())
        first = scenario.sim_profile_import(
            self.env.state, WORKSPACE_ID, VARIANT_ID, REPO_ID, PROFILE_INBOX_NAME, operation
        )
        replay = scenario.sim_profile_import(
            self.env.state, WORKSPACE_ID, VARIANT_ID, REPO_ID, PROFILE_INBOX_NAME, operation
        )
        self.assertEqual(first, replay)
        self.expect_error(
            "OPERATION_CONFLICT",
            lambda: scenario.sim_profile_import(
                self.env.state, WORKSPACE_ID, VARIANT_ID, REPO_ID, "other-profile.json", operation
            ),
        )
        fresh = scenario.sim_profile_import(
            self.env.state, WORKSPACE_ID, VARIANT_ID, REPO_ID, PROFILE_INBOX_NAME, str(uuid.uuid4())
        )
        self.assertEqual(PROFILE_ID, fresh["profile_id"])

    def test_import_rejects_tampered_module(self) -> None:
        tampered = bytes((byte + 1) % 256 for byte in (SCENARIO_EVIDENCE / "inbox" / "bus.wasm").read_bytes())
        (self.env.inbox_dir / "tampered.wasm").write_bytes(tampered)

        def mutate(payload: Dict[str, Any]) -> None:
            payload["module"]["file"] = "tampered.wasm"

        self.expect_error(
            "INVALID_ARGUMENT", lambda: self.import_profile_variant(mutate)
        )

    def test_import_binding_errors(self) -> None:
        def other_workspace(payload: Dict[str, Any]) -> None:
            payload["binding"]["workspace_id"] = "other-workspace"

        self.expect_error("SCOPE_DENIED", lambda: self.import_profile_variant(other_workspace))

        def other_variant_binding(payload: Dict[str, Any]) -> None:
            payload["binding"]["variant_id"] = "other-variant"

        self.expect_error(
            "INVALID_ARGUMENT", lambda: self.import_profile_variant(other_variant_binding)
        )

        def other_repo_binding(payload: Dict[str, Any]) -> None:
            payload["binding"]["repo_id"] = "other-repo"

        self.expect_error(
            "INVALID_ARGUMENT", lambda: self.import_profile_variant(other_repo_binding)
        )

        def unknown_snapshot(payload: Dict[str, Any]) -> None:
            payload["binding"]["snapshot_id"] = "ffffffffffffffffffffffffffffffff"

        self.expect_error("NOT_FOUND", lambda: self.import_profile_variant(unknown_snapshot))

        def unknown_variant_param(payload: Dict[str, Any]) -> None:
            payload["binding"]["variant_id"] = "unknown-variant"

        payload = self.read_profile_payload()
        unknown_variant_param(payload)
        name = self.write_inbox_profile(payload, "profile-unknown-variant.json")
        self.expect_error(
            "NOT_FOUND",
            lambda: scenario.sim_profile_import(
                self.env.state, WORKSPACE_ID, "unknown-variant", REPO_ID, name, str(uuid.uuid4())
            ),
        )

        self.expect_error(
            "NOT_FOUND",
            lambda: scenario.sim_profile_import(
                self.env.state, WORKSPACE_ID, VARIANT_ID, "unknown-repo", PROFILE_INBOX_NAME, str(uuid.uuid4())
            ),
        )

    def test_import_rejects_fake_event_resources(self) -> None:
        def mutate(payload: Dict[str, Any]) -> None:
            payload["event_resources"]["LOOKUP"][0]["resource_id"] = "s_fake_object"

        self.expect_error(
            "INVALID_ARGUMENT", lambda: self.import_profile_variant(mutate)
        )

    def test_import_interface_validation(self) -> None:
        def bad_range(payload: Dict[str, Any]) -> None:
            payload["interfaces"][1]["params"][0]["min"] = 9
            payload["interfaces"][1]["params"][0]["max"] = 3

        self.expect_error("INVALID_ARGUMENT", lambda: self.import_profile_variant(bad_range))

        def bad_role(payload: Dict[str, Any]) -> None:
            payload["interfaces"][0]["role"] = "side_effect"

        self.expect_error("INVALID_ARGUMENT", lambda: self.import_profile_variant(bad_role))

        def bad_returns(payload: Dict[str, Any]) -> None:
            payload["interfaces"][0]["returns"] = "i64"

        self.expect_error("INVALID_ARGUMENT", lambda: self.import_profile_variant(bad_returns))

        def bad_event_key(payload: Dict[str, Any]) -> None:
            payload["trace"]["events"]["bad_lower"] = 99

        self.expect_error("INVALID_ARGUMENT", lambda: self.import_profile_variant(bad_event_key))

        def bad_entry_id(payload: Dict[str, Any]) -> None:
            payload["interfaces"][1]["entry_id"] = "f_does_not_exist"

        self.expect_error("INVALID_ARGUMENT", lambda: self.import_profile_variant(bad_entry_id))

    def test_profile_list_verified_and_unknown_workspace(self) -> None:
        listing = scenario.sim_profile_list(self.env.state, WORKSPACE_ID)
        self.assertEqual(1, listing["schema_version"])
        self.assertEqual(1, len(listing["profiles"]))
        item = listing["profiles"][0]
        self.assertEqual(PROFILE_ID, item["profile_id"])
        self.assertEqual("verified", item["status"])
        self.assertEqual(MODULE_SHA, item["module_sha256"])
        self.assertEqual(1547, item["module_bytes"])
        self.assertEqual(7, item["interface_count"])
        self.assertTrue(item["limited"])
        # The workbench step editor builds its interface dropdown from the
        # projection, so the full validated interfaces must be present.
        interfaces = item["interfaces"]
        self.assertEqual(7, len(interfaces))
        self.assertLessEqual(len(interfaces), 32)
        self.assertEqual(
            ["reset", "bus_register", "stub_route", "bus_unregister", "bus_send", "bus_irq", "set_platform_stub"],
            [interface["name"] for interface in interfaces],
        )
        self.assertEqual(
            {
                "name": "bus_send",
                "params": [
                    {"name": "channel", "type": "u32", "min": 0, "max": 3},
                    {"name": "length", "type": "u32", "min": 0, "max": 65535},
                ],
                "returns": "i32",
                "role": "entry",
                "entry_id": "f_afa8298f2d197e5fd110e49a",
            },
            interfaces[4],
        )
        stub_control = next(
            interface for interface in interfaces if interface["role"] == "stub_control"
        )
        self.assertEqual("set_platform_stub", stub_control["name"])
        self.assertIsNone(stub_control["entry_id"])
        self.assertEqual("void", stub_control["returns"])
        for interface in interfaces:
            self.assertIn(interface["role"], {"entry", "stub_control", "util"})
            self.assertIn(interface["returns"], {"i32", "void"})
            self.assertIsInstance(interface["params"], list)
            self.assertLessEqual(len(interface["params"]), 8)
            for param in interface["params"]:
                self.assertEqual(
                    {"name", "type", "min", "max"}, set(param.keys())
                )
        self.assertEqual(
            {"steps": 20, "events_per_step": 256, "timeout_ms": 10000},
            item["limits"],
        )
        self.assertEqual(19, len(item["trace_events"]))
        self.assertEqual(7, item["trace_events"]["WRITE"])
        # Stable order: repeated listings are byte-identical for the projection.
        again = scenario.sim_profile_list(self.env.state, WORKSPACE_ID)
        self.assertEqual(
            json.dumps(interfaces, ensure_ascii=False),
            json.dumps(again["profiles"][0]["interfaces"], ensure_ascii=False),
        )
        self.assertEqual([], listing["gaps"])
        self.assert_no_absolute_paths(listing)
        self.expect_error(
            "NOT_FOUND",
            lambda: scenario.sim_profile_list(self.env.state, "no-such-workspace"),
        )

    def test_tampered_state_profile_is_invalid_and_module_read_fails(self) -> None:
        plan = self.make_plan()
        profile_dir = self.env.state.state_root / "sim" / PROFILE_ID / f"{MODULE_SHA}.wasm"
        original = profile_dir.read_bytes()
        profile_dir.write_bytes(original + b"\x00")
        listing = scenario.sim_profile_list(self.env.state, WORKSPACE_ID)
        self.assertEqual("invalid", listing["profiles"][0]["status"])
        self.assertIn("sim_profile_invalid", {gap["code"] for gap in listing["gaps"]})
        self.expect_error(
            "STALE_SOURCE", lambda: scenario.scenario_module(self.env.state, plan["plan_id"])
        )
        profile_dir.write_bytes(original)
        self.assertEqual(
            MODULE_SHA, hashlib.sha256(profile_dir.read_bytes()).hexdigest()
        )

        record_path = self.env.state.state_root / "sim" / PROFILE_ID / "profile.json"
        record = json.loads(record_path.read_text(encoding="utf-8"))
        record["profile"]["label"] = "tampered"
        record_path.write_text(json.dumps(record), encoding="utf-8")
        self.expect_error(
            "SCOPE_DENIED",
            lambda: scenario.scenario_plan(
                self.env.state,
                WORKSPACE_ID,
                self.snapshot_id,
                PROFILE_ID,
                self.scenario_b64(),
            ),
        )


class PlanTest(ScenarioTestBase):
    def test_plan_projection(self) -> None:
        plan = self.make_plan()
        self.assertEqual(1, plan["schema_version"])
        self.assertEqual(PROFILE_ID, plan["profile_id"])
        self.assertEqual(MODULE_SHA, plan["module_sha256"])
        self.assertRegex(plan["scenario_id"], r"^scn_[0-9a-f]{12}$")
        self.assertRegex(plan["scenario_digest"], r"^[0-9a-f]{64}$")
        self.assertEqual(1, plan["generation"])
        self.assertEqual(
            ["reset", "bus_register", "set_platform_stub", "bus_send"],
            [step["interface"] for step in plan["steps"]],
        )
        self.assertEqual(
            ["util", "entry", "stub_control", "entry"],
            [step["role"] for step in plan["steps"]],
        )
        self.assertEqual([0, 1, 2, 3], [step["index"] for step in plan["steps"]])
        self.assertEqual(
            {"timeout_ms": 10000, "steps": 20, "events_per_step": 256},
            plan["limits"],
        )
        self.assertEqual(19, len(plan["trace"]["events"]))
        self.assertTrue(plan["expires_at"].endswith("Z"))
        self.assertTrue(plan["limitations"])
        self.assert_no_absolute_paths(plan)

    def test_plan_host_run_generation_semantics(self) -> None:
        # Host scenario.run re-validates a previously previewed generation: the
        # scenario carries the generation to write and --expected-generation the
        # same value; the ledger must still be one generation behind.
        plan = scenario.scenario_plan(
            self.env.state,
            WORKSPACE_ID,
            self.snapshot_id,
            PROFILE_ID,
            self.scenario_b64(generation=1),
            expected_generation=1,
        )
        self.assertEqual(1, plan["generation"])
        record = self.record(plan)
        self.assertEqual(1, record["generation"])
        second = scenario.scenario_plan(
            self.env.state,
            WORKSPACE_ID,
            self.snapshot_id,
            PROFILE_ID,
            self.scenario_b64(generation=2),
            expected_generation=2,
        )
        self.assertEqual(2, second["generation"])
        self.expect_error(
            "STATE_CONFLICT",
            lambda: scenario.scenario_plan(
                self.env.state,
                WORKSPACE_ID,
                self.snapshot_id,
                PROFILE_ID,
                self.scenario_b64(generation=3),
                expected_generation=3,
            ),
        )

    def test_plan_scenario_id_is_stable(self) -> None:
        first = self.make_plan()
        second = self.make_plan()
        self.assertEqual(first["scenario_id"], second["scenario_id"])
        self.assertEqual(first["scenario_digest"], second["scenario_digest"])
        self.assertNotEqual(first["plan_id"], second["plan_id"])
        different = self.make_plan(steps=[{"interface": "reset", "args": []}])
        self.assertNotEqual(first["scenario_id"], different["scenario_id"])

    def test_plan_scenario_validation(self) -> None:
        def plan_with(document: Any) -> Dict[str, Any]:
            return scenario.scenario_plan(
                self.env.state,
                WORKSPACE_ID,
                self.snapshot_id,
                PROFILE_ID,
                base64.b64encode(json.dumps(document).encode()).decode(),
            )

        self.expect_error(
            "INVALID_ARGUMENT",
            lambda: scenario.scenario_plan(
                self.env.state, WORKSPACE_ID, self.snapshot_id, PROFILE_ID, "not-base64!!"
            ),
        )
        padded = json.dumps(
            {"generation": 0, "stop_on_error": True, "steps": [], "padding": " " * 9000},
            separators=(",", ":"),
        )
        # Decoded payload exceeds the 8 KiB scenario budget.
        self.assertGreater(len(padded.encode()), 8192)
        large = {"generation": 0, "stop_on_error": True, "steps": []}
        raw_large = ('{"generation":0,"stop_on_error":true,"steps":[],"x":' + '"' + "a" * 9000 + '"}')
        self.expect_error(
            "LIMIT_EXCEEDED",
            lambda: scenario.scenario_plan(
                self.env.state,
                WORKSPACE_ID,
                self.snapshot_id,
                PROFILE_ID,
                base64.b64encode(raw_large.encode()).decode(),
            ),
        )
        self.expect_error(
            "INVALID_ARGUMENT",
            lambda: plan_with({"generation": 0, "stop_on_error": True, "steps": [{"interface": "unknown", "args": []}]}),
        )
        self.expect_error(
            "INVALID_ARGUMENT",
            lambda: plan_with({"generation": 0, "stop_on_error": True, "steps": [{"interface": "bus_register", "args": []}]}),
        )
        self.expect_error(
            "INVALID_ARGUMENT",
            lambda: plan_with({"generation": 0, "stop_on_error": True, "steps": [{"interface": "bus_register", "args": [4]}]}),
        )
        self.expect_error(
            "INVALID_ARGUMENT",
            lambda: plan_with({"generation": 0, "stop_on_error": True, "steps": [{"interface": "bus_register", "args": ["1"]}]}),
        )
        self.expect_error(
            "INVALID_ARGUMENT",
            lambda: plan_with({"generation": 0, "stop_on_error": True, "steps": [{"interface": "reset", "args": [], "extra": 1}]}),
        )
        self.expect_error(
            "INVALID_ARGUMENT",
            lambda: plan_with(
                {
                    "generation": 0,
                    "stop_on_error": True,
                    "steps": [{"interface": "reset", "args": []}] * 21,
                }
            ),
        )
        # Generation CAS: a brand new scenario ledger is at generation 0.
        conflict = self.expect_error(
            "STATE_CONFLICT",
            lambda: plan_with(
                {
                    "generation": 1,
                    "stop_on_error": True,
                    "steps": [{"interface": "reset", "args": []}],
                }
            ),
        )
        self.assertEqual(0, conflict.details["current_generation"])
        self.expect_error(
            "STATE_CONFLICT",
            lambda: scenario.scenario_plan(
                self.env.state,
                WORKSPACE_ID,
                self.snapshot_id,
                PROFILE_ID,
                self.scenario_b64(steps=[{"interface": "reset", "args": []}]),
                expected_generation=3,
            ),
        )
        self.expect_error(
            "NOT_FOUND",
            lambda: scenario.scenario_plan(
                self.env.state,
                WORKSPACE_ID,
                self.snapshot_id,
                "missing-profile",
                self.scenario_b64(),
            ),
        )
        extra_snapshot = self.import_extra_snapshot()
        self.expect_error(
            "INVALID_ARGUMENT",
            lambda: self.make_plan(snapshot_ref=extra_snapshot),
        )

    def test_plan_ttl_expiry_and_unknown_plan(self) -> None:
        with mock.patch.object(scenario, "PLAN_TTL_SECONDS", -1):
            expired = self.make_plan()
        self.expect_error(
            "STALE_PLAN",
            lambda: scenario.scenario_module(self.env.state, expired["plan_id"]),
        )
        self.expect_error(
            "STALE_PLAN",
            lambda: scenario.scenario_record(
                self.env.state,
                expired["plan_id"],
                self.b64_json({"records": self.make_records(expired)}),
                str(uuid.uuid4()),
            ),
        )
        self.expect_error(
            "INVALID_ARGUMENT",
            lambda: scenario.scenario_module(self.env.state, "not-a-plan"),
        )
        self.expect_error(
            "NOT_FOUND",
            lambda: scenario.scenario_module(self.env.state, "plan_" + "0" * 32),
        )

    def test_plan_module_payload(self) -> None:
        plan = self.make_plan()
        module = scenario.scenario_module(self.env.state, plan["plan_id"])
        self.assertEqual(plan["module_sha256"], module["module_sha256"])
        self.assertEqual(1547, module["module_bytes"])
        raw = base64.b64decode(module["module_b64"])
        self.assertEqual(1547, len(raw))
        self.assertEqual(MODULE_SHA, hashlib.sha256(raw).hexdigest())
        self.assertEqual(PROFILE_ID, module["profile"]["profile_id"])
        self.assertEqual(19, len(module["trace"]["events"]))
        self.assertIn("WRITE", module["event_resources"])
        self.assertEqual(plan["limits"], module["limits"])
        self.assertEqual(plan["generation"], module["generation"])
        self.assert_no_absolute_paths(module)


class RecordTest(ScenarioTestBase):
    def test_record_writes_immutable_ledger_generation(self) -> None:
        plan = self.make_plan()
        ledger = self.record(plan)
        self.assertEqual(1, ledger["schema_version"])
        self.assertEqual(plan["scenario_id"], ledger["scenario_id"])
        self.assertEqual(1, ledger["generation"])
        self.assertEqual(PROFILE_ID, ledger["profile_id"])
        self.assertEqual(WORKSPACE_ID, ledger["workspace_id"])
        self.assertEqual(self.snapshot_id, ledger["snapshot_id"])
        self.assertEqual(plan["scenario_digest"], ledger["scenario_digest"])
        self.assertEqual(plan["plan_id"], ledger["plan_id"])
        self.assertEqual(MODULE_SHA, ledger["module_sha256"])
        self.assertRegex(ledger["records_digest"], r"^[0-9a-f]{64}$")
        self.assertTrue(ledger["observed"])
        self.assertEqual(["wasm_simulation_not_real_device"], ledger["limitations"])
        self.assertEqual(4, len(ledger["records"]))
        self.assertEqual(
            [f"call_1_{index + 1}" for index in range(4)],
            [record["call_id"] for record in ledger["records"]],
        )
        self.assertEqual(["reset", "bus_register", "set_platform_stub", "bus_send"],
                         [record["interface"] for record in ledger["records"]])
        stub_record = ledger["records"][2]
        self.assertTrue(stub_record["stubbed"])
        self.assertEqual(-5, stub_record["result"])
        bus_register_effects = ledger["records"][1]["affected_resources"]
        self.assertIn(
            {
                "resource_id": "s_0860e6738eaa8c95f37d0d03",
                "name": "routes",
                "access": "write",
                "field": "lane/max_len",
            },
            bus_register_effects,
        )
        bus_send_effects = ledger["records"][3]["affected_resources"]
        self.assertIn(
            {"resource_id": "s_48a2fcb62cdba6e1c7bf5528", "name": "simulated_doorbell", "access": "write"},
            bus_send_effects,
        )
        self.assertEqual(
            [f"ev_1_3_{index}" for index in range(11)],
            [event["event_id"] for event in ledger["records"][3]["execution_events"]],
        )
        self.assertEqual(util.digest(ledger["records"]), ledger["records_digest"])

        scenario_dir = self.env.state.state_root / "scenarios" / plan["scenario_id"]
        self.assertTrue((scenario_dir / "generation-1.json").is_file())
        current = json.loads((scenario_dir / "current.json").read_text(encoding="utf-8"))
        self.assertEqual(1, current["generation"])
        self.assertEqual(ledger["records_digest"], current["records_digest"])
        self.assertEqual(ledger, scenario.scenario_get(self.env.state, WORKSPACE_ID, plan["scenario_id"]))

        listing = scenario.scenario_list(self.env.state, WORKSPACE_ID)
        self.assertEqual(1, len(listing["scenarios"]))
        summary = listing["scenarios"][0]
        self.assertEqual(plan["scenario_id"], summary["scenario_id"])
        self.assertEqual(4, summary["step_count"])
        self.assertEqual(ledger["records_digest"], summary["records_digest"])
        self.assert_no_absolute_paths(ledger)
        self.assert_no_absolute_paths(listing)

    def test_record_alignment_and_value_validation(self) -> None:
        plan = self.make_plan()
        good = self.make_records(plan)

        def bad(mutator) -> None:
            records = json.loads(json.dumps(good))
            mutator(records)
            self.expect_error(
                "INVALID_ARGUMENT",
                lambda: scenario.scenario_record(
                    self.env.state,
                    plan["plan_id"],
                    self.b64_json({"records": records}),
                    str(uuid.uuid4()),
                ),
            )

        bad(lambda records: records.pop())
        bad(lambda records: records[0].update({"interface": "bus_send"}))
        bad(lambda records: records[0].update({"args": [1]}))
        bad(lambda records: records[0].update({"status": "maybe"}))
        bad(lambda records: records[1].update({"result": 1 << 32}))
        bad(lambda records: records[1].update({"memory_digest": "xyz"}))
        bad(lambda records: records[1]["events"][0].update({"event": "UNKNOWN"}))
        bad(lambda records: records[1]["events"][0].update({"a": 1 << 32}))
        bad(lambda records: records[1].update({"extra": True}))
        bad(lambda records: records[1]["events"][0].update({"extra": True}))
        bad(lambda records: records[1].update({"events": [records[1]["events"][0]] * 257}))

        huge = {"records": good, "padding": " " * (40 * 1024)}
        self.expect_error(
            "LIMIT_EXCEEDED",
            lambda: scenario.scenario_record(
                self.env.state,
                plan["plan_id"],
                base64.b64encode(json.dumps(huge).encode()).decode(),
                str(uuid.uuid4()),
            ),
        )
        self.expect_error(
            "INVALID_ARGUMENT",
            lambda: scenario.scenario_record(
                self.env.state,
                plan["plan_id"],
                self.b64_json({"records": good, "extra": 1}),
                str(uuid.uuid4()),
            ),
        )
        self.expect_error(
            "INVALID_ARGUMENT",
            lambda: scenario.scenario_record(
                self.env.state,
                "not-a-plan",
                self.b64_json({"records": good}),
                str(uuid.uuid4()),
            ),
        )

    def test_record_generation_cas_idempotency_and_immutability(self) -> None:
        plan = self.make_plan()
        operation = str(uuid.uuid4())
        first = self.record(plan, operation_id=operation)
        replay = self.record(plan, operation_id=operation)
        self.assertEqual(first, replay)
        generation_one_bytes = (
            self.env.state.state_root
            / "scenarios"
            / plan["scenario_id"]
            / "generation-1.json"
        ).read_bytes()

        changed = self.make_records(plan, results={3: -2}, statuses={3: "error"})
        self.expect_error(
            "OPERATION_CONFLICT",
            lambda: self.record(plan, changed, operation_id=operation),
        )
        self.expect_error(
            "STATE_CONFLICT", lambda: self.record(plan, changed)
        )

        # A new plan for the same scenario must use the new current generation.
        self.expect_error(
            "STATE_CONFLICT",
            lambda: scenario.scenario_plan(
                self.env.state,
                WORKSPACE_ID,
                self.snapshot_id,
                PROFILE_ID,
                self.scenario_b64(),
            ),
        )
        second_plan = scenario.scenario_plan(
            self.env.state,
            WORKSPACE_ID,
            self.snapshot_id,
            PROFILE_ID,
            self.scenario_b64(generation=1),
            expected_generation=1,
        )
        self.assertEqual(2, second_plan["generation"])
        second = self.record(second_plan, self.make_records(second_plan))
        self.assertEqual(2, second["generation"])
        self.assertEqual(first["scenario_id"], second["scenario_id"])
        self.assertEqual(
            generation_one_bytes,
            (
                self.env.state.state_root
                / "scenarios"
                / plan["scenario_id"]
                / "generation-1.json"
            ).read_bytes(),
        )
        latest = scenario.scenario_get(self.env.state, WORKSPACE_ID, plan["scenario_id"])
        self.assertEqual(2, latest["generation"])

        # A tampered ledger generation is refused on read.
        path = (
            self.env.state.state_root
            / "scenarios"
            / plan["scenario_id"]
            / "generation-2.json"
        )
        tampered = json.loads(path.read_text(encoding="utf-8"))
        tampered["records"][0]["result"] = 99
        path.write_text(json.dumps(tampered), encoding="utf-8")
        self.expect_error(
            "STALE_SOURCE",
            lambda: scenario.scenario_get(self.env.state, WORKSPACE_ID, plan["scenario_id"]),
        )


class ObservedSequenceTest(ScenarioTestBase):
    def test_observed_sequence_from_real_profile_ledger(self) -> None:
        plan = self.make_plan()
        ledger = self.record(plan)
        payload = scenario.view_sequence_observed(
            self.env.state, WORKSPACE_ID, ledger["scenario_id"]
        )
        self.assertEqual(1, payload["schema_version"])
        self.assertEqual("observed", payload["mode"])
        self.assertTrue(payload["observed"])
        self.assertIsNone(payload["warning"])
        self.assertEqual(
            ["caller", "driver", "resource", "platform"],
            [item["participant_id"] for item in payload["participants"]],
        )
        scenario_block = payload["scenario"]
        self.assertEqual(ledger["scenario_id"], scenario_block["scenario_id"])
        self.assertEqual(1, scenario_block["generation"])
        self.assertEqual(ledger["records_digest"], scenario_block["records_digest"])
        self.assertEqual(
            ["observed_wasm_simulation_not_real_device"], payload["limitations"]
        )
        self.assertEqual([], payload["gaps"])
        self.assertFalse(payload["truncated"])
        message_ids = [message["message_id"] for message in payload["messages"]]
        self.assertEqual([f"m_{index + 1}" for index in range(len(message_ids))], message_ids)
        kinds = {message["kind"] for message in payload["messages"]}
        self.assertTrue({"call", "return", "access", "event"} <= kinds)
        labels = [message["label"] or "" for message in payload["messages"]]
        self.assertIn("bus_send(1, 48)", labels)
        event_names = {message["event"] for message in payload["messages"] if message["event"]}
        self.assertIn("WRITE", event_names)
        self.assertIn("DOORBELL", event_names)
        write_message = next(
            message for message in payload["messages"] if message["event"] == "WRITE"
        )
        self.assertEqual("platform", write_message["to"])
        self.assertIn(
            {"resource_id": "s_48a2fcb62cdba6e1c7bf5528", "name": "simulated_doorbell", "access": "write"},
            write_message["affected_resources"],
        )
        stub_message = next(
            message
            for message in payload["messages"]
            if (message["label"] or "").startswith("set_platform_stub")
        )
        self.assertTrue(stub_message.get("stubbed"))
        error_return = next(
            message
            for message in payload["messages"]
            if message["kind"] == "error" and (message["label"] or "") == "返回 -5"
        )
        self.assertEqual("driver", error_return["from"])
        self.assertEqual("caller", error_return["to"])
        bus_send_call = next(
            message for message in payload["messages"]
            if (message["label"] or "") == "bus_send(1, 48)"
        )
        self.assertEqual(
            {"function_id": "f_afa8298f2d197e5fd110e49a", "file": "bus.c", "line": 152},
            bus_send_call["source_ref"],
        )
        final_return = payload["messages"][-1]
        self.assertEqual("return", final_return["kind"])
        self.assertEqual(0, final_return["result"])
        self.assert_no_absolute_paths(payload)

        repeated = scenario.view_sequence_observed(
            self.env.state, WORKSPACE_ID, ledger["scenario_id"]
        )
        self.assertEqual(
            json.dumps(payload, ensure_ascii=False, sort_keys=True),
            json.dumps(repeated, ensure_ascii=False, sort_keys=True),
        )

    def test_observed_sequence_error_status(self) -> None:
        steps = [{"interface": "bus_send", "args": [0, 48]}]
        plan = self.make_plan(steps=steps)
        records = self.make_records(
            plan,
            results={0: -2},
            statuses={0: "error"},
            events_by_step={0: [{"event": "INVALID", "code": 8, "a": 0, "b": 48, "c": 0, "line": 157}]},
        )
        ledger = self.record(plan, records)
        self.assertEqual("error", ledger["records"][0]["status"])
        payload = scenario.view_sequence_observed(
            self.env.state, WORKSPACE_ID, ledger["scenario_id"]
        )
        error_message = payload["messages"][-1]
        self.assertEqual("error", error_message["kind"])
        self.assertEqual(-2, error_message["result"])
        self.assertIn("-2", error_message["label"])
        self.assert_no_absolute_paths(payload)

    def test_observed_sequence_truncation_and_unknown(self) -> None:
        plan = self.make_plan()
        ledger = self.record(plan)
        with mock.patch.object(scenario, "MAX_OBSERVED_MESSAGES", 4):
            payload = scenario.view_sequence_observed(
                self.env.state, WORKSPACE_ID, ledger["scenario_id"]
            )
        self.assertEqual(4, len(payload["messages"]))
        self.assertTrue(payload["truncated"])
        self.assertIn("sequence_truncated", {gap["code"] for gap in payload["gaps"]})

        self.expect_error(
            "NOT_FOUND",
            lambda: scenario.view_sequence_observed(
                self.env.state, WORKSPACE_ID, "scn_000000000000"
            ),
        )
        self.expect_error(
            "INVALID_ARGUMENT",
            lambda: scenario.view_sequence_observed(
                self.env.state, WORKSPACE_ID, "not-a-scenario"
            ),
        )


class ScenarioCliTest(ScenarioTestBase):
    def test_cli_full_flow(self) -> None:
        payload = self.read_profile_payload()
        payload["profile_id"] = "bus-demo-copy"
        payload["label"] = "CLI copy profile"
        name = self.write_inbox_profile(payload, "sim-profile-copy.json")
        imported = self.cli_json(
            "sim-profile-import",
            "--workspace",
            WORKSPACE_ID,
            "--variant",
            VARIANT_ID,
            "--repo",
            REPO_ID,
            "--profile",
            name,
            "--operation-id",
            str(uuid.uuid4()),
        )
        self.assertEqual("bus-demo-copy", imported["profile_id"])
        listing = self.cli_json("sim-profile-list", "--workspace", WORKSPACE_ID)
        self.assertIn(
            "bus-demo-copy", [item["profile_id"] for item in listing["profiles"]]
        )
        plan = self.cli_json(
            "scenario-plan",
            "--workspace",
            WORKSPACE_ID,
            "--snapshot",
            self.snapshot_id,
            "--profile",
            "bus-demo-copy",
            "--scenario-json",
            self.scenario_b64(),
            "--expected-generation",
            "0",
        )
        self.assertEqual(1, plan["generation"])
        module = self.cli_json("scenario-module", "--plan", plan["plan_id"])
        self.assertEqual(MODULE_SHA, module["module_sha256"])
        records = self.make_records(plan)
        ledger = self.cli_json(
            "scenario-record",
            "--plan",
            plan["plan_id"],
            "--records-json",
            self.b64_json({"records": records}),
            "--operation-id",
            str(uuid.uuid4()),
        )
        self.assertEqual(1, ledger["generation"])
        scenario_id = ledger["scenario_id"]
        got = self.cli_json(
            "scenario-get", "--workspace", WORKSPACE_ID, "--scenario", scenario_id
        )
        self.assertEqual(ledger["records_digest"], got["records_digest"])
        summaries = self.cli_json("scenario-list", "--workspace", WORKSPACE_ID)
        self.assertIn(
            scenario_id, [item["scenario_id"] for item in summaries["scenarios"]]
        )
        observed = self.cli_json(
            "view-sequence-observed",
            "--workspace",
            WORKSPACE_ID,
            "--scenario",
            scenario_id,
        )
        self.assertTrue(observed["observed"])
        self.assertEqual("observed", observed["mode"])
        self.assert_no_absolute_paths(observed)

    def test_cli_error_envelopes(self) -> None:
        completed = helpers.run_cli(
            self.env.bootstrap_path,
            "scenario-module",
            "--plan",
            "not-a-plan",
            expect=2,
        )
        self.assertEqual(
            "INVALID_ARGUMENT", json.loads(completed.stdout)["error"]["code"]
        )
        completed = helpers.run_cli(
            self.env.bootstrap_path,
            "scenario-get",
            "--workspace",
            WORKSPACE_ID,
            "--scenario",
            "scn_000000000000",
            expect=2,
        )
        self.assertEqual("NOT_FOUND", json.loads(completed.stdout)["error"]["code"])

class UndoTailTest(ScenarioTestBase):
    def test_undo_plan_and_happy_path(self) -> None:
        _plan, source_records, source = self.source_scenario(UNDO_STEPS)
        self.assertEqual(1, source["generation"])
        undo = self.undo_plan(source, 1)
        self.assertEqual(1, undo["schema_version"])
        self.assertEqual("undo", undo["kind"])
        self.assertRegex(undo["undo_plan_id"], r"^undo_[0-9a-f]{32}$")
        self.assertEqual(
            {
                "scenario_id": source["scenario_id"],
                "generation": 1,
                "step_count": 3,
            },
            undo["source"],
        )
        self.assertEqual(1, undo["count"])
        prefix = undo["prefix"]
        self.assertRegex(prefix["scenario_id"], r"^scn_[0-9a-f]{12}$")
        self.assertEqual(1, prefix["generation"])
        self.assertEqual(2, prefix["step_count"])
        self.assertEqual(
            [
                {"index": 0, "interface": "reset", "args": []},
                {"index": 1, "interface": "bus_register", "args": [1]},
            ],
            prefix["steps"],
        )
        self.assertRegex(prefix["scenario_digest"], r"^[0-9a-f]{64}$")
        self.assertRegex(prefix["expected_records_digest"], r"^[0-9a-f]{64}$")
        self.assertEqual(2, len(undo["expected_prefix"]))
        for index, expected in enumerate(undo["expected_prefix"]):
            self.assertEqual(index, expected["step_index"])
            self.assertEqual(source_records[index]["memory_digest"], expected["memory_digest"])
            self.assertEqual(source_records[index]["result"], expected["result"])
            self.assertEqual(source_records[index]["status"], expected["status"])
        self.assertEqual(MODULE_SHA, undo["module_sha256"])
        self.assertEqual(
            {"timeout_ms": 10000, "steps": 20, "events_per_step": 256},
            undo["limits"],
        )
        self.assertEqual(
            ["replay_verified_by_memory_digest", "wasm_simulation_not_real_device"],
            undo["limitations"],
        )
        self.assertTrue(undo["expires_at"].endswith("Z"))

        repeated = self.undo_plan(source, 1)
        self.assertEqual(prefix["scenario_id"], repeated["prefix"]["scenario_id"])
        self.assertNotEqual(undo["undo_plan_id"], repeated["undo_plan_id"])

        module = scenario.scenario_module(self.env.state, undo["undo_plan_id"])
        self.assertEqual("undo", module["kind"])
        self.assertEqual(MODULE_SHA, module["module_sha256"])
        self.assertEqual(1547, len(base64.b64decode(module["module_b64"])))
        self.assertEqual(prefix["scenario_id"], module["prefix"]["scenario_id"])
        self.assertEqual(2, len(module["prefix"]["steps"]))

        replay_records = json.loads(json.dumps(source_records[:2]))
        operation = str(uuid.uuid4())
        ledger = self.undo_record(undo, replay_records, operation_id=operation)
        self.assertEqual(
            ledger, self.undo_record(undo, replay_records, operation_id=operation)
        )
        self.expect_error(
            "OPERATION_CONFLICT",
            lambda: self.undo_record(
                undo, replay_records[:1], operation_id=operation
            ),
        )
        self.assertEqual(prefix["scenario_id"], ledger["scenario_id"])
        self.assertEqual(1, ledger["generation"])
        self.assertEqual(2, len(ledger["records"]))
        self.assertEqual(
            {
                "of_scenario_id": source["scenario_id"],
                "of_generation": 1,
                "count": 1,
                "state_digest_verified": True,
            },
            ledger["undo"],
        )
        self.assertEqual(
            ["replay_verified_by_memory_digest", "wasm_simulation_not_real_device"],
            ledger["limitations"],
        )
        self.assertEqual(undo["undo_plan_id"], ledger["plan_id"])
        self.assertEqual(MODULE_SHA, ledger["module_sha256"])
        self.assertEqual(prefix["scenario_digest"], ledger["scenario_digest"])
        self.assertEqual(util.digest(ledger["records"]), ledger["records_digest"])
        prefix_current = scenario.scenario_get(
            self.env.state, WORKSPACE_ID, prefix["scenario_id"]
        )
        self.assertEqual(ledger, prefix_current)
        summaries = scenario.scenario_list(self.env.state, WORKSPACE_ID)
        summary = next(
            item for item in summaries["scenarios"]
            if item["scenario_id"] == prefix["scenario_id"]
        )
        self.assertEqual(2, summary["step_count"])
        self.assertEqual(ledger["undo"], summary["undo"])
        # Source ledger is untouched and remains readable.
        source_after = scenario.scenario_get(
            self.env.state, WORKSPACE_ID, source["scenario_id"]
        )
        self.assertEqual(3, len(source_after["records"]))
        self.assertEqual(1, source_after["generation"])
        self.assert_no_absolute_paths(undo)
        self.assert_no_absolute_paths(ledger)

    def test_undo_digest_mismatch_does_not_publish(self) -> None:
        _plan, source_records, source = self.source_scenario(UNDO_STEPS)
        undo = self.undo_plan(source, 1)
        replay_records = json.loads(json.dumps(source_records[:2]))
        replay_records[1]["memory_digest"] = "ff" * 32
        error = self.expect_error(
            "STATE_CONFLICT", lambda: self.undo_record(undo, replay_records)
        )
        self.assertEqual("state_digest_mismatch", error.details["code"])
        self.assertEqual("state_digest_mismatch", error.details["reason_code"])
        self.assertEqual(1, error.details["step_index"])
        self.assertEqual(source_records[1]["memory_digest"], error.details["expected"])
        self.assertEqual("ff" * 32, error.details["actual"])
        self.assertEqual(
            [source_records[0]["memory_digest"], source_records[1]["memory_digest"]],
            error.details["expected_prefix"],
        )
        self.assertEqual(
            [source_records[0]["memory_digest"], "ff" * 32],
            error.details["actual_prefix"],
        )
        prefix_dir = (
            self.env.state.state_root / "scenarios" / undo["prefix"]["scenario_id"]
        )
        self.assertFalse((prefix_dir / "current.json").exists())
        self.assertFalse((prefix_dir / "generation-1.json").exists())
        # A corrected replay can still publish; the failed attempt left no state.
        good_records = json.loads(json.dumps(source_records[:2]))
        ledger = self.undo_record(undo, good_records)
        self.assertEqual(1, ledger["generation"])
        self.assertTrue(ledger["undo"]["state_digest_verified"])

    def test_undo_empty_prefix_and_prefix_generation_cas(self) -> None:
        _plan, _records, source = self.source_scenario(UNDO_STEPS)
        empty = self.undo_plan(source, 3)
        self.assertEqual(0, empty["prefix"]["step_count"])
        self.assertEqual([], empty["prefix"]["steps"])
        self.assertEqual([], empty["expected_prefix"])
        empty_ledger = self.undo_record(empty, [])
        self.assertEqual(0, len(empty_ledger["records"]))
        self.assertEqual(3, empty_ledger["undo"]["count"])
        self.assertTrue(empty_ledger["undo"]["state_digest_verified"])

        # Run the prefix as its own scenario first, then undo onto its ledger.
        prefix_steps = UNDO_STEPS[:2]
        _prefix_plan, prefix_records, prefix_ledger = self.source_scenario(prefix_steps)
        undo = self.undo_plan(source, 1)
        self.assertEqual(prefix_ledger["scenario_id"], undo["prefix"]["scenario_id"])
        self.assertEqual(2, undo["prefix"]["generation"])
        replay_records = json.loads(json.dumps(prefix_records))
        competing_undo = self.undo_plan(source, 1)
        appended = self.undo_record(undo, replay_records)
        self.assertEqual(prefix_ledger["scenario_id"], appended["scenario_id"])
        self.assertEqual(2, appended["generation"])
        self.assertEqual(source["scenario_id"], appended["undo"]["of_scenario_id"])
        self.assertEqual(1, appended["undo"]["of_generation"])
        generation_one = (
            self.env.state.state_root
            / "scenarios"
            / prefix_ledger["scenario_id"]
            / "generation-1.json"
        ).read_bytes()
        self.assertIn(b'"generation": 1', generation_one)
        # Both undo plans targeted prefix generation 2; after the first one
        # published it, the second plan's CAS is stale and nothing is written.
        self.assertEqual(2, competing_undo["prefix"]["generation"])
        self.expect_error(
            "STATE_CONFLICT", lambda: self.undo_record(competing_undo, replay_records)
        )
        self.assertEqual(
            generation_one,
            (
                self.env.state.state_root
                / "scenarios"
                / prefix_ledger["scenario_id"]
                / "generation-1.json"
            ).read_bytes(),
        )

    def test_undo_validation_and_imported_ledgers(self) -> None:
        _plan, source_records, source = self.source_scenario(UNDO_STEPS)
        for count in (0, 4):
            self.expect_error("INVALID_ARGUMENT", lambda: self.undo_plan(source, count))
        self.expect_error(
            "STATE_CONFLICT",
            lambda: scenario.scenario_undo_plan(
                self.env.state,
                WORKSPACE_ID,
                source["scenario_id"],
                1,
                2,
            ),
        )
        self.expect_error(
            "NOT_FOUND",
            lambda: scenario.scenario_undo_plan(
                self.env.state, WORKSPACE_ID, "scn_000000000000", 1, 1
            ),
        )
        self.expect_error(
            "NOT_FOUND",
            lambda: scenario.scenario_undo_record(
                self.env.state,
                "plan_" + "0" * 32,
                self.b64_json({"records": []}),
                str(uuid.uuid4()),
            ),
        )
        undo = self.undo_plan(source, 1)
        self.expect_error(
            "INVALID_ARGUMENT",
            lambda: scenario.scenario_record(
                self.env.state,
                undo["undo_plan_id"],
                self.b64_json({"records": source_records[:2]}),
                str(uuid.uuid4()),
            ),
        )
        replay_records = json.loads(json.dumps(source_records[:2]))
        broken = json.loads(json.dumps(replay_records))
        broken[0]["interface"] = "bus_send"
        self.expect_error("INVALID_ARGUMENT", lambda: self.undo_record(undo, broken))
        self.expect_error(
            "INVALID_ARGUMENT", lambda: self.undo_record(undo, replay_records[:1])
        )
        self.expect_error(
            "NOT_FOUND",
            lambda: scenario.scenario_undo_record(
                self.env.state,
                "undo_" + "0" * 32,
                self.b64_json({"records": replay_records}),
                str(uuid.uuid4()),
            ),
        )
        with mock.patch.object(scenario, "PLAN_TTL_SECONDS", -1):
            expired = self.undo_plan(source, 1)
        self.expect_error(
            "STALE_PLAN", lambda: self.undo_record(expired, replay_records)
        )

        imported = self.import_trace()
        self.expect_error(
            "CAPABILITY_UNAVAILABLE",
            lambda: scenario.scenario_undo_plan(
                self.env.state,
                WORKSPACE_ID,
                imported["scenario_id"],
                1,
                1,
            ),
        )


class TraceImportTest(ScenarioTestBase):
    def test_trace_import_projection_and_observed(self) -> None:
        fixture = self.trace_payload()
        ledger = self.import_trace()
        self.assertRegex(ledger["scenario_id"], r"^scn_[0-9a-f]{12}$")
        self.assertEqual(1, ledger["generation"])
        self.assertTrue(ledger["imported"])
        self.assertEqual("imported_trace", ledger["source"])
        self.assertEqual(fixture["label"], ledger["label"])
        self.assertEqual(fixture["metadata"], ledger["metadata"])
        self.assertTrue(ledger["observed"])
        self.assertEqual(PROFILE_ID, ledger["profile_id"])
        self.assertEqual(MODULE_SHA, ledger["module_sha256"])
        self.assertIsNone(ledger["plan_id"])
        self.assertEqual(
            [
                "imported_trace_not_executed_by_host",
                "resource_effects_unknown_for_imported_trace",
            ],
            ledger["limitations"],
        )
        self.assertEqual(3, len(ledger["records"]))
        self.assertEqual(
            ["call_1_1", "call_1_2", "call_1_3"],
            [record["call_id"] for record in ledger["records"]],
        )
        self.assertEqual(
            ["reset", "bus_register", "bus_send"],
            [record["interface"] for record in ledger["records"]],
        )
        self.assertEqual([1, 48], ledger["records"][2]["args"])
        self.assertEqual(
            fixture["steps"][2]["memory_digest"], ledger["records"][2]["memory_digest"]
        )
        for record in ledger["records"]:
            self.assertEqual([], record["affected_resources"])
            self.assertFalse(record["stubbed"])
        self.assertEqual(
            util.digest(ledger["records"]), ledger["records_digest"]
        )
        self.assertFalse(
            (self.env.state.state_root / "scenarios" / ledger["scenario_id"] / "generation-2.json").exists()
        )

        got = scenario.scenario_get(self.env.state, WORKSPACE_ID, ledger["scenario_id"])
        self.assertEqual(ledger, got)
        summaries = scenario.scenario_list(self.env.state, WORKSPACE_ID)
        summary = next(
            item for item in summaries["scenarios"]
            if item["scenario_id"] == ledger["scenario_id"]
        )
        self.assertTrue(summary["imported"])
        self.assertEqual(ledger["label"], summary["label"])
        self.assertEqual(3, summary["step_count"])

        observed = scenario.view_sequence_observed(
            self.env.state, WORKSPACE_ID, ledger["scenario_id"]
        )
        self.assertTrue(observed["observed"])
        self.assertTrue(observed["imported"])
        self.assertEqual(ledger["label"], observed["label"])
        self.assertIsNone(observed["warning"])
        self.assertEqual(ledger["limitations"], observed["limitations"])
        self.assertTrue(all(message["imported"] for message in observed["messages"]))
        labels = [message["label"] or "" for message in observed["messages"]]
        self.assertIn("bus_send(1, 48)", labels)
        event_names = {
            message["event"] for message in observed["messages"] if message["event"]
        }
        self.assertIn("DOORBELL", event_names)
        self.assertIn("WRITE", event_names)
        write_message = next(
            message for message in observed["messages"] if message["event"] == "WRITE"
        )
        self.assertEqual("platform", write_message["to"])
        self.assertEqual([], write_message["affected_resources"])
        self.assertEqual("imported_trace_not_executed_by_host", observed["limitations"][0])
        final_return = observed["messages"][-1]
        self.assertEqual("return", final_return["kind"])
        self.assertEqual(0, final_return["result"])
        self.assert_no_absolute_paths(ledger)
        self.assert_no_absolute_paths(observed)

    def test_trace_import_idempotent_and_without_profile(self) -> None:
        first = self.import_trace()
        second = self.import_trace()
        self.assertEqual(first, second)
        self.assertEqual(1, second["generation"])

        payload = self.trace_payload()
        payload.pop("profile_id")
        payload["label"] = "imported trace without profile"
        payload["steps"][2]["args"] = [1, 49]
        name = self.write_inbox_json("trace-no-profile.json", payload)
        ledger = self.import_trace(name)
        self.assertIsNone(ledger["profile_id"])
        self.assertIsNone(ledger["module_sha256"])
        observed = scenario.view_sequence_observed(
            self.env.state, WORKSPACE_ID, ledger["scenario_id"]
        )
        self.assertTrue(observed["imported"])
        self.assertEqual(ledger["label"], observed["label"])
        self.assertIn("bus_send(1, 49)", [m["label"] or "" for m in observed["messages"]])
        self.assert_no_absolute_paths(observed)

    def test_trace_import_validation_errors(self) -> None:
        base = self.trace_payload()

        def import_variant(payload: Dict[str, Any], name: str = "trace-variant.json") -> Dict[str, Any]:
            return self.import_trace(self.write_inbox_json(name, payload))

        def expect_invalid(code: str, mutator) -> None:
            payload = json.loads(json.dumps(base))
            mutator(payload)
            self.expect_error(code, lambda: import_variant(payload))

        expect_invalid("INVALID_ARGUMENT", lambda payload: payload.update({"snapshot_id": "f" * 32}))
        expect_invalid("UNSUPPORTED_SCHEMA", lambda payload: payload.update({"schema_version": 2}))
        expect_invalid("INVALID_ARGUMENT", lambda payload: payload.update({"kind": "trace"}))
        expect_invalid("INVALID_ARGUMENT", lambda payload: payload.update({"steps": []}))
        expect_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload.update({"steps": [payload["steps"][0]] * 201}),
        )
        expect_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload["steps"][0].update({"interface": "1bad"}),
        )
        expect_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload["steps"][0].update({"args": [1, 2, 3, 4, 5, 6, 7, 8, 9]}),
        )
        expect_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload["steps"][0].update({"result": 1 << 31}),
        )
        expect_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload["steps"][1]["events"][0].update({"code": "1"}),
        )
        expect_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload["steps"][0].update({"memory_digest": "xyz"}),
        )
        expect_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload["steps"][0].update({"elapsed_ms": -1}),
        )
        def too_many_events(payload: Dict[str, Any]) -> None:
            template = {
                "event": "WRITE",
                "code": 7,
                "a": 0,
                "b": 0,
                "c": 0,
                "line": 1,
            }
            payload["steps"][1]["events"] = [dict(template) for _ in range(257)]

        expect_invalid("INVALID_ARGUMENT", too_many_events)
        expect_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload.update({"metadata": {"nested": {"a": 1}}}),
        )
        expect_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload.update({"label": "C:\\secret\\trace.json"}),
        )
        expect_invalid(
            "INVALID_ARGUMENT",
            lambda payload: payload["metadata"].update({"note": "/var/log/trace"}),
        )
        expect_invalid(
            "NOT_FOUND",
            lambda payload: payload.update({"profile_id": "missing-profile"}),
        )

        big = json.dumps(base) + " " * (70 * 1024)
        (self.env.inbox_dir / "trace-big.json").write_text(big, encoding="utf-8")
        self.expect_error(
            "LIMIT_EXCEEDED", lambda: self.import_trace("trace-big.json")
        )
        self.expect_error(
            "NOT_FOUND", lambda: self.import_trace("trace-missing.json")
        )


class S3bCliTest(ScenarioTestBase):
    def test_trace_import_and_observed_cli(self) -> None:
        ledger = self.cli_json(
            "trace-import",
            "--workspace",
            WORKSPACE_ID,
            "--snapshot",
            self.snapshot_id,
            "--input",
            "trace-bus-send.json",
            "--operation-id",
            str(uuid.uuid4()),
        )
        self.assertTrue(ledger["imported"])
        observed = self.cli_json(
            "view-sequence-observed",
            "--workspace",
            WORKSPACE_ID,
            "--scenario",
            ledger["scenario_id"],
        )
        self.assertTrue(observed["imported"])
        self.assertIn(
            "bus_send(1, 48)", [message["label"] or "" for message in observed["messages"]]
        )
        completed = helpers.run_cli(
            self.env.bootstrap_path,
            "scenario-undo-plan",
            "--workspace",
            WORKSPACE_ID,
            "--scenario",
            ledger["scenario_id"],
            "--count",
            "1",
            "--expected-generation",
            "1",
            expect=2,
        )
        self.assertEqual(
            "CAPABILITY_UNAVAILABLE",
            json.loads(completed.stdout)["error"]["code"],
        )

    def test_undo_tail_cli(self) -> None:
        _plan, source_records, source = self.source_scenario(UNDO_STEPS)
        undo = self.cli_json(
            "scenario-undo-plan",
            "--workspace",
            WORKSPACE_ID,
            "--scenario",
            source["scenario_id"],
            "--count",
            "1",
            "--expected-generation",
            "1",
        )
        self.assertEqual("undo", undo["kind"])
        record = self.cli_json(
            "scenario-undo-record",
            "--plan",
            undo["undo_plan_id"],
            "--records-json",
            self.b64_json({"records": source_records[:2]}),
            "--operation-id",
            str(uuid.uuid4()),
        )
        self.assertEqual(undo["prefix"]["scenario_id"], record["scenario_id"])
        self.assertTrue(record["undo"]["state_digest_verified"])
        self.assertEqual(2, len(record["records"]))



if __name__ == "__main__":
    unittest.main()
