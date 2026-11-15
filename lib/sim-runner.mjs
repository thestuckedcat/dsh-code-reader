// dsh-code-reader: parent-side orchestrator for the isolated Wasm simulation.
//
// The parent never touches Wasm memory: it validates the bounded plan, spawns
// lib/sim-worker.mjs in a `worker_threads` thread with a 64 MB old-generation
// cap, waits for records and owns the total timeout. A timeout, crash or
// cancellation terminates the worker and reports OUTCOME_UNKNOWN so the caller
// can refuse to write a ledger generation.
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

const WORKER_FILE = fileURLToPath(new URL('./sim-worker.mjs', import.meta.url))

export const DEFAULT_TIMEOUT_MS = 10_000
export const MAX_TIMEOUT_MS = 30_000
export const MAX_RESOURCE_LIMIT_MB = 64

const MAX_STEPS = 20
const MAX_ARGS_PER_STEP = 8
const MAX_STEPS_JSON_BYTES = 4096
const INTERFACE_PATTERN = /^[A-Za-z0-9_$.:-]{1,64}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const UINT32_MAX = 0xffffffff
const INT32_MIN = -0x80000000

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(code, message) {
  return { ok: false, error: { code, message } }
}

function invalid(message) {
  return fail('INVALID_ARGUMENT', message)
}

function unknownOutcome(message) {
  return fail('OUTCOME_UNKNOWN', message)
}

function checkIntegerArg(arg, stepIndex, argIndex) {
  if (!Number.isSafeInteger(arg) || arg < INT32_MIN || arg > UINT32_MAX) {
    return invalid(`step ${stepIndex} arg ${argIndex} must be a 32-bit integer`)
  }
  return null
}

/**
 * Validate the bounded plan and, when the profile interface table is known,
 * every interface name/arity/range before any worker is spawned. Unknown
 * interfaces and out-of-range values are rejected here rather than becoming a
 * Wasm trap inside the worker.
 */
export function validateSimulationInput(input = {}) {
  const { moduleB64, moduleSha256, steps, interfaces, traceSpec, timeoutMs } = input
  if (typeof moduleB64 !== 'string' || moduleB64.length === 0) return invalid('moduleB64 is required')
  if (typeof moduleSha256 !== 'string' || !SHA256_PATTERN.test(moduleSha256)) {
    return invalid('moduleSha256 must be 64 lowercase hex characters')
  }
  if (!Array.isArray(steps)) return invalid('steps must be an array')
  if (steps.length > MAX_STEPS) return invalid(`steps must contain at most ${MAX_STEPS} entries`)
  let stepsBytes
  try {
    stepsBytes = Buffer.byteLength(JSON.stringify(steps), 'utf8')
  } catch {
    return invalid('steps must be JSON serialisable')
  }
  if (stepsBytes > MAX_STEPS_JSON_BYTES) return invalid(`steps must be at most ${MAX_STEPS_JSON_BYTES} JSON bytes`)

  const interfaceTable = Array.isArray(interfaces)
    ? new Map(
        interfaces
          .filter((entry) => isRecord(entry) && typeof entry.name === 'string')
          .map((entry) => [entry.name, entry]),
      )
    : null

  const normalizedSteps = []
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (!isRecord(step) || typeof step.interface !== 'string' || !INTERFACE_PATTERN.test(step.interface)) {
      return invalid(`step ${index} interface must be a bounded identifier`)
    }
    if (!Array.isArray(step.args) || step.args.length > MAX_ARGS_PER_STEP) {
      return invalid(`step ${index} args must be an array of at most ${MAX_ARGS_PER_STEP} integers`)
    }
    for (let argIndex = 0; argIndex < step.args.length; argIndex += 1) {
      const problem = checkIntegerArg(step.args[argIndex], index, argIndex)
      if (problem !== null) return problem
    }
    if (interfaceTable !== null) {
      const iface = interfaceTable.get(step.interface)
      if (iface === undefined) return invalid(`step ${index} interface "${step.interface}" is not in the profile`)
      const params = Array.isArray(iface.params) ? iface.params : []
      if (params.length !== step.args.length) {
        return invalid(`step ${index} interface "${step.interface}" expects ${params.length} arguments`)
      }
      for (let argIndex = 0; argIndex < params.length; argIndex += 1) {
        const param = isRecord(params[argIndex]) ? params[argIndex] : {}
        const value = step.args[argIndex]
        if (typeof param.min === 'number' && value < param.min) return invalid(`step ${index} arg ${argIndex} is below min`)
        if (typeof param.max === 'number' && value > param.max) return invalid(`step ${index} arg ${argIndex} is above max`)
      }
    }
    normalizedSteps.push({ interface: step.interface, args: step.args.slice() })
  }

  const budget = timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : timeoutMs
  if (!Number.isInteger(budget) || budget < 1 || budget > MAX_TIMEOUT_MS) {
    return invalid(`timeoutMs must be an integer in 1..${MAX_TIMEOUT_MS}`)
  }
  if (traceSpec !== undefined && traceSpec !== null && !isRecord(traceSpec)) return invalid('traceSpec must be an object')

  return {
    ok: true,
    workerData: {
      moduleB64,
      moduleSha256,
      steps: normalizedSteps,
      traceSpec: traceSpec ?? null,
      eventResourceSpec: input.eventResourceSpec ?? null,
    },
    timeoutMs: budget,
  }
}

/**
 * Run one bounded scenario in an isolated worker.
 *
 * @returns {Promise<{ok:true, records: object[]} | {ok:false, error:{code:string,message:string}}>}
 */
export async function runSimulation(input = {}) {
  const prepared = validateSimulationInput(input)
  if (!prepared.ok) return prepared
  const { workerData, timeoutMs } = prepared
  const signal = input.signal

  if (signal?.aborted) return unknownOutcome('simulation was cancelled before it started; outcome unknown')

  return await new Promise((resolve) => {
    let settled = false
    let timer = null
    let worker = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      try {
        signal?.removeEventListener?.('abort', onAbort)
      } catch {
        /* signal may be foreign */
      }
      try {
        worker?.removeAllListeners()
        Promise.resolve(worker?.terminate()).catch(() => {})
      } catch {
        /* already terminated */
      }
      resolve(result)
    }
    const onAbort = () => finish(unknownOutcome('simulation was cancelled; outcome unknown'))
    timer = setTimeout(() => {
      finish(unknownOutcome(`simulation exceeded timeoutMs=${timeoutMs}; outcome unknown`))
    }, timeoutMs)
    try {
      signal?.addEventListener?.('abort', onAbort, { once: true })
    } catch {
      /* signal may be foreign */
    }

    try {
      worker = new Worker(WORKER_FILE, {
        workerData,
        // Never inherit CLI flags (e.g. --test / --input-type) into the
        // isolated thread: the worker must run exactly this local module.
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: MAX_RESOURCE_LIMIT_MB },
      })
    } catch {
      finish(unknownOutcome('simulation worker could not be started; outcome unknown'))
      return
    }
    worker.once('message', (message) => {
      if (isRecord(message) && message.ok === true && Array.isArray(message.records)) {
        finish({ ok: true, records: message.records })
        return
      }
      finish(unknownOutcome('simulation worker failed; outcome unknown'))
    })
    worker.once('error', () => finish(unknownOutcome('simulation worker crashed; outcome unknown')))
    worker.once('messageerror', () => finish(unknownOutcome('simulation worker message was invalid; outcome unknown')))
    worker.once('exit', (code) => {
      if (settled) return
      finish(unknownOutcome(`simulation worker exited (code ${code === null ? 'null' : code}) without records; outcome unknown`))
    })
  })
}
