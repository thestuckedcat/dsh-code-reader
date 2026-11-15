function groupMembers(id, groups) {
  return groups[id] ? groups[id].flatMap((child) => groupMembers(child, groups)) : [id];
}

function groupSummary(id, groups, roles, stages = {}) {
  const members = groupMembers(id, groups);
  const duties = [...new Set(members.map((member) => roles[member] ?? member))];
  const phase = members.map((member) => stages[member]).find(Boolean);
  return { title: phase ?? duties.slice(0, 2).join(' / '), description: duties.join('、'), members };
}

function visibleNodes(groups, expanded) {
  const parent = new Map();
  for (const [id, members] of Object.entries(groups)) {
    for (const member of members) parent.set(member, id);
  }
  return (id) => {
    let visible = id;
    for (let ancestor = parent.get(id); ancestor; ancestor = parent.get(ancestor)) {
      if (!expanded.has(ancestor)) visible = ancestor;
    }
    return visible;
  };
}

function projectEdges(groups, expanded, edges) {
  const visible = visibleNodes(groups, expanded);
  const projection = new Map();
  for (const edge of edges) {
    const from = visible(edge.from);
    const to = visible(edge.to);
    if (from === to) continue;
    const key = `${from}:${to}`;
    const previous = projection.get(key);
    if (!previous) projection.set(key, { ...edge, from, to });
    else {
      if (edge.active && !previous.active) previous.text = edge.text;
      else if (edge.active === previous.active && edge.text && edge.text !== previous.text) {
        previous.text = [previous.text, edge.text].filter(Boolean).join(' / ');
      }
      previous.active ||= edge.active;
    }
  }
  return [...projection.values()];
}

function observedInPath(path, names) {
  return path.every((name) => names.has(name));
}

if (typeof module !== 'undefined') {
  module.exports = { groupSummary, groupMembers, visibleNodes, projectEdges, observedInPath };
}
