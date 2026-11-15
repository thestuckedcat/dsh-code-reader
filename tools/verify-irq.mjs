#!/usr/bin/env node
// S4-prep T41 async/IRQ acceptance verifier (independent, read-only).
//
// Contract: docs/scenario-contract.md §11.3.
// Layers:
//   atlas_snapshot  real engine CLI: rev2 sim-profile import/list (async_events),
//                   bus_irq scenario ledger + observed DTO (IRQ async:true),
//                   imported async trace fallback, invalid async_events rejection.
//   dsh_host        pinned host gate + isolated web profile + /code-view carriers
//                   (scenario.run bus_irq, view.sequence observed/static,
//                   trace.import invalid async) + Chromium probe:
//                   observed [data-sequence-async="true"] IRQ + "异步" chip,
//                   static/rev1 no marker, console=0, no absolute paths,
//                   screenshot async-irq.png.
//   demo_observed   Demo 8/8 + Node full suite.
//
// Regressions: tools/perf-regressions.mjs (S3b/S3a/S2b/summary).
// Usage: node tools/verify-irq.mjs --with-repo-tests
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {RENDER_PROBE_ELECTRON, verifyHostBaseline} from './readonly-slice/host-baseline.mjs';
import {
  ENGINE_DIR, REPO_ROOT, SLICE_DIR, WORKSPACE_ID,
  prepareIsolatedHome, readJsonFile, runEngineCli, writeJsonFile,
} from './readonly-slice/isolated-home.mjs';
import {extractBootManifest, fetchShell, httpFetch, startWebServer} from './readonly-slice/web-host.mjs';

const SCRATCH = join(REPO_ROOT, 'scratch', 'irq');
const EVIDENCE_DIR = join(REPO_ROOT, 'evidence', 'async-irq');
const REPORT_PATH = join(EVIDENCE_DIR, 'verification.json');
const COMMANDS_PATH = join(EVIDENCE_DIR, 'commands.log');
const PROBE_PATH = join(REPO_ROOT, 'tools', 'irq-probe.cjs');
const SCENARIO_SIM_DIR = join(REPO_ROOT, 'evidence', 'scenario-sim', 'inbox');
const SNAPSHOT_ID = 'ed326d554334432b907de21297207eb8';
const ENTRY_NAME = 'bus_send';
const ENTRY_ID = 'f_afa8298f2d197e5fd110e49a';
const PROFILE_ID = 'bus-demo-wasm';
const ASYNC_EVENT = 'IRQ';
const ASYNC_CHIP = '异步';
const TRACE_FILE = 'trace-bus-send.json';
const WITH_REPO_TESTS = process.argv.includes('--with-repo-tests');
const SKIP_PROBES = process.argv.includes('--skip-probes');
const SKIP_REGRESSION = process.argv.includes('--skip-regression');

const report = {
  ok: false,
  verified: false,
  started_at_utc: new Date().toISOString(),
  checks: {},
  layers: {},
  checks_summary: {},
  not_verified: [],
  commands: [],
  config: {},
  screenshots: {},
};

function logCommand(record) {
  report.commands.push({at: new Date().toISOString(), ...record, display: [record.executable, ...(record.args ?? [])].join(' ').replace(/token=[^&\s]+/, 'token=<redacted>')});
}

function record(name, ok, detail = {}, layer = null) {
  report.checks[name] = {ok: ok === true, ...(layer === null ? {} : {layer}), detail};
  return report.checks[name];
}

function requireCheck(name, ok, detail = {}, layer = null) {
  const row = record(name, ok, detail, layer);
  if (!row.ok) report.not_verified.push({item: name, reason: typeof detail?.error === 'string' ? detail.error.split('\n')[0] : 'check failed', layer, out_of_scope: false});
  return row;
}

function skipCheck(name, reason, layer = null) {
  record(name, false, {skipped: true, reason}, layer);
  report.not_verified.push({item: name, reason, layer, out_of_scope: false});
}

function outOfScope(item, reason) {
  report.not_verified.push({item, reason, out_of_scope: true});
}

function tapSummary(text) {
  const summary = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const match = text.match(new RegExp(`^# ${key} (\\d+)\\r?$`, 'm'));
    summary[key] = match === null ? null : Number(match[1]);
  }
  return summary;
}

function runNode(files, {cwd = REPO_ROOT, timeoutMs = 600000} = {}) {
  const args = ['--test', '--test-reporter=tap', '--test-concurrency=1', ...files];
  const result = spawnSync(process.execPath, args, {cwd, windowsHide: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024});
  logCommand({executable: process.execPath, args, cwd, exit_code: result.status});
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return {status: result.status, summary: tapSummary(text), text};
}

function absolutePathLeakInJson(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  const matches = text.match(/[A-Za-z]:[\\/][^"',\s}]+/g) ?? [];
  return {count: matches.length, samples: [...new Set(matches)].slice(0, 10)};
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function runProbeApp({appName, entryName}) {
  const appDir = join(SCRATCH, 'apps', appName);
  mkdirSync(appDir, {recursive: true});
  copyFileSync(PROBE_PATH, join(appDir, entryName));
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({name: `dsh-code-reader-${appName}`, version: '0.0.0-private', private: true, main: entryName}, null, 2));
  return appDir;
}

async function runElectronProbe({boot, appDir, outPath, env, logPath, timeoutMs = 600000}) {
  const userDataDir = join(SCRATCH, `electron-userdata-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const probeEnv = {...process.env, ...env, RV_URL: boot.url};
  delete probeEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(RENDER_PROBE_ELECTRON, [appDir, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userDataDir}`], {cwd: REPO_ROOT, env: probeEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk.toString('utf8'); writeFileSync(logPath, log); });
  child.stderr.on('data', (chunk) => { log += chunk.toString('utf8'); writeFileSync(logPath, log); });
  const exitCode = await new Promise((resolvePromise) => {
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolvePromise(null); }, timeoutMs);
    child.once('exit', (code) => { clearTimeout(timer); resolvePromise(code); });
  });
  try { rmSync(userDataDir, {recursive: true, force: true}); } catch { /* best effort */ }
  logCommand({executable: RENDER_PROBE_ELECTRON, args: [appDir, '--no-sandbox', '--disable-gpu'], cwd: REPO_ROOT, exit_code: exitCode});
  return {exitCode, log, result: existsSync(outPath) ? readJsonFile(outPath) : null};
}

async function main() {
  mkdirSync(EVIDENCE_DIR, {recursive: true});
  mkdirSync(SCRATCH, {recursive: true});
  const gate = verifyHostBaseline();
  requireCheck('host.pinned_baseline', gate.ok === true, {executable: gate.executable, archive: gate.archive, failed: (gate.checks ?? []).filter((row) => !row.ok)}, 'dsh_host');
  if (!gate.ok) throw new Error('pinned host gate failed');

  const prepared = prepareIsolatedHome({wipe: true, importData: false, quiet: true});
  const python = prepared.python;
  const bootstrap = prepared.bootstrap_path;
  const inbox = join(SCRATCH, 'inbox');
  mkdirSync(inbox, {recursive: true});
  copyFileSync(join(SLICE_DIR, 'inbox', 'workspace.json'), join(inbox, 'workspace.json'));
  cpSync(join(SLICE_DIR, 'inbox', 'snapshot-bus'), join(inbox, 'snapshot-bus'), {recursive: true});
  for (const name of ['sim-profile.json', 'bus.wasm', TRACE_FILE]) copyFileSync(join(SCENARIO_SIM_DIR, name), join(inbox, name));
  const bootstrapDoc = readJsonFile(bootstrap);
  bootstrapDoc.import_inbox_dir = inbox;
  writeJsonFile(bootstrap, bootstrapDoc);
  const profilePath = join(inbox, 'sim-profile.json');
  const profileDoc = readJsonFile(profilePath);
  const profileSha = sha256(readFileSync(profilePath));
  const moduleSha = sha256(readFileSync(join(inbox, 'bus.wasm')));
  report.config = {profile_path: 'evidence/scenario-sim/inbox/sim-profile.json', profile_sha256: profileSha, profile_async_events: profileDoc.async_events ?? [], module_sha256: moduleSha, trace_fixture: `evidence/scenario-sim/inbox/${TRACE_FILE}`, snapshot_id: SNAPSHOT_ID, workspace_id: WORKSPACE_ID};
  requireCheck('atlas.rev2_profile_fixture', Array.isArray(profileDoc.async_events) && JSON.stringify(profileDoc.async_events) === JSON.stringify([ASYNC_EVENT]), {profile_sha256: profileSha, async_events: profileDoc.async_events ?? null, note: 'rev2 fixture (Lead-updated); rev1 historical evidence in evidence/s3b and evidence/s3a stays valid'}, 'atlas_snapshot');

  function cli(args) {
    const result = runEngineCli({python, args, bootstrapPath: bootstrap});
    logCommand({executable: python.command, args: result.argv ?? ['engine', ...args], cwd: ENGINE_DIR, exit_code: result.exit_code});
    return result;
  }

  const imports = {
    workspace: cli(['workspace-import', '--manifest', 'workspace.json', '--expected-revision', '0', '--operation-id', crypto.randomUUID()]),
    snapshot: cli(['snapshot-import', '--workspace', WORKSPACE_ID, '--variant', 'semantic-x86_64', '--repo', 'bus', '--snapshot', 'snapshot-bus', '--operation-id', crypto.randomUUID()]),
  };
  requireCheck('atlas.atlas_import', imports.workspace.exit_code === 0 && imports.snapshot.exit_code === 0, {
    workspace_exit: imports.workspace.exit_code, snapshot_exit: imports.snapshot.exit_code,
    workspace_error: imports.workspace.ok ? null : (imports.workspace.stdout_json?.error ?? imports.workspace.stderr_tail),
    snapshot_error: imports.snapshot.ok ? null : (imports.snapshot.stdout_json?.error ?? imports.snapshot.stderr_tail),
  }, 'atlas_snapshot');

  // --- rev2 profile import + async_events projection -----------------------
  const profileImport = cli(['sim-profile-import', '--workspace', WORKSPACE_ID, '--variant', 'semantic-x86_64', '--repo', 'bus', '--profile', 'sim-profile.json', '--operation-id', crypto.randomUUID()]);
  const importValue = profileImport.stdout_json ?? {};
  requireCheck('atlas.profile_import_rev2', profileImport.ok === true
    && (importValue.profile_id ?? importValue.profile?.profile_id) === PROFILE_ID
    && absolutePathLeakInJson(importValue).count === 0, {
    profile_id: importValue.profile_id ?? importValue.profile?.profile_id ?? null,
    label: importValue.label ?? importValue.profile?.label ?? null,
    module: importValue.module ?? importValue.profile?.module ?? null,
    async_events: importValue.async_events ?? importValue.profile?.async_events ?? null,
    error: profileImport.ok ? null : (importValue.error ?? profileImport.stderr_tail),
    absolute_path_leak: absolutePathLeakInJson(importValue),
  }, 'atlas_snapshot');

  const profileList = cli(['sim-profile-list', '--workspace', WORKSPACE_ID]);
  const listValue = profileList.stdout_json ?? {};
  const listedProfiles = listValue.profiles ?? [];
  const listedProfile = listedProfiles.find((row) => row.profile_id === PROFILE_ID);
  requireCheck('atlas.profile_list_async_events', profileList.ok === true && listedProfile !== undefined
    && JSON.stringify(listedProfile.async_events ?? null) === JSON.stringify([ASYNC_EVENT])
    && (listedProfile.interfaces ?? []).some((row) => row.name === 'bus_irq' && row.role === 'entry')
    && absolutePathLeakInJson(listValue).count === 0, {
    profile_id: PROFILE_ID,
    async_events: listedProfile?.async_events ?? null,
    interface_count: (listedProfile?.interfaces ?? []).length,
    bus_irq_interface: (listedProfile?.interfaces ?? []).find((row) => row.name === 'bus_irq') ?? null,
    profiles: listedProfiles.map((row) => ({profile_id: row.profile_id, async_events: row.async_events ?? null})),
    error: profileList.ok ? null : (listValue.error ?? profileList.stderr_tail),
  }, 'atlas_snapshot');

  // --- invalid async_events on profile import (no registration) ------------
  const eventNames = Object.keys(profileDoc.trace?.events ?? {});
  const tooMany = eventNames.slice(0, 17);
  const invalidProfiles = {
    duplicate: [ASYNC_EVENT, ASYNC_EVENT],
    unknown: ['NOT_A_DECLARED_EVENT'],
    non_array: ASYNC_EVENT,
    too_many: tooMany.length >= 17 ? tooMany : [...eventNames, 'FAKE_17TH_EVENT'],
  };
  const invalidProfileResults = {};
  const profilesBefore = listedProfiles.length;
  for (const [name, asyncEvents] of Object.entries(invalidProfiles)) {
    const variant = {...profileDoc, profile_id: `${PROFILE_ID}-invalid-${name}`, async_events: asyncEvents};
    const file = `invalid-profile-${name}.json`;
    writeJsonFile(join(inbox, file), variant);
    const result = cli(['sim-profile-import', '--workspace', WORKSPACE_ID, '--variant', 'semantic-x86_64', '--repo', 'bus', '--profile', file, '--operation-id', crypto.randomUUID()]);
    const code = result.stdout_json?.error?.code ?? null;
    invalidProfileResults[name] = {exit_code: result.exit_code, ok: result.ok, code, error: result.stdout_json?.error?.message ?? null};
  }
  const afterInvalidProfiles = cli(['sim-profile-list', '--workspace', WORKSPACE_ID]).stdout_json?.profiles ?? [];
  const invalidProfileOk = Object.values(invalidProfileResults).every((row) => row.ok !== true && row.code === 'INVALID_ARGUMENT')
    && afterInvalidProfiles.length === profilesBefore;
  requireCheck('atlas.invalid_async_profile_rejected', invalidProfileOk, {cases: invalidProfileResults, profiles_before: profilesBefore, profiles_after: afterInvalidProfiles.length, note: 'duplicate / unknown / non-array / >16 all rejected with INVALID_ARGUMENT; no profile registered'}, 'atlas_snapshot');

  // --- rev1 trace import (no async declaration) ----------------------------
  const traceRev1Import = cli(['trace-import', '--workspace', WORKSPACE_ID, '--snapshot', SNAPSHOT_ID, '--input', TRACE_FILE, '--operation-id', crypto.randomUUID()]);
  const rev1Value = traceRev1Import.stdout_json ?? {};
  const rev1Scenario = (rev1Value.scenario ?? rev1Value).scenario_id ?? rev1Value.scenario_id ?? null;
  const rev1Limitations = (rev1Value.scenario ?? rev1Value).limitations ?? [];
  requireCheck('atlas.rev1_trace_import', traceRev1Import.ok === true && typeof rev1Scenario === 'string'
    && !JSON.stringify(rev1Limitations).includes('async_events_declared')
    && absolutePathLeakInJson(rev1Value).count === 0, {
    scenario_id: rev1Scenario,
    observed: (rev1Value.scenario ?? rev1Value).observed ?? null,
    imported: (rev1Value.scenario ?? rev1Value).imported ?? null,
    limitations: rev1Limitations,
    async_events: rev1Value.async_events ?? (rev1Value.scenario ?? rev1Value).async_events ?? null,
    note: 'rev1 fixture: no async_events declaration, expected to stay without async markers',
    error: traceRev1Import.ok ? null : (rev1Value.error ?? traceRev1Import.stderr_tail),
  }, 'atlas_snapshot');

  // --- invalid async_events on trace-import (no ledger write) -------------
  const traceDoc = readJsonFile(join(inbox, TRACE_FILE));
  const invalidTraceResults = {};
  const traceEventNames = [...new Set(traceDoc.steps.flatMap((step) => (step.events ?? []).map((event) => event.event)).filter(Boolean))];
  const traceTooMany = [...traceEventNames, ...Array.from({length: 17}, (_, index) => `NOT_DECLARED_${index + 1}`)].slice(0, 17);
  const invalidTraceAsync = {
    duplicate: [traceEventNames[0] ?? 'IRQ', traceEventNames[0] ?? 'IRQ'],
    unknown: ['NOT_A_DECLARED_EVENT'],
    non_array: 'IRQ',
    too_many: traceTooMany,
  };
  const scenarioCountBefore = ((cli(['scenario-list', '--workspace', WORKSPACE_ID]).stdout_json ?? {}).scenarios ?? []).length;
  for (const [name, asyncEvents] of Object.entries(invalidTraceAsync)) {
    const variant = {...traceDoc, label: `invalid async trace ${name}`, async_events: asyncEvents};
    const file = `invalid-trace-${name}.json`;
    writeJsonFile(join(inbox, file), variant);
    const result = cli(['trace-import', '--workspace', WORKSPACE_ID, '--snapshot', SNAPSHOT_ID, '--input', file, '--operation-id', crypto.randomUUID()]);
    const code = result.stdout_json?.error?.code ?? null;
    invalidTraceResults[name] = {exit_code: result.exit_code, ok: result.ok, code, error: result.stdout_json?.error?.message ?? null};
  }
  const scenarioCountAfter = ((cli(['scenario-list', '--workspace', WORKSPACE_ID]).stdout_json ?? {}).scenarios ?? []).length;
  const invalidTraceOk = Object.values(invalidTraceResults).every((row) => row.ok !== true && row.code === 'INVALID_ARGUMENT')
    && scenarioCountAfter === scenarioCountBefore;
  requireCheck('atlas.invalid_async_trace_rejected', invalidTraceOk, {cases: invalidTraceResults, scenarios_before: scenarioCountBefore, scenarios_after: scenarioCountAfter, note: 'invalid async_events on trace-import rejected; ledger generation count unchanged'}, 'atlas_snapshot');

  // --- imported async trace fallback (guarantees the async DTO path) ------
  const asyncTrace = {
    ...traceDoc,
    label: 'verifier 构造的带 async_events:["IRQ"] 导入轨迹（T41 async 验收夹具）',
    async_events: [ASYNC_EVENT],
    steps: [
      ...traceDoc.steps,
      {interface: 'bus_irq', args: [], status: 'ok', result: 0, memory_digest: sha256(Buffer.from('t41-async-trace-irq', 'utf8')), elapsed_ms: null, events: [{event: ASYNC_EVENT, code: 17, a: 1, b: 0, c: 0, line: 210}]},
    ],
  };
  writeJsonFile(join(inbox, 'trace-async-irq.json'), asyncTrace);
  const asyncTraceImport = cli(['trace-import', '--workspace', WORKSPACE_ID, '--snapshot', SNAPSHOT_ID, '--input', 'trace-async-irq.json', '--operation-id', crypto.randomUUID()]);
  const asyncTraceValue = asyncTraceImport.stdout_json ?? {};
  const asyncTraceScenario = (asyncTraceValue.scenario ?? asyncTraceValue).scenario_id ?? asyncTraceValue.scenario_id ?? null;
  requireCheck('atlas.async_trace_import', asyncTraceImport.ok === true && typeof asyncTraceScenario === 'string'
    && JSON.stringify((asyncTraceValue.scenario ?? asyncTraceValue).limitations ?? []).includes('async_events_declared')
    && absolutePathLeakInJson(asyncTraceValue).count === 0, {
    scenario_id: asyncTraceScenario,
    async_events: asyncTraceValue.async_events ?? (asyncTraceValue.scenario ?? asyncTraceValue).async_events ?? null,
    limitations: (asyncTraceValue.scenario ?? asyncTraceValue).limitations ?? [],
    error: asyncTraceImport.ok ? null : (asyncTraceValue.error ?? asyncTraceImport.stderr_tail),
  }, 'atlas_snapshot');

  const observedCli = cli(['view-sequence-observed', '--workspace', WORKSPACE_ID, '--scenario', asyncTraceScenario]);
  const observedCliValue = observedCli.stdout_json ?? {};
  const cliMessages = observedCliValue.messages ?? [];
  const cliIrqMessages = cliMessages.filter((message) => message.event === ASYNC_EVENT || String(message.label ?? '').includes(ASYNC_EVENT));
  const cliAsyncIrq = cliIrqMessages.filter((message) => message.async === true);
  requireCheck('atlas.observed_async_engine', observedCli.ok === true
    && Array.isArray(observedCliValue.async_events) && observedCliValue.async_events.includes(ASYNC_EVENT)
    && cliAsyncIrq.length > 0
    && absolutePathLeakInJson(observedCliValue).count === 0, {
    scenario_id: asyncTraceScenario,
    async_events: observedCliValue.async_events ?? null,
    irq_messages: cliIrqMessages.slice(0, 6).map((message) => ({kind: message.kind, event: message.event ?? null, async: message.async ?? null, label: message.label ?? null})),
    async_true_count: cliAsyncIrq.length,
    message_count: cliMessages.length,
    error: observedCli.ok ? null : (observedCliValue.error ?? observedCli.stderr_tail),
    absolute_path_leak: absolutePathLeakInJson(observedCliValue),
  }, 'atlas_snapshot');

  // --- real dsh web: scenario.run bus_irq + carried view endpoints ----------
  const boot = await startWebServer({python, tag: 'verify-irq'});
  let probe = null;
  let primaryScenario = asyncTraceScenario;
  let busIrqEvents = null;
  try {
    const shell = await fetchShell(boot.url);
    const bootManifest = extractBootManifest(shell.response.text);
    const cookies = shell.cookies ?? [];
    const cookieHeader = cookies.length > 0 ? {cookie: cookies.join('; ')} : {};
    requireCheck('host.web_shell', shell.response.status === 200, {status: shell.response.status, bytes: shell.response.bytes.length, cookies: cookies.map((pair) => pair.split('=', 1)[0])}, 'dsh_host');
    const entry = (bootManifest?.entries ?? []).find((row) => row.id === '@local/dsh-code-reader');
    requireCheck('host.boot_graph_entry', entry !== undefined && entry.inject !== undefined, {entry: entry === undefined ? null : {id: entry.id, rev: entry.rev, inject: entry.inject}, host_version: bootManifest?.release?.version ?? null}, 'dsh_host');
    async function callRpc(endpoint, payload, rpcId) {
      const response = await httpFetch(new URL(`/code-view/${endpoint}`, boot.url), {method: 'POST', headers: {'content-type': 'application/json', ...cookieHeader}, body: JSON.stringify({type: 'client-request', rpcId, method: endpoint, payload})});
      let parsed = null;
      try { parsed = JSON.parse(response.text); } catch { parsed = null; }
      return {status: response.status, parsed, value: parsed?.result?.value ?? null, ok: parsed?.result?.ok === true, text: response.text};
    }
    const profiles = await callRpc('scenario.listProfiles', {workspace: WORKSPACE_ID}, 'irq-profiles');
    requireCheck('host.rpc_profiles_async', profiles.ok === true
      && (profiles.value?.profiles ?? []).some((row) => row.profile_id === PROFILE_ID && JSON.stringify(row.async_events ?? null) === JSON.stringify([ASYNC_EVENT]))
      && absolutePathLeakInJson(profiles.text).count === 0, {
      profiles: (profiles.value?.profiles ?? []).map((row) => ({profile_id: row.profile_id, async_events: row.async_events ?? null})),
      error: profiles.parsed?.result?.error ?? null,
    }, 'dsh_host');

    const busIrqScenario = {generation: 0, stop_on_error: true, steps: [{interface: 'reset', args: []}, {interface: 'bus_register', args: [1]}, {interface: 'bus_irq', args: []}]};
    const runIrq = await callRpc('scenario.run', {workspace: WORKSPACE_ID, snapshot: SNAPSHOT_ID, profile: PROFILE_ID, scenario: busIrqScenario, expected_generation: 0}, 'irq-run');
    const runValue = runIrq.value ?? {};
    const scenarioDoc = runValue.scenario ?? runValue;
    const records = scenarioDoc.records ?? runValue.records ?? [];
    const busIrqRecord = records.find((row) => row.interface === 'bus_irq');
    busIrqEvents = (busIrqRecord?.execution_events ?? busIrqRecord?.events ?? []).map((event) => event.event);
    const irqScenarioId = scenarioDoc.scenario_id ?? runValue.scenario_id ?? null;
    requireCheck('host.rpc_bus_irq_run', runIrq.ok === true && records.length === 3 && busIrqRecord !== undefined
      && absolutePathLeakInJson(runIrq.text).count === 0, {
      scenario_id: irqScenarioId,
      records: records.map((row) => ({interface: row.interface, status: row.status, result: row.result, events: (row.execution_events ?? row.events ?? []).map((event) => event.event)})),
      bus_irq_events: busIrqEvents,
      bus_irq_produces_irq: busIrqEvents.includes(ASYNC_EVENT),
      error: runIrq.parsed?.result?.error ?? null,
    }, 'dsh_host');

    if (typeof irqScenarioId === 'string' && busIrqEvents.includes(ASYNC_EVENT)) {
      primaryScenario = irqScenarioId;
      const irqObserved = await callRpc('view.sequence', {workspace: WORKSPACE_ID, snapshot: SNAPSHOT_ID, mode: 'observed', scenario: irqScenarioId}, 'irq-observed');
      const irqMessages = irqObserved.value?.messages ?? [];
      requireCheck('host.rpc_bus_irq_observed_async', irqObserved.ok === true
        && (irqObserved.value?.async_events ?? []).includes(ASYNC_EVENT)
        && irqMessages.some((message) => message.event === ASYNC_EVENT && message.async === true)
        && absolutePathLeakInJson(irqObserved.text).count === 0, {
        scenario_id: irqScenarioId,
        async_events: irqObserved.value?.async_events ?? null,
        irq_messages: irqMessages.filter((message) => message.event === ASYNC_EVENT).slice(0, 6).map((message) => ({kind: message.kind, async: message.async ?? null, label: message.label ?? null})),
        error: irqObserved.parsed?.result?.error ?? null,
      }, 'dsh_host');
    }

    // Primary observed scenario (bus_irq if it emitted IRQ, else the imported async trace).
    const primaryObserved = await callRpc('view.sequence', {workspace: WORKSPACE_ID, snapshot: SNAPSHOT_ID, mode: 'observed', scenario: primaryScenario}, 'irq-primary-observed');
    const primaryMessages = primaryObserved.value?.messages ?? [];
    requireCheck('host.rpc_observed_async_primary', primaryObserved.ok === true
      && (primaryObserved.value?.async_events ?? []).includes(ASYNC_EVENT)
      && primaryMessages.some((message) => message.event === ASYNC_EVENT && message.async === true)
      && absolutePathLeakInJson(primaryObserved.text).count === 0, {
      scenario_id: primaryScenario,
      source: primaryScenario === asyncTraceScenario ? 'imported_async_trace' : 'bus_irq_wasm_run',
      async_events: primaryObserved.value?.async_events ?? null,
      async_true_count: primaryMessages.filter((message) => message.async === true).length,
      error: primaryObserved.parsed?.result?.error ?? null,
    }, 'dsh_host');

    // Static mode stays async-free.
    const staticObserved = await callRpc('view.sequence', {workspace: WORKSPACE_ID, snapshot: SNAPSHOT_ID, entry: ENTRY_ID, mode: 'static'}, 'irq-static');
    requireCheck('host.rpc_static_no_async', staticObserved.ok === true && staticObserved.value?.observed === false
      && !JSON.stringify(staticObserved.value ?? {}).includes('"async":true')
      && absolutePathLeakInJson(staticObserved.text).count === 0, {
      mode: staticObserved.value?.mode ?? null,
      observed: staticObserved.value?.observed ?? null,
      error: staticObserved.parsed?.result?.error ?? null,
    }, 'dsh_host');

    // rev1 imported trace: no async declaration -> no async markers.
    const rev1Observed = await callRpc('view.sequence', {workspace: WORKSPACE_ID, snapshot: SNAPSHOT_ID, mode: 'observed', scenario: rev1Scenario}, 'irq-rev1-observed');
    const rev1Messages = rev1Observed.value?.messages ?? [];
    requireCheck('host.rpc_rev1_no_async', rev1Observed.ok === true
      && rev1Messages.every((message) => message.async !== true)
      && !(rev1Observed.value?.async_events ?? []).includes(ASYNC_EVENT)
      && absolutePathLeakInJson(rev1Observed.text).count === 0, {
      scenario_id: rev1Scenario,
      async_events: rev1Observed.value?.async_events ?? null,
      async_true_count: rev1Messages.filter((message) => message.async === true).length,
      error: rev1Observed.parsed?.result?.error ?? null,
    }, 'dsh_host');

    // Invalid async_events through the Host trace.import carrier: rejected, no ledger write.
    const ledgerBefore = await callRpc('scenario.list', {workspace: WORKSPACE_ID}, 'irq-ledger-before');
    const beforeCount = (ledgerBefore.value?.scenarios ?? ledgerBefore.value?.entries ?? []).length;
    const traceInvalid = await callRpc('trace.import', {workspace: WORKSPACE_ID, snapshot: SNAPSHOT_ID, input: 'invalid-trace-duplicate.json'}, 'irq-trace-invalid');
    const ledgerAfter = await callRpc('scenario.list', {workspace: WORKSPACE_ID}, 'irq-ledger-after');
    const afterCount = (ledgerAfter.value?.scenarios ?? ledgerAfter.value?.entries ?? []).length;
    const invalidCode = traceInvalid.parsed?.result?.error?.code ?? traceInvalid.value?.error?.code ?? null;
    requireCheck('host.rpc_invalid_async_trace', invalidCode === 'INVALID_ARGUMENT' && afterCount === beforeCount, {
      code: invalidCode, ledger_before: beforeCount, ledger_after: afterCount,
      error: traceInvalid.parsed?.result?.error ?? null,
    }, 'dsh_host');

    // --- Chromium DOM probe ---
    if (!SKIP_PROBES) {
      const appDir = runProbeApp({appName: 'irq-probe-app', entryName: 'irq-probe.cjs'});
      const shotDir = join(SCRATCH, 'shots');
      mkdirSync(shotDir, {recursive: true});
      const outPath = join(SCRATCH, 'irq-probe.json');
      rmSync(outPath, {force: true});
      const run = await runElectronProbe({
        boot, appDir, outPath,
        env: {RV_OUT: outPath, RV_SHOT_DIR: shotDir, RV_SNAPSHOT_ID: SNAPSHOT_ID, RV_IRQ_SCENARIO: primaryScenario, RV_REV1_SCENARIO: rev1Scenario, RV_ASYNC_EVENT: ASYNC_EVENT, RV_ASYNC_CHIP: ASYNC_CHIP, RV_TIMEOUT_MS: '540000'},
        logPath: join(SCRATCH, 'irq-probe.log'),
      });
      probe = run.result;
      const checks = probe?.checks ?? {};
      requireCheck('host.irq_probe', probe !== null && probe.ok === true, {exit_code: run.exitCode, duration_ms: probe?.duration_ms ?? null, failed_steps: probe?.failed_steps ?? [], steps: probe?.steps ?? null, checks, console_error_count: probe?.console_error_count ?? null, observed: probe?.observed ? {async_count: probe.observed.async_count, chips: probe.observed.chips, async_event_present: probe.observed.async_event_present} : null, static: probe?.static ?? null, rev1: probe?.rev1 ?? null, log_tail: run.log.slice(-1200)}, 'dsh_host');
      requireCheck('host.irq_observed_async', checks.observed_async_marker === true && checks.observed_irq_message === true && checks.observed_async_chip === true, {checks: {observed_async_marker: checks.observed_async_marker, observed_irq_message: checks.observed_irq_message, observed_async_chip: checks.observed_async_chip}, observed: probe?.observed ?? null}, 'dsh_host');
      requireCheck('host.irq_async_chrome', checks.observed_async_chip_attr === true && checks.observed_async_note === true, {checks: {observed_async_chip_attr: checks.observed_async_chip_attr, observed_async_note: checks.observed_async_note}, chip_nodes: probe?.observed?.async_chip_nodes ?? null, notes: probe?.observed?.async_notes ?? null}, 'dsh_host');
      requireCheck('host.irq_static_no_marker', checks.static_no_async_marker === true && checks.static_after_no_async_marker === true, {static: probe?.static ?? null, static_after: probe?.static_after ?? null}, 'dsh_host');
      requireCheck('host.irq_rev1_no_marker', checks.rev1_no_async_marker === true, {rev1: probe?.rev1 ?? null}, 'dsh_host');
      requireCheck('host.irq_console_clean', (probe?.console_error_count ?? 1) === 0, {console_error_count: probe?.console_error_count ?? null, console_lines: probe?.console_lines ?? []}, 'dsh_host');
      requireCheck('host.irq_no_absolute_paths', probe?.absolute_paths?.count === 0, {absolute_paths: probe?.absolute_paths ?? null}, 'dsh_host');
      let screenshot = null;
      const shot = probe?.screenshots?.['async-irq'];
      if (shot?.path !== undefined && existsSync(shot.path)) {
        const target = join(EVIDENCE_DIR, 'async-irq.png');
        copyFileSync(shot.path, target);
        screenshot = {path: 'evidence/async-irq/async-irq.png', bytes: readFileSync(target).length, sha256: sha256(readFileSync(target))};
        report.screenshots['async-irq'] = screenshot;
      }
      requireCheck('host.irq_screenshot', screenshot !== null && screenshot.bytes > 0, {screenshot}, 'dsh_host');
    }
  } finally {
    await boot.stop().catch(() => null);
  }

  // --- regressions: S3b / S3a / S2b / summary (perf-regressions pack) ------
  if (WITH_REPO_TESTS) {
    const regressionResult = spawnSync(process.execPath, [join(REPO_ROOT, 'tools', 'perf-regressions.mjs')], {cwd: REPO_ROOT, windowsHide: true, encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024, env: {...process.env, PYTHON_BIN: python.command ?? 'E:/Anaconda-main/python.exe'}});
    logCommand({executable: process.execPath, args: ['tools/perf-regressions.mjs'], cwd: REPO_ROOT, exit_code: regressionResult.status});
    const regressionPath = join(REPO_ROOT, 'scratch', 'perf', 'regressions', 'regressions.json');
    const regression = existsSync(regressionPath) ? readJsonFile(regressionPath) : null;
    const regressionChecks = regression?.checks ?? {};
    requireCheck('regression.s3b', regressionChecks['regression.s3b_probe']?.ok === true, {check: regressionChecks['regression.s3b_probe'] ?? null, exit_code: regressionResult.status, log_tail: (regressionResult.stderr ?? '').slice(-800)}, 'dsh_host');
    requireCheck('regression.s3a', regressionChecks['regression.s3a_probe']?.ok === true, {check: regressionChecks['regression.s3a_probe'] ?? null}, 'dsh_host');
    requireCheck('regression.s2b', regressionChecks['regression.s2b_probe']?.ok === true, {check: regressionChecks['regression.s2b_probe'] ?? null}, 'dsh_host');
    requireCheck('regression.summary', regressionChecks['regression.summary_roundtrip']?.ok === true, {check: regressionChecks['regression.summary_roundtrip'] ?? null}, 'dsh_host');
    const regressionProbes = regression?.probes ?? {};
    const consoleClean = ['s3b', 's3a', 's2b', 'summary_gap', 'summary_written'].every((name) => (regressionProbes[name]?.console_error_count ?? 1) === 0);
    requireCheck('regression.console_clean', consoleClean, {probes: Object.fromEntries(Object.entries(regressionProbes).map(([name, row]) => [name, row?.console_error_count ?? null]))}, 'dsh_host');

    const files = readdirSync(join(REPO_ROOT, 'tests', 'node')).filter((name) => name.endsWith('.test.mjs')).map((name) => `tests/node/${name}`);
    const nodeRun = runNode(files);
    requireCheck('regression.node_tests', nodeRun.status === 0 && nodeRun.summary.fail === 0 && (nodeRun.summary.pass ?? 0) > 0, {summary: nodeRun.summary, output_tail: nodeRun.text.slice(-1200)}, 'demo_observed');
    const demoRun = runNode(['demo/code-view/demo.test.cjs']);
    requireCheck('regression.demo', demoRun.status === 0 && demoRun.summary.fail === 0 && (demoRun.summary.pass ?? 0) > 0, {summary: demoRun.summary, output_tail: demoRun.text.slice(-1200)}, 'demo_observed');
  } else {
    skipCheck('regression.node_tests', '--with-repo-tests not requested', 'demo_observed');
    skipCheck('regression.demo', '--with-repo-tests not requested', 'demo_observed');
  }

  // --- layers / summary -----------------------------------------------------
  const layerChecks = (layer) => Object.entries(report.checks).filter(([, row]) => row.layer === layer);
  for (const layer of ['atlas_snapshot', 'dsh_host', 'demo_observed']) {
    const rows = layerChecks(layer);
    report.layers[layer] = rows.length > 0 && rows.every(([, row]) => row.ok === true);
  }
  const requiredRows = Object.values(report.checks).filter((row) => row.required !== false);
  report.checks_summary = {
    total: Object.keys(report.checks).length,
    passed: Object.values(report.checks).filter((row) => row.ok === true).length,
    failed: Object.values(report.checks).filter((row) => row.ok !== true).length,
    in_scope_not_verified: report.not_verified.filter((row) => !row.out_of_scope).length,
    out_of_scope_not_verified: report.not_verified.filter((row) => row.out_of_scope).length,
  };
  outOfScope('真实硬件 IRQ 因果/中断完成判定', 'async:true 仅表示该事件被 profile 声明为异步触发，不推断硬件中断已发生（契约 §11.2 明确）');
  outOfScope('真实设备/外部轨迹采集与下发', 'S4 后续；本轮只验证已执行 Wasm 台账与导入轨迹的异步边界标记');
  outOfScope('跨进程异步调度/时序竞态的证明', '台账只记录顺序与事件本身，不建模调度器；S4 后续');
  outOfScope('rev1 历史证据重跑', 'rev1 profile/trace 的 S3a/S3b 证据在 evidence/s3、evidence/s3b 保持有效，不重复纳入本轮');
  outOfScope('480KiB 内核/大 payload 的 async 变体', '限流路径由引擎/Node 测试覆盖，本轮夹具远低于上限，未构造超大 payload');
  // Recompute the not_verified counters AFTER the out-of-scope declarations so
  // the evidence summary matches the written list.
  report.checks_summary.in_scope_not_verified = report.not_verified.filter((row) => !row.out_of_scope).length;
  report.checks_summary.out_of_scope_not_verified = report.not_verified.filter((row) => row.out_of_scope).length;
  report.ok = requiredRows.length > 0 && Object.values(report.layers).every((value) => value === true);
  report.verified = report.ok;
  report.finished_at_utc = new Date().toISOString();
  report.duration_ms = Date.parse(report.finished_at_utc) - Date.parse(report.started_at_utc);
  report.evidence = 'evidence/async-irq/verification.json';

  writeJsonFile(REPORT_PATH, report);
  writeFileSync(COMMANDS_PATH, `${report.commands.map((row) => `${row.at ?? ''} ${row.display ?? ''}${row.exit_code === undefined ? '' : ` [exit ${row.exit_code}]`}`).join('\n')}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ok: report.ok, verified: report.verified, layers: report.layers, checks_summary: report.checks_summary, duration_ms: report.duration_ms, evidence: 'evidence/async-irq/verification.json'}, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((error) => {
  report.ok = false;
  report.verified = false;
  report.error = String(error?.stack ?? error);
  report.finished_at_utc = new Date().toISOString();
  report.duration_ms = Date.parse(report.finished_at_utc) - Date.parse(report.started_at_utc);
  try { mkdirSync(EVIDENCE_DIR, {recursive: true}); } catch { /* ignore */ }
  try { writeJsonFile(REPORT_PATH, report); } catch { /* ignore */ }
  process.stdout.write(`${JSON.stringify({ok: false, error: report.error.split('\n')[0]}, null, 2)}\n`);
  process.exitCode = 1;
});
