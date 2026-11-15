#!/usr/bin/env node
// Boot/stall/stop helper for the real pinned rc.5 `dsh web` host used by the 04
// read-only slice acceptance. Boots the installed Electron executable in Node
// mode (`ELECTRON_RUN_AS_NODE=1`) against the isolated DSH_HOME profile, waits
// for the one-time `dsh web: <url>` line, and can always kill the process tree.
import {spawn} from 'node:child_process';
import {createWriteStream, mkdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {
  EXECUTABLE,
  DSH_BIN,
} from './host-baseline.mjs';
import {
  HOME_DIR,
  SCRATCH_ROOT,
  isolatedEnv,
  killProcessTree,
  log,
} from './isolated-home.mjs';

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/**
 * Start the isolated web host.
 * @returns {Promise<{url: string, origin: string, child: import('node:child_process').ChildProcess,
 *   stopped: boolean, stdoutPath: string, stderrPath: string, stdout: () => string,
 *   stderr: () => string, stop: () => Promise<void>}>}
 */
export async function startWebServer({python, tag = 'web', home = HOME_DIR, timeoutMs = 120000, extraEnv = {}} = {}) {
  mkdirSync(SCRATCH_ROOT, {recursive: true});
  const stdoutPath = join(SCRATCH_ROOT, `${tag}.out.log`);
  const stderrPath = join(SCRATCH_ROOT, `${tag}.err.log`);
  rmSync(stdoutPath, {force: true});
  rmSync(stderrPath, {force: true});
  let stdout = '';
  let stderr = '';
  const child = spawn(EXECUTABLE, [DSH_BIN, 'web', '--no-open', '--port', '0'], {
    cwd: SCRATCH_ROOT,
    env: isolatedEnv({python, home, extra: {ELECTRON_RUN_AS_NODE: '1', ...extraEnv}}),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const outStream = createWriteStream(stdoutPath, {flags: 'w'});
  const errStream = createWriteStream(stderrPath, {flags: 'w'});
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stdout += text;
    outStream.write(text);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stderr += text;
    errStream.write(text);
  });
  const exited = new Promise((resolvePromise) => child.once('exit', (code, signal) => resolvePromise({code, signal})));
  const handle = {
    child,
    url: null,
    origin: null,
    stdoutPath,
    stderrPath,
    stdout: () => stdout,
    stderr: () => stderr,
    exited,
    stopped: false,
    async stop() {
      if (handle.stopped) return;
      handle.stopped = true;
      if (child.exitCode === null) killProcessTree(child.pid);
      await Promise.race([exited, sleep(15000)]);
      outStream.end();
      errStream.end();
    },
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = /dsh web: (http:\/\/\S+)/.exec(stdout);
    if (match !== null) {
      handle.url = match[1];
      handle.origin = new URL(match[1]).origin;
      log(`${tag}: booted ${handle.url.replace(/token=[^&]+/, 'token=<redacted>')}`);
      return handle;
    }
    if (child.exitCode !== null) break;
    await sleep(250);
  }
  await handle.stop();
  throw new Error(`isolated web boot did not print a URL within ${timeoutMs}ms (stderr: ${stderr.slice(-1200)})`);
}

/** Fetch an HTTP URL and return status/headers/body bytes (no cookie jar). */
export async function httpFetch(url, {method = 'GET', headers = {}, body = undefined, redirect = 'manual', timeoutMs = 30000} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const options = {method, headers, redirect, signal: controller.signal};
    if (body !== undefined) options.body = body;
    const response = await fetch(url, options);
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      url,
      status: response.status,
      headers: Object.fromEntries([...response.headers.entries()]),
      set_cookie: typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [],
      bytes,
      text: bytes.toString('utf8'),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the web shell index, following the rc.5 one-time-token 303 redirect.
 * The token is single use: the first response sets the session cookie and
 * redirects to the shell URL, which is then fetched with that cookie. No cookie
 * is fabricated: only the `Set-Cookie` values the host itself returned are sent
 * back to the same origin.
 */
export async function fetchShell(url, {maxHops = 4} = {}) {
  const cookies = [];
  let current = url;
  let response = await httpFetch(current);
  let hops = 0;
  while (response.status >= 300 && response.status < 400 && hops < maxHops) {
    hops += 1;
    for (const value of response.set_cookie) {
      const pair = value.split(';', 1)[0];
      if (pair.includes('=') && !cookies.some((existing) => existing.split('=', 1)[0] === pair.split('=', 1)[0])) {
        cookies.push(pair);
      }
    }
    const location = response.headers.location ?? '/';
    current = new URL(location, current).href;
    response = await httpFetch(current, {headers: cookies.length === 0 ? {} : {cookie: cookies.join('; ')}});
  }
  return {response, final_url: current, cookies, hops};
}

/**
 * Parse the rc.5 web shell `__DSH_BOOT__` manifest out of index HTML without
 * evaluating page code. Prefers the exact data assignment shape; falls back to
 * a brace-balanced scan after the marker.
 */
export function extractBootManifest(html) {
  const marker = /(?:globalThis\s*\[\s*"__DSH_BOOT__"\s*\]|globalThis\s*\.\s*__DSH_BOOT__|window\s*\.\s*__DSH_BOOT__)\s*=\s*/g.exec(html);
  if (marker === null) throw new Error('__DSH_BOOT__ assignment not found in index HTML');
  const start = marker.index + marker[0].length;
  if (html[start] !== '{') throw new Error(`__DSH_BOOT__ value does not start with an object (found ${JSON.stringify(html.slice(start, start + 40))})`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(start, index + 1));
    }
  }
  throw new Error('__DSH_BOOT__ object is not brace-balanced');
}
