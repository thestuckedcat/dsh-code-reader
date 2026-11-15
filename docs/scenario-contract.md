# 04 受控场景契约（CL-VIEW-T3 / 阶段 S3a）

`CL-VIEW-T3-CONTRACT` · 2026-11-15 · 本文件固定受控场景执行、边界打桩、运行台账与「时序观测」模式的首个切片
（S3a）的读模型、执行隔离边界、Host 编排、UI 与 dsh-web 验收方式。产品语义依据
[交互式代码工作台软件设计](interactive-code-view-software-design.md) §7、CW-08/CW-09 与验收 A08/A09；
实现/验收依据本文件。S3a 之后（S3b）再做回退末尾 N 次/前缀重放、轨迹导入与异步事件细化。

## 0. 阶段范围

S3a 做：**已登记 Wasm 模拟 profile → 用户触发的有序接口调用 → 隔离执行 → 运行台账 → 时序观测**，
包括边界打桩（stub-control 接口随场景步骤执行并标记）、失败传播、`observed` 证据分级。Demo 的
`bus.c`/`platform.c` Wasm 构建产物作为唯一模拟 profile（来源见 §2）。

S3a 不做（UI 以 gap 显示）：回退末尾 N 次与前缀重放、轨迹导入、异步/IRQ 因果细化、真实设备下发、
图内源码写回、编译器/沙箱内构建。真实 Linux/Kbuild 与设备行为仍按 CW-T4 单独验收。

## 1. 信任与隔离边界

- **profile 是可信输入**：由人工/Host 放入 bootstrap `import_inbox_dir` 的 JSON + Wasm 文件；Agent/浏览器
  不能指定路径、模块 URL 或任意接口。引擎校验 Wasm sha256、大小与 envelope 后复制到 `state/sim/` 只读区，
  并签名登记；运行只使用 state 内副本。
- **执行只发生在 Host 的隔离 worker**：Node `worker_threads`，模块字节由父进程从引擎
  `scenario-module` 取得后传入，worker 不读文件系统、不联网、无其他 import；`env.trace` 是唯一宿主回调。
  worker 资源限制（内存 ≤64 MB）与总超时（默认 10 s，≤30 s）；取消/超时返回 `OUTCOME_UNKNOWN`，未落台账。
- **用户触发**：S3a 只有工作台「打桩模拟」面板的「运行」按钮触发执行；新增 Host RPC 仅接受
  `workspace/snapshot/profile/scenario` 结构，不接受路径/argv/模块；模型-facing tool 本轮不新增执行入口。
- **台账只追加、带签名与代次**：每代 `generation-<n>.json` 不可变，`current.json` 指向当前代；记录
  `plan_id`、`module_sha256`、`scenario_digest`、`records_digest`（records 规范化哈希）与 memory digest。
- **证据分级**：运行记录标 `observed`；静态图/树/时序预测仍标 `exact/may/unknown`，不得混写。

## 2. 模拟 profile（可信 inbox）

`sim-profile.json`（同目录放 `module.file` 指向的 `.wasm`）：

```jsonc
{"schema_version":1,"profile_id":"bus-demo-wasm","label":"Demo bus/platform Wasm 隔离模拟",
 "kind":"wasm32",
 "binding":{"workspace_id":"code-view-bus-demo","variant_id":"semantic-x86_64","repo_id":"bus",
            "snapshot_id":"ed326d554334432b907de21297207eb8"},
 "module":{"file":"bus.wasm","sha256":"<64hex>"},
 "interfaces":[
   {"name":"reset","params":[],"returns":"void","role":"util"},
   {"name":"bus_register","params":[{"name":"channel","type":"u32","min":0,"max":3}],
    "returns":"i32","role":"entry","entry_id":"f_…"},
   {"name":"set_platform_stub","params":[{"name":"return_code","type":"i32","min":-4095,"max":0}],
    "returns":"void","role":"stub_control"}
 ],
 "trace":{"import":{"module":"env","field":"trace"},"signature":["i32","i32","i32","i32","i32"],
          "events":{"1":"DEFAULT_ROUTE","…":"…"}},
 "event_resources":{"STORE_ROUTE":[{"resource_id":"s_…","name":"routes","access":"write","field":"lane/max_len"}],
                    "WRITE":[{"resource_id":"s_…","name":"simulated_doorbell","access":"write"}]},
 "limitations":["Wasm 模拟器为 Demo 构建产物，不证明真实设备/内核行为；不联网、不写源码"]}
```

规则：`profile_id` `^[a-z0-9][a-z0-9._-]{0,63}$`；interface ≤32，`params` ≤8，`type ∈ u32|i32`，`returns ∈
i32|void`，`role ∈ entry|stub_control|util`；`params.min/max` 必须含 `type` 的合法整数范围；events ≤64、
值为大写标识符；`event_resources` 只引用该 profile 绑定快照中的对象 id（不得伪造）。profile 绑定
workspace/variant/repo 必须已登记，`snapshot_id` 必须已导入且与 repo 匹配。

## 3. 引擎 CLI / DTO（S3a）

| 命令 | 参数 | 说明 |
|---|---|---|
| `sim-profile-import` | `--workspace --variant --repo --profile <inbox文件名> --operation-id` | 校验/复制 Wasm、签名登记；返回 profile 投影（无绝对路径） |
| `sim-profile-list` | `--workspace` | profile 列表：含 `interfaces`（完整接口列表，供 UI 步骤编辑器：name/params/returns/role/entry_id）、binding、module sha/bytes、limits、受限标记/局限；不输出绝对路径 |
| `scenario-plan` | `--workspace --snapshot --profile P --scenario-json <base64> [--expected-generation N]` | 校验场景并签发 plan（TTL 600s），不执行 |
| `scenario-module` | `--plan <plan_id>` | 返回 `{module_b64, module_sha256, profile 投影, trace, event_resources}`（仅给 Host worker 用） |
| `scenario-record` | `--plan <plan_id> --records-json <base64> --operation-id` | 校验记录与 plan 对齐、代次 CAS，追加不可变 generation |
| `scenario-list` | `--workspace` | 台账摘要（scenario_id/profile/current generation/step 数/时间/records_digest） |
| `scenario-get` | `--workspace --scenario S` | 当前代完整记录投影 |
| `view-sequence-observed` | `--workspace --scenario S` | 由台账生成 observed 时序 DTO（§6） |

场景定义（浏览器提交，Host 校验后交给引擎）：
```jsonc
{"generation":0,"stop_on_error":true,
 "steps":[{"interface":"reset","args":[]},
          {"interface":"bus_register","args":[1]},
          {"interface":"set_platform_stub","args":[-5]},
          {"interface":"bus_send","args":[1,48]}]}
```
校验：steps ≤20；interface 必须属于 profile；args 个数/类型/范围严格匹配；`generation` = 当前代次
（CAS）；总参数字节 ≤4 KiB；`scenario-json`/`records-json` base64 解码后分别 ≤8 KiB / ≤32 KiB（超出
`LIMIT_EXCEEDED`；更大轨迹走 S3b `trace-import`）。

Plan 投影：`{schema_version:1, plan_id, profile_id, module_sha256, scenario_id, scenario_digest, generation,
steps:[{index,interface,role,args}], trace:{…}, limits:{timeout_ms,steps,events_per_step}, expires_at,
limitations}`。

运行记录（Host worker → `scenario-record`）：
```jsonc
{"records":[{"step_index":0,"interface":"bus_send","args":[1,48],
             "status":"ok|error","result":0,"memory_digest":"<64hex>","elapsed_ms":1,
             "events":[{"event":"DOORBELL","code":19,"a":4160,"b":131120,"c":0,"line":113}]}]}
```
`scenario-record` 校验：records 数 = plan steps 数且 interface/args 逐项一致；status ∈ ok|error；
result 为 32 位整数或 null；events ≤256/step、`event` 必须在 profile events 内、四字段为 32 位整数带符号
语义；memory_digest 64hex；拒绝任何额外字段。通过后写入：
```jsonc
{"schema_version":1,"scenario_id":"scn_<digest12>","generation":1,"profile_id":"bus-demo-wasm",
 "workspace_id":"…","snapshot_id":"…","variant_id":"…","repo_id":"…",
 "scenario_digest":"…","records_digest":"…","observed":true,
 "created_at":"2026-11-15T…Z",
 "records":[{"call_id":"call_1_1","step_index":0,"interface":"bus_send","args":[1,48],
             "status":"ok","result":0,"memory_digest":"<64hex>",
             "affected_resources":[{"resource_id":"s_…","name":"simulated_doorbell","access":"write"}],
             "stubbed":false,
             "execution_events":[{"event_id":"ev_1_0_0","event":"DOORBELL","code":19,
                                  "a":4160,"b":131120,"c":0,"line":113}]}],
 "limitations":["wasm_simulation_not_real_device"]}
```
`affected_resources` 由 profile `event_resources` + 本步 events 推导；`stubbed` = 该步 interface role 为
`stub_control`。`scenario_id` 由 scenario_digest 确定性生成；同一场景重复运行 generation+1。

## 4. Host 编排与端点

新增 `lib/sim-runner.mjs` + `lib/sim-worker.mjs` + `lib/scenario-service.mjs`：

| endpoint | 输入 | 行为 |
|---|---|---|
| `scenario.listProfiles` | `{workspace}` | 引擎 `sim-profile-list` |
| `scenario.list` | `{workspace}` | 引擎 `scenario-list` |
| `scenario.get` | `{workspace, scenario}` | 引擎 `scenario-get` |
| `scenario.preview` | `{workspace, snapshot, profile, scenario}` | 引擎 `scenario-plan`，返回 plan 投影（不执行） |
| `scenario.run` | `{workspace, snapshot, profile, scenario, expected_generation}` | plan → module → worker 执行 → record → 当前代投影；总超时 15 s；用户按钮触发 |
| `view.sequence` | `{workspace, snapshot, entry?, mode:'static'|'observed', scenario?}` | static 沿用 S2a；observed 需 scenario，映射引擎 `view-sequence-observed` |

`scenario.run` 执行顺序：引擎 `scenario-plan`（带 expected_generation）→ 引擎 `scenario-module` →
worker（隔离）→ 引擎 `scenario-record`（operation_id 由 Host 生成，幂等）。任一步失败：
- 引擎校验失败：`scenario.run` 返回 `{ok:true,value:<engine error doc>}`（UI 显示 code/message）；
- worker 超时/取消/崩溃：返回 `{ok:false,error:{code:'OUTCOME_UNKNOWN',message:…,details:{}}}`，不落台账；
- 记录校验失败：engine error doc 原样返回，不落台账。

Host 校验：workspace/snapshot/profile 既有规则；scenario 结构（steps 数组、每步 interface 字符串 ≤64、
args 整数数组 ≤8、总长 ≤4 KiB）；`expected_generation` 整数 ≥0；`mode` 枚举；不接受路径/模块/任意 URL。
worker 限：总超时 15 s（父进程计时 + terminate）、`resourceLimits.maxOldGenerationSizeMb=64`；
`trace` 回调只在 worker 内累积，父进程不接触 wasm 内存。

S3a 落地后 `view.status` 语义：`capabilities` 增加 `scenario_execution:true`、`run_observation:true`、
`scenario_undo:false`、`trace_import:false`、`real_device_dispatch:false`；`gaps` 移除
scenario_execution/run_observation，保留/新增 `ai_summary`、`scenario_undo`（回退/重放 S3b）、
`trace_import`（S3b）、`real_device_dispatch`（需单独授权与运行验证）。

## 5. 客户端「打桩模拟」与观测时序（CW-08/§3.5）

- 左栏 `[data-rail="stub"]` 从占位升级为可用面板容器 `[data-code-view="stub-panel"][data-busy]`
  （不另设 `data-stub-panel` 属性）：
  - profile 选择 `[data-stub-profile]`（显示 label/binding/模块 sha 前缀/interfaces 数量/limits）；未导入
    profile 时显示 `[data-stub-gap]` 与导入说明；
  - 步骤编辑器 `[data-stub-editor]`：`[data-stub-step][data-step-index]`，接口下拉
    `[data-step-interface="<stepIndex>"]`（按 role 分组 entry/stub_control/util）、数字参数
    `[data-step-arg="<stepIndex>:<paramIndex>"]`（min/max）、`[data-step-move-up]`/`[data-step-move-down]`/
    `[data-step-remove]`、`[data-stub-add-step]`（≤20）；`[data-stub-stop-on-error]`（默认开）；
  - `[data-stub-run]`（用户点击才执行）、`[data-stub-plan]`、`[data-stub-generation]`、运行中 `[data-busy]`；
  - 边界打桩：role=stub_control 的步骤高亮为「边界打桩」；记录 `[data-stub-record][data-call-id][data-status]`
    `[data-result]`（void 不写该属性并显示“结果 —”）`[data-stub-step-index]`、`[data-stubbed="true"]`；
    事件 `[data-stub-event][data-event-kind]`（`title` 含 code/a/b/c/line）、受影响资源
    `[data-stub-affect][data-resource-id][data-access]`、memory digest（DOM 文本保留完整 64hex，可视觉截断）；
    `[data-stub-error][data-error-code]`；
  - `[data-stub-undo]` 禁用 + `[data-stub-undo-gap]` 文案（S3b 提供回退/重放）；`[data-stub-gap]` 显示
    未导入 profile/真实设备未授权（含插件内不启用编译器/构建）/超时 unknown 等实际缺口；
- 时序视图 `[data-code-view="sequence-mode"]` + `[data-sequence-mode="static|observed"]`：observed 调用
  `view.sequence {mode:'observed',scenario}` 渲染 `[data-sequence-observed="true"]`、
  `[data-sequence-message][data-message-kind][data-observed="true"]`、`[data-scenario-id]`、代次/digest；
  无台账时 observed 不可选 + `[data-sequence-gap]`；静态预测保持 `[data-sequence-warning]` + observed=false。
  S3a 的 observed 默认展示最近更新的台账（多场景选择器留待 S3b）。
- Selection 追加 `scenario_id`、`run_generation`、`call_id`（均可 null，旧字段不变）。
- 静态图/树/资源视图不因运行改变；运行只在台账与时序/记录中体现（selected 记录可联动到调用点源码）。

## 6. `view-sequence-observed` DTO

```jsonc
{"schema_version":1,"mode":"observed","observed":true,
 "scenario":{"scenario_id":"scn_…","generation":1,"profile_id":"bus-demo-wasm",
             "workspace_id":"…","snapshot_id":"…","records_digest":"…","created_at":"…"},
 "participants":[{"participant_id":"caller","label":"调用方"},
                 {"participant_id":"driver","label":"驱动"},
                 {"participant_id":"resource","label":"驱动资源"},
                 {"participant_id":"platform","label":"平台/设备边界"}],
 "messages":[{"message_id":"m_1","index":1,"kind":"call|return|event|access|error",
              "from":"caller","to":"driver","label":"bus_send(1, 48)","call_id":"call_1_1",
              "step_index":0,"status":"ok","result":0,
              "observed":true,"event":"DOORBELL","code":19,
              "affected_resources":[{"resource_id":"s_…","name":"simulated_doorbell","access":"write"}],
              "source_ref":{"function_id":"f_…","file":"bus.c","line":152},"limitations":[]}],
 "warning":null,
 "gaps":[],"truncated":false,
 "limitations":["observed_wasm_simulation_not_real_device"]}
```
消息序 = 台账 steps 顺序：call → 该步 events（access/event，含平台写边界）→ return；`kind=error` 当 status=error
或 result<0；参与者由 profile interfaces 的 role/entry 与 event_resources 分类（stub_control 步为 caller→driver
的 `stub` 消息，from=caller）。`warning=null` 表示有运行观测；无台账时引擎返回 `NOT_FOUND`。

## 7. dsh-web S3a 验收（`node tools/verify-s3.mjs --with-repo-tests`）

在隔离 profile 的**真实 dsh web** 中，使用 Demo Wasm profile（`evidence/scenario-sim/inbox/sim-profile.json`
+ `bus.wasm` 由隔离 inbox 导入）：
1. 打开工作台 → 打桩模拟 rail → 选择 profile → 步骤编辑器可见，接口下拉含 `bus_send`/`set_platform_stub`。
2. 组成 `reset`、`bus_register(1)`、`bus_send(1,48)` 三步 → 点击「运行」→ records 3 条：结果 0/0/0；
   事件含 `DEFAULT_ROUTE`、`STORE_ROUTE`、`REQUEST`、`LOOKUP`、`CHECK_LENGTH`、`TRANSFER`、`DIRECT`、
   `ENCODE`、`DOORBELL`、`WRITE`；`WRITE` 受影响资源 `simulated_doorbell`；memory digest 64hex。
3. 边界打桩：加一步 `set_platform_stub(-5)` 后再 `bus_send(1,48)` → 结果 `-5`，`WRITE` 缺失，
   `LOCK` 事件 1→0 可见，stub 步 `data-stubbed="true"`。
4. 失败传播：`bus_send(0,48)`（未登记）→ `-2` 且记录 status/结果正确；非法实参（如超 min/max）由 UI/引擎拒绝
   显示错误码，不产生台账。
5. 时序观测：切「运行观测」→ `[data-sequence-observed="true"]`，消息含 `bus_send(1, 48)`、`WRITE`/`DOORBELL`、
   平台边界、返回 0；切回静态预测仍为 observed=false。
6. 回退按钮禁用且 gap 文本存在；真实设备/编译器/轨迹导入 gap 原样显示。
7. console error=0、无绝对路径；截图 `evidence/s3/{stub-run,stub-stub,sequence-observed}.png` + main.png；
   证据 `evidence/s3/verification.json`（layers/checks/in_scope/out_of_scope not_verified）。
8. 回归：S2a/S2b/S1 探针全部通过；旧 6 工具与 Cordis 挂载/卸载/二次挂载通过；Demo 8/8；仓库 Node/Python 全绿。

## 8. dsh-web 之外的分层验证

- 引擎：`engine/tests/test_scenario.py`（profile 导入/哈希篡改/绑定错/场景校验/plan 签名 TTL/records 对齐/
  代次 CAS/幂等/台账不可变/observed 时序/无绝对路径/预算截断）。
- Host：`tests/node/scenario.test.mjs`（端点校验/编排顺序/超时 OUTCOME_UNKNOWN/不落台账/错误映射）+
  `tests/node/sim-runner.test.mjs`（真实 wasm 隔离执行：reset/register/send、stub 失败、非法接口拒绝、
  超时终止、内存限制、无 fs/网络）。
- 真实 Cordis：`tools/s3-host-runtime.test.mjs`（挂载→scenario.run 真实 wasm 执行→台账→dispose→二次挂载）。

## 9. 文件所有权（S3a）

| 负责人 | 写入范围 |
|---|---|
| Lead | `docs/`、`source.lock.json`、`evidence/scenario-sim/`（profile/Wasm 夹具）、最终集成/提交 |
| engine | `engine/code_learning/scenario.py`（新）、`cli.py`、`engine/tests/test_scenario.py`、`engine/schemas/`（如需） |
| host | `lib/sim-runner.mjs`、`lib/sim-worker.mjs`、`lib/scenario-service.mjs`、`index.js`、`lib/view-service.mjs`（view.sequence observed）、`tests/node/scenario.test.mjs`、`tests/node/sim-runner.test.mjs`、`tests/node/view-rpc.test.mjs` |
| client | `bundle/client.js`、`tests/node/client.test.mjs`、`tests/node/helpers/client-harness.mjs` |
| verifier | `tools/verify-s3.mjs`、`tools/s3-probe.cjs`、`tools/s3-host-runtime.test.mjs`、`evidence/s3/` |

跨范围修改先经 Lead；不 git 提交；不联网；不改真实 `~/.dsh`；不重启桌面宿主；不在插件内运行编译器/构建。

## 10. 本轮验收结果（2026-11-15，S3a）

`node tools/verify-s3.mjs --with-repo-tests`：`ok=true, verified=true`，**43/43 检查通过**，
`in_scope_not_verified=[]`；`out_of_scope_not_verified` 5 类（S3b 回退/重放/轨迹导入、AI 归纳正文、
observed 异步/IRQ 与真实设备、S4 Linux/CFG/性能、OS 出口）。分层：`demo_observed` Demo 8/8、
`atlas_snapshot` 隔离 inbox 真实 `sim-profile-import` + `scenario-plan/module` + ledger/observed 真实 Python、
`dsh_host` pinned rc.5 隔离 dsh-web（boot graph/bundle 前缀/401 准入/`scenario.*`+`view.*` RPC/Chromium
打桩面板+台账+stub 失败+observed/Cordis scenario.run→dispose→二次挂载）。

关键 dsh-web 证据：步骤编辑器（interfaces 7、bus_send/set_platform_stub role 分组、参数 min/max）；
A happy 场景 3 条记录结果 **—/0/0**、status ok、call_id、64hex memory digest、事件含 DEFAULT_ROUTE/
STORE_ROUTE/REQUEST/LOOKUP/CHECK_LENGTH/LOCK/TRANSFER/DIRECT/COMMIT/ENCODE/DOORBELL/LIBRARY/WRITE/LOCK，
affects 含 simulated_doorbell(write)；同场景再运行代次 1→2。B stub `set_platform_stub(-5)` →
`[data-stubbed="true"]`/result —，bus_send **status error / -5**、该记录无 WRITE、LOCK a=1→0。
C 未登记 channel → -2；非法参数 `INVALID_ARGUMENT` 且台账不增。observed 20 条消息（call/return/access/event）
含 bus_send(1, 48)→0、DOORBELL/WRITE、平台边界；切回 static observed=false。undo/trace_import/
real_device_dispatch gaps 原样；console error=0、无绝对路径。另：engine `Ran 289 tests, OK`、Node `136/136`。
证据见 `evidence/s3/`（`verification.json`、`s3-stub-run.png`/`s3-stub-stub.png`/`s3-sequence-observed.png`/
`s3-main.png`、S1/S2a/S2b 回归截图、`host-runtime.json/tap`、`commands.log`、引擎/Node 测试日志、README）。
已知交互限制（S3b 候选）：observed 默认最近更新台账、无多场景选择器；跨场景后重跑旧场景可能 CAS 冲突。

## 11. 增量：异步/IRQ 事件边界（2026-11-15，S4-prep 收尾）

设计依据：设计 A08/§3“异步完成单独显示事件触发”。Demo 的 `bus_irq` 入口会触发平台 IRQ 事件；当前
observed 时序把 IRQ 当普通 event，无法看出它是异步完成/中断触发。本增量给事件增加**异步边界标记**，
不改静态投影、不改台账记录语义（记录仍只包含顺序与事件本身）。

### 11.1 Profile / 导入轨迹的异步事件声明

- SimProfileV1 新增可选顶层字段 `async_events`：事件名数组（≤16，去重，每个必须是 `trace.events` 中的
  事件名）；缺省为空 = 无异步事件。profile 签名/摘要覆盖该字段（重导入产生新 digest）。
- 导入轨迹（`trace-import`）文件新增可选顶层字段 `async_events`：≤16 事件名，必须属于该轨迹 steps 的
  events；缺省为空。导入台账 `limitations` 增加 `async_events_declared`（当有声明时）。
- Demo 夹具 `evidence/scenario-sim/inbox/sim-profile.json` 声明 `["IRQ"]`（rev2）；历史 S3a/S3b 证据使用
  rev1（sha 记录在各自 verification.json），本轮异步证据使用 rev2，README 记版本差异。
- 校验：非法（非数组/超 16/重复/未知事件/非字符串）→ `INVALID_ARGUMENT`；无绝对路径。

### 11.2 observed 时序 DTO 与 UI

- `view-sequence-observed`：当台账有异步事件声明时，对应 event 消息增加 `"async":true`（其余消息
  `async:false` 或不含；契约以 `async:true` 为准），并在顶层 `async_events` 返回声明列表（≤16，供图例）。
  call/access/return 消息不受影响；无声明时行为与 S3b 完全一致。
- 客户端 observed 时序：异步事件消息加 `[data-sequence-async="true"]` 标记与“异步”chip（样式区分，
  不改变消息顺序/观察语义）；图例/头部说明“异步：由中断/完成事件触发，仍来自已执行或导入的台账”；
  静态预测模式不显示 async 标记。
- 不推断“因果完成”与否：`async:true` 只表示该事件在 profile 中被声明为异步触发，不表示硬件中断已发生。

### 11.3 验收（`node tools/verify-irq.mjs --with-repo-tests`）

隔离 profile + 真实 dsh web：
1) 用 rev2 profile 运行包含 `bus_irq` 的场景（reset, bus_register(1), bus_irq）→ 台账成功、observed 返回
   IRQ 事件 `async:true`（若 bus_irq 不产生事件则如实记录该 Demo 行为并改为构造导入轨迹验证）；
2) dsh-web observed 视图出现 `[data-sequence-async="true"]`（IRQ 消息）与“异步”chip；
3) 无 async 声明的导入轨迹（rev1 trace）observed 不出现 async 标记（旧行为不变）；
4) 非法 `async_events`（重复/未知/超 16）被引擎拒绝且不写台账；无绝对路径、console=0；
5) 证据 `evidence/async-irq/{verification.json,README.md,async-irq.png}`；回归 S3b/S3a/S2b/summary + Node/
   Demo。

### 11.4 文件所有权

| 负责人 | 写入范围 |
|---|---|
| engine | `engine/code_learning/scenario.py`、`cli.py`、`engine/tests/test_scenario.py`（async_events 校验/observed 标记/导入轨迹） |
| client | `bundle/client.js`、`tests/node/client.test.mjs`、`tests/node/helpers/client-harness.mjs` |
| verifier | `tools/verify-irq.mjs`、`tools/irq-probe.cjs`、`evidence/async-irq/` |
| Lead | 夹具 rev2、`docs/scenario-contract.md`、`source.lock.json`、集成/提交 |

### 11.5 验收结果（2026-11-15，T41 最终）

`node tools/verify-irq.mjs --with-repo-tests` → **34/34 全绿**，layers 全 true，`ok=true, verified=true`；
`in_scope_not_verified=0`、out_of_scope 5。真实 Wasm 路径（无需 fallback）：rev2 profile（sha256
`1c9ae155…`）真实导入 → `reset → bus_register(1) → bus_irq()` 台账 records `[null,0,0]`，bus_irq 真实产生
`IRQ` 事件（observed `async_events:["IRQ"]`、IRQ 消息 `async:true`，无绝对路径）；真实 dsh web observed 出现
`[data-sequence-async="true"]`（IRQ 消息 `IRQ: write irq_count`）+ `[data-sequence-async-chip]`“异步”+
`[data-sequence-async-note]` 说明；static 模式与 rev1 导入台账无 async 标记（旧行为不变）；非法 async_events
（重复/未知/超16/非数组）对 `sim-profile-import` 与 `trace-import` 均 `INVALID_ARGUMENT` 且不写台账；
console=0。另验证带 `async_events` 的导入轨迹路径（`async_events_declared`）。回归 S3b/S3a（residual=[]）/
S2b/summary + Node `195/195` + Demo 8/8 全绿。证据 `evidence/async-irq/`（`verification.json`、
`async-irq.png`、`README.md`、`commands.log`）。out_of_scope：真实硬件 IRQ 因果/中断完成判定、真实设备与外部
轨迹采集、跨进程异步调度证明、rev1 历史证据重跑、超大 payload async 变体；`async:true` 只表示声明为异步触发，
不推断中断已发生。