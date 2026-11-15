// T7 / CL-VIEW-T2 (S2a) client-half contract tests.
//
// These tests load the REAL rc.5 client module (bundle/client.js) through the
// fake loader/window/document/React/ctx in tests/node/helpers/client-harness.mjs.
// They cover the preserved read-only slice (snapshot -> entry -> source /
// evidence / gaps / return-to-chat / remembered selection) and the new five
// views: coupling three-column layout, collapsible tree, orthogonal end-to-end
// graph with drag/fit/reset/search, static sequence warning, read-only files,
// global-resource rail + stub placeholder, legend, details panel and
// cross-view selection.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  BUS_SEND_ID,
  CHECK_LENGTH_ID,
  CHANNEL,
  LOOKUP_ROUTE_ID,
  PANEL_LABEL,
  PANEL_KEY,
  PLUGIN_ID,
  ROUTES_ID,
  SNAPSHOT_ID,
  STORE_ROUTE_ID,
  createHarness,
  deferred,
  failResult,
  makeCouplingPayload,
  makeEndToEndPayload,
  makeEntriesPayload,
  makeEntryPayload,
  makeFileReadPayload,
  makeFileTreePayload,
  makeSelection,
  makeSequencePayload,
  makeSnapshotsPayload,
  makeSourceLines,
  makeStatusPayload,
  makeTreePayload,
  makeWorkspace,
  readBundleSource,
} from './helpers/client-harness.mjs';

const ENTRY_NAMES = {
  [BUS_SEND_ID]: 'bus_send',
  [STORE_ROUTE_ID]: 'store_route',
  [LOOKUP_ROUTE_ID]: 'lookup_route',
  [CHECK_LENGTH_ID]: 'check_length',
};

function entryName(entryId) {
  return ENTRY_NAMES[entryId] || String(entryId).slice(0, 8);
}

function makeGetEntryHandler() {
  return (payload) => {
    const base = makeEntryPayload();
    const name = entryName(payload.entry);
    return makeEntryPayload({
      entry: {...base.entry, entry_id: payload.entry, name, display_name: name},
      selection: {...base.selection, entry_id: payload.entry},
    });
  };
}

function bootHarness(overrides = {}) {
  const h = createHarness();
  const handlers = {
    'view.status': () => makeStatusPayload(),
    'view.listSnapshots': () => makeSnapshotsPayload(),
    'view.listEntries': () => makeEntriesPayload(),
    'view.getEntry': makeGetEntryHandler(),
    'view.coupling': (payload) => makeCouplingPayload(payload.entry ? {} : {selection: makeSelection(), scope: {mode: 'snapshot', entry_id: null}}),
    'view.tree': () => makeTreePayload(),
    'view.endToEnd': () => makeEndToEndPayload(),
    'view.sequence': () => makeSequencePayload(),
    'view.fileTree': () => makeFileTreePayload(),
    'view.fileRead': (payload) => makeFileReadPayload({path: payload.path, repo_id: payload.repo}),
    ...overrides,
  };
  for (const [endpoint, handler] of Object.entries(handlers)) h.rpc.setResponse(endpoint, handler);
  return h;
}

async function openSnapshot(h) {
  h.clickData('data-snapshot-id', SNAPSHOT_ID);
  await h.settle();
}

async function openEntry(h) {
  await openSnapshot(h);
  h.clickData('data-entry-name', 'bus_send');
  await h.settle();
}

function tabButton(h, view) {
  return h.findAll((node) => node.tag === 'button' && node.props && node.props['data-view'] === view)[0];
}

async function switchView(h, view) {
  const button = tabButton(h, view);
  assert.ok(button, `tab ${view} is missing`);
  h.clickNode(button);
  await h.settle();
}

function viewRoot(h) {
  return h.nodeByData('data-code-view', 'view');
}

function selectionJson(h) {
  return JSON.parse(h.textOf(h.nodeByData('data-code-view', 'selection')));
}

function detailsNode(h) {
  return h.nodeByData('data-code-view', 'details');
}

function nodesWithAttribute(h, attribute) {
  return h.findAll((node) => node.props && node.props[attribute] !== undefined);
}

function textIncludes(h, needle) {
  return h.text().includes(needle);
}

function captureConsole() {
  const captured = [];
  const originals = {};
  for (const name of ['log', 'warn', 'error']) {
    originals[name] = console[name];
    console[name] = (...args) => {
      captured.push(args.map((value) => String(value)).join(' '));
    };
  }
  return {
    captured,
    restore() {
      for (const name of ['log', 'warn', 'error']) console[name] = originals[name];
    },
  };
}

function assertNoAbsolutePaths(text) {
  assert.equal(text.includes('E:\\'), false, 'absolute Windows path leaked into the UI');
  assert.equal(text.includes('C:/'), false, 'absolute POSIX path leaked into the UI');
  assert.equal(text.includes('bootstrap.json'), false, 'raw bootstrap path leaked into the UI');
  assert.equal(/\n\s+at\s/.test(text), false, 'stack trace leaked into the UI');
}

// ---------------------------------------------------------------------------
// 1. loader wrapper, slots and plugin shape
// ---------------------------------------------------------------------------

test('rc.5 loader wrapper: id, first executable statement, only react, plugin shape', async (t) => {
  const source = readBundleSource();
  assert.ok(source.length < 160 * 1024, `bundle source must stay below 160KB, got ${source.length}`);
  const withoutLeadingComment = source.replace(/^\s*\/\*[\s\S]*?\*\//, '').trimStart();
  assert.ok(
    withoutLeadingComment.startsWith('window.__ModuleLoader__.load({'),
    'first executable statement must be window.__ModuleLoader__.load({...})',
  );
  const h = createHarness();
  t.after(() => h.dispose());
  assert.equal(h.loadError, null, `bundle failed to execute: ${h.loadError?.message}`);
  assert.equal(h.factoryError, null, `factory threw: ${h.factoryError?.message}`);
  assert.equal(h.registrations.length, 1);
  assert.equal(h.registration.id, PLUGIN_ID);
  assert.deepEqual(h.requires, ['react'], 'the bundle may only require the static react seed');
  assert.equal(h.plugin.name, 'dsh-code-reader');
  assert.deepEqual(h.plugin.inject, ['slots', 'layout', 'connection']);
  assert.equal(typeof h.plugin.apply, 'function');
});

test('registers keyed main + sidebar panellist, injects one style, dispose cleans, second apply works', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  assert.equal(h.styleCount(), 1, 'exactly one <style data-code-view-style> is injected at materialization');
  const style = h.styleNode();
  assert.ok(style);
  assert.equal(style.parentNode, h.document.head);
  assert.ok(style.hasAttribute('data-code-view-style'));
  const css = String(style.textContent);
  for (const needle of [
    'dcr-',
    'var(--dsh-',
    'currentColor',
    '@media (max-width:720px)',
    '@media (max-width:900px)',
    ':focus-visible',
    'grid-template-columns',
    'prefers-reduced-motion',
  ]) {
    assert.ok(css.includes(needle), `stylesheet must contain ${JSON.stringify(needle)}`);
  }
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css), false, 'theme colors must not be hard-coded');

  h.apply();
  assert.equal(h.styleCount(), 1, 'apply must not inject a second stylesheet');
  const main = h.mainEntry();
  assert.ok(main, `main slot key "${PANEL_KEY}" must be registered`);
  assert.equal(main.options.name, 'main');
  assert.equal(main.options.key, PANEL_KEY);
  assert.equal(typeof main.component, 'function');
  const panellist = h.panellistEntry();
  assert.ok(panellist);
  assert.equal(panellist.options.name, 'sidebar.panellist');
  assert.equal(panellist.options.id, PANEL_KEY);
  assert.equal(panellist.options.order, 30);
  assert.equal(panellist.options.label(), PANEL_LABEL);
  const icon = panellist.component({size: 18});
  assert.equal(icon.type, 'svg');
  assert.equal(icon.props.role, 'img');
  assert.equal(icon.props['aria-label'], PANEL_LABEL);

  h.ctx.dispose();
  assert.equal(h.slots.entriesOfSlot('main').length, 0);
  assert.equal(h.slots.entriesOfSlot('sidebar.panellist').length, 0);
  assert.equal(h.styleCount(), 0);
  h.apply();
  assert.equal(h.slots.entriesOfSlot('main').length, 1);
  assert.equal(h.slots.entriesOfSlot('sidebar.panellist').length, 1);
  assert.equal(h.styleCount(), 1);
  h.ctx.dispose();
  assert.equal(h.slots.entriesOfSlot('main').length, 0);
  assert.equal(h.styleCount(), 0);
});

// ---------------------------------------------------------------------------
// 2. preserved read-only slice
// ---------------------------------------------------------------------------

test('open flow: status -> listSnapshots, snapshot -> entries+coupling, entry -> getEntry', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  assert.deepEqual(h.rpc.endpoints(), ['view.status', 'view.listSnapshots']);
  assert.equal(h.nodeByData('data-code-view', 'status').props['data-state'], 'ready');
  assert.ok(h.nodeByData('data-code-view', 'panel'));

  const snapshot = h.nodeByData('data-snapshot-id', SNAPSHOT_ID);
  assert.ok(snapshot);
  assert.equal(snapshot.tag, 'button');
  const snapshotText = h.textOf(snapshot);
  for (const needle of [SNAPSHOT_ID, 'verified', 'fresh', '入口 14', 'failed 0', 'pending 0', 'whole_program_complete false']) {
    assert.ok(snapshotText.includes(needle), `snapshot row must show ${JSON.stringify(needle)}`);
  }

  await openSnapshot(h);
  assert.equal(h.rpc.callsFor('view.listEntries').length, 1);
  assert.deepEqual(h.rpc.lastPayload('view.listEntries'), {workspace: 'code-view-bus-demo', snapshot: SNAPSHOT_ID});
  assert.equal(h.rpc.callsFor('view.coupling').length, 1, 'coupling is projected for the snapshot before an entry is chosen');
  assert.equal(h.rpc.lastPayload('view.coupling').entry, undefined);
  const entryButtons = h.findAll((node) => node.props?.['data-entry-id'] !== undefined && node.props?.['data-entry-name'] !== undefined);
  assert.deepEqual(entryButtons.map((node) => node.props['data-entry-name']), ['bus_send', 'store_route']);

  h.clickData('data-entry-name', 'bus_send');
  await h.settle();
  assert.equal(h.rpc.callsFor('view.getEntry').length, 1);
  assert.deepEqual(h.rpc.lastPayload('view.getEntry'), {workspace: 'code-view-bus-demo', snapshot: SNAPSHOT_ID, entry: BUS_SEND_ID});
  assert.equal(h.rpc.callsFor('view.coupling').at(-1).payload.entry, BUS_SEND_ID, 'coupling scope moves to entry_neighborhood');
  assert.ok(textIncludes(h, 'bus_send'));
  assert.ok(h.nodeByData('data-line', '152'), 'entry source window must preserve the old data-line hook');
  assert.ok(detailsNode(h), 'entry selection opens the details panel');
  assert.equal(h.nodeByData('data-entry-name', 'bus_send').props['aria-current'], 'true');
});

test('loading / empty / gap / error states are exposed through data-state', async (t) => {
  const statusDeferred = deferred();
  const loadingHarness = createHarness();
  loadingHarness.rpc.setResponse('view.status', () => statusDeferred.promise);
  for (const [endpoint, handler] of Object.entries({
    'view.listSnapshots': () => makeSnapshotsPayload(),
    'view.listEntries': () => makeEntriesPayload(),
    'view.getEntry': makeGetEntryHandler(),
    'view.coupling': () => makeCouplingPayload(),
    'view.tree': () => makeTreePayload(),
    'view.endToEnd': () => makeEndToEndPayload(),
    'view.sequence': () => makeSequencePayload(),
    'view.fileTree': () => makeFileTreePayload(),
    'view.fileRead': (payload) => makeFileReadPayload({path: payload.path}),
  })) loadingHarness.rpc.setResponse(endpoint, handler);
  t.after(() => loadingHarness.dispose());
  loadingHarness.apply();
  loadingHarness.mountMain();
  assert.equal(loadingHarness.nodeByData('data-code-view', 'status').props['data-state'], 'loading');
  statusDeferred.resolve(makeStatusPayload());
  await loadingHarness.settle();
  assert.equal(loadingHarness.nodeByData('data-code-view', 'status').props['data-state'], 'ready');

  const emptyHarness = bootHarness({'view.listSnapshots': () => makeSnapshotsPayload({workspaces: [makeWorkspace({snapshots: []})]})});
  t.after(() => emptyHarness.dispose());
  await emptyHarness.boot();
  assert.equal(emptyHarness.nodeByData('data-code-view', 'status').props['data-state'], 'empty');
  assert.ok(emptyHarness.findByData('data-gap-code', 'no_snapshot').length > 0);

  const gapHarness = bootHarness({
    'view.status': () => makeStatusPayload({engine: {python: 'missing', bootstrap: {configured: true, exists: false}}}),
    'view.listSnapshots': () => failResult('BRIDGE_UNAVAILABLE', 'python engine unavailable'),
  });
  t.after(() => gapHarness.dispose());
  await gapHarness.boot();
  assert.ok(gapHarness.nodeByData('data-code-view', 'panel'), 'missing engine must not hide the panel');
  assert.equal(gapHarness.nodeByData('data-code-view', 'status').props['data-state'], 'gap');
  assert.ok(gapHarness.findByData('data-gap-code', 'engine_python_missing').length > 0);
  assert.ok(gapHarness.findByData('data-gap-code', 'bootstrap_missing').length > 0);

  const errorHarness = bootHarness({
    'view.status': () => failResult('ENGINE_BLOCKED', 'engine exit 2'),
    'view.listSnapshots': () => failResult('ENGINE_BLOCKED', 'engine exit 2'),
  });
  t.after(() => errorHarness.dispose());
  await errorHarness.boot();
  assert.equal(errorHarness.nodeByData('data-code-view', 'status').props['data-state'], 'error');
  assert.equal(errorHarness.nodeByData('data-code-view', 'error').props['data-error-code'], 'ENGINE_BLOCKED');
});

test('source window: line numbers, highlight interval, source_text badge', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  assert.ok(h.nodeByData('data-code-view', 'source'));
  const line152 = h.nodeByData('data-line', '152');
  assert.ok(line152);
  assert.equal(line152.props['data-highlight'], 'true');
  assert.ok(h.textOf(line152).includes('int bus_send(unsigned channel, unsigned length)'));
  assert.equal(h.nodeByData('data-line', '174').props['data-highlight'], 'true');
  assert.ok(h.findByData('data-evidence-class', 'source_text').length > 0);
  assert.ok(h.findByData('data-evidence-id', 'e_call_lookup').length > 0);
});

test('highlight only marks the highlight interval when the window has context lines', async (t) => {
  const entry = makeEntryPayload({
    source: {line_start: 150, line_end: 176, lines: makeSourceLines(150, 176), highlight: {line_start: 152, line_end: 174}},
  });
  const h = bootHarness({'view.getEntry': () => entry});
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  assert.equal(h.nodeByData('data-line', '150').props['data-highlight'], undefined);
  assert.equal(h.nodeByData('data-line', '152').props['data-highlight'], 'true');
  assert.equal(h.nodeByData('data-line', '174').props['data-highlight'], 'true');
  assert.equal(h.nodeByData('data-line', '176').props['data-highlight'], undefined);
});

test('readonly details keep call-edge evidence badges and resource identifiers', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  for (const classification of ['exact', 'may', 'unknown', 'source_text']) {
    const badges = h.findByData('data-evidence-class', classification);
    assert.ok(badges.length > 0, `missing ${classification} evidence badge`);
  }
  assert.ok(h.findByData('data-evidence-class', 'exact').some((badge) => h.textOf(badge).includes('静态确定')));
  assert.ok(h.findByData('data-evidence-class', 'may').some((badge) => h.textOf(badge).includes('候选')));
  assert.ok(h.findByData('data-evidence-class', 'unknown').some((badge) => h.textOf(badge).includes('未知')));
  assert.ok(h.findByData('data-evidence-class', 'source_text').some((badge) => h.textOf(badge).includes('源码证据')));
  const exactRow = h.nodeByData('data-callsite-id', 'c_lookup');
  assert.ok(exactRow);
  for (const needle of ['exact', 'deterministic_analysis', 'bus.c:160', 'lookup_route', 'e_call_lookup']) {
    assert.ok(h.textOf(exactRow).includes(needle), `call row must show ${needle}`);
  }
  const resources = h.nodeByData('data-code-view', 'resources');
  assert.ok(resources);
  const resourcesText = h.textOf(resources);
  for (const needle of ['资源标识', 'routes', 'struct Route[4]', 'STATIC', 'bus.c:26']) {
    assert.ok(resourcesText.includes(needle), `resources block must show ${needle}`);
  }
  assert.ok(h.nodeByData('data-resource-id', ROUTES_ID));
  const write = h.nodeByData('data-field-access', 'field_routes_max_len_write');
  assert.equal(write.props['data-access'], 'write');
  assert.equal(write.props['data-certainty'], 'exact');
  const read = h.nodeByData('data-field-access', 'field_routes_max_len_read');
  assert.equal(read.props['data-access'], 'read');
  assert.equal(read.props['data-certainty'], 'may');
});

test('unavailable resources keep their real reason in gaps, never a fake empty list', async (t) => {
  const reason = 'resource_layer_not_in_this_atlas_snapshot';
  const entry = makeEntryPayload({
    resources: {status: 'unavailable', reason, objects: [], field_accesses: [], gaps: [], truncated: false},
    selection: {resource_ids: [], resource_status: 'unavailable'},
    gaps: [],
  });
  const h = bootHarness({
    'view.status': () => makeStatusPayload({gaps: [{code: 'resource_graph', status: 'unavailable', reason: 'resource_graph_view_not_in_readonly_slice'}]}),
    'view.getEntry': () => entry,
    'view.coupling': () => makeCouplingPayload({resources: [], functions: [], edges: [], external_nodes: [], selection: makeSelection()}),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  const resources = h.nodeByData('data-code-view', 'resources');
  assert.ok(h.textOf(resources).includes(reason));
  assert.equal(nodesWithAttribute(h, 'data-resource-id').length, 0);
  const resourceGaps = h.findByData('data-gap-code', 'resource_graph');
  assert.ok(resourceGaps.some((gap) => h.textOf(gap).includes(reason)), 'resource-layer reason must reach the gap rows');
  const selection = selectionJson(h);
  assert.deepEqual(selection.resource_ids, []);
  assert.equal(selection.resource_status, 'unavailable');
});

test('gaps keep server code/status/reason and add S2b placeholders with gap-code hooks', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  assert.equal(h.nodeByData('data-code-view', 'status').props['data-state'], 'ready');
  const scenario = h.nodeByData('data-gap-code', 'scenario_execution');
  assert.ok(scenario);
  assert.ok(h.textOf(scenario).includes('本轮只读切片；场景执行/打桩/回退未实现'));
  for (const code of ['group_collapse', 'interface_library', 'ai_summary', 'run_observation']) {
    assert.ok(h.findByData('data-gap-code', code).length > 0, `missing S2a/S2b gap ${code}`);
  }
  assert.equal(h.findByData('data-gap-code', 'five_views').length, 0, 'five views are implemented in S2a');
  assert.ok(h.findAll((node) => node.props && node.props['data-code-view'] === 'gap-code').length >= 4);
  assert.equal(h.text().includes('not_available_in_readonly_slice'), false);
});

test('invalid snapshot is listed with its verification error and a gap', async (t) => {
  const invalid = makeWorkspace({snapshot: {status: 'invalid', error: {code: 'STALE_SNAPSHOT', message: 'graph hash mismatch'}}});
  const h = bootHarness({'view.listSnapshots': () => makeSnapshotsPayload({workspaces: [invalid]})});
  t.after(() => h.dispose());
  await h.boot();
  const snapshotText = h.textOf(h.nodeByData('data-snapshot-id', SNAPSHOT_ID));
  for (const needle of ['invalid', '无效', 'STALE_SNAPSHOT']) assert.ok(snapshotText.includes(needle));
  const gap = h.nodeByData('data-gap-code', 'STALE_SNAPSHOT');
  assert.ok(gap);
  assert.ok(h.textOf(gap).includes('graph hash mismatch'));
  assert.equal(h.nodeByData('data-code-view', 'status').props['data-state'], 'ready');
});

test('engine errors show data-error-code + message and never absolute paths or stacks', async (t) => {
  const consoleSpy = captureConsole();
  t.after(() => consoleSpy.restore());
  const badMessage = 'python missing: E:\\secret\\bootstrap.json\n    at runCli (E:\\secret\\engine.js:1:1)\n    at async main';
  const h = bootHarness({
    'view.status': () => failResult('BRIDGE_UNAVAILABLE', badMessage),
    'view.listSnapshots': () => failResult('BRIDGE_UNAVAILABLE', badMessage),
  });
  t.after(() => h.dispose());
  await h.boot();
  const errorNode = h.nodeByData('data-code-view', 'error');
  assert.equal(errorNode.props['data-error-code'], 'BRIDGE_UNAVAILABLE');
  const errorText = h.textOf(errorNode);
  assert.ok(errorText.includes('python missing'));
  assertNoAbsolutePaths(errorText);
  assertNoAbsolutePaths(h.text());
  for (const line of consoleSpy.captured) assertNoAbsolutePaths(line);
});

test('engine CLI error document (value without top-level ok) surfaces data-error-code', async (t) => {
  const engineError = {
    schema_version: 1,
    error: {code: 'STALE_SNAPSHOT', message: 'snapshot hash mismatch', details_ref: null, retryable: false},
    operation_id: null,
  };
  const h = bootHarness({'view.status': () => engineError, 'view.listSnapshots': () => engineError});
  t.after(() => h.dispose());
  await h.boot();
  assert.equal(h.nodeByData('data-code-view', 'error').props['data-error-code'], 'STALE_SNAPSHOT');
  assert.equal(h.nodeByData('data-code-view', 'status').props['data-state'], 'error');
});

test('getEntry failure shows the engine error code and keeps the panel usable', async (t) => {
  const h = bootHarness({'view.getEntry': () => failResult('ENGINE_BLOCKED', 'engine exit 2: blocked by coverage gate')});
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  const errors = h.findByData('data-code-view', 'error');
  assert.ok(errors.length > 0);
  assert.equal(errors[0].props['data-error-code'], 'ENGINE_BLOCKED');
  assert.ok(h.nodeByData('data-code-view', 'panel'));
  assert.ok(h.nodeByData('data-snapshot-id', SNAPSHOT_ID));
});

test('view endpoint failure exposes data-error-code and keeps the panel usable', async (t) => {
  const h = bootHarness({'view.endToEnd': () => failResult('ENGINE_FAILED', 'engine failed: E:\\work\\engine\\run.py')});
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await switchView(h, 'end_to_end');
  assert.equal(viewRoot(h).props['data-state'], 'error');
  const errorNode = h.nodeByData('data-code-view', 'error');
  assert.equal(errorNode.props['data-error-code'], 'ENGINE_FAILED');
  assertNoAbsolutePaths(h.text());
  assert.ok(h.nodeByData('data-code-view', 'panel'));
});

test('return-to-chat calls layout.selectPanel(null)', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  assert.ok(h.textOf(h.button('返回聊天')).includes('返回聊天'));
  h.clickButton('返回聊天');
  assert.deepEqual(h.layout.selection, [null]);
});

test('Selection JSON carries §2 fields plus S2a focus fields', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openSnapshot(h);
  const before = selectionJson(h);
  assert.deepEqual(Object.keys(before), [
    'workspace_id', 'variant_id', 'snapshot_id', 'repo_id', 'entry_id', 'symbol_id',
    'callsite_ids', 'callsite_path', 'resource_ids', 'resource_status', 'evidence_ids',
    'run_id', 'event_id', 'focus_resource_id', 'focus_callsite_id',
  ]);
  assert.equal(before.workspace_id, 'code-view-bus-demo');
  assert.equal(before.snapshot_id, SNAPSHOT_ID);
  assert.equal(before.entry_id, null);
  assert.deepEqual(before.resource_ids, []);
  assert.equal(before.resource_status, 'unavailable');
  assert.equal(before.focus_resource_id, null);
  assert.equal(before.focus_callsite_id, null);
  await h.settle();
  h.clickData('data-entry-name', 'bus_send');
  await h.settle();
  const after = selectionJson(h);
  assert.equal(after.entry_id, BUS_SEND_ID);
  assert.equal(after.symbol_id, 's_9a99bb2c95e28f92052a6d4b');
});

test('re-opening the panel restores the last snapshot/entry and refetches data', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  assert.equal(selectionJson(h).entry_id, BUS_SEND_ID);
  assert.ok(h.nodeByData('data-line', '152'));

  h.unmountMain();
  await h.settle();
  h.remountMain();
  await h.settle();
  assert.equal(h.rpc.callsFor('view.status').length, 2);
  assert.equal(h.rpc.callsFor('view.listSnapshots').length, 2);
  assert.equal(h.rpc.callsFor('view.listEntries').length, 2);
  assert.equal(h.rpc.callsFor('view.getEntry').length, 2);
  assert.equal(selectionJson(h).snapshot_id, SNAPSHOT_ID);
  assert.equal(selectionJson(h).entry_id, BUS_SEND_ID);
  assert.equal(h.nodeByData('data-snapshot-id', SNAPSHOT_ID).props['aria-pressed'], 'true');
  assert.ok(h.nodeByData('data-line', '152'), 'source window must be restored after re-open');
  assert.equal(h.nodeByData('data-entry-name', 'bus_send').props['aria-current'], 'true');
  assert.ok(detailsNode(h));
});

test('a fresh module instance does not inherit another harness remembered selection', async (t) => {
  const first = bootHarness();
  t.after(() => first.dispose());
  await first.boot();
  await openEntry(first);
  first.unmountMain();
  await first.settle();

  const second = bootHarness();
  t.after(() => second.dispose());
  await second.boot();
  assert.equal(second.rpc.callsFor('view.listEntries').length, 0);
  assert.equal(selectionJson(second).snapshot_id, null);
});

test('RPC calls stay on the /code-view channel with contract payload shapes', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openSnapshot(h);
  for (const call of h.rpc.calls) {
    assert.equal(call.channel, CHANNEL);
    assert.ok(String(call.endpoint).startsWith('view.'), `unexpected endpoint ${call.endpoint}`);
    assert.equal(call.payload && typeof call.payload, 'object');
  }
  assert.deepEqual(h.rpc.lastPayload('view.listEntries'), {workspace: 'code-view-bus-demo', snapshot: SNAPSHOT_ID});
  assert.deepEqual(Object.keys(h.rpc.callsFor('view.coupling')[0].payload).sort(), ['snapshot', 'workspace']);
  h.clickData('data-entry-name', 'bus_send');
  await h.settle();
  assert.deepEqual(h.rpc.lastPayload('view.coupling'), {workspace: 'code-view-bus-demo', snapshot: SNAPSHOT_ID, entry: BUS_SEND_ID});
});

// ---------------------------------------------------------------------------
// 3. tabs and view shells
// ---------------------------------------------------------------------------

test('five view tabs exist, switch, and each view reaches data-state=ready', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  const tabs = h.findAll((node) => node.tag === 'button' && node.props && node.props['data-view'] !== undefined && node.props['aria-pressed'] !== undefined);
  assert.deepEqual(tabs.map((node) => node.props['data-view']), ['coupling', 'tree', 'end_to_end', 'sequence', 'file']);
  assert.ok(h.nodeByData('data-code-view', 'tabs'));
  assert.equal(viewRoot(h).props['data-view'], 'coupling');
  assert.equal(viewRoot(h).props['data-state'], 'ready');

  await switchView(h, 'tree');
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  await switchView(h, 'end_to_end');
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  await switchView(h, 'sequence');
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  await switchView(h, 'file');
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  await switchView(h, 'coupling');
  assert.equal(tabButton(h, 'coupling').props['aria-pressed'], 'true');
  const endpoints = new Set(h.rpc.endpoints());
  for (const endpoint of ['view.coupling', 'view.getEntry', 'view.tree', 'view.endToEnd', 'view.sequence', 'view.fileTree', 'view.fileRead']) {
    assert.ok(endpoints.has(endpoint), `missing endpoint call ${endpoint}`);
  }
});

test('views that need an entry show an empty reason until an entry is chosen', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openSnapshot(h);
  await switchView(h, 'tree');
  assert.equal(viewRoot(h).props['data-state'], 'empty');
  assert.ok(textIncludes(h, '需要先选择一个入口'));
  assert.equal(h.rpc.callsFor('view.tree').length, 0);
});

// ---------------------------------------------------------------------------
// 4. coupling + global-resource rail
// ---------------------------------------------------------------------------

test('coupling renders writers/resources/readers columns with access edges and certainty', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  const columns = h.findAll((node) => node.props && node.props['data-coupling-column'] !== undefined).map((node) => node.props['data-coupling-column']);
  assert.deepEqual(columns, ['writer', 'resource', 'reader']);
  const resourceNode = h.nodeByData('data-resource-node', ROUTES_ID);
  assert.ok(resourceNode);
  assert.ok(h.textOf(resourceNode).includes('routes'));
  assert.ok(h.textOf(resourceNode).includes('max_len'));
  assert.ok(h.nodeByData('data-function-node', STORE_ROUTE_ID));
  assert.ok(h.nodeByData('data-function-node', BUS_SEND_ID));

  const writeEdge = h.findAll((node) => node.props && node.props['data-access-edge'] !== undefined && node.props['data-access'] === 'write')[0];
  assert.ok(writeEdge, 'write access edge is missing');
  assert.equal(writeEdge.props['data-certainty'], 'exact');
  assert.equal(writeEdge.props['data-field-name'], 'max_len');
  assert.equal(writeEdge.props['data-file'], 'bus.c');
  assert.equal(writeEdge.props['data-line'], '46');
  const readEdges = h.findAll((node) => node.props && node.props['data-access-edge'] !== undefined && node.props['data-access'] === 'read');
  assert.ok(readEdges.length >= 2);
  assert.ok(readEdges.every((edge) => edge.props['data-certainty'] === 'may'));
  assert.ok(readEdges.some((edge) => edge.props['data-line'] === '92'));
  assert.ok(readEdges.some((edge) => edge.props['data-line'] === '98'));
  assert.ok(textIncludes(h, '外部边界'));
  assert.ok(textIncludes(h, 'platform_write'));
});

test('coupling resource click highlights functions without opening details; function click opens details', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  const canvas = h.findAll((node) => String((node.props && node.props.className) || '').includes('dcr-coupling-columns'))[0];
  assert.ok(canvas && typeof canvas.props.onClick === 'function');
  h.clickNode(canvas);
  await h.settle();
  assert.equal(detailsNode(h), null, 'blank canvas click closes details');
  h.clickNode(h.nodeByData('data-resource-node', ROUTES_ID));
  await h.settle();
  assert.equal(detailsNode(h), null, 'resource click only highlights, details stay collapsed');
  assert.equal(selectionJson(h).focus_resource_id, ROUTES_ID);
  assert.ok(h.findAll((node) => String((node.props && node.props.className) || '').includes('dcr-highlight')).length > 0);
  h.clickNode(h.nodeByData('data-function-node', STORE_ROUTE_ID));
  await h.settle();
  assert.ok(detailsNode(h), 'function click opens details');
  assert.deepEqual(h.rpc.lastPayload('view.getEntry'), {workspace: 'code-view-bus-demo', snapshot: SNAPSHOT_ID, entry: STORE_ROUTE_ID});
  assert.equal(viewRoot(h).props['data-view'], 'coupling');
});

test('global-resource rail lists related resources, direction tags, and the stub placeholder', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  const railButtons = h.findAll((node) => node.props && node.props['data-rail'] !== undefined).map((node) => node.props['data-rail']);
  assert.deepEqual(railButtons, ['resources', 'stub']);
  const rows = h.findAll((node) => node.props && node.props['data-resource-row'] !== undefined);
  assert.equal(rows.length, 1);
  const rowText = h.textOf(rows[0]);
  for (const needle of ['routes', 'struct Route[4]', 'STATIC', 'bus.c:26', '字段：lane、max_len', '读取', '写入 / 修改']) {
    assert.ok(rowText.includes(needle), `resource row must show ${needle}`);
  }
  assert.ok(String(rows[0].props.className).includes('dcr-related'));

  await switchView(h, 'tree');
  h.clickNode(h.nodeByData('data-resource-row', ROUTES_ID));
  await h.settle();
  assert.equal(viewRoot(h).props['data-view'], 'coupling', 'rail resource click locates the resource in coupling');
  assert.ok(detailsNode(h));
  assert.ok(h.textOf(detailsNode(h)).includes('资源详情'));
  assert.ok(h.textOf(detailsNode(h)).includes('写入 / 修改'));

  h.clickData('data-rail', 'stub');
  await h.settle();
  const stub = h.findByData('data-stub-panel', '')[0];
  assert.ok(stub);
  assert.ok(h.textOf(stub).includes('CW-T3'));
  assert.ok(h.textOf(stub).includes('打桩模拟'));
});

// ---------------------------------------------------------------------------
// 5. collapsible text tree
// ---------------------------------------------------------------------------

test('tree renders the entry root, call/guard/return details and toggles', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await switchView(h, 'tree');
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  const treeNodes = h.findAll((node) => node.props && node.props['data-tree-node'] !== undefined);
  assert.equal(treeNodes.length, 5);
  assert.equal(treeNodes[0].props['data-depth'], '0');
  assert.ok(h.textOf(treeNodes[0]).includes('bus_send'));
  const checkNode = treeNodes.find((node) => h.textOf(node).includes('check_length'));
  assert.ok(checkNode);
  assert.ok(h.textOf(checkNode).includes('if (!check_length(route, length))'));
  assert.ok(h.textOf(checkNode).includes('-90'));
  assert.ok(h.textOf(treeNodes[treeNodes.length - 1]).includes('外部边界'));
  assert.ok(h.nodeByData('data-tree-toggle', 'n_1'));
  h.clickNode(h.nodeByData('data-tree-toggle', 'n_1'));
  await h.settle();
  assert.equal(h.findAll((node) => node.props && node.props['data-tree-node'] !== undefined).length, 1);
  h.clickNode(h.nodeByData('data-tree-toggle', 'n_1'));
  await h.settle();
  assert.equal(h.findAll((node) => node.props && node.props['data-tree-node'] !== undefined).length, 5);
});

test('tree node click switches to the file view at the function line', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await switchView(h, 'tree');
  const lookupButton = h.findAll((node) => node.tag === 'button' && String(node.props.className || '').includes('dcr-tree-name') && h.textOf(node).includes('lookup_route'))[0];
  h.clickNode(lookupButton);
  await h.settle();
  assert.equal(viewRoot(h).props['data-view'], 'file');
  assert.equal(h.rpc.lastPayload('view.fileRead').path, 'bus.c');
  assert.equal(h.nodeByData('data-line', '89').props['data-highlight'], 'true');
  assert.ok(detailsNode(h));
  assert.equal(h.rpc.lastPayload('view.getEntry').entry, LOOKUP_ROUTE_ID);
});

// ---------------------------------------------------------------------------
// 6. end-to-end graph
// ---------------------------------------------------------------------------

test('end-to-end graph renders entry/decision/exit/external nodes with orthogonal edges', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await switchView(h, 'end_to_end');
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  const nodes = h.findAll((node) => node.props && node.props['data-graph-node'] !== undefined);
  const kinds = nodes.map((node) => node.props['data-node-kind']);
  for (const kind of ['entry', 'process', 'decision', 'exit', 'external']) assert.ok(kinds.includes(kind), `missing node kind ${kind}`);
  const entryNode = nodes.find((node) => node.props['data-node-kind'] === 'entry');
  assert.equal(entryNode.props['data-shape'], 'ellipse');
  assert.ok(h.textOf(entryNode).includes('bus_send'));
  const decision = nodes.find((node) => node.props['data-node-kind'] === 'decision');
  assert.equal(decision.props['data-shape'], 'diamond');
  assert.ok(h.textOf(decision).includes('if (!check_length(route, length))'));
  const errorExit = nodes.find((node) => node.props['data-node-kind'] === 'exit' && node.props['data-role'] === 'error');
  assert.ok(errorExit);
  assert.ok(h.textOf(errorExit).includes('-90'));
  const external = nodes.find((node) => node.props['data-node-kind'] === 'external');
  assert.equal(external.props['data-shape'], 'rectangle');
  assert.ok(h.textOf(external).includes('platform_write'));
  assert.equal(nodes.find((node) => node.props['data-node-kind'] === 'entry').props['data-shape'], 'ellipse');

  const edges = h.findAll((node) => node.props && node.props['data-graph-edge'] !== undefined);
  const edgeKinds = edges.map((node) => node.props['data-edge-kind']);
  for (const kind of ['call', 'guard', 'return', 'external']) assert.ok(edgeKinds.includes(kind), `missing edge kind ${kind}`);
  const exceptionEdges = edges.filter((node) => node.props['data-color'] === 'exception');
  assert.ok(exceptionEdges.length >= 1);
  assert.equal(exceptionEdges[0].props['data-edge-kind'], 'return');
  assert.ok(edges.every((edge) => /^[MHV0-9\s.-]+$/.test(String(edge.props.d))), 'edges must be orthogonal H/V polylines');
  for (const edge of edges) assert.ok(['exact', 'may', 'unknown'].includes(edge.props['data-certainty']));
  assert.equal(h.findByData('data-graph-fit', '').length, 1);
  assert.equal(h.findAll((node) => node.props && node.props['data-graph-search'] !== undefined).length, 1);
});

test('end-to-end graph supports drag, reset, search and blank-click close', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await switchView(h, 'end_to_end');
  const graphNodes = () => h.findAll((node) => node.props && node.props['data-graph-node'] !== undefined);
  const entryNodeId = graphNodes().find((node) => node.props['data-node-kind'] === 'entry').props['data-node-id'];
  const before = graphNodes().find((node) => node.props['data-node-id'] === entryNodeId).props.style.left;
  graphNodes().find((node) => node.props['data-node-id'] === entryNodeId)
    .props.onPointerDown({clientX: 10, clientY: 10, pointerId: 1, button: 0, stopPropagation() {}, preventDefault() {}});
  await h.settle();
  let viewport = h.findAll((node) => String((node.props && node.props.className) || '').includes('dcr-canvas-viewport'))[0];
  viewport.props.onPointerMove({clientX: 140, clientY: 110, pointerId: 1});
  await h.settle();
  const moved = graphNodes().find((node) => node.props['data-node-id'] === entryNodeId).props.style.left;
  assert.notEqual(moved, before, 'dragging a node must move it');
  viewport = h.findAll((node) => String((node.props && node.props.className) || '').includes('dcr-canvas-viewport'))[0];
  viewport.props.onPointerUp({pointerId: 1});
  await h.settle();
  const reset = h.findAll((node) => node.tag === 'button' && h.textOf(node).includes('一键规整'))[0];
  assert.ok(reset);
  h.clickNode(reset);
  await h.settle();
  assert.equal(graphNodes().find((node) => node.props['data-node-id'] === entryNodeId).props.style.left, before, '一键规整 restores deterministic layout');

  const lookupNode = graphNodes().find((node) => node.props['data-function-id'] === LOOKUP_ROUTE_ID);
  assert.ok(lookupNode);
  h.clickNode(lookupNode);
  await h.settle();
  assert.ok(detailsNode(h), 'graph node click opens details');
  const viewportNode = h.findAll((node) => String((node.props && node.props.className) || '').includes('dcr-canvas-viewport'))[0];
  viewportNode.props.onClick({target: {closest: () => null}});
  await h.settle();
  assert.equal(detailsNode(h), null, 'blank canvas click closes details');

  const search = h.findAll((node) => node.props && node.props['data-graph-search'] !== undefined)[0];
  search.props.onChange({target: {value: 'lookup'}});
  await h.settle();
  const locate = h.findAll((node) => node.tag === 'button' && h.textOf(node).includes('定位'))[0];
  h.clickNode(locate);
  await h.settle();
  assert.equal(h.rpc.lastPayload('view.getEntry').entry, LOOKUP_ROUTE_ID, 'search+locate selects the matching node');
});

// ---------------------------------------------------------------------------
// 7. static sequence
// ---------------------------------------------------------------------------

test('sequence shows the static-prediction warning and typed messages', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await switchView(h, 'sequence');
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  const warning = h.findByData('data-sequence-warning', '')[0];
  assert.ok(warning);
  assert.ok(h.textOf(warning).includes('静态预测'));
  assert.ok(h.textOf(warning).includes('observed=false'));
  assert.equal(warning.props['data-observed'], 'false');
  const messages = h.findAll((node) => node.props && node.props['data-sequence-message'] !== undefined);
  assert.equal(messages.length, 7);
  const kinds = messages.map((node) => node.props['data-message-kind']);
  for (const kind of ['call', 'return', 'access', 'external', 'error']) assert.ok(kinds.includes(kind), `missing message kind ${kind}`);
  assert.ok(messages.some((node) => h.textOf(node).includes('bus_send')));
  assert.ok(messages.some((node) => h.textOf(node).includes('lookup_route')));
  assert.ok(messages.some((node) => h.textOf(node).includes('check_length')));
  assert.ok(messages.some((node) => h.textOf(node).includes('platform_write')));
});

test('sequence message click locates the source line in the file view', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await switchView(h, 'sequence');
  const message = h.findAll((node) => node.props && node.props['data-sequence-message'] !== undefined && h.textOf(node).includes('check_length'))[0];
  h.clickNode(message);
  await h.settle();
  assert.equal(viewRoot(h).props['data-view'], 'file');
  assert.equal(h.nodeByData('data-line', '96').props['data-highlight'], 'true');
  assert.equal(h.rpc.lastPayload('view.getEntry').entry, CHECK_LENGTH_ID);
  assert.equal(selectionJson(h).focus_callsite_id, 'c_check');
});

// ---------------------------------------------------------------------------
// 8. read-only file view
// ---------------------------------------------------------------------------

test('file view lists snapshot files, renders line numbers and supports navigation', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await switchView(h, 'file');
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  assert.equal(h.findByData('data-file-tree', '').length, 1);
  const fileButtons = h.findAll((node) => node.props && node.props['data-file-path'] !== undefined);
  assert.deepEqual(fileButtons.map((node) => node.props['data-file-path']), ['bus.c', 'platform.c']);
  assert.equal(h.findByData('data-file-line', '46').length, 1, 'data-file-line must carry the line number (§7.6)');
  const lines = h.findAll((node) => node.props && node.props['data-file-line'] !== undefined);
  assert.equal(lines.length, 174);
  assert.ok(lines.every((node) => node.props['data-file-line'] === node.props['data-line']), 'data-file-line mirrors data-line');
  h.clickNode(h.nodeByData('data-file-line', '46'));
  await h.settle();
  assert.equal(h.findAll((node) => node.props && node.props['data-file-line'] !== undefined && node.props['data-highlight'] === 'true').length, 1);
  const platformButton = h.findAll((node) => node.props && node.props['data-file-path'] === 'platform.c')[0];
  h.clickNode(platformButton);
  await h.settle();
  assert.equal(h.rpc.lastPayload('view.fileRead').path, 'platform.c');
});

test('resource selection targets its definition line when the file view opens', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  h.clickNode(h.nodeByData('data-resource-row', ROUTES_ID));
  await h.settle();
  await switchView(h, 'file');
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  assert.equal(h.findByData('data-file-line', '26').length, 1, 'resource jump targets its definition line');
  assert.equal(h.nodeByData('data-line', '26').props['data-highlight'], 'true');
});

// ---------------------------------------------------------------------------
// 9. details, legend and cross-view selection
// ---------------------------------------------------------------------------

test('details panel shows function source, resources, evidence and the AI gap', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  const details = detailsNode(h);
  assert.ok(details);
  assert.ok(h.textOf(details).includes('函数详情'));
  assert.ok(h.nodeByData('data-code-view', 'source'));
  assert.ok(h.nodeByData('data-code-view', 'resources'));
  assert.ok(h.textOf(details).includes('AI 归纳在 S2b 后置'));
  assert.ok(h.textOf(details).includes('bus_send'));
  const jump = h.findAll((node) => node.tag === 'button' && h.textOf(node).includes('定位源码'))[0];
  assert.ok(jump);
  h.clickNode(jump);
  await h.settle();
  assert.equal(viewRoot(h).props['data-view'], 'file');
  assert.equal(h.nodeByData('data-line', '152').props['data-highlight'], 'true');
});

test('legend trigger opens the legend with evidence/access/shape/boundary keys', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  const legend = h.nodeByData('data-code-view', 'legend');
  assert.ok(legend);
  assert.equal(legend.props.hidden, true);
  const trigger = h.findAll((node) => String((node.props && node.props.className) || '').includes('dcr-legend-trigger'))[0];
  assert.equal(trigger.props['aria-expanded'], 'false');
  h.clickNode(trigger);
  await h.settle();
  const openLegend = h.nodeByData('data-code-view', 'legend');
  assert.equal(openLegend.props.hidden, undefined);
  const text = h.textOf(openLegend);
  for (const needle of ['证据分级', '静态确定', '候选', '未知', '源码证据', '资源访问方向', '图形形状', '边界与异常', '外部边界', '异常返回', 'AI 归纳']) {
    assert.ok(text.includes(needle), `legend must explain ${needle}`);
  }
  assert.equal(h.findAll((node) => String((node.props && node.props.className) || '').includes('dcr-legend-trigger'))[0].props['aria-expanded'], 'true');
});

test('cross-view selection: focused function is reflected in Selection and file view', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await switchView(h, 'tree');
  const checkButton = h.findAll((node) => node.tag === 'button' && String(node.props.className || '').includes('dcr-tree-name') && h.textOf(node).includes('check_length'))[0];
  h.clickNode(checkButton);
  await h.settle();
  assert.equal(viewRoot(h).props['data-view'], 'file');
  assert.equal(selectionJson(h).entry_id, CHECK_LENGTH_ID);
  assert.equal(h.nodeByData('data-line', '96').props['data-highlight'], 'true');
  assert.ok(h.textOf(detailsNode(h)).includes('check_length'));
});

test('second open restores the active view, focused function and details', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await switchView(h, 'end_to_end');
  const lookupNode = h.findAll((node) => node.props && node.props['data-graph-node'] !== undefined && h.textOf(node).includes('lookup_route'))[0];
  h.clickNode(lookupNode);
  await h.settle();
  assert.equal(selectionJson(h).entry_id, LOOKUP_ROUTE_ID);
  h.unmountMain();
  await h.settle();
  h.remountMain();
  await h.settle();
  assert.equal(h.nodeByData('data-code-view', 'view').props['data-view'], 'end_to_end');
  assert.equal(h.nodeByData('data-code-view', 'view').props['data-state'], 'ready');
  assert.equal(tabButton(h, 'end_to_end').props['aria-pressed'], 'true');
  assert.equal(selectionJson(h).entry_id, LOOKUP_ROUTE_ID);
  assert.ok(detailsNode(h));
  assert.ok(h.nodeByData('data-code-view', 'source'));
  assert.ok(h.rpc.callsFor('view.endToEnd').length >= 2, 're-open must refetch the active view');
});

test('second open restores a focused resource and its rail detail', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  h.clickNode(h.nodeByData('data-resource-row', ROUTES_ID));
  await h.settle();
  assert.equal(selectionJson(h).focus_resource_id, ROUTES_ID);
  h.unmountMain();
  await h.settle();
  h.remountMain();
  await h.settle();
  assert.equal(selectionJson(h).focus_resource_id, ROUTES_ID);
  assert.ok(detailsNode(h));
  assert.ok(h.textOf(detailsNode(h)).includes('资源详情'));
  assert.ok(h.nodeByData('data-resource-node', ROUTES_ID));
});

test('no absolute/internal paths leak across the five views', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  for (const view of ['coupling', 'tree', 'end_to_end', 'sequence', 'file']) {
    await switchView(h, view);
    const text = h.text();
    assertNoAbsolutePaths(text);
    assert.equal(text.includes('C:\\Users'), false);
  }
});

test('five views expose no not_available_in_readonly_slice placeholders', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  for (const view of ['coupling', 'tree', 'end_to_end', 'sequence', 'file']) {
    await switchView(h, view);
    const root = viewRoot(h);
    assert.equal(root.props['data-view'], view);
    assert.ok(['loading', 'ready', 'empty', 'error'].includes(root.props['data-state']));
    assert.equal(h.text().includes('not_available_in_readonly_slice'), false);
  }
});
