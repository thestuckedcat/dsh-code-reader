// dsh-code-reader: controlled scenario execution orchestration (S3a + S3b).
//
// The browser only submits structured `workspace/snapshot/profile/scenario`
// values: it never supplies a path, module URL or argv. The Host validates the
// scenario shape, asks the local engine for a signed plan and the module
// bytes, runs the module inside the isolated worker (lib/sim-runner.mjs) and
// asks the engine to append the immutable ledger generation with a Host-owned
// idempotency id.
//
// S3b adds:
//   - `scenario.undoTail`: undo-plan → module (undo plan store) → isolated
//     prefix replay → undo-record (the engine verifies memory digests and only
//     then publishes the prefix generation);
//   - `trace.import`: a single trusted-inbox trace file name is mapped to the
//     engine `trace-import` CLI (the Host never reads the file or executes it).
//
// Error semantics (scenario contract §4, s3b contract §1.3/§2.3):
//   - input validation → {ok:false,error:{code:'INVALID_ARGUMENT',message}}
//   - engine validation/state failure → {ok:true,value:<engine error doc>}
//   - worker timeout/crash/cancel → {ok:false,error:{code:'OUTCOME_UNKNOWN',
//     message,details:{}}} and NO ledger write
//   - bridge/host failure → stable path-free error codes (same as view service)
import { randomUUID } from 'node:crypto'

import { BridgeError } from './bridge.mjs'
import { runSimulation } from './sim-runner.mjs'

export const SCENARIO_ENDPOINTS = Object.freeze([
  'scenario.listProfiles',
  'scenario.list',
  'scenario.get',
  'scenario.preview',
  'scenario.run',
  'scenario.undoTail',
  'trace.import',
])

const RUN_TIMEOUT_MS = 15_000
const DEFAULT_WORKER_TIMEOUT_MS = 10_000
const MAX_WORKER_TIMEOUT_MS = 30_000
const MAX_STEPS = 20
const MAX_UNDO_COUNT = 200
const MAX_ARGS_PER_STEP = 8
const MAX_TRACE_INPUT_NAME = 256
const TRACE_INPUT_PATTERN = /^[A-Za-z0-9._-]+$/
const MAX_SCENARIO_ARGS_BYTES = 4096
const MAX_SCENARIO_JSON_BYTES = 8192
const MAX_RECORDS_JSON_BYTES = 32768
const MAX_EVENTS_PER_STEP = 256
const UINT32_MAX = 0xffffffff
const INT32_MIN = -0x80000000
const SAFE_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

const WORKSPACE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const WORKSPACE_MAX = 128
const SNAPSHOT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SNAPSHOT_MAX = 128
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const PROFILE_MAX = 64
const SCENARIO_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SCENARIO_REF_MAX = 128
const INTERFACE_PATTERN = /^[A-Za-z0-9_$.:-]{1,64}$/
const MEMORY_DIGEST_PATTERN = /^[0-9a-f]{64}$/

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

function endpoint(handler) {
  return async (payload, signal) => {
    try {
      return await handler(payload, signal)
    } catch (error) {
      return bridgeErrorResult(error)
    }
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

function requireProfileField(body) {
  return requireStringField(body, 'profile', {
    max: PROFILE_MAX,
    pattern: PROFILE_PATTERN,
    description: '^[a-z0-9][a-z0-9._-]{0,63}$',
  })
}

function requireScenarioRefField(body) {
  return requireStringField(body, 'scenario', {
    max: SCENARIO_REF_MAX,
    pattern: SCENARIO_REF_PATTERN,
    description: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
  })
}

function requireGenerationField(body) {
  if (!Object.hasOwn(body, 'expected_generation')) invalid('expected_generation is required')
  const value = body.expected_generation
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) {
    invalid('expected_generation must be an integer >= 0')
  }
  return value
}

/** S3b: number of trailing steps to undo. The engine still enforces N <= L. */
function requireUndoCountField(body) {
  if (!Object.hasOwn(body, 'count')) invalid('count is required')
  const value = body.count
  if (!Number.isInteger(value) || value < 1 || value > MAX_UNDO_COUNT) {
    invalid(`count must be an integer in 1..${MAX_UNDO_COUNT}`)
  }
  return value
}

/** S3b: a single trusted-inbox file name; never a path, module URL or argv. */
function requireTraceInputField(body) {
  if (!Object.hasOwn(body, 'input')) invalid('input is required')
  const value = body.input
  if (typeof value !== 'string') invalid('input must be a string')
  if (value.length === 0 || value.length > MAX_TRACE_INPUT_NAME) {
    invalid(`input must be a non-empty file name of at most ${MAX_TRACE_INPUT_NAME} characters`)
  }
  if (value === '.' || value === '..' || value.includes('..')) {
    invalid('input must be a plain inbox file name (no "." or ".." path segments)')
  }
  if (value.includes('/') || value.includes('\\')) {
    invalid('input must be a plain inbox file name (no path separators)')
  }
  if (!TRACE_INPUT_PATTERN.test(value)) invalid('input must match ^[A-Za-z0-9._-]+$')
  return value
}

function validateScenarioSteps(value) {
  if (!Array.isArray(value)) invalid('scenario.steps must be an array')
  if (value.length > MAX_STEPS) invalid(`scenario.steps must contain at most ${MAX_STEPS} steps`)
  const steps = []
  for (let index = 0; index < value.length; index += 1) {
    const step = value[index]
    if (!isRecord(step)) invalid(`scenario.steps[${index}] must be an object`)
    for (const key of Object.keys(step)) {
      if (key !== 'interface' && key !== 'args') {
        invalid(`unknown scenario step field: ${safeFieldName(key)}`)
      }
    }
    const iface = step.interface
    if (typeof iface !== 'string' || iface.length === 0 || iface.length > 64 || !INTERFACE_PATTERN.test(iface)) {
      invalid(`scenario.steps[${index}].interface must be a bounded interface name`)
    }
    if (!Array.isArray(step.args)) invalid(`scenario.steps[${index}].args must be an array`)
    if (step.args.length > MAX_ARGS_PER_STEP) {
      invalid(`scenario.steps[${index}].args must contain at most ${MAX_ARGS_PER_STEP} integers`)
    }
    for (let argIndex = 0; argIndex < step.args.length; argIndex += 1) {
      const arg = step.args[argIndex]
      if (!Number.isSafeInteger(arg) || arg < INT32_MIN || arg > UINT32_MAX) {
        invalid(`scenario.steps[${index}].args[${argIndex}] must be a 32-bit integer`)
      }
    }
    steps.push({ interface: iface, args: step.args.slice() })
  }
  // Contract §3: the canonical scenario argument list is limited to 4 KiB.
  let argsBytes
  try {
    argsBytes = Buffer.byteLength(JSON.stringify(steps.map((step) => step.args)), 'utf8')
  } catch {
    invalid('scenario arguments must be JSON serialisable')
  }
  if (argsBytes > MAX_SCENARIO_ARGS_BYTES) {
    invalid(`scenario arguments must be at most ${MAX_SCENARIO_ARGS_BYTES} bytes`)
  }
  return steps
}

/** Validate one browser scenario object; throws BridgeError on any deviation. */
function validateScenarioField(body) {
  if (!Object.hasOwn(body, 'scenario')) invalid('scenario is required')
  const scenario = body.scenario
  if (!isRecord(scenario)) invalid('scenario must be a JSON object')
  for (const key of Object.keys(scenario)) {
    if (key !== 'generation' && key !== 'stop_on_error' && key !== 'steps') {
      invalid(`unknown scenario field: ${safeFieldName(key)}`)
    }
  }
  if (!Number.isInteger(scenario.generation) || scenario.generation < 0 || scenario.generation > 0x7fffffff) {
    invalid('scenario.generation must be an integer >= 0')
  }
  if (scenario.stop_on_error !== undefined && typeof scenario.stop_on_error !== 'boolean') {
    invalid('scenario.stop_on_error must be a boolean')
  }
  const steps = validateScenarioSteps(scenario.steps)
  const normalized = {
    generation: scenario.generation,
    stop_on_error: scenario.stop_on_error === undefined ? true : scenario.stop_on_error,
    steps,
  }
  let encoded
  try {
    encoded = JSON.stringify(normalized)
  } catch {
    invalid('scenario must be JSON serialisable')
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_SCENARIO_JSON_BYTES) {
    invalid(`scenario JSON must be at most ${MAX_SCENARIO_JSON_BYTES} bytes`)
  }
  return normalized
}

function encodeBase64(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

function createInvoke(bridge) {
  return async function invokeEngine(argv, { signal, timeoutMs } = {}) {
    let result
    try {
      result = await bridge.execute(argv, timeoutMs === undefined ? { signal } : { signal, timeoutMs })
    } catch (error) {
      return bridgeErrorResult(error)
    }
    if (isRecord(result) && result.cli !== undefined && result.cli !== null) {
      // Engine documents (including `{error:{code,message}}` validation
      // failures) are successful RPC payloads; the caller decides what they mean.
      return { ok: true, value: result.cli }
    }
    return bridgeFailureResult(result)
  }
}

function isEngineErrorDoc(value) {
  return isRecord(value) && isRecord(value.error) && typeof value.error.code === 'string'
}

function outcomeUnknown(message) {
  return { ok: false, error: { code: 'OUTCOME_UNKNOWN', message, details: {} } }
}

function hostFailure(message) {
  return { ok: false, error: { code: 'ENGINE_FAILED', message } }
}

function extractPlanSteps(plan) {
  if (!isRecord(plan) || !Array.isArray(plan.steps)) return null
  const steps = []
  for (const step of plan.steps) {
    if (!isRecord(step) || typeof step.interface !== 'string' || !Array.isArray(step.args)) return null
    steps.push({ interface: step.interface, args: step.args })
  }
  return steps
}

/** S3b undo plan: the replay prefix lives under `prefix.steps`. */
function extractUndoPrefixSteps(undoPlan) {
  if (!isRecord(undoPlan) || !isRecord(undoPlan.prefix) || !Array.isArray(undoPlan.prefix.steps)) return null
  const steps = []
  for (const step of undoPlan.prefix.steps) {
    if (!isRecord(step) || typeof step.interface !== 'string' || !Array.isArray(step.args)) return null
    steps.push({ interface: step.interface, args: step.args })
  }
  return steps
}

/** Host-owned idempotency id (never supplied by the browser). */
function hostOperationId(bridge) {
  const id = typeof bridge.newOperationId === 'function' ? bridge.newOperationId() : randomUUID()
  return typeof id === 'string' && id.length > 0 ? id : randomUUID()
}

function planWorkerTimeout(plan) {
  const limits = isRecord(plan) && isRecord(plan.limits) ? plan.limits : {}
  const value = limits.timeout_ms
  if (Number.isInteger(value) && value >= 1 && value <= MAX_WORKER_TIMEOUT_MS) return value
  return DEFAULT_WORKER_TIMEOUT_MS
}

/** Validate the isolated worker records against the engine-signed plan. */
function validateRecords(records, planSteps) {
  if (!Array.isArray(records) || records.length !== planSteps.length) {
    return 'isolated worker returned the wrong number of records'
  }
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    const step = planSteps[index]
    if (!isRecord(record)) return `record ${index} is not an object`
    if (record.step_index !== index) return `record ${index} has the wrong step_index`
    if (record.interface !== step.interface) return `record ${index} interface does not match the plan`
    if (!Array.isArray(record.args) || record.args.length !== step.args.length) return `record ${index} args do not match the plan`
    for (let argIndex = 0; argIndex < step.args.length; argIndex += 1) {
      if (record.args[argIndex] !== step.args[argIndex]) return `record ${index} args do not match the plan`
    }
    if (record.status !== 'ok' && record.status !== 'error') return `record ${index} has an invalid status`
    if (record.result !== null && !Number.isInteger(record.result)) return `record ${index} has an invalid result`
    if (typeof record.memory_digest !== 'string' || !MEMORY_DIGEST_PATTERN.test(record.memory_digest)) {
      return `record ${index} has an invalid memory_digest`
    }
    if (!Number.isInteger(record.elapsed_ms) || record.elapsed_ms < 0) return `record ${index} has an invalid elapsed_ms`
    if (!Array.isArray(record.events) || record.events.length > MAX_EVENTS_PER_STEP) return `record ${index} events exceed the budget`
    for (const event of record.events) {
      if (
        !isRecord(event) ||
        typeof event.event !== 'string' ||
        !Number.isInteger(event.code) ||
        !Number.isInteger(event.a) ||
        !Number.isInteger(event.b) ||
        !Number.isInteger(event.c) ||
        !Number.isInteger(event.line)
      ) {
        return `record ${index} has a malformed event`
      }
    }
  }
  return null
}

/**
 * Create the scenario endpoints.
 *
 * @param {{bridge: {execute: Function, newOperationId?: Function}, settings?: object, runner?: Function}} options
 *   `runner` is injectable for tests; production uses lib/sim-runner.mjs.
 */
export function createScenarioService({ bridge, settings, runner = runSimulation } = {}) {
  if (typeof bridge?.execute !== 'function') throw new Error('dsh-code-reader: scenario service requires bridge.execute')
  if (typeof runner !== 'function') throw new Error('dsh-code-reader: scenario service requires a runner function')
  const invokeEngine = createInvoke(bridge)

  /**
   * Load the engine-signed module for one signed plan (normal or undo kind),
   * execute the bounded steps in the isolated worker and validate the records.
   * Returns `{done:true,result}` for every failure/engine-error path (the caller
   * returns that result verbatim) or `{done:false,records}` on success — the
   * engine ledger write still has to happen in the caller.
   */
  async function replayIsolated({ planRef, planSteps, plan, signal, remaining, expire }) {
    if (remaining() <= 0) return { done: true, result: expire() }
    const moduleCall = await invokeEngine(['scenario-module', '--plan', planRef], {
      signal,
      timeoutMs: Math.max(1, Math.min(remaining(), RUN_TIMEOUT_MS)),
    })
    if (!moduleCall.ok) return { done: true, result: moduleCall }
    if (isEngineErrorDoc(moduleCall.value)) return { done: true, result: { ok: true, value: moduleCall.value } }
    const moduleDoc = moduleCall.value
    if (!isRecord(moduleDoc) || typeof moduleDoc.module_b64 !== 'string' || typeof moduleDoc.module_sha256 !== 'string') {
      return { done: true, result: hostFailure('engine module document is missing the module bytes or sha256') }
    }
    const profileProjection = isRecord(moduleDoc.profile) ? moduleDoc.profile : {}
    const interfaces = Array.isArray(profileProjection.interfaces) ? profileProjection.interfaces : undefined
    if (remaining() <= 0) return { done: true, result: expire() }
    const workerTimeout = Math.max(1, Math.min(remaining(), planWorkerTimeout(plan)))
    const simulation = await runner({
      moduleB64: moduleDoc.module_b64,
      moduleSha256: moduleDoc.module_sha256,
      steps: planSteps,
      interfaces,
      traceSpec: moduleDoc.trace,
      eventResourceSpec: moduleDoc.event_resources,
      timeoutMs: workerTimeout,
      signal,
    })
    if (!isRecord(simulation)) {
      return { done: true, result: outcomeUnknown('isolated simulation returned an invalid result; outcome unknown') }
    }
    if (simulation.ok !== true) {
      const error = isRecord(simulation.error) ? simulation.error : {}
      if (error.code === 'INVALID_ARGUMENT') {
        return {
          done: true,
          result: {
            ok: false,
            error: { code: 'INVALID_ARGUMENT', message: typeof error.message === 'string' ? error.message : 'simulation input was rejected' },
          },
        }
      }
      return { done: true, result: outcomeUnknown('isolated simulation failed (timeout, crash or cancellation); outcome unknown') }
    }
    const recordsProblem = validateRecords(simulation.records, planSteps)
    if (recordsProblem !== null) return { done: true, result: hostFailure(recordsProblem) }
    return { done: false, records: simulation.records }
  }

  /** Encode worker records as the bounded base64 `--records-json` payload. */
  function encodeRecords(records) {
    let recordsJson
    try {
      recordsJson = JSON.stringify({ records })
    } catch {
      return { ok: false, result: hostFailure('isolated records are not JSON serialisable') }
    }
    if (Buffer.byteLength(recordsJson, 'utf8') > MAX_RECORDS_JSON_BYTES) {
      return {
        ok: false,
        result: {
          ok: false,
          error: {
            code: 'LIMIT_EXCEEDED',
            message: `simulation records must be at most ${MAX_RECORDS_JSON_BYTES} JSON bytes`,
            details: {},
          },
        },
      }
    }
    return { ok: true, recordsB64: Buffer.from(recordsJson, 'utf8').toString('base64') }
  }

  const listProfiles = endpoint(async (payload, signal) => {
    const body = validatePayload(payload, ['workspace'])
    const workspace = requireWorkspaceField(body)
    return invokeEngine(['sim-profile-list', '--workspace', workspace], { signal })
  })

  const list = endpoint(async (payload, signal) => {
    const body = validatePayload(payload, ['workspace'])
    const workspace = requireWorkspaceField(body)
    return invokeEngine(['scenario-list', '--workspace', workspace], { signal })
  })

  const get = endpoint(async (payload, signal) => {
    const body = validatePayload(payload, ['workspace', 'scenario'])
    const workspace = requireWorkspaceField(body)
    const scenario = requireScenarioRefField(body)
    return invokeEngine(['scenario-get', '--workspace', workspace, '--scenario', scenario], { signal })
  })

  const preview = endpoint(async (payload, signal) => {
    const body = validatePayload(payload, ['workspace', 'snapshot', 'profile', 'scenario'])
    const workspace = requireWorkspaceField(body)
    const snapshot = requireSnapshotField(body)
    const profile = requireProfileField(body)
    const scenario = validateScenarioField(body)
    const call = await invokeEngine(
      [
        'scenario-plan',
        '--workspace', workspace,
        '--snapshot', snapshot,
        '--profile', profile,
        '--scenario-json', encodeBase64(scenario),
      ],
      { signal },
    )
    if (!call.ok) return call
    return { ok: true, value: call.value }
  })

  const run = endpoint(async (payload, signal) => {
    const body = validatePayload(payload, ['workspace', 'snapshot', 'profile', 'scenario', 'expected_generation'])
    const workspace = requireWorkspaceField(body)
    const snapshot = requireSnapshotField(body)
    const profile = requireProfileField(body)
    const scenario = validateScenarioField(body)
    const expectedGeneration = requireGenerationField(body)

    // Generation CAS (engine scenario.py §3): `scenario-plan` accepts the
    // contract-style call (scenario.generation == current ledger generation) or
    // the Host run path (declared == expected_generation == current + 1).
    // Declaring the requested expected_generation here maps both browser
    // conventions onto one deterministic Host call; the engine still rejects a
    // stale/advanced ledger with STATE_CONFLICT.
    const engineScenario = { ...scenario, generation: expectedGeneration }

    const deadline = Date.now() + RUN_TIMEOUT_MS
    const remaining = () => deadline - Date.now()
    const budget = (ms) => Math.max(1, Math.min(ms, RUN_TIMEOUT_MS))
    const expire = () => outcomeUnknown(`scenario run exceeded its ${RUN_TIMEOUT_MS}ms budget; outcome unknown`)

    if (remaining() <= 0) return expire()

    // 1) engine-signed plan (CAS on the current ledger generation).
    const planCall = await invokeEngine(
      [
        'scenario-plan',
        '--workspace', workspace,
        '--snapshot', snapshot,
        '--profile', profile,
        '--scenario-json', encodeBase64(engineScenario),
        '--expected-generation', String(expectedGeneration),
      ],
      { signal, timeoutMs: budget(remaining()) },
    )
    if (!planCall.ok) return planCall
    if (isEngineErrorDoc(planCall.value)) return { ok: true, value: planCall.value }
    const plan = planCall.value
    if (!isRecord(plan) || typeof plan.plan_id !== 'string' || !SCENARIO_REF_PATTERN.test(plan.plan_id)) {
      return hostFailure('engine returned a plan without a usable plan_id')
    }
    const planSteps = extractPlanSteps(plan)
    if (planSteps === null) return hostFailure('engine plan projection is missing its bounded steps')

    const replay = await replayIsolated({
      planRef: plan.plan_id,
      planSteps,
      plan,
      signal,
      remaining,
      expire,
    })
    if (replay.done) return replay.result
    const encodedRecords = encodeRecords(replay.records)
    if (!encodedRecords.ok) return encodedRecords.result
    if (remaining() <= 0) return expire()
    const recordCall = await invokeEngine(
      [
        'scenario-record',
        '--plan', plan.plan_id,
        '--records-json', encodedRecords.recordsB64,
        '--operation-id', hostOperationId(bridge),
      ],
      { signal, timeoutMs: budget(remaining()) },
    )
    if (!recordCall.ok) return recordCall
    // Success or an engine validation failure (e.g. STATE_CONFLICT) is returned
    // verbatim; neither path may be retried with a different payload here.
    return { ok: true, value: recordCall.value }
  })

  // --- S3b: undo tail + prefix replay (s3b contract §1.3) -------------------

  const undoTail = endpoint(async (payload, signal) => {
    const body = validatePayload(payload, ['workspace', 'scenario', 'count', 'expected_generation'])
    const workspace = requireWorkspaceField(body)
    const scenario = requireScenarioRefField(body)
    const count = requireUndoCountField(body)
    const expectedGeneration = requireGenerationField(body)

    const deadline = Date.now() + RUN_TIMEOUT_MS
    const remaining = () => deadline - Date.now()
    const budget = (ms) => Math.max(1, Math.min(ms, RUN_TIMEOUT_MS))
    const expire = () => outcomeUnknown(`scenario undo exceeded its ${RUN_TIMEOUT_MS}ms budget; outcome unknown`)

    if (remaining() <= 0) return expire()

    // 1) engine undo plan: source generation CAS, prefix scenario/steps and the
    // expected per-step memory digests (the engine verifies them on publish).
    const undoPlanCall = await invokeEngine(
      [
        'scenario-undo-plan',
        '--workspace', workspace,
        '--scenario', scenario,
        '--count', String(count),
        '--expected-generation', String(expectedGeneration),
      ],
      { signal, timeoutMs: budget(remaining()) },
    )
    if (!undoPlanCall.ok) return undoPlanCall
    if (isEngineErrorDoc(undoPlanCall.value)) return { ok: true, value: undoPlanCall.value }
    const undoPlan = undoPlanCall.value
    if (
      !isRecord(undoPlan) ||
      undoPlan.kind !== 'undo' ||
      typeof undoPlan.undo_plan_id !== 'string' ||
      !SCENARIO_REF_PATTERN.test(undoPlan.undo_plan_id)
    ) {
      return hostFailure('engine returned an undo plan without a usable undo_plan_id')
    }
    const prefixSteps = extractUndoPrefixSteps(undoPlan)
    if (prefixSteps === null) return hostFailure('engine undo plan projection is missing its prefix steps')

    // 2+3) module bytes from the same plan store (kind=undo) and the isolated
    // prefix replay; a worker failure leaves the ledger untouched.
    const replay = await replayIsolated({
      planRef: undoPlan.undo_plan_id,
      planSteps: prefixSteps,
      plan: undoPlan,
      signal,
      remaining,
      expire,
    })
    if (replay.done) return replay.result
    const encodedRecords = encodeRecords(replay.records)
    if (!encodedRecords.ok) return encodedRecords.result

    // 4) the engine verifies the replayed memory digests against the source
    // prefix and only then publishes the prefix generation; an engine error
    // document (e.g. STATE_CONFLICT / state_digest_mismatch) is returned verbatim.
    if (remaining() <= 0) return expire()
    const undoRecordCall = await invokeEngine(
      [
        'scenario-undo-record',
        '--plan', undoPlan.undo_plan_id,
        '--records-json', encodedRecords.recordsB64,
        '--operation-id', hostOperationId(bridge),
      ],
      { signal, timeoutMs: budget(remaining()) },
    )
    if (!undoRecordCall.ok) return undoRecordCall
    return { ok: true, value: undoRecordCall.value }
  })

  // --- S3b: trusted-inbox trace import (s3b contract §2.3) ------------------

  const traceImport = endpoint(async (payload, signal) => {
    const body = validatePayload(payload, ['workspace', 'snapshot', 'input'])
    const workspace = requireWorkspaceField(body)
    const snapshot = requireSnapshotField(body)
    const input = requireTraceInputField(body)
    const call = await invokeEngine(
      [
        'trace-import',
        '--workspace', workspace,
        '--snapshot', snapshot,
        '--input', input,
        '--operation-id', hostOperationId(bridge),
      ],
      { signal },
    )
    if (!call.ok) return call
    return { ok: true, value: call.value }
  })

  return Object.freeze({
    'scenario.listProfiles': listProfiles,
    'scenario.list': list,
    'scenario.get': get,
    'scenario.preview': preview,
    'scenario.run': run,
    'scenario.undoTail': undoTail,
    'trace.import': traceImport,
  })
}

/**
 * Route one workbench RPC method to the matching service by endpoint prefix.
 * The HTTP carrier still owns the method whitelist and the envelope limits.
 */
export function createWorkbenchDispatch({ viewService, scenarioService } = {}) {
  if (!isRecord(viewService)) throw new Error('dsh-code-reader: workbench dispatch requires a view service')
  if (!isRecord(scenarioService)) throw new Error('dsh-code-reader: workbench dispatch requires a scenario service')
  return async function dispatch(endpointName, payload, signal) {
    if (typeof endpointName === 'string' && endpointName.startsWith('view.')) {
      if (!Object.hasOwn(viewService, endpointName)) {
        return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'unknown view endpoint' } }
      }
      return viewService[endpointName](payload, signal)
    }
    if (
      typeof endpointName === 'string' &&
      (endpointName.startsWith('scenario.') || endpointName.startsWith('trace.'))
    ) {
      const prefix = endpointName.startsWith('trace.') ? 'trace' : 'scenario'
      if (!Object.hasOwn(scenarioService, endpointName)) {
        return { ok: false, error: { code: 'INVALID_ARGUMENT', message: `unknown ${prefix} endpoint` } }
      }
      return scenarioService[endpointName](payload, signal)
    }
    return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'unknown workbench endpoint' } }
  }
}
