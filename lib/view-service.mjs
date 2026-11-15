// dsh-code-reader: read-model service behind the read-only code view.
//
// The service turns strictly validated browser payloads into fixed engine CLI
// argv (docs/readonly-workbench-contract.md §4.2/§5, docs/five-view-contract.md
// §2 for the five views and §10 for the S2b increments) and normalizes the
// result into the frozen RPC result shape:
//
//   - engine stdout JSON, including an engine `ok:false`/error document, is a
//     successful RPC payload: {ok:true, value:<engine JSON>};
//   - BridgeError is a host/bridge failure: {ok:false, error:{code, message}}
//     with stable, path-free codes (BRIDGE_UNAVAILABLE / OUTCOME_UNKNOWN /
//     INVALID_ARGUMENT / ENGINE_BLOCKED / ENGINE_FAILED);
//   - input validation failures never reach the engine.
//
// `view.status` never starts the engine and stays 200/ok:true even when Python
// or the bootstrap file is missing; the missing pieces are reported through
// `engine` and `gaps` so the UI can show the actual reason.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { BridgeError } from './bridge.mjs'

export const VIEW_ENDPOINTS = Object.freeze([
  // read-only workbench slice (CL-VIEW-T1)
  'view.status',
  'view.listSnapshots',
  'view.listEntries',
  'view.getEntry',
  // S2a five views (CL-VIEW-T2)
  'view.coupling',
  'view.tree',
  'view.endToEnd',
  'view.fileTree',
  'view.fileRead',
  'view.sequence',
  // S2b increments (§10)
  'view.interfaces',
])

const PLUGIN_NAME = 'dsh-code-reader'
const PACKAGE_NAME = '@local/dsh-code-reader'
const PANEL_KEY = 'dsh-code-reader'
const RPC_CHANNEL = '/code-view'
const FALLBACK_VERSION = '0.0.0'

const WORKSPACE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const WORKSPACE_MAX = 128
const SNAPSHOT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SNAPSHOT_MAX = 128
const ENTRY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/
const ENTRY_MAX = 512
const REPO_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const REPO_MAX = 128
const PATH_MAX = 512
const MAX_LINES_MIN = 1
const MAX_LINES_MAX = 2000
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const SEQUENCE_MODE = 'static'
const SAFE_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

// Boolean semantics: "the view is available in this stage". S2a adds the five
// views; S2b adds group collapse, the interface library and sub-flow
// breadcrumbs; the rest stay false until later stages.
const CAPABILITIES = Object.freeze({
  readonly_workbench: true,
  five_views: true,
  resource_graph: true,
  group_collapse: true,
  interface_library: true,
  subflow_breadcrumb: true,
  scenario_execution: false,
  run_observation: false,
  ai_summary: false,
})

// Capabilities this stage deliberately does not provide. Codes match the false
// capability flags; reasons stay verbatim for the UI gap rows. S2a/S2b
// capabilities (five views/resource graph, group collapse, interface library,
// breadcrumbs) are implemented and therefore not gaps.
const SLICE_GAPS = Object.freeze([
  Object.freeze({ code: 'scenario_execution', status: 'unavailable', reason: '本轮只读切片；场景执行/打桩/回退未实现' }),
  Object.freeze({ code: 'run_observation', status: 'unavailable', reason: '本切片无运行观测；运行记录/事件未接入' }),
  Object.freeze({ code: 'ai_summary', status: 'unavailable', reason: '无模型出口，仅占位；AI 归纳正文未实现' }),
])

// Stable client-safe messages. BridgeError text is never forwarded: it can
// contain interpreter paths or captured engine stdout.
const SAFE_MESSAGES = Object.freeze({
  BRIDGE_UNAVAILABLE: 'local Python engine is unavailable (no usable Python 3.11+ interpreter, or the engine failed to start)',
  OUTCOME_UNKNOWN: 'engine outcome unknown (timeout or cancellation); retry may be required',
  ENGINE_BLOCKED: 'engine blocked the request (invalid arguments, scope or missing capability)',
  ENGINE_FAILED: 'engine failed without a usable JSON result',
})

const BRIDGE_ERROR_CODES = Object.freeze({
  DEPENDENCY_UNAVAILABLE: 'BRIDGE_UNAVAILABLE',
  OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INTERNAL_ERROR: 'ENGINE_FAILED',
})

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message) {
  throw new BridgeError('INVALID_ARGUMENT', message)
}

function safeFieldName(key) {
  return typeof key === 'string' && SAFE_FIELD_NAME.test(key) ? key : 'unnamed'
}

/** Reject non-object payloads and unknown fields; `undefined` means `{}`. */
function validatePayload(payload, allowedKeys) {
  const body = payload === undefined ? {} : payload
  if (!isRecord(body)) invalid('payload must be a JSON object')
  for (const key of Object.keys(body)) {
    if (!allowedKeys.includes(key)) invalid(`unknown payload field: ${safeFieldName(key)}`)
  }
  return body
}

function requireStringField(body, name, { max, pattern, description }) {
  if (!Object.hasOwn(body, name)) invalid(`${name} is required`)
  const value = body[name]
  if (typeof value !== 'string') invalid(`${name} must be a string`)
  if (value.length === 0 || value.length > max) {
    invalid(`${name} must be a non-empty string of at most ${max} characters`)
  }
  if (!pattern.test(value)) invalid(`${name} must match ${description}`)
  return value
}

function requireWorkspaceField(body) {
  return requireStringField(body, 'workspace', {
    max: WORKSPACE_MAX,
    pattern: WORKSPACE_PATTERN,
    description: '^[a-z0-9][a-z0-9._-]{0,63}$',
  })
}

function requireSnapshotField(body) {
  return requireStringField(body, 'snapshot', {
    max: SNAPSHOT_MAX,
    pattern: SNAPSHOT_PATTERN,
    description: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
  })
}

function requireEntryField(body) {
  return requireStringField(body, 'entry', {
    max: ENTRY_MAX,
    pattern: ENTRY_PATTERN,
    description: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$',
  })
}

function requireRepoField(body) {
  return requireStringField(body, 'repo', {
    max: REPO_MAX,
    pattern: REPO_PATTERN,
    description: '^[a-z0-9][a-z0-9._-]{0,63}$',
  })
}

/** `null` is tolerated as "no entry" so the client can pass an unselected value. */
function optionalEntryField(body) {
  if (!Object.hasOwn(body, 'entry') || body.entry === null) return undefined
  return requireEntryField(body)
}

/**
 * Optional S2b sub-flow root (`view.endToEnd root`): same bounded entry-id shape
 * as `entry`; absent/`null` means "no sub-flow root".
 */
function optionalRootField(body) {
  if (!Object.hasOwn(body, 'root') || body.root === null) return undefined
  return requireStringField(body, 'root', {
    max: ENTRY_MAX,
    pattern: ENTRY_PATTERN,
    description: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$',
  })
}

/**
 * Repository-relative POSIX path only: no absolute paths, backslashes, control
 * characters, empty/"."/".." segments, and at most 512 characters.
 */
function requireRepoPathField(body) {
  if (!Object.hasOwn(body, 'path')) invalid('path is required')
  const value = body.path
  if (typeof value !== 'string') invalid('path must be a string')
  if (value.length === 0 || value.length > PATH_MAX) {
    invalid(`path must be a non-empty string of at most ${PATH_MAX} characters`)
  }
  if (CONTROL_CHARS.test(value)) invalid('path must not contain control characters')
  if (value.includes('\\')) invalid('path must use POSIX separators (backslash is not allowed)')
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    invalid('path must be repository-relative (absolute paths are not allowed)')
  }
  const segments = value.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    invalid('path must not contain empty, "." or ".." segments')
  }
  return value
}

/** Optional 1..2000 read window; `null`/absent means "engine default". */
function optionalMaxLinesField(body) {
  if (!Object.hasOwn(body, 'max_lines') || body.max_lines === null) return undefined
  const value = body.max_lines
  if (!Number.isInteger(value)) invalid('max_lines must be an integer')
  if (value < MAX_LINES_MIN || value > MAX_LINES_MAX) {
    invalid(`max_lines must be an integer in ${MAX_LINES_MIN}..${MAX_LINES_MAX}`)
  }
  return value
}

/** S2a has exactly one prediction mode; absent/null defaults to "static". */
function sequenceModeField(body) {
  if (!Object.hasOwn(body, 'mode') || body.mode === null) return SEQUENCE_MODE
  if (body.mode !== SEQUENCE_MODE) {
    invalid(`mode must be '${SEQUENCE_MODE}' (this slice only provides static prediction)`)
  }
  return SEQUENCE_MODE
}

function readPackageFacts(settings) {
  const packageRoot = typeof settings?.packageRoot === 'string' ? settings.packageRoot : ''
  if (packageRoot !== '') {
    try {
      const parsed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
      if (isRecord(parsed)) {
        const name = typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : PACKAGE_NAME
        const version = typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : FALLBACK_VERSION
        return { name, version }
      }
    } catch {
      /* fall through to the fixed identity */
    }
  }
  return { name: PACKAGE_NAME, version: FALLBACK_VERSION }
}

function bootstrapExists(bootstrapPath) {
  return typeof bootstrapPath === 'string' && bootstrapPath.length > 0 && existsSync(bootstrapPath)
}

async function probePython(bridge, signal) {
  if (typeof bridge?.resolvePython !== 'function') return 'missing'
  try {
    await bridge.resolvePython(signal)
    return 'available'
  } catch {
    return 'missing'
  }
}

function bridgeFailureResult(result) {
  const bridgeCode = isRecord(result) && isRecord(result.error) ? result.error.code : undefined
  if (bridgeCode === 'DEPENDENCY_UNAVAILABLE') {
    return { ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: SAFE_MESSAGES.BRIDGE_UNAVAILABLE } }
  }
  const exitCode = isRecord(result) ? result.exit_code : undefined
  if (exitCode === 2) return { ok: false, error: { code: 'ENGINE_BLOCKED', message: SAFE_MESSAGES.ENGINE_BLOCKED } }
  if (exitCode === 4) return { ok: false, error: { code: 'OUTCOME_UNKNOWN', message: SAFE_MESSAGES.OUTCOME_UNKNOWN } }
  return { ok: false, error: { code: 'ENGINE_FAILED', message: SAFE_MESSAGES.ENGINE_FAILED } }
}

function bridgeErrorResult(error) {
  if (!(error instanceof BridgeError)) throw error
  const code = BRIDGE_ERROR_CODES[error.code] ?? 'ENGINE_FAILED'
  const message = code === 'INVALID_ARGUMENT' ? error.message : SAFE_MESSAGES[code]
  return { ok: false, error: { code, message } }
}

/**
 * Endpoint wrapper: BridgeError → stable failure result, anything else is a
 * programming/host error and is rethrown so the HTTP carrier answers with the
 * fixed gateway/internal envelope instead of leaking it.
 */
function endpoint(handler) {
  return async (payload, signal) => {
    try {
      return await handler(payload, signal)
    } catch (error) {
      return bridgeErrorResult(error)
    }
  }
}

function createInvoke(bridge) {
  return async function invokeEngine(argv, signal) {
    let result
    try {
      result = await bridge.execute(argv, { signal })
    } catch (error) {
      return bridgeErrorResult(error)
    }
    if (isRecord(result) && result.cli !== undefined && result.cli !== null) {
      // Engine JSON is the payload, even when the engine reported an error:
      // the UI renders value.error.code/ message itself.
      return { ok: true, value: result.cli }
    }
    return bridgeFailureResult(result)
  }
}

/**
 * Create the read-model endpoint handlers: the four read-only workbench
 * endpoints plus the six S2a five-view endpoints.
 *
 * @param {{bridge: {execute: Function, resolvePython?: Function}, settings: object}} options
 *   `settings` is the trusted plugin configuration (bootstrapPath, packageRoot);
 *   no field is supplied by the browser.
 * @returns {Readonly<Record<string, Function>>} endpoint → handler(payload, signal)
 */
export function createViewService({ bridge, settings } = {}) {
  if (typeof bridge?.execute !== 'function') throw new Error('dsh-code-reader: view service requires bridge.execute')
  const invokeEngine = createInvoke(bridge)
  const packageFacts = readPackageFacts(settings)
  const bootstrapPath = settings?.bootstrapPath

  const status = endpoint(async (payload, signal) => {
    validatePayload(payload, [])
    // Availability is reported through `engine`; `gaps` only lists capabilities
    // this read-only slice does not provide. The UI turns python/bootstrap
    // availability into its own gap rows from `engine` (contract §4.3/§6).
    const python = await probePython(bridge, signal)
    const exists = bootstrapExists(bootstrapPath)
    const gaps = SLICE_GAPS.map((gap) => ({ ...gap }))
    return {
      ok: true,
      value: {
        schema_version: 1,
        host: {
          plugin: PLUGIN_NAME,
          package: packageFacts.name,
          version: packageFacts.version,
          panel_key: PANEL_KEY,
          rpc_channel: RPC_CHANNEL,
          node: process.versions.node,
          platform: process.platform,
        },
        engine: {
          python,
          bootstrap: { configured: true, exists },
        },
        capabilities: { ...CAPABILITIES },
        gaps,
      },
    }
  })

  const listSnapshots = endpoint(async (payload, signal) => {
    validatePayload(payload, [])
    return invokeEngine(['view-snapshots'], signal)
  })

  const listEntries = endpoint(async (payload, signal) => {
    const body = validatePayload(payload, ['workspace', 'snapshot'])
    const workspace = requireWorkspaceField(body)
    const snapshot = requireSnapshotField(body)
    return invokeEngine(['view-entries', '--workspace', workspace, '--snapshot', snapshot], signal)
  })

  const getEntry = endpoint(async (payload, signal) => {
    const body = validatePayload(payload, ['workspace', 'snapshot', 'entry'])
    const workspace = requireWorkspaceField(body)
    const snapshot = requireSnapshotField(body)
    const entry = requireEntryField(body)
    return invokeEngine(['view-entry', '--workspace', workspace, '--snapshot', snapshot, '--entry', entry], signal)
  })

  // --- S2a five-view read model (docs/five-view-contract.md §2) -------------

  const coupling = endpoint(async (payload, signal) => {
    const body = validatePayload(payload, ['workspace', 'snapshot', 'entry'])
    const workspace = requireWorkspaceField(body)
    const snapshot = requireSnapshotField(body)
    const entry = optionalEntryField(body)
    const argv = ['view-coupling', '--workspace', workspace, '--snapshot', snapshot]
    if (entry !== undefined) argv.push('--entry', entry)
    return invokeEngine(argv, signal)
  })

  const tree = endpoint(async (payload, signal) => {
    const body = validatePayload(payload, ['workspace', 'snapshot', 'entry'])
    const workspace = requireWorkspaceField(body)
    const snapshot = requireSnapshotField(body)
    const entry = requireEntryField(body)
    return invokeEngine(['view-tree', '--workspace', workspace, '--snapshot', snapshot, '--entry', entry], signal)
  })

  const endToEnd = endpoint(async (payload, signal) => {
    const body = validatePayload(payload, ['workspace', 'snapshot', 'entry', 'root'])
    const workspace = requireWorkspaceField(body)
    const snapshot = requireSnapshotField(body)
    const entry = requireEntryField(body)
    const root = optionalRootField(body)
    const argv = ['view-end-to-end', '--workspace', workspace, '--snapshot', snapshot, '--entry', entry]
    if (root !== undefined) argv.push('--root', root)
    return invokeEngine(argv, signal)
  })

  const fileTree = endpoint(async (payload, signal) => {
    const body = validatePayload(payload, ['workspace', 'snapshot'])
    const workspace = requireWorkspaceField(body)
    const snapshot = requireSnapshotField(body)
    return invokeEngine(['view-file-tree', '--workspace', workspace, '--snapshot', snapshot], signal)
  })

  const fileRead = endpoint(async (payload, signal) => {
    const body = validatePayload(payload, ['workspace', 'snapshot', 'repo', 'path', 'max_lines'])
    const workspace = requireWorkspaceField(body)
    const snapshot = requireSnapshotField(body)
    const repo = requireRepoField(body)
    const repoPath = requireRepoPathField(body)
    const argv = ['view-file-read', '--workspace', workspace, '--snapshot', snapshot, '--repo', repo, '--path', repoPath]
    const maxLines = optionalMaxLinesField(body)
    if (maxLines !== undefined) argv.push('--max-lines', String(maxLines))
    return invokeEngine(argv, signal)
  })

  const sequence = endpoint(async (payload, signal) => {
    const body = validatePayload(payload, ['workspace', 'snapshot', 'entry', 'mode'])
    const workspace = requireWorkspaceField(body)
    const snapshot = requireSnapshotField(body)
    const entry = requireEntryField(body)
    const mode = sequenceModeField(body)
    return invokeEngine(['view-sequence', '--workspace', workspace, '--snapshot', snapshot, '--entry', entry, '--mode', mode], signal)
  })

  // --- S2b increments (docs/five-view-contract.md §10) ----------------------

  const interfaces = endpoint(async (payload, signal) => {
    const body = validatePayload(payload, ['workspace', 'snapshot', 'entry'])
    const workspace = requireWorkspaceField(body)
    const snapshot = requireSnapshotField(body)
    const entry = optionalEntryField(body)
    const argv = ['view-interfaces', '--workspace', workspace, '--snapshot', snapshot]
    if (entry !== undefined) argv.push('--entry', entry)
    return invokeEngine(argv, signal)
  })

  return Object.freeze({
    'view.status': status,
    'view.listSnapshots': listSnapshots,
    'view.listEntries': listEntries,
    'view.getEntry': getEntry,
    'view.coupling': coupling,
    'view.tree': tree,
    'view.endToEnd': endToEnd,
    'view.fileTree': fileTree,
    'view.fileRead': fileRead,
    'view.sequence': sequence,
    'view.interfaces': interfaces,
  })
}

/**
 * Build the HTTP carrier handler for a view service. Unknown endpoints fail
 * closed with INVALID_ARGUMENT; the carrier's own whitelist normally rejects
 * them first as a bad request.
 */
export function createViewDispatch(service) {
  if (!isRecord(service)) throw new Error('dsh-code-reader: view dispatch requires a view service')
  return async function dispatch(endpointName, payload, signal) {
    if (typeof endpointName !== 'string' || !Object.hasOwn(service, endpointName)) {
      return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'unknown view endpoint' } }
    }
    return service[endpointName](payload, signal)
  }
}
