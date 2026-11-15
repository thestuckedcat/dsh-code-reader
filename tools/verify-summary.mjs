#!/usr/bin/env node
// Independent black-box acceptance runner for S3a (controlled scenario
// simulation: stub panel, Wasm execution ledger, observed sequence) on the real
// pinned rc.5 DSH web host. Never imports plugin modules for assertions and
// never writes into the plugin implementation.
//
// Layers (kept separate, never mixed):
//   demo_observed   `node --test demo/code-view/demo.test.cjs`
//   atlas_snapshot  real engine CLI: sim-profile-import/list, scenario-plan/
//                   module, scenario-list/get, view-sequence-observed
//   dsh_host        pinned host gate + isolated web profile + /code-view
//                   carriers (scenario + view endpoints, real Python, real
//                   isolated Wasm worker through scenario.run) + Chromium:
//                   S1/S2a/S2b regression probes + S3a stub/ledger/observed
//                   sequence probe + real Cordis mount/dispose/remount test
//
// Output: evidence/s3b/verification.json, commands.log, README (authored
// separately), screenshots stub-run/stub-stub/sequence-observed/main plus
// regression PNGs; out_of_scope items stay flagged in not_verified.
//
// Usage: node tools/verify-s3.mjs [--skip-probes] [--skip-regression]
//        [--skip-host-runtime] [--skip-demo] [--skip-http] [--with-repo-tests]
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  DSH_BIN,
  EXECUTABLE,
  HOST_BASELINE,
  RENDER_PROBE_ELECTRON,
  verifyHostBaseline,
} from './readonly-slice/host-baseline.mjs';
import {
  BOOTSTRAP_PATH,
  ENGINE_DIR,
  HOME_DIR,
  REPO_ROOT,
  SLICE_DIR,
  WORKSPACE_ID,
  inspectSnapshot,
  isolatedEnv,
  prepareIsolatedHome,
  readJsonFile,
  runEngineCli,
  writeJsonFile,
} from './readonly-slice/isolated-home.mjs';
import {extractBootManifest, fetchShell, httpFetch, startWebServer} from './readonly-slice/web-host.mjs';

const EVIDENCE_DIR = join(REPO_ROOT, 'evidence', 'ai-summary');
const COMMANDS_PATH = join(EVIDENCE_DIR, 'commands.log');
const REPORT_PATH = join(EVIDENCE_DIR, 'verification.json');
const SCRATCH = join(REPO_ROOT, 'scratch', 'summary');
const S3_SHOT_DIR = join(SCRATCH, 'shots');
const S2B_SHOT_DIR = join(SCRATCH, 's2b-shots');
const S2A_SHOT_DIR = join(SCRATCH, 's2a-shots');
const S1_SHOT_DIR = join(SCRATCH, 's1-shots');
const S3_PROBE_JSON = join(SCRATCH, 's3-probe.json');
const S2B_PROBE_JSON = join(SCRATCH, 's2b-probe.json');
const S2A_PROBE_JSON = join(SCRATCH, 's2a-probe.json');
const S1_PROBE_JSON = join(SCRATCH, 's1-probe.json');
const S1_PROBE_PNG = join(SCRATCH, 's1-render.png');
const HOST_RUNTIME_TAP = join(EVIDENCE_DIR, 'host-runtime.tap');
const HOST_RUNTIME_JSON = join(EVIDENCE_DIR, 'host-runtime.json');
const S3B_PROBE = join(REPO_ROOT, 'tools', 's3b-probe.cjs');
const SUMMARY_PROBE = join(REPO_ROOT, 'tools', 'summary-probe.cjs');
const S3_PROBE = join(REPO_ROOT, 'tools', 's3-probe.cjs');
const S2B_PROBE = join(REPO_ROOT, 'tools', 's2b-probe.cjs');
const S2A_PROBE = join(REPO_ROOT, 'tools', 'five-views-probe.cjs');
const S1_PROBE = join(REPO_ROOT, 'tools', 'readonly-slice', 'electron-probe.cjs');
const HOST_RUNTIME_TEST = 'tools/summary-host-runtime.test.mjs';
const PACKAGE_JSON = join(REPO_ROOT, 'package.json');
const SCENARIO_SIM_DIR = join(REPO_ROOT, 'evidence', 'scenario-sim');
const SCRATCH_INBOX = join(SCRATCH, 'inbox');
const PROFILE_ID = 'bus-demo-wasm';
const TRACE_FILE = 'trace-bus-send.json';

const argv = process.argv.slice(2);
const options = {
  skipProbes: argv.includes('--skip-probes'),
  skipRegression: argv.includes('--skip-regression'),
  skipHostRuntime: argv.includes('--skip-host-runtime'),
  skipDemo: argv.includes('--skip-demo'),
  skipHttp: argv.includes('--skip-http'),
  withRepoTests: argv.includes('--with-repo-tests'),
};

const startedAt = new Date().toISOString();
const report = {
  schema_version: 1,
  stage: 'S4-prep',
  contract: 'docs/ai-summary-perf-contract.md (CL-VIEW-T4A-CONTRACT)',
  started_at_utc: startedAt,
  purpose:
    'Independent black-box acceptance of S4-prep AI summary (CW-09): real isolated dsh web gap state, engine summary-put/view-summary writes (simulated Agent), UI rendering of text/facts/generator/generated_at/stale=false, invalid payload rejection, group subject, S3b/S3a/S2b/S2a/S1 regression and real Cordis code_summary put/get with dispose/remount.',
  host: HOST_BASELINE,
  layers: {demo_observed: false, atlas_snapshot: false, dsh_host: false},
  checks: {},
  not_verified: [],
  commands: [],
  environment: {node: process.versions.node, platform: process.platform, workspace: REPO_ROOT},
  limitations: [
    'Uses the locally installed generic Electron binary only as the Chromium test instrument; it is not a shipped dependency.',
    'The isolated fresh DSH_HOME may show the host first-run overlay in screenshots; S3a DOM assertions are recorded independently of host UI (captures close host overlays first).',
    'The Wasm profile is the Demo build artifact executed in the Host sandboxed worker: it is not evidence of real device/kernel behavior. Imported trace ledgers are never executed.',
    'No OS-wide egress certification; only loopback HTTP and local process/worker observation.',
    'DEMO layer is the Wasm/JS demo model, ATLAS is the real imported snapshot + engine projections, DSH_HOST is the pinned local rc.5; the three are never mixed.',
    'S3b does not add async/IRQ causal refinement, real device dispatch, AI summary text, or S4 (real Linux/Kbuild, CFG/locks, performance); these remain gaps.',
  ],
};

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function redactUrl(url) {
  return String(url ?? '').replace(/token=[^&]+/g, 'token=<redacted>');
}

function logCommand(record) {
  report.commands.push({
    at: new Date().toISOString(),
    ...record,
    display: `${redactUrl([record.executable, ...(record.args ?? [])].join(' '))}${record.exit_code === undefined ? '' : ` [exit ${record.exit_code}]`}`,
  });
}

function record(name, ok, detail = {}, {required = true, layer = null} = {}) {
  report.checks[name] = {ok: ok === true, required: required === true, ...(layer === null ? {} : {layer}), detail};
  return report.checks[name];
}

function requireCheck(name, ok, detail = {}, {layer = null} = {}) {
  const row = record(name, ok, detail, {required: true, layer});
  if (!row.ok) {
    report.not_verified.push({
      item: name,
      reason: typeof detail?.error === 'string' ? detail.error.split('\n')[0] : 'check failed',
      layer,
      out_of_scope: false,
    });
  }
  return row;
}

function skipCheck(name, reason, {layer = null, outOfScope = false} = {}) {
  record(name, false, {skipped: true, reason, ...(layer === null ? {} : {layer})}, {required: false, layer});
  report.not_verified.push({item: name, reason, layer, out_of_scope: outOfScope});
}

function outOfScope(item, reason, layer = null) {
  report.not_verified.push({item, reason, layer, out_of_scope: true});
}

async function guard(name, fn, {required = true, layer = null} = {}) {
  try {
    return await fn();
  } catch (error) {
    const message = String(error?.stack ?? error?.message ?? error);
    record(name, false, {error: message}, {required, layer});
    if (required) report.not_verified.push({item: name, reason: message.split('\n')[0], layer, out_of_scope: false});
    return {__error: message};
  }
}

function tapSummary(tapText) {
  const summary = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const match = tapText.match(new RegExp(`^# ${key} (\\d+)\\r?$`, 'm'));
    summary[key] = match === null ? null : Number(match[1]);
  }
  return summary;
}

function runNodeTests(files, {cwd = REPO_ROOT, timeoutMs = 360000} = {}) {
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

function cli(python, args, bootstrapPath = BOOTSTRAP_PATH) {
  const result = runEngineCli({python, args, bootstrapPath});
  logCommand({executable: python.command, args: result.argv, cwd: ENGINE_DIR, exit_code: result.exit_code});
  return result;
}

function b64(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function scenarioA() {
  return {generation: 0, stop_on_error: true, steps: [{interface: 'reset', args: []}, {interface: 'bus_register', args: [2]}, {interface: 'bus_send', args: [2, 48]}]};
}
function scenarioB() {
  return {generation: 0, stop_on_error: true, steps: [{interface: 'reset', args: []}, {interface: 'bus_register', args: [2]}, {interface: 'set_platform_stub', args: [-5]}, {interface: 'bus_send', args: [2, 48]}]};
}
function scenarioC() {
  return {generation: 0, stop_on_error: true, steps: [{interface: 'reset', args: []}, {interface: 'bus_send', args: [0, 49]}]};
}
const EXPECTED_EVENTS = ['DEFAULT_ROUTE', 'STORE_ROUTE', 'REQUEST', 'LOOKUP', 'CHECK_LENGTH', 'TRANSFER', 'DIRECT', 'ENCODE', 'DOORBELL', 'WRITE'];

// ---------------------------------------------------------------------------
// static client contract
// ---------------------------------------------------------------------------
function packageContract() {
  const pkg = readJsonFile(PACKAGE_JSON);
  const checks = {
    name: pkg.name === '@local/dsh-code-reader',
    client_platform: pkg?.dsh?.client?.platform === 'web',
    client_export: pkg?.exports?.['./client'] === './bundle/client.js',
  };
  const clientPath = join(REPO_ROOT, 'bundle', 'client.js');
  checks.client_bundle_exists = existsSync(clientPath);
  let clientBytes = Buffer.alloc(0);
  let clientText = '';
  if (checks.client_bundle_exists) {
    clientBytes = readFileSync(clientPath);
    clientText = clientBytes.toString('utf8');
    checks.client_loader = clientText.includes('window.__ModuleLoader__.load(') && clientText.includes('@local/dsh-code-reader');
    checks.client_s3_labels = ['打桩模拟', '运行观测', '静态预测', '回退', '导入轨迹'].every((label) => clientText.includes(label));
    // Attribute-name tokens as they appear in the rc.5 client source (object keys are quoted).
    checks.client_ai_summary_hooks = ['ai-summary', 'data-ai-summary-text', 'data-ai-summary-gap',
      'data-ai-summary-generator', 'data-ai-summary-generated-at', 'data-ai-summary-facts',
      'data-ai-summary-labels', 'data-ai-summary-stale'].every((hook) => clientText.includes(hook));
    checks.client_s3b_hooks = ['stub-panel', 'data-code-view', 'data-stub-profile', 'data-stub-step', 'data-step-interface',
      'data-step-arg', 'data-stub-add-step', 'data-stub-stop-on-error', 'data-stub-run', 'data-stub-record',
      'data-stub-event', 'data-stub-affect', 'data-stub-undo', 'data-stub-undo-count', 'data-stub-undo-status',
      'data-trace-import-input', 'data-trace-import', 'data-trace-import-status', 'data-stub-gap',
      'data-sequence-observed', 'data-sequence-message', 'data-sequence-imported', 'sequence-scenario', 'sequence-mode'].every((hook) => clientText.includes(hook));
  }
  return {
    ok: Object.values(checks).every((value) => value === true),
    package: {name: pkg.name, version: pkg.version, main: pkg.main, dsh: pkg.dsh},
    client_bundle: {path: 'bundle/client.js', bytes: clientBytes.length, sha256: checks.client_bundle_exists ? sha256(clientBytes) : null},
    checks,
  };
}

// ---------------------------------------------------------------------------
// isolated home + inbox (workspace/snapshot + sim-profile assets)
// ---------------------------------------------------------------------------
function prepareIsolatedInbox(prepared) {
  mkdirSync(SCRATCH_INBOX, {recursive: true});
  // Trusted Lead slice data copied read-only into the isolated inbox.
  copyFileSync(join(SLICE_DIR, 'inbox', 'workspace.json'), join(SCRATCH_INBOX, 'workspace.json'));
  cpSync(join(SLICE_DIR, 'inbox', 'snapshot-bus'), join(SCRATCH_INBOX, 'snapshot-bus'), {recursive: true});
  // S3a trusted sim profile + Wasm module (Lead-provided fixtures).
  for (const name of ['sim-profile.json', 'bus.wasm', TRACE_FILE]) {
    const source = join(SCENARIO_SIM_DIR, 'inbox', name);
    if (!existsSync(source)) throw new Error(`scenario-sim fixture missing: evidence/scenario-sim/inbox/${name}`);
    copyFileSync(source, join(SCRATCH_INBOX, name));
  }
  const bootstrap = readJsonFile(prepared.bootstrap_path);
  bootstrap.import_inbox_dir = SCRATCH_INBOX;
  writeJsonFile(prepared.bootstrap_path, bootstrap);
  return {inbox: SCRATCH_INBOX, bootstrapPath: prepared.bootstrap_path, files: readdirSync(SCRATCH_INBOX)};
}

// ---------------------------------------------------------------------------
// Atlas layer: sim profile registration + scenario plan/module
// ---------------------------------------------------------------------------
async function verifyAtlasScenarioSetup(python, facts, prepared, inbox, snapshotId) {
  const workspaceId = WORKSPACE_ID;
  // sim-profile-import: register the trusted Wasm profile through the real engine.
  const importResult = cli(python, [
    'sim-profile-import',
    '--workspace', workspaceId,
    '--variant', 'semantic-x86_64',
    '--repo', 'bus',
    '--profile', 'sim-profile.json',
    '--operation-id', crypto.randomUUID(),
  ], inbox.bootstrapPath);
  const importValue = importResult.stdout_json ?? {};
  const moduleSha = importValue.module?.sha256 ?? importValue.module_sha256 ?? importValue.profile?.module?.sha256 ?? null;
  const wasmPath = join(SCENARIO_SIM_DIR, 'inbox', 'bus.wasm');
  const wasmBytes = readFileSync(wasmPath);
  requireCheck('atlas.sim_profile_import', importResult.ok
    && (importValue.profile_id ?? importValue.profile?.profile_id) === PROFILE_ID
    && (moduleSha === null || moduleSha === sha256(wasmBytes))
    && (importValue.binding ?? importValue.profile?.binding) !== undefined
    && absolutePathLeakInJson(importValue).count === 0, {
    command: 'sim-profile-import --workspace code-view-bus-demo --variant semantic-x86_64 --repo bus --profile sim-profile.json --operation-id <uuid>',
    profile_id: importValue.profile_id ?? importValue.profile?.profile_id ?? null,
    label: importValue.label ?? importValue.profile?.label ?? null,
    binding: importValue.binding ?? importValue.profile?.binding ?? null,
    module: importValue.module ?? importValue.profile?.module ?? null,
    module_sha256_expected: sha256(wasmBytes),
    module_bytes: wasmBytes.length,
    interface_count: (importValue.interfaces ?? importValue.profile?.interfaces ?? []).length,
    absolute_path_leak: absolutePathLeakInJson(importValue),
    error: importResult.ok ? null : (importResult.stdout_json?.error ?? importResult.stderr_tail),
  }, {layer: 'atlas_snapshot'});

  // sim-profile-list
  const listResult = cli(python, ['sim-profile-list', '--workspace', workspaceId], inbox.bootstrapPath);
  const listValue = listResult.stdout_json ?? {};
  const profiles = listValue.profiles ?? [];
  const profile = profiles.find((row) => row.profile_id === PROFILE_ID);
  requireCheck('atlas.sim_profile_list', listResult.ok && profile !== undefined
    && (profile.interfaces ?? []).length === 7
    && ['reset', 'bus_register', 'stub_route', 'bus_unregister', 'bus_send', 'bus_irq', 'set_platform_stub'].every((name, index) => (profile.interfaces ?? [])[index]?.name === name)
    && JSON.stringify(profile.limits) === JSON.stringify({timeout_ms: 10000, steps: 20, events_per_step: 256})
    && (profile.interfaces ?? []).some((row) => row.name === 'bus_send' && row.role === 'entry' && row.entry_id === 'f_afa8298f2d197e5fd110e49a')
    && (profile.interfaces ?? []).some((row) => row.name === 'set_platform_stub' && row.role === 'stub_control' && row.returns === 'void' && row.entry_id === null)
    && absolutePathLeakInJson(listValue).count === 0, {
    command: 'sim-profile-list --workspace code-view-bus-demo',
    profiles: profiles.map((row) => ({profile_id: row.profile_id, label: row.label, module_sha256: row.module_sha256 ?? row.module?.sha256, interface_count: (row.interfaces ?? []).length, limits: row.limits ?? null, trace_events: row.trace_events ?? null})),
    interfaces: (profile?.interfaces ?? []).map((row) => ({name: row.name, returns: row.returns, role: row.role, entry_id: row.entry_id ?? null, params: row.params ?? null})),
    limits: profile?.limits ?? null,
    error: listResult.ok ? null : (listResult.stdout_json?.error ?? listResult.stderr_tail),
  }, {layer: 'atlas_snapshot'});

  // scenario-plan (no execution)
  const planResult = cli(python, ['scenario-plan', '--workspace', workspaceId, '--snapshot', snapshotId, '--profile', PROFILE_ID, '--scenario-json', b64(scenarioA())], inbox.bootstrapPath);
  const planValue = planResult.stdout_json ?? {};
  const plan = planValue.plan ?? planValue;
  requireCheck('atlas.scenario_plan', planResult.ok
    && typeof plan.plan_id === 'string' && plan.plan_id.length > 0
    && (plan.profile_id ?? PROFILE_ID) === PROFILE_ID
    && (plan.plan?.steps ?? plan.steps ?? []).length === 3
    && (plan.plan?.module_sha256 ?? plan.module_sha256) === sha256(wasmBytes)
    && typeof plan.scenario_id === 'string'
    && absolutePathLeakInJson(planValue).count === 0, {
    command: 'scenario-plan --workspace code-view-bus-demo --snapshot <snapshot> --profile bus-demo-wasm --scenario-json <base64>',
    plan_id: plan.plan_id ?? null,
    scenario_id: plan.scenario_id ?? null,
    generation: plan.generation ?? null,
    steps: plan.steps ?? plan.plan?.steps ?? null,
    limits: plan.limits ?? plan.plan?.limits ?? null,
    expires_at: plan.expires_at ?? plan.plan?.expires_at ?? null,
    absolute_path_leak: absolutePathLeakInJson(planValue),
    error: planResult.ok ? null : (planResult.stdout_json?.error ?? planResult.stderr_tail),
  }, {layer: 'atlas_snapshot'});

  // scenario-module (bytes for the Host worker) — verify sha256/size only.
  let moduleCheck = {ok: false};
  if (planResult.ok && typeof plan.plan_id === 'string') {
    const moduleResult = cli(python, ['scenario-module', '--plan', plan.plan_id], inbox.bootstrapPath);
    const moduleValue = moduleResult.stdout_json ?? {};
    const moduleB64 = moduleValue.module_b64 ?? moduleValue.module?.b64 ?? null;
    const bytes = moduleB64 === null ? null : Buffer.from(moduleB64, 'base64');
    moduleCheck = {
      ok: moduleResult.ok && bytes !== null && bytes.length === wasmBytes.length && sha256(bytes) === sha256(wasmBytes),
      bytes: bytes === null ? null : bytes.length,
      sha256: bytes === null ? null : sha256(bytes),
      expected_sha256: sha256(wasmBytes),
      expected_bytes: wasmBytes.length,
      trace: moduleValue.trace ?? null,
      profile_id: moduleValue.profile?.profile_id ?? moduleValue.profile_id ?? null,
      absolute_path_leak: absolutePathLeakInJson(moduleValue),
      error: moduleResult.ok ? null : (moduleResult.stdout_json?.error ?? moduleResult.stderr_tail),
    };
  }
  requireCheck('atlas.scenario_module', moduleCheck.ok === true && moduleCheck.absolute_path_leak?.count === 0, moduleCheck, {layer: 'atlas_snapshot'});
  return {importValue, profile, plan: planValue};
}

// ---------------------------------------------------------------------------
// DSH host layer: boot graph + carriers (scenario + view)
// ---------------------------------------------------------------------------
async function verifyBootGraph(boot) {
  const shell = await fetchShell(boot.url);
  requireCheck('host.web_shell', shell.response.status === 200 && shell.response.bytes.length > 0, {
    status: shell.response.status,
    final_url: redactUrl(shell.final_url),
    redirects: shell.hops,
    bytes: shell.response.bytes.length,
    cookies_issued_by_host: shell.cookies.map((pair) => pair.split('=', 1)[0]),
  }, {layer: 'dsh_host'});
  const bootManifest = extractBootManifest(shell.response.text);
  requireCheck('host.boot_release', bootManifest?.release?.version === HOST_BASELINE.dsh_version, {
    release: bootManifest?.release ?? null,
    entries: bootManifest?.entries?.length ?? null,
  }, {layer: 'dsh_host'});
  const entry = (bootManifest.entries ?? []).find((row) => row.id === '@local/dsh-code-reader');
  requireCheck('host.boot_graph_entry', entry !== undefined, {
    entry: entry === undefined ? null : {id: entry.id, url: redactUrl(entry.url), inject: entry.inject},
    plugin_entries: (bootManifest.entries ?? []).length,
  }, {layer: 'dsh_host'});
  const pkg = readJsonFile(PACKAGE_JSON);
  requireCheck('host.boot_graph_inject', entry !== undefined && JSON.stringify(entry.inject) === JSON.stringify(pkg.dsh.client.inject), {
    boot_graph_inject: entry?.inject ?? null,
    package_inject: pkg.dsh.client.inject,
  }, {layer: 'dsh_host'});
  let bundle = {fetched: false};
  if (entry !== undefined && typeof entry.url === 'string') {
    const clientUrl = new URL(entry.url.replace(/&amp;/g, '&'), shell.final_url).href;
    const response = await httpFetch(clientUrl, {headers: shell.cookies.length > 0 ? {cookie: shell.cookies.join('; ')} : {}});
    const repo = readFileSync(join(REPO_ROOT, 'bundle', 'client.js'));
    bundle = {
      fetched: true,
      url: redactUrl(clientUrl),
      status: response.status,
      bytes: response.bytes.length,
      sha256: sha256(response.bytes),
      repo_bytes: repo.length,
      exact_prefix: response.bytes.length >= repo.length && response.bytes.subarray(0, repo.length).equals(repo),
    };
  }
  requireCheck('host.client_bundle_bytes', bundle.fetched === true && bundle.status === 200 && bundle.exact_prefix === true, bundle, {layer: 'dsh_host'});
  return {shell, bootManifest, entry, bundle};
}

async function callRpc(boot, cookieHeader, endpoint, payload, rpcId) {
  const body = JSON.stringify({type: 'client-request', rpcId, method: endpoint, payload});
  const response = await httpFetch(new URL(`/code-view/${endpoint}`, boot.url), {
    method: 'POST',
    headers: {'content-type': 'application/json', ...cookieHeader},
    body,
  });
  let parsed = null;
  try { parsed = JSON.parse(response.text); } catch { parsed = null; }
  return {status: response.status, parsed, text: response.text};
}

async function verifyCarriers(boot, facts, bootGraph) {
  const noCookie = await httpFetch(new URL('/code-view/view.status', boot.url), {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({type: 'client-request', rpcId: 'verify-admission-1', method: 'view.status', payload: {}}),
  });
  let admissionEnvelope = null;
  try { admissionEnvelope = JSON.parse(noCookie.text); } catch { admissionEnvelope = null; }
  requireCheck('host.rpc_admission', noCookie.status === 401 || noCookie.status === 403
    || (noCookie.status === 200 && admissionEnvelope?.type === 'server-response'), {
    status: noCookie.status,
    body_head: noCookie.text.slice(0, 200),
    interpretation: noCookie.status === 401 || noCookie.status === 403
      ? 'connection admission refused the cookie-less request (seam active)'
      : 'admitted; carrier answered with an envelope',
  }, {layer: 'dsh_host'});

  const shellCookies = bootGraph?.shell?.cookies ?? [];
  const cookieHeader = shellCookies.length > 0 ? {cookie: shellCookies.join('; ')} : {};
  const status = await callRpc(boot, cookieHeader, 'view.status', {}, 'verify-status-1');
  requireCheck('host.rpc_view_status', status.status === 200 && status.parsed?.result?.ok === true
    && status.parsed?.result?.value?.host?.panel_key === 'dsh-code-reader'
    && status.parsed?.result?.value?.engine?.python === 'available'
    && status.parsed?.result?.value?.capabilities?.scenario_execution === true
    && status.parsed?.result?.value?.capabilities?.run_observation === true
    && status.parsed?.result?.value?.capabilities?.scenario_undo === true
    && status.parsed?.result?.value?.capabilities?.trace_import === true
    && status.parsed?.result?.value?.capabilities?.real_device_dispatch === false
    && status.parsed?.result?.value?.capabilities?.ai_summary === false
    && (status.parsed?.result?.value?.gaps ?? []).map((gap) => gap.code ?? gap).includes('ai_summary')
    && (status.parsed?.result?.value?.gaps ?? []).map((gap) => gap.code ?? gap).includes('real_device_dispatch'), {
    status: status.status,
    capabilities: status.parsed?.result?.value?.capabilities ?? null,
    gaps: (status.parsed?.result?.value?.gaps ?? []).map((gap) => gap.code),
    engine: status.parsed?.result?.value?.engine ?? null,
  }, {layer: 'dsh_host'});

  const listed = await callRpc(boot, cookieHeader, 'view.listSnapshots', {}, 'verify-snapshots-1');
  const workspace = (listed.parsed?.result?.value?.workspaces ?? []).find((row) => row.workspace_id === WORKSPACE_ID);
  const snapshot = (workspace?.snapshots ?? [])[0];
  requireCheck('host.rpc_list_snapshots', listed.parsed?.result?.ok === true && snapshot !== undefined
    && snapshot.status === 'verified' && (facts.snapshot_id === null || snapshot.snapshot_id === facts.snapshot_id), {
    snapshot: snapshot ?? null,
  }, {layer: 'dsh_host'});
  if (snapshot === undefined) return;
  const snapshotId = snapshot.snapshot_id;

  // scenario.listProfiles through the carrier.
  const profiles = await callRpc(boot, cookieHeader, 'scenario.listProfiles', {workspace: WORKSPACE_ID}, 'verify-profiles');
  const profile = (profiles.parsed?.result?.value?.profiles ?? []).find((row) => row.profile_id === PROFILE_ID);
  requireCheck('host.rpc_list_profiles', profiles.parsed?.result?.ok === true && profile !== undefined
    && absolutePathLeakInJson(profiles.text).count === 0, {
    http_status: profiles.status,
    profiles: (profiles.parsed?.result?.value?.profiles ?? []).map((row) => ({profile_id: row.profile_id, module_sha256: row.module_sha256 ?? row.module?.sha256, interface_count: (row.interfaces ?? []).length})),
    error: profiles.parsed?.result?.error ?? null,
  }, {layer: 'dsh_host'});

  // scenario.preview (plan only).
  const preview = await callRpc(boot, cookieHeader, 'scenario.preview', {
    workspace: WORKSPACE_ID, snapshot: snapshotId, profile: PROFILE_ID, scenario: scenarioA(),
  }, 'verify-preview');
  const previewValue = preview.parsed?.result?.value ?? {};
  requireCheck('host.rpc_scenario_preview', preview.parsed?.result?.ok === true
    && typeof (previewValue.plan_id ?? previewValue.plan?.plan_id) === 'string'
    && absolutePathLeakInJson(preview.text).count === 0, {
    http_status: preview.status,
    plan_id: previewValue.plan_id ?? previewValue.plan?.plan_id ?? null,
    steps: (previewValue.steps ?? previewValue.plan?.steps ?? []).length,
    error: preview.parsed?.result?.error ?? null,
  }, {layer: 'dsh_host'});

  // scenario.run A: real isolated Wasm execution + ledger.
  const runA = await callRpc(boot, cookieHeader, 'scenario.run', {
    workspace: WORKSPACE_ID, snapshot: snapshotId, profile: PROFILE_ID, scenario: scenarioA(), expected_generation: 0,
  }, 'verify-run-a');
  const runAValue = runA.parsed?.result?.value ?? {};
  const scenario = runAValue.scenario ?? runAValue;
  const recordsA = scenario.records ?? runAValue.records ?? [];
  const eventsA = recordsA.flatMap((row) => (row.execution_events ?? row.events ?? []).map((event) => event.event));
  const writeRecordA = recordsA.find((row) => (row.execution_events ?? row.events ?? []).some((event) => event.event === 'WRITE'));
  requireCheck('host.rpc_scenario_run_a', runA.parsed?.result?.ok === true
    && recordsA.length === 3
    && JSON.stringify(recordsA.map((row) => row.result)) === JSON.stringify([null, 0, 0])
    && EXPECTED_EVENTS.every((name) => eventsA.includes(name))
    && writeRecordA !== undefined
    && (writeRecordA.affected_resources ?? []).some((resource) => resource.name === 'simulated_doorbell')
    && recordsA.every((row) => /^[0-9a-f]{64}$/.test(row.memory_digest ?? ''))
    && recordsA.every((row) => row.status === 'ok')
    && (scenario.observed === true || runAValue.observed === true)
    && absolutePathLeakInJson(runA.text).count === 0, {
    http_status: runA.status,
    scenario_id: scenario.scenario_id ?? runAValue.scenario_id ?? null,
    generation: scenario.generation ?? runAValue.generation ?? null,
    records: recordsA.map((row) => ({call_id: row.call_id, interface: row.interface, args: row.args, status: row.status, result: row.result, stubbed: row.stubbed, event_count: (row.execution_events ?? row.events ?? []).length, records_digest: row.memory_digest})),
    events: [...new Set(eventsA)],
    write_affects: writeRecordA?.affected_resources ?? null,
    error: runA.parsed?.result?.error ?? null,
  }, {layer: 'dsh_host'});
  const scenarioId = scenario.scenario_id ?? runAValue.scenario_id ?? null;

  // scenario.run B: stub control (-5).
  const runB = await callRpc(boot, cookieHeader, 'scenario.run', {
    workspace: WORKSPACE_ID, snapshot: snapshotId, profile: PROFILE_ID, scenario: scenarioB(), expected_generation: 0,
  }, 'verify-run-b');
  const runBValue = runB.parsed?.result?.value ?? {};
  const recordsB = (runBValue.scenario ?? runBValue).records ?? [];
  const stubRecord = recordsB.find((row) => row.stubbed === true);
  const sendB = recordsB.find((row) => row.interface === 'bus_send');
  const lockEventsB = (sendB?.execution_events ?? sendB?.events ?? []).filter((event) => event.event === 'LOCK');
  requireCheck('host.rpc_scenario_run_b', runB.parsed?.result?.ok === true
    && recordsB.length === 4
    && stubRecord !== undefined && stubRecord.interface === 'set_platform_stub'
    && sendB !== undefined && sendB.result === -5
    && !(sendB.execution_events ?? sendB.events ?? []).some((event) => event.event === 'WRITE')
    && lockEventsB.length >= 2 && lockEventsB[0].a === 1 && lockEventsB[lockEventsB.length - 1].a === 0
    && sendB?.status === 'error', {
    http_status: runB.status,
    records: recordsB.map((row) => ({interface: row.interface, status: row.status, result: row.result, stubbed: row.stubbed})),
    lock_events: lockEventsB,
    error: runB.parsed?.result?.error ?? null,
  }, {layer: 'dsh_host'});

  // scenario.run C: unregistered channel -> -2.
  const runC = await callRpc(boot, cookieHeader, 'scenario.run', {
    workspace: WORKSPACE_ID, snapshot: snapshotId, profile: PROFILE_ID, scenario: scenarioC(), expected_generation: 0,
  }, 'verify-run-c');
  const sendC = ((runC.parsed?.result?.value?.scenario ?? runC.parsed?.result?.value ?? {}).records ?? []).find((row) => row.interface === 'bus_send');
  requireCheck('host.rpc_scenario_run_c', runC.parsed?.result?.ok === true && sendC !== undefined && sendC.result === -2, {
    http_status: runC.status,
    send: sendC ?? null,
    error: runC.parsed?.result?.error ?? null,
  }, {layer: 'dsh_host'});

  // Invalid args -> engine error doc, no new ledger generation.
  const ledgerBefore = await callRpc(boot, cookieHeader, 'scenario.list', {workspace: WORKSPACE_ID}, 'verify-ledger-before');
  const beforeRows = ledgerBefore.parsed?.result?.value?.scenarios ?? ledgerBefore.parsed?.result?.value?.entries ?? [];
  const invalid = await callRpc(boot, cookieHeader, 'scenario.run', {
    workspace: WORKSPACE_ID, snapshot: snapshotId, profile: PROFILE_ID,
    scenario: {generation: 0, stop_on_error: true, steps: [{interface: 'bus_send', args: [4, 48]}]},
    expected_generation: 0,
  }, 'verify-run-invalid');
  const invalidResult = invalid.parsed?.result ?? {};
  const invalidCode = String(invalidResult.value?.error?.code ?? invalidResult.error?.code ?? '');
  const ledgerAfter = await callRpc(boot, cookieHeader, 'scenario.list', {workspace: WORKSPACE_ID}, 'verify-ledger-after');
  const afterRows = ledgerAfter.parsed?.result?.value?.scenarios ?? ledgerAfter.parsed?.result?.value?.entries ?? [];
  requireCheck('host.rpc_invalid_scenario', /INVALID_ARGUMENT|OUT_OF_RANGE|SCOPE_DENIED/.test(invalidCode)
    && afterRows.length === beforeRows.length, {
    http_status: invalid.status,
    code: invalidCode || null,
    result: invalidResult,
    ledger_before: beforeRows.length,
    ledger_after: afterRows.length,
  }, {layer: 'dsh_host'});

  // scenario.list / scenario.get / observed sequence through the carrier.
  const ledger = await callRpc(boot, cookieHeader, 'scenario.list', {workspace: WORKSPACE_ID}, 'verify-ledger');
  const ledgerRows = ledger.parsed?.result?.value?.scenarios ?? ledger.parsed?.result?.value?.entries ?? [];
  requireCheck('host.rpc_scenario_list', ledger.parsed?.result?.ok === true
    && ledgerRows.some((row) => row.scenario_id === scenarioId), {
    http_status: ledger.status,
    scenarios: ledgerRows.map((row) => ({scenario_id: row.scenario_id, generation: row.generation ?? row.current_generation, step_count: row.step_count ?? row.steps, profile_id: row.profile_id})),
  }, {layer: 'dsh_host'});
  const getOne = await callRpc(boot, cookieHeader, 'scenario.get', {workspace: WORKSPACE_ID, scenario: scenarioId}, 'verify-ledger-get');
  const getValue = getOne.parsed?.result?.value ?? {};
  const getScenario = getValue.scenario ?? getValue;
  requireCheck('host.rpc_scenario_get', getOne.parsed?.result?.ok === true
    && (getScenario.records ?? []).length === 3 && getScenario.observed === true, {
    http_status: getOne.status,
    generation: getScenario.generation ?? null,
    record_count: (getScenario.records ?? []).length,
    records_digest: getScenario.records_digest ?? null,
  }, {layer: 'dsh_host'});
  const observed = await callRpc(boot, cookieHeader, 'view.sequence', {
    workspace: WORKSPACE_ID, snapshot: snapshotId, mode: 'observed', scenario: scenarioId,
  }, 'verify-sequence-observed');
  const observedValue = observed.parsed?.result?.value ?? {};
  const messageText = (observedValue.messages ?? []).map((message) => String(message.label ?? '')).join('\n');
  requireCheck('host.rpc_sequence_observed', observed.parsed?.result?.ok === true
    && observedValue.observed === true && observedValue.mode === 'observed'
    && /bus_send\(2,\s*48\)/.test(messageText)
    && (observedValue.messages ?? []).some((message) => message.event === 'DOORBELL')
    && (observedValue.messages ?? []).some((message) => message.event === 'WRITE' || (message.affected_resources ?? []).some((resource) => resource.name === 'simulated_doorbell'))
    && (observedValue.messages ?? []).some((message) => /返回/.test(String(message.label ?? '')) && message.result === 0)
    && (observedValue.messages ?? []).every((message) => message.observed === true)
    && absolutePathLeakInJson(observed.text).count === 0, {
    http_status: observed.status,
    mode: observedValue.mode,
    message_count: (observedValue.messages ?? []).length,
    message_kinds: [...new Set((observedValue.messages ?? []).map((message) => message.kind))],
    error: observed.parsed?.result?.error ?? null,
  }, {layer: 'dsh_host'});
  const staticSequence = await callRpc(boot, cookieHeader, 'view.sequence', {
    workspace: WORKSPACE_ID, snapshot: snapshotId, entry: facts.target?.entry_id ?? null, mode: 'static',
  }, 'verify-sequence-static');
  requireCheck('host.rpc_sequence_static', staticSequence.parsed?.result?.ok === true
    && (staticSequence.parsed?.result?.value?.observed === false), {
    http_status: staticSequence.status,
    mode: staticSequence.parsed?.result?.value?.mode ?? null,
    observed: staticSequence.parsed?.result?.value?.observed ?? null,
  }, {layer: 'dsh_host'});

  return {scenarioId, snapshotId, runA: runAValue, observedValue};
}

// ---------------------------------------------------------------------------
// Chromium probes (S3a + S1/S2a/S2b regression)
// ---------------------------------------------------------------------------
function prepareProbeApp(toolFile, appName, mainFile) {
  const appDir = join(SCRATCH, appName);
  mkdirSync(appDir, {recursive: true});
  copyFileSync(toolFile, join(appDir, mainFile));
  writeFileSync(join(appDir, 'package.json'), `${JSON.stringify({
    name: `dsh-code-reader-${appName}`,
    version: '0.0.0-private',
    private: true,
    description: 'Verifier probe; not a shipped component.',
    main: mainFile,
  }, null, 2)}\n`, 'utf8');
  return appDir;
}

async function runElectronProbe({boot, outPath, env, appDir, logPath, timeoutMs = 600000}) {
  // Unique per invocation: stale singleton locks on a shared user-data dir make
  // Chromium probes start extremely slowly / time out after a hung run.
  const userDataDir = join(SCRATCH, `electron-userdata-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const probeEnv = {...process.env, ...env, RV_URL: boot.url};
  delete probeEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(RENDER_PROBE_ELECTRON, [appDir, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userDataDir}`], {
    cwd: REPO_ROOT, env: probeEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk.toString('utf8'); writeFileSync(logPath, log); });
  child.stderr.on('data', (chunk) => { log += chunk.toString('utf8'); writeFileSync(logPath, log); });
  const exitCode = await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolvePromise(null);
    }, timeoutMs);
    child.once('exit', (code) => { clearTimeout(timer); resolvePromise(code); });
  });
  try { rmSync(userDataDir, {recursive: true, force: true}); } catch { /* best effort */ }
  logCommand({executable: RENDER_PROBE_ELECTRON, args: [appDir, '--no-sandbox', '--disable-gpu'], cwd: REPO_ROOT, exit_code: exitCode});
  const result = existsSync(outPath) ? readJsonFile(outPath) : null;
  return {exitCode, log, result};
}

function copyScreenshots(probeResult, prefix, names) {
  const copied = {};
  mkdirSync(EVIDENCE_DIR, {recursive: true});
  for (const name of names) {
    const record = probeResult?.screenshots?.[name];
    if (record?.path === undefined || !existsSync(record.path)) continue;
    const targetName = `${prefix}-${name}.png`;
    const target = join(EVIDENCE_DIR, targetName);
    copyFileSync(record.path, target);
    copied[name] = {path: `evidence/s3b/${targetName}`, bytes: readFileSync(target).length, sha256: sha256(readFileSync(target))};
  }
  return copied;
}

async function verifyS3Probe(boot, facts) {
  const appDir = prepareProbeApp(S3_PROBE, 's3-probe-app', 's3-probe.cjs');
  mkdirSync(S3_SHOT_DIR, {recursive: true});
  rmSync(S3_PROBE_JSON, {force: true});
  const run = await runElectronProbe({
    boot, appDir,
    outPath: S3_PROBE_JSON,
    env: {
      RV_OUT: S3_PROBE_JSON,
      RV_SHOT_DIR: S3_SHOT_DIR,
      RV_PROFILE_ID: PROFILE_ID,
      ...(facts.snapshot_id === null ? {} : {RV_SNAPSHOT_ID: facts.snapshot_id}),
      RV_TIMEOUT_MS: '540000',
    },
    logPath: join(SCRATCH, 's3-probe.log'),
  });
  const probe = run.result;
  const screenshots = copyScreenshots(probe, 's3', ['stub-run', 'stub-stub', 'sequence-observed', 'main']);
  requireCheck('host.s3_probe', probe !== null && probe.ok === true, {
    exit_code: run.exitCode,
    duration_ms: probe?.duration_ms ?? null,
    failed_steps: probe?.failed_steps ?? [],
    steps: probe?.steps ?? null,
    console_error_count: probe?.console_error_count ?? null,
    screenshots,
    log_tail: run.log.slice(-1800),
  }, {layer: 'dsh_host'});
  requireCheck('host.s3_screenshots', ['stub-run', 'stub-stub', 'sequence-observed', 'main'].every((name) => screenshots[name] !== undefined)
    && new Set(['stub-run', 'stub-stub', 'sequence-observed', 'main'].map((name) => screenshots[name]?.sha256)).size >= 3, {
    required: ['stub-run', 'stub-stub', 'sequence-observed', 'main'],
    copied: screenshots,
    unique_frames: new Set(['stub-run', 'stub-stub', 'sequence-observed', 'main'].map((name) => screenshots[name]?.sha256)).size,
  }, {layer: 'dsh_host'});
  for (const [view, checkName] of Object.entries({
    stubRun: 'host.s3_stub_run',
    observedSequence: 'host.s3_observed_sequence',
    stubChrome: 'host.s3_stub_chrome',
  })) {
    const detail = probe?.views?.[view] ?? null;
    requireCheck(checkName, detail?.ok === true, {
      steps: detail?.steps ?? null,
      detail: detail === null ? null : {
        profile: detail.profile ?? null,
        interfaceOptions: detail.interfaceOptions ?? null,
        steps_built: detail.stateStepsA?.steps ?? null,
        records_a: (detail.recordsA?.records ?? []).map((row) => ({call_id: row.call_id, status: row.status, result: row.result, stubbed: row.stubbed, memory_digest: row.memory_digest, events: (row.events ?? []).map((event) => event.kind), affects: row.affects})),
        events_a: detail.eventsA ?? null,
        stub_record: detail.stubRecord ?? null,
        send_record_b: detail.sendRecordB ?? null,
        lock_events: detail.lockEvents ?? null,
        send_record_c: detail.sendRecordC ?? null,
        invalid_error_codes: detail.invalidState?.error_codes ?? null,
        observed_messages: detail.messages ?? null,
        observed_attr_text: detail.observedAttrText ?? null,
        static_state: detail.staticState ?? null,
        undo: detail.state?.undo ?? null,
        gaps: detail.state?.gaps ?? null,
        selection: detail.selection ?? null,
      },
    }, {layer: 'dsh_host'});
  }
  requireCheck('host.s3_console_clean', (probe?.console_error_count ?? 1) === 0, {
    console_error_count: probe?.console_error_count ?? null,
    console_errors: (probe?.console_lines ?? []).filter((line) => Number(line.level) >= 3).slice(0, 20),
  }, {layer: 'dsh_host'});
  requireCheck('host.s3_no_absolute_paths', (probe?.leak?.count ?? -1) === 0, {leak: probe?.leak ?? null}, {layer: 'dsh_host'});
  return probe;
}

async function verifyS2bRegressionProbe(boot, facts) {
  const appDir = prepareProbeApp(S2B_PROBE, 's2b-probe-app', 's2b-probe.cjs');
  mkdirSync(S2B_SHOT_DIR, {recursive: true});
  rmSync(S2B_PROBE_JSON, {force: true});
  const run = await runElectronProbe({
    boot, appDir, outPath: S2B_PROBE_JSON,
    env: {
      RV_OUT: S2B_PROBE_JSON, RV_SHOT_DIR: S2B_SHOT_DIR,
      RV_ENTRY_NAME: 'bus_send', RV_EXPECT_LINE: String(facts.target?.line ?? 152),
      ...(facts.snapshot_id === null ? {} : {RV_SNAPSHOT_ID: facts.snapshot_id}),
      RV_SUBFLOW_ENTRY: 'check_length', RV_TIMEOUT_MS: '480000',
    },
    logPath: join(SCRATCH, 's2b-regression.log'),
  });
  const probe = run.result;
  const screenshots = copyScreenshots(probe, 's2b', ['groups', 'interfaces', 'subflow', 'main']);
  requireCheck('regression.s2b_probe', probe !== null && probe.ok === true, {
    exit_code: run.exitCode,
    failed_steps: probe?.failed_steps ?? [],
    steps: probe?.steps ?? null,
    console_error_count: probe?.console_error_count ?? null,
    screenshots,
    log_tail: run.log.slice(-1500),
  }, {layer: 'dsh_host'});
  requireCheck('regression.s2b_console_clean', (probe?.console_error_count ?? 1) === 0, {console_error_count: probe?.console_error_count ?? null}, {layer: 'dsh_host'});
  return probe;
}

async function verifyS2aRegressionProbe(boot, facts) {
  const appDir = prepareProbeApp(S2A_PROBE, 's2a-probe-app', 'five-views-probe.cjs');
  mkdirSync(S2A_SHOT_DIR, {recursive: true});
  rmSync(S2A_PROBE_JSON, {force: true});
  const run = await runElectronProbe({
    boot, appDir, outPath: S2A_PROBE_JSON,
    env: {
      RV_OUT: S2A_PROBE_JSON, RV_SHOT_DIR: S2A_SHOT_DIR,
      RV_ENTRY_NAME: 'bus_send', RV_EXPECT_LINE: String(facts.target?.line ?? 152),
      RV_ENTRY_LINES: JSON.stringify(facts.entry_lines ?? {}),
      ...(facts.snapshot_id === null ? {} : {RV_SNAPSHOT_ID: facts.snapshot_id}),
      RV_TIMEOUT_MS: '420000',
    },
    logPath: join(SCRATCH, 's2a-regression.log'),
  });
  const probe = run.result;
  const screenshots = copyScreenshots(probe, 's2a', ['coupling', 'tree', 'end_to_end', 'sequence', 'file', 'main']);
  const views = probe?.views ?? {};
  const couplingIgnored = ['gapsOriginal', 'stubPanel']; // S2b implemented groups/interface-library gaps; S3a replaced the stub placeholder with the real simulation panel
  const couplingFailed = Object.entries(views.coupling?.steps ?? {})
    .filter(([key, value]) => value !== true && !couplingIgnored.includes(key)).map(([key]) => key);
  const otherOk = ['tree', 'end_to_end', 'sequence', 'file'].every((view) => views[view]?.ok === true);
  requireCheck('regression.s2a_probe', probe !== null
    && couplingFailed.length === 0 && otherOk
    && (probe.chrome?.ok === true || Object.entries(probe.chrome?.steps ?? {}).every(([key, value]) => value === true || key === 'gapsVerbatim'))
    && (probe.console_error_count ?? 1) === 0, {
    exit_code: run.exitCode,
    failed_steps: probe?.failed_steps ?? [],
    coupling_failed: couplingFailed,
    coupling_ignored_superseded: couplingIgnored,
    other_views: Object.fromEntries(['tree', 'end_to_end', 'sequence', 'file'].map((view) => [view, views[view]?.ok ?? null])),
    console_error_count: probe?.console_error_count ?? null,
    screenshots,
    log_tail: run.log.slice(-1500),
  }, {layer: 'dsh_host'});
  return probe;
}

async function verifyS1RegressionProbe(boot, facts) {
  mkdirSync(S1_SHOT_DIR, {recursive: true});
  rmSync(S1_PROBE_JSON, {force: true});
  rmSync(S1_PROBE_PNG, {force: true});
  const appDir = prepareProbeApp(S1_PROBE, 's1-probe-app', 'electron-probe.cjs');
  const run = await runElectronProbe({
    boot, appDir, outPath: S1_PROBE_JSON,
    env: {
      RV_OUT: S1_PROBE_JSON, RV_SHOT: S1_PROBE_PNG,
      RV_SHOT2: join(S1_SHOT_DIR, 'render-resources.png'),
      RV_ENTRY_NAME: 'bus_send', RV_EXPECT_LINE: String(facts.target?.line ?? 152),
      ...(facts.snapshot_id === null ? {} : {RV_EXPECT_SNAPSHOT_ID: facts.snapshot_id}),
      RV_WRITE_ENTRY_NAME: 'bus_register', RV_WRITE_EXPECT_LINE: '50',
      RV_TIMEOUT_MS: '300000',
    },
    logPath: join(SCRATCH, 's1-regression.log'),
  });
  const probe = run.result;
  const required = ['pageLoaded', 'sidebarEntry', 'panelOpened', 'snapshotClicked', 'entryListed', 'entryClicked',
    'sourceLineOk', 'sourceBoundsOk', 'evidenceClassesPresent', 'resourcesReadPresent', 'selectionEntrySelected',
    'selectionMatchesClickedEntry', 'returnToChat', 'chatRestored', 'panelReopened', 'reopenedSourceKept',
    'reopenSelectionKept', 'writeEntryClicked', 'writeSourceLineOk', 'writeExactResource', 'writeSelectionEntry',
    'noConsoleErrors', 'screenshotCaptured'];
  const failed = required.filter((step) => (probe?.steps ?? {})[step] !== true);
  const screenshot = {};
  if (existsSync(S1_PROBE_PNG)) {
    copyFileSync(S1_PROBE_PNG, join(EVIDENCE_DIR, 's1-regression.png'));
    screenshot.path = 'evidence/s3b/s1-regression.png';
    screenshot.bytes = readFileSync(join(EVIDENCE_DIR, 's1-regression.png')).length;
    screenshot.sha256 = sha256(readFileSync(join(EVIDENCE_DIR, 's1-regression.png')));
  }
  requireCheck('regression.s1_probe', probe !== null && failed.length === 0 && (probe.console_error_count ?? 1) === 0, {
    exit_code: run.exitCode,
    required_steps: required,
    failed_steps: failed,
    console_error_count: probe?.console_error_count ?? null,
    screenshot,
    log_tail: run.log.slice(-1500),
  }, {layer: 'dsh_host'});
  return probe;
}

// ---------------------------------------------------------------------------
// Real Cordis host runtime (S3a scenario.run with real Wasm)
// ---------------------------------------------------------------------------
function runHostRuntime({python, home, bootstrapPath, facts}) {
  mkdirSync(EVIDENCE_DIR, {recursive: true});
  rmSync(HOST_RUNTIME_TAP, {force: true});
  rmSync(HOST_RUNTIME_JSON, {force: true});
  const env = isolatedEnv({
    python,
    home,
    extra: {
      ELECTRON_RUN_AS_NODE: '1',
      CODE_READER_BOOTSTRAP: bootstrapPath,
      READONLY_WORKSPACE_ID: WORKSPACE_ID,
      READONLY_ENTRY_NAME: 'bus_send',
      READONLY_ENTRY_LINE: String(facts.target?.line ?? 152),
      ...(facts.snapshot_id === null ? {} : {READONLY_SNAPSHOT_ID: facts.snapshot_id}),
      SCENARIO_PROFILE_ID: PROFILE_ID,
      DSH_AUDIT_APPLICATION: '04-s3a-verifier',
    },
  });
  const args = ['--test', '--test-concurrency=1', '--test-reporter=tap', `--test-reporter-destination=${HOST_RUNTIME_TAP}`, HOST_RUNTIME_TEST];
  const started = Date.now();
  const result = spawnSync(EXECUTABLE, args, {cwd: REPO_ROOT, env, windowsHide: true, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024});
  logCommand({executable: EXECUTABLE, args, cwd: REPO_ROOT, exit_code: result.status});
  let tapText = '';
  try { tapText = readFileSync(HOST_RUNTIME_TAP, 'utf8'); } catch { tapText = ''; }
  const summary = tapSummary(tapText);
  const reportValue = {
    schema_version: 1,
    layer: 'dsh_host',
    started_at_utc: new Date(started).toISOString(),
    duration_ms: Date.now() - started,
    host: HOST_BASELINE,
    command: {executable: EXECUTABLE, args, env_subset: {ELECTRON_RUN_AS_NODE: env.ELECTRON_RUN_AS_NODE, DSH_HOME: env.DSH_HOME, CODE_READER_BOOTSTRAP: env.CODE_READER_BOOTSTRAP}},
    isolated_home: home,
    exit_code: result.status,
    timed_out: result.error?.code === 'ETIMEDOUT',
    tap_summary: summary,
    tap_sha256: tapText === '' ? null : sha256(tapText),
    stdout_tail: (result.stdout ?? '').slice(-12000),
    stderr_tail: (result.stderr ?? '').slice(-12000),
    ok: result.status === 0 && summary.fail === 0 && summary.tests !== null && summary.tests === summary.pass,
  };
  reportValue.verified = reportValue.ok;
  writeFileSync(HOST_RUNTIME_JSON, `${JSON.stringify(reportValue, null, 2)}\n`, 'utf8');
  return reportValue;
}

// ---------------------------------------------------------------------------
// Demo layer + repo tests
// ---------------------------------------------------------------------------
function verifyDemo() {
  const result = runNodeTests(['demo/code-view/demo.test.cjs'], {timeoutMs: 180000});
  const ok = result.status === 0 && result.summary.fail === 0 && result.summary.tests !== null && result.summary.tests > 0;
  requireCheck('demo.code_view_demo_tests', ok, {
    command: 'node --test demo/code-view/demo.test.cjs', status: result.status, summary: result.summary, output_tail: result.text.slice(-2000),
  }, {layer: 'demo_observed'});
  return {status: result.status, summary: result.summary};
}

function verifyRepoNodeTests() {
  const testsDir = join(REPO_ROOT, 'tests', 'node');
  const files = readdirSync(testsDir).filter((name) => name.endsWith('.test.mjs')).map((name) => `tests/node/${name}`);
  const result = runNodeTests(files, {timeoutMs: 420000});
  const ok = result.status === 0 && result.summary.fail === 0 && result.summary.tests !== null && result.summary.tests > 0;
  requireCheck('dsh_host.repo_node_tests', ok, {files, status: result.status, summary: result.summary, output_tail: result.text.slice(-3000)}, {layer: 'dsh_host'});
  return {status: result.status, summary: result.summary};
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// S3b: atlas layer — trace import CLI + undo plan (real engine, no execution)
// ---------------------------------------------------------------------------
async function verifyAtlasS3b(python, inbox, snapshotId) {
  const importResult = cli(python, [
    'trace-import', '--workspace', WORKSPACE_ID, '--snapshot', snapshotId,
    '--input', TRACE_FILE, '--operation-id', crypto.randomUUID(),
  ], inbox.bootstrapPath);
  const imported = importResult.stdout_json ?? {};
  const importedValue = imported.scenario ?? imported;
  const records = importedValue.records ?? [];
  const scenarioId = importedValue.scenario_id ?? null;
  requireCheck('atlas.trace_import', importResult.ok
    && importedValue.imported === true
    && importedValue.source === 'imported_trace'
    && typeof importedValue.label === 'string' && importedValue.label.length > 0
    && typeof scenarioId === 'string' && scenarioId.startsWith('scn_')
    && records.length === 3
    && records.every((row) => typeof row.call_id === 'string' && row.status === 'ok')
    && (importedValue.limitations ?? []).includes('imported_trace_not_executed_by_host')
    && importedValue.observed === true
    && absolutePathLeakInJson(imported).count === 0, {
    command: 'trace-import --workspace code-view-bus-demo --snapshot <snapshot> --input trace-bus-send.json --operation-id <uuid>',
    scenario_id: scenarioId,
    generation: importedValue.generation ?? null,
    label: importedValue.label ?? null,
    source: importedValue.source ?? null,
    imported: importedValue.imported ?? null,
    record_count: records.length,
    limitations: importedValue.limitations ?? null,
    records_digest: importedValue.records_digest ?? null,
    error: importResult.ok ? null : (importResult.stdout_json?.error ?? importResult.stderr_tail),
  }, {layer: 'atlas_snapshot'});

  const second = cli(python, [
    'trace-import', '--workspace', WORKSPACE_ID, '--snapshot', snapshotId,
    '--input', TRACE_FILE, '--operation-id', crypto.randomUUID(),
  ], inbox.bootstrapPath);
  const secondValue = (second.stdout_json?.scenario ?? second.stdout_json) ?? {};
  requireCheck('atlas.trace_import_idempotent', second.ok
    && secondValue.scenario_id === scenarioId
    && Number(secondValue.generation) === Number(importedValue.generation), {
    scenario_id: secondValue.scenario_id ?? null,
    generation: secondValue.generation ?? null,
    first_generation: importedValue.generation ?? null,
    error: second.ok ? null : (second.stdout_json?.error ?? second.stderr_tail),
  }, {layer: 'atlas_snapshot'});

  let observedValue = {};
  if (scenarioId !== null) {
    const observed = cli(python, ['view-sequence-observed', '--workspace', WORKSPACE_ID, '--scenario', scenarioId], inbox.bootstrapPath);
    observedValue = observed.stdout_json ?? {};
    const messageText = (observedValue.messages ?? []).map((message) => String(message.label ?? '')).join('\n');
    requireCheck('atlas.trace_observed', observed.ok
      && observedValue.observed === true
      && observedValue.imported === true
      && /bus_send\(1,\s*48\)/.test(messageText)
      && /DOORBELL/.test(messageText) && /WRITE/.test(messageText)
      && /返回\s*0|return\s*0/.test(messageText)
      && absolutePathLeakInJson(observedValue).count === 0, {
      command: 'view-sequence-observed --workspace code-view-bus-demo --scenario <imported id>',
      scenario: observedValue.scenario ?? null,
      observed: observedValue.observed ?? null,
      imported: observedValue.imported ?? null,
      message_count: (observedValue.messages ?? []).length,
      limitations: observedValue.limitations ?? null,
      error: observed.ok ? null : (observed.stdout_json?.error ?? observed.stderr_tail),
    }, {layer: 'atlas_snapshot'});
  } else {
    record('atlas.trace_observed', false, {error: 'trace-import failed; observed skipped'}, {layer: 'atlas_snapshot'});
  }

  // Undo must be unavailable for imported ledgers.
  let importedUndo = {ok: false};
  if (scenarioId !== null) {
    const undo = cli(python, [
      'scenario-undo-plan', '--workspace', WORKSPACE_ID, '--scenario', scenarioId,
      '--count', '1', '--expected-generation', String(importedValue.generation ?? 1),
    ], inbox.bootstrapPath);
    const code = undo.stdout_json?.error?.code ?? null;
    importedUndo = {exit_code: undo.exit_code, code, error: undo.stdout_json?.error ?? null, ok: undo.ok === false && /CAPABILITY_UNAVAILABLE|SCOPE_DENIED|INVALID_ARGUMENT|OUTCOME/.test(String(code))};
  }
  requireCheck('atlas.undo_plan_imported_rejected', importedUndo.ok === true, {
    command: 'scenario-undo-plan --workspace code-view-bus-demo --scenario <imported id> --count 1 --expected-generation <gen>',
    ...importedUndo,
  }, {layer: 'atlas_snapshot'});
  return {scenarioId, generation: importedValue.generation ?? null, importedValue, observedValue};
}

// ---------------------------------------------------------------------------
// S3b: atlas layer — undo plan projection for an executable ledger
// ---------------------------------------------------------------------------
async function verifyAtlasUndoPlan(python, inbox, s3bCarriers) {
  let planValue = {};
  let planCheck = {ok: false};
  const sourceId = s3bCarriers?.sourceScenarioId ?? null;
  const sourceGen = s3bCarriers?.sourceGeneration ?? null;
  if (sourceId !== null && sourceGen !== null) {
    const plan = cli(python, [
      'scenario-undo-plan', '--workspace', WORKSPACE_ID, '--scenario', sourceId,
      '--count', '1', '--expected-generation', String(sourceGen),
    ], inbox.bootstrapPath);
    planValue = plan.stdout_json ?? {};
    const source = planValue.source ?? {};
    const prefix = planValue.prefix ?? {};
    planCheck = {
      ok: plan.ok
        && planValue.kind === 'undo'
        && typeof planValue.undo_plan_id === 'string'
        && Number(planValue.count) === 1
        && Number(source.step_count) === 3
        && Number(prefix.step_count) === 2
        && (prefix.steps ?? []).length === 2
        && (planValue.expected_prefix ?? []).length === 2
        && (planValue.expected_prefix ?? []).every((row) => /^[0-9a-f]{64}$/.test(row.memory_digest ?? ''))
        && absolutePathLeakInJson(planValue).count === 0,
      exit_code: plan.exit_code,
      undo_plan_id: planValue.undo_plan_id ?? null,
      source: planValue.source ?? null,
      count: planValue.count ?? null,
      prefix: planValue.prefix ?? null,
      expected_prefix: planValue.expected_prefix ?? null,
      error: plan.ok ? null : (plan.stdout_json?.error ?? plan.stderr_tail),
    };
  }
  requireCheck('atlas.undo_plan', planCheck.ok === true, {
    command: 'scenario-undo-plan --workspace code-view-bus-demo --scenario <source> --count 1 --expected-generation <G>',
    ...planCheck,
  }, {layer: 'atlas_snapshot'});
}

// ---------------------------------------------------------------------------
// S3b: dsh-web carriers — scenario.undoTail / trace.import / multi-scenario view
// ---------------------------------------------------------------------------
async function verifyS3bCarriers(boot, bootGraph, facts, s3aCarriers) {
  const cookies = bootGraph?.shell?.cookies ?? [];
  const cookieHeader = cookies.length > 0 ? {cookie: cookies.join('; ')} : {};
  const snapshotId = s3aCarriers?.snapshotId ?? facts.snapshot_id;
  const sourceScenarioId = s3aCarriers?.scenarioId ?? null;
  const runAValue = s3aCarriers?.runA ?? {};
  const sourceGeneration = Number(runAValue.generation ?? (runAValue.scenario?.generation) ?? 1);

  // Source ledger records (entity for prefix digest comparison).
  const sourceGet = await callRpc(boot, cookieHeader, 'scenario.get', {workspace: WORKSPACE_ID, scenario: sourceScenarioId}, 'verify-s3b-source-get');
  const sourceLedger = sourceGet.parsed?.result?.value?.scenario ?? sourceGet.parsed?.result?.value ?? {};
  const sourceRecords = sourceLedger.records ?? [];

  // --- undo tail: replay the 2-step prefix with the real Wasm worker ---------
  const undoTail = await callRpc(boot, cookieHeader, 'scenario.undoTail', {
    workspace: WORKSPACE_ID, scenario: sourceScenarioId, count: 1, expected_generation: sourceGeneration,
  }, 'verify-s3b-undo-tail');
  const undoValue = undoTail.parsed?.result?.value ?? {};
  const undoRecords = undoValue.records ?? [];
  const undoMeta = undoValue.undo ?? {};
  const undoPrefixId = undoValue.scenario_id ?? null;
  requireCheck('host.rpc_undo_tail', undoTail.parsed?.result?.ok === true
    && undoRecords.length === 2
    && sourceRecords.length === 3
    && undoRecords.every((row, index) => row.memory_digest === sourceRecords[index]?.memory_digest
      && row.call_id === sourceRecords[index]?.call_id)
    && undoMeta.count === 1
    && undoMeta.state_digest_verified === true
    && undoMeta.of_scenario_id === sourceScenarioId
    && undoPrefixId !== null && undoPrefixId !== sourceScenarioId
    && absolutePathLeakInJson(undoTail.text).count === 0, {
    http_status: undoTail.status,
    scenario_id: undoPrefixId,
    generation: undoValue.generation ?? null,
    step_count: undoRecords.length,
    undo: undoMeta,
    source: {scenario_id: sourceScenarioId, generation: sourceGeneration, step_count: sourceRecords.length},
    prefix_records: undoRecords.map((row) => ({call_id: row.call_id, memory_digest: row.memory_digest, result: row.result, status: row.status})),
    error: undoTail.parsed?.result?.error ?? null,
  }, {layer: 'dsh_host'});

  // --- undo is unavailable / rejects bad counts -------------------------------
  const ledgerBefore = await callRpc(boot, cookieHeader, 'scenario.list', {workspace: WORKSPACE_ID}, 'verify-s3b-undo-invalid-before');
  const beforeRows = ledgerBefore.parsed?.result?.value?.scenarios ?? [];
  const invalidUndo = await callRpc(boot, cookieHeader, 'scenario.undoTail', {
    workspace: WORKSPACE_ID, scenario: sourceScenarioId, count: 99, expected_generation: sourceGeneration,
  }, 'verify-s3b-undo-invalid');
  const invalidUndoValue = invalidUndo.parsed?.result?.value ?? {};
  const invalidUndoCode = String(invalidUndoValue?.error?.code ?? invalidUndo.parsed?.result?.error?.code ?? '');
  const ledgerAfter = await callRpc(boot, cookieHeader, 'scenario.list', {workspace: WORKSPACE_ID}, 'verify-s3b-undo-invalid-after');
  const afterRows = ledgerAfter.parsed?.result?.value?.scenarios ?? [];
  requireCheck('host.rpc_undo_invalid_count', /INVALID_ARGUMENT|OUT_OF_RANGE|SCOPE_DENIED|STATE_CONFLICT/.test(invalidUndoCode)
    && afterRows.length === beforeRows.length, {
    http_status: invalidUndo.status,
    code: invalidUndoCode || null,
    value: invalidUndoValue,
    ledger_before: beforeRows.length,
    ledger_after: afterRows.length,
  }, {layer: 'dsh_host'});

  // --- trace.import through the carrier (real engine, no execution) ----------
  const traceImport = await callRpc(boot, cookieHeader, 'trace.import', {
    workspace: WORKSPACE_ID, snapshot: snapshotId, input: TRACE_FILE,
  }, 'verify-s3b-trace-import');
  const traceValue = traceImport.parsed?.result?.value ?? {};
  const importedScenarioId = traceValue.scenario_id ?? null;
  requireCheck('host.rpc_trace_import', traceImport.parsed?.result?.ok === true
    && traceValue.imported === true
    && traceValue.source === 'imported_trace'
    && typeof traceValue.label === 'string'
    && (traceValue.records ?? []).length === 3
    && (traceValue.limitations ?? []).includes('imported_trace_not_executed_by_host')
    && absolutePathLeakInJson(traceImport.text).count === 0, {
    http_status: traceImport.status,
    scenario_id: importedScenarioId,
    generation: traceValue.generation ?? null,
    label: traceValue.label ?? null,
    record_count: (traceValue.records ?? []).length,
    limitations: traceValue.limitations ?? null,
    error: traceImport.parsed?.result?.error ?? null,
  }, {layer: 'dsh_host'});
  const traceAgain = await callRpc(boot, cookieHeader, 'trace.import', {
    workspace: WORKSPACE_ID, snapshot: snapshotId, input: TRACE_FILE,
  }, 'verify-s3b-trace-import-again');
  const traceAgainValue = traceAgain.parsed?.result?.value ?? {};
  requireCheck('host.rpc_trace_import_idempotent', traceAgain.parsed?.result?.ok === true
    && traceAgainValue.scenario_id === importedScenarioId
    && Number(traceAgainValue.generation) === Number(traceValue.generation), {
    scenario_id: traceAgainValue.scenario_id ?? null,
    generation: traceAgainValue.generation ?? null,
    first_generation: traceValue.generation ?? null,
  }, {layer: 'dsh_host'});

  // --- undo rejected for imported ledger --------------------------------------
  const importedUndo = await callRpc(boot, cookieHeader, 'scenario.undoTail', {
    workspace: WORKSPACE_ID, scenario: importedScenarioId, count: 1, expected_generation: Number(traceValue.generation ?? 1),
  }, 'verify-s3b-undo-imported');
  const importedUndoValue = importedUndo.parsed?.result?.value ?? {};
  const importedUndoCode = String(importedUndoValue?.error?.code ?? importedUndo.parsed?.result?.error?.code ?? '');
  requireCheck('host.rpc_undo_imported_rejected', /CAPABILITY_UNAVAILABLE|SCOPE_DENIED|INVALID_ARGUMENT|STATE_CONFLICT/.test(importedUndoCode), {
    http_status: importedUndo.status,
    code: importedUndoCode || null,
    value: importedUndoValue,
  }, {layer: 'dsh_host'});

  // --- observed multi-scenario: prefix vs imported ----------------------------
  const observedPrefix = await callRpc(boot, cookieHeader, 'view.sequence', {
    workspace: WORKSPACE_ID, snapshot: snapshotId, mode: 'observed', scenario: undoPrefixId,
  }, 'verify-s3b-observed-prefix');
  const observedPrefixValue = observedPrefix.parsed?.result?.value ?? {};
  const observedImported = await callRpc(boot, cookieHeader, 'view.sequence', {
    workspace: WORKSPACE_ID, snapshot: snapshotId, mode: 'observed', scenario: importedScenarioId,
  }, 'verify-s3b-observed-imported');
  const observedImportedValue = observedImported.parsed?.result?.value ?? {};
  const importedText = (observedImportedValue.messages ?? []).map((message) => String(message.label ?? '')).join('\n');
  requireCheck('host.rpc_sequence_multiscenario', observedPrefix.parsed?.result?.ok === true
    && scenarioRefId(observedPrefixValue) === undoPrefixId
    && observedPrefixValue.observed === true
    && (observedPrefixValue.messages ?? []).length > 0
    && observedImported.parsed?.result?.ok === true
    && scenarioRefId(observedImportedValue) === importedScenarioId
    && observedImportedValue.observed === true
    && observedImportedValue.imported === true
    && /bus_send\(1,\s*48\)/.test(importedText)
    && /DOORBELL/.test(importedText) && /WRITE/.test(importedText)
    && /返回\s*0|return\s*0/.test(importedText)
    && offsetOfSequenceIsDistinct(observedPrefixValue, observedImportedValue), {
    prefix: {scenario: observedPrefixValue.scenario ?? null, observed: observedPrefixValue.observed ?? null, messages: (observedPrefixValue.messages ?? []).length},
    imported: {scenario: observedImportedValue.scenario ?? null, observed: observedImportedValue.observed ?? null, imported: observedImportedValue.imported ?? null, label: observedImportedValue.label ?? null, messages: (observedImportedValue.messages ?? []).length},
    imported_limitations: observedImportedValue.limitations ?? null,
    error: observedImported.parsed?.result?.error ?? null,
  }, {layer: 'dsh_host'});

  // --- prefix rerun: generation increments -----------------------------------
  const prefixRerun = await callRpc(boot, cookieHeader, 'scenario.run', {
    workspace: WORKSPACE_ID, snapshot: snapshotId, profile: PROFILE_ID,
    scenario: {
      generation: Number(undoValue.generation ?? 1), stop_on_error: true,
      steps: [{interface: 'reset', args: []}, {interface: 'bus_register', args: [2]}],
    },
    expected_generation: Number(undoValue.generation ?? 1),
  }, 'verify-s3b-prefix-rerun');
  const prefixRerunValue = prefixRerun.parsed?.result?.value ?? {};
  requireCheck('host.rpc_prefix_rerun_generation', prefixRerun.parsed?.result?.ok === true
    && Number(prefixRerunValue.generation) === Number(undoValue.generation ?? 1) + 1, {
    http_status: prefixRerun.status,
    generation: prefixRerunValue.generation ?? null,
    previous_generation: undoValue.generation ?? null,
    error: prefixRerun.parsed?.result?.error ?? null,
  }, {layer: 'dsh_host'});
  return {
    sourceScenarioId, sourceGeneration, prefixScenarioId: undoPrefixId, prefixGeneration: undoValue.generation ?? null,
    importedScenarioId, importedGeneration: traceValue.generation ?? null,
    undoMeta, undoRecords: undoRecords.length, sourceRecords: sourceRecords.length,
  };
}

function scenarioRefId(value) {
  const ref = value?.scenario;
  if (typeof ref === 'string') return ref;
  return ref?.scenario_id ?? null;
}

function offsetOfSequenceIsDistinct(prefixValue, importedValue) {
  return scenarioRefId(prefixValue) !== scenarioRefId(importedValue);
}

// ---------------------------------------------------------------------------
// S3b: Chromium probe (undo / trace import / observed selector)
// ---------------------------------------------------------------------------
async function verifyS3bProbe(boot, facts) {
  const appDir = prepareProbeApp(S3B_PROBE, 's3b-probe-app', 's3b-probe.cjs');
  const shotDir = join(SCRATCH, 's3b-shots');
  mkdirSync(shotDir, {recursive: true});
  rmSync(S3_PROBE_JSON, {force: true});
  const run = await runElectronProbe({
    boot, appDir, outPath: S3_PROBE_JSON,
    env: {
      RV_OUT: S3_PROBE_JSON,
      RV_SHOT_DIR: shotDir,
      RV_PROFILE_ID: PROFILE_ID,
      ...(facts.snapshot_id === null ? {} : {RV_SNAPSHOT_ID: facts.snapshot_id}),
      RV_TRACE_FILE: TRACE_FILE,
      RV_TIMEOUT_MS: '540000',
    },
    logPath: join(SCRATCH, 's3b-probe.log'),
  });
  const probe = run.result;
  const screenshots = copyScreenshots(probe, 's3b', ['undo', 'imported', 'observed-scenario', 'main']);
  requireCheck('host.s3b_probe', probe !== null && probe.ok === true, {
    exit_code: run.exitCode,
    duration_ms: probe?.duration_ms ?? null,
    failed_steps: probe?.failed_steps ?? [],
    steps: probe?.steps ?? null,
    console_error_count: probe?.console_error_count ?? null,
    screenshots,
    log_tail: run.log.slice(-1800),
  }, {layer: 'dsh_host'});
  requireCheck('host.s3b_screenshots', ['undo', 'imported', 'observed-scenario', 'main'].every((name) => screenshots[name] !== undefined)
    && new Set(['undo', 'imported', 'observed-scenario', 'main'].map((name) => screenshots[name]?.sha256)).size >= 3, {
    required: ['undo', 'imported', 'observed-scenario', 'main'],
    copied: screenshots,
    unique_frames: new Set(['undo', 'imported', 'observed-scenario', 'main'].map((name) => screenshots[name]?.sha256)).size,
  }, {layer: 'dsh_host'});
  for (const [view, checkName] of Object.entries({
    undo: 'host.s3b_undo',
    traceImport: 'host.s3b_trace_import',
    observedScenarios: 'host.s3b_observed_scenarios',
    chrome: 'host.s3b_chrome',
  })) {
    const detail = probe?.views?.[view] ?? null;
    requireCheck(checkName, detail?.ok === true, {steps: detail?.steps ?? null, detail: detail === null ? null : {
      source: detail.sourceA ?? null,
      undo: {after: detail.afterUndo ? {records: detail.afterUndo.records, steps: detail.afterUndo.steps, ids: detail.afterUndo.ids, scenario_selector: detail.afterUndo.scenario_selector} : null, prefixScenarioId: detail.prefixScenarioId ?? null, status: detail.undoDone ?? null, replayed: detail.replayed ?? null, rerunPrefix: detail.rerunPrefix ?? null, invalidUndoStatus: detail.invalidUndoStatus ?? null},
      traceImport: detail.afterImport ? {ids: detail.afterImport.ids, text: detail.afterImport.text?.slice(0, 2000), importedScenarioId: detail.importedScenarioId ?? null, importDone: detail.importDone ?? null, selection: detail.afterImport.selection} : null,
      observed: detail.state ? {selector: detail.selector, options: detail.options, importedOption: detail.importedOption, importedId: detail.importedId, importedState: detail.importedState ? {sequence_text: detail.importedState.sequence_text?.slice(0, 3000), selection: detail.importedState.selection, imported_marker: detail.importedState.imported_marker} : null, prefixState: detail.prefixState ?? null} : null,
      chrome: detail.state ? {undo: detail.state.undo_button, undoStatus: detail.state.undo_status, trace: detail.state.trace_status} : null,
    }}, {layer: 'dsh_host'});
  }
  requireCheck('host.s3b_console_clean', (probe?.console_error_count ?? 1) === 0, {
    console_error_count: probe?.console_error_count ?? null,
    console_errors: (probe?.console_lines ?? []).filter((line) => Number(line.level) >= 3).slice(0, 20),
  }, {layer: 'dsh_host'});
  requireCheck('host.s3b_no_absolute_paths', (probe?.leak?.count ?? -1) === 0, {leak: probe?.leak ?? null}, {layer: 'dsh_host'});
  return probe;
}

// ---------------------------------------------------------------------------
// S3b regression: S3a probe on a disjoint scenario channel (env override)
// ---------------------------------------------------------------------------
async function verifyS3aRegressionProbe(boot, facts) {
  const appDir = prepareProbeApp(S3_PROBE, 's3a-regression-app', 's3-probe.cjs');
  const shotDir = join(SCRATCH, 's3a-regression-shots');
  const outPath = join(SCRATCH, 's3a-regression-probe.json');
  mkdirSync(shotDir, {recursive: true});
  rmSync(outPath, {force: true});
  const run = await runElectronProbe({
    boot, appDir, outPath,
    env: {
      RV_OUT: outPath, RV_SHOT_DIR: shotDir, RV_PROFILE_ID: PROFILE_ID,
      RV_SCENARIO_CHANNEL: '3',
      ...(facts.snapshot_id === null ? {} : {RV_SNAPSHOT_ID: facts.snapshot_id}),
      RV_TIMEOUT_MS: '540000',
    },
    logPath: join(SCRATCH, 's3a-regression-probe.log'),
  });
  const probe = run.result;
  const screenshots = copyScreenshots(probe, 's3a-regression', ['stub-run', 'stub-stub', 'sequence-observed', 'main']);
  // S3b legitimately supersedes the S3a gap assertions: scenario undo / trace import
  // are now implemented (host caps true), so the old "S3b gap" checks do not apply.
  const s3aIgnoredSuperseded = ['s3bGap', 'traceImportGap', 'capabilityGaps', 'undoDisabled'];
  const s3aResidual = [];
  for (const [view, detail] of Object.entries(probe?.views ?? {})) {
    for (const [step, value] of Object.entries(detail?.steps ?? {})) {
      if (value !== true && !s3aIgnoredSuperseded.includes(step)) s3aResidual.push(`${view}.${step}`);
    }
  }
  requireCheck('host.s3a_regression_probe', probe !== null
    && (s3aResidual.length === 0)
    && (probe.console_error_count ?? 1) === 0, {
    exit_code: run.exitCode,
    failed_steps: probe?.failed_steps ?? [],
    residual_failed_steps: s3aResidual,
    ignored_superseded: s3aIgnoredSuperseded,
    steps: probe?.steps ?? null,
    console_error_count: probe?.console_error_count ?? null,
    screenshots,
    log_tail: run.log.slice(-1500),
  }, {layer: 'dsh_host'});
  requireCheck('host.s3a_regression_console_clean', (probe?.console_error_count ?? 1) === 0, {
    console_error_count: probe?.console_error_count ?? null,
  }, {layer: 'dsh_host'});
  return probe;
}

// ---------------------------------------------------------------------------
// S4-prep AI summary: engine CLI writes (simulated Agent) + real dsh-web probe
// ---------------------------------------------------------------------------
const SUMMARY_TEXT = 'bus_send 先校验通道与长度，再查路由表；长度上限取 route->max_len，超长返回 -22。'
  + '实现以 trace(REQUEST) 记录入口，成功后 doorbell 写回平台边界。此归纳基于静态结构与源码文本，未含运行观测。';

function summaryEvidenceId(python, inbox, snapshotId) {
  const e2e = cli(python, ['view-end-to-end', '--workspace', WORKSPACE_ID, '--snapshot', snapshotId, '--entry', 'f_afa8298f2d197e5fd110e49a'], inbox.bootstrapPath);
  const text = JSON.stringify(e2e.stdout_json ?? {});
  const match = /e_[0-9a-f]{16,24}/.exec(text);
  return match === null ? 'e_231505a73a485bc1d8c9249d' : match[0];
}

function summaryGroupId(python, inbox, snapshotId) {
  const e2e = cli(python, ['view-end-to-end', '--workspace', WORKSPACE_ID, '--snapshot', snapshotId, '--entry', 'f_afa8298f2d197e5fd110e49a'], inbox.bootstrapPath);
  const groups = e2e.stdout_json?.groups ?? e2e.stdout_json?.payload?.groups ?? [];
  const id = groups?.[0]?.group_id ?? null;
  return typeof id === 'string' && id.startsWith('group:') ? id : 'group:f_ec61140249f393550eb97946:294d40d8';
}

/** Run summary-put / view-summary through the real engine CLI, including the
 * invalid payload cases (over-long text, control character, invalid facts). */
async function verifySummaryEngine(python, inbox, snapshotId) {
  const detail = {ok: false, steps: {}};
  const evidenceId = summaryEvidenceId(python, inbox, snapshotId);
  const groupId = summaryGroupId(python, inbox, snapshotId);
  detail.evidenceId = evidenceId;
  detail.groupId = groupId;
  const putPayload = {
    subject: {type: 'function', id: 'f_afa8298f2d197e5fd110e49a'},
    text: SUMMARY_TEXT,
    facts: [{kind: 'evidence', ref: evidenceId}],
    generator: {kind: 'agent', ref: 'verify-summary'},
    inference_labels: ['from_static_structure'],
  };
  const put = cli(python, ['summary-put', '--workspace', WORKSPACE_ID, '--snapshot', snapshotId, '--payload-json', b64(putPayload)], inbox.bootstrapPath);
  const projection = put.stdout_json?.summary ?? put.stdout_json ?? {};
  detail.put = {exit_code: put.exit_code, projection};
  detail.steps.putOk = put.ok
    && projection?.subject?.id === 'f_afa8298f2d197e5fd110e49a'
    && projection?.text === SUMMARY_TEXT
    && projection?.stale === false
    && /^20\d\d-\d\d-\d\dT/.test(projection?.generated_at ?? '')
    && (projection?.facts ?? []).some((fact) => fact.ref === evidenceId)
    && projection?.generator?.kind === 'agent' && projection?.generator?.ref === 'verify-summary'
    && absolutePathLeakInJson(projection).count === 0;

  const view = cli(python, ['view-summary', '--workspace', WORKSPACE_ID, '--snapshot', snapshotId], inbox.bootstrapPath);
  const viewValue = view.stdout_json ?? {};
  const summaries = viewValue.summaries ?? [];
  const row = summaries.find((entry) => entry?.subject?.id === 'f_afa8298f2d197e5fd110e49a');
  detail.view = {exit_code: view.exit_code, stale_count: viewValue.stale_count ?? null, summary_count: summaries.length, row};
  detail.steps.viewOk = view.ok && row !== undefined && row.stale === false
    && row.text === SUMMARY_TEXT && (row.facts ?? []).length >= 1
    && absolutePathLeakInJson(viewValue).count === 0;

  // invalid payload variants must be rejected and must not replace the valid summary
  const invalidCases = [
    ['text_too_long', {...putPayload, text: 'A'.repeat(501)}],
    ['control_char', {...putPayload, text: 'bad\u0001text'}],
    ['facts_invalid', {...putPayload, facts: [{kind: 'evidence', ref: '../etc/passwd'}]}],
  ];
  detail.invalid = [];
  for (const [name, payload] of invalidCases) {
    const result = cli(python, ['summary-put', '--workspace', WORKSPACE_ID, '--snapshot', snapshotId, '--payload-json', b64(payload)], inbox.bootstrapPath);
    const code = result.stdout_json?.error?.code ?? null;
    detail.invalid.push({name, exit_code: result.exit_code, code, rejected: result.ok === false && /INVALID_ARGUMENT|LIMIT_EXCEEDED|SCOPE_DENIED/.test(String(code))});
  }
  detail.steps.invalidRejected = detail.invalid.every((row) => row.rejected === true);
  const afterInvalid = cli(python, ['view-summary', '--workspace', WORKSPACE_ID, '--snapshot', snapshotId], inbox.bootstrapPath);
  const afterRows = afterInvalid.stdout_json?.summaries ?? [];
  const afterRow = afterRows.find((entry) => entry?.subject?.id === 'f_afa8298f2d197e5fd110e49a');
  detail.steps.invalidKeptOriginal = afterRow?.text === SUMMARY_TEXT;

  // group subject write/read (non-function subject, not existence-checked)
  const groupText = 'bus_register 下游子流程：两条私有子路径（direct/buffered），由单入口结构归纳，名称可修订。';
  const groupPut = cli(python, ['summary-put', '--workspace', WORKSPACE_ID, '--snapshot', snapshotId, '--payload-json', b64({
    subject: {type: 'group', id: groupId},
    text: groupText,
    facts: [{kind: 'selection', ref: groupId}],
    generator: {kind: 'agent', ref: 'verify-summary'},
    inference_labels: ['from_static_structure'],
  })], inbox.bootstrapPath);
  const groupView = cli(python, ['view-summary', '--workspace', WORKSPACE_ID, '--snapshot', snapshotId, '--subject-type', 'group', '--subject-id', groupId], inbox.bootstrapPath);
  const groupRow = (groupView.stdout_json?.summaries ?? [])[0] ?? null;
  detail.group = {put_exit_code: groupPut.exit_code, view_exit_code: groupView.exit_code, row: groupRow};
  detail.steps.groupOk = groupPut.ok && groupView.ok && groupRow !== null
    && groupRow.subject?.type === 'group' && groupRow.subject?.id === groupId && groupRow.text === groupText;

  detail.ok = Object.values(detail.steps).every((value) => value === true);
  return detail;
}

async function runSummaryProbe(boot, phase, expectText, facts) {
  const appDir = prepareProbeApp(SUMMARY_PROBE, `summary-probe-${phase}`, 'summary-probe.cjs');
  const shotDir = join(SCRATCH, `summary-shots-${phase}`);
  const outPath = join(SCRATCH, `summary-${phase}.json`);
  mkdirSync(shotDir, {recursive: true});
  rmSync(outPath, {force: true});
  const run = await runElectronProbe({
    boot, appDir, outPath,
    env: {
      RV_OUT: outPath,
      RV_SHOT_DIR: shotDir,
      RV_PHASE: phase,
      ...(expectText === null ? {} : {RV_EXPECT_TEXT: expectText}),
      ...(facts.snapshot_id === null ? {} : {RV_SNAPSHOT_ID: facts.snapshot_id}),
      RV_TIMEOUT_MS: '300000',
    },
    logPath: join(SCRATCH, `summary-probe-${phase}.log`),
  });
  return {run, probe: run.result, shotDir};
}

function installSummaryScreenshot(result, probe, sourceName, targetName) {
  const record = probe?.screenshots?.[sourceName];
  if (record?.path === undefined || !existsSync(record.path)) return null;
  mkdirSync(EVIDENCE_DIR, {recursive: true});
  const target = join(EVIDENCE_DIR, `${targetName}.png`);
  copyFileSync(record.path, target);
  const bytes = readFileSync(target);
  const installed = {path: `evidence/ai-summary/${targetName}.png`, bytes: bytes.length, sha256: sha256(bytes)};
  result.screenshots[targetName] = installed;
  return installed;
}

/** Full summary flow: gap probe -> engine CLI writes -> written probe -> RPC reads. */
async function verifySummaryFlow(boot, bootGraph, python, inbox, facts) {
  // 1) gap phase (before any write)
  const gap = await runSummaryProbe(boot, 'gap', null, facts);
  const gapProbe = gap.probe;
  const gapShot = installSummaryScreenshot({screenshots: {}}, gapProbe, 'gap', 'gap');
  requireCheck('host.summary_gap_probe', gapProbe !== null && gapProbe.ok === true, {
    exit_code: gap.run.exitCode,
    steps: gapProbe?.steps ?? null,
    views: gapProbe?.views ?? null,
    console_error_count: gapProbe?.console_error_count ?? null,
    screenshot: gapShot,
    log_tail: gap.run.log.slice(-1500),
  }, {layer: 'dsh_host'});

  // 2) engine writes (real CLI, real isolated state)
  const engine = await guard('atlas.summary_engine', () => verifySummaryEngine(python, inbox, facts.snapshot_id), {layer: 'atlas_snapshot'});
  if (engine && !engine.__error) {
    for (const [name, ok, detail] of [
      ['atlas.summary_put', engine.steps.putOk, engine.put],
      ['atlas.summary_view', engine.steps.viewOk, engine.view],
      ['atlas.summary_invalid', engine.steps.invalidRejected && engine.steps.invalidKeptOriginal, {invalid: engine.invalid}],
      ['atlas.summary_group', engine.steps.groupOk, engine.group],
    ]) {
      requireCheck(name, ok === true, detail, {layer: 'atlas_snapshot'});
    }
  }

  // 3) written phase (page reload -> fresh view.summary request)
  const written = await runSummaryProbe(boot, 'written', SUMMARY_TEXT, facts);
  const writtenProbe = written.probe;
  const writtenShot = installSummaryScreenshot({screenshots: {}}, writtenProbe, 'written', 'written');
  requireCheck('host.summary_written_probe', writtenProbe !== null && writtenProbe.ok === true, {
    exit_code: written.run.exitCode,
    steps: writtenProbe?.steps ?? null,
    views: writtenProbe?.views ?? null,
    console_error_count: writtenProbe?.console_error_count ?? null,
    screenshot: writtenShot,
    log_tail: written.run.log.slice(-1500),
  }, {layer: 'dsh_host'});
  requireCheck('host.summary_screenshots', gapShot !== null && writtenShot !== null
    && gapShot.sha256 !== writtenShot.sha256, {gap: gapShot, written: writtenShot}, {layer: 'dsh_host'});
  requireCheck('host.summary_console_clean', (gapProbe?.console_error_count ?? 1) === 0
    && (writtenProbe?.console_error_count ?? 1) === 0, {
    gap: gapProbe?.console_error_count ?? null,
    written: writtenProbe?.console_error_count ?? null,
  }, {layer: 'dsh_host'});

  // 4) RPC reads + status caps
  const cookies = bootGraph?.shell?.cookies ?? [];
  const cookieHeader = cookies.length > 0 ? {cookie: cookies.join('; ')} : {};
  const snapshotId = facts.snapshot_id;
  const noCookie = await httpFetch(new URL('/code-view/view.status', boot.url), {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({type: 'client-request', rpcId: 'verify-summary-admission', method: 'view.status', payload: {}}),
  });
  requireCheck('host.rpc_admission', noCookie.status === 401 || noCookie.status === 403, {
    status: noCookie.status, body_head: noCookie.text.slice(0, 200),
  }, {layer: 'dsh_host'});
  const statusCall = await callRpc(boot, cookieHeader, 'view.status', {}, 'verify-summary-view-status');
  requireCheck('host.rpc_view_status', statusCall.parsed?.result?.ok === true
    && statusCall.parsed?.result?.value?.host?.panel_key === 'dsh-code-reader', {
    status: statusCall.status, host: statusCall.parsed?.result?.value?.host ?? null,
  }, {layer: 'dsh_host'});
  const snapshotsCall = await callRpc(boot, cookieHeader, 'view.listSnapshots', {}, 'verify-summary-snapshots');
  const listedWorkspace = (snapshotsCall.parsed?.result?.value?.workspaces ?? []).find((row) => row.workspace_id === WORKSPACE_ID);
  const listedSnapshot = (listedWorkspace?.snapshots ?? []).find((row) => row.snapshot_id === snapshotId);
  requireCheck('host.rpc_list_snapshots', snapshotsCall.parsed?.result?.ok === true && listedSnapshot !== undefined, {
    status: snapshotsCall.status, snapshot: listedSnapshot ?? null,
  }, {layer: 'dsh_host'});
  const rpc = await callRpc(boot, cookieHeader, 'view.summary', {workspace: WORKSPACE_ID, snapshot: snapshotId, subject_type: 'function', subject_id: 'f_afa8298f2d197e5fd110e49a'}, 'verify-summary-rpc');
  const value = rpc.parsed?.result?.value ?? {};
  const row = (value.summaries ?? [])[0] ?? null;
  requireCheck('host.rpc_summary', rpc.parsed?.result?.ok === true && row !== null
    && row.stale === false && row.text === SUMMARY_TEXT
    && (row.facts ?? []).length >= 1 && absolutePathLeakInJson(rpc.text).count === 0, {
    http_status: rpc.status, summary: row, gaps: value.gaps ?? null, error: rpc.parsed?.result?.error ?? null,
  }, {layer: 'dsh_host'});
  const groupRpc = await callRpc(boot, cookieHeader, 'view.summary', {
    workspace: WORKSPACE_ID, snapshot: snapshotId, subject_type: 'group', subject_id: engine?.groupId ?? null,
  }, 'verify-summary-group-rpc');
  const groupValue = groupRpc.parsed?.result?.value ?? {};
  requireCheck('host.rpc_summary_group', groupRpc.parsed?.result?.ok === true
    && (groupValue.summaries ?? []).some((entry) => entry?.subject?.type === 'group'), {
    http_status: groupRpc.status, summaries: groupValue.summaries ?? null, gaps: groupValue.gaps ?? null,
  }, {layer: 'dsh_host'});
  const status = await callRpc(boot, cookieHeader, 'view.status', {}, 'verify-summary-status');
  const caps = status.parsed?.result?.value?.capabilities ?? {};
  requireCheck('host.rpc_status_summary_caps', status.parsed?.result?.ok === true
    && caps.ai_summary_store === true && caps.ai_summary === false, {
    capabilities: caps, gaps: status.parsed?.result?.value?.gaps ?? null,
  }, {layer: 'dsh_host'});
  record('host.summary_flow', true, {
    steps: {gap: gapProbe?.ok === true, written: writtenProbe?.ok === true, engine: engine?.ok === true},
    screenshots: {gap: gapShot, written: writtenShot},
    summary_checks: {put: engine?.steps?.putOk ?? null, view: engine?.steps?.viewOk ?? null, invalid: engine?.steps?.invalidRejected ?? null, group: engine?.steps?.groupOk ?? null},
  }, {layer: 'dsh_host'});
  return {engine, gapProbe, writtenProbe};
}

async function main() {
  const webBoots = [];
  let webBoot = null;
  logCommand({executable: process.execPath, args: [fileURLToPath(import.meta.url), ...argv], cwd: REPO_ROOT, note: 'self (S3b verifier entry point)'});

  outOfScope('plugin/model-side AI text generation', 'the plugin never calls a model; summaries are written by the Agent through code_summary/summary-put (verified as an Agent driver would)', 'dsh_host');
  outOfScope('real Linux/Kbuild + CFG/locks/aliases deep analysis', 'CW-T4 follow-up; this slice uses the imported Atlas snapshot', 'atlas_snapshot');
  outOfScope('real device dispatch / graph source write-back', 'not part of the summary slice', 'atlas_snapshot');
  outOfScope('real Linux/Kbuild index, CFG/locks/aliases/dataflow, target verification, performance budget (S4)', 'CW-T4 scope', 'atlas_snapshot');
  outOfScope('OS-wide egress certification', 'verifier only performs loopback HTTP and local process/worker observation', null);

  try {
    // 1. pinned host + static client contract
    const hostGate = verifyHostBaseline();
    record('host.pinned_baseline', hostGate.ok, {
      executable: hostGate.executable,
      archive: hostGate.archive,
      completed_checks: hostGate.checks.filter((row) => row.ok).length,
      failed_checks: hostGate.checks.filter((row) => !row.ok),
    }, {layer: 'dsh_host'});
    if (!hostGate.ok) throw new Error(`pinned host gate failed: ${JSON.stringify(hostGate.checks.filter((row) => !row.ok))}`);
    const contract = packageContract();
    requireCheck('host.client_s3_contract', contract.ok, contract, {layer: 'dsh_host'});

    // 2. isolated home/profile + isolated inbox (workspace/snapshot + sim profile)
    const prepared = prepareIsolatedHome({wipe: true, importData: false});
    const inbox = prepareIsolatedInbox(prepared);
    const importResults = {
      workspace: cli(prepared.python, ['workspace-import', '--manifest', 'workspace.json', '--expected-revision', '0', '--operation-id', crypto.randomUUID()], inbox.bootstrapPath),
      snapshot: null,
      profile: null,
    };
    const slice = inspectSnapshot();
    const snapshotId = slice.snapshot_id;
    if (importResults.workspace.ok) {
      importResults.snapshot = cli(prepared.python, [
        'snapshot-import', '--workspace', WORKSPACE_ID, '--variant', 'semantic-x86_64', '--repo', 'bus',
        '--snapshot', slice.slice.snapshot_dir_name ?? 'snapshot-bus', '--operation-id', crypto.randomUUID(),
      ], inbox.bootstrapPath);
    }
    requireCheck('host.isolated_profile', prepared.data_ready !== false
      && importResults.workspace.ok && (importResults.snapshot?.ok ?? false), {
      home: 'scratch/readonly-home/home',
      home_is_isolated_from_user_profile: true,
      inbox: {path: 'scratch/s3/inbox', files: inbox.files, note: 'isolated copy of Lead slice inbox + evidence/scenario-sim/inbox sim-profile.json + bus.wasm'},
      bootstrap: {path: 'scratch/readonly-home/home/code-reader/bootstrap.json', import_inbox_dir: inbox.inbox, candidate_roots: [{root_ref: 'slice-root', absolute_path: 'evidence/code-view-slice'}]},
      python: prepared.python,
      imports: {workspace: importResults.workspace.exit_code, snapshot: importResults.snapshot?.exit_code ?? null},
      snapshot: {snapshot_id: snapshotId, path: `evidence/code-view-slice/snapshot/${snapshotId}`},
    }, {layer: 'dsh_host'});
    if (!importResults.workspace.ok || !(importResults.snapshot?.ok ?? false) || snapshotId === null) {
      throw new Error('isolated workspace/snapshot import failed');
    }

    const facts = {
      snapshot_id: snapshotId,
      target: slice.target,
      slice: slice.slice,
      entry_lines: {},
    };
    // Entry id/line hints via the engine projection.
    const entriesCli = cli(prepared.python, ['view-entries', '--workspace', WORKSPACE_ID, '--snapshot', snapshotId], inbox.bootstrapPath);
    for (const row of entriesCli.stdout_json?.entries ?? []) {
      if (typeof row.name === 'string' && typeof row.line === 'number') facts.entry_lines[row.name] = row.line;
    }
    facts.target = facts.target ?? {entry_id: null, line: facts.entry_lines.bus_send ?? 152};
    requireCheck('host.entry_hints', entriesCli.ok && (entriesCli.stdout_json?.entries ?? []).length === 19, {
      entry_count: (entriesCli.stdout_json?.entries ?? []).length,
      bus_send_line: facts.entry_lines.bus_send ?? null,
    }, {layer: 'dsh_host'});

    // 3. atlas layer: sim-profile-import/list + scenario-plan/module
    const setup = await guard('atlas.scenario_setup', () => verifyAtlasScenarioSetup(prepared.python, facts, prepared, inbox, snapshotId), {layer: 'atlas_snapshot'});
    const s3bAtlas = setup && !setup.__error ? await guard('atlas.s3b_setup', () => verifyAtlasS3b(prepared.python, inbox, snapshotId), {layer: 'atlas_snapshot'}) : undefined;
    const simulation = setup && !setup.__error ? {setup, snapshotId} : {snapshotId};

    // 4. boot the real isolated web host
    if (!options.skipHttp) {
      webBoot = await guard('host.web_boot', () => startWebServer({python: prepared.python, tag: 's3'}), {layer: 'dsh_host'});
      if (webBoot && !webBoot.__error) {
        webBoots.push(webBoot);
        logCommand({executable: EXECUTABLE, args: [DSH_BIN, 'web', '--no-open', '--port', '0'], cwd: join(REPO_ROOT, 'scratch'), note: 'isolated dsh web boot (one-time URL token redacted)'});
        const bootGraph = await guard('host.boot_graph', () => verifyBootGraph(webBoot), {layer: 'dsh_host'});
        await guard('host.summary_flow', () => verifySummaryFlow(webBoot, bootGraph, prepared.python, inbox, facts), {layer: 'dsh_host'});

        if (!options.skipProbes) {
          await guard('host.s3b_probe_runner', () => verifyS3bProbe(webBoot, facts), {layer: 'dsh_host'});
          await guard('host.s3a_probe_runner', () => verifyS3aRegressionProbe(webBoot, facts), {layer: 'dsh_host'});
        } else {
          skipCheck('host.s3b_probe', '--skip-probes', {layer: 'dsh_host'});
          skipCheck('host.s3a_regression_probe', '--skip-probes', {layer: 'dsh_host'});
        }
        if (!options.skipRegression) {
          await guard('regression.s2b_runner', () => verifyS2bRegressionProbe(webBoot, facts), {layer: 'dsh_host'});
          await guard('regression.s2a_runner', () => verifyS2aRegressionProbe(webBoot, facts), {layer: 'dsh_host'});
          await guard('regression.s1_runner', () => verifyS1RegressionProbe(webBoot, facts), {layer: 'dsh_host'});
        } else {
          skipCheck('regression.s2b_probe', '--skip-regression', {layer: 'dsh_host'});
          skipCheck('regression.s2a_probe', '--skip-regression', {layer: 'dsh_host'});
          skipCheck('regression.s1_probe', '--skip-regression', {layer: 'dsh_host'});
        }
      }
    } else {
      skipCheck('host.boot_graph', '--skip-http');
      skipCheck('host.s3b_probe', '--skip-http');
      skipCheck('host.s3a_regression_probe', '--skip-http');
    }

    // 5. real Cordis runtime with scenario.run (real Wasm)
    if (!options.skipHostRuntime) {
      const hostRuntime = await guard('dsh_host.summary_host_runtime_runner', () => runHostRuntime({
        python: prepared.python, home: prepared.home, bootstrapPath: inbox.bootstrapPath, facts,
      }), {layer: 'dsh_host'});
      if (hostRuntime && !hostRuntime.__error) {
        requireCheck('dsh_host.summary_host_runtime', hostRuntime.ok === true, {
          exit_code: hostRuntime.exit_code,
          tap_summary: hostRuntime.tap_summary,
          duration_ms: hostRuntime.duration_ms,
          evidence: 'evidence/ai-summary/host-runtime.json',
          tap: 'evidence/ai-summary/host-runtime.tap',
          stdout_tail: (hostRuntime.stdout_tail ?? '').slice(-2500),
          stderr_tail: (hostRuntime.stderr_tail ?? '').slice(-1500),
        }, {layer: 'dsh_host'});
      }
    } else {
      skipCheck('dsh_host.summary_host_runtime', '--skip-host-runtime', {layer: 'dsh_host'});
    }

    // 6. demo + optional repo node tests
    if (!options.skipDemo) {
      await guard('demo.layer', () => verifyDemo(), {layer: 'demo_observed'});
    } else {
      skipCheck('demo.code_view_demo_tests', '--skip-demo', {layer: 'demo_observed'});
    }
    if (options.withRepoTests) {
      await guard('dsh_host.repo_node_tests', () => verifyRepoNodeTests(), {layer: 'dsh_host'});
    } else {
      skipCheck('dsh_host.repo_node_tests', 'not requested (--with-repo-tests)', {outOfScope: true});
    }

    // layers
    report.layers.demo_observed = report.checks['demo.code_view_demo_tests']?.ok === true;
    report.layers.atlas_snapshot = [
      'atlas.sim_profile_import', 'atlas.sim_profile_list',
      'atlas.trace_import', 'atlas.trace_import_idempotent', 'atlas.trace_observed',
      'atlas.undo_plan_imported_rejected',
      'atlas.summary_put', 'atlas.summary_view', 'atlas.summary_invalid', 'atlas.summary_group',
    ].every((name) => report.checks[name]?.ok === true);
    const requiredHostChecks = [
      'host.pinned_baseline', 'host.client_s3_contract', 'host.isolated_profile', 'host.entry_hints',
      'host.web_shell', 'host.boot_release', 'host.boot_graph_entry', 'host.boot_graph_inject',
      'host.client_bundle_bytes', 'host.rpc_admission', 'host.rpc_view_status', 'host.rpc_list_snapshots',
      'host.summary_flow', 'host.summary_gap_probe', 'host.summary_written_probe', 'host.summary_screenshots',
      'host.summary_console_clean', 'host.rpc_summary', 'host.rpc_summary_group', 'host.rpc_status_summary_caps',
      'host.s3b_probe', 'host.s3b_screenshots', 'host.s3b_undo', 'host.s3b_trace_import',
      'host.s3b_observed_scenarios', 'host.s3b_chrome', 'host.s3b_console_clean', 'host.s3b_no_absolute_paths',
      'host.s3a_regression_probe', 'host.s3a_regression_console_clean',
      'regression.s2b_probe', 'regression.s2b_console_clean',
      'regression.s2a_probe', 'regression.s1_probe',
      'dsh_host.summary_host_runtime',
    ];
    report.layers.dsh_host = requiredHostChecks.every((name) => report.checks[name]?.ok === true);
    report.in_scope_not_verified = report.not_verified.filter((row) => row.out_of_scope !== true);
    report.out_of_scope_not_verified = report.not_verified.filter((row) => row.out_of_scope === true);
    report.checks_summary = {
      total: Object.keys(report.checks).length,
      passed: Object.values(report.checks).filter((row) => row.ok === true).length,
      failed: Object.values(report.checks).filter((row) => row.ok !== true && row.required === true).length,
      in_scope_not_verified: report.in_scope_not_verified.length,
      out_of_scope_not_verified: report.out_of_scope_not_verified.length,
    };
    report.ok = report.layers.demo_observed === true
      && report.layers.atlas_snapshot === true
      && report.layers.dsh_host === true
      && report.in_scope_not_verified.length === 0;
    report.verified = report.ok;
  } catch (error) {
    report.ok = false;
    report.verified = false;
    report.error = String(error?.stack ?? error?.message ?? error);
  } finally {
    for (const boot of webBoots.reverse()) {
      try { await boot.stop(); } catch { /* already stopped */ }
    }
  }

  mkdirSync(EVIDENCE_DIR, {recursive: true});
  report.finished_at_utc = new Date().toISOString();
  report.duration_ms = Date.parse(report.finished_at_utc) - Date.parse(report.started_at_utc);
  writeFileSync(COMMANDS_PATH, `${report.commands.map((row) => `${row.at} ${row.display}${row.cwd === undefined ? '' : ` (cwd ${row.cwd})`}`).join('\n')}\n`, 'utf8');
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    verified: report.verified,
    layers: report.layers,
    checks: report.checks_summary,
    in_scope_not_verified: report.in_scope_not_verified,
    out_of_scope_count: report.out_of_scope_not_verified.length,
    evidence: 'evidence/ai-summary/verification.json',
  }, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

main();
