# dsh-code-reader 使用说明

版本 0.1.0（`CL-IMPL-1` 2026-11-07；只读代码工作台切片 2026-11-15）。本文件面向使用者与后续 skill 维护者：怎样安装、怎样登记 workspace、六个工具怎么用、代码工作台怎么打开、返回的 JSON 怎么读、哪些边界不允许越过。

设计背景：[软件设计](docs/software-design.md)、[实施契约](docs/implementation-contract.md)、[只读工作台契约](docs/readonly-workbench-contract.md)、[机制说明](docs/mechanisms.md)。

## 1. 前置条件

| 依赖 | 要求 | 说明 |
|---|---|---|
| DSH Harness | 当前 desktop profile 同版本 Host API（`ctx.tools` / `ctx.skills`） | 通过 `plugin_manager install_bundle` 安装本地 bundle |
| Python | 3.11+（`python3` 或 `python` 在 PATH，或配置 `pythonPath`） | 本版不 vendor 固定解释器；引擎只用标准库 |
| 数据 | 一个本地 workspace 根目录 + 可选 Atlas 0.1 快照 | 合成 fixture 见 `engine/tests/helpers.py` |

## 2. 首次安装

### 2.1 创建可信 bootstrap（人工执行，只做一次）

模型/工具 **不能** 创建或改写 bootstrap；这是人工授权的读取根表。在仓库 `engine/` 目录执行：

```bash
python -m code_learning.cli bootstrap-init \
  --out  ~/.dsh/code-reader/bootstrap.json \
  --state-dir ~/.dsh/code-reader/state \
  --import-inbox ~/.dsh/code-reader/inbox \
  --root dev=/path/to/your/repositories \
  --profile-ref desktop --scope-ref local --scope-generation 1
```

- `--root NAME=PATH` 可重复；之后 workspace manifest 只能用这些 `root_ref` 下的相对路径。
- `state-dir` 保存 sign key、workspace 登记、快照只读副本、学习记录与导出；不写源码仓库。
- `import-inbox` 是人工/外部工具放入 `workspace.json`、`<snapshot>/` 目录的地方；Agent 工具只能按文件名读取它，不能指定任意路径。
- 已有 bootstrap 不会被覆盖（`STATE_CONFLICT`）；确需重建请人工删除后重跑。

### 2.2 安装 bundle

在 DSH 内由 `plugin_manager` 安装本仓库目录（本地目录以链接方式安装）：

```
plugin_manager action=install_bundle target=<绝对路径>/04-code-learning
```

安装后检查（无需浏览器）：

- `cordis_inspect_query` Host `Tool.listTools` 中出现 `code_workspace`、`code_overview`、`code_source`、`code_snapshot`、`code_path`、`code_learn`；
- Host `Service`（skills）目录中出现 `learn-code-workspace`（来源 `custom`，provider `dsh-code-reader`）。

插件配置项（`cordis.patch.yml` 行的 `config`，全部可选）：

```yaml
- id: dsh-code-reader
  name: '@local/dsh-code-reader'
  config:
    bootstrapPath: 'C:/Users/you/.dsh/code-reader/bootstrap.json'  # 默认 CODE_READER_BOOTSTRAP 或 $DSH_HOME/code-reader/bootstrap.json
    pythonPath: 'C:/Python311/python.exe'                          # 默认 DSH_CODE_READER_PYTHON / python3 / python
    timeoutMs: 120000                                              # 1000..600000
```

## 3. 工具总览

六个工具都返回同一种外层 JSON：

```json
{"schema_version": 1, "ok": true, "exit_code": 0, "cli": { /* 引擎结果或公共错误对象 */ }}
```

- `ok=false` 且 `exit_code=2`：输入/scope/能力边界阻断（例如未登记、证据过期、缺少构建能力）；`cli.error.code` 给出稳定错误码。
- `exit_code=3`：执行失败；`exit_code=4`：结果未知（超时/取消，不能当成功）。
- 工具调用本身抛错只发生在参数非法、Python 缺失或输出不可解析等宿主侧问题。

### 3.1 `code_workspace` — 登记/校验/状态

| 参数 | 说明 |
|---|---|
| `action` | `import` \| `validate` \| `status` |
| `workspace` | 已登记 workspace_id（status 必需；validate 可省，仅有一个登记时自动选中） |
| `manifest` | import 用：inbox 内 manifest 文件名 |
| `expected_revision` | import 用：0 表示首次登记；已登记则传当前 revision |
| `operation_id` | 幂等 ID；省略时插件自动生成 UUID |

```json
// action=import 的 cli 结果（节选）
{"schema_version":1,"workspace_id":"synthetic-linux-ioctl","workspace_revision":1,
 "scope_ref":"local","manifest_digest":"…","variants":[{"variant_id":"source-only-x86_64",
 "analysis_mode":"source_only","semantic_status":"blocked","missing_inputs":["compiler_build_context"]}],
 "semantic_status_by_variant":{"source-only-x86_64":"blocked"},"missing_inputs":[],"freshness":"fresh"}
```

`workspace-validate` 不执行 probe；`semantic_status=blocked` 只代表缺编译输入，仍可 source-only 阅读。

### 3.2 `code_overview` — 先看小地图

参数：`workspace`、`variant`（必填）、`snapshot`（可选）、`max_components`（1..100，默认 20）。

返回 `components[]`（`origin=declared`，只表示 manifest 声明）、`interface_candidates[]`（binding 端点等，`certainty=may`）、`unknown_boundaries[]`、`truncated`。文件夹名/README/人工角色不是编译依赖。

### 3.3 `code_source` — 源码证据

| action | 参数 | 说明 |
|---|---|---|
| `find` | `workspace`、`repo`、`relative_glob` + 恰好一个 `literal`/`filename`，可选 `cursor` | 字面文本或文件名查找；预算 128 文件/32 MiB/200 命中；`next_cursor` 可续页；源码变化后游标 `STALE_SOURCE` |
| `read` | `workspace`、`path_ref`、`expected_sha256`、`byte_start`、`byte_end` | 区间 ≤16 KiB；核 hash 与签名；UTF-8 边界安全调整；二进制/疑似秘密返回 `ref_only` |
| `evidence` | `workspace`、`evidence_ref`，可选 `max_bytes` | 重读之前签发的证据；文件变化/丢失报 `STALE_SOURCE`/`NOT_FOUND` |

find 返回示例（节选）：

```json
{"schema_version":1,
 "matches":[{"path_ref":"v1.…","evidence_ref":"v1.…","source_sha256":"…",
             "byte_start":0,"byte_end":142,"line_start":1,"line_end":10,
             "safe_preview":"int job_submit(int fd, …)"}],
 "next_cursor":null,"scanned_files":3,"scanned_bytes":2231,"truncated":false,
 "semantic_status":"blocked","limitations":["text_only_not_compiler_fact"]}
```

文本证据只证明“这段文本存在”；不产生 exact 调用/锁/布局事实，也不能证明运行时行为。

### 3.4 `code_snapshot` — Atlas 0.1 快照

| action | 参数 | 说明 |
|---|---|---|
| `import` | `workspace`、`variant`、`repo`、`snapshot`（inbox 内目录名）、`operation_id` | 校验 envelope schema、manifest 必填字段、`payload.graph_hash == sha256(graph.json 原始字节)`、`workspace_roots` 至少一个条目指回**本次导入的目标 repo**；复制只读副本到 state |
| `status` | `workspace`、`snapshot_ref` | 返回 SnapshotEvidence：coverage（failed 数组、pending_units 路径数组原样保留）、capabilities、freshness、limitations |

导入不会运行 Atlas/CMake/编译器；`freshness` 在 workspace revision 或源清单摘要变化后为 `stale`，文件缺失为 `unknown`。`workspace_roots` 必须包含本次导入的目标 repo（同 workspace 其它 repo 不算），否则拒绝导入（独立验证 N1 修复），避免把别的仓库快照的 exact 边记到本仓；多根 Atlas 快照可在每个根对应的 repo 下分别导入。

### 3.5 `code_path` — 证据路径与关系

**path**：`workspace`、`variant`、`from`、`to`（函数 ref，如 `kmd:job_dispatch`），可选 `budget`（1..10000，默认 2000）、`max_depth`（1..100，默认 30）、`direction=down|up`。

返回 `nodes[]`、`edges[]`（来自 `call_targets`，带 `callsite/origin/certainty/evidence_ids`）、`unresolved[]`、`choices[]`、`coverage`、`truncated`、`freshness`。同 repo 内为有界 BFS；跨 repo 端点只在 `supported` 的跨仓 binding 上产生 `abi_bridge, certainty=may`，`incomplete/conflicting/stale` 只给 unresolved。

**relation**：`workspace`、`snapshot_ref`、`mode ∈ flow_legacy|flow_cfg|locks|aliases`，selector 按模式互斥。缺少对应分析能力时返回 `status=unavailable` 与 `unknowns`；空结果不代表“无竞争/无别名”。

### 3.6 `code_learn` — 版本化学习记录

| action | 参数 | 说明 |
|---|---|---|
| `save` | `workspace`、`input`（inbox 内记录草稿文件名）、`expected_generation`（新记录 0）、`operation_id` | CAS 写入不可变 revision；相同 operation+请求幂等，不同摘要 `OPERATION_CONFLICT` |
| `get` | `workspace`、`record` | 当前 revision |
| `resume` | `workspace`、`record` | 重核 workspace/build/证据；返回 `freshness`、`changed_inputs[]`、`required_rechecks[]`、`safe_cursor` |
| `export` | `workspace`、`record`、`format=markdown|json` | 只导出到本地 state/exports，不上传 |

硬规则：没有用户输入时 `prediction.status=pending`；`observation.status=observed` 必须同时有非空证据与 `experiment.status=executed`；Agent 解释不得写成用户已复述；`next_action` 至多一条；`DONE-APPLIED` 需实际证据。

保存时的额外校验（2026-11-07 独立验证修复）：

- 本版没有 execution backend，`experiment.status=executed` 必须指向本地 `runs` 账本中的真实运行，当前不存在 → 直接 `CAPABILITY_UNAVAILABLE`；因此 `observation.observed` 与 `DONE-APPLIED` 不可能靠伪造 `run_ref` 落盘。
- `experiment.status=planned` 的 `plan_ref` 必须是本地签名 plan（`SCOPE_DENIED` 否则）。
- 草稿引用的每条 source evidence 会在保存时重核签名/文件/byte 区间；伪造或已过期的引用不会以 `fresh` 保存，记录 freshness 会降为 `stale`/`unknown` 并写 `invalidation_reasons`。
- **残余信任边界**：`prediction.status=user_provided` 与 `mental_model.author=user` 是“对话来源”声明，引擎只能校验结构与时间戳，无法密码学认证“确实由用户说出”。Agent 必须遵守 skill 的“不得代填”规则；不要把该字段当作已验证事实。

## 4. 一次典型对话

1. 用户："帮我读懂 UMD 的 ioctl 提交到 KMD 队列完成通知。"
2. Agent 调 `code_workspace action=validate`，确认 variant/semantic_status。
3. `code_overview` 给出三仓职责与接口候选。
4. `code_source find` 找 `JOB_IOCTL_SUBMIT` → `read` 读带行号片段 → 解释。
5. 若已有快照：`code_snapshot import` → `code_path path from=umd:job_submit to=kmd:job_complete`，讲清 exact/may/unknown。
6. 用户要验证时先请用户给预测；记录用 `code_learn save`，预测保持 pending。
7. 暂停后源码/CONFIG 变了：`code_learn resume` 返回 stale 与 safe_cursor，先重核再续读；旧行号不能当当前事实。

普通知识问答直接回答，不强制建记录/测验；只有用户明确“学完了/复盘”才走完整复盘流程。

## 5. 安全与边界速查

- **模型不可指定**：绝对读取路径、bootstrap/state 目录、Python 解释器、Atlas argv、shell 片段、记录 DB 路径。
- 读取仅限 bootstrap 登记根内、workspace 登记 repo 内；不跟随 symlink/junction、不跨根；含秘密/二进制 → `ref_only`。
- 快照必须通过 envelope/hash/schema/图引用校验，且 `workspace_roots` 至少一个条目指回本 workspace 的 repo；不满足直接拒绝。
- 不默认运行构建/测试/Atlas/编译器；`run` 固定 `EXECUTION_BLOCKED`，`plan` 只产出计划。
- 跨仓 ABI 只是静态契约候选（最多 may）；运行时行为、硬件完成、线程重叠、字节偏移需要另行证据。
- 不自动写 05 长期记忆、不上传、不新增模型接收方。

## 6. 故障排查

| 现象 | 处理 |
|---|---|
| 工具返回 `CONFIG_UNAVAILABLE` | 未找到 bootstrap；运行 §2.1 或检查 `bootstrapPath`/`CODE_READER_BOOTSTRAP` |
| `DEPENDENCY_UNAVAILABLE` | Python 3.11+ 不可用；设 `pythonPath` 或 `DSH_CODE_READER_PYTHON` |
| `SCOPE_DENIED` | 路径/根不在 bootstrap 授权范围，或签名引用被篡改 |
| `STALE_SOURCE` | 文件/游标/证据签发后源码已变化，重新 find/read |
| `STALE_SNAPSHOT` / `UNSUPPORTED_SCHEMA` | 快照不是已核验的 Atlas 0.1 对，或 hash 不匹配；重新导入 |
| `STATE_CONFLICT` | revision/generation/锁冲突；先 `status`/`resume` 取当前值再重试 |
| 工具不存在 | 插件未激活：检查 `plugin_manager` 安装结果与 `inspect` 诊断 |

## 7. 代码工作台（原生右侧栏，CL-UI-R1）

产品以 DSH plugin 交付。加载当前 bundle 后，点击宿主的「打开右侧边栏」→ 开始页「代码工作台」；已有页面时先点右栏的「新标签页」。工作台与聊天并排，右上角使用宿主的分栏、全屏和关闭。关闭再开保留当前会话的来源、视图、函数、拖动布局、缩放、展开组和最后已完成场景；刷新整个客户端后的持久化不在本轮范围内。用户桌面热更新尚未验证，本轮全部宿主操作使用隔离 profile。

顶部「来源」默认是当前 Demo：直接执行打包的 C/Wasm 样例，不依赖 Python 首屏；可切换已登记并导入的真实 Atlas 静态快照。真实快照读取失败保留原有画面并显示原因，不把样例数据混入真实代码。

| 视图或工具 | 操作 |
|---|---|
| 资源关系图 | 左右函数、中间共享资源；同一实体一个框，动作色线和字段注释表示关系。点资源看定义、用途、字段与引用。 |
| 文字树 | 所有入口可折叠；真实快照逐次展开源码步骤与调用，避免一开始渲染整个深树。 |
| 端到端流程图 | 选择一个入口；节点可拖，空白可平移、滚轮缩放、规整恢复。判断为菱形，折叠组为处理矩形。真实快照采用竖排正交线；缺少 CFG 的分支明确保留缺口。 |
| 时序图 | 选择接口顺序和参数并生成；Demo 在浏览器执行 C/Wasm。真实快照若有匹配 profile，则通过 Host worker 生成台账观测；否则显示静态场景，不宣称实际执行。 |
| 文件视图 | 仓库文件树与带行号源码；函数选择可定位相应文件区间。 |
| 函数详情 | 源码／子流程／资源分析／AI 归纳；基础接口显示输入、输出、功能、实现与校验，可加入或移出。点击画布空白收起源码。 |
| 全局资源 | 当前函数相关资源高亮置顶；初始化、修改、释放与 Read 分色。关联函数只在图中定位。source_text 是简单文件静态声明/访问的词法补充，不等于预处理后的语义事实。 |
| 打桩模拟 | 真实快照选择匹配的隔离 profile，再选接口与入参。「执行接口」追加当前场景；「新建执行场景」清空执行草稿。Host 执行后保留不可变台账。 |

窄栏可用「展开／收起工具区」把空间留给画布。基础接口、源码和跨视图选择沿用 Demo 交互。内置 Demo 的源码归纳与布局含已复核的样例配置；真实任意仓库不会因此自动获得完整业务语义。

### 7.1 模拟、回退和导入

真实快照先按 §8.1 登记可信 profile。接口名、参数和范围来自 profile；边界打桩接口仍由该 profile 明确声明。每次运行先 preview，再由 Host 隔离执行并写台账；入参变化形成不同场景，同一场景使用 generation 防止覆盖。

「回退末尾」只允许撤销最后 N 条；Host 重放前缀并核验状态摘要。执行记录的「Host 执行记录／观测导入」可查看同快照、同配置台账，并输入可信 inbox 内的轨迹文件名导入。导入数据不会在插件执行，也不能回退重放；要再次模拟先新建执行场景。

真实 Host 的事件显示在记录和 observed 时序中。没有可靠源码分支映射时，图会明确提示「尚未投影到源码分支」。异步标记只采用引擎返回的 observed async 标记，旧导入轨迹不会因当前 profile 声明变化而升级。

### 7.2 验收与开发

本轮隔离 rc.5 的 49 项操作见 [CL-UI-R1](docs/ui-demo-alignment.md)。同视口 Demo 节点位置、形状和颜色一致；真实指针拖动、关闭重开、登记→发送 0x20030、末尾回退、导入和所选接口时序均已实测。

仓库根执行 `node tools/build-workbench.mjs` 构建，`node tools/build-workbench.mjs --check` 检查发布 bundle 与来源一致；`node tools/verify-demo-rebuild.mjs` 运行当前隔离验收。旧 S1/S2a 的主页面 DOM 探针保留历史用途。

## 8. 受控场景与打桩模拟（S3a）

产品「打桩模拟」由 DSH 插件实现：可信 Wasm 模拟 profile + Host 隔离 worker + 引擎运行台账。**执行只由用户在
工作台点击「运行」触发**；Agent/浏览器不提供执行入口，也不能指定模块路径或任意代码。

### 8.1 前置：登记模拟 profile（人工/Host，一次性）

把 `sim-profile.json` 与其 `module.file`（Wasm）放入 bootstrap 的可信 `import_inbox_dir`，然后由人工/Host 执行：

```bash
python -m code_learning.cli --bootstrap <bootstrap.json> sim-profile-import \
  --workspace code-view-bus-demo --variant semantic-x86_64 --repo bus \
  --profile sim-profile.json --operation-id <uuid>
```

引擎校验绑定（workspace/variant/repo 已登记、快照已导入且匹配）、模块 sha256/大小、接口/参数范围、trace 事件表与
`event_resources`（只能引用该快照对象）后复制到 `state/sim/`。Demo 夹具见 `evidence/scenario-sim/`
（bus.wasm 1547B，sha256 `69c8622d…321c`）。未登记 profile 时面板显示 gap，不伪造。

### 8.2 S3 历史完整界面操作（当前入口按 §7.1）

1. 左栏「打桩模拟」→ 选择 profile（显示绑定、模块 sha、接口数、limits）。
2. 组合有序步骤：`reset` → `bus_register(1)` → `bus_send(1, 48)`；接口/参数由 profile 约束（min/max；
   `set_platform_stub` 为边界打桩接口，UI 标「边界打桩」）。
3. 点击「运行」→ Host 引擎 plan → 隔离 worker 执行 Wasm（`env.trace` 收集事件，仅内存/超时限制，无 fs/网络）
   → 引擎写不可变台账（generation，CAS）。
4. 记录逐条显示：接口(实参)、结果（void 显示“—”）、status、call_id、事件（DEFAULT_ROUTE/STORE_ROUTE/
   REQUEST/LOOKUP/CHECK_LENGTH/LOCK/TRANSFER/…/WRITE）、受影响资源（如 `simulated_doorbell` write）、
   memory digest、records_digest、是否边界打桩。
5. 失败/打桩示例：先 `set_platform_stub(-5)` 再 `bus_send(1,48)` → bus_send 结果 `-5`、状态 error、无 WRITE、
   LOCK 1→0；未登记通道 `bus_send(0,48)` → `-2`；非法参数被 UI/引擎拒绝且不产生台账。
6. 时序图切「运行观测」（`observed=true`）读取台账消息（call/return/access/event，含 DOORBELL/WRITE、平台边界）；
   切回「静态预测」仍是 `observed=false` 的静态推断。观测模式有台账场景选择器（默认最近更新，可切换前缀/导入等台账）。
   若 profile/导入轨迹声明了异步事件（如 Demo 的 `IRQ`），对应事件消息显示“异步”chip 与说明（`async:true`），
   仅表示该事件被声明为异步触发，不等于中断已发生；静态模式不显示。
7. 回退：输入「回退步数 N」（1..当前步数）→ 点「回退」→ 重放前缀并逐条核对 memory digest，成功切到前缀台账
   （`undo.state_digest_verified`、步骤编辑器同步前缀步骤、时序选择器刷新）；不一致显示
   `STATE_CONFLICT/state_digest_mismatch` 且不改台账。导入轨迹台账不可回退（按钮禁用并显示原因）。
8. 轨迹导入：在「导入轨迹」输入 inbox 内文件名（如 `trace-bus-send.json`，仅文件名、不接受路径）→ 导入为
   **只读 imported 台账**（不从插件执行代码）；时序观测选中该台账显示 imported 标记与 label/限制。

### 8.3 边界与失败

- 运行只发生在 `worker_threads`：仅 `env.trace` 回调、无 fs/网络/其他 import；总超时 15s、内存 ≤64MB；
  超时/取消/崩溃返回 `OUTCOME_UNKNOWN` 且**不落台账**。
- 台账只追加、带签名/plan_id/module_sha256/records_digest/代次；同一场景重复运行代次 +1；不同场景各自从 0 开始。
  回退发布的是**前缀场景**的新 generation（带 `undo.of_scenario_id/of_generation/count/state_digest_verified`）；
  前缀不可重放（如导入轨迹）时不提供回退，只保留只读历史。
- 未提供：异步/IRQ 因果细化、真实设备下发、图内源码写回（gap 显示；S4/后续验收）。
  Wasm 模拟不证明真实设备/内核行为。

## 9. AI 归纳（CW-09）

工作台详情面板（函数/组）会显示 **AI 归纳区**；正文不是插件生成，而是 **Agent 通过 `code_summary` 工具写入**
（插件无模型出口，不自动调用模型）：

```
code_summary action=put workspace=<id> snapshot=<snapshot_id>
  subject_type=function|group|entry subject_id=<f_…|group:…>
  text="≤500 字，基于已核验证据" facts=[{kind:"evidence",ref:"e_…"},{kind:"node",ref:"f_…"}]
  generator={kind:"agent",ref:"session/…"} inference_labels=["from_static_structure"]
```

- 归纳写入引擎缓存（签名、绑定快照 graph sha）；快照变化后旧归纳标 `stale`（“基于旧快照，待复核”），
  不继续当当前事实。
- 写入约束：≤500 字、facts ≤32 条证据/节点引用、候选/未知用 `inference_labels` 标注、无运行台账不得用
  `from_observation`、不得伪造运行观测；Host/引擎双重校验。`action=get` 读取当前归纳。
- UI 只读展示正文/事实引用数/generator/生成时间/stale；详情另可展示独立的**入口归纳**子块
  （subject_type=entry；无记录时静默、不显示 gap）。未写入函数归纳时显示 gap，不伪造正文。RPC 只读端点
  `view.summary` 供面板使用。

## 10. 历史客户端性能实测（A11；新 UI 待重测）

仓库提供可复现的实测工具（不属于产品运行路径）：

```bash
node tools/verify-perf.mjs --with-repo-tests
```

- 合成 500 节点/800 边与 2,000 节点/1 万事件 Atlas 0.1 fixture（明确标注 SYNTHETIC，非真实仓库），经真实
  引擎导入与视图投影；真实 dsh-web 测量首屏（点击入口→视图 ready）、跨视图定位（资源→函数高亮）、拖动
  反馈（pointermove→rAF）、大图截断/搜索/事件序列反馈。
- 当前实测（2026-11-15，i7-13700F/34GB/Win10/Node 26，最终 Lead/verifier 两次独立 run 均 25/25）：跨视图
  coupling p95 **3–4 ms**（预算 120ms）达标；首屏 hot p95 **382–387 ms**（预算 500ms）**✅ 达标**——三轮
  优化：1078/1141 → 646–705/704–769（并行/预取/缓存）→ 455/527（批量首屏 `view.firstScreen`）→
  328–330/382–387（batch+coupling_aux，省 1 次 coupling RPC）；batch 使用 20/20 hot 样本全 `batch`、一致性
  8/8、coupling p95 3–4 ms；tree 定位/拖动/cold UI/已截断文本在合成夹具/一次性 token 限制下不可测，记
  not_verified 并保留原始样本/失败数。
- 证据：`evidence/perf/verification.json`（机器信息/原始样本/p50/p95/预算判定/覆盖/失败数）、
  `first-screen-consistency.json`、README。合成图只作规模与截断证据，不代表真实仓库或 Linux/Kbuild 证据；
  首屏达标仅限该合成夹具+本机，跨参考机校准未做。
