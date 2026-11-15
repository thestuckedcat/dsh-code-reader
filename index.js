// dsh-code-reader: a DeepSeek Harness Host bundle that exposes a local,
// source-grounded code-learning engine as agent tools plus one packaged skill.
//
// The plugin only orchestrates: workspace registration, bounded source reads,
// verified Atlas snapshot imports, evidence path queries and versioned learning
// records all live in the local Python engine (engine/code_learning) and are
// invoked through a fixed argv bridge. No build, index or compiler execution is
// started from this plugin.
//
// The read-only code view is a second, optional half: its HTTP carrier needs the
// Host `connection` and `webServer` services, so it is mounted as a nested
// Cordis plugin that declares those dependencies itself. When the services are
// missing that nested plugin stays pending and the tools/skills above keep
// working (docs/readonly-workbench-contract.md §1 "Host 侧注册边界").
import { resolveSettings } from './lib/config.mjs'
import { createBridge } from './lib/bridge.mjs'
import { buildTools } from './lib/tools.mjs'
import { registerSkillProvider } from './lib/skills.mjs'
import { HTTP_RPC_CHANNEL, registerWorkbenchHttpRoute } from './lib/http-rpc.mjs'
import { createViewDispatch, createViewService, VIEW_ENDPOINTS } from './lib/view-service.mjs'

export const name = 'dsh-code-reader'
export const inject = ['tools', 'skills']

const VIEW_PLUGIN_NAME = 'dsh-code-reader-view'

export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  const bridge = createBridge(settings)
  for (const tool of buildTools(bridge)) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-code-reader: register tool ${tool.name}`)
  }
  registerSkillProvider(ctx)

  // The nested plugin owns the UI-only dependencies; a host without them keeps
  // this fiber pending instead of failing the whole plugin. The route and the
  // read-model service are disposed with that fiber, so remounting re-registers
  // both (rc.5 load → unload → load).
  ctx.plugin({
    name: VIEW_PLUGIN_NAME,
    inject: ['connection', 'webServer'],
    apply(viewCtx) {
      const service = createViewService({ bridge, settings })
      registerWorkbenchHttpRoute(viewCtx, {
        channel: HTTP_RPC_CHANNEL,
        methods: VIEW_ENDPOINTS,
        handler: createViewDispatch(service),
      })
    },
  })
}

export default { name, inject, apply }
