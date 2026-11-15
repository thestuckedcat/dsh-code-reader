// dsh-code-reader: the plugin's own HTTP carrier for the read-only code view.
//
// The reviewed rc.5 seam is the webServer route registry plus the connection
// service's admission (`ctx.connection.admit(req)`). The shared `/api` RPC
// channel is single-owner and `ctx.connection.rpc.handle` is registered through
// the connection service's own fiber, so a consumer plugin cannot use either
// (both verified at runtime by 08-workbench-ui). This module reimplements that
// mechanism locally on a private `/code-view` prefix; it neither imports nor
// depends on the 08 package.
//
// Wire contract (docs/readonly-workbench-contract.md §4.1):
//   POST /code-view/<endpoint>
//   request  {"type":"client-request","rpcId":"…","method":"<endpoint>","payload":{…}}
//   response {"type":"server-response","rpcId":"…","result":
//              {"ok":true,"value":…} | {"ok":false,"error":{"code":"…","message":"…","details":{}}}}
//
// Every JSON answer is HTTP 200: the rc.5 browser `connection.rpc.call` treats
// any other status code as a transport failure before it parses the envelope,
// and its response validator requires `error.details` to be a record. The
// carrier therefore always emits an empty details object, never echoes host
// error text or absolute paths, and only uses 401/403 for admission failures
// (which terminate the request before the envelope).
import { Buffer } from 'node:buffer'

export const HTTP_RPC_CHANNEL = '/code-view'
export const MAX_REQUEST_BYTES = 16 * 1024
export const MAX_RESPONSE_BYTES = 512 * 1024

const RPC_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_./-]{1,64}$/
const MAX_ERROR_MESSAGE_CHARS = 512

const BAD_REQUEST_RESULT = Object.freeze({
  ok: false,
  error: Object.freeze({ code: 'gateway/bad-request', message: 'invalid client-request message', details: Object.freeze({}) }),
})
const INTERNAL_FAILURE_RESULT = Object.freeze({
  ok: false,
  error: Object.freeze({ code: 'gateway/internal', message: 'internal failure', details: Object.freeze({}) }),
})

function serverResponse(rpcId, result) {
  return { type: 'server-response', rpcId, result }
}

function jsonResponse(res, payload, { status = 200, close = false } = {}) {
  const body = JSON.stringify(payload)
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body, 'utf8'),
  }
  if (close) headers.connection = 'close'
  res.writeHead(status, headers)
  res.end(body)
}

function plainResponse(res, status, text, { close = false } = {}) {
  const headers = { 'content-type': 'text/plain; charset=utf-8' }
  if (close) headers.connection = 'close'
  res.writeHead(status, headers)
  res.end(text)
}

function validRpcId(value) {
  return typeof value === 'string' && RPC_ID_PATTERN.test(value) ? value : undefined
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readBody(req, limit) {
  if (typeof req?.[Symbol.asyncIterator] !== 'function') return { ok: false, reason: 'UNREADABLE' }
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buffer.length
      if (size > limit) return { ok: false, reason: 'LIMIT_EXCEEDED' }
      chunks.push(buffer)
    }
  } catch {
    return { ok: false, reason: 'READ_FAILED' }
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') }
}

/** Null means "no envelope": the request is answered with gateway/bad-request. */
function parseClientRequest(parsed) {
  if (!isRecord(parsed)) return null
  if (parsed.type !== 'client-request') return null
  if (validRpcId(parsed.rpcId) === undefined) return null
  if (typeof parsed.method !== 'string' || !ENDPOINT_SEGMENT_PATTERN.test(parsed.method)) return null
  return { rpcId: parsed.rpcId, method: parsed.method, payload: parsed.payload }
}

/** rc.5 `admit` returns `{peer}` or `{rejection}`; anything else is denied closed. */
function admissionStatus(admission) {
  if (isRecord(admission) && 'peer' in admission && !('rejection' in admission)) return null
  if (isRecord(admission) && admission.rejection === 401) return 401
  return 403
}

/**
 * Normalize a view-service handler result into the frozen server-response
 * result shape. Anything malformed becomes a fixed internal failure so that no
 * unexpected host text, stack or path can leak to the browser.
 */
function normalizeResult(result) {
  if (!isRecord(result)) return INTERNAL_FAILURE_RESULT
  if (result.ok === true) return { ok: true, value: result.value === undefined ? null : result.value }
  if (result.ok !== false || !isRecord(result.error)) return INTERNAL_FAILURE_RESULT
  const error = result.error
  if (typeof error.code !== 'string' || !ERROR_CODE_PATTERN.test(error.code)) return INTERNAL_FAILURE_RESULT
  let message = typeof error.message === 'string' && error.message.length > 0 ? error.message : 'request failed'
  if (message.length > MAX_ERROR_MESSAGE_CHARS) message = message.slice(0, MAX_ERROR_MESSAGE_CHARS)
  return { ok: false, error: { code: error.code, message, details: {} } }
}

/**
 * Register the read-only workbench's POST /code-view/<endpoint> carrier on the
 * reviewed webServer route registry. Call from a context that injects both
 * `connection` and `webServer`; the route is effect-scoped to that fiber.
 *
 * @param {object} ctx Host context exposing `connection.admit` and `webServer.register`.
 * @param {{channel?: string, handler: Function, methods?: string[]}} options
 *   handler(endpoint, payload, signal) → {ok:true,value} | {ok:false,error:{code,message}}
 *   methods whitelists the endpoint names; omitted means "any safe segment".
 * @returns {Function} disposer that removes the route.
 */
export function registerWorkbenchHttpRoute(ctx, { channel = HTTP_RPC_CHANNEL, handler, methods } = {}) {
  if (typeof ctx?.connection?.admit !== 'function') throw new Error('dsh-code-reader: connection.admit is unavailable')
  if (typeof ctx?.webServer?.register !== 'function') throw new Error('dsh-code-reader: webServer.register is unavailable')
  if (typeof handler !== 'function') throw new Error('dsh-code-reader: http rpc handler must be a function')
  if (typeof channel !== 'string' || !channel.startsWith('/') || channel.length < 2) {
    throw new Error('dsh-code-reader: http rpc channel must be an absolute path')
  }
  const allowedMethods = Array.isArray(methods) ? new Set(methods.filter((name) => typeof name === 'string')) : null
  const prefix = `${channel}/`

  const route = {
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      let rpcId = 'invalid-request'
      try {
        if (req.method !== 'POST') {
          plainResponse(res, 405, 'method not allowed')
          return
        }
        let admission
        try {
          admission = ctx.connection.admit(req)
        } catch {
          // Admission is a host boundary: fail closed before touching the body.
          plainResponse(res, 403, 'forbidden')
          return
        }
        const rejection = admissionStatus(admission)
        if (rejection !== null) {
          plainResponse(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        const pathname = String(req.url ?? '').split('?', 1)[0]
        const endpoint = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : ''
        if (endpoint === '' || !ENDPOINT_SEGMENT_PATTERN.test(endpoint)) {
          jsonResponse(res, serverResponse(rpcId, BAD_REQUEST_RESULT))
          return
        }
        const declaredLength = Number(req.headers?.['content-length'])
        if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
          try {
            req.resume?.()
          } catch {
            /* body already settled */
          }
          jsonResponse(res, serverResponse(rpcId, BAD_REQUEST_RESULT), { close: true })
          return
        }
        const body = await readBody(req, MAX_REQUEST_BYTES)
        if (!body.ok) {
          try {
            req.resume?.()
          } catch {
            /* body already settled */
          }
          jsonResponse(res, serverResponse(rpcId, BAD_REQUEST_RESULT), { close: body.reason === 'LIMIT_EXCEEDED' })
          return
        }
        let parsed
        try {
          parsed = JSON.parse(body.text)
        } catch {
          jsonResponse(res, serverResponse(rpcId, BAD_REQUEST_RESULT))
          return
        }
        rpcId = validRpcId(parsed?.rpcId) ?? rpcId
        const envelope = parseClientRequest(parsed)
        if (envelope === null || envelope.method !== endpoint) {
          jsonResponse(res, serverResponse(rpcId, BAD_REQUEST_RESULT))
          return
        }
        if (allowedMethods !== null && !allowedMethods.has(envelope.method)) {
          jsonResponse(res, serverResponse(rpcId, BAD_REQUEST_RESULT))
          return
        }
        const controller = new AbortController()
        if (typeof req.on === 'function') {
          req.on('aborted', () => controller.abort(new Error('client disconnected')))
        }
        let result
        try {
          result = await handler(envelope.method, envelope.payload, controller.signal)
        } catch {
          jsonResponse(res, serverResponse(envelope.rpcId, INTERNAL_FAILURE_RESULT))
          return
        }
        const normalized = normalizeResult(result)
        let encoded
        try {
          encoded = JSON.stringify(serverResponse(envelope.rpcId, normalized))
        } catch {
          jsonResponse(res, serverResponse(envelope.rpcId, INTERNAL_FAILURE_RESULT))
          return
        }
        if (Buffer.byteLength(encoded, 'utf8') > MAX_RESPONSE_BYTES) {
          // Never stream a partial/oversized body: answer with the fixed small
          // internal envelope instead.
          jsonResponse(res, serverResponse(envelope.rpcId, INTERNAL_FAILURE_RESULT))
          return
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(encoded, 'utf8'),
        })
        res.end(encoded)
      } catch {
        // Fixed envelope only: never leak error text, stack or absolute paths.
        try {
          jsonResponse(res, serverResponse(rpcId, INTERNAL_FAILURE_RESULT))
        } catch {
          /* response already owned/completed */
        }
      }
    },
  }
  return ctx.effect(() => ctx.webServer.register(route), `dsh-code-reader: ${channel} http rpc route`)
}
