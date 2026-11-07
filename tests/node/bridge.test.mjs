import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  buildTools,
} from '../../lib/tools.mjs'
import {
  BridgeError,
  bridgeEnv,
  createBridge,
  parseCliDocument,
} from '../../lib/bridge.mjs'
import { resolveSettings, defaultBootstrapPath, ENGINE_DIR } from '../../lib/config.mjs'

function fakeBridge(records) {
  return {
    newOperationId: () => 'op-fixed',
    async execute(argv) {
      records.push(argv)
      return { schema_version: 1, ok: true, exit_code: 0, cli: { argv } }
    },
  }
}

const settings = {
  bootstrapPath: join(tmpdir(), 'boot.json'),
  timeoutMs: 5000,
  engineDir: ENGINE_DIR,
  packageRoot: 'unused',
}

test('config: default bootstrap path follows DSH_HOME and rejects unknown fields', () => {
  assert.equal(defaultBootstrapPath({ DSH_HOME: 'C:\\dsh-home' }), join('C:\\dsh-home', 'code-reader', 'bootstrap.json'))
  assert.throws(() => resolveSettings({ unknown: 1 }), /unknown config field/)
  assert.throws(() => resolveSettings({ timeoutMs: 10 }), /timeoutMs/)
  assert.throws(() => resolveSettings({ bootstrapPath: '' }), /bootstrapPath/)
  assert.equal(resolveSettings({}).timeoutMs, 120_000)
  assert.equal(resolveSettings({ bootstrapPath: 'C:\\x\\bootstrap.json' }).bootstrapPath, 'C:\\x\\bootstrap.json')
})

test('bridgeEnv drops credential variables from the Python child environment', () => {
  const env = bridgeEnv({ PATH: '/usr/bin', OPENAI_API_KEY: 'secret', GITHUB_TOKEN: 'secret', DSH_HOME: '/dsh' })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.DSH_HOME, '/dsh')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.GITHUB_TOKEN, undefined)
  assert.equal(env.PYTHONIOENCODING, 'utf-8')
})

test('parseCliDocument only accepts one JSON document', () => {
  assert.deepEqual(parseCliDocument('{"a":1}\n'), { a: 1 })
  assert.equal(parseCliDocument(''), null)
  assert.equal(parseCliDocument('not json'), null)
})

test('bridge resolves a python probe then runs the fixed CLI argv', async () => {
  const calls = []
  const fakeSpawn = async (command, args) => {
    calls.push({ command, args })
    if (args[0] === '--version') {
      return { exitCode: 0, stdout: 'Python 3.11.4', stderr: '' }
    }
    return { exitCode: 0, stdout: '{"schema_version":1,"result":"ok"}', stderr: '' }
  }
  const bridge = createBridge(settings, { spawnImpl: fakeSpawn, env: { PATH: '/usr/bin', OPENAI_API_KEY: 'x' } })
  const value = await bridge.execute(['status', '--workspace', 'demo'])
  assert.equal(value.ok, true)
  assert.deepEqual(value.cli, { schema_version: 1, result: 'ok' })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].command, 'python3')
  assert.deepEqual(calls[1].args, ['-m', 'code_learning.cli', '--bootstrap', settings.bootstrapPath, 'status', '--workspace', 'demo'])
  assert.ok(calls[1].args.includes('status'))
})

test('bridge reports missing interpreter and non-JSON failures as tool values', async () => {
  const bridge = createBridge(settings, {
    spawnImpl: async () => ({ exitCode: null, spawnError: Object.assign(new Error('nope'), { code: 'ENOENT' }) }),
  })
  await assert.rejects(() => bridge.execute(['status', '--workspace', 'demo']), (error) => {
    assert.ok(error instanceof BridgeError)
    assert.equal(error.code, 'DEPENDENCY_UNAVAILABLE')
    return true
  })
  const bad = createBridge(settings, {
    spawnImpl: async (command, args) => {
      if (args[0] === '--version') return { exitCode: 0, stdout: 'Python 3.12.1', stderr: '' }
      return { exitCode: 3, stdout: 'boom', stderr: 'traceback' }
    },
  })
  const value = await bad.execute(['status', '--workspace', 'demo'])
  assert.equal(value.ok, false)
  assert.equal(value.exit_code, 3)
  assert.equal(value.error.code, 'DEPENDENCY_UNAVAILABLE')
})

test('tool argv mapping is fixed and does not shell-interpolate', async () => {
  const records = []
  const tools = Object.fromEntries(buildTools(fakeBridge(records)).map((tool) => [tool.name, tool]))
  assert.deepEqual(Object.keys(tools).sort(), ['code_learn', 'code_overview', 'code_path', 'code_snapshot', 'code_source', 'code_workspace'])

  const workspace = await tools.code_workspace.execute(
    { action: 'import', manifest: 'workspace.json', expected_revision: 0 },
    {},
  )
  assert.deepEqual(workspace.cli.argv, ['workspace-import', '--manifest', 'workspace.json', '--expected-revision', '0', '--operation-id', 'op-fixed'])

  await tools.code_workspace.execute({ action: 'status', workspace: 'demo' }, {})
  assert.deepEqual(records.at(-1), ['status', '--workspace', 'demo'])

  await tools.code_source.execute(
    { action: 'find', workspace: 'demo', repo: 'umd', relative_glob: 'src/**/*.c', literal: 'ioctl' },
    {},
  )
  assert.deepEqual(records.at(-1), [
    'source-find', '--workspace', 'demo', '--repo', 'umd', '--relative-glob', 'src/**/*.c', '--literal', 'ioctl',
  ])

  await assert.rejects(
    () => tools.code_source.execute({ action: 'find', workspace: 'demo', repo: 'umd', relative_glob: '*.c' }, {}),
    (error) => error instanceof BridgeError && error.code === 'INVALID_ARGUMENT',
  )
  await assert.rejects(
    () => tools.code_source.execute({ action: 'find', workspace: 'demo', repo: 'umd', relative_glob: '*.c', literal: 'a', filename: 'b' }, {}),
    /exactly one of literal or filename/,
  )
  await assert.rejects(() => tools.code_workspace.execute({ action: 'nope' }, {}), /action/)
})

test('bridge rejects Python versions older than 3.11', async () => {
  const bridge = createBridge(settings, {
    spawnImpl: async (command, args) => {
      if (args[0] === '--version') return { exitCode: 0, stdout: 'Python 3.9.18', stderr: '' }
      return { exitCode: 0, stdout: '{}', stderr: '' }
    },
  })
  await assert.rejects(() => bridge.execute(['status', '--workspace', 'demo']), (error) => {
    assert.ok(error instanceof BridgeError)
    assert.equal(error.code, 'DEPENDENCY_UNAVAILABLE')
    assert.match(error.message, /3\.11\+/)
    return true
  })
})

test('tool output renderer returns one text content block', () => {
  const tools = buildTools(fakeBridge([]))
  const value = { schema_version: 1, ok: true, exit_code: 0, cli: { x: 1 } }
  for (const tool of tools) {
    const blocks = tool.output.render({}, value)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'text')
    assert.deepEqual(JSON.parse(blocks[0].text), value)
  }
})
