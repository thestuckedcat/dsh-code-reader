// T3 / CL-VIEW-T1 client-half contract tests (04 code-reader).
//
// These tests load the REAL rc.5 client module (bundle/client.js) through the
// fake loader/window/document/React/ctx in tests/node/helpers/client-harness.mjs.
// They cover the loader wrapper + plugin shape, slot registration/dispose,
// view.status -> view.listSnapshots -> view.listEntries -> view.getEntry flow,
// snapshot/entry selection, source-line highlighting, evidence classification
// badges, resource identifiers (write/read + certainty), gaps, error codes,
// return-to-chat, remembered selection on re-open and the five-view placeholders.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL,
  PANEL_KEY,
  PANEL_LABEL,
  PLUGIN_ID,
  SNAPSHOT_ID,
  createHarness,
  failResult,
  deferred,
  makeEntriesPayload,
  makeEntryPayload,
  makeSelection,
  makeSnapshotsPayload,
  makeSourceLines,
  makeStatusPayload,
  makeWorkspace,
  readBundleSource,
} from './helpers/client-harness.mjs';

function bootHarness(overrides = {}) {
  const h = createHarness();
  h.rpc.setResponse('view.status', overrides.status ?? (() => makeStatusPayload()));
  h.rpc.setResponse('view.listSnapshots', overrides.snapshots ?? (() => makeSnapshotsPayload()));
  h.rpc.setResponse('view.listEntries', overrides.entries ?? (() => makeEntriesPayload()));
  h.rpc.setResponse('view.getEntry', overrides.entry ?? (() => makeEntryPayload()));
  return h;
}

async function openSnapshot(h) {
  h.clickData('data-snapshot-id', SNAPSHOT_ID);
  await h.settle();
}

async function openEntry(h, entryId = 'f_bus_send') {
  await openSnapshot(h);
  h.clickData('data-entry-id', entryId);
  await h.settle();
}

function selectionJson(h) {
  const node = h.nodeByData('data-code-view', 'selection');
  assert.ok(node, 'selection JSON node is missing');
  return JSON.parse(h.textOf(node));
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
// 1. loader wrapper and factory contract
// ---------------------------------------------------------------------------

test('rc.5 loader wrapper: id, first executable statement, only react, plugin shape', async (t) => {
  const source = readBundleSource();
  assert.ok(source.length < 64 * 1024, `bundle source must stay below 64KB, got ${source.length}`);
  const withoutLeadingComment = source.replace(/^\s*\/\*[\s\S]*?\*\//, '').trimStart();
  assert.ok(
    withoutLeadingComment.startsWith('window.__ModuleLoader__.load({'),
    'first executable statement must be window.__ModuleLoader__.load({...})',
  );

  const h = createHarness();
  t.after(() => h.dispose());
  assert.equal(h.loadError, null, `bundle failed to execute: ${h.loadError?.message}`);
  assert.equal(h.registrations.length, 1, 'exactly one __ModuleLoader__.load registration is expected');
  assert.equal(h.registration.id, PLUGIN_ID);
  assert.equal(typeof h.registration.factory, 'function');
  assert.equal(h.factoryError, null, `factory threw: ${h.factoryError?.message}`);
  assert.deepEqual(h.requires, ['react'], 'the bundle may only require the static react seed');
  assert.equal(h.plugin.name, 'dsh-code-reader');
  assert.deepEqual(h.plugin.inject, ['slots', 'layout', 'connection']);
  assert.equal(typeof h.plugin.apply, 'function');
});

// ---------------------------------------------------------------------------
// 2. slots, style injection, dispose and re-apply
// ---------------------------------------------------------------------------

test('registers keyed main + sidebar panellist, injects one style, dispose cleans, second apply works', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());

  assert.equal(h.styleCount(), 1, 'exactly one <style data-code-view-style> is injected at materialization');
  const style = h.styleNode();
  assert.ok(style, 'style element must be appended to document.head');
  assert.equal(style.parentNode, h.document.head);
  assert.ok(style.hasAttribute('data-code-view-style'));
  const css = String(style.textContent);
  for (const needle of [
    'dcr-',
    'var(--dsh-',
    'currentColor',
    '@media (max-width:720px)',
    ':focus-visible',
    'grid-template-columns',
    'prefers-reduced-motion',
  ]) {
    assert.ok(css.includes(needle), `stylesheet must contain ${JSON.stringify(needle)}`);
  }
  assert.equal(/background:\s*#|color:\s*#/.test(css), false, 'theme colors must not be hard-coded');

  h.apply();
  assert.equal(h.styleCount(), 1, 'apply must not inject a second stylesheet');
  const main = h.mainEntry();
  assert.ok(main, `main slot key "${PANEL_KEY}" must be registered`);
  assert.equal(main.options.name, 'main');
  assert.equal(main.options.key, PANEL_KEY);
  assert.equal(typeof main.component, 'function');

  const panellist = h.panellistEntry();
  assert.ok(panellist, `sidebar.panellist entry "${PANEL_KEY}" must be registered`);
  assert.equal(panellist.options.name, 'sidebar.panellist');
  assert.equal(panellist.options.id, PANEL_KEY);
  assert.equal(panellist.options.order, 30);
  assert.equal(typeof panellist.options.label, 'function');
  assert.equal(panellist.options.label(), PANEL_LABEL);

  const icon = panellist.component({size: 18});
  assert.equal(icon.type, 'svg', 'panellist entry must render an inline SVG icon, not an emoji');
  assert.equal(icon.props.role, 'img');
  assert.equal(icon.props['aria-label'], PANEL_LABEL, 'icon must carry the accessible label 代码工作台');

  h.ctx.dispose();
  assert.equal(h.slots.entriesOfSlot('main').length, 0, 'dispose must unregister the main panel');
  assert.equal(h.slots.entriesOfSlot('sidebar.panellist').length, 0, 'dispose must unregister the sidebar entry');
  assert.equal(h.styleCount(), 0, 'dispose must remove the injected style');

  h.apply();
  assert.equal(h.slots.entriesOfSlot('main').length, 1, 'second apply must re-register the main panel');
  assert.equal(h.slots.entriesOfSlot('sidebar.panellist').length, 1, 'second apply must re-register the sidebar entry');
  assert.equal(h.styleCount(), 1, 'second apply must inject the style again');
  h.ctx.dispose();
  assert.equal(h.slots.entriesOfSlot('main').length, 0);
  assert.equal(h.slots.entriesOfSlot('sidebar.panellist').length, 0);
  assert.equal(h.styleCount(), 0);
});

// ---------------------------------------------------------------------------
// 3. opening flow and status states
// ---------------------------------------------------------------------------

test('open flow: status -> listSnapshots, then snapshot -> listEntries -> entry -> getEntry', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();

  assert.deepEqual(h.rpc.endpoints(), ['view.status', 'view.listSnapshots']);
  assert.equal(h.nodeByData('data-code-view', 'status').props['data-state'], 'ready');
  assert.ok(h.nodeByData('data-code-view', 'panel'), 'panel root must be present');

  const snapshot = h.nodeByData('data-snapshot-id', SNAPSHOT_ID);
  assert.ok(snapshot, 'snapshot candidate must expose data-snapshot-id');
  assert.equal(snapshot.tag, 'button', 'snapshot candidate must be clickable');
  const snapshotText = h.textOf(snapshot);
  for (const needle of [SNAPSHOT_ID, 'verified', 'fresh', '入口 14', 'failed 0', 'pending 0', 'whole_program_complete false']) {
    assert.ok(snapshotText.includes(needle), `snapshot row must show ${JSON.stringify(needle)}, got: ${snapshotText}`);
  }

  await openSnapshot(h);
  assert.equal(h.rpc.callsFor('view.listEntries').length, 1);
  assert.deepEqual(h.rpc.lastPayload('view.listEntries'), {workspace: 'code-view-bus-demo', snapshot: SNAPSHOT_ID});
  assert.equal(h.nodeByData('data-snapshot-id', SNAPSHOT_ID).props['aria-pressed'], 'true');

  const entryButtons = h.findAll((node) => node.props?.['data-entry-id'] !== undefined);
  assert.deepEqual(
    entryButtons.map((node) => node.props['data-entry-name']),
    ['bus_send', 'store_route'],
    'is_entry rows must sort first',
  );

  h.clickData('data-entry-id', 'f_bus_send');
  await h.settle();
  assert.equal(h.rpc.callsFor('view.getEntry').length, 1);
  assert.deepEqual(h.rpc.lastPayload('view.getEntry'), {
    workspace: 'code-view-bus-demo',
    snapshot: SNAPSHOT_ID,
    entry: 'f_bus_send',
  });
  assert.deepEqual(h.rpc.endpoints(), ['view.status', 'view.listSnapshots', 'view.listEntries', 'view.getEntry']);
  assert.ok(textIncludes(h, 'bus_send'), 'entry detail must render the entry name');
  assert.ok(textIncludes(h, 'bus.c:152'), 'entry detail must render the repository-relative location');
});

test('loading / empty / gap / error states are exposed through data-state', async (t) => {
  // loading: hold view.status open, then resolve.
  const statusDeferred = deferred();
  const loadingHarness = createHarness();
  loadingHarness.rpc.setResponse('view.status', () => statusDeferred.promise);
  loadingHarness.rpc.setResponse('view.listSnapshots', () => makeSnapshotsPayload());
  loadingHarness.rpc.setResponse('view.listEntries', () => makeEntriesPayload());
  loadingHarness.rpc.setResponse('view.getEntry', () => makeEntryPayload());
  t.after(() => loadingHarness.dispose());
  loadingHarness.apply();
  loadingHarness.mountMain();
  assert.equal(loadingHarness.nodeByData('data-code-view', 'status').props['data-state'], 'loading');
  assert.equal(loadingHarness.rpc.callsFor('view.status').length, 1);
  statusDeferred.resolve(makeStatusPayload());
  await loadingHarness.settle();
  assert.equal(loadingHarness.nodeByData('data-code-view', 'status').props['data-state'], 'ready');

  // empty: registered workspace without snapshots.
  const emptyHarness = bootHarness({snapshots: () => makeSnapshotsPayload({workspaces: [makeWorkspace({snapshots: []})]})});
  t.after(() => emptyHarness.dispose());
  await emptyHarness.boot();
  assert.equal(emptyHarness.nodeByData('data-code-view', 'status').props['data-state'], 'empty');
  assert.ok(emptyHarness.findByData('data-gap-code', 'no_snapshot').length > 0, 'empty snapshot list must be a gap');
  assert.ok(textIncludes(emptyHarness, '没有已导入的 Atlas 快照'));

  // gap: python/bootstrap unavailable -> panel stays, state gap, gaps explain why.
  const gapHarness = bootHarness({
    status: () => makeStatusPayload({engine: {python: 'missing', bootstrap: {configured: true, exists: false}}}),
    snapshots: () => failResult('BRIDGE_UNAVAILABLE', 'python engine unavailable'),
  });
  t.after(() => gapHarness.dispose());
  await gapHarness.boot();
  assert.ok(gapHarness.nodeByData('data-code-view', 'panel'), 'missing engine must not hide the panel');
  assert.equal(gapHarness.nodeByData('data-code-view', 'status').props['data-state'], 'gap');
  assert.ok(gapHarness.findByData('data-gap-code', 'engine_python_missing').length > 0);
  assert.ok(gapHarness.findByData('data-gap-code', 'bootstrap_missing').length > 0);
  assert.ok(gapHarness.findByData('data-gap-code', 'readonly_workbench_unavailable').length === 0);

  // error: status request fails with an error code.
  const errorHarness = bootHarness({
    status: () => failResult('ENGINE_BLOCKED', 'engine exit 2'),
    snapshots: () => failResult('ENGINE_BLOCKED', 'engine exit 2'),
  });
  t.after(() => errorHarness.dispose());
  await errorHarness.boot();
  assert.equal(errorHarness.nodeByData('data-code-view', 'status').props['data-state'], 'error');
  const errorNode = errorHarness.nodeByData('data-code-view', 'error');
  assert.ok(errorNode, 'error region must be rendered');
  assert.equal(errorNode.props['data-error-code'], 'ENGINE_BLOCKED');
  assert.ok(errorHarness.textOf(errorNode).includes('ENGINE_BLOCKED'));
});

// ---------------------------------------------------------------------------
// 4. source window and highlighting
// ---------------------------------------------------------------------------

test('entry renders the bounded source window with line numbers and highlighted definition lines', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);

  const source = h.nodeByData('data-code-view', 'source');
  assert.ok(source, 'source region must exist once an entry is open');
  assert.ok(h.textOf(source).includes('bus.c:152'));

  const line152 = h.nodeByData('data-line', '152');
  assert.ok(line152, 'definition line bus.c:152 must be present');
  assert.equal(line152.props['data-highlight'], 'true', 'definition line must carry data-highlight="true"');
  assert.ok(h.textOf(line152).includes('int bus_send(unsigned channel, unsigned length)'));
  assert.equal(h.nodeByData('data-line', '160').props['data-highlight'], 'true');
  assert.equal(h.nodeByData('data-line', '174').props['data-highlight'], 'true');
  assert.equal(h.findByData('data-line', '999').length, 0, 'no fabricated source lines');
  assert.ok(h.findByData('data-evidence-class', 'source_text').length > 0, 'source_text evidence badge must be shown');
});

test('highlight only marks the highlight interval when the window has context lines', async (t) => {
  const entry = makeEntryPayload({
    source: {
      line_start: 150,
      line_end: 176,
      lines: makeSourceLines(150, 176),
      highlight: {line_start: 152, line_end: 174},
    },
  });
  const h = bootHarness({entry: () => entry});
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);

  assert.ok(h.nodeByData('data-line', '150'), 'context line before the highlight must render');
  assert.equal(h.nodeByData('data-line', '150').props['data-highlight'], undefined);
  assert.equal(h.nodeByData('data-line', '152').props['data-highlight'], 'true');
  assert.equal(h.nodeByData('data-line', '174').props['data-highlight'], 'true');
  assert.equal(h.nodeByData('data-line', '176').props['data-highlight'], undefined);
});

// ---------------------------------------------------------------------------
// 5. evidence classification badges
// ---------------------------------------------------------------------------

test('call edges render exact/may/unknown badges with their fixed labels', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);

  for (const expected of ['exact', 'may', 'unknown']) {
    const badges = h.findByData('data-evidence-class', expected);
    assert.ok(badges.length > 0, `missing data-evidence-class="${expected}" badge`);
  }
  const labels = {
    exact: '静态确定',
    may: '候选',
    unknown: '未知',
    source_text: '源码证据',
  };
  for (const [classification, label] of Object.entries(labels)) {
    const badges = h.findByData('data-evidence-class', classification);
    assert.ok(badges.length > 0, `missing ${classification} badge`);
    assert.ok(
      badges.some((badge) => h.textOf(badge).includes(label)),
      `${classification} badge must use label ${label}`,
    );
  }
  // Each call row shows certainty/origin/callsite file:line and evidence ids.
  const exactRow = h.nodeByData('data-callsite-id', 'c_lookup');
  assert.ok(exactRow, 'calls row for c_lookup is missing');
  const exactText = h.textOf(exactRow);
  for (const needle of ['exact', 'deterministic_analysis', 'bus.c:160', 'lookup_route', 'e_call_lookup']) {
    assert.ok(exactText.includes(needle), `call row must show ${JSON.stringify(needle)}, got: ${exactText}`);
  }
  assert.ok(h.rpc.lastPayload('view.getEntry') !== null);
});

test('observed evidence renders the 运行观测 badge and drops the run-observation gap', async (t) => {
  const entry = makeEntryPayload({
    calls: [
      {
        edge_id: 'edge_observed',
        callsite_id: 'c_observed',
        callsite: {file: 'bus.c', line: 163, expression: 'observed_call(channel)'},
        target: {entry_id: 'f_observed', name: 'observed_call', file: 'bus.c', line: 100},
        certainty: 'observed',
        origin: 'trace',
        evidence_ids: ['e_observed'],
        limitations: [],
        observation_refs: ['run_1/event_2'],
      },
    ],
    callers: [],
  });
  const h = bootHarness({entry: () => entry});
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);

  assert.ok(h.findByData('data-evidence-class', 'observed').length > 0, 'observed badge must be shown');
  assert.equal(h.findByData('data-gap-code', 'run_observation').length, 0, 'run observation gap must disappear when observed data exists');
});

// ---------------------------------------------------------------------------
// 6. resource identifiers (preserved, not rendered as a graph)
// ---------------------------------------------------------------------------

test('resources block shows objects and write/read field accesses with certainty badges', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);

  const resources = h.nodeByData('data-code-view', 'resources');
  assert.ok(resources, 'resource identifier region must exist');
  const resourcesText = h.textOf(resources);
  for (const needle of ['资源标识', '状态 partial', 'routes', 'struct Route[4]', 'STATIC', 'bus.c:26']) {
    assert.ok(resourcesText.includes(needle), `resources block must show ${JSON.stringify(needle)}`);
  }

  const object = h.nodeByData('data-resource-id', 's_routes');
  assert.ok(object, 'object row [data-resource-id] is missing');
  assert.ok(h.textOf(object).includes('routes'));

  const write = h.nodeByData('data-field-access', 'field_routes_max_len_write');
  assert.ok(write, 'write field access row is missing');
  assert.equal(write.props['data-access'], 'write');
  assert.equal(write.props['data-certainty'], 'exact');
  const writeText = h.textOf(write);
  for (const needle of ['写', 'write', 'store_route', 'bus.c:46', 'max_len', 'routes[channel].max_len', 'e_write_max_len']) {
    assert.ok(writeText.includes(needle), `write access row must show ${JSON.stringify(needle)}, got: ${writeText}`);
  }

  const read = h.nodeByData('data-field-access', 'field_routes_max_len_read');
  assert.ok(read, 'read field access row is missing');
  assert.equal(read.props['data-access'], 'read');
  assert.equal(read.props['data-certainty'], 'may');
  const readText = h.textOf(read);
  for (const needle of ['读', 'read', '候选', 'bus_send', 'bus.c:161', 'max_len']) {
    assert.ok(readText.includes(needle), `read access row must show ${JSON.stringify(needle)}, got: ${readText}`);
  }
  assert.ok(h.findByData('data-evidence-class', 'exact').length > 0);
  assert.ok(h.findByData('data-evidence-class', 'may').length > 0);

  const selection = selectionJson(h);
  assert.deepEqual(selection.resource_ids, ['s_routes'], 'selection.resource_ids must keep the backend value');
  assert.equal(selection.resource_status, 'partial', 'selection.resource_status must keep the backend value');

  // The coupling view is still an explicit non-available placeholder.
  const coupling = h.nodeByData('data-view', 'coupling');
  assert.ok(coupling);
  assert.equal(coupling.props['data-state'], 'not_available_in_readonly_slice');
  assert.ok(h.textOf(coupling).includes('资源标识'), 'coupling placeholder must reference preserved identifiers');
});

test('unavailable resources keep their reason in the gaps, never an empty "no resources" list', async (t) => {
  const reason = 'resource_layer_not_in_this_atlas_snapshot';
  const hostViewGap = {code: 'resource_graph', status: 'unavailable', reason: 'resource_graph_view_not_in_readonly_slice'};
  const entry = makeEntryPayload({
    resources: {status: 'unavailable', reason, objects: [], field_accesses: [], gaps: [], truncated: false},
    selection: {resource_ids: [], resource_status: 'unavailable'},
    gaps: [],
  });
  const h = bootHarness({
    status: () => makeStatusPayload({gaps: [hostViewGap]}),
    entries: () => makeEntriesPayload({gaps: []}),
    entry: () => entry,
  });
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);

  const resources = h.nodeByData('data-code-view', 'resources');
  assert.ok(resources);
  const resourcesText = h.textOf(resources);
  assert.ok(resourcesText.includes('资源层不可用'), `resources block must state unavailability: ${resourcesText}`);
  assert.ok(resourcesText.includes(reason), 'resources block must show the actual reason');
  assert.equal(h.findByData('data-resource-id', 's_routes').length, 0, 'no fabricated object rows');

  const resourceGaps = h.findByData('data-gap-code', 'resource_graph');
  assert.ok(resourceGaps.length >= 1, 'unavailable resources must add a resource_graph gap');
  assert.ok(
    resourceGaps.some((gap) => h.textOf(gap).includes(reason)),
    'gap must keep the actual resources reason even when the Host already reports a view-level resource_graph gap',
  );
  assert.ok(resourceGaps.some((gap) => h.textOf(gap).includes(hostViewGap.reason)), 'the Host view-level gap reason must be preserved');

  const selection = selectionJson(h);
  assert.deepEqual(selection.resource_ids, []);
  assert.equal(selection.resource_status, 'unavailable');
});

// ---------------------------------------------------------------------------
// 7. gaps, errors and error-code surfacing
// ---------------------------------------------------------------------------

test('gaps region keeps the original code/status/reason and covers resource graph, five views and run observation', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();

  const gaps = h.nodeByData('data-code-view', 'gaps');
  assert.ok(gaps, 'gap region must be rendered');
  assert.ok(h.findByData('data-gap-code', 'scenario_execution').length > 0);
  const fiveViews = h.nodeByData('data-gap-code', 'five_views');
  assert.ok(fiveViews, 'five views gap must be present');
  assert.ok(h.textOf(fiveViews).includes('unavailable'));
  const runObservation = h.nodeByData('data-gap-code', 'run_observation');
  assert.ok(runObservation, 'run observation gap must be present in this slice');
  assert.ok(h.textOf(runObservation).includes('本切片未提供运行观测'));

  await openSnapshot(h);
  const resourceGap = h.nodeByData('data-gap-code', 'resource_graph');
  assert.ok(resourceGap, 'snapshot entry list gaps must surface in the gap region');
  assert.ok(h.textOf(resourceGap).includes('resource_graph_view_not_in_readonly_slice'));

  const serverGap = h.nodeByData('data-gap-code', 'scenario_execution');
  const serverText = h.textOf(serverGap);
  assert.ok(serverText.includes('scenario_execution'));
  assert.ok(serverText.includes('unavailable'));
  assert.ok(serverText.includes('本轮只读切片；场景执行/打桩/回退未实现'), 'server gap reason must be kept verbatim');
});

test('invalid snapshot is listed with its verification error and a gap, without failing the page', async (t) => {
  const invalid = makeWorkspace({
    snapshot: {status: 'invalid', error: {code: 'STALE_SNAPSHOT', message: 'graph hash mismatch'}},
  });
  const h = bootHarness({snapshots: () => makeSnapshotsPayload({workspaces: [invalid]})});
  t.after(() => h.dispose());
  await h.boot();

  const snapshot = h.nodeByData('data-snapshot-id', SNAPSHOT_ID);
  assert.ok(snapshot);
  const snapshotText = h.textOf(snapshot);
  assert.ok(snapshotText.includes('invalid'));
  assert.ok(snapshotText.includes('无效'));
  assert.ok(snapshotText.includes('STALE_SNAPSHOT'));
  const gap = h.nodeByData('data-gap-code', 'STALE_SNAPSHOT');
  assert.ok(gap, 'invalid snapshot must add a gap with its error code');
  assert.ok(h.textOf(gap).includes('graph hash mismatch'));
  assert.equal(h.nodeByData('data-code-view', 'status').props['data-state'], 'ready');
});

test('engine errors show data-error-code + message and never absolute paths or stacks', async (t) => {
  const consoleSpy = captureConsole();
  t.after(() => consoleSpy.restore());
  const badMessage = 'python missing: E:\\secret\\bootstrap.json\n    at runCli (E:\\secret\\engine.js:1:1)\n    at async main';
  const h = bootHarness({
    status: () => failResult('BRIDGE_UNAVAILABLE', badMessage),
    snapshots: () => failResult('BRIDGE_UNAVAILABLE', badMessage),
  });
  t.after(() => h.dispose());
  await h.boot();

  const errorNode = h.nodeByData('data-code-view', 'error');
  assert.ok(errorNode);
  assert.equal(errorNode.props['data-error-code'], 'BRIDGE_UNAVAILABLE');
  const errorText = h.textOf(errorNode);
  assert.ok(errorText.includes('python missing'), `sanitized message must be kept: ${errorText}`);
  assertNoAbsolutePaths(errorText);
  assertNoAbsolutePaths(h.text());
  for (const line of consoleSpy.captured) assertNoAbsolutePaths(line);
});

test('getEntry failure shows the engine error code and keeps the panel usable', async (t) => {
  const h = bootHarness({entry: () => failResult('ENGINE_BLOCKED', 'engine exit 2: blocked by coverage gate')});
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);

  const errors = h.findByData('data-code-view', 'error');
  assert.ok(errors.length > 0, 'getEntry failure must render an error region');
  assert.equal(errors[0].props['data-error-code'], 'ENGINE_BLOCKED');
  assert.ok(h.textOf(errors[0]).includes('blocked by coverage gate'));
  assert.ok(h.nodeByData('data-code-view', 'panel'), 'panel must stay mounted after an entry error');
  assert.ok(h.nodeByData('data-snapshot-id', SNAPSHOT_ID), 'snapshot list must stay usable after an entry error');
});

test('engine CLI error document (success envelope whose value has no top-level ok) surfaces data-error-code', async (t) => {
  // Host shape from lib/view-service.mjs: engine stdout JSON (including the
  // exit-2 error document {schema_version, error:{code,message}}) is passed
  // through verbatim inside {ok:true, value}.
  const engineError = {
    schema_version: 1,
    error: {code: 'STALE_SNAPSHOT', message: 'snapshot hash mismatch', details_ref: null, retryable: false},
    operation_id: null,
  };
  const h = bootHarness({status: () => engineError, snapshots: () => engineError});
  t.after(() => h.dispose());
  await h.boot();

  const errorNode = h.nodeByData('data-code-view', 'error');
  assert.ok(errorNode, 'engine error document must render the error region');
  assert.equal(errorNode.props['data-error-code'], 'STALE_SNAPSHOT');
  assert.ok(h.textOf(errorNode).includes('snapshot hash mismatch'));
  assert.equal(h.nodeByData('data-code-view', 'status').props['data-state'], 'error');
  assertNoAbsolutePaths(h.text());
});

// ---------------------------------------------------------------------------
// 8. return to chat, remembered selection, selection JSON and five views
// ---------------------------------------------------------------------------

test('return-to-chat calls layout.selectPanel(null)', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();

  const button = h.button('返回聊天');
  assert.ok(button, '返回聊天 button must exist');
  assert.ok(h.textOf(button).includes('返回聊天'));
  h.clickButton('返回聊天');
  assert.deepEqual(h.layout.selection, [null]);
});

test('Selection JSON carries every §2 field including the preserved resource fields', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openSnapshot(h);

  const before = selectionJson(h);
  assert.deepEqual(Object.keys(before), [
    'workspace_id',
    'variant_id',
    'snapshot_id',
    'repo_id',
    'entry_id',
    'symbol_id',
    'callsite_ids',
    'callsite_path',
    'resource_ids',
    'resource_status',
    'evidence_ids',
    'run_id',
    'event_id',
  ]);
  assert.equal(before.workspace_id, 'code-view-bus-demo');
  assert.equal(before.variant_id, 'semantic-x86_64');
  assert.equal(before.snapshot_id, SNAPSHOT_ID);
  assert.equal(before.repo_id, 'bus');
  assert.equal(before.entry_id, null);
  assert.equal(before.symbol_id, null);
  assert.deepEqual(before.callsite_ids, []);
  assert.deepEqual(before.callsite_path, []);
  assert.deepEqual(before.resource_ids, []);
  assert.equal(before.resource_status, 'unavailable');
  assert.deepEqual(before.evidence_ids, []);
  assert.equal(before.run_id, null);
  assert.equal(before.event_id, null);

  h.clickData('data-entry-id', 'f_bus_send');
  await h.settle();
  const after = selectionJson(h);
  assert.equal(after.entry_id, 'f_bus_send');
  assert.equal(after.symbol_id, 's_bus_send');
  assert.deepEqual(after.resource_ids, ['s_routes']);
  assert.equal(after.resource_status, 'partial');
  assert.ok(after.evidence_ids.includes('e_call_lookup'));
});

test('five views are explicit placeholders with per-view reasons', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);

  for (const view of ['coupling', 'tree', 'end_to_end', 'sequence', 'file']) {
    const node = h.nodeByData('data-view', view);
    assert.ok(node, `missing five-view placeholder data-view="${view}"`);
    assert.equal(node.props['data-state'], 'not_available_in_readonly_slice');
    assert.ok(h.textOf(node).length > 20, `placeholder ${view} must state a concrete reason`);
  }
});

test('re-opening the panel restores the last snapshot/entry and refetches data', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openEntry(h);

  const first = selectionJson(h);
  assert.equal(first.snapshot_id, SNAPSHOT_ID);
  assert.equal(first.entry_id, 'f_bus_send');
  assert.ok(h.nodeByData('data-line', '152'), 'source must be visible before closing');

  h.unmountMain();
  await h.settle();
  h.remountMain();
  await h.settle();

  assert.equal(h.rpc.callsFor('view.status').length, 2, 're-open must refetch view.status');
  assert.equal(h.rpc.callsFor('view.listSnapshots').length, 2, 're-open must refetch view.listSnapshots');
  assert.equal(h.rpc.callsFor('view.listEntries').length, 2, 're-open must refetch view.listEntries');
  assert.equal(h.rpc.callsFor('view.getEntry').length, 2, 're-open must refetch view.getEntry');

  const restored = selectionJson(h);
  assert.equal(restored.snapshot_id, first.snapshot_id);
  assert.equal(restored.entry_id, first.entry_id);
  assert.deepEqual(restored.resource_ids, first.resource_ids);
  assert.equal(h.nodeByData('data-snapshot-id', SNAPSHOT_ID).props['aria-pressed'], 'true');
  assert.ok(h.nodeByData('data-line', '152'), 'source line must be restored after re-open');
  const entryRow = h.nodeByData('data-entry-id', 'f_bus_send');
  assert.equal(entryRow.props['aria-current'], 'true');
  assert.ok(h.text() !== '', 'panel content must render after re-open');
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
  assert.equal(second.rpc.callsFor('view.listEntries').length, 0, 'a fresh module must not auto-select a snapshot');
  assert.equal(selectionJson(second).snapshot_id, null);
  assert.equal(second.nodeByData('data-code-view', 'status').props['data-state'], 'ready');
});

test('snapshot-only selection keeps RPC payloads within the contract channel and bounds', async (t) => {
  const h = bootHarness();
  t.after(() => h.dispose());
  await h.boot();
  await openSnapshot(h);

  for (const call of h.rpc.calls) {
    assert.equal(call.channel, CHANNEL, 'all client calls must use the /code-view channel');
    assert.equal(typeof call.endpoint, 'string');
    assert.ok(call.endpoint.startsWith('view.'), `unexpected endpoint: ${call.endpoint}`);
    assert.equal(call.payload && typeof call.payload, 'object');
  }
  const listEntries = h.rpc.callsFor('view.listEntries')[0];
  assert.deepEqual(Object.keys(listEntries.payload).sort(), ['snapshot', 'workspace']);
  assert.ok(String(listEntries.payload.workspace).length <= 128);
  assert.ok(String(listEntries.payload.snapshot).length <= 128);
});
