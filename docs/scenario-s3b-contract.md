# 04 场景回退与轨迹导入契约（CL-VIEW-T3 / 阶段 S3b）

`CL-VIEW-T3B-CONTRACT` · 2026-11-15 · 固定**回退末尾 N 次与前缀重放**（CW-08/A09）、**轨迹导入**（CW-08
"先支持导入已有轨迹"）与**观测时序多场景选择**的首个切片。前置契约
[scenario-contract](scenario-contract.md) 的 profile/plan/record/台账/observed DTO 继续有效；本文件只加增量。

## 0. 范围

做：undo tail（回退末尾 N 步→重放前缀→状态摘要核验→新 generation）、trace import（inbox 轨迹→只读台账→
观测时序）、observed 多场景选择器；S3b 的 dsh-web 验收。
不做：真实设备下发、图内源码写回、异步/IRQ 因果推断细化、AI 归纳正文、S4 目标验证；这些继续以 gaps 显示。

## 1. 回退末尾 N 次与前缀重放（CW-08/A09）

### 1.1 语义

- 源：当前 scenario ledger 的 generation `G`（须等于调用方 `expected_generation`），步骤 = 该代 records 的
  `interface/args` 序列（`len = L`）。`count = N`，`1 ≤ N ≤ L`（允许 N=L → 空前缀）。
- 前缀 = 原步骤 `[0 .. L-N]`；前缀场景 `scenario_id = scn_<digest(profile, prefix steps)[:12]>`（确定性；
  空前缀也合法，digest 固定）。若该前缀场景已存在台账，则在其当前代上追加新 generation（CAS 由 plan 记录
  `expected_prefix_generation`）。
- **重放**：Host 在隔离 worker 中以同一 profile/模块重新执行前缀步骤；引擎逐条核对重放 records 的
  `memory_digest` 是否与源 ledger 前缀 records 的 `memory_digest` 完全一致。
  - 一致 → `state_digest_verified=true`，发布前缀场景新 generation（records=重放记录，附
    `undo:{of_scenario_id,of_generation,count,state_digest_verified:true}`），返回该代台账。
  - 不一致 → `STATE_CONFLICT`（`code="state_digest_mismatch"`，details 给出第一条不一致的 step_index、
    expected/actual digest 前缀），**不发布**；调用方可重试或保留只读历史。
  - 重放期间的 worker 超时/取消/崩溃 → `OUTCOME_UNKNOWN`，不发布。
- 副作用不可逆/无重放前提时：不提供 undo，只保留只读历史（S3b 的模拟 profile 均可重放；未知/导入轨迹台账
  不提供 undo）。
- 只允许回退末尾 N 步，不支持中间插入/重排（重排属于 UI 场景编辑，重新 plan 即可）。

### 1.2 引擎 CLI

| 命令 | 参数 | 说明 |
|---|---|---|
| `scenario-undo-plan` | `--workspace --scenario S --count N --expected-generation G` | 校验源代次/步骤数/计数；算前缀场景与 plan（含前缀 steps、expected prefix generation、源前缀 memory_digest 期望、module/trace 引用、TTL）；返回 undo plan 投影，不执行 |
| `scenario-undo-record` | `--plan <undo_plan_id> --records-json <b64> --operation-id` | 校验 records 对齐前缀 steps、逐条 memory_digest 与源前缀期望一致（不一致 → STATE_CONFLICT/state_digest_mismatch 且不发布）；发布前缀台账 generation（含 undo 元数据、records_digest、签名、幂等 operation），返回台账投影 |

undo plan 投影：
```jsonc
{"schema_version":1,"undo_plan_id":"undo_<32hex>","kind":"undo",
 "source":{"scenario_id":"scn_…","generation":2,"step_count":3},
 "count":1,
 "prefix":{"scenario_id":"scn_…","generation":1,"step_count":2,
           "steps":[{"index":0,"interface":"reset","args":[]},
                    {"index":1,"interface":"bus_register","args":[1]}],
           "scenario_digest":"…","expected_records_digest":"…"},
 "expected_prefix":[{"step_index":0,"memory_digest":"<64hex>","result":null,"status":"ok"},
                    {"step_index":1,"memory_digest":"<64hex>","result":0,"status":"ok"}],
 "profile_id":"bus-demo-wasm","module_sha256":"…",
 "limits":{"timeout_ms":10000,"steps":20,"events_per_step":256},
 "expires_at":"…","limitations":["replay_verified_by_memory_digest","wasm_simulation_not_real_device"]}
```
新 generation 额外字段：`"undo":{"of_scenario_id":"…","of_generation":2,"count":1,"state_digest_verified":true}`；
`scenario-list`/`scenario-get` 原样返回该字段；`scenario_id` 仍是前缀场景。

### 1.3 Host 端点

`scenario.undoTail`：输入 `{workspace, scenario, count, expected_generation}`；
Host 编排 `scenario-undo-plan` → `scenario-module --plan <undo_plan_id>`（plan 类型为 undo，模块导出接口不变）
→ worker 重放前缀 → `scenario-undo-record`。总超时 15s；worker 失败/超时 → `OUTCOME_UNKNOWN` 不发布；
digest 不一致 → 引擎错误文档原样返回（`{ok:true,value:{…error…}}`）。返回值 = 新前缀台账 + `undo` 字段。
同时 `scenario.module` 导出需接受 undo plan id（同一 plan store，`kind` 区分）。

### 1.4 客户端

- 打桩面板记录区下方：`[data-stub-undo-count]`（1..L，默认 1）、`[data-stub-undo]`（可用条件：当前代 L≥1、
  非导入台账；用户点击才执行）、`[data-stub-undo-status]`（busy/成功“回退 N 步：前缀重放状态摘要一致
  （scenario … generation …）"/失败错误码与消息，不显示路径/堆栈）。
- 成功后：台账切到前缀场景与代次；步骤编辑器同步为前缀 steps；observed 选择器刷新并选中该场景；
  Selection `scenario_id/run_generation` 更新、`call_id=null`；历史只读（不可再回退到已删步骤）。
- 回退失败（state_digest_mismatch/OUTCOME_UNKNOWN）：保持原台账，显示诊断；不静默改数据。
- 导入台账（`imported:true`）显示 undo 不可用与原因（无法重放）。

## 2. 轨迹导入（CW-08）

### 2.1 inbox 轨迹文件（人工/外部放入可信 inbox）

```jsonc
{"schema_version":1,"kind":"imported_trace",
 "label":"外部采集 bus_send 轨迹（示例）",
 "profile_id":"bus-demo-wasm",            // 可选：仅在能被已登记 profile 解析时引用
 "snapshot_id":"ed326d554334432b907de21297207eb8",
 "metadata":{"collected_by":"external","clock":"event-order"},
 "steps":[
   {"interface":"reset","args":[],"status":"ok","result":null,
    "events":[],"memory_digest":"<64hex>|null","elapsed_ms":0},
   {"interface":"bus_send","args":[1,48],"status":"ok","result":0,
    "events":[{"event":"REQUEST","code":4,"a":1,"b":48,"c":0,"line":154}, "…"]}]}
```
校验：`schema_version=1`、steps 1..200、interface 名模式 `^[A-Za-z_][A-Za-z0-9_]{0,63}$`、args ≤8 个 32 位整数、
status ∈ ok|error、result 32 位整数或 null、events ≤256/step（`event` 名 ≤64、`code/a/b/c/line` 32 位）、
`memory_digest` 可选 64hex、文件 ≤64 KiB；`snapshot_id` 必须等于命令行 snapshot；若给 `profile_id` 必须已登记且
绑定一致。导入**不执行**任何代码。

### 2.2 引擎 CLI / 台账

`trace-import --workspace --snapshot S --input <inbox 文件名> --operation-id`：
- `scenario_id = scn_<digest(snapshot,steps)[:12]>`；台账写 generation（首次 1；同一输入再次导入返回当前代，
  幂等 operation）；
- ledger 增加 `imported:true`、`source:"imported_trace"`、`label`、`metadata`、`observed:true`；
  `limitations` 追加 `imported_trace_not_executed_by_host`；
- records：`call_id=call_<gen>_<index>`、`affected_resources=[]`（无 profile 映射时不伪造）+ limitation
  `resource_effects_unknown_for_imported_trace`；`stubbed=false`；
- `records_digest` 沿用；`scenario-get/list` 返回 imported/label 字段；`view-sequence-observed` 对该台账生成
  消息（`observed:true`、`imported:true`，call/event/return 按 events 与 status/result 推导；warning 仍 null，
  但 `limitations` 保留导入声明）。
- **不提供** undo/重放到导入台账（undo 只在可重放模拟台账上）。

### 2.3 Host 端点 / 客户端

- `trace.import`：输入 `{workspace, snapshot, input}`；`input` 为 inbox 内单文件名（只允许普通文件名，≤256，
  engine 再校验存在与大小）；映射 `trace-import`；返回台账投影；engine 错误原样。
- 客户端：打桩面板底部「导入轨迹」区 `[data-trace-import-input]`（文件名文本）、`[data-trace-import]` 按钮
  （用户点击）、`[data-trace-import-status]`；成功后 observed 选择器出现 imported 台账并选中，观测时序显示
  `[data-sequence-imported="true"]` 标记与 `label`、limitations；undo 禁用并显示原因；不做文件上传/路径选择。

## 3. 观测时序多场景选择（S3a 限制修复）

- 时序视图 observed 模式增加 `[data-code-view="sequence-scenario"]` 选择器：选项来自 `scenario.list`
  （`scenario_id`、`step_count`、`generation`、`updated_at`、imported 标记），默认最近更新台账；
  切换重新请求 `view.sequence {mode:'observed', scenario}` 并更新 Selection `scenario_id/run_generation`。
- 若台账为空：observed 不可选 + gap（同 S3a）。
- 静态预测模式不显示该选择器。

## 4. dsh-web S3b 验收（`node tools/verify-s3b.mjs --with-repo-tests`）

隔离 profile + 真实 dsh web + 真实引擎/worker；sim profile 与轨迹文件放入隔离 inbox：
1. **回退**：跑 A（reset, bus_register(1), bus_send(1,48)，3 步）→ 台账代次 g；设 undo count=1 → 点击回退 →
   新台账 step_count=2、records[0..1] 的 call_id/memory_digest 与源前两步一致、`undo.count=1`、
   `state_digest_verified` 可见、`[data-stub-undo-status]` 显示“前缀重放状态摘要一致”；步骤编辑器变 2 步；
   observed 选择器出现前缀场景；随后再次运行 → 前缀台账代次递增。
2. **回退失败不可见场景**：导入轨迹台账 undo 按钮禁用并显示原因；count 越界由 UI/引擎拒绝且台账不变。
3. **轨迹导入**：输入 `trace-bus-send.json`（evidence/scenario-sim/inbox）→ 导入成功 → observed 选择器出现
   imported 台账（含 label）→ observed 消息含 bus_send(1, 48)/DOORBELL/WRITE/返回 0 且 marked imported；
   `[data-sequence-imported="true"]`；台账 limitation 原样；不显示绝对路径。
4. **多场景选择**：observed 选择器切换 happy 前缀场景与 imported 台账，消息/scenario_id 跟随切换；Selection 更新。
5. console error=0、无绝对路径；截图 `evidence/s3b/{undo,imported,observed-scenario}.png` + main.png；
   `verification.json`（in/out_of_scope not_verified）+ README（复现命令/sha/限制）。
6. 回归：S3a（打桩/台账/observed）、S2a/S2b/S1 探针通过；Cordis 挂载/卸载/二次挂载含 `scenario.undoTail`/
   `trace.import` 真实调用；Demo 8/8；仓库 Node/Python 全绿。

## 5. 文件所有权（S3b）

| 负责人 | 写入范围 |
|---|---|
| Lead | `docs/`、`source.lock.json`、`evidence/scenario-sim/`（轨迹夹具）、`evidence/s3b/` 汇总、最终集成/提交 |
| engine | `engine/code_learning/scenario.py`、`cli.py`、`engine/tests/test_scenario.py` |
| host | `lib/scenario-service.mjs`、`index.js`（如需）、`lib/view-service.mjs`（如需）、`tests/node/scenario.test.mjs`、`tests/node/view-rpc.test.mjs` |
| client | `bundle/client.js`、`tests/node/client.test.mjs`、`tests/node/helpers/client-harness.mjs` |
| verifier | `tools/verify-s3b.mjs`、`tools/s3b-probe.cjs`、`tools/s3b-host-runtime.test.mjs`、`evidence/s3b/` |

跨范围修改先经 Lead；不 git 提交；不联网；不改真实 `~/.dsh`；不重启桌面宿主；不在插件内运行编译器/构建。

## 6. 本轮验收结果（2026-11-15，S3b）

`node tools/verify-s3b.mjs --with-repo-tests`：`ok=true, verified=true`，**58/58 检查通过**，
`in_scope_not_verified=[]`；`out_of_scope_not_verified` 5 类（observed 异步/IRQ 因果、AI 归纳正文、
真实设备/图内源码写回、S4 Linux/CFG/性能、OS 出口）。分层：`demo_observed` Demo 8/8、
`atlas_snapshot` 隔离 inbox 真实登记 + `trace-import`（`scn_982682c88e20`、imported/label/limitations、
幂等、imported observed 20 消息）+ `scenario-undo-plan`（prefix 2 步/expected_prefix）+ imported undo 拒绝、
`dsh_host` 隔离 rc.5 dsh-web（真实 wasm undo 前缀重放：records 2、memory_digest 与源前两步一致、
undo.of_*/count/state_digest_verified；非法 count 不增代；trace.import 幂等；observed 多场景切换；
前缀再运行代次 1→2；Cordis TAP 1/1 含 undo/trace/dispose/二次挂载）。

关键 dsh-web 证据：`[data-stub-undo-status]`「回退 1 步：前缀重放状态摘要一致（scenario scn_4686… gen 1）」、
新台账 step_count=2 且 `call_1_1/call_1_2` 的 memory_digest 与源一致、步骤编辑器 2 步、observed 选择器含前缀
场景、再运行 1→2、count=99 本地拒绝且台账不变；`[data-trace-import-status]` 导入成功 + imported label/
limitations + undo 禁用原因 + 二次导入幂等；`[data-code-view="sequence-scenario"]` 多场景切换（imported
`[data-sequence-imported="true"]`、消息含 bus_send(1,48)/DOORBELL/WRITE/返回 0、Selection 跟随）。
`view.status`：`scenario_undo=true`、`trace_import=true`，gaps 仅 `ai_summary`、`real_device_dispatch`。
另：引擎 `Ran 298 tests, OK`、Node `152/152`。证据见 `evidence/s3b/`（`verification.json`、
`s3b-undo.png`/`s3b-imported.png`/`s3b-observed-scenario.png`/`s3b-main.png`、S3a/S2a/S2b/S1 回归截图、
`host-runtime.json/tap`、`commands.log`、README）。已知限制：observed 默认最近台账（可切换但无持久化）；
undo 仅对可重放模拟台账；导入轨迹只读；异步/IRQ 因果与真实设备仍未提供。