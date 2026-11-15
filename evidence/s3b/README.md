# 04 场景回退/轨迹导入/观测场景选择（S3b）· 独立黑盒验收证据

本目录是 **verifier（独立验收者）** 对 S3b（undo tail/前缀重放、轨迹导入、observed 多场景选择）
的验收产物。验收只读：不修改插件实现、不联网（仅本机回环 HTTP）、不写真实
`%USERPROFILE%\.dsh`、不重启用户桌面宿主、不做 git 提交。契约依据：
[S3b 契约](../../docs/scenario-s3b-contract.md)（CL-VIEW-T3B，§1 undo、§2 轨迹导入、§3 observed
多场景选择、§4 dsh-web 验收、§5 文件所有权）；前置 [S3a 契约](../../docs/scenario-contract.md)
继续有效。S1/S2a/S2b/S3a 成果分别在 `evidence/readonly-slice/`、`five-views/`、`s2b/`、`s3/`
（本轮均未改动）。

## 1. 最终结论（2026-11-15T17:42+08:00）

| 层 | 结果 | 证据 |
|---|---|---|
| `demo_observed`（Demo Wasm/JS 行为模型） | ✅ 8/8 | `verification.json` → `demo.code_view_demo_tests` |
| `atlas_snapshot`（真实引擎：隔离 inbox 登记 profile + `trace-import` 幂等/observed + `scenario-undo-plan` 投影/imported 拒绝） | ✅ 全过 | `atlas.*` |
| `dsh_host`（pinned rc.5 宿主：隔离 profile → 真实 dsh web → `scenario.undoTail` 真实 wasm 前缀重放/`trace.import`/多场景 observed → Chromium S3b 探针 → S3a/S2a/S2b/S1 回归 → 真实 Cordis 挂载/dispose/二次挂载含 undo/trace） | ✅ 全过 | `host.*` / `regression.*` / `dsh_host.s3b_host_runtime`；`s3b-*.png` |
| 仓库 Node 测试（附加检查） | ✅ 152/152 | `commands.log` 末行 |
| **总体** | **`ok=true, verified=true`：58/58 检查通过，`in_scope_not_verified=[]`** | `verification.json` |

分层口径：`demo_observed` 是 Demo Wasm/JS 行为模型；`atlas_snapshot` 是真实 Python 引擎
（隔离 inbox 登记、轨迹导入不执行代码、undo plan 投影）；`dsh_host` 是本机 pinned rc.5 宿主实测
（真实隔离 Wasm worker 重放前缀、真实台账、真实宿主编排）。三层分别标注、不混写。

## 2. 运行命令（复现）

在 `E:\dsh\plugin\04-code-learning` 下：

```powershell
# 全量 S3b 验收（门禁 → 隔离 home/profile + 隔离 inbox 登记 workspace/snapshot/sim-profile
#   → 引擎 trace-import/undo-plan → 真实 dsh web（boot graph/401 准入/端点 RPC：undoTail 真实
#   wasm 前缀重放、trace.import、view.sequence 多场景）→ Chromium S3b 探针（undo→observed→
#   trace import→多场景切换）→ S3a/S2a/S2b/S1 回归探针 → Cordis（undoTail/trace.import、
#   dispose/二次挂载）→ Demo + 仓库 Node 测试 → 证据）
node tools\verify-s3b.mjs --with-repo-tests

# 单项
node tools\verify-s3b.mjs --skip-probes        # 跳过 Chromium 探针
node tools\verify-s3b.mjs --skip-regression    # 跳过 S1/S2a/S2b/S3a 回归
node tools\verify-s3b.mjs --skip-host-runtime  # 跳过 Cordis 运行时
node tools\verify-s3b.mjs --skip-demo          # 跳过 Demo 层
node tools\verify-s3b.mjs --skip-http          # 只跑门禁/隔离引擎/测试
```

隔离运行时在 `04-code-learning/scratch/s3b/`（`.gitignore` 覆盖 `scratch/`）；探针中间 JSON
`scratch/s3b/s3-probe.json`（S3b 探针）、`s3a-regression-probe.json`、回归 JSON/日志同名目录。

## 3. 产物清单与 sha256（Lead 最终独立复跑后目录内当前值；每次运行会重新生成报告/截图，值随之变化）

| 文件 | 说明 | sha256 |
|---|---|---|
| `verification.json` | 权威报告：layers/checks/not_verified/commands/limitations（106,153 B） | `d0081e2616ff114f866cf8eceac2ad9ce1f46cf272b4c01e4b50fa263ef75f96` |
| `s3b-undo.png` | 回退：成功文案「回退 1 步：前缀重放状态摘要一致（scenario … generation 1）」、前缀台账 2 步、步骤编辑器 2 步、导入轨迹区 | `61a1a2cbe7598fe87fcbeed7ea8e35ae37249581a82ccbf7cd8c46d4b32ebde3` |
| `s3b-imported.png` | 轨迹导入：`已导入轨迹台账：scenario scn_982682c88e20 generation 1（…label）`、imported 台账/limitations/undo 禁用原因 | `938ef547d25956f852f5833c7d3fcb634b42db1c7d058c50dff9ba3771112bda` |
| `s3b-observed-scenario.png` | observed 多场景：台账场景选择器（`[data-code-view="sequence-scenario"]`）选中 imported，`[data-sequence-imported="true"]`、label/limitations、消息含 bus_send(1, 48)/事件/返回 0 | `0ad937d82e6a6e2ad5a6f5ec176ca8691b3199c3fd0af5169904248cb277bf6a` |
| `s3b-main.png` | 打桩 rail 主面板（undo/导入轨迹/接口库/最终台账） | `503a21c026d551a9880093b48026a6c6974e4b1ad24096576d185545306bd389` |
| `s3a-regression-*.png` | S3a 探针在本构建上的回归截图（channel=3 独立 digest） | 见 `verification.json` → `host.s3a_regression_probe` |
| `s2a-*.png` / `s2b-*.png` / `s1-regression.png` | S2a/S2b/S1 回归截图 | 见 `regression.*` |
| `host-runtime.json` / `.tap` | 真实 Cordis 运行时（undoTail/trace.import、dispose/二次挂载）TAP+JSON | `0f7a14536a43251f4539e4b4e38b1d905ee339972be5214a3135340fc42d30b1` / `b9048b4c5b4930e51e08cb9ead12edd48af98fc93a7a179a0f6be6ff583087ea` |
| `commands.log` | 实际命令（含 `sim-profile-import`/`trace-import` 真实 argv、exit code、cwd） | `ba01697b8a56f9109831c6cdf858ada0999abdbd1db005795209a279c5d63db0` |

工具源码：`tools/verify-s3b.mjs`、`tools/s3b-probe.cjs`、`tools/s3b-host-runtime.test.mjs`；
回归使用既有 `tools/s3-probe.cjs`（新增可选 `RV_SCENARIO_CHANNEL`，默认 1 保持 S3a 行为不变）、
`tools/s2b-probe.cjs`、`tools/five-views-probe.cjs`、`tools/readonly-slice/electron-probe.cjs`。

## 4. 隔离运行环境与可信输入

- 固定宿主：`E:\dsh\DeepSeek Harness.exe` SHA256 `7ae939b5…0cc4`；`E:\dsh\resources\app.asar`
  SHA256 `e1b6f25f…6915`；dsh `0.2.1-rc.5`；内嵌 Node `24.21.0` / Electron `44.7.0`。
- 隔离 `DSH_HOME`：`scratch/readonly-home/home`（非真实 `~/.dsh`）；web profile
  `bundles = base + web-app + @local/dsh-code-reader`（模块 junction 指向本仓库），`cordis.patch.yml = []`。
- **隔离 inbox**（`scratch/s3b/inbox`，复制的可信输入）：Lead slice 的 `workspace.json` +
  `snapshot-bus/`，`evidence/scenario-sim/inbox/{sim-profile.json,bus.wasm}`（Wasm 1547 B，
  SHA256 `69c8622d…1321c`），以及 S3b 轨迹夹具 `trace-bus-send.json`（3418 B，
  SHA256 `8860df51…47e06`，steps reset/bus_register(1)/bus_send(1,48)，真实 Demo Wasm 导出）。
- 真实引擎命令（commands.log 有完整 argv）：
  `sim-profile-import --workspace code-view-bus-demo --variant semantic-x86_64 --repo bus --profile sim-profile.json --operation-id <uuid>`
  → profile 投影（binding 一致、interfaces 7、module sha 匹配、无绝对路径）；
  `trace-import --workspace code-view-bus-demo --snapshot <snap> --input trace-bus-send.json --operation-id <uuid>`
  → `scn_982682c88e20` / generation 1，imported/label/source/observed/limitations，幂等；
  `scenario-undo-plan --workspace … --scenario <source> --count 1 --expected-generation G`
  → undo plan（prefix 2 步、expected_prefix 两条 64hex、module sha 对齐），imported 台账返回
  `CAPABILITY_UNAVAILABLE`（不可回退，符合契约 §2.2）。
- Client bundle：仓库 `bundle/client.js` 274,227 B；服务端字节精确前缀；含
  `window.__ModuleLoader__.load(` 与 `@local/dsh-code-reader`。
- Chromium 探针：本机通用 Electron 作测试仪器（opacity=0 + showInactive 不可见窗口），每次
  探针使用独立 user-data-dir（避免共享目录 singleton 锁导致启动缓慢/超时），截图前关闭宿主浮层、
  滚动到目标区域、invalidate+连拍三帧取后一帧。

## 5. 关键验收证据（契约 §4）

### 5.1 回退（undo tail + 前缀重放，§4.1）
- 打桩面板跑 A（reset、bus_register(1)、bus_send(1,48)）→ 台账代次 1、3 条记录、
  Selection `scenario_id=scn_06ff06bc9060`（当次运行）。
- `[data-stub-undo-count]` 设为 1 → 点击 `[data-stub-undo]` → `[data-stub-undo-status]` 显示
  **「回退 1 步：前缀重放状态摘要一致（scenario scn_4686ecddf868 generation 1）」**；
  新台账 step_count=2，前两步 `call_id=call_1_1/call_1_2` 与 **memory_digest 与源前两步完全一致**；
  `undo={of_scenario_id:源, of_generation:1, count:1, state_digest_verified:true}` 可见；
  步骤编辑器自动变为 **2 步**（reset、bus_register(1)）。
- 观察：observed 选择器（时序视图 `[data-code-view="sequence-scenario"]`）列出该前缀场景
  `scn_4686ecddf868 · gen 1 · 2 步`。
- 前缀场景再次点运行 → 代次 **1→2**（Selection `run_generation` 递增；客户端用「不重编辑步骤」
  的方式点击运行，避免其编辑态重置 generation tracker）。
- `count=99` 越界：**本地拒绝**（`data-error-code`，错误文案），台账不变
  （记录数/scenario id 集合前后一致；RPC 层同样验证引擎 `INVALID_ARGUMENT` 且 `scenario.list`
  5→5 条不变）。

### 5.2 轨迹导入与 imported 台账（§4.2/§4.3）
- 打桩面板「导入轨迹」区：输入 `trace-bus-send.json`（只读 inbox 文件名，无路径选择/上传）→
  点击导入 → `[data-trace-import-status]` 显示 **已导入轨迹台账：scenario scn_982682c88e20
  generation 1（外部采集 bus_send 轨迹（Demo Wasm 构建产物导出，示例））**；
  台账显示 imported/source=imported_trace/label/limitations
  （`imported_trace_not_executed_by_host`、`resource_effects_unknown_for_imported_trace`），
  records 3 条（reset/register/send，digest 与夹具一致），**undo 禁用并显示原因**（不可重放）。
- 幂等：再次导入返回同 scenario_id/同 generation（引擎/RPC 层均验证）。
- observed：选择 imported 台账 → `[data-sequence-imported="true"]`、label/limitations，
  20 条消息中 `bus_send(1, 48)` 调用/返回 0、DOORBELL/WRITE、平台/设备边界等，全部
  `observed=true`、`imported` 标记。

### 5.3 observed 多场景选择（§4.4）
- 时序视图 observed 模式出现 `[data-code-view="sequence-scenario"]`（实际为 `<select>`，
  同元素 `data-sequence-scenario-select`）「台账场景」选择器，选项包含 happy/前缀场景
  （`scn_4686ecddf868 · gen 1 · 2 步`）、A 源场景（`scn_06ff06bc9060 · gen 1 · 3 步`）、
  imported（`scn_982682c88e20 · gen 1 · 3 步 · imported 外部采集…`），默认最近更新台账。
- 切换 imported ↔ 前缀场景：消息内容、header scenario_id、`[data-sequence-imported]` 标记
  跟随；Selection `scenario_id`/`run_generation` 同步更新（prefix 切换后 imported 标记消失）。
- 静态预测模式不显示该选择器，`observed=false`（S3a 回归已覆盖）。

### 5.4 宿主与回归（§4.6/§4.7）
- `view.status` capabilities：`scenario_execution=true`、`run_observation=true`、
  **`scenario_undo=true`、`trace_import=true`**、`real_device_dispatch=false`、`ai_summary=false`；
  gaps 仅 `ai_summary`、`real_device_dispatch`。
- RPC：`scenario.undoTail`（真实隔离 Wasm 重放前缀：records 2、digest 逐条一致、
  undo 元数据正确）、非法 count `INVALID_ARGUMENT` 且台账不增、`trace.import` 幂等、
  `view.sequence` observed 多场景（prefix 6 消息 / imported 20 消息）全部 200+冻结 envelope；
  imported undo 返回 `CAPABILITY_UNAVAILABLE`。
- 真实 Cordis：挂载 → 6 工具/旧视图端点 → `scenario.undoTail`（真实 wasm、digest 校验）→
  非法 count → `trace.import`+幂等 → imported observed → imported undo 拒绝 → 前缀再运行代次递增
  → dispose 注销 → 二次 apply 再注册并再次 run；TAP 1/1（`host-runtime.tap`，4.5 s）。
- 回归：S3a 探针在本构建上以 channel=3 独立 digest 通过（`residual_failed_steps=[]`）；
  S2b 全过；S2a 全过（`gapsOriginal`、`stubPanel` 属 S2b/S3a 正当取代，记入
  `coupling_ignored_superseded`）；S1 只读切片全过；三者 console=0。Demo 8/8；仓库 Node 152/152。

## 6. DOM 实际钩子与差异记录（按实际 DOM，未改源码）

| 契约 §1.4/§2.3/§3 示例 | 实际（rc.5 当前 client） |
|---|---|
| `[data-stub-undo-count]` / `[data-stub-undo]` / `[data-stub-undo-status]` | 一致（count 为 number 输入，越界本地拒绝显示 `data-error-code`） |
| `[data-trace-import-input]` / `[data-trace-import]` / `[data-trace-import-status]` | 一致（input 为文件名文本框，无路径选择/上传） |
| `[data-code-view="sequence-scenario"]` | 一致，实际挂在该 `<select>` 上，同元素另有 `data-sequence-scenario-select` |
| `[data-sequence-imported="true"]` | 一致（observed header 的 imported chip） |
| `[data-stub-panel]` | 存在别名（真实容器 `div.dcr-stub-panel[data-code-view="stub-panel"]`） |
| undo 成功文案 | 实际「回退 N 步：前缀重放状态摘要一致（scenario … generation …）」，undo 元数据在台账区/状态文本可见 |
| imported undo 禁用原因 | 客户端按钮禁用 + 原因文本；引擎/RPC 错误码为 **`CAPABILITY_UNAVAILABLE`**（契约 §2.2 只说不提供，实际 code 如此） |
| observed 选择器选项文本 | `scn_… · gen N · M 步 · <ISO 时间>[ · imported <label>]`（无单独 data-scenario-id 属性，选项 value 即 scenario_id） |

其他实际行为（探针已按此适配）：`[data-sequence-mode="static|observed"]` 切换；`[data-sequence-message][data-message-kind]`
消息；observed 默认最近更新台账，需在跑完 A 后立即观察（S3b 顺序 A→undo→observed→trace import）；
导入后自动选中 imported 台账；回退成功后步骤编辑器同步为前缀 steps、历史只读；客户端
`runStub` 的 expected_generation 依赖全局 latestGeneration（编辑步骤会重置为 0），
因此「前缀再运行」探针在不重编辑步骤的前提下直接点运行——此跨场景 CAS 行为记录为 S3b
已知交互限制（不属失败，未改源码）。

## 7. `not_verified` 与范围限制（如实声明）

最终运行 `in_scope_not_verified=[]`（S3b 契约内 58 项全部通过）；`out_of_scope_not_verified` 5 项
（本阶段明确不提供，UI/gaps 体现）：

1. observed 的异步/IRQ 因果细化（S3b 仍为有序步骤台账）；
2. AI 归纳正文（模型出口未接入，仅 gap，不伪造）；
3. 真实设备下发 / 图内源码写回（需单独授权，S4/外部）；
4. 真实 Linux/Kbuild 索引、CFG/locks/aliases/dataflow、目标验证与性能预算（CW-T4/S4）；
5. OS 级出口认证（仅本机回环 HTTP 与本地进程/worker 观测）。

另：engine 全量 unittest（298 tests）由团队执行与报告；本工具实际运行仓库 Node **152/152**
（含 scenario/client/view-rpc 等）与 Demo 8/8；宿主兼容性仅限 pinned rc.5；真实设备/内核行为不被
本证据证明。

## 8. 工具与来源机制

| 工具 | 作用 | 说明 |
|---|---|---|
| `tools/verify-s3b.mjs` | 分层编排：门禁→隔离 home/profile→隔离 inbox 真实登记（workspace/snapshot/sim-profile）→引擎 trace-import/undo-plan→真实 dsh web（boot graph/401/端点 RPC）→Chromium S3b 探针→S3a/S2a/S2b/S1 回归→Cordis→Demo/仓库测试→证据 | 复用 `tools/readonly-slice/*` 机制；探针使用唯一 user-data-dir 保证可重复与速度 |
| `tools/s3b-probe.cjs` | Chromium S3b 探针：A→undo count=1→前缀台账/编辑器/observed 选择器/再运行→count 越界→轨迹导入→observed imported→多场景切换→截图 | 不可见窗口、宿主浮层关闭、面板恢复；React select/number input 用原生 setter + `change`/`input` bubbles |
| `tools/s3b-host-runtime.test.mjs` | 真实 Cordis 上 undoTail（真实 wasm 重放）/trace.import/imported observed/dispose/二次挂载 | Host 服务仅替身；Cordis Context/loader、04 主模块、真实 Python、worker/Wasm 执行均为真 |
| `tools/s3-probe.cjs` 增量 | 可选 `RV_SCENARIO_CHANNEL`（默认 1 保持 S3a 证据行为） | 让 S3a 回归在 S3b 共享台账上使用独立 scenario digest，避免 CAS 冲突 |

## 9. 已知限制与风险

- 探针使用本机通用 Electron 作 Chromium 测试仪器（不随包分发）；不可见窗口渲染属时序观测，
  截图前 invalidate+连拍三帧，仍非确定性像素基线。**若 Electron 共享 user-data-dir 残留
  singleton 锁，探针会启动缓慢/超时；本工具已改为每次独立 user-data-dir 并在退出后清理。**
- 轨迹导入不执行任何代码（引擎只校验/登记）；imported 台账不参与 Wasm 重放，故无
  memory digest 校验，资源影响为 `[]` + limitations（不伪造）。
- 前缀重放状态摘要按 memory_digest 逐条核对（契约实现），call_id 为**新代次**的
  `call_<gen>_<index>`，当前缀场景已有历史台账时其生成代次可能大于源前缀代次（Cordis 测试已按
  契约验证 digest，不要求 call_id 跨代相等；UI 探针在 fresh 场景下两者一致）。
- 回退仅支持末尾 N 步，count 越界由客户端本地拒绝 + 引擎 INVALID_ARGUMENT 双保险，不改台账。
- 隔离路径/宿主 SHA 为 Windows 本机固定值；换机复现需同步固定环境值（门禁立即暴露差异）。
- 证据中不含 `dsh web` 一次性 token（已 redact），不写凭据/密钥。
