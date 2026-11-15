#!/usr/bin/env node
// Independent black-box acceptance runner for S2b (read-only group folding,
// basic interface library, subflow + breadcrumb) on the real pinned rc.5
// DSH web host. Never imports plugin modules for assertions and never writes
// into the plugin implementation.
//
// Layers (kept separate, never mixed):
//   demo_observed   `node --test demo/code-view/demo.test.cjs`
//   atlas_snapshot  real engine CLI projections: S2a six endpoints + S2b
//                   groups / view.interfaces / subflow breadcrumb
//   dsh_host        pinned host gate + isolated web profile boot graph +
//                   /code-view carriers (old/S2a/S2b endpoints) + Chromium:
//                   S2a five-view regression probe, S2b groups/interfaces/
//                   subflow probe, S1 readonly slice regression probe +
//                   real Cordis mount/dispose/remount runtime test
//
// Output: evidence/s2b/verification.json, commands.log, README (authored
// separately), per-feature PNGs (groups/interfaces/subflow/main) plus S2a
// regression screenshots; out_of_scope items stay in not_verified flagged.
//
// Usage: node tools/verify-s2b.mjs [--skip-probes] [--skip-regression]
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
  REPO_ROOT,
  WORKSPACE_ID,
  inspectSnapshot,
  isolatedEnv,
  prepareIsolatedHome,
  readJsonFile,
  runEngineCli,
} from './readonly-slice/isolated-home.mjs';
import {extractBootManifest, fetchShell, httpFetch, startWebServer} from './readonly-slice/web-host.mjs';

const EVIDENCE_DIR = join(REPO_ROOT, 'evidence', 's2b');
const COMMANDS_PATH = join(EVIDENCE_DIR, 'commands.log');
const REPORT_PATH = join(EVIDENCE_DIR, 'verification.json');
const SCRATCH = join(REPO_ROOT, 'scratch', 's2b');
const S2B_SHOT_DIR = join(SCRATCH, 'shots');
const S2A_SHOT_DIR = join(SCRATCH, 's2a-shots');
const S2B_PROBE_JSON = join(SCRATCH, 's2b-probe.json');
const S2A_PROBE_JSON = join(SCRATCH, 's2a-probe.json');
const REGRESSION_JSON = join(SCRATCH, 'readonly-regression.json');
const REGRESSION_PNG = join(SCRATCH, 'readonly-regression.png');
const HOST_RUNTIME_TAP = join(EVIDENCE_DIR, 'host-runtime.tap');
const HOST_RUNTIME_JSON = join(EVIDENCE_DIR, 'host-runtime.json');
const S2B_PROBE = join(REPO_ROOT, 'tools', 's2b-probe.cjs');
const FIVE_VIEWS_PROBE = join(REPO_ROOT, 'tools', 'five-views-probe.cjs');
const OLD_PROBE = join(REPO_ROOT, 'tools', 'readonly-slice', 'electron-probe.cjs');
const HOST_RUNTIME_TEST = 'tools/s2b-host-runtime.test.mjs';
const PACKAGE_JSON = join(REPO_ROOT, 'package.json');

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
  stage: 'S2b',
  contract: 'docs/five-view-contract.md §10 (CL-VIEW-T2 S2b increment)',
  started_at_utc: startedAt,
  purpose:
    'Independent black-box acceptance of S2b: S2a five-view regression, end-to-end groups (collapse/expand/rename/edge metadata), basic interface library (candidates + blackbox add/remove), subflow + breadcrumb via details tabs, on the real isolated rc.5 dsh web plus real engine and Cordis runtime.',
  host: HOST_BASELINE,
  layers: {demo_observed: false, atlas_snapshot: false, dsh_host: false},
  checks: {},
  not_verified: [],
  commands: [],
  environment: {node: process.versions.node, platform: process.platform, workspace: REPO_ROOT},
  limitations: [
    'Uses the locally installed generic Electron binary only as the Chromium test instrument; it is not a shipped dependency.',
    'The isolated fresh DSH_HOME may show the host first-run overlay in screenshots; the S2b DOM assertions are recorded independently of that host UI (captures close host overlays first).',
    'No OS-wide egress certification; this acceptance performs local loopback HTTP and local process observation only.',
    'DEMO layer is the Wasm/JS demo model, ATLAS is the real imported snapshot read model, DSH_HOST is the pinned local rc.5; the three are never mixed.',
    'Group labels/descriptions are structural heuristics (private-callee subflows), not semantic understanding; the UI must mark them as such.',
    'AI summary text, scenario execution/stub/rollback, run observation, real Linux/Kbuild and CFG/locks/aliases remain S3/S4 scope and are listed as out_of_scope.',
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

function runNodeTests(files, {cwd = REPO_ROOT, timeoutMs = 300000} = {}) {
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
    checks.client_s2a_labels = ['资源关系图', '文字树', '端到端图', '时序图', '文件视图'].every((label) => clientText.includes(label));
    checks.client_s2b_hooks = ['data-graph-group', 'data-group-toggle', 'data-graph-collapse-all', 'data-graph-expand-all',
      'data-interface-library', 'data-interface-candidate', 'data-interface-action', 'data-blackbox-node',
      'data-code-view', 'details-tab', 'data-breadcrumb'].every((hook) => clientText.includes(hook));
  }
  return {
    ok: Object.values(checks).every((value) => value === true),
    package: {name: pkg.name, version: pkg.version, main: pkg.main, dsh: pkg.dsh},
    client_bundle: {path: 'bundle/client.js', bytes: clientBytes.length, sha256: checks.client_bundle_exists ? sha256(clientBytes) : null},
    checks,
  };
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
// Atlas layer: S2a endpoints + S2b groups/interfaces/breadcrumb projections
// ---------------------------------------------------------------------------
function cli(python, args) {
  const result = runEngineCli({python, args});
  logCommand({executable: python.command, args: result.argv, cwd: ENGINE_DIR, exit_code: result.exit_code});
  return result;
}

async function verifyAtlasS2a(python, facts) {
  const workspaceId = facts.slice?.workspace_manifest?.workspace_id ?? WORKSPACE_ID;
  const snapshotId = facts.snapshot_id;
  const entryId = facts.target?.entry_id;
  if (!facts.ok || snapshotId === null) throw new Error('Lead slice data is not ready');

  const coupling = cli(python, ['view-coupling', '--workspace', workspaceId, '--snapshot', snapshotId, '--entry', entryId]);
  const couplingValue = coupling.stdout_json ?? {};
  const accesses = (couplingValue.resources ?? []).flatMap((resource) => resource.accesses ?? []);
  const writeExact = accesses.filter((access) => access.access === 'write' && access.certainty === 'exact' && access.field_name === 'max_len' && access.location?.line === 46);
  const readLines = [...new Set(accesses.filter((access) => access.access === 'read' && access.certainty === 'may' && access.field_name === 'max_len').map((access) => access.location?.line))];
  requireCheck('atlas.view_coupling', coupling.ok
    && (couplingValue.resources ?? []).some((resource) => resource.name === 'routes')
    && writeExact.length > 0
    && [92, 93, 98].every((line) => readLines.includes(line))
    && absolutePathLeakInJson(couplingValue).count === 0, {
    command: 'view-coupling',
    resources: (couplingValue.resources ?? []).map((resource) => ({name: resource.name, file: resource.file, line: resource.line})),
    write_exact_max_len_46: writeExact.length,
    read_may_lines: readLines.sort((left, right) => left - right),
    error: coupling.ok ? null : (coupling.stdout_json?.error ?? coupling.stderr_tail),
  }, {layer: 'atlas_snapshot'});

  const tree = cli(python, ['view-tree', '--workspace', workspaceId, '--snapshot', snapshotId, '--entry', entryId]);
  const treeValue = tree.stdout_json ?? {};
  const treeText = JSON.stringify(treeValue.nodes ?? []);
  const checkLengthNode = (treeValue.nodes ?? []).find((node) => node.symbol?.name === 'check_length');
  requireCheck('atlas.view_tree', tree.ok
    && treeValue.entry?.name === 'bus_send'
    && ['lookup_route', 'check_length', 'dispatch_transfer'].every((name) => treeText.includes(name))
    && checkLengthNode !== undefined
    && (checkLengthNode.guards ?? []).length > 0
    && absolutePathLeakInJson(treeValue).count === 0, {
    command: 'view-tree',
    entry: treeValue.entry ?? null,
    node_count: (treeValue.nodes ?? []).length,
    guard: checkLengthNode?.guards ?? null,
    error: tree.ok ? null : (tree.stdout_json?.error ?? tree.stderr_tail),
  }, {layer: 'atlas_snapshot'});

  const endToEnd = cli(python, ['view-end-to-end', '--workspace', workspaceId, '--snapshot', snapshotId, '--entry', entryId]);
  const endValue = endToEnd.stdout_json ?? {};
  const errorExit = (endValue.exits ?? []).find((exit) => exit.role === 'error' && String(exit.expression).includes('-90'));
  requireCheck('atlas.view_end_to_end', endToEnd.ok
    && (endValue.nodes ?? []).some((node) => node.kind === 'entry' && node.label === 'bus_send')
    && (endValue.nodes ?? []).some((node) => node.kind === 'decision')
    && errorExit !== undefined
    && (endValue.nodes ?? []).some((node) => node.kind === 'external' && String(node.label).includes('platform_write'))
    && endValue.layout?.direction === 'DOWN'
    && endValue.layout?.edge_routing === 'ORTHOGONAL'
    && absolutePathLeakInJson(endValue).count === 0, {
    command: 'view-end-to-end',
    node_count: (endValue.nodes ?? []).length,
    edge_count: (endValue.edges ?? []).length,
    error_exit: errorExit ?? null,
    layout: endValue.layout ?? null,
    error: endToEnd.ok ? null : (endToEnd.stdout_json?.error ?? endToEnd.stderr_tail),
  }, {layer: 'atlas_snapshot'});

  const fileTree = cli(python, ['view-file-tree', '--workspace', workspaceId, '--snapshot', snapshotId]);
  const fileTreeValue = fileTree.stdout_json ?? {};
  requireCheck('atlas.view_file_tree', fileTree.ok
    && (fileTreeValue.repos ?? []).some((repo) => repo.repo_id === 'bus' && (repo.files ?? []).some((file) => file.path === 'bus.c'))
    && absolutePathLeakInJson(fileTreeValue).count === 0, {
    command: 'view-file-tree',
    repos: (fileTreeValue.repos ?? []).map((repo) => ({repo_id: repo.repo_id, files: (repo.files ?? []).map((file) => file.path)})),
    error: fileTree.ok ? null : (fileTree.stdout_json?.error ?? fileTree.stderr_tail),
  }, {layer: 'atlas_snapshot'});

  const fileRead = cli(python, ['view-file-read', '--workspace', workspaceId, '--snapshot', snapshotId, '--repo', 'bus', '--path', 'bus.c']);
  const fileReadValue = fileRead.stdout_json ?? {};
  requireCheck('atlas.view_file_read', fileRead.ok
    && fileReadValue.path === 'bus.c'
    && fileReadValue.total_lines === 174
    && (fileReadValue.lines ?? []).some((line) => line.n === 46 && /max_len/.test(line.text))
    && absolutePathLeakInJson(fileReadValue).count === 0, {
    command: 'view-file-read',
    total_lines: fileReadValue.total_lines,
    sha256: fileReadValue.sha256,
    line_46: (fileReadValue.lines ?? []).find((line) => line.n === 46) ?? null,
    error: fileRead.ok ? null : (fileRead.stdout_json?.error ?? fileRead.stderr_tail),
  }, {layer: 'atlas_snapshot'});

  const sequence = cli(python, ['view-sequence', '--workspace', workspaceId, '--snapshot', snapshotId, '--entry', entryId, '--mode', 'static']);
  const sequenceValue = sequence.stdout_json ?? {};
  requireCheck('atlas.view_sequence', sequence.ok
    && sequenceValue.observed === false
    && /静态预测/.test(sequenceValue.warning ?? '')
    && (sequenceValue.gaps ?? []).some((gap) => gap.code === 'run_observation')
    && absolutePathLeakInJson(sequenceValue).count === 0, {
    command: 'view-sequence',
    observed: sequenceValue.observed,
    message_count: (sequenceValue.messages ?? []).length,
    gaps: sequenceValue.gaps ?? [],
    error: sequence.ok ? null : (sequence.stdout_json?.error ?? sequence.stderr_tail),
  }, {layer: 'atlas_snapshot'});

  return {workspaceId, snapshotId, entryId, endToEnd: endValue};
}

async function verifyAtlasS2b(python, facts) {
  const workspaceId = facts.slice?.workspace_manifest?.workspace_id ?? WORKSPACE_ID;
  const snapshotId = facts.snapshot_id;
  const entryId = facts.target?.entry_id;

  // 1. view.interfaces: platform_write (cross_file + side effects) + >=2 independent.
  let interfaces = cli(python, ['view-interfaces', '--workspace', workspaceId, '--snapshot', snapshotId, '--entry', entryId]);
  if (!interfaces.ok && interfaces.exit_code !== 0) {
    interfaces = cli(python, ['view-interfaces', '--workspace', workspaceId, '--snapshot', snapshotId]);
  }
  const interfacesValue = interfaces.stdout_json ?? {};
  const candidates = interfacesValue.candidates ?? [];
  const platformWrite = candidates.find((candidate) => candidate.name === 'platform_write') ?? null;
  const independent = candidates.filter((candidate) => candidate.decoupling === 'independent');
  requireCheck('atlas.view_interfaces', interfaces.ok
    && candidates.length > 0
    && platformWrite !== null
    && platformWrite.cross_file === true
    && (platformWrite.field_accesses ?? []).some((access) => access.access === 'write')
    && (platformWrite.reasons ?? []).length > 0
    && (platformWrite.parameters ?? []).length === 2
    && independent.length >= 2
    && candidates.every((candidate) => candidate.certainty === 'may')
    && absolutePathLeakInJson(interfacesValue).count === 0, {
    command: 'view-interfaces',
    candidate_count: candidates.length,
    platform_write: platformWrite === null ? null : {
      interface_id: platformWrite.interface_id,
      file: platformWrite.file,
      line: platformWrite.line,
      signature: platformWrite.signature,
      cross_file: platformWrite.cross_file,
      leaf: platformWrite.leaf,
      decoupling: platformWrite.decoupling,
      reasons: platformWrite.reasons,
      field_accesses: platformWrite.field_accesses,
      parameters: platformWrite.parameters,
      return_type: platformWrite.return_type,
      callers: (platformWrite.callers ?? []).map((caller) => ({name: caller.name, file: caller.file, line: caller.line})),
    },
    independent: independent.map((candidate) => candidate.name),
    candidates_all_may: candidates.every((candidate) => candidate.certainty === 'may'),
    external_boundaries: interfacesValue.external_boundaries ?? null,
    error: interfaces.ok ? null : (interfaces.stdout_json?.error ?? interfaces.stderr_tail),
  }, {layer: 'atlas_snapshot'});

  // 2. endToEnd groups: >=2 (dispatch_transfer / commit_transfer subflows),
  //    edge ids/metadata unchanged (no edge merging), grouping summary present.
  const endToEnd = cli(python, ['view-end-to-end', '--workspace', workspaceId, '--snapshot', snapshotId, '--entry', entryId]);
  const endValue = endToEnd.stdout_json ?? {};
  const groups = endValue.groups ?? [];
  const labels = groups.map((group) => String(group.label ?? ''));
  requireCheck('atlas.end_to_end_groups', endToEnd.ok
    && groups.length >= 2
    && labels.some((label) => label.includes('dispatch_transfer'))
    && labels.some((label) => label.includes('commit_transfer'))
    && groups.every((group) => Array.isArray(group.member_node_ids) && group.member_node_ids.length >= 2
      && (group.limitations ?? []).length > 0 && typeof group.group_id === 'string')
    && endValue.grouping?.algorithm === 'private_callee_subflow'
    && endValue.grouping?.groups === groups.length
    && (endValue.edges ?? []).length >= 31
    && absolutePathLeakInJson(endValue).count === 0, {
    command: 'view-end-to-end (groups)',
    groups: groups.map((group) => ({
      group_id: group.group_id,
      label: group.label,
      parent_group_id: group.parent_group_id ?? null,
      members: group.member_node_ids,
      entry_nodes: group.entry_node_ids ?? null,
      exit_nodes: group.exit_node_ids ?? null,
      collapsed_default: group.collapsed_default ?? null,
      limitations: group.limitations ?? [],
    })),
    grouping: endValue.grouping ?? null,
    edge_count: (endValue.edges ?? []).length,
    error: endToEnd.ok ? null : (endToEnd.stdout_json?.error ?? endToEnd.stderr_tail),
  }, {layer: 'atlas_snapshot'});

  // 3. subflow breadcrumb: view.endToEnd {entry: check_length, root: bus_send}.
  const checkLength = cli(python, ['view-entry', '--workspace', workspaceId, '--snapshot', snapshotId, '--entry', facts.check_length_id ?? '']);
  const checkLengthId = facts.check_length_id
    ?? (interfacesValue.candidates ?? []).find((candidate) => candidate.name === 'check_length')?.function_id
    ?? checkLength.stdout_json?.entry?.entry_id
    ?? null;
  const attempts = [
    ['view-end-to-end', '--workspace', workspaceId, '--snapshot', snapshotId, '--entry', checkLengthId, '--root', entryId],
    ['view-end-to-end', '--workspace', workspaceId, '--snapshot', snapshotId, '--entry', checkLengthId, '--root', entryId, '--mode', 'subflow'],
  ];
  let subflow = null;
  let subflowArgs = null;
  for (const args of attempts) {
    const attempt = cli(python, args);
    if (attempt.ok && Array.isArray(attempt.stdout_json?.breadcrumb)) {
      subflow = attempt;
      subflowArgs = args;
      break;
    }
  }
  const subflowValue = subflow?.stdout_json ?? {};
  const breadcrumb = subflowValue.breadcrumb ?? [];
  const names = breadcrumb.map((crumb) => crumb.name);
  requireCheck('atlas.end_to_end_breadcrumb', subflow !== null
    && names.includes('bus_send')
    && names.includes('check_length')
    && breadcrumb.length >= 2
    && absolutePathLeakInJson(subflowValue).count === 0, {
    command: subflowArgs === null ? 'view-end-to-end (root/breadcrumb) — no accepted argv shape' : subflowArgs.join(' '),
    breadcrumb,
    entry: subflowValue.entry ?? null,
    snapshot: subflowValue.snapshot ?? null,
    error: subflow === null ? 'endToEnd with root/breadcrumb not accepted by the engine CLI yet' : null,
  }, {layer: 'atlas_snapshot'});

  return {interfaces: interfacesValue, endToEnd: endValue, subflow: subflowValue};
}

/** Entry name → id map for the S2b checks (engine projection). */
function collectEntryIds(python, facts) {
  const workspaceId = facts.slice?.workspace_manifest?.workspace_id ?? WORKSPACE_ID;
  const result = cli(python, ['view-entries', '--workspace', workspaceId, '--snapshot', facts.snapshot_id]);
  const byName = {};
  const byLine = {};
  for (const row of result.stdout_json?.entries ?? []) {
    if (typeof row.name === 'string') byName[row.name] = row.entry_id;
    if (typeof row.name === 'string' && typeof row.line === 'number') byLine[row.name] = row.line;
  }
  return {ok: result.ok && Object.keys(byName).length > 0, byName, byLine};
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

async function verifyCarriers(boot, facts, bootGraph, ids) {
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
  const entryId = ids.byName['bus_send'] ?? facts.target?.entry_id;
  const entryCall = await callRpc(boot, cookieHeader, 'view.getEntry', {workspace: workspaceId, snapshot: snapshotId, entry: entryId}, 'verify-entry-1');
  requireCheck('host.rpc_get_entry', entryCall.parsed?.result?.ok === true
    && entryCall.parsed?.result?.value?.source?.status === 'ok'
    && (entryCall.parsed?.result?.value?.calls ?? []).some((call) => call.certainty === 'exact'), {
    source: entryCall.parsed?.result?.value?.source ?? null,
    calls: (entryCall.parsed?.result?.value?.calls ?? []).length,
  }, {layer: 'dsh_host'});

  const s2aPayloads = {
    'view.coupling': {workspace: workspaceId, snapshot: snapshotId, entry: entryId},
    'view.tree': {workspace: workspaceId, snapshot: snapshotId, entry: entryId},
    'view.endToEnd': {workspace: workspaceId, snapshot: snapshotId, entry: entryId},
    'view.fileTree': {workspace: workspaceId, snapshot: snapshotId},
    'view.fileRead': {workspace: workspaceId, snapshot: snapshotId, repo: 'bus', path: 'bus.c'},
    'view.sequence': {workspace: workspaceId, snapshot: snapshotId, entry: entryId, mode: 'static'},
  };
  const endpointResults = {};
  let endpointsOk = true;
  for (const [endpoint, payload] of Object.entries(s2aPayloads)) {
    const response = await callRpc(boot, cookieHeader, endpoint, payload, `verify-${endpoint.replace(/\./g, '-')}`);
    const value = response.parsed?.result?.value;
    const ok = response.status === 200 && response.parsed?.type === 'server-response'
      && response.parsed?.result?.ok === true && value !== null && typeof value === 'object'
      && value.schema_version === 1 && absolutePathLeakInJson(response.text).count === 0;
    if (!ok) endpointsOk = false;
    endpointResults[endpoint] = {ok, http_status: response.status, error: response.parsed?.result?.error ?? null, keys: value === null || typeof value !== 'object' ? null : Object.keys(value).slice(0, 20)};
  }
  requireCheck('host.rpc_s2a_endpoints', endpointsOk, endpointResults, {layer: 'dsh_host'});

  // S2b: view.interfaces + endToEnd groups + subflow root/breadcrumb via carrier.
  const interfaces = await callRpc(boot, cookieHeader, 'view.interfaces', {workspace: workspaceId, snapshot: snapshotId, entry: entryId}, 'verify-interfaces');
  const interfacesValue = interfaces.parsed?.result?.value ?? {};
  const platformWrite = (interfacesValue.candidates ?? []).find((candidate) => candidate.name === 'platform_write');
  const independent = (interfacesValue.candidates ?? []).filter((candidate) => candidate.decoupling === 'independent');
  requireCheck('host.rpc_view_interfaces', interfaces.parsed?.result?.ok === true
    && platformWrite !== undefined
    && platformWrite.cross_file === true
    && (platformWrite.field_accesses ?? []).some((access) => access.access === 'write')
    && independent.length >= 2
    && (interfacesValue.candidates ?? []).every((candidate) => candidate.certainty === 'may')
    && absolutePathLeakInJson(interfaces.text).count === 0, {
    http_status: interfaces.status,
    candidate_count: (interfacesValue.candidates ?? []).length,
    platform_write: platformWrite ?? null,
    independent: independent.map((candidate) => candidate.name),
    error: interfaces.parsed?.result?.error ?? null,
  }, {layer: 'dsh_host'});

  const endToEnd = await callRpc(boot, cookieHeader, 'view.endToEnd', {workspace: workspaceId, snapshot: snapshotId, entry: entryId}, 'verify-e2e-s2b');
  const groups = endToEnd.parsed?.result?.value?.groups ?? [];
  requireCheck('host.rpc_end_to_end_groups', endToEnd.parsed?.result?.ok === true
    && groups.length >= 2
    && groups.map((group) => String(group.label ?? '')).some((label) => label.includes('dispatch_transfer'))
    && absolutePathLeakInJson(endToEnd.text).count === 0, {
    http_status: endToEnd.status,
    groups: groups.map((group) => ({group_id: group.group_id, label: group.label, members: group.member_node_ids})),
    grouping: endToEnd.parsed?.result?.value?.grouping ?? null,
    error: endToEnd.parsed?.result?.error ?? null,
  }, {layer: 'dsh_host'});

  const checkLengthId = ids.byName['check_length'] ?? null;
  let subflow = null;
  if (checkLengthId !== null) {
    const body = {workspace: workspaceId, snapshot: snapshotId, entry: checkLengthId, root: entryId};
    subflow = await callRpc(boot, cookieHeader, 'view.endToEnd', body, 'verify-subflow');
  }
  const breadcrumb = subflow?.parsed?.result?.value?.breadcrumb ?? [];
  const crumbNames = breadcrumb.map((crumb) => crumb.name);
  requireCheck('host.rpc_subflow_breadcrumb', subflow !== null
    && subflow.parsed?.result?.ok === true
    && crumbNames.includes('bus_send')
    && crumbNames.includes('check_length')
    && absolutePathLeakInJson(subflow.text).count === 0, {
    http_status: subflow?.status ?? null,
    breadcrumb,
    error: subflow?.parsed?.result?.error ?? null,
  }, {layer: 'dsh_host'});

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
// Chromium probes (S2a regression, S2b delta, S1 regression)
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

async function runElectronProbe({boot, outPath, shotDir, env, appDir, logPath, timeoutMs = 480000}) {
  const userDataDir = join(SCRATCH, 'electron-userdata');
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
  logCommand({executable: RENDER_PROBE_ELECTRON, args: [appDir, '--no-sandbox', '--disable-gpu'], cwd: REPO_ROOT, exit_code: exitCode});
  const result = existsSync(outPath) ? readJsonFile(outPath) : null;
  return {exitCode, log, result, shotDir};
}

function copyScreenshots(probeResult, prefix, requiredNames) {
  const copied = {};
  mkdirSync(EVIDENCE_DIR, {recursive: true});
  for (const name of requiredNames) {
    const record = probeResult?.screenshots?.[name];
    if (record?.path === undefined || !existsSync(record.path)) continue;
    const targetName = prefix === null ? `${name}.png` : `${prefix}-${name}.png`;
    const target = join(EVIDENCE_DIR, targetName);
    copyFileSync(record.path, target);
    copied[name] = {path: `evidence/s2b/${targetName}`, bytes: readFileSync(target).length, sha256: sha256(readFileSync(target))};
  }
  return copied;
}

async function verifyS2aRegressionProbe(boot, facts) {
  const appDir = prepareProbeApp(FIVE_VIEWS_PROBE, 's2a-probe-app', 'five-views-probe.cjs');
  mkdirSync(S2A_SHOT_DIR, {recursive: true});
  rmSync(S2A_PROBE_JSON, {force: true});
  const run = await runElectronProbe({
    boot, appDir,
    outPath: S2A_PROBE_JSON,
    shotDir: S2A_SHOT_DIR,
    logPath: join(SCRATCH, 's2a-probe.log'),
    env: {
      RV_OUT: S2A_PROBE_JSON,
      RV_SHOT_DIR: S2A_SHOT_DIR,
      RV_ENTRY_NAME: 'bus_send',
      RV_EXPECT_LINE: String(facts.target?.line ?? 152),
      RV_ENTRY_LINES: JSON.stringify(facts.entry_lines ?? {}),
      ...(facts.snapshot_id === null ? {} : {RV_SNAPSHOT_ID: facts.snapshot_id}),
      RV_TIMEOUT_MS: '360000',
    },
  });
  const probe = run.result;
  const screenshots = copyScreenshots(probe, 's2a', ['coupling', 'tree', 'end_to_end', 'sequence', 'file', 'main']);
  const requiredShots = ['coupling', 'tree', 'end_to_end', 'sequence', 'file', 'main'];
  // S2a regression on an S2b tree: the five views and their hooks must still
  // work. The only legitimately superseded assertion is the coupling gap text
  // (组折叠 / 接口库 are now implemented in S2b, so those gaps disappear from
  // the panel by design; contract §10 adds them as features, not gaps).
  const probeViews = probe?.views ?? {};
  const couplingSteps = probeViews.coupling?.steps ?? {};
  const couplingIgnored = ['gapsOriginal'];
  const couplingFailed = Object.entries(couplingSteps)
    .filter(([key, value]) => value !== true && !couplingIgnored.includes(key))
    .map(([key]) => key);
  const otherViews = ['tree', 'end_to_end', 'sequence', 'file'];
  const otherViewsOk = otherViews.every((view) => probeViews[view]?.ok === true);
  const chrome = probe?.chrome ?? {};
  const chromeIgnored = ['gapsVerbatim'];
  const chromeFailed = Object.entries(chrome.steps ?? {})
    .filter(([key, value]) => value !== true && !chromeIgnored.includes(key))
    .map(([key]) => key);
  requireCheck('regression.five_views_probe', probe !== null
    && couplingFailed.length === 0
    && otherViewsOk
    && (chrome.ok === true || chromeFailed.length === 0)
    && (probe.console_error_count ?? 1) === 0, {
    exit_code: run.exitCode,
    duration_ms: probe?.duration_ms ?? null,
    failed_steps: probe?.failed_steps ?? [],
    view_states: probe?.viewStates ?? null,
    coupling_failed: couplingFailed,
    coupling_ignored_superseded: couplingIgnored,
    other_views: Object.fromEntries(otherViews.map((view) => [view, probeViews[view]?.ok ?? null])),
    chrome_failed: chromeFailed,
    chrome_ignored: chromeIgnored,
    console_error_count: probe?.console_error_count ?? null,
    screenshots,
    log_tail: run.log.slice(-1200),
  }, {layer: 'dsh_host'});
  requireCheck('regression.five_views_screenshots', requiredShots.every((name) => screenshots[name] !== undefined)
    && new Set(requiredShots.map((name) => screenshots[name]?.sha256)).size >= 5, {
    required: requiredShots,
    copied: screenshots,
    unique_frames: new Set(requiredShots.map((name) => screenshots[name]?.sha256)).size,
  }, {layer: 'dsh_host'});
  requireCheck('regression.five_views_console_clean', (probe?.console_error_count ?? 1) === 0, {
    console_error_count: probe?.console_error_count ?? null,
    console_errors: (probe?.console_lines ?? []).filter((line) => Number(line.level) >= 3).slice(0, 20),
  }, {layer: 'dsh_host'});
  return probe;
}

async function verifyS2bProbe(boot, facts) {
  const appDir = prepareProbeApp(S2B_PROBE, 's2b-probe-app', 's2b-probe.cjs');
  mkdirSync(S2B_SHOT_DIR, {recursive: true});
  rmSync(S2B_PROBE_JSON, {force: true});
  const run = await runElectronProbe({
    boot, appDir,
    outPath: S2B_PROBE_JSON,
    shotDir: S2B_SHOT_DIR,
    logPath: join(SCRATCH, 's2b-probe.log'),
    env: {
      RV_OUT: S2B_PROBE_JSON,
      RV_SHOT_DIR: S2B_SHOT_DIR,
      RV_ENTRY_NAME: 'bus_send',
      RV_EXPECT_LINE: String(facts.target?.line ?? 152),
      ...(facts.snapshot_id === null ? {} : {RV_SNAPSHOT_ID: facts.snapshot_id}),
      RV_SUBFLOW_ENTRY: 'check_length',
      RV_TIMEOUT_MS: '420000',
    },
  });
  const probe = run.result;
  const copied = copyScreenshots(probe, null, ['groups', 'interfaces', 'subflow', 'main']);
  requireCheck('host.s2b_probe', probe !== null && probe.ok === true, {
    exit_code: run.exitCode,
    duration_ms: probe?.duration_ms ?? null,
    failed_steps: probe?.failed_steps ?? [],
    steps: probe?.steps ?? null,
    console_error_count: probe?.console_error_count ?? null,
    screenshots: copied,
    log_tail: run.log.slice(-1600),
  }, {layer: 'dsh_host'});
  requireCheck('host.s2b_screenshots', ['groups', 'interfaces', 'subflow', 'main'].every((name) => copied[name] !== undefined)
    && new Set(['groups', 'interfaces', 'subflow', 'main'].map((name) => copied[name]?.sha256)).size >= 3, {
    required: ['groups', 'interfaces', 'subflow', 'main'],
    copied,
    missing: ['groups', 'interfaces', 'subflow', 'main'].filter((name) => copied[name] === undefined),
    unique_frames: new Set(['groups', 'interfaces', 'subflow', 'main'].map((name) => copied[name]?.sha256)).size,
  }, {layer: 'dsh_host'});
  for (const [view, checkName] of Object.entries({
    groups: 'host.s2b_groups',
    interfaces: 'host.s2b_interfaces',
    subflow: 'host.s2b_subflow',
  })) {
    const detail = probe?.views?.[view] ?? null;
    requireCheck(checkName, detail?.ok === true, {
      steps: detail?.steps ?? null,
      detail: detail === null ? null : {
        node_counts: detail.groups?.node_counts ?? null,
        edge_counts: detail.groups?.edge_counts ?? null,
        group_labels: detail.groups?.labels ?? detail.groupLabels ?? null,
        group_ids: detail.groups?.group_ids ?? null,
        controls: detail.groups?.controls ?? null,
        toggles: detail.groups?.toggle ?? detail.initial?.toggles ?? null,
        rename: {rename: detail.rename ?? null, inputs: detail.renameInputs ?? null, save: detail.renameSave ?? null, after: detail.afterRename ?? null, persist: detail.afterRefresh ?? null},
        candidates: (detail.cards ?? []).map((card) => ({id: card.interface_id, text: card.text.slice(0, 220)})),
        platform_write: detail.platformWrite ?? null,
        independent: detail.independentNames ?? null,
        blackboxes: detail.afterAdd?.blackboxes ?? null,
        original_node: detail.originalNode ?? null,
        add: detail.addClick ?? null,
        remove: detail.removeClick ?? null,
        breadcrumb: detail.subflowBreadcrumb ?? null, subflow_section: detail.subflowSection ?? null,
        details_tabs: detail.detailsTabs ?? null,
        restore: detail.restore ?? null,
        selection: detail.selection ?? detail.selectionAfterAdd ?? detail.selectionSubflow ?? null,
      },
    }, {layer: 'dsh_host'});
  }
  requireCheck('host.s2b_console_clean', (probe?.console_error_count ?? 1) === 0, {
    console_error_count: probe?.console_error_count ?? null,
    console_errors: (probe?.console_lines ?? []).filter((line) => Number(line.level) >= 3).slice(0, 20),
  }, {layer: 'dsh_host'});
  requireCheck('host.s2b_no_absolute_paths', (probe?.leak?.count ?? -1) === 0, {leak: probe?.leak ?? null}, {layer: 'dsh_host'});
  return probe;
}

async function verifyS1RegressionProbe(boot, facts) {
  mkdirSync(SCRATCH, {recursive: true});
  rmSync(REGRESSION_JSON, {force: true});
  rmSync(REGRESSION_PNG, {force: true});
  const appDir = prepareProbeApp(OLD_PROBE, 'readonly-probe-app', 'electron-probe.cjs');
  const run = await runElectronProbe({
    boot, appDir,
    outPath: REGRESSION_JSON,
    shotDir: null,
    logPath: join(SCRATCH, 'readonly-regression.log'),
    env: {
      RV_OUT: REGRESSION_JSON,
      RV_SHOT: REGRESSION_PNG,
      RV_SHOT2: join(SCRATCH, 'readonly-regression-resources.png'),
      RV_ENTRY_NAME: 'bus_send',
      RV_EXPECT_LINE: String(facts.target?.line ?? 152),
      ...(facts.snapshot_id === null ? {} : {RV_EXPECT_SNAPSHOT_ID: facts.snapshot_id}),
      RV_WRITE_ENTRY_NAME: 'bus_register',
      RV_WRITE_EXPECT_LINE: '50',
      RV_TIMEOUT_MS: '300000',
    },
  });
  const probe = run.result;
  const regressionRequired = [
    'pageLoaded', 'sidebarEntry', 'panelOpened', 'snapshotClicked', 'entryListed', 'entryClicked',
    'sourceLineOk', 'sourceBoundsOk', 'evidenceClassesPresent', 'resourcesReadPresent', 'selectionEntrySelected',
    'selectionMatchesClickedEntry', 'returnToChat', 'chatRestored', 'panelReopened', 'reopenedSourceKept',
    'reopenSelectionKept', 'writeEntryClicked', 'writeSourceLineOk', 'writeExactResource', 'writeSelectionEntry',
    'noConsoleErrors', 'screenshotCaptured',
  ];
  const steps = probe?.steps ?? {};
  const failed = regressionRequired.filter((step) => steps[step] !== true);
  const screenshot = {};
  if (existsSync(REGRESSION_PNG)) {
    mkdirSync(EVIDENCE_DIR, {recursive: true});
    copyFileSync(REGRESSION_PNG, join(EVIDENCE_DIR, 'regression-readonly-slice.png'));
    screenshot.path = 'evidence/s2b/regression-readonly-slice.png';
    screenshot.bytes = readFileSync(join(EVIDENCE_DIR, 'regression-readonly-slice.png')).length;
    screenshot.sha256 = sha256(readFileSync(join(EVIDENCE_DIR, 'regression-readonly-slice.png')));
  }
  requireCheck('dsh_host.s1_regression_probe', probe !== null && failed.length === 0
    && (probe.console_error_count ?? 1) === 0, {
    exit_code: run.exitCode,
    note: 'S1 probe may exit non-zero only because its pre-S2a five-view placeholder assertion is superseded by the S2a tabs hook; the required S1 subset is evaluated here.',
    required_steps: regressionRequired,
    failed_steps: failed,
    console_error_count: probe?.console_error_count ?? null,
    screenshot,
    log_tail: run.log.slice(-1200),
  }, {layer: 'dsh_host'});
  return probe;
}

// ---------------------------------------------------------------------------
// Real Cordis host runtime (S2b endpoints)
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
      DSH_AUDIT_APPLICATION: '04-s2b-verifier',
    },
  });
  const args = ['--test', '--test-concurrency=1', '--test-reporter=tap', `--test-reporter-destination=${HOST_RUNTIME_TAP}`, HOST_RUNTIME_TEST];
  const started = Date.now();
  const result = spawnSync(EXECUTABLE, args, {cwd: REPO_ROOT, env, windowsHide: true, encoding: 'utf8', timeout: 480000, maxBuffer: 64 * 1024 * 1024});
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
    stdout_tail: (result.stdout ?? '').slice(-8000),
    stderr_tail: (result.stderr ?? '').slice(-8000),
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
  const result = runNodeTests(files, {timeoutMs: 360000});
  const ok = result.status === 0 && result.summary.fail === 0 && result.summary.tests !== null && result.summary.tests > 0;
  requireCheck('dsh_host.repo_node_tests', ok, {files, status: result.status, summary: result.summary, output_tail: result.text.slice(-3000)}, {layer: 'dsh_host'});
  return {status: result.status, summary: result.summary};
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const webBoots = [];
  let webBoot = null;
  logCommand({executable: process.execPath, args: [fileURLToPath(import.meta.url), ...argv], cwd: REPO_ROOT, note: 'self (S2b verifier entry point)'});

  outOfScope('AI summary / model-generated description text (CW-07 placeholder)', 'S2b shows "AI 归纳未接入" gap only; model egress not available', 'dsh_host');
  outOfScope('scenario execution / stub / rollback / run observation / sequence observed mode (S3)', 'CW-T3 scope; S2b sequence stays static-prediction only', 'dsh_host');
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
    requireCheck('host.client_s2b_contract', contract.ok, contract, {layer: 'dsh_host'});

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
      slice: prepared.slice,
      entry_lines: {},
    };
    const idHints = prepared.data_ready ? collectEntryIds(prepared.python, facts) : {ok: false, byName: {}, byLine: {}};
    facts.entry_lines = idHints.byLine ?? {};
    facts.check_length_id = idHints.byName?.check_length ?? null;
    requireCheck('host.entry_id_hints', idHints.ok, {
      source: 'engine view-entries projection',
      names: Object.keys(idHints.byName ?? {}),
      check_length_id: facts.check_length_id,
      lines: facts.entry_lines,
    }, {layer: 'dsh_host'});

    // 3. atlas layer: S2a six endpoints + S2b projections
    if (prepared.data_ready) {
      await guard('atlas.s2a', () => verifyAtlasS2a(prepared.python, facts), {layer: 'atlas_snapshot'});
      await guard('atlas.s2b', () => verifyAtlasS2b(prepared.python, facts), {layer: 'atlas_snapshot'});
    } else {
      requireCheck('atlas.s2a', false, {error: 'Lead slice data is not ready'}, {layer: 'atlas_snapshot'});
      requireCheck('atlas.s2b', false, {error: 'Lead slice data is not ready'}, {layer: 'atlas_snapshot'});
    }

    // 4. boot the real isolated web host
    if (!options.skipHttp) {
      webBoot = await guard('host.web_boot', () => startWebServer({python: prepared.python, tag: 's2b'}), {layer: 'dsh_host'});
      if (webBoot && !webBoot.__error) {
        webBoots.push(webBoot);
        logCommand({executable: EXECUTABLE, args: [DSH_BIN, 'web', '--no-open', '--port', '0'], cwd: join(REPO_ROOT, 'scratch'), note: 'isolated dsh web boot (one-time URL token redacted)'});
        const bootGraph = await guard('host.boot_graph', () => verifyBootGraph(webBoot), {layer: 'dsh_host'});
        await guard('host.carriers', () => verifyCarriers(webBoot, facts, bootGraph, idHints), {layer: 'dsh_host'});
        if (!options.skipProbes) {
          await guard('regression.s2a_probe_runner', () => verifyS2aRegressionProbe(webBoot, facts), {layer: 'dsh_host'});
          await guard('host.s2b_probe_runner', () => verifyS2bProbe(webBoot, facts), {layer: 'dsh_host'});
        } else {
          skipCheck('regression.five_views_probe', '--skip-probes', {layer: 'dsh_host'});
          skipCheck('host.s2b_probe', '--skip-probes', {layer: 'dsh_host'});
        }
        if (!options.skipRegression) {
          await guard('dsh_host.s1_regression_runner', () => verifyS1RegressionProbe(webBoot, facts), {layer: 'dsh_host'});
        } else {
          skipCheck('dsh_host.s1_regression_probe', '--skip-regression', {layer: 'dsh_host'});
        }
      }
    } else {
      skipCheck('host.boot_graph', '--skip-http');
      skipCheck('host.s2b_probe', '--skip-http');
    }

    // 5. real Cordis runtime with S2b endpoints
    if (!options.skipHostRuntime) {
      const hostRuntime = await guard('dsh_host.s2b_host_runtime', () => runHostRuntime({
        python: prepared.python,
        home: prepared.home,
        bootstrapPath: prepared.bootstrap_path,
        facts,
      }), {layer: 'dsh_host'});
      if (hostRuntime && !hostRuntime.__error) {
        requireCheck('dsh_host.s2b_host_runtime', hostRuntime.ok === true, {
          exit_code: hostRuntime.exit_code,
          tap_summary: hostRuntime.tap_summary,
          duration_ms: hostRuntime.duration_ms,
          evidence: 'evidence/s2b/host-runtime.json',
          tap: 'evidence/s2b/host-runtime.tap',
          stdout_tail: (hostRuntime.stdout_tail ?? '').slice(-1500),
          stderr_tail: (hostRuntime.stderr_tail ?? '').slice(-1000),
        }, {layer: 'dsh_host'});
      }
    } else {
      skipCheck('dsh_host.s2b_host_runtime', '--skip-host-runtime', {layer: 'dsh_host'});
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
      'atlas.view_coupling', 'atlas.view_tree', 'atlas.view_end_to_end', 'atlas.view_file_tree',
      'atlas.view_file_read', 'atlas.view_sequence', 'atlas.view_interfaces',
      'atlas.end_to_end_groups', 'atlas.end_to_end_breadcrumb',
    ].every((name) => report.checks[name]?.ok === true);
    const requiredHostChecks = [
      'host.pinned_baseline',
      'host.client_s2b_contract',
      'host.isolated_profile',
      'host.entry_id_hints',
      'host.web_shell',
      'host.boot_release',
      'host.boot_graph_entry',
      'host.boot_graph_inject',
      'host.client_bundle_bytes',
      'host.rpc_admission',
      'host.rpc_view_status',
      'host.rpc_list_snapshots',
      'host.rpc_get_entry',
      'host.rpc_s2a_endpoints',
      'host.rpc_view_interfaces',
      'host.rpc_end_to_end_groups',
      'host.rpc_subflow_breadcrumb',
      'host.rpc_input_validation',
      'regression.five_views_probe',
      'regression.five_views_screenshots',
      'regression.five_views_console_clean',
      'host.s2b_probe',
      'host.s2b_screenshots',
      'host.s2b_groups',
      'host.s2b_interfaces',
      'host.s2b_subflow',
      'host.s2b_console_clean',
      'host.s2b_no_absolute_paths',
      'dsh_host.s1_regression_probe',
      'dsh_host.s2b_host_runtime',
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
    evidence: 'evidence/s2b/verification.json',
  }, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

main();
