#!/usr/bin/env node
// Isolated DSH profile + code-reading bootstrap bootstrap for the 04 read-only
// slice acceptance.
//
// Builds a throw-away runtime tree under `<repo>/scratch/readonly-home`:
//   home/profiles/web/package.json      profile bundles (base + web-app + 04)
//   home/profiles/web/node_modules/@local/dsh-code-reader -> repo (junction)
//   home/profiles/web/cordis.patch.yml  empty (no extra patch)
//   home/code-reader/bootstrap.json     isolated BootstrapConfigV1
//   home/code-reader/state | output     isolated engine state/output
//
// The user's real DSH_HOME (%USERPROFILE%/.dsh) is never read or written: the
// isolated home is the only DSH_HOME passed to every spawned child. The slice
// data (workspace manifest + Atlas snapshot) is consumed from
// `evidence/code-view-slice/inbox` as a trusted Lead-provided input; the
// engine's state/output are copies under the isolated home.
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCRATCH_ROOT = join(REPO_ROOT, 'scratch', 'readonly-home');
export const HOME_DIR = join(SCRATCH_ROOT, 'home');
export const PROFILE_DIR = join(HOME_DIR, 'profiles', 'web');
export const BOOTSTRAP_PATH = join(HOME_DIR, 'code-reader', 'bootstrap.json');
export const EVIDENCE_DIR = join(REPO_ROOT, 'evidence', 'readonly-slice');
export const SLICE_DIR = join(REPO_ROOT, 'evidence', 'code-view-slice');
export const INBOX_DIR = join(SLICE_DIR, 'inbox');
export const ENGINE_DIR = join(REPO_ROOT, 'engine');
export const WORKSPACE_ID = 'code-view-bus-demo';
export const VARIANT_ID = 'semantic-x86_64';
export const REPO_ID = 'bus';
export const PROFILE_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@local/dsh-code-reader',
]);
export const PYTHON_CANDIDATES = Object.freeze([
  process.env.DSH_CODE_READER_PYTHON,
  process.env.CODE_READER_PYTHON,
  'E:/Anaconda-main/python.exe',
  'python',
  'python3',
].filter((value) => typeof value === 'string' && value.length > 0));

export function log(message) {
  process.stderr.write(`[readonly-slice] ${message}\n`);
}

export function writeJsonFile(path, value) {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

/** Keep the scratch tree invisible to `git status` without touching repo files. */
export function ensureScratchGitignore() {
  const scratch = join(REPO_ROOT, 'scratch');
  mkdirSync(scratch, {recursive: true});
  const ignore = join(scratch, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n', 'utf8');
}

/** Remove the whole scratch tree. Refuses to clean outside <repo>/scratch. */
export function wipeScratch() {
  const normalized = resolve(SCRATCH_ROOT);
  const allowedRoot = resolve(join(REPO_ROOT, 'scratch'));
  if (!normalized.startsWith(`${allowedRoot}\\`) && !normalized.startsWith(`${allowedRoot}/`)) {
    throw new Error(`refusing to clean outside <repo>/scratch: ${normalized}`);
  }
  rmSync(normalized, {recursive: true, force: true});
}

/** Resolve a Python 3.11+ interpreter (the engine baseline). */
export function resolvePython() {
  const tried = [];
  for (const candidate of PYTHON_CANDIDATES) {
    tried.push(candidate);
    const isPath = isAbsolute(candidate) || /[\\/]/.test(candidate);
    if (isPath && !existsSync(candidate)) continue;
    const result = spawnSync(candidate, ['--version'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 20000,
    });
    const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const match = /Python (\d+)\.(\d+)\.(\d+)/.exec(text);
    if (result.status === 0 && match !== null && Number(match[1]) === 3 && Number(match[2]) >= 11) {
      return {
        command: candidate,
        version: `${match[1]}.${match[2]}.${match[3]}`,
        directory: isPath ? dirname(resolve(candidate)) : null,
      };
    }
  }
  throw new Error(`no usable Python 3.11+ interpreter found (tried: ${tried.join(', ')})`);
}

/** Windows PATH value that puts the engine interpreter first. */
export function pathWithPython(python, base = process.env.PATH ?? '') {
  const parts = (base ?? '').split(';').filter((part) => part.length > 0);
  if (python.directory !== null && !parts.some((part) => resolve(part).toLowerCase() === resolve(python.directory).toLowerCase())) {
    parts.unshift(python.directory);
  }
  return parts.join(';');
}

/**
 * Environment for every isolated child process (web host, node test runner,
 * Python engine). Keeps the OS-minimal variables and points DSH_HOME at the
 * isolated home only.
 */
export function isolatedEnv({python, home = HOME_DIR, extra = {}} = {}) {
  const env = {
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    WINDIR: process.env.WINDIR ?? 'C:\\Windows',
    COMSPEC: process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe',
    PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    PATH: pathWithPython(python),
    DSH_HOME: home,
    CODE_READER_BOOTSTRAP: join(home, 'code-reader', 'bootstrap.json'),
    DSH_TELEMETRY_DISABLED: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONNOUSERSITE: '1',
    ...extra,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
}

function runCommand(command, args, {cwd, env, timeoutMs = 120000} = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    env,
    windowsHide: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    command,
    args,
    cwd,
    exit_code: result.status,
    signal: result.signal ?? null,
    timed_out: result.error?.code === 'ETIMEDOUT',
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    duration_ms: Date.now() - started,
    ok: result.status === 0,
  };
}

function parseSingleJson(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Run the engine CLI under the isolated bootstrap; always returns a record. */
export function runEngineCli({python, args, bootstrapPath = BOOTSTRAP_PATH, timeoutMs = 180000, env} = {}) {
  const result = runCommand(python.command, ['-m', 'code_learning.cli', '--bootstrap', bootstrapPath, ...args], {
    cwd: ENGINE_DIR,
    env: env ?? isolatedEnv({python}),
    timeoutMs,
  });
  return {
    argv: ['-m', 'code_learning.cli', '--bootstrap', bootstrapPath, ...args],
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    stdout_json: parseSingleJson(result.stdout),
    stdout_tail: result.stdout.length > 4000 ? result.stdout.slice(result.stdout.length - 4000) : result.stdout,
    stderr_tail: result.stderr.length > 4000 ? result.stderr.slice(result.stderr.length - 4000) : result.stderr,
    ok: result.ok && parseSingleJson(result.stdout) !== null,
  };
}

/** Read the Lead-provided slice data facts (workspace manifest + snapshot dir). */
export function readSliceData() {
  const missing = [];
  const workspaceFile = join(INBOX_DIR, 'workspace.json');
  if (!existsSync(workspaceFile)) missing.push('evidence/code-view-slice/inbox/workspace.json');
  let workspaceManifest = null;
  if (existsSync(workspaceFile)) {
    try {
      workspaceManifest = readJsonFile(workspaceFile);
    } catch (error) {
      missing.push(`unreadable workspace.json (${error.message})`);
    }
  }
  const snapshotCandidates = [];
  if (existsSync(INBOX_DIR)) {
    for (const entry of readdirSync(INBOX_DIR, {withFileTypes: true})) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const dir = join(INBOX_DIR, entry.name);
      if (existsSync(join(dir, 'graph.json')) && existsSync(join(dir, 'analysis_manifest.json'))) {
        snapshotCandidates.push(entry.name);
      }
    }
  }
  if (snapshotCandidates.length === 0) missing.push('evidence/code-view-slice/inbox/<snapshot>/graph.json + analysis_manifest.json');
  snapshotCandidates.sort((left, right) => {
    if (left === 'snapshot-bus') return -1;
    if (right === 'snapshot-bus') return 1;
    return left.localeCompare(right);
  });
  return {
    workspace_file: workspaceFile,
    workspace_manifest: workspaceManifest,
    inbox_dir: INBOX_DIR,
    snapshot_dir_name: snapshotCandidates[0] ?? null,
    snapshot_candidates: snapshotCandidates,
    missing,
    data_ready: missing.length === 0,
  };
}

/**
 * Inspect the snapshot graph for the acceptance target (first function by
 * definition evidence start with name `bus_send`) so probes/assertions use the
 * actual line rather than a hard-coded one.
 */
export function inspectSnapshot({snapshotDirName = null} = {}) {
  const slice = readSliceData();
  const name = snapshotDirName ?? slice.snapshot_dir_name;
  if (name === null) return {ok: false, reason: 'no snapshot directory in the inbox', slice};
  const dir = join(INBOX_DIR, name);
  const graphPath = join(dir, 'graph.json');
  const manifestPath = join(dir, 'analysis_manifest.json');
  const raw = readFileSync(graphPath);
  const graph = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
  const manifest = readJsonFile(manifestPath);
  const payload = graph.payload ?? {};
  const functions = Array.isArray(payload.functions) ? payload.functions : [];
  const evidenceById = new Map((payload.evidence ?? []).map((row) => [row.id, row]));
  const target = functions.find((fn) => fn.name === 'bus_send') ?? null;
  let definitionEvidence = null;
  if (target !== null) {
    const rows = (target.evidence_ids ?? [])
      .map((id) => evidenceById.get(id))
      .filter((row) => row !== undefined)
      .sort((left, right) => Number(left.start) - Number(right.start));
    definitionEvidence = rows[0] ?? null;
  }
  const repoRoot = join(SLICE_DIR, 'repo');
  const relFile = definitionEvidence === null
    ? null
    : definitionEvidence.file.replace(/\\/g, '/').replace(`${repoRoot.replace(/\\/g, '/')}/`, '');
  return {
    ok: definitionEvidence !== null,
    snapshot_dir_name: name,
    snapshot_id: manifest?.payload?.snapshot_id ?? null,
    graph_sha256: manifest?.payload?.graph_hash ?? null,
    graph_bytes: raw.length,
    entry_count: functions.length,
    target: target === null
      ? null
      : {
          entry_id: target.id ?? null,
          symbol_id: target.base_id ?? null,
          name: target.name,
          display_name: target.display_name ?? null,
          signature: target.signature ?? null,
          file: relFile,
          line: definitionEvidence === null ? null : Number(definitionEvidence.line),
          byte_start: definitionEvidence === null ? null : Number(definitionEvidence.start),
          byte_end: definitionEvidence === null ? null : Number(definitionEvidence.end),
        },
    slice,
  };
}

/**
 * Build the isolated home/profile/bootstrap and (when the Lead data is ready)
 * import the workspace + snapshot through the real engine CLI.
 */
export function prepareIsolatedHome({wipe = true, importData = true, quiet = false} = {}) {
  const say = quiet ? () => {} : log;
  ensureScratchGitignore();
  if (wipe) {
    say(`wiping isolated scratch ${SCRATCH_ROOT}`);
    wipeScratch();
  }
  const python = resolvePython();
  mkdirSync(join(PROFILE_DIR, 'node_modules', '@local'), {recursive: true});
  mkdirSync(join(HOME_DIR, 'code-reader', 'state'), {recursive: true});
  mkdirSync(join(HOME_DIR, 'code-reader', 'output'), {recursive: true});

  const linkPath = join(PROFILE_DIR, 'node_modules', '@local', 'dsh-code-reader');
  rmSync(linkPath, {recursive: true, force: true});
  symlinkSync(REPO_ROOT, linkPath, 'junction');

  writeJsonFile(join(PROFILE_DIR, 'package.json'), {
    name: 'dsh-profile-web',
    private: true,
    description: 'Isolated verifier profile for the 04 read-only workbench slice (never the user profile).',
    dependencies: {'@local/dsh-code-reader': `file:${REPO_ROOT.replace(/\\/g, '/')}`},
    dsh: {profile: {bundles: [...PROFILE_BUNDLES]}},
  });
  writeFileSync(join(PROFILE_DIR, 'cordis.patch.yml'), '[]\n', 'utf8');
  writeJsonFile(BOOTSTRAP_PATH, {
    schema_version: 1,
    profile_ref: 'desktop',
    scope_ref: 'local',
    scope_generation: 1,
    state_dir: join(HOME_DIR, 'code-reader', 'state'),
    import_inbox_dir: INBOX_DIR,
    output_root: join(HOME_DIR, 'code-reader', 'output'),
    candidate_roots: [
      {
        root_ref: 'slice-root',
        absolute_path: SLICE_DIR,
        read_grant_ref: 'grant-slice',
      },
    ],
  });

  const slice = readSliceData();
  const imports = {workspace: null, snapshot: null, skipped: null};
  let snapshot = null;
  if (!slice.data_ready) {
    imports.skipped = {reason: 'Lead slice data is not ready', missing: slice.missing};
    say(`slice data not ready; skipping engine imports (missing: ${slice.missing.join(', ')})`);
  } else if (!importData) {
    imports.skipped = {reason: 'importData=false'};
  } else {
    const workspaceArgs = [
      'workspace-import',
      '--manifest', 'workspace.json',
      '--expected-revision', '0',
      '--operation-id', crypto.randomUUID(),
    ];
    imports.workspace = runEngineCli({python, args: workspaceArgs});
    say(`workspace-import exit=${imports.workspace.exit_code}`);
    if (imports.workspace.ok) {
      snapshot = inspectSnapshot({snapshotDirName: slice.snapshot_dir_name});
      const snapshotArgs = [
        'snapshot-import',
        '--workspace', WORKSPACE_ID,
        '--variant', VARIANT_ID,
        '--repo', REPO_ID,
        '--snapshot', slice.snapshot_dir_name,
        '--operation-id', crypto.randomUUID(),
      ];
      imports.snapshot = runEngineCli({python, args: snapshotArgs});
      say(`snapshot-import exit=${imports.snapshot.exit_code}`);
    }
  }

  return {
    home: HOME_DIR,
    profile_dir: PROFILE_DIR,
    bootstrap_path: BOOTSTRAP_PATH,
    repo_root: REPO_ROOT,
    python,
    bundles: [...PROFILE_BUNDLES],
    slice,
    imports,
    snapshot,
    data_ready: slice.data_ready,
  };
}

/** Spawn a child with the isolated environment and always kill its tree. */
export function runIsolated(command, args, {python, cwd = REPO_ROOT, timeoutMs = 180000, env = {}} = {}) {
  return runCommand(command, args, {
    cwd,
    env: isolatedEnv({python, extra: env}),
    timeoutMs,
  });
}

export function killProcessTree(pid) {
  if (typeof pid !== 'number' || pid <= 0) return;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {windowsHide: true, encoding: 'utf8', timeout: 20000});
  } catch {
    // process already gone
  }
}

export {runCommand, parseSingleJson};
