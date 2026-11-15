// TAP test: S3b undo-tail / trace-import surface on the real pinned rc.5 Cordis
// runtime, with the real isolated Wasm worker execution path.
//
// Runs under the installed Electron embedded Node 24.21.0 via
// tools/verify-s3.mjs (`ELECTRON_RUN_AS_NODE=1`) against the isolated
// DSH_HOME/profile whose real Python engine imported the Lead-provided Atlas
// snapshot and the Demo Wasm sim profile. Only Host services are doubles; the
// Cordis Context, loader/fiber lifecycle, the 04 package main, the Python
// engine, the sandboxed worker and the Wasm module execution are real.
//
// Covers (scenario-contract §4/§7/§8):
//   * six code_* tools + old view endpoints still served,
//   * scenario.listProfiles / preview / run (real wasm) / get / list / CAS
//     generation / invalid args rejection without new ledger generation,
//   * view.sequence observed mode from the ledger,
//   * dispose unregisters tools + route; second apply re-registers and runs
//     again (generation increments) without absolute paths.
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import test from 'node:test';
import {pathToFileURL} from 'node:url';

const HOST_ROOT = 'E:/dsh/resources/app.asar/dsh';
const CORDIS_ENTRY = `${HOST_ROOT}/node_modules/@deepseek-ai/cordis/lib/index.js`;
const PLUGIN_ENTRY = new URL('../index.js', import.meta.url).href;
const CHANNEL = '/code-view';
const WORKSPACE_ID = process.env.READONLY_WORKSPACE_ID ?? 'code-view-bus-demo';
const PROFILE_ID = process.env.SCENARIO_PROFILE_ID ?? 'bus-demo-wasm';
const RUN = process.versions.electron !== undefined && process.versions.node === '24.21.0';
const CODE_TOOLS = ['code_learn', 'code_overview', 'code_path', 'code_snapshot', 'code_source', 'code_workspace'];
const EXPECTED_EVENTS = ['DEFAULT_ROUTE', 'STORE_ROUTE', 'REQUEST', 'LOOKUP', 'CHECK_LENGTH', 'TRANSFER', 'DIRECT', 'ENCODE', 'DOORBELL', 'WRITE'];

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

async function invokeRoute(route, {endpoint, payload = {}, rpcId = 'verifier-rpc-1'}) {
  const req = createFakeHttpRequest({endpoint, payload, rpcId});
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
  assert.equal(response.status, 200, `${endpoint}: HTTP ${response.status} (${response.text.slice(0, 300)})`);
  assert.equal(response.parsed?.type, 'server-response', `${endpoint}: not a server-response envelope`);
  assert.equal(response.parsed?.result?.ok, true, `${endpoint}: ${JSON.stringify(response.parsed?.result).slice(0, 1000)}`);
  assert.equal(absolutePathLeak(response.text), false, `${endpoint}: absolute path leaked`);
  return response.parsed.result.value;
}

function scenarioA() {
  return {
    generation: 0,
    stop_on_error: true,
    steps: [
      {interface: 'reset', args: []},
      {interface: 'bus_register', args: [1]},
      {interface: 'bus_send', args: [1, 48]},
      {interface: 'bus_send', args: [1, 48]},
    ],
  };
}

function scenarioB() {
  return {
    generation: 0,
    stop_on_error: true,
    steps: [
      {interface: 'reset', args: []},
      {interface: 'bus_register', args: [1]},
      {interface: 'set_platform_stub', args: [-5]},
      {interface: 'bus_send', args: [1, 48]},
    ],
  };
}

test('S3b undo/trace endpoints run real isolated Wasm/ledger on the pinned rc.5 Cordis runtime', {skip: !RUN}, async (t) => {
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

  const fiber = ctx.plugin(plugin);
  await fiber;
  assert.equal(doubles.tools.size, 6);
  for (const name of CODE_TOOLS) assert.ok(doubles.tools.has(name), `tool ${name} missing`);
  const route = doubles.routes.get(CHANNEL);
  assert.ok(route !== undefined, `route ${CHANNEL} not registered`);
  assert.equal(route.kind, 'prefix');

  // Old surface still served.
  const status = await callEndpoint(route, 'view.status', {});
  assert.equal(status.host.panel_key, 'dsh-code-reader');
  const listed = await callEndpoint(route, 'view.listSnapshots', {});
  const workspace = (listed.workspaces ?? []).find((row) => row.workspace_id === WORKSPACE_ID);
  assert.ok(workspace !== undefined, 'workspace missing');
  const snapshot = (workspace.snapshots ?? [])[0];
  assert.ok(snapshot !== undefined, 'snapshot missing');
  const snapshotId = snapshot.snapshot_id;

  // --- sim profile list ----------------------------------------------------
  const profiles = await callEndpoint(route, 'scenario.listProfiles', {workspace: WORKSPACE_ID});
  const profile = (profiles.profiles ?? []).find((row) => row.profile_id === PROFILE_ID);
  assert.ok(profile !== undefined, `scenario.listProfiles: ${PROFILE_ID} missing (${JSON.stringify(profiles).slice(0, 600)})`);
  assert.equal(profile.module_sha256, '69c8622d3522f68f90450a2db36ee11a85c859c91bdf2b5df1688fd6acd1321c');
  const interfaceCount = (profile.interfaces ?? []).length || Number(profile.interface_count ?? 0);
  assert.ok(interfaceCount >= 7, 'profile interfaces missing');
  const interfaceNames = (profile.interfaces ?? []).map((row) => row.name);
  assert.ok(interfaceNames.includes('bus_send') && interfaceNames.includes('set_platform_stub'), 'profile interface names missing');

  // --- preview (plan, no execution) ---------------------------------------
  const preview = await callEndpoint(route, 'scenario.preview', {
    workspace: WORKSPACE_ID,
    snapshot: snapshotId,
    profile: PROFILE_ID,
    scenario: scenarioA(),
  });
  assert.ok(typeof preview.plan_id === 'string' && preview.plan_id.length > 0, 'preview: plan_id missing');
  assert.equal(preview.plan?.profile_id ?? preview.profile_id ?? PROFILE_ID, PROFILE_ID);
  assert.equal((preview.plan?.steps ?? preview.steps ?? []).length, 4);
  assert.equal(preview.plan?.module_sha256 ?? preview.module_sha256, profile.module_sha256);

  // --- run scenario A: real worker + Wasm -------------------------------
  const runA = await callEndpoint(route, 'scenario.run', {
    workspace: WORKSPACE_ID,
    snapshot: snapshotId,
    profile: PROFILE_ID,
    scenario: scenarioA(),
    expected_generation: 0,
  });
  const runValue = runA.value ?? runA;
  const generation = runValue.generation ?? runValue.scenario?.generation;
  assert.ok(Number.isInteger(generation) && generation >= 1, `scenario.run: generation ${generation}`);
  const recordsA = runValue.records ?? [];
  assert.equal(recordsA.length, 4, `scenario.run: expected 4 records, got ${recordsA.length}`);
  // Host worker semantics: reset/void -> null, bus_register -> 0, bus_send -> 0 (x2).
  assert.deepEqual(recordsA.map((record) => record.result), [null, 0, 0, 0]);
  const eventsA = recordsA.flatMap((record) => (record.execution_events ?? record.events ?? []).map((event) => event.event));
  for (const name of EXPECTED_EVENTS) assert.ok(eventsA.includes(name), `scenario A: event ${name} missing`);
  const writeRecord = recordsA.find((record) => (record.execution_events ?? record.events ?? []).some((event) => event.event === 'WRITE'));
  assert.ok(writeRecord !== undefined, 'scenario A: WRITE record missing');
  assert.ok((writeRecord.affected_resources ?? []).some((resource) => resource.name === 'simulated_doorbell'), 'WRITE affected simulated_doorbell missing');
  for (const record of recordsA) {
    assert.match(record.memory_digest, /^[0-9a-f]{64}$/, 'memory_digest must be 64 hex');
    assert.ok(typeof record.call_id === 'string' && record.call_id.length > 0, 'call_id missing');
    assert.equal(record.status, 'ok');
  }
  const scenarioId = runValue.scenario_id ?? runValue.scenario?.scenario_id;
  assert.ok(typeof scenarioId === 'string' && scenarioId.startsWith('scn_'), `scenario_id shape (${scenarioId})`);

  // --- ledger read endpoints ----------------------------------------------
  const ledger = await callEndpoint(route, 'scenario.list', {workspace: WORKSPACE_ID});
  const ledgerRow = (ledger.scenarios ?? ledger.entries ?? []).find((row) => row.scenario_id === scenarioId);
  assert.ok(ledgerRow !== undefined, 'scenario.list: current scenario missing');
  const getOne = await callEndpoint(route, 'scenario.get', {workspace: WORKSPACE_ID, scenario: scenarioId});
  const persisted = getOne.scenario ?? getOne;
  assert.equal((persisted.records ?? []).length, 4);
  assert.equal(persisted.observed, true);

  // --- observed sequence from ledger --------------------------------------
  const observed = await callEndpoint(route, 'view.sequence', {
    workspace: WORKSPACE_ID,
    snapshot: snapshotId,
    mode: 'observed',
    scenario: scenarioId,
  });
  assert.equal(observed.mode, 'observed');
  assert.equal(observed.observed, true);
  const messageText = (observed.messages ?? []).map((message) => String(message.label ?? '')).join('\n');
  assert.ok(/bus_send\(1,\s*48\)/.test(messageText), `observed: bus_send(1, 48) missing (${messageText.slice(0, 400)})`);
  assert.ok((observed.messages ?? []).some((message) => message.event === 'DOORBELL'), 'observed: DOORBELL missing');
  assert.ok((observed.messages ?? []).some((message) => message.event === 'WRITE' || (message.affected_resources ?? []).some((resource) => resource.name === 'simulated_doorbell')), 'observed: WRITE/simulated_doorbell missing');
  assert.ok((observed.messages ?? []).some((message) => /返回|return/.test(String(message.label ?? '')) && message.result === 0), 'observed: return 0 missing');
  assert.ok((observed.messages ?? []).every((message) => message.observed === true), 'observed: message.observed must stay true');

  // --- scenario B: stub control (-5) --------------------------------------
  const runB = await callEndpoint(route, 'scenario.run', {
    workspace: WORKSPACE_ID,
    snapshot: snapshotId,
    profile: PROFILE_ID,
    scenario: scenarioB(),
    expected_generation: 0,
  });
  const recordsB = (runB.value ?? runB).records ?? [];
  assert.equal(recordsB.length, 4, `scenario B: expected 4 records, got ${recordsB.length}`);
  const stubRecord = recordsB.find((record) => record.stubbed === true);
  assert.ok(stubRecord !== undefined, 'scenario B: stub record missing (stubbed=true)');
  assert.equal(stubRecord.interface, 'set_platform_stub');
  const sendB = recordsB.find((record) => record.interface === 'bus_send');
  assert.equal(sendB.result, -5, `scenario B: bus_send result ${sendB.result} (expected -5)`);
  const eventsB = (sendB.execution_events ?? sendB.events ?? []).map((event) => event.event);
  assert.ok(!eventsB.includes('WRITE'), 'scenario B: WRITE must be absent under platform stub');
  assert.equal(sendB.status, 'error', 'scenario B: failed bus_send step must be status=error');
  assert.equal(stubRecord.result, null, 'scenario B: void stub step result must be null');
  const lockEvents = (sendB.execution_events ?? sendB.events ?? []).filter((event) => event.event === 'LOCK');
  assert.ok(lockEvents.length >= 2 && lockEvents[0].a === 1 && lockEvents[lockEvents.length - 1].a === 0, `scenario B: LOCK 1->0 missing (${JSON.stringify(lockEvents)})`);

  // --- scenario C: unregistered channel -> -2 -----------------------------
  const runC = await callEndpoint(route, 'scenario.run', {
    workspace: WORKSPACE_ID,
    snapshot: snapshotId,
    profile: PROFILE_ID,
    scenario: {generation: 0, stop_on_error: true, steps: [{interface: 'reset', args: []}, {interface: 'bus_send', args: [0, 48]}]},
    expected_generation: 0,
  });
  const recordsC = (runC.value ?? runC).records ?? [];
  const sendC = recordsC.find((record) => record.interface === 'bus_send');
  assert.ok(sendC !== undefined && sendC.result === -2, `scenario C: bus_send(0,48) result ${sendC?.result} (expected -2)`);

  // --- invalid args: engine error doc, no new ledger generation -----------
  const beforeInvalid = await callEndpoint(route, 'scenario.list', {workspace: WORKSPACE_ID});
  const beforeRows = beforeInvalid.scenarios ?? beforeInvalid.entries ?? [];
  const invalid = await invokeRoute(route, {
    endpoint: 'scenario.run',
    payload: {
      workspace: WORKSPACE_ID, snapshot: snapshotId, profile: PROFILE_ID,
      scenario: {generation: 0, stop_on_error: true, steps: [{interface: 'bus_send', args: [4, 48]}]},
      expected_generation: 0,
    },
    rpcId: 'verifier-invalid-run',
  });
  assert.equal(invalid.status, 200);
  const invalidValue = invalid.parsed?.result?.value ?? invalid.parsed?.result?.error ?? {};
  const invalidCode = String(invalidValue?.error?.code ?? invalidValue?.code ?? JSON.stringify(invalidValue));
  assert.ok(/INVALID_ARGUMENT|OUT_OF_RANGE|SCOPE_DENIED/.test(invalidCode), `invalid args: unexpected response ${JSON.stringify(invalid.parsed).slice(0, 800)}`);
  const afterInvalid = await callEndpoint(route, 'scenario.list', {workspace: WORKSPACE_ID});
  const afterRows = afterInvalid.scenarios ?? afterInvalid.entries ?? [];
  assert.equal(afterRows.length, beforeRows.length, 'invalid args must not append a ledger generation');

  // --- undo tail: replay the 2-step prefix on the real Wasm worker ----------
  const sourceGet = await callEndpoint(route, 'scenario.get', {workspace: WORKSPACE_ID, scenario: scenarioId});
  const sourceLedger = sourceGet.scenario ?? sourceGet;
  const sourceRecords = sourceLedger.records ?? [];
  assert.equal(sourceRecords.length, 4, 'undo source: expected 4 records');
  const sourceGen = sourceLedger.generation ?? 1;
  const undoRun = await callEndpoint(route, 'scenario.undoTail', {
    workspace: WORKSPACE_ID, scenario: scenarioId, count: 1, expected_generation: sourceGen,
  });
  const undoValue = undoRun.scenario ?? undoRun;
  const undoRecords = undoValue.records ?? [];
  assert.equal(undoRecords.length, 3, 'undo: prefix ledger must have 3 records');
  assert.notEqual(undoValue.scenario_id, scenarioId, 'undo: prefix scenario id must differ');
  assert.equal(undoValue.undo?.count, 1, 'undo: count missing');
  assert.equal(undoValue.undo?.state_digest_verified, true, 'undo: state_digest_verified missing');
  assert.equal(undoValue.undo?.of_scenario_id, scenarioId, 'undo: of_scenario_id mismatch');
  assert.equal(undoValue.undo?.of_generation, sourceGen, 'undo: of_generation mismatch');
  for (let index = 0; index < 3; index += 1) {
    assert.equal(undoRecords[index].memory_digest, sourceRecords[index].memory_digest, 'undo: memory_digest[' + index + '] mismatch');
    // call_id is generation-scoped (new prefix generation); the replay proof is memory_digest.
    assert.match(String(undoRecords[index].call_id), /^call_\d+_\d+$/, 'undo: call_id shape');
  }
  const prefixScenarioId = undoValue.scenario_id;
  const prefixGeneration = undoValue.generation;

  // Bad undo count is rejected and does not add a generation.
  const ledgerPreBad = await callEndpoint(route, 'scenario.list', {workspace: WORKSPACE_ID});
  const rowsPreBad = ledgerPreBad.scenarios ?? [];
  const badUndo = await invokeRoute(route, {
    endpoint: 'scenario.undoTail',
    payload: {workspace: WORKSPACE_ID, scenario: scenarioId, count: 99, expected_generation: sourceGen},
    rpcId: 'verifier-s3b-bad-undo',
  });
  const badUndoValue = badUndo.parsed?.result?.value ?? {};
  const badUndoCode = String(badUndoValue?.error?.code ?? badUndo.parsed?.result?.error?.code ?? '');
  assert.ok(/INVALID_ARGUMENT|OUT_OF_RANGE|SCOPE_DENIED|STATE_CONFLICT/.test(badUndoCode), 'undo: out-of-range count must be rejected');
  const ledgerPostBad = await callEndpoint(route, 'scenario.list', {workspace: WORKSPACE_ID});
  assert.equal((ledgerPostBad.scenarios ?? []).length, rowsPreBad.length, 'undo: rejected count must not append a generation');

  // --- trace import (no execution) + imported observed ledger ---------------
  const traceImport = await callEndpoint(route, 'trace.import', {workspace: WORKSPACE_ID, snapshot: snapshotId, input: 'trace-bus-send.json'});
  const traceValue = traceImport.scenario ?? traceImport;
  assert.equal(traceValue.imported, true, 'trace.import: imported flag missing');
  assert.equal(traceValue.source, 'imported_trace', 'trace.import: source missing');
  assert.ok(typeof traceValue.label === 'string' && traceValue.label.length > 0, 'trace.import: label missing');
  assert.equal((traceValue.records ?? []).length, 3, 'trace.import: expected 3 records');
  assert.ok((traceValue.limitations ?? []).includes('imported_trace_not_executed_by_host'), 'trace.import: limitation missing');
  const importedScenarioId = traceValue.scenario_id;
  const traceAgain = await callEndpoint(route, 'trace.import', {workspace: WORKSPACE_ID, snapshot: snapshotId, input: 'trace-bus-send.json'});
  const traceAgainValue = traceAgain.scenario ?? traceAgain;
  assert.equal(traceAgainValue.scenario_id, importedScenarioId, 'trace.import: idempotent scenario id mismatch');
  assert.equal(traceAgainValue.generation, traceValue.generation, 'trace.import: idempotent generation mismatch');

  const observedImported = await callEndpoint(route, 'view.sequence', {
    workspace: WORKSPACE_ID, snapshot: snapshotId, mode: 'observed', scenario: importedScenarioId,
  });
  assert.equal(observedImported.observed, true);
  assert.equal(observedImported.imported, true, 'observed: imported flag missing');
  const importedObservedText = (observedImported.messages ?? []).map((message) => String(message.label ?? '')).join('\n');
  assert.ok(/bus_send\(1,\s*48\)/.test(importedObservedText), 'observed imported: bus_send(1, 48) missing (' + importedObservedText.slice(0, 400) + ')');
  assert.ok((observedImported.messages ?? []).some((message) => message.event === 'DOORBELL'), 'observed imported: DOORBELL missing');
  assert.ok((observedImported.messages ?? []).some((message) => message.event === 'WRITE' || (message.affected_resources ?? []).some((resource) => resource.name === 'simulated_doorbell')), 'observed imported: WRITE missing');
  assert.ok((observedImported.messages ?? []).some((message) => /返回/.test(String(message.label ?? '')) && message.result === 0), 'observed imported: return 0 missing');
  assert.ok((observedImported.messages ?? []).every((message) => message.observed === true), 'observed imported: observed must stay true');

  const importedUndo = await invokeRoute(route, {
    endpoint: 'scenario.undoTail',
    payload: {workspace: WORKSPACE_ID, scenario: importedScenarioId, count: 1, expected_generation: traceValue.generation ?? 1},
    rpcId: 'verifier-s3b-imported-undo',
  });
  const importedUndoValue = importedUndo.parsed?.result?.value ?? {};
  const importedUndoCode = String(importedUndoValue?.error?.code ?? importedUndo.parsed?.result?.error?.code ?? '');
  assert.ok(/CAPABILITY_UNAVAILABLE|SCOPE_DENIED|INVALID_ARGUMENT|STATE_CONFLICT/.test(importedUndoCode), 'undo on imported ledger must be rejected');

  // Prefix rerun increments the prefix ledger generation.
  const prefixRerun = await callEndpoint(route, 'scenario.run', {
    workspace: WORKSPACE_ID, snapshot: snapshotId, profile: PROFILE_ID,
    scenario: {generation: prefixGeneration, stop_on_error: true, steps: [{interface: 'reset', args: []}, {interface: 'bus_register', args: [1]}, {interface: 'bus_send', args: [1, 48]}]},
    expected_generation: prefixGeneration,
  });
  const prefixRerunValue = prefixRerun.scenario ?? prefixRerun;
  assert.equal(prefixRerunValue.generation, prefixGeneration + 1, 'prefix rerun: generation must increment');

  // --- dispose / remount ---------------------------------------------------
  await fiber.dispose();
  assert.equal(doubles.tools.size, 0);
  assert.equal(doubles.routes.size, 0);
  const fiber2 = ctx.plugin(plugin);
  await fiber2;
  assert.equal(doubles.tools.size, 6);
  const route2 = doubles.routes.get(CHANNEL);
  assert.ok(route2 !== undefined, 'route missing after second mount');
  const profiles2 = await callEndpoint(route2, 'scenario.listProfiles', {workspace: WORKSPACE_ID});
  assert.ok((profiles2.profiles ?? []).some((row) => row.profile_id === PROFILE_ID), 'second mount: profile list missing');
  const rerun = await callEndpoint(route2, 'scenario.run', {
    workspace: WORKSPACE_ID,
    snapshot: snapshotId,
    profile: PROFILE_ID,
    scenario: scenarioA(),
    expected_generation: 1,
  });
  const rerunRecords = (rerun.value ?? rerun).records ?? [];
  assert.equal(rerunRecords.length, 4, 'second mount: rerun records missing');
  assert.deepEqual(rerunRecords.map((record) => record.result), [null, 0, 0, 0]);
  await fiber2.dispose();
  assert.equal(doubles.tools.size, 0);
  assert.equal(doubles.routes.size, 0);
});
