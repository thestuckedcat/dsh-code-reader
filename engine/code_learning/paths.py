"""Bounded call-path reconstruction and relation projection over Atlas snapshots.

Call paths are rebuilt from ``graph.payload.call_targets`` and joined back
through the callsite recorded on the trace line, so every emitted edge keeps
the original ``origin``/``certainty``/``evidence_ids`` of the Atlas fact.  A
path line never upgrades a ``may`` fact to ``exact``.

Cross-repository queries are only bridged by ``supported`` CrossRepoBindingV1
entries; the bridge is emitted as ``abi_bridge`` with ``certainty='may'`` and
``origin='derived'``.  No call edge is ever invented across repositories.

Relation queries validate the design §5 selector exclusivity table up front.
When the snapshot lacks the analysis capability, ``status='unavailable'`` plus
``unknowns`` is returned instead of fabricating (or silently downgrading to)
legacy data.
"""

from __future__ import annotations

import time
from collections import deque
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from . import atlas, snapshot, util, validation
from .errors import fail

DIRECTIONS = ("down", "up")
RELATION_MODES = ("flow_cfg", "flow_legacy", "locks", "aliases")

_SELECTOR_KEYS = frozenset(
    {
        "function_ref",
        "parameter_ref",
        "value_ref",
        "symbol_ref",
        "object_ref",
        "lock_ref",
        "direction",
        "budget",
        "max_items",
    }
)
_REF_SELECTOR_KEYS = (
    "function_ref",
    "parameter_ref",
    "value_ref",
    "symbol_ref",
    "object_ref",
    "lock_ref",
)
_MAX_UNRESOLVED = 200
_MAX_COMBINATIONS = 32
_FLOW_LEGACY_LIMITATIONS = ("path_insensitive", "alias_not_solved")


# ---------------------------------------------------------------------------
# shared helpers
# ---------------------------------------------------------------------------
def _node_ref(bundle: Dict[str, Any], function_id: str) -> str:
    return (
        f"{bundle.get('workspace_id')}/{bundle.get('repo_id')}/"
        f"{bundle.get('variant_id')}/{bundle.get('snapshot_id')}/{function_id}"
    )


def _node_projection(bundle: Dict[str, Any], function_id: str) -> Dict[str, Any]:
    graph = bundle.get("graph") or {}
    function = atlas.functions_by_id(graph).get(function_id)
    projection: Dict[str, Any] = {
        "node_ref": _node_ref(bundle, function_id),
        "id": function_id,
        "workspace_id": bundle.get("workspace_id"),
        "repo_id": bundle.get("repo_id"),
        "variant_id": bundle.get("variant_id"),
        "snapshot_id": bundle.get("snapshot_id"),
    }
    if function is None:
        projection.update(
            {
                "name": None,
                "display_name": None,
                "file": None,
                "line": None,
                "kind": "external_or_unknown",
            }
        )
        return projection
    line = function.get("line")
    projection.update(
        {
            "name": function.get("name") if isinstance(function.get("name"), str) else None,
            "display_name": function.get("display_name")
            if isinstance(function.get("display_name"), str)
            else None,
            "file": function.get("file") if isinstance(function.get("file"), str) else None,
            "line": line if isinstance(line, int) and not isinstance(line, bool) else None,
            "kind": function.get("kind") if isinstance(function.get("kind"), str) else "function",
        }
    )
    return projection


def _adjacency(graph: Dict[str, Any], direction: str) -> Dict[str, List[Tuple[str, str]]]:
    """Node -> sorted unique ``(next_node, callsite)`` pairs from call_targets."""
    collected: Dict[str, List[Tuple[str, str]]] = {}
    for target in graph.get("call_targets") or []:
        if not isinstance(target, dict):
            continue
        if direction == "down":
            current, following = target.get("source"), target.get("target")
        else:
            current, following = target.get("target"), target.get("source")
        if not isinstance(current, str) or not isinstance(following, str):
            continue
        collected.setdefault(current, []).append((following, target.get("callsite")))
    return {node: sorted(set(pairs)) for node, pairs in collected.items()}


def _unknown_target_possible(target: Dict[str, Any]) -> Optional[bool]:
    for key in ("unknown_target_possible", "open_world"):
        value = target.get(key)
        if isinstance(value, bool):
            return value
    return None


def _edge_projection(target: Dict[str, Any], bundle: Dict[str, Any]) -> Dict[str, Any]:
    evidence_ids = [item for item in target.get("evidence_ids") or [] if isinstance(item, str) and item]
    limitations = [item for item in target.get("limitations") or [] if isinstance(item, str)]
    return {
        "edge_id": target.get("id"),
        "call_target_id": target.get("id"),
        "from_ref": _node_ref(bundle, target.get("source")),
        "to_ref": _node_ref(bundle, target.get("target")),
        "relation": "call",
        "callsite": target.get("callsite"),
        "origin": target.get("origin") if isinstance(target.get("origin"), str) else "unknown",
        "certainty": target.get("certainty") if target.get("certainty") in ("exact", "may") else "unknown",
        "evidence_ids": evidence_ids,
        "unknown_target_possible": _unknown_target_possible(target),
        "assumptions": [],
        "limitations": limitations,
    }


def _join_edges(
    graph: Dict[str, Any],
    path: Dict[str, Any],
    direction: str,
    bundle: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Join one traced path back to the call_targets rows that produced it."""
    calls = graph.get("call_targets") or []
    nodes = path["nodes"]
    sites = path["callsites"]
    edges: List[Dict[str, Any]] = []
    for index in range(len(nodes) - 1):
        source, target, callsite = nodes[index], nodes[index + 1], sites[index]
        matches: List[Dict[str, Any]] = []
        for candidate in calls:
            if not isinstance(candidate, dict) or candidate.get("callsite") != callsite:
                continue
            if direction == "down":
                if candidate.get("source") == source and candidate.get("target") == target:
                    matches.append(candidate)
            else:
                if candidate.get("target") == source and candidate.get("source") == target:
                    matches.append(candidate)
        if not matches:  # pragma: no cover - adjacency came from the same rows
            edges.append(
                {
                    "edge_id": f"unknown:{callsite}",
                    "call_target_id": None,
                    "from_ref": _node_ref(bundle, source),
                    "to_ref": _node_ref(bundle, target),
                    "relation": "call",
                    "callsite": callsite,
                    "origin": "unknown",
                    "certainty": "unknown",
                    "evidence_ids": [],
                    "unknown_target_possible": True,
                    "assumptions": [],
                    "limitations": ["callsite_join_not_unique"],
                }
            )
            continue
        for match in matches:
            edges.append(_edge_projection(match, bundle))
    return edges


class _PathBudget:
    """Shared traversal budget/depth accounting plus bounded unresolved notes."""

    def __init__(self, budget: int, max_depth: int) -> None:
        self.budget = budget
        self.max_depth = max_depth
        self.used = 0
        self.truncated = False
        self._notes: List[Dict[str, Any]] = []
        self._seen: set = set()

    def note(self, reason: str, **fields: Any) -> None:
        key = (reason, tuple(sorted((name, str(value)) for name, value in fields.items())))
        if key in self._seen:
            return
        self._seen.add(key)
        entry: Dict[str, Any] = {"reason": reason}
        for name, value in fields.items():
            entry[name] = value
        self._notes.append(entry)

    def exhausted(self) -> bool:
        return self.used >= self.budget

    def notes(self) -> List[Dict[str, Any]]:
        if len(self._notes) > _MAX_UNRESOLVED:
            self.truncated = True
            return self._notes[:_MAX_UNRESOLVED] + [
                {"reason": "unresolved_truncated", "detail": "unresolved entries were capped"}
            ]
        return list(self._notes)


def _find_paths(
    adjacency: Dict[str, List[Tuple[str, str]]],
    start_id: str,
    target_id: str,
    shared: _PathBudget,
    label: str = "path",
) -> List[Dict[str, Any]]:
    """Bounded BFS enumerating simple paths start -> target (Atlas trace style)."""
    found: List[Dict[str, Any]] = []
    queue: deque = deque([((start_id,), ())])
    while queue:
        if shared.exhausted():
            shared.truncated = True
            shared.note("budget_exhausted", detail=f"{label} traversal budget was exhausted")
            break
        nodes, sites = queue.popleft()
        node = nodes[-1]
        neighbors = adjacency.get(node, [])
        if node == target_id:
            found.append({"nodes": list(nodes), "callsites": list(sites)})
            if len(found) >= shared.budget:
                shared.truncated = True
                shared.note("budget_exhausted", detail="path result budget was exhausted")
                break
            continue
        if not neighbors:
            shared.note("leaf_in_analyzed_graph", node_id=node)
            continue
        if len(nodes) - 1 >= shared.max_depth:
            shared.truncated = True
            shared.note("depth_exhausted", node_id=node, max_depth=shared.max_depth)
            continue
        shared.used += 1
        for following, callsite in neighbors:
            if following in nodes:
                shared.note("recursion", node_id=node, recursion_target=following)
                continue
            if len(queue) >= shared.budget:
                shared.truncated = True
                shared.note("budget_exhausted", detail="frontier limit")
                break
            queue.append((nodes + (following,), sites + (callsite,)))
    if queue:
        shared.truncated = True
        shared.note("budget_exhausted", detail="frontier was not fully explored")
    return found


def _common_prefix_and_choices(
    node_sequences: Sequence[Sequence[str]],
    bundle_for: Dict[str, Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    if not node_sequences:
        return [], []
    prefix: List[str] = []
    for values in zip(*node_sequences):
        if len(set(values)) != 1:
            break
        prefix.append(values[0])
    divergence = sorted(
        {sequence[len(prefix)] for sequence in node_sequences if len(sequence) > len(prefix)}
    )
    return (
        [_project_for_ref(value, bundle_for) for value in prefix],
        [_project_for_ref(value, bundle_for) for value in divergence],
    )


def _project_for_ref(node_ref: str, bundle_for: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    snapshot_id, function_id = _split_node_ref(node_ref)
    bundle = bundle_for.get(snapshot_id)
    if bundle is None:
        return {"node_ref": node_ref, "id": function_id, "snapshot_id": snapshot_id}
    return _node_projection(bundle, function_id)


def _split_node_ref(node_ref: str) -> Tuple[str, str]:
    parts = node_ref.split("/", 4)
    if len(parts) < 5:
        return "", node_ref
    return parts[3], parts[4]


def _finalize_unresolved(notes: Sequence[Dict[str, Any]], bundles: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    bundle_list = list(bundles)
    unresolved: List[Dict[str, Any]] = []
    for bundle in bundle_list:
        for issue in atlas.issue_summaries(bundle.get("graph") or {}):
            entry = dict(issue)
            entry["snapshot_ref"] = bundle["snapshot_id"]
            unresolved.append(entry)
    for note in notes:
        unresolved.append(dict(note))
    return unresolved


def _freshness_of(bundles: Sequence[Dict[str, Any]]) -> str:
    return "stale" if any(bundle.get("freshness") == "stale" for bundle in bundles) else "fresh"


def _coverage_of(bundles: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    return {bundle["snapshot_id"]: bundle.get("coverage") or {} for bundle in bundles}


def _load_query_bundle(
    state: Any, workspace_ref: str, snapshot_id: str
) -> Dict[str, Any]:
    bundle = snapshot.load_snapshot_bundle(state, workspace_ref, snapshot_id)
    if bundle.get("freshness") == "unknown":
        fail(
            "STALE_SNAPSHOT",
            "snapshot files are missing or unreadable; re-import the snapshot before querying",
            details={"snapshot_ref": snapshot_id},
        )
    return bundle


# ---------------------------------------------------------------------------
# query_path
# ---------------------------------------------------------------------------
def query_path(
    state: Any,
    workspace_ref: str,
    variant_id: str,
    from_ref: str,
    to_ref: str,
    budget: int = 2000,
    max_depth: int = 30,
    direction: str = "down",
) -> Dict[str, Any]:
    budget = util.clamp_int(budget, 1, 10000, "budget")
    max_depth = util.clamp_int(max_depth, 1, 100, "max_depth")
    direction = validation.one_of(direction, DIRECTIONS, "direction")
    validation.expect_str(variant_id, "variant_id", max_len=128)

    workspace = snapshot.load_workspace_registration(state, workspace_ref)
    workspace_id = _workspace_id(workspace)
    repo_ids = {
        repository["repo_id"]
        for repository in workspace.get("repositories") or []
        if isinstance(repository, dict) and isinstance(repository.get("repo_id"), str)
    }
    if variant_id not in {
        variant.get("variant_id")
        for variant in workspace.get("variants") or []
        if isinstance(variant, dict)
    }:
        fail("NOT_FOUND", "variant is not registered in this workspace")
    snapshot_map = snapshot.variant_snapshot_map(state, workspace_id, variant_id)

    from_endpoint = _parse_endpoint_ref(from_ref, "from_ref", repo_ids, snapshot_map)
    to_endpoint = _parse_endpoint_ref(to_ref, "to_ref", repo_ids, snapshot_map)

    snapshot_ids = list(dict.fromkeys([from_endpoint["snapshot_id"], to_endpoint["snapshot_id"]]))
    bundles = {
        snapshot_id: _load_query_bundle(state, workspace_ref, snapshot_id) for snapshot_id in snapshot_ids
    }

    if from_endpoint["snapshot_id"] == to_endpoint["snapshot_id"]:
        bundle = bundles[from_endpoint["snapshot_id"]]
        return _same_snapshot_path(bundle, from_endpoint, to_endpoint, budget, max_depth, direction)
    return _cross_repo_path(
        workspace,
        from_endpoint,
        to_endpoint,
        bundles[from_endpoint["snapshot_id"]],
        bundles[to_endpoint["snapshot_id"]],
        budget,
        max_depth,
        direction,
    )


def _workspace_id(workspace: Dict[str, Any]) -> str:
    workspace_id = workspace.get("workspace_id")
    if not isinstance(workspace_id, str) or not workspace_id:
        fail("UNSUPPORTED_SCHEMA", "workspace registration is missing workspace_id")
    return workspace_id


def _parse_endpoint_ref(
    ref: Any,
    label: str,
    repo_ids: set,
    snapshot_map: Dict[str, str],
) -> Dict[str, str]:
    validation.expect_str(ref, label, max_len=1024)
    repo_id: Optional[str] = None
    function_ref = ref
    if ":" in ref:
        prefix, rest = ref.split(":", 1)
        if prefix in repo_ids:
            repo_id = prefix
            function_ref = rest
    if repo_id is None:
        if not snapshot_map:
            fail("NOT_FOUND", "no snapshot is imported for this variant")
        if len(snapshot_map) > 1:
            fail(
                "INVALID_ARGUMENT",
                f"{label} is bare but the variant has several repository snapshots; prefix a repo_id",
                details={"repos": sorted(snapshot_map)},
            )
        repo_id = next(iter(snapshot_map))
    if repo_id not in snapshot_map:
        fail("NOT_FOUND", f"no snapshot is imported for repository {repo_id}")
    function_ref = validation.expect_str(function_ref, f"{label} function part", max_len=512)
    return {
        "repo_id": repo_id,
        "function_ref": function_ref,
        "snapshot_id": snapshot_map[repo_id],
    }


def _same_snapshot_path(
    bundle: Dict[str, Any],
    from_endpoint: Dict[str, str],
    to_endpoint: Dict[str, str],
    budget: int,
    max_depth: int,
    direction: str,
) -> Dict[str, Any]:
    graph = bundle.get("graph") or {}
    start = atlas.resolve_function(graph, from_endpoint["function_ref"], "from_ref")
    target = atlas.resolve_function(graph, to_endpoint["function_ref"], "to_ref")
    shared = _PathBudget(budget, max_depth)
    adjacency = _adjacency(graph, direction)
    paths = _find_paths(adjacency, start["id"], target["id"], shared)

    node_ids: List[str] = []
    node_sequences: List[List[str]] = []
    edges: List[Dict[str, Any]] = []
    seen_edges: set = set()
    if paths:
        for path in paths:
            sequence: List[str] = []
            for node_id in path["nodes"]:
                if node_id not in node_ids:
                    node_ids.append(node_id)
                sequence.append(_node_ref(bundle, node_id))
            node_sequences.append(sequence)
            for edge in _join_edges(graph, path, direction, bundle):
                edge_id = edge.get("edge_id")
                if edge_id in seen_edges:
                    continue
                seen_edges.add(edge_id)
                edges.append(edge)
    else:
        node_ids = [start["id"]]
        if target["id"] != start["id"]:
            node_ids.append(target["id"])
        shared.note(
            "target_not_reachable",
            detail="no call path reaches the target within the analyzed graph",
        )

    nodes = [_node_projection(bundle, node_id) for node_id in node_ids]
    common_prefix, choices = _common_prefix_and_choices(node_sequences, {bundle["snapshot_id"]: bundle})
    unresolved = _finalize_unresolved(shared.notes(), [bundle])
    return {
        "schema_version": 1,
        "snapshot_refs": [bundle["snapshot_id"]],
        "nodes": nodes,
        "edges": edges,
        "unresolved": unresolved,
        "choices": choices,
        "common_prefix": common_prefix,
        "coverage": _coverage_of([bundle]),
        "truncated": bool(shared.truncated),
        "budget_used": int(shared.used),
        "direction": direction,
        "freshness": _freshness_of([bundle]),
    }


# ---------------------------------------------------------------------------
# cross-repository paths
# ---------------------------------------------------------------------------
def _binding_applies_to_variant(binding: Dict[str, Any], variant_id: str) -> bool:
    from_endpoint = binding.get("from") if isinstance(binding.get("from"), dict) else {}
    to_endpoint = binding.get("to") if isinstance(binding.get("to"), dict) else {}
    if from_endpoint.get("variant_id") not in (None, variant_id):
        return False
    if to_endpoint.get("variant_id") not in (None, variant_id):
        return False
    pairs = binding.get("applicable_variant_pairs")
    if isinstance(pairs, list) and pairs:
        return any(
            isinstance(pair, dict)
            and pair.get("from_variant") == variant_id
            and pair.get("to_variant") == variant_id
            for pair in pairs
        )
    return True


def _binding_evidence_refs(binding: Dict[str, Any]) -> List[str]:
    refs: List[str] = []
    for endpoint_key in ("from", "to"):
        endpoint = binding.get(endpoint_key)
        if isinstance(endpoint, dict):
            for ref in endpoint.get("source_evidence_refs") or []:
                if isinstance(ref, str) and ref and ref not in refs:
                    refs.append(ref)
    selector = binding.get("selector")
    if isinstance(selector, dict):
        for ref in selector.get("value_evidence_refs") or []:
            if isinstance(ref, str) and ref and ref not in refs:
                refs.append(ref)
    for ref in binding.get("shared_definition_evidence_refs") or []:
        if isinstance(ref, str) and ref and ref not in refs:
            refs.append(ref)
    return refs


def _bridge_edge(
    binding: Dict[str, Any],
    from_bundle: Dict[str, Any],
    to_bundle: Dict[str, Any],
    left_interface: str,
    right_interface: str,
) -> Dict[str, Any]:
    limitations = [item for item in binding.get("limitations") or [] if isinstance(item, str)]
    limitations.append("static_contract_not_runtime_call")
    return {
        "edge_id": f"bridge_{binding.get('binding_id')}",
        "call_target_id": None,
        "binding_id": binding.get("binding_id"),
        "from_ref": _node_ref(from_bundle, left_interface),
        "to_ref": _node_ref(to_bundle, right_interface),
        "relation": "abi_bridge",
        "callsite": None,
        "origin": "derived",
        "certainty": "may",
        "evidence_ids": [],
        "evidence_refs": _binding_evidence_refs(binding),
        "unknown_target_possible": None,
        "assumptions": [item for item in binding.get("assumptions") or [] if isinstance(item, str)],
        "limitations": limitations,
    }


def _cross_repo_path(
    workspace: Dict[str, Any],
    from_endpoint: Dict[str, str],
    to_endpoint: Dict[str, str],
    from_bundle: Dict[str, Any],
    to_bundle: Dict[str, Any],
    budget: int,
    max_depth: int,
    direction: str,
) -> Dict[str, Any]:
    variant_id = from_bundle.get("variant_id")
    bindings = workspace.get("bindings") if isinstance(workspace.get("bindings"), list) else []
    applicable: List[Dict[str, Any]] = []
    opposite: List[Dict[str, Any]] = []
    for binding in bindings:
        if not isinstance(binding, dict):
            continue
        from_side = binding.get("from") if isinstance(binding.get("from"), dict) else {}
        to_side = binding.get("to") if isinstance(binding.get("to"), dict) else {}
        if (
            from_side.get("repo_id") == from_endpoint["repo_id"]
            and to_side.get("repo_id") == to_endpoint["repo_id"]
        ):
            if _binding_applies_to_variant(binding, variant_id):
                applicable.append(binding)
        elif (
            from_side.get("repo_id") == to_endpoint["repo_id"]
            and to_side.get("repo_id") == from_endpoint["repo_id"]
        ):
            opposite.append(binding)

    from_graph = from_bundle.get("graph") or {}
    to_graph = to_bundle.get("graph") or {}
    start = atlas.resolve_function(from_graph, from_endpoint["function_ref"], "from_ref")
    target = atlas.resolve_function(to_graph, to_endpoint["function_ref"], "to_ref")

    shared = _PathBudget(budget, max_depth)
    from_adjacency = _adjacency(from_graph, direction)
    to_adjacency = _adjacency(to_graph, direction)
    unresolved_extra: List[Dict[str, Any]] = []

    combinations: List[Dict[str, Any]] = []
    for binding in applicable:
        status = binding.get("status")
        binding_id = binding.get("binding_id")
        if status != "supported":
            unresolved_extra.append(
                {
                    "reason": f"binding_{status}" if isinstance(status, str) and status else "binding_not_supported",
                    "binding_id": binding_id,
                    "detail": "only a fully supported binding can produce a usable bridge path",
                }
            )
            continue
        from_side = binding.get("from") if isinstance(binding.get("from"), dict) else {}
        to_side = binding.get("to") if isinstance(binding.get("to"), dict) else {}
        left_matches = atlas.match_functions(from_graph, from_side.get("interface_ref"))
        right_matches = atlas.match_functions(to_graph, to_side.get("interface_ref"))
        if not left_matches or not right_matches:
            unresolved_extra.append(
                {
                    "reason": "binding_interface_not_found",
                    "binding_id": binding_id,
                    "detail": "a binding endpoint interface is not present in its snapshot graph",
                }
            )
            continue
        if len(left_matches) > 1 or len(right_matches) > 1:
            unresolved_extra.append(
                {
                    "reason": "ambiguous_binding_interface",
                    "binding_id": binding_id,
                    "choices": [
                        atlas.function_choice(entry) for entry in (left_matches + right_matches)
                    ],
                }
            )
            continue
        left_interface = left_matches[0]["id"]
        right_interface = right_matches[0]["id"]
        left_paths = _find_paths(from_adjacency, start["id"], left_interface, shared, label="from-segment")
        if not left_paths:
            unresolved_extra.append(
                {
                    "reason": "binding_segment_unreachable",
                    "binding_id": binding_id,
                    "detail": "the from endpoint does not reach the binding interface",
                }
            )
            continue
        right_paths = _find_paths(to_adjacency, right_interface, target["id"], shared, label="to-segment")
        if not right_paths:
            unresolved_extra.append(
                {
                    "reason": "binding_segment_unreachable",
                    "binding_id": binding_id,
                    "detail": "the binding interface does not reach the to endpoint",
                }
            )
            continue
        combinations_for_binding = 0
        for left_path in left_paths:
            for right_path in right_paths:
                if len(combinations) >= _MAX_COMBINATIONS:
                    shared.truncated = True
                    shared.note("combination_limit", detail="cross-repo path combinations were capped")
                    break
                combinations.append(
                    {
                        "binding": binding,
                        "left_path": left_path,
                        "right_path": right_path,
                        "left_interface": left_interface,
                        "right_interface": right_interface,
                    }
                )
                combinations_for_binding += 1
            if len(combinations) >= _MAX_COMBINATIONS:
                break
        if combinations_for_binding == 0:
            unresolved_extra.append(
                {
                    "reason": "binding_path_not_combined",
                    "binding_id": binding_id,
                    "detail": "no bounded path combination connected both endpoints",
                }
            )

    node_ids: Dict[str, List[str]] = {}
    node_sequences: List[List[str]] = []
    edges: List[Dict[str, Any]] = []
    seen_edges: set = set()

    def add_node(bundle: Dict[str, Any], node_id: str) -> str:
        ref = _node_ref(bundle, node_id)
        bucket = node_ids.setdefault(bundle["snapshot_id"], [])
        if node_id not in bucket:
            bucket.append(node_id)
        return ref

    if combinations:
        for combination in combinations:
            left_bundle = from_bundle
            right_bundle = to_bundle
            sequence: List[str] = []
            for node_id in combination["left_path"]["nodes"]:
                sequence.append(add_node(left_bundle, node_id))
            for node_id in combination["right_path"]["nodes"]:
                sequence.append(add_node(right_bundle, node_id))
            node_sequences.append(sequence)
            for edge in _join_edges(
                from_graph, combination["left_path"], direction, left_bundle
            ):
                if edge.get("edge_id") not in seen_edges:
                    seen_edges.add(edge.get("edge_id"))
                    edges.append(edge)
            for edge in _join_edges(to_graph, combination["right_path"], direction, right_bundle):
                if edge.get("edge_id") not in seen_edges:
                    seen_edges.add(edge.get("edge_id"))
                    edges.append(edge)
            bridge = _bridge_edge(
                combination["binding"],
                left_bundle,
                right_bundle,
                combination["left_interface"],
                combination["right_interface"],
            )
            if bridge["edge_id"] not in seen_edges:
                seen_edges.add(bridge["edge_id"])
                edges.append(bridge)
    else:
        add_node(from_bundle, start["id"])
        add_node(to_bundle, target["id"])
        unresolved_extra.append(
            {
                "reason": "no_supported_binding",
                "from_repo_id": from_endpoint["repo_id"],
                "to_repo_id": to_endpoint["repo_id"],
                "detail": (
                    "binding exists only in the opposite direction"
                    if opposite
                    else "no supported cross-repo binding connects these repositories for this variant"
                ),
            }
        )

    nodes: List[Dict[str, Any]] = []
    for bundle in (from_bundle, to_bundle):
        for node_id in node_ids.get(bundle["snapshot_id"], []):
            nodes.append(_node_projection(bundle, node_id))

    bundle_for = {from_bundle["snapshot_id"]: from_bundle, to_bundle["snapshot_id"]: to_bundle}
    common_prefix, choices = _common_prefix_and_choices(node_sequences, bundle_for)
    unresolved = _finalize_unresolved(shared.notes(), [from_bundle, to_bundle]) + unresolved_extra
    return {
        "schema_version": 1,
        "snapshot_refs": [from_bundle["snapshot_id"], to_bundle["snapshot_id"]],
        "nodes": nodes,
        "edges": edges,
        "unresolved": unresolved[:_MAX_UNRESOLVED],
        "choices": choices,
        "common_prefix": common_prefix,
        "coverage": _coverage_of([from_bundle, to_bundle]),
        "truncated": bool(shared.truncated),
        "budget_used": int(shared.used),
        "direction": direction,
        "freshness": _freshness_of([from_bundle, to_bundle]),
    }


# ---------------------------------------------------------------------------
# query_relation
# ---------------------------------------------------------------------------
def query_relation(
    state: Any,
    workspace_ref: str,
    snapshot_ref: str,
    mode: str,
    **selectors: Any,
) -> Dict[str, Any]:
    started = time.perf_counter()
    mode = validation.one_of(mode, RELATION_MODES, "mode")
    unknown_keys = sorted(set(selectors) - _SELECTOR_KEYS)
    if unknown_keys:
        fail("INVALID_ARGUMENT", f"relation query contains unknown selectors: {', '.join(unknown_keys)}")
    present: Dict[str, Any] = {}
    for key, value in selectors.items():
        if value is None:
            continue
        present[key] = value
    for key in _REF_SELECTOR_KEYS:
        if key in present:
            validation.expect_str(present[key], key, max_len=512)

    budget, max_items, direction = _validate_relation_selectors(mode, present)
    selection: Dict[str, Any] = {"mode": mode}
    for key in _REF_SELECTOR_KEYS:
        if key in present:
            selection[key] = present[key]
    if direction is not None:
        selection["direction"] = direction
    selection["budget"] = budget
    selection["max_items"] = max_items
    query_digest = util.digest(
        {"mode": mode, "snapshot_ref": snapshot_ref, "selection": selection}
    )

    bundle = _load_query_bundle(state, workspace_ref, snapshot_ref)
    evidence = snapshot.snapshot_evidence(state, workspace_ref, snapshot_ref)
    capabilities = bundle.get("capabilities") or {}
    graph = bundle.get("graph") or {}
    result = _relation_result(mode, query_digest, selection, evidence, snapshot_ref)

    if mode == "flow_legacy":
        _project_flow_legacy(result, graph, present["symbol_ref"], budget, max_items)
    elif mode == "flow_cfg":
        _project_flow_cfg(result, graph, capabilities, present, budget, max_items)
    elif mode == "locks":
        _project_locks(result, graph, capabilities, present, budget, max_items)
    else:
        _project_aliases(result, graph, capabilities, present, budget, max_items)

    elapsed_ms = int(round((time.perf_counter() - started) * 1000))
    items = result["items"]
    result["budget_used"] = {
        "elapsed_ms": elapsed_ms,
        "items_emitted": len(items),
        "bytes_captured": len(util.canonical_json(items).encode("utf-8")),
    }
    return result


def _validate_relation_selectors(
    mode: str, present: Dict[str, Any]
) -> Tuple[int, int, Optional[str]]:
    direction = present.get("direction")
    if direction is not None:
        direction = validation.one_of(direction, ("forward", "backward"), "direction")
    budget = util.clamp_int(present.get("budget", 2000), 1, 10000, "budget")
    max_items = util.clamp_int(present.get("max_items", 200), 1, 2000, "max_items")

    if mode == "flow_cfg":
        _forbid_selectors(present, ("symbol_ref", "object_ref", "lock_ref"), "flow_cfg")
        if "function_ref" not in present:
            fail("INVALID_ARGUMENT", "flow_cfg requires function_ref")
        if ("parameter_ref" in present) == ("value_ref" in present):
            fail("INVALID_ARGUMENT", "flow_cfg requires exactly one of parameter_ref|value_ref")
        return budget, max_items, direction or "forward"
    if mode == "flow_legacy":
        _forbid_selectors(
            present,
            ("function_ref", "parameter_ref", "value_ref", "object_ref", "lock_ref"),
            "flow_legacy",
        )
        if "symbol_ref" not in present:
            fail("INVALID_ARGUMENT", "flow_legacy requires symbol_ref")
        if direction not in (None, "forward"):
            fail("INVALID_ARGUMENT", "flow_legacy direction is fixed to forward")
        return budget, max_items, "forward"
    if mode == "locks":
        _forbid_selectors(
            present, ("function_ref", "parameter_ref", "value_ref", "symbol_ref", "direction"), "locks"
        )
        if "object_ref" not in present and "lock_ref" not in present:
            fail("INVALID_ARGUMENT", "locks requires object_ref and/or lock_ref")
        return budget, max_items, None
    _forbid_selectors(
        present, ("parameter_ref", "value_ref", "symbol_ref", "lock_ref", "direction"), "aliases"
    )
    if "object_ref" not in present and "function_ref" not in present:
        fail("INVALID_ARGUMENT", "aliases requires object_ref and/or function_ref")
    return budget, max_items, None


def _forbid_selectors(present: Dict[str, Any], forbidden: Sequence[str], mode: str) -> None:
    offending = [key for key in forbidden if key in present]
    if offending:
        fail(
            "INVALID_ARGUMENT",
            f"{mode} rejects selectors: {', '.join(offending)}",
        )


def _relation_result(
    mode: str,
    query_digest: str,
    selection: Dict[str, Any],
    evidence: Dict[str, Any],
    snapshot_ref: str,
) -> Dict[str, Any]:
    return {
        "schema_version": 1,
        "mode": mode,
        "query_digest": query_digest,
        "snapshot": evidence,
        "status": "ok",
        "capability": {"available": True, "reason": None},
        "selection": selection,
        "items": [],
        "unknowns": [],
        "choices": [],
        "truncated": False,
        "budget_used": {"elapsed_ms": 0, "items_emitted": 0, "bytes_captured": 0},
        "limitations": [],
        "raw_result_ref": f"snapshot:{snapshot_ref}:graph",
    }


def _mark_unavailable(result: Dict[str, Any], reason: str, detail: Optional[str] = None) -> None:
    result["status"] = "unavailable"
    result["capability"] = {"available": False, "reason": reason}
    unknown: Dict[str, Any] = {"reason": reason, "evidence_refs": []}
    if detail:
        unknown["detail"] = detail
    result["unknowns"].append(unknown)


def _add_unknown(result: Dict[str, Any], reason: str, detail: Optional[str] = None) -> None:
    if any(entry.get("reason") == reason for entry in result["unknowns"]):
        return
    unknown: Dict[str, Any] = {"reason": reason, "evidence_refs": []}
    if detail:
        unknown["detail"] = detail
    result["unknowns"].append(unknown)


def _flow_item(edge: Dict[str, Any], relation: Optional[str] = None) -> Dict[str, Any]:
    source_refs: List[str] = []
    owner = edge.get("owner")
    if isinstance(owner, str) and owner:
        source_refs.append(owner)
    for source in edge.get("sources") or []:
        if isinstance(source, str) and source and source not in source_refs:
            source_refs.append(source)
    return {
        "item_id": edge.get("id"),
        "relation": relation or edge.get("relation") or "data_flow",
        "origin": edge.get("origin") if isinstance(edge.get("origin"), str) else "derived",
        "certainty": "may",
        "evidence_refs": [item for item in edge.get("evidence_ids") or [] if isinstance(item, str)],
        "source_entity_refs": source_refs,
        "limitations": [item for item in edge.get("limitations") or [] if isinstance(item, str)],
    }


def _extend_limitations(result: Dict[str, Any], limitations: Iterable[str]) -> None:
    for limitation in limitations:
        if isinstance(limitation, str) and limitation and limitation not in result["limitations"]:
            result["limitations"].append(limitation)


def _project_flow_legacy(
    result: Dict[str, Any],
    graph: Dict[str, Any],
    symbol_ref: str,
    budget: int,
    max_items: int,
) -> None:
    flow_edges = graph.get("flow_edges")
    if not isinstance(flow_edges, list) or not flow_edges:
        _mark_unavailable(
            result,
            "legacy_flow_data_missing",
            "the snapshot has no legacy flow_edges; select flow_cfg when a real CFG capability exists",
        )
        return
    adjacency: Dict[str, List[Dict[str, Any]]] = {}
    for edge in flow_edges:
        if not isinstance(edge, dict):
            continue
        for source in edge.get("sources") or []:
            if isinstance(source, str) and source:
                adjacency.setdefault(source, []).append(edge)
    queue: deque = deque([symbol_ref])
    visited = {symbol_ref}
    inspected = 0
    truncated = False
    while queue and not truncated:
        if len(result["items"]) >= max_items:
            truncated = True
            _add_unknown(result, "max_items_truncated")
            break
        symbol = queue.popleft()
        for edge in adjacency.get(symbol, []):
            inspected += 1
            if inspected > budget:
                truncated = True
                _add_unknown(result, "budget_exhausted", "flow_legacy traversal budget was exhausted")
                break
            if len(result["items"]) >= max_items:
                truncated = True
                _add_unknown(result, "max_items_truncated")
                break
            result["items"].append(_flow_item(edge))
            _extend_limitations(result, edge.get("limitations") or [])
            following = edge.get("target")
            if isinstance(following, str) and following and following not in visited:
                visited.add(following)
                queue.append(following)
    if not result["items"]:
        _add_unknown(
            result,
            "no_legacy_flow_edge_from_symbol",
            "no legacy flow edge starts at this symbol; this does not prove the absence of data flow",
        )
    result["truncated"] = truncated
    if truncated:
        result["status"] = "partial"


def _project_flow_cfg(
    result: Dict[str, Any],
    graph: Dict[str, Any],
    capabilities: Dict[str, str],
    present: Dict[str, Any],
    budget: int,
    max_items: int,
) -> None:
    function = atlas.resolve_function(graph, present["function_ref"], "function_ref")
    result["selection"]["function_id"] = function.get("id")
    capability_status = capabilities.get("cfg", "unknown")
    capability_available = capability_status in atlas.TRUTHY_CAPABILITY_STATUSES
    cfg_edges = graph.get("cfg_edges")
    value_nodes = graph.get("value_nodes")
    has_cfg_edges = isinstance(cfg_edges, list) and bool(cfg_edges)
    has_value_nodes = isinstance(value_nodes, list) and bool(value_nodes)
    if not capability_available or not (has_cfg_edges or has_value_nodes):
        _mark_unavailable(
            result,
            "cfg_capability_not_available" if not capability_available else "cfg_data_missing",
            "flow_cfg requires a real CFG capability and value/CFG data; legacy flow is never substituted",
        )
        return
    if has_cfg_edges:
        inspected = 0
        truncated = False
        for edge in cfg_edges:
            if not isinstance(edge, dict):
                continue
            inspected += 1
            if inspected > budget:
                truncated = True
                _add_unknown(result, "budget_exhausted", "flow_cfg traversal budget was exhausted")
                break
            owner = edge.get("owner")
            if owner is not None and owner != function.get("id"):
                continue
            if len(result["items"]) >= max_items:
                truncated = True
                _add_unknown(result, "max_items_truncated")
                break
            result["items"].append(_flow_item(edge, relation="data_flow"))
            _extend_limitations(result, edge.get("limitations") or [])
        result["truncated"] = truncated
        if truncated:
            result["status"] = "partial"
        if not result["items"]:
            _add_unknown(
                result,
                "no_cfg_edges_for_function",
                "the CFG capability is present but no edge for this function was projected",
            )
    else:
        _add_unknown(
            result,
            "cfg_value_nodes_present_without_cfg_edges",
            "value nodes exist but no CFG edges were supplied; no flow is fabricated",
        )


def _field_matches(entry: Dict[str, Any], keys: Sequence[str], value: str) -> bool:
    for key in keys:
        candidate = entry.get(key)
        if isinstance(candidate, str) and candidate == value:
            return True
    return False


def _project_locks(
    result: Dict[str, Any],
    graph: Dict[str, Any],
    capabilities: Dict[str, str],
    present: Dict[str, Any],
    budget: int,
    max_items: int,
) -> None:
    _project_capability_items(result, graph, capabilities, present, budget, max_items, "locks", "lock")


def _project_aliases(
    result: Dict[str, Any],
    graph: Dict[str, Any],
    capabilities: Dict[str, str],
    present: Dict[str, Any],
    budget: int,
    max_items: int,
) -> None:
    _project_capability_items(result, graph, capabilities, present, budget, max_items, "aliases", "alias")


def _project_capability_items(
    result: Dict[str, Any],
    graph: Dict[str, Any],
    capabilities: Dict[str, str],
    present: Dict[str, Any],
    budget: int,
    max_items: int,
    data_key: str,
    relation: str,
) -> None:
    capability_status = capabilities.get(data_key, "unknown")
    entries = graph.get(data_key)
    if not isinstance(entries, list) or not entries:
        _mark_unavailable(
            result,
            f"{data_key}_capability_not_available"
            if capability_status not in atlas.TRUTHY_CAPABILITY_STATUSES
            else f"{data_key}_data_missing",
            f"{data_key} analysis data is absent; an empty result would not prove anything",
        )
        return
    inspected = 0
    truncated = False
    for entry in entries:
        inspected += 1
        if inspected > budget:
            truncated = True
            _add_unknown(result, "budget_exhausted", f"{data_key} projection budget was exhausted")
            break
        if not isinstance(entry, dict):
            continue
        if data_key == "locks":
            if "object_ref" in present and not _field_matches(
                entry, ("object_id", "object_ref", "object", "object_name"), present["object_ref"]
            ):
                continue
            if "lock_ref" in present and not _field_matches(
                entry, ("lock_id", "lock_ref", "lock"), present["lock_ref"]
            ):
                continue
        else:
            if "object_ref" in present and not _field_matches(
                entry, ("object_id", "object_ref", "object", "object_name"), present["object_ref"]
            ):
                continue
            if "function_ref" in present and not _field_matches(
                entry, ("function_id", "function_ref", "owner", "function"), present["function_ref"]
            ):
                continue
        if len(result["items"]) >= max_items:
            truncated = True
            _add_unknown(result, "max_items_truncated")
            break
        source_refs: List[str] = []
        for key in ("object_id", "lock_id", "function_id", "owner"):
            candidate = entry.get(key)
            if isinstance(candidate, str) and candidate and candidate not in source_refs:
                source_refs.append(candidate)
        certainty = entry.get("certainty")
        result["items"].append(
            {
                "item_id": entry.get("id") if isinstance(entry.get("id"), str) else util.digest(entry)[:24],
                "relation": relation,
                "origin": entry.get("origin") if isinstance(entry.get("origin"), str) else "derived",
                "certainty": certainty if certainty in ("exact", "may", "unknown") else "unknown",
                "evidence_refs": [
                    item for item in entry.get("evidence_ids") or [] if isinstance(item, str)
                ],
                "source_entity_refs": source_refs,
                "limitations": [item for item in entry.get("limitations") or [] if isinstance(item, str)],
            }
        )
        _extend_limitations(result, entry.get("limitations") or [])
    if not result["items"]:
        _add_unknown(
            result,
            f"no_matching_{data_key}_evidence",
            f"no matching {data_key} entry was projected; an empty result does not prove absence",
        )
    result["truncated"] = truncated
    if truncated:
        result["status"] = "partial"
