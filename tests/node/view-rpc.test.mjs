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
    five_views: false,
    resource_graph: false,
    scenario_execution: false,
    run_observation: false,
  })
  assert.deepEqual(
    value.gaps.map((gap) => gap.code),
    ['five_views', 'resource_graph', 'scenario_execution', 'run_observation'],
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
  // Availability is carried by `engine`; `gaps` stays the fixed slice capability
  // list so the UI does not render duplicate engine/bootstrap rows.
  assert.deepEqual(
    value.gaps.map((gap) => gap.code),
    ['five_views', 'resource_graph', 'scenario_execution', 'run_observation'],
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

test('plugin mounts the /code-view prefix route when host services are available', () => {
  const { ctx, state } = createPluginHost({ services: true })
  apply(ctx, {})
  assert.deepEqual(state.activated, ['dsh-code-reader-view'])
  assert.equal(state.routes.size, 1)
  const route = state.routes.get('/code-view')
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/code-view')
  assert.equal(typeof route.handler, 'function')
  // The route is effect-scoped: disposing that effect removes it.
  const routeEffect = state.effects.find((effect) => /\/code-view http rpc route/.test(effect.label))
  assert.ok(routeEffect, 'route effect must be registered on the nested fiber')
  routeEffect.disposer()
  assert.equal(state.routes.size, 0)
})
