#!/usr/bin/env node
// S4-prep T33: batch first-screen consistency verifier (independent, read-only).
//
// Contract: docs/five-view-contract.md §12.1/§12.2.
//   * real CLI in one isolated state: view-first-screen --view X vs the
//     individual endpoints (view-entry / view-interfaces / view-coupling /
//     view-tree / view-end-to-end / view-sequence / view-file-tree);
//   * field-by-field equality of entry / interfaces / view_payload;
//   * unknown view + unknown entry are rejected with explicit error codes;
//   * no absolute paths in either payload;
//   * real dsh web RPC: /code-view/view.firstScreen vs individual RPC values
//     must be field-by-field equal for every view.
// Writes evidence/perf/first-screen-consistency.json and prints a JSON summary.
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  SLICE_DIR, WORKSPACE_ID, prepareIsolatedHome, readJsonFile, runEngineCli, writeJsonFile,
} from './readonly-slice/isolated-home.mjs';
import {extractBootManifest, fetchShell, httpFetch, startWebServer} from './readonly-slice/web-host.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = join(REPO_ROOT, 'scratch', 'firstscreen');
const OUT_JSON = join(SCRATCH, 'consistency.json');
const EVIDENCE = join(REPO_ROOT, 'evidence', 'perf', 'first-screen-consistency.json');
const SNAPSHOT_DIR = 'snapshot-bus';
const WORKSPACE = WORKSPACE_ID;
const ENTRY_NAME = 'bus_send';
const SNAPSHOT_ID = 'ed326d554334432b907de21297207eb8';
const FIRST_SCREEN_LIMIT_BYTES = 480 * 1024;
const VIEWS = [['coupling', 'view.coupling', ['view-coupling']], ['tree', 'view.tree', ['view-tree']], ['end_to_end', 'view.endToEnd', ['view-end-to-end']], ['sequence', 'view.sequence', ['view-sequence']], ['file', 'view.fileTree', ['view-file-tree']]];

const report = {
  ok: false,
  started_at_utc: new Date().toISOString(),
  workspace_id: WORKSPACE,
  entry_name: ENTRY_NAME,
  checks: {},
  cli: {},
  rpc: {},
  commands: [],
  not_verified: [],
};

function record(name, ok, detail = {}) {
  const passed = ok === true;
  report.checks[name] = {ok: passed, detail};
  if (!passed) {
    report.ok = false;
    report.failed = report.failed ?? [];
    report.failed.push(name);
  }
  return passed;
}

function logCommand(executable, args, exitCode, cwd = REPO_ROOT) {
  report.commands.push({executable, args, exit_code: exitCode, cwd});
}

function cli(python, bootstrapPath, args) {
  const result = runEngineCli({python, args, bootstrapPath});
  logCommand(python.command, result.argv ?? ['engine', ...args], result.exit_code);
  return result;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

// Signed path refs (e.g. entry.source.evidence_ref) are re-signed per call and
// embed the issue time, so their raw tokens legitimately differ across calls.
// Compare their decoded claims instead (ignoring only the volatile issue time).
function signedRefClaims(value) {
  if (typeof value !== 'string' || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const payload = value.split('.')[1];
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8'));
    if (claims !== null && typeof claims === 'object' && !Array.isArray(claims)) {
      delete claims.t;
      return claims;
    }
    return null;
  } catch { return null; }
}

function diffPaths(left, right, path = '$', out = [], limit = 12) {
  if (out.length >= limit) return out;
  if (left === right) return out;
  if (typeof left === 'string' && typeof right === 'string') {
    const leftClaims = signedRefClaims(left);
    const rightClaims = signedRefClaims(right);
    if (leftClaims !== null && rightClaims !== null && JSON.stringify(canonical(leftClaims)) === JSON.stringify(canonical(rightClaims))) return out;
  }
  if (typeof left !== typeof right || left === null || right === null || typeof left !== 'object') {
    out.push({path, left: preview(left), right: preview(right)});
    return out;
  }
  if (Array.isArray(left) !== Array.isArray(right)) {
    out.push({path, left: Array.isArray(left) ? 'array' : 'object', right: Array.isArray(right) ? 'array' : 'object'});
    return out;
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of [...keys].sort()) {
    if (out.length >= limit) break;
    if (!(key in left)) out.push({path: `${path}.${key}`, left: '<missing>', right: preview(right[key])});
    else if (!(key in right)) out.push({path: `${path}.${key}`, left: preview(left[key]), right: '<missing>'});
    else diffPaths(left[key], right[key], `${path}.${key}`, out, limit);
  }
  return out;
}

function preview(value) {
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 117)}…` : value;
  if (value === undefined) return '<undefined>';
  try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
}

function canonicalSize(value) {
  if (value === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function pick(obj, keys) {
  if (obj === null || typeof obj !== 'object') return undefined;
  for (const key of keys) if (key in obj) return obj[key];
  return obj;
}

const ABSOLUTE_PATH = /(?:^|[\s"']) [A-Za-z]:[\\/]|\\\\[^\\]|\b(?:state|bootstrap|import_inbox|output)[\\/](?:[^\s"']+)/g;

function absolutePaths(value, path = '$', out = [], limit = 8) {
  if (out.length >= limit) return out;
  if (typeof value === 'string') {
    if (/[A-Za-z]:[\\/]/.test(value) || value.includes('\\\\')) out.push({path, value: value.slice(0, 160)});
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => absolutePaths(item, `${path}[${index}]`, out, limit));
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) absolutePaths(item, `${path}.${key}`, out, limit);
  }
  return out;
}

async function rpc(boot, cookieHeader, endpoint, payload, rpcId) {
  const response = await httpFetch(new URL(`/code-view/${endpoint}`, boot.url), {
    method: 'POST',
    headers: {'content-type': 'application/json', ...cookieHeader},
    body: JSON.stringify({type: 'client-request', rpcId, method: endpoint, payload}),
  });
  let parsed = null;
  try { parsed = JSON.parse(response.text); } catch { parsed = null; }
  return {status: response.status, parsed, value: parsed?.result?.value ?? null, ok: parsed?.result?.ok === true, text: response.text};
}

async function main() {
  mkdirSync(SCRATCH, {recursive: true});
  const prepared = prepareIsolatedHome({wipe: true, importData: false, quiet: true});
  const inbox = join(SCRATCH, 'inbox');
  mkdirSync(inbox, {recursive: true});
  for (const name of ['workspace.json', SNAPSHOT_DIR]) {
    const source = join(SLICE_DIR, 'inbox', name);
    if (existsSync(source)) {
      const target = join(inbox, name);
      if (name.endsWith('.json')) writeJsonFile(target, readJsonFile(source));
      else {
        const {cpSync} = await import('node:fs');
        cpSync(source, target, {recursive: true});
      }
    }
  }
  const bootstrap = readJsonFile(prepared.bootstrap_path);
  bootstrap.import_inbox_dir = inbox;
  writeJsonFile(prepared.bootstrap_path, bootstrap);
  report.imports = {
    workspace: cli(prepared.python, prepared.bootstrap_path, ['workspace-import', '--manifest', 'workspace.json', '--expected-revision', '0', '--operation-id', randomUUID()]).exit_code,
    snapshot: cli(prepared.python, prepared.bootstrap_path, ['snapshot-import', '--workspace', WORKSPACE, '--variant', 'semantic-x86_64', '--repo', 'bus', '--snapshot', SNAPSHOT_DIR, '--operation-id', randomUUID()]).exit_code,
  };
  const py = prepared.python;
  const boot = prepared.bootstrap_path;
  // Resolve the real snapshot id from view-snapshots (the importer may keep the
  // manifest snapshot id; this avoids hard-coding a stale id in future runs).
  const listed = cli(py, boot, ['view-snapshots']);
  const snapshots = [];
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object') {
      if (typeof value.snapshot_id === 'string' && value.workspace_id === WORKSPACE) snapshots.push(value);
      for (const item of Object.values(value)) walk(item);
    }
  };
  walk(listed.stdout_json);
  const snapshotId = snapshots.find((row) => row.status === 'verified')?.snapshot_id
    ?? listed.stdout_json?.workspaces?.[0]?.snapshots?.find((row) => row.status === 'verified')?.snapshot_id
    ?? listed.stdout_json?.workspaces?.[0]?.snapshots?.[0]?.snapshot_id
    ?? listed.stdout_json?.snapshots?.[0]?.snapshot_id
    ?? SNAPSHOT_ID;
  if (typeof snapshotId !== 'string') throw new Error('could not resolve an imported snapshot id');
  const argsFor = (entry, view) => ['--workspace', WORKSPACE, '--snapshot', snapshotId, '--entry', entry, ...(view === undefined ? [] : ['--view', view])];

  const entries = cli(py, boot, ['view-entries', '--workspace', WORKSPACE, '--snapshot', snapshotId]);
  const entryRows = [];
  const collectEntries = (value) => {
    if (Array.isArray(value)) value.forEach(collectEntries);
    else if (value !== null && typeof value === 'object') {
      if (typeof value.entry_id === 'string' && typeof value.name === 'string') entryRows.push(value);
      for (const item of Object.values(value)) collectEntries(item);
    }
  };
  collectEntries(entries.stdout_json);
  const entryId = entryRows.find((row) => row.name === ENTRY_NAME)?.entry_id ?? entryRows[0]?.entry_id;
  if (typeof entryId !== 'string') throw new Error('could not resolve an entry id');
  report.entry_id = entryId;
  report.snapshot_id = snapshotId;

  const individual = {
    entry: cli(py, boot, ['view-entry', '--workspace', WORKSPACE, '--snapshot', snapshotId, '--entry', entryId]).stdout_json,
    interfaces: cli(py, boot, ['view-interfaces', '--workspace', WORKSPACE, '--snapshot', snapshotId, '--entry', entryId]).stdout_json,
    coupling: cli(py, boot, ['view-coupling', '--workspace', WORKSPACE, '--snapshot', snapshotId, '--entry', entryId]).stdout_json,
    tree: cli(py, boot, ['view-tree', '--workspace', WORKSPACE, '--snapshot', snapshotId, '--entry', entryId]).stdout_json,
    end_to_end: cli(py, boot, ['view-end-to-end', '--workspace', WORKSPACE, '--snapshot', snapshotId, '--entry', entryId]).stdout_json,
    sequence: cli(py, boot, ['view-sequence', '--workspace', WORKSPACE, '--snapshot', snapshotId, '--entry', entryId, '--mode', 'static']).stdout_json,
    file: cli(py, boot, ['view-file-tree', '--workspace', WORKSPACE, '--snapshot', snapshotId]).stdout_json,
  };
  report.cli.individual_exit_codes = Object.fromEntries(Object.entries(individual).map(([key, value]) => [key, value?.schema_version !== undefined || value?.error === undefined ? 0 : 1]));

  const batchResults = {};
  let cliConsistency = true;
  let cliNoAbsolute = true;
  let cliCouplingAux = true;
  for (const [view, , ] of VIEWS) {
    const batch = cli(py, boot, ['view-first-screen', ...argsFor(entryId, view)]);
    const payload = batch.stdout_json;
    const entryProjection = payload?.entry;
    const interfaceProjection = payload?.interfaces;
    const viewProjection = payload?.view_payload;
    const entryDiff = diffPaths(entryProjection, individual.entry, '$.entry');
    const interfacesDiff = diffPaths(interfaceProjection, individual.interfaces, '$.interfaces');
    const viewDiff = diffPaths(viewProjection, individual[view], '$.view_payload');
    const hasAux = payload !== null && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'coupling_aux');
    const auxValue = payload?.coupling_aux;
    let couplingDiff = [];
    let couplingOk = true;
    if (view === 'coupling') {
      // Convention: no coupling_aux (absent or null) for the coupling view; sizes.coupling_aux is 0 (or absent).
      couplingOk = (!hasAux || auxValue === null) && ((payload?.sizes?.coupling_aux ?? 0) === 0);
    } else {
      couplingDiff = diffPaths(auxValue, individual.coupling, '$.coupling_aux');
      couplingOk = hasAux && auxValue !== null && couplingDiff.length === 0 && (payload?.sizes?.coupling_aux ?? 0) > 0;
    }
    const sizes = payload?.sizes ?? null;
    const expectedSizes = {
      entry: canonicalSize(payload?.entry),
      interfaces: canonicalSize(payload?.interfaces),
      view: canonicalSize(payload?.view_payload),
      coupling_aux: view === 'coupling' ? 0 : canonicalSize(auxValue),
    };
    const sizesMatch = sizes !== null
      && sizes.entry === expectedSizes.entry
      && sizes.interfaces === expectedSizes.interfaces
      && sizes.view === expectedSizes.view
      && (sizes.coupling_aux ?? 0) === expectedSizes.coupling_aux;
    const sizeSum = sizes === null ? null : (sizes.entry ?? 0) + (sizes.interfaces ?? 0) + (sizes.view ?? 0) + (sizes.coupling_aux ?? 0);
    const budgetOk = sizeSum !== null && sizeSum <= FIRST_SCREEN_LIMIT_BYTES;
    const absolute = absolutePaths(payload);
    if (absolute.length > 0) cliNoAbsolute = false;
    const ok = batch.exit_code === 0 && entryDiff.length === 0 && interfacesDiff.length === 0 && viewDiff.length === 0 && couplingOk && sizesMatch && budgetOk && absolute.length === 0;
    if (!ok) cliConsistency = false;
    if (!couplingOk || !sizesMatch || !budgetOk) cliCouplingAux = false;
    batchResults[view] = {
      ok,
      exit_code: batch.exit_code,
      view,
      coupling_aux_present: hasAux,
      coupling_aux_value_is_null: auxValue === null,
      sizes,
      sizes_expected: expectedSizes,
      sizes_match: sizesMatch,
      size_sum: sizeSum,
      budget_ok: budgetOk,
      truncated: payload?.truncated ?? null,
      limitations: payload?.limitations ?? null,
      entry_diff: entryDiff,
      interfaces_diff: interfacesDiff,
      view_payload_diff: viewDiff,
      coupling_aux_diff: couplingDiff,
      coupling_aux_ok: couplingOk,
      absolute_paths: absolute,
    };
  }
  report.cli.batch = batchResults;
  report.first_screen_budget = {limit_bytes: FIRST_SCREEN_LIMIT_BYTES, limit_exceeded_exercised: false, note: 'real bus snapshot payloads are below 480 KiB; LIMIT_EXCEEDED enforcement is covered by engine/Node tests, not triggered by this verifier run'};
  report.signed_ref_normalization = 'signed path refs compared by decoded claims, ignoring the per-call issue time t (raw tokens are re-signed per call and legitimately differ)';
  record('cli.batch_vs_individual', cliConsistency && report.imports.workspace === 0 && report.imports.snapshot === 0, {views: Object.keys(batchResults), imports: report.imports, batch: batchResults});
  record('cli.coupling_aux_and_sizes', cliCouplingAux, {views: Object.keys(batchResults), batch: batchResults, note: 'coupling_aux present only for view!=coupling and field-equal to view-coupling; sizes include coupling_aux and sum <= 480 KiB (limit not exercised by this real snapshot)'});

  // CLI negative cases: unknown view + unknown entry.
  const unknownView = cli(py, boot, ['view-first-screen', ...argsFor(entryId), '--view', 'bogus_view']);
  const unknownEntry = cli(py, boot, ['view-first-screen', '--workspace', WORKSPACE, '--snapshot', snapshotId, '--entry', 'f_unknown_entry_000000000000', '--view', 'coupling']);
  const unknownViewCode = unknownView.stdout_json?.error?.code ?? null;
  const unknownEntryCode = unknownEntry.stdout_json?.error?.code ?? null;
  const negativeOk = unknownView.exit_code !== 0 && ['INVALID_ARGUMENT', 'BAD_ARGUMENT'].includes(unknownViewCode)
    && unknownEntry.exit_code !== 0 && unknownEntryCode === 'NOT_FOUND';
  record('cli.negative_cases', negativeOk, {unknown_view: {exit_code: unknownView.exit_code, code: unknownViewCode}, unknown_entry: {exit_code: unknownEntry.exit_code, code: unknownEntryCode}});
  record('cli.no_absolute_paths', cliNoAbsolute, {views: Object.keys(batchResults)});

  // Real dsh web RPC consistency.
  const webBoot = await startWebServer({python: prepared.python, tag: 'firstscreen-consistency'});
  try {
    const shell = await fetchShell(webBoot.url);
    const cookies = shell.cookies ?? [];
    const cookieHeader = cookies.length > 0 ? {cookie: cookies.join('; ')} : {};
    const batchEndpoint = 'view.firstScreen';
    const rpcResults = {};
    let rpcConsistency = true;
    let rpcNoAbsolute = true;
    let rpcCouplingAux = true;
    for (const [view, endpoint, ] of VIEWS) {
      const payload = {workspace: WORKSPACE, snapshot: snapshotId, entry: entryId, view};
      const batch = await rpc(webBoot, cookieHeader, batchEndpoint, payload, `fs-batch-${view}`);
      const entryRpc = await rpc(webBoot, cookieHeader, 'view.getEntry', {workspace: WORKSPACE, snapshot: snapshotId, entry: entryId}, `fs-entry-${view}`);
      const interfacesRpc = await rpc(webBoot, cookieHeader, 'view.interfaces', {workspace: WORKSPACE, snapshot: snapshotId, entry: entryId}, `fs-interfaces-${view}`);
      const viewRpc = await rpc(webBoot, cookieHeader, endpoint, endpoint === 'view.fileTree' ? {workspace: WORKSPACE, snapshot: snapshotId} : {workspace: WORKSPACE, snapshot: snapshotId, entry: entryId, ...(endpoint === 'view.sequence' ? {mode: 'static'} : {})}, `fs-view-${view}`);
      const entryDiff = diffPaths(batch.value?.entry, entryRpc.value, '$.entry');
      const interfacesDiff = diffPaths(batch.value?.interfaces, interfacesRpc.value, '$.interfaces');
      const viewDiff = diffPaths(batch.value?.view_payload, viewRpc.value, '$.view_payload');
      const couplingRpc = await rpc(webBoot, cookieHeader, 'view.coupling', {workspace: WORKSPACE, snapshot: snapshotId, entry: entryId}, `fs-coupling-${view}`);
      const hasAux = batch.value !== null && typeof batch.value === 'object' && Object.prototype.hasOwnProperty.call(batch.value, 'coupling_aux');
      const auxValue = batch.value?.coupling_aux;
      let couplingDiff = [];
      let couplingOk = true;
      if (view === 'coupling') {
        couplingOk = (!hasAux || auxValue === null) && ((batch.value?.sizes?.coupling_aux ?? 0) === 0);
      } else {
        couplingDiff = diffPaths(auxValue, couplingRpc.value, '$.coupling_aux');
        couplingOk = hasAux && auxValue !== null && couplingDiff.length === 0 && (batch.value?.sizes?.coupling_aux ?? 0) > 0;
      }
      const sizes = batch.value?.sizes ?? null;
      const expectedSizes = {
        entry: canonicalSize(batch.value?.entry),
        interfaces: canonicalSize(batch.value?.interfaces),
        view: canonicalSize(batch.value?.view_payload),
        coupling_aux: view === 'coupling' ? 0 : canonicalSize(auxValue),
      };
      const sizesMatch = sizes !== null
        && sizes.entry === expectedSizes.entry
        && sizes.interfaces === expectedSizes.interfaces
        && sizes.view === expectedSizes.view
        && (sizes.coupling_aux ?? 0) === expectedSizes.coupling_aux;
      const sizeSum = sizes === null ? null : (sizes.entry ?? 0) + (sizes.interfaces ?? 0) + (sizes.view ?? 0) + (sizes.coupling_aux ?? 0);
      const budgetOk = sizeSum !== null && sizeSum <= FIRST_SCREEN_LIMIT_BYTES;
      const absolute = [...absolutePaths(batch.text), ...absolutePaths(entryRpc.text), ...absolutePaths(interfacesRpc.text), ...absolutePaths(viewRpc.text), ...absolutePaths(couplingRpc.text)];
      if (absolute.length > 0) rpcNoAbsolute = false;
      const ok = batch.status === 200 && batch.ok === true && entryRpc.ok === true && interfacesRpc.ok === true && viewRpc.ok === true && couplingRpc.ok === true
        && entryDiff.length === 0 && interfacesDiff.length === 0 && viewDiff.length === 0 && couplingOk && sizesMatch && budgetOk && absolute.length === 0;
      if (!ok) rpcConsistency = false;
      if (!couplingOk || !sizesMatch || !budgetOk) rpcCouplingAux = false;
      rpcResults[view] = {
        ok,
        status: batch.status,
        envelope_ok: batch.ok,
        coupling_aux_present: hasAux,
        coupling_aux_value_is_null: auxValue === null,
        sizes,
        sizes_expected: expectedSizes,
        sizes_match: sizesMatch,
        size_sum: sizeSum,
        budget_ok: budgetOk,
        entry_diff: entryDiff,
        interfaces_diff: interfacesDiff,
        view_payload_diff: viewDiff,
        coupling_aux_diff: couplingDiff,
        coupling_aux_ok: couplingOk,
        absolute_paths: absolute,
      };
    }
    report.rpc.batch = rpcResults;
    report.rpc.shell = {status: shell.response.status, cookies: cookies.map((pair) => pair.split('=', 1)[0])};
    record('rpc.batch_vs_individual', rpcConsistency, {views: Object.keys(rpcResults), shell: report.rpc.shell, batch: rpcResults});
    record('rpc.coupling_aux_and_sizes', rpcCouplingAux, {views: Object.keys(rpcResults), batch: rpcResults, note: 'RPC coupling_aux field-equal to view.coupling for view!=coupling; sizes include coupling_aux; sum <= 480 KiB' });
    record('rpc.no_absolute_paths', rpcNoAbsolute, {views: Object.keys(rpcResults)});

    // RPC negatives: unknown view and unknown entry.
    const badView = await rpc(webBoot, cookieHeader, batchEndpoint, {workspace: WORKSPACE, snapshot: snapshotId, entry: entryId, view: 'bogus_view'}, 'fs-bad-view');
    const badEntry = await rpc(webBoot, cookieHeader, batchEndpoint, {workspace: WORKSPACE, snapshot: snapshotId, entry: 'f_unknown_entry_000000000000', view: 'coupling'}, 'fs-bad-entry');
    const badViewCode = badView.parsed?.result?.error?.code ?? badView.value?.error?.code ?? null;
    const badEntryCode = badEntry.parsed?.result?.error?.code ?? badEntry.value?.error?.code ?? null;
    const badViewRejected = badView.status === 200 && ['INVALID_ARGUMENT', 'BAD_ARGUMENT'].includes(badViewCode);
    const badEntryRejected = badEntry.status === 200 && badEntryCode === 'NOT_FOUND';
    record('rpc.negative_cases', badViewRejected && badEntryRejected, {
      bad_view: {status: badView.status, envelope_ok: badView.ok, code: badViewCode}, bad_entry: {status: badEntry.status, envelope_ok: badEntry.ok, code: badEntryCode},
    });
  } finally {
    await webBoot.stop().catch(() => null);
  }

  report.finished_at_utc = new Date().toISOString();
  report.duration_ms = Date.parse(report.finished_at_utc) - Date.parse(report.started_at_utc);
  report.ok = Object.values(report.checks).every((row) => row.ok === true);
  mkdirSync(dirname(OUT_JSON), {recursive: true});
  writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  mkdirSync(dirname(EVIDENCE), {recursive: true});
  writeFileSync(EVIDENCE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ok: report.ok, checks: Object.fromEntries(Object.entries(report.checks).map(([name, row]) => [name, row.ok])), duration_ms: report.duration_ms, evidence: 'evidence/perf/first-screen-consistency.json'}, null, 2)}\n`);
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
