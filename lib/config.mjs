// Trusted configuration resolution for the dsh-code-reader Host plugin.
// No field here comes from the model: the bootstrap file and the Python
// interpreter are deployment facts owned by the human/profile.
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE_DIR = join(PACKAGE_ROOT, 'engine')
const DEFAULT_TIMEOUT_MS = 120_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 600_000
const ALLOWED_KEYS = new Set(['bootstrapPath', 'pythonPath', 'timeoutMs'])

function fail(message) {
  throw new Error(`dsh-code-reader config: ${message}`)
}

export function defaultBootstrapPath(env = process.env) {
  if (env.CODE_READER_BOOTSTRAP) return env.CODE_READER_BOOTSTRAP
  const dshHome = env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'code-reader', 'bootstrap.json')
}

export function resolveSettings(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    fail('row config must be an object')
  }
  for (const key of Object.keys(config)) {
    if (!ALLOWED_KEYS.has(key)) fail(`unknown config field: ${key}`)
  }
  if (config.bootstrapPath !== undefined && (typeof config.bootstrapPath !== 'string' || config.bootstrapPath.length === 0)) {
    fail('bootstrapPath must be a non-empty absolute path string')
  }
  if (config.pythonPath !== undefined && (typeof config.pythonPath !== 'string' || config.pythonPath.length === 0)) {
    fail('pythonPath must be a non-empty path string')
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS
  if (config.timeoutMs !== undefined) {
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < MIN_TIMEOUT_MS || config.timeoutMs > MAX_TIMEOUT_MS) {
      fail(`timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`)
    }
    timeoutMs = config.timeoutMs
  }
  return Object.freeze({
    bootstrapPath: config.bootstrapPath || defaultBootstrapPath(),
    pythonPath: config.pythonPath || process.env.DSH_CODE_READER_PYTHON || undefined,
    timeoutMs,
    packageRoot: PACKAGE_ROOT,
    engineDir: ENGINE_DIR,
  })
}

export { PACKAGE_ROOT, ENGINE_DIR }
