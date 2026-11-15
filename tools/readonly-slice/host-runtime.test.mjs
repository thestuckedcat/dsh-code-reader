// TAP test: the 04 plugin mounted into the *real* pinned rc.5 Cordis runtime.
//
// Runs under the installed Electron's embedded Node 24.21.0 through
// tools/verify-host-runtime.mjs (`ELECTRON_RUN_AS_NODE=1`), which first builds
// the isolated DSH_HOME/profile + imports the Atlas snapshot with the real
// Python engine. The test provides only the Host *services* as doubles
// (tools/skills/connection/webServer); the Cordis Context, loader/fiber
// lifecycle and our package main are the real ones.
//
// It proves, end to end:
//   * real Context mount of the 04 package main,
//   * six code_* tools registered, one real Python engine call succeeds,
//   * the /code-view route is registered on the webServer seam with the
//     client-request/server-response envelope, admission fail-closed and the
//     read-model endpoints reaching the real Python engine,
//   * dispose unregisters tools + route; a second apply re-registers and the
//     engine call succeeds again (rc.5 load → unload → load).
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import test from 'node:test';
import {pathToFileURL} from 'node:url';

const HOST_ROOT = 'E:/dsh/resources/app.asar/dsh';
const CORDIS_ENTRY = `${HOST_ROOT}/node_modules/@deepseek-ai/cordis/lib/index.js`;
const PLUGIN_ENTRY = new URL('../../index.js', import.meta.url).href;
const CHANNEL = '/code-view';
const WORKSPACE_ID = process.env.READONLY_WORKSPACE_ID ?? 'code-view-bus-demo';
const EXPECTED_ENTRY = process.env.READONLY_ENTRY_NAME ?? 'bus_send';
const EXPECTED_LINE = Number(process.env.READONLY_ENTRY_LINE ?? '152');
const EXPECTED_SNAPSHOT_ID = process.env.READONLY_SNAPSHOT_ID ?? null;
const RUN = process.versions.electron !== undefined && process.versions.node === '24.21.0';
const CODE_TOOLS = ['code_learn', 'code_overview', 'code_path', 'code_snapshot', 'code_source', 'code_workspace'];

export function createOwnerPeer() {
  return {
    id: 'verifier-peer-owner',
    principal: {kind: 'owner'},
    ctx: {},
    signal: new AbortController().signal,
  };
}

/** Recording doubles for the four Host services the package touches. */
function createHostDoubles() {
  const tools = new Map();
  const routes = new Map();
  const skillProviders = [];
  const peer = createOwnerPeer();
  const connection = {
    admit(_req) {
      return {peer};
    },
  };
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
    get(name) {
      return tools.get(name);
    },
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

/** Mount the four services as a sibling plugin so the package's inject resolves. */
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

function createFakeHttpRequest({endpoint, method = 'POST', rawBody, rpcId = 'verifier-rpc-1', payload = {}}) {
  const body = rawBody ?? JSON.stringify({type: 'client-request', rpcId, method: endpoint, payload});
  return {
    method,
    url: `${CHANNEL}/${endpoint}`,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body, 'utf8')),
    },
    on() {
      return this;
    },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body, 'utf8');
    },
  };
}

function createFakeHttpResponse() {
  return {
    statusCode: null,
    headers: {},
    body: '',
    finished: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
      return this;
    },
    end(chunk = '') {
      this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      this.finished = true;
      return this;
    },
  };
}

/** Invoke the registered route like the real Host would. */
async function invokeRoute(route, {endpoint, payload = {}, rpcId = 'verifier-rpc-1', rawBody, method = 'POST', reqOverride = {}} = {}) {
  const req = {...createFakeHttpRequest({endpoint, rawBody, rpcId, payload, method}), ...reqOverride};
  const res = createFakeHttpResponse();
  await route.handler(req, res);
  let parsed = null;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = null;
  }
  return {status: res.statusCode, text: res.body, parsed};
}

function engineToolCall(tool, args) {
  return tool.execute(args, {signal: new AbortController().signal});
}

test('04 plugin mounts into the real pinned rc.5 Cordis, serves /code-view, disposes and re-mounts', {skip: !RUN}, async (t) => {
  assert.equal(process.versions.node, '24.21.0');
  assert.equal(process.versions.electron, '44.7.0');
  assert.ok(typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0, 'DSH_HOME must point at the isolated home');
  assert.ok(typeof process.env.CODE_READER_BOOTSTRAP === 'string' && process.env.CODE_READER_BOOTSTRAP.length > 0, 'CODE_READER_BOOTSTRAP must point at the isolated bootstrap');

  const {Context} = await import(pathToFileURL(CORDIS_ENTRY).href);
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
  });
  const doubles = createHostDoubles();
  await provideHostServices(ctx, doubles);

  const plugin = await import(PLUGIN_ENTRY);
  assert.equal(plugin.name, 'dsh-code-reader');
  assert.deepEqual(plugin.inject, ['tools', 'skills']);
  assert.equal(typeof plugin.apply, 'function');

  // --- first mount ---------------------------------------------------------
  const fiber = ctx.plugin(plugin);
  await fiber;
  assert.equal(doubles.tools.size, 6, `registered tools: ${[...doubles.tools.keys()].join(', ')}`);
  for (const name of CODE_TOOLS) assert.ok(doubles.tools.has(name), `tool ${name} is not registered`);
  const workspaceTool = doubles.tools.get('code_workspace');
  assert.equal(typeof workspaceTool.execute, 'function');
  assert.equal(typeof workspaceTool.output.render, 'function');

  // One real Python-engine tool call.
  const statusCall = await engineToolCall(workspaceTool, {action: 'status', workspace: WORKSPACE_ID});
  assert.equal(statusCall.ok, true, `tool call failed: ${JSON.stringify(statusCall.error ?? statusCall).slice(0, 500)}`);
  assert.equal(statusCall.exit_code, 0);
  assert.equal(statusCall.cli?.workspace_id, WORKSPACE_ID);
  assert.equal(typeof statusCall.cli?.workspace_revision, 'number');

  // The UI route is mounted with the frozen prefix/channel.
  const route = doubles.routes.get(CHANNEL);
  assert.ok(route !== undefined, `route ${CHANNEL} is not registered (routes: ${[...doubles.routes.keys()].join(', ')})`);
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, CHANNEL);

  // view.status over the real carrier: host facts + gaps, no engine start.
  const statusResponse = await invokeRoute(route, {endpoint: 'view.status', payload: {}, rpcId: 'verifier-status-1'});
  assert.equal(statusResponse.status, 200);
  assert.equal(statusResponse.parsed?.type, 'server-response');
  assert.equal(statusResponse.parsed?.rpcId, 'verifier-status-1');
  assert.equal(statusResponse.parsed?.result?.ok, true, JSON.stringify(statusResponse.parsed).slice(0, 600));
  assert.equal(statusResponse.parsed?.result?.value?.host?.panel_key, 'dsh-code-reader');
  assert.equal(statusResponse.parsed?.result?.value?.host?.rpc_channel, CHANNEL);
  assert.equal(statusResponse.parsed?.result?.value?.capabilities?.readonly_workbench, true);
  assert.equal(statusResponse.parsed?.result?.value?.engine?.python, 'available');
  assert.equal(statusResponse.parsed?.result?.value?.engine?.bootstrap?.exists, true);

  // Admission is fail-closed before any body/envelope work.
  const savedAdmit = doubles.connection.admit;
  doubles.connection.admit = () => ({rejection: 401});
  const denied = await invokeRoute(route, {endpoint: 'view.status', payload: {}, rpcId: 'verifier-denied-1'});
  doubles.connection.admit = savedAdmit;
  assert.equal(denied.status, 401, `admission rejection produced status ${denied.status} (${denied.text.slice(0, 120)})`);

  // A malformed envelope is answered with the fixed gateway/bad-request.
  const badEnvelope = await invokeRoute(route, {endpoint: 'view.status', rawBody: '{"type":"not-a-client-request"}', rpcId: 'verifier-bad-1'});
  assert.equal(badEnvelope.status, 200);
  assert.equal(badEnvelope.parsed?.result?.ok, false);
  assert.equal(badEnvelope.parsed?.result?.error?.code, 'gateway/bad-request');

  // Real Python read-model through the carrier: snapshots list.
  const snapshots = await invokeRoute(route, {endpoint: 'view.listSnapshots', payload: {}, rpcId: 'verifier-snap-1'});
  assert.equal(snapshots.status, 200);
  assert.equal(snapshots.parsed?.result?.ok, true, JSON.stringify(snapshots.parsed).slice(0, 800));
  const workspace = (snapshots.parsed?.result?.value?.workspaces ?? []).find((row) => row.workspace_id === WORKSPACE_ID);
  assert.ok(workspace !== undefined, 'registered workspace missing from view.listSnapshots');
  const snapshot = (workspace.snapshots ?? [])[0];
  assert.ok(snapshot !== undefined, 'imported snapshot missing from view.listSnapshots');
  assert.equal(snapshot.status, 'verified');
  assert.equal(snapshot.freshness, 'fresh');
  assert.ok(snapshot.entry_count > 0);
  if (EXPECTED_SNAPSHOT_ID !== null) assert.equal(snapshot.snapshot_id, EXPECTED_SNAPSHOT_ID);
  assert.ok(!JSON.stringify(snapshots.parsed).includes(process.env.DSH_HOME), 'RPC payload leaked an isolated-home absolute path');

  const entries = await invokeRoute(route, {
    endpoint: 'view.listEntries',
    payload: {workspace: WORKSPACE_ID, snapshot: snapshot.snapshot_id},
    rpcId: 'verifier-entries-1',
  });
  assert.equal(entries.parsed?.result?.ok, true, JSON.stringify(entries.parsed).slice(0, 800));
  const entryRow = (entries.parsed?.result?.value?.entries ?? []).find((row) => row.name === EXPECTED_ENTRY);
  assert.ok(entryRow !== undefined, `entry ${EXPECTED_ENTRY} missing from view.listEntries`);
  assert.equal(entryRow.file, 'bus.c');
  assert.equal(entryRow.line, EXPECTED_LINE);

  const entryDetail = await invokeRoute(route, {
    endpoint: 'view.getEntry',
    payload: {workspace: WORKSPACE_ID, snapshot: snapshot.snapshot_id, entry: entryRow.entry_id},
    rpcId: 'verifier-entry-1',
  });
  assert.equal(entryDetail.parsed?.result?.ok, true, JSON.stringify(entryDetail.parsed).slice(0, 1200));
  const value = entryDetail.parsed?.result?.value;
  assert.equal(value?.entry?.name, EXPECTED_ENTRY);
  assert.equal(value?.source?.status, 'ok');
  const sourceLine = (value?.source?.lines ?? []).find((row) => row.n === EXPECTED_LINE);
  assert.ok(sourceLine !== undefined, `source line ${EXPECTED_LINE} missing from view.getEntry`);
  assert.ok(sourceLine.text.includes(EXPECTED_ENTRY), `source line text ${JSON.stringify(sourceLine.text)} does not contain ${EXPECTED_ENTRY}`);
  assert.ok(Array.isArray(value?.calls) && value.calls.length > 0, 'view.getEntry returned no call edges');
  assert.ok(value.calls.some((call) => call.certainty === 'exact'), 'view.getEntry returned no exact call edge');
  assert.ok(!JSON.stringify(value).includes('E:\\\\') && !JSON.stringify(value).includes('E:/'), 'view.getEntry leaked an absolute path');

  const invalidInput = await invokeRoute(route, {
    endpoint: 'view.getEntry',
    payload: {workspace: 'NOT A WORKSPACE', snapshot: snapshot.snapshot_id, entry: entryRow.entry_id},
    rpcId: 'verifier-invalid-1',
  });
  assert.equal(invalidInput.parsed?.result?.ok, false);
  assert.equal(invalidInput.parsed?.result?.error?.code, 'INVALID_ARGUMENT');

  // --- dispose -------------------------------------------------------------
  await fiber.dispose();
  assert.equal(doubles.tools.size, 0, `tools survived dispose: ${[...doubles.tools.keys()].join(', ')}`);
  assert.equal(doubles.routes.size, 0, `routes survived dispose: ${[...doubles.routes.keys()].join(', ')}`);

  // --- second mount (rc.5 load → unload → load) ----------------------------
  const fiber2 = ctx.plugin(plugin);
  await fiber2;
  assert.equal(doubles.tools.size, 6);
  const route2 = doubles.routes.get(CHANNEL);
  assert.ok(route2 !== undefined, 'route missing after second mount');
  const statusCall2 = await engineToolCall(doubles.tools.get('code_workspace'), {action: 'status', workspace: WORKSPACE_ID});
  assert.equal(statusCall2.ok, true, `second mount tool call failed: ${JSON.stringify(statusCall2.error ?? statusCall2).slice(0, 500)}`);
  assert.equal(statusCall2.exit_code, 0);
  const statusResponse2 = await invokeRoute(route2, {endpoint: 'view.status', payload: {}, rpcId: 'verifier-status-2'});
  assert.equal(statusResponse2.parsed?.result?.ok, true);
  assert.equal(statusResponse2.parsed?.result?.value?.host?.panel_key, 'dsh-code-reader');
  await fiber2.dispose();
  assert.equal(doubles.tools.size, 0);
  assert.equal(doubles.routes.size, 0);
});
