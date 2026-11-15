// dsh-code-reader S3a: scenario endpoints, orchestration and ledger safety.
//
// The engine bridge and the isolated runner are scripted here so the tests can
// assert the fixed plan→module→worker→record order, the engine-error passthrough
// and that a worker timeout/crash/cancel never reaches `scenario-record`. The
// happy path still runs the real Demo Wasm through lib/sim-runner.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { registerWorkbenchHttpRoute } from '../../lib/http-rpc.mjs'
import { createViewService, VIEW_ENDPOINTS } from '../../lib/view-service.mjs'
import {
  createScenarioService,
  createWorkbenchDispatch,
  SCENARIO_ENDPOINTS,
} from '../../lib/scenario-service.mjs'
import { resolveSettings } from '../../lib/config.mjs'

const FIXTURE_DIR = fileURLToPath(new URL('../../evidence/scenario-sim/inbox/', import.meta.url))
const MODULE_BYTES = readFileSync(`${FIXTURE_DIR}bus.wasm`)
const PROFILE = JSON.parse(readFileSync(`${FIXTURE_DIR}sim-profile.json`, 'utf8'))
const MODULE_B64 = MODULE_BYTES.toString('base64')
const MODULE_SHA256 = createHash('sha256').update(MODULE_BYTES).digest('hex')

const WORKSPACE = 'code-view-bus-demo'
const SNAPSHOT_ID = 'ed326d554334432b907de21297207eb8'
const PROFILE_ID = 'bus-demo-wasm'
const SCENARIO_REF = 'scn_0123456789ab'
const PLAN_ID = 'plan_01abcdef2345'

const SCENARIO = {
  generation: 0,
  stop_on_error: true,
  steps: [
    { interface: 'reset', args: [] },
    { interface: 'bus_register', args: [1] },
    { interface: 'bus_send', args: [1, 48] },
  ],
}
const PLAN_STEPS = [
  { index: 0, interface: 'reset', role: 'util', args: [] },
  { index: 1, interface: 'bus_register', role: 'entry', args: [1] },
  { index: 2, interface: 'bus_send', role: 'entry', args: [1, 48] },
]
const PLAN_DOC = {
  schema_version: 1,
  plan_id: PLAN_ID,
  profile_id: PROFILE_ID,
  module_sha256: MODULE_SHA256,
  scenario_id: SCENARIO_REF,
  scenario_digest: 'd'.repeat(64),
  generation: 0,
  steps: PLAN_STEPS,
  trace: PROFILE.trace,
  limits: { timeout_ms: 10_000, steps: 20, events_per_step: 256 },
  expires_at: '2026-11-15T16:00:00Z',
  limitations: [],
}
const MODULE_DOC = {
  schema_version: 1,
  plan_id: PLAN_ID,
  module_b64: MODULE_B64,
  module_sha256: MODULE_SHA256,
  profile: { profile_id: PROFILE_ID, label: PROFILE.label, binding: PROFILE.binding, interfaces: PROFILE.interfaces },
  trace: PROFILE.trace,
  event_resources: PROFILE.event_resources,
}
const LEDGER_DOC = {
  schema_version: 1,
  scenario_id: SCENARIO_REF,
  generation: 1,
  profile_id: PROFILE_ID,
  workspace_id: WORKSPACE,
  snapshot_id: SNAPSHOT_ID,
  variant_id: 'semantic-x86_64',
  repo_id: 'bus',
  scenario_digest: 'd'.repeat(64),
  records_digest: 'e'.repeat(64),
  observed: true,
  created_at: '2026-11-15T15:40:00Z',
  records: [],
  limitations: ['wasm_simulation_not_real_device'],
}

// --- S3b fixtures ----------------------------------------------------------
const UNDO_PLAN_ID = 'undo_0123456789abcdef0123456789abcdef'
const PREFIX_STEPS = [
  { index: 0, interface: 'reset', args: [] },
  { index: 1, interface: 'bus_register', args: [1] },
]
const UNDO_PLAN_DOC = {
  schema_version: 1,
  undo_plan_id: UNDO_PLAN_ID,
  kind: 'undo',
  source: { scenario_id: SCENARIO_REF, generation: 2, step_count: 3 },
  count: 1,
  prefix: {
    scenario_id: 'scn_abcdef123456',
    generation: 1,
    step_count: 2,
    steps: PREFIX_STEPS,
    scenario_digest: 'f'.repeat(64),
    expected_records_digest: '9'.repeat(64),
  },
  expected_prefix: [
    { step_index: 0, memory_digest: '1'.repeat(64), result: null, status: 'ok' },
    { step_index: 1, memory_digest: '2'.repeat(64), result: 0, status: 'ok' },
  ],
  profile_id: PROFILE_ID,
  module_sha256: MODULE_SHA256,
  limits: { timeout_ms: 10_000, steps: 20, events_per_step: 256 },
  expires_at: '2026-11-15T18:00:00Z',
  limitations: ['replay_verified_by_memory_digest', 'wasm_simulation_not_real_device'],
}
const UNDO_LEDGER_DOC = {
  ...LEDGER_DOC,
  scenario_id: 'scn_abcdef123456',
  generation: 1,
  undo: { of_scenario_id: SCENARIO_REF, of_generation: 2, count: 1, state_digest_verified: true },
}
const IMPORTED_LEDGER_DOC = {
  schema_version: 1,
  scenario_id: 'scn_feedface1234',
  generation: 1,
  imported: true,
  source: 'imported_trace',
  label: '外部采集 bus_send 轨迹（示例）',
  observed: true,
  records: [],
  limitations: ['imported_trace_not_executed_by_host', 'resource_effects_unknown_for_imported_trace'],
}

const cliOk = (cli) => ({ schema_version: 1, ok: true, exit_code: 0, cli })
const cliEngineError = (code, message) => ({
  schema_version: 1,
  ok: false,
  exit_code: 2,
  cli: { schema_version: 1, error: { code, message, details_ref: null, retryable: false }, operation_id: null },
})

function scenarioB64() {
  return Buffer.from(JSON.stringify(SCENARIO), 'utf8').toString('base64')
}

function previewPayload(overrides = {}) {
  return { workspace: WORKSPACE, snapshot: SNAPSHOT_ID, profile: PROFILE_ID, scenario: SCENARIO, ...overrides }
}

function runPayload(overrides = {}) {
  return { ...previewPayload(), expected_generation: 0, ...overrides }
}

function happyScript({ recordResult } = {}) {
  return (argv) => {
    if (argv[0] === 'scenario-plan') return cliOk(PLAN_DOC)
    if (argv[0] === 'scenario-module') return cliOk(MODULE_DOC)
    if (argv[0] === 'scenario-record') return recordResult ?? cliOk(LEDGER_DOC)
    return cliEngineError('INVALID_ARGUMENT', `unexpected command ${argv[0]}`)
  }
}

function undoScript({ recordResult } = {}) {
  return (argv) => {
    if (argv[0] === 'scenario-undo-plan') return cliOk(UNDO_PLAN_DOC)
    if (argv[0] === 'scenario-module') return cliOk(MODULE_DOC)
    if (argv[0] === 'scenario-undo-record') return recordResult ?? cliOk(UNDO_LEDGER_DOC)
    return cliEngineError('INVALID_ARGUMENT', `unexpected command ${argv[0]}`)
  }
}

function undoPayload(overrides = {}) {
  return { workspace: WORKSPACE, scenario: SCENARIO_REF, count: 1, expected_generation: 2, ...overrides }
}

function scriptedBridge(handler) {
  const calls = []
  const operationIds = []
  return {
    calls,
    operationIds,
    resolvePython: async () => 'python3',
    async execute(argv, options = {}) {
      calls.push({ argv, options })
      return handler(argv, options)
    },
    newOperationId() {
      const id = `op-host-${operationIds.length + 1}`
      operationIds.push(id)
      return id
    },
  }
}

function createFakeHost() {
  const state = { routes: new Map(), effects: [] }
  const ctx = {
    connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
    webServer: {
      register(route) {
        state.routes.set(route.path, route)
        return () => state.routes.delete(route.path)
      },
    },
    effect(callback, label) {
      const disposer = callback()
      state.effects.push({ label, disposer })
      return disposer
    },
  }
  return { ctx, state }
}

function createRequest({ url, body }) {
  return {
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    consumed: false,
    on() {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body, 'utf8')
    },
  }
}

function createResponse() {
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      response.statusCode = status
      response.headers = { ...headers }
    },
    end(chunk = '') {
      response.body = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    },
  }
  return response
}

const settings = resolveSettings({})

function mountWorkbench({ bridge, runner } = {}) {
  const host = createFakeHost()
  const viewService = createViewService({ bridge, settings })
  const scenarioService = createScenarioService({ bridge, settings, ...(runner === undefined ? {} : { runner }) })
  const dispose = registerWorkbenchHttpRoute(host.ctx, {
    channel: '/code-view',
    methods: [...VIEW_ENDPOINTS, ...SCENARIO_ENDPOINTS],
    handler: createWorkbenchDispatch({ viewService, scenarioService }),
  })
  return {
    route: host.state.routes.get('/code-view'),
    state: host.state,
    dispose,
    viewService,
    scenarioService,
  }
}

async function invoke(route, endpoint, payload) {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: 'scenario-rpc-1',
    method: endpoint,
    payload,
  })
  const response = createResponse()
  await route.handler(createRequest({ url: `/code-view/${endpoint}`, body }), response)
  return { response, json: response.body ? JSON.parse(response.body) : undefined }
}

test('rejects malformed scenario endpoints before any engine call', async () => {
  const bridge = scriptedBridge(happyScript())
  const { route } = mountWorkbench({ bridge })
  const cases = [
    ['scenario.listProfiles', {}, /workspace is required/],
    ['scenario.listProfiles', { workspace: 'Bad' }, /workspace must match/],
    ['scenario.listProfiles', { workspace: WORKSPACE, extra: 1 }, /unknown payload field: extra/],
    ['scenario.list', { workspace: WORKSPACE, snapshot: SNAPSHOT_ID }, /unknown payload field: snapshot/],
    ['scenario.get', { workspace: WORKSPACE }, /scenario is required/],
    ['scenario.get', { workspace: WORKSPACE, scenario: '../etc/passwd' }, /scenario must match/],
    ['scenario.preview', { workspace: WORKSPACE, snapshot: SNAPSHOT_ID, profile: PROFILE_ID }, /scenario is required/],
    ['scenario.preview', previewPayload({ profile: 'Bad Profile' }), /profile must match/],
    ['scenario.preview', previewPayload({ scenario: { ...SCENARIO, generation: -1 } }), /generation must be an integer/],
    ['scenario.preview', previewPayload({ scenario: { ...SCENARIO, unknown: true } }), /unknown scenario field/],
    [
      'scenario.preview',
      previewPayload({ scenario: { ...SCENARIO, steps: Array.from({ length: 21 }, () => ({ interface: 'reset', args: [] })) } }),
      /at most 20 steps/,
    ],
    [
      'scenario.preview',
      previewPayload({ scenario: { ...SCENARIO, steps: [{ interface: 'reset', args: [1.5] }] } }),
      /32-bit integer/,
    ],
    [
      'scenario.preview',
      previewPayload({ scenario: { ...SCENARIO, steps: [{ interface: 'reset', args: [], extra: 1 }] } }),
      /unknown scenario step field/,
    ],
    ['scenario.preview', previewPayload({ module: 'bus.wasm' }), /unknown payload field: module/],
    ['scenario.preview', previewPayload({ path: 'C:/x' }), /unknown payload field: path/],
    ['scenario.run', runPayload({ expected_generation: undefined }), /expected_generation is required/],
    ['scenario.run', runPayload({ expected_generation: -1 }), /expected_generation must be an integer/],
    ['scenario.run', runPayload({ extra: true }), /unknown payload field: extra/],
    ['scenario.run', runPayload({ workspace: 'a'.repeat(129) }), /at most 128 characters/],
  ]
  for (const [endpoint, payload, message] of cases) {
    const result = await invoke(route, endpoint, payload)
    assert.equal(result.response.statusCode, 200, endpoint)
    assert.equal(result.json.result.ok, false, `${endpoint} ${JSON.stringify(payload)}`)
    assert.equal(result.json.result.error.code, 'INVALID_ARGUMENT', endpoint)
    assert.match(result.json.result.error.message, message, `${endpoint} ${JSON.stringify(payload)}`)
  }
  assert.equal(bridge.calls.length, 0, 'invalid payloads must never reach the engine')
})

test('scenario.listProfiles/list/get map to the fixed argv and pass engine JSON through', async () => {
  const profilesDoc = { schema_version: 1, profiles: [{ profile_id: PROFILE_ID }] }
  const listDoc = { schema_version: 1, scenarios: [] }
  const getDoc = { schema_version: 1, scenario_id: SCENARIO_REF, generation: 1 }
  const bridge = scriptedBridge((argv) => {
    if (argv[0] === 'sim-profile-list') return cliOk(profilesDoc)
    if (argv[0] === 'scenario-list') return cliOk(listDoc)
    if (argv[0] === 'scenario-get') return cliOk(getDoc)
    return cliEngineError('INVALID_ARGUMENT', 'unexpected command')
  })
  const { route } = mountWorkbench({ bridge })

  let result = await invoke(route, 'scenario.listProfiles', { workspace: WORKSPACE })
  assert.equal(result.json.result.ok, true)
  assert.deepEqual(result.json.result.value, profilesDoc)
  assert.deepEqual(bridge.calls.at(-1).argv, ['sim-profile-list', '--workspace', WORKSPACE])

  result = await invoke(route, 'scenario.list', { workspace: WORKSPACE })
  assert.deepEqual(result.json.result.value, listDoc)
  assert.deepEqual(bridge.calls.at(-1).argv, ['scenario-list', '--workspace', WORKSPACE])

  result = await invoke(route, 'scenario.get', { workspace: WORKSPACE, scenario: SCENARIO_REF })
  assert.deepEqual(result.json.result.value, getDoc)
  assert.deepEqual(bridge.calls.at(-1).argv, ['scenario-get', '--workspace', WORKSPACE, '--scenario', SCENARIO_REF])
})

test('scenario.preview maps to scenario-plan without expected_generation', async () => {
  const bridge = scriptedBridge(happyScript())
  const { route } = mountWorkbench({ bridge })
  const result = await invoke(route, 'scenario.preview', previewPayload())
  assert.equal(result.json.result.ok, true)
  assert.deepEqual(result.json.result.value, PLAN_DOC)
  assert.equal(bridge.calls.length, 1)
  assert.deepEqual(bridge.calls[0].argv, [
    'scenario-plan',
    '--workspace', WORKSPACE,
    '--snapshot', SNAPSHOT_ID,
    '--profile', PROFILE_ID,
    '--scenario-json', scenarioB64(),
  ])
  assert.equal(bridge.operationIds.length, 0, 'preview must not touch the ledger')

  const errorDoc = { schema_version: 1, error: { code: 'STALE_SNAPSHOT', message: 'hash mismatch' }, operation_id: null }
  const errorBridge = scriptedBridge(() => ({ schema_version: 1, ok: false, exit_code: 2, cli: errorDoc }))
  const errorMount = mountWorkbench({ bridge: errorBridge })
  const errorResult = await invoke(errorMount.route, 'scenario.preview', previewPayload())
  assert.equal(errorResult.json.result.ok, true)
  assert.deepEqual(errorResult.json.result.value, errorDoc)
})

test('scenario.run orchestrates plan→module→isolated worker→record and returns the ledger', async () => {
  const bridge = scriptedBridge(happyScript())
  const { route } = mountWorkbench({ bridge })
  const result = await invoke(route, 'scenario.run', runPayload())
  assert.equal(result.json.result.ok, true, JSON.stringify(result.json).slice(0, 600))
  assert.deepEqual(result.json.result.value, LEDGER_DOC)
  assert.equal(bridge.calls.length, 3)

  assert.deepEqual(bridge.calls[0].argv, [
    'scenario-plan',
    '--workspace', WORKSPACE,
    '--snapshot', SNAPSHOT_ID,
    '--profile', PROFILE_ID,
    '--scenario-json', scenarioB64(),
    '--expected-generation', '0',
  ])
  assert.deepEqual(bridge.calls[1].argv, ['scenario-module', '--plan', PLAN_ID])

  const recordArgv = bridge.calls[2].argv
  assert.equal(recordArgv[0], 'scenario-record')
  assert.deepEqual(recordArgv.slice(1, 3), ['--plan', PLAN_ID])
  assert.equal(recordArgv[3], '--records-json')
  assert.equal(recordArgv[5], '--operation-id')
  assert.equal(bridge.operationIds.length, 1)
  assert.equal(recordArgv[6], bridge.operationIds[0])

  const recordsPayload = JSON.parse(Buffer.from(recordArgv[4], 'base64').toString('utf8'))
  assert.equal(recordsPayload.records.length, 3)
  assert.deepEqual(recordsPayload.records.map((record) => record.interface), ['reset', 'bus_register', 'bus_send'])
  assert.deepEqual(recordsPayload.records.map((record) => record.result), [null, 0, 0])
  assert.deepEqual(recordsPayload.records.map((record) => record.status), ['ok', 'ok', 'ok'])
  for (const record of recordsPayload.records) {
    assert.match(record.memory_digest, /^[0-9a-f]{64}$/)
    assert.ok(Array.isArray(record.events))
  }
  const sendEvents = recordsPayload.records[2].events.map((event) => event.event)
  assert.ok(sendEvents.includes('WRITE'))
  assert.ok(sendEvents.includes('DOORBELL'))
})

test('scenario.run declares expected_generation for the engine generation CAS', async () => {
  const bridge = scriptedBridge(happyScript())
  const { route } = mountWorkbench({ bridge })
  // The browser may send the current generation (0) or the generation this run
  // will write (1); the Host declares the requested expected_generation so the
  // engine Host-run CAS path (declared == expected == current + 1) is hit.
  const result = await invoke(route, 'scenario.run', runPayload({ expected_generation: 1 }))
  assert.equal(result.json.result.ok, true)
  const planArgv = bridge.calls[0].argv
  assert.equal(planArgv[planArgv.indexOf('--expected-generation') + 1], '1')
  const declared = JSON.parse(Buffer.from(planArgv[planArgv.indexOf('--scenario-json') + 1], 'base64').toString('utf8'))
  assert.equal(declared.generation, 1)
  assert.deepEqual(declared.steps, SCENARIO.steps)
  assert.equal(declared.stop_on_error, true)

  // Preview never rewrites: it stays the contract-style "current generation" call.
  const previewBridge = scriptedBridge(happyScript())
  const previewMount = mountWorkbench({ bridge: previewBridge })
  await invoke(previewMount.route, 'scenario.preview', previewPayload({ scenario: { ...SCENARIO, generation: 3 } }))
  const previewArgv = previewBridge.calls[0].argv
  const previewDeclared = JSON.parse(
    Buffer.from(previewArgv[previewArgv.indexOf('--scenario-json') + 1], 'base64').toString('utf8'),
  )
  assert.equal(previewDeclared.generation, 3)
  assert.equal(previewArgv.includes('--expected-generation'), false)
})

test('engine validation failures are returned verbatim and stop the pipeline', async () => {
  const planError = {
    schema_version: 1,
    error: { code: 'STALE_PLAN', message: 'ledger generation moved', details_ref: null, retryable: false },
    operation_id: null,
  }
  const bridge = scriptedBridge(() => ({ schema_version: 1, ok: false, exit_code: 2, cli: planError }))
  const { route } = mountWorkbench({ bridge })
  const result = await invoke(route, 'scenario.run', runPayload())
  assert.equal(result.json.result.ok, true)
  assert.deepEqual(result.json.result.value, planError)
  assert.equal(bridge.calls.length, 1, 'module/worker/record must not run after a plan failure')
  assert.equal(bridge.operationIds.length, 0)
})

test('a worker OUTCOME_UNKNOWN never writes the ledger', async () => {
  const bridge = scriptedBridge(happyScript())
  let runnerCalls = 0
  const runner = async () => {
    runnerCalls += 1
    return { ok: false, error: { code: 'OUTCOME_UNKNOWN', message: 'simulation exceeded timeoutMs=1' } }
  }
  const { route } = mountWorkbench({ bridge, runner })
  const result = await invoke(route, 'scenario.run', runPayload())
  assert.equal(result.json.result.ok, false)
  assert.equal(result.json.result.error.code, 'OUTCOME_UNKNOWN')
  assert.equal(result.json.result.error.message, 'isolated simulation failed (timeout, crash or cancellation); outcome unknown')
  assert.deepEqual(result.json.result.error.details, {})
  assert.equal(runnerCalls, 1)
  assert.deepEqual(bridge.calls.map((call) => call.argv[0]), ['scenario-plan', 'scenario-module'])
  assert.equal(bridge.operationIds.length, 0, 'no ledger write may be attempted')
})

test('malformed worker records are rejected before the ledger write', async () => {
  const bridge = scriptedBridge(happyScript())
  const { route } = mountWorkbench({ bridge, runner: async () => ({ ok: true, records: [] }) })
  const result = await invoke(route, 'scenario.run', runPayload())
  assert.equal(result.json.result.ok, false)
  assert.equal(result.json.result.error.code, 'ENGINE_FAILED')
  assert.deepEqual(bridge.calls.map((call) => call.argv[0]), ['scenario-plan', 'scenario-module'])
  assert.equal(bridge.operationIds.length, 0)
})

test('an INVALID_ARGUMENT runner failure is surfaced without a ledger write', async () => {
  const bridge = scriptedBridge(happyScript())
  const { route } = mountWorkbench({
    bridge,
    runner: async () => ({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'step 0 interface is not in the profile' } }),
  })
  const result = await invoke(route, 'scenario.run', runPayload())
  assert.equal(result.json.result.ok, false)
  assert.equal(result.json.result.error.code, 'INVALID_ARGUMENT')
  assert.match(result.json.result.error.message, /not in the profile/)
  assert.equal(bridge.calls.some((call) => call.argv[0] === 'scenario-record'), false)
})

test('engine record failures are returned verbatim after exactly one record attempt', async () => {
  const recordError = {
    schema_version: 1,
    error: { code: 'STATE_CONFLICT', message: 'ledger generation changed', details_ref: null, retryable: false },
    operation_id: null,
  }
  const bridge = scriptedBridge(happyScript({ recordResult: cliEngineError('STATE_CONFLICT', 'ledger generation changed') }))
  const { route } = mountWorkbench({ bridge })
  const result = await invoke(route, 'scenario.run', runPayload())
  assert.equal(result.json.result.ok, true)
  assert.deepEqual(result.json.result.value, recordError)
  assert.equal(bridge.calls.filter((call) => call.argv[0] === 'scenario-record').length, 1)
  assert.equal(bridge.operationIds.length, 1)
})

test('each run gets its own Host-owned operation id while records stay deterministic', async () => {
  const bridge = scriptedBridge(happyScript())
  const { route } = mountWorkbench({ bridge })
  await invoke(route, 'scenario.run', runPayload())
  await invoke(route, 'scenario.run', runPayload())
  assert.deepEqual(bridge.operationIds, ['op-host-1', 'op-host-2'])
  const recordsCalls = bridge.calls.filter((call) => call.argv[0] === 'scenario-record')
  assert.equal(recordsCalls.length, 2)
  assert.equal(recordsCalls[0].argv[6], 'op-host-1')
  assert.equal(recordsCalls[1].argv[6], 'op-host-2')
  const payloads = recordsCalls.map((call) => JSON.parse(Buffer.from(call.argv[4], 'base64').toString('utf8')))
  assert.deepEqual(payloads[0], payloads[1])
})

test('pre-aborted scenario.run returns OUTCOME_UNKNOWN without a ledger write', async () => {
  const bridge = scriptedBridge(happyScript())
  const host = createFakeHost()
  const viewService = createViewService({ bridge, settings })
  const scenarioService = createScenarioService({ bridge, settings })
  registerWorkbenchHttpRoute(host.ctx, {
    channel: '/code-view',
    methods: [...VIEW_ENDPOINTS, ...SCENARIO_ENDPOINTS],
    handler: createWorkbenchDispatch({ viewService, scenarioService }),
  })
  const controller = new AbortController()
  controller.abort()
  const result = await scenarioService['scenario.run'](runPayload(), controller.signal)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'OUTCOME_UNKNOWN')
  assert.equal(bridge.calls.some((call) => call.argv[0] === 'scenario-record'), false)
  assert.equal(bridge.operationIds.length, 0)
})

// ---------------------------------------------------------------------------
// S3b: undo tail + prefix replay
// ---------------------------------------------------------------------------
test('scenario.undoTail rejects malformed input before any engine call', async () => {
  const bridge = scriptedBridge(undoScript())
  const { route } = mountWorkbench({ bridge })
  const cases = [
    [{}, /workspace is required/],
    [{ ...undoPayload(), workspace: 'Bad' }, /workspace must match/],
    [{ workspace: WORKSPACE, count: 1, expected_generation: 2 }, /scenario is required/],
    [{ ...undoPayload(), scenario: '../etc/passwd' }, /scenario must match/],
    [{ workspace: WORKSPACE, scenario: SCENARIO_REF, expected_generation: 2 }, /count is required/],
    [{ ...undoPayload(), count: 0 }, /count must be an integer in 1\.\.200/],
    [{ ...undoPayload(), count: 201 }, /count must be an integer in 1\.\.200/],
    [{ ...undoPayload(), count: 1.5 }, /count must be an integer in 1\.\.200/],
    [{ ...undoPayload(), count: '1' }, /count must be an integer in 1\.\.200/],
    [{ workspace: WORKSPACE, scenario: SCENARIO_REF, count: 1 }, /expected_generation is required/],
    [{ ...undoPayload(), expected_generation: -1 }, /expected_generation must be an integer/],
    [{ ...undoPayload(), path: 'trace.json' }, /unknown payload field: path/],
  ]
  for (const [payload, message] of cases) {
    const result = await invoke(route, 'scenario.undoTail', payload)
    assert.equal(result.response.statusCode, 200)
    assert.equal(result.json.result.ok, false)
    assert.equal(result.json.result.error.code, 'INVALID_ARGUMENT')
    assert.match(result.json.result.error.message, message)
  }
  assert.equal(bridge.calls.length, 0, 'invalid payloads must never reach the engine')
})

test('scenario.undoTail orchestrates undo-plan→module→prefix replay→undo-record', async () => {
  const bridge = scriptedBridge(undoScript())
  const { route } = mountWorkbench({ bridge })
  const result = await invoke(route, 'scenario.undoTail', undoPayload())
  assert.equal(result.json.result.ok, true, JSON.stringify(result.json).slice(0, 600))
  assert.deepEqual(result.json.result.value, UNDO_LEDGER_DOC)
  assert.equal(bridge.calls.length, 3)
  assert.deepEqual(bridge.calls[0].argv, [
    'scenario-undo-plan',
    '--workspace', WORKSPACE,
    '--scenario', SCENARIO_REF,
    '--count', '1',
    '--expected-generation', '2',
  ])
  assert.deepEqual(bridge.calls[1].argv, ['scenario-module', '--plan', UNDO_PLAN_ID])
  const recordArgv = bridge.calls[2].argv
  assert.equal(recordArgv[0], 'scenario-undo-record')
  assert.deepEqual(recordArgv.slice(1, 3), ['--plan', UNDO_PLAN_ID])
  assert.equal(recordArgv[3], '--records-json')
  assert.equal(recordArgv[5], '--operation-id')
  assert.equal(bridge.operationIds.length, 1)
  assert.equal(recordArgv[6], bridge.operationIds[0])

  const recordsPayload = JSON.parse(Buffer.from(recordArgv[4], 'base64').toString('utf8'))
  assert.equal(recordsPayload.records.length, 2, 'the replay must cover exactly the prefix steps')
  assert.deepEqual(recordsPayload.records.map((record) => record.interface), ['reset', 'bus_register'])
  assert.deepEqual(recordsPayload.records.map((record) => record.result), [null, 0])
  assert.deepEqual(recordsPayload.records.map((record) => record.status), ['ok', 'ok'])
  for (const record of recordsPayload.records) assert.match(record.memory_digest, /^[0-9a-f]{64}$/)
  assert.deepEqual(recordsPayload.records[1].events.map((event) => event.event), ['DEFAULT_ROUTE', 'STORE_ROUTE'])
})

test('scenario.undoTail returns the digest-mismatch engine document verbatim', async () => {
  const mismatchDoc = {
    schema_version: 1,
    error: {
      code: 'STATE_CONFLICT',
      message: 'replayed state digest does not match the source ledger',
      details: { reason_code: 'state_digest_mismatch', step_index: 1, expected: '2'.repeat(64), actual: '0'.repeat(64) },
      details_ref: null,
      retryable: true,
    },
    operation_id: null,
  }
  const bridge = scriptedBridge(
    undoScript({ recordResult: { schema_version: 1, ok: false, exit_code: 2, cli: mismatchDoc } }),
  )
  const { route } = mountWorkbench({ bridge })
  const result = await invoke(route, 'scenario.undoTail', undoPayload())
  assert.equal(result.json.result.ok, true)
  assert.deepEqual(result.json.result.value, mismatchDoc)
  assert.equal(
    bridge.calls.filter((call) => call.argv[0] === 'scenario-undo-record').length,
    1,
    'no retry may publish a mismatching replay',
  )
  assert.equal(bridge.operationIds.length, 1)
})

test('scenario.undoTail worker OUTCOME_UNKNOWN leaves the ledger untouched', async () => {
  const bridge = scriptedBridge(undoScript())
  const { route } = mountWorkbench({
    bridge,
    runner: async () => ({ ok: false, error: { code: 'OUTCOME_UNKNOWN', message: 'simulation exceeded timeoutMs=1' } }),
  })
  const result = await invoke(route, 'scenario.undoTail', undoPayload())
  assert.equal(result.json.result.ok, false)
  assert.equal(result.json.result.error.code, 'OUTCOME_UNKNOWN')
  assert.deepEqual(result.json.result.error.details, {})
  assert.deepEqual(bridge.calls.map((call) => call.argv[0]), ['scenario-undo-plan', 'scenario-module'])
  assert.equal(bridge.operationIds.length, 0, 'no undo-record may be attempted')
})

test('scenario.undoTail rejects an engine plan that is not an undo plan', async () => {
  const bridge = scriptedBridge((argv) =>
    argv[0] === 'scenario-undo-plan'
      ? cliOk({ schema_version: 1, plan_id: PLAN_ID, steps: PLAN_STEPS })
      : cliEngineError('INVALID_ARGUMENT', 'unexpected'),
  )
  const { route } = mountWorkbench({ bridge })
  const result = await invoke(route, 'scenario.undoTail', undoPayload())
  assert.equal(result.json.result.ok, false)
  assert.equal(result.json.result.error.code, 'ENGINE_FAILED')
  assert.match(result.json.result.error.message, /undo plan/)
  assert.equal(bridge.calls.length, 1)
  assert.equal(bridge.operationIds.length, 0)
})

// ---------------------------------------------------------------------------
// S3b: trusted-inbox trace import
// ---------------------------------------------------------------------------
test('trace.import maps to trace-import and passes the ledger through', async () => {
  const traceHandler = (argv) =>
    argv[0] === 'trace-import' ? cliOk(IMPORTED_LEDGER_DOC) : cliEngineError('INVALID_ARGUMENT', `unexpected command ${argv[0]}`)
  const bridge = scriptedBridge(traceHandler)
  const { route } = mountWorkbench({ bridge })
  const result = await invoke(route, 'trace.import', {
    workspace: WORKSPACE,
    snapshot: SNAPSHOT_ID,
    input: 'trace-bus-send.json',
  })
  assert.equal(result.json.result.ok, true)
  assert.deepEqual(result.json.result.value, IMPORTED_LEDGER_DOC)
  assert.equal(bridge.operationIds.length, 1)
  assert.deepEqual(bridge.calls[0].argv, [
    'trace-import',
    '--workspace', WORKSPACE,
    '--snapshot', SNAPSHOT_ID,
    '--input', 'trace-bus-send.json',
    '--operation-id', bridge.operationIds[0],
  ])

  // Engine error documents (missing/invalid trace file) are returned verbatim.
  const notFoundDoc = {
    schema_version: 1,
    error: { code: 'NOT_FOUND', message: 'trace input file is missing from the import inbox', details_ref: null, retryable: false },
    operation_id: null,
  }
  const errorBridge = scriptedBridge(() => ({ schema_version: 1, ok: false, exit_code: 2, cli: notFoundDoc }))
  const errorMount = mountWorkbench({ bridge: errorBridge })
  const errorResult = await invoke(errorMount.route, 'trace.import', {
    workspace: WORKSPACE,
    snapshot: SNAPSHOT_ID,
    input: 'trace-missing.json',
  })
  assert.equal(errorResult.json.result.ok, true)
  assert.deepEqual(errorResult.json.result.value, notFoundDoc)
})

test('trace.import rejects path-like or malformed input names before any engine call', async () => {
  const bridge = scriptedBridge(() => cliOk({}))
  const { route } = mountWorkbench({ bridge })
  const cases = [
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID }, /input is required/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, input: '' }, /non-empty file name/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, input: 'a/b.json' }, /no path separators/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, input: 'a\\b.json' }, /no path separators/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, input: 'C:\\traces\\x.json' }, /no path separators/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, input: '../x.json' }, /no "." or ".." path segments/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, input: '..' }, /no "." or ".." path segments/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, input: '.' }, /no "." or ".." path segments/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, input: 'trace file.json' }, /input must match/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, input: 42 }, /input must be a string/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, input: 'x'.repeat(257) }, /at most 256 characters/],
    [{ workspace: WORKSPACE, input: 'trace.json' }, /snapshot is required/],
    [{ snapshot: SNAPSHOT_ID, input: 'trace.json' }, /workspace is required/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, input: 'trace.json', path: 'x' }, /unknown payload field: path/],
  ]
  for (const [payload, message] of cases) {
    const result = await invoke(route, 'trace.import', payload)
    assert.equal(result.response.statusCode, 200)
    assert.equal(result.json.result.ok, false)
    assert.equal(result.json.result.error.code, 'INVALID_ARGUMENT')
    assert.match(result.json.result.error.message, message)
  }
  assert.equal(bridge.calls.length, 0, 'invalid payloads must never reach the engine')
})

test('SCENARIO_ENDPOINTS lists the S3b endpoints in contract order', () => {
  assert.deepEqual(SCENARIO_ENDPOINTS, [
    'scenario.listProfiles',
    'scenario.list',
    'scenario.get',
    'scenario.preview',
    'scenario.run',
    'scenario.undoTail',
    'trace.import',
  ])
})

test('the workbench dispatch routes view.* and scenario.* and fails closed otherwise', async () => {
  const bridge = scriptedBridge(happyScript())
  const viewService = createViewService({ bridge, settings })
  const scenarioService = createScenarioService({ bridge, settings })
  const dispatch = createWorkbenchDispatch({ viewService, scenarioService })
  assert.deepEqual(await dispatch('view.unknown', {}), {
    ok: false,
    error: { code: 'INVALID_ARGUMENT', message: 'unknown view endpoint' },
  })
  assert.deepEqual(await dispatch('scenario.unknown', {}), {
    ok: false,
    error: { code: 'INVALID_ARGUMENT', message: 'unknown scenario endpoint' },
  })
  assert.deepEqual(await dispatch('trace.unknown', {}), {
    ok: false,
    error: { code: 'INVALID_ARGUMENT', message: 'unknown trace endpoint' },
  })
  // S3b endpoints are routed into the scenario service (validation runs first).
  const undoRouted = await dispatch('scenario.undoTail', {})
  assert.equal(undoRouted.ok, false)
  assert.equal(undoRouted.error.code, 'INVALID_ARGUMENT')
  assert.match(undoRouted.error.message, /workspace is required/)
  const traceRouted = await dispatch('trace.import', {})
  assert.equal(traceRouted.ok, false)
  assert.equal(traceRouted.error.code, 'INVALID_ARGUMENT')
  assert.match(traceRouted.error.message, /workspace is required/)
  assert.deepEqual(await dispatch('other.endpoint', {}), {
    ok: false,
    error: { code: 'INVALID_ARGUMENT', message: 'unknown workbench endpoint' },
  })
  assert.throws(() => createWorkbenchDispatch({ scenarioService }), /requires a view service/)
  assert.throws(() => createWorkbenchDispatch({ viewService }), /requires a scenario service/)
})
