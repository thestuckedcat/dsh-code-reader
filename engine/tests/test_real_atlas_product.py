"""Real SDK Code Atlas 0.8.0 product fixtures (2026-11-08 cross-check).

The fixture pairs under ``fixtures/real-atlas/`` are unmodified Atlas output
from ``scripts/sdk_atlas.py`` (tool 0.8.0 / schema 0.1):

* ``quickstart`` — Atlas-bundled trusted example (``examples/quickstart-sdk``),
  analyzed by ``sdk_atlas.py quickstart``.
* ``mini`` — our own three-function C repository with a real clang compdb,
  analyzed by ``sdk_atlas.py run --interface submit``.

These tests pin the *real product shape* the synthetic fixtures cannot:
real graph payloads do not carry ``file``/``line`` on function entities (the
location lives on referenced evidence entities), ``coverage.selected_scope`` is
an object and extra optional fields exist.  See
``evidence/real-atlas/README.md`` for provenance, hashes and reproductions.
"""

from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path

from code_learning import atlas, paths

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "real-atlas"
CASES = {
    "quickstart": {
        "snapshot_id": "00fb39c133fa4841a64ec014fc0b5c18",
        "function": "sdk_entry",
        "line": 7,
        "file_suffix": "sdk.c",
        "call_count": 1,
        "flow_count": 3,
    },
    "mini": {
        "snapshot_id": "22a7c4d18126447688ea05faf45a3e65",
        "function": "submit",
        "line": 13,
        "file_suffix": "mini.c",
        "call_count": 2,
        "flow_count": 5,
    },
}


def load_case(name: str):
    base = FIXTURES / name
    graph_raw = (base / "graph.json").read_bytes()
    manifest_raw = (base / "analysis_manifest.json").read_bytes()
    return (
        graph_raw,
        manifest_raw,
        json.loads(graph_raw.decode("utf-8")),
        json.loads(manifest_raw.decode("utf-8")),
    )


class RealAtlasProductTest(unittest.TestCase):
    def test_envelopes_and_graph_hash_match_raw_bytes(self) -> None:
        for name, case in CASES.items():
            with self.subTest(name=name):
                graph_raw, _manifest_raw, graph_doc, manifest_doc = load_case(name)
                self.assertEqual("0.1", graph_doc["schema_version"])
                self.assertEqual("graph", graph_doc["record_kind"])
                self.assertEqual("0.1", manifest_doc["schema_version"])
                self.assertEqual("analysis_manifest", manifest_doc["record_kind"])
                payload = manifest_doc["payload"]
                self.assertEqual(case["snapshot_id"], payload["snapshot_id"])
                self.assertEqual(hashlib.sha256(graph_raw).hexdigest(), payload["graph_hash"])
                self.assertEqual("0.8.0", payload["tool_version"])
                self.assertTrue(payload["workspace_roots"])
                # Real Atlas coverage keeps failed/pending arrays and never claims whole-program completeness.
                coverage = payload["coverage"]
                self.assertIsInstance(coverage["failed"], list)
                self.assertIsInstance(coverage["pending_units"], list)
                self.assertFalse(coverage["whole_program_complete"])
                self.assertIsInstance(coverage["selected_scope"], dict)

    def test_real_payloads_pass_the_adapter_validators(self) -> None:
        for name in CASES:
            with self.subTest(name=name):
                _graph_raw, _manifest_raw, graph_doc, manifest_doc = load_case(name)
                atlas.validate_graph_payload(graph_doc["payload"])
                atlas.validate_manifest_payload(manifest_doc["payload"])
                projected = atlas.project_coverage(manifest_doc["payload"]["coverage"], "coverage")
                self.assertEqual(0, projected["failed_count"])
                self.assertIn("capabilities", projected)

    def test_real_functions_resolve_location_from_evidence(self) -> None:
        for name, case in CASES.items():
            with self.subTest(name=name):
                _graph_raw, _manifest_raw, graph_doc, _manifest_doc = load_case(name)
                payload = graph_doc["payload"]
                function = next(
                    item for item in payload["functions"] if item.get("name") == case["function"]
                )
                # Real Atlas 0.8 functions do not carry direct file/line fields.
                self.assertFalse(isinstance(function.get("file"), str) and function.get("file"))
                file_value, line_value = atlas.function_location(payload, function)
                self.assertIsNotNone(file_value)
                self.assertTrue(str(file_value).replace("\\", "/").endswith(case["file_suffix"]))
                self.assertEqual(case["line"], line_value)

    def test_path_node_projection_uses_real_location_and_edges(self) -> None:
        for name, case in CASES.items():
            with self.subTest(name=name):
                _graph_raw, _manifest_raw, graph_doc, manifest_doc = load_case(name)
                payload = graph_doc["payload"]
                bundle = {
                    "workspace_id": "fixture-workspace",
                    "repo_id": "fixture-repo",
                    "variant_id": "source-only-x86_64",
                    "snapshot_id": manifest_doc["payload"]["snapshot_id"],
                    "graph": payload,
                }
                function = next(
                    item for item in payload["functions"] if item.get("name") == case["function"]
                )
                node = paths._node_projection(bundle, function["id"])
                self.assertTrue(str(node["file"]).replace("\\", "/").endswith(case["file_suffix"]))
                self.assertEqual(case["line"], node["line"])
                self.assertEqual(case["call_count"], len(payload["call_targets"]))
                self.assertEqual(case["flow_count"], len(payload["flow_edges"]))
                # Real edges keep their compiler origin and exact/may certainty.
                for edge in payload["call_targets"]:
                    self.assertIn(edge["certainty"], {"exact", "may"})
                    self.assertEqual("deterministic_analysis", edge["origin"])
                    self.assertTrue(edge["callsite"] and edge["evidence_ids"])
                # Real flow edges project with certainty may (path-insensitive).
                for edge in payload["flow_edges"]:
                    self.assertIn(edge["certainty"], {"may", "exact", "unknown"})
                    self.assertTrue(edge.get("limitations"))

    def test_function_choice_reports_text_truncation(self) -> None:
        long_function = {"id": "f_long", "name": "n" * 5000, "display_name": "d" * 5000}
        choice = atlas.function_choice(long_function)
        self.assertEqual(4096, len(choice["name"]))
        self.assertIn("function_name_truncated", choice["limitations"])
        self.assertIn("function_display_name_truncated", choice["limitations"])
        # Without a payload there is no evidence to resolve a location from.
        self.assertIsNone(choice["file"])
        self.assertIsNone(choice["line"])


if __name__ == "__main__":
    unittest.main()
