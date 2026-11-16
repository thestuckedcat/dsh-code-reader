// S4-prep Linux-built Atlas snapshot acceptance (Lead).
//
// Builds a Linux Atlas 0.8 snapshot (in WSL, see evidence/linux-atlas/README.md),
// imports it into the *Windows* DSH plugin using a bootstrap-declared
// `path_aliases` root mapping, compares its projections with the Windows-built
// fixture snapshot, and runs the real five-view Chromium probe against the
// Linux snapshot in an isolated dsh-web profile.
import {spawn} from 'node:child_process';
import {copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

import {
  BOOTSTRAP_PATH, ENGINE_DIR, HOME_DIR, INBOX_DIR, REPO_ROOT, SCRATCH_ROOT, SLICE_DIR,
  log, prepareIsolatedHome, readJsonFile, resolvePython, runEngineCli, writeJsonFile,
} from './readonly-slice/isolated-home.mjs';
import {fetchShell, startWebServer} from './readonly-slice/web-host.mjs';
import {RENDER_PROBE_ELECTRON, verifyHostBaseline} from './readonly-slice/host-baseline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = join(REPO_ROOT, 'evidence', 'linux-atlas');
const LINUX_SNAPSHOT_SRC = join(REPO_ROOT, 'evidence', 'linux-atlas', 'snapshot-linux');
const LINUX_SNAPSHOT_DIR_NAME = 'snapshot-linux';
const LINUX_SNAPSHOT_ID = '2ffddd4400b6400b8bdc55ffcd33bf76';
const LINUX_ANALYZED_ROOT = '/root/atlas-demo/repo';
const WINDOWS_SNAPSHOT_DIR_NAME = 'snapshot-bus';
const WINDOWS_SNAPSHOT_GRAPH = join(SLICE_DIR, 'inbox', WINDOWS_SNAPSHOT_DIR_NAME, 'graph.json');
const ENTRY_NAME = 'bus_send';
const ENTRY_LINE = '152';
const SCRATCH = join(SCRATCH_ROOT, 'linux-atlas');
const PROBE_DIR = join(SCRATCH, 'probe-app');
const PROBE_JSON = join(SCRATCH, 'five-views-probe.json');
const PROBE_LOG = join(SCRATCH, 'five-views-probe.log');
const SHOT_DIR = join(SCRATCH, 'shots');
const FIVE_VIEWS_PROBE = join(REPO_ROOT, 'tools', 'five-views-probe.cjs');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function writeLog(lines) {
  writeFileSync(join(SCRATCH, 'commands.log'), `${lines.join('\n')}\n`, 'utf8');
}

function parseGraph(path, label) {
  const payload = readJsonFile(path)?.payload ?? {};
  const functions = payload.functions ?? [];
  const byId = new Map(functions.map((item) => [item.id, item]));
  const objects = new Map((payload.objects ?? []).map((item) => [item.id, item]));
  const accesses = (payload.field_accesses ?? []).map((item) => [
    byId.get(item.function_id)?.name ?? null,
    objects.get(item.object_id)?.name ?? null,
    (item.field_path ?? []).join('.'),
    item.access ?? null,
    item.certainty ?? null,
  ]).sort();
  return {
    label,
    counts: {
      functions: functions.length,
      call_targets: (payload.call_targets ?? []).length,
      objects: (payload.objects ?? []).length,
      field_accesses: (payload.field_accesses ?? []).length,
      flow_edges: (payload.flow_edges ?? []).length,
      lock_events: (payload.lock_events ?? []).length,
      alias_relations: (payload.alias_relations ?? []).length,
    },
    accesses,
    coverage: payload.coverage ?? {},
  };
}

function prepareProbeApp() {
  mkdirSync(PROBE_DIR, {recursive: true});
  copyFileSync(FIVE_VIEWS_PROBE, join(PROBE_DIR, 'five-views-probe.cjs'));
  writeFileSync(join(PROBE_DIR, 'package.json'), `${JSON.stringify({
    name: 'dsh-code-reader-linux-snapshot-probe',
    version: '0.0.0-private',
    private: true,
    description: 'Lead S4-prep cross-OS snapshot probe; not a shipped component.',
    main: 'five-views-probe.cjs',
  }, null, 2)}\n`, 'utf8');
  return PROBE_DIR;
}

async function runElectronProbe({boot, env, timeoutMs = 480000}) {
  const userDataDir = join(SCRATCH, 'electron-userdata');
  const probeEnv = {...process.env, ...env, RV_URL: boot.url};
  delete probeEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(RENDER_PROBE_ELECTRON, [PROBE_DIR, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userDataDir}`], {
    cwd: REPO_ROOT, env: probeEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logText = '';
  child.stdout.on('data', (chunk) => { logText += chunk.toString('utf8'); writeFileSync(PROBE_LOG, logText); });
  child.stderr.on('data', (chunk) => { logText += chunk.toString('utf8'); writeFileSync(PROBE_LOG, logText); });
  const exitCode = await new Promise((resolvePromise) => {
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolvePromise(null); }, timeoutMs);
    child.once('exit', (code) => { clearTimeout(timer); resolvePromise(code); });
  });
  const result = existsSync(PROBE_JSON) ? readJsonFile(PROBE_JSON) : null;
  return {exitCode, logText, result};
}

function copyScreenshots(probe) {
  mkdirSync(EVIDENCE_DIR, {recursive: true});
  const copied = {};
  for (const [name, record] of Object.entries(probe?.screenshots ?? {})) {
    if (!record?.path || !existsSync(record.path)) continue;
    const target = join(EVIDENCE_DIR, `linux-${name}.png`);
    copyFileSync(record.path, target);
    const raw = readFileSync(target);
    copied[name] = {path: `evidence/linux-atlas/linux-${name}.png`, bytes: raw.length, sha256: sha256(raw)};
  }
  return copied;
}

async function main() {
  rmSync(SCRATCH, {recursive: true, force: true});
  mkdirSync(SCRATCH, {recursive: true});
  mkdirSync(EVIDENCE_DIR, {recursive: true});
  const commands = [];
  const checks = [];
  const requireCheck = (name, ok, detail, layer) => {
    checks.push({name, ok: ok === true, layer, detail});
    return ok === true;
  };

  const gate = verifyHostBaseline();
  requireCheck('pinned_host_baseline', gate.ok, {
    executable: gate.executable, archive: gate.archive,
    failures: gate.checks.filter((item) => !item.ok),
  }, 'dsh_host');
  if (!gate.ok) {
    writeJsonFile(join(EVIDENCE_DIR, 'verification.json'), {
      schema_version: 1, stage: 'S4-prep-linux-atlas', ok: false, verified: false,
      checks, limitations: ['pinned host baseline failed'],
    });
    console.error('pinned host baseline failed');
    process.exit(1);
  }

  const prepared = prepareIsolatedHome({wipe: true, quiet: true});
  const python = resolvePython();
  commands.push(`prepareIsolatedHome workspace=${prepared.imports.workspace?.exit_code} snapshot=${prepared.imports.snapshot?.exit_code}`);
  requireCheck('fixture_workspace_import', prepared.imports.workspace?.ok === true, prepared.imports.workspace, 'atlas_snapshot');

  // Stage a scratch import inbox (workspace + both snapshots) so the checked-in
  // evidence fixture directory stays untouched, then copy the Linux-built
  // snapshot in and declare the foreign analyzed root as a trusted alias of the
  // local candidate root.
  const scratchInbox = join(SCRATCH, 'inbox');
  mkdirSync(scratchInbox, {recursive: true});
  copyFileSync(join(INBOX_DIR, 'workspace.json'), join(scratchInbox, 'workspace.json'));
  cpSync(join(INBOX_DIR, WINDOWS_SNAPSHOT_DIR_NAME), join(scratchInbox, WINDOWS_SNAPSHOT_DIR_NAME), {recursive: true});
  const linuxSnapshotDir = join(scratchInbox, LINUX_SNAPSHOT_DIR_NAME);
  mkdirSync(linuxSnapshotDir, {recursive: true});
  for (const name of ['graph.json', 'analysis_manifest.json']) {
    copyFileSync(join(LINUX_SNAPSHOT_SRC, name), join(linuxSnapshotDir, name));
  }
  const bootstrap = readJsonFile(BOOTSTRAP_PATH);
  bootstrap.import_inbox_dir = scratchInbox;
  bootstrap.candidate_roots[0].path_aliases = [LINUX_ANALYZED_ROOT];
  writeJsonFile(BOOTSTRAP_PATH, bootstrap);
  commands.push(`bootstrap import_inbox_dir=${scratchInbox} path_aliases[slice-root] = ${LINUX_ANALYZED_ROOT}`);

  const importArgs = ['snapshot-import', '--workspace', 'code-view-bus-demo', '--variant', 'semantic-x86_64',
    '--repo', 'bus', '--snapshot', LINUX_SNAPSHOT_DIR_NAME, '--operation-id', crypto.randomUUID()];
  const imported = runEngineCli({python, args: importArgs});
  commands.push(`engine ${importArgs.join(' ')} -> exit ${imported.exit_code}`);
  requireCheck('linux_snapshot_import', imported.ok === true && imported.stdout_json !== null, {
    exit_code: imported.exit_code, stdout_json: imported.stdout_json, stderr_tail: imported.stderr_tail ?? null,
  }, 'atlas_snapshot');

  const listArgs = ['view-entries', '--workspace', 'code-view-bus-demo', '--snapshot', LINUX_SNAPSHOT_ID];
  const listed = runEngineCli({python, args: listArgs});
  commands.push(`engine ${listArgs.join(' ')} -> exit ${listed.exit_code}`);
  const entries = listed.stdout_json?.entries ?? [];
  const entryRow = entries.find((item) => item.name === ENTRY_NAME) ?? null;
  requireCheck('linux_snapshot_entries', listed.ok === true && entryRow !== null && entryRow.file === 'bus.c', {
    exit_code: listed.exit_code, entries: entries.length, bus_send: entryRow,
  }, 'atlas_snapshot');
  const linuxEntryId = entryRow?.entry_id ?? null;

  const couplingArgs = ['view-coupling', '--workspace', 'code-view-bus-demo', '--snapshot', LINUX_SNAPSHOT_ID,
    '--entry', linuxEntryId ?? ''];
  const coupling = runEngineCli({python, args: couplingArgs});
  commands.push(`engine ${couplingArgs.join(' ')} -> exit ${coupling.exit_code}`);
  const couplingPayload = coupling.stdout_json ?? {};
  const routes = (couplingPayload.resources ?? []).find((item) => item.name === 'routes') ?? null;
  requireCheck('linux_snapshot_coupling', coupling.ok === true && routes !== null, {
    exit_code: coupling.exit_code,
    resources: (couplingPayload.resources ?? []).length,
    functions: (couplingPayload.functions ?? []).length,
    edges: (couplingPayload.edges ?? []).length,
    routes,
    gaps: couplingPayload.gaps ?? [],
  }, 'atlas_snapshot');

  const readArgs = ['view-file-read', '--workspace', 'code-view-bus-demo', '--snapshot', LINUX_SNAPSHOT_ID,
    '--repo', 'bus', '--path', 'bus.c', '--max-lines', '2000'];
  const source = runEngineCli({python, args: readArgs});
  commands.push(`engine ${readArgs.join(' ')} -> exit ${source.exit_code}`);
  requireCheck('linux_snapshot_source_read', source.ok === true && typeof source.stdout_json?.sha256 === 'string', {
    exit_code: source.exit_code, sha256: source.stdout_json?.sha256 ?? null,
  }, 'atlas_snapshot');

  const windowsFacts = parseGraph(WINDOWS_SNAPSHOT_GRAPH, 'windows-fixture');
  const linuxFacts = parseGraph(join(linuxSnapshotDir, 'graph.json'), 'linux-built');
  commands.push(`compare windows snapshot vs linux snapshot: ${JSON.stringify({windows: windowsFacts.counts, linux: linuxFacts.counts})}`);
  requireCheck('cross_os_graph_counts_match', JSON.stringify(windowsFacts.counts) === JSON.stringify(linuxFacts.counts), {
    windows: windowsFacts.counts, linux: linuxFacts.counts,
  }, 'atlas_snapshot');
  requireCheck('cross_os_field_access_certainty_match', JSON.stringify(windowsFacts.accesses) === JSON.stringify(linuxFacts.accesses), {
    rows: linuxFacts.accesses.length,
    max_len_writes: linuxFacts.accesses.filter((row) => row[2] === 'max_len' && row[3] === 'write'),
    max_len_reads: linuxFacts.accesses.filter((row) => row[2] === 'max_len' && row[3] === 'read').length,
  }, 'atlas_snapshot');
  requireCheck('linux_snapshot_coverage_parsed', linuxFacts.coverage?.parsed === 2 && (linuxFacts.coverage?.failed ?? []).length === 0, {
    parsed: linuxFacts.coverage?.parsed ?? null, failed: linuxFacts.coverage?.failed ?? [],
  }, 'atlas_snapshot');

  // Real isolated dsh-web five-view probe against the Linux-built snapshot.
  const boot = await startWebServer({python, tag: 'linux-atlas'});
  commands.push(`started isolated dsh web ${boot.url.replace(/token=[^&]+/, 'token=<redacted>')}`);
  const shell = await fetchShell(boot.url);
  requireCheck('dsh_web_boot', shell?.response?.status === 200 && typeof shell?.final_url === 'string', {url: boot.url.replace(/token=[^&]+/, 'token=<redacted>')}, 'dsh_host');
  mkdirSync(SHOT_DIR, {recursive: true});
  rmSync(PROBE_JSON, {force: true});
  prepareProbeApp();
  const entryLines = Object.fromEntries(entries.filter((item) => Number.isInteger(item.line)).map((item) => [item.name, item.line]));
  const probeRun = await runElectronProbe({
    boot,
    env: {
      RV_OUT: PROBE_JSON,
      RV_SHOT_DIR: SHOT_DIR,
      RV_ENTRY_NAME: ENTRY_NAME,
      RV_EXPECT_LINE: ENTRY_LINE,
      RV_ENTRY_LINES: JSON.stringify(entryLines),
      RV_SNAPSHOT_ID: LINUX_SNAPSHOT_ID,
      RV_TIMEOUT_MS: '420000',
    },
  });
  commands.push(`five-views probe exit=${probeRun.exitCode}`);
  const probe = probeRun.result;
  // The five-view probe was frozen at S2a; `gapsOriginal` asserts that 组折叠 /
  // 接口库 / AI 归纳 / 运行观测 are still gaps. S2b/S3a/CW-09 implemented them,
  // so that single substep is legitimately superseded (same handling as the
  // verifier's S2a regression). Every other step is evaluated normally.
  const supersededProbeSteps = ['view_coupling_assertions.gapsOriginal'];
  const residualFailedSteps = [];
  for (const [viewName, detail] of Object.entries(probe?.views ?? {})) {
    for (const [step, value] of Object.entries(detail?.steps ?? {})) {
      if (value === true) continue;
      const qualified = `view_${viewName}_assertions.${step}`;
      if (!supersededProbeSteps.includes(qualified)) residualFailedSteps.push(qualified);
    }
  }
  const topLevelFailedSteps = Object.entries(probe?.steps ?? {})
    .filter(([name, value]) => value !== true && !name.startsWith('view_'))
    .map(([name]) => name);
  requireCheck('dsh_web_five_views_probe', residualFailedSteps.length === 0 && topLevelFailedSteps.length === 0 && (probe?.console_error_count ?? 1) === 0, {
    exit_code: probeRun.exitCode,
    probe_ok: probe?.ok ?? null,
    failed_steps: probe?.failed_steps ?? null,
    residual_failed_steps: residualFailedSteps,
    superseded_steps: supersededProbeSteps,
    top_level_failed_steps: topLevelFailedSteps,
    console_error_count: probe?.console_error_count ?? null,
    log_tail: probe ? null : probeRun.logText.slice(-2000),
  }, 'dsh_host');
  const screenshots = copyScreenshots(probe);
  requireCheck('dsh_web_screenshots', ['coupling', 'tree', 'end_to_end', 'sequence', 'file', 'main'].every((name) => screenshots[name]), {
    copied: screenshots,
  }, 'dsh_host');

  try { if (typeof boot.stop === 'function') await boot.stop(); } catch { /* ignore */ }

  const ok = checks.every((item) => item.ok);
  const evidence = {
    schema_version: 1,
    stage: 'S4-prep-linux-atlas',
    objective: 'Linux 构建的 Atlas 0.8 快照经 bootstrap path_aliases 导入 Windows DSH 插件并在隔离 dsh-web 通过五视图验收',
    generated_at: new Date().toISOString(),
    environment: {
      linux_build: 'WSL2 Ubuntu 20.04 + Atlas bundled Python 3.12.14 (Atlas 0.8.0 Linux runtime)',
      linux_analyzed_root: LINUX_ANALYZED_ROOT,
      windows_plugin: 'DSH rc.5 isolated profile, plugin @local/dsh-code-reader',
      bootstrap_alias: `${LINUX_ANALYZED_ROOT} -> slice-root`,
    },
    snapshots: {
      linux: {snapshot_id: LINUX_SNAPSHOT_ID, graph_sha256: readJsonFile(join(linuxSnapshotDir, 'analysis_manifest.json'))?.payload?.graph_hash},
      windows_fixture: {snapshot_dir: WINDOWS_SNAPSHOT_DIR_NAME},
    },
    checks,
    checks_summary: {
      total: checks.length,
      passed: checks.filter((item) => item.ok === true).length,
      failed: checks.filter((item) => item.ok !== true).length,
      in_scope_not_verified: 0,
      out_of_scope_not_verified: 3,
    },
    in_scope_not_verified: [],
    out_of_scope_not_verified: [
      '真实 Linux/Kbuild 内核或驱动源码分析（本轮 Demo C 用户态源码）',
      'native CFG / locks / aliases 深度分析（Atlas Linux runtime 报告 cfg=unsupported；本轮仅验证数据字段与路径映射）',
      '跨参考机审计与复核数据',
    ],
    measurements: {windows: windowsFacts.counts, linux: linuxFacts.counts, field_access_rows: linuxFacts.accesses.length},
    screenshots,
    commands,
    limitations: [
      'Demo C（bus.c/platform.c）是用户态风格源码；Linux 构建仅证明 Atlas Linux runtime + 跨 OS 路径映射链路，不代表已分析目标内核/驱动（Kbuild 仍需目标环境）。',
      'graph/evidence 的绝对路径通过 bootstrap path_aliases 显式映射；未声明 alias 时导入会以 workspace_roots 不匹配拒绝（测试 test_cross_os_snapshot.py）。',
      'Atlas Linux runtime 报告 native_cfg=unsupported、data_flow=partial_path_insensitive、locks=lexical projection；CFG/locks/aliases 深度仍是 out_of_scope。',
    ],
    ok,
    verified: ok,
  };
  writeJsonFile(join(EVIDENCE_DIR, 'verification.json'), evidence);
  writeLog(commands);
  writeFileSync(join(EVIDENCE_DIR, 'five-views-probe.json'), `${JSON.stringify(probe, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ok, verified: ok, checks: checks.length, screenshots: Object.keys(screenshots)}, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
