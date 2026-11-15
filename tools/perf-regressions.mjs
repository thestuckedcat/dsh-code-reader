#!/usr/bin/env node
// S4-prep perf re-test: regression pack for the T29 run (verifier tooling).
//
// Runs in a FRESH isolated home (the perf runner must stop its own web host
// before invoking this script, because both use scratch/readonly-home):
//   * imports the Lead slice workspace/snapshot + scenario-sim profile/trace;
//   * real dsh web (pinned rc.5) with the same web profile;
//   * S3b acceptance probe (undo/trace/observed), S3a regression probe
//     (RV_SCENARIO_CHANNEL=3), S2b acceptance probe;
//   * AI-summary gap probe -> real engine summary-put -> written probe;
//   * JSON summary on stdout (last line) + scratch/perf/regressions.json.
// Never modifies plugin code; scratch/ and evidence/perf only.
import {spawn, spawnSync} from 'node:child_process';
import {copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {EXECUTABLE, RENDER_PROBE_ELECTRON} from './readonly-slice/host-baseline.mjs';
import {
  SLICE_DIR, WORKSPACE_ID, prepareIsolatedHome, readJsonFile, runEngineCli, writeJsonFile,
} from './readonly-slice/isolated-home.mjs';
import {startWebServer} from './readonly-slice/web-host.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = join(REPO_ROOT, 'scratch', 'perf', 'regressions');
const OUT_JSON = join(SCRATCH, 'regressions.json');
const SCENARIO_SIM = join(REPO_ROOT, 'evidence', 'scenario-sim', 'inbox');
const SNAPSHOT_ID = 'ed326d554334432b907de21297207eb8';
const BUS_SEND = 'f_afa8298f2d197e5fd110e49a';
const EVIDENCE_ID = 'e_231505a73a485bc1d8c9249d';
const SUMMARY_TEXT = 'bus_send 先校验通道与长度，再查路由表；长度上限取 route->max_len，超长返回 -22。此归纳基于静态结构与源码文本，未含运行观测。';
const SUMMARY_GAP_PROBE = join(REPO_ROOT, 'tools', 'summary-probe.cjs');
const S3B_PROBE = join(REPO_ROOT, 'tools', 's3b-probe.cjs');
const S3A_PROBE = join(REPO_ROOT, 'tools', 's3-probe.cjs');
const S2B_PROBE = join(REPO_ROOT, 'tools', 's2b-probe.cjs');

const report = {ok: false, started_at_utc: new Date().toISOString(), checks: {}, probes: {}, commands: []};

function record(name, ok, detail = {}) {
  report.checks[name] = {ok: ok === true, detail};
  if (ok !== true) report.failed = report.failed ?? [], report.failed.push(name);
  return ok === true;
}

function runProbe({probeFile, appName, runName, env, timeoutMs = 480000}) {
  const appDir = join(SCRATCH, 'apps', appName);
  mkdirSync(appDir, {recursive: true});
  const entryName = `${appName}.cjs`;
  copyFileSync(probeFile, join(appDir, entryName));
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({name: `dsh-code-reader-${appName}`, version: '0.0.0-private', private: true, main: entryName}, null, 2));
  const outPath = join(SCRATCH, `${runName}.json`);
  const shotDir = join(SCRATCH, `shots-${runName}`);
  mkdirSync(shotDir, {recursive: true});
  rmSync(outPath, {force: true});
  const userDataDir = join(SCRATCH, `electron-userdata-${runName}-${Date.now()}`);
  const probeEnv = {...process.env, ...env, RV_OUT: outPath, RV_SHOT_DIR: shotDir};
  delete probeEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(RENDER_PROBE_ELECTRON, [appDir, '--no-sandbox', '--disable-gpu', `--user-data-dir=${userDataDir}`], {cwd: REPO_ROOT, env: probeEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { log += chunk.toString('utf8'); });
  const wait = new Promise((resolvePromise) => {
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolvePromise(null); }, timeoutMs);
    child.once('exit', (code) => { clearTimeout(timer); resolvePromise(code); });
  });
  return wait.then((exitCode) => {
    try { rmSync(userDataDir, {recursive: true, force: true}); } catch { /* best effort */ }
    report.commands.push({executable: RENDER_PROBE_ELECTRON, args: [appDir, '--no-sandbox', '--disable-gpu'], exit_code: exitCode, run: runName});
    const probe = existsSync(outPath) ? readJsonFile(outPath) : null;
    return {exitCode, probe, log, outPath};
  });
}

function cli(python, bootstrapPath, args) {
  const result = runEngineCli({python, args, bootstrapPath});
  report.commands.push({executable: python.command, args: result.argv, exit_code: result.exit_code, run: 'engine'});
  return result;
}

function scenarioResidual(probe, ignored) {
  if (probe === null) return ['probe-missing'];
  const residual = [];
  for (const [view, detail] of Object.entries(probe.views ?? {})) {
    for (const [step, value] of Object.entries(detail?.steps ?? {})) {
      if (value !== true && !ignored.includes(step)) residual.push(`${view}.${step}`);
    }
  }
  return residual;
}

async function main() {
  const python = process.env.PYTHON_BIN ?? 'E:/Anaconda-main/python.exe';
  const prepared = prepareIsolatedHome({wipe: true, importData: false, quiet: true});
  const inbox = join(SCRATCH, 'inbox');
  mkdirSync(inbox, {recursive: true});
  copyFileSync(join(SLICE_DIR, 'inbox', 'workspace.json'), join(inbox, 'workspace.json'));
  cpSync(join(SLICE_DIR, 'inbox', 'snapshot-bus'), join(inbox, 'snapshot-bus'), {recursive: true});
  for (const name of ['sim-profile.json', 'bus.wasm', 'trace-bus-send.json']) copyFileSync(join(SCENARIO_SIM, name), join(inbox, name));
  const bootstrap = readJsonFile(prepared.bootstrap_path);
  bootstrap.import_inbox_dir = inbox;
  writeJsonFile(prepared.bootstrap_path, bootstrap);
  const enginePython = prepared.python?.command ?? python;
  const imports = {
    workspace: cli(prepared.python, prepared.bootstrap_path, ['workspace-import', '--manifest', 'workspace.json', '--expected-revision', '0', '--operation-id', crypto.randomUUID()]).exit_code,
    snapshot: cli(prepared.python, prepared.bootstrap_path, ['snapshot-import', '--workspace', WORKSPACE_ID, '--variant', 'semantic-x86_64', '--repo', 'bus', '--snapshot', 'snapshot-bus', '--operation-id', crypto.randomUUID()]).exit_code,
    profile: cli(prepared.python, prepared.bootstrap_path, ['sim-profile-import', '--workspace', WORKSPACE_ID, '--variant', 'semantic-x86_64', '--repo', 'bus', '--profile', 'sim-profile.json', '--operation-id', crypto.randomUUID()]).exit_code,
    trace: cli(prepared.python, prepared.bootstrap_path, ['trace-import', '--workspace', WORKSPACE_ID, '--snapshot', SNAPSHOT_ID, '--input', 'trace-bus-send.json', '--operation-id', crypto.randomUUID()]).exit_code,
  };
  report.imports = imports;
  const boot = await startWebServer({python: prepared.python, tag: 'perf-regressions'});
  try {
    report.boot = {url: boot.url.replace(/token=[^&]+/, 'token=<redacted>')};
    const baseEnv = {
      RV_URL: boot.url,
      RV_ENTRY_NAME: 'bus_send',
      RV_EXPECT_LINE: '152',
      RV_SNAPSHOT_ID: SNAPSHOT_ID,
      RV_TIMEOUT_MS: '480000',
    };
    // --- S3b acceptance probe (undo / trace import / observed selector) ---
    const s3b = await runProbe({probeFile: S3B_PROBE, appName: 'perf-reg-s3b', runName: 's3b', env: {...baseEnv, RV_SUBFLOW_ENTRY: 'check_length'}});
    report.probes.s3b = {exit_code: s3b.exitCode, ok: s3b.probe?.ok ?? null, failed_steps: s3b.probe?.failed_steps ?? null, console_error_count: s3b.probe?.console_error_count ?? null};
    record('regression.s3b_probe', s3b.probe !== null && s3b.probe.ok === true && (s3b.probe.console_error_count ?? 1) === 0, {exit_code: s3b.exitCode, failed_steps: s3b.probe?.failed_steps ?? null, console_error_count: s3b.probe?.console_error_count ?? null, log_tail: s3b.log.slice(-800)});

    // --- S3a regression probe (channel=3 so it does not collide with S3b's ledger) ---
    const s3a = await runProbe({probeFile: S3A_PROBE, appName: 'perf-reg-s3a', runName: 's3a', env: {...baseEnv, RV_SCENARIO_CHANNEL: '3'}});
    const s3aIgnored = ['s3bGap', 'traceImportGap', 'capabilityGaps', 'undoDisabled'];
    const s3aResidual = scenarioResidual(s3a.probe, s3aIgnored);
    report.probes.s3a = {exit_code: s3a.exitCode, ok: s3a.probe?.ok ?? null, residual_failed_steps: s3aResidual, ignored_superseded: s3aIgnored, console_error_count: s3a.probe?.console_error_count ?? null};
    record('regression.s3a_probe', s3a.probe !== null && s3aResidual.length === 0 && (s3a.probe.console_error_count ?? 1) === 0, {exit_code: s3a.exitCode, residual_failed_steps: s3aResidual, ignored_superseded: s3aIgnored, console_error_count: s3a.probe?.console_error_count ?? null, log_tail: s3a.log.slice(-800)});

    // --- S2b acceptance probe ---
    const s2b = await runProbe({probeFile: S2B_PROBE, appName: 'perf-reg-s2b', runName: 's2b', env: {...baseEnv, RV_EXPECT_LINE: '152', RV_SUBFLOW_ENTRY: 'check_length'}});
    report.probes.s2b = {exit_code: s2b.exitCode, ok: s2b.probe?.ok ?? null, failed_steps: s2b.probe?.failed_steps ?? null, console_error_count: s2b.probe?.console_error_count ?? null};
    record('regression.s2b_probe', s2b.probe !== null && s2b.probe.ok === true && (s2b.probe.console_error_count ?? 1) === 0, {exit_code: s2b.exitCode, failed_steps: s2b.probe?.failed_steps ?? null, console_error_count: s2b.probe?.console_error_count ?? null, log_tail: s2b.log.slice(-800)});

    // --- AI summary: gap probe -> real engine summary-put -> written probe ---
    const gap = await runProbe({probeFile: SUMMARY_GAP_PROBE, appName: 'perf-reg-summary-gap', runName: 'summary-gap', env: {...baseEnv, RV_PHASE: 'gap', RV_TIMEOUT_MS: '300000'}});
    report.probes.summary_gap = {exit_code: gap.exitCode, ok: gap.probe?.ok ?? null, steps: gap.probe?.steps ?? null, console_error_count: gap.probe?.console_error_count ?? null};
    const putResult = cli(prepared.python, prepared.bootstrap_path, ['summary-put', '--workspace', WORKSPACE_ID, '--snapshot', SNAPSHOT_ID, '--payload-json', Buffer.from(JSON.stringify({
      subject: {type: 'function', id: BUS_SEND},
      text: SUMMARY_TEXT,
      facts: [{kind: 'evidence', ref: EVIDENCE_ID}],
      generator: {kind: 'agent', ref: 'perf-regression'},
      inference_labels: ['from_static_structure'],
    }), 'utf8').toString('base64')]);
    const written = await runProbe({probeFile: SUMMARY_GAP_PROBE, appName: 'perf-reg-summary-written', runName: 'summary-written', env: {...baseEnv, RV_PHASE: 'written', RV_EXPECT_TEXT: SUMMARY_TEXT, RV_TIMEOUT_MS: '300000'}});
    report.probes.summary_written = {exit_code: written.exitCode, ok: written.probe?.ok ?? null, steps: written.probe?.steps ?? null, console_error_count: written.probe?.console_error_count ?? null};
    record('regression.summary_roundtrip', gap.probe !== null && gap.probe.ok === true && putResult.ok === true && written.probe !== null && written.probe.ok === true && (gap.probe.console_error_count ?? 1) === 0 && (written.probe.console_error_count ?? 1) === 0, {
      gap: {exit_code: gap.exitCode, ok: gap.probe?.ok ?? null, steps: gap.probe?.steps ?? null},
      summary_put: {exit_code: putResult.exit_code, ok: putResult.ok, projection_text: putResult.stdout_json?.summary?.text ?? putResult.stdout_json?.text ?? null},
      written: {exit_code: written.exitCode, ok: written.probe?.ok ?? null, steps: written.probe?.steps ?? null},
      console_error_counts: {gap: gap.probe?.console_error_count ?? null, written: written.probe?.console_error_count ?? null},
      log_tail: (gap.log + written.log).slice(-800),
    });
  } finally {
    await boot.stop().catch(() => null);
  }
  report.finished_at_utc = new Date().toISOString();
  report.duration_ms = Date.parse(report.finished_at_utc) - Date.parse(report.started_at_utc);
  report.ok = Object.values(report.checks).every((row) => row.ok === true);
  mkdirSync(SCRATCH, {recursive: true});
  writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(SCRATCH, 'commands.log'), report.commands.map((row) => `${row.run ?? ''} ${row.executable} ${(row.args ?? []).join(' ')} [exit ${row.exit_code}]`).join('\n') + '\n', 'utf8');
  process.stdout.write(`${JSON.stringify({ok: report.ok, checks: Object.fromEntries(Object.entries(report.checks).map(([name, row]) => [name, row.ok])), duration_ms: report.duration_ms, evidence: 'scratch/perf/regressions/regressions.json'}, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((error) => {
  report.ok = false;
  report.error = String(error?.stack ?? error);
  mkdirSync(SCRATCH, {recursive: true});
  writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ok: false, error: report.error.split('\n')[0]}, null, 2)}\n`);
  process.exitCode = 1;
});
