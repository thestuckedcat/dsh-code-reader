// TAP test: S4-prep AI summary surface on the real pinned rc.5 Cordis runtime.
//
// Mounts the real 04 plugin in the isolated profile, then:
//   * asserts the Agent tool `code_summary` is registered (plus the existing
//     code_* tools) and the /code-view prefix route exists;
//   * invokes code_summary put/get through the real tool handler -> real bridge
//     -> real Python engine (signed summary cache in the isolated state);
//   * rejects an invalid put (over-long text) and keeps the stored summary;
//   * writes/reads a group subject;
//   * dispose -> remount -> get still returns the cached summary (state is in
//     the isolated home, not process memory) and put/get work again.
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import test from 'node:test';
import {pathToFileURL} from 'node:url';

const HOST_ROOT = 'E:/dsh/resources/app.asar/dsh';
const CORDIS_ENTRY = `${HOST_ROOT}/node_modules/@deepseek-ai/cordis/lib/index.js`;
const PLUGIN_ENTRY = new URL('../index.js', import.meta.url).href;
const CHANNEL = '/code-view';
const WORKSPACE_ID = process.env.READONLY_WORKSPACE_ID ?? 'code-view-bus-demo';
const RUN = process.versions.electron !== undefined && process.versions.node === '24.21.0';
const BASE_TOOLS = ['code_learn', 'code_overview', 'code_path', 'code_snapshot', 'code_source', 'code_workspace'];
const SUMMARY_TEXT = 'bus_send 先校验通道与长度，再查路由表；长度上限取 route->max_len，超长返回 -22。'
  + '该归纳基于静态结构与源码文本，未包含运行观测。';

function createHostDoubles() {
  const tools = new Map();
  const routes = new Map();
  const skillProviders = [];
  const peer = {id: 'verifier-peer-owner', principal: {kind: 'owner'}, ctx: {}, signal: new AbortController().signal};
  const connection = {admit() { return {peer}; }};
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
  return {tools, routes, connection, webServer, toolsService, skillsService, peer};
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

function createFakeHttpRequest({endpoint, payload = {}, rpcId = 'verifier-summary-rpc'}) {
  const body = JSON.stringify({type: 'client-request', rpcId, method: endpoint, payload});
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
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; return this; },
    end(chunk = '') { this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); return this; },
  };
}

async function invokeRoute(route, {endpoint, payload = {}, rpcId = 'verifier-summary-rpc'}) {
  const res = createFakeHttpResponse();
  await route.handler(createFakeHttpRequest({endpoint, payload, rpcId}), res);
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { parsed = null; }
  return {status: res.statusCode, parsed, text: res.body};
}

async function callEndpoint(route, endpoint, payload) {
  const response = await invokeRoute(route, {endpoint, payload, rpcId: `verifier-${endpoint.replace(/\./g, '-')}`});
  assert.equal(response.status, 200, `${endpoint}: HTTP ${response.status} (${response.text.slice(0, 300)})`);
  assert.equal(response.parsed?.type, 'server-response');
  assert.equal(response.parsed?.result?.ok, true, `${endpoint}: ${JSON.stringify(response.parsed?.result).slice(0, 800)}`);
  assert.equal(/(?:[A-Za-z]:[\\/](?:dsh|Users|Anaconda|plugin))/.test(response.text), false, `${endpoint}: absolute path leaked`);
  return response.parsed.result.value;
}

async function callTool(tools, name, args) {
  const definition = tools.get(name);
  assert.ok(definition !== undefined, `tool ${name} missing`);
  try {
    const value = await definition.execute(args, {signal: new AbortController().signal});
    return {ok: true, value};
  } catch (error) {
    return {ok: false, error: String(error?.message ?? error), code: error?.code ?? null};
  }
}

test('S4-prep code_summary tool registers and performs real put/get on the pinned rc.5 Cordis', {skip: !RUN}, async (t) => {
  assert.equal(process.versions.node, '24.21.0');
  assert.equal(process.versions.electron, '44.7.0');
  const {Context} = await import(pathToFileURL(CORDIS_ENTRY).href);
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); });
  const doubles = createHostDoubles();
  await provideHostServices(ctx, doubles);
  const plugin = await import(PLUGIN_ENTRY);
  const fiber = ctx.plugin(plugin);
  await fiber;
  for (const name of BASE_TOOLS) assert.ok(doubles.tools.has(name), `tool ${name} missing`);
  assert.ok(doubles.tools.has('code_summary'), 'code_summary tool missing');
  assert.ok(doubles.routes.has(CHANNEL), 'code-view route missing');
  const route = doubles.routes.get(CHANNEL);
  assert.ok(route !== undefined);

  const listed = await callEndpoint(route, 'view.listSnapshots', {});
  const workspace = (listed.workspaces ?? []).find((row) => row.workspace_id === WORKSPACE_ID);
  assert.ok(workspace !== undefined, 'workspace missing');
  const snapshot = (workspace.snapshots ?? [])[0];
  assert.ok(snapshot !== undefined, 'snapshot missing');
  const snapshotId = snapshot.snapshot_id;

  // Engine RPC read before any put: summary list + ai_summary gap, no error.
  const before = await callEndpoint(route, 'view.summary', {workspace: WORKSPACE_ID, snapshot: snapshotId});
  assert.ok(Array.isArray(before.summaries), 'view.summary summaries must be an array');
  // The real dsh-web summary flow may have already written a summary before this
  // Cordis runtime test runs (same isolated state); the gap is only required when
  // the cache is still empty.
  const hadSummary = (before.summaries ?? []).length > 0;
  if (!hadSummary) assert.ok((before.gaps ?? []).some((gap) => (gap.code ?? gap) === 'ai_summary_not_generated'), 'summary gap missing before write');

  // Agent tool put (real handler -> bridge -> engine summary-put).
  const facts = [{kind: 'evidence', ref: 'e_231505a73a485bc1d8c9249d'}];
  const put = await callTool(doubles.tools, 'code_summary', {
    action: 'put', workspace: WORKSPACE_ID, snapshot: snapshotId,
    subject_type: 'function', subject_id: 'f_afa8298f2d197e5fd110e49a',
    text: SUMMARY_TEXT, facts,
    generator: {kind: 'agent', ref: 'verify-summary'},
    inference_labels: ['from_static_structure'],
  });
  assert.equal(put.ok, true, `code_summary put failed: ${put.error ?? ''}`);
  const putCli = put.value?.cli ?? put.value ?? {};
  const projection = putCli.summary ?? putCli;
  assert.equal(projection?.text, SUMMARY_TEXT);
  assert.equal(projection?.stale, false);

  const get = await callTool(doubles.tools, 'code_summary', {
    action: 'get', workspace: WORKSPACE_ID, snapshot: snapshotId,
    subject_type: 'function', subject_id: 'f_afa8298f2d197e5fd110e49a',
  });
  assert.equal(get.ok, true, `code_summary get failed: ${get.error ?? ''}`);
  const getValue = get.value?.cli ?? get.value ?? {};
  const row = (getValue.summaries ?? [])[0];
  assert.ok(row !== undefined, 'code_summary get: summary missing');
  assert.equal(row.text, SUMMARY_TEXT);
  assert.equal(row.stale, false);

  // invalid put (501 chars) must be rejected by the Host typed-slot validation
  const invalid = await callTool(doubles.tools, 'code_summary', {
    action: 'put', workspace: WORKSPACE_ID, snapshot: snapshotId,
    subject_type: 'function', subject_id: 'f_afa8298f2d197e5fd110e49a',
    text: 'A'.repeat(501), facts,
    generator: {kind: 'agent', ref: 'verify-summary'},
    inference_labels: ['from_static_structure'],
  });
  assert.equal(invalid.ok, false, 'over-long summary text must be rejected');
  const afterInvalid = await callEndpoint(route, 'view.summary', {workspace: WORKSPACE_ID, snapshot: snapshotId});
  const kept = (afterInvalid.summaries ?? []).find((entry) => entry?.subject?.id === 'f_afa8298f2d197e5fd110e49a');
  assert.equal(kept?.text, SUMMARY_TEXT, 'invalid put must not replace the stored summary');

  // group subject
  const groupId = process.env.SCENARIO_GROUP_ID ?? 'group:f_ec61140249f393550eb97946:294d40d8';
  const groupPut = await callTool(doubles.tools, 'code_summary', {
    action: 'put', workspace: WORKSPACE_ID, snapshot: snapshotId,
    subject_type: 'group', subject_id: groupId,
    text: '该组由单入口私有子图结构归纳，包含 direct/buffered 两条路径。',
    facts: [{kind: 'selection', ref: groupId}],
    generator: {kind: 'agent', ref: 'verify-summary'},
    inference_labels: ['from_static_structure'],
  });
  assert.equal(groupPut.ok, true, `group put failed: ${groupPut.error ?? ''}`);
  const groupGet = await callTool(doubles.tools, 'code_summary', {
    action: 'get', workspace: WORKSPACE_ID, snapshot: snapshotId, subject_type: 'group', subject_id: groupId,
  });
  const groupValue = groupGet.value?.cli ?? groupGet.value ?? {};
  assert.ok((groupValue.summaries ?? []).some((entry) => entry?.subject?.type === 'group'), 'group summary missing');

  // dispose / remount: summary cache persists in the isolated state
  await fiber.dispose();
  assert.equal(doubles.tools.size, 0);
  assert.equal(doubles.routes.size, 0);
  const fiber2 = ctx.plugin(plugin);
  await fiber2;
  assert.ok(doubles.tools.has('code_summary'), 'code_summary missing after remount');
  const route2 = doubles.routes.get(CHANNEL);
  const again = await callTool(doubles.tools, 'code_summary', {
    action: 'get', workspace: WORKSPACE_ID, snapshot: snapshotId,
    subject_type: 'function', subject_id: 'f_afa8298f2d197e5fd110e49a',
  });
  assert.equal(again.ok, true);
  const againValue = again.value?.cli ?? again.value ?? {};
  assert.equal((againValue.summaries ?? [])[0]?.text, SUMMARY_TEXT, 'summary must persist across remount');
  await fiber2.dispose();
  assert.equal(doubles.tools.size, 0);
  assert.equal(doubles.routes.size, 0);
});
