#!/usr/bin/env node
// Runner for the real-rc.5 Host-runtime acceptance test.
//
// 1. Re-verifies the pinned executable/archive digests (never trust a cached
//    gate from another process).
// 2. Uses the isolated DSH_HOME/bootstrap prepared by tools/verify-readonly.mjs
//    (env READONLY_HOME + READONLY_BOOTSTRAP), or prepares a fresh one.
// 3. Runs tools/readonly-slice/host-runtime.test.mjs under the installed
//    Electron's embedded Node 24.21.0 (`ELECTRON_RUN_AS_NODE=1`) and records
//    TAP + JSON evidence under evidence/readonly-slice/.
//
// It never touches the user's real ~/.dsh, never boots a web server and never
// writes into the plugin implementation.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  EXECUTABLE,
  HOST_BASELINE,
  verifyHostBaseline,
} from './readonly-slice/host-baseline.mjs';
import {
  EVIDENCE_DIR,
  HOME_DIR,
  REPO_ROOT,
  inspectSnapshot,
  isolatedEnv,
  prepareIsolatedHome,
  resolvePython,
} from './readonly-slice/isolated-home.mjs';

const TAP_PATH = join(EVIDENCE_DIR, 'host-runtime.tap');
const JSON_PATH = join(EVIDENCE_DIR, 'host-runtime.json');
const TEST_RELATIVE = 'tools/readonly-slice/host-runtime.test.mjs';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function parseTapSummary(tapText) {
  const summary = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const match = tapText.match(new RegExp(`^# ${key} (\\d+)\\r?$`, 'm'));
    summary[key] = match === null ? null : Number(match[1]);
  }
  return summary;
}

function main() {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const report = {
    schema_version: 1,
    started_at_utc: startedAt,
    layer: 'dsh_host',
    purpose: 'Real pinned rc.5 Cordis Context mounts/serves/disposes/re-mounts the 04 plugin; one real Python tool call and the /code-view read-model endpoints succeed',
    host: HOST_BASELINE,
    mode: null,
    isolated_home: null,
    command: null,
    tap_path: 'evidence/readonly-slice/host-runtime.tap',
    checks: {},
  };

  try {
    const gate = verifyHostBaseline();
    report.gates = gate;
    report.checks.host_digest = gate.ok;
    if (!gate.ok) throw new Error(`pinned host gate failed: ${JSON.stringify(gate.checks.filter((row) => !row.ok))}`);

    const parentHome = process.env.READONLY_HOME;
    const parentBootstrap = process.env.READONLY_BOOTSTRAP;
    let python;
    let home;
    let bootstrapPath;
    let snapshot = null;
    if (typeof parentHome === 'string' && parentHome.length > 0) {
      home = parentHome;
      bootstrapPath = typeof parentBootstrap === 'string' && parentBootstrap.length > 0
        ? parentBootstrap
        : join(home, 'code-reader', 'bootstrap.json');
      report.mode = 'parent-prepared isolated home';
    } else {
      const prepared = prepareIsolatedHome({wipe: true, importData: true});
      home = prepared.home;
      bootstrapPath = prepared.bootstrap_path;
      snapshot = prepared.snapshot;
      report.mode = 'standalone isolated home';
    }
    python = resolvePython();
    report.isolated_home = home;
    report.snapshot = snapshot
      ? {snapshot_id: snapshot.snapshot_id, graph_sha256: snapshot.graph_sha256, entry_count: snapshot.entry_count, target: snapshot.target}
      : inspectSnapshot().ok
        ? (({snapshot_id, graph_sha256, entry_count, target}) => ({snapshot_id, graph_sha256, entry_count, target}))(inspectSnapshot())
        : null;

    mkdirSync(EVIDENCE_DIR, {recursive: true});
    const args = [
      '--test',
      '--test-concurrency=1',
      '--test-reporter=tap',
      `--test-reporter-destination=${TAP_PATH}`,
      TEST_RELATIVE,
    ];
    const env = isolatedEnv({
      python,
      home,
      extra: {
        ELECTRON_RUN_AS_NODE: '1',
        CODE_READER_BOOTSTRAP: bootstrapPath,
        READONLY_WORKSPACE_ID: process.env.READONLY_WORKSPACE_ID ?? 'code-view-bus-demo',
        READONLY_ENTRY_NAME: process.env.READONLY_ENTRY_NAME ?? (report.snapshot?.target?.name ?? 'bus_send'),
        READONLY_ENTRY_LINE: String(process.env.READONLY_ENTRY_LINE ?? (report.snapshot?.target?.line ?? 152)),
        READONLY_SNAPSHOT_ID: process.env.READONLY_SNAPSHOT_ID ?? (report.snapshot?.snapshot_id ?? ''),
        DSH_AUDIT_APPLICATION: '04-readonly-slice-verifier',
      },
    });
    report.command = {
      executable: EXECUTABLE,
      args,
      cwd: REPO_ROOT,
      env_subset: {
        ELECTRON_RUN_AS_NODE: env.ELECTRON_RUN_AS_NODE,
        DSH_HOME: env.DSH_HOME,
        CODE_READER_BOOTSTRAP: env.CODE_READER_BOOTSTRAP,
        DSH_TELEMETRY_DISABLED: env.DSH_TELEMETRY_DISABLED,
      },
    };
    const result = spawnSync(EXECUTABLE, args, {
      cwd: REPO_ROOT,
      env,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 300000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const durationMs = Math.round(performance.now() - started);
    let tapText = '';
    try {
      tapText = readFileSync(TAP_PATH, 'utf8');
    } catch {
      tapText = '';
    }
    const summary = parseTapSummary(tapText);
    report.duration_ms = durationMs;
    report.exit_code = result.status;
    report.timed_out = result.error?.code === 'ETIMEDOUT';
    report.tap_summary = summary;
    report.tap_sha256 = tapText === '' ? null : sha256(tapText);
    report.stdout_tail = (result.stdout ?? '').slice(-6000);
    report.stderr_tail = (result.stderr ?? '').slice(-6000);
    report.checks.tap_completed = summary.tests !== null && summary.tests > 0;
    report.checks.tap_all_passed = summary.fail === 0 && summary.tests !== null && summary.tests === summary.pass;
    report.checks.process_exit_zero = result.status === 0;
    report.ok = report.checks.host_digest === true
      && report.checks.tap_completed === true
      && report.checks.tap_all_passed === true
      && report.checks.process_exit_zero === true;
    report.verified = report.ok;
  } catch (error) {
    report.ok = false;
    report.verified = false;
    report.error = String(error?.message ?? error);
  }

  report.generated_at = new Date().toISOString();
  mkdirSync(EVIDENCE_DIR, {recursive: true});
  writeFileSync(JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (report.stdout_tail) process.stdout.write(report.stdout_tail);
  if (report.stderr_tail) process.stderr.write(report.stderr_tail);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    exit_code: report.exit_code,
    tap_summary: report.tap_summary,
    duration_ms: report.duration_ms,
    evidence: 'evidence/readonly-slice/host-runtime.json',
    error: report.error,
  }, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

main();
