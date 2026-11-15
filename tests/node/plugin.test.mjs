import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import plugin, { apply, name, inject } from '../../index.js'
import { resolveSettings } from '../../lib/config.mjs'
import { PACKAGE_ROOT } from '../../lib/config.mjs'
import { buildTools } from '../../lib/tools.mjs'

function fakeContext({ withUiServices = false } = {}) {
  const state = { tools: [], disposers: [], providers: [], plugins: [], activated: [], pending: [] }
  const ctx = {
    tools: {
      register(definition) {
        state.tools.push(definition)
        return () => {}
      },
    },
    skills: {
      registerProvider(factory) {
        state.providers.push(factory)
        return () => {}
      },
    },
    effect(callback, label) {
      const disposer = callback()
      state.disposers.push({ label, disposer })
      return disposer
    },
    // Minimal Cordis stand-in: a plugin object whose `inject` cannot be
    // satisfied stays pending (its apply never runs), exactly like rc.5.
    plugin(definition) {
      state.plugins.push(definition)
      const required = Array.isArray(definition.inject) ? definition.inject : []
      const missing = required.filter((serviceName) => ctx[serviceName] === undefined)
      if (missing.length > 0) {
        state.pending.push({ name: definition.name, missing })
        return { dispose() {} }
      }
      state.activated.push(definition.name)
      definition.apply(Object.create(ctx))
      return { dispose() {} }
    },
  }
  if (withUiServices) {
    ctx.connection = { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }
    ctx.webServer = {
      register() {
        return () => {}
      },
    }
  }
  return { ctx, state }
}

test('plugin exports the expected Cordis identity and services', () => {
  assert.equal(name, 'dsh-code-reader')
  assert.deepEqual(inject, ['tools', 'skills'])
  assert.equal(plugin.name, name)
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers exactly the seven code tools plus one skill provider', async () => {
  const { ctx, state } = fakeContext()
  apply(ctx, {})
  assert.deepEqual(
    state.tools.map((tool) => tool.name).sort(),
    ['code_learn', 'code_overview', 'code_path', 'code_snapshot', 'code_source', 'code_summary', 'code_workspace'],
  )
  for (const tool of state.tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 80)
    assert.equal(typeof tool.parameters, 'object')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(tool.output.schema.type, 'object')
  }
  assert.equal(state.providers.length, 1)
  const provider = state.providers[0]({ signal: new AbortController().signal, invalidate() {} })
  assert.equal(provider.name, 'dsh-code-reader')
  const candidates = await provider.list({})
  const names = candidates.map((candidate) => candidate.name)
  assert.ok(names.includes('learn-code-workspace'), `packaged skills missing learn-code-workspace: ${names}`)
  const definition = await provider.get(candidates.find((candidate) => candidate.name === 'learn-code-workspace'), {})
  assert.equal(definition.name, 'learn-code-workspace')
  assert.ok(definition.content.length > 1000)
  assert.match(definition.content, /预测/)
  // Packaged skills are model-invocable and resource-backed from the package dir.
  assert.equal(definition.invocation.modelInvocable, true)
  assert.equal(definition.resourceBase.kind, 'directory')
})

test('code_summary tool exposes the frozen schema, description and fixed argv', async () => {
  const calls = []
  const bridge = {
    async execute(argv) {
      calls.push(argv)
      return { schema_version: 1, ok: true, exit_code: 0, cli: { argv } }
    },
    newOperationId: () => 'op-summary-1',
  }
  const summary = buildTools(bridge).find((tool) => tool.name === 'code_summary')
  assert.ok(summary, 'code_summary tool is missing')

  // The description must carry the hard rules from ai-summary-perf-contract §1.3.
  assert.match(summary.description, /verified evidence/)
  assert.match(summary.description, /500 characters/)
  assert.match(summary.description, /candidate\/may\/unknown static facts as certain/)
  assert.match(summary.description, /never fabricate runtime observations/)
  assert.match(summary.description, /does not call any model/)

  // Frozen parameter schema: typed slots only, no free-form argv/paths.
  assert.equal(summary.parameters.type, 'object')
  assert.equal(summary.parameters.additionalProperties, false)
  assert.deepEqual(summary.parameters.required, ['action', 'workspace', 'snapshot'])
  assert.deepEqual(summary.parameters.properties.action.enum, ['get', 'put'])
  assert.deepEqual(summary.parameters.properties.subject_type.enum, ['function', 'group', 'entry'])
  assert.equal(summary.parameters.properties.text.maxLength, 500)
  assert.equal(summary.parameters.properties.facts.maxItems, 32)
  assert.deepEqual(summary.parameters.properties.facts.items.properties.kind.enum, ['evidence', 'node', 'selection'])
  assert.equal(summary.parameters.properties.inference_labels.maxItems, 8)
  assert.deepEqual(summary.parameters.properties.inference_labels.items.enum, [
    'from_static_structure',
    'from_source_text',
    'may_speculative',
    'from_observation',
  ])
  assert.deepEqual(summary.parameters.properties.generator.properties.kind.enum, ['agent', 'user'])
  assert.equal(summary.parameters.properties.generator.properties.model_ref.maxLength, 128)
  assert.equal(summary.parameters.properties.generator.additionalProperties, false)

  const snapshotId = 'a'.repeat(32)
  await summary.execute({ action: 'get', workspace: 'demo', snapshot: snapshotId }, {})
  assert.deepEqual(calls.at(-1), ['view-summary', '--workspace', 'demo', '--snapshot', snapshotId])
  await summary.execute(
    { action: 'get', workspace: 'demo', snapshot: snapshotId, subject_type: 'group', subject_id: 'group:f_1' },
    {},
  )
  assert.deepEqual(calls.at(-1), [
    'view-summary', '--workspace', 'demo', '--snapshot', snapshotId, '--subject-type', 'group', '--subject-id', 'group:f_1',
  ])

  const text = 'bus_send 先查路由再校验长度，然后按分支提交传输。'
  const put = await summary.execute(
    {
      action: 'put',
      workspace: 'demo',
      snapshot: snapshotId,
      subject_type: 'function',
      subject_id: 'f_1',
      text,
      facts: [
        { kind: 'evidence', ref: 'e_1' },
        { kind: 'selection', ref: 'function:f_1' },
      ],
      generator: { kind: 'agent', ref: 'skill:verify-summary', model_ref: 'deepseek-flash' },
      inference_labels: ['from_static_structure', 'from_source_text'],
    },
    {},
  )
  const putArgv = put.cli.argv
  assert.deepEqual(putArgv.slice(0, 5), ['summary-put', '--workspace', 'demo', '--snapshot', snapshotId])
  assert.equal(putArgv[5], '--payload-json')
  const payload = JSON.parse(Buffer.from(putArgv[6], 'base64').toString('utf8'))
  assert.deepEqual(payload, {
    subject: { type: 'function', id: 'f_1' },
    text,
    facts: [
      { kind: 'evidence', ref: 'e_1' },
      { kind: 'selection', ref: 'function:f_1' },
    ],
    generator: { kind: 'agent', ref: 'skill:verify-summary', model_ref: 'deepseek-flash' },
    inference_labels: ['from_static_structure', 'from_source_text'],
  })
})

test('code_summary rejects invalid summaries before the engine call', async () => {
  const calls = []
  const bridge = {
    async execute(argv) {
      calls.push(argv)
      return { schema_version: 1, ok: true, exit_code: 0, cli: {} }
    },
    newOperationId: () => 'op-summary-1',
  }
  const summary = buildTools(bridge).find((tool) => tool.name === 'code_summary')
  const base = { action: 'put', workspace: 'demo', snapshot: 'a'.repeat(32), subject_type: 'function', subject_id: 'f_1' }
  const valid = { ...base, text: 'ok', generator: { kind: 'agent', ref: 'skill:test' } }
  const cases = [
    [{ ...valid, text: '' }, /text must be 1\.\.500 Unicode code points/],
    [{ ...valid, text: 'x'.repeat(501) }, /text must be 1\.\.500 Unicode code points/],
    [{ ...valid, text: '字'.repeat(501) }, /text must be 1\.\.500 Unicode code points/],
    [{ ...valid, text: 'bad\u0000text' }, /must not contain control characters/],
    [{ ...valid, facts: Array.from({ length: 33 }, (_, i) => ({ kind: 'evidence', ref: `e_${i}` })) }, /at most 32 entries/],
    [{ ...valid, facts: [{ kind: 'guess', ref: 'x' }] }, /facts\[0\]\.kind must be one of/],
    [{ ...valid, facts: [{ kind: 'evidence', ref: 'bad ref!' }] }, /facts\[0\]\.ref must be a bounded reference/],
    [{ ...valid, generator: { kind: 'robot', ref: 'r' } }, /generator\.kind must be one of/],
    [{ ...valid, generator: { kind: 'agent' } }, /generator\.ref must be a non-empty reference/],
    [
      { ...valid, generator: { kind: 'agent', ref: 'r', model_ref: 'm'.repeat(129) } },
      /generator\.model_ref must be a non-empty reference of at most 128 characters/,
    ],
    [{ ...valid, inference_labels: Array.from({ length: 9 }, () => 'from_source_text') }, /at most 8 labels/],
    [{ ...valid, inference_labels: ['from_vibes'] }, /inference_labels\[0\] must be one of/],
    [{ ...valid, subject_id: undefined }, /subject_type and subject_id must be provided together/],
    [{ ...valid, subject_type: undefined }, /subject_type and subject_id must be provided together/],
    [{ action: 'put', workspace: 'demo', snapshot: 'a'.repeat(32), text: 'ok', generator: { kind: 'agent', ref: 'r' } }, /subject_type and subject_id are required/],
    [{ ...valid, subject_id: 'bad id!' }, /subject_id must be a bounded reference/],
    [{ ...valid, workspace: 'a'.repeat(129) }, /workspace must be a string of length 1\.\.128/],
  ]
  for (const [args, message] of cases) {
    await assert.rejects(() => summary.execute(args, {}), message)
  }
  assert.equal(calls.length, 0, 'invalid summaries must never reach the engine')

  // Unicode code-point counting: 500 emoji are allowed, 501 are not.
  await summary.execute({ ...valid, text: '😀'.repeat(500) }, {})
  assert.equal(calls.length, 1)

  // generator.model_ref mirrors the engine limit (128, not 256).
  const longModelRef = 'm'.repeat(128)
  await summary.execute({ ...valid, generator: { kind: 'agent', ref: 'r', model_ref: longModelRef } }, {})
  const boundaryArgv = calls.at(-1)
  const boundaryPayload = JSON.parse(
    Buffer.from(boundaryArgv[boundaryArgv.indexOf('--payload-json') + 1], 'base64').toString('utf8'),
  )
  assert.equal(boundaryPayload.generator.model_ref, longModelRef)
  assert.equal(boundaryPayload.generator.ref, 'r')
  assert.equal(calls.length, 2)
})

test('code_summary surfaces engine summary errors unchanged', async () => {
  for (const code of ['LIMIT_EXCEEDED', 'INVALID_ARGUMENT', 'NOT_FOUND', 'SCOPE_DENIED']) {
    const errorDoc = {
      schema_version: 1,
      error: { code, message: `${code} from the summary engine`, details_ref: null, retryable: false },
      operation_id: null,
    }
    const bridge = {
      async execute() {
        return { schema_version: 1, ok: false, exit_code: 2, cli: errorDoc }
      },
      newOperationId: () => 'op-summary-1',
    }
    const summary = buildTools(bridge).find((tool) => tool.name === 'code_summary')
    const getValue = await summary.execute({ action: 'get', workspace: 'demo', snapshot: 'a'.repeat(32) }, {})
    assert.equal(getValue.ok, false, code)
    assert.equal(getValue.exit_code, 2, code)
    assert.deepEqual(getValue.cli, errorDoc, code)
    const putValue = await summary.execute(
      {
        action: 'put',
        workspace: 'demo',
        snapshot: 'a'.repeat(32),
        subject_type: 'function',
        subject_id: 'f_1',
        text: '归纳文本',
        generator: { kind: 'agent', ref: 'r' },
      },
      {},
    )
    assert.deepEqual(putValue.cli, errorDoc, code)
  }
})

test('apply mounts the read-only view as a nested UI plugin with its own injects', () => {
  const { ctx, state } = fakeContext()
  apply(ctx, {})
  assert.equal(state.plugins.length, 1)
  const viewPlugin = state.plugins[0]
  assert.equal(viewPlugin.name, 'dsh-code-reader-view')
  assert.deepEqual(viewPlugin.inject, ['connection', 'webServer'])
  assert.equal(typeof viewPlugin.apply, 'function')
  // Host UI services are absent: the nested fiber stays pending, old tools work.
  assert.deepEqual(state.pending, [{ name: 'dsh-code-reader-view', missing: ['connection', 'webServer'] }])
  assert.deepEqual(state.activated, [])
  assert.equal(state.tools.length, 7)
})

test('apply mounts the /code-view route when the UI host services are present', () => {
  const { ctx, state } = fakeContext({ withUiServices: true })
  apply(ctx, {})
  assert.deepEqual(state.activated, ['dsh-code-reader-view'])
  assert.equal(state.tools.length, 7)
  assert.equal(state.providers.length, 1)
  // tools + skill + one route effect, all disposable.
  assert.equal(state.disposers.length, 9)
  const routeEffect = state.disposers.find((entry) => /\/code-view http rpc route/.test(entry.label))
  assert.ok(routeEffect, 'route effect must be registered')
  assert.doesNotThrow(() => routeEffect.disposer())
})

test('apply rejects malformed row config and returns disposable effects', () => {
  const { ctx } = fakeContext()
  assert.throws(() => apply(ctx, { typo: true }), /unknown config field/)
  assert.throws(() => apply(ctx, { timeoutMs: 10 }), /timeoutMs/)
  const { ctx: ctx2, state } = fakeContext()
  apply(ctx2, {})
  assert.equal(state.disposers.length, 8)
  for (const { label, disposer } of state.disposers) {
    assert.equal(typeof disposer, 'function', `${label} disposer must be callable`)
    assert.doesNotThrow(() => disposer())
  }
})

test('display metadata and icon satisfy bundle packaging facts', () => {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  // Client half wiring is part of the load contract (readonly-workbench-contract §1).
  assert.equal(pkg.main, 'index.js')
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './bundle/client.js')
  assert.ok(pkg.files.includes('bundle/'), 'bundle/ must ship in the package files')
  assert.deepEqual(pkg.dsh.client, {
    inject: [
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-renderer',
    ],
    platform: 'web',
  })
  assert.equal(typeof pkg.scripts.test, 'string')
  assert.match(pkg.scripts['test:node'], /tests\/node\/view-rpc\.test\.mjs/)
  for (const localeName of ['en', 'zh']) {
    const locale = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'locale', `${localeName}.json`), 'utf8'))
    assert.equal(typeof locale.meta.title, 'string')
    assert.ok(locale.meta.title.length > 2)
    assert.equal(typeof locale.meta.description, 'string')
    assert.ok(locale.meta.description.length > 10)
  }
  const icon = readFileSync(join(PACKAGE_ROOT, 'icon.svg'), 'utf8')
  assert.match(icon, /^<svg[\s>]/)
  assert.ok(icon.length < 256 * 1024)
  const patch = readFileSync(join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: dsh-code-reader/)
  assert.match(patch, /name: '@local\/dsh-code-reader'/)
  const settings = resolveSettings({})
  assert.match(settings.bootstrapPath, /code-reader[\\/]bootstrap\.json$/)
})
