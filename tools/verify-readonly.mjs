#!/usr/bin/env node
// Independent, black-box acceptance runner for the 04 read-only workbench slice
// (docs/readonly-workbench-contract.md §7/§9). It never imports the plugin's
// client/server modules for assertions and never writes into the plugin
// implementation; it only builds an isolated DSH runtime under
// `04-code-learning/scratch/readonly-home` and observes the real host.
//
// Layers (kept separate, never mixed):
//   demo_observed   `node --test demo/code-view/demo.test.cjs` (Wasm demo)
//   atlas_snapshot  the real Atlas 0.1 snapshot read through the real Python
//                   read-model CLI (snapshots / entries / entry+source window)
//   dsh_host        pinned rc.5 host digests + isolated web profile boot graph +
//                   /code-view admission/route + real Chromium render probe +
//                   real Cordis mount/dispose/re-mount runtime test
//
// Output: evidence/readonly-slice/verification.json, render.png, commands.log
// (and host-runtime.json/.tap from tools/verify-host-runtime.mjs). Unverified
// items are listed under `not_verified`; they are never reported as passed.
//
// Usage: node tools/verify-readonly.mjs [--skip-render] [--skip-host-runtime]
//        [--skip-demo] [--skip-http] [--skip-engine-cli] [--with-repo-tests]
import {copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
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
  EVIDENCE_DIR,
  HOME_DIR,
  PROFILE_DIR,
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

const REPORT_PATH = join(EVIDENCE_DIR, 'verification.json');
const COMMANDS_PATH = join(EVIDENCE_DIR, 'commands.log');
const RENDER_JSON = join(REPO_ROOT, 'scratch', 'readonly-home', 'render.json');
const RENDER_PNG = join(REPO_ROOT, 'scratch', 'readonly-home', 'render.png');
const RENDER_PNG2 = join(REPO_ROOT, 'scratch', 'readonly-home', 'render-resources.png');
const EVIDENCE_RENDER_PNG = join(EVIDENCE_DIR, 'render.png');
const EVIDENCE_RENDER_RESOURCES_PNG = join(EVIDENCE_DIR, 'render-resources.png');
const ELECTRON_PROBE = join(REPO_ROOT, 'tools', 'readonly-slice', 'electron-probe.cjs');
const HOST_RUNTIME_RUNNER = join(REPO_ROOT, 'tools', 'verify-host-runtime.mjs');
const HOST_RUNTIME_JSON = join(EVIDENCE_DIR, 'host-runtime.json');
const PACKAGE_JSON = join(REPO_ROOT, 'package.json');

const argv = process.argv.slice(2);
const options = {
  skipRender: argv.includes('--skip-render'),
  skipHostRuntime: argv.includes('--skip-host-runtime'),
  skipDemo: argv.includes('--skip-demo'),
  skipHttp: argv.includes('--skip-http'),
  skipEngineCli: argv.includes('--skip-engine-cli'),
  withRepoTests: argv.includes('--with-repo-tests'),
};

const startedAt = new Date().toISOString();
const report = {
  schema_version: 1,
  started_at_utc: startedAt,
  purpose:
    'Independent black-box acceptance of the 04 read-only code workbench slice: pinned rc.5 isolated profile boot graph, /code-view admission+read model, real Chromium render/navigation, real Cordis mount/dispose/re-mount, real Atlas snapshot read model and the Demo observed behaviour.',
  host: HOST_BASELINE,
  layers: {
    demo_observed: false,
    atlas_snapshot: false,
    dsh_host: false,
  },
  checks: {},
  not_verified: [],
  commands: [],
  environment: {
    node: process.versions.node,
    platform: process.platform,
    workspace: REPO_ROOT,
  },
  limitations: [
    'Uses a locally installed generic Electron binary only as the Chromium test instrument; it is not a shipped dependency.',
    'The isolated fresh DSH_HOME may show the product host first-run preview/onboarding overlay in the screenshot; the workbench DOM assertions are recorded independently of that host UI.',
    'No OS-wide egress certification is performed here; this acceptance is a local, read-only slice check.',
    'DEMO layer is the Wasm/JS behaviour model, not the real DSH host; ATLAS layer is the real imported snapshot; DSH_HOST is the pinned local rc.5. The three are kept separate.',
  ],
};

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function redactUrl(url) {
  return String(url ?? '').replace(/token=[^&]+/g, 'token=<redacted>');
}

function commandLine(record) {
  return [record.executable, ...(record.args ?? [])].join(' ');
}

function logCommand(record) {
  report.commands.push({
    at: new Date().toISOString(),
    ...record,
    display: `${redactUrl(commandLine(record))}${record.exit_code === undefined ? '' : ` [exit ${record.exit_code}]`}`,
  });
}

function record(name, ok, detail = {}, {required = true, layer = null} = {}) {
  report.checks[name] = {ok: ok === true, required: required === true, ...(layer === null ? {} : {layer}), detail};
  return report.checks[name];
}

function require_(name, ok, detail, options_) {
  const row = record(name, ok, detail, options_);
  if (!row.ok && row.required) {
    report.not_verified.push({check: name, reason: typeof detail?.error === 'string' ? detail.error : 'check failed'});
  }
  return row;
}

function skipped(name, reason, {layer = null} = {}) {
  record(name, false, {skipped: true, reason, ...(layer === null ? {} : {layer})}, {required: false});
}

async function guard(name, fn, {required = true, layer = null} = {}) {
  try {
    const value = await fn();
    return value;
  } catch (error) {
    const message = String(error?.stack ?? error?.message ?? error);
    record(name, false, {error: message}, {required, layer});
    if (required) report.not_verified.push({check: name, reason: message.split('\n')[0]});
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
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...files], {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  logCommand({executable: process.execPath, args: ['--test', '--test-reporter=tap', ...files], cwd, exit_code: result.status});
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return {status: result.status, summary: tapSummary(text), text};
}

// ---------------------------------------------------------------------------
// static contract + host gate
// ---------------------------------------------------------------------------
function packageContract() {
  const pkg = readJsonFile(PACKAGE_JSON);
  const checks = {
    name: pkg.name === '@local/dsh-code-reader',
    main: pkg.main === 'index.js',
    client_platform: pkg?.dsh?.client?.platform === 'web',
    client_inject: Array.isArray(pkg?.dsh?.client?.inject)
      && JSON.stringify(pkg.dsh.client.inject) === JSON.stringify([
        '@deepseek-ai/dsh-client-connection',
        '@deepseek-ai/dsh-client-ui-layout',
        '@deepseek-ai/dsh-client-ui-renderer',
      ]),
    client_export: pkg?.exports?.['./client'] === './bundle/client.js',
    bundle_patch: pkg?.dsh?.bundle?.patch === './cordis.patch.yml',
  };
  const patchPath = join(REPO_ROOT, 'cordis.patch.yml');
  const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  checks.patch_row = /id:\s*dsh-code-reader/.test(patchText) && /name:\s*'@local\/dsh-code-reader'/.test(patchText);
  const clientPath = join(REPO_ROOT, 'bundle', 'client.js');
  checks.client_bundle_exists = existsSync(clientPath);
  let clientBytes = Buffer.alloc(0);
  if (checks.client_bundle_exists) {
    clientBytes = readFileSync(clientPath);
    const text = clientBytes.toString('utf8');
    checks.client_bundle_bytes = clientBytes.length > 0;
    checks.client_loader_facade = text.includes('window.__ModuleLoader__.load(');
    checks.client_loader_id = text.includes("'@local/dsh-code-reader'") || text.includes('"@local/dsh-code-reader"');
  }
  return {
    ok: Object.values(checks).every((value) => value === true),
    package: {
      name: pkg.name,
      version: pkg.version,
      main: pkg.main,
      dsh: pkg.dsh,
    },
    client_bundle: {
      path: 'bundle/client.js',
      bytes: clientBytes.length,
      sha256: checks.client_bundle_exists ? sha256(clientBytes) : null,
    },
    checks,
  };
}

// ---------------------------------------------------------------------------
// Atlas snapshot layer: real engine read model over the Lead-provided snapshot
// ---------------------------------------------------------------------------
async function verifyAtlasSnapshot(home, python) {
  const slice = inspectSnapshot();
  const workspaceId = slice.slice?.workspace_manifest?.workspace_id ?? WORKSPACE_ID;
  const snapshotId = slice.snapshot_id;
  if (!slice.ok) throw new Error(`Lead slice data is not ready: ${slice.slice?.missing?.join(', ') ?? 'no snapshot'}`);

  const snapshotsCli = runEngineCli({python, args: ['view-snapshots']});
  logCommand({executable: python.command, args: snapshotsCli.argv, cwd: join(REPO_ROOT, 'engine'), exit_code: snapshotsCli.exit_code});
  const workspace = (snapshotsCli.stdout_json?.workspaces ?? []).find((row) => row.workspace_id === workspaceId);
  const snapshot = (workspace?.snapshots ?? []).find((row) => row.snapshot_id === snapshotId) ?? (workspace?.snapshots ?? [])[0];
  require_('atlas.view_snapshots', snapshotsCli.ok && snapshot !== undefined && snapshot.status === 'verified' && snapshot.freshness === 'fresh', {
    source: 'evidence/code-view-slice/inbox',
    snapshot: snapshot ?? null,
  }, {layer: 'atlas_snapshot'});

  const entriesCli = runEngineCli({python, args: ['view-entries', '--workspace', workspaceId, '--snapshot', snapshotId]});
  logCommand({executable: python.command, args: entriesCli.argv, cwd: join(REPO_ROOT, 'engine'), exit_code: entriesCli.exit_code});
  const entryRow = (entriesCli.stdout_json?.entries ?? []).find((row) => row.name === 'bus_send');
  require_('atlas.view_entries', entriesCli.ok && entryRow !== undefined && entryRow.file === 'bus.c' && entryRow.line === slice.target.line, {
    entry: entryRow ?? null,
    entry_count: entriesCli.stdout_json?.entries?.length ?? null,
  }, {layer: 'atlas_snapshot'});

  const entryId = entryRow?.entry_id ?? slice.target.entry_id;
  const entryCli = runEngineCli({python, args: ['view-entry', '--workspace', workspaceId, '--snapshot', snapshotId, '--entry', entryId]});
  logCommand({executable: python.command, args: entryCli.argv, cwd: join(REPO_ROOT, 'engine'), exit_code: entryCli.exit_code});
  const value = entryCli.stdout_json ?? {};
  const sourceLine = (value.source?.lines ?? []).find((row) => row.n === slice.target.line);
  const absolutePathLeak = /[A-Za-z]:[\\/](?:dsh|Users|Anaconda)/.test(JSON.stringify(value));
  require_('atlas.view_entry', entryCli.ok
    && value.source?.status === 'ok'
    && sourceLine !== undefined
    && sourceLine.text.includes('bus_send')
    && Array.isArray(value.calls)
    && value.calls.length > 0
    && value.calls.some((call) => call.certainty === 'exact')
    && absolutePathLeak === false, {
    source: {status: value.source?.status, path: value.source?.path, lines: value.source?.lines?.length, byte_start: value.source?.byte_start, byte_end: value.source?.byte_end},
    definition_line: sourceLine ?? null,
    calls: (value.calls ?? []).slice(0, 6).map((call) => ({callsite: call.callsite, target: call.target, certainty: call.certainty})),
    evidence_classes: [...new Set((value.calls ?? []).map((call) => call.certainty))],
    gaps: value.gaps ?? [],
    absolute_path_leak: absolutePathLeak,
  }, {layer: 'atlas_snapshot'});

  // Resource layer: bus_send reads routes.max_len as `may`; bus_register exposes
  // the exact write of routes.max_len at bus.c:46 through its store_route path.
  const registerRow = (entriesCli.stdout_json?.entries ?? []).find((row) => row.name === 'bus_register');
  const registerCli = registerRow === undefined
    ? null
    : runEngineCli({python, args: ['view-entry', '--workspace', workspaceId, '--snapshot', snapshotId, '--entry', registerRow.entry_id]});
  if (registerCli !== null) {
    logCommand({executable: python.command, args: registerCli.argv, cwd: join(REPO_ROOT, 'engine'), exit_code: registerCli.exit_code});
  }
  const busSendResources = value.resources ?? {};
  const registerValue = registerCli?.stdout_json ?? {};
  const busSendRead = (busSendResources.field_accesses ?? []).find((access) => access.access === 'read' && access.field_name === 'max_len');
  const registerWrite = (registerValue.resources?.field_accesses ?? []).find((access) => access.access === 'write'
    && access.certainty === 'exact'
    && access.field_name === 'max_len'
    && access.location?.line === 46);
  require_('atlas.view_entry_resources', busSendResources.status === 'partial'
    && (busSendResources.objects ?? []).some((object) => object.name === 'routes')
    && busSendRead !== undefined
    && registerCli !== null
    && registerCli.ok
    && registerWrite !== undefined, {
    bus_send: {
      resources_status: busSendResources.status,
      objects: (busSendResources.objects ?? []).map((object) => ({name: object.name, file: object.file, line: object.line})),
      read_max_len: busSendRead ?? null,
    },
    bus_register: {
      entry_id: registerRow?.entry_id ?? null,
      write_max_len: registerWrite ?? null,
    },
  }, {layer: 'atlas_snapshot'});

  return {
    workspace_id: workspaceId,
    snapshot_id: snapshotId,
    entry_id: entryId,
    expected_line: slice.target.line,
    write_entry: {
      name: 'bus_register',
      entry_id: registerRow?.entry_id ?? null,
      line: registerRow?.line ?? 50,
    },
    graph_sha256: slice.graph_sha256,
    entry_count: slice.entry_count,
    engine: {python: python.version, command: python.command},
    home_isolated: home !== undefined,
  };
}

// ---------------------------------------------------------------------------
// DSH host layer: isolated profile boot graph + /code-view carrier
// ---------------------------------------------------------------------------
async function verifyHttpLayer(boot, {python, expectedSnapshotId}) {
  const shell = await fetchShell(boot.url);
  require_('host.web_shell', shell.response.status === 200 && shell.response.bytes.length > 0, {
    status: shell.response.status,
    final_url: redactUrl(shell.final_url),
    redirects: shell.hops,
    bytes: shell.response.bytes.length,
    cookies_issued_by_host: shell.cookies.map((pair) => pair.split('=', 1)[0]),
  });

  const bootManifest = extractBootManifest(shell.response.text);
  require_('host.boot_release', bootManifest?.release?.version === HOST_BASELINE.dsh_version, {
    release: bootManifest?.release ?? null,
    expected: HOST_BASELINE.dsh_version,
    rev: bootManifest?.rev ?? null,
    entries: bootManifest?.entries?.length ?? null,
  });

  const entry = (bootManifest.entries ?? []).find((row) => row.id === '@local/dsh-code-reader');
  require_('host.boot_graph_entry', entry !== undefined, {
    entry: entry === undefined ? null : {id: entry.id, url: redactUrl(entry.url), rev: entry.rev, inject: entry.inject},
    plugin_entries: (bootManifest.entries ?? []).length,
  });

  const pkg = readJsonFile(PACKAGE_JSON);
  const expectedInject = pkg?.dsh?.client?.inject ?? null;
  require_('host.boot_graph_inject', entry !== undefined && JSON.stringify(entry.inject) === JSON.stringify(expectedInject), {
    boot_graph_inject: entry?.inject ?? null,
    package_inject: expectedInject,
  });
  require_('host.boot_graph_platform', entry !== undefined && (entry.platform === undefined || entry.platform === 'web'), {
    platform: entry?.platform ?? null,
  });

  let clientBytes = Buffer.alloc(0);
  let bundleCheck = {fetched: false};
  if (entry !== undefined && typeof entry.url === 'string') {
    const clientUrl = new URL(entry.url.replace(/&amp;/g, '&'), shell.final_url).href;
    const clientResponse = await httpFetch(clientUrl, {headers: shell.cookies.length > 0 ? {cookie: shell.cookies.join('; ')} : {}});
    clientBytes = clientResponse.bytes;
    const repoClient = readFileSync(join(REPO_ROOT, 'bundle', 'client.js'));
    const prefixMatches = clientBytes.length >= repoClient.length && clientBytes.subarray(0, repoClient.length).equals(repoClient);
    const suffix = clientBytes.subarray(repoClient.length).toString('utf8');
    const text = clientBytes.toString('utf8');
    bundleCheck = {
      fetched: true,
      url: redactUrl(clientUrl),
      status: clientResponse.status,
      bytes: clientBytes.length,
      sha256: sha256(clientBytes),
      repo_bytes: repoClient.length,
      repo_sha256: sha256(repoClient),
      exact_prefix: prefixMatches,
      served_suffix: suffix.slice(0, 200),
      suffix_is_sourcemap_ref: /^;\r?\n\/\/# sourceMappingURL=/.test(suffix) || suffix === '',
      loader_facade: text.includes('window.__ModuleLoader__.load('),
      loader_id: text.includes("'@local/dsh-code-reader'") || text.includes('"@local/dsh-code-reader"'),
      content_type: clientResponse.headers['content-type'] ?? null,
    };
    require_('host.client_bundle_bytes', bundleCheck.status === 200 && bundleCheck.exact_prefix && bundleCheck.loader_facade && bundleCheck.loader_id && bundleCheck.suffix_is_sourcemap_ref, bundleCheck);
  } else {
    require_('host.client_bundle_bytes', false, {error: 'boot graph has no fetchable client entry url', ...bundleCheck});
  }

  // Primary acceptance: a direct request without the browser session cookie must
  // be refused by the connection admission seam (401/403), not served.
  const rpcBody = JSON.stringify({type: 'client-request', rpcId: 'verify-admission-1', method: 'view.status', payload: {}});
  const noCookie = await httpFetch(new URL('/code-view/view.status', boot.url), {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: rpcBody,
  });
  const noCookieIsAdmissionDenial = noCookie.status === 401 || noCookie.status === 403;
  let noCookieEnvelope = null;
  try {
    noCookieEnvelope = JSON.parse(noCookie.text);
  } catch {
    noCookieEnvelope = null;
  }
  require_('host.rpc_admission', noCookieIsAdmissionDenial || (noCookie.status === 200 && noCookieEnvelope?.type === 'server-response'), {
    status: noCookie.status,
    content_type: noCookie.headers['content-type'] ?? null,
    body_head: noCookie.text.slice(0, 200),
    interpretation: noCookieIsAdmissionDenial
      ? 'connection admission refused the cookie-less direct request (seam active)'
      : 'request was admitted; carrier answered with an envelope',
  });

  // Additional carrier evidence, using only cookies the host itself issued for
  // this boot (never fabricated): the read-model endpoints must reach Python.
  const cookieHeader = shell.cookies.length > 0 ? {cookie: shell.cookies.join('; ')} : {};
  const callRpc = async (endpoint, payload, rpcId) => {
    const body = JSON.stringify({type: 'client-request', rpcId, method: endpoint, payload});
    const response = await httpFetch(new URL(`/code-view/${endpoint}`, boot.url), {
      method: 'POST',
      headers: {'content-type': 'application/json', ...cookieHeader},
      body,
    });
    let parsed = null;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      parsed = null;
    }
    return {status: response.status, parsed, text: response.text, content_type: response.headers['content-type'] ?? null};
  };

  const statusCall = await callRpc('view.status', {}, 'verify-status-1');
  require_('host.rpc_view_status', statusCall.status === 200
    && statusCall.parsed?.type === 'server-response'
    && statusCall.parsed?.rpcId === 'verify-status-1'
    && statusCall.parsed?.result?.ok === true
    && statusCall.parsed?.result?.value?.host?.panel_key === 'dsh-code-reader'
    && statusCall.parsed?.result?.value?.engine?.python === 'available'
    && statusCall.parsed?.result?.value?.engine?.bootstrap?.exists === true, {
    status: statusCall.status,
    host: statusCall.parsed?.result?.value?.host ?? null,
    engine: statusCall.parsed?.result?.value?.engine ?? null,
    capabilities: statusCall.parsed?.result?.value?.capabilities ?? null,
    gap_codes: (statusCall.parsed?.result?.value?.gaps ?? []).map((gap) => gap.code),
  });

  const listCall = await callRpc('view.listSnapshots', {}, 'verify-snapshots-1');
  const listedWorkspace = (listCall.parsed?.result?.value?.workspaces ?? []).find((row) => row.workspace_id === WORKSPACE_ID);
  const listedSnapshot = (listedWorkspace?.snapshots ?? [])[0];
  require_('host.rpc_list_snapshots', listCall.status === 200
    && listCall.parsed?.result?.ok === true
    && listedSnapshot !== undefined
    && listedSnapshot.status === 'verified'
    && (expectedSnapshotId === null || listedSnapshot.snapshot_id === expectedSnapshotId), {
    status: listCall.status,
    workspace: listedWorkspace === undefined ? null : {workspace_id: listedWorkspace.workspace_id, revision: listedWorkspace.revision, semantic_status: listedWorkspace.semantic_status},
    snapshot: listedSnapshot ?? null,
  });

  if (listedSnapshot !== undefined) {
    const entriesCall = await callRpc('view.listEntries', {workspace: WORKSPACE_ID, snapshot: listedSnapshot.snapshot_id}, 'verify-entries-1');
    const busSend = (entriesCall.parsed?.result?.value?.entries ?? []).find((row) => row.name === 'bus_send');
    require_('host.rpc_list_entries', entriesCall.parsed?.result?.ok === true && busSend !== undefined && busSend.file === 'bus.c', {
      status: entriesCall.status,
      entries: entriesCall.parsed?.result?.value?.entries?.length ?? null,
      bus_send: busSend ?? null,
    });

    if (busSend !== undefined) {
      const detailCall = await callRpc('view.getEntry', {
        workspace: WORKSPACE_ID,
        snapshot: listedSnapshot.snapshot_id,
        entry: busSend.entry_id,
      }, 'verify-entry-1');
      const detail = detailCall.parsed?.result?.value ?? {};
      const definitionRow = (detail.source?.lines ?? []).find((row) => row.n === busSend.line);
      const absolutePathLeak = /[A-Za-z]:[\\/](?:dsh|Users|Anaconda)/.test(detailCall.text);
      require_('host.rpc_get_entry', detailCall.parsed?.result?.ok === true
        && detail.source?.status === 'ok'
        && definitionRow !== undefined
        && definitionRow.text.includes('bus_send')
        && (detail.calls ?? []).some((call) => call.certainty === 'exact')
        && absolutePathLeak === false, {
        status: detailCall.status,
        source: {status: detail.source?.status, path: detail.source?.path, line_start: detail.source?.line_start, line_end: detail.source?.line_end},
        definition_line: definitionRow ?? null,
        calls: (detail.calls ?? []).slice(0, 6).map((call) => ({callsite: call.callsite, target: call.target, certainty: call.certainty})),
        gaps: detail.gaps ?? [],
        absolute_path_leak: absolutePathLeak,
      });
    }

    const badInput = await callRpc('view.getEntry', {workspace: 'INVALID WORKSPACE', snapshot: listedSnapshot.snapshot_id, entry: busSend?.entry_id ?? 'x'}, 'verify-invalid-1');
    require_('host.rpc_input_validation', badInput.status === 200 && badInput.parsed?.result?.ok === false && badInput.parsed?.result?.error?.code === 'INVALID_ARGUMENT', {
      status: badInput.status,
      error: badInput.parsed?.result?.error ?? null,
    });
  }

  const malformedBody = await httpFetch(new URL('/code-view/view.status', boot.url), {
    method: 'POST',
    headers: {'content-type': 'application/json', ...cookieHeader},
    body: '{"type":"not-a-client-request"}',
  });
  let malformedParsed = null;
  try {
    malformedParsed = JSON.parse(malformedBody.text);
  } catch {
    malformedParsed = null;
  }
  require_('host.rpc_bad_request_envelope', malformedBody.status === 200
    && malformedParsed?.type === 'server-response'
    && (malformedParsed?.result?.error?.code === 'gateway/bad-request' || malformedParsed?.result?.ok === false), {
    status: malformedBody.status,
    body_head: malformedBody.text.slice(0, 240),
  });

  return {
    boot: {
      url: redactUrl(boot.url),
      stdout_path: 'scratch/readonly-home/web-render.out.log',
      stderr_path: 'scratch/readonly-home/web-render.err.log',
    },
    client_bundle: bundleCheck,
    admission: {
      cookie_less_status: noCookie.status,
      interpretation: noCookieIsAdmissionDenial ? 'admission seam refused (401/403) as expected' : 'admitted or other',
    },
    endpoints: {
      view_status: statusCall.parsed?.result?.ok ?? null,
      view_list_snapshots: listCall.parsed?.result?.ok ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Chromium render probe
// ---------------------------------------------------------------------------
async function runRenderProbe({boot, snapshot}) {
  if (!existsSync(ELECTRON_PROBE)) throw new Error(`probe script missing: ${ELECTRON_PROBE}`);
  if (!existsSync(RENDER_PROBE_ELECTRON)) throw new Error(`Electron test instrument missing: ${RENDER_PROBE_ELECTRON}`);
  const appDir = join(REPO_ROOT, 'scratch', 'readonly-home', 'probe-app');
  mkdirSync(appDir, {recursive: true});
  copyFileSync(ELECTRON_PROBE, join(appDir, 'electron-probe.cjs'));
  writeFileSync(join(appDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-code-reader-render-probe',
    version: '0.0.0-private',
    private: true,
    description: 'Verifier render probe; not a shipped component.',
    main: 'electron-probe.cjs',
  }, null, 2)}\n`, 'utf8');
  rmSync(RENDER_JSON, {force: true});
  rmSync(RENDER_PNG, {force: true});
  rmSync(RENDER_PNG2, {force: true});
  const probeLogPath = join(REPO_ROOT, 'scratch', 'readonly-home', 'probe.log');
  const userDataDir = join(REPO_ROOT, 'scratch', 'readonly-home', 'electron-userdata');
  const env = {
    ...process.env,
    RV_URL: boot.url,
    RV_OUT: RENDER_JSON,
    RV_SHOT: RENDER_PNG,
    RV_ENTRY_NAME: 'bus_send',
    RV_EXPECT_LINE: String(snapshot?.expected_line ?? 152),
    RV_WRITE_ENTRY_NAME: snapshot?.write_entry?.name ?? 'bus_register',
    RV_WRITE_EXPECT_LINE: String(snapshot?.write_entry?.line ?? 50),
    RV_SHOT2: RENDER_PNG2,
    RV_TIMEOUT_MS: '240000',
  };
  if (snapshot?.snapshot_id) env.RV_EXPECT_SNAPSHOT_ID = snapshot.snapshot_id;
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(RENDER_PROBE_ELECTRON, [appDir, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userDataDir}`], {
    cwd: REPO_ROOT,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => {
    log += chunk.toString('utf8');
    writeFileSync(probeLogPath, log);
  });
  child.stderr.on('data', (chunk) => {
    log += chunk.toString('utf8');
    writeFileSync(probeLogPath, log);
  });
  const exitCode = await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolvePromise(null);
    }, 280000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });
  logCommand({executable: RENDER_PROBE_ELECTRON, args: [appDir, '--no-sandbox', '--disable-gpu'], cwd: REPO_ROOT, exit_code: exitCode});
  if (!existsSync(RENDER_JSON)) {
    return {__error: `render probe produced no result (exit ${exitCode}); log tail: ${log.slice(-1200)}`};
  }
  const probe = readJsonFile(RENDER_JSON);
  probe.exit_code = exitCode;
  probe.log_tail = log.slice(-2000);
  if (existsSync(RENDER_PNG)) {
    mkdirSync(EVIDENCE_DIR, {recursive: true});
    copyFileSync(RENDER_PNG, EVIDENCE_RENDER_PNG);
    probe.evidence_screenshot = 'evidence/readonly-slice/render.png';
    probe.screenshot_bytes = readFileSync(EVIDENCE_RENDER_PNG).length;
    probe.screenshot_sha256 = sha256(readFileSync(EVIDENCE_RENDER_PNG));
  }
  if (existsSync(RENDER_PNG2)) {
    mkdirSync(EVIDENCE_DIR, {recursive: true});
    copyFileSync(RENDER_PNG2, EVIDENCE_RENDER_RESOURCES_PNG);
    probe.evidence_screenshot_resources = 'evidence/readonly-slice/render-resources.png';
    probe.screenshot_resources_bytes = readFileSync(EVIDENCE_RENDER_RESOURCES_PNG).length;
    probe.screenshot_resources_sha256 = sha256(readFileSync(EVIDENCE_RENDER_RESOURCES_PNG));
  }
  return probe;
}

// ---------------------------------------------------------------------------
// demo + optional repo tests
// ---------------------------------------------------------------------------
function verifyDemo() {
  const result = runNodeTests(['demo/code-view/demo.test.cjs'], {timeoutMs: 120000});
  const ok = result.status === 0 && result.summary.fail === 0 && result.summary.tests !== null && result.summary.tests > 0;
  require_('demo.code_view_demo_tests', ok, {
    command: 'node --test demo/code-view/demo.test.cjs',
    status: result.status,
    summary: result.summary,
    output_tail: result.text.slice(-2000),
  }, {layer: 'demo_observed'});
  return {status: result.status, summary: result.summary};
}

function verifyRepoNodeTests() {
  const testsDir = join(REPO_ROOT, 'tests', 'node');
  const files = readdirSync(testsDir)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `tests/node/${name}`);
  const result = runNodeTests(files, {timeoutMs: 240000});
  const ok = result.status === 0 && result.summary.fail === 0 && result.summary.tests !== null && result.summary.tests > 0;
  require_('dsh_host.repo_node_tests', ok, {
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
  logCommand({
    executable: process.execPath,
    args: [fileURLToPath(import.meta.url), ...argv],
    cwd: REPO_ROOT,
    note: 'self (verifier entry point)',
  });
  try {
    // 1. pinned host + plugin static contract gates
    const hostGate = verifyHostBaseline();
    record('host.pinned_baseline', hostGate.ok, {
      executable: hostGate.executable,
      archive: hostGate.archive,
      completed_checks: hostGate.checks.filter((row) => row.ok).length,
      failed_checks: hostGate.checks.filter((row) => !row.ok),
    });
    if (!hostGate.ok) throw new Error(`pinned host gate failed: ${JSON.stringify(hostGate.checks.filter((row) => !row.ok))}`);
    const contract = packageContract();
    record('host.plugin_package_contract', contract.ok, contract, {layer: 'dsh_host'});

    // 2. isolated home/profile + real engine snapshot import
    const prepared = prepareIsolatedHome({wipe: true, importData: true});
    record('host.isolated_profile', prepared.data_ready
      && prepared.imports.workspace?.exit_code === 0
      && prepared.imports.snapshot?.exit_code === 0, {
      home: 'scratch/readonly-home/home',
      home_is_isolated_from_user_profile: true,
      profile: {
        dir: 'scratch/readonly-home/home/profiles/web',
        bundles: prepared.bundles,
        junction: 'scratch/readonly-home/home/profiles/web/node_modules/@local/dsh-code-reader -> repository',
        cordis_patch: '[]',
      },
      bootstrap: {
        path: 'scratch/readonly-home/home/code-reader/bootstrap.json',
        candidate_roots: [{root_ref: 'slice-root', absolute_path: 'evidence/code-view-slice', read_grant_ref: 'grant-slice'}],
      },
      python: prepared.python,
      imports: {workspace: prepared.imports.workspace?.exit_code ?? null, snapshot: prepared.imports.snapshot?.exit_code ?? null, skipped: prepared.imports.skipped ?? null},
      snapshot: prepared.snapshot ? {snapshot_id: prepared.snapshot.snapshot_id, graph_sha256: prepared.snapshot.graph_sha256, entry_count: prepared.snapshot.entry_count, target: prepared.snapshot.target} : null,
    }, {layer: 'dsh_host'});
    if (prepared.imports.workspace) {
      logCommand({executable: prepared.python.command, args: prepared.imports.workspace.argv, cwd: join(REPO_ROOT, 'engine'), exit_code: prepared.imports.workspace.exit_code});
    }
    if (prepared.imports.snapshot) {
      logCommand({executable: prepared.python.command, args: prepared.imports.snapshot.argv, cwd: join(REPO_ROOT, 'engine'), exit_code: prepared.imports.snapshot.exit_code});
    }

    // 3. Atlas snapshot read model (real Python CLI over the real snapshot)
    let atlas = null;
    if (!options.skipEngineCli && prepared.data_ready) {
      atlas = await guard('atlas.layer', () => verifyAtlasSnapshot(prepared.home, prepared.python), {layer: 'atlas_snapshot'});
    } else {
      skipped('atlas.layer', options.skipEngineCli ? '--skip-engine-cli' : 'Lead slice data is not ready', {layer: 'atlas_snapshot'});
    }
    const snapshotHint = atlas && !atlas.__error
      ? {expected_line: atlas.expected_line, snapshot_id: atlas.snapshot_id, write_entry: atlas.write_entry}
      : prepared.snapshot
        ? {
            expected_line: prepared.snapshot.target?.line ?? 152,
            snapshot_id: prepared.snapshot.snapshot_id,
            write_entry: {name: 'bus_register', entry_id: null, line: 50},
          }
        : {expected_line: 152, snapshot_id: null, write_entry: {name: 'bus_register', entry_id: null, line: 50}};

    // 4. boot the real isolated web host and verify the boot graph + carrier
    let http = null;
    let shellCookies = [];
    if (!options.skipHttp && !options.skipRender) {
      webBoot = await guard('host.web_boot', () => startWebServer({python: prepared.python, tag: 'render'}), {layer: 'dsh_host'});
      if (webBoot && !webBoot.__error) {
        webBoots.push(webBoot);
        logCommand({
          executable: EXECUTABLE,
          args: [DSH_BIN, 'web', '--no-open', '--port', '0'],
          cwd: join(REPO_ROOT, 'scratch', 'readonly-home'),
          note: 'isolated dsh web boot (one-time URL token redacted)',
        });
        http = await guard('host.http_layer', () => verifyHttpLayer(webBoot, {python: prepared.python, expectedSnapshotId: snapshotHint.snapshot_id}), {layer: 'dsh_host'});
        if (http && !http.__error) shellCookies = [];
      }
    } else {
      skipped('host.http_layer', '--skip-http or --skip-render', {layer: 'dsh_host'});
    }

    // 5. real Chromium render probe against the still-running isolated host
    let render = null;
    if (!options.skipRender && webBoot && !webBoot.__error) {
      render = await guard('host.render_probe', () => runRenderProbe({boot: webBoot, snapshot: snapshotHint}), {layer: 'dsh_host'});
      if (render && !render.__error) {
        const steps = render.steps ?? {};
        const consoleErrors = (render.console_lines ?? []).filter((line) => Number(line.level) >= 3);
        record('host.render_flow', render.ok === true, {
          ok: render.ok,
          steps,
          snapshot_candidates: render.snapshotCandidates ?? null,
          chosen_snapshot: render.chosenSnapshot ?? null,
          source_view: render.sourceView ?? null,
          evidence_classes: render.evidenceClasses ?? null,
          resources: render.resources ?? null,
          write_view: render.writeView ?? null,
          write_resources: render.writeResources ?? null,
          write_access: render.writeAccess ?? null,
          write_selection: render.writeSelection ?? null,
          gaps: render.gaps ?? null,
          five_views: render.fiveViews ?? null,
          selection: render.selection ?? null,
          reopen_selection: render.reopenSelection ?? null,
          panel_dom: render.panelDom ?? null,
          final_overlay: render.finalOverlay ?? null,
          console_errors: consoleErrors,
          screenshot: render.evidence_screenshot ?? null,
          screenshot_bytes: render.screenshot_bytes ?? null,
          screenshot_sha256: render.screenshot_sha256 ?? null,
          screenshot_method: render.screenshot_method ?? null,
          resources_screenshot: render.evidence_screenshot_resources ?? null,
          resources_screenshot_sha256: render.screenshot_resources_sha256 ?? null,
          window_shown_invisible: render.steps?.windowShownInvisible === true,
          debug: render.debug ?? null,
        }, {layer: 'dsh_host'});
        record('host.render_probe', render.ok === true, {
          exit_code: render.exit_code ?? null,
          duration_ms: render.duration_ms ?? null,
          screenshot: render.evidence_screenshot ?? null,
          screenshot_bytes: render.screenshot_bytes ?? null,
          screenshot_sha256: render.screenshot_sha256 ?? null,
          screenshot_error: render.screenshotError ?? null,
          console_error_count: consoleErrors.length,
          console_lines: (render.console_lines ?? []).slice(0, 80),
          result_json: 'scratch/readonly-home/render.json',
          probe_log: 'scratch/readonly-home/probe.log',
          log_tail: render.log_tail ?? null,
          error: render.error ?? null,
        }, {layer: 'dsh_host'});
        record('host.render_console_clean', consoleErrors.length === 0, {
          console_lines: (render.console_lines ?? []).slice(0, 80),
          console_error_count: consoleErrors.length,
        }, {layer: 'dsh_host'});
      } else if (render && render.__error) {
        record('host.render_probe', false, {error: render.__error}, {layer: 'dsh_host'});
      }
    } else if (options.skipRender) {
      skipped('host.render_probe', '--skip-render', {layer: 'dsh_host'});
      skipped('host.render_flow', '--skip-render', {layer: 'dsh_host'});
    } else {
      skipped('host.render_probe', 'isolated web host did not boot', {layer: 'dsh_host'});
      skipped('host.render_flow', 'isolated web host did not boot', {layer: 'dsh_host'});
    }

    // 6. real Cordis mount/dispose/re-mount runtime test
    let hostRuntime = null;
    if (!options.skipHostRuntime) {
      const env = {
        ...process.env,
        READONLY_HOME: prepared.home,
        READONLY_BOOTSTRAP: prepared.bootstrap_path,
        READONLY_WORKSPACE_ID: WORKSPACE_ID,
        READONLY_ENTRY_NAME: 'bus_send',
        READONLY_ENTRY_LINE: String(snapshotHint.expected_line),
      };
      if (snapshotHint.snapshot_id) env.READONLY_SNAPSHOT_ID = snapshotHint.snapshot_id;
      const result = spawnSync(process.execPath, [HOST_RUNTIME_RUNNER], {
        cwd: REPO_ROOT,
        env,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 420000,
        maxBuffer: 64 * 1024 * 1024,
      });
      logCommand({executable: process.execPath, args: [HOST_RUNTIME_RUNNER], cwd: REPO_ROOT, exit_code: result.status});
      if (existsSync(HOST_RUNTIME_JSON)) {
        hostRuntime = readJsonFile(HOST_RUNTIME_JSON);
        record('dsh_host.cordis_runtime', result.status === 0 && hostRuntime.ok === true, {
          exit_code: result.status,
          tap_summary: hostRuntime.tap_summary,
          gates_ok: hostRuntime.gates?.ok ?? null,
          host: hostRuntime.host ?? null,
          evidence: 'evidence/readonly-slice/host-runtime.json',
          tap: 'evidence/readonly-slice/host-runtime.tap',
          stdout_tail: (result.stdout ?? '').slice(-1500),
          stderr_tail: (result.stderr ?? '').slice(-1000),
        }, {layer: 'dsh_host'});
      } else {
        require_('dsh_host.cordis_runtime', false, {
          exit_code: result.status,
          error: 'host runtime runner produced no evidence JSON',
          stdout_tail: (result.stdout ?? '').slice(-2000),
          stderr_tail: (result.stderr ?? '').slice(-2000),
        }, {layer: 'dsh_host'});
      }
    } else {
      skipped('dsh_host.cordis_runtime', '--skip-host-runtime', {layer: 'dsh_host'});
    }

    // 7. Demo behaviour comparison (separate layer)
    let demo = null;
    if (!options.skipDemo) {
      demo = await guard('demo.layer', () => verifyDemo(), {layer: 'demo_observed'});
    } else {
      skipped('demo.code_view_demo_tests', '--skip-demo', {layer: 'demo_observed'});
    }

    // 8. optional repository Node test suite (Lead/teammates own the layer too)
    if (options.withRepoTests) {
      await guard('dsh_host.repo_node_tests', () => verifyRepoNodeTests(), {layer: 'dsh_host'});
    } else {
      skipped('dsh_host.repo_node_tests', 'not requested (--with-repo-tests)', {layer: 'dsh_host'});
    }

    // layered roll-up
    report.layers.demo_observed = report.checks['demo.code_view_demo_tests']?.ok === true;
    report.layers.atlas_snapshot = report.checks['atlas.view_snapshots']?.ok === true
      && report.checks['atlas.view_entries']?.ok === true
      && report.checks['atlas.view_entry']?.ok === true;
    const hostLayerChecks = [
      'host.pinned_baseline',
      'host.plugin_package_contract',
      'host.isolated_profile',
      'host.web_shell',
      'host.boot_release',
      'host.boot_graph_entry',
      'host.boot_graph_inject',
      'host.client_bundle_bytes',
      'host.rpc_admission',
      'host.rpc_view_status',
      'host.rpc_list_snapshots',
      'host.rpc_list_entries',
      'host.rpc_get_entry',
      'host.rpc_input_validation',
      'host.rpc_bad_request_envelope',
      'host.render_probe',
      'host.render_flow',
      'host.render_console_clean',
      'dsh_host.cordis_runtime',
    ];
    if (options.skipRender) {
      for (const name of hostLayerChecks) if (name.startsWith('host.render')) report.checks[name] = {ok: false, required: false, skipped: true, layer: 'dsh_host'};
    }
    report.layers.dsh_host = hostLayerChecks.every((name) => report.checks[name]?.ok === true);

    report.checks_summary = {
      total: Object.keys(report.checks).length,
      passed: Object.values(report.checks).filter((row) => row.ok === true).length,
      failed: Object.values(report.checks).filter((row) => row.ok !== true && row.required === true).length,
      not_verified: report.not_verified.length,
    };
    report.ok = report.layers.demo_observed === true
      && report.layers.atlas_snapshot === true
      && report.layers.dsh_host === true
      && report.not_verified.length === 0;
    report.verified = report.ok;
  } catch (error) {
    report.ok = false;
    report.verified = false;
    report.error = String(error?.stack ?? error?.message ?? error);
  } finally {
    for (const boot of webBoots.reverse()) {
      try {
        await boot.stop();
      } catch {
        /* process already gone */
      }
    }
  }

  // write evidence artifacts
  mkdirSync(EVIDENCE_DIR, {recursive: true});
  report.finished_at_utc = new Date().toISOString();
  report.duration_ms = Date.parse(report.finished_at_utc) - Date.parse(report.started_at_utc);
  const commands = report.commands.map((row) => `${row.at} ${row.display}${row.cwd === undefined ? '' : ` (cwd ${row.cwd})`}`).join('\n');
  writeFileSync(COMMANDS_PATH, `${commands}\n`, 'utf8');
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const summary = {
    ok: report.ok,
    verified: report.verified,
    layers: report.layers,
    checks: report.checks_summary,
    not_verified: report.not_verified,
    evidence: 'evidence/readonly-slice/verification.json',
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

main();
