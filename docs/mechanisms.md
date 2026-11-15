# dsh-code-reader 机制说明（04 代码学习，当前整体交付）

版本 `MECH-04-2`，2026-11-15。本文按[机制说明合同](../../docs/mechanism-document-contract.md)交付：以 **场景→触发→输入与前置条件→判断规则→工具动作→状态/输出→证据→失败与恢复** 为主线，解释为什么这样设计、代价与已知限制，并区分 **skill 可调策略** 与 **plugin/Host/引擎必须执行的硬边界**。

**覆盖的交付**：首版 `CL-IMPL-1`（2026-11-07，登记/源码证据/快照/路径/记录/resume/6 工具/skill）+ `CL-VIEW-T1` 只读工作台切片（CW-T1）+ `CW-T2` 五视图 S2a / 组折叠·接口库·子流程 S2b + `CW-T3` 受控场景 S3a / 回退·轨迹导入 S3b + `CW-T4A` S4-prep（AI 归纳 CW-09、性能实测 A11、异步/IRQ 事件边界、Linux 可移植性探测）。本文覆盖 2026-11-15 最终交付（T37 批量首屏收口提交 `69a1173` + 异步/IRQ 增量）；`view.firstScreen` 已**验证通过**、首屏预算已达标（见 M-04-22、§12.2 与[五视图契约 §12](five-view-contract.md)）；异步/IRQ 事件边界已**验证通过**（M-04-33、[场景契约 §11](scenario-contract.md)）；**S4 目标门禁仍未验证**，见证据边界。

## 证据边界（先读，不得改写为已通过）

1. **本版只覆盖 2026-11-15 最终交付**。已知测试：**318 Python unittest、195 Node 测试、Demo 8/8**（本轮独立复跑：引擎 `Ran 318 tests, OK`、Node `195/195`）；隔离 dsh-web 阶段验收 S1 `26/26`、S2a `37/37`、S2b `41/41`、S3a `43/43`、S3b `58/58`、AI 归纳 `49/49`；性能实测 **25/25 全绿**（含批量首屏/`coupling_aux` 一致性与 5 项回归）；**异步/IRQ 事件边界 34/34 全绿**（`in_scope_not_verified=0`、`out_of_scope=5`），均 `ok=true, verified=true`。
2. **S4 目标门禁未验证**：真实 Linux/Kbuild 索引与生成头、native CFG/locks/aliases、复核 precision/recall、OS 出口认证全部**未验证**。`evidence/s4-feasibility/` 只是 Linux 可移植性探测，`verification.json` 明确 `verified=false`；不得据 Node/Wasm 在 Linux 上跑通推断内核分析已通过。
3. **首屏性能预算已达标（最终验收）**：500/800 图 hot 首屏 p50/p95 = **328–330/382–387 ms ≤ 500 ms**（历史：T27 基线 1078/1141 → T28 优化 646/704 → T33 批量首屏无 aux 455/527 → T37 `coupling_aux` 后 328–330/382–387）；`verify-perf` **25/25 全绿**、layers 全 true、`ok=true/verified=true`，预算未调整。剩余 not_verified 4 项（cold UI 20 冷样本、tree→file 行高亮、拖动反馈、2000/10k UI「已截断」文本）如实保留；本轮数字只对本机/本版本有效。
4. **批量首屏 `view.firstScreen` 已验证**（[五视图契约 §12/§12.4](five-view-contract.md)）：最终 `node tools/verify-perf.mjs --with-repo-tests` **25/25 全绿**；20/20 hot 样本中 `[data-first-screen]` 共 60 处全部 `batch`（fallback=0）；`coupling_aux` 一致性 **8/8**（view!=coupling 时 CLI 5/5 视图与单独 `view-coupling` 逐字段一致、RPC 5/5 一致；view==coupling 省略 aux 且 `sizes.coupling_aux=0`；`sizes` 4 键精确、aux 计入 480 KiB；未知 view→`INVALID_ARGUMENT`（优先于 entry）、未知 entry→`NOT_FOUND`；CLI/RPC 无绝对路径）；client 消费 aux 后 0 次单独 coupling RPC，缺失/格式错回退。证据 `evidence/perf/{verification.json,first-screen-consistency.json}`。
5. **已验证范围的边界**：所有 `dsh_host` 层证据来自本机 pinned DSH `0.2.1-rc.5` 的**隔离 profile**（独立 `DSH_HOME`，不改真实 `~/.dsh`、不重启桌面宿主，Windows）；`atlas_snapshot` 层来自 Atlas 0.8.0 自带 Windows runtime 对**合成 C/Demo C** 的产物；`demo_observed` 层来自 Demo 的 Wasm 模拟。真实用户仓库、真实设备/硬件、目标 ABI、Linux 桌面宿主、桌面宿主热更新、OS 级出口认证均**未验证**；异步/IRQ 只做**声明式边界标记**（profile/导入轨迹声明→`async` 标记→UI chip），**不推断**真实硬件中断/因果（`out_of_scope`）。
6. **三层证据不得互相冒充**：`demo_observed`（Wasm/JS 行为模型）、`atlas_snapshot`（真实 Atlas 0.1 静态快照 + 真实 Python 投影）、`dsh_host`（隔离真实宿主/浏览器行为）分层记录在任何证据 JSON 与 UI 标签中；没有运行的项只进 `not_verified`。
7. 设计文档中的“未来合同”不等于已实现；本文对每个机制给出实际证据与未验证项，候选改进只写成假设。

---

## 0. 机制总表

| ID | 机制 | 类别 | 主要代码 | 本轮证据（相对路径 + 关键数字） |
|---|---|---|---|---|
| M-04-01 | 可信 bootstrap 与 scope 根表 | 硬边界 | `engine/code_learning/state.py`、`scope.py`、`cli.py` | `engine/tests/test_workspace.py`、`test_cli_journey.py`；安装旅程 bootstrap-init 实测 exit 0 |
| M-04-02 | Workspace 登记与 revision CAS | 硬边界 + 触发可调 | `workspace.py`、`state.py` | `test_workspace.py`（CAS/operation/清单漂移）；`evidence/code-view-slice/verification.json`（revision=1, fresh） |
| M-04-03 | 变体与 BuildIdentity 身份 | 硬边界 | `workspace.py`、`build.py` | `test_workspace.py`（digest 随 config/compdb/source 变化） |
| M-04-04 | compdb/config 只读预检 | 硬边界 | `build.py` | `test_workspace.py::test_semantic_variant_*` |
| M-04-05 | 签名 path_ref/evidence_ref 与安全路径 | 硬边界 | `state.py`、`scope.py`、`source.py` | `test_source.py`、`test_io_robustness.py`（Windows O_BINARY 密钥回归）；证据引用全链路复验 |
| M-04-06 | 有界源码 find（预算/游标/脱敏） | 预算可调，边界硬 | `source.py` | `test_source.py`、`test_verifier_regressions.py::BoundedProjectionTest` |
| M-04-07 | 有界源码 read/evidence（hash/UTF-8/ref_only） | 硬边界 | `source.py` | `test_source.py`（read/evidence/秘密 ref_only） |
| M-04-08 | Atlas 0.1 快照导入与复核 | 硬边界 | `atlas.py`、`snapshot.py` | `test_snapshot.py`（22）、`test_real_atlas_product.py`；`evidence/real-atlas/`、`evidence/code-view-slice/`（`ed326d55…`，19 函数/15 调用边） |
| M-04-09 | 快照 freshness 与只读隔离 | 硬边界 | `snapshot.py`、`state.py` | `test_snapshot.py`（stale/unknown/current 漂移）；`evidence/readonly-slice/verification.json`（verified/fresh/19 entries） |
| M-04-10 | 路径查询与 certainty 回连 | 查询策略可调 | `paths.py`、`atlas.py` | `test_paths.py`（31）；`test_real_atlas_product.py`；`evidence/readonly-slice/`（bus_send 三条 exact） |
| M-04-11 | 跨仓 Binding 评估与 abi_bridge | 硬边界（不得升 exact） | `bindings.py`、`paths.py` | `test_bindings.py`（19）；Host 旅程 umd→kmd `abi_bridge may` |
| M-04-12 | 关系查询模式与 capability 门禁 | 硬边界（不得伪造） | `paths.py` | `test_paths.py::RelationQueryTests`；切片快照 `cfg=unsupported`、`data_flow=partial_path_insensitive`，无数据返回 `unavailable` |
| M-04-13 | 学习记录存储/CAS/导出 | 硬边界 | `records.py`、`learning.py` | `test_records.py`（32：CAS/幂等/body 篡改/导出 pending） |
| M-04-14 | 预测/观察/决策的 pending 规则 | 硬边界 | `learning.py`、`records.py` | `test_records.py::DraftValidationTests`、`test_verifier_regressions.py::RecordClaimTest`、`test_skill_contract.py` |
| M-04-15 | resume 失效重核与事件消费 | 硬边界 | `invalidation.py`、`scope.py` | `test_invalidation.py`（25）、`test_verifier_regressions.py::SourceManifestJunctionTest` |
| M-04-16 | 编译/Atlas 执行阻断 | 硬边界 | `service.py`、`cli.py` | `test_cli_journey.py::test_plan_is_reference_only_and_run_is_blocked` |
| M-04-17 | 工具注册、固定 argv 桥、技能分发 | 硬边界 + 预算可调 | `index.js`、`lib/{bridge,config,skills,tools}.mjs` | `tests/node/{bridge,plugin}.test.mjs`；7 个 `code_*` 工具（首版 6 个 + S4-prep `code_summary`）、195 Node 测试；Cordis `host-runtime.tap` 1/1；`evidence/plugin-install-verification.json`（首版安装旅程） |
| M-04-18 | 学习编排 skill（阅读顺序/讲解/停止/归纳写入） | skill 可调 | `skills/learn-code-workspace/` | `test_skill_contract.py`（19 条款）；`evidence/*/verification.json` 的回归层 |
| M-04-19 | 只读工作台 RPC 载体与准入 | 硬边界 | `index.js`、`lib/http-rpc.mjs`、`lib/view-service.mjs`、`bundle/client.js` | `evidence/readonly-slice/verification.json`（26/26、401 准入、71 boot 条目、bundle 精确前缀）；`host-runtime.tap` 1/1 |
| M-04-20 | 只读读模型、五视图投影与共享 Selection | 硬边界（派生/预算）+ 展示可调 | `engine/code_learning/views.py`、`five_views.py`、`lib/view-service.mjs`、`bundle/client.js` | `evidence/five-views/verification.json`（37/37）；五视图截图；`test_views.py`（18）、`test_five_views.py`（31） |
| M-04-21 | 组折叠/接口库/黑盒/子流程面包屑 | 可调策略（结构启发式，不升级事实） | `five_views.py`、`bundle/client.js` | `evidence/s2b/verification.json`（41/41：2 组/4 成员、10 候选、31 边元数据保留、面包屑） |
| M-04-22 | 批量首屏 `view.firstScreen`（含 `coupling_aux`） | 硬边界 + 性能优化（**已验收**） | `docs/five-view-contract.md §12`、`lib/view-service.mjs`、`engine/code_learning/{cli,five_views}.py`、`bundle/client.js` | `evidence/perf/verification.json`（25/25；hot p50/p95 328–330/382–387 ms ≤500 ✅；20/20 hot 60 处 batch/fallback=0）；`first-screen-consistency.json`（8/8；38,950 B sha256 `8bb859f9…`）；client 消费 aux→0 次单独 coupling RPC |
| M-04-23 | 受控 Wasm 模拟 profile 与隔离 worker | 硬边界 | `engine/code_learning/scenario.py`、`lib/sim-runner.mjs`、`lib/sim-worker.mjs` | `evidence/s3/verification.json`（43/43：profile 7 接口、bus.wasm 1547 B sha256 `69c8622d…`）；`evidence/s4-feasibility/`（真实 Wasm worker 8/8） |
| M-04-24 | 场景 plan/record 台账与代次 CAS | 硬边界 | `scenario.py`、`lib/scenario-service.mjs` | `evidence/s3/`（3 条记录结果 —/0/0、代次 1→2、64hex digest、records_digest）；`test_scenario.py`（31） |
| M-04-25 | 边界打桩与失败传播 | 硬边界 + 场景可调 | `scenario.py`、`lib/sim-worker.mjs`、`bundle/client.js` | `evidence/s3/`（`set_platform_stub(-5)` → -5、无 WRITE、LOCK 1→0）；`evidence/scenario-sim/README.md` |
| M-04-26 | 回退末尾 N 次与前缀重放 | 硬边界 | `scenario.py`、`lib/scenario-service.mjs`、`bundle/client.js` | `evidence/s3b/verification.json`（58/58：memory_digest 逐条一致、`undo.state_digest_verified`、count=99 拒绝） |
| M-04-27 | 轨迹导入（只读台账） | 硬边界 | `scenario.py`、`lib/scenario-service.mjs` | `evidence/s3b/`（`scn_982682c88e20` imported 幂等；3418 B sha256 `8860df51…`；undo 禁用） |
| M-04-28 | 运行观测时序（observed） | 硬边界（证据分级）+ 展示可调 | `scenario.py`（`view-sequence-observed`）、`lib/scenario-service.mjs`、`bundle/client.js` | `evidence/s3/`（observed 20 消息）；`evidence/s3b/`（多场景选择/imported 标记/前缀 6 消息）；`evidence/async-irq/`（IRQ async 标记，M-04-33） |
| M-04-29 | AI 归纳（Agent 写入/签名/失效） | 硬边界 + 内容 skill 可调 | `engine/code_learning/summary.py`、`lib/tools.mjs`（`code_summary`）、`lib/view-service.mjs`、`bundle/client.js` | `evidence/ai-summary/verification.json`（49/49：gap→put→UI 展示、非法 put 拒绝、group subject、Cordis TAP 1/1） |
| M-04-30 | 性能实测口径与首屏预算 | 测量机制（非产品路径，**已验收**） | `tools/verify-perf.mjs`、`tools/perf-probe.cjs`、`tools/perf/*`、`tools/firstscreen-consistency.mjs` | `evidence/perf/verification.json`（25/25 全绿；hot p50/p95 328–330/382–387 ms ≤500 ✅；coupling p95 3 ms；历史 646/704→455/527→328–330/382–387；not_verified 4 项如实） |
| M-04-31 | S4 Linux 可移植性探测与不可声明项 | 待验证门禁（只记录） | `evidence/s4-feasibility/`、`source.lock.json` | `evidence/s4-feasibility/verification.json`（Node 164/164、Wasm worker 8/8、Python 3.8 引擎单测 255 errors、Windows 快照被拒绝；`ok=true, verified=false`） |
| M-04-32 | 分层证据与隔离 dsh-web 验收门禁 | 硬边界（证据纪律） | `tools/verify-*.mjs`、`tools/*-probe.cjs`、`evidence/*/verification.json` | S1..AI 6 阶段 + 性能 **25/25** + 异步/IRQ **34/34** 均 `ok=true, verified=true`；`in_scope_not_verified` 如实（perf 4 项、async 0 项）；pinned 宿主 SHA 门禁 |
| M-04-33 | 异步/IRQ 事件边界（声明→校验→observed 标记→UI；不推断中断发生） | 硬边界 + 展示可调（**已验收**） | `engine/code_learning/scenario.py`、`bundle/client.js`、`tools/verify-irq.mjs` | `evidence/async-irq/verification.json`（34/34、layers 全 true、`in_scope_not_verified=0`；真实 Wasm `bus_irq`→IRQ、observed `async:true`、dsh-web `[data-sequence-async]`+“异步”chip/说明；非法声明拒绝不写）；sha256 `38080909…` |

---

## 1. 能力、分层与信任边界

### 1.1 解决什么实际场景

1. **模型侧学习**：Agent 在“已登记 workspace”上回答“某个 ioctl / 调用链 / 对象生命周期 / 同步路径如何工作”，必须能回到**真实源码行**与**已核验快照边**，区分 exact/may/unknown/source_text，并保留用户自己的预测与观察（`CL-IMPL-1`）。
2. **浏览器侧只读工作台**：人在 DSH 侧边栏看同一份已核验快照的入口、源码、资源读写、五视图、组/接口库/子流程，并与模型共享同一选择标识（CW-T1/T2）。
3. **受控模拟观测**：在没有真实设备/编译器的情况下，对**已登记且可信**的 Wasm 模拟 profile 执行用户在 UI 里编排的有序接口调用，落不可变台账，得到 observed 时序；支持边界打桩、失败传播、回退前缀重放与只读轨迹导入（CW-T3）；另支持异步/IRQ 事件的声明式边界标记（M-04-33，不推断中断发生）。
4. **AI 归纳缓存**：Agent 基于已核验证据写 ≤500 字归纳，工作台详情展示并标 generator/事实引用/stale；**插件自身不调用模型**（CW-09）。
5. **可复核的证据链**：所有能力按阶段在隔离 dsh-web 中黑盒验收，输出分层 `verification.json`，未验证项单列（CW-11/A11、S4-prep）。

### 1.2 分层职责（谁做什么、谁掌握凭据/数据、生命周期）

| 层 | 负责 | 掌握凭据/数据 | 生命周期 |
|---|---|---|---|
| **skill** `learn-code-workspace` | 阅读顺序、挑一个问题、讲解篇幅、先预测、何时建记录/复盘、何时写 AI 归纳、停止与 Next Action | 无凭据；只产出工具参数与解释文本 | 每次对话；不持久化（状态在记录/面板里） |
| **plugin Host 半**（`index.js`、`lib/*.mjs`） | 7 个 `code_*` 工具 schema、固定 argv 桥、skill provider、`/code-view` RPC 编排、场景 plan→module→worker→record 编排、AI 归纳写入工具 | 从人工/插件配置读取 `bootstrapPath`、`pythonPath`、`timeoutMs`；**不持有模型/API 密钥**，环境变量白名单剥离凭据；浏览器凭据由 Host 会话提供 | bundle `apply` 注册、`ctx.effect` 随 fiber dispose；UI 子插件依赖缺失时保持 pending，不影响旧工具 |
| **Python 引擎**（`engine/code_learning/`） | 全部 scope/hash/schema/证据等级/记录/场景台账/归纳的**校验与持久化**；只读源码与快照副本 | HMAC secret（人工 `bootstrap-init` 首次创建，0600；Windows 0x0A 缺陷已修复）；`state_dir` 下登记/快照/记录/模拟/台账/归纳；不联网、不上传 | 每次 CLI 子进程；state 长期存在 |
| **DSH Host** | `ctx.tools.register`、`ctx.skills.registerProvider`、`connection.admit` + `webServer.register`、rc.5 client loader、`slots/layout`、连接准入 cookie | 宿主会话凭据、UI loader/路由生命周期 | 宿主进程；升级必须重跑验收（pinned rc.5 门禁） |
| **OS** | 文件系统、进程/线程、worker 内存限额、本机回环 HTTP | 用户账户权限 | 系统级 |

**模型/浏览器永远不能指定**：绝对读取路径、bootstrap/state/inbox 路径、Python 解释器、Atlas argv、shell 片段、Wasm 模块路径/URL、执行入口。这些只能来自人工 bootstrap、Host 配置与引擎签名引用。

### 1.3 数据位置与出口

| 数据 | 位置 | 写入者 | 出口 |
|---|---|---|---|
| bootstrap（候选根/HMAC secret） | 人工指定文件（默认 `$DSH_HOME/code-reader/bootstrap.json`） | 人工 `bootstrap-init`（模型不可写） | 只本地 |
| workspace 登记/快照副本/记录/模拟 profile/台账/归纳 | `state_dir`（引擎） | 引擎校验后原子写 | 只本地；无上传/云出口 |
| 人工输入 | `import_inbox_dir`（manifest、snapshot 目录、`sim-profile.json`+Wasm、轨迹、记录草稿） | 人工/外部工具 | 引擎按文件名读取，禁止任意路径 |
| 验收证据 | 仓库内 `evidence/`、`tools/` | 验收工具（非产品运行路径） | 仓库内；不含 token/凭据（已 redact） |
| UI/RPC | 浏览器内存 + 会话缓存（LRU ≤32） | client 半 | 只经 `/code-view` 载体，不出绝对路径 |

---

## 2. 端到端机制（一次典型旅程与恢复分支）

```text
[人工一次] bootstrap-init ──► 信任根表 + HMAC secret ──┐
[人工/Host] inbox: workspace.json / snapshot-graph+manifest / sim-profile.json+bus.wasm / trace.json
                                                        │
   Agent(模型)                    DSH Host 插件                    Python 引擎(本地)              浏览器(工作台)
   ─────────                      ─────────────                    ───────────────               ──────────
1  install bundle ─────────────► apply: 注册 7 tools + skill；嵌套 UI 子插件等 connection/webServer
2  code_workspace import ──────► 固定 argv 桥 ──────────────────► 校验 manifest/CAS → registration.json
3  code_snapshot import ───────► 固定 argv 桥 ──────────────────► envelope/graph_hash/workspace_roots → state 只读副本
4  code_overview/source/path ──► 固定 argv 桥 ──────────────────► 签名引用/预算/关系查询 → 证据 JSON
5  code_learn save/resume ─────► 固定 argv 桥 ──────────────────► Draft 校验/CAS/证据重核 → 记录 revision
6  打开「代码工作台」→ 选快照/入口 ───────────────────────────────────────────────────────► POST /code-view/view.firstScreen
   （准入 connection.admit → 校验 → 固定 argv → 引擎） ─────────► 1 次批量投影 entry+interfaces+当前视图
   （需要左栏资源 rail 且 view!=coupling 时同时返回 coupling_aux；失败/超限/旧宿主回退单独端点）
7  点入口/切五视图/组/接口库/子流程（读模型 + 客户端渲染，Selection 跨视图共享；首屏后切视图命中缓存）
8  用户编排步骤 → 运行 ────────► scenario-plan → scenario-module → worker_threads(Wasm, env.trace)
                                  → scenario-record（代次 CAS/不可变台账）→ 台账投影
9  observed 时序 / undoTail / trace.import（obs=台账；undo=前缀重放+digest 核验；import=只读）
   异步/IRQ：profile/导入轨迹声明 async_events → observed 事件标 async:true → UI「异步」chip/说明（不推断中断发生）
10 Agent code_summary put ─────► 校验+签名+graph sha 绑定 → summary 缓存；UI 只读展示/stale 标记
11 证据：tools/verify-*.mjs 在隔离 dsh-web 产出 evidence/<stage>/verification.json（分层/not_verified）
12 取消/部分完成/恢复：abort→OUTCOME_UNKNOWN（不落台账）；预算/能力缺失→gaps/truncated；stale→重新导入/复核
```

**取消与部分完成**：

- 工具/CLI 超时或取消：`OUTCOME_UNKNOWN`（exit 4）或 `BridgeError`，**不得当成功**；不写记录、不写台账。
- 场景运行中取消/worker 崩溃/超时：`OUTCOME_UNKNOWN`，**不发布**台账代次（M-04-24/26）。
- 快照损坏/过期：单个快照标 `invalid`/`stale`，整页/整请求仍成功，UI 在缺口区显示原因（M-04-09/19）。
- 证据失效（源码/构建/快照变化）：`resume` 返回 `stale`/`unknown` + `changed_inputs` + `safe_cursor`，先复核再续读（M-04-15）；AI 归纳在 graph sha 变化后标 `stale`（M-04-29）。
- 预算截断：显式 `truncated=true` + 原因，不静默丢数据（M-04-06/20/30）。

---

## 3. 来源与复用方式

| 来源（固定基线） | 借鉴机制 | 采用方式 |
|---|---|---|
| SDK Code Atlas `0.8.0` / schema `0.1`（`H:/VSCODE_READER`，git `c33320a98face14c5f6e5e817beaccf52b9bbb93`，只读） | 0.1 envelope、`graph_hash`=`graph.json` 原始字节 SHA256、`coverage.failed`/`pending_units`/`whole_program_complete=false` 原样语义、`call_targets` 上的 certainty、trace BFS 形状、`objects`/`field_accesses`/`flow_edges`/`boundaries`/`issues` 词汇 | **只读消费 + 本仓薄适配**：`atlas.py`/`snapshot.py`/`paths.py`/`views.py`/`five_views.py` 自行实现消费者；**不 vendor** Atlas 源码/runtime/DB，不执行 Atlas（真实产物由人工用其自带 Windows runtime 在 2026-11-08/11-15 生成）；SHA 见 `source.lock.json`（`redistributed:false`） |
| 本仓 CL-DESIGN-2 / CL-VIEW-D2 设计文档 | DTO 字段、CLI 合同、pending 字段、resume 失效顺序、五视图/场景/归纳的端点、预算、DOM 钩子 | **直接实现**（模块级）；偏差记录在 `docs/implementation-route.md` §偏离与本文 §10.1 |
| 用户 `C:/Users/admin/.codex/行为守则.md` | 普通问答不强制考试、明确学完才复盘、先预测后验证、K2/K3 无 G/Q 可停、Next Action 最多一条 | **直接实现**为 skill 文本 + `learning.py` 硬规则 |
| 本机 DSH Host `0.2.1-rc.5`（build `d4db512a…`；exe SHA `7ae939b5…`、asar `e1b6f25f…`） | `ctx.tools.register`、`ctx.skills.registerProvider`、`ctx.effect`、rc.5 `__ModuleLoader__` client、`sidebar.panellist`+keyed main、`layout.selectPanel`、`connection.admit`+`webServer.register` | **按本机实际签名自行实现**；UI 子插件依赖缺失时 pending；pinned 版本门禁见 `evidence/readonly-slice/` |
| 08 工作台（`bundle/client.js`、`src/http-rpc.mjs`、`tools/isolated-profile-verify.mjs` 等，本机已自测 rc.5） | 原生 client bundle 包装、侧栏+keyed main 注册形态、连接准入信封、隔离 profile 启动与 Chromium 探针方法 | **借鉴机制 + 薄适配**：04 自有 `/code-view` 载体（`lib/http-rpc.mjs`）与自有探针；**不依赖 08 包、不同时运行 08** |
| 本仓 Demo `demo/code-view/`（`bus.c`、`platform.c`、Wasm bundle、`demo.test.cjs`） | `routes[channel].max_len` 登记/发送/超限语义、事件 trace、五种视图样例交互 | **行为对照夹具**（`demo_observed`）：只作 Wasm 模拟观测，不冒充真实设备；C 源字节级复制进真实 Atlas 快照夹具 `evidence/code-view-slice/repo/` |
| superpowers-dsh `0.4.0`（本机已装） | 打包 skill provider 的目录扫描/frontmatter/rank 骨架 | **仅借鉴模式**；provider 与 skill 内容自写，未合入其代码 |
| clang 16.0.4（`C:\mingw64\bin\clang.exe`）、Atlas 自带 libclang 18.1.1 | compdb 预检/真实产物解析 | 仅用于**人工生成/复核合成 C** 的 `compile_commands.json` 与真实 Atlas 产物；插件运行期不执行编译器 |
| Serena/codegraph/clangd；ELK/React Flow/Monaco/Perfetto | 符号导航、图布局、时序渲染 | **仅调查对照/技术候选**：本版未集成、未引入、未声称合入 |

判定复用方式的原则：本仓库不复制上游代码；Atlas 只被消费格式（`redistributed:false`）；设计文档只作为合同来源；08 只借鉴机制；未实际复用的项目不写成已合入。

---

## 4. 决策规则与分机制说明

### 4.1 基础机制 M-04-01..18（保留并更新证据）

以下机制在 2026-11-15 仍有效；测试计数统一更新为 **318 Python / 195 Node / Demo 8/8**，每节列出场景/判断/证据/失败恢复/可调与限制。**类别与主要代码位置见 §0 总表**；**参数范围见 §6**、**规则间依赖见 §7**、**最小验证命令见 §8**（按节内文件名即可定位到对应测试模块）。

- **M-04-01 可信 bootstrap 与 scope 根表（硬边界）**。**场景**：Agent 要读“某个仓库”，但不能自决读整块磁盘。**触发**：每次 CLI 调用前由 `--bootstrap`/`CODE_READER_BOOTSTRAP`/`$DSH_HOME/code-reader/bootstrap.json` 解析。**输入与前置**：`BootstrapConfigV1{schema_version:1, profile_ref, scope_ref, scope_generation, state_dir, import_inbox_dir, output_root, candidate_roots[{root_ref,absolute_path,read_grant_ref}]}`，由人工 `bootstrap-init` 创建，已存在拒绝覆盖（`STATE_CONFLICT`）。**判断**：绝对路径/字段白名单、`root_ref` 唯一、state/inbox/output 必须存在；模型参数永不出现绝对路径。**动作/状态**：`State` 持有 layout、HMAC secret（首次 0600）、workspace 锁、operation 幂等文件、snapshot 索引。**输出**：`state_root`/`inbox_dir`/`output_root`/candidate roots。**失败恢复**：缺失→`CONFIG_UNAVAILABLE`(exit 2)，人工修 bootstrap，不自动重建。**可调**：何时调用；**不可调**：根表/secret。**最小验证**：`cd engine && python -m unittest discover -s tests -p "test_workspace.py" -v`。**代价**：一次人工配置换“模型无法扩权”。

- **M-04-02 Workspace 登记与 revision CAS（硬边界 + 触发可调）**。**触发**：`workspace-import --manifest NAME --expected-revision N --operation-id UUID`（`code_workspace action=import`）。**输入**：inbox 单层 manifest（`WorkspaceManifestV1`），引用 `root_ref+relative_path`。**判断**：schema 严格校验、`scope_ref` 匹配、根 realpath 一致/不嵌套/不重复/拒绝 symlink-junction；`expected_revision` 必须等于当前 revision（首次 0）；相同 operation 摘要幂等返回原结果，不同摘要 `OPERATION_CONFLICT`。**动作/状态**：workspace 锁内原子写 `workspaces/<id>/registration.json`，revision+1；manifest 与 roots 摘要入登记。**输出**：`WorkspaceProjectionV1`（不含绝对路径），含 variant `semantic_status/missing_inputs/build_identity`。**失败恢复**：`STATE_CONFLICT`→先 `status` 取当前 revision 再试；`SCOPE_DENIED`→修根/清单，不扫父目录。**证据**：`test_workspace.py`、`evidence/code-view-slice/verification.json`（revision=1/fresh）。**可调**：何时登记/重登记；**不可调**：CAS 与根校验。

- **M-04-03 变体与 BuildIdentity 身份（硬边界）**。**输入/判断**：`analysis_mode ∈ source_only|semantic`；semantic 必须有 compdb/config/生成头/toolchain，否则 `semantic_status=blocked` + `missing_inputs`；source_only 允许空。`BuildIdentity{workspace_revision, variant_id, roots_digest, source_manifest_digest, compdb_digests, config_digests, generated_header_digests, toolchain_digest, atlas_lock_digest, sysroot_manifest_digest, binding_digest}`。`source_manifest_digest` = 登记 repo 内普通文件排序后的 `repo_id/relpath\0size\0mtime_ns\n` 流 SHA256（保守变化探测，不冒充内容 hash；超预算显式 `LIMIT_EXCEEDED` 不静默截断）；引用文件 digest 用内容 SHA256（≤16 MiB）。**动作/输出**：登记与快照/记录/归纳都绑定这份身份。**失败恢复**：build 输入缺失→blocked 但仍可 source-only 阅读；身份变化→旧记录/快照/归纳 stale（M-04-09/15/29）。**代价**：mtime 摘要可能误报变化（保守方向），不误报 fresh。**证据**：`test_workspace.py`、`evidence/code-view-slice/`（`semantic_status=semantic`、fresh）。

- **M-04-04 compdb/config 只读预检（硬边界）**。**场景**：恶意/错误编译数据库可能诱导执行 wrapper、越根读头文件、插件加载或 shell。**触发**：`workspace-import`/`workspace-validate` 的 semantic 变体预检（不执行 probe）。**判断**：拒绝 shell 链/重定向/环境赋值包装、非绝对 compiler、未登记 wrapper、`-Xclang -load`/plugin/VFS/动态 module、`-include/-imacros/-I/-isystem/--sysroot` 越登记根；response 文件递归 ≤8 层/≤1 MiB、防环/防越根；源文件必须属于登记 repo；错误使 variant `blocked` 并给 diagnostics，**不删参数假装构建相同**。**输出**：`semantic_status/missing_inputs/diagnostics/各 digest`。**失败恢复**：blocked 时只开放源码阅读。**未验证**：真实编译/索引执行仍阻断（M-04-16）。**证据**：`test_workspace.py::test_semantic_variant_*`。

- **M-04-05 签名 path_ref/evidence_ref 与安全路径（硬边界）**。**规则**：`state.sign(payload)`=`v1.<b64url-json>.<HMAC-SHA256>`；path_ref `{kind:'path',w,r,p,s,g}`、evidence_ref `{kind:'source',w,r,p,s,b,e,ls,le,v,g,t}`；校验 MAC、scope_generation、workspace/repo 归属、文件 SHA256、byte 区间、变体；读取前 lstat/realpath 拒绝 symlink-junction 越界。**输出**：`SourceEvidence{evidence_ref, repo_id, variant_id, source_ref, source_sha256, byte_start/end, line_start/end, origin:'source_text', semantic_status:'blocked', limitations:['text_only_not_compiler_fact']}`。**失败恢复**：`SCOPE_DENIED`/`STALE_SOURCE`→重新 find/read。**本轮修复的真实缺陷**：Windows 上 `os.open` 未带 `O_BINARY`，CTRL 文本模式把随机密钥中的 `0x0A` 扩成 CRLF，导致签名文件约 12% 概率损坏、已签引用/台账/plan/归纳随机 `SCOPE_DENIED`；已改为二进制打开并严格校验 32 字节，回归 `engine/tests/test_io_robustness.py`（构造含 `0x0A/0x0D` 密钥验证 round-trip 与损坏报错）。**代价**：引用不可跨 scope 复用；换可审计来源。**可调**：何时获取引用；**不可调**：MAC/路径边界。

- **M-04-06 有界源码 find（预算可调、边界硬）**。**规则**：`literal` 与 `filename` 恰一个；literal 是字面文本（非正则）1..256；`relative_glob` 受限（`*`/`**`/`?`）；跳过 `.git/node_modules/__pycache__` 与链接；预算 128 文件/32 MiB/200 命中；`next_cursor` 是签名令牌（query digest + workspace_revision + 文件清单摘要 + offset），相关文件变化→`STALE_SOURCE`；单文件读取窗口 8 MiB；只搜到前缀时显式 `truncated=true`+`large_file_prefix_only`。**脱敏**：疑似秘密行/二进制返回 `ref_only` 原因，不进入上下文；preview 限长。**输出**：`matches[{path_ref,evidence_ref,source_sha256,byte_start/end,line_start/end,safe_preview}]`、`next_cursor`、`scanned_files/bytes`、`truncated`、`semantic_status:'blocked'`、`limitations`。**失败恢复**：预算用尽带 `next_cursor` 续页；源码变化重查。**证据**：`test_source.py`、`test_verifier_regressions.py::BoundedProjectionTest`。**可调**：更小 glob/更窄路径；**不可调**：单次预算上限、脱敏、不跟链接。

- **M-04-07 有界源码 read/evidence（硬边界）**。**规则**：仅接受签名 `path_ref`+`expected_sha256`+区间；0≤start<end、单次 ≤16 KiB；先核 hash 再核区间（文件被改短→`STALE_SOURCE`，hash 相符但区间越界→`INVALID_ARGUMENT`）；UTF-8 边界安全调整；二进制/疑似秘密→`ref_only`。**输出**：`evidence`+`safe_text|ref_only`+实际区间；`origin='source_text'`、`semantic_status='blocked'`。**证据**：`test_source.py::test_read_source_*`、`test_read_evidence_roundtrip_limits_and_staleness`、`test_suspected_secret_returns_ref_only`。**恢复**：`STALE_SOURCE`→重新 find/read。**限制**：文本证据永不升级为编译器事实，行号仅导航。

- **M-04-08 Atlas 0.1 快照导入与复核（硬边界）**。**场景**：复用 Atlas 编译事实，但不能信任任意传入快照目录。**触发**：`snapshot-import --workspace --variant --repo --snapshot NAME --operation-id`（`code_snapshot action=import`）。**规则**：NAME 只能是 inbox 内单层目录；读 `graph.json`/`analysis_manifest.json` 两 envelope；校验 `schema_version='0.1'`、`record_kind`、payload 必填字段、`payload.graph_hash == sha256(graph.json 原始字节)`、严格图引用（call_targets 的 callsite/source/target/evidence id 必须存在）；**`workspace_roots` 必须至少一个条目指回本次导入的目标 repo**（只命中同 workspace 其它 repo 不够），避免把别的仓库快照 exact 边记到本仓；同 snapshot_id 不同内容→`STATE_CONFLICT`；operation 幂等。多根 Atlas 快照列出全部被分析根，因此同一对已核验快照可在每个根对应 repo 下分别导入。**动作/状态**：原子复制到 `state/snapshots/<id>/`，写 `import.json`（workspace/variant/repo/两 hash/build_identity/imported_at）与 `current.json` 只读 view，更新索引（key=workspace+variant+repo）。**输出**：`SnapshotEvidence`（coverage 原样保留，`failed` 数组/`pending_units` 路径数组不改数字，另加 `failed_count`；`whole_program_complete` 不升级）。**证据**：`test_snapshot.py`（22：hash/schema 篡改、整数 coverage 拒绝、missing copy 修复、current/inbox 漂移不影响已导入副本）、`test_real_atlas_product.py`；真实产物：`evidence/real-atlas/`（quickstart `00fb…`、mini `22a7c4…`，`graph_hash` 逐字节相等）与 `evidence/code-view-slice/`（Demo C：snapshot `ed326d554334432b907de21297207eb8`，19 functions/15 call_targets，coverage failed=[]）。**本轮修复的真实适配缺陷**：真实 Atlas 为文件级初始化产生 `flow_edges.owner=null`、`sources=[]`，旧校验要求非空而拒绝；已放宽为“owner 可为 null、sources 可为空 id 数组”，其余恒等字段/确定性检查不变，回归 `engine/tests/test_atlas_flow_shape.py`（4）。**失败恢复**：`UNSUPPORTED_SCHEMA`/`STALE_SNAPSHOT`→重新导出/导入；损坏副本可同 hash 重导修复；**不**改 Atlas DB/current。

- **M-04-09 快照 freshness 与只读隔离（硬边界）**。**规则**：每次 `load_snapshot`/`snapshot_evidence` 重新核两文件 hash 与 schema；freshness：导入后 workspace revision 或 `source_manifest_digest` 变化→`stale`；文件缺失/不可读→`unknown`；否则 `fresh`。查询只读 state 内副本，不读 Atlas `current` 指针，故不会被另一次 run 漂移影响。**输出**：`SnapshotEvidence`、`freshness`、`capabilities`、`limitations`。**证据**：`test_snapshot.py::test_freshness_*`、`test_current_and_inbox_drift_do_not_change_loaded_snapshot`、`test_tampered_copy_is_rejected_on_load`；`evidence/readonly-slice/verification.json`（verified/fresh/19 entries）。**恢复**：stale/unknown 时重新导入或重跑分析（本版不执行）；skill/UI 必须先提示 freshness。

- **M-04-10 路径查询与 certainty 回连（查询策略可调）**。**触发**：`path --workspace --variant --from REF --to REF [--budget --max-depth --direction]`（`code_path action=path`）。**规则**：REF=`repo:function` 或单快照裸 ref；先按 `id` 再按 `name/display_name` 解析，多义→`AMBIGUOUS_SYMBOL`（给 choices，不批量跑）；同 repo 对 `graph.payload.call_targets` 做 BFS（down/up），预算默认 2000、深度 30；每条边从 `call_targets` 回连 `callsite` 取 origin/certainty/evidence_ids，**绝不把路径线条升级为 exact**；边界/递归/深度/预算停止进 `unresolved`；结果含 `common_prefix`、`choices`、`truncated`、`freshness`。**输出**：`PathResultV1`（nodes/edges/unresolved/choices/coverage/truncated/budget_used/freshness）。**真实产物位置解析**：真实 Atlas 0.8 function 实体**不带** `file`/`line`，位置在 `payload.evidence[]` 并由 `function.evidence_ids` 引用；`atlas.function_location()` 按 evidence `start` 最小优先解析，路径 nodes/choices 因此带回真实文件与行号（合成 fixture 仍可直接带 file/line，两种形状都接受）。**证据**：`test_paths.py`（31：certainty join、同名 static 不跨仓合并、歧义 choices、预算/深度截断、direction up、reference candidate 不伪造 call）、`test_real_atlas_product.py`、`evidence/readonly-slice/`（`bus_send` callees 三条 exact：`lookup_route`160/`check_length`164/`dispatch_transfer`170）。**代价/恢复**：只覆盖“已分析图”内关系，`completeness` 不声称全程序；stale 快照仍可查但结果标 stale。

- **M-04-11 跨仓 Binding 评估与 abi_bridge（硬边界）**。**场景**：UMD ioctl↔UAPI↔KMD dispatch 无编译 call 边，需要显式 ABI/接口事实。**规则**：`CrossRepoBindingV1` 严格校验（端点 repo/variant/interface_ref/evidence、variant 组合精确匹配、ABI/selector）；status **按证据重算**：缺证据/接口版本/共同定义/selector 值→`incomplete`；同 binding_id 修订不连续、同 from+selector+variant 指向不同 to、端点 interface revision 不一致→`conflicting`；身份/证据摘要变化→`stale`；全部齐→`supported`。`supported` 最多产生 `abi_bridge, certainty='may', origin='derived'` + `static_contract_not_runtime_call`，**不产生 call 边**。**输出**：路径结果 `edges[]` 或 `unresolved[]`；`binding_digest` 进 BuildIdentity。**证据**：`test_bindings.py`（19）、`test_paths.py::CrossRepoPathTests`、Host 旅程 umd→kmd `abi_bridge may` 且无 call 边。**限制**：导入时 workspace.py 会重建 bindings 列表且未传旧评估结果，“stale”主要靠显式 `previous_bindings` 交接触发（模块已测，集成待后续）；真实跨进程/布局仍需目标 ABI 证据。skill 不得据此声称“实际调用”。

- **M-04-12 关系查询模式与 capability 门禁（硬边界）**。**规则**：`mode ∈ flow_cfg|flow_legacy|locks|aliases`，selector 按模式互斥（如 flow_cfg 必须 function_ref + 恰一个 parameter/value，拒绝 symbol/object/lock）；`flow_legacy` 仅在存在 `flow_edges` 时投影，certainty=may 并保留原 limitations；`flow_cfg` 必须有真实 CFG capability+数据，否则 `status=unavailable`，**不自动降级为 legacy**；locks/aliases 无分析数据同样 `unavailable`+unknowns，空结果不证明“无竞争/无别名”；budget/max_items 截断显式。**证据**：`test_paths.py::RelationQueryTests`；本机真实切片快照 `cfg=unsupported`、`data_flow=partial_path_insensitive`（`view-snapshots` 原样保留），关系查询返回 `unavailable`；`evidence/real-atlas/` 的 `flow_legacy status=ok` 是唯一真实可用的关系模式。**代价**：多数关系查询在现有快照上不可用；本版不伪造。

- **M-04-13 学习记录存储/CAS/导出（硬边界）**。**触发**：`record-save --input NAME --expected-generation N --operation-id UUID`、`record-get`、`export`（`code_learn`）。**规则**：Draft 严格 schema（`schema_version=1`，未知字段拒绝，不接受 `generation`）；SQLite `PRAGMA user_version=1`+WAL，表 `workspaces/records/revisions/operations/runs/event_inbox/consumer_cursors`；正文写 `state/records/<rid>/<gen>.json`（临时+fsync+rename），事务更新 revision/record/operation；CAS：current generation ≠ expected→`STATE_CONFLICT`；operation 相同请求摘要返回原结果，不同摘要 `OPERATION_CONFLICT`；导出 markdown 标明 pending/stale 字段与证据，json 为 revision 精确副本+sha256；只允许本 workspace；`uploaded=false`。**证据**：`test_records.py`（32：CAS、幂等、body 篡改、archived 增长拒绝、导出 pending 标记、scope）。**失败恢复**：冲突先 get/resume；归档记录不销毁证据；**限制**：resume 只读不自动写新 revision。

- **M-04-14 预测/观察/决策的 pending 规则（硬边界）**。**规则**（`learning.py` 校验、`records.py` 强制）：无用户文本/时间→`prediction.status='pending'`；`user_provided` 必须带 `text+provided_at`；`mental_model.author='agent'` 的 agent 解释不能写成用户已复述；`observation.status='observed'` 必须非空 `evidence_refs` 且 `experiment.status='executed'`（有 run_ref）；`decision='DONE-APPLIED'` 需 observed+executed+记录证据；`next_action` 至多一条且 `text/estimated_minutes(1..240)/completion_criterion` 完整。**保存时二次校验**：`records.save_record` 调 `_verify_record_claims`；本版没有 execution backend，任何 `experiment.status='executed'` 都因 `runs` 账本无对应 run_id 被 `CAPABILITY_UNAVAILABLE` 拒绝，因此 `observation.observed`/`DONE-APPLIED` 无法靠伪造 run 落盘；`planned` 的 `plan_ref` 必须是本地签名 plan；记录引用证据按签名/文件/字节区间重核，unsigned/过期证据不按 fresh 落盘而是把 freshness 降为 `stale`/`unknown` 并写 `invalidation_reasons`。**证据**：`test_records.py::DraftValidationTests`、`test_verifier_regressions.py::RecordClaimTest`、`test_skill_contract.py`。**残余信任边界（诚实披露）**：`prediction.status='user_provided'` 与 `mental_model.author='user'` 属于对话来源声明，引擎只能校验结构与时间戳，**不能密码学认证“确实是用户说的”**；由 skill/对话层约束，评审时应视为非阻塞信任边界而非已解决的安全保证。

- **M-04-15 resume 失效重核与事件消费（硬边界）**。**触发**：`resume --record RID`（`code_learn action=resume`）；可选 `consume-event --event-file NAME`。**顺序**：workspace revision→记录 BuildIdentity 与当前登记身份逐项摘要→重算 `source_manifest_digest`→config/compdb/generated 内容 sha256→每条 evidence_ref 的 MAC/文件存在/内容 SHA256/byte 区间/变体。**判断**：任一变化→`stale`+`changed_inputs/required_rechecks`；文件丢失/不可读→`unknown`；revision 变但摘要全同→`unknown`（保守不宣称 fresh）；否则 `fresh`。返回 `safe_cursor`（“先复核这条证据”，禁止直接用旧行号/旧结论）。**junction 安全**：source-manifest 重算走 `scope.iter_regular_files`，显式跳过 symlink/junction/reparse，不会把 repo 外树计入摘要或无界遍历。**事件**：`CapabilityEventV1` 只接受 3 种 kind；按 event_id 幂等；旧/乱序 generation 只审计不置 fresh；`partial/unknown`/不可定位→相关记录 `unknown`；cursor 缺口→`gap_detected=true, requires_local_recheck=true`；事件丢失仍靠本地 hash 重核。**证据**：`test_invalidation.py`（25）、`test_verifier_regressions.py::SourceManifestJunctionTest`。**限制**：safe_cursor 的 evidence_refs 列表封顶 32 条，超出显式 `evidence_refs_total/evidence_refs_truncated`。

- **M-04-16 编译/Atlas 执行阻断（硬边界）**。**规则**：`plan` 只做数据/摘要与固定 Atlas 0.8 argv 形状（引用字符串、不 embedding 绝对 host 路径、不执行）；`plan_id` 是签名令牌（TTL 600s）；`run` 校验签名/过期后**始终**返回 `EXECUTION_BLOCKED`（exit 2），因为未提供强制隔离 execution profile；没有裸跑 compiler probe/Atlas/CMake 的路径。**证据**：`test_cli_journey.py::test_plan_is_reference_only_and_run_is_blocked`。**恢复**：真实执行需未来固定 Linux 隔离 runner + 固定 Atlas runtime + 授权（未实现）。**重要区分**：CW-T3 的“受控场景执行”（M-04-23..28）是**受控 Wasm 模拟**，不是编译/Atlas/用户代码执行，不改变本机制的阻断。

- **M-04-17 工具注册、固定 argv 桥、技能分发（硬边界 + 预算可调）**。**触发**：插件 bundle `apply(ctx, config)` 激活。**规则**：`inject=['tools','skills']`；`ctx.effect` 注册/清理；`ctx.tools.register` 注册 **7 个** `code_*`（首版 6 个，S4-prep 增加 `code_summary`：`code_workspace/overview/source/snapshot/path/learn/summary`）；`ctx.skills.registerProvider` 扫描 `skills/*/SKILL.md`（frontmatter/rank=550/source=custom）。每次工具调用→`lib/bridge.mjs` 解析 Python（配置 `pythonPath`/`DSH_CODE_READER_PYTHON`/`python3`/`python`，探测 `--version` 并要求 3.11+，旧 3.x 判 `DEPENDENCY_UNAVAILABLE`）→`spawn(python,['-m','code_learning.cli','--bootstrap',…,固定 argv])`，`cwd=engine/`，**无 shell**；环境变量白名单、剥离 API key 等凭据；stdout 必须是一个 JSON（>8 MiB 截断保护）；域内错误以 `{schema_version,ok,exit_code,cli}` 返回；spawn/超时/取消抛 `BridgeError`（超时=`OUTCOME_UNKNOWN/4`）。工具层参数只填 typed slots，不能提供可执行文件、cwd、根表、bootstrap；插件内**串行**化 CLI 调用避免同一 sqlite writer 竞争（这也是首屏性能瓶颈的结构原因，见 M-04-30）。**UI 子插件**：嵌套 Cordis 插件声明 `inject:['connection','webServer']` 挂载 `/code-view` 载体（13 个 view 端点 + 7 个 scenario 端点）；服务缺失时该子插件保持 pending，旧工具不受影响。**输出**：工具值 JSON + RPC 信封。**失败恢复**：`DEPENDENCY_UNAVAILABLE`→配置 `pythonPath`；超时/取消→`OUTCOME_UNKNOWN`，不得当成功。**可调**：`bootstrapPath`、`pythonPath`、`timeoutMs(1000..600000)`、更小查询预算；**不可调**：argv 形状、环境白名单、JSON/退出码合同、写作用域。**证据**：`tests/node/bridge.test.mjs`、`tests/node/plugin.test.mjs`、`tests/node/view-rpc.test.mjs`、`tests/node/scenario.test.mjs`、`tests/node/client.test.mjs`（195 Node 总计）；`evidence/plugin-install-verification.json`；Cordis `host-runtime.tap` 各阶段 1/1（7 工具注册、真实 Python 调用、dispose 注销、二次挂载再注册）。

- **M-04-18 学习编排 skill（skill 可调）**。**规则**：workspace 优先 9 步（登记/校验→概览→选一个问题→一条证据路径→解释→先预测→最小授权核验→规则/未知→记录/停止）；普通问答直接答、不强制记录/测验；仅用户明确“学完了/复盘”才走完整 11 阶段，未完成字段保持 pending；Next Action ≤1（动作+分钟+完成标准）；K2/K3 无 G/Q 可停；证据分级 exact/may/unknown/source_text；不自动跑构建/测试、不自动写 05、不代填预测。**S4-prep 增量**：可选第 10 步“详情归纳”——用户要工作台详情出现归纳时用 `code_summary put` 写 ≤500 字，必须基于已核验证据、facts 放 evidence/节点引用、候选/未知用 `inference_labels` 标注、无运行台账不得用 `from_observation`、不得伪造正文或把候选写成 exact；插件不会自动调用模型。**可调**：阅读顺序、每次讲多少、何时建记录、是否总结、预算内查询范围、是否/如何写归纳、停止时机。**不可调**：M-04-01/05/08/11/12/13/14/15/16/19/20/23..29 的硬边界（skill 不能绕过 scope、不能把文本当编译事实、不能把 pending 写成 user、不能执行 run、不能伪造 observed/归纳、不能声称未验证通过）。**证据**：`test_skill_contract.py`（19 条款，含六工具/证据分级/resume/复盘/停止/秘密 ref_only）；各阶段 dsh-web 验收把 S1..S4-prep 回归层作为 skill 行为的护栏。**仍需**：独立对话评审实际学习质量（结构测试不等于效果证明）。**打包范围**：仅 `skills/learn-code-workspace/`（SKILL.md + references）；`docs/dsh-code-view-ui/SKILL.md` 是 UI 指导 skill 草案，未打包。

### 4.2 本轮新增机制 M-04-19..33

#### M-04-19 只读工作台 RPC 载体与准入（硬边界）

| 项 | 内容 |
|---|---|
| 场景/触发 | 浏览器侧只读工作台需要读引擎数据，但共享 `/api` RPC 通道是 single-owner 且 `connection.rpc.handle` 经 connection 服务自身 fiber 注册，消费者插件不能使用；因此插件自建私有 prefix 路由，在 UI 子插件挂载时生效。 |
| 输入与前置 | `POST /code-view/<endpoint>`，body `{"type":"client-request","rpcId":"<1..128 [A-Za-z0-9._:-]>","method":"<endpoint>","payload":{…}}`；方法白名单 = 13 个 `view.*` + 7 个 `scenario.*`/`trace.import`；需要 Host `connection` 与 `webServer` 服务。 |
| 判断规则 | ① 非 POST→405；② `ctx.connection.admit(req)` 先于读 body，失败/异常 fail-closed 401/403；③ 请求体 ≤16 KiB（content-length 与流式双检）；④ JSON+信封+`rpcId`+method 必须合法，`method` 必须等于 URL 末段且在白名单；否则固定 `gateway/bad-request`；⑤ 处理异常/超限/响应 >512 KiB→固定 `gateway/internal`，**永不回传 Host 错误文本或绝对路径**；⑥ `error.details` 恒为空对象（rc.5 浏览器响应校验器要求 record）。 |
| 工具动作与状态 | `ctx.effect(() => ctx.webServer.register({kind:'prefix',…}))` 绑定嵌套 UI fiber：dispose 时路由注销、二次 apply 重新注册；UI 服务缺失时嵌套插件 pending，旧 7 工具与 skill 不受影响。 |
| 输出/证据 | 成功 `{type:'server-response',rpcId,result:{ok:true,value:<engine payload>}}`；桥接/宿主失败 `{ok:false,error:{code,message,details:{}}}`；引擎逻辑错误（exit 2/3/4）以 `ok:true,value:<engine JSON>` 原样返回、由 client 识别 `value.error.code`。证据：`evidence/readonly-slice/verification.json`（26/26；无 cookie 直连 `/code-view/view.status`→401；`__DSH_BOOT__` 71 条含 `@local/dsh-code-reader`；服务端 bundle 为仓库 `bundle/client.js` 精确前缀；旧 4 端点 200+冻结信封+真实 Python）；`host-runtime.tap` 1/1；后续阶段同一载体扩到 20 端点并回归（`evidence/{five-views,s2b,s3,s3b,ai-summary}/verification.json`）。 |
| 参数与范围 | 通道 `/code-view` 固定；请求/响应上限、rpcId 模式、方法白名单、`details:{}` 均为硬编码；插件 config 只能改 `bootstrapPath/pythonPath/timeoutMs`，不能改载体。 |
| 依赖与冲突 | 依赖 rc.5 的 `webServer.register`/`connection.admit` 实际签名（pinned 门禁）；与 Host 其它插件路由隔离（自有 prefix）；升级 Host 必须重跑验收。 |
| 失败与恢复 | 401/403→面板显示准入缺口，不伪造 cookie；`BRIDGE_UNAVAILABLE`（Python/引导不可用）、`ENGINE_BLOCKED`(exit 2)、`ENGINE_FAILED`(exit 3)、`OUTCOME_UNKNOWN`(4/超时)、`LIMIT_EXCEEDED`→UI 显示 code/message 并可重试；单个 snapshot 损坏只标该条 invalid，不整页报错。 |
| 最小验证 | `node --test tests/node/view-rpc.test.mjs tests/node/plugin.test.mjs`；`node tools/verify-readonly.mjs --with-repo-tests`（隔离 profile）；`node tools/verify-five-views.mjs --with-repo-tests`（401 准入回归）。 |
| 限制/改进假设 | 仅本机 rc.5 验证；浏览器 cookie 由宿主自签、插件不做用户认证；Chromium 探针是时序观测（隐藏窗口+截图），不是确定性像素基线；桌面宿主热更新未验证（验收用独立 profile）。 |

#### M-04-20 只读读模型、五视图投影与共享 Selection（硬边界派生 + 展示可调）

| 项 | 内容 |
|---|---|
| 场景/触发 | 从**已登记且已核验**的 Atlas 0.1 快照投影入口/源码/资源读写/五视图；所有视图共享一个稳定 `Selection` 供跨视图联动与后续阶段复用。触发：`view.listSnapshots/listEntries/getEntry`（工作台骨架）与 `view.coupling/tree/endToEnd/fileTree/fileRead/sequence`（五视图）。 |
| 输入与前置 | 只接受 workspace/snapshot/entry/repo/path/max_lines 等有界标识；`path` 只允许仓库相对 POSIX 路径，拒绝 `..`/绝对路径/反斜杠；快照必须先通过 M-04-08/09 哈希与 freshness 复核。 |
| 判断规则 | 派生只使用快照已有实体：`functions`、`objects`、`field_accesses`、`call_targets`、`callsites`（含 `guards`）、`flow_edges`（relation ∈ argument_binding/assignment/return/initializer）、`boundaries`、`issues`、`evidence`；**缺失层一律进 `gaps`，不得用空数组伪装“无关系”**；certainty 原样保留（`exact`/`may`/`unknown`），`flow_edges` 的 `path_insensitive/alias_not_solved` 限制必须保留；不新增解析器、不执行编译/Atlas。 |
| 工具动作与状态 | 引擎单进程读 state 内只读快照副本 + 签名源码证据，输出 DTO；client 只渲染与缓存（会话内 LRU≤32 + in-flight 去重），不改任何引擎状态；面板关闭/返回聊天不丢 workspace/snapshot/entry/view/selection。 |
| 输出/证据 | 五视图 DTO 与 DOM 钩子见[五视图契约 §3–§6](five-view-contract.md)；预算：coupling 资源 ≤100/访问 ≤400；tree 节点 ≤500、深度 ≤8；e2e 节点 ≤120/边 ≤240；fileTree ≤2000 文件；fileRead ≤64 KiB/2000 行；sequence 消息 ≤200；超限 `truncated:true`+gaps。证据：`evidence/five-views/verification.json`（37/37；coupling `routes` `max_len` write **exact** `bus.c:46`、read **may** `bus.c:92/93/98`；e2e 19 nodes/31 edges 全 M/H/V 正交、`-90` 红色异常边、`platform_write` 虚线外部边界；fileRead 174 行；sequence 静态 38 消息 observed=false+warning）；`evidence/readonly-slice/`（入口 `bus_send` `bus.c:152`、源码 152–174、三条 exact 调用边、资源标识）；`test_views.py`（18）、`test_five_views.py`（31）。 |
| 参数与范围 | 端点/字段/预算/枚举固定；`max_lines` 1..2000；Host 校验 workspace `^[a-z0-9][a-z0-9._-]{0,63}$`、snapshot/entry/repo/path 有界字符集与长度。 |
| 依赖与冲突 | 依赖 M-04-08/09（快照核验与 freshness）、M-04-05（签名源码证据）、M-04-17（桥）。`Selection` 字段一旦引入保持稳定，不提供字段用 `null`/空数组 + `*_status`，不得删除；`focus_resource_id/focus_callsite_id` 等扩展字段旧布局不改。 |
| 失败与恢复 | 快照损坏→该条 `status:invalid` + error，整页仍可用；源码不可读/摘要不符/二进制/秘密→`source.status:'unavailable'`+reason，其余字段照常；freshness stale/unknown 原样返回并提示；前端错误保留面板并显示错误码；无绝对路径。 |
| 最小验证 | `node tools/verify-five-views.mjs --with-repo-tests`；`cd engine && python -m unittest discover -s tests -p "test_views.py" -v`；`python -m unittest discover -s tests -p "test_five_views.py" -v`。 |
| 限制/改进假设 | 无 native CFG → 端到端图“无调用点分支”只能 gap（`branch_conditions_partial`）；sequence 静态模式只是源码顺序预测，不是运行观测；资源读写 certainty 由 Atlas 决定，UI 不得升级。 |

#### M-04-21 组折叠/接口库/黑盒/子流程面包屑（可调策略，结构启发式，不升级事实）

| 项 | 内容 |
|---|---|
| 场景/触发 | 端到端图较大时需要结构分组；用户需要把稳定边界收成黑盒/接口；函数详情需要子流程与调用面包屑。触发：`view.endToEnd {entry,root?}` 的 `groups/grouping/breadcrumb`、`view.interfaces {entry?}`，以及客户端组折叠/展开/改名、接口库加入/移出、黑盒展开、子流程 tab。 |
| 输入与前置 | 同一已核验快照与入口/根入口标识；组/接口派生只用已投影的函数/调用边/字段访问/guard。 |
| 判断规则 | **组**：对端到端投影中每个非入口、非外部函数 F，令 P(F)=F 的直接 callee 中“投影内只有 F 一个调用者且本身是 process 节点”的函数；P(F) 的成员数 ≥2 时生成 `G(F)`（`group_id=group:<F_id>:<members 排序短哈希>`）；`label="<F.name> 下游子流程"`、`description` 列出成员与“仅被 F 调用”；`origin:"structural_heuristic"`、limitations `group_structural_heuristic/group_name_not_semantic`；共享函数（多调用者）永不入组；**边不合并**——折叠是客户端投影，跨组边接组端口并保留原 `edge_id/certainty/label/evidence_ids/limitations`，展开精确恢复；组数 ≤50。**接口库**：候选池=被至少 1 条已解析调用边指向、非入口根、签名/返回完整者；`leaf`=无已解析出边，`cross_file`=有异文件调用者，`decoupling=independent`（leaf 且无写类字段访问且签名完整）/`mixed`（leaf 但有写类副作用，或非 leaf 但签名完整）/`unknown`；`score` 可解释权重（independent +5、cross_file +3、callers≥2 +2、无字段访问 +2、写类副作用 −1）；**全部 `certainty:"may"`**。**黑盒**：客户端展示覆盖，仅把函数收成黑盒并隐藏其下游，不写快照/源码。**面包屑**：从 root 到 entry 的调用路径 ≤20 跳，无路径→`[]`+gap `breadcrumb_unavailable`。 |
| 工具动作与状态 | 引擎确定性派生并输出；客户端组折叠/展开/改名（`groupOverrides` 仅当前会话 view 状态，刷新数据保留修订、不改引擎快照）；接口库加入/移出只改展示；Selection 追加 `group_id/interface_id/subflow_root_id`（可为 null，旧字段不改）。 |
| 输出/证据 | `evidence/s2b/verification.json`（41/41）：groups=2（`commit_transfer 下游子流程`：encode_doorbell/write_doorbell；`dispatch_transfer 下游子流程`：submit_buffered/submit_direct；members:4），折叠后节点 19→15、31 条跨组边 survivor 的 `data-edge-id/certainty/label` 零变化、展开精确恢复；接口库 10 候选（快照全范围 12），`platform_write` mixed+cross_file+字段写副作用、3 个 independent（encode_doorbell/check_length/lookup_route），add→`[data-blackbox-node]`、remove→恢复；面包屑 `bus_send→check_length`、根 crumb 回主图（19 nodes/31 edges 精确一致）；console error=0、无绝对路径。引擎/Node 测试：`test_five_views.py`、`bundle/client.js`+`tests/node/client.test.mjs`。 |
| 参数与范围 | 组数 ≤50、成员总数 ≤节点数；接口 ≤100；面包屑 ≤20 跳；全部枚举/权重固定。 |
| 依赖与冲突 | 依赖 M-04-20 的投影与预算；组只是视图辅助，不改变调用事实、不新增语义推断；接口候选是规则候选不是语义断言；用户修订只存会话，不会与引擎数据冲突。 |
| 失败与恢复 | 无组/无候选→空数组+`group_semantics`/理由 gap；面包屑不可用→gap；黑盒加入后原节点隐藏但可“展开原有步骤”恢复；刷新后组修订保留标记“已修订（结构归纳）”。 |
| 最小验证 | `node tools/verify-s2b.mjs --with-repo-tests`；`cd engine && python -m unittest discover -s tests -p "test_five_views.py" -v`。 |
| 限制/改进假设 | 组名/描述是结构归纳而非语义理解（可由用户修订，仅当前会话）；接口候选评分是固定规则、无语义模型；跨视图选择联动只保留 Selection 字段，不做持久化或跨变体合并。 |

#### M-04-22 批量首屏 `view.firstScreen`（含 `coupling_aux`，硬边界 + 性能优化，**已验收**）

| 项 | 内容 |
|---|---|
| 场景/触发 | 首屏原需 4 个 RPC（getEntry + coupling + interfaces + 当前视图），Host `bridge` 串行执行 Engine CLI，T27 实测 hot p95 1141 ms、T28 客户端优化后仍 704 ms，超 500 ms 预算；设计 §5“Host 合并同键只读计算”要求把首屏合并为一次 Host→Engine 调用，并让左栏资源 rail 复用同一批数据（`coupling_aux`）以避免额外一次 coupling RPC。 |
| 输入与前置 | 契约[五视图契约 §12](five-view-contract.md)：引擎 `view-first-screen --workspace --snapshot --entry [--view <coupling/tree/end_to_end/sequence/file>]`（默认 coupling）；返回 `entry`/`interfaces`/`view_payload`，当 `view!=coupling` 时额外返回 `coupling_aux`（同 `view.coupling` 同参投影）；Host 端点 `view.firstScreen` 输入 `{workspace,snapshot,entry,view?}`（枚举/有界/未知字段拒绝），映射 CLI，`VIEW_ENDPOINTS` 13 个。 |
| 判断规则 | 一次加载并核验快照，`entry`/`interfaces`/`view_payload`/`coupling_aux` **必须与单独端点逐字段一致**（certainty/gap/预算/标签不得因批量改变）；`--view` 只接受 5 个视图枚举；未知 view→`INVALID_ARGUMENT`（优先于 entry）、未知 entry→`NOT_FOUND`；`view==coupling` 时省略 `coupling_aux`（或 null）且 `sizes.coupling_aux=0`；`sizes` 固定 4 键 `{entry,interfaces,view,coupling_aux}` 且值为各组件 canonical JSON 的 UTF-8 字节数；响应总大小引擎侧预算 ≤480 KiB（**含 aux**），超限 `LIMIT_EXCEEDED`（附 sizes），**不做静默裁剪**；client 失败（gap/`LIMIT_EXCEEDED`/旧宿主 404/aux 缺失或格式错）回退单独端点，`data-first-screen="batch 或 fallback"`，ready 仍由真实 payload 决定。 |
| 工具动作与状态 | 引擎在单进程内一次核验快照并投影；client 优先 1 次 `view.firstScreen`，成功后写 entry/interfaces/view/`coupling_aux` 会话缓存（后续视图切换命中缓存）；`view!=coupling` 时消费 aux 填 rail/缓存 → **0 次单独 coupling RPC**；缺失 aux 时回退原单独请求路径。 |
| 输出/证据 | 最终验收：`evidence/perf/verification.json`（116,133 B，sha256 `e350ed99fa73072c2493305ef6832021f7c3187dbca9e4669c8b2c9c7358fa0c`；25/25 全绿、layers 全 true、`ok=true/verified=true`；hot p50/p95 **328–330/382–387 ms ≤500 ✅**；20/20 hot 样本 `[data-first-screen]` 共 60 处全部 `batch`、fallback=0）；`evidence/perf/first-screen-consistency.json`（38,950 B，sha256 `8bb859f90f30909d18a7020d706e94172b2005ae056509af5d13568ec7784393`；8/8：CLI 5/5 视图+RPC 5/5 视图逐字段一致、sizes 4 键精确/aux 计入 480 KiB、负例、无绝对路径，duration 8.8 s）；回归 perf-regressions（S3b/S3a residual=[]/S2b/summary）+ Node 191/191（当次；最终 195/195）+ Demo 8/8 全绿。 |
| 参数与范围 | 视图枚举 5；sizes 4 键；响应 ≤480 KiB（含 aux）；Host 输入有界；无额外缓存（首屏合并即一次调用）；`LIMIT_EXCEEDED` 走回退。 |
| 依赖与冲突 | 依赖 M-04-19/20；与单端点共享同一 DTO 形状，若批量/aux 偏离单端点即违约；`coupling_aux` 与 `view.coupling` 同源保证 coupling 视图与左栏资源 rail 一致；失败必须回退，不能把批量失败变成面板失败。 |
| 失败与恢复 | 旧宿主/引擎不支持→404 或引擎错误→client 回退单独端点；`LIMIT_EXCEEDED` 或 aux 缺失/格式错→回退；批量一致性不放宽（逐字段严格相等，signed `v1.*` evidence_ref 按 claims 归一化、忽略每次签发时间 t）；回退后行为与错误语义不变。 |
| 最小验证 | `node tools/verify-perf.mjs --with-repo-tests`（25/25；内含 `tools/firstscreen-consistency.mjs` 8/8）；`node --test tests/node/view-rpc.test.mjs`、`tests/node/client.test.mjs`；隔离 dsh-web 探针 `data-first-screen="batch"`、console=0、无绝对路径。 |
| 限制/改进假设 | 已验证范围：合成 500/800 快照 + 本机 rc.5 隔离 profile；`LIMIT_EXCEEDED`（480 KiB）路径最终 verifier run **未触发**（真实快照远低于上限，由引擎/Node 测试覆盖 sizes/回退）；剩余 not_verified 见 M-04-30（cold UI、tree→file、拖动、2000/10k 截断文本）；跨参考机预算校准为 out_of_scope。 |

#### M-04-23 受控 Wasm 模拟 profile 与隔离 worker（硬边界）

| 项 | 内容 |
|---|---|
| 场景/触发 | 在没有真实设备/编译器的情况下，对可信、可重放的 Wasm 模拟执行有序接口调用，观察行为与资源影响。**触发**：人工/Host 把 `sim-profile.json` 与其 `module.file`（Wasm）放入 bootstrap 可信 `import_inbox_dir`，执行 `sim-profile-import --workspace --variant --repo --profile <inbox 文件名> --operation-id` 登记；之后由**用户**在工作台「打桩模拟」点「运行」触发 Host `scenario.run`。 |
| 输入与前置 | `SimProfileV1`：`profile_id ^[a-z0-9][a-z0-9._-]{0,63}$`；binding workspace/variant/repo **必须已登记**、snapshot **已导入且与 repo 匹配**；module `file`+`sha256`；interface ≤32、params ≤8、`type ∈ {u32,i32}`、`returns ∈ {i32,void}`、`role ∈ {entry,stub_control,util}`、min/max 必须含类型合法范围；trace import 名 `env.trace`、5 个 i32 参数、events ≤64 大写标识符；`event_resources` 只引用该绑定快照的对象 id（不得伪造）；可选顶层 `async_events`（≤16、去重、必须来自 trace events；见 M-04-33）。 |
| 判断规则 | 引擎校验 Wasm sha256/大小/接口/事件表/资源映射后复制到 `state/sim/` 只读区并签名登记；运行只使用 state 内副本；Host/引擎在 spawn 前再次校验 plan、module sha、steps ≤20、args 与 profile min/max（`INVALID_ARGUMENT`，不产生 Wasm trap）；worker 内再做一次 sha256 防御（`MODULE_HASH_MISMATCH`），未知接口 `UNKNOWN_INTERFACE`；profile/轨迹的 async_events 声明按 M-04-33 校验（≤16、去重、必须属事件表）。 |
| 工具动作与状态 | worker 由父进程 `worker_threads` 启动，只通过 `workerData` 拿模块字节/steps/trace 表，**worker 不读文件系统、不联网、无其他 import**（只有 `node:crypto`、`node:worker_threads`），唯一宿主回调是 `env.trace`；父进程不接触 wasm 内存；`execArgv:[]` 防止继承测试参数；资源限制 `maxOldGenerationSizeMb=64`；默认超时 10 s，最大 30 s（Host 总超时 15 s）；超时/取消/崩溃/异常退出→`OUTCOME_UNKNOWN`，**不落台账**。模型-facing 工具没有执行入口。 |
| 输出/证据 | profile 投影（无绝对路径）、`scenario-module` 给 worker 的模块载荷、运行 records/台账（M-04-24）。证据：`evidence/s3/verification.json`（43/43；profile 7 接口、`bus.wasm` 1547 B sha256 `69c8622d3522f68f90450a2db36ee11a85c859c91bdf2b5df1688fd6acd1321c`、limits `{timeout_ms:10000,steps:20,events_per_step:256}`、19 trace events）；`evidence/scenario-sim/README.md`（来源=Demo 已构建产物原样解码，插件不编译）；`evidence/s4-feasibility/`（Linux 上真实 Wasm worker 8/8）；`tests/node/sim-runner.test.mjs`、`test_scenario.py`。 |
| 参数与范围 | steps ≤20、args/步 ≤8、总参数 ≤4 KiB；events/步 ≤256；内存 64 MB；worker 超时 10 s（≤30 s）；profile/接口/事件/资源映射上限固定。 |
| 依赖与冲突 | 依赖 M-04-08/09（绑定快照核验）、M-04-05（签名）、M-04-24（台账）；与 M-04-16 不冲突——它是 Wasm 模拟，不是编译/Atlas/用户代码执行。 |
| 失败与恢复 | profile 未导入/绑定错/哈希不符→gap 或引擎错误，不执行；worker 超时/崩溃→`OUTCOME_UNKNOWN`、台账不变；未知接口/越界参数→`INVALID_ARGUMENT`，不落台账。 |
| 最小验证 | `cd engine && python -m unittest discover -s tests -p "test_scenario.py" -v`；`node --test tests/node/sim-runner.test.mjs`；`node tools/verify-s3.mjs --with-repo-tests`。 |
| 限制/改进假设 | Wasm 模块是 Demo 构建产物，**不证明真实设备/内核行为**；异步/IRQ 因果未建模（M-04-33 仅声明式标记）；真实设备下发需单独授权与运行验证；profile 只能来自可信 inbox（人工），浏览器/模型不能上传或指定路径。 |

#### M-04-24 场景 plan/record 台账与代次 CAS（硬边界）

| 项 | 内容 |
|---|---|
| 场景/触发 | 把一次“plan→执行→记录”变成可审计、只追加、可复查的台账。**触发**：`scenario-plan`（签 TTL 600s plan，不执行）、`scenario-module`（仅 Host worker 用）、`scenario-record`（worker 记录 → 台账）、`scenario-list`/`scenario-get`；Host 端点 `scenario.preview/run/list/get`。 |
| 输入与前置 | 场景 JSON `{generation, stop_on_error, steps:[{interface,args}]}`：steps ≤20、interface 必须属于 profile、args 个数/类型/范围严格匹配、`generation`=当前代次（CAS）、总参数字节 ≤4 KiB；`scenario-json`/`records-json` base64 解码后 ≤8 KiB/≤32 KiB（超出 `LIMIT_EXCEEDED`）；运行记录 `records` 数=plan steps 数且 interface/args 逐项一致；status ∈ {ok,error}；result 32 位整数或 null；events ≤256/step 且 event 必须在 profile events；四字段 int32；memory_digest 64hex；拒绝额外字段。 |
| 判断规则 | plan 投影签名/TTL/`plan_id`；record 校验与 plan 对齐后写**不可变** `generation-<n>.json`，`current.json` 指向当前代；每代含 `plan_id`、`module_sha256`、`scenario_digest`、`records_digest`（records 规范化哈希）、签名、`observed:true`；`scenario_id=scn_<scenario_digest 前 12>`；同场景重复运行 generation+1；`operation_id` 幂等（同摘要返回原结果，不同摘要 `OPERATION_CONFLICT`）；代次 CAS 由 plan 记录的 expected generation 决定。 |
| 工具动作与状态 | Host `scenario.run` 顺序：plan → module → worker → record（operation_id 由 Host 生成）；任何一步失败：引擎校验失败原样返回 error doc；worker 超时/取消/崩溃返回 `OUTCOME_UNKNOWN` **且不落台账**；记录校验失败不落台账。 |
| 输出/证据 | `evidence/s3/verification.json`（43/43）：3 条记录结果 **—/0/0**、call_id/call_1_1…、memory digest 64hex、records_digest、同场景再运行代次 1→2、非法参数 `INVALID_ARGUMENT` 且台账不增；`evidence/s3b/`（前缀场景代次 1→2）；`test_scenario.py`（31：profile 导入/哈希篡改/绑定错/场景校验/plan 签名 TTL/records 对齐/代次 CAS/幂等/台账不可变/observed 时序/无绝对路径/预算截断）。 |
| 参数与范围 | steps ≤20、args/步 ≤8、事件 ≤256/步、scenario ≤8 KiB、records ≤32 KiB、plan TTL 600 s；generation 整数 ≥0。 |
| 依赖与冲突 | 依赖 M-04-23 的隔离执行；台账只追加、不可就地改；`scenario_id` 由 digest 确定性生成；observed 时序（M-04-28）只读台账。 |
| 失败与恢复 | CAS 冲突→`STATE_CONFLICT`，重新 `scenario-list/get` 取当前代；非法参数不落台账；worker 失败 `OUTCOME_UNKNOWN`；引擎错误码原样显示。 |
| 最小验证 | `cd engine && python -m unittest discover -s tests -p "test_scenario.py" -v`；`node --test tests/node/scenario.test.mjs`；`node tools/verify-s3.mjs --with-repo-tests`。 |
| 限制/改进假设 | 台账只追加、无删除/压缩策略；observed 默认取最近更新台账（多场景选择在 S3b 补齐但无持久化）；client `expected_generation` 依赖全局 latestGeneration，跨场景后重跑旧场景可能 CAS 冲突（已知交互限制，非失败）。 |

#### M-04-25 边界打桩与失败传播（硬边界 + 场景可调）

| 项 | 内容 |
|---|---|
| 场景/触发 | 用户想在模拟里验证失败路径：通过 profile 的 `role=stub_control` 接口（如 `set_platform_stub(-5)`）改变边界返回，再调用业务入口观察失败传播与资源影响。触发：用户步骤编辑器加入 `stub_control` 步骤并运行。 |
| 输入与前置 | 接口必须在 profile 内、参数在 min/max 内；profile 的 `event_resources` 只把**实际资源变更**映射到快照对象（`STORE_ROUTE→routes`、`WRITE→simulated_doorbell` 等）；`DOORBELL` 只是把编码值交给平台写之前的通知，不映射资源。 |
| 判断规则 | `stubbed = (interface.role == 'stub_control')`；`result` 为 32 位整数或 null（void→null，UI 显示“结果 —”）；`affected_resources` 由 `event_resources` + 本步 events 推导；失败码按 Wasm 返回值传播（<0 → status error）。 |
| 工具动作与状态 | worker 顺序执行步骤，stub 步标记写台账；业务步看到被 stub 的返回值并按真实 C 逻辑失败；台账记录 events（含 LOCK a 值变化），不改静态图/树/资源视图。 |
| 输出/证据 | `evidence/s3/`：`set_platform_stub(-5)` 步 `stubbed=true`/result —，随后的 `bus_send` **status error/result -5**、该记录**无 WRITE** 事件、`LOCK` 事件 a=1→0；未登记 channel `bus_send(0,48)`→`-2`；非法参数（如 channel=4 超 0..3）由 UI/引擎拒绝且台账不增；`evidence/scenario-sim/README.md` 说明 DOORBELL 不映射资源的原因。 |
| 参数与范围 | stub 返回值受 profile 声明范围限制（Demo `return_code -4095..0`）；打桩只对声明为 `stub_control` 的接口生效，不能任意改内存/代码。 |
| 依赖与冲突 | 依赖 M-04-23/24；observed 时序（M-04-28）把 stub 步呈现为 caller→driver 的 stub 消息；静态预测视图不因打桩改变（运行只在台账/时序/记录体现）。 |
| 失败与恢复 | 越界/非法接口→`INVALID_ARGUMENT` 不落台账；平台失败照实记录但**不**伪造 WRITE；无 stub 能力时 UI 不提供该接口。 |
| 最小验证 | `node tools/verify-s3.mjs --with-repo-tests`（B 场景）；`node --test tests/node/sim-runner.test.mjs`（stub 失败、未知接口、超时）。 |
| 限制/改进假设 | 打桩语义是 Demo 模拟行为，不证明真实设备/驱动的失败语义；无异步中断/竞态注入；不能打桩未在 profile 声明的内部函数。 |

#### M-04-26 回退末尾 N 次与前缀重放（硬边界）

| 项 | 内容 |
|---|---|
| 场景/触发 | 用户想“退回到第 L−N 步并继续”，但必须保证回退后的状态与原来一致，不能伪造历史。触发：工作台打桩面板 `[data-stub-undo-count]`（默认 1）+ `[data-stub-undo]` 用户点击；Host `scenario.undoTail`；引擎 `scenario-undo-plan`/`scenario-undo-record`。 |
| 输入与前置 | 源代次 `G` 必须等于调用方 `expected_generation`；源 steps 长度 L；`1≤N≤L`（允许 N=L→空前缀）；前缀=原步骤 `[0..L-N]`；前缀 `scenario_id` 由 `digest(profile, prefix steps)` 确定性生成（空前缀也合法）；导入轨迹台账**不可重放**。 |
| 判断规则 | Host 在隔离 worker 以同一 profile/module **重放前缀**；引擎逐条核对重放 records 的 `memory_digest` 与源台账前缀 records **完全一致**：一致→`state_digest_verified=true`，发布前缀场景新 generation（records=重放记录 + `undo:{of_scenario_id,of_generation,count,state_digest_verified:true}`）；不一致→`STATE_CONFLICT`（`code="state_digest_mismatch"`，details 给第一条不一致 step_index、expected/actual 前缀 digest）**且不发布**；重放 worker 超时/取消/崩溃→`OUTCOME_UNKNOWN` 不发布；只允许回退末尾 N 步，不支持中间插入/重排。 |
| 工具动作与状态 | undo plan 含源/前缀/expected_prefix/module/TTL；发布的是**前缀场景**的新代次，`scenario_id` 仍是前缀场景；历史只读（不可再回退到已删步骤）；回退成功后 UI 台账切到前缀场景/代次、步骤编辑器同步前缀 steps、observed 选择器刷新并选中、Selection `scenario_id/run_generation` 更新、`call_id=null`。 |
| 输出/证据 | `evidence/s3b/verification.json`（58/58）：`[data-stub-undo-status]`「回退 1 步：前缀重放状态摘要一致（scenario scn_4686… generation 1）」；新台账 step_count=2、`call_1_1/call_1_2` 的 memory_digest 与源一致；`undo.of_*/count/state_digest_verified` 可见；再次运行前缀场景代次 1→2；`count=99` 本地拒绝 + 引擎 `INVALID_ARGUMENT`，台账不变；imported undo→`CAPABILITY_UNAVAILABLE`；`test_scenario.py`。 |
| 参数与范围 | N=1..L；Host `MAX_UNDO_COUNT=200`；plan TTL 600 s；重放 worker 与 M-04-23 同一隔离/超时/内存限制；无中间编辑。 |
| 依赖与冲突 | 依赖台账不可变/CAS（M-04-24）与 memory_digest 语义；只对**可重放模拟台账**可用；导入台账不提供 undo（只保留只读历史）。 |
| 失败与恢复 | digest 不一致→`STATE_CONFLICT/state_digest_mismatch`，保持原台账并显示诊断，不静默改数据；worker 失败→`OUTCOME_UNKNOWN` 不发布；count 越界 UI 本地拒绝 + 引擎 `INVALID_ARGUMENT` 双保险。 |
| 最小验证 | `node tools/verify-s3b.mjs --with-repo-tests`；`cd engine && python -m unittest discover -s tests -p "test_scenario.py" -v`。 |
| 限制/改进假设 | 只支持末尾 N 步；重放依赖模块确定性（memory_digest 是全内存哈希，非事务级回滚）；前缀场景已有历史时新代次可能大于源前缀代次（call_id 不要求跨代相等，契约只核 digest）；异步/IRQ 副作用不可回退。 |

#### M-04-27 轨迹导入（只读台账，硬边界）

| 项 | 内容 |
|---|---|
| 场景/触发 | 先支持“导入已有轨迹”：外部采集的调用序列作为只读证据进入工作台，用于观测时序对照。触发：人工把轨迹 JSON 放入可信 inbox；工作台「导入轨迹」输入 `inbox 内单文件名` + 点击；Host `trace.import`；引擎 `trace-import`。 |
| 输入与前置 | `{schema_version:1,kind:'imported_trace',label,profile_id?,snapshot_id,metadata,steps:[{interface,args,status,result,events,memory_digest?,elapsed_ms}]}`；steps 1..200；interface 名 `^[A-Za-z_][A-Za-z0-9_]{0,63}$`；args ≤8 个 32 位整数；event ≤256/step 且名字/字段合法；`memory_digest` 可选 64hex；文件 ≤64 KiB；`snapshot_id` 必须等于命令行 snapshot；若给 `profile_id` 必须已登记且绑定一致；可选顶层 `async_events`（≤16、必须属于本轨迹 steps 的事件名；见 M-04-33）。 |
| 判断规则 | **导入不执行任何代码**；`scenario_id=scn_<digest(snapshot,steps) 前 12>`；台账 generation 首次 1；同一输入再次导入返回当前代（幂等 operation）；ledger 加 `imported:true`、`source:"imported_trace"`、`label`、`metadata`、`observed:true`、limitations `imported_trace_not_executed_by_host`；records 加 `affected_resources=[]`（无 profile 映射时不伪造）+ limitation `resource_effects_unknown_for_imported_trace`、`stubbed=false`；可选 async 声明记入 ledger 并在 limitations 追加 `async_events_declared`（见 M-04-33）；**不提供 undo/重放**。 |
| 工具动作与状态 | 引擎校验+登记只读台账；Host 只接受 inbox 内普通文件名（≤256，`^[A-Za-z0-9._-]+$`），不接受路径/上传；客户端成功后 observed 选择器出现 imported 台账并选中，显示 `[data-sequence-imported="true"]` 标记/label/limitations，undo 禁用并显示原因。 |
| 输出/证据 | `evidence/s3b/verification.json`（58/58）：`trace-bus-send.json`（3418 B，sha256 `8860df515c39ae26cf62edfc8da74f454bcc3e65677092a7559aaf6d05d47e06`）导入为 `scn_982682c88e20` generation 1，imported/label/source/observed/limitations、幂等；observed 20 消息含 `bus_send(1,48)`/DOORBELL/WRITE/返回 0；imported undo 被拒（`CAPABILITY_UNAVAILABLE`）；`test_scenario.py`。 |
| 参数与范围 | steps 1..200（轨迹文件；运行场景 steps ≤20 是另一约束，见 M-04-24）；args ≤8；events ≤256/步；文件 ≤64 KiB；输入名 ≤256 且只允许普通文件名。 |
| 依赖与冲突 | 与 M-04-26 冲突处理：导入台账不可 undo、不参与 Wasm 重放；与 M-04-28 observed 兼容（消息按事件/status 推导，但保留 imported 声明）。 |
| 失败与恢复 | 校验失败→引擎错误码，不落台账（除幂等返回）；名称非法/越界→Host/引擎拒绝；导入台账只读、不可修改。 |
| 最小验证 | `node tools/verify-s3b.mjs --with-repo-tests`；`cd engine && python -m unittest discover -s tests -p "test_scenario.py" -v`。 |
| 限制/改进假设 | 导入轨迹无法校验外部采集的真实性/时钟；资源影响未知（`[]`+limitation）；无 undo/重放；不做文件上传（只从可信 inbox 按名读取）。 |

#### M-04-28 运行观测时序（observed，硬边界证据分级 + 展示可调）

| 项 | 内容 |
|---|---|
| 场景/触发 | 用户要看“实际运行顺序”而不是静态预测。触发：时序视图 observed 模式；客户端 `view.sequence {mode:'observed', scenario?}` → 引擎 `view-sequence-observed`；S3b 起有台账场景选择器（`[data-code-view="sequence-scenario"]`，默认最近更新台账）。 |
| 输入与前置 | 需要已有 observed 台账（M-04-24/26/27）；`scenario` 可选，必须存在；静态模式 `mode:'static'` 不走台账。 |
| 判断规则 | 消息序=台账 steps 顺序：每步 call → 该步 events（event/access，含平台写边界）→ return；`kind=error` 当 `status=error` 或 `result<0`；参与者由 profile interfaces 的 role/entry 与 `event_resources` 分类（`stub_control` 步为 caller→driver 的 stub 消息，from=caller）；`observed:true`、`warning:null`、`limitations:['observed_wasm_simulation_not_real_device']`；imported 台账消息带 imported 标记但**仍不得**改写成真实运行；无台账→`NOT_FOUND`；静态模式保持 `[data-sequence-warning]` + `observed=false`。 |
| 工具动作与状态 | 引擎只读台账生成 DTO；client 渲染（`[data-sequence-observed="true"]`、`[data-sequence-message][data-message-kind][data-observed="true"]`、`[data-scenario-id]`、代次/digest、`[data-sequence-imported="true"]`）；Selection 追加 `scenario_id/run_generation/call_id`；静态图/树/资源视图不因运行改变。 |
| 输出/证据 | `evidence/s3/`（observed 20 条 call/return/access/event，含 `bus_send(1,48)`、DOORBELL/WRITE、平台/设备边界、返回 0；切回 static `observed=false`）；`evidence/s3b/`（多场景切换：prefix 6 消息 / imported 20 消息；`[data-sequence-imported="true"]`；Selection 跟随）；`test_scenario.py`、`tests/node/client.test.mjs`。 |
| 参数与范围 | 消息数受台账 steps/events 限制（≤20 步、≤256 事件/步）；无分页参数；`scenario` 有界标识。 |
| 依赖与冲突 | 依赖 M-04-24/26/27；与静态预测是**两种证据等级**，不得混写：observed 只来自台账，静态预测只来自快照；imported 台账的标志不得丢失；异步声明（M-04-33）只给消息加 `async` 标记与顶层 `async_events`，不改变消息序/观察语义。 |
| 失败与恢复 | 无台账→observed 不可选 + gap；请求的 scenario 不存在→引擎 `NOT_FOUND`；worker/记录失败不会产生半截台账（M-04-24）。 |
| 最小验证 | `node tools/verify-s3.mjs --with-repo-tests`；`node tools/verify-s3b.mjs --with-repo-tests`；`cd engine && python -m unittest discover -s tests -p "test_scenario.py" -v`。 |
| 限制/改进假设 | 只记录有序步骤台账，**没有异步/IRQ 因果细化**（M-04-33 仅声明式标记，不推断中断发生/完成）；observed 默认最近台账、选择无持久化；`elapsed_ms` 是 Wasm 调用耗时不是设备时延；Wasm 模拟不证明真实设备行为。 |

#### M-04-29 AI 归纳（Agent 写入/签名/失效，硬边界 + 内容 skill 可调）

| 项 | 内容 |
|---|---|
| 场景/触发 | 详情面板需要 ≤500 字 AI 归纳（CW-09）。**插件不产生正文**：由 Agent（模型）经 DSH 工具 `code_summary` 写入，UI 只读展示并标来源。触发：Agent `code_summary action=put/get`；UI `view.summary` 懒加载（选中变化防抖 ≤200ms）。 |
| 输入与前置 | 作用域 `workspace+snapshot+subject`；subject 类型 `function/group/entry`（entry 指入口函数详情的独立归纳，可与 function 归纳并存）；同一 subject 只保留最新一条（修订覆盖，无历史代际）；payload：`text` 1..500 Unicode 码点且禁止控制字符；`facts` ≤32 条 `{kind ∈ evidence/node/selection, ref ≤512 安全字符}`；`inference_labels` ≤8，枚举 `from_static_structure/from_source_text/may_speculative/from_observation`（**仅当有运行台账时才允许 `from_observation`**）；`generator {kind ∈ agent/user, ref, model_ref?}`（不记录密钥/路径）。function subject 必须存在；group subject 非函数不做存在性校验但记 limitation `subject_existence_not_verified`。 |
| 判断规则 | Host 先校验 text/facts 等有界字段并组装 base64 payload；引擎再校验 schema/长度/枚举/subject，写**签名 JSON**（复用 state 签名）并记录该快照 `graph_sha256`；读取时与当前核验快照 graph sha 比较：一致→`stale:false`；不一致（重导入/内容变化）→`stale:true`，仍返回文本但 UI 必须显示“基于旧快照，待复核”并给 `limitations:['summary_stale_against_current_snapshot']`。不写入源码/快照。 |
| 工具动作与状态 | `summary-put`/`view-summary`；`view.status` capabilities `ai_summary_store:true` 而 `ai_summary:false`（插件不自动生成）；client 详情面板 AI 归纳区展示 `[data-ai-summary-text]`、facts、generator、generated_at、labels、`[data-ai-summary-stale]`；无记录显示 `[data-ai-summary-gap]`（“AI 归纳未生成（Agent 可通过 code_summary 写入）”），不伪造；竞态时丢弃过期响应；归纳不写入 Selection。 |
| 输出/证据 | `evidence/ai-summary/verification.json`（49/49）：未写入 gap→真实引擎 `summary-put`（模拟 Agent，约 120 字、facts 含真实 `e_…`、generator `{agent, verify-summary}`、labels `from_static_structure`）→UI 显示原文/facts/generator/generated_at/stale=false；501 字→`LIMIT_EXCEEDED`、控制字符/非法 facts（`../etc/passwd`）→`INVALID_ARGUMENT`，三次均被拒且原归纳未被覆盖；group subject put/get 成功并带 limitations；Cordis `code_summary`（7 工具）真实 put/get + dispose/二次挂载缓存保留 TAP 1/1；回归 S1/S2a/S2b/S3a/S3b + console=0、无绝对路径；`test_summary.py`（9）。 |
| 参数与范围 | text ≤500 码点；facts ≤32；labels ≤8；generator ref 有界；无历史版本（历史走学习记录/快照）。 |
| 依赖与冲突 | 依赖 M-04-08/09（graph sha 失效基准）、M-04-24（判断是否有运行台账以允许 `from_observation`）、M-04-19（view.summary RPC）；与 M-04-14 的“用户/Agent 身份”一样，`generator.kind/ref` 是**声明**而非密码学认证。 |
| 失败与恢复 | 非法 put→引擎错误码，不覆盖原文；快照变化→stale 标记；无记录→gap；“插件不调用模型”是硬边界——UI/插件不得自行生成正文。 |
| 最小验证 | `node tools/verify-summary.mjs --with-repo-tests`；`cd engine && python -m unittest discover -s tests -p "test_summary.py" -v`；`node --test tests/node/view-rpc.test.mjs`（`view.summary`）。 |
| 限制/改进假设 | 语义质量（是否把候选/未知写成确定）**不做评分**，只校验结构/标签/失效；stale 只比较 graph sha（不单独核源码摘要，快照重导入即失效）；无历史代际；`from_observation` 仅靠“有台账”判断，不校验台账与 subject 的关联强度；归纳的正文本内容质量需独立评审。 |

#### M-04-30 性能实测口径与首屏预算（测量机制，非产品运行路径；**已验收：首屏达标**）

| 项 | 内容 |
|---|---|
| 场景/触发 | 设计 §5/A11 要求可复现的性能证据且不允许拿未测数字当通过。触发：`node tools/verify-perf.mjs --with-repo-tests`（人工/验收用，不在产品运行路径）；最终 run 含批量首屏/`coupling_aux` 一致性与 perf-regressions。 |
| 输入与前置 | 合成 Atlas 0.1 fixture：`tools/perf/make-synthetic-graph.mjs` 生成 500 节点/800 边与 2000 节点/10k 事件的合法 envelope（`graph_hash=sha256(graph.json)`）、经真实引擎 `snapshot-import` 校验；隔离 dsh-web + `tools/perf-probe.cjs`；`tools/firstscreen-consistency.mjs`（独立隔离 state + 真实 CLI/RPC）；预算来自契约 §2 拟验收基线（500/120/32 ms），只记录不调整。 |
| 判断规则 | 口径：首屏 p95=dsh-web 点击入口/快照→视图根 `data-state=ready`（含 RPC+投影+渲染），冷/热各 20；跨视图定位 p95=coupling 资源→函数高亮、tree→file 行高亮，20；拖动反馈=pointermove→下一 rAF，20；引擎 CLI 冷投影（子进程）与 in-process 投影各 20；2000/10k 分片/搜索/截断各 ≥5；另跑批量首屏一致性 8/8 与回归 5 项。记录 p50/p95（nearest-rank）、机器信息、覆盖/截断/失败数；**不满足如实记录、不调整预算**；夹具不可测项记 `in_scope_not_verified` 且不伪造样本。 |
| 工具动作与状态 | 只读测量：写 `evidence/perf/verification.json`（原始样本/机器信息/p50/p95/预算判定/batch 使用/一致性/回归/not_verified）+ README + commands.log；仅允许只读 `performance.mark`；不改生产代码、不联网（仅本机回环）。 |
| 输出/证据 | 最终 run（2026-11-15T14:33–14:38 UTC，duration 270,039 ms≈270.7 s）：**25/25 检查全绿、0 失败**（13 核心 + 5 batch/一致性 + 5 回归 + Demo + Node = 25）；layers `{engine,dsh_host,fixture,demo_observed}` 全 true；`ok=true, verified=true`；**首屏 hot p50/p95 = 328–330/382–387 ms ≤500 ms ✅**（历史：T27 基线 1078/1141 → T28 优化 646/704 → T33 批量首屏无 aux 455/527 → T37 `coupling_aux` 后 328–330/382–387）；coupling p50/p95=2/3 ms（预算 120 ✅）；引擎 CLI entries p50/p95 133/139 ms、e2e/coupling/tree p95 142/147/141 ms；in-process 热 p50 22.0/24.6/22.8/22.7 ms；2000/10k e2e ready 1413 ms（入口 1600）、搜索 p50/p95 1/2 ms、事件序列 4/4 ms；`data-first-screen` 20/20 样本 60 处全部 batch、fallback=0。证据：`evidence/perf/verification.json`（116,133 B sha256 `e350ed99…`）、`README.md`（6,554 B sha256 `f2d39214…`）、`first-screen-consistency.json`（38,950 B sha256 `8bb859f9…`）、`commands.log`（sha256 `a62f8942…`）。 |
| 参数与范围 | 预算常量在 `tools/verify-perf.mjs BUDGETS={first_screen_ms:500, cross_view_ms:120, drag_feedback_ms:32}`；cold UI 默认关闭（`PERF_COLD_SAMPLES=20` 可显式开启）；`RV_SKIP_TREE/RV_SKIP_DRAG` 等夹具限制开关；合成图明确标 SYNTHETIC，不代表真实仓库。 |
| 依赖与冲突 | 依赖 M-04-19/20/21（真实 dsh-web 与端点）与 M-04-22（批量首屏+aux）；性能链路：T27 基线 1078/1141 → T28 并行/预取/缓存 646/704 → T33 批量首屏 455/527 → T37 `coupling_aux` 328–330/382–387；回归包（S3b/S3a/S2b/summary + console/Demo/Node）不得因性能改动回退。 |
| 失败与恢复 | 预算失败→历史 run 曾 `ok=false` 并如实记录；本轮全部预算项通过（drag 记 in_scope_not_verified 不计 fail）；可测项缺失→`in_scope_not_verified` 而非假样本；回归失败→整批 fail。 |
| 最小验证 | `node tools/verify-perf.mjs --with-repo-tests`（当前预期 **25/25 全绿**，duration≈4.5 min；不得为变绿调预算）。 |
| 限制/改进假设 | 合成图只作规模/截断证据，不代表真实仓库或 Linux/Kbuild；剩余 not_verified 4 项：cold UI 20 冷样本（一次性 token，不伪造）、tree→file 行高亮（合成夹具无 file evidence）、拖动反馈（无可拖边目标）、2000/10k UI「已截断」文本（本轮未显示，加载/搜索/事件已实测）；跨参考机预算校准为 out_of_scope；测量基于隐藏窗口 + DOM 计时，非像素基准。 |

#### M-04-31 S4 Linux 可移植性探测与不可声明项（待验证门禁，只记录）

| 项 | 内容 |
|---|---|
| 场景/触发 | S4 目标验证需要 Linux 环境，但当前只有 Windows + WSL2；先如实探测哪些层可移植，避免把“能跑”写成“门禁通过”。触发：`evidence/s4-feasibility/`（2026-11-15，WSL2 Ubuntu 20.04 / kernel 6.6.87.2-microsoft-standard-WSL2、Python 3.8.10、Node v22.22.1；仓库经 `/mnt/e/...` 只读挂载；未联网、未改真实 `~/.dsh`）。 |
| 输入与前置 | 本机 WSL2；无 Linux 内核源码/compdb/生成头、无 Atlas 0.8 Linux runtime、无复核标注数据。 |
| 判断规则 | 只记录实际执行结果，不推断门禁通过：JS 契约套件、真实 Wasm worker、引擎 CLI status/import、引擎 unittest、Windows 构建快照导入分别记录 ok/失败原因；不可用能力进 `in_scope_not_verified`；`verified=false` 明确输出。 |
| 输出/证据 | `evidence/s4-feasibility/verification.json`（`ok=true, verified=false`）：Linux Node 契约 **164/164 pass**；隔离 Wasm worker（真实 Demo `bus.wasm`）**8/8 pass**；引擎 CLI `workspace-import`/`status` 可运行（status exit 0、`valid=true`、fresh、无 `/mnt/e` 或 state 路径泄漏；重复 import `STATE_CONFLICT` CAS 正确）；引擎 unittest **FAILED**（Ran 309（当时套件规模），255 errors，因 Python 3.8 不满足 `>=3.11`、helpers 用 3.10+ `Path.write_text(newline=)`）；Windows 构建的 Atlas 快照被拒绝（`analysis_manifest.workspace_roots does not identify this registered workspace`——manifest 绑定 Windows 工作区根，Linux 需 Linux 构建的同源快照）。 |
| 参数与范围 | 仅本机 WSL2 环境事实；日志：`linux-node-suite.log`、`linux-host-worker.log`、`linux-engine-cli.log`、`linux-engine-unittest.log`。 |
| 依赖与冲突 | 与 `source.lock.json` 的 `s4_feasibility_probe` 一致；不能用于支持任何 Kbuild/CFG/复核/OS 出口声明。 |
| 失败与恢复 | 失败项不修数据：要么补外部前置（固定 Linux 目标 Python≥3.11、构建工具链、Linux 构建 Atlas 快照、内核源码/compdb/生成头、复核数据），要么继续保持未验证。 |
| 最小验证/复现 | 见 `evidence/s4-feasibility/README.md`：Linux 上 `node --test tests/node/*.test.mjs`、`node --test tests/node/sim-runner.test.mjs`；Python 3.11+ 环境再跑 `cd engine && python3 -m unittest discover -s tests`；Atlas 快照必须在目标 Linux 上构建。 |
| 限制/改进假设 | 不可声明：真实 Linux/Kbuild 与生成头、native CFG/locks/aliases、Atlas Linux runtime、复核 precision/recall、OS 出口认证、Linux 上完整引擎套件（≥3.11）。这些需要外部前置，当前环境不具备。 |

#### M-04-32 分层证据与隔离 dsh-web 验收门禁（硬边界：证据纪律）

| 项 | 内容 |
|---|---|
| 场景/触发 | 插件要在真实 Host/浏览器中验收，且不能让“结构测试通过”冒充“产品行为通过”。触发：各阶段 `node tools/verify-<stage>.mjs --with-repo-tests`。 |
| 输入与前置 | 本机 **pinned** DSH 基线（`DeepSeek Harness.exe` SHA256 `7ae939b5…`、`app.asar` SHA256 `e1b6f25f…`、dsh `0.2.1-rc.5`、内嵌 Node 24.21.0/Electron 44.7.0、6 个已核 seam 文件）——版本/SHA 不符即失败；隔离 `DSH_HOME`（`scratch/readonly-home/home`，非真实 `~/.dsh`）与隔离 web profile（bundles=base+web-app+`@local/dsh-code-reader`）；隔离 bootstrap + 真实 Python 3.11.4；本机 Electron 仅作 Chromium 探针（不随包分发）。 |
| 判断规则 | 每次运行重新生成 `evidence/<stage>/verification.json`（layers/checks/not_verified/commands/limitations），以**三层**（`demo_observed`/`atlas_snapshot`/`dsh_host`）分别记录、互不冒充；无 cookie 直连 `/code-view` 必须 401；Chromium 探针必须 console error=0、无绝对路径、按 DOM 钩子断言并截图；`in_scope_not_verified` 与 `out_of_scope_not_verified` 分开、不隐藏；被后续阶段正当取代的旧断言（如 S2a 的 `gapsOriginal`、打桩占位）显式记录 ignored/superseded，不静默通过。 |
| 工具动作与状态 | 只读验收：不改插件实现、不联网（仅本机回环 HTTP）、不写真实 `%USERPROFILE%\.dsh`、不重启桌面宿主、不 git 提交；探针窗口 `opacity=0 + showInactive` 截当前 composited 帧，截图前滚动/invalidate/连拍；token redact；失败保留 `scratch/<stage>/*-probe.json` 与日志供复核。 |
| 输出/证据 | S1..AI 6 阶段 + 性能 **25/25** 均 `ok=true, verified=true`：`evidence/readonly-slice/` 26/26、`five-views/` 37/37、`s2b/` 41/41、`s3/` 43/43、`s3b/` 58/58、`ai-summary/` 49/49；`evidence/perf/` **25/25 全绿**（hot p50/p95 328–330/382–387 ms ≤500 ✅；4 项 not_verified 如实）；每阶段 `host-runtime.tap` 1/1；`commands.log` 记录实际命令/exit code/cwd；`evidence/plugin-install-verification.json` 记录安装注册。 |
| 参数与范围 | 固定宿主 SHA/版本、固定隔离路径（Windows 本机；换机需同步调整，门禁会立即暴露差异）；探针超时（每视图 ≤45 s、整体 360–420 s）与截图口径固定；不联网。 |
| 依赖与冲突 | 依赖 Host rc.5 实际接缝（M-04-19）；与开发机真实桌面宿主隔离——**桌面宿主热更新未验证**（验收用独立 profile）；`demo_observed` 层依赖 Demo Wasm/JS 行为，但不证明真实设备。 |
| 失败与恢复 | 门禁失败→整批失败（不继续产出“通过”）；探针失败→保留中间 JSON/日志；`not_verified` 不得改写为通过；阶段回退保留旧证据目录不覆盖（S1..S4-prep 各自目录未改动）。 |
| 最小验证 | 逐阶段 `node tools/verify-readonly.mjs --with-repo-tests`、`verify-five-views.mjs`、`verify-s2b.mjs`、`verify-s3.mjs`、`verify-s3b.mjs`、`verify-summary.mjs`、`verify-perf.mjs`（均带 `--with-repo-tests`）。 |
| 限制/改进假设 | 探针是时序观测而非确定性像素基线；宿主首次运行浮层由探针关闭并记录；证据固定 Windows 路径/SHA；Chromium 探针使用本机通用 Electron（测试仪器，非产品依赖）；验证工具本身也应被评审（本轮只做只读使用）。 |

#### M-04-33 异步/IRQ 事件边界（声明→校验→observed 标记→UI；不推断中断发生；硬边界 + 展示可调，**已验收**）

| 项 | 内容 |
|---|---|
| 场景/触发 | Demo 的 `bus_irq` 会触发平台 IRQ 事件，原 observed 时序把 IRQ 当普通 event，看不出“异步完成/中断触发”；设计 A08/§3 要求异步完成单独显示事件触发。本增量给事件加**声明式异步边界标记**，不改静态投影、不改台账顺序/记录语义。触发：`sim-profile-import`/`trace-import` 的 `async_events` 声明；`view-sequence-observed` 与工作台 observed 时序。 |
| 输入与前置 | Profile 可选顶层 `async_events`：事件名数组 ≤16、去重、每个必须是 `trace.events` 中的事件名；缺省空=无异步事件。导入轨迹可选顶层 `async_events`：≤16、必须属于该轨迹 steps 里出现的事件名；缺省空。profile 签名/摘要覆盖该字段（重导入产生新 digest）；rev1 profile/trace 缺省为空=旧行为（S3a/S3b 证据有效，rev2 仅新增可选字段）。 |
| 判断规则 | 校验：非数组/超 16/重复/未知事件/非字符串→`INVALID_ARGUMENT`；profile 与 trace import **均拒绝且不写**（profile 数/台账数不变）。observed：执行台账的 async 声明从 ledger 绑定的已登记 profile 解析；导入台账从自身 `async_events` 解析（rev1 导入无声明保持 S3b 形状）；对应 event 消息加 `async:true`（其余消息 false/不含），顶层返回 `async_events`（≤16，供图例）；call/access/return 消息不受影响。**`async:true` 只表示该事件在 profile/轨迹中被声明为异步触发，不推断硬件中断已发生/完成**。 |
| 工具动作与状态 | 引擎：profile/轨迹导入校验+投影；`view-sequence-observed` 在台账上生成标记，不写回台账/源码。Host：`scenario.*`/`trace.import`/`view.sequence observed` 原样透传。client observed 时序给异步事件加 `[data-sequence-async="true"]`、`[data-sequence-async-chip]`“异步”、`[data-sequence-async-note]`“异步：由中断/完成事件触发，仍来自已执行或导入的台账”；static 模式与 rev1 导入台账无标记。 |
| 输出/证据 | `node tools/verify-irq.mjs --with-repo-tests` → **34/34 全绿**（layers `{atlas_snapshot,dsh_host,demo_observed}` 全 true、`ok=true, verified=true`、`in_scope_not_verified=0`、`out_of_scope=5`、duration_ms≈164,131）；真实 Wasm 路径（无 fallback）：rev2 profile（`evidence/scenario-sim/inbox/sim-profile.json` sha256 `1c9ae155…`）真实导入 → `reset→bus_register(1)→bus_irq()` 台账 records `[null,0,0]`、`bus_irq` 真实产生 `IRQ`（`scn_7b5258892e19`）；observed/`view.sequence` 顶层 `async_events:["IRQ"]`、IRQ 消息 `async:true`（label `IRQ: write irq_count`）；Chromium 探针 `[data-sequence-async="true"]`=1、chip“异步”、note 文案、console=0、无绝对路径、static 0 标记、rev1 导入 0 标记；非法 async_events（duplicate/unknown/non_array/>16）对 profile 与 trace import 均 `INVALID_ARGUMENT` 且不写；带声明导入轨迹 limitations 含 `async_events_declared`。回归 S3b/S3a(residual=[])/S2b/summary + Node 195/195 + Demo 8/8。证据：`evidence/async-irq/verification.json`（46,736 B sha256 `38080909…`）、`README.md`（8,307 B sha256 `5914291e…`）、`async-irq.png`（163,779 B sha256 `36907e95…`）、`commands.log`（6,398 B sha256 `bf493784…`）。 |
| 参数与范围 | `async_events` ≤16、去重、必须来自事件表；profile rev1/rev2 兼容；无新增静态投影/台账字段语义（导入台账额外 `async_events` + limitation）；DOM 钩子只读。 |
| 依赖与冲突 | 依赖 M-04-23/24/27/28（profile/台账/导入/observed）；与静态预测互斥（static 不显示 async）；rev1 行为不变；`async` 不升级任何证据等级/certainty。 |
| 失败与恢复 | 非法声明→`INVALID_ARGUMENT` 且不写 profile/台账；执行台账的 async 声明不冻结在台账里（按当前已登记 profile 解析），导入台账按自身声明；缺省无声明=旧行为（S3b）。 |
| 最小验证 | `node tools/verify-irq.mjs --with-repo-tests`（34/34）；`cd engine && python -m unittest discover -s tests -p "test_scenario.py" -v`（async 校验/observed/导入）；`node --test tests/node/client.test.mjs`（async DOM）；回归 `verify-s3`/`verify-s3b`。 |
| 限制/改进假设 | 只做**声明式边界标记**：不推断真实硬件 IRQ 因果/中断完成、不建模跨进程异步调度/时序竞态；真实设备/外部轨迹采集、rev1 历史证据重跑、超大 payload async 变体为 out_of_scope；rev2 fixture sha 固定，变更需重跑工具；本版不写“异步因果已被证明”。 |

---

## 5. 硬边界 vs skill 可调（改 skill 不能越过的项）

| 边界 | 强制位置 | 为什么不能靠 skill/prompt |
|---|---|---|
| 读取根/签名引用/绝对路径 | `state.py`/`scope.py`/`source.py`；`/code-view` 输入校验 | 模型无法传绝对路径；MAC/realpath 在引擎侧，提示层无法伪造 |
| 快照可信（envelope/hash/schema/workspace_roots） | `atlas.py`/`snapshot.py` | 伪快照不能因“用户说可以”通过；目标 repo provenance 强制 |
| 证据等级/certainty 不升级 | `paths.py`/`bindings.py`/`views.py`/`five_views.py` | text 最多 source_text；derived/abi_bridge 最多 may；exact 只来自编译器证据 |
| pending/身份规则 | `learning.py`/`records.py` | Agent 不能替用户声称预测/观察/理解（残余信任边界已披露） |
| 编译/Atlas 执行阻断 | `service.py`（`run`） | 无隔离 execution profile 时任何提示都不能裸跑 |
| 工作台 RPC 准入/无绝对路径/固定方法 | `lib/http-rpc.mjs`/`lib/view-service.mjs` | 连接准入在 Host；插件不向前端回传内部错误文本/路径 |
| 五视图确定性/预算/缺口 | `views.py`/`five_views.py` + 契约 | 缺失层必须 gap，不得用空数组伪装“无关系”；预算/截断由引擎执行 |
| 场景执行只经可信 profile + 隔离 worker + 用户触发 | `scenario.py`/`lib/sim-runner.mjs`/`lib/sim-worker.mjs` | 模型没有执行入口；worker 无 fs/网络/其他 import；模块来自引擎签名副本 |
| 台账只追加/代次 CAS/不可变 generation | `scenario.py` | 提示层无法伪装 generation 或就地改历史 |
| 回退必须前缀重放 + memory_digest 逐条核验 | `scenario.py` | 不能“声称回退成功”；不一致 `STATE_CONFLICT` 不发布 |
| 轨迹导入只读、不执行 | `scenario.py`/`lib/scenario-service.mjs` | 外部轨迹不能作为“已执行”证据；无 undo/重放 |
| 异步/IRQ 只做声明标记 | `scenario.py`（profile/轨迹校验、observed）+ `bundle/client.js` | `async:true` 只表示该事件被声明为异步触发，**不推断**硬件中断已发生/完成；skill/UI 不得写成运行事实 |
| AI 归纳由 Agent 写入、签名、绑定 graph sha、无模型出口 | `summary.py`/`lib/tools.mjs`/`lib/view-service.mjs` | 插件不得自动生成正文；快照变化必须 stale；`from_observation` 需台账 |
| 性能/门禁声明 | `tools/verify-perf.mjs`/`evidence/*/verification.json` | 未达标必须 `ok=false`；skill/文档不得把未验证写成通过 |
| 分层证据不互相冒充 | 验收工具 + 证据 JSON + 后端/UI 标签 | `demo_observed`/`atlas_snapshot`/`dsh_host` 各自标注；`observed`（台账）不得冒充静态 exact |
| 导出/记忆出口 | `records.py`/`cli.py` | 只写本地 state，不上传、不自动写 05 |

**skill 可以调整**（不涉及上述硬边界）：问什么/何时问、阅读顺序、每次讲多少、何时登记/重登记、查询范围与更小 glob/预算、何时建记录/复盘/写 AI 归纳（内容须基于证据）、如何呈现证据分级与 Next Action、何时停止。**skill 不能**：绕过 scope、把文本当编译事实、把 may/候选说成 exact、代填用户预测/观察、执行 `run`/场景（模型无执行入口）、伪造 observed/台账/归纳、声称 Linux/Kbuild/CFG/性能门禁通过、删除 `not_verified`。

---

## 6. 可调参数与范围

| 参数 | 默认 | 范围 | 谁能改 / 影响 |
|---|---|---|---|
| find 扫描文件/字节/命中 | 128 文件 / 32 MiB / 200 | 单次固定预算 | 引擎；超限 `next_cursor`，不静默 |
| source read 区间 | — | ≤16 KiB/次 | 引擎；超限 `INVALID_ARGUMENT` |
| path budget / max_depth | 2000 / 30 | 1..10000 / 1..100 | 工具参数（skill 可调）；超限 `truncated` |
| relation budget / max_items | 2000 / 200 | 1..10000 / 1..2000 | 工具参数；截断披露 |
| record generation | — | CAS 精确匹配 | 引擎；冲突 `STATE_CONFLICT` |
| 插件 timeoutMs | 120000 | 1000..600000 | 人工配置；超时 `OUTCOME_UNKNOWN/4` |
| bootstrap scope_generation | 1 | ≥1 | 人工；变化使旧签名引用 `SCOPE_DENIED` |
| `/code-view` 请求/响应 | 16 KiB / 512 KiB | 固定 | 插件硬边界；超限固定错误信封 |
| 五视图预算 | coupling 100/400、tree 500/8、e2e 120/240、fileTree 2000、fileRead 64 KiB/2000、sequence 200 | 固定 | 引擎；超限 `truncated` |
| RPC 输入上限 | workspace/snapshot ≤128、entry ≤512、repo/path 有界 | 固定模式 | Host；拒绝未知字段/路径穿越 |
| `view.firstScreen` 响应/`coupling_aux` | ≤480 KiB（含 aux）；sizes 4 键；view 5 枚举 | 固定 | 引擎；超限 `LIMIT_EXCEEDED`（附 sizes），client 回退单端点 |
| 场景 steps / args / 参数总量 / JSON | 20 / 8 / 4 KiB / scenario 8 KiB、records 32 KiB | 固定 | 引擎；超限 `LIMIT_EXCEEDED`/`INVALID_ARGUMENT` |
| `async_events` 声明 | 空 | ≤16、去重、必须属事件表（profile/导入轨迹） | 引擎校验；非法 `INVALID_ARGUMENT` 且不写 |
| worker 超时 / 内存 | 10 s（≤30 s）/ 64 MB；Host 总 15 s | 固定 | Host/引擎；超时 `OUTCOME_UNKNOWN`，不落台账 |
| undo count | 1 | 1..源步数（Host ≤200） | UI 输入 + 引擎校验；越界拒绝 |
| summary text / facts / labels | 500 码点 / 32 / 8 | 固定 | Host+引擎双重校验；超限 `LIMIT_EXCEEDED` |
| 组数 / 接口候选 | ≤50 / ≤100 | 固定 | 引擎；超限截断 |
| 首屏预算 | 500 ms | 拟验收基线，不调 | 验收工具；当前 hot p50/p95 328–330/382–387 ms 达标（25/25 全绿），未调整预算 |
| 性能冷样本 | 关闭（cold UI 记 not_verified） | `PERF_COLD_SAMPLES=20` 可开启 | 验收工具；一次性 token 限制，不伪造样本 |
| AI 归纳 stale 判定 | graph sha | 快照重导入即变 | 引擎；stale 仍返回但必须显示待复核 |

---

## 7. 规则间依赖

1. `scope_generation`（M-04-01）→ 所有签名引用有效性（M-04-05/06/07），以及 `path_ref/evidence_ref` 复核（M-04-19/20）。
2. `source_manifest_digest`/`BuildIdentity`（M-04-03/04）→ 快照 freshness（M-04-09）、记录 resume（M-04-15）与 AI 归纳 stale（M-04-29 的 graph sha 是快照级、BuildIdentity 是构建级，二者不互替）。
3. `coverage.capabilities`（M-04-08）→ 五视图可投影层（M-04-20）与关系查询可用性（M-04-12）；`cfg=unsupported` 时端到端图只能给 `branch_conditions_partial` gap。
4. `binding status`（M-04-11）→ 跨仓路径能否产出 `abi_bridge`（M-04-10）。
5. 快照绑定（M-04-08/09）→ 模拟 profile 的 workspace/variant/repo/snapshot 绑定（M-04-23）→ 台账（M-04-24）→ observed 时序（M-04-28）与拟归纳的 `from_observation` 许可（M-04-29）。
6. 台账 generation/CAS/不可变（M-04-24）→ 回退前缀发布（M-04-26）→ observed 多场景选择（M-04-28）；导入轨迹（M-04-27）不参与重放。
7. `event_resources` + events 推导（M-04-23/25）→ `affected_resources`（M-04-24）→ observed 消息中的资源/边界（M-04-28）。
8. 记录 generation/CAS（M-04-13）→ 事件失效与 resume 的“不覆盖旧修订”（M-04-14/15）。
9. `run` 阻断（M-04-16）→ 本版不存在“实验已执行”的真实来源，因此记录 observation 只能是 pending（M-04-14）——**受控 Wasm 模拟台账不是 learning 记录的 execution backend**，二者不互相充数。
10. 首屏性能（M-04-30）→ M-04-22 批量首屏（已验证）：首屏由 4 个 RPC 合并为 1 次批量 RPC + `coupling_aux`，hot p50/p95 328–330/382–387 ms ≤500；批量与单端点 DTO 必须逐字段一致（M-04-20 的预算/证据等级不变），失败回退单端点。
11. `coupling_aux`（M-04-22）→ coupling 视图/左栏资源 rail 与单独 `view.coupling` 同源；sizes 4 键含 aux、总预算 480 KiB；client 消费后跳过单独 coupling RPC（0 次），aux 缺失/格式错回退。
12. 异步声明（M-04-33）→ profile/导入轨迹 `async_events` → observed event 消息 `async` 与顶层 `async_events`；只影响标记，不改台账顺序/静态投影；rev1 无声明保持 S3b 旧行为。

---

## 8. 最小验证清单（改 skill/机制后至少重跑）

```bash
# 引擎（合成 fixture + 真实 Atlas fixture；当前 318 tests）
cd engine && python -m unittest discover -s tests -v

# 插件 Host/Client 合同（当前 195 tests）
node --test tests/node/*.test.mjs

# Demo 行为对照（Wasm 模拟观测，8/8）
node --test demo/code-view/demo.test.cjs

# 阶段隔离 dsh-web 黑盒验收（各自产出 evidence/<stage>/verification.json）
node tools/verify-readonly.mjs --with-repo-tests        # S1 只读切片（26/26）
node tools/verify-five-views.mjs --with-repo-tests      # S2a 五视图（37/37）
node tools/verify-s2b.mjs --with-repo-tests             # S2b 组/接口库/子流程（41/41）
node tools/verify-s3.mjs --with-repo-tests              # S3a 场景/打桩/台账/observed（43/43）
node tools/verify-s3b.mjs --with-repo-tests             # S3b 回退/轨迹导入/多场景（58/58）
node tools/verify-summary.mjs --with-repo-tests         # AI 归纳（49/49）
node tools/verify-perf.mjs --with-repo-tests            # 性能实测（当前 25/25 全绿；首屏 hot p50/p95 328–330/382–387 ≤500 ✅）
node tools/firstscreen-consistency.mjs                  # 批量首屏/aux/sizes 一致性（8/8；verify-perf 内含）
node tools/verify-irq.mjs --with-repo-tests             # 异步/IRQ 事件边界（34/34；真实 Wasm IRQ + dsh-web async 标记）
```

对照关系：CL-001（M-04-01/02/03/05/06/07）、CL-003（M-04-08/09）、CL-004（M-04-10/11/12）、CL-005（M-04-13/14）、CL-006（M-04-15）、CL-009（M-04-16/17）、CL-007（M-04-18 文档条款）；CL-VIEW-T1（M-04-19、部分 20）、CW-T2（M-04-20/21）、CW-T3（M-04-23..28）、CW-T4A（M-04-29/30/31、M-04-32、M-04-33 异步/IRQ）；S4 目标门禁仍不在此清单的“通过”含义内（M-04-22 批量首屏、M-04-33 异步/IRQ 已验收）。

---

## 9. 失败与恢复总表

| 失败 | 输出 | 恢复 |
|---|---|---|
| bootstrap 缺失/非法 | `CONFIG_UNAVAILABLE`/`INVALID_ARGUMENT` | 人工 `bootstrap-init`/修文件 |
| Python 不可用/版本 <3.11 | `DEPENDENCY_UNAVAILABLE`→`BRIDGE_UNAVAILABLE` | 配置 `pythonPath` |
| 越根/篡改引用/签名损坏 | `SCOPE_DENIED` | 重新 find/read；检查 state secret/文件 |
| 源码变化 | `STALE_SOURCE` | 重新查询/复核 |
| 快照坏/不支持/过期 | `STALE_SNAPSHOT`/`UNSUPPORTED_SCHEMA`；UI 单条 `invalid`/`stale` | 重新导入 |
| revision/generation 冲突 | `STATE_CONFLICT` | 取当前状态重试 |
| operation 摘要不同 | `OPERATION_CONFLICT` | 新 operation_id |
| 能力缺失（CFG/locks/aliases/AI 正文/真实设备） | `status=unavailable`/gap（exit 0） | 保持 unknown，不补造 |
| 超时/取消（工具/场景 worker/重放） | `OUTCOME_UNKNOWN`(4)（视图层）或 `{ok:false,error}` | 不重试成“成功”；场景/重放不落台账 |
| 无隔离执行 profile | `EXECUTION_BLOCKED`(2) | 仅读已有证据 |
| RPC 未准入/非 POST/超限/坏信封 | 401/403/405/固定 `gateway/bad-request`/`gateway/internal` | 重新登录/修请求；不上传内部错误文本 |
| 输入非法（枚举/长度/路径穿越/未知字段） | `INVALID_ARGUMENT` | 修正参数 |
| 场景越界/records 不对齐/未知接口 | `INVALID_ARGUMENT`/`UNKNOWN_INTERFACE` | 修正步骤；不落台账 |
| Wasm 哈希不符/无法实例化/无 memory | `MODULE_HASH_MISMATCH`/`INSTANTIATE_FAILED`/`MODULE_BINDING_INVALID` | 重新登记 profile；不执行 |
| 回退前缀 digest 不一致 | `STATE_CONFLICT/state_digest_mismatch`（含 step_index/digests） | 不发布；重试或保留只读历史 |
| 导入轨迹不可回退 | `CAPABILITY_UNAVAILABLE` | 只读历史；重跑新场景 |
| 非法 `async_events`（重复/未知/超 16/非数组） | `INVALID_ARGUMENT`（profile 与 trace-import 均拒绝） | 修正声明；profile/台账不写 |
| 归纳超长/控制字符/非法 facts | `LIMIT_EXCEEDED`/`INVALID_ARGUMENT` | 修正 payload；原文不被覆盖 |
| 快照变化后的旧归纳 | `stale:true` + `summary_stale_against_current_snapshot` | UI 显示“基于旧快照，待复核”；重写归纳 |
| 性能预算未达标（历史） | 验收 `ok=false`（首屏，历史 run） | 优化后复测；不得调预算。当前已达标：hot p95 387 ms、25/25 全绿 |
| 验收门禁失败（宿主 SHA/版本不符） | 整批失败 | 同步固定环境值或退回已发布宿主版本 |

---

## 10. 当前状态：actual / 已验证 / 未验证 / blocked

| 项 | 状态 | 说明 |
|---|---|---|
| 合成 fixture 上 workspace/source/snapshot/path/binding/record/resume/CLI/Host 工具旅程 | **actual** | 318 引擎测试 + 195 Node 测试 + 安装后 Host 工具旅程 |
| 真实 Atlas 0.8 产物适配（Windows runtime，合成 C） | **actual（非 Linux 门禁）** | `evidence/real-atlas/`、`evidence/code-view-slice/`：envelope/graph_hash/coverage/真实 file/line/exact 边/flow_legacy |
| 只读工作台 RPC/面板/五视图/组折叠/接口库/子流程 | **actual** | S1 26/26、S2a 37/37、S2b 41/41 隔离 dsh-web 验收 |
| 受控 Wasm 场景/打桩/台账/observed/回退/轨迹导入 | **actual** | S3a 43/43、S3b 58/58 隔离 dsh-web 验收（Demo Wasm，非真实设备） |
| 异步/IRQ 事件边界（observed `async` 标记） | **actual（已验证）** | `verify-irq` 34/34：真实 Wasm `bus_irq`→IRQ、observed `async_events:["IRQ"]`/IRQ `async:true`、dsh-web `[data-sequence-async]`+“异步”chip/说明；static/rev1 无标记；非法声明拒绝不写（M-04-33） |
| AI 归纳写入/缓存/展示/失效 | **actual** | 49/49，Agent 写入 ≠ 插件生成 |
| 性能实测与大图规模证据 | **actual，首屏预算已达标** | `evidence/perf/`：25/25 全绿，首屏 hot p50/p95 328–330/382–387 ms ≤500；coupling p95 3 ms；not_verified 4 项（cold UI/tree→file/拖动/2000-10k 截断文本）如实 |
| 批量首屏 `view.firstScreen`（含 `coupling_aux`） | **actual（已验证）** | `verify-perf` 25/25；一致性 8/8；20/20 hot 60 处 batch、fallback=0；client 消费 aux→0 次单独 coupling RPC（M-04-22） |
| 真实 Linux/Kbuild 索引/生成头/目标 ABI | **blocked（未验证）** | 需 Linux 工具链 + Linux 构建的 Atlas 快照；`evidence/s4-feasibility/` 只做探测 |
| native CFG / 数据流 / 锁 / 别名深分析 | **blocked（未验证）** | 快照 `cfg=unsupported`；关系查询返回 unavailable |
| 真实设备/硬件/线程重叠/字节布局/真实设备下发 | **blocked（未验证）** | 静态证据与 Wasm 模拟均不证明；需单独授权与运行验证 |
| 复核 precision/recall、OS 出口认证 | **blocked（未验证）** | 无复核数据；只有本机回环 HTTP 观测 |
| 桌面宿主热更新 | **未验证（有意）** | 验收用隔离 profile，未重启用户桌面宿主 |
| 05 长期记忆联动、上传/云、远程仓库 | **not implemented（有意）** | 只本地导出，不联网 |
| 图内源码写回 | **not implemented（有意）** | 只读工作台；需另立授权与设计 |

### 10.1 与设计/契约的有意偏差

1. **载体**：设计主形态是 skill + Python CLI 薄适配，DSH Host plugin 后置；实际先交付可安装 Host plugin + 嵌套 UI 子插件。Python 引擎保持设计模块划分与 CLI JSON 合同，插件是薄桥（固定 argv、无 shell），不是第二套解析器。
2. **runtime**：用系统 Python 3.11+（本机 3.11.4），不 vendor 固定解释器/Atlas 包；`source.lock.json` 记录依赖与来源，后续补固定 runtime 时 CLI 合同不变。
3. **Atlas 执行**：`run` 恒阻断；真实产物由人工用 Atlas 自带 Windows runtime 在合成 C 上生成并消费（2026-11-08/11-15），不分析用户仓库/Linux Kbuild、不联网、不运行 H 盘 launcher。
4. **关系查询**：flow_legacy 用快照内 flow_edges 投影；flow_cfg/locks/aliases 在 capability 不足时一律 `status=unavailable` 并列出 unknowns，不以空数组伪装完整。
5. **记录存储**：SQLite（标准库）+ 不可变 revision JSON，未引入 FTS/外部依赖。
6. **测试**：设计列出的 `test_runner.py`/`test_egress.py` 改为等价边界测试（无执行后端→blocked；无外发路径断言）。
7. **S3/S4-prep 增量**：受控场景、AI 归纳、性能实测按分阶段契约实现；AI 归纳正文由 Agent 经工具写入（插件无模型出口）。**首屏批量端点 + `coupling_aux`（T33/T37）是 S4-prep 性能迭代的最终实现并已验收：hot p95 328–330/382–387 ms、25/25 全绿**。
8. **已知交互限制**：observed 默认最近更新台账（可切换但无持久化）；client `expected_generation` 依赖全局 latestGeneration，跨场景后重跑旧场景可能 CAS 冲突；组名/接口库修订只在会话内；接口候选是规则候选（全部 may）。
9. **首屏批量的边界**：`LIMIT_EXCEEDED`（480 KiB）路径最终 verifier run 未触发（真实快照远低于上限），其 sizes/回退由引擎/Node 测试覆盖；跨参考机预算校准为 out_of_scope；cold UI、tree→file 行高亮、拖动反馈、2000/10k UI「已截断」文本仍 not_verified（不伪造）。
10. **异步/IRQ 边界（M-04-33）**：按 profile/导入轨迹的 `async_events` 声明给事件加 `async` 标记与 UI chip/说明，**不推断**真实硬件中断/因果；rev1/rev2 兼容，静态投影与台账语义不变；out_of_scope 5 项已列在证据。

---

## 11. 待验证改进假设（不得当已实现）

以下大多需要真实环境/额外授权，只能作为假设与下一步验证；已达成项单独标注，不能把未完成项写成已通过：

1. **真实 Linux Kbuild + 固定 Atlas 0.8 runtime**：graph/manifest 字段与 fixtures 一致；失败 TU 诊断可保留并解释；生成头/目标 ABI 覆盖；Linux 构建快照可通过 `workspace_roots` 校验。前置：Linux 目标（Python≥3.11、工具链）、Linux 构建 Atlas 快照、内核源码/compdb/生成头。
2. **强制隔离 runner**（bwrap/OCI）能挡住 compiler probe 越根写/网络；负例通过前 `run` 保持阻断。
3. **native CFG（Clang18 extractor）** 可用时 flow_cfg 结果正确；缺失时 `capability=false` 分支保持。
4. **大仓库下 find/overview/五视图性能与预算**；当前“候选枚举不计入读取预算”可能成为热点。
5. **事件来源 03 的真实 event_id/generation 语义**；本版仅 fixture 兼容。
6. **首屏达标（已达成，T37 最终验收）**：M-04-22 批量首屏 + `coupling_aux` 使 hot p50/p95 = 328–330/382–387 ms ≤500，一致性 8/8、fallback=0；**仍待补测**：cold UI 20 冷样本、tree→file 行高亮、拖动反馈、2000/10k UI「已截断」文本（not_verified 4 项，不伪造）；跨参考机预算校准为 out_of_scope。
7. **异步/IRQ 声明式边界（M-04-33）已实现并验收（34/34）**；**仍未验证**：真实硬件 IRQ 因果/中断完成判定、跨进程异步调度/时序竞态、真实设备下发的可回退语义（当前仅有序步骤 + memory digest 前缀）。
8. **结构布局/compat**：只有真实目标 ABI 证据才可解释字节偏移。
9. **skill 实际学习质量**：独立对话评审（结构测试不能证明学习效果）；AI 归纳语义质量（是否把候选写成确定）需评审。
10. **OS 出口认证**：需要目标 OS 的网络策略证据，当前只有“不联网”的代码事实与本机回环观测。

---

## 12. 独立验证与缺陷修复记录

### 12.1 首版（2026-11-07/08，保留）

独立 verifier（未参与编写，自建 `%TEMP%` fixture）复审 v0.1.0 给 **FAIL**，推动修复（均有回归）：

| 发现 | 级别 | 修复 | 回归 |
|---|---|---|---|
| `resume` 经 Windows junction 走进 repo 外目录，可能无界遍历并把外部文件计入 source-manifest 摘要 | BLOCKING | `invalidation.py` 改用 `scope.iter_regular_files`（跳过 symlink/junction/reparse） | `test_verifier_regressions.py::SourceManifestJunctionTest` |
| `record-save` 接受伪造 `experiment.executed`/`observation.observed`/`DONE-APPLIED`，并曾以 fresh 落盘 | BLOCKING | `records._verify_record_claims`（executed 必须有本地 runs 账本；planned 必须签名 plan；证据保存时重核并降级 freshness） | `RecordClaimTest` |
| 快照 `workspace_roots` 未绑定登记 workspace | NON-BLOCKING | import 时要求至少一个 root 指回本次目标 repo（同 workspace 其它 repo 不够） | `SnapshotProvenanceTest` |
| Host 桥接受旧 Python 3.x | NON-BLOCKING | `--version` 探测要求 3.11+ | `tests/node/bridge.test.mjs` |
| issue/unresolved 截断静默；find 大文件前缀搜索 `truncated=false` | NON-BLOCKING | 显式 `*_truncated` limitations；find 前缀单文件 `truncated=true` | `BoundedProjectionTest` |
| `State.require_in_root` 接受最终 symlink/junction（死接口） | NIT | 拒绝最终 reparse point | `RequireInRootTest` |

二次复核结论 **PASS WITH FINDINGS**（两项原始 blocking 已关闭；`prediction` 作者身份与少量 NIT 保留为非阻塞）。2026-11-08 真实 Atlas 0.8 产物对照（quickstart + 三函数 C 仓库）修复“真实 function 无 file/line、位置在 evidence”的适配缺口，并给函数名/显示名/文件名截断与 `safe_cursor.evidence_refs` 封顶加显式 marker（`evidence/real-atlas/`）。

### 12.2 本轮（2026-11-15）阶段验收与真实缺陷修复

| 阶段 | 验收 | 期间发现并修复的真实缺陷 / 记录 |
|---|---|---|
| S1 只读切片 | `verify-readonly` 26/26，三层全 true | 真实 `flow_edges.owner=null/sources=[]` 适配缺口（`test_atlas_flow_shape.py`，4 回归）；`__DSH_BOOT__` client 条目/401 准入/旧工具回归实测 |
| S2a 五视图 | `verify-five-views` 37/37 | 时序静态预测必须显式 warning+observed=false；DOM 契约与实际差异按契约“实现可增不改”记录；被后续取代的 S1 占位断言以子集+`ignored_steps` 记录 |
| S2b 组/接口库/子流程 | `verify-s2b` 41/41 | 组折叠必须边不合并（31 条原边元数据 before/after 全量比对）；接口候选全部 may；组修订仅会话 |
| S3a 场景/打桩/observed | `verify-s3` 43/43 | 契约 §5 DOM 示例与实际差异如实记录（如 `data-code-view="stub-panel"` 实际为容器类名）；observed 默认最近台账、跨场景 CAS 限制记录为交互改进候选 |
| S3b 回退/轨迹导入/多场景 | `verify-s3b` 58/58 | imported 台账 undo 实际返回 `CAPABILITY_UNAVAILABLE`（契约只写“不提供”），按实际码记录；S3a 回归探针新增 `RV_SCENARIO_CHANNEL` 避免共享台账 CAS 冲突 |
| S4-prep AI 归纳 | `verify-summary` 49/49 | **Windows 签名密钥文本模式损坏**：`State.secret` 用 `os.open` 未带 `O_BINARY`，CRT 文本模式把随机密钥中的 `0x0A` 扩展为 CRLF，导致签名文件约 12% 概率损坏、已签 profile/台账/plan/summary 随机 `SCOPE_DENIED`（S3/S4 偶发失败根因）。修复为二进制打开+严格 32 字节校验，回归 `test_io_robustness.py`（含 0x0A/0x0D 密钥 round-trip 与损坏文件报错）；修复后引擎套件稳定（最终 318 tests） |
| S4-prep 性能 + 首屏批量（T27–T37） | `verify-perf` **25/25 全绿**，`ok=true/verified=true` | 首屏链路：T27 基线 1078/1141 → T28 并行/预取/缓存 646/704 → T33 批量首屏 455/527 → T37 `coupling_aux` **328–330/382–387 ms ≤500 ✅**；coupling p95 3 ms；`data-first-screen` 20/20 样本 60 处 batch、fallback=0；`coupling_aux` 一致性 8/8；剩余 not_verified 4 项（cold UI/tree→file/拖动/2000-10k 截断文本）如实；`LIMIT_EXCEEDED` 路径本 run 未触发（引擎/Node 测试覆盖） |
| S4-prep 异步/IRQ 边界（T39–T41） | `verify-irq` **34/34 全绿**、layers 全 true、`ok/verified=true`、`in_scope_not_verified=0` | 真实 Wasm `reset→bus_register(1)→bus_irq()` 台账 `[null,0,0]` 且 `bus_irq` 真实产生 `IRQ`（`scn_7b5258892e19`）；observed/`view.sequence` 顶层 `async_events:["IRQ"]`、IRQ 消息 `async:true`；dsh-web `[data-sequence-async="true"]`+“异步”chip/说明；static/rev1 导入台账无标记（旧行为不变）；非法 async_events（duplicate/unknown/non_array/>16）对 profile/trace import 均 `INVALID_ARGUMENT` 且不写；回归 S3b/S3a(residual=[])/S2b/summary + Node 195/195 + Demo 8/8；证据 sha256 见 §12.3 |
| S4 可行性 | `evidence/s4-feasibility/`（`ok=true, verified=false`） | Linux 可移植性探测：Node 164/164、真实 Wasm worker 8/8、引擎 CLI status/import 可用；Python 3.8 引擎套件 255 errors；Windows 构建快照被拒绝——Kbuild/CFG/复核/OS 出口保持不可声明 |

### 12.3 最终验收收口（2026-11-15）

- **M-04-22 批量首屏 `view.firstScreen`（含 `coupling_aux`）已完成最终验收**：`node tools/verify-perf.mjs --with-repo-tests` → 25/25 全绿、layers 全 true、`ok=true/verified=true`；首屏 hot p50/p95 = **328–330/382–387 ms ≤500 ✅**（历史：batch 前 646/704、无 aux 455/527）；20/20 hot 样本 `[data-first-screen]` 60 处全部 batch（fallback=0）；一致性 8/8（CLI 5/5 视图 + RPC 5/5 逐字段一致、sizes 4 键、aux 计入 480 KiB、未知 view→INVALID_ARGUMENT/未知 entry→NOT_FOUND、无绝对路径）；回归 perf-regressions（S3b/S3a residual=[]/S2b/summary）+ Node 191/191（当次；最终 195/195）+ Demo 8/8 全绿。证据 sha256：`verification.json` `e350ed99…`、`first-screen-consistency.json` `8bb859f9…`、`README.md` `f2d39214…`、`commands.log` `a62f8942…`。
- **M-04-33 异步/IRQ 事件边界已完成最终验收（T41）**：`node tools/verify-irq.mjs --with-repo-tests` → **34/34 全绿**（layers 全 true、`ok=true/verified=true`、`in_scope_not_verified=0`、out_of_scope 5）；真实 Wasm `reset→bus_register(1)→bus_irq()` 台账 `[null,0,0]` 且 `bus_irq` 真实产生 `IRQ`（`scn_7b5258892e19`）；observed/`view.sequence` 顶层 `async_events:["IRQ"]`、IRQ 消息 `async:true`（label `IRQ: write irq_count`）；dsh-web `[data-sequence-async="true"]`=1 + `[data-sequence-async-chip]`“异步” + `[data-sequence-async-note]` 说明；static 与 rev1 导入台账 0 标记（旧行为不变）；非法 async_events（duplicate/unknown/non_array/>16）对 profile/trace import 均 `INVALID_ARGUMENT` 且不写；回归 S3b/S3a(residual=[])/S2b/summary + Node 195/195 + Demo 8/8。证据 sha256：`verification.json` `38080909…`、`README.md` `5914291e…`、`async-irq.png` `36907e95…`、`commands.log` `bf493784…`。
- **S4 目标门禁**：在具备 Linux 内核源码/compdb/生成头、Linux 构建 Atlas 快照、固定 Atlas Linux runtime、复核数据的固定 Linux 目标上重跑同一验收口径；在此之前不得更新本文件的“未验证”结论。

---

## 13. 交付与验收索引（证据地图）

| 阶段 | 验收命令 | 证据 | 结论 |
|---|---|---|---|
| 首版 `CL-IMPL-1` | 引擎 unittest + Node 测试 + 安装后 Host 工具旅程 | `evidence/plugin-install-verification.json`、`evidence/real-atlas/` | actual（合成 + 真实 Atlas 产物对照；非 Linux 门禁） |
| CW-T1 只读切片 | `node tools/verify-readonly.mjs --with-repo-tests` | `evidence/readonly-slice/`（26/26、`render*.png`、host-runtime、commands.log） | actual（隔离 rc.5） |
| CW-T2 S2a | `node tools/verify-five-views.mjs --with-repo-tests` | `evidence/five-views/`（37/37、五视图截图） | actual |
| CW-T2 S2b | `node tools/verify-s2b.mjs --with-repo-tests` | `evidence/s2b/`（41/41、组/接口/子流程截图） | actual |
| CW-T3 S3a | `node tools/verify-s3.mjs --with-repo-tests` | `evidence/s3/`（43/43、打桩/台账/observed 截图） | actual（Wasm 模拟） |
| CW-T3 S3b | `node tools/verify-s3b.mjs --with-repo-tests` | `evidence/s3b/`（58/58、undo/imported/多场景截图） | actual（Wasm 模拟） |
| CW-09 AI 归纳 | `node tools/verify-summary.mjs --with-repo-tests` | `evidence/ai-summary/`（49/49、gap/written 截图） | actual（Agent 写入） |
| CW-11/A11 性能（含首屏批量/aux） | `node tools/verify-perf.mjs --with-repo-tests`（内含 `tools/firstscreen-consistency.mjs`） | `evidence/perf/`（25/25 全绿、hot p50/p95 328–330/382–387 ≤500 ✅、一致性 8/8、60 处 batch/fallback=0、4 项 not_verified 如实） | **actual（已验证）** |
| 异步/IRQ 事件边界（S4-prep 收尾） | `node tools/verify-irq.mjs --with-repo-tests` | `evidence/async-irq/`（34/34、layers 全 true、`in_scope_not_verified=0`/out_of_scope 5、真实 Wasm IRQ、async DOM、截图；4 个证据 sha256 见 §12.3） | **actual（已验证）** |
| S4 可行性 | 见 `evidence/s4-feasibility/README.md` | `evidence/s4-feasibility/`（Node 164/164、worker 8/8、引擎限制） | **仅探测，门禁未验证** |
| 首屏批量端点（`view.firstScreen`+aux） | `node tools/verify-perf.mjs --with-repo-tests` | `evidence/perf/{verification.json,first-screen-consistency.json}`（25/25；8/8；sha256 见 §12.3） | **actual（已验证）** |

**结论**：本交付可作为“合成 fixture + 真实 Atlas 产物对照 + 隔离 rc.5 dsh-web 上可安装、可自测、边界清晰”的当前整体实现；不得据此声称已读懂用户真实驱动或通过 Linux/Kbuild/CFG/locks/aliases/复核/OS 出口门禁。首屏性能已在**合成 500/800 夹具 + 本机**上达标（hot p50/p95 328–330/382–387 ms ≤500，25/25 全绿），但不代表真实仓库/其它机器；异步/IRQ 边界仅做声明式标记（34/34），**不推断**真实中断/因果；S4 门禁仍未验证。改 skill 只能调整阅读/提问/呈现/何时写归纳等策略，不能绕过硬边界，也不能把未验证结果（Linux/CFG/真实设备/异步因果）提升为事实。
