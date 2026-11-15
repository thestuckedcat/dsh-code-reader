// dsh-code-reader S3a: isolated Wasm simulation runner.
//
// These tests use the committed trusted Demo fixture (evidence/scenario-sim:
// bus.wasm + sim-profile.json) and assert real execution records, stub failure
// propagation, argument/interface rejection, timeout termination, the memory
// digest and the worker import surface (no fs/network).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_TIMEOUT_MS,
  MAX_RESOURCE_LIMIT_MB,
  MAX_TIMEOUT_MS,
  runSimulation,
} from '../../lib/sim-runner.mjs'

const FIXTURE_DIR = fileURLToPath(new URL('../../evidence/scenario-sim/inbox/', import.meta.url))
const WORKER_SOURCE = readFileSync(fileURLToPath(new URL('../../lib/sim-worker.mjs', import.meta.url)), 'utf8')
const RUNNER_SOURCE = readFileSync(fileURLToPath(new URL('../../lib/sim-runner.mjs', import.meta.url)), 'utf8')
const MODULE_BYTES = readFileSync(`${FIXTURE_DIR}bus.wasm`)
const PROFILE = JSON.parse(readFileSync(`${FIXTURE_DIR}sim-profile.json`, 'utf8'))
const MODULE_B64 = MODULE_BYTES.toString('base64')
const MODULE_SHA256 = createHash('sha256').update(MODULE_BYTES).digest('hex')

const BASE = Object.freeze({
  moduleB64: MODULE_B64,
  moduleSha256: MODULE_SHA256,
  interfaces: PROFILE.interfaces,
  traceSpec: PROFILE.trace,
  eventResourceSpec: PROFILE.event_resources,
  timeoutMs: 5_000,
})

function run(steps, overrides = {}) {
  return runSimulation({ ...BASE, steps, ...overrides })
}

function eventNames(record) {
  return record.events.map((event) => event.event)
}

const HAPPY_STEPS = [
  { interface: 'reset', args: [] },
  { interface: 'bus_register', args: [1] },
  { interface: 'bus_send', args: [1, 48] },
]

test('runs the real Demo Wasm and returns one isolated record per step', async () => {
  const result = await run(HAPPY_STEPS)
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 500))
  assert.equal(result.records.length, 3)
  assert.deepEqual(result.records.map((record) => record.result), [null, 0, 0])
  assert.deepEqual(result.records.map((record) => record.status), ['ok', 'ok', 'ok'])
  assert.deepEqual(result.records.map((record) => record.step_index), [0, 1, 2])

  assert.deepEqual(eventNames(result.records[1]), ['DEFAULT_ROUTE', 'STORE_ROUTE'])
  const sendEvents = eventNames(result.records[2])
  for (const expected of [
    'REQUEST',
    'LOOKUP',
    'CHECK_LENGTH',
    'LOCK',
    'TRANSFER',
    'DIRECT',
    'COMMIT',
    'ENCODE',
    'DOORBELL',
    'LIBRARY',
    'WRITE',
  ]) {
    assert.ok(sendEvents.includes(expected), `missing send event ${expected}: ${sendEvents}`)
  }
  const write = result.records[2].events.find((event) => event.event === 'WRITE')
  assert.equal(write.code, PROFILE.trace.events.WRITE)
  assert.deepEqual([write.a, write.b, write.c], [0x1040, 0x20030, 0])
  assert.ok(Number.isInteger(write.line) && write.line > 0)

  for (const record of result.records) {
    assert.deepEqual(Object.keys(record).sort(), [
      'args',
      'elapsed_ms',
      'events',
      'interface',
      'memory_digest',
      'result',
      'status',
      'step_index',
    ])
    assert.match(record.memory_digest, /^[0-9a-f]{64}$/)
    assert.ok(Number.isInteger(record.elapsed_ms) && record.elapsed_ms >= 0)
    for (const event of record.events) {
      assert.equal(typeof event.event, 'string')
      assert.ok(Number.isInteger(event.code))
      assert.ok(Number.isInteger(event.a) && Number.isInteger(event.b) && Number.isInteger(event.c))
      assert.ok(Number.isInteger(event.line))
    }
  }
  // Instance state was mutated by register/send, so the digest changes.
  assert.notEqual(result.records[0].memory_digest, result.records[2].memory_digest)

  // Every run gets a fresh instance: results/events are deterministic.
  const again = await run(HAPPY_STEPS)
  assert.equal(again.ok, true)
  assert.deepEqual(
    again.records.map((record) => ({ result: record.result, status: record.status, events: eventNames(record) })),
    result.records.map((record) => ({ result: record.result, status: record.status, events: eventNames(record) })),
  )
})

test('a platform stub return code propagates and suppresses the doorbell write', async () => {
  const result = await run([
    { interface: 'reset', args: [] },
    { interface: 'bus_register', args: [1] },
    { interface: 'set_platform_stub', args: [-5] },
    { interface: 'bus_send', args: [1, 48] },
  ])
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 500))
  assert.deepEqual(result.records.map((record) => record.result), [null, 0, null, -5])
  assert.deepEqual(result.records.map((record) => record.status), ['ok', 'ok', 'ok', 'error'])
  const send = result.records[3]
  assert.equal(eventNames(send).includes('WRITE'), false)
  const lock = send.events.filter((event) => event.event === 'LOCK').map((event) => event.a)
  assert.deepEqual(lock, [1, 0], 'the transfer lock must be acquired and released')
})

test('negative return codes become error records while later steps still run', async () => {
  const result = await run([
    { interface: 'bus_register', args: [1] },
    { interface: 'bus_send', args: [0, 48] },
    { interface: 'bus_send', args: [1, 65] },
    { interface: 'bus_send', args: [1, 0] },
  ])
  assert.equal(result.ok, true)
  assert.deepEqual(result.records.map((record) => record.result), [0, -2, -90, -22])
  assert.deepEqual(result.records.map((record) => record.status), ['ok', 'error', 'error', 'error'])
})

test('rejects unknown interfaces, bad arity and out-of-range arguments before spawning', async () => {
  const cases = [
    [[{ interface: 'does_not_exist', args: [] }], /not in the profile/],
    [[{ interface: 'bus_register', args: [] }], /expects 1 arguments/],
    [[{ interface: 'bus_register', args: [9] }], /above max/],
    [[{ interface: 'bus_send', args: [1] }], /expects 2 arguments/],
    [[{ interface: 'set_platform_stub', args: [1] }], /above max/],
    [[{ interface: 'bus_send', args: [1, 1.5] }], /32-bit integer/],
    [[{ interface: 'bad interface!', args: [] }], /bounded identifier/],
    [[{ interface: 'bus_send', args: new Array(9).fill(0) }], /at most 8/],
    [Array.from({ length: 21 }, () => ({ interface: 'reset', args: [] })), /at most 20/],
  ]
  for (const [steps, message] of cases) {
    const result = await run(steps)
    assert.equal(result.ok, false, JSON.stringify(steps))
    assert.equal(result.error.code, 'INVALID_ARGUMENT')
    assert.match(result.error.message, message)
  }
})

test('times out to OUTCOME_UNKNOWN and enforces the timeout budget', async () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 10_000)
  assert.equal(MAX_TIMEOUT_MS, 30_000)
  assert.equal(MAX_RESOURCE_LIMIT_MB, 64)

  const timedOut = await run([{ interface: 'reset', args: [] }], { timeoutMs: 1 })
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.error.code, 'OUTCOME_UNKNOWN')
  assert.match(timedOut.error.message, /timeoutMs=1/)

  for (const timeoutMs of [0, 30_001, 1.5, '1000']) {
    const result = await run([{ interface: 'reset', args: [] }], { timeoutMs })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'INVALID_ARGUMENT')
  }
})

test('rejects module bytes that do not match the engine-signed sha256', async () => {
  const result = await run([{ interface: 'reset', args: [] }], { moduleSha256: 'a'.repeat(64) })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'OUTCOME_UNKNOWN')

  const emptyModule = await runSimulation({ ...BASE, moduleB64: '!!!', steps: [{ interface: 'reset', args: [] }] })
  assert.equal(emptyModule.ok, false)
  assert.equal(emptyModule.error.code, 'OUTCOME_UNKNOWN')
})

test('pre-aborted cancellation returns OUTCOME_UNKNOWN without executing', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await run([{ interface: 'reset', args: [] }], { signal: controller.signal })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'OUTCOME_UNKNOWN')
  assert.match(result.error.message, /cancelled/)
})

test('the worker has no filesystem or network import surface', () => {
  const imports = WORKER_SOURCE.split('\n')
    .filter((line) => line.startsWith('import '))
    .map((line) => /^import\s+.*\sfrom\s+'([^']+)'/.exec(line)?.[1])
  assert.deepEqual(imports.sort(), ['node:crypto', 'node:worker_threads'])
  assert.equal(/node:(fs|http|https|net|dgram|tls|child_process|inspector)/.test(WORKER_SOURCE), false)
  assert.equal(/fetch\s*\(/.test(WORKER_SOURCE), false)
  assert.equal(/import\s*\(/.test(WORKER_SOURCE), false)
  // The real module's only host import is env.trace.
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(MODULE_BYTES)), [
    { module: 'env', name: 'trace', kind: 'function' },
  ])
  // The parent owns the 64 MB old-generation cap.
  assert.match(RUNNER_SOURCE, /maxOldGenerationSizeMb:\s*MAX_RESOURCE_LIMIT_MB/)
  assert.match(RUNNER_SOURCE, /execArgv:\s*\[\]/)
})
