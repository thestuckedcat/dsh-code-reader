import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import plugin, { apply, name, inject } from '../../index.js'
import { resolveSettings } from '../../lib/config.mjs'
import { PACKAGE_ROOT } from '../../lib/config.mjs'

function fakeContext() {
  const state = { tools: [], disposers: [], providers: [] }
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
  }
  return { ctx, state }
}

test('plugin exports the expected Cordis identity and services', () => {
  assert.equal(name, 'dsh-code-reader')
  assert.deepEqual(inject, ['tools', 'skills'])
  assert.equal(plugin.name, name)
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers exactly the six code tools plus one skill provider', async () => {
  const { ctx, state } = fakeContext()
  apply(ctx, {})
  assert.deepEqual(
    state.tools.map((tool) => tool.name).sort(),
    ['code_learn', 'code_overview', 'code_path', 'code_snapshot', 'code_source', 'code_workspace'],
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

test('apply rejects malformed row config and returns disposable effects', () => {
  const { ctx } = fakeContext()
  assert.throws(() => apply(ctx, { typo: true }), /unknown config field/)
  const { ctx: ctx2, state } = fakeContext()
  apply(ctx2, {})
  assert.equal(state.disposers.length, 7)
  for (const { label, disposer } of state.disposers) {
    assert.equal(typeof disposer, 'function', `${label} disposer must be callable`)
    assert.doesNotThrow(() => disposer())
  }
})

test('display metadata and icon satisfy bundle packaging facts', () => {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
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
