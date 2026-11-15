// TAP test: S2a five-view endpoints on the real pinned rc.5 Cordis runtime.
//
// Runs under the installed Electron embedded Node 24.21.0 via
// tools/verify-five-views.mjs (`ELECTRON_RUN_AS_NODE=1`) against the isolated
// DSH_HOME/profile whose real Python engine already imported the Lead-provided
// Atlas snapshot. Only the Host *services* are doubles (tools/skills/connection/
// webServer); the Cordis Context, loader/fiber lifecycle, the 04 package main
// and the Python engine are real.
//
// Covers (five-view-contract §7.9 + task T8):
//   * six code_* tools still registered; one real Python tool call succeeds,
//   * /code-view route serves the old view.* endpoints and the new
//     view.coupling/tree/endToEnd/fileTree/fileRead/sequence endpoints with
//     real engine payloads (no absolute paths),
//   * dispose unregisters tools + route; second apply re-registers and succeeds.
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import test from 'node:test';
import {pathToFileURL} from 'node:url';

const HOST_ROOT = 'E:/dsh/resources/app.asar/dsh';
const CORDIS_ENTRY = `${HOST_ROOT}/node_modules/@deepseek-ai/cordis/lib/index.js`;
const PLUGIN_ENTRY = new URL('../index.js', import.meta.url).href;
const CHANNEL = '/code-view';
const WORKSPACE_ID = process.env.READONLY_WORKSPACE_ID ?? 'code-view-bus-demo';
const ENTRY_NAME = process.env.READONLY_ENTRY_NAME ?? 'bus_send';
const ENTRY_LINE = Number(process.env.READONLY_ENTRY_LINE ?? '152');
const SNAPSHOT_ID = process.env.READONLY_SNAPSHOT_ID ?? null;
const RUN = process.versions.electron !== undefined && process.versions.node === '24.21.0';
const CODE_TOOLS = ['code_learn', 'code_overview', 'code_path', 'code_snapshot', 'code_source', 'code_workspace'];

function createOwnerPeer() {
  return {id: 'verifier-peer-owner', principal: {kind: 'owner'}, ctx: {}, signal: new AbortController().signal};
}

function createHostDoubles() {
  const tools = new Map();
  const routes = new Map();
  const skillProviders = [];
  const peer = createOwnerPeer();
  const connection = {admit(_req) { return {peer}; }};
  const webServer = {
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate webServer route ${route.path}`);
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
  const toolsService = {
    register(definition) {
      if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
    get(name) { return tools.get(name); },
  };
  const skillsService = {
    registerProvider(factory) {
      skillProviders.push(factory);
      return () => {
        const index = skillProviders.indexOf(factory);
        if (index >= 0) skillProviders.splice(index, 1);
      };
    },
  };
  return {tools, routes, skillProviders, peer, connection, webServer, toolsService, skillsService};
}

async function provideHostServices(ctx, doubles) {
  await ctx.plugin({
    name: 'verifier-host-services-double',
    apply(inner) {
      inner.provide('tools', doubles.toolsService);
      inner.provide('skills', doubles.skillsService);
      inner.provide('connection', doubles.connection);
      inner.provide('webServer', doubles.webServer);
    },
  });
}

function createFakeHttpRequest({endpoint, rawBody, rpcId = 'verifier-rpc-1', payload = {}}) {
  const body = rawBody ?? JSON.stringify({type: 'client-request', rpcId, method: endpoint, payload});
  return {
    method: 'POST',
    url: `${CHANNEL}/${endpoint}`,
    headers: {'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body, 'utf8'))},
    on() { return this; },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body, 'utf8'); },
  };
}

function createFakeHttpResponse() {
  return {
    statusCode: null,
    headers: {},
    body: '',
    finished: false,
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; return this; },
    end(chunk = '') { this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); this.finished = true; return this; },
  };
}

async function invokeRoute(route, {endpoint, payload = {}, rpcId = 'verifier-rpc-1', rawBody} = {}) {
  const req = createFakeHttpRequest({endpoint, payload, rpcId, rawBody});
  const res = createFakeHttpResponse();
  await route.handler(req, res);
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { parsed = null; }
  return {status: res.statusCode, parsed, text: res.body};
}

function absolutePathLeak(text) {
  return /(?:[A-Za-z]:[\\/](?:dsh|Users|Anaconda|plugin)|E:\\\\)/.test(String(text).replace(/\\\\/g, '\\'));
}

async function callEndpoint(route, endpoint, payload) {
  const response = await invokeRoute(route, {endpoint, payload, rpcId: `verifier-${endpoint.replace(/\./g, '-')}`});
  assert.equal(response.status, 200, `${endpoint}: HTTP ${response.status} (${response.text.slice(0, 200)})`);
  assert.equal(response.parsed?.type, 'server-response', `${endpoint}: not a server-response envelope`);
  assert.equal(response.parsed?.result?.ok, true, `${endpoint}: ${JSON.stringify(response.parsed?.result).slice(0, 800)}`);
  assert.equal(absolutePathLeak(response.text), false, `${endpoint}: absolute path leaked`);
  return response.parsed.result.value;
}

test('S2a five-view endpoints run on the real pinned rc.5 Cordis runtime', {skip: !RUN}, async (t) => {
  assert.equal(process.versions.node, '24.21.0');
  assert.equal(process.versions.electron, '44.7.0');
  assert.ok(typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0, 'isolated DSH_HOME missing');
  assert.ok(typeof process.env.CODE_READER_BOOTSTRAP === 'string' && process.env.CODE_READER_BOOTSTRAP.length > 0, 'isolated bootstrap missing');

  const {Context} = await import(pathToFileURL(CORDIS_ENTRY).href);
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); });
  const doubles = createHostDoubles();
  await provideHostServices(ctx, doubles);

  const plugin = await import(PLUGIN_ENTRY);
  assert.equal(plugin.name, 'dsh-code-reader');
  assert.deepEqual(plugin.inject, ['tools', 'skills']);

  // --- first mount ---------------------------------------------------------
  const fiber = ctx.plugin(plugin);
  await fiber;
  assert.equal(doubles.tools.size, 6);
  for (const name of CODE_TOOLS) assert.ok(doubles.tools.has(name), `tool ${name} missing`);
  const route = doubles.routes.get(CHANNEL);
  assert.ok(route !== undefined, `route ${CHANNEL} not registered (routes: ${[...doubles.routes.keys()].join(', ')})`);
  assert.equal(route.kind, 'prefix');

  // Real Python tool call (S1 regression: old tools still work).
  const statusCall = await doubles.tools.get('code_workspace').execute({action: 'status', workspace: WORKSPACE_ID}, {signal: new AbortController().signal});
  assert.equal(statusCall.ok, true, `tool call failed: ${JSON.stringify(statusCall.error ?? statusCall).slice(0, 500)}`);
  assert.equal(statusCall.exit_code, 0);

  // Old endpoints still served.
  const status = await callEndpoint(route, 'view.status', {});
  assert.equal(status.host.panel_key, 'dsh-code-reader');
  assert.equal(status.capabilities.readonly_workbench, true);
  const listed = await callEndpoint(route, 'view.listSnapshots', {});
  const workspace = (listed.workspaces ?? []).find((row) => row.workspace_id === WORKSPACE_ID);
  assert.ok(workspace !== undefined);
  const snapshot = (workspace.snapshots ?? [])[0];
  assert.ok(snapshot !== undefined);
  assert.equal(snapshot.status, 'verified');
  if (SNAPSHOT_ID !== null) assert.equal(snapshot.snapshot_id, SNAPSHOT_ID);
  const snapshotId = snapshot.snapshot_id;
  const entries = await callEndpoint(route, 'view.listEntries', {workspace: WORKSPACE_ID, snapshot: snapshotId});
  const entryRow = (entries.entries ?? []).find((row) => row.name === ENTRY_NAME);
  assert.ok(entryRow !== undefined, `entry ${ENTRY_NAME} missing`);
  assert.equal(entryRow.line, ENTRY_LINE);
  const entryId = entryRow.entry_id;
  const entry = await callEndpoint(route, 'view.getEntry', {workspace: WORKSPACE_ID, snapshot: snapshotId, entry: entryId});
  assert.equal(entry.entry.name, ENTRY_NAME);
  assert.equal(entry.source.status, 'ok');

  // --- new S2a endpoints over the same carrier (real Python) --------------
  const coupling = await callEndpoint(route, 'view.coupling', {workspace: WORKSPACE_ID, snapshot: snapshotId, entry: entryId});
  assert.equal(coupling.schema_version, 1);
  const routesResource = (coupling.resources ?? []).find((resource) => resource.name === 'routes');
  assert.ok(routesResource !== undefined, 'view.coupling: routes resource missing');
  const writeExact = (coupling.resources ?? []).flatMap((resource) => resource.accesses ?? [])
    .filter((access) => access.access === 'write' && access.certainty === 'exact'
      && access.field_name === 'max_len' && access.location?.line === 46);
  assert.ok(writeExact.length > 0, 'view.coupling: write exact max_len@46 missing');
  const readMayLines = new Set((coupling.resources ?? []).flatMap((resource) => resource.accesses ?? [])
    .filter((access) => access.access === 'read' && access.certainty === 'may' && access.field_name === 'max_len')
    .map((access) => access.location?.line));
  for (const line of [92, 93, 98]) assert.ok(readMayLines.has(line), `view.coupling: read may max_len@${line} missing`);
  assert.ok(!absolutePathLeak(JSON.stringify(coupling)), 'view.coupling leaked an absolute path');

  const tree = await callEndpoint(route, 'view.tree', {workspace: WORKSPACE_ID, snapshot: snapshotId, entry: entryId});
  assert.equal(tree.entry.name, ENTRY_NAME);
  const treeText = JSON.stringify(tree.nodes ?? []);
  for (const name of ['lookup_route', 'check_length', 'dispatch_transfer']) {
    assert.ok(treeText.includes(name), `view.tree: node ${name} missing`);
  }
  const checkLengthNode = (tree.nodes ?? []).find((node) => node.symbol?.name === 'check_length');
  assert.ok(checkLengthNode !== undefined, 'view.tree: check_length node missing');
  assert.ok(Array.isArray(checkLengthNode.guards) && checkLengthNode.guards.length > 0, 'view.tree: check_length guards missing');
  assert.ok(checkLengthNode.guards[0].expression.includes('check_length'), 'view.tree: guard expression missing');
  assert.ok(!absolutePathLeak(JSON.stringify(tree)), 'view.tree leaked an absolute path');

  const endToEnd = await callEndpoint(route, 'view.endToEnd', {workspace: WORKSPACE_ID, snapshot: snapshotId, entry: entryId});
  assert.ok((endToEnd.nodes ?? []).some((node) => node.kind === 'entry' && node.label === ENTRY_NAME), 'view.endToEnd: entry node missing');
  assert.ok((endToEnd.nodes ?? []).some((node) => node.kind === 'decision'), 'view.endToEnd: decision node missing');
  assert.ok((endToEnd.exits ?? []).some((exit) => exit.role === 'error' && String(exit.expression).includes('-90')), 'view.endToEnd: error exit -90 missing');
  assert.ok((endToEnd.nodes ?? []).some((node) => node.kind === 'external' && String(node.label).includes('platform_write')), 'view.endToEnd: external platform_write missing');
  assert.ok((endToEnd.edges ?? []).some((edge) => edge.kind === 'external' && /platform_write/.test(JSON.stringify(edge))), 'view.endToEnd: external edge missing');
  assert.deepEqual((endToEnd.legend ?? []).map((row) => row.key), ['exact', 'may', 'unknown', 'error', 'boundary']);
  assert.equal(endToEnd.layout?.direction, 'DOWN');
  assert.equal(endToEnd.layout?.edge_routing, 'ORTHOGONAL');
  assert.ok(!absolutePathLeak(JSON.stringify(endToEnd)), 'view.endToEnd leaked an absolute path');

  const fileTree = await callEndpoint(route, 'view.fileTree', {workspace: WORKSPACE_ID, snapshot: snapshotId});
  const busRepo = (fileTree.repos ?? []).find((repo) => repo.repo_id === 'bus');
  assert.ok(busRepo !== undefined, 'view.fileTree: bus repo missing');
  assert.ok((busRepo.files ?? []).some((file) => file.path === 'bus.c' && file.has_evidence === true), 'view.fileTree: bus.c missing');
  assert.ok(!absolutePathLeak(JSON.stringify(fileTree)), 'view.fileTree leaked an absolute path');

  const fileRead = await callEndpoint(route, 'view.fileRead', {workspace: WORKSPACE_ID, snapshot: snapshotId, repo: 'bus', path: 'bus.c'});
  assert.equal(fileRead.path, 'bus.c');
  assert.equal(fileRead.total_lines, 174);
  assert.ok(Array.isArray(fileRead.lines) && fileRead.lines.length === 174, 'view.fileRead: expected 174 lines');
  assert.ok(fileRead.lines.some((line) => line.n === 46 && /max_len/.test(line.text)), 'view.fileRead: line 46 max_len missing');
  assert.ok(!absolutePathLeak(JSON.stringify(fileRead)), 'view.fileRead leaked an absolute path');

  const sequence = await callEndpoint(route, 'view.sequence', {workspace: WORKSPACE_ID, snapshot: snapshotId, entry: entryId, mode: 'static'});
  assert.equal(sequence.mode, 'static');
  assert.equal(sequence.observed, false);
  assert.ok(/静态预测/.test(sequence.warning ?? ''), 'view.sequence: static warning missing');
  const sequenceText = JSON.stringify(sequence.messages ?? []);
  for (const label of [ENTRY_NAME, 'lookup_route', 'check_length', 'platform_write']) {
    assert.ok(sequenceText.includes(label), `view.sequence: message ${label} missing`);
  }
  assert.ok(!absolutePathLeak(JSON.stringify(sequence)), 'view.sequence leaked an absolute path');

  // Bad input is rejected with the stable INVALID_ARGUMENT code.
  const invalid = await invokeRoute(route, {endpoint: 'view.fileRead', payload: {workspace: WORKSPACE_ID, snapshot: snapshotId, repo: 'bus', path: '../etc/passwd'}, rpcId: 'verifier-invalid'});
  assert.equal(invalid.parsed?.result?.ok, false);
  assert.equal(invalid.parsed?.result?.error?.code, 'INVALID_ARGUMENT');

  // --- dispose / remount ---------------------------------------------------
  await fiber.dispose();
  assert.equal(doubles.tools.size, 0, `tools survived dispose: ${[...doubles.tools.keys()].join(', ')}`);
  assert.equal(doubles.routes.size, 0, `routes survived dispose: ${[...doubles.routes.keys()].join(', ')}`);

  const fiber2 = ctx.plugin(plugin);
  await fiber2;
  assert.equal(doubles.tools.size, 6);
  const route2 = doubles.routes.get(CHANNEL);
  assert.ok(route2 !== undefined, 'route missing after second mount');
  const coupling2 = await callEndpoint(route2, 'view.coupling', {workspace: WORKSPACE_ID, snapshot: snapshotId, entry: entryId});
  assert.ok((coupling2.resources ?? []).some((resource) => resource.name === 'routes'), 'second mount: view.coupling failed');
  const status2 = await callEndpoint(route2, 'view.status', {});
  assert.equal(status2.host.panel_key, 'dsh-code-reader');
  await fiber2.dispose();
  assert.equal(doubles.tools.size, 0);
  assert.equal(doubles.routes.size, 0);
});
