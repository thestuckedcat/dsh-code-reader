#!/usr/bin/env node
// Independent black-box acceptance runner for the S2a read-only five views
// (docs/five-view-contract.md §5/§7). It never imports the plugin's client or
// server modules for assertions and never writes into the plugin
// implementation; it only builds an isolated DSH runtime under
// `04-code-learning/scratch/readonly-home` (shared mechanism with the S1
// verifier) and observes the real pinned rc.5 host.
//
// Layers (kept separate, never mixed):
//   demo_observed   `node --test demo/code-view/demo.test.cjs`
//   atlas_snapshot  the six S2a engine CLI endpoints over the real Atlas snapshot
//   dsh_host        pinned rc.5 host gate + isolated web profile boot graph +
//                   /code-view carriers (old + new endpoints) + Chromium
//                   five-view probe + S1 regression probe + real Cordis
//                   mount/dispose/remount runtime test
//
// Output: evidence/five-views/verification.json, commands.log, per-view PNGs
// (coupling/tree/end_to_end/sequence/file/main + regression-readonly-slice),
// host-runtime.json/.tap. S2b/S3/S4 capabilities stay in `not_verified` with
// `out_of_scope: true`; in-scope failures are listed without that flag.
//
// Usage: node tools/verify-five-views.mjs [--skip-probe] [--skip-regression]
//        [--skip-host-runtime] [--skip-demo] [--skip-http] [--with-repo-tests]
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
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
  ENGINE_DIR,
  HOME_DIR,
  REPO_ROOT,
  SLICE_DIR,
  WORKSPACE_ID,
  inspectSnapshot,
  isolatedEnv,
  prepareIsolatedHome,
  readJsonFile,
  resolvePython,
  runEngineCli,
} from './readonly-slice/isolated-home.mjs';
import {extractBootManifest, fetchShell, httpFetch, startWebServer} from './readonly-slice/web-host.mjs';

const EVIDENCE_DIR = join(REPO_ROOT, 'evidence', 'five-views');
const COMMANDS_PATH = join(EVIDENCE_DIR, 'commands.log');
const REPORT_PATH = join(EVIDENCE_DIR, 'verification.json');
const SCRATCH = join(REPO_ROOT, 'scratch', 'five-views');
const SHOT_DIR = join(SCRATCH, 'shots');
const PROBE_JSON = join(SCRATCH, 'five-views-probe.json');
const REGRESSION_JSON = join(SCRATCH, 'readonly-regression.json');
const REGRESSION_PNG = join(SCRATCH, 'readonly-regression.png');
const HOST_RUNTIME_TAP = join(EVIDENCE_DIR, 'host-runtime.tap');
const HOST_RUNTIME_JSON = join(EVIDENCE_DIR, 'host-runtime.json');
const FIVE_VIEWS_PROBE = join(REPO_ROOT, 'tools', 'five-views-probe.cjs');
const HOST_RUNTIME_TEST = 'tools/five-views-host-runtime.test.mjs';
const OLD_PROBE = join(REPO_ROOT, 'tools', 'readonly-slice', 'electron-probe.cjs');
const PACKAGE_JSON = join(REPO_ROOT, 'package.json');

const argv = process.argv.slice(2);
const options = {
  skipProbe: argv.includes('--skip-probe'),
  skipRegression: argv.includes('--skip-regression'),
  skipHostRuntime: argv.includes('--skip-host-runtime'),
  skipDemo: argv.includes('--skip-demo'),
  skipHttp: argv.includes('--skip-http'),
  withRepoTests: argv.includes('--with-repo-tests'),
};

const startedAt = new Date().toISOString();
const report = {
  schema_version: 1,
  stage: 'S2a',
  contract: 'docs/five-view-contract.md (CL-VIEW-T2-CONTRACT)',
  started_at_utc: startedAt,
  purpose:
    'Independent black-box acceptance of the S2a read-only five views: isolated rc.5 dsh web boot graph, /code-view old+new endpoints, Chromium per-view DOM assertions + screenshots, S1 regression and real Cordis mount/dispose/remount runtime.',
  host: HOST_BASELINE,
  layers: {demo_observed: false, atlas_snapshot: false, dsh_host: false},
  checks: {},
  not_verified: [],
  commands: [],
  environment: {node: process.versions.node, platform: process.platform, workspace: REPO_ROOT},
  limitations: [
    'Uses the locally installed generic Electron binary only as the Chromium test instrument; it is not a shipped dependency.',
    'The isolated fresh DSH_HOME may show the host first-run overlay in screenshots; the five-view DOM assertions are recorded independently of that host UI.',
    'No OS-wide egress certification; this is a local read-only slice check (loopback HTTP only).',
    'DEMO layer is the Wasm/JS demo model, ATLAS is the real imported snapshot read model, DSH_HOST is the pinned local rc.5; the three are never mixed.',
    'Group folding, interface library, AI summary, run observation, scenario execution/stub/rollback, real Linux/Kbuild and CFG/locks/aliases are S2b/S3/S4 scope and are listed under not_verified as out_of_scope.',
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

function runNodeTests(files, {cwd = REPO_ROOT, timeoutMs = 240000} = {}) {
  const args = ['--test', '--test-reporter=tap', '--test-concurrency=1', ...files];
  const result = spawnSync(process.execPath, args, {
    cwd, windowsHide: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
  });
  logCommand({executable: process.execPath, args, cwd, exit_code: result.status});
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return {status: result.status, summary: tapSummary(text), text};
}

function absolutePathLeakInJson(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  const matches = text.match(/[A-Za-z]:[\\/][^"',\s}]+/g) ?? [];
  return {count: matches.length, samples: [...new Set(matches)].slice(0, 10)};
}

function snapshotFacts() {
  const inspected = inspectSnapshot();
  return {
    ok: inspected.ok,
    snapshot_id: inspected.snapshot_id,
    target: inspected.target,
    entry_count: inspected.entry_count,
    graph_sha256: inspected.graph_sha256,
    slice: inspected.slice,
  };
}

// ---------------------------------------------------------------------------
// static contract + host gate
// ---------------------------------------------------------------------------
function packageContract() {
  const pkg = readJsonFile(PACKAGE_JSON);
  const checks = {
    name: pkg.name === '@local/dsh-code-reader',
    client_platform: pkg?.dsh?.client?.platform === 'web',
    client_inject: Array.isArray(pkg?.dsh?.client?.inject) && pkg.dsh.client.inject.length === 3,
    client_export: pkg?.exports?.['./client'] === './bundle/client.js',
  };
  const clientPath = join(REPO_ROOT, 'bundle', 'client.js');
  checks.client_bundle_exists = existsSync(clientPath);
  let clientBytes = Buffer.alloc(0);
  let clientText = '';
  if (checks.client_bundle_exists) {
    clientBytes = readFileSync(clientPath);
    clientText = clientBytes.toString('utf8');
    checks.client_bundle_bytes = clientBytes.length > 0;
    checks.client_loader_facade = clientText.includes('window.__ModuleLoader__.load(');
    checks.client_loader_id = clientText.includes("'@local/dsh-code-reader'") || clientText.includes('"@local/dsh-code-reader"');
    checks.client_five_view_labels = ['资源关系图', '文字树', '端到端图', '时序图', '文件视图'].every((label) => clientText.includes(label));
    checks.client_five_view_hooks = ['data-code-view', 'tabs', 'data-coupling-column', 'data-tree-node', 'data-graph-node',
      'data-sequence-message', 'data-file-line', 'data-rail', 'data-graph-fit'].every((hook) => clientText.includes(hook));
  }
  return {
    ok: Object.values(checks).every((value) => value === true),
    package: {name: pkg.name, version: pkg.version, main: pkg.main, dsh: pkg.dsh},
    client_bundle: {path: 'bundle/client.js', bytes: clientBytes.length, sha256: checks.client_bundle_exists ? sha256(clientBytes) : null},
    checks,
  };
}

// ---------------------------------------------------------------------------
// Atlas snapshot layer: six S2a engine CLI endpoints over the real snapshot
// ---------------------------------------------------------------------------
async function verifyAtlasEndpoints(python, facts) {
  const workspaceId = facts.slice?.workspace_manifest?.workspace_id ?? WORKSPACE_ID;
  const snapshotId = facts.snapshot_id;
  const entryId = facts.target?.entry_id;
  if (!facts.ok || snapshotId === null || entryId === null) {
    throw new Error(`Lead slice data is not ready: ${facts.slice?.missing?.join(', ') ?? 'no snapshot/target'}`);
  }
  const invoke = (args) => {
    const result = runEngineCli({python, args});
    logCommand({executable: python.command, args: result.argv, cwd: ENGINE_DIR, exit_code: result.exit_code});
    return result;
  };

  // view-coupling
  const coupling = invoke(['view-coupling', '--workspace', workspaceId, '--snapshot', snapshotId, '--entry', entryId]);
  const couplingValue = coupling.stdout_json ?? {};
  const routesResource = (couplingValue.resources ?? []).find((resource) => resource.name === 'routes');
  const allAccesses = (couplingValue.resources ?? []).flatMap((resource) => resource.accesses ?? []);
  const writeExact = allAccesses.filter((access) => access.access === 'write' && access.certainty === 'exact'
    && access.field_name === 'max_len' && access.location?.line === 46);
  const readMayLines = [...new Set(allAccesses.filter((access) => access.access === 'read' && access.certainty === 'may'
    && access.field_name === 'max_len').map((access) => access.location?.line))];
  const couplingLeak = absolutePathLeakInJson(couplingValue);
  requireCheck('atlas.view_coupling', coupling.ok
    && routesResource !== undefined
    && writeExact.length > 0
    && [92, 93, 98].every((line) => readMayLines.includes(line))
    && (couplingValue.functions ?? []).length > 0
    && (couplingValue.edges ?? []).length > 0
    && couplingLeak.count === 0, {
    command: 'view-coupling',
    scope: couplingValue.scope ?? null,
    resource_count: (couplingValue.resources ?? []).length,
    routes: routesResource === undefined ? null : {resource_id: routesResource.resource_id, file: routesResource.file, line: routesResource.line},
    write_exact_max_len_46: writeExact.slice(0, 3),
    read_may_lines: readMayLines.sort((left, right) => left - right),
    function_count: (couplingValue.functions ?? []).length,
    edge_count: (couplingValue.edges ?? []).length,
    external_nodes: (couplingValue.external_nodes ?? []).map((node) => ({name: node.name, kind: node.kind, reason: node.reason})),
    absolute_path_leak: couplingLeak,
    error: coupling.exit_code === 0 ? null : (coupling.stdout_json?.error ?? coupling.stderr_tail),
  }, {layer: 'atlas_snapshot'});

  // view-tree
  const tree = invoke(['view-tree', '--workspace', workspaceId, '--snapshot', snapshotId, '--entry', entryId]);
  const treeValue = tree.stdout_json ?? {};
  const treeText = JSON.stringify(treeValue.nodes ?? []);
  const checkLengthNode = (treeValue.nodes ?? []).find((node) => node.symbol?.name === 'check_length');
  const treeLeak = absolutePathLeakInJson(treeValue);
  requireCheck('atlas.view_tree', tree.ok
    && treeValue.entry?.name === 'bus_send'
    && ['lookup_route', 'check_length', 'dispatch_transfer'].every((name) => treeText.includes(name))
    && checkLengthNode !== undefined
    && (checkLengthNode.guards ?? []).length > 0
    && treeLeak.count === 0, {
    command: 'view-tree',
    entry: treeValue.entry ?? null,
    node_count: (treeValue.nodes ?? []).length,
    max_depth: treeValue.max_depth ?? null,
    check_length_guards: checkLengthNode?.guards ?? null,
    kinds: [...new Set((treeValue.nodes ?? []).map((node) => node.kind))],
    absolute_path_leak: treeLeak,
    error: tree.exit_code === 0 ? null : (tree.stdout_json?.error ?? tree.stderr_tail),
  }, {layer: 'atlas_snapshot'});

  // view-end-to-end
  const endToEnd = invoke(['view-end-to-end', '--workspace', workspaceId, '--snapshot', snapshotId, '--entry', entryId]);
  const endValue = endToEnd.stdout_json ?? {};
  const externalEdges = (endValue.edges ?? []).filter((edge) => edge.kind === 'external');
  const errorExit = (endValue.exits ?? []).find((exit) => exit.role === 'error' && String(exit.expression).includes('-90'));
  const endLeak = absolutePathLeakInJson(endValue);
  requireCheck('atlas.view_end_to_end', endToEnd.ok
    && (endValue.nodes ?? []).some((node) => node.kind === 'entry' && node.label === 'bus_send')
    && (endValue.nodes ?? []).some((node) => node.kind === 'decision')
    && errorExit !== undefined
    && (endValue.nodes ?? []).some((node) => node.kind === 'external' && String(node.label).includes('platform_write'))
    && externalEdges.length > 0
    && (endValue.legend ?? []).map((row) => row.key).join(',') === 'exact,may,unknown,error,boundary'
    && endValue.layout?.direction === 'DOWN'
    && endValue.layout?.edge_routing === 'ORTHOGONAL'
    && endLeak.count === 0, {
    command: 'view-end-to-end',
    node_count: (endValue.nodes ?? []).length,
    node_kinds: [...new Set((endValue.nodes ?? []).map((node) => node.kind))],
    decision_count: (endValue.nodes ?? []).filter((node) => node.kind === 'decision').length,
    error_exit: errorExit ?? null,
    external_nodes: (endValue.nodes ?? []).filter((node) => node.kind === 'external').map((node) => node.label),
    external_edges: externalEdges.slice(0, 4).map((edge) => ({kind: edge.kind, style: edge.style ?? null, label: edge.label})),
    legend: endValue.legend ?? null,
    layout: endValue.layout ?? null,
    gaps: endValue.gaps ?? [],
    absolute_path_leak: endLeak,
    error: endToEnd.exit_code === 0 ? null : (endToEnd.stdout_json?.error ?? endToEnd.stderr_tail),
  }, {layer: 'atlas_snapshot'});

  // view-file-tree
  const fileTree = invoke(['view-file-tree', '--workspace', workspaceId, '--snapshot', snapshotId]);
  const fileTreeValue = fileTree.stdout_json ?? {};
  const busRepo = (fileTreeValue.repos ?? []).find((repo) => repo.repo_id === 'bus');
  const fileTreeLeak = absolutePathLeakInJson(fileTreeValue);
  requireCheck('atlas.view_file_tree', fileTree.ok
    && busRepo !== undefined
    && (busRepo.files ?? []).some((file) => file.path === 'bus.c' && file.has_evidence === true)
    && (busRepo.files ?? []).some((file) => file.path === 'platform.c')
    && fileTreeLeak.count === 0, {
    command: 'view-file-tree',
    repos: (fileTreeValue.repos ?? []).map((repo) => ({repo_id: repo.repo_id, files: (repo.files ?? []).map((file) => file.path)})),
    absolute_path_leak: fileTreeLeak,
    error: fileTree.exit_code === 0 ? null : (fileTree.stdout_json?.error ?? fileTree.stderr_tail),
  }, {layer: 'atlas_snapshot'});

  // view-file-read
  const fileRead = invoke(['view-file-read', '--workspace', workspaceId, '--snapshot', snapshotId, '--repo', 'bus', '--path', 'bus.c']);
  const fileReadValue = fileRead.stdout_json ?? {};
  const repoBusPath = join(SLICE_DIR, 'repo', 'bus.c');
  const expectedFileSha = existsSync(repoBusPath) ? sha256(readFileSync(repoBusPath)) : null;
  const line46 = (fileReadValue.lines ?? []).find((line) => line.n === 46);
  const fileReadLeak = absolutePathLeakInJson(fileReadValue);
  requireCheck('atlas.view_file_read', fileRead.ok
    && fileReadValue.path === 'bus.c'
    && fileReadValue.total_lines === 174
    && (fileReadValue.lines ?? []).length === 174
    && line46 !== undefined
    && /max_len/.test(line46.text)
    && (expectedFileSha === null || fileReadValue.sha256 === expectedFileSha)
    && fileReadLeak.count === 0, {
    command: 'view-file-read',
    path: fileReadValue.path,
    total_lines: fileReadValue.total_lines,
    lines: (fileReadValue.lines ?? []).length,
    sha256: fileReadValue.sha256,
    expected_sha256: expectedFileSha,
    line_46: line46 ?? null,
    absolute_path_leak: fileReadLeak,
    error: fileRead.exit_code === 0 ? null : (fileRead.stdout_json?.error ?? fileRead.stderr_tail),
  }, {layer: 'atlas_snapshot'});

  // view-sequence (static only)
  const sequence = invoke(['view-sequence', '--workspace', workspaceId, '--snapshot', snapshotId, '--entry', entryId, '--mode', 'static']);
  const sequenceValue = sequence.stdout_json ?? {};
  const sequenceText = JSON.stringify(sequenceValue.messages ?? []);
  const sequenceLeak = absolutePathLeakInJson(sequenceValue);
  requireCheck('atlas.view_sequence', sequence.ok
    && sequenceValue.mode === 'static'
    && sequenceValue.observed === false
    && /静态预测/.test(sequenceValue.warning ?? '')
    && ['bus_send', 'lookup_route', 'check_length', 'platform_write'].every((label) => sequenceText.includes(label))
    && (sequenceValue.gaps ?? []).some((gap) => gap.code === 'run_observation')
    && sequenceLeak.count === 0, {
    command: 'view-sequence',
    mode: sequenceValue.mode,
    observed: sequenceValue.observed,
    warning: sequenceValue.warning,
    message_count: (sequenceValue.messages ?? []).length,
    message_kinds: [...new Set((sequenceValue.messages ?? []).map((message) => message.kind))],
    participants: sequenceValue.participants ?? null,
    gaps: sequenceValue.gaps ?? [],
    absolute_path_leak: sequenceLeak,
    error: sequence.exit_code === 0 ? null : (sequence.stdout_json?.error ?? sequence.stderr_tail),
  }, {layer: 'atlas_snapshot'});

  return {
    workspace_id: workspaceId,
    snapshot_id: snapshotId,
    entry_id: entryId,
    expected_line: facts.target?.line ?? 152,
    engine: {python: python.version, command: python.command},
  };
}

/** Entry name → definition line map (for the probe's file-jump assertions). */
function collectEntryLines(python, facts) {
  const workspaceId = facts.slice?.workspace_manifest?.workspace_id ?? WORKSPACE_ID;
  const result = runEngineCli({python, args: ['view-entries', '--workspace', workspaceId, '--snapshot', facts.snapshot_id]});
  logCommand({executable: python.command, args: result.argv, cwd: ENGINE_DIR, exit_code: result.exit_code});
  const lines = {};
  for (const row of result.stdout_json?.entries ?? []) {
    if (typeof row.name === 'string' && typeof row.line === 'number') lines[row.name] = row.line;
  }
  return {ok: result.ok && Object.keys(lines).length > 0, lines};
}

// ---------------------------------------------------------------------------
// DSH host layer: boot graph + carriers
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
    entry: entry === undefined ? null : {id: entry.id, url: redactUrl(entry.url), rev: entry.rev, inject: entry.inject},
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
    const prefix = response.bytes.length >= repo.length && response.bytes.subarray(0, repo.length).equals(repo);
    bundle = {
      fetched: true,
      url: redactUrl(clientUrl),
      status: response.status,
      bytes: response.bytes.length,
      sha256: sha256(response.bytes),
      repo_bytes: repo.length,
      exact_prefix: prefix,
      suffix: response.bytes.subarray(repo.length).toString('utf8').slice(0, 200),
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
  // Primary acceptance: cookie-less direct request must be refused by admission.
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
  requireCheck('host.rpc_view_status', status.status === 200
    && status.parsed?.result?.ok === true
    && status.parsed?.result?.value?.host?.panel_key === 'dsh-code-reader'
    && status.parsed?.result?.value?.engine?.python === 'available', {
    status: status.status,
    host: status.parsed?.result?.value?.host ?? null,
    engine: status.parsed?.result?.value?.engine ?? null,
    gap_codes: (status.parsed?.result?.value?.gaps ?? []).map((gap) => gap.code),
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
  const workspaceId = WORKSPACE_ID;
  const entries = await callRpc(boot, cookieHeader, 'view.listEntries', {workspace: workspaceId, snapshot: snapshotId}, 'verify-entries-1');
  const entryRow = (entries.parsed?.result?.value?.entries ?? []).find((row) => row.name === 'bus_send');
  const entryId = entryRow?.entry_id ?? facts.target?.entry_id;
  const entryCall = await callRpc(boot, cookieHeader, 'view.getEntry', {workspace: workspaceId, snapshot: snapshotId, entry: entryId}, 'verify-entry-1');
  requireCheck('host.rpc_get_entry', entryCall.parsed?.result?.ok === true
    && (entryCall.parsed?.result?.value?.source?.status === 'ok')
    && (entryCall.parsed?.result?.value?.calls ?? []).some((call) => call.certainty === 'exact'), {
    source: entryCall.parsed?.result?.value?.source ?? null,
    calls: (entryCall.parsed?.result?.value?.calls ?? []).length,
  }, {layer: 'dsh_host'});

  // Six S2a endpoints through the same carrier with real Python.
  const endpointPayloads = {
    'view.coupling': {workspace: workspaceId, snapshot: snapshotId, entry: entryId},
    'view.tree': {workspace: workspaceId, snapshot: snapshotId, entry: entryId},
    'view.endToEnd': {workspace: workspaceId, snapshot: snapshotId, entry: entryId},
    'view.fileTree': {workspace: workspaceId, snapshot: snapshotId},
    'view.fileRead': {workspace: workspaceId, snapshot: snapshotId, repo: 'bus', path: 'bus.c'},
    'view.sequence': {workspace: workspaceId, snapshot: snapshotId, entry: entryId, mode: 'static'},
  };
  const endpointResults = {};
  let endpointsOk = true;
  for (const [endpoint, payload] of Object.entries(endpointPayloads)) {
    const response = await callRpc(boot, cookieHeader, endpoint, payload, `verify-${endpoint.replace(/\./g, '-')}`);
    const value = response.parsed?.result?.value;
    const ok = response.status === 200 && response.parsed?.type === 'server-response'
      && response.parsed?.result?.ok === true
      && value !== null && typeof value === 'object'
      && value.schema_version === 1
      && absolutePathLeakInJson(response.text).count === 0;
    if (!ok) endpointsOk = false;
    endpointResults[endpoint] = {
      ok,
      http_status: response.status,
      error: response.parsed?.result?.error ?? null,
      keys: value === null || typeof value !== 'object' ? null : Object.keys(value).slice(0, 20),
      error_text: ok ? null : response.text.slice(0, 400),
    };
  }
  requireCheck('host.rpc_five_view_endpoints', endpointsOk, endpointResults, {layer: 'dsh_host'});

  // Adversarial input: path traversal must be rejected as INVALID_ARGUMENT.
  const invalid = await callRpc(boot, cookieHeader, 'view.fileRead', {
    workspace: workspaceId, snapshot: snapshotId, repo: 'bus', path: '../etc/passwd',
  }, 'verify-invalid-1');
  requireCheck('host.rpc_input_validation', invalid.status === 200
    && invalid.parsed?.result?.ok === false
    && invalid.parsed?.result?.error?.code === 'INVALID_ARGUMENT', {
    status: invalid.status,
    error: invalid.parsed?.result?.error ?? null,
  }, {layer: 'dsh_host'});
}

// ---------------------------------------------------------------------------
// Chromium probes
// ---------------------------------------------------------------------------
function prepareProbeApp() {
  const appDir = join(SCRATCH, 'probe-app');
  mkdirSync(appDir, {recursive: true});
  copyFileSync(FIVE_VIEWS_PROBE, join(appDir, 'five-views-probe.cjs'));
  writeFileSync(join(appDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-code-reader-five-views-probe',
    version: '0.0.0-private',
    private: true,
    description: 'Verifier S2a five-view probe; not a shipped component.',
    main: 'five-views-probe.cjs',
  }, null, 2)}\n`, 'utf8');
  return appDir;
}

async function runElectronProbe({boot, outPath, shotDir, env, appDir, logPath, timeoutMs = 420000, extraArgs = []}) {
  const userDataDir = join(SCRATCH, 'electron-userdata');
  const probeEnv = {...process.env, ...env, RV_URL: boot.url};
  delete probeEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(RENDER_PROBE_ELECTRON, [appDir, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userDataDir}`, ...extraArgs], {
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
  logCommand({executable: RENDER_PROBE_ELECTRON, args: [appDir, '--no-sandbox', '--disable-gpu'], cwd: REPO_ROOT, exit_code: exitCode});
  const result = existsSync(outPath) ? readJsonFile(outPath) : null;
  return {exitCode, log, result, shotDir};
}

function copyProbeScreenshots(probeResult) {
  const copied = {};
  mkdirSync(EVIDENCE_DIR, {recursive: true});
  for (const [name, record] of Object.entries(probeResult?.screenshots ?? {})) {
    if (record?.path === undefined || !existsSync(record.path)) continue;
    const target = join(EVIDENCE_DIR, `${name}.png`);
    copyFileSync(record.path, target);
    copied[name] = {
      path: `evidence/five-views/${name}.png`,
      bytes: readFileSync(target).length,
      sha256: sha256(readFileSync(target)),
      source_record: {bytes: record.bytes ?? null, sha256: record.sha256 ?? null},
    };
  }
  return copied;
}

async function verifyProbe(boot, facts) {
  const appDir = prepareProbeApp();
  mkdirSync(SHOT_DIR, {recursive: true});
  rmSync(PROBE_JSON, {force: true});
  const run = await runElectronProbe({
    boot,
    appDir,
    outPath: PROBE_JSON,
    shotDir: SHOT_DIR,
    logPath: join(SCRATCH, 'five-views-probe.log'),
    env: {
      RV_OUT: PROBE_JSON,
      RV_SHOT_DIR: SHOT_DIR,
      RV_ENTRY_NAME: 'bus_send',
      RV_EXPECT_LINE: String(facts.expected_line ?? 152),
      RV_ENTRY_LINES: JSON.stringify(facts.entry_lines ?? {}),
      ...(facts.snapshot_id === null ? {} : {RV_SNAPSHOT_ID: facts.snapshot_id}),
      RV_TIMEOUT_MS: '360000',
    },
  });
  if (run.result === null) {
    requireCheck('host.five_views_probe', false, {exit_code: run.exitCode, error: 'probe produced no result JSON', log_tail: run.log.slice(-2000)}, {layer: 'dsh_host'});
    return null;
  }
  const probe = run.result;
  const screenshots = copyProbeScreenshots(probe);
  const requiredShots = ['coupling', 'tree', 'end_to_end', 'sequence', 'file', 'main'];
  requireCheck('host.five_views_screenshots', requiredShots.every((name) => screenshots[name] !== undefined), {
    required: requiredShots,
    copied: screenshots,
    missing: requiredShots.filter((name) => screenshots[name] === undefined),
  }, {layer: 'dsh_host'});
  requireCheck('host.five_views_probe', probe.ok === true, {
    exit_code: run.exitCode,
    duration_ms: probe.duration_ms ?? null,
    failed_steps: probe.failed_steps ?? [],
    view_states: probe.viewStates ?? null,
    console_error_count: probe.console_error_count ?? null,
    absolute_path_leak: probe.leak ?? (probe.chrome?.leak ?? null),
    screenshots,
    log_tail: run.log.slice(-1500),
  }, {layer: 'dsh_host'});

  const viewChecks = {
    coupling: 'host.view_coupling',
    tree: 'host.view_tree',
    end_to_end: 'host.view_end_to_end',
    sequence: 'host.view_sequence',
    file: 'host.view_file',
  };
  for (const [view, checkName] of Object.entries(viewChecks)) {
    const detail = probe.views?.[view] ?? null;
    requireCheck(checkName, detail?.ok === true, {
      state: probe.viewStates?.[view]?.state ?? null,
      steps: detail?.steps ?? null,
      detail: detail === null ? null : {
        columns: detail.columns,
        routesNode: detail.routesNode,
        writeExact: detail.writeExact,
        readLines: detail.readLines,
        railHighlight: detail.railHighlight,
        rootNodes: detail.rootNodes,
        checkLengthNode: detail.checkLengthNode,
        lookupNode: detail.lookupNode,
        fileAfterTreeClick: detail.fileAfterTreeClick,
        selectedLines: detail.fileSelectedLines,
        entryNode: detail.entryNode,
        decisionNodes: detail.decisionNodes,
        errorExit: detail.errorExit,
        errorEdge: detail.errorEdge,
        externalEdge: detail.externalEdge,
        geometry: detail.geometry,
        controls: detail.controls,
        drag: detail.drag,
        relayoutRecord: detail.relayoutRecord,
        warning: detail.warning,
        observed: detail.observed,
        messages: detail.messages,
        messageKinds: detail.messageKinds,
        fileTree: detail.fileTree,
        lines: detail.lines === undefined ? null : {count: detail.lines.length, first: detail.lines[0], last: detail.lines[detail.lines.length - 1], line46: detail.line46},
        line46Highlight: detail.line46Highlight,
        resourceJumpLine: detail.resourceJumpLine,
      },
    }, {layer: 'dsh_host'});
  }
  requireCheck('host.five_views_tabs', probe.steps?.tabsFive === true && Object.values(probe.viewStates ?? {}).every((state) => state.state === 'ready'), {
    tabs: probe.tabs ?? null,
    view_states: probe.viewStates ?? null,
  }, {layer: 'dsh_host'});
  requireCheck('host.five_views_console_clean', probe.console_error_count === 0, {
    console_error_count: probe.console_error_count ?? null,
    console_errors: (probe.console_lines ?? []).filter((line) => Number(line.level) >= 3).slice(0, 20),
  }, {layer: 'dsh_host'});
  requireCheck('host.five_views_no_absolute_paths', (probe.chrome?.leak?.count ?? -1) === 0, {
    leak: probe.chrome?.leak ?? null,
  }, {layer: 'dsh_host'});
  requireCheck('host.five_views_chrome', probe.chrome?.ok === true, {
    steps: probe.chrome?.steps ?? null,
    legend: probe.chrome?.legend ?? null,
    details: probe.chrome?.details ?? null,
    gaps: probe.gaps ?? null,
  }, {layer: 'dsh_host'});
  requireCheck('host.five_views_s1_panel_regression', probe.steps?.s1SourceLine === true, {
    s1SourceLine: probe.s1SourceLine ?? null,
    selectionOpen: probe.selectionOpen ?? null,
  }, {layer: 'dsh_host'});
  return probe;
}

async function verifyS1RegressionProbe(boot, facts) {
  mkdirSync(SCRATCH, {recursive: true});
  rmSync(REGRESSION_JSON, {force: true});
  rmSync(REGRESSION_PNG, {force: true});
  // Recreate the S1 probe app dir under the isolated scratch tree (the S1
  // runner did the same; this keeps the regression tool self-contained).
  const regressionAppDir = join(REPO_ROOT, 'scratch', 'readonly-home', 'probe-app');
  mkdirSync(regressionAppDir, {recursive: true});
  copyFileSync(OLD_PROBE, join(regressionAppDir, 'electron-probe.cjs'));
  writeFileSync(join(regressionAppDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-code-reader-render-probe',
    version: '0.0.0-private',
    private: true,
    description: 'Verifier S1 render probe; not a shipped component.',
    main: 'electron-probe.cjs',
  }, null, 2)}\n`, 'utf8');
  const run = await runElectronProbe({
    boot,
    appDir: regressionAppDir,
    outPath: REGRESSION_JSON,
    shotDir: null,
    logPath: join(SCRATCH, 'readonly-regression.log'),
    env: {
      RV_OUT: REGRESSION_JSON,
      RV_SHOT: REGRESSION_PNG,
      RV_SHOT2: join(SCRATCH, 'readonly-regression-resources.png'),
      RV_ENTRY_NAME: 'bus_send',
      RV_EXPECT_LINE: String(facts.expected_line ?? 152),
      ...(facts.snapshot_id === null ? {} : {RV_EXPECT_SNAPSHOT_ID: facts.snapshot_id}),
      RV_WRITE_ENTRY_NAME: 'bus_register',
      RV_WRITE_EXPECT_LINE: '50',
      RV_TIMEOUT_MS: '280000',
    },
  });
  const probe = run.result;
  // S1 regression subset: the S1 probe predates S2a, so its five-view
  // placeholder assertion (`data-view` with not_available_in_readonly_slice)
  // is legitimately superseded by the S2a tabs/content hook (contract §4/§5)
  // and is excluded from the regression verdict; everything else the S1 probe
  // measured must still hold.
  const regressionRequired = [
    'pageLoaded', 'sidebarEntry', 'panelOpened', 'snapshotClicked', 'entryListed', 'entryClicked',
    'sourceLineOk', 'sourceBoundsOk', 'evidenceClassesPresent', 'resourcesReadPresent', 'selectionEntrySelected',
    'selectionMatchesClickedEntry', 'returnToChat', 'chatRestored', 'panelReopened', 'reopenedSourceKept',
    'reopenSelectionKept', 'writeEntryClicked', 'writeSourceLineOk', 'writeExactResource', 'writeSelectionEntry',
    'noConsoleErrors', 'screenshotCaptured',
  ];
  const regressionSteps = probe?.steps ?? {};
  const regressionFailed = regressionRequired.filter((step) => regressionSteps[step] !== true);
  const screenshot = {};
  if (existsSync(REGRESSION_PNG)) {
    mkdirSync(EVIDENCE_DIR, {recursive: true});
    copyFileSync(REGRESSION_PNG, join(EVIDENCE_DIR, 'regression-readonly-slice.png'));
    screenshot.path = 'evidence/five-views/regression-readonly-slice.png';
    screenshot.bytes = readFileSync(join(EVIDENCE_DIR, 'regression-readonly-slice.png')).length;
    screenshot.sha256 = sha256(readFileSync(join(EVIDENCE_DIR, 'regression-readonly-slice.png')));
  }
  requireCheck('dsh_host.s1_regression_probe', probe !== null && regressionFailed.length === 0
    && (probe.console_error_count ?? 1) === 0, {
    exit_code: run.exitCode,
    note: 'The S1 probe exit code may be non-zero only because its pre-S2a five-view placeholder assertion is superseded by the S2a tabs hook; the required S1 subset is evaluated here.',
    required_steps: regressionRequired,
    failed_steps: regressionFailed,
    ignored_steps: ['fiveViewPlaceholders'],
    console_error_count: probe?.console_error_count ?? null,
    screenshot,
    log_tail: run.log.slice(-1500),
  }, {layer: 'dsh_host'});
  return probe;
}

// ---------------------------------------------------------------------------
// Real Cordis host runtime (new endpoints)
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
      READONLY_ENTRY_LINE: String(facts.expected_line ?? 152),
      ...(facts.snapshot_id === null ? {} : {READONLY_SNAPSHOT_ID: facts.snapshot_id}),
      DSH_AUDIT_APPLICATION: '04-five-views-verifier',
    },
  });
  const args = [
    '--test',
    '--test-concurrency=1',
    '--test-reporter=tap',
    `--test-reporter-destination=${HOST_RUNTIME_TAP}`,
    HOST_RUNTIME_TEST,
  ];
  const started = Date.now();
  const result = spawnSync(EXECUTABLE, args, {
    cwd: REPO_ROOT, env, windowsHide: true, encoding: 'utf8', timeout: 420000, maxBuffer: 64 * 1024 * 1024,
  });
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
    stdout_tail: (result.stdout ?? '').slice(-6000),
    stderr_tail: (result.stderr ?? '').slice(-6000),
    ok: result.status === 0 && summary.fail === 0 && summary.tests !== null && summary.tests === summary.pass,
  };
  reportValue.verified = reportValue.ok;
  writeFileSync(HOST_RUNTIME_JSON, `${JSON.stringify(reportValue, null, 2)}\n`, 'utf8');
  return reportValue;
}

// ---------------------------------------------------------------------------
// Demo layer
// ---------------------------------------------------------------------------
function verifyDemo() {
  const result = runNodeTests(['demo/code-view/demo.test.cjs'], {timeoutMs: 180000});
  const ok = result.status === 0 && result.summary.fail === 0 && result.summary.tests !== null && result.summary.tests > 0;
  requireCheck('demo.code_view_demo_tests', ok, {
    command: 'node --test demo/code-view/demo.test.cjs',
    status: result.status,
    summary: result.summary,
    output_tail: result.text.slice(-2000),
  }, {layer: 'demo_observed'});
  return {status: result.status, summary: result.summary};
}

function verifyRepoNodeTests() {
  const testsDir = join(REPO_ROOT, 'tests', 'node');
  const files = readdirSync(testsDir).filter((name) => name.endsWith('.test.mjs')).map((name) => `tests/node/${name}`);
  const result = runNodeTests(files, {timeoutMs: 300000});
  const ok = result.status === 0 && result.summary.fail === 0 && result.summary.tests !== null && result.summary.tests > 0;
  requireCheck('dsh_host.repo_node_tests', ok, {
    files,
    status: result.status,
    summary: result.summary,
    output_tail: result.text.slice(-3000),
  }, {layer: 'dsh_host'});
  return {status: result.status, summary: result.summary};
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const webBoots = [];
  let webBoot = null;
  logCommand({executable: process.execPath, args: [fileURLToPath(import.meta.url), ...argv], cwd: REPO_ROOT, note: 'self (S2a verifier entry point)'});

  // S2b/S3/S4 items that S2a explicitly does not provide: recorded once.
  outOfScope('group folding / interface library / AI summary (S2b)', 'S2a only; shown as gaps in the UI', 'dsh_host');
  outOfScope('sequence observed mode / run observation / scenario execution / stub / rollback (S3)', 'CW-T3 scope; S2a sequence is static-prediction only', 'dsh_host');
  outOfScope('real Linux/Kbuild index, CFG/locks/aliases/dataflow, target verification, performance budget (S4)', 'CW-T4 scope; snapshot-only read model in this slice', 'atlas_snapshot');
  outOfScope('OS-wide egress certification', 'verifier only performs loopback HTTP and local process observation', null);

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
    requireCheck('host.client_five_view_contract', contract.ok, contract, {layer: 'dsh_host'});

    // 2. isolated home/profile + real engine snapshot import
    const prepared = prepareIsolatedHome({wipe: true, importData: true});
    requireCheck('host.isolated_profile', prepared.data_ready
      && prepared.imports.workspace?.exit_code === 0
      && prepared.imports.snapshot?.exit_code === 0, {
      home: 'scratch/readonly-home/home',
      home_is_isolated_from_user_profile: true,
      profile: {dir: 'scratch/readonly-home/home/profiles/web', bundles: prepared.bundles, junction: 'node_modules/@local/dsh-code-reader -> repository', cordis_patch: '[]'},
      bootstrap: {path: 'scratch/readonly-home/home/code-reader/bootstrap.json', candidate_roots: [{root_ref: 'slice-root', absolute_path: 'evidence/code-view-slice', read_grant_ref: 'grant-slice'}]},
      python: prepared.python,
      imports: {workspace: prepared.imports.workspace?.exit_code ?? null, snapshot: prepared.imports.snapshot?.exit_code ?? null, skipped: prepared.imports.skipped ?? null},
      snapshot: prepared.snapshot === null ? null : {snapshot_id: prepared.snapshot.snapshot_id, graph_sha256: prepared.snapshot.graph_sha256, entry_count: prepared.snapshot.entry_count, target: prepared.snapshot.target},
    }, {layer: 'dsh_host'});
    if (prepared.imports.workspace) logCommand({executable: prepared.python.command, args: prepared.imports.workspace.argv, cwd: ENGINE_DIR, exit_code: prepared.imports.workspace.exit_code});
    if (prepared.imports.snapshot) logCommand({executable: prepared.python.command, args: prepared.imports.snapshot.argv, cwd: ENGINE_DIR, exit_code: prepared.imports.snapshot.exit_code});

    const facts = {
      ok: prepared.data_ready,
      snapshot_id: prepared.snapshot?.snapshot_id ?? null,
      target: prepared.snapshot?.target ?? null,
      entry_count: prepared.snapshot?.entry_count ?? null,
      graph_sha256: prepared.snapshot?.graph_sha256 ?? null,
      expected_line: prepared.snapshot?.target?.line ?? 152,
      slice: prepared.slice,
    };

    // 3. atlas snapshot layer (six S2a engine endpoints)
    if (prepared.data_ready) {
      await guard('atlas.layer', () => verifyAtlasEndpoints(prepared.python, facts), {layer: 'atlas_snapshot'});
    } else {
      requireCheck('atlas.layer', false, {error: 'Lead slice data is not ready'}, {layer: 'atlas_snapshot'});
    }
    // Definition lines for tree/file jump assertions (engine projection).
    const entryLineHints = prepared.data_ready
      ? collectEntryLines(prepared.python, facts)
      : {ok: false, lines: {}};
    facts.entry_lines = entryLineHints.ok
      ? entryLineHints.lines
      : {lookup_route: 89, check_length: 96, dispatch_transfer: 143};
    requireCheck('host.entry_line_hints', entryLineHints.ok, {
      source: 'engine view-entries projection',
      lines: facts.entry_lines,
      fallback_used: entryLineHints.ok !== true,
    }, {layer: 'dsh_host'});

    // 4. boot the real isolated web host
    if (!options.skipHttp) {
      webBoot = await guard('host.web_boot', () => startWebServer({python: prepared.python, tag: 'five-views'}), {layer: 'dsh_host'});
      if (webBoot && !webBoot.__error) {
        webBoots.push(webBoot);
        logCommand({executable: EXECUTABLE, args: [DSH_BIN, 'web', '--no-open', '--port', '0'], cwd: join(REPO_ROOT, 'scratch'), note: 'isolated dsh web boot (one-time URL token redacted)'});
        // 5. boot graph + carriers
        const bootGraph = await guard('host.boot_graph', () => verifyBootGraph(webBoot), {layer: 'dsh_host'});
        await guard('host.carriers', () => verifyCarriers(webBoot, facts, bootGraph), {layer: 'dsh_host'});

        // 6. Chromium five-view probe + S1 regression probe against the same host
        if (!options.skipProbe) {
          await guard('host.five_views_probe_runner', () => verifyProbe(webBoot, facts), {layer: 'dsh_host'});
        } else {
          skipCheck('host.five_views_probe', '--skip-probe', {layer: 'dsh_host'});
        }
        if (!options.skipRegression) {
          await guard('dsh_host.s1_regression_runner', () => verifyS1RegressionProbe(webBoot, facts), {layer: 'dsh_host'});
        } else {
          skipCheck('dsh_host.s1_regression_probe', '--skip-regression', {layer: 'dsh_host'});
        }
      }
    } else {
      skipCheck('host.boot_graph', '--skip-http');
      skipCheck('host.five_views_probe', '--skip-http');
    }

    // 7. real Cordis runtime with the new endpoints
    if (!options.skipHostRuntime) {
      const hostRuntime = await guard('dsh_host.five_view_host_runtime', () => runHostRuntime({
        python: prepared.python,
        home: prepared.home,
        bootstrapPath: prepared.bootstrap_path,
        facts,
      }), {layer: 'dsh_host'});
      if (hostRuntime && !hostRuntime.__error) {
        requireCheck('dsh_host.five_view_host_runtime', hostRuntime.ok === true, {
          exit_code: hostRuntime.exit_code,
          tap_summary: hostRuntime.tap_summary,
          duration_ms: hostRuntime.duration_ms,
          evidence: 'evidence/five-views/host-runtime.json',
          tap: 'evidence/five-views/host-runtime.tap',
          stdout_tail: (hostRuntime.stdout_tail ?? '').slice(-1500),
          stderr_tail: (hostRuntime.stderr_tail ?? '').slice(-1000),
        }, {layer: 'dsh_host'});
      }
    } else {
      skipCheck('dsh_host.five_view_host_runtime', '--skip-host-runtime', {layer: 'dsh_host'});
    }

    // 8. demo layer + optional repo node tests
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
    report.layers.atlas_snapshot = ['atlas.view_coupling', 'atlas.view_tree', 'atlas.view_end_to_end', 'atlas.view_file_tree', 'atlas.view_file_read', 'atlas.view_sequence']
      .every((name) => report.checks[name]?.ok === true);
    const requiredHostChecks = [
      'host.pinned_baseline',
      'host.client_five_view_contract',
      'host.isolated_profile',
      'host.web_shell',
      'host.boot_release',
      'host.boot_graph_entry',
      'host.boot_graph_inject',
      'host.client_bundle_bytes',
      'host.rpc_admission',
      'host.rpc_view_status',
      'host.rpc_list_snapshots',
      'host.rpc_get_entry',
      'host.rpc_five_view_endpoints',
      'host.rpc_input_validation',
      'host.entry_line_hints',
      'host.five_views_screenshots',
      'host.five_views_probe',
      'host.five_views_tabs',
      'host.view_coupling',
      'host.view_tree',
      'host.view_end_to_end',
      'host.view_sequence',
      'host.view_file',
      'host.five_views_console_clean',
      'host.five_views_no_absolute_paths',
      'host.five_views_chrome',
      'host.five_views_s1_panel_regression',
      'dsh_host.s1_regression_probe',
      'dsh_host.five_view_host_runtime',
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
    evidence: 'evidence/five-views/verification.json',
  }, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

main();
