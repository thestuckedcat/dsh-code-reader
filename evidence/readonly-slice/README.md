# 04 只读代码工作台切片 · 独立黑盒验收证据

本目录是 **verifier（独立验收者）** 对 04-code-learning 只读切片（CL-VIEW-T1）的验收产物。
验收只读：不修改插件实现、不联网、不写真实 `%USERPROFILE%\.dsh`、不重启用户桌面宿主、不做 git 提交。
契约依据：[只读工作台切片契约](../../docs/readonly-workbench-contract.md) §7（DOM 钩子）、§9（验收动作）；
产品依据：[交互式代码工作台软件设计](../../docs/interactive-code-view-software-design.md) §9–§10。

## 1. 最终结论（2026-11-15T13:37+08:00）

| 层 | 结果 | 证据 |
|---|---|---|
| `demo_observed`（Demo/Wasm 行为对照，非宿主） | ✅ 8/8 | `node --test --test-reporter=tap demo/code-view/demo.test.cjs` |
| `atlas_snapshot`（真实 Atlas 0.1 快照 + 真实 Python 读模型） | ✅ | `verification.json` 的 `atlas.*` 检查 |
| `dsh_host`（pinned rc.5 宿主：隔离 profile → boot graph → `/code-view` → Chromium 渲染 → Cordis 生命周期） | ✅ | `verification.json` 的 `host.*`/`dsh_host.*` 检查、`render*.png`、`host-runtime.*` |
| 仓库 Node 测试（附加检查） | ✅ 56/56 | `commands.log` 最后一行 |
| **总体** | **`ok=true`, `verified=true`**：26/26 检查通过，`not_verified=[]` | `verification.json` |

> 分层口径：`demo_observed` 是 Demo 的 Wasm/JS 行为模型；`atlas_snapshot` 是 Lead 生成并导入的真实
> Atlas 0.1 快照（graph sha256 `c6e49fe9…207c`，manifest sha256 `6fc22d84…b6`）；`dsh_host` 是本机
> pinned rc.5 宿主实测。三层分别标注，互不冒充。运行观测（`run_id/event_id`）本切片不提供。

## 2. 运行命令（复现）

在 `E:\dsh\plugin\04-code-learning` 下：

```powershell
# 全量黑盒验收（门禁 + 隔离 profile 启动 + boot graph + /code-view + Chromium 探针
#              + 真实 Cordis 运行时 + Demo 对照 + 仓库 Node 测试），约 20–40s
node tools\verify-readonly.mjs --with-repo-tests

# 单项工具
node tools\readonly-slice\host-baseline.mjs     # pinned exe/asar/version/seam 门禁
node tools\verify-host-runtime.mjs               # 真实 rc.5 Cordis 运行时 TAP + JSON
node tools\readonly-slice\asar.mjs list --filter dsh-client-ui-layout   # 只读 app.asar

# 最终证据在本目录（脚本会重新生成 verification.json / commands.log / render*.png）
```

隔离运行时树写在 `04-code-learning/scratch/readonly-home/`（仓库 `.gitignore` 已含 `scratch/`，
运行结束保留日志/截图中间产物，便于复核；可随时删除）。全流程不访问网络（本机回环 HTTP 除外），
不读写真实 `~/.dsh`。

## 3. 产物清单

| 文件 | 说明 |
|---|---|
| `verification.json` | 权威分层报告：`layers`/`checks`/`not_verified`/`commands`/`limitations`；26 项检查全部带 detail |
| `render.png` | Chromium 探针主截图：面板 + 已核验快照 + `bus_send` 源码 `bus.c:50` 状态（当前选择 `bus_register` 时截取，见下条） |
| `render-resources.png` | Chromium 探针第二截图：资源标识区，`[data-field-access][data-access="write"][data-certainty="exact"]` 的 `routes.max_len @ bus.c:46` |
| `host-runtime.json` / `host-runtime.tap` | 内嵌 Node 24.21.0 + 真实 Cordis 4.0.5 的挂载/卸载/二次挂载 TAP 与 JSON |
| `commands.log` | 本次实际执行的每条命令（含 exit code、cwd），用于复现 |

关键 sha256（Lead 最终独立复跑后目录内当前值；每次运行会重新生成截图/报告，值随之变化）：

- `render.png` = `22a9a028837317fb4ae227660c923c1d8b7e03106cefdeb0e7e200e1fd62a77a`（231,722 B）
- `render-resources.png` = `70134e95ed962ce6260bb2ddf6d34d5cf1a51d391fbf23afb52d65ca8107dcce`（311,524 B）
- `verification.json` = `2b007dc845cef2dc2971bd629f21b4bc4902c69a3849ab14ac1b29e9585b11f2`（62,862 B；
  其中 `checks.host.render_probe.detail.screenshot_sha256` 记录同次运行截图哈希）
- `host-runtime.json` = `f21e258fd33a1c66fce8111f2750ff2675d84a116749e1eb8e57d85f3008e71e`（6,886 B）

## 4. 隔离运行环境（断言前提）

- 固定宿主：`E:\dsh\DeepSeek Harness.exe` SHA256 `7ae939b5…0cc4`；
  `E:\dsh\resources\app.asar` SHA256 `e1b6f25f…6915`；dsh version `0.2.1-rc.5`；
  内嵌 Node `24.21.0` / Electron `44.7.0`；6 个已核 seam 文件逐字节 SHA + 关键字复核
  （见 `verification.json` → `host.pinned_baseline`）。版本/SHA 不符时验收直接失败。
- 隔离 `DSH_HOME`：`scratch/readonly-home/home`（**不是** `%USERPROFILE%\.dsh`）。
- 隔离 web profile：`home/profiles/web/`，`package.json` 的
  `dsh.profile.bundles = ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@local/dsh-code-reader']`；
  `node_modules/@local/dsh-code-reader` 为 junction → `E:\dsh\plugin\04-code-learning`；
  `cordis.patch.yml` 为 `[]`。
- 隔离引擎 bootstrap：`home/code-reader/bootstrap.json`，
  `candidate_roots=[{root_ref:'slice-root', absolute_path:'E:\dsh\plugin\04-code-learning\evidence\code-view-slice', read_grant_ref:'grant-slice'}]`，
  `state_dir`/`import_inbox_dir`/`output_root` 均指向证据输入或隔离 home。
- 引擎：`E:\Anaconda-main\python.exe` 3.11.4；用真实 `python -m code_learning.cli` 执行
  `workspace-import`（`inbox/workspace.json`）与 `snapshot-import`（`inbox/snapshot-bus`，
  snapshot_id `ed326d554334432b907de21297207eb8`）。
- Chromium 探针：本机 `C:\Users\admin\.dsh\electron\electron.exe` 仅作测试工具（不随包分发）；
  窗口以 `opacity=0` + `showInactive` 存在，用户不可见，但能取得当前 composited 帧做截图。
  宿主自身首次运行的「预览版说明/开始使用」浮层只在宿主 UI 层面关闭并原样记录
  （`render_probe.detail` 中 `host_overlays_*`/`final_overlay`），**不省略任何工作台 DOM 断言**。

## 5. 关键验收证据（全部来自最终运行）

### 5.1 dsh_host：隔离 profile + boot graph + RPC 接缝

- `dsh web` 真实启动（`DeepSeek Harness.exe ... lib/bin.js web --no-open --port 0`），
  index 303 + 宿主自签 session cookie 后 200。
- `__DSH_BOOT__` 共 **71** 个 client 条目，含 `@local/dsh-code-reader`；
  其 `inject` 与 `package.json` 的 `dsh.client.inject` 完全一致：
  `['@deepseek-ai/dsh-client-connection','@deepseek-ai/dsh-client-ui-layout','@deepseek-ai/dsh-client-ui-renderer']`。
- 服务端 client bundle 字节 64,169 B，仓库 `bundle/client.js`（64,090 B）为其**精确前缀**，
  仅追加 `;\n//# sourceMappingURL=…`；bundle 内含 `window.__ModuleLoader__.load(` 与模块 id。
- **准入接缝**：无浏览器 cookie 直连 `POST /code-view/view.status` → **401 unauthorized**
  （`connection.admit` 拒绝；未伪造 cookie）。使用宿主自己签发的 session cookie 时：
  `view.status`/`view.listSnapshots`/`view.listEntries`/`view.getEntry` 均 HTTP 200 +
  冻结 `server-response` 信封（`rpcId` 回填），真实 Python 返回：
  snapshot `verified/fresh/19 entries`、`bus_send file=bus.c line=152`、
  source window 152–174、3 条 `exact` 调用边、无绝对路径；
  非法 workspace → `INVALID_ARGUMENT`；坏信封 → `gateway/bad-request`。

### 5.2 dsh_host：Chromium 真实渲染/交互（契约 §7）

`render_flow.steps` 全为 true（32 步），`console error=0`：

- 侧边栏「代码工作台」以 **`aria-label="代码工作台"`** 的 36×36 icon button 呈现
  （rc.5 原生侧栏为图标行；`aria_count=2`：button + 内嵌 svg；文字文本不在 `innerText` 中，
  故验收按可访问名 + `textContent` 双口径记录）。
- 打开面板 `[data-code-view="panel"]`，状态 `data-state="ready"`；
  快照候选 `[data-snapshot-id=ed326d…]`（含「状态 已核验（verified）/新鲜度 最新（fresh）/入口 19」文本）点击成功。
- 入口列表 19 行；点击 `data-entry-name="bus_send"` → 源码区
  `[data-code-view="source"] [data-line="152"]` 文本 `int bus_send(unsigned channel, unsigned length)`，
  `data-highlight="true"`；源码窗口 23 行，含
  `[data-line="164"]` `if (!check_length(route, length))` 与 `[data-line="165"]` `return -90;`。
- 证据分级徽标 `[data-evidence-class]` = `{source_text, exact, may}`（exact 调用边 + 源码证据 + may 资源），
  符合契约 §3「不得混写」要求。
- 资源标识区 `[data-code-view="resources"]`：对象 `[data-resource-id]`（`routes`，`bus.c:26`）；
  字段访问 `[data-field-access][data-access="read"][data-certainty="may"]`（`routes.max_len`，`bus.c:92/93/98/99`）。
- 再点 `bus_register`（`bus.c:50`）→ 资源区出现
  `[data-field-access][data-access="write"][data-certainty="exact"]`：
  `max_len (routes[channel].max_len)`、位置 `bus.c:46`、owner `store_route(bus.c:43)`、
  `data-line="50"` 文本含 `bus_register`。
- 缺口区 `[data-code-view="gaps"]` 非空，`[data-gap-code]` =
  `five_views, resource_graph, scenario_execution, run_observation, resource_object_unresolved`（原因原文）。
- 五视图占位全部存在：`[data-view=coupling|tree|end_to_end|sequence|file]` 且
  `data-state="not_available_in_readonly_slice"`。
- 「返回聊天」→ 面板消失；再次点侧栏 → 面板重开且保留选择：
  `[data-code-view="selection"]` JSON 的 `entry_id` 前后一致（bus_send `f_afa829…`；
  再点 bus_register 后为 `f_5aad5c…`），源码仍在。
- 截图：`render.png`（工作台主视图）、`render-resources.png`（write-exact 资源证据）。

### 5.3 dsh_host：真实 Cordis 运行时（内嵌 Node 24.21.0）

`host-runtime.tap` 1/1 通过；测试挂载真实 `@deepseek-ai/cordis@4.0.5` `Context`（`tools/readonly-slice/host-runtime.test.mjs`）：

1. 6 个 `code_*` 工具注册（`code_workspace/overview/source/snapshot/path/learn`）；
2. `code_workspace action=status` 经真实 Python 引擎成功（`exit_code=0`，返回 `workspace_id=code-view-bus-demo`）；
3. `/code-view` prefix 路由注册；`view.status`/`view.listSnapshots`/`view.listEntries`/`view.getEntry`
   经载体走真实引擎成功；无 cookie 准入拒绝 401（route 级 fail-closed 语义同 §5.1）；
4. dispose 后工具与路由全部注销；二次 `apply` 后再次注册，工具调用与 `/code-view` 仍成功（rc.5 load→unload→load）。

### 5.4 atlas_snapshot 与 demo_observed

- `view-snapshots`：1 workspace / 1 snapshot，`verified`、`fresh`、`entry_count=19`、coverage `failed=0/pending=0`。
- `view-entries`：`bus_send`（`f_afa829…`，`bus.c:152`，`is_entry=true`，callees=3）。
- `view-entry`：source 152–174（byte 4086–4743，sha256 `b2ec2328…`），164/165 行，3 条 exact calls
  （lookup_route 160 / check_length 164 / dispatch_transfer 170），gaps 原样；输出无绝对路径。
- resources partial：`routes` 对象 `bus.c:26`；`bus_send` 的 read may（`max_len` 92/93/98/99）；
  `bus_register` 经 `store_route` 的 write exact（`max_len`，`bus.c:46`，evidence `e_e2c45180…`）。
- Demo：`node --test demo/code-view/demo.test.cjs` 8/8（登记→发送、48/49 分支、平台失败、锁 1→0 等）。

## 6. `not_verified` 与范围限制（如实声明）

最终运行 `not_verified=[]`（本工具范围内的 26 项检查全部通过）。以下项**不在本验收工具范围**，
不得据此宣称已验证：

- 引擎完整 unittest（`cd engine && python -m unittest discover -s tests`，240 项）由 engine/Lead 执行与报告，
  本工具未重复运行、未纳入 `verification.json` 的 `checks`。
- 五视图正式投影、资源关系图/文字树/端到端/时序/文件视图、场景执行/打桩/回退、运行观测：
  本切片明确未提供，UI 以 `data-state="not_available_in_readonly_slice"` 和 gaps 原文占位。
- 真实 Linux/Kbuild/生成头索引、CFG/locks/aliases/dataflow 深分析、真实设备与 ABI/锁/IRQ 目标验证（A05/A07/A11/A12 等）。
- OS 级出口认证：仅做本机回环 HTTP 与静态/运行时行为观测，不等价于 OS 网络认证。
- 宿主版本兼容性：仅固定本机 rc.5 基线（门禁拒绝其他版本）；升级宿主必须重跑并更新证据。
- 桌面宿主自身 UI（首次运行预览/登录浮层）非本插件验收对象；探针仅记录其存在/关闭情况。

## 7. 工具与来源机制（自行实现，不 import 08 代码）

| 工具 | 作用 | 借鉴机制（固定来源） |
|---|---|---|
| `tools/readonly-slice/asar.mjs` | 只读 app.asar 头/entry 解析、SHA256 | 08 `tools/host-rc5/asar.mjs` 的 ASAR pickle/header 机制；本文件独立实现 |
| `tools/readonly-slice/host-baseline.mjs` | pinned exe/asar/version/6 个 seam 门禁 | 08 `src/compat.mjs` + `docs/compatibility-matrix.md §2` 的已核接缝清单 |
| `tools/readonly-slice/isolated-home.mjs` | 隔离 DSH_HOME/profile/bootstrap + 真实 Python CLI import | 08 `tools/isolated-profile-verify.mjs` 的隔离 profile 结构；04 自有实现 |
| `tools/readonly-slice/web-host.mjs` | 真实 `dsh web` 启动/URL/303 token→cookie/`__DSH_BOOT__` 解析 | 08 `tools/isolated-profile-verify.mjs` 的启动与 boot graph 解析机制 |
| `tools/readonly-slice/electron-probe.cjs` | Chromium 探针（契约 §7 断言 + 截图） | 08 `tools/isolated-profile/electron-probe.cjs` 的宿主浮层关闭与探测器机制 |
| `tools/readonly-slice/host-runtime.test.mjs` | 真实 Cordis 挂载/卸载/重挂 + 真实引擎调用 | 08 `tests/host-rpc.test.mjs` / `tools/test-rc5-host.mjs` 的真实 Context + 服务替身机制 |
| `tools/verify-host-runtime.mjs` | 内嵌 Node 24.21.0 runner + 门禁 + TAP/JSON 证据 | 同上 |
| `tools/verify-readonly.mjs` | 分层编排与证据输出 | 08 `tools/isolated-profile-verify.mjs` 的分层报告结构；断言/分层为 04 契约定制 |

## 8. 已知限制与风险

- 探针使用本机安装的通用 Electron 作为 Chromium 测试仪器，不是产品依赖；截图取自 1263×822 的有效视口
  （1500×950 窗口、hidden+opacity0）。
- 探针基于等待/轮询（`data-state`、DOM 钩子、超时 240s），非确定性快照；失败时会写 `debug`/`probe.log`。
- 宿主自身首次运行浮层（「预览版说明」「开始使用」）出现时机由宿主决定；探针只在其遮挡时关闭，
  若未来宿主改动浮层文案/结构，`host_overlays_*` 记录会变化，但工作台 DOM 断言不依赖它。
- 隔离 home 的路径/证据输入路径为 Windows 绝对路径；跨机器复现需同步调整固定环境值（SHA 门禁会立即暴露宿主差异）。
- `verification.json` 中 `commands[].display` 不包含 `dsh web` 的一次性 token（已 redact），`render.json`
  同样不落 token；无凭据/密钥写入证据。
