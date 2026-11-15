#!/usr/bin/env node
// Pinned-host gate for the 04 read-only slice acceptance.
//
// Verifies machine facts that every later layer depends on, before anything is
// booted or imported:
//   * `DeepSeek Harness.exe` SHA256,
//   * `resources/app.asar` SHA256,
//   * archived `@deepseek-ai/dsh` package version,
//   * presence, digest and one literal marker of the reviewed rc.5 seam files
//     the boot-graph / sidebar / admission acceptance relies on.
//
// Values are fixed deployment facts (Lead re-checked 2026-11-15); this tool
// never downloads, never executes archive content and never writes.
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  DEFAULT_ARCHIVE,
  DEFAULT_EXECUTABLE,
  HOST_ROOT,
  openArchive,
  sha256File,
} from './asar.mjs';

export const HOST_BASELINE = Object.freeze({
  executable_path: DEFAULT_EXECUTABLE,
  executable_sha256: '7ae939b5a82b220fbd8ad04dfbafaaedb5a49ab43dc884a5db6381f678dd0cc4',
  archive_path: DEFAULT_ARCHIVE,
  archive_sha256: 'e1b6f25fa937da98086c3e77af77aa14791105963c4d337a1c42179d232c6915',
  dsh_version: '0.2.1-rc.5',
  embedded_node: '24.21.0',
  electron: '44.7.0',
});

/** Executable + archive used to spawn the real rc.5 host and the render probe. */
export const EXECUTABLE = DEFAULT_EXECUTABLE;
export const ARCHIVE = DEFAULT_ARCHIVE;
export const DSH_BIN = `${HOST_ROOT}/node_modules/@deepseek-ai/dsh/lib/bin.js`;
export const CORDIS_ENTRY = `${HOST_ROOT}/node_modules/@deepseek-ai/cordis/lib/index.js`;
export const RENDER_PROBE_ELECTRON =
  process.env.DSH_ELECTRON_BIN ?? 'C:/Users/admin/.dsh/electron/electron.exe';

// Reviewed seam files inside the pinned archive (the rc.5 seam matrix). Each
// row is a bytes digest + literal marker check: enough to prove the reviewed
// build did not change under this acceptance, not a semantic audit.
const SEAM_FILES = Object.freeze([
  {
    path: 'dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js',
    markers: ['__ModuleLoader__', '.load('],
    why: 'client loader facade used by bundle/client.js',
  },
  {
    path: 'dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js',
    markers: ['dsh.client'],
    why: 'Host half that scans dsh.client and builds __DSH_BOOT__',
  },
  {
    path: 'dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js',
    markers: ['selectPanel'],
    why: 'keyed main panel + layout.selectPanel(null) return-to-chat seam',
  },
  {
    path: 'dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js',
    markers: ['sidebar.panellist'],
    why: 'sidebar.panellist row registration seam',
  },
  {
    path: 'dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js',
    markers: ['admit'],
    why: 'connection.admit(request) browser-session admission seam',
  },
  {
    path: 'dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js',
    markers: ['register'],
    why: 'webServer.register({kind,path,handler}) route seam',
  },
]);

/**
 * Verify the pinned host facts. Returns a structured report; callers decide
 * whether a `false` row is fatal for their layer.
 */
export function verifyHostBaseline({executable = EXECUTABLE, archive = ARCHIVE} = {}) {
  const checks = [];
  const push = (name, ok, detail = {}) => checks.push({name, ok: ok === true, detail});

  push('executable.exists', existsSync(executable), {path: executable});
  let executableSha = null;
  try {
    executableSha = sha256File(executable);
    push('executable.sha256', executableSha === HOST_BASELINE.executable_sha256, {
      expected: HOST_BASELINE.executable_sha256,
      actual: executableSha,
    });
  } catch (error) {
    push('executable.readable', false, {error: String(error.message ?? error)});
  }

  push('archive.exists', existsSync(archive), {path: archive});
  let archiveSha = null;
  try {
    archiveSha = sha256File(archive);
    push('archive.sha256', archiveSha === HOST_BASELINE.archive_sha256, {
      expected: HOST_BASELINE.archive_sha256,
      actual: archiveSha,
    });
  } catch (error) {
    push('archive.readable', false, {error: String(error.message ?? error)});
  }

  let asar = null;
  try {
    asar = openArchive(archive);
    push('archive.header', true, {header_size: asar.headerSize, archive_size: asar.archiveSize});
  } catch (error) {
    push('archive.header', false, {error: String(error.message ?? error)});
  }

  let dshVersion = null;
  if (asar !== null) {
    try {
      const manifest = asar.readJson('dsh/node_modules/@deepseek-ai/dsh/package.json');
      dshVersion = manifest.version ?? null;
      push('archive.dsh_version', dshVersion === HOST_BASELINE.dsh_version, {
        expected: HOST_BASELINE.dsh_version,
        actual: dshVersion,
        name: manifest.name ?? null,
      });
    } catch (error) {
      push('archive.dsh_version', false, {error: String(error.message ?? error)});
    }
    for (const seam of SEAM_FILES) {
      try {
        const bytes = asar.read(seam.path);
        const text = bytes.toString('utf8');
        const missing = seam.markers.filter((marker) => !text.includes(marker));
        push(`seam:${seam.path}`, missing.length === 0, {
          why: seam.why,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          missing_markers: missing,
        });
      } catch (error) {
        push(`seam:${seam.path}`, false, {why: seam.why, error: String(error.message ?? error)});
      }
    }
  }

  return {
    ok: checks.every((check) => check.ok === true),
    baseline: HOST_BASELINE,
    executable: {path: executable, sha256: executableSha},
    archive: {path: archive, sha256: archiveSha, dsh_version: dshVersion},
    checks,
  };
}

// --- CLI -------------------------------------------------------------------
function main() {
  const report = verifyHostBaseline();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
