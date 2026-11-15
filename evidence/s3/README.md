# 04 受控场景模拟（S3a）· 独立黑盒验收证据

本目录是 **verifier（独立验收者）** 对 S3a（打桩模拟/运行台账/时序观测首切片）的验收产物。
验收只读：不修改插件实现、不联网（仅本机回环 HTTP）、不写真实 `%USERPROFILE%\.dsh`、
不重启用户桌面宿主、不做 git 提交。契约依据：
[受控场景契约](../../docs/scenario-contract.md)（CL-VIEW-T3，§2 profile 信任、§3 引擎
CLI/DTO、§4 Host 端点、§5 客户端 DOM 钩子、§6 运行台账/observed DTO、§7 dsh-web 验收、
§8 分层验证、§9 文件所有权）。S1/S2a/S2b 成果分别在 `evidence/readonly-slice/`、
`evidence/five-views/`、`evidence/s2b/`（本轮均未改动）。

## 1. 最终结论（2026-11-15T16:36+08:00）

| 层 | 结果 | 证据 |
|---|---|---|
| `demo_observed`（Demo Wasm/JS 行为模型） | ✅ 8/8 | `verification.json` → `demo.code_view_demo_tests` |
| `atlas_snapshot`（真实引擎：隔离 inbox 登记 profile→scenario-plan/module→RPC 执行后 scenario-list/get、observed 时序） | ✅ 全过 | `atlas.*` |
| `dsh_host`（pinned rc.5 宿主：隔离 profile → 真实 dsh web → boot graph/401 准入 → `scenario.*` + `view.*` RPC（真 Python + 真隔离 Wasm worker）→ Chromium S3a 打桩/台账/observed 探针 → S1/S2a/S2b 回归 → 真实 Cordis 挂载/dispose/二次挂载） | ✅ 全过 | `host.*` / `regression.*` / `dsh_host.s3_host_runtime`；`s3-*.png` |
| 仓库 Node 测试（附加检查） | ✅ 136/136 | `commands.log` 末行 |
| **总体** | **`ok=true, verified=true`：43/43 检查通过，`in_scope_not_verified=[]`** | `verification.json` |

分层口径：`demo_observed` 是 Demo Wasm/JS 行为模型；`atlas_snapshot` 是真实 Python 引擎
（从隔离 inbox 登记 profile、签发 plan、真实 scenario.run 后读取台账与 observed 时序）；
`dsh_host` 是本机 pinned rc.5 宿主实测。三层分别标注、不混写；真实设备/内核行为不在本切片。

## 2. 运行命令（复现）

在 `E:\dsh\plugin\04-code-learning` 下：

```powershell
# 全量 S3a 验收（门禁 → 隔离 home/profile + 隔离 inbox 登记 workspace/snapshot/sim-profile
#   → 引擎 scenario CLI 断言 → 真实 dsh web（boot graph/401 准入/11 端点 RPC，含真实 Wasm worker）
#   → Chromium S3a 探针（A happy→observed→B stub→C -2→非法参数→undo/gaps）
#   → S2b/S2a/S1 回归探针 → 真实 Cordis 运行时（scenario.run 真实 wasm、dispose/二次挂载）
#   → Demo + 仓库 Node 测试 → 证据）
node tools\verify-s3.mjs --with-repo-tests

# 单项
node tools\verify-s3.mjs --skip-probes        # 跳过 Chromium 探针
node tools\verify-s3.mjs --skip-regression    # 跳过 S1/S2a/S2b 回归
node tools\verify-s3.mjs --skip-host-runtime  # 跳过 Cordis 运行时
node tools\verify-s3.mjs --skip-demo          # 跳过 Demo 层
node tools\verify-s3.mjs --skip-http          # 只跑门禁/隔离引擎/测试
```

隔离运行时在 `04-code-learning/scratch/`（已被 `.gitignore` 忽略）；探针中间 JSON：
`scratch/s3/s3-probe.json`、回归探针 JSON 与日志同名目录。

## 3. 产物清单与 sha256（Lead 最终独立复跑后目录内当前值；每次运行会重新生成报告/截图，值随之变化）

| 文件 | 说明 | sha256 |
|---|---|---|
| `verification.json` | 权威报告：layers/checks/not_verified/commands/limitations（82,388 B） | `acfd7eb34cbb9529e03e48f6c2ff4a1ae33b509ca2b4318e448c07bbcab6c230` |
| `s3-stub-run.png` | A happy 场景台账：scenario_id/代次 2/records_digest、3 条记录（reset→—、register→0、bus_send→0）与事件/资源 | `e2db04b55b4c7cb055325543b8dee5f9965763a829fa30bacf25406adab048a2` |
| `s3-stub-stub.png` | B 边界打桩：`set_platform_stub(-5)` 记录（stubbed=边界打桩步、result —）、bus_send status error 结果 -5、无 WRITE、LOCK 两事件、S3b 回退 gap | `c363f4279705f0e014bcb4d1c08e8e7625638e688f74274d36a55a818c2c4e8d` |
| `s3-sequence-observed.png` | 时序图 observed：`observed=true`、scenario/generation、20 条 call/return/access/event 消息（bus_send(1,48)、DOORBELL/WRITE、平台/设备边界、返回 0） | `c73156fd134f16acb2965a963be8a4f1d67977b86077e417512639bd09d7d342` |
| `s3-main.png` | 打桩 rail 主面板 + 最终台账（只追加记录/回退 gap/接口库） | `bb0f562d08d8c1949d3cb8147049d743967d77e0bb1ce85a7be490e32a6844ce` |
| `s2a-*.png` / `s2b-*.png` / `s1-regression.png` | S2a 五视图、S2b 组/接口库/子流程、S1 只读切片回归截图 | 见 `verification.json` → `regression.*` |
| `host-runtime.json` / `.tap` | 真实 Cordis 运行时（scenario.run 真实 wasm、dispose/二次挂载）TAP+JSON | `ea708b20e8cfe5586217cd6b1e43fca3d095f65dae33bde91b59a0f8187947e1` / `9c81a867efa6f03300973bef2f6d6e2a7e99bb3528ddd4ec89b40672e1dfe790` |
| `commands.log` | 本次实际命令（含 sim-profile-import 真实 argv、exit code、cwd） | `73a692719262501314441fba8c2eb8c7eed447119f5832123d18875589dd900f` |

工具源码：`tools/verify-s3.mjs`、`tools/s3-probe.cjs`、`tools/s3-host-runtime.test.mjs`。

## 4. 隔离运行环境与可信 profile 登记

- 固定宿主：`E:\dsh\DeepSeek Harness.exe` SHA256 `7ae939b5…0cc4`；`E:\dsh\resources\app.asar`
  SHA256 `e1b6f25f…6915`；dsh `0.2.1-rc.5`；内嵌 Node `24.21.0` / Electron `44.7.0`。
- 隔离 `DSH_HOME`：`scratch/readonly-home/home`（非真实 `~/.dsh`）；web profile
  `bundles = base + web-app + @local/dsh-code-reader`（模块 junction 指向本仓库），`cordis.patch.yml = []`。
- **隔离 inbox**（`scratch/s3/inbox`，复制的可信输入）：Lead slice 的 `workspace.json` +
  `snapshot-bus/`，加 `evidence/scenario-sim/inbox/{sim-profile.json,bus.wasm}`
  （Wasm 1547 B，SHA256 `69c8622d3522f68f90450a2db36ee11a85c859c91bdf2b5df1688fd6acd1321c`）。
- 真实引擎登记（commands.log 有完整 argv）：
  `sim-profile-import --workspace code-view-bus-demo --variant semantic-x86_64 --repo bus --profile sim-profile.json --operation-id <uuid>`
  → 返回 profile 投影（binding 一致、interfaces 7、module sha 匹配、无绝对路径）；
  `sim-profile-list` 重新校验（`status:"verified"`、7 接口、`limits {timeout_ms:10000,steps:20,events_per_step:256}`、19 个 trace events）。
- Client bundle：仓库 `bundle/client.js` 259,297 B；服务端返回 259,377 B = 仓库字节精确前缀
  （+ sourceMappingURL 后缀）；含 `window.__ModuleLoader__.load(` 与 `@local/dsh-code-reader`。
- Chromium 探针：本机通用 Electron 作测试仪器（opacity=0 + showInactive 不可见窗口），截图前
  关闭宿主浮层、滚动到台账/消息区域、invalidate+连拍三帧取后一帧。

## 5. 关键验收证据（契约 §7）

### 5.1 打桩面板与 profile/步骤编辑器（§7.1）
- 左侧 rail 出现 `button[data-rail="stub"]`「打桩模拟」；`[data-code-view="stub-panel"]` 打开；
  `[data-stub-profile]` 为可选 select（auto 选中 `bus-demo-wasm`），facts 显示 label、
  **binding code-view-bus-demo / semantic-x86_64 / bus / ed326d554…207eb8**、module sha256 前缀与
  1547 B、接口 7、limits、限制文案；`[data-stub-editor]` 步骤编辑器出现。
- `[data-step-interface]` 下拉按 role 分组（optgroup）包含 **bus_send / set_platform_stub**
  （另有 reset/bus_register/stub_route/bus_unregister/bus_irq），`[data-stub-add-step]` 可增行，
  `[data-stub-stop-on-error]` 存在；参数输入 `[data-step-arg]` 带 min/max（channel 0..3、
  length 0..65535、return_code -4095..0）。

### 5.2 happy 场景 + 重复代次（§7.2）
- 步骤 reset、bus_register(1)、bus_send(1,48) → 点击 `[data-stub-run]` 后真实 Wasm worker 执行；
  3 条 `[data-stub-record][data-call-id][data-status]`：结果 **—（reset void→null）/0/0**、
  全部 status ok；call_id/call_1_1…、memory digest 均为 **64 hex**。
- 事件集合：bus_register 记录 DEFAULT_ROUTE、STORE_ROUTE；bus_send 记录
  REQUEST/LOOKUP/CHECK_LENGTH/LOCK/TRANSFER/DIRECT/COMMIT/ENCODE/DOORBELL/LIBRARY/WRITE/LOCK
  （契约要求的 10 个事件全部覆盖，额外含真实 LOCK/COMMIT/LIBRARY）；`[data-stub-affect]`
  含 `routes`(read/write)、`transfer_lock`(write)、`platform_status`(read)、
  **`simulated_doorbell`(write)**。
- 同一场景再次点运行 → 台账代次 1→2（页头 `台账当前代 N`，Selection `run_generation` 递增 1）。

### 5.3 边界打桩 / 失败 / 非法参数（§7.3）
- 新增 set_platform_stub(-5) 后 bus_send(1,48)：`[data-stub-record]` 中 stub 步
  **边界打桩步** 且 result —（void 且 `data-stubbed=true`）；bus_send 记录 status **error**、
  result **-5**；该记录 **无 WRITE** 事件；LOCK 两个事件 **a=1 → a=0**（title 中 code/a/b/c 可读）。
- bus_send(0,48)（未注册 route）→ result **-2**、status error。
- 非法参数 bus_send(4,48)（超出 channel 0..3）：UI 校验显示 error code / 引擎返回
  **INVALID_ARGUMENT**（`scenario.steps[0].args[0] is outside the declared range [0, 3]`），
  **台账不新增**（records 数不变；scenario.list 条数不变）。

### 5.4 时序观测（§7.5）
- A 运行完成后立即切「时序图」→ 时序模式 `[data-code-view="sequence-mode"]` 中
  `[data-sequence-mode="observed"]`「运行观测」→ `[data-sequence-observed="true"]`，
  observed=true、scenario_id/generation/records_digest 显示；**20 条**
  `[data-sequence-message][data-message-kind]`（call/return/access/event，全部 observed=true），
  含 `bus_send(1, 48)` 调用与返回 0、DOORBELL/WRITE、平台/设备边界、LOCK 等；
  数据来自运行台账（非静态预测）。
- 切回静态预测 `[data-sequence-mode="static"]` → `[data-sequence-warning]` 显示
  `observed=false（静态预测，无运行观测）`，`[data-sequence-observed="true"]` 消失。

### 5.5 gaps / 回退禁用 / Selection（§7.6）
- `[data-stub-undo]` 禁用，文案「回退末尾 N 次（S3b 提供）」+ `[data-stub-undo-gap]`；
  `[data-stub-gap]` 含 `scenario_undo`、`trace_import`、`real_device_dispatch`
  （真实设备下发需单独授权；编译器/构建未启用，不在插件内编译）；候选区另含 `ai_summary` 等
  （由 view.status gaps 提供：`ai_summary/scenario_undo/trace_import/real_device_dispatch`）。
- `view.status` capabilities：`scenario_execution=true`、`run_observation=true`、
  `scenario_undo=false`、`trace_import=false`、`real_device_dispatch=false`、`ai_summary=false`。
- Selection 含 `scenario_id`/`run_generation`/`call_id` 字段；console error=0、无绝对路径
  （探针输出 `leak.count=0`）。

### 5.6 真实宿主与回归（§7.7/§7.8）
- boot graph 71 条含 `@local/dsh-code-reader` 且 inject 一致；无 cookie POST
  `/code-view/view.status` → **401**（admission 生效）；带宿主自签 cookie 时：
  `scenario.listProfiles`（7 接口/limits）、`scenario.preview`（真实 plan_id/steps/module_sha）、
  `scenario.run`（records 3、结果 [null,0,0]、10+ 事件、WRITE→simulated_doorbell、
  records_digest 64hex）、`scenario.list/get`、`view.sequence observed`（20 消息）全部 200 +
  冻结 envelope + 真实 Python；非法参数 → INVALID_ARGUMENT 且 ledger 3→3 不变。
- 真实 Cordis：插件挂载 → 6 工具注册 → `scenario.listProfiles/preview/run(真实 Wasm)/get/list` →
  `view.sequence observed` → 场景 B(-5/stub/无 WRITE/LOCK [1,0]) → C(-2) → 非法参数不落台账
  （独立渠道）→ dispose 注销工具/前缀路由 → 二次 apply 再注册并再次 run（代次递增）→ dispose；
  TAP 1/1（`host-runtime.tap`）。
- 回归：S2b 探针（组/接口库/子流程/Selection）全过；S2a 五视图探针全过（其中
  `gapsOriginal` 与 `stubPanel` 两个 S2a 断言属**被 S3a 正当取代**：组折叠/接口库已在 S2b 实现、
  打桩占位已升级为真实面板，记入 `coupling_ignored_superseded`）；S1 只读切片探针 23 项全过；
  三者 console error=0。Demo 8/8；仓库 Node 136/136。

## 6. DOM 实际钩子（与契约 §5 的差异记录）

验收按**实际 DOM**记录（未改源码；如需对齐由 Lead 裁定改 client 或调 probe）：

| 契约 §5 示例 | 实际（rc.5 当前 client） |
|---|---|
| `[data-code-view="stub-panel"]` | 实际为 `div.dcr-stub-panel[data-code-view="stub-panel"]`（无 `data-stub-panel` 属性） |
| 步骤 `[data-stub-step][data-step-index]` | 一致；接口 select 为 `[data-step-interface="<stepIndex>"]`，参数为 `[data-step-arg="<stepIndex>:<paramIndex>"]`，移除为 `[data-step-remove]` |
| 记录 `[data-stub-record]` | 一致，另有 `data-call-id/data-status/data-step-index/data-result`；void → `结果 —` 且无 `data-result` |
| 事件 `[data-stub-event][data-event-kind]` | 一致；`title` 携带 `code= a= b= c= line=`（探针由此解析 LOCK a 值） |
| 资源影响 `[data-stub-affect][data-resource-id]` | 一致，另有 `data-access` |
| observed `[data-sequence-observed="true"]` | 一致（包裹层）；模式控制在 `[data-code-view="sequence-mode"]` 内，按钮为 `[data-sequence-mode="static|observed"]`（非 `data-mode`）；消息 `[data-sequence-message][data-message-kind]` |
| 回退 `[data-stub-undo]` + gap | 一致；另有 `[data-stub-undo-gap]`；gaps 为 `[data-stub-gap="<code>"]` |

其他实际行为（探针已按此调整）：步骤编辑器仅在 profile 接口可用时出现；运行按钮在
workspace ready 且 profile 有接口时可用；`[data-stub-plan]`、`[data-stub-generation]` 显示 plan/代次；
observed 按钮需已有台账才可用；**observed 模式取最近更新的台账**（当前 client 无多 scenario 选择器，
S3b 可加；验收顺序为 A→observed→static→B→C→非法参数，故 observed 读到 A 的时间线）；
client 的 `runStub` 用全局 `latestGeneration` 作 expected_generation，跨场景切换后重跑旧场景可能
CAS 冲突——本轮验收已用「不重复触碰同一 digest」的顺序规避，记录为 S3b/交互改进候选（不属 S3a 失败）。

## 7. `not_verified` 与范围限制（如实声明）

最终运行 `in_scope_not_verified=[]`（S3a 契约内 43 项全部通过）；`out_of_scope_not_verified` 5 项
（本阶段明确不提供，UI 以 gaps/禁用体现）：

1. 回退末尾 N 次/前缀重放、轨迹导入（S3b）；
2. AI 归纳正文（模型出口未接入，仅 gap，不伪造）；
3. observed 的异步/IRQ 因果细化与真实设备下发（S3a 只记录有序步骤台账；真实设备需单独授权/S4）；
4. 真实 Linux/Kbuild 索引、CFG/locks/aliases/dataflow、目标验证与性能预算（CW-T4/S4）；
5. OS 级出口认证（仅本机回环 HTTP 与本地进程/worker 观测）。

另：engine 全量 unittest（289 tests）由团队执行与报告，本工具实际运行仓库 `node --test`（136/136，
含 scenario/sim-runner/client）与 Demo；宿主兼容性仅限 pinned rc.5；真实设备/内核行为不被本证据证明。

## 8. 工具与来源机制

| 工具 | 作用 | 说明 |
|---|---|---|
| `tools/verify-s3.mjs` | 分层编排：门禁→隔离 home/profile→**隔离 inbox 真实登记 workspace/snapshot/sim-profile**→引擎 scenario CLI→真实 dsh web（boot graph/401/11 端点 RPC）→Chromium S3a 探针→S1/S2a/S2b 回归→Cordis→Demo/仓库测试→证据 | 复用 `tools/readonly-slice/*`（asar/host-baseline/isolated-home/web-host）机制 |
| `tools/s3-probe.cjs` | Chromium S3a 探针：profile/步骤编辑器、A/B/C 场景、observed 时序、gaps/undo/Selection、截图 | 复用 S1/S2a/S2b 的不可见窗口、宿主浮层关闭、面板恢复机制；React select/input 用原生 setter + `change`/`input` bubbles |
| `tools/s3-host-runtime.test.mjs` | 真实 Cordis 挂载→scenario.run 真实 Wasm→台账→observed→dispose→二次挂载 | Host 服务仅替身；Cordis Context/loader、04 主模块、真实 Python、worker/Wasm 执行均为真 |

## 9. 已知限制与风险

- 探针使用本机通用 Electron 作为 Chromium 测试仪器（不随包分发）；不可见窗口渲染属时序观测，
  截图前 invalidate+连拍三帧，仍非确定性像素基线。
- 执行仅在 Host `worker_threads` 内完成（父进程从引擎 `scenario-module` 取模块字节；worker 不读
  fs、不联网、无其他 import），本验收通过 UI/RPC 观察台账，不直接执行 Wasm。
- 隔离 profile 为 Demo 构建产物，不证明真实设备/内核行为；真实下发/编译构建不在 S3a 范围。
- 台账只追加；探针按「A→observed→B→C→非法参数」顺序执行以匹配 client 的 latest-ledger 语义，
  同场景重跑代次递增已单独断言（1→2）；跨场景 CAS 交互限制见 §6。
- 宿主首次运行浮层出现时机由宿主决定；探针只在其遮挡时关闭并记录，最终运行未发生面板丢失。
- 隔离路径/宿主 SHA 为 Windows 本机固定值；换机复现需同步固定环境值（门禁立即暴露差异）。
- 证据中不含 `dsh web` 一次性 token（已 redact），不写凭据/密钥。
