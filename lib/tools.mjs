// Agent-facing tools. Every definition owns one fixed CLI argv shape; model
// arguments only fill typed slots, never an executable, cwd, path root or
// environment variable.
import { BridgeError } from './bridge.mjs'

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    schema_version: { type: 'integer' },
    ok: { type: 'boolean' },
    exit_code: { type: 'integer' },
    cli: {},
  },
  required: ['schema_version', 'ok', 'exit_code'],
  additionalProperties: true,
}

function render(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function definition({ name, description, parameters, handler }) {
  return Object.freeze({
    name,
    description,
    parameters,
    output: { schema: OUTPUT_SCHEMA, render },
    execute: async (args, exec) => handler(args ?? {}, exec),
  })
}

function invalid(message) {
  throw new BridgeError('INVALID_ARGUMENT', message)
}

function requireString(args, name, { min = 1, max = 1024, allowed } = {}) {
  const value = args[name]
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    invalid(`${name} must be a string of length ${min}..${max}`)
  }
  if (allowed && !allowed.includes(value)) invalid(`${name} must be one of: ${allowed.join(', ')}`)
  return value
}

function optionalString(args, name, { min = 1, max = 1024 } = {}) {
  if (args[name] === undefined || args[name] === null) return undefined
  return requireString(args, name, { min, max })
}

function optionalInt(args, name, { min = 0, max = 2 ** 31 - 1 } = {}) {
  if (args[name] === undefined || args[name] === null) return undefined
  const value = args[name]
  if (!Number.isInteger(value) || value < min || value > max) invalid(`${name} must be an integer in ${min}..${max}`)
  return value
}

function requireEnum(args, name, allowed) {
  return requireString(args, name, { max: 64, allowed })
}

function pushFlag(argv, flag, value) {
  if (value !== undefined) argv.push(flag, String(value))
}

export function buildTools(bridge) {
  const invoke = (argv, exec) => bridge.execute(argv, { signal: exec?.signal })

  const workspace = definition({
    name: 'code_workspace',
    description:
      'Register, validate or inspect a local Linux driver/user-space code workspace for the code-learning flow. USE WHEN the user wants to study a repository, when starting any code-learning session, or when checking whether a registered workspace or its build variants are still fresh. Actions: import (reads an inbox manifest under the trusted bootstrap scope and CAS-updates the workspace revision), validate (re-checks scope/build inputs without executing compilers), status (variants, semantic status, snapshots, freshness). This tool never indexes or builds code; source-only workspaces remain readable with semantic_status=blocked.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['import', 'validate', 'status'], description: 'Which workspace operation to run.' },
        workspace: { type: 'string', maxLength: 128, description: 'Registered workspace_id (required for status; optional for validate).' },
        manifest: { type: 'string', maxLength: 256, description: 'Manifest filename inside the trusted import inbox (import only).' },
        expected_revision: { type: 'integer', minimum: 0, description: 'Revision precondition; use 0 for the first registration (default 0).' },
        operation_id: { type: 'string', maxLength: 128, description: 'Idempotency id; omit to let the bridge generate one.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: async (args, exec) => {
      const action = requireEnum(args, 'action', ['import', 'validate', 'status'])
      if (action === 'import') {
        const manifest = requireString(args, 'manifest', { max: 256 })
        const expected = optionalInt(args, 'expected_revision') ?? 0
        const operationId = optionalString(args, 'operation_id', { max: 128 }) ?? bridge.newOperationId()
        return invoke(['workspace-import', '--manifest', manifest, '--expected-revision', String(expected), '--operation-id', operationId], exec)
      }
      if (action === 'validate') {
        const argv = ['workspace-validate']
        pushFlag(argv, '--workspace', optionalString(args, 'workspace', { max: 128 }))
        return invoke(argv, exec)
      }
      const workspaceId = requireString(args, 'workspace', { max: 128 })
      return invoke(['status', '--workspace', workspaceId], exec)
    },
  })

  const overview = definition({
    name: 'code_overview',
    description:
      'Show the first small map of one registered workspace variant: repositories/components, interface candidates, unknown boundaries and current snapshot coverage. USE WHEN the user asks "where do I start" or wants a repository/component overview before choosing one question. Declared roles and text candidates are not compiler facts; only evidence-backed items are marked as such.',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', maxLength: 128 },
        variant: { type: 'string', maxLength: 128, description: 'Registered variant_id.' },
        snapshot: { type: 'string', maxLength: 128, description: 'Optional imported snapshot_id to enrich interface candidates.' },
        max_components: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 20.' },
      },
      required: ['workspace', 'variant'],
      additionalProperties: false,
    },
    handler: async (args, exec) => {
      const argv = ['overview', '--workspace', requireString(args, 'workspace', { max: 128 }), '--variant', requireString(args, 'variant', { max: 128 })]
      pushFlag(argv, '--snapshot', optionalString(args, 'snapshot', { max: 128 }))
      const max = optionalInt(args, 'max_components', { min: 1, max: 100 })
      if (max !== undefined) argv.push('--max-components', String(max))
      return invoke(argv, exec)
    },
  })

  const source = definition({
    name: 'code_source',
    description:
      'Read bounded source evidence from a registered workspace without executing builds. Actions: find (literal text or filename search inside one repo with explicit glob and scan budgets; returns signed path_refs plus safe previews), read (hash-verified byte range of a signed path_ref; returns source_text evidence plus safe_text or ref_only), evidence (re-read a previously issued source evidence_ref with the same integrity checks). USE WHEN explaining what code says. Text evidence proves only that selected text exists: it is never compiler semantics and cannot prove runtime behavior. Binary or sensitive regions come back as ref_only.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['find', 'read', 'evidence'] },
        workspace: { type: 'string', maxLength: 128 },
        repo: { type: 'string', maxLength: 64, description: 'Registered repo_id (find).' },
        relative_glob: { type: 'string', maxLength: 512, description: 'Repo-relative glob such as "src/**/*.c" (find).' },
        literal: { type: 'string', maxLength: 256, description: 'Literal text to search; mutually exclusive with filename (find).' },
        filename: { type: 'string', maxLength: 256, description: 'Filename glob such as "*.c"; mutually exclusive with literal (find).' },
        cursor: { type: 'string', maxLength: 4096, description: 'Opaque next_cursor returned by a previous find.' },
        path_ref: { type: 'string', maxLength: 8192, description: 'Signed path reference from find (read).' },
        expected_sha256: { type: 'string', maxLength: 64, description: 'Expected content SHA256 (read).' },
        byte_start: { type: 'integer', minimum: 0 },
        byte_end: { type: 'integer', minimum: 1, maximum: 16777216 },
        evidence_ref: { type: 'string', maxLength: 8192, description: 'Signed source evidence reference (evidence).' },
        max_bytes: { type: 'integer', minimum: 1, maximum: 16384 },
      },
      required: ['action', 'workspace'],
      additionalProperties: false,
    },
    handler: async (args, exec) => {
      const action = requireEnum(args, 'action', ['find', 'read', 'evidence'])
      const workspaceId = requireString(args, 'workspace', { max: 128 })
      if (action === 'find') {
        const literal = optionalString(args, 'literal', { max: 256 })
        const filename = optionalString(args, 'filename', { max: 256 })
        if ((literal === undefined) === (filename === undefined)) invalid('find requires exactly one of literal or filename')
        const argv = [
          'source-find',
          '--workspace', workspaceId,
          '--repo', requireString(args, 'repo', { max: 64 }),
          '--relative-glob', requireString(args, 'relative_glob', { max: 512 }),
        ]
        if (literal !== undefined) argv.push('--literal', literal)
        if (filename !== undefined) argv.push('--filename', filename)
        pushFlag(argv, '--cursor', optionalString(args, 'cursor', { max: 4096 }))
        return invoke(argv, exec)
      }
      if (action === 'read') {
        const start = optionalInt(args, 'byte_start', { min: 0 })
        const end = optionalInt(args, 'byte_end', { min: 1, max: 16777216 })
        if (start === undefined || end === undefined) invalid('read requires byte_start and byte_end')
        return invoke(
          [
            'source-read',
            '--workspace', workspaceId,
            '--path', requireString(args, 'path_ref', { max: 8192 }),
            '--expected-sha256', requireString(args, 'expected_sha256', { max: 64, min: 64 }),
            '--byte-start', String(start),
            '--byte-end', String(end),
          ],
          exec,
        )
      }
      const argv = ['source', '--workspace', workspaceId, '--evidence', requireString(args, 'evidence_ref', { max: 8192 })]
      const maxBytes = optionalInt(args, 'max_bytes', { min: 1, max: 16384 })
      if (maxBytes !== undefined) argv.push('--max-bytes', String(maxBytes))
      return invoke(argv, exec)
    },
  })

  const snapshot = definition({
    name: 'code_snapshot',
    description:
      'Import or inspect a verified SDK Code Atlas 0.1 snapshot (graph + analysis manifest) for one registered repo/variant. Use only a snapshot provided under the trusted import inbox; this tool never runs Atlas, CMake or a compiler. Import verifies the envelope schema, manifest fields and payload.graph_hash against the raw graph bytes before copying a read-only local view. failed/pending coverage units stay visible and are never treated as analyzed facts.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['import', 'status'] },
        workspace: { type: 'string', maxLength: 128 },
        variant: { type: 'string', maxLength: 128 },
        repo: { type: 'string', maxLength: 64 },
        snapshot: { type: 'string', maxLength: 128, description: 'Inbox directory name containing graph.json and analysis_manifest.json (import).' },
        snapshot_ref: { type: 'string', maxLength: 128, description: 'Imported snapshot_id (status).' },
        operation_id: { type: 'string', maxLength: 128 },
      },
      required: ['action', 'workspace'],
      additionalProperties: false,
    },
    handler: async (args, exec) => {
      const action = requireEnum(args, 'action', ['import', 'status'])
      const workspaceId = requireString(args, 'workspace', { max: 128 })
      if (action === 'import') {
        const operationId = optionalString(args, 'operation_id', { max: 128 }) ?? bridge.newOperationId()
        return invoke(
          [
            'snapshot-import',
            '--workspace', workspaceId,
            '--variant', requireString(args, 'variant', { max: 128 }),
            '--repo', requireString(args, 'repo', { max: 64 }),
            '--snapshot', requireString(args, 'snapshot', { max: 128 }),
            '--operation-id', operationId,
          ],
          exec,
        )
      }
      return invoke(
        [
          'snapshot',
          '--workspace', workspaceId,
          '--snapshot', requireString(args, 'snapshot_ref', { max: 128 }),
        ],
        exec,
      )
    },
  })

  const path = definition({
    name: 'code_path',
    description:
      'Trace one evidence path or run one relation query over an imported snapshot. Actions: path (bounded call/dependency path between two function refs, repo-qualified like "umd:job_submit"; returns nodes, edges with origin/certainty/evidence, unresolved boundaries, choices and truncation; cross-repo endpoints use explicit supported bindings at most as abi_bridge/certainty=may), relation (one mode of flow_legacy/flow_cfg/locks/aliases; a snapshot lacking that analysis returns status=unavailable instead of fabricated data). USE WHEN explaining how control/data/objects move. exact means "resolved in this analyzed build", never "executes at runtime".',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['path', 'relation'] },
        workspace: { type: 'string', maxLength: 128 },
        variant: { type: 'string', maxLength: 128, description: 'Required for path.' },
        from: { type: 'string', maxLength: 512, description: 'Function ref, e.g. "kmd:job_dispatch" (path).' },
        to: { type: 'string', maxLength: 512, description: 'Function ref (path).' },
        budget: { type: 'integer', minimum: 1, maximum: 10000 },
        max_depth: { type: 'integer', minimum: 1, maximum: 100 },
        direction: { type: 'string', enum: ['down', 'up'], description: 'Path direction; default down (callees).' },
        snapshot_ref: { type: 'string', maxLength: 128, description: 'Required for relation.' },
        mode: { type: 'string', enum: ['flow_legacy', 'flow_cfg', 'locks', 'aliases'] },
        function: { type: 'string', maxLength: 512 },
        parameter: { type: 'string', maxLength: 512 },
        value: { type: 'string', maxLength: 512 },
        symbol: { type: 'string', maxLength: 512 },
        object: { type: 'string', maxLength: 512 },
        lock: { type: 'string', maxLength: 512 },
        max_items: { type: 'integer', minimum: 1, maximum: 2000 },
      },
      required: ['action', 'workspace'],
      additionalProperties: false,
    },
    handler: async (args, exec) => {
      const action = requireEnum(args, 'action', ['path', 'relation'])
      const workspaceId = requireString(args, 'workspace', { max: 128 })
      if (action === 'path') {
        const argv = [
          'path',
          '--workspace', workspaceId,
          '--variant', requireString(args, 'variant', { max: 128 }),
          '--from', requireString(args, 'from', { max: 512 }),
          '--to', requireString(args, 'to', { max: 512 }),
        ]
        const budget = optionalInt(args, 'budget', { min: 1, max: 10000 })
        if (budget !== undefined) argv.push('--budget', String(budget))
        const depth = optionalInt(args, 'max_depth', { min: 1, max: 100 })
        if (depth !== undefined) argv.push('--max-depth', String(depth))
        pushFlag(argv, '--direction', optionalString(args, 'direction', { max: 8 }))
        return invoke(argv, exec)
      }
      const argv = [
        'relation',
        '--workspace', workspaceId,
        '--snapshot', requireString(args, 'snapshot_ref', { max: 128 }),
        '--mode', requireEnum(args, 'mode', ['flow_legacy', 'flow_cfg', 'locks', 'aliases']),
      ]
      for (const [argName, flag, max] of [
        ['function', '--function', 512],
        ['parameter', '--parameter', 512],
        ['value', '--value', 512],
        ['symbol', '--symbol', 512],
        ['object', '--object', 512],
        ['lock', '--lock', 512],
      ]) {
        const item = optionalString(args, argName, { max })
        if (item !== undefined) argv.push(flag, item)
      }
      pushFlag(argv, '--direction', optionalString(args, 'direction', { max: 8 }))
      const budget = optionalInt(args, 'budget', { min: 1, max: 10000 })
      if (budget !== undefined) argv.push('--budget', String(budget))
      const maxItems = optionalInt(args, 'max_items', { min: 1, max: 2000 })
      if (maxItems !== undefined) argv.push('--max-items', String(maxItems))
      return invoke(argv, exec)
    },
  })

  const learn = definition({
    name: 'code_learn',
    description:
      'Versioned learning records for a registered workspace. Actions: save (validate a draft record from the inbox and CAS-write a new immutable revision; prediction/observation stay pending until the user or real evidence provides them), get (read the current revision), resume (recheck workspace/build/evidence freshness and return a safe recheck cursor; stale or unknown records must not be reused as current facts), export (Markdown or JSON under the local state; never uploaded). USE WHEN the user explicitly asks to save/continue/export learning, or when a full retrospective is requested. Ordinary Q&A does not need a record.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'get', 'resume', 'export'] },
        workspace: { type: 'string', maxLength: 128 },
        record: { type: 'string', maxLength: 128, description: 'record_id (get/resume/export).' },
        input: { type: 'string', maxLength: 256, description: 'Draft record filename inside the trusted inbox (save).' },
        expected_generation: { type: 'integer', minimum: 0, description: '0 for a new record (save).' },
        operation_id: { type: 'string', maxLength: 128 },
        format: { type: 'string', enum: ['markdown', 'json'] },
      },
      required: ['action', 'workspace'],
      additionalProperties: false,
    },
    handler: async (args, exec) => {
      const action = requireEnum(args, 'action', ['save', 'get', 'resume', 'export'])
      const workspaceId = requireString(args, 'workspace', { max: 128 })
      if (action === 'save') {
        const operationId = optionalString(args, 'operation_id', { max: 128 }) ?? bridge.newOperationId()
        return invoke(
          [
            'record-save',
            '--workspace', workspaceId,
            '--input', requireString(args, 'input', { max: 256 }),
            '--expected-generation', String(optionalInt(args, 'expected_generation') ?? 0),
            '--operation-id', operationId,
          ],
          exec,
        )
      }
      const recordId = requireString(args, 'record', { max: 128 })
      if (action === 'get') return invoke(['record-get', '--workspace', workspaceId, '--record', recordId], exec)
      if (action === 'resume') return invoke(['resume', '--workspace', workspaceId, '--record', recordId], exec)
      const format = optionalString(args, 'format', { max: 16 }) ?? 'markdown'
      if (!['markdown', 'json'].includes(format)) invalid('format must be markdown or json')
      return invoke(['export', '--workspace', workspaceId, '--record', recordId, '--format', format], exec)
    },
  })

  return Object.freeze([workspace, overview, source, snapshot, path, learn])
}
