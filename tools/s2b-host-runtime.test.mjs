// TAP test: S2b endpoint surface on the real pinned rc.5 Cordis runtime.
//
// Runs under the installed Electron embedded Node 24.21.0 via
// tools/verify-s2b.mjs (`ELECTRON_RUN_AS_NODE=1`) against the isolated
// DSH_HOME/profile whose real Python engine imported the Lead-provided Atlas
// snapshot. Only Host services are doubles (tools/skills/connection/webServer);
// the Cordis Context, loader/fiber lifecycle, the 04 package main and the
// Python engine are real.
//
// Covers (five-view-contract §10.5 + S2b ownership):
//   * six code_* tools registered; one real Python tool call succeeds,
//   * old view.* and S2a five-view endpoints still served,
//   * S2b: view.endToEnd groups (>=2, dispatch_transfer/commit_transfer labels),
//     view.interfaces candidates (platform_write cross_file/side_effects, >=2
//     independent, all certainty may), optional endToEnd root -> breadcrumb,
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
  return /(?:[A-Za-z]:[\\/](?:dsh|Users|Anaconda|plugin))/.test(String(text).replace(/\\\\/g, '\\'));
}

async function callEndpoint(route, endpoint, payload) {
  const response = await invokeRoute(route, {endpoint, payload, rpcId: `verifier-${endpoint.replace(/\./g, '-')}`});
  assert.equal(response.status, 200, `${endpoint}: HTTP ${response.status} (${response.text.slice(0, 200)})`);
  assert.equal(response.parsed?.type, 'server-response', `${endpoint}: not a server-response envelope`);
  assert.equal(response.parsed?.result?.ok, true, `${endpoint}: ${JSON.stringify(response.parsed?.result).slice(0, 800)}`);
  assert.equal(absolutePathLeak(response.text), false, `${endpoint}: absolute path leaked`);
  return response.parsed.result.value;
}

test('S2b groups/interfaces/subflow endpoints run on the real pinned rc.5 Cordis runtime', {skip: !RUN}, async (t) => {
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
  assert.ok(route !== undefined, `route ${CHANNEL} not registered`);
  assert.equal(route.kind, 'prefix');

  const statusCall = await doubles.tools.get('code_workspace').execute({action: 'status', workspace: WORKSPACE_ID}, {signal: new AbortController().signal});
  assert.equal(statusCall.ok, true, `tool call failed: ${JSON.stringify(statusCall.error ?? statusCall).slice(0, 500)}`);

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
  const entryId = entryRow.entry_id;

  // Old + S2a endpoint surface remains served.
  const status = await callEndpoint(route, 'view.status', {});
  assert.equal(status.host.panel_key, 'dsh-code-reader');
  const entry = await callEndpoint(route, 'view.getEntry', {workspace: WORKSPACE_ID, snapshot: snapshotId, entry: entryId});
  assert.equal(entry.entry.name, ENTRY_NAME);
  const coupling = await callEndpoint(route, 'view.coupling', {workspace: WORKSPACE_ID, snapshot: snapshotId, entry: entryId});
  assert.ok((coupling.resources ?? []).some((resource) => resource.name === 'routes'));

  // --- S2b: endToEnd groups ------------------------------------------------
  const endToEnd = await callEndpoint(route, 'view.endToEnd', {workspace: WORKSPACE_ID, snapshot: snapshotId, entry: entryId});
  const groups = endToEnd.groups ?? [];
  assert.ok(Array.isArray(groups) && groups.length >= 2, `view.endToEnd: expected >=2 groups, got ${groups.length}`);
  const groupLabels = groups.map((group) => String(group.label ?? ''));
  assert.ok(groupLabels.some((label) => label.includes('dispatch_transfer')), `view.endToEnd: dispatch_transfer group missing (${groupLabels.join(', ')})`);
  assert.ok(groupLabels.some((label) => label.includes('commit_transfer')), `view.endToEnd: commit_transfer group missing (${groupLabels.join(', ')})`);
  for (const group of groups) {
    assert.ok(typeof group.group_id === 'string' && group.group_id.startsWith('group:'), 'group_id shape');
    assert.ok(Array.isArray(group.member_node_ids) && group.member_node_ids.length >= 2, 'group members');
    assert.ok(Array.isArray(group.limitations) && group.limitations.length > 0, 'group limitations');
  }
  assert.ok(endToEnd.grouping !== undefined && endToEnd.grouping.groups === groups.length, 'grouping summary');
  assert.equal(endToEnd.grouping.algorithm, 'private_callee_subflow');
  // Edges are not merged: the S2a edge count/id set stays intact.
  assert.ok((endToEnd.edges ?? []).length >= 31, 'endToEnd edges unexpectedly reduced');

  // --- S2b: interface library ---------------------------------------------
  const interfaces = await callEndpoint(route, 'view.interfaces', {workspace: WORKSPACE_ID, snapshot: snapshotId, entry: entryId});
  const candidates = interfaces.candidates ?? [];
  assert.ok(candidates.length > 0, 'view.interfaces: no candidates');
  const platformWrite = candidates.find((candidate) => candidate.name === 'platform_write');
  assert.ok(platformWrite !== undefined, 'view.interfaces: platform_write candidate missing');
  assert.equal(platformWrite.cross_file, true);
  assert.ok((platformWrite.field_accesses ?? []).some((access) => access.access === 'write'), 'platform_write side effects missing');
  assert.ok(Array.isArray(platformWrite.reasons) && platformWrite.reasons.length > 0, 'platform_write reasons missing');
  assert.ok(Array.isArray(platformWrite.parameters) && platformWrite.parameters.length === 2, 'platform_write parameters missing');
  assert.equal(typeof platformWrite.return_type, 'string');
  const independent = candidates.filter((candidate) => candidate.decoupling === 'independent');
  assert.ok(independent.length >= 2, `view.interfaces: expected >=2 independent candidates, got ${independent.length}`);
  for (const candidate of candidates) {
    assert.equal(candidate.certainty, 'may', `candidate ${candidate.name} certainty must stay may`);
  }

  // --- S2b: subflow root + breadcrumb -------------------------------------
  const checkLengthRow = (entries.entries ?? []).find((row) => row.name === 'check_length');
  assert.ok(checkLengthRow !== undefined, 'check_length entry missing');
  let subflow = null;
  for (const payload of [
    {workspace: WORKSPACE_ID, snapshot: snapshotId, entry: checkLengthRow.entry_id, root: entryId},
    {workspace: WORKSPACE_ID, snapshot: snapshotId, entry: checkLengthRow.entry_id, root: entryId, mode: 'subflow'},
  ]) {
    try {
      subflow = await callEndpoint(route, 'view.endToEnd', payload);
      break;
    } catch {
      subflow = null;
    }
  }
  assert.ok(subflow !== null, 'view.endToEnd with root: endpoint rejected the subflow request');
  assert.ok(Array.isArray(subflow.breadcrumb) && subflow.breadcrumb.length >= 2, 'view.endToEnd: breadcrumb missing');
  const breadcrumbNames = subflow.breadcrumb.map((crumb) => crumb.name);
  assert.ok(breadcrumbNames.includes(ENTRY_NAME), `breadcrumb root ${ENTRY_NAME} missing (${breadcrumbNames.join(' -> ')})`);
  assert.ok(breadcrumbNames.includes('check_length'), `breadcrumb entry check_length missing (${breadcrumbNames.join(' -> ')})`);

  // --- dispose / remount ---------------------------------------------------
  await fiber.dispose();
  assert.equal(doubles.tools.size, 0, `tools survived dispose: ${[...doubles.tools.keys()].join(', ')}`);
  assert.equal(doubles.routes.size, 0);

  const fiber2 = ctx.plugin(plugin);
  await fiber2;
  assert.equal(doubles.tools.size, 6);
  const route2 = doubles.routes.get(CHANNEL);
  assert.ok(route2 !== undefined, 'route missing after second mount');
  const groups2 = await callEndpoint(route2, 'view.endToEnd', {workspace: WORKSPACE_ID, snapshot: snapshotId, entry: entryId});
  assert.ok((groups2.groups ?? []).length >= 2, 'second mount: groups missing');
  const interfaces2 = await callEndpoint(route2, 'view.interfaces', {workspace: WORKSPACE_ID, snapshot: snapshotId, entry: entryId});
  assert.ok((interfaces2.candidates ?? []).some((candidate) => candidate.name === 'platform_write'), 'second mount: interfaces missing');
  await fiber2.dispose();
  assert.equal(doubles.tools.size, 0);
  assert.equal(doubles.routes.size, 0);
});
