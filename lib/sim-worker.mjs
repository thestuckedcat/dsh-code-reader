// dsh-code-reader: isolated Wasm simulation worker (scenario contract §1).
//
// This file runs inside a `worker_threads` thread spawned by
// lib/sim-runner.mjs. The parent passes the engine-signed module bytes, the
// ordered steps and the profile trace table through `workerData`; the worker
// reads no files, opens no sockets and imports nothing but `node:crypto` (for
// the memory digest) and `node:worker_threads` (the message port). The only
// host callback the module receives is `env.trace`.
//
// It returns one record per step ({step_index,interface,args,status,result,
// memory_digest,elapsed_ms,events}) and never leaks stack traces or paths:
// failures are reported as fixed {ok:false,error:{code,message}} messages.
import { createHash } from 'node:crypto'
import { parentPort, workerData } from 'node:worker_threads'

const MAX_STEPS = 20
const MAX_ARGS_PER_STEP = 8
const MAX_EVENTS_PER_STEP = 256
const UINT32_MAX = 0xffffffff
const INT32_MIN = -0x80000000

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(code, message) {
  parentPort?.postMessage({ ok: false, error: { code, message } })
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Normalize a trace argument to signed 32-bit semantics (uint32 wraps too). */
function toInt32(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value | 0 : 0
}

/**
 * Build code → event-name lookup from the profile trace table. Both directions
 * observed in the contract/fixture are accepted: `{"1":"NAME"}` and
 * `{"NAME":1}`.
 */
function traceEventTable(traceSpec) {
  const byCode = new Map()
  const events = isRecord(traceSpec) ? traceSpec.events : undefined
  if (!isRecord(events)) return byCode
  const entries = Object.entries(events)
  if (entries.length > 0 && entries.every(([key]) => /^\d+$/.test(key))) {
    for (const [code, name] of entries) {
      if (typeof name === 'string' && name.length > 0) byCode.set(Number(code), name)
    }
    return byCode
  }
  for (const [name, code] of entries) {
    if (typeof code === 'number' && Number.isInteger(code)) byCode.set(code, name)
  }
  return byCode
}

function prepareSteps(rawSteps) {
  if (!Array.isArray(rawSteps)) throw new Error('steps must be an array')
  if (rawSteps.length > MAX_STEPS) throw new Error('steps exceed the contract budget')
  return rawSteps.map((step, index) => {
    if (!isRecord(step) || typeof step.interface !== 'string' || step.interface.length === 0) {
      throw new Error(`step ${index} is malformed`)
    }
    if (!Array.isArray(step.args) || step.args.length > MAX_ARGS_PER_STEP) {
      throw new Error(`step ${index} args are malformed`)
    }
    const args = step.args.map((arg) => {
      if (!Number.isSafeInteger(arg) || arg < INT32_MIN || arg > UINT32_MAX) {
        throw new Error(`step ${index} arg is not a 32-bit integer`)
      }
      return arg
    })
    return { interface: step.interface, args }
  })
}

async function main() {
  const data = isRecord(workerData) ? workerData : {}
  if (typeof data.moduleB64 !== 'string' || data.moduleB64.length === 0) {
    fail('INVALID_ARGUMENT', 'workerData.moduleB64 is required')
    return
  }
  if (typeof data.moduleSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(data.moduleSha256)) {
    fail('INVALID_ARGUMENT', 'workerData.moduleSha256 must be 64 lowercase hex characters')
    return
  }
  let steps
  try {
    steps = prepareSteps(data.steps)
  } catch {
    fail('INVALID_ARGUMENT', 'workerData.steps are malformed')
    return
  }
  let moduleBytes
  try {
    moduleBytes = Buffer.from(data.moduleB64, 'base64')
  } catch {
    fail('INVALID_ARGUMENT', 'workerData.moduleB64 is not valid base64')
    return
  }
  if (moduleBytes.length === 0) {
    fail('INVALID_ARGUMENT', 'module bytes are empty')
    return
  }
  // Defense in depth: never instantiate bytes that do not match the engine
  // signed hash the parent was given.
  if (sha256Hex(moduleBytes) !== data.moduleSha256) {
    fail('MODULE_HASH_MISMATCH', 'module bytes do not match the engine-signed sha256')
    return
  }

  const eventNamesByCode = traceEventTable(data.traceSpec)
  let stepEvents = []
  const imports = {
    env: {
      trace: (code, a, b, c, line) => {
        const value = toInt32(code)
        const name = eventNamesByCode.get(value)
        // Only profile-declared events are recorded so `scenario-record` never
        // receives an event the profile cannot explain.
        if (name === undefined || stepEvents.length >= MAX_EVENTS_PER_STEP) return
        stepEvents.push({ event: name, code: value, a: toInt32(a), b: toInt32(b), c: toInt32(c), line: toInt32(line) })
      },
    },
  }

  let instance
  try {
    ;({ instance } = await WebAssembly.instantiate(moduleBytes, imports))
  } catch {
    fail('INSTANTIATE_FAILED', 'the Wasm module could not be instantiated')
    return
  }
  const exports = instance.exports
  if (!(exports.memory instanceof WebAssembly.Memory)) {
    fail('MODULE_BINDING_INVALID', 'the Wasm module must export its memory')
    return
  }

  const records = []
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    const fn = exports[step.interface]
    if (typeof fn !== 'function') {
      fail('UNKNOWN_INTERFACE', `the Wasm module has no exported interface "${step.interface.slice(0, 64)}"`)
      return
    }
    stepEvents = []
    const started = process.hrtime.bigint()
    let result = null
    let status = 'ok'
    try {
      const value = fn(...step.args)
      result = typeof value === 'number' ? toInt32(value) : null
      status = result !== null && result < 0 ? 'error' : 'ok'
    } catch {
      result = null
      status = 'error'
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    records.push({
      step_index: index,
      interface: step.interface,
      args: step.args.slice(),
      status,
      result,
      memory_digest: sha256Hex(new Uint8Array(exports.memory.buffer)),
      elapsed_ms: Math.max(0, Math.round(elapsedMs)),
      events: stepEvents,
    })
  }
  parentPort?.postMessage({ ok: true, records })
}

main().catch(() => {
  try {
    parentPort?.postMessage({ ok: false, error: { code: 'OUTCOME_UNKNOWN', message: 'simulation worker failed' } })
  } catch {
    /* port already closed */
  }
})
