// dsh-code-reader: a DeepSeek Harness Host bundle that exposes a local,
// source-grounded code-learning engine as agent tools plus one packaged skill.
//
// The plugin only orchestrates: workspace registration, bounded source reads,
// verified Atlas snapshot imports, evidence path queries and versioned learning
// records all live in the local Python engine (engine/code_learning) and are
// invoked through a fixed argv bridge. No build, index or compiler execution is
// started from this plugin.
import { resolveSettings } from './lib/config.mjs'
import { createBridge } from './lib/bridge.mjs'
import { buildTools } from './lib/tools.mjs'
import { registerSkillProvider } from './lib/skills.mjs'

export const name = 'dsh-code-reader'
export const inject = ['tools', 'skills']

export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  const bridge = createBridge(settings)
  for (const tool of buildTools(bridge)) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-code-reader: register tool ${tool.name}`)
  }
  registerSkillProvider(ctx)
}

export default { name, inject, apply }
