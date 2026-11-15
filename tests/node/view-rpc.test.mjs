// Host half of the read-only code view: the /code-view HTTP carrier and the
// four read-model endpoints. The carrier is exercised against the frozen
// client-request/server-response envelope that the rc.5 browser
// `connection.rpc.call` sends and validates; the real services are
// runtime-verified separately, so the fakes here stand in for
// `webServer.register` / `connection.admit` / the Python bridge only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HTTP_RPC_CHANNEL,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  registerWorkbenchHttpRoute,
} from '../../lib/http-rpc.mjs'
import { createViewDispatch, createViewService, VIEW_ENDPOINTS } from '../../lib/view-service.mjs'
import { BridgeError } from '../../lib/bridge.mjs'
import { PACKAGE_ROOT, resolveSettings } from '../../lib/config.mjs'
import { apply, inject, name as pluginName } from '../../index.js'

const PACKAGE = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
const SNAPSHOT_ID = '22a7f0c0d3e4459ab8c7d6e5f40123456789abcd'

function testSettings(overrides = {}) {
  return {
    ...resolveSettings({}),
    bootstrapPath: join(PACKAGE_ROOT, 'package.json'),
    ...overrides,
  }
}

function createFakeHost({ admit } = {}) {
  const state = { routes: new Map(), effects: [], admissions: 0 }
  const defaultAdmit = () => ({ peer: { principal: { kind: 'owner' } } })
  const ctx = {
    connection: {
      admit(request) {
        state.admissions += 1
        return (admit ?? defaultAdmit)(request)
      },
    },
    webServer: {
      register(route) {
        if (state.routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        state.routes.set(route.path, route)
        return () => {
          state.routes.delete(route.path)
        }
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

function createRequest({ method = 'POST', url = `${HTTP_RPC_CHANNEL}/view.status`, body = '', headers = {} } = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  const request = {
    method,
    url,
    headers,
    consumed: false,
    on() {},
  }
  request[Symbol.asyncIterator] = async function* iterator() {
    request.consumed = true
    if (payload.length > 0) yield payload
  }
  return request
}

function createResponse() {
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
    writeHead(status, headers = {}) {
      response.statusCode = status
      response.headers = { ...headers }
    },
    end(chunk = '') {
      response.ended = true
      response.body = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    },
  }
  return response
}

function clientRequest({ rpcId = 'rpc-0001', method = 'view.status', payload } = {}) {
  const message = { type: 'client-request', rpcId, method }
  if (payload !== undefined) message.payload = payload
  return JSON.stringify(message)
}

async function invoke(route, { endpoint = 'view.status', method, payload, rpcId = 'rpc-0001', body, request = {} } = {}) {
  const requestObject = createRequest({
    url: `${HTTP_RPC_CHANNEL}/${endpoint}`,
    body: body ?? clientRequest({ rpcId, method: method ?? endpoint, payload }),
    ...request,
  })
  const response = createResponse()
  await route.handler(requestObject, response)
  let json
  try {
    json = response.body ? JSON.parse(response.body) : undefined
  } catch {
    json = undefined
  }
  return { request: requestObject, response, json }
}

function createBridgeStub(execute, { resolvePython } = {}) {
  const calls = []
  return {
    calls,
    resolvePython: resolvePython ?? (async () => 'python3'),
    async execute(argv, options = {}) {
      calls.push({ argv, options })
      return execute(argv, options)
    },
  }
}

function engineOk(cli) {
  return { schema_version: 1, ok: true, exit_code: 0, cli }
}

function mount({ bridge = createBridgeStub(async () => engineOk({ schema_version: 1 })), settings = testSettings(), admit, methods = VIEW_ENDPOINTS } = {}) {
  const host = createFakeHost({ admit })
  const service = createViewService({ bridge, settings })
  const dispose = registerWorkbenchHttpRoute(host.ctx, {
    channel: HTTP_RPC_CHANNEL,
    methods,
    handler: createViewDispatch(service),
  })
  const route = host.state.routes.get(HTTP_RPC_CHANNEL)
  return { ctx: host.ctx, state: host.state, route, dispose, service, bridge, settings }
}

// ---------------------------------------------------------------------------
// carrier registration / admission / envelope
// ---------------------------------------------------------------------------
test('carrier registers one prefix route on /code-view and removes it on dispose', () => {
  const { state, route, dispose } = mount()
  assert.ok(route, 'route must be registered')
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/code-view')
  assert.equal(state.routes.size, 1)
  assert.equal(state.effects.length, 1)
  assert.match(state.effects[0].label, /\/code-view http rpc route/)
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(state.routes.size, 0)
})

test('carrier refuses to mount without the reviewed host seams', () => {
  assert.throws(() => registerWorkbenchHttpRoute({ webServer: { register() {} } }, { handler() {} }), /connection\.admit is unavailable/)
  assert.throws(() => registerWorkbenchHttpRoute({ connection: { admit() {} } }, { handler() {} }), /webServer\.register is unavailable/)
  const { ctx } = createFakeHost()
  assert.throws(() => registerWorkbenchHttpRoute(ctx, {}), /handler must be a function/)
  assert.throws(() => registerWorkbenchHttpRoute(ctx, { handler() {}, channel: 'code-view' }), /must be an absolute path/)
})

test('non-POST requests are answered 405 before the body is read', async () => {
  const { route } = mount()
  const { response, request } = await invoke(route, { body: clientRequest({ payload: {} }), request: { method: 'GET' } })
  assert.equal(response.statusCode, 405)
  assert.equal(request.consumed, false)
  assert.match(response.body, /method not allowed/)
})

test('admission failures terminate with 401/403 and never read the body', async () => {
  for (const [admission, status, body] of [
    [{ rejection: 401 }, 401, 'unauthorized'],
    [{ rejection: 403 }, 403, 'forbidden'],
    [undefined, 403, 'forbidden'],
    [null, 403, 'forbidden'],
  ]) {
    const { route } = mount({ admit: () => admission })
    const result = await invoke(route, { body: clientRequest({ payload: {} }) })
    assert.equal(result.response.statusCode, status)
    assert.equal(result.response.body, body)
    assert.equal(result.request.consumed, false)
  }
  // A throwing admission still fails closed instead of leaking the error.
  const { route } = mount({
    admit: () => {
      throw new Error('C:\\Users\\admin\\.dsh\\trusted-hosts')
    },
  })
  const rejected = await invoke(route, { body: clientRequest({ payload: {} }) })
  assert.equal(rejected.response.statusCode, 403)
  assert.equal(rejected.response.body.includes('Users'), false)
})

test('malformed envelopes answer the fixed gateway/bad-request envelope', async () => {
  const { route, bridge } = mount()

  let result = await invoke(route, { body: '{not json' })
  assert.equal(result.response.statusCode, 200)
  assert.equal(result.json.type, 'server-response')
  assert.equal(result.json.rpcId, 'invalid-request')
  assert.equal(result.json.result.ok, false)
  assert.equal(result.json.result.error.code, 'gateway/bad-request')
  assert.equal(result.json.result.error.message, 'invalid client-request message')
  assert.deepEqual(result.json.result.error.details, {})

  // A valid rpcId is echoed even when the rest of the envelope is invalid.
  result = await invoke(route, {
    body: JSON.stringify({ type: 'server-response', rpcId: 'rpc-echo', method: 'view.status', payload: {} }),
  })
  assert.equal(result.json.rpcId, 'rpc-echo')
  assert.equal(result.json.result.error.code, 'gateway/bad-request')

  // The envelope method must equal the URL endpoint.
  result = await invoke(route, { endpoint: 'view.status', body: clientRequest({ method: 'view.listSnapshots', payload: {} }) })
  assert.equal(result.json.result.error.code, 'gateway/bad-request')

  // The method must be a whitelisted view endpoint, never a free-form URL.
  result = await invoke(route, { endpoint: 'view.evil', body: clientRequest({ method: 'view.evil', payload: {} }) })
  assert.equal(result.json.result.error.code, 'gateway/bad-request')
  result = await invoke(route, { endpoint: 'view.status', body: clientRequest({ method: 'view.status/extra', payload: {} }) })
  assert.equal(result.json.result.error.code, 'gateway/bad-request')

  // Invalid rpcId characters are replaced by the fixed correlation id.
  result = await invoke(route, { body: clientRequest({ rpcId: 'bad rpc id!', payload: {} }) })
  assert.equal(result.json.rpcId, 'invalid-request')

  // Empty bodies and unknown paths are bad requests too.
  result = await invoke(route, { body: '' })
  assert.equal(result.json.result.error.code, 'gateway/bad-request')
  result = await invoke(route, { endpoint: '', body: clientRequest({ payload: {} }) })
  assert.equal(result.json.result.error.code, 'gateway/bad-request')

  assert.equal(bridge.calls.length, 0, 'bad requests must never reach the bridge')
})

test('request bodies above 16 KiB are rejected before dispatch', async () => {
  const { route, bridge } = mount()
  const oversized = clientRequest({ payload: { blob: 'x'.repeat(MAX_REQUEST_BYTES) } })
  assert.ok(Buffer.byteLength(oversized, 'utf8') > MAX_REQUEST_BYTES)
  const result = await invoke(route, { body: oversized })
  assert.equal(result.response.statusCode, 200)
  assert.equal(result.json.result.error.code, 'gateway/bad-request')
  assert.equal(result.response.headers.connection, 'close')
  assert.equal(bridge.calls.length, 0)

  // Declared content-length is rejected without consuming the stream.
  const declared = await invoke(route, {
    body: 'unused',
    request: { headers: { 'content-length': String(MAX_REQUEST_BYTES + 1) } },
  })
  assert.equal(declared.json.result.error.code, 'gateway/bad-request')
  assert.equal(declared.request.consumed, false)
  assert.equal(bridge.calls.length, 0)
})

test('handler throws and malformed handler results become fixed gateway/internal', async () => {
  const throwing = mount({
    bridge: createBridgeStub(async () => {
      throw new Error('C:\\Users\\admin\\.dsh\\.credentials token=sk-live')
    }),
  })
  let result = await invoke(throwing.route, { endpoint: 'view.listSnapshots', payload: {} })
  assert.equal(result.response.statusCode, 200)
  assert.equal(result.json.result.ok, false)
  assert.equal(result.json.result.error.code, 'gateway/internal')
  assert.equal(result.json.result.error.message, 'internal failure')
  assert.deepEqual(result.json.result.error.details, {})
  assert.equal(result.response.body.includes('credentials'), false)
  assert.equal(result.response.body.includes('Users'), false)

  // A handler that returns neither {ok:true,...} nor {ok:false,...} is internal.
  const host = createFakeHost()
  registerWorkbenchHttpRoute(host.ctx, {
    channel: HTTP_RPC_CHANNEL,
    methods: ['view.status'],
    handler: async () => 'raw-value-is-not-a-result',
  })
  const malformed = await invoke(host.state.routes.get(HTTP_RPC_CHANNEL), { payload: {} })
  assert.equal(malformed.json.result.error.code, 'gateway/internal')
})

test('success responses echo rpcId, freeze the envelope type and pass an AbortSignal', async () => {
  let sawSignal = false
  const bridge = createBridgeStub(async () => engineOk({ schema_version: 1, ok: true }))
  const originalExecute = bridge.execute
  bridge.execute = async (argv, options) => {
    sawSignal = options.signal instanceof AbortSignal
    return originalExecute(argv, options)
  }
  const { route } = mount({ bridge })
  const result = await invoke(route, { endpoint: 'view.listSnapshots', payload: {}, rpcId: 'abc.DEF:123-xyz' })
  assert.equal(result.json.type, 'server-response')
  assert.equal(result.json.rpcId, 'abc.DEF:123-xyz')
  assert.equal(result.json.result.ok, true)
  assert.equal(sawSignal, true)
})

// ---------------------------------------------------------------------------
// view.status
// ---------------------------------------------------------------------------
test('view.status reports host/engine facts and slice gaps without starting the engine', async () => {
  const bridge = createBridgeStub()
  const { route, settings } = mount({ bridge })
  const result = await invoke(route, { endpoint: 'view.status', payload: {} })
  assert.equal(result.response.statusCode, 200)
  assert.equal(result.json.result.ok, true)
  const value = result.json.result.value
  assert.equal(value.schema_version, 1)
  assert.deepEqual(value.host, {
    plugin: 'dsh-code-reader',
    package: PACKAGE.name,
    version: PACKAGE.version,
    panel_key: 'dsh-code-reader',
    rpc_channel: '/code-view',
    node: process.versions.node,
    platform: process.platform,
  })
  assert.deepEqual(value.engine, { python: 'available', bootstrap: { configured: true, exists: true } })
  assert.deepEqual(value.capabilities, {
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
  assert.deepEqual(
    value.gaps.map((gap) => gap.code),
    ['scenario_execution', 'run_observation', 'ai_summary'],
  )
  // S2a/S2b implemented capabilities must not remain gaps.
  assert.equal(
    value.gaps.some((gap) =>
      ['five_views', 'resource_graph', 'group_collapse', 'interface_library', 'subflow_breadcrumb'].includes(gap.code),
    ),
    false,
  )
  for (const gap of value.gaps) {
    assert.equal(gap.status, 'unavailable')
    assert.equal(typeof gap.reason, 'string')
    assert.ok(gap.reason.length > 0)
  }
  // The status endpoint must not invoke the engine CLI, and it never exposes
  // the trusted bootstrap path.
  assert.equal(bridge.calls.length, 0)
  const escapedBootstrap = JSON.stringify(settings.bootstrapPath).slice(1, -1)
  assert.equal(result.response.body.includes(escapedBootstrap), false)

  // Repeated polling stays cheap and stable; payload may be omitted entirely.
  const again = await invoke(route, {
    body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-2', method: 'view.status' }),
  })
  assert.deepEqual(again.json.result, result.json.result)
  assert.equal(bridge.calls.length, 0)
})

test('view.status stays ok:true with explicit gaps when Python and bootstrap are missing', async () => {
  const bridge = createBridgeStub(undefined, {
    resolvePython: async () => {
      throw new BridgeError('DEPENDENCY_UNAVAILABLE', 'no usable Python at C:\\Users\\admin\\python.exe')
    },
  })
  const missingDir = mkdtempSync(join(tmpdir(), 'dsh-code-reader-status-'))
  const settings = testSettings({ bootstrapPath: join(missingDir, 'bootstrap.json') })
  const { route } = mount({ bridge, settings })
  const result = await invoke(route, { endpoint: 'view.status', payload: {} })
  assert.equal(result.response.statusCode, 200)
  assert.equal(result.json.result.ok, true)
  const value = result.json.result.value
  assert.deepEqual(value.engine, { python: 'missing', bootstrap: { configured: true, exists: false } })
  // Availability is carried by `engine`; `gaps` stays the fixed capability list
  // (S2a/S2b views and capabilities are implemented) so the UI does not render
  // duplicate rows.
  assert.deepEqual(
    value.gaps.map((gap) => gap.code),
    ['scenario_execution', 'run_observation', 'ai_summary'],
  )
  // The degraded status must not leak the interpreter/bootstrap paths.
  assert.equal(result.response.body.includes('python.exe'), false)
  assert.equal(result.response.body.includes('Users'), false)
  assert.equal(result.response.body.includes('bootstrap.json'), false)
})

test('view.status rejects unknown payload fields with INVALID_ARGUMENT', async () => {
  const { route } = mount()
  const result = await invoke(route, { endpoint: 'view.status', payload: { workspace: 'demo' } })
  assert.equal(result.response.statusCode, 200)
  assert.equal(result.json.result.ok, false)
  assert.equal(result.json.result.error.code, 'INVALID_ARGUMENT')
  assert.match(result.json.result.error.message, /unknown payload field: workspace/)
})

// ---------------------------------------------------------------------------
// engine-backed endpoints
// ---------------------------------------------------------------------------
test('view.listSnapshots maps to the fixed argv and returns engine JSON verbatim', async () => {
  const engineJson = { schema_version: 1, host: { engine: 'code-learning', scope_ref: 'local' }, workspaces: [], gaps: [] }
  const bridge = createBridgeStub(async () => engineOk(engineJson))
  const { route } = mount({ bridge })
  const result = await invoke(route, { endpoint: 'view.listSnapshots', payload: {} })
  assert.equal(result.json.result.ok, true)
  assert.deepEqual(result.json.result.value, engineJson)
  assert.deepEqual(bridge.calls.map((call) => call.argv), [['view-snapshots']])

  const bad = await invoke(route, { endpoint: 'view.listSnapshots', payload: { extra: 1 } })
  assert.equal(bad.json.result.error.code, 'INVALID_ARGUMENT')
  assert.equal(bridge.calls.length, 1, 'invalid payloads must not reach the engine')
})

test('view.listEntries validates the payload and maps to the fixed argv', async () => {
  const engineJson = { schema_version: 1, snapshot: { snapshot_id: SNAPSHOT_ID }, entries: [], gaps: [] }
  const bridge = createBridgeStub(async () => engineOk(engineJson))
  const { route } = mount({ bridge })
  const valid = await invoke(route, {
    endpoint: 'view.listEntries',
    payload: { workspace: 'code-view-bus-demo', snapshot: SNAPSHOT_ID },
  })
  assert.equal(valid.json.result.ok, true)
  assert.deepEqual(valid.json.result.value, engineJson)
  assert.deepEqual(bridge.calls.map((call) => call.argv), [
    ['view-entries', '--workspace', 'code-view-bus-demo', '--snapshot', SNAPSHOT_ID],
  ])

  const rejected = [
    [undefined, /workspace is required/],
    [{}, /workspace is required/],
    [{ workspace: 'demo' }, /snapshot is required/],
    [{ workspace: 'demo', snapshot: SNAPSHOT_ID, extra: true }, /unknown payload field: extra/],
    [{ workspace: 42, snapshot: SNAPSHOT_ID }, /workspace must be a string/],
    [{ workspace: 'Demo', snapshot: SNAPSHOT_ID }, /workspace must match/],
    [{ workspace: 'a'.repeat(65), snapshot: SNAPSHOT_ID }, /workspace must match/],
    [{ workspace: 'a'.repeat(129), snapshot: SNAPSHOT_ID }, /at most 128 characters/],
    [{ workspace: '', snapshot: SNAPSHOT_ID }, /workspace must be a non-empty string/],
    [{ workspace: 'demo', snapshot: '' }, /snapshot must be a non-empty string/],
    [{ workspace: 'demo', snapshot: 'has space' }, /snapshot must match/],
    [{ workspace: 'demo', snapshot: 'a/b' }, /snapshot must match/],
    [{ workspace: 'demo', snapshot: 'a'.repeat(129) }, /at most 128 characters/],
    [{ workspace: 'demo', snapshot: 7 }, /snapshot must be a string/],
    [null, /payload must be a JSON object/],
    [[], /payload must be a JSON object/],
  ]
  for (const [payload, message] of rejected) {
    const bad = await invoke(route, { endpoint: 'view.listEntries', payload })
    assert.equal(bad.json.result.ok, false, `expected rejection for ${JSON.stringify(payload)}`)
    assert.equal(bad.json.result.error.code, 'INVALID_ARGUMENT')
    assert.match(bad.json.result.error.message, message)
  }
  assert.equal(bridge.calls.length, 1, 'invalid payloads must not reach the engine')
})

test('view.getEntry validates the payload and maps to the fixed argv', async () => {
  const entryJson = { schema_version: 1, snapshot: {}, entry: { entry_id: 'f_1' }, gaps: [] }
  const bridge = createBridgeStub(async () => engineOk(entryJson))
  const { route } = mount({ bridge })
  const entry = 'bus:bus_send'
  const valid = await invoke(route, {
    endpoint: 'view.getEntry',
    payload: { workspace: 'code-view-bus-demo', snapshot: SNAPSHOT_ID, entry },
  })
  assert.equal(valid.json.result.ok, true)
  assert.deepEqual(valid.json.result.value, entryJson)
  assert.deepEqual(bridge.calls.map((call) => call.argv), [
    ['view-entry', '--workspace', 'code-view-bus-demo', '--snapshot', SNAPSHOT_ID, '--entry', entry],
  ])

  // Bounded lengths on the integer boundaries of the contract.
  const boundarySnapshot = 'a'.repeat(128)
  const boundaryEntry = 'f'.repeat(512)
  await invoke(route, {
    endpoint: 'view.getEntry',
    payload: { workspace: 'demo', snapshot: boundarySnapshot, entry: boundaryEntry },
  })
  assert.deepEqual(bridge.calls.at(-1).argv, [
    'view-entry', '--workspace', 'demo', '--snapshot', boundarySnapshot, '--entry', boundaryEntry,
  ])

  const rejected = [
    [{ workspace: 'demo', snapshot: SNAPSHOT_ID }, /entry is required/],
    [{ workspace: 'demo', snapshot: SNAPSHOT_ID, entry: 'f'.repeat(513) }, /at most 512 characters/],
    [{ workspace: 'demo', snapshot: SNAPSHOT_ID, entry: 'bus/bus_send' }, /entry must match/],
    [{ workspace: 'demo', snapshot: SNAPSHOT_ID, entry: '' }, /entry must be a non-empty string/],
    [{ workspace: 'demo', snapshot: SNAPSHOT_ID, entry: 99 }, /entry must be a string/],
    [{ workspace: 'demo', snapshot: SNAPSHOT_ID, entry, operation_id: 'x' }, /unknown payload field: operation_id/],
  ]
  const before = bridge.calls.length
  for (const [payload, message] of rejected) {
    const bad = await invoke(route, { endpoint: 'view.getEntry', payload })
    assert.equal(bad.json.result.error.code, 'INVALID_ARGUMENT')
    assert.match(bad.json.result.error.message, message)
  }
  assert.equal(bridge.calls.length, before, 'invalid payloads must not reach the engine')
})

test('engine error JSON (ok:false) is passed through as a successful RPC value', async () => {
  const engineError = {
    schema_version: 1,
    error: { code: 'STALE_SNAPSHOT', message: 'snapshot hash mismatch', details_ref: null, retryable: false },
    operation_id: null,
  }
  const bridge = createBridgeStub(async () => ({ schema_version: 1, ok: false, exit_code: 2, cli: engineError }))
  const { route } = mount({ bridge })
  const result = await invoke(route, { endpoint: 'view.listSnapshots', payload: {} })
  assert.equal(result.json.result.ok, true)
  assert.deepEqual(result.json.result.value, engineError)
})

test('BridgeError maps to stable path-free codes', async () => {
  const cases = [
    ['DEPENDENCY_UNAVAILABLE', 'BRIDGE_UNAVAILABLE', 'engine at C:\\Users\\admin\\python.exe failed'],
    ['OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN', 'engine at C:\\Users\\admin\\python.exe timed out'],
    ['INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'bridge argv must be an array of strings'],
    ['INTERNAL_ERROR', 'ENGINE_FAILED', 'non-JSON stdout from C:\\Users\\admin\\engine'],
  ]
  for (const [bridgeCode, rpcCode, message] of cases) {
    const bridge = createBridgeStub(async () => {
      throw new BridgeError(bridgeCode, message)
    })
    const { route } = mount({ bridge })
    const result = await invoke(route, { endpoint: 'view.listSnapshots', payload: {} })
    assert.equal(result.response.statusCode, 200)
    assert.equal(result.json.result.ok, false)
    assert.equal(result.json.result.error.code, rpcCode)
    assert.deepEqual(result.json.result.error.details, {})
    assert.equal(typeof result.json.result.error.message, 'string')
    if (bridgeCode === 'INVALID_ARGUMENT') {
      assert.equal(result.json.result.error.message, message, 'own validation messages pass through')
    } else {
      // Host/bridge failures get a fixed safe message, never the BridgeError text.
      assert.notEqual(result.json.result.error.message, message)
      assert.equal(result.json.result.error.message.includes('Users'), false)
      assert.equal(result.json.result.error.message.includes('python.exe'), false)
      assert.equal(result.json.result.error.message.includes('C:\\'), false)
    }
  }
})

test('bridge failures without engine JSON are mapped by exit code', async () => {
  const cases = [
    [2, 'ENGINE_BLOCKED'],
    [3, 'ENGINE_FAILED'],
    [4, 'OUTCOME_UNKNOWN'],
  ]
  for (const [exitCode, rpcCode] of cases) {
    const bridge = createBridgeStub(async () => ({
      schema_version: 1,
      ok: false,
      exit_code: exitCode,
      cli: null,
      error: { code: 'INTERNAL_ERROR', message: 'engine failed', details_ref: null, retryable: false },
    }))
    const { route } = mount({ bridge })
    const result = await invoke(route, { endpoint: 'view.listSnapshots', payload: {} })
    assert.equal(result.json.result.ok, false)
    assert.equal(result.json.result.error.code, rpcCode)
  }

  const dependency = createBridgeStub(async () => ({
    schema_version: 1,
    ok: false,
    exit_code: 3,
    cli: null,
    error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'stderr at C:\\Users\\admin\\python.exe', details_ref: null, retryable: false },
  }))
  const { route } = mount({ bridge: dependency })
  const result = await invoke(route, { endpoint: 'view.listSnapshots', payload: {} })
  assert.equal(result.json.result.error.code, 'BRIDGE_UNAVAILABLE')
  assert.equal(result.response.body.includes('Users'), false)
})

test('responses above 512 KiB are refused with a fixed small envelope', async () => {
  const huge = { schema_version: 1, blob: 'x'.repeat(MAX_RESPONSE_BYTES) }
  const bridge = createBridgeStub(async () => engineOk(huge))
  const { route } = mount({ bridge })
  const result = await invoke(route, { endpoint: 'view.listSnapshots', payload: {} })
  assert.equal(result.response.statusCode, 200)
  assert.equal(result.json.result.ok, false)
  assert.equal(result.json.result.error.code, 'gateway/internal')
  assert.equal(result.json.result.error.message, 'internal failure')
  assert.ok(Buffer.byteLength(result.response.body, 'utf8') < 1024)
  assert.equal(result.response.body.includes('xxxx'), false)

  // A large-but-allowed response still goes through untouched.
  const allowed = { schema_version: 1, blob: 'y'.repeat(400 * 1024) }
  const allowedBridge = createBridgeStub(async () => engineOk(allowed))
  const allowedRoute = mount({ bridge: allowedBridge })
  const allowedResult = await invoke(allowedRoute.route, { endpoint: 'view.listSnapshots', payload: {} })
  assert.equal(allowedResult.json.result.ok, true)
  const size = Buffer.byteLength(allowedResult.response.body, 'utf8')
  assert.ok(size > 400 * 1024 && size <= MAX_RESPONSE_BYTES, `unexpected response size ${size}`)
})

test('createViewDispatch fails closed for unknown endpoints', async () => {
  const service = createViewService({ bridge: createBridgeStub(), settings: testSettings() })
  const dispatch = createViewDispatch(service)
  assert.deepEqual(await dispatch('view.unknown', {}), {
    ok: false,
    error: { code: 'INVALID_ARGUMENT', message: 'unknown view endpoint' },
  })
  assert.deepEqual(Object.keys(service), VIEW_ENDPOINTS)
  assert.throws(() => createViewDispatch(null), /requires a view service/)
  assert.throws(() => createViewService({}), /requires bridge\.execute/)
})

// ---------------------------------------------------------------------------
// S2a five-view endpoints (docs/five-view-contract.md §2)
// ---------------------------------------------------------------------------
const WORKSPACE = 'code-view-bus-demo'
const ENTRY = 'f_afa8298f2d197e5fd110e49a'

test('VIEW_ENDPOINTS keeps the read-only endpoints and appends the five-view and S2b endpoints', () => {
  assert.deepEqual(VIEW_ENDPOINTS, [
    'view.status',
    'view.listSnapshots',
    'view.listEntries',
    'view.getEntry',
    'view.coupling',
    'view.tree',
    'view.endToEnd',
    'view.fileTree',
    'view.fileRead',
    'view.sequence',
    'view.interfaces',
  ])
  const service = createViewService({ bridge: createBridgeStub(), settings: testSettings() })
  assert.deepEqual(Object.keys(service), [...VIEW_ENDPOINTS])
})

test('view.coupling maps to the fixed argv with an optional entry', async () => {
  const engineJson = {
    schema_version: 1,
    scope: { mode: 'entry_neighborhood', entry_id: ENTRY },
    resources: [],
    functions: [],
    edges: [],
    external_nodes: [],
    gaps: [],
    truncated: false,
  }
  const bridge = createBridgeStub(async () => engineOk(engineJson))
  const { route } = mount({ bridge })
  const result = await invoke(route, {
    endpoint: 'view.coupling',
    payload: { workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY },
  })
  assert.equal(result.json.result.ok, true)
  assert.deepEqual(result.json.result.value, engineJson)
  assert.deepEqual(bridge.calls.map((call) => call.argv), [
    ['view-coupling', '--workspace', WORKSPACE, '--snapshot', SNAPSHOT_ID, '--entry', ENTRY],
  ])

  // entry omitted or null → snapshot scope without --entry.
  const omitted = await invoke(route, { endpoint: 'view.coupling', payload: { workspace: WORKSPACE, snapshot: SNAPSHOT_ID } })
  assert.equal(omitted.json.result.ok, true)
  assert.deepEqual(bridge.calls.at(-1).argv, ['view-coupling', '--workspace', WORKSPACE, '--snapshot', SNAPSHOT_ID])
  await invoke(route, { endpoint: 'view.coupling', payload: { workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: null } })
  assert.deepEqual(bridge.calls.at(-1).argv, ['view-coupling', '--workspace', WORKSPACE, '--snapshot', SNAPSHOT_ID])

  const before = bridge.calls.length
  const rejected = [
    [{}, /workspace is required/],
    [{ workspace: WORKSPACE }, /snapshot is required/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: 42 }, /entry must be a string/],
    [{ workspace: 'Code-View', snapshot: SNAPSHOT_ID }, /workspace must match/],
    [{ workspace: 'a'.repeat(129), snapshot: SNAPSHOT_ID }, /at most 128 characters/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, extra: true }, /unknown payload field: extra/],
  ]
  for (const [payload, message] of rejected) {
    const bad = await invoke(route, { endpoint: 'view.coupling', payload })
    assert.equal(bad.json.result.error.code, 'INVALID_ARGUMENT')
    assert.match(bad.json.result.error.message, message)
  }
  assert.equal(bridge.calls.length, before, 'invalid payloads must not reach the engine')
})

test('view.tree maps to the fixed argv and requires a bounded entry', async () => {
  const engineJson = { schema_version: 1, entry: { entry_id: ENTRY, name: 'bus_send' }, nodes: [], max_depth: 8, gaps: [], truncated: false }
  const bridge = createBridgeStub(async () => engineOk(engineJson))
  const { route } = mount({ bridge })
  const result = await invoke(route, {
    endpoint: 'view.tree',
    payload: { workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY },
  })
  assert.equal(result.json.result.ok, true)
  assert.deepEqual(result.json.result.value, engineJson)
  assert.deepEqual(bridge.calls.map((call) => call.argv), [
    ['view-tree', '--workspace', WORKSPACE, '--snapshot', SNAPSHOT_ID, '--entry', ENTRY],
  ])

  const before = bridge.calls.length
  const rejected = [
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID }, /entry is required/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: '' }, /entry must be a non-empty string/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: 'f'.repeat(513) }, /at most 512 characters/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: 'bad/entry' }, /entry must match/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY, depth: 2 }, /unknown payload field: depth/],
  ]
  for (const [payload, message] of rejected) {
    const bad = await invoke(route, { endpoint: 'view.tree', payload })
    assert.equal(bad.json.result.error.code, 'INVALID_ARGUMENT')
    assert.match(bad.json.result.error.message, message)
  }
  assert.equal(bridge.calls.length, before, 'invalid payloads must not reach the engine')
})

test('view.endToEnd maps to the fixed argv and supports the optional S2b root', async () => {
  const engineJson = {
    schema_version: 1,
    entry: { entry_id: ENTRY, name: 'bus_send' },
    nodes: [],
    edges: [],
    exits: [],
    legend: [],
    layout: { direction: 'DOWN', edge_routing: 'ORTHOGONAL' },
    gaps: [],
    truncated: false,
  }
  const bridge = createBridgeStub(async () => engineOk(engineJson))
  const { route } = mount({ bridge })
  const result = await invoke(route, {
    endpoint: 'view.endToEnd',
    payload: { workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY },
  })
  assert.equal(result.json.result.ok, true)
  assert.deepEqual(result.json.result.value, engineJson)
  assert.deepEqual(bridge.calls.map((call) => call.argv), [
    ['view-end-to-end', '--workspace', WORKSPACE, '--snapshot', SNAPSHOT_ID, '--entry', ENTRY],
  ])

  // S2b sub-flow root: appended after --entry.
  const root = 'f_1a2b3c4d5e6f708192a3b4c5'
  await invoke(route, {
    endpoint: 'view.endToEnd',
    payload: { workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY, root },
  })
  assert.deepEqual(bridge.calls.at(-1).argv, [
    'view-end-to-end', '--workspace', WORKSPACE, '--snapshot', SNAPSHOT_ID, '--entry', ENTRY, '--root', root,
  ])
  // root omitted / null → no --root.
  await invoke(route, { endpoint: 'view.endToEnd', payload: { workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY, root: null } })
  assert.deepEqual(bridge.calls.at(-1).argv, [
    'view-end-to-end', '--workspace', WORKSPACE, '--snapshot', SNAPSHOT_ID, '--entry', ENTRY,
  ])
  await invoke(route, { endpoint: 'view.endToEnd', payload: { workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY } })
  assert.deepEqual(bridge.calls.at(-1).argv, [
    'view-end-to-end', '--workspace', WORKSPACE, '--snapshot', SNAPSHOT_ID, '--entry', ENTRY,
  ])

  const before = bridge.calls.length
  const rejected = [
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID }, /entry is required/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY, mode: 'static' }, /unknown payload field: mode/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY, root: 42 }, /root must be a string/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY, root: '' }, /root must be a non-empty string/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY, root: 'f'.repeat(513) }, /at most 512 characters/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY, root: 'bad/root' }, /root must match/],
  ]
  for (const [payload, message] of rejected) {
    const bad = await invoke(route, { endpoint: 'view.endToEnd', payload })
    assert.equal(bad.json.result.error.code, 'INVALID_ARGUMENT')
    assert.match(bad.json.result.error.message, message)
  }
  assert.equal(bridge.calls.length, before, 'invalid payloads must not reach the engine')
})

test('view.fileTree maps to the fixed argv and rejects entry input', async () => {
  const engineJson = { schema_version: 1, repos: [], gaps: [], truncated: false }
  const bridge = createBridgeStub(async () => engineOk(engineJson))
  const { route } = mount({ bridge })
  const result = await invoke(route, {
    endpoint: 'view.fileTree',
    payload: { workspace: WORKSPACE, snapshot: SNAPSHOT_ID },
  })
  assert.equal(result.json.result.ok, true)
  assert.deepEqual(result.json.result.value, engineJson)
  assert.deepEqual(bridge.calls.map((call) => call.argv), [
    ['view-file-tree', '--workspace', WORKSPACE, '--snapshot', SNAPSHOT_ID],
  ])

  const before = bridge.calls.length
  const rejected = [
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY }, /unknown payload field: entry/],
    [{ workspace: WORKSPACE }, /snapshot is required/],
    [{ snapshot: SNAPSHOT_ID }, /workspace is required/],
  ]
  for (const [payload, message] of rejected) {
    const bad = await invoke(route, { endpoint: 'view.fileTree', payload })
    assert.equal(bad.json.result.error.code, 'INVALID_ARGUMENT')
    assert.match(bad.json.result.error.message, message)
  }
  assert.equal(bridge.calls.length, before)
})

test('view.fileRead validates the repository path and maps to the fixed argv', async () => {
  const engineJson = { schema_version: 1, repo_id: 'bus', path: 'bus.c', lines: [], gaps: [], truncated: false }
  const bridge = createBridgeStub(async () => engineOk(engineJson))
  const { route } = mount({ bridge })
  const base = { workspace: WORKSPACE, snapshot: SNAPSHOT_ID, repo: 'bus' }

  const result = await invoke(route, { endpoint: 'view.fileRead', payload: { ...base, path: 'bus.c' } })
  assert.equal(result.json.result.ok, true)
  assert.deepEqual(result.json.result.value, engineJson)
  assert.deepEqual(bridge.calls.at(-1).argv, [
    'view-file-read', '--workspace', WORKSPACE, '--snapshot', SNAPSHOT_ID, '--repo', 'bus', '--path', 'bus.c',
  ])

  // Nested repository-relative path and explicit 1..2000 window.
  await invoke(route, { endpoint: 'view.fileRead', payload: { ...base, path: 'include/routes.h', max_lines: 174 } })
  assert.deepEqual(bridge.calls.at(-1).argv, [
    'view-file-read', '--workspace', WORKSPACE, '--snapshot', SNAPSHOT_ID, '--repo', 'bus', '--path', 'include/routes.h', '--max-lines', '174',
  ])
  await invoke(route, { endpoint: 'view.fileRead', payload: { ...base, path: 'bus.c', max_lines: 1 } })
  assert.deepEqual(bridge.calls.at(-1).argv, [
    'view-file-read', '--workspace', WORKSPACE, '--snapshot', SNAPSHOT_ID, '--repo', 'bus', '--path', 'bus.c', '--max-lines', '1',
  ])
  await invoke(route, { endpoint: 'view.fileRead', payload: { ...base, path: 'bus.c', max_lines: 2000 } })
  assert.deepEqual(bridge.calls.at(-1).argv, [
    'view-file-read', '--workspace', WORKSPACE, '--snapshot', SNAPSHOT_ID, '--repo', 'bus', '--path', 'bus.c', '--max-lines', '2000',
  ])
  // null max_lines means the engine default (flag omitted).
  await invoke(route, { endpoint: 'view.fileRead', payload: { ...base, path: 'bus.c', max_lines: null } })
  assert.deepEqual(bridge.calls.at(-1).argv, [
    'view-file-read', '--workspace', WORKSPACE, '--snapshot', SNAPSHOT_ID, '--repo', 'bus', '--path', 'bus.c',
  ])

  const before = bridge.calls.length
  const badPaths = [
    ['../bus.c', /path must not contain/],
    ['a/../b.c', /path must not contain/],
    ['./bus.c', /path must not contain/],
    ['a/./b.c', /path must not contain/],
    ['/etc/passwd', /absolute paths are not allowed/],
    ['C:/boot.c', /absolute paths are not allowed/],
    ['C:\\boot.c', /must use POSIX separators/],
    ['a\\b.c', /must use POSIX separators/],
    ['a//b.c', /path must not contain/],
    ['a/b.c/', /path must not contain/],
    ['bus\u0000.c', /control characters/],
  ]
  for (const [badPath, message] of badPaths) {
    const bad = await invoke(route, { endpoint: 'view.fileRead', payload: { ...base, path: badPath } })
    assert.equal(bad.json.result.error.code, 'INVALID_ARGUMENT', `path ${JSON.stringify(badPath)} must be rejected`)
    assert.match(bad.json.result.error.message, message)
  }
  const rejected = [
    [{ ...base, path: 'a'.repeat(513) }, /at most 512 characters/],
    [{ ...base, path: 42 }, /path must be a string/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, repo: 'bus' }, /path is required/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, repo: 'Bus', path: 'bus.c' }, /repo must match/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, path: 'bus.c' }, /repo is required/],
    [{ ...base, path: 'bus.c', max_lines: 0 }, /max_lines must be an integer in 1\.\.2000/],
    [{ ...base, path: 'bus.c', max_lines: 2001 }, /max_lines must be an integer in 1\.\.2000/],
    [{ ...base, path: 'bus.c', max_lines: 1.5 }, /max_lines must be an integer/],
    [{ ...base, path: 'bus.c', max_lines: '10' }, /max_lines must be an integer/],
    [{ ...base, path: 'bus.c', maxLines: 10 }, /unknown payload field: maxLines/],
  ]
  for (const [payload, message] of rejected) {
    const bad = await invoke(route, { endpoint: 'view.fileRead', payload })
    assert.equal(bad.json.result.error.code, 'INVALID_ARGUMENT')
    assert.match(bad.json.result.error.message, message)
  }
  assert.equal(bridge.calls.length, before, 'invalid payloads must not reach the engine')
})

test('view.sequence maps to the fixed static argv and rejects other modes', async () => {
  const engineJson = {
    schema_version: 1,
    mode: 'static',
    observed: false,
    warning: '静态预测：无运行观测，不表示实际执行顺序或取值',
    participants: [],
    messages: [],
    gaps: [{ code: 'run_observation', status: 'unavailable', reason: 'S2a 无运行观测；场景/轨迹导入在 CW-T3' }],
  }
  const bridge = createBridgeStub(async () => engineOk(engineJson))
  const { route } = mount({ bridge })
  const payload = { workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY }
  const result = await invoke(route, { endpoint: 'view.sequence', payload: { ...payload, mode: 'static' } })
  assert.equal(result.json.result.ok, true)
  assert.deepEqual(result.json.result.value, engineJson)
  const staticArgv = ['view-sequence', '--workspace', WORKSPACE, '--snapshot', SNAPSHOT_ID, '--entry', ENTRY, '--mode', 'static']
  assert.deepEqual(bridge.calls.at(-1).argv, staticArgv)

  // Omitted/null mode defaults to static; the argv is always fully fixed.
  await invoke(route, { endpoint: 'view.sequence', payload })
  assert.deepEqual(bridge.calls.at(-1).argv, staticArgv)
  await invoke(route, { endpoint: 'view.sequence', payload: { ...payload, mode: null } })
  assert.deepEqual(bridge.calls.at(-1).argv, staticArgv)

  const before = bridge.calls.length
  const rejected = [
    [{ ...payload, mode: 'observed' }, /mode must be 'static'/],
    [{ ...payload, mode: 42 }, /mode must be 'static'/],
    [{ ...payload, mode: 'Static' }, /mode must be 'static'/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, mode: 'static' }, /entry is required/],
    [{ ...payload, max_messages: 10 }, /unknown payload field: max_messages/],
  ]
  for (const [badPayload, message] of rejected) {
    const bad = await invoke(route, { endpoint: 'view.sequence', payload: badPayload })
    assert.equal(bad.json.result.error.code, 'INVALID_ARGUMENT')
    assert.match(bad.json.result.error.message, message)
  }
  assert.equal(bridge.calls.length, before, 'invalid payloads must not reach the engine')
})

// ---------------------------------------------------------------------------
// S2b increment: base interface library (docs/five-view-contract.md §10.2)
// ---------------------------------------------------------------------------
test('view.interfaces maps to the fixed argv with an optional entry', async () => {
  const engineJson = {
    schema_version: 1,
    snapshot: { snapshot_id: SNAPSHOT_ID },
    selection: {},
    candidates: [],
    external_boundaries: [],
    gaps: [],
    truncated: false,
  }
  const bridge = createBridgeStub(async () => engineOk(engineJson))
  const { route } = mount({ bridge })
  const result = await invoke(route, {
    endpoint: 'view.interfaces',
    payload: { workspace: WORKSPACE, snapshot: SNAPSHOT_ID },
  })
  assert.equal(result.json.result.ok, true)
  assert.deepEqual(result.json.result.value, engineJson)
  assert.deepEqual(bridge.calls.map((call) => call.argv), [
    ['view-interfaces', '--workspace', WORKSPACE, '--snapshot', SNAPSHOT_ID],
  ])

  // Optional entry: provided → --entry; omitted/null → snapshot-wide pool.
  await invoke(route, {
    endpoint: 'view.interfaces',
    payload: { workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY },
  })
  assert.deepEqual(bridge.calls.at(-1).argv, [
    'view-interfaces', '--workspace', WORKSPACE, '--snapshot', SNAPSHOT_ID, '--entry', ENTRY,
  ])
  await invoke(route, {
    endpoint: 'view.interfaces',
    payload: { workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: null },
  })
  assert.deepEqual(bridge.calls.at(-1).argv, [
    'view-interfaces', '--workspace', WORKSPACE, '--snapshot', SNAPSHOT_ID,
  ])

  const before = bridge.calls.length
  const rejected = [
    [{}, /workspace is required/],
    [{ workspace: WORKSPACE }, /snapshot is required/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: 42 }, /entry must be a string/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: 'f'.repeat(513) }, /at most 512 characters/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: 'bad/entry' }, /entry must match/],
    [{ workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY, mode: 'static' }, /unknown payload field: mode/],
    [{ workspace: 'Code-View', snapshot: SNAPSHOT_ID }, /workspace must match/],
  ]
  for (const [payload, message] of rejected) {
    const bad = await invoke(route, { endpoint: 'view.interfaces', payload })
    assert.equal(bad.json.result.error.code, 'INVALID_ARGUMENT')
    assert.match(bad.json.result.error.message, message)
  }
  assert.equal(bridge.calls.length, before, 'invalid payloads must not reach the engine')
})

test('view endpoints map BridgeError without leaking host paths', async () => {
  const bridge = createBridgeStub(async () => {
    throw new BridgeError('DEPENDENCY_UNAVAILABLE', 'engine at C:\\Users\\admin\\python.exe failed')
  })
  const { route } = mount({ bridge })
  const calls = [
    ['view.coupling', { workspace: WORKSPACE, snapshot: SNAPSHOT_ID }],
    ['view.tree', { workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY }],
    ['view.endToEnd', { workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY }],
    ['view.endToEnd', { workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY, root: ENTRY }],
    ['view.fileTree', { workspace: WORKSPACE, snapshot: SNAPSHOT_ID }],
    ['view.fileRead', { workspace: WORKSPACE, snapshot: SNAPSHOT_ID, repo: 'bus', path: 'bus.c' }],
    ['view.sequence', { workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY }],
    ['view.interfaces', { workspace: WORKSPACE, snapshot: SNAPSHOT_ID }],
    ['view.interfaces', { workspace: WORKSPACE, snapshot: SNAPSHOT_ID, entry: ENTRY }],
  ]
  for (const [endpoint, payload] of calls) {
    const result = await invoke(route, { endpoint, payload })
    assert.equal(result.response.statusCode, 200, endpoint)
    assert.equal(result.json.result.ok, false, endpoint)
    assert.equal(result.json.result.error.code, 'BRIDGE_UNAVAILABLE', endpoint)
    assert.deepEqual(result.json.result.error.details, {})
    assert.equal(result.response.body.includes('Users'), false, endpoint)
    assert.equal(result.response.body.includes('python.exe'), false, endpoint)
  }
})

test('the 512 KiB response cap still applies to five-view responses', async () => {
  const huge = { schema_version: 1, resources: 'x'.repeat(MAX_RESPONSE_BYTES) }
  const bridge = createBridgeStub(async () => engineOk(huge))
  const { route } = mount({ bridge })
  const result = await invoke(route, {
    endpoint: 'view.coupling',
    payload: { workspace: WORKSPACE, snapshot: SNAPSHOT_ID },
  })
  assert.equal(result.response.statusCode, 200)
  assert.equal(result.json.result.ok, false)
  assert.equal(result.json.result.error.code, 'gateway/internal')
  assert.equal(result.json.result.error.message, 'internal failure')
  assert.ok(Buffer.byteLength(result.response.body, 'utf8') < 1024)
  assert.equal(result.response.body.includes('xxxx'), false)
})

// ---------------------------------------------------------------------------
// plugin wiring: the UI half is a nested plugin with its own hard injects
// ---------------------------------------------------------------------------
function createPluginHost({ services = false } = {}) {
  const state = { routes: new Map(), effects: [], plugins: [], activated: [], pending: [] }
  const host = {
    tools: { register: () => () => {} },
    skills: { registerProvider: () => () => {} },
    effect(callback, label) {
      const disposer = callback()
      state.effects.push({ label, disposer })
      return disposer
    },
    plugin(definition) {
      state.plugins.push(definition)
      const required = Array.isArray(definition.inject) ? definition.inject : []
      const missing = required.filter((serviceName) => host[serviceName] === undefined)
      if (missing.length > 0) {
        // Cordis keeps an unsatisfied plugin fiber pending instead of failing.
        state.pending.push({ name: definition.name, missing })
        return { dispose() {} }
      }
      state.activated.push(definition.name)
      definition.apply(Object.create(host))
      return { dispose() {} }
    },
  }
  if (services) {
    host.connection = { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }
    host.webServer = {
      register(route) {
        state.routes.set(route.path, route)
        return () => {
          state.routes.delete(route.path)
        }
      },
    }
  }
  return { ctx: host, state }
}

test('plugin identity is unchanged and the UI fiber stays pending without host services', () => {
  assert.equal(pluginName, 'dsh-code-reader')
  assert.deepEqual(inject, ['tools', 'skills'])
  const { ctx, state } = createPluginHost({ services: false })
  apply(ctx, {})
  // Old behaviour is untouched: six tools plus the skill provider register.
  assert.deepEqual(
    state.effects.filter((effect) => /register tool/.test(effect.label)).map((effect) => effect.label).sort(),
    [
      'dsh-code-reader: register tool code_learn',
      'dsh-code-reader: register tool code_overview',
      'dsh-code-reader: register tool code_path',
      'dsh-code-reader: register tool code_snapshot',
      'dsh-code-reader: register tool code_source',
      'dsh-code-reader: register tool code_workspace',
    ],
  )
  assert.ok(state.effects.some((effect) => /skill/.test(effect.label)))
  assert.equal(state.plugins.length, 1)
  assert.equal(state.plugins[0].name, 'dsh-code-reader-view')
  assert.deepEqual(state.plugins[0].inject, ['connection', 'webServer'])
  assert.equal(typeof state.plugins[0].apply, 'function')
  // connection/webServer are missing: the fiber is pending, no route is mounted.
  assert.deepEqual(state.activated, [])
  assert.deepEqual(state.pending, [{ name: 'dsh-code-reader-view', missing: ['connection', 'webServer'] }])
  assert.equal(state.routes.size, 0)
})

test('plugin mounts the /code-view prefix route when host services are available', async () => {
  const { ctx, state } = createPluginHost({ services: true })
  apply(ctx, {})
  assert.deepEqual(state.activated, ['dsh-code-reader-view'])
  assert.equal(state.routes.size, 1)
  const route = state.routes.get('/code-view')
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/code-view')
  assert.equal(typeof route.handler, 'function')

  // The nested route's whitelist covers the S2a/S2b endpoints too: an invalid
  // payload is rejected by the read model before the bridge (no engine spawn).
  for (const endpoint of ['view.coupling', 'view.tree', 'view.endToEnd', 'view.fileTree', 'view.fileRead', 'view.sequence', 'view.interfaces']) {
    const rejected = await invoke(route, {
      endpoint,
      payload: { workspace: 'NOT A WORKSPACE', snapshot: SNAPSHOT_ID, entry: 'bad entry', mode: 'observed' },
    })
    assert.equal(rejected.response.statusCode, 200, endpoint)
    assert.equal(rejected.json.result.error.code, 'INVALID_ARGUMENT', endpoint)
  }

  // The route is effect-scoped: disposing that effect removes it.
  const routeEffect = state.effects.find((effect) => /\/code-view http rpc route/.test(effect.label))
  assert.ok(routeEffect, 'route effect must be registered on the nested fiber')
  routeEffect.disposer()
  assert.equal(state.routes.size, 0)
})
