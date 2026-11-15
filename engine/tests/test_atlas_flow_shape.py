"""Real Atlas 0.8 flow-shape regression (2026-11-15 read-only slice).

While importing the real Atlas snapshot of the Demo ``bus.c``/``platform.c``
(``evidence/code-view-slice``), the adapter rejected it because real Atlas
emits ``flow_edges`` for file-scope initializers whose ``owner`` is ``null``
and whose ``sources`` array is empty (literal/global initialization).  The
previous validator required both to be non-empty strings/arrays, which the
committed quickstart/mini fixtures did not exercise.

This test pins the real shape: identity fields stay required strings, ``owner``
may be ``null``, ``sources`` may be an empty array of ids, and the deterministic
safety checks still reject malformed edges.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from code_learning import atlas

REPO_ROOT = Path(__file__).resolve().parents[2]
REAL_SLICE = REPO_ROOT / "evidence" / "code-view-slice" / "snapshot" / "ed326d554334432b907de21297207eb8"


def base_graph(flow_edges):
    return {
        "functions": [
            {"id": "f_owner", "kind": "function", "name": "owner"},
        ],
        "types": [],
        "objects": [],
        "callsites": [],
        "call_targets": [],
        "evidence": [],
        "issues": [],
        "coverage": {},
        "scope": {},
        "flow_edges": flow_edges,
    }


def initializer_edge(**overrides):
    edge = {
        "id": "flow_init",
        "kind": "flow",
        "origin": "compiler",
        "owner": None,
        "sources": [],
        "target": "s_object",
        "relation": "initializer",
        "certainty": "may",
        "evidence_ids": ["e_init"],
        "limitations": ["path_insensitive", "alias_not_solved"],
    }
    edge.update(overrides)
    return edge


class RealAtlasFlowShapeTest(unittest.TestCase):
    def test_initializer_edge_with_null_owner_and_empty_sources_is_accepted(self) -> None:
        payload = base_graph([initializer_edge()])
        validated = atlas.validate_graph_payload(payload)
        self.assertIsNone(validated["flow_edges"][0]["owner"])
        self.assertEqual([], validated["flow_edges"][0]["sources"])

    def test_real_slice_snapshot_validates_when_present(self) -> None:
        graph_path = REAL_SLICE / "graph.json"
        manifest_path = REAL_SLICE / "analysis_manifest.json"
        if not graph_path.is_file():
            self.skipTest("real read-only slice snapshot is not present")
        graph_doc = json.loads(graph_path.read_text(encoding="utf-8"))
        manifest_doc = json.loads(manifest_path.read_text(encoding="utf-8"))
        payload = atlas.validate_graph_payload(graph_doc["payload"])
        manifest = atlas.validate_manifest_payload(manifest_doc["payload"])
        initializers = [
            edge for edge in payload["flow_edges"] if edge.get("relation") == "initializer"
        ]
        self.assertTrue(initializers, "real bus snapshot should record initializer flow edges")
        self.assertTrue(any(edge.get("owner") is None for edge in initializers))
        self.assertEqual(manifest["snapshot_id"], "ed326d554334432b907de21297207eb8")

    def test_malformed_flow_edges_are_still_rejected(self) -> None:
        cases = [
            initializer_edge(target=""),
            initializer_edge(owner=""),
            initializer_edge(owner=17),
            initializer_edge(sources="not-a-list"),
            initializer_edge(sources=[""]),
            initializer_edge(sources=[3]),
            initializer_edge(id=""),
            initializer_edge(certainty="certain"),
        ]
        for edge in cases:
            with self.subTest(edge=edge):
                with self.assertRaises(Exception):
                    atlas.validate_graph_payload(base_graph([edge]))

    def test_duplicate_flow_ids_are_rejected(self) -> None:
        payload = base_graph([initializer_edge(), initializer_edge()])
        with self.assertRaises(Exception):
            atlas.validate_graph_payload(payload)


if __name__ == "__main__":
    unittest.main()
