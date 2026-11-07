// Thin, fixed-argv bridge from the DSH Host plugin to the local Python engine.
// The model never supplies an executable, a cwd, an environment variable or a
// bootstrap path: all of those come from trusted plugin configuration.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const MAX_STDOUT_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 1024 * 1024
const PROBE_TIMEOUT_MS = 5_000
const MAX_CAPTURED_CHARS = 4_000

export class BridgeError extends Error {
  constructor(code, message, { retryable = false, exitCode = 0 } = {}) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.retryable = retryable
    this.exitCode = exitCode
  }

  asValue() {
    return {
      schema_version: 1,
      ok: false,
      exit_code: this.exitCode,
      cli: null,
      error: { code: this.code, message: this.message, details_ref: null, retryable: this.retryable },
    }
  }
}

function tail(text, limit = MAX_CAPTURED_CHARS) {
  const value = String(text ?? '')
  return value.length > limit ? value.slice(value.length - limit) : value
}

function runProcess(command, args, { cwd, env, timeoutMs, signal, maxStdout = MAX_STDOUT_BYTES, maxStderr = MAX_STDERR_BYTES }) {
  return new Promise((resolve) => {
    let settled = false
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let timer = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    let child
    try {
      child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({ exitCode: null, timedOut: false, spawnError: error, stdout: '', stderr: '' })
      return
    }
    const onAbort = () => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish({ exitCode: 4, aborted: true, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') })
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (timeoutMs) {
      timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        finish({ exitCode: 4, timedOut: true, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') })
      }, timeoutMs)
    }
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < maxStdout) stdout = Buffer.concat([stdout, chunk])
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < maxStderr) stderr = Buffer.concat([stderr, chunk])
    })
    child.on('error', (error) => {
      finish({ exitCode: null, timedOut: false, spawnError: error, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') })
    })
    child.on('close', (code) => {
      finish({ exitCode: code, timedOut: false, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') })
    })
  })
}

export function parseCliDocument(stdout) {
  const text = String(stdout ?? '').trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function bridgeEnv(env = process.env) {
  const filtered = {}
  const allowed = new Set([
    'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC',
    'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'PYTHONIOENCODING', 'PYTHONUTF8',
    'DSH_HOME', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_CODE_READER_PYTHON',
    'NUMBER_OF_PROCESSORS', 'OS', 'PROCESSOR_ARCHITECTURE'
  ])
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && allowed.has(key)) filtered[key] = value
  }
  filtered.PYTHONIOENCODING = 'utf-8'
  filtered.PYTHONUTF8 = '1'
  filtered.PYTHONNOUSERSITE = '1'
  return filtered
}

export function createBridge(settings, { env = process.env, spawnImpl = runProcess } = {}) {
  const pythonCandidates = settings.pythonPath ? [settings.pythonPath] : ['python3', 'python']
  const environment = bridgeEnv({ ...env, ...(settings.pythonPath ? {} : {}) })
  let resolvedPython
  let dispatchSerial = Promise.resolve()

  async function probe(candidate, signal) {
    const result = await spawnImpl(candidate, ['--version'], {
      cwd: settings.engineDir,
      env: environment,
      timeoutMs: PROBE_TIMEOUT_MS,
      signal,
      maxStdout: 64 * 1024,
      maxStderr: 64 * 1024,
    })
    if (result.spawnError || result.timedOut || result.aborted) return false
    if (result.exitCode !== 0) return false
    const match = /Python\s+3\.(\d+)/.exec(`${result.stdout}\n${result.stderr}`)
    // The engine targets Python 3.11+ (stdlib sqlite3/typing baseline); an
    // older 3.x passes `--version` but must not be selected.
    return match !== null && Number(match[1]) >= 11
  }

  async function resolvePython(signal) {
    if (resolvedPython) return resolvedPython
    const tried = []
    for (const candidate of pythonCandidates) {
      tried.push(candidate)
      if (await probe(candidate, signal)) {
        resolvedPython = candidate
        return resolvedPython
      }
    }
    throw new BridgeError(
      'DEPENDENCY_UNAVAILABLE',
      `no usable Python 3.11+ interpreter found (tried: ${tried.join(', ')}); set DSH_CODE_READER_PYTHON or plugin config pythonPath`,
    )
  }

  async function execute(args, { signal, timeoutMs = settings.timeoutMs } = {}) {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new BridgeError('INVALID_ARGUMENT', 'bridge argv must be an array of strings')
    }
    const python = await resolvePython(signal)
    const argv = ['-m', 'code_learning.cli', '--bootstrap', settings.bootstrapPath, ...args]
    const result = await spawnImpl(python, argv, {
      cwd: settings.engineDir,
      env: environment,
      timeoutMs,
      signal,
    })
    if (result.spawnError) {
      const detail = result.spawnError.code === 'ENOENT' ? 'interpreter disappeared after resolution' : result.spawnError.message
      throw new BridgeError('DEPENDENCY_UNAVAILABLE', `Python engine could not start: ${detail}`)
    }
    if (result.timedOut) {
      throw new BridgeError('OUTCOME_UNKNOWN', `Python engine exceeded timeoutMs=${timeoutMs}; outcome unknown`, { retryable: true, exitCode: 4 })
    }
    if (result.aborted) {
      throw new BridgeError('OUTCOME_UNKNOWN', 'tool call was cancelled; Python engine outcome unknown', { exitCode: 4 })
    }
    const payload = parseCliDocument(result.stdout)
    if (payload === null) {
      if (result.exitCode === 0) {
        throw new BridgeError('INTERNAL_ERROR', `Python engine returned non-JSON stdout: ${tail(result.stdout, 400)}`)
      }
      return {
        schema_version: 1,
        ok: false,
        exit_code: typeof result.exitCode === 'number' ? result.exitCode : 3,
        cli: null,
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'Python engine failed without a JSON result',
          details_ref: null,
          retryable: false,
          stderr_tail: tail(result.stderr),
        },
      }
    }
    return {
      schema_version: 1,
      ok: result.exitCode === 0,
      exit_code: typeof result.exitCode === 'number' ? result.exitCode : 3,
      cli: payload,
    }
  }

  // One intent at a time per session keeps reserve/execute ordering simple and
  // avoids two long CLI calls racing over the same local sqlite writer.
  async function serialized(args, options) {
    const previous = dispatchSerial
    let release
    dispatchSerial = new Promise((resolveRelease) => {
      release = resolveRelease
    })
    await previous
    try {
      return await execute(args, options)
    } finally {
      release()
    }
  }

  return Object.freeze({
    settings,
    resolvePython,
    execute: serialized,
    newOperationId: () => randomUUID(),
  })
}
