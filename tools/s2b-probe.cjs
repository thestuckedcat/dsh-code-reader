// Chromium probe for the S2b read-only workbench increment (independent
// verifier artefact; not a shipped plugin component).
//
// Asserts docs/five-view-contract.md §10.5 on the real isolated rc.5 `dsh web`:
//   * group collapsing in the end-to-end graph (group boxes, member hiding,
//     cross-group edge metadata preserved, toggle/all-expand/all-collapse),
//   * basic interface library candidates + blackbox add/remove in the graph,
//   * subflow tab + breadcrumb navigation back to the main graph,
//   * Selection extension fields (group_id/interface_id/subflow_root_id),
//   * console clean + no absolute-path leak + per-feature screenshots.
//
// The S2a five-view regression itself is run separately by
// tools/verify-s2b.mjs using the committed S2a probe, so this file focuses on
// the S2b delta. Mechanisms (invisible opacity-0 window for current composited
// screenshots, host first-run overlay dismissal) are the same verifier-owned
// mechanisms as tools/five-views-probe.cjs.
//
// Environment:
//   RV_URL            isolated dsh web URL with one-time token
//   RV_OUT            JSON result path
//   RV_SHOT_DIR       directory for s2b PNGs
//   RV_ENTRY_NAME     entry name (default bus_send)
//   RV_EXPECT_LINE    entry definition line (default 152)
//   RV_SNAPSHOT_ID    expected verified snapshot id (optional)
//   RV_SUBFLOW_ENTRY  function to open the subflow for (default check_length)
//   RV_TIMEOUT_MS     overall probe timeout (default 360000)
const {app, BrowserWindow} = require('electron');
const {createHash} = require('node:crypto');
const {mkdirSync, writeFileSync} = require('node:fs');
const {dirname, join} = require('node:path');

const url = process.env.RV_URL;
const out = process.env.RV_OUT;
const shotDir = process.env.RV_SHOT_DIR;
const expectEntry = process.env.RV_ENTRY_NAME || 'bus_send';
const expectLine = Number(process.env.RV_EXPECT_LINE || '152');
const expectSnapshotId = process.env.RV_SNAPSHOT_ID || null;
const subflowEntry = process.env.RV_SUBFLOW_ENTRY || 'check_length';
const overallTimeoutMs = Number(process.env.RV_TIMEOUT_MS || 360000);
const consoleLines = [];
const startedAt = Date.now();

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function writeResult(payload) {
  try {
    if (out) {
      mkdirSync(dirname(out), {recursive: true});
      writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
    }
  } catch (error) {
    console.error('s2b probe result write failed', String(error && error.message ? error.message : error));
  }
}

function finish(payload) {
  payload.duration_ms = Date.now() - startedAt;
  payload.console_lines = consoleLines.slice(0, 300);
  payload.console_error_count = consoleLines.filter((line) => Number(line.level) >= 3).length;
  writeResult(payload);
  app.exit(payload.ok === true ? 0 : 1);
}

async function waitFor(win, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await win.webContents.executeJavaScript(expression).catch(() => false);
    if (value) return value;
    await sleep(250);
  }
  return false;
}

function evaluate(win, expression) {
  return win.webContents.executeJavaScript(expression);
}

async function capturePng(win) {
  try {
    const image = await win.webContents.capturePage();
    return {ok: true, bytes: image.toPNG()};
  } catch (error) {
    return {ok: false, error: String(error && error.message ? error.message : error)};
  }
}

// Host first-run overlay dismissal (best effort; host UI, never a gate).
async function dismissHostOverlays(win) {  for (let attempt = 0; attempt < 12; attempt += 1) {
    const state = await evaluate(win, `(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(visible);
      if (dialogs.length === 0) return {done: true, clicked: false};
      for (const dialog of dialogs) {
        const buttons = [...dialog.querySelectorAll('button')].filter(visible);
        const byText = (pattern) => buttons.find((node) => pattern.test((node.textContent || '').trim()));
        const byLabel = (pattern) => buttons.find((node) => pattern.test(node.getAttribute('aria-label') || ''));
        const candidate = byText(/稍后|跳过|继续/) ?? byLabel(/关闭|close|skip/i) ?? null;
        if (candidate) { candidate.click(); return {done: false, clicked: true}; }
      }
      return {done: false, clicked: false};
    })()`).catch(() => ({done: false, clicked: false}));
    if (state.done === true) return true;
    if (state.clicked !== true) {
      win.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Escape'});
      win.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Escape'});
    }
    await sleep(400);
  }
  return false;
}

async function panelPresent(win) {
  return evaluate(win, `document.querySelector('[data-code-view="panel"]') !== null`).catch(() => false);
}
/** Re-open the workbench panel if the host shell navigated away (host UI
 * artifact); the recovered panel keeps the module-level remembered selection. */
async function ensurePanel(win, result, where) {
  if (await panelPresent(win)) return true;
  result.panelLosses = result.panelLosses ?? [];
  result.panelLosses.push({at: where, at_ms: Date.now() - startedAt});
  await evaluate(win, clickSidebarEntry()).catch(() => null);
  await waitFor(win, `document.querySelector('[data-code-view="panel"]') !== null`, 15000);
  await sleep(800);
  return panelPresent(win);
}
async function screenshot(win, result, name, scrollSelector = null) {
  await dismissHostOverlays(win).catch(() => null);
  // Dismissing a host first-run overlay can occasionally navigate the shell
  // (host UI, not the plugin); make sure the workbench panel is still open
  // before taking the evidence frame and record any such host-side loss.
  const panelOpen = await evaluate(win, `document.querySelector('[data-code-view="panel"]') !== null`).catch(() => false);
  if (panelOpen !== true) {
    result.panelLosses = result.panelLosses ?? [];
    result.panelLosses.push({at: name, at_ms: Date.now() - startedAt});
    await evaluate(win, clickSidebarEntry()).catch(() => null);
    await waitFor(win, `document.querySelector('[data-code-view="panel"]') !== null`, 15000);
    await sleep(800);
  }
  await evaluate(win, `(() => {
    const target = ${scrollSelector === null ? "document.querySelector('[data-code-view=\"view\"]')" : scrollSelector};
    const element = target ?? document.querySelector('[data-code-view="view"]');
    if (element) element.scrollIntoView({block: 'start'});
    return true;
  })()`).catch(() => null);
  await sleep(800);
  // Hidden windows can lag compositor frames; invalidate + take three frames
  // (the last one is used) so each evidence PNG reflects the current view.
  try { win.webContents.invalidate(); } catch { /* optional API */ }
  await capturePng(win).catch(() => null);
  await sleep(450);
  try { win.webContents.invalidate(); } catch { /* optional API */ }
  await capturePng(win).catch(() => null);
  await sleep(450);
  const capture = await capturePng(win);
  const record = {name, ok: capture.ok === true};
  if (capture.ok === true) {
    if (shotDir) {
      mkdirSync(shotDir, {recursive: true});
      const path = join(shotDir, `${name}.png`);
      writeFileSync(path, capture.bytes);
      record.path = path;
      record.bytes = capture.bytes.length;
      record.sha256 = sha(capture.bytes);
    } else {
      record.bytes = capture.bytes.length;
    }
  } else {
    record.error = capture.error;
  }
  result.screenshots[name] = record;
  return record;
}

function clickSidebarEntry() {
  return `(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const candidates = [...document.querySelectorAll('button, [role="button"], [data-panel-id]')];
    const label = (element) => (element.getAttribute('aria-label') || '') + ' ' + (element.textContent || '');
    const button = candidates.find((element) => visible(element) && label(element).includes('代码工作台'));
    if (!button) return {ok: false};
    button.click();
    return {ok: true};
  })()`;
}

function selectionExpr() {
  return `(() => {
    const element = document.querySelector('[data-code-view="selection"]');
    if (!element) return null;
    try { return JSON.parse(element.textContent); } catch { return {raw: element.textContent.slice(0, 3000)}; }
  })()`;
}

function absolutePathLeakExpr() {
  return `(() => {
    const panel = document.querySelector('[data-code-view="panel"]');
    const text = panel === null ? document.body.innerText : panel.innerText;
    const matches = String(text || '').match(/[A-Za-z]:[\\\\/][^\\s"'<>]*/g) || [];
    return {count: matches.length, samples: matches.slice(0, 10)};
  })()`;
}

async function readTabs(win) {
  return evaluate(win, `(() => [...document.querySelectorAll('[data-code-view="tabs"] button[data-view]')].map((element) => ({
    view: element.getAttribute('data-view'),
    text: (element.innerText || element.textContent || '').trim().slice(0, 40),
    selected: element.getAttribute('aria-pressed') === 'true' || element.getAttribute('aria-selected') === 'true',
  })))()`).catch(() => []);
}

async function clickTab(win, view) {
  return evaluate(win, `(() => {
    const button = document.querySelector('[data-code-view="tabs"] button[data-view=${JSON.stringify(view)}]');
    if (!button) return {ok: false, reason: 'tab not found'};
    button.click();
    return {ok: true};
  })()`).catch((error) => ({ok: false, reason: String(error && error.message ? error.message : error)}));
}

async function waitViewReady(win, view, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(win, `(() => {
      const root = document.querySelector('[data-code-view="view"][data-view=${JSON.stringify(view)}]');
      if (!root) return null;
      return {state: root.getAttribute('data-state'), text_length: (root.innerText || '').length};
    })()`).catch(() => null);
    if (last !== null && last.state === 'ready') return {ready: true, state: last.state};
    if (last !== null && (last.state === 'error' || last.state === 'empty')) return {ready: false, state: last.state};
    await sleep(300);
  }
  return {ready: false, state: last === null ? 'missing' : last.state};
}

async function readGaps(win) {
  return evaluate(win, `(() => [...document.querySelectorAll('[data-code-view="gap-code"], [data-gap-code]')].map((element) => ({
    code: element.getAttribute('data-gap-code') || element.getAttribute('data-code') || '',
    text: (element.innerText || element.textContent || '').trim().slice(0, 240),
  })))()`).catch(() => []);
}

// ---------------------------------------------------------------------------
// open: panel -> verified snapshot -> bus_send -> end-to-end view
// ---------------------------------------------------------------------------
async function openWorkbench(win, result) {
  result.sidebarProbe = await waitFor(win, `(() => {
    const byAria = [...document.querySelectorAll('[aria-label]')].filter((element) => (element.getAttribute('aria-label') || '').includes('代码工作台'));
    if (byAria.length > 0) return {aria_count: byAria.length};
    return document.body.textContent.includes('代码工作台') ? {text_content_has: true} : false;
  })()`, 60000);
  result.steps.sidebarEntry = result.sidebarProbe !== false && result.sidebarProbe !== null;
  await dismissHostOverlays(win);
  result.clickOpen = await evaluate(win, clickSidebarEntry());
  result.steps.panelOpened = Boolean(await waitFor(win, `document.querySelector('[data-code-view="panel"]') !== null`, 30000));
  if (!result.steps.panelOpened) return false;
  result.steps.statusReady = Boolean(await waitFor(win, `(() => {
    const status = document.querySelector('[data-code-view="status"]');
    return status !== null && status.getAttribute('data-state') === 'ready';
  })()`, 40000));
  result.snapshotCandidates = await evaluate(win, `(() => [...document.querySelectorAll('[data-snapshot-id]')].map((element) => ({
    snapshot_id: element.getAttribute('data-snapshot-id'),
    status: element.getAttribute('data-snapshot-status'),
    text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
  })))()`).catch(() => []);
  const chosen = (() => {
    if (expectSnapshotId !== null) {
      const exact = result.snapshotCandidates.find((candidate) => candidate.snapshot_id === expectSnapshotId);
      if (exact) return exact;
    }
    return result.snapshotCandidates.find((candidate) => candidate.status === 'verified') ?? result.snapshotCandidates[0] ?? null;
  })();
  result.chosenSnapshot = chosen;
  if (chosen !== null) {
    result.clickSnapshot = await evaluate(win, `(() => {
      const element = [...document.querySelectorAll('[data-snapshot-id]')].find((node) => node.getAttribute('data-snapshot-id') === ${JSON.stringify(chosen.snapshot_id)});
      if (!element) return {ok: false};
      element.click();
      return {ok: true};
    })()`).catch(() => ({ok: false}));
    result.steps.snapshotClicked = result.clickSnapshot.ok === true;
  }
  result.steps.entryListed = Boolean(await waitFor(win, `document.querySelectorAll('[data-entry-id][data-entry-name]').length > 0`, 40000));
  result.clickEntry = await evaluate(win, `(() => {
    const rows = [...document.querySelectorAll('[data-entry-id][data-entry-name]')];
    const row = rows.find((element) => element.getAttribute('data-entry-name') === ${JSON.stringify(expectEntry)});
    if (!row) return {ok: false, names: rows.map((element) => element.getAttribute('data-entry-name')).slice(0, 40)};
    (row.closest('button, [role="button"], li') ?? row).click();
    return {ok: true, entry_id: row.getAttribute('data-entry-id')};
  })()`).catch(() => ({ok: false}));
  result.steps.entryClicked = result.clickEntry.ok === true;
  result.s1SourceLine = await waitFor(win, `(() => {
    const source = document.querySelector('[data-code-view="source"]');
    if (!source) return false;
    const row = [...source.querySelectorAll('[data-line]')].find((element) => element.getAttribute('data-line') === '${expectLine}');
    return row === undefined ? false : (row.innerText || row.textContent || '').includes(${JSON.stringify(expectEntry)});
  })()`, 40000).catch(() => false);
  result.steps.s1SourceLine = Boolean(result.s1SourceLine);
  result.tabs = await readTabs(win);
  result.steps.tabsFive = ['coupling', 'tree', 'end_to_end', 'sequence', 'file'].every((view) => result.tabs.some((tab) => tab.view === view));
  return true;
}

// ---------------------------------------------------------------------------
// S2b: groups in the end-to-end graph
// ---------------------------------------------------------------------------
function graphNodesExpr() {
  return `(() => [...document.querySelectorAll('[data-graph-node][data-node-id]')].map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      node_id: element.getAttribute('data-node-id'),
      kind: element.getAttribute('data-node-kind'),
      text: (element.innerText || element.textContent || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
      visible: rect.width > 0 && rect.height > 0,
    };
  }))()`;
}

function graphEdgesExpr() {
  return `(() => [...document.querySelectorAll('[data-graph-edge]')].map((element) => ({
    edge_id: element.getAttribute('data-edge-id'),
    kind: element.getAttribute('data-edge-kind'),
    certainty: element.getAttribute('data-certainty'),
    color: element.getAttribute('data-color'),
    label: element.getAttribute('data-edge-label') || '',
    text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
  })))()`;
}

function edgeMetadataMap(edges) {
  const map = {};
  for (const edge of edges ?? []) map[edge.edge_id] = {kind: edge.kind, certainty: edge.certainty, color: edge.color, label: edge.label};
  return map;
}

async function readGraphState(win) {
  return {
    nodes: await evaluate(win, graphNodesExpr()).catch(() => []),
    edges: await evaluate(win, graphEdgesExpr()).catch(() => []),
    groups: await evaluate(win, `(() => [...document.querySelectorAll('[data-graph-group][data-group-id]')].map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        group_id: element.getAttribute('data-group-id'),
        collapsed: element.getAttribute('data-collapsed'),
        text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
        visible: rect.width > 0 && rect.height > 0,
        revised: element.getAttribute('data-revised') || null,
        toggles: element.querySelectorAll('[data-group-toggle]').length,
      };
    }))()`).catch(() => []),
    toggles: await evaluate(win, `(() => [...document.querySelectorAll('[data-group-toggle]')].map((element) => ({
      text: (element.innerText || element.textContent || '').trim().slice(0, 40),
      aria: element.getAttribute('aria-label') || '',
      expanded: element.getAttribute('aria-expanded'),
      collapsed: element.getAttribute('data-collapsed'),
    })))()`).catch(() => []),
    controls: await evaluate(win, `(() => ({
      collapse_all: document.querySelector('[data-graph-collapse-all]') !== null,
      expand_all: document.querySelector('[data-graph-expand-all]') !== null,
    }))()`).catch(() => ({collapse_all: false, expand_all: false})),
  };
}

async function checkGroups(win, result) {
  const detail = {ok: false, steps: {}};
  await clickTab(win, 'end_to_end');
  detail.viewReady = await waitViewReady(win, 'end_to_end', 45000);
  detail.steps.viewReady = detail.viewReady.ready === true;
  await sleep(800);

  detail.initial = await readGraphState(win);
  detail.groupLabels = (detail.initial.groups ?? []).map((group) => group.text);
  detail.steps.groupCount = (detail.initial.groups ?? []).length >= 2;
  detail.steps.groupDispatch = detail.groupLabels.some((label) => label.includes('dispatch_transfer'));
  detail.steps.groupCommit = detail.groupLabels.some((label) => label.includes('commit_transfer'));
  detail.steps.toggles = (detail.initial.toggles ?? []).length >= 2;
  detail.steps.collapseAllControl = detail.initial.controls.collapse_all === true;
  detail.steps.expandAllControl = detail.initial.controls.expand_all === true;

  // Baseline: expand everything first (contract allows collapsed_default true).
  detail.expandAllClick = await evaluate(win, `(() => {
    const button = document.querySelector('[data-graph-expand-all]');
    if (!button) return {ok: false};
    button.click();
    return {ok: true};
  })()`).catch(() => ({ok: false}));
  await sleep(1000);
  detail.expanded = await readGraphState(win);
  detail.baselineNodeIds = (detail.expanded.nodes ?? []).map((node) => node.node_id);
  detail.baselineEdgeMeta = edgeMetadataMap(detail.expanded.edges);
  detail.baselineEdgeCount = (detail.expanded.edges ?? []).length;
  detail.baselineNodeCount = (detail.expanded.nodes ?? []).length;

  // Collapse all: members hidden, group boxes visible, surviving cross-group
  // edges keep the exact same metadata as the expanded baseline.
  detail.collapseAllClick = await evaluate(win, `(() => {
    const button = document.querySelector('[data-graph-collapse-all]');
    if (!button) return {ok: false};
    button.click();
    return {ok: true};
  })()`).catch(() => ({ok: false}));
  await sleep(1000);
  detail.collapsed = await readGraphState(win);
  detail.collapsedNodeIds = (detail.collapsed.nodes ?? []).map((node) => node.node_id);
  detail.hiddenMemberCount = detail.baselineNodeIds.filter((id) => !detail.collapsedNodeIds.includes(id)).length;
  detail.steps.collapseHidesMembers = detail.hiddenMemberCount >= 2;
  detail.steps.groupBoxAfterCollapse = (detail.collapsed.groups ?? []).some((group) => group.visible === true && group.collapsed === 'true');
  const collapsedEdgeMeta = edgeMetadataMap(detail.collapsed.edges);
  const survivors = Object.keys(collapsedEdgeMeta);
  const changed = survivors.filter((id) => JSON.stringify(collapsedEdgeMeta[id]) !== JSON.stringify(detail.baselineEdgeMeta[id]));
  detail.edgeSurvivors = {count: survivors.length, baseline: detail.baselineEdgeCount, changed: changed.slice(0, 10)};
  detail.steps.crossGroupEdgesPreserved = survivors.length > 0 && changed.length === 0;

  // Expand all restores the exact original edge id set + metadata.
  detail.expandAgainClick = await evaluate(win, `(() => {
    const button = document.querySelector('[data-graph-expand-all]');
    if (!button) return {ok: false};
    button.click();
    return {ok: true};
  })()`).catch(() => ({ok: false}));
  await sleep(1200);
  detail.restored = await readGraphState(win);
  const restoredNodeIds = (detail.restored.nodes ?? []).map((node) => node.node_id).sort();
  const restoredEdgeMeta = edgeMetadataMap(detail.restored.edges);
  const restoredEdgeIds = Object.keys(restoredEdgeMeta).sort();
  detail.steps.restoreNodeSet = JSON.stringify(restoredNodeIds) === JSON.stringify([...detail.baselineNodeIds].sort());
  detail.steps.restoreEdgeMeta = JSON.stringify(restoredEdgeMeta) === JSON.stringify(detail.baselineEdgeMeta);
  detail.restore = {
    node_count: restoredNodeIds.length,
    edge_count: restoredEdgeIds.length,
    baseline_nodes: detail.baselineNodeIds.length,
    baseline_edges: detail.baselineEdgeCount,
  };

  // Single-group toggle: collapse one group, members hidden, toggle expands.
  detail.singleToggle = await evaluate(win, `(() => {
    const group = document.querySelector('[data-graph-group][data-group-id]');
    if (!group) return {ok: false};
    const toggle = group.querySelector('[data-group-toggle]') ?? document.querySelector('[data-group-toggle]');
    if (!toggle) return {ok: false};
    const before = toggle.getAttribute('aria-expanded');
    toggle.click();
    return {ok: true, before, group_id: group.getAttribute('data-group-id')};
  })()`).catch(() => ({ok: false}));
  await sleep(900);
  detail.afterSingleToggle = await readGraphState(win);
  const afterNodes = (detail.afterSingleToggle.nodes ?? []).map((node) => node.node_id);
  detail.singleToggleHidden = detail.baselineNodeIds.filter((id) => !afterNodes.includes(id)).length;
  detail.steps.singleToggleCollapses = detail.singleToggle.ok === true && detail.singleToggleHidden >= 1;
  await evaluate(win, `(() => {
    const group = document.querySelector('[data-graph-group][data-group-id]');
    if (group) {
      const toggle = group.querySelector('[data-group-toggle]') ?? document.querySelector('[data-group-toggle]');
      if (toggle) toggle.click();
    }
  })()`).catch(() => {});
  await sleep(900);

  // Group rename: the client exposes an explicit edit control
  // ([data-group-edit]) with inline label/description inputs and a save button;
  // a saved override must show the "已修订（结构归纳）" marker and survive a
  // data refresh (view switch) without touching the engine snapshot.
  detail.rename = await evaluate(win, `(() => {
    const button = document.querySelector('[data-group-edit]');
    if (!button) {
      const group = document.querySelector('[data-graph-group][data-group-id]');
      return {ok: false, reason: 'data-group-edit button missing', group_text: group === null ? '' : (group.innerText || '').slice(0, 200)};
    }
    const groupId = button.getAttribute('data-group-edit');
    button.click();
    return {ok: true, group_id: groupId};
  })()`).catch(() => ({ok: false}));
  await sleep(600);
  detail.renameInputs = await evaluate(win, `(() => ({
    label: (() => { const element = document.querySelector('[data-group-edit-label]'); return element === null ? null : {value: element.value, aria: element.getAttribute('aria-label')}; })(),
    description: (() => { const element = document.querySelector('[data-group-edit-description]'); return element === null ? null : {value: element.value}; })(),
    save: document.querySelector('[data-group-edit-save]') !== null,
    cancel: document.querySelector('[data-group-edit-cancel]') !== null,
  }))()`).catch(() => ({label: null, save: false}));
  detail.renameSave = await evaluate(win, `(() => {
    const input = document.querySelector('[data-group-edit-label]');
    if (!input) return {ok: false, reason: 'edit label input missing'};
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '验收修订组');
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new Event('change', {bubbles: true}));
    const save = document.querySelector('[data-group-edit-save]');
    if (!save) return {ok: false, reason: 'save button missing'};
    save.click();
    return {ok: true, value: '验收修订组'};
  })()`).catch(() => ({ok: false}));
  await sleep(900);
  detail.afterRename = await evaluate(win, `(() => {
    const group = document.querySelector('[data-graph-group][data-group-id]');
    const revised = [...document.querySelectorAll('[data-group-revised]')].map((element) => ({
      text: (element.innerText || element.textContent || '').trim(),
      attrs: Object.fromEntries([...element.attributes].map((attribute) => [attribute.name, attribute.value.slice(0, 80)])),
    }));
    return {
      group_text: group === null ? '' : (group.innerText || group.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
      revised,
      panel_has_revised: (document.querySelector('[data-code-view="panel"]')?.innerText || '').includes('已修订'),
    };
  })()`).catch(() => ({group_text: '', revised: [], panel_has_revised: false}));
  // Switch views and back: the group override is session view state and must
  // survive the data refresh.
  await clickTab(win, 'coupling');
  await waitViewReady(win, 'coupling', 20000);
  await clickTab(win, 'end_to_end');
  await waitViewReady(win, 'end_to_end', 30000);
  await sleep(800);
  detail.afterRefresh = await evaluate(win, `(() => {
    const group = document.querySelector('[data-graph-group][data-group-id]');
    return {
      group_text: group === null ? '' : (group.innerText || group.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
      revised_count: document.querySelectorAll('[data-group-revised]').length,
    };
  })()`).catch(() => ({group_text: '', revised_count: 0}));
  detail.steps.renameMarker = detail.renameInputs.label !== null
    && detail.renameSave.ok === true
    && (detail.afterRename.revised ?? []).some((chip) => chip.attrs['data-group-revised'] === 'true')
    && /已修订/.test(detail.afterRename.group_text);
  detail.steps.renamePersisted = detail.afterRefresh.revised_count >= 1 && /验收修订组|已修订/.test(detail.afterRefresh.group_text);
  detail.selection = await evaluate(win, selectionExpr()).catch(() => null);
  detail.steps.selectionGroupField = detail.selection !== null && typeof detail.selection === 'object'
    && Object.prototype.hasOwnProperty.call(detail.selection, 'group_id');
  detail.groups = {
    group_ids: (detail.initial.groups ?? []).map((group) => group.group_id),
    labels: detail.groupLabels,
    node_counts: {baseline: detail.baselineNodeCount, collapsed: (detail.collapsed.nodes ?? []).length, restored: restoredNodeIds.length},
    edge_counts: {baseline: detail.baselineEdgeCount, collapsed: (detail.collapsed.edges ?? []).length, restored: restoredEdgeIds.length},
    toggle: detail.initial.toggles,
    controls: detail.initial.controls,
  };
  detail.ok = Object.values(detail.steps).every((value) => value === true);
  result.views.groups = detail;
  // Evidence frame: collapse one group so its box + port wiring is visible.
  await evaluate(win, `(() => {
    const group = document.querySelector('[data-graph-group][data-group-id]');
    const toggle = group === null ? null : (group.querySelector('[data-group-toggle]') ?? document.querySelector('[data-group-toggle]'));
    if (toggle) toggle.click();
    return true;
  })()`).catch(() => null);
  await sleep(900);
  await screenshot(win, result, 'groups');
  // Leave the graph fully expanded for the interface/subflow checks.
  await evaluate(win, `(() => { const button = document.querySelector('[data-graph-expand-all]'); if (button) button.click(); return true; })()`).catch(() => null);
  await sleep(900);
  return detail;
}

// ---------------------------------------------------------------------------
// S2b: interface library + blackbox add/remove
// ---------------------------------------------------------------------------
async function checkInterfaces(win, result) {
  const detail = {ok: false, steps: {}};
  // Ensure the graph is fully expanded and the interface library list is open.
  await clickTab(win, 'end_to_end');
  await waitViewReady(win, 'end_to_end', 30000);
  await evaluate(win, `(() => { const button = document.querySelector('[data-graph-expand-all]'); if (button) button.click(); return true; })()`).catch(() => null);
  await sleep(500);
  detail.libraryToggle = await evaluate(win, `(() => {
    const toggle = document.querySelector('[data-interface-library-toggle]');
    if (toggle === null) return {found: false};
    const expanded = toggle.getAttribute('aria-expanded');
    if (expanded !== 'true') toggle.click();
    return {found: true, before: expanded};
  })()`).catch(() => ({found: false}));
  await sleep(800);
  detail.library = await evaluate(win, `(() => {
    const library = document.querySelector('[data-code-view="interface-library"]');
    const candidates = [...document.querySelectorAll('[data-interface-candidate][data-interface-id]')].map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        interface_id: element.getAttribute('data-interface-id'),
        text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
        visible: rect.width > 0 && rect.height > 0,
        attributes: Object.fromEntries([...element.attributes].map((attribute) => [attribute.name, attribute.value.slice(0, 120)])),
        actions: [...element.querySelectorAll('[data-interface-action]')].map((action) => action.getAttribute('data-interface-action')),
      };
    });
    return {
      present: library !== null,
      cards: candidates,
      external_boundaries: [...document.querySelectorAll('[data-interface-external-boundary], [data-external-boundary]')].map((element) => (element.innerText || element.textContent || '').trim().slice(0, 160)),
    };
  })()`).catch(() => ({present: false, cards: []}));
  detail.cards = detail.library.cards ?? [];
  detail.steps.libraryPresent = detail.library.present === true && detail.cards.length > 0;
  detail.platformWrite = detail.cards.find((card) => /platform_write/.test(card.text)) ?? null;
  detail.steps.platformWriteCandidate = detail.platformWrite !== null;
  detail.steps.platformWriteCrossFile = detail.platformWrite !== null && /cross_file|cross-file|跨文件/.test(detail.platformWrite.text);
  detail.steps.platformWriteSideEffects = detail.platformWrite !== null && /侧?副作用|simulated_doorbell|write/.test(detail.platformWrite.text);
  detail.independentCandidates = detail.cards.filter((card) => /独立接口|independent/.test(card.text));
  detail.independentNames = detail.independentCandidates.map((card) => {
    const match = /(lookup_route|check_length|encode_doorbell|platform_write|trace)/.exec(card.text);
    return match === null ? null : match[1];
  }).filter(Boolean);
  detail.steps.twoIndependent = detail.independentCandidates.length >= 2;
  detail.steps.independentNames = ['lookup_route', 'check_length', 'encode_doorbell'].filter((name) => detail.independentNames.includes(name)).length >= 2;
  // Card detail must show parameters / return type / reasons / side effects.
  detail.steps.cardParameters = detail.platformWrite !== null
    && /(unsigned int|address|value|入参|参数)/.test(detail.platformWrite.text);
  detail.steps.cardReturn = detail.platformWrite !== null && /(返回|return|int)/i.test(detail.platformWrite.text);
  detail.steps.cardReasons = detail.platformWrite !== null && /(理由|leaf_callee|cross_file_boundary|stable_signature|side_effects_present)/.test(detail.platformWrite.text);
  detail.steps.cardSideEffects = detail.steps.platformWriteSideEffects;

  // Add platform_write -> blackbox node in the graph, original node hidden.
  await clickTab(win, 'end_to_end');
  await waitViewReady(win, 'end_to_end', 30000);
  await sleep(700);
  detail.beforeAdd = await readGraphState(win);
  detail.addClick = await evaluate(win, `(() => {
    const card = [...document.querySelectorAll('[data-interface-candidate][data-interface-id]')]
      .find((element) => /platform_write/.test(element.innerText || element.textContent || ''));
    if (!card) return {ok: false, reason: 'platform_write card missing'};
    const add = card.querySelector('[data-interface-action="add"]')
      ?? [...card.querySelectorAll('button')].find((button) => /加入|添加|add/i.test((button.textContent || '') + (button.getAttribute('aria-label') || '')));
    if (!add) return {ok: false, reason: 'add action missing'};
    add.click();
    return {ok: true};
  })()`).catch(() => ({ok: false}));
  await sleep(1200);
  detail.afterAdd = await evaluate(win, `(() => {
    const blackboxes = [...document.querySelectorAll('[data-blackbox-node][data-interface-id]')].map((element) => ({
      interface_id: element.getAttribute('data-interface-id'),
      text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
    }));
    const nodes = [...document.querySelectorAll('[data-graph-node]')].map((element) => ({
      node_id: element.getAttribute('data-node-id'),
      kind: element.getAttribute('data-node-kind'),
      text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
    }));
    return {blackboxes, nodes};
  })()`).catch(() => ({blackboxes: [], nodes: []}));
  detail.steps.blackboxAppears = (detail.afterAdd.blackboxes ?? []).length > 0;
  const originalBefore = (detail.beforeAdd.nodes ?? []).filter((node) => /platform_write/.test(node.text));
  const originalAfter = (detail.afterAdd.nodes ?? []).filter((node) => /platform_write/.test(node.text) && !/blackbox/i.test(node.kind ?? ''));
  detail.originalNode = {before: originalBefore, after: originalAfter};
  detail.steps.originalHidden = originalBefore.length > 0 && originalAfter.length < originalBefore.length;
  detail.selectionAfterAdd = await evaluate(win, selectionExpr()).catch(() => null);
  detail.steps.selectionInterfaceField = detail.selectionAfterAdd !== null && typeof detail.selectionAfterAdd === 'object'
    && Object.prototype.hasOwnProperty.call(detail.selectionAfterAdd, 'interface_id');
  await screenshot(win, result, 'interfaces');

  // Remove -> blackbox gone, original node restored. After adding, the
  // candidate card is replaced by the blackbox node; the remove action lives in
  // the interface library state layer, so search the whole panel and poll for
  // the graph to settle back.
  detail.removeClick = await evaluate(win, `(() => {
    const remove = document.querySelector('[data-interface-action="remove"]');
    if (!remove) return {ok: false, reason: 'remove action missing', actions: document.querySelectorAll('[data-interface-action]').length};
    const interfaceId = remove.getAttribute('data-interface-id');
    remove.click();
    return {ok: true, interface_id: interfaceId};
  })()`).catch(() => ({ok: false}));
  const blackboxDeadline = Date.now() + 8000;
  let blackboxCount = null;
  while (Date.now() < blackboxDeadline) {
    await sleep(300);
    blackboxCount = await evaluate(win, `document.querySelectorAll('[data-blackbox-node][data-interface-id]').length`).catch(() => null);
    if (blackboxCount === 0) break;
  }
  detail.blackboxLeftAfterRemove = blackboxCount;
  detail.afterRemove = await readGraphState(win);
  const restoredOriginals = (detail.afterRemove.nodes ?? []).filter((node) => /platform_write/.test(node.text) && node.kind !== 'blackbox');
  detail.steps.blackboxRemoved = blackboxCount === 0;
  detail.steps.originalRestored = restoredOriginals.length >= originalBefore.length;
  detail.ok = Object.values(detail.steps).every((value) => value === true);
  result.views.interfaces = detail;
  return detail;
}

// ---------------------------------------------------------------------------
// S2b: subflow tab + breadcrumb
// ---------------------------------------------------------------------------
async function checkSubflow(win, result) {
  const detail = {ok: false, steps: {}};
  // Select check_length (a *process* node: the decision node also contains the
  // name inside its guard text and is not a valid subflow target).
  await clickTab(win, 'end_to_end');
  await waitViewReady(win, 'end_to_end', 30000);
  await evaluate(win, `(() => { const button = document.querySelector('[data-graph-expand-all]'); if (button) button.click(); return true; })()`).catch(() => null);
  await sleep(900);
  detail.baseline = await readGraphState(win);
  detail.baselineEdgeMeta = edgeMetadataMap(detail.baseline.edges);
  detail.selectNode = await evaluate(win, `(() => {
    const selector = ${JSON.stringify(subflowEntry)};
    const nodes = [...document.querySelectorAll('[data-graph-node]')];
    const node = nodes.find((element) => element.getAttribute('data-node-kind') === 'process'
      && new RegExp(selector).test(element.innerText || element.textContent || ''));
    if (!node) return {ok: false, reason: 'process node missing', process_nodes: nodes.filter((element) => element.getAttribute('data-node-kind') === 'process').map((element) => (element.innerText || '').slice(0, 40))};
    node.click();
    return {ok: true, node_id: node.getAttribute('data-node-id'), text: (node.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120)};
  })()`).catch(() => ({ok: false}));
  detail.steps.selectNode = detail.selectNode.ok === true;
  await sleep(900);
  // Details tabs hook (contract §10.4).
  detail.detailsTabs = await evaluate(win, `(() => [...document.querySelectorAll('[data-code-view="details-tab"][data-tab]')].map((element) => ({
    tab: element.getAttribute('data-tab'),
    text: (element.innerText || element.textContent || '').trim().slice(0, 40),
    pressed: element.getAttribute('aria-pressed'),
  })))()`).catch(() => []);
  detail.steps.detailsTabs = detail.detailsTabs.some((tab) => tab.tab === 'subflow');
  detail.clickSubflowTab = await evaluate(win, `(() => {
    const button = document.querySelector('[data-code-view="details-tab"][data-tab="subflow"]');
    if (!button) return {ok: false};
    button.click();
    return {ok: true};
  })()`).catch(() => ({ok: false}));
  // Wait for the async subflow payload: crumbs or the unavailable-gap must
  // appear (the section element itself is rendered in the loading state first).
  detail.subflowReady = await waitFor(win, `(() => {
    const crumbs = document.querySelectorAll('[data-breadcrumb] [data-crumb]').length;
    const gap = document.querySelector('[data-breadcrumb-gap]') !== null;
    const nodes = document.querySelectorAll('[data-subflow-node]').length;
    if (crumbs >= 2 || gap || nodes > 0) {
      return {crumb_count: crumbs, gap, subflow_nodes: nodes};
    }
    return false;
  })()`, 45000).catch(() => false);
  detail.steps.subflowView = detail.subflowReady !== false && detail.subflowReady !== null;
  await sleep(800);
  detail.subflowSection = await evaluate(win, `(() => {
    const section = document.querySelector('[data-code-view="subflow"]');
    return section === null ? null : {text: (section.innerText || section.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500)};
  })()`).catch(() => null);
  detail.subflowBreadcrumb = await evaluate(win, `(() => [...document.querySelectorAll('[data-breadcrumb] [data-crumb]')].map((element) => ({
    crumb: element.getAttribute('data-crumb'),
    text: (element.innerText || element.textContent || '').trim().slice(0, 120),
    index: element.getAttribute('data-crumb-index'),
  })))()`).catch(() => []);
  const breadcrumbText = (detail.subflowBreadcrumb ?? []).map((crumb) => crumb.text).join(' / ');
  detail.steps.breadcrumbHasRoot = /bus_send/.test(breadcrumbText);
  detail.steps.breadcrumbHasEntry = new RegExp(subflowEntry).test(breadcrumbText);
  detail.steps.breadcrumbRootFirst = (detail.subflowBreadcrumb ?? [])[0]?.index === '0' && /bus_send/.test((detail.subflowBreadcrumb ?? [])[0]?.text ?? '');
  detail.selectionSubflow = await evaluate(win, selectionExpr()).catch(() => null);
  detail.steps.selectionSubflowField = detail.selectionSubflow !== null && typeof detail.selectionSubflow === 'object'
    && Object.prototype.hasOwnProperty.call(detail.selectionSubflow, 'subflow_root_id');
  await screenshot(win, result, 'subflow', "document.querySelector('[data-code-view=\"subflow\"]')");

  // Click the root crumb -> main graph restored (same nodes/edges baseline).
  detail.clickRootCrumb = await evaluate(win, `(() => {
    const crumbs = [...document.querySelectorAll('[data-breadcrumb] [data-crumb]')];
    if (!crumbs.length) return {ok: false, reason: 'no crumbs'};
    crumbs[0].click();
    return {ok: true};
  })()`).catch(() => ({ok: false}));
  detail.steps.rootCrumbClick = detail.clickRootCrumb.ok === true;
  await sleep(1200);
  detail.mainAfterCrumb = await waitViewReady(win, 'end_to_end', 20000);
  await sleep(600);
  detail.afterRootCrumb = await readGraphState(win);
  const afterNodeIds = (detail.afterRootCrumb.nodes ?? []).map((node) => node.node_id).sort();
  const baselineNodeIds = (detail.baseline.nodes ?? []).map((node) => node.node_id).sort();
  detail.steps.mainGraphNodesRestored = JSON.stringify(afterNodeIds) === JSON.stringify(baselineNodeIds);
  const afterEdgeMeta = edgeMetadataMap(detail.afterRootCrumb.edges);
  detail.steps.mainGraphEdgesRestored = Object.keys(afterEdgeMeta).length > 0
    && Object.keys(detail.baselineEdgeMeta).every((id) => JSON.stringify(afterEdgeMeta[id]) === JSON.stringify(detail.baselineEdgeMeta[id]));
  detail.steps.subflowClosedAfterRoot = await evaluate(win, `document.querySelector('[data-code-view="subflow"]') === null || document.querySelector('[data-code-view="subflow"]')?.innerText?.includes('子流程') === true`).catch(() => false);
  detail.restore = {nodes: afterNodeIds.length, baseline_nodes: baselineNodeIds.length, edges: Object.keys(afterEdgeMeta).length, crumb_count: (detail.subflowBreadcrumb ?? []).length};
  detail.ok = Object.values(detail.steps).every((value) => value === true);
  result.views.subflow = detail;
  return detail;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const result = {
    ok: false,
    probe: 's2b',
    url: url ? url.replace(/token=[^&]+/, 'token=<redacted>') : null,
    entry_name: expectEntry,
    subflow_entry: subflowEntry,
    views: {},
    screenshots: {},
    steps: {},
  };
  try {
    const win = new BrowserWindow({
      show: false,
      width: 1500,
      height: 950,
      webPreferences: {contextIsolation: true, sandbox: false, backgroundThrottling: false},
    });
    win.webContents.on('console-message', (_event, level, message) => {
      const text = String(message).slice(0, 400);
      if (text.includes('Electron Security Warning')) return;
      consoleLines.push({level, message: text, at_ms: Date.now() - startedAt});
    });
    await win.loadURL(url);
    result.steps.pageLoaded = true;
    try {
      win.setOpacity(0);
      win.showInactive();
      result.steps.windowShownInvisible = true;
    } catch {
      result.steps.windowShownInvisible = false;
    }
    await waitFor(win, 'document.body && document.body.innerText.length > 0', 60000);
    result.steps.bodySettled = true;
    const opened = await openWorkbench(win, result);
    result.steps.workbenchOpened = opened === true;

    // End-to-end tab must be reachable before S2b checks.
    await clickTab(win, 'end_to_end');
    result.endToEndReady = await waitViewReady(win, 'end_to_end', 45000);
    result.steps.endToEndReady = result.endToEndReady.ready === true;
    await sleep(800);

    await ensurePanel(win, result, 'before-groups');
    const groups = await checkGroups(win, result);
    result.steps.groups = groups.ok === true;
    await ensurePanel(win, result, 'before-interfaces');
    const interfaces = await checkInterfaces(win, result);
    result.steps.interfaces = interfaces.ok === true;
    // Main graph evidence frame: end-to-end graph on the main (bus_send) root
    // after the interface library add/remove round-trip.
    await clickTab(win, 'end_to_end');
    await waitViewReady(win, 'end_to_end', 30000);
    await evaluate(win, `(() => { const button = document.querySelector('[data-graph-expand-all]'); if (button) button.click(); return true; })()`).catch(() => null);
    await sleep(800);
    await screenshot(win, result, 'main');
    result.steps.mainScreenshot = (result.screenshots.main ?? {}).ok === true;
    await ensurePanel(win, result, 'before-subflow');
    const subflow = await checkSubflow(win, result);
    result.steps.subflow = subflow.ok === true;

    // Selection/gaps/chrome state (main graph is restored after the root crumb).
    await clickTab(win, 'end_to_end');
    await waitViewReady(win, 'end_to_end', 30000);
    await sleep(600);
    result.selection = await evaluate(win, selectionExpr()).catch(() => null);
    result.steps.selectionExtensionFields = result.selection !== null && typeof result.selection === 'object'
      && ['group_id', 'interface_id', 'subflow_root_id'].every((field) => Object.prototype.hasOwnProperty.call(result.selection, field));
    result.gaps = await readGaps(win);
    const gapText = (result.gaps ?? []).map((gap) => `${gap.code} ${gap.text}`).join(' | ');
    result.steps.gapsIncludeOutOfScope = /ai_summary|ai 归纳|run_observation|场景/.test(gapText);
    result.leak = await evaluate(win, absolutePathLeakExpr()).catch(() => ({count: -1, samples: []}));
    result.steps.noAbsolutePaths = result.leak.count === 0;
    result.steps.noConsoleErrors = consoleLines.filter((line) => Number(line.level) >= 3).length === 0;

    const requiredSteps = [
      'pageLoaded', 'bodySettled', 'workbenchOpened', 'endToEndReady',
      'groups', 'interfaces', 'subflow', 'mainScreenshot',
      'selectionExtensionFields', 'gapsIncludeOutOfScope', 'noAbsolutePaths', 'noConsoleErrors',
    ];
    result.required_steps = requiredSteps;
    result.failed_steps = requiredSteps.filter((step) => result.steps[step] !== true);
    result.ok = result.failed_steps.length === 0;
    finish(result);
  } catch (error) {
    result.error = String(error && error.stack ? error.stack : error);
    result.failed_steps = Object.keys(result.steps).filter((step) => result.steps[step] !== true);
    finish(result);
  }
}

app.whenReady().then(main);

setTimeout(() => {
  finish({ok: false, timeout: true, steps: {}, views: {}, screenshots: {}, console_lines: consoleLines.slice(0, 100)});
}, overallTimeoutMs);
