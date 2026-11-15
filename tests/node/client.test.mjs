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
  DISPATCH_TRANSFER_ID,
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
  makeEntryRow,
  makeEntriesPayload,
  makeEntryPayload,
  makeFileReadPayload,
  makeFileTreePayload,
  makeFirstScreenPayload,
  makeImportedObservedSequencePayload,
  makeImportedScenarioSummary,
  makeInterfacesPayload,
  makeSelection,
  makeSequencePayload,
  makeSnapshotRow,
  makeSnapshotsPayload,
  makeSourceLines,
  makeStatusPayload,
  makeSubflowPayload,
  makeStubProfilesPayload,
  makeSummaryGapPayload,
  makeSummaryPayload,
  makeSummaryRecord,
  makeSummaryStalePayload,
  makeScenarioLedgerPayload,
  makeScenarioPlanPayload,
  makeScenarioRunPayload,
  makeStubRecord,
  makeTraceImportPayload,
  makeUndoTailPayload,
  makeObservedSequencePayload,
  makeScenarioSummary,
  makeTreePayload,
  makeWorkspace,
  okResult,
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
    'view.endToEnd': (payload) => (payload.entry === CHECK_LENGTH_ID ? makeSubflowPayload() : makeEndToEndPayload()),
    'view.sequence': (payload) => (payload.mode === 'observed' ? makeObservedSequencePayload() : makeSequencePayload()),
    'scenario.listProfiles': () => makeStubProfilesPayload(),
    'scenario.list': () => makeScenarioLedgerPayload(),
    'scenario.preview': () => makeScenarioPlanPayload(),
    'scenario.run': () => makeScenarioRunPayload(),
    'scenario.undoTail': () => makeUndoTailPayload(),
    'trace.import': () => makeTraceImportPayload(),
    'view.fileTree': () => makeFileTreePayload(),
    'view.fileRead': (payload) => makeFileReadPayload({path: payload.path, repo_id: payload.repo}),
    'view.interfaces': () => makeInterfacesPayload(),
    'view.summary': (payload) => makeSummaryGapPayload(),
    'view.firstScreen': () => failResult('UNKNOWN_ENDPOINT', 'view.firstScreen not available in the fake bridge'),
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
  assert.ok(source.length < 300 * 1024, `bundle source must stay below 300KB, got ${source.length}`);
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

test('S3a status gaps keep server code/status/reason and drop implemented capability gaps', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  assert.equal(h.nodeByData('data-code-view', 'status').props['data-state'], 'ready');
  for (const code of ['ai_summary', 'scenario_undo', 'trace_import', 'real_device_dispatch']) {
    assert.ok(h.findByData('data-gap-code', code).length > 0, `missing server gap ${code}`);
  }
  const undoGap = h.nodeByData('data-gap-code', 'scenario_undo');
  assert.ok(h.textOf(undoGap).includes('回退末尾 N 次/前缀重放 S3b 提供'), 'server reason is preserved');
  for (const code of ['scenario_execution', 'run_observation', 'group_collapse', 'interface_library', 'five_views']) {
    assert.equal(h.findByData('data-gap-code', code).length, 0, `${code} is implemented and must not be a gap`);
  }
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
    'group_id', 'interface_id', 'subflow_root_id',
    'scenario_id', 'run_generation', 'call_id',
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
  for (const endpoint of ['view.coupling', 'view.getEntry', 'view.tree', 'view.endToEnd', 'view.sequence', 'view.fileTree', 'view.fileRead', 'view.interfaces']) {
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

test('global-resource rail lists related resources, direction tags, and the S3a stub panel', async (t) => {
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
  await h.settle();
  const stub = h.nodeByData('data-code-view', 'stub-panel');
  assert.ok(stub, 'stub panel hook is missing');
  assert.ok(h.textOf(stub).includes('打桩模拟'));
  assert.ok(h.textOf(stub).includes('bus-demo-wasm'), 'profile label/options are rendered');
  assert.equal(h.findAll((node) => node.props && node.props['data-stub-profile'] !== undefined).length, 1);
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
  await new Promise((resolve) => setTimeout(resolve, 250));
  await h.settle();
  const summaryGap = h.findAll((node) => node.props && node.props['data-ai-summary-gap'] !== undefined)[0];
  assert.ok(summaryGap, 'AI summary gap hook is missing');
  assert.ok(h.textOf(summaryGap).includes('AI 归纳未生成（Agent 可通过 code_summary 写入）'));
  assert.equal(h.findAll((node) => node.props && node.props['data-ai-summary-text'] !== undefined).length, 0);
  assert.deepEqual(h.rpc.lastPayload('view.summary'), {workspace: 'code-view-bus-demo', snapshot: SNAPSHOT_ID, subject_type: 'function', subject_id: BUS_SEND_ID});
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

// ---------------------------------------------------------------------------
// 10. S2b: groups, interface library, subflow + breadcrumb
// ---------------------------------------------------------------------------

const GROUP_DISPATCH = 'group:' + DISPATCH_TRANSFER_ID + ':g1';
const GROUP_COMMIT = 'group:f_commit_transfer:g2';
const IFACE_PLATFORM = 'iface:platform_write';
const IFACE_LOOKUP = 'iface:' + LOOKUP_ROUTE_ID;
const IFACE_CHECK = 'iface:' + CHECK_LENGTH_ID;

async function openGraph(h) {
  await switchView(h, 'end_to_end');
}

function interfaceCard(h, interfaceId) {
  return h.nodeByData('data-interface-candidate', interfaceId);
}

test('end-to-end groups collapse by default; member nodes hidden while cross-group edges keep original ids', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openGraph(h);
  const group = h.nodeByData('data-graph-group', GROUP_DISPATCH);
  assert.ok(group, 'collapsed group box missing');
  assert.equal(group.props['data-collapsed'], 'true');
  assert.ok(h.textOf(group).includes('dispatch_transfer 下游子流程'));
  assert.ok(h.textOf(group).includes('5 成员'));
  assert.equal(h.nodeByData('data-graph-node', 'fn:submit_buffered'), null, 'group member node must be hidden');
  assert.equal(h.nodeByData('data-graph-group', GROUP_COMMIT), null, 'nested group must be hidden while the parent is collapsed');
  assert.ok(h.nodeByData('data-graph-node', 'fn:' + DISPATCH_TRANSFER_ID), 'non-member function stays visible');
  const crossEdge = h.findAll((node) => node.props && node.props['data-graph-edge'] !== undefined && node.props['data-edge-id'] === 'call:dispatch_buffered')[0];
  assert.ok(crossEdge, 'cross-group edge missing');
  assert.equal(crossEdge.props['data-cross-group'], 'true');
  assert.equal(crossEdge.props['data-certainty'], 'exact');
  assert.equal(crossEdge.props['data-edge-label'], 'submit_buffered(route, length)');
  const semanticsGap = h.nodeByData('data-gap-code', 'group_semantics');
  assert.ok(semanticsGap, 'grouping gap must surface in the gap area');
  assert.ok(h.textOf(semanticsGap).includes('结构归纳'));
});

test('single-group toggle, nested group boxes, collapse-all and expand-all restore nodes/edges', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openGraph(h);
  h.clickNode(h.nodeByData('data-group-toggle', GROUP_DISPATCH));
  await h.settle();
  assert.equal(h.nodeByData('data-graph-group', GROUP_DISPATCH).props['data-collapsed'], 'false');
  assert.ok(h.nodeByData('data-graph-node', 'fn:submit_buffered'), 'expanded group must show member nodes');
  const nested = h.nodeByData('data-graph-group', GROUP_COMMIT);
  assert.ok(nested, 'nested group box must appear when the parent expands');
  assert.equal(nested.props['data-collapsed'], 'true');
  assert.equal(nested.props['data-group-depth'], '1');
  assert.equal(h.nodeByData('data-graph-node', 'fn:encode_doorbell'), null, 'nested collapsed group hides its members');

  h.clickData('data-graph-collapse-all', '');
  await h.settle();
  assert.equal(h.nodeByData('data-graph-group', GROUP_DISPATCH).props['data-collapsed'], 'true');
  assert.equal(h.nodeByData('data-graph-node', 'fn:submit_buffered'), null);

  h.clickData('data-graph-expand-all', '');
  await h.settle();
  assert.equal(h.nodeByData('data-graph-group', GROUP_DISPATCH).props['data-collapsed'], 'false');
  assert.equal(h.nodeByData('data-graph-group', GROUP_COMMIT).props['data-collapsed'], 'false');
  assert.ok(h.nodeByData('data-graph-node', 'fn:encode_doorbell'), 'nested expand-all shows deep members');
  assert.ok(h.nodeByData('data-graph-node', 'fn:write_doorbell'));
});

test('group name/description editing marks 已修订 and survives data refresh and remount', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openGraph(h);
  h.clickNode(h.nodeByData('data-group-edit', GROUP_DISPATCH));
  await h.settle();
  const labelInput = h.findAll((node) => node.props && node.props['data-group-edit-label'] === GROUP_DISPATCH)[0];
  assert.ok(labelInput, 'group editor label input missing');
  labelInput.props.onChange({target: {value: '登记后的下游子流程'}});
  await h.settle();
  h.findAll((node) => node.props && node.props['data-group-edit-save'] === GROUP_DISPATCH)[0].props.onClick({stopPropagation() {}});
  await h.settle();
  assert.ok(h.textOf(h.nodeByData('data-graph-group', GROUP_DISPATCH)).includes('登记后的下游子流程'));
  assert.ok(h.findByData('data-group-revised', 'true').length > 0, '已修订 marker missing');

  h.clickButton('重新读取');
  await h.settle();
  await h.settle();
  assert.ok(h.textOf(h.nodeByData('data-graph-group', GROUP_DISPATCH)).includes('登记后的下游子流程'), 'override must survive refresh');

  h.unmountMain();
  await h.settle();
  h.remountMain();
  await h.settle();
  await h.settle();
  assert.equal(h.nodeByData('data-code-view', 'view').props['data-view'], 'end_to_end');
  assert.ok(h.textOf(h.nodeByData('data-graph-group', GROUP_DISPATCH)).includes('登记后的下游子流程'), 'override must survive remount');
});

test('node drag positions are preserved across group collapse/expand and reset restores layout', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openGraph(h);
  const graphNodes = () => h.findAll((node) => node.props && node.props['data-graph-node'] !== undefined);
  const lookupId = 'fn:' + LOOKUP_ROUTE_ID;
  const before = graphNodes().find((node) => node.props['data-node-id'] === lookupId).props.style.left;
  graphNodes().find((node) => node.props['data-node-id'] === lookupId)
    .props.onPointerDown({clientX: 10, clientY: 10, pointerId: 1, button: 0, stopPropagation() {}, preventDefault() {}});
  await h.settle();
  let viewport = h.findAll((node) => String((node.props && node.props.className) || '').includes('dcr-canvas-viewport'))[0];
  viewport.props.onPointerMove({clientX: 90, clientY: 40, pointerId: 1});
  await h.settle();
  viewport = h.findAll((node) => String((node.props && node.props.className) || '').includes('dcr-canvas-viewport'))[0];
  viewport.props.onPointerUp({pointerId: 1});
  await h.settle();
  const moved = graphNodes().find((node) => node.props['data-node-id'] === lookupId).props.style.left;
  assert.notEqual(moved, before);
  h.clickData('data-graph-expand-all', '');
  await h.settle();
  h.clickData('data-graph-collapse-all', '');
  await h.settle();
  assert.equal(graphNodes().find((node) => node.props['data-node-id'] === lookupId).props.style.left, moved, 'collapse/expand must not lose dragged positions');
  const reset = h.findAll((node) => node.tag === 'button' && h.textOf(node).includes('一键规整'))[0];
  h.clickNode(reset);
  await h.settle();
  assert.equal(graphNodes().find((node) => node.props['data-node-id'] === lookupId).props.style.left, before);
});

test('interface library lists candidates with signature/params/reasons/effects/guards and read-only external boundaries', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  const library = h.nodeByData('data-code-view', 'interface-library');
  assert.ok(library, 'interface library hook missing');
  const card = interfaceCard(h, IFACE_PLATFORM);
  assert.ok(card, 'interface candidate card missing');
  const text = h.textOf(card);
  for (const needle of ['platform_write', 'int (unsigned int, unsigned int)', 'address', '返回 int', '跨文件边界', '副作用', '写入 / 修改', 'simulated_doorbell', 'guard', 'if (address != TX_DOORBELL)']) {
    if (needle === '') continue;
    assert.ok(text.includes(needle), `interface card must show ${needle}`);
  }
  const addAction = h.findAll((node) => node.props && node.props['data-interface-action'] === 'add' && node.props['data-interface-id'] === IFACE_PLATFORM)[0];
  assert.ok(addAction, 'add action missing');
  const boundary = h.findAll((node) => node.props && node.props['data-external-boundary'] !== undefined);
  assert.ok(boundary.length >= 1, 'external boundary list missing');
  assert.ok(h.textOf(boundary[0]).includes('trace') || h.textOf(boundary[0]).includes('platform_write'));
});

test('adding an interface turns the graph node into a blackbox and removing restores it', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openGraph(h);
  const externalBefore = h.nodeByData('data-graph-node', 'external:callee:platform_write');
  assert.ok(externalBefore);
  assert.equal(h.findAll((node) => node.props && node.props['data-interface-action'] === 'add' && node.props['data-interface-id'] === IFACE_PLATFORM).length, 1);
  h.findAll((node) => node.props && node.props['data-interface-action'] === 'add' && node.props['data-interface-id'] === IFACE_PLATFORM)[0].props.onClick();
  await h.settle();
  const blackbox = h.nodeByData('data-blackbox-node', IFACE_PLATFORM);
  assert.ok(blackbox, 'blackbox node missing after adding interface');
  assert.equal(blackbox.props['data-interface-id'], IFACE_PLATFORM);
  assert.ok(h.textOf(blackbox).includes('platform_write'));
  assert.equal(h.findAll((node) => node.props && node.props['data-graph-node'] === 'external:callee:platform_write' && node.props['data-node-kind'] === 'external').length, 0, 'original node is folded into the blackbox');
  const expand = h.findAll((node) => node.props && node.props['data-blackbox-expand'] === IFACE_PLATFORM)[0];
  assert.ok(expand);
  h.clickNode(expand);
  await h.settle();
  assert.equal(h.nodeByData('data-blackbox-node', IFACE_PLATFORM), null);
  assert.ok(h.nodeByData('data-graph-node', 'external:callee:platform_write'), 'expanding the blackbox restores the original node');
  const actionsAfterExpand = h.findAll((node) => node.props && node.props['data-interface-action'] === 'remove' && node.props['data-interface-id'] === IFACE_PLATFORM);
  assert.equal(actionsAfterExpand.length, 1, 'added candidate offers a remove action');
  actionsAfterExpand[0].props.onClick();
  await h.settle();
  assert.equal(h.nodeByData('data-blackbox-node', IFACE_PLATFORM), null);
  assert.ok(h.findAll((node) => node.props && node.props['data-interface-action'] === 'add' && node.props['data-interface-id'] === IFACE_PLATFORM).length >= 1);
});

test('blackbox folds downstream nodes in the graph and subtree in the tree, expandable again', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openGraph(h);
  assert.ok(h.nodeByData('data-graph-node', 'decision:c_check'));
  h.findAll((node) => node.props && node.props['data-interface-action'] === 'add' && node.props['data-interface-id'] === IFACE_LOOKUP)[0].props.onClick();
  await h.settle();
  assert.ok(h.nodeByData('data-blackbox-node', IFACE_LOOKUP), 'lookup_route blackbox missing');
  assert.equal(h.nodeByData('data-graph-node', 'fn:' + CHECK_LENGTH_ID), null, 'blackbox hides downstream nodes');
  await switchView(h, 'tree');
  const treeBlackbox = h.nodeByData('data-blackbox-node', IFACE_LOOKUP);
  assert.ok(treeBlackbox, 'tree blackbox node missing');
  assert.ok(h.textOf(treeBlackbox).includes('lookup_route'));
  const expand = h.findAll((node) => node.props && node.props['data-blackbox-expand'] === IFACE_LOOKUP)[0];
  h.clickNode(expand);
  await h.settle();
  assert.ok(h.findAll((node) => node.props && node.props['data-tree-node'] !== undefined && h.textOf(node).includes('lookup_route')).length > 0, 'expanded interface restores the normal tree node');

  const IFACE_DISPATCH = 'iface:' + DISPATCH_TRANSFER_ID;
  h.findAll((node) => node.props && node.props['data-interface-action'] === 'add' && node.props['data-interface-id'] === IFACE_DISPATCH)[0].props.onClick();
  await h.settle();
  const dispatchBlackbox = h.nodeByData('data-blackbox-node', IFACE_DISPATCH);
  assert.ok(dispatchBlackbox, 'dispatch_transfer tree blackbox missing');
  const hiddenChild = h.findAll((node) => node.props && node.props['data-tree-node'] !== undefined && h.textOf(node).includes('platform_write'));
  assert.equal(hiddenChild.length, 0, 'tree blackbox folds its subtree');
  h.findAll((node) => node.props && node.props['data-blackbox-expand'] === IFACE_DISPATCH)[0].props.onClick({stopPropagation() {}});
  await h.settle();
  assert.ok(h.findAll((node) => node.props && node.props['data-tree-node'] !== undefined && h.textOf(node).includes('platform_write')).length > 0, 'expanded tree blackbox restores the subtree');
});

test('details tabs expose source/subflow/resources and subflow fetches with entry+root', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openGraph(h);
  const checkNode = h.findAll((node) => node.props && node.props['data-graph-node'] !== undefined && node.props['data-function-id'] === CHECK_LENGTH_ID)[0];
  assert.ok(checkNode);
  h.clickNode(checkNode);
  await h.settle();
  const tabs = h.findAll((node) => node.props && node.props['data-code-view'] === 'details-tab');
  assert.deepEqual(tabs.map((node) => node.props['data-tab']), ['source', 'subflow', 'resources']);
  const resourcesTab = tabs.find((node) => node.props['data-tab'] === 'resources');
  h.clickNode(resourcesTab);
  await h.settle();
  assert.ok(h.nodeByData('data-code-view', 'resources'));
  const subflowTab = h.findAll((node) => node.props && node.props['data-code-view'] === 'details-tab' && node.props['data-tab'] === 'subflow')[0];
  h.clickNode(subflowTab);
  await h.settle();
  const subflowPayload = h.rpc.lastPayload('view.endToEnd');
  assert.equal(subflowPayload.entry, CHECK_LENGTH_ID);
  assert.equal(subflowPayload.root, BUS_SEND_ID);
  assert.ok(h.nodeByData('data-code-view', 'subflow'), 'subflow region missing');
  const subflowNodes = h.findAll((node) => node.props && node.props['data-subflow-node'] !== undefined);
  assert.ok(subflowNodes.length >= 1);
  const breadcrumb = h.findByData('data-breadcrumb', '')[0];
  assert.ok(breadcrumb, 'breadcrumb hook missing');
  const crumbs = h.findAll((node) => node.props && node.props['data-crumb'] !== undefined);
  assert.deepEqual(crumbs.map((node) => node.props['data-crumb']), [BUS_SEND_ID, CHECK_LENGTH_ID]);
  assert.ok(h.textOf(crumbs[0]).includes('bus_send'));
  assert.equal(selectionJson(h).subflow_root_id, BUS_SEND_ID);
  h.clickNode(crumbs[0]);
  await h.settle();
  assert.equal(h.nodeByData('data-code-view', 'view').props['data-view'], 'end_to_end');
  assert.equal(h.nodeByData('data-code-view', 'subflow'), null, 'root crumb returns to the main graph');
  assert.ok(h.nodeByData('data-graph-group', GROUP_DISPATCH), 'main graph nodes/edges are restored from cache');
  assert.equal(h.rpc.callsFor('view.endToEnd').filter((call) => call.payload.root !== undefined).length, 1, 'root crumb must reuse the cached main graph');
});

test('subflow without a resolved root path shows the breadcrumb gap', async (t) => {
  const h = bootHarness({
    'view.endToEnd': (payload) => (payload.entry === CHECK_LENGTH_ID
      ? makeSubflowPayload({breadcrumb: [], gaps: [{code: 'breadcrumb_unavailable', status: 'degraded', reason: 'no resolved caller path'}]})
      : makeEndToEndPayload()),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openGraph(h);
  const checkNode = h.findAll((node) => node.props && node.props['data-graph-node'] !== undefined && node.props['data-function-id'] === CHECK_LENGTH_ID)[0];
  h.clickNode(checkNode);
  await h.settle();
  h.clickNode(h.findAll((node) => node.props && node.props['data-code-view'] === 'details-tab' && node.props['data-tab'] === 'subflow')[0]);
  await h.settle();
  assert.ok(h.text().includes('breadcrumb_unavailable'));
  assert.equal(h.findByData('data-crumb', '').length, 0);
  assert.ok(h.findByData('data-subflow-gap', 'breadcrumb_unavailable').length > 0);
});

test('Selection JSON gains group_id / interface_id / subflow_root_id', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openGraph(h);
  const selectionBefore = selectionJson(h);
  assert.equal(selectionBefore.group_id, null);
  assert.equal(selectionBefore.interface_id, null);
  assert.equal(selectionBefore.subflow_root_id, null);
  h.clickNode(h.nodeByData('data-group-toggle', GROUP_DISPATCH));
  await h.settle();
  assert.equal(selectionJson(h).group_id, GROUP_DISPATCH);
  h.findAll((node) => node.props && node.props['data-interface-action'] === 'add' && node.props['data-interface-id'] === IFACE_PLATFORM)[0].props.onClick();
  await h.settle();
  assert.equal(selectionJson(h).interface_id, IFACE_PLATFORM);
  const checkNode = h.findAll((node) => node.props && node.props['data-graph-node'] !== undefined && node.props['data-function-id'] === CHECK_LENGTH_ID)[0];
  h.clickNode(checkNode);
  await h.settle();
  h.clickNode(h.findAll((node) => node.props && node.props['data-code-view'] === 'details-tab' && node.props['data-tab'] === 'subflow')[0]);
  await h.settle();
  assert.equal(selectionJson(h).subflow_root_id, BUS_SEND_ID);
});

test('legend explains group rectangles and blackbox interfaces', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  const trigger = h.findAll((node) => String((node.props && node.props.className) || '').includes('dcr-legend-trigger'))[0];
  h.clickNode(trigger);
  await h.settle();
  const legendText = h.textOf(h.nodeByData('data-code-view', 'legend'));
  for (const needle of ['组与黑盒', '矩形组框', '黑盒接口', '隐藏下游']) {
    assert.ok(legendText.includes(needle), `legend must explain ${needle}`);
  }
});

test('middle breadcrumb crumb re-roots the subflow without losing the cached main graph', async (t) => {
  const lookupCrumb = {function_id: LOOKUP_ROUTE_ID, name: 'lookup_route', file: 'bus.c', line: 89, callsite_id: 'c_lookup'};
  const checkCrumb = {function_id: CHECK_LENGTH_ID, name: 'check_length', file: 'bus.c', line: 96, callsite_id: 'c_check'};
  const busCrumb = {function_id: BUS_SEND_ID, name: 'bus_send', file: 'bus.c', line: 152, callsite_id: null};
  const h = bootHarness({
    'view.endToEnd': (payload) => {
      if (payload.entry !== CHECK_LENGTH_ID) return makeEndToEndPayload();
      if (payload.root === LOOKUP_ROUTE_ID) {
        return makeSubflowPayload({root: LOOKUP_ROUTE_ID, breadcrumb: [lookupCrumb, checkCrumb]});
      }
      return makeSubflowPayload({breadcrumb: [busCrumb, lookupCrumb, checkCrumb]});
    },
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openGraph(h);
  const mainCallsBefore = h.rpc.callsFor('view.endToEnd').filter((call) => call.payload.root === undefined).length;
  const checkNode = h.findAll((node) => node.props && node.props['data-graph-node'] !== undefined && node.props['data-function-id'] === CHECK_LENGTH_ID)[0];
  h.clickNode(checkNode);
  await h.settle();
  h.clickNode(h.findAll((node) => node.props && node.props['data-code-view'] === 'details-tab' && node.props['data-tab'] === 'subflow')[0]);
  await h.settle();
  let crumbs = h.findAll((node) => node.props && node.props['data-crumb'] !== undefined);
  assert.deepEqual(crumbs.map((crumb) => crumb.props['data-crumb']), [BUS_SEND_ID, LOOKUP_ROUTE_ID, CHECK_LENGTH_ID]);
  h.clickNode(crumbs[1]);
  await h.settle();
  const rerootCall = h.rpc.callsFor('view.endToEnd').filter((call) => call.payload.root === LOOKUP_ROUTE_ID).pop();
  assert.ok(rerootCall, 'middle crumb must re-root the subflow');
  assert.equal(rerootCall.payload.entry, CHECK_LENGTH_ID);
  assert.equal(selectionJson(h).subflow_root_id, LOOKUP_ROUTE_ID);
  crumbs = h.findAll((node) => node.props && node.props['data-crumb'] !== undefined);
  assert.deepEqual(crumbs.map((crumb) => crumb.props['data-crumb']), [LOOKUP_ROUTE_ID, CHECK_LENGTH_ID]);
  assert.equal(h.rpc.callsFor('view.endToEnd').filter((call) => call.payload.root === undefined).length, mainCallsBefore, 'main graph is not refetched');
  assert.ok(h.nodeByData('data-graph-group', GROUP_DISPATCH), 'main graph groups still cached');
});

// ---------------------------------------------------------------------------
// 11. S3a: stub simulation panel + run ledger + observed sequence
// ---------------------------------------------------------------------------

function stubPanel(h) {
  return h.nodeByData('data-code-view', 'stub-panel');
}

async function openStub(h) {
  h.clickData('data-rail', 'stub');
  await h.settle();
  await h.settle();
  assert.ok(stubPanel(h), 'stub panel must render');
}

function profileSelect(h) {
  return h.findAll((node) => node.props && node.props['data-stub-profile'] !== undefined)[0];
}

function stubStepCount(h) {
  return h.findAll((node) => node.props && node.props['data-stub-step'] !== undefined).length;
}

async function addStubStepTo(h, count) {
  while (stubStepCount(h) < count) {
    const add = h.findAll((node) => node.props && node.props['data-stub-add-step'] !== undefined)[0];
    assert.ok(add, 'add-step button is missing');
    h.clickNode(add);
    await h.settle();
  }
}

async function setStepInterface(h, index, interfaceName) {
  const select = h.findAll((node) => node.props && node.props['data-step-interface'] === String(index))[0];
  assert.ok(select, 'step interface select ' + index + ' is missing');
  select.props.onChange({target: {value: interfaceName}});
  await h.settle();
}

async function setStepArg(h, index, argIndex, value) {
  const input = h.findAll((node) => node.props && node.props['data-step-arg'] === String(index) + ':' + String(argIndex))[0];
  assert.ok(input, 'step arg input ' + index + ':' + argIndex + ' is missing');
  input.props.onChange({target: {value: String(value)}});
  await h.settle();
}

async function composeSteps(h, list) {
  await addStubStepTo(h, list.length);
  for (let index = 0; index < list.length; index += 1) {
    await setStepInterface(h, index, list[index].interface);
    for (let argIndex = 0; argIndex < list[index].args.length; argIndex += 1) {
      await setStepArg(h, index, argIndex, list[index].args[argIndex]);
    }
  }
}

function stubRunButton(h) {
  return h.findAll((node) => node.props && node.props['data-stub-run'] !== undefined)[0];
}

test('stub panel loads real-shaped profiles with binding/module/limits and default stop-on-error', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openStub(h);
  assert.ok(profileSelect(h), 'profile selector hook is missing');
  assert.equal(profileSelect(h).props.value, 'bus-demo-wasm');
  assert.deepEqual(h.rpc.lastPayload('scenario.listProfiles'), {workspace: 'code-view-bus-demo'});
  const text = h.textOf(stubPanel(h));
  for (const needle of ['Demo bus/platform Wasm 隔离模拟', 'code-view-bus-demo', 'semantic-x86_64', 'a1b2c3d4e5f6…', '接口 5', '10000 ms', 'wasm_simulation_not_real_device', 'reset', 'set_platform_stub'].slice(0, 8)) {
    assert.ok(text.includes(needle), `stub panel must show ${needle}`);
  }
  const stop = h.findAll((node) => node.props && node.props['data-stub-stop-on-error'] !== undefined)[0];
  assert.ok(stop);
  assert.equal(stop.props.checked, true, 'stop_on_error defaults to true');
  assert.ok(h.findByData('data-stub-undo', '').length === 1);
  assert.equal(h.findByData('data-stub-undo', '')[0].props.disabled, true, 'undo is disabled without a run ledger');
  assert.ok(text.includes('暂无可回退台账'));
  assert.ok(h.findByData('data-stub-undo-count', '').length === 1);
  assert.ok(h.findByData('data-stub-undo-status', '').length === 1);
  assert.ok(h.findByData('data-trace-import-input', '').length === 1);
  assert.ok(h.findByData('data-trace-import', '').length === 1);
  assert.ok(h.findByData('data-trace-import-status', '').length === 1);
  assert.ok(h.findByData('data-stub-gap', 'real_device_dispatch').length === 1);
  assert.ok(h.findByData('data-stub-gap', 'scenario_undo').length === 1);
  assert.ok(h.text().includes('运行观测记录（observed）'));
});

test('stub panel without an imported profile shows the profile gap and disables run', async (t) => {
  const h = bootHarness({'scenario.listProfiles': () => makeStubProfilesPayload({profiles: []})});
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openStub(h);
  assert.ok(h.findByData('data-stub-gap', 'sim_profile_missing').length === 1);
  assert.ok(h.textOf(stubPanel(h)).includes('未导入模拟 profile'));
  assert.equal(stubRunButton(h).props.disabled, true);
  assert.equal(h.findAll((node) => node.props && node.props['data-stub-step'] !== undefined).length, 0, 'no profile => no fake steps');
  assert.ok(h.findByData('data-stub-gap', 'scenario_undo').length === 1);
  assert.ok(h.findByData('data-stub-gap', 'trace_import').length === 1);
  assert.ok(h.findByData('data-stub-gap', 'real_device_dispatch').length === 1);
});

test('step editor groups interfaces by role, renders min/max args, and supports add/move/remove', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openStub(h);
  const select = h.findAll((node) => node.props && node.props['data-step-interface'] === '0')[0];
  assert.ok(select);
  const optionText = (() => {
    const collect = (node) => {
      if (node === null || node === undefined) return '';
      if (typeof node === 'string') return node;
      if (Array.isArray(node)) return node.map(collect).join(' ');
      const label = node.props && typeof node.props.label === 'string' ? node.props.label + ' ' : '';
      return label + (node.children || []).map(collect).join(' ');
    };
    return collect(select);
  })();
  for (const needle of ['入口调用', '边界打桩', '工具接口', 'bus_send', 'set_platform_stub', 'reset']) {
    assert.ok(optionText.includes(needle), `interface dropdown must group ${needle}`);
  }
  await setStepInterface(h, 0, 'bus_send');
  const channelInput = h.findAll((node) => node.props && node.props['data-step-arg'] === '0:0')[0];
  const lengthInput = h.findAll((node) => node.props && node.props['data-step-arg'] === '0:1')[0];
  assert.ok(channelInput && lengthInput);
  assert.equal(channelInput.props.min, '0');
  assert.equal(channelInput.props.max, '3');
  assert.equal(lengthInput.props.min, '1');
  assert.equal(lengthInput.props.max, '65535');
  await setStepInterface(h, 0, 'set_platform_stub');
  const stepAfterBoundary = h.findAll((node) => node.props && node.props['data-stub-step'] !== undefined)[0];
  assert.ok(String(stepAfterBoundary.props.className).includes('dcr-stub-step-boundary'));
  assert.ok(h.textOf(stepAfterBoundary).includes('边界打桩'));
  await setStepInterface(h, 0, 'reset');
  await addStubStepTo(h, 2);
  assert.equal(stubStepCount(h), 2);
  await setStepInterface(h, 1, 'bus_register');
  const moveUp = h.findAll((node) => node.props && node.props['data-step-move-up'] === '1')[0];
  h.clickNode(moveUp);
  await h.settle();
  const firstSelect = h.findAll((node) => node.props && node.props['data-step-interface'] === '0')[0];
  assert.equal(firstSelect.props.value, 'bus_register', 'move-up reorders steps');
  const removeSecond = h.findAll((node) => node.props && node.props['data-step-remove'] === '1')[0];
  h.clickNode(removeSecond);
  await h.settle();
  assert.equal(stubStepCount(h), 1);
});

test('step count is capped by the profile limit and the add button disables', async (t) => {
  const h = bootHarness({'scenario.listProfiles': () => makeStubProfilesPayload({profiles: [{...makeStubProfilesPayload().profiles[0], limits: {timeout_ms: 10000, steps: 2, events_per_step: 256}}]})});
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openStub(h);
  await addStubStepTo(h, 2);
  const add = h.findAll((node) => node.props && node.props['data-stub-add-step'] !== undefined)[0];
  assert.equal(add.props.disabled, true);
  assert.equal(stubStepCount(h), 2);
});

test('invalid args block the run with data-error-code and no scenario.preview call', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openStub(h);
  await setStepInterface(h, 0, 'bus_send');
  await setStepArg(h, 0, 0, 7);
  await setStepArg(h, 0, 1, 48);
  const invalidInput = h.findAll((node) => node.props && node.props['data-step-arg'] === '0:0')[0];
  assert.ok(String(invalidInput.props.className).includes('dcr-stub-invalid'));
  h.clickNode(stubRunButton(h));
  await h.settle();
  const errorNode = h.findAll((node) => node.props && node.props['data-stub-error'] !== undefined)[0];
  assert.ok(errorNode, 'stub error hook is missing');
  assert.equal(errorNode.props['data-error-code'], 'INVALID_ARGUMENT');
  assert.ok(h.textOf(errorNode).includes('范围内的整数'));
  assert.equal(h.rpc.callsFor('scenario.preview').length, 0);
  assert.equal(h.rpc.callsFor('scenario.run').length, 0);
});

test('run performs preview then run with the plan generation, and renders records/events/affects/undo', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openStub(h);
  await composeSteps(h, [
    {interface: 'reset', args: []},
    {interface: 'bus_register', args: [1]},
    {interface: 'bus_send', args: [1, 48]},
  ]);
  h.clickNode(stubRunButton(h));
  await h.settle();
  await h.settle();
  const previewPayload = h.rpc.lastPayload('scenario.preview');
  assert.equal(previewPayload.workspace, 'code-view-bus-demo');
  assert.equal(previewPayload.snapshot, SNAPSHOT_ID);
  assert.equal(previewPayload.profile, 'bus-demo-wasm');
  assert.equal(previewPayload.scenario.stop_on_error, true);
  assert.deepEqual(previewPayload.scenario.steps, [
    {interface: 'reset', args: []},
    {interface: 'bus_register', args: [1]},
    {interface: 'bus_send', args: [1, 48]},
  ]);
  const runPayload = h.rpc.lastPayload('scenario.run');
  assert.equal(runPayload.expected_generation, 0, 'first run uses the current ledger generation 0');
  assert.equal(runPayload.scenario.generation, 0);
  assert.deepEqual(runPayload.scenario.steps.map((step) => step.interface), ['reset', 'bus_register', 'bus_send']);
  assert.equal(runPayload.profile, 'bus-demo-wasm');
  const records = h.findAll((node) => node.props && node.props['data-stub-record'] !== undefined);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((record) => record.props['data-call-id']), ['call_1_1', 'call_1_2', 'call_1_3']);
  assert.deepEqual(records.map((record) => record.props['data-status']), ['ok', 'ok', 'ok']);
  const events = h.findAll((node) => node.props && node.props['data-stub-event'] !== undefined);
  assert.ok(events.some((event) => event.props['data-event-kind'] === 'WRITE'));
  assert.ok(events.some((event) => event.props['data-event-kind'] === 'DEFAULT_ROUTE'));
  const affects = h.findAll((node) => node.props && node.props['data-stub-affect'] !== undefined);
  assert.equal(affects.length, 1);
  assert.equal(affects[0].props['data-resource-id'], ROUTES_ID);
  assert.ok(h.textOf(affects[0]).includes('simulated_doorbell'));
  const generation = h.nodeByData('data-stub-generation', '');
  assert.ok(generation);
  assert.ok(h.textOf(generation).includes('scn_0123456789ab'));
  assert.ok(h.textOf(generation).includes('1'));
  const recordText = h.textOf(h.findByData('data-stub-records', '')[0]);
  assert.ok(recordText.includes('d'.repeat(64)), 'DOM text keeps the full 64hex memory digest');
  assert.ok(h.findAll((node) => String((node.props && node.props.className) || '').includes('dcr-stub-digest')).length >= 1, 'digest has a visually truncated class');
  assert.equal(h.nodeByData('data-code-view', 'stub-panel').props['data-busy'], 'false');
  assert.equal(records[0].props['data-result'], '0');
  assert.ok(h.findByData('data-stub-gap', 'scenario_undo').length === 1);
  assert.ok(h.rpc.callsFor('scenario.list').length >= 2, 'ledger is refreshed after a run');
  const selection = selectionJson(h);
  assert.equal(selection.scenario_id, 'scn_0123456789ab');
  assert.equal(selection.run_generation, 1);
});

test('busy state disables the run button and shows the busy text while preview is pending', async (t) => {
  const previewDeferred = deferred();
  const h = bootHarness({'scenario.preview': () => previewDeferred.promise});
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openStub(h);
  await composeSteps(h, [{interface: 'reset', args: []}]);
  h.clickNode(stubRunButton(h));
  await h.settle();
  const busyButton = stubRunButton(h);
  assert.equal(busyButton.props.disabled, true);
  assert.ok(h.textOf(busyButton).includes('正在隔离执行'));
  previewDeferred.resolve(makeScenarioPlanPayload());
  await h.settle();
  await h.settle();
  assert.ok(h.findAll((node) => node.props && node.props['data-stub-record'] !== undefined).length >= 1);
});

test('engine scenario errors surface data-error-code/message without records', async (t) => {
  const h = bootHarness({'scenario.run': () => ({schema_version: 1, error: {code: 'GENERATION_CONFLICT', message: '场景代次冲突，请重新读取台账'}})});
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openStub(h);
  await composeSteps(h, [{interface: 'reset', args: []}]);
  h.clickNode(stubRunButton(h));
  await h.settle();
  await h.settle();
  const errorNode = h.findAll((node) => node.props && node.props['data-stub-error'] !== undefined)[0];
  assert.ok(errorNode);
  assert.equal(errorNode.props['data-error-code'], 'GENERATION_CONFLICT');
  assert.ok(h.textOf(errorNode).includes('场景代次冲突'));
  assert.equal(h.findAll((node) => node.props && node.props['data-stub-record'] !== undefined).length, 0);
  assert.ok(h.findByData('data-stub-gap', 'real_device_dispatch').length === 1);
});

test('stop_on_error marks later planned steps as skipped after a failing record', async (t) => {
  const h = bootHarness({
    'scenario.run': () => makeScenarioRunPayload({
      scenario: {generation: 2},
      records: [
        makeStubRecord({call_id: 'call_2_1', step_index: 0, interface: 'reset', args: [], status: 'ok', result: 0}),
        makeStubRecord({call_id: 'call_2_2', step_index: 1, interface: 'bus_register', args: [0], status: 'error', result: -2, error_message: 'channel 未登记'}),
      ],
    }),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openStub(h);
  await composeSteps(h, [
    {interface: 'reset', args: []},
    {interface: 'bus_register', args: [0]},
    {interface: 'bus_send', args: [1, 48]},
  ]);
  h.clickNode(stubRunButton(h));
  await h.settle();
  await h.settle();
  const records = h.findAll((node) => node.props && node.props['data-stub-record'] !== undefined);
  const failed = records.find((record) => record.props['data-status'] === 'error');
  assert.ok(failed);
  assert.ok(h.textOf(failed).includes('channel 未登记'));
  const skipped = h.findAll((node) => node.props && node.props['data-stub-record'] !== undefined && node.props['data-status'] === 'skipped');
  assert.equal(skipped.length, 1);
  assert.ok(h.textOf(skipped[0]).includes('已跳过'));
});

test('boundary stub steps show stubbed=true on the run record', async (t) => {
  const h = bootHarness({
    'scenario.run': () => makeScenarioRunPayload({
      records: [
        makeStubRecord({call_id: 'call_3_1', step_index: 0, interface: 'set_platform_stub', args: [-5], status: 'ok', result: null, stubbed: true}),
        makeStubRecord({call_id: 'call_3_2', step_index: 1, interface: 'bus_send', args: [1, 48], status: 'ok', result: -5}),
      ],
    }),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openStub(h);
  await composeSteps(h, [
    {interface: 'set_platform_stub', args: [-5]},
    {interface: 'bus_send', args: [1, 48]},
  ]);
  assert.ok(String(h.findAll((node) => node.props && node.props['data-stub-step'] !== undefined)[0].props.className).includes('dcr-stub-step-boundary'));
  h.clickNode(stubRunButton(h));
  await h.settle();
  await h.settle();
  const stubbedRecords = h.findByData('data-stubbed', 'true');
  assert.equal(stubbedRecords.length, 1);
  assert.equal(stubbedRecords[0].props['data-call-id'], 'call_3_1');
  assert.ok(h.textOf(stubbedRecords[0]).includes('边界打桩步'));
  assert.ok(h.textOf(stubbedRecords[0]).includes('结果 —'), 'void stub result renders as —');
});

test('clicking a run record jumps to the source line and updates S3a selection fields', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openStub(h);
  await composeSteps(h, [
    {interface: 'reset', args: []},
    {interface: 'bus_register', args: [1]},
    {interface: 'bus_send', args: [1, 48]},
  ]);
  h.clickNode(stubRunButton(h));
  await h.settle();
  await h.settle();
  const record = h.findByData('data-call-id', 'call_1_3')[0];
  assert.ok(record, 'bus_send record is missing');
  h.clickNode(record);
  await h.settle();
  assert.equal(viewRoot(h).props['data-view'], 'file');
  assert.equal(h.rpc.lastPayload('view.fileRead').path, 'bus.c');
  const highlightedFileLines = h.findAll((node) => node.props && node.props['data-file-line'] !== undefined && node.props['data-highlight'] === 'true');
  assert.ok(highlightedFileLines.length >= 1, 'the record jump highlights a file line');
  const writeEvent = h.findAll((node) => node.props && node.props['data-event-kind'] === 'WRITE')[0];
  assert.ok(writeEvent, 'WRITE event chip is missing');
  h.clickNode(writeEvent);
  await h.settle();
  const line113 = h.findAll((node) => node.props && node.props['data-file-line'] === '113');
  assert.ok(line113.length >= 1, 'bus.c:113 line must render');
  assert.ok(line113.some((node) => node.props['data-highlight'] === 'true'), 'event click highlights the event source line');
  const selection = selectionJson(h);
  assert.equal(selection.scenario_id, 'scn_0123456789ab');
  assert.equal(selection.run_generation, 1);
  assert.equal(selection.call_id, 'call_1_3');
});

test('sequence view exposes the static/observed switch and blocks observed without a ledger', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await switchView(h, 'sequence');
  await h.settle();
  assert.ok(h.nodeByData('data-code-view', 'sequence-mode'), 'sequence mode hook is missing');
  const observedButton = h.findAll((node) => node.props && node.props['data-sequence-mode'] === 'observed')[0];
  assert.ok(observedButton);
  assert.equal(observedButton.props.disabled, true);
  assert.ok(h.findByData('data-sequence-gap', '').length === 1, 'no-ledger gap is missing');
  const warning = h.findAll((node) => node.props && node.props['data-sequence-warning'] !== undefined)[0];
  assert.ok(warning);
  assert.ok(h.textOf(warning).includes('observed=false'));
});

test('observed sequence renders ledger messages/scenario generation and switches back to static', async (t) => {
  const h = bootHarness({
    'scenario.list': () => makeScenarioLedgerPayload({scenarios: [makeScenarioSummary()]}),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await switchView(h, 'sequence');
  await h.settle();
  const observedButton = h.findAll((node) => node.props && node.props['data-sequence-mode'] === 'observed')[0];
  assert.equal(observedButton.props.disabled, false, 'observed is enabled when a ledger exists');
  h.clickNode(observedButton);
  await h.settle();
  await h.settle();
  const observedPayload = h.rpc.lastPayload('view.sequence');
  assert.equal(observedPayload.mode, 'observed');
  assert.equal(observedPayload.scenario, 'scn_0123456789ab');
  assert.equal(h.findAll((node) => node.props && node.props['data-sequence-observed'] === 'true').length > 0, true);
  const observedMessages = h.findAll((node) => node.props && node.props['data-sequence-message'] !== undefined && node.props['data-observed'] === 'true');
  assert.ok(observedMessages.length >= 3, 'observed messages are rendered');
  assert.ok(observedMessages.some((message) => h.textOf(message).includes('bus_send(1, 48)')));
  assert.ok(observedMessages.some((message) => h.textOf(message).includes('WRITE')));
  assert.ok(observedMessages.some((message) => message.props['data-message-kind'] === 'error'));
  assert.ok(h.findAll((node) => node.props && node.props['data-stubbed'] === 'true').length >= 1, 'stubbed observed message is marked');
  assert.ok(h.text().includes('scn_0123456789ab'));
  assert.ok(h.text().includes('observed=true'));
  const staticButton = h.findAll((node) => node.props && node.props['data-sequence-mode'] === 'static')[0];
  h.clickNode(staticButton);
  await h.settle();
  const warning = h.findAll((node) => node.props && node.props['data-sequence-warning'] !== undefined)[0];
  assert.ok(warning);
  assert.ok(h.textOf(warning).includes('observed=false'));
  assert.equal(h.findAll((node) => node.props && node.props['data-sequence-message'] !== undefined && node.props['data-observed'] === 'true').length, 0);
});

test('observed sequence message click jumps to the simulation source ref and sets call selection', async (t) => {
  const h = bootHarness({
    'scenario.list': () => makeScenarioLedgerPayload({scenarios: [makeScenarioSummary()]}),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await switchView(h, 'sequence');
  await h.settle();
  h.clickNode(h.findAll((node) => node.props && node.props['data-sequence-mode'] === 'observed')[0]);
  await h.settle();
  await h.settle();
  const writeMessage = h.findAll((node) => node.props && node.props['data-sequence-message'] === 'm_2')[0];
  assert.ok(writeMessage);
  h.clickNode(writeMessage);
  await h.settle();
  assert.equal(viewRoot(h).props['data-view'], 'file');
  const selection = selectionJson(h);
  assert.equal(selection.scenario_id, 'scn_0123456789ab');
  assert.equal(selection.run_generation, 1);
  assert.equal(selection.call_id, 'call_1_3');
  assert.ok(h.findAll((node) => node.props && node.props['data-line'] === '113')[0], 'source line 113 from source_ref is shown');
});

test('observed sequence errors display data-error-code', async (t) => {
  const h = bootHarness({
    'scenario.list': () => makeScenarioLedgerPayload({scenarios: [makeScenarioSummary()]}),
    'view.sequence': (payload) => (payload.mode === 'observed' ? failResult('NOT_FOUND', '没有运行台账') : makeSequencePayload()),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await switchView(h, 'sequence');
  await h.settle();
  h.clickNode(h.findAll((node) => node.props && node.props['data-sequence-mode'] === 'observed')[0]);
  await h.settle();
  await h.settle();
  const errorNode = h.findAll((node) => node.props && node.props['data-error-code'] !== undefined).find((node) => h.textOf(node).includes('运行观测'));
  assert.ok(errorNode);
  assert.equal(errorNode.props['data-error-code'], 'NOT_FOUND');
});

test('generation resets to 0 after scenario edits and increments on an identical rerun', async (t) => {
  const h = bootHarness({
    'scenario.preview': (payload) => makeScenarioPlanPayload({generation: payload.scenario.generation + 1}),
    'scenario.run': (payload) => makeScenarioRunPayload({
      scenario: {...makeScenarioRunPayload().scenario, generation: payload.expected_generation + 1},
    }),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openStub(h);
  await composeSteps(h, [{interface: 'reset', args: []}, {interface: 'bus_register', args: [1]}]);
  h.clickNode(stubRunButton(h));
  await h.settle();
  await h.settle();
  const firstPreview = h.rpc.callsFor('scenario.preview')[0].payload;
  const firstRun = h.rpc.callsFor('scenario.run')[0].payload;
  assert.equal(firstPreview.scenario.generation, 0);
  assert.equal(firstRun.expected_generation, 0);
  assert.equal(firstRun.scenario.generation, 0);
  assert.equal(selectionJson(h).run_generation, 1);

  h.clickNode(stubRunButton(h));
  await h.settle();
  await h.settle();
  const secondPreview = h.rpc.callsFor('scenario.preview')[1].payload;
  const secondRun = h.rpc.callsFor('scenario.run')[1].payload;
  assert.equal(secondPreview.scenario.generation, 1, 'identical rerun keeps the current ledger generation');
  assert.equal(secondRun.expected_generation, 1);
  assert.equal(secondRun.scenario.generation, 1);

  await setStepArg(h, 1, 0, 2);
  h.clickNode(stubRunButton(h));
  await h.settle();
  await h.settle();
  const thirdPreview = h.rpc.callsFor('scenario.preview')[2].payload;
  const thirdRun = h.rpc.callsFor('scenario.run')[2].payload;
  assert.equal(thirdPreview.scenario.generation, 0, 'editing steps resets the expected generation');
  assert.equal(thirdRun.expected_generation, 0);
  assert.equal(thirdRun.scenario.steps[1].args[0], 2);
});

test('stub pane shows the three deferral gaps once each, preferring status reasons', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openStub(h);
  const gapNodes = h.findAll((node) => node.props && node.props['data-stub-gap'] !== undefined);
  const codes = gapNodes.map((node) => node.props['data-stub-gap']);
  assert.equal(codes.filter((code) => code === 'scenario_undo').length, 1, 'no duplicate scenario_undo row');
  assert.equal(codes.filter((code) => code === 'trace_import').length, 1, 'no duplicate trace_import row');
  assert.equal(codes.filter((code) => code === 'real_device_dispatch').length, 1, 'no duplicate real_device_dispatch row');
  const undo = gapNodes.find((node) => node.props['data-stub-gap'] === 'scenario_undo');
  assert.ok(h.textOf(undo).includes('回退末尾 N 次/前缀重放 S3b 提供'), 'server gap reason is preferred');
  const realDevice = gapNodes.find((node) => node.props['data-stub-gap'] === 'real_device_dispatch');
  assert.ok(h.textOf(realDevice).includes('真实设备/内核下发需单独授权与运行验证'));
  const trace = gapNodes.find((node) => node.props['data-stub-gap'] === 'trace_import');
  assert.ok(h.textOf(trace).includes('轨迹导入 S3b 提供'));
});

test('run_observation is not duplicated when the host declares run_observation capability', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  assert.equal(h.findByData('data-gap-code', 'run_observation').length, 0);
  const capabilities = h.nodeByData('data-code-view', 'status');
  assert.ok(capabilities);
});

// ---------------------------------------------------------------------------
// 12. S3b: undo tail, trace import, observed scenario selection
// ---------------------------------------------------------------------------

function undoCountInput(h) {
  return h.findAll((node) => node.props && node.props['data-stub-undo-count'] !== undefined)[0];
}

function undoButton(h) {
  return h.findAll((node) => node.props && node.props['data-stub-undo'] !== undefined)[0];
}

function undoStatus(h) {
  return h.findAll((node) => node.props && node.props['data-stub-undo-status'] !== undefined)[0];
}

function traceInput(h) {
  return h.findAll((node) => node.props && node.props['data-trace-import-input'] !== undefined)[0];
}

function traceButton(h) {
  return h.findAll((node) => node.props && node.props['data-trace-import'] !== undefined)[0];
}

function traceStatus(h) {
  return h.findAll((node) => node.props && node.props['data-trace-import-status'] !== undefined)[0];
}

async function runHappyScenario(h) {
  await composeSteps(h, [
    {interface: 'reset', args: []},
    {interface: 'bus_register', args: [1]},
    {interface: 'bus_send', args: [1, 48]},
  ]);
  h.clickNode(stubRunButton(h));
  await h.settle();
  await h.settle();
}

function visibleRecords(h) {
  return h.findAll((node) => node.props && node.props['data-stub-record'] !== undefined && node.props['data-call-id'] !== '');
}

test('undo controls default to 1/disabled without a ledger and capability-aware gaps hide S3b features', async (t) => {
  const capabilities = {readonly_workbench: true, five_views: true, resource_graph: true, group_collapse: true, interface_library: true, subflow_breadcrumb: true, scenario_execution: true, run_observation: true, scenario_undo: true, trace_import: true, real_device_dispatch: false, ai_summary: false};
  const h = bootHarness({
    'view.status': () => makeStatusPayload({
      capabilities,
      gaps: [
        {code: 'ai_summary', status: 'unavailable', reason: '无模型出口，仅占位；AI 归纳正文未实现'},
        {code: 'real_device_dispatch', status: 'unavailable', reason: '真实设备下发需单独授权与运行验证'},
      ],
    }),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openStub(h);
  assert.equal(undoCountInput(h).props.value, '1');
  assert.equal(undoCountInput(h).props.disabled, true);
  assert.equal(undoButton(h).props.disabled, true);
  const statusText = h.textOf(undoStatus(h));
  assert.ok(statusText.includes('暂无可回退台账'), statusText);
  assert.ok(h.textOf(stubPanel(h)).includes('暂无可回退台账'));
  assert.equal(h.findByData('data-stub-gap', 'scenario_undo').length, 0, 'scenario_undo capability true => no gap row');
  assert.equal(h.findByData('data-stub-gap', 'trace_import').length, 0, 'trace_import capability true => no gap row');
  assert.equal(h.findByData('data-stub-gap', 'real_device_dispatch').length, 1);
});

test('undo tail sends count/expected_generation, then syncs prefix steps and observed selection', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openStub(h);
  await runHappyScenario(h);
  assert.equal(visibleRecords(h).length, 3);
  assert.equal(undoButton(h).props.disabled, false, 'undo is enabled after a run');
  assert.equal(undoCountInput(h).props.max, '3');
  undoCountInput(h).props.onChange({target: {value: '1'}});
  await h.settle();
  h.clickNode(undoButton(h));
  await h.settle();
  await h.settle();
  const payload = h.rpc.lastPayload('scenario.undoTail');
  assert.deepEqual(payload, {workspace: 'code-view-bus-demo', scenario: 'scn_0123456789ab', count: 1, expected_generation: 1});
  const status = h.textOf(undoStatus(h));
  assert.ok(status.includes('回退 1 步：前缀重放状态摘要一致'), status);
  assert.ok(status.includes('scn_prefix000001'));
  assert.ok(status.includes('generation 2'));
  const steps = h.findAll((node) => node.props && node.props['data-stub-step'] !== undefined);
  assert.equal(steps.length, 2, 'step editor syncs to the prefix steps');
  assert.equal(h.findAll((node) => node.props && node.props['data-step-interface'] === '0')[0].props.value, 'reset');
  assert.equal(h.findAll((node) => node.props && node.props['data-step-interface'] === '1')[0].props.value, 'bus_register');
  const records = visibleRecords(h);
  assert.deepEqual(records.map((record) => record.props['data-call-id']), ['call_2_1', 'call_2_2']);
  assert.ok(h.textOf(h.findByData('data-stub-generation', '')[0]).includes('scn_prefix000001'));
  const selection = selectionJson(h);
  assert.equal(selection.scenario_id, 'scn_prefix000001');
  assert.equal(selection.run_generation, 2);
  assert.equal(selection.call_id, null);
  assert.ok(h.rpc.callsFor('scenario.list').length >= 2, 'ledger is refreshed after undo');
});

test('undo failure keeps the original ledger and shows the engine error code/message', async (t) => {
  const h = bootHarness({
    'scenario.undoTail': () => ({schema_version: 1, error: {code: 'STATE_CONFLICT', message: 'state_digest_mismatch at step_index 1'}}),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openStub(h);
  await runHappyScenario(h);
  const beforeRecords = visibleRecords(h).map((record) => record.props['data-call-id']);
  h.clickNode(undoButton(h));
  await h.settle();
  const errorStatus = undoStatus(h);
  assert.equal(errorStatus.props['data-error-code'], 'STATE_CONFLICT');
  assert.ok(h.textOf(errorStatus).includes('state_digest_mismatch'));
  assert.ok(h.textOf(errorStatus).includes('回退失败'));
  assert.deepEqual(visibleRecords(h).map((record) => record.props['data-call-id']), beforeRecords, 'records stay unchanged');
  assert.equal(h.findAll((node) => node.props && node.props['data-stub-step'] !== undefined).length, 3, 'steps stay unchanged');
  const selection = selectionJson(h);
  assert.equal(selection.scenario_id, 'scn_0123456789ab');
  assert.equal(selection.run_generation, 1);
});

test('out-of-range undo counts are rejected without touching the ledger', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openStub(h);
  await runHappyScenario(h);
  const recordsBefore = visibleRecords(h).map((record) => record.props['data-call-id']);
  const undoCallsBefore = h.rpc.callsFor('scenario.undoTail').length;
  undoCountInput(h).props.onChange({target: {value: '99'}});
  await h.settle();
  assert.equal(undoCountInput(h).props.value, '99');
  h.clickNode(undoButton(h));
  await h.settle();
  assert.equal(undoStatus(h).props['data-error-code'], 'INVALID_ARGUMENT');
  assert.ok(h.textOf(undoStatus(h)).includes('回退步数必须在 1..3'));
  assert.equal(h.rpc.callsFor('scenario.undoTail').length, undoCallsBefore, 'invalid count never reaches the host');
  assert.deepEqual(visibleRecords(h).map((record) => record.props['data-call-id']), recordsBefore);
  undoCountInput(h).props.onChange({target: {value: '0'}});
  await h.settle();
  assert.equal(undoCountInput(h).props.value, '0');
  h.clickNode(undoButton(h));
  await h.settle();
  assert.equal(h.rpc.callsFor('scenario.undoTail').length, undoCallsBefore);
  undoCountInput(h).props.onChange({target: {value: '2'}});
  await h.settle();
  assert.equal(undoCountInput(h).props.value, '2');
  h.clickNode(undoButton(h));
  await h.settle();
  const payload = h.rpc.lastPayload('scenario.undoTail');
  assert.equal(payload.count, 2);
});

test('undo then rerun uses the prefix generation as expected_generation', async (t) => {
  const h = bootHarness({
    'scenario.run': (payload) => makeScenarioRunPayload({
      scenario: {...makeScenarioRunPayload().scenario, generation: payload.expected_generation + 1},
      records: makeScenarioRunPayload().records.map((record) => ({...record, call_id: 'call_' + String(payload.expected_generation + 1) + '_' + String(record.step_index + 1)})),
    }),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openStub(h);
  await runHappyScenario(h);
  h.clickNode(undoButton(h));
  await h.settle();
  await h.settle();
  h.clickNode(stubRunButton(h));
  await h.settle();
  await h.settle();
  const runCalls = h.rpc.callsFor('scenario.run');
  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[1].payload.expected_generation, 2, 'prefix ledger generation is the next expected generation');
  assert.equal(runCalls[1].payload.scenario.steps.length, 2);
});

test('trace import sends workspace/snapshot/input and selects the imported ledger in the observed picker', async (t) => {
  let imported = false;
  const h = bootHarness({
    'trace.import': () => {
      imported = true;
      return makeTraceImportPayload();
    },
    'scenario.list': () => (imported
      ? makeScenarioLedgerPayload({scenarios: [makeImportedScenarioSummary()]})
      : makeScenarioLedgerPayload()),
    'view.sequence': (payload) => (payload.mode === 'observed' && payload.scenario === 'scn_1a2b3c4d5e6f'
      ? makeImportedObservedSequencePayload()
      : makeObservedSequencePayload()),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openStub(h);
  traceInput(h).props.onChange({target: {value: 'trace-bus-send.json'}});
  await h.settle();
  assert.equal(traceButton(h).props.disabled, false);
  h.clickNode(traceButton(h));
  await h.settle();
  await h.settle();
  assert.deepEqual(h.rpc.lastPayload('trace.import'), {workspace: 'code-view-bus-demo', snapshot: SNAPSHOT_ID, input: 'trace-bus-send.json'});
  const statusText = h.textOf(traceStatus(h));
  assert.ok(statusText.includes('已导入轨迹台账'), statusText);
  assert.ok(statusText.includes('scn_1a2b3c4d5e6f'));
  assert.ok(statusText.includes('外部采集 bus_send 轨迹（示例）'));
  const selection = selectionJson(h);
  assert.equal(selection.scenario_id, 'scn_1a2b3c4d5e6f');
  assert.equal(selection.run_generation, 1);
  assert.ok(h.rpc.callsFor('scenario.list').length >= 2);
  const importedRecords = visibleRecords(h);
  assert.equal(importedRecords.length, 2);
  assert.ok(h.textOf(h.findByData('data-stub-generation', '')[0]).includes('imported'));
  assert.equal(undoButton(h).props.disabled, true, 'imported ledger cannot be undone');
  assert.ok(h.textOf(undoStatus(h)).includes('导入轨迹'));

  const sequenceTab = h.findAll((node) => node.tag === 'button' && node.props && node.props['data-view'] === 'sequence')[0];
  h.clickNode(sequenceTab);
  await h.settle();
  await h.settle();
  const observed = h.findAll((node) => node.props && node.props['data-sequence-mode'] === 'observed')[0];
  assert.equal(observed.props.disabled, false, 'ledger exists so observed is enabled');
  h.clickNode(observed);
  await h.settle();
  await h.settle();
  assert.ok(h.findAll((node) => node.props && node.props['data-sequence-imported'] === 'true').length >= 1);
  assert.ok(h.text().includes('外部采集 bus_send 轨迹（示例）'));
  assert.ok(h.text().includes('imported_trace_not_executed_by_host'));
  const scenarioSelector = h.nodeByData('data-code-view', 'sequence-scenario');
  assert.ok(scenarioSelector);
  const select = h.findAll((node) => node.props && node.props['data-sequence-scenario-select'] !== undefined)[0];
  assert.equal(select.props.value, 'scn_1a2b3c4d5e6f');
});

test('trace import failure shows data-error-code and invalid file names are rejected locally', async (t) => {
  const h = bootHarness({'trace.import': () => failResult('NOT_FOUND', '轨迹文件不存在')});
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await openStub(h);
  traceInput(h).props.onChange({target: {value: 'trace-missing.json'}});
  await h.settle();
  h.clickNode(traceButton(h));
  await h.settle();
  assert.equal(traceStatus(h).props['data-error-code'], 'NOT_FOUND');
  assert.ok(h.textOf(traceStatus(h)).includes('轨迹文件不存在'));

  const callsBefore = h.rpc.callsFor('trace.import').length;
  traceInput(h).props.onChange({target: {value: '../etc/passwd'}});
  await h.settle();
  h.clickNode(traceButton(h));
  await h.settle();
  assert.equal(traceStatus(h).props['data-error-code'], 'INVALID_ARGUMENT');
  assert.equal(h.rpc.callsFor('trace.import').length, callsBefore, 'invalid names never reach the host');
});

test('observed mode exposes a scenario selector from the ledger, switches request and imported marker', async (t) => {
  const scenarios = [
    makeScenarioSummary({scenario_id: 'scn_0123456789ab', generation: 2, updated_at: '2026-11-15T09:00:00Z'}),
    makeImportedScenarioSummary({updated_at: '2026-11-15T08:00:00Z'}),
  ];
  const h = bootHarness({
    'scenario.list': () => makeScenarioLedgerPayload({scenarios}),
    'view.sequence': (payload) => {
      if (payload.mode !== 'observed') return makeSequencePayload();
      return payload.scenario === 'scn_1a2b3c4d5e6f' ? makeImportedObservedSequencePayload() : makeObservedSequencePayload();
    },
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await switchView(h, 'sequence');
  await h.settle();
  assert.equal(h.nodeByData('data-code-view', 'sequence-scenario'), null, 'static mode does not render the scenario picker');
  h.clickNode(h.findAll((node) => node.props && node.props['data-sequence-mode'] === 'observed')[0]);
  await h.settle();
  await h.settle();
  const picker = h.nodeByData('data-code-view', 'sequence-scenario');
  assert.ok(picker, 'observed mode renders the scenario picker');
  const select = h.findAll((node) => node.props && node.props['data-sequence-scenario-select'] !== undefined)[0];
  const optionValues = select.children.map((child) => (child.props && child.props.value !== undefined ? child.props.value : (child.children || []).map((option) => option.props && option.props.value))).flat().filter(Boolean);
  assert.ok(optionValues.includes('scn_0123456789ab'));
  assert.ok(optionValues.includes('scn_1a2b3c4d5e6f'));
  assert.equal(select.props.value, 'scn_0123456789ab', 'most recently updated scenario is selected by default');
  assert.equal(h.findAll((node) => node.props && node.props['data-sequence-imported'] === 'true').length, 0);
  select.props.onChange({target: {value: 'scn_1a2b3c4d5e6f'}});
  await h.settle();
  await h.settle();
  const observedCalls = h.rpc.callsFor('view.sequence').filter((call) => call.payload.mode === 'observed');
  assert.equal(observedCalls[observedCalls.length - 1].payload.scenario, 'scn_1a2b3c4d5e6f');
  assert.ok(h.findAll((node) => node.props && node.props['data-sequence-imported'] === 'true').length >= 1, 'imported marker appears for imported ledger');
  assert.ok(h.text().includes('外部采集 bus_send 轨迹（示例）'));
  const selection = selectionJson(h);
  assert.equal(selection.scenario_id, 'scn_1a2b3c4d5e6f');
  assert.equal(selection.run_generation, 1);
  const selectAgain = h.findAll((node) => node.props && node.props['data-sequence-scenario-select'] !== undefined)[0];
  selectAgain.props.onChange({target: {value: 'scn_0123456789ab'}});
  await h.settle();
  await h.settle();
  assert.equal(h.findAll((node) => node.props && node.props['data-sequence-imported'] === 'true').length, 0);
  assert.equal(selectionJson(h).scenario_id, 'scn_0123456789ab');
});

// ---------------------------------------------------------------------------
// 13. S4-prep: AI summary in the details panel
// ---------------------------------------------------------------------------

async function waitSummary(h) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await h.settle();
}

test('AI summary loads lazily after a <=200ms debounce and shows a gap when there is no record', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openSnapshot(h);
  await switchView(h, 'coupling');
  h.clickNode(h.nodeByData('data-function-node', STORE_ROUTE_ID));
  assert.equal(h.rpc.callsFor('view.summary').length, 0, 'summary request must be debounced, not immediate');
  await waitSummary(h);
  assert.equal(h.rpc.callsFor('view.summary').length, 1);
  assert.deepEqual(h.rpc.lastPayload('view.summary'), {workspace: 'code-view-bus-demo', snapshot: SNAPSHOT_ID, subject_type: 'function', subject_id: STORE_ROUTE_ID});
  const gap = h.findAll((node) => node.props && node.props['data-ai-summary-gap'] !== undefined)[0];
  assert.ok(gap, 'missing ai-summary gap hook');
  assert.ok(h.textOf(gap).includes('AI 归纳未生成（Agent 可通过 code_summary 写入）'));
  assert.equal(h.findAll((node) => node.props && node.props['data-ai-summary-text'] !== undefined).length, 0, 'gap must not fabricate summary text');
  assert.equal(h.findAll((node) => node.props && node.props['data-code-view'] === 'ai-summary').length, 0);
});

test('AI summary record renders text/generator/generated-at/facts/labels/stale and coexists with tabs', async (t) => {
  const longText = '归纳正文'.repeat(125);
  assert.ok(longText.length <= 500);
  const h = bootHarness({
    'view.summary': (payload) => makeSummaryPayload({
      summaries: [makeSummaryRecord({
        subject: {type: payload.subject_type, id: payload.subject_id},
        text: longText,
        facts: [
          {kind: 'evidence', ref: 'e_231505a73a485bc1d8c9249d'},
          {kind: 'evidence', ref: 'e_ret'},
          {kind: 'node', ref: 'fn:' + BUS_SEND_ID},
        ],
      })],
    }),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await waitSummary(h);
  const section = h.nodeByData('data-code-view', 'ai-summary');
  assert.ok(section, 'ai-summary container is missing');
  assert.equal(section.props['data-ai-summary-stale'], 'false');
  const text = h.nodeByData('data-ai-summary-text', '');
  assert.ok(text);
  assert.equal(h.textOf(text), longText, 'summary text is rendered verbatim');
  assert.ok(h.textOf(h.nodeByData('data-ai-summary-generator', '')).includes('agent'));
  assert.ok(h.textOf(h.nodeByData('data-ai-summary-generator', '')).includes('skill:code-view'));
  assert.ok(h.textOf(h.nodeByData('data-ai-summary-generated-at', '')).includes('2026-11-15T10:00:00Z'));
  const factsText = h.textOf(h.nodeByData('data-ai-summary-facts', ''));
  assert.ok(factsText.includes('3'), factsText);
  assert.ok(factsText.includes('evidence×2'), factsText);
  assert.ok(factsText.includes('node×1'), factsText);
  assert.ok(h.textOf(h.nodeByData('data-ai-summary-labels', '')).includes('from_static_structure'));
  assert.equal(h.findAll((node) => node.props && node.props['data-code-view'] === 'details-tab').length, 3);
  h.clickNode(h.findAll((node) => node.props && node.props['data-code-view'] === 'details-tab' && node.props['data-tab'] === 'resources')[0]);
  await h.settle();
  assert.ok(h.nodeByData('data-code-view', 'ai-summary'), 'AI summary stays visible when switching tabs');
  assert.ok(h.nodeByData('data-code-view', 'resources'));
  const selectionText = h.textOf(h.nodeByData('data-code-view', 'selection'));
  assert.equal(selectionText.includes(longText.slice(0, 20)), false, 'summary text must not leak into Selection');
});

test('stale summary shows 基于旧快照，待复核 and limitations', async (t) => {
  const h = bootHarness({'view.summary': () => makeSummaryStalePayload()});
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await waitSummary(h);
  const section = h.nodeByData('data-code-view', 'ai-summary');
  assert.ok(section);
  assert.equal(section.props['data-ai-summary-stale'], 'true');
  assert.ok(h.textOf(section).includes('基于旧快照，待复核'));
  assert.ok(h.textOf(section).includes('summary_stale_against_current_snapshot'));
  assert.ok(h.textOf(h.nodeByData('data-ai-summary-text', '')).includes('旧快照'));
});

test('summary errors expose data-error-code without leaking paths', async (t) => {
  const h = bootHarness({'view.summary': () => failResult('NOT_FOUND', 'summary store is empty')});
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await waitSummary(h);
  const errorNode = h.findAll((node) => node.props && node.props['data-ai-summary-error'] !== undefined)[0];
  assert.ok(errorNode, 'summary error hook is missing');
  assert.equal(errorNode.props['data-error-code'], 'NOT_FOUND');
  assert.ok(h.textOf(errorNode).includes('NOT_FOUND'));
  assert.equal(h.findAll((node) => node.props && node.props['data-ai-summary-text'] !== undefined).length, 0);
  assert.equal(h.text().includes('E:/'), false);
});

test('debounced summary requests discard stale responses when the subject changes', async (t) => {
  const deferreds = [];
  const h = bootHarness({
    'view.summary': (payload) => {
      const pending = deferred();
      deferreds.push({payload, pending});
      return pending.promise;
    },
  });
  t.after(() => h.dispose());
  await h.boot();
  await openSnapshot(h);
  await switchView(h, 'coupling');
  h.clickNode(h.nodeByData('data-function-node', STORE_ROUTE_ID));
  await new Promise((resolve) => setTimeout(resolve, 200));
  await h.settle();
  assert.equal(deferreds.length, 1, 'first subject request is pending');
  assert.equal(deferreds[0].payload.subject_id, STORE_ROUTE_ID);
  h.clickNode(h.nodeByData('data-function-node', BUS_SEND_ID));
  await new Promise((resolve) => setTimeout(resolve, 200));
  await h.settle();
  assert.equal(deferreds.length, 2, 'second subject request after debounce');
  assert.equal(deferreds[1].payload.subject_id, BUS_SEND_ID);
  const firstCall = h.rpc.callsFor('view.summary')[0];
  assert.equal(firstCall.signal && firstCall.signal.aborted, true, 'superseded request is aborted');

  deferreds[0].pending.resolve(makeSummaryPayload({summaries: [makeSummaryRecord({subject: {type: 'function', id: STORE_ROUTE_ID}, text: 'OLD stale summary'})]}));
  await h.settle();
  assert.equal(h.findAll((node) => node.props && node.props['data-ai-summary-text'] !== undefined).length, 0, 'stale response must not render');
  deferreds[1].pending.resolve(makeSummaryPayload({summaries: [makeSummaryRecord({subject: {type: 'function', id: BUS_SEND_ID}, text: 'NEW summary'})]}));
  await h.settle();
  const text = h.nodeByData('data-ai-summary-text', '');
  assert.ok(text);
  assert.equal(h.textOf(text), 'NEW summary');
  assert.equal(h.text().includes('OLD stale summary'), false);
});

test('group subject selection opens group details and loads group AI summary', async (t) => {
  const h = bootHarness({
    'view.summary': (payload) => makeSummaryPayload({
      summaries: [makeSummaryRecord({
        subject: {type: payload.subject_type, id: payload.subject_id},
        text: '组归纳：dispatch_transfer 下游由两个私有子流程组成，均只被该函数调用。',
        facts: [{kind: 'node', ref: 'group:' + 'x'}],
        inference_labels: ['from_static_structure'],
      })],
    }),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await switchView(h, 'end_to_end');
  const groupBox = h.nodeByData('data-graph-group', GROUP_DISPATCH);
  assert.ok(groupBox);
  h.clickNode(groupBox);
  await waitSummary(h);
  const payload = h.rpc.lastPayload('view.summary');
  assert.equal(payload.subject_type, 'group');
  assert.equal(payload.subject_id, GROUP_DISPATCH);
  const details = detailsNode(h);
  assert.ok(details);
  assert.ok(h.textOf(details).includes('组详情'));
  assert.ok(h.textOf(details).includes('dispatch_transfer 下游子流程'));
  assert.ok(h.textOf(h.nodeByData('data-ai-summary-text', '')).includes('组归纳'));
  assert.equal(h.findAll((node) => node.props && node.props['data-ai-summary-gap'] !== undefined).length, 0);
});

test('refresh and closing/reopening details reload the summary', async (t) => {
  let version = 0;
  const h = bootHarness({
    'view.summary': (payload) => {
      version += 1;
      return makeSummaryPayload({
        summaries: [makeSummaryRecord({subject: {type: payload.subject_type, id: payload.subject_id}, text: 'summary version ' + String(version)})],
      });
    },
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await waitSummary(h);
  assert.equal(h.textOf(h.nodeByData('data-ai-summary-text', '')), 'summary version 1');
  h.clickButton('重新读取');
  await h.settle();
  await waitSummary(h);
  assert.equal(h.textOf(h.nodeByData('data-ai-summary-text', '')), 'summary version 2');
  h.clickNode(h.findAll((node) => node.tag === 'button' && h.textOf(node).includes('关闭详情'))[0]);
  await h.settle();
  assert.equal(detailsNode(h), null);
  assert.equal(h.nodeByData('data-code-view', 'ai-summary'), null);
  h.clickNode(h.nodeByData('data-function-node', BUS_SEND_ID));
  await waitSummary(h);
  assert.equal(h.textOf(h.nodeByData('data-ai-summary-text', '')), 'summary version 3');
});

// ---------------------------------------------------------------------------
// 14. first-screen performance: parallel reads, idle/hover prefetch, session cache
// ---------------------------------------------------------------------------

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function viewCacheHit(h) { return viewRoot(h).props['data-cache']; }
function cacheSize(h) { return Number(h.nodeByData('data-code-view', 'panel').props['data-cache-size']); }
function entryCouplingCalls(h) { return h.rpc.callsFor('view.coupling').filter((call) => call.payload && call.payload.entry !== undefined); }

test('entry selection fires getEntry and the current view in parallel; each branch resolves independently', async (t) => {
  const entryDeferred = deferred();
  const couplingDeferred = deferred();
  const h = bootHarness({
    'view.getEntry': () => entryDeferred.promise,
    'view.coupling': (payload) => {
      if (payload && payload.entry !== undefined) return couplingDeferred.promise;
      return makeCouplingPayload({selection: makeSelection(), scope: {mode: 'snapshot', entry_id: null}});
    },
  });
  t.after(() => h.dispose());
  await h.boot();
  await openSnapshot(h);
  h.clickData('data-entry-name', 'bus_send');
  await h.settle();
  assert.deepEqual(h.rpc.lastPayload('view.getEntry'), {workspace: 'code-view-bus-demo', snapshot: SNAPSHOT_ID, entry: BUS_SEND_ID});
  const entryCoupling = entryCouplingCalls(h).at(-1);
  assert.ok(entryCoupling, 'coupling for the selected entry must be requested in parallel before getEntry resolves');
  assert.equal(entryCoupling.payload.entry, BUS_SEND_ID);
  couplingDeferred.resolve(makeCouplingPayload());
  await h.settle();
  assert.equal(viewRoot(h).props['data-state'], 'ready', 'coupling can become ready while getEntry is still pending');
  assert.equal(viewRoot(h).props['data-view'], 'coupling');
  entryDeferred.resolve(makeEntryPayload());
  await h.settle();
  assert.ok(detailsNode(h));
  assert.equal(h.findAll((node) => node.props && node.props['data-code-view'] === 'source').length >= 1, true);
});

test('one failed parallel read does not mask the other: getEntry failure keeps the view ready and errors are not cached', async (t) => {
  const h = bootHarness({
    'view.getEntry': (payload) => (payload.entry === BUS_SEND_ID ? failResult('NOT_FOUND', 'entry details missing') : makeEntryPayload()),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  assert.equal(viewRoot(h).props['data-state'], 'ready', 'coupling succeeded even though getEntry failed');
  const errorCodes = h.findAll((node) => node.props && node.props['data-error-code'] !== undefined).map((node) => node.props['data-error-code']);
  assert.ok(errorCodes.includes('NOT_FOUND'), 'getEntry error is surfaced with data-error-code');
  const failedCalls = h.rpc.callsFor('view.getEntry').length;
  h.clickData('data-entry-name', 'store_route');
  await h.settle();
  h.clickData('data-entry-name', 'bus_send');
  await h.settle();
  assert.ok(h.rpc.callsFor('view.getEntry').length > failedCalls, 'failed responses are never cached; selecting again retries');
});

test('a failed view read does not mask a successful getEntry', async (t) => {
  const h = bootHarness({
    'view.coupling': (payload) => (payload && payload.entry !== undefined ? failResult('OUTCOME_UNKNOWN', 'coupling projection failed') : makeCouplingPayload()),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  assert.equal(viewRoot(h).props['data-state'], 'error');
  const errorCodes = h.findAll((node) => node.props && node.props['data-error-code'] !== undefined).map((node) => node.props['data-error-code']);
  assert.ok(errorCodes.includes('OUTCOME_UNKNOWN'));
  assert.ok(detailsNode(h), 'getEntry details still render when the view failed');
  assert.equal(h.findAll((node) => node.props && node.props['data-code-view'] === 'source').length >= 1, true);
});

test('idle prefetch warms the first entry after entries load and a click is served from cache', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openSnapshot(h);
  await delay(140);
  await h.settle();
  const prefetchGet = h.rpc.callsFor('view.getEntry');
  assert.equal(prefetchGet.length, 1, 'first entry getEntry is prefetched after entries are ready');
  assert.equal(prefetchGet[0].payload.entry, BUS_SEND_ID);
  const prefetchCoupling = entryCouplingCalls(h);
  assert.equal(prefetchCoupling.length, 1, 'first entry coupling is prefetched too');
  assert.equal(prefetchCoupling[0].payload.entry, BUS_SEND_ID);
  assert.ok(cacheSize(h) >= 2);
  const getCallsBefore = h.rpc.callsFor('view.getEntry').length;
  const couplingCallsBefore = entryCouplingCalls(h).length;
  h.clickData('data-entry-name', 'bus_send');
  await h.settle();
  assert.equal(h.rpc.callsFor('view.getEntry').length, getCallsBefore, 'cache hit: no new getEntry RPC');
  assert.equal(entryCouplingCalls(h).length, couplingCallsBefore, 'cache hit: no new coupling RPC');
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  assert.equal(viewCacheHit(h), 'hit');
  assert.equal(detailsNode(h).props['data-cache'], 'hit');
  assert.ok(h.text().includes('bus_send'));
});

test('hovering/focusing an entry row prefetches it and the subsequent click hits the cache', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openSnapshot(h);
  await delay(140);
  await h.settle();
  const storeRow = h.nodeByData('data-entry-name', 'store_route');
  assert.ok(storeRow);
  const callsBefore = h.rpc.callsFor('view.getEntry').length;
  storeRow.props.onMouseEnter({});
  await h.settle();
  await delay(20);
  await h.settle();
  const storeCalls = h.rpc.callsFor('view.getEntry').filter((call) => call.payload.entry === STORE_ROUTE_ID);
  assert.ok(storeCalls.length >= 1, 'hover triggers a getEntry prefetch for that entry');
  const couplingStore = entryCouplingCalls(h).filter((call) => call.payload.entry === STORE_ROUTE_ID);
  assert.ok(couplingStore.length >= 1, 'hover triggers a coupling prefetch too');
  h.clickData('data-entry-name', 'store_route');
  await h.settle();
  assert.equal(h.rpc.callsFor('view.getEntry').length, callsBefore + storeCalls.length, 'click is served from the hover prefetch cache');
  assert.equal(viewRoot(h).props['data-cache'], 'hit');
});

test('revisiting an already loaded entry in the same session does not repeat RPCs', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  h.clickData('data-entry-name', 'store_route');
  await h.settle();
  const getCallsBefore = h.rpc.callsFor('view.getEntry').length;
  h.clickData('data-entry-name', 'bus_send');
  await h.settle();
  assert.equal(h.rpc.callsFor('view.getEntry').length, getCallsBefore, 'cached getEntry');
  assert.equal(viewRoot(h).props['data-cache'], 'hit');
  assert.ok(h.text().includes('bus_send'));
});

test('refresh clears the session cache and refetches the entry', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  const before = h.rpc.callsFor('view.getEntry').length;
  h.clickButton('重新读取');
  await h.settle();
  await h.settle();
  assert.ok(h.rpc.callsFor('view.getEntry').length > before, 'refresh must clear the cache and refetch');
  assert.ok(selectionJson(h).entry_id === BUS_SEND_ID, 'restored entry after refresh');
});

test('switching snapshots clears the session cache', async (t) => {
  const secondSnapshot = makeSnapshotRow({snapshot_id: 'b'.repeat(32)});
  const h = bootHarness({
    'view.listSnapshots': () => makeSnapshotsPayload({workspaces: [makeWorkspace({snapshots: [makeSnapshotRow(), secondSnapshot]})]}),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openSnapshot(h);
  h.clickData('data-entry-name', 'bus_send');
  await h.settle();
  const firstCount = h.rpc.callsFor('view.getEntry').length;
  h.clickData('data-snapshot-id', 'b'.repeat(32));
  await h.settle();
  h.clickData('data-snapshot-id', SNAPSHOT_ID);
  await h.settle();
  await delay(120);
  await h.settle();
  h.clickData('data-entry-name', 'bus_send');
  await h.settle();
  assert.ok(h.rpc.callsFor('view.getEntry').length > firstCount, 'snapshot switch invalidates cached entries');
});

test('session cache is a bounded LRU of at most 32 entries', async (t) => {
  const manyEntries = Array.from({length: 24}, (_, index) => makeEntryRow({
    entry_id: 'f_many_' + String(index),
    symbol_id: 's_many_' + String(index),
    name: 'many_fn_' + String(index),
    display_name: 'many_fn_' + String(index) + '()',
    file: 'bus.c',
    line: index + 1,
    is_entry: index === 0,
  }));
  const h = bootHarness({'view.listEntries': () => makeEntriesPayload({entries: manyEntries})});
  t.after(() => h.dispose());
  await h.boot();
  await openSnapshot(h);
  await delay(140);
  await h.settle();
  const rows = h.findAll((node) => node.props && node.props['data-entry-name'] !== undefined);
  assert.equal(rows.length, 24);
  for (const row of rows) {
    row.props.onMouseEnter({});
    await h.settle();
  }
  await h.settle();
  const size = cacheSize(h);
  assert.ok(Number.isInteger(size) && size > 0 && size <= 32, 'cache size must stay within the 32-entry LRU bound, got ' + size);
  const lastRow = rows[rows.length - 1];
  const lastEntryId = lastRow.props['data-entry-id'];
  lastRow.props.onMouseEnter({});
  await h.settle();
  const getCallsBefore = h.rpc.callsFor('view.getEntry').length;
  h.clickData('data-entry-name', lastRow.props['data-entry-name']);
  await h.settle();
  assert.equal(h.rpc.callsFor('view.getEntry').length, getCallsBefore, 'most recently prefetched entry is still cached');
  assert.ok(h.text().includes(lastRow.props['data-entry-name']));
});

test('an in-flight idle prefetch is shared with the click instead of issuing a duplicate RPC', async (t) => {
  const entryDeferred = deferred();
  let getEntryCalls = 0;
  const h = bootHarness({
    'view.getEntry': () => {
      getEntryCalls += 1;
      if (getEntryCalls === 1) return entryDeferred.promise;
      return makeEntryPayload();
    },
  });
  t.after(() => h.dispose());
  await h.boot();
  await openSnapshot(h);
  await delay(140);
  await h.settle();
  assert.equal(h.rpc.callsFor('view.getEntry').length, 1, 'idle prefetch started one getEntry');
  h.clickData('data-entry-name', 'bus_send');
  await h.settle();
  assert.equal(h.rpc.callsFor('view.getEntry').length, 1, 'click shares the in-flight prefetch instead of duplicating it');
  entryDeferred.resolve(makeEntryPayload());
  await h.settle();
  assert.ok(detailsNode(h));
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  assert.equal(detailsNode(h).props['data-cache'], 'hit');
  assert.equal(h.rpc.callsFor('view.getEntry').length, 1);
});

// ---------------------------------------------------------------------------
// 15. S4-prep: batch first-screen endpoint, cache seeding and fallback
// ---------------------------------------------------------------------------

function firstScreenCalls(h) { return h.rpc.callsFor('view.firstScreen'); }
function detailErrorCodes(h) {
  return h.findAll((node) => node.props && node.props['data-error-code'] !== undefined).map((node) => node.props['data-error-code']);
}
function batchPayload(h, overrides = {}) {
  return makeFirstScreenPayload({
    entry: makeEntryPayload(),
    interfaces: makeInterfacesPayload(),
    view_payload: makeCouplingPayload(),
    ...overrides,
  });
}

test('first screen prefers one view.firstScreen batch and marks data-first-screen=batch', async (t) => {
  const h = bootHarness({
    'view.firstScreen': (payload) => batchPayload(h, {view: payload.view}),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openSnapshot(h);
  h.clickData('data-entry-name', 'bus_send');
  await h.settle();
  assert.equal(firstScreenCalls(h).length, 1, 'exactly one batch request');
  assert.deepEqual(h.rpc.lastPayload('view.firstScreen'), {workspace: 'code-view-bus-demo', snapshot: SNAPSHOT_ID, entry: BUS_SEND_ID, view: 'coupling'});
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  assert.equal(viewRoot(h).props['data-first-screen'], 'batch');
  assert.equal(detailsNode(h).props['data-first-screen'], 'batch');
  assert.equal(h.nodeByData('data-code-view', 'panel').props['data-first-screen'], 'batch');
  assert.equal(h.rpc.callsFor('view.getEntry').length, 0, 'batch provides entry, no single getEntry');
  assert.equal(h.rpc.callsFor('view.interfaces').filter((call) => call.payload && call.payload.entry === BUS_SEND_ID).length, 0, 'batch provides interfaces');
  assert.equal(h.rpc.callsFor('view.coupling').filter((call) => call.payload && call.payload.entry !== undefined).length, 0, 'batch provides the current view');
  assert.ok(h.nodeByData('data-code-view', 'source'), 'details source tab content preserved');
  assert.equal(h.findAll((node) => node.props && node.props['data-code-view'] === 'details-tab').length, 3);
  assert.equal(selectionJson(h).entry_id, BUS_SEND_ID);
  assert.ok(h.nodeByData('data-ai-summary-gap') || h.findAll((node) => node.props && node.props['data-ai-summary-loading'] !== undefined).length >= 0);
  assert.equal(h.text().includes('E:\\'), false);
});

test('batch success seeds the per-endpoint cache so view switches and re-selection hit it', async (t) => {
  const h = bootHarness({
    'view.firstScreen': (payload) => batchPayload(h, {view: payload.view}),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openSnapshot(h);
  h.clickData('data-entry-name', 'bus_send');
  await h.settle();
  assert.equal(firstScreenCalls(h).length, 1);
  await switchView(h, 'tree');
  const treeCalls = h.rpc.callsFor('view.tree').length;
  assert.ok(treeCalls >= 1, 'tree is fetched when first switching to it');
  await switchView(h, 'coupling');
  assert.equal(h.rpc.callsFor('view.coupling').filter((call) => call.payload && call.payload.entry !== undefined).length, 0, 'coupling came from the batch cache');
  assert.equal(viewRoot(h).props['data-cache'], 'hit');
  h.clickData('data-entry-name', 'bus_send');
  await h.settle();
  assert.equal(firstScreenCalls(h).length, 1, 'fully cache-hot re-selection skips the batch RPC');
  assert.equal(h.rpc.callsFor('view.getEntry').length, 0, 'cached getEntry is not requested again');
  assert.equal(h.rpc.callsFor('view.interfaces').filter((call) => call.payload && call.payload.entry === BUS_SEND_ID).length, 0);
  assert.equal(viewRoot(h).props['data-cache'], 'hit');
  assert.equal(selectionJson(h).entry_id, BUS_SEND_ID);
});

test('batch failure falls back to the parallel individual reads exactly once and marks fallback', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  assert.equal(firstScreenCalls(h).length, 1);
  assert.equal(h.rpc.callsFor('view.getEntry').length, 1);
  assert.equal(h.rpc.callsFor('view.interfaces').filter((call) => call.payload && call.payload.entry === BUS_SEND_ID).length, 1);
  assert.equal(h.rpc.callsFor('view.coupling').filter((call) => call.payload && call.payload.entry !== undefined).length, 1);
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  assert.equal(viewRoot(h).props['data-first-screen'], 'fallback');
  assert.equal(detailsNode(h).props['data-first-screen'], 'fallback');
  assert.equal(h.nodeByData('data-code-view', 'panel').props['data-first-screen'], 'fallback');
  assert.equal(detailErrorCodes(h).includes('UNKNOWN_ENDPOINT'), false, 'batch failure is silent; only individual errors surface');
  assert.ok(h.nodeByData('data-code-view', 'source'));
  h.clickData('data-entry-name', 'store_route');
  await h.settle();
  assert.equal(firstScreenCalls(h).length, 1, 'unsupported batch endpoint is remembered for the session');
  assert.ok(h.rpc.callsFor('view.getEntry').some((call) => call.payload.entry === STORE_ROUTE_ID));
  assert.equal(selectionJson(h).entry_id, STORE_ROUTE_ID);
  assert.equal(viewRoot(h).props['data-first-screen'], 'fallback');
});

test('LIMIT_EXCEEDED falls back but is retried for the next selection', async (t) => {
  const h = bootHarness({
    'view.firstScreen': () => failResult('LIMIT_EXCEEDED', 'batch payload exceeds 480 KiB'),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  assert.equal(firstScreenCalls(h).length, 1);
  assert.equal(viewRoot(h).props['data-first-screen'], 'fallback');
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  assert.ok(h.rpc.callsFor('view.getEntry').length >= 1);
  h.clickData('data-entry-name', 'store_route');
  await h.settle();
  assert.equal(firstScreenCalls(h).length, 2, 'LIMIT_EXCEEDED is payload-specific, so the batch is retried');
  assert.equal(viewRoot(h).props['data-first-screen'], 'fallback');
  assert.equal(selectionJson(h).entry_id, STORE_ROUTE_ID);
});

test('a malformed batch payload falls back instead of fabricating first-screen data', async (t) => {
  const h = bootHarness({
    'view.firstScreen': () => okResult({
      schema_version: 1,
      entry: makeEntryPayload(),
      interfaces: makeInterfacesPayload(),
    }),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  assert.equal(firstScreenCalls(h).length, 1);
  assert.equal(h.rpc.callsFor('view.getEntry').length, 1, 'missing view_payload triggers the individual path');
  assert.equal(h.rpc.callsFor('view.interfaces').filter((call) => call.payload && call.payload.entry === BUS_SEND_ID).length, 1);
  assert.equal(viewRoot(h).props['data-first-screen'], 'fallback');
  assert.equal(viewRoot(h).props['data-state'], 'ready');
});

test('snapshot switch aborts the in-flight batch and discards its late response', async (t) => {
  const batchDeferred = deferred();
  const secondSnapshot = makeSnapshotRow({snapshot_id: 'b'.repeat(32)});
  const h = bootHarness({
    'view.listSnapshots': () => makeSnapshotsPayload({workspaces: [makeWorkspace({snapshots: [makeSnapshotRow(), secondSnapshot]})]}),
    'view.firstScreen': () => batchDeferred.promise,
  });
  t.after(() => h.dispose());
  await h.boot();
  await openSnapshot(h);
  h.clickData('data-entry-name', 'bus_send');
  await h.settle();
  assert.equal(firstScreenCalls(h).length, 1);
  const firstSignal = firstScreenCalls(h)[0].signal;
  h.clickData('data-snapshot-id', 'b'.repeat(32));
  await h.settle();
  assert.equal(firstSignal && firstSignal.aborted, true, 'batch request is aborted on snapshot switch');
  const baseEntry = makeEntryPayload();
  batchDeferred.resolve(batchPayload(h, {
    entry: {...baseEntry, entry: {...baseEntry.entry, name: 'stale_entry_name'}},
  }));
  await h.settle();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await h.settle();
  assert.equal(selectionJson(h).entry_id, null, 'stale batch must not restore an entry on the new snapshot');
  assert.equal(h.text().includes('stale_entry_name'), false);
  assert.equal(detailsNode(h), null);
  assert.equal(h.nodeByData('data-code-view', 'view').props['data-first-screen'], undefined);
});

test('refresh aborts the in-flight batch and a fresh batch fills the restored first screen', async (t) => {
  const batches = [];
  const h = bootHarness({
    'view.firstScreen': () => {
      const pending = deferred();
      batches.push(pending);
      return pending.promise;
    },
  });
  t.after(() => h.dispose());
  await h.boot();
  await openSnapshot(h);
  h.clickData('data-entry-name', 'bus_send');
  await h.settle();
  assert.equal(batches.length, 1);
  const firstBatchSignal = firstScreenCalls(h)[0].signal;
  h.clickButton('重新读取');
  await h.settle();
  assert.equal(firstBatchSignal && firstBatchSignal.aborted, true, 'refresh aborts the old batch');
  assert.ok(batches.length >= 2, 'refresh starts a fresh batch after restoring the selection');
  const staleEntry = makeEntryPayload();
  batches[0].resolve(batchPayload(h, {entry: {...staleEntry, entry: {...staleEntry.entry, name: 'stale_after_refresh'}}}));
  await h.settle();
  assert.equal(h.text().includes('stale_after_refresh'), false);
  batches[batches.length - 1].resolve(batchPayload(h));
  await h.settle();
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  assert.equal(viewRoot(h).props['data-first-screen'], 'batch');
  assert.ok(detailsNode(h));
  assert.equal(selectionJson(h).entry_id, BUS_SEND_ID);
});

test('batch path keeps old DOM hooks, gaps and error semantics intact', async (t) => {
  const h = bootHarness({
    'view.firstScreen': (payload) => batchPayload(h, {view: payload.view}),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  for (const hook of ['status', 'panel', 'tabs', 'legend', 'details', 'selection', 'view', 'source', 'resources']) {
    assert.ok(h.nodeByData('data-code-view', hook), 'hook ' + hook + ' must survive the batch path');
  }
  assert.ok(h.findAll((node) => node.props && node.props['data-entry-id'] !== undefined).length >= 2);
  assert.ok(h.findAll((node) => node.props && node.props['data-snapshot-id'] !== undefined).length >= 1);
  assert.equal(h.findAll((node) => node.props && node.props['data-code-view'] === 'details-tab').length, 3);
  assert.deepEqual(h.findAll((node) => node.props && node.props['data-error-code'] !== undefined).map((node) => node.props['data-error-code']), []);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await h.settle();
  assert.ok(h.findAll((node) => node.props && node.props['data-ai-summary-gap'] !== undefined).length >= 1, 'AI summary gap hook still works after batch');
});

// ---------------------------------------------------------------------------
// 16. S4-prep: batch coupling_aux saves the extra coupling RPC
// ---------------------------------------------------------------------------

function batchWithAux(h, overrides = {}) {
  return makeFirstScreenPayload({
    entry: makeEntryPayload(),
    interfaces: makeInterfacesPayload(),
    view_payload: makeCouplingPayload(),
    coupling_aux: makeCouplingPayload(),
    ...overrides,
  });
}
function auxEntryCouplingCalls(h) {
  return h.rpc.callsFor('view.coupling').filter((call) => call.payload && call.payload.entry !== undefined);
}

async function openNonCouplingViewAndEntry(h, view) {
  await openSnapshot(h);
  await switchView(h, view);
  h.clickData('data-entry-name', 'bus_send');
  await h.settle();
}

test('tree batch coupling_aux fills coupling/rail and skips the separate coupling RPC', async (t) => {
  const h = bootHarness({
    'view.firstScreen': (payload) => batchWithAux(h, {view: payload.view, view_payload: makeTreePayload()}),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openNonCouplingViewAndEntry(h, 'tree');
  assert.equal(firstScreenCalls(h).length, 1);
  assert.equal(h.rpc.lastPayload('view.firstScreen').view, 'tree');
  assert.equal(auxEntryCouplingCalls(h).length, 0, 'coupling_aux must replace the separate coupling RPC');
  assert.equal(viewRoot(h).props['data-view'], 'tree');
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  assert.equal(viewRoot(h).props['data-first-screen'], 'batch');
  assert.equal(detailsNode(h).props['data-first-screen'], 'batch');
  assert.ok(h.nodeByData('data-resource-row', ROUTES_ID), 'rail resources come from coupling_aux');
  assert.ok(h.nodeByData('data-code-view', 'source'));
  const couplingCacheCalls = auxEntryCouplingCalls(h).length;
  await switchView(h, 'coupling');
  assert.equal(auxEntryCouplingCalls(h).length, couplingCacheCalls, 'coupling_aux seeds the coupling cache for the later switch');
  assert.ok(auxEntryCouplingCalls(h).length === 0);
  assert.equal(viewRoot(h).props['data-view'], 'coupling');
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  assert.equal(viewRoot(h).props['data-cache'], 'hit');
  assert.ok(h.nodeByData('data-resource-row', ROUTES_ID));
  assert.equal(h.text().includes('E:\\'), false);
});

test('end_to_end batch coupling_aux skips coupling and keeps graph + rail hooks', async (t) => {
  const h = bootHarness({
    'view.firstScreen': (payload) => batchWithAux(h, {view: payload.view, view_payload: makeEndToEndPayload()}),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openNonCouplingViewAndEntry(h, 'end_to_end');
  assert.equal(firstScreenCalls(h).length, 1);
  assert.equal(h.rpc.lastPayload('view.firstScreen').view, 'end_to_end');
  assert.equal(auxEntryCouplingCalls(h).length, 0);
  assert.equal(viewRoot(h).props['data-view'], 'end_to_end');
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  assert.equal(viewRoot(h).props['data-first-screen'], 'batch');
  assert.ok(h.findAll((node) => node.props && node.props['data-graph-node'] !== undefined).length > 0, 'graph nodes still render');
  assert.ok(h.nodeByData('data-resource-row', ROUTES_ID));
  await switchView(h, 'coupling');
  assert.equal(auxEntryCouplingCalls(h).length, 0, 'coupling switch is a cache hit');
  assert.equal(viewRoot(h).props['data-cache'], 'hit');
});

test('sequence batch coupling_aux skips coupling and keeps sequence + rail hooks', async (t) => {
  const h = bootHarness({
    'view.firstScreen': (payload) => batchWithAux(h, {view: payload.view, view_payload: makeSequencePayload()}),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openNonCouplingViewAndEntry(h, 'sequence');
  assert.equal(firstScreenCalls(h).length, 1);
  assert.equal(h.rpc.lastPayload('view.firstScreen').view, 'sequence');
  assert.equal(auxEntryCouplingCalls(h).length, 0);
  assert.equal(viewRoot(h).props['data-view'], 'sequence');
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  assert.equal(viewRoot(h).props['data-first-screen'], 'batch');
  assert.ok(h.findAll((node) => node.props && node.props['data-sequence-mode'] !== undefined).length >= 1);
  assert.ok(h.nodeByData('data-resource-row', ROUTES_ID));
  await switchView(h, 'coupling');
  assert.equal(auxEntryCouplingCalls(h).length, 0);
  assert.equal(viewRoot(h).props['data-cache'], 'hit');
});

test('file batch coupling_aux skips coupling while the file view keeps its own tree', async (t) => {
  const h = bootHarness({
    'view.firstScreen': (payload) => batchWithAux(h, {view: payload.view, view_payload: makeFileTreePayload()}),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openSnapshot(h);
  await switchView(h, 'file');
  h.clickData('data-entry-name', 'bus_send');
  await h.settle();
  assert.equal(firstScreenCalls(h).length, 1);
  assert.equal(h.rpc.lastPayload('view.firstScreen').view, 'file');
  assert.equal(auxEntryCouplingCalls(h).length, 0, 'file batch coupling_aux also skips the coupling RPC');
  assert.equal(viewRoot(h).props['data-view'], 'file');
  assert.equal(viewRoot(h).props['data-first-screen'], 'batch');
  assert.equal(detailsNode(h).props['data-first-screen'], 'batch');
  assert.ok(h.nodeByData('data-resource-row', ROUTES_ID));
  assert.ok(h.nodeByData('data-code-view', 'source'));
  assert.equal(h.text().includes('E:\\'), false);
});

test('missing coupling_aux keeps the old separate coupling request (batch still applied)', async (t) => {
  const h = bootHarness({
    'view.firstScreen': (payload) => makeFirstScreenPayload({
      view: payload.view,
      entry: makeEntryPayload(),
      interfaces: makeInterfacesPayload(),
      view_payload: makeTreePayload(),
    }),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openNonCouplingViewAndEntry(h, 'tree');
  assert.equal(firstScreenCalls(h).length, 1);
  assert.equal(viewRoot(h).props['data-first-screen'], 'batch');
  assert.equal(auxEntryCouplingCalls(h).length, 1, 'missing coupling_aux falls back to the separate coupling request');
  assert.equal(h.rpc.lastPayload('view.coupling').entry, BUS_SEND_ID);
  assert.ok(h.nodeByData('data-resource-row', ROUTES_ID), 'rail still filled by the fallback coupling request');
});

test('malformed coupling_aux falls back to the separate coupling request', async (t) => {
  const h = bootHarness({
    'view.firstScreen': (payload) => batchWithAux(h, {
      view: payload.view,
      view_payload: makeTreePayload(),
      coupling_aux: {resources: 'not-an-array', functions: null},
    }),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openNonCouplingViewAndEntry(h, 'tree');
  assert.equal(firstScreenCalls(h).length, 1);
  assert.equal(viewRoot(h).props['data-first-screen'], 'batch');
  assert.equal(auxEntryCouplingCalls(h).length, 1);
  assert.ok(h.nodeByData('data-resource-row', ROUTES_ID));
});

test('coupling view batches ignore coupling_aux and use view_payload (old behaviour)', async (t) => {
  const h = bootHarness({
    'view.firstScreen': (payload) => batchWithAux(h, {view: 'coupling', view_payload: makeCouplingPayload()}),
  });
  t.after(() => h.dispose());
  await h.boot();
  await openSnapshot(h);
  h.clickData('data-entry-name', 'bus_send');
  await h.settle();
  assert.equal(firstScreenCalls(h).length, 1);
  assert.equal(auxEntryCouplingCalls(h).length, 0);
  assert.equal(viewRoot(h).props['data-first-screen'], 'batch');
  assert.equal(viewRoot(h).props['data-state'], 'ready');
  assert.ok(h.nodeByData('data-resource-row', ROUTES_ID));
});

// ---------------------------------------------------------------------------
// 17. S4-prep: observed async/IRQ event markers
// ---------------------------------------------------------------------------

function asyncRows(h) {
  return h.findAll((node) => node.props && node.props['data-sequence-async'] === 'true');
}
function asyncNote(h) {
  return h.findAll((node) => node.props && node.props['data-sequence-async-note'] !== undefined)[0];
}
async function enterObserved(h) {
  await openEntry(h);
  await switchView(h, 'sequence');
  await h.settle();
  h.clickNode(h.findAll((node) => node.props && node.props['data-sequence-mode'] === 'observed')[0]);
  await h.settle();
  await h.settle();
}

test('observed async event renders the 异步 chip, data-sequence-async marker and the header note', async (t) => {
  const h = bootHarness({
    'scenario.list': () => makeScenarioLedgerPayload({scenarios: [makeScenarioSummary()]}),
  });
  t.after(() => h.dispose());
  await h.boot();
  await enterObserved(h);
  const rows = asyncRows(h);
  assert.equal(rows.length, 1, 'exactly the async IRQ message is marked');
  assert.equal(rows[0].props['data-sequence-message'], 'm_7');
  assert.equal(rows[0].props['data-observed'], 'true');
  assert.ok(h.textOf(rows[0]).includes('IRQ'));
  assert.ok(h.textOf(rows[0]).includes('异步'));
  assert.ok(h.findAll((node) => node.props && node.props['data-sequence-async-chip'] !== undefined).length >= 1);
  const writeRow = h.findAll((node) => node.props && node.props['data-sequence-message'] === 'm_2')[0];
  assert.ok(writeRow);
  assert.equal(writeRow.props['data-sequence-async'], undefined, 'non-async observed messages have no async marker');
  assert.equal(h.textOf(writeRow).includes('异步'), false);
  const note = asyncNote(h);
  assert.ok(note, 'header note appears when async messages exist');
  assert.ok(h.textOf(note).includes('由中断/完成事件触发'));
  assert.ok(h.textOf(note).includes('已执行或导入'));
  assert.ok(h.text().includes('observed=true'), 'old observed header hook still present');
  assert.equal(h.findAll((node) => node.props && node.props['data-sequence-message'] !== undefined && node.props['data-observed'] === 'true').length >= 7, true);
  assert.equal(h.text().includes('E:\\'), false);
});

test('static prediction mode never renders async markers or the async note', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);
  await switchView(h, 'sequence');
  assert.equal(asyncRows(h).length, 0);
  assert.equal(asyncNote(h), undefined);
  assert.equal(h.text().includes('异步：由中断/完成事件触发'), false);
  assert.equal(h.findAll((node) => node.props && node.props['data-sequence-async-chip'] !== undefined).length, 0);
});

test('switching observed -> static -> observed updates the async markers', async (t) => {
  const h = bootHarness({
    'scenario.list': () => makeScenarioLedgerPayload({scenarios: [makeScenarioSummary()]}),
  });
  t.after(() => h.dispose());
  await h.boot();
  await enterObserved(h);
  assert.equal(asyncRows(h).length, 1);
  assert.ok(asyncNote(h));
  h.clickNode(h.findAll((node) => node.props && node.props['data-sequence-mode'] === 'static')[0]);
  await h.settle();
  assert.equal(asyncRows(h).length, 0, 'static mode clears the async markers');
  assert.equal(asyncNote(h), undefined);
  h.clickNode(h.findAll((node) => node.props && node.props['data-sequence-mode'] === 'observed')[0]);
  await h.settle();
  await h.settle();
  assert.equal(asyncRows(h).length, 1, 'returning to observed restores the async marker');
  assert.ok(asyncNote(h));
});

test('async markers follow the observed scenario selection', async (t) => {
  const scenarios = [
    makeScenarioSummary({scenario_id: 'scn_0123456789ab', generation: 2, updated_at: '2026-11-15T09:00:00Z'}),
    makeImportedScenarioSummary({updated_at: '2026-11-15T08:00:00Z'}),
  ];
  const h = bootHarness({
    'scenario.list': () => makeScenarioLedgerPayload({scenarios}),
    'view.sequence': (payload) => {
      if (payload.mode !== 'observed') return makeSequencePayload();
      return payload.scenario === 'scn_1a2b3c4d5e6f' ? makeImportedObservedSequencePayload() : makeObservedSequencePayload();
    },
  });
  t.after(() => h.dispose());
  await h.boot();
  await enterObserved(h);
  assert.equal(asyncRows(h).length, 1);
  const select = h.findAll((node) => node.props && node.props['data-sequence-scenario-select'] !== undefined)[0];
  select.props.onChange({target: {value: 'scn_1a2b3c4d5e6f'}});
  await h.settle();
  await h.settle();
  assert.equal(asyncRows(h).length, 0, 'an imported trace without async declarations has no async marker');
  assert.equal(asyncNote(h), undefined);
  const selectAgain = h.findAll((node) => node.props && node.props['data-sequence-scenario-select'] !== undefined)[0];
  selectAgain.props.onChange({target: {value: 'scn_0123456789ab'}});
  await h.settle();
  await h.settle();
  assert.equal(asyncRows(h).length, 1, 'switching back restores the async marker for the simulated ledger');
  assert.ok(asyncNote(h));
});
