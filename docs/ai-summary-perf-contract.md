# 04 AI 归纳与性能实测契约（CL-VIEW-T4 前置 / 阶段 S4-prep）

`CL-VIEW-T4A-CONTRACT` · 2026-11-15 · 固定 **CW-09 详情 AI 归纳**（≤500 字、事实引用、生成版本、推断标签）
与 **CW-11/A11 性能实测口径**的首个切片。前置契约
[five-view-contract](five-view-contract.md)/[readonly-workbench-contract](readonly-workbench-contract.md) 的
Selection、证据分级、缺口规则继续有效。

## 0. 范围

做：AI 归纳的**写入/缓存/读取/失效**与详情面板展示（写入者是 Agent，经新工具 `code_summary`；插件自身
不调用模型）、性能实测口径 + 500/800 与 2000/10k 合成图测量工具与证据。
不做：插件内模型调用（无模型出口）、真实 Linux/Kbuild、CFG/locks/aliases 深分析、OS 出口认证（S4 后续）。

## 1. AI 归纳（CW-09）

设计依据：详情含源码、子流程图、资源分析和不超过 500 字的 AI 归纳；归纳必须保存事实引用、生成版本与
推断标签（设计 §3、CW-09）。**插件不产生归纳正文**：由 Agent（模型）经 DSH 工具写入；UI 只读展示并标来源。

### 1.1 存储与失效

- 作用域：`workspace + snapshot + subject`；subject 类型 `function|group|entry`（entry 指入口函数详情的
  独立归纳，可与 function 归纳并存）。同一 subject 只保留最新一条（修订覆盖，不保留历史代际；历史走
  学习记录/快照）。
- 失效：存储时记录该快照 `graph_sha256`；读取时与当前核验快照的 graph sha 比较：
  - 一致 → `stale:false`；
  - 不一致（快照重导入/内容变化）→ `stale:true`，仍返回文本但 UI 必须显示“基于旧快照，待复核”，
    并给出 `limitations:["summary_stale_against_current_snapshot"]`。
- 不写入源码/快照；state 内 JSON，含 `signature`（复用 state 签名）与 `generated_at`。
- 文本 1..500 个 Unicode 码点、禁止控制字符；事实引用 ≤32 条（`{kind:'evidence'|'node'|'selection',
  ref:'…'}`，ref ≤512 安全字符）；推断标签 ≤8，枚举 `from_static_structure|from_source_text|
  may_speculative|from_observation`（`from_observation` 仅当有运行台账时才允许）；generator
  `{kind:'agent'|'user', ref:'<有界字符串>'}`（不记录密钥/路径）；可选 `model_ref`。

### 1.2 引擎 CLI

| 命令 | 参数 | 说明 |
|---|---|---|
| `summary-put` | `--workspace --snapshot --payload-json <base64>` | 校验 payload（§1.1）与快照已导入、subject 函数存在；写签名 JSON；覆盖同 subject；返回 summary 投影 |
| `view-summary` | `--workspace --snapshot [--subject-type T --subject-id ID]` | 返回 `{summaries:[…], gaps:[…], stale_count}`；无记录时 gaps 含 `ai_summary_not_generated` |
| `summary-put` 的 payload | `{subject:{type,id}, text, facts:[…], generator:{kind,ref,model_ref?}, inference_labels:[…]}` | `subject.id` 函数/组 id；组 id 形如 `group:…`，非函数 subject 不做存在性校验（记录 limitations） |

summary 投影：
```jsonc
{"schema_version":1,"workspace_id":"…","snapshot_id":"…","subject":{"type":"function","id":"f_…"},
 "text":"≤500 字","facts":[{"kind":"evidence","ref":"e_…"}],"generator":{"kind":"agent","ref":"skill:…","model_ref":null},
 "inference_labels":["from_static_structure"],"generated_at":"2026-11-15T…Z",
 "snapshot_graph_sha256":"<64hex>","stale":false,"limitations":[]}
```

### 1.3 Host 工具与端点

- 新 Agent 工具 `code_summary`（`lib/tools.mjs`，固定 argv，模型只填类型化字段）：
  - `action=get`：`workspace/snapshot/subject_type?/subject_id?` → `view-summary`；
  - `action=put`：`workspace/snapshot/subject_type/subject_id/text/facts/generator/inference_labels` →
    `summary-put`（payload 由 Host 组装 base64；text ≤500、facts ≤32 等 Host 先校验）。
  - 描述中明确：归纳必须基于已核验证据、≤500 字、不得把候选/未知写成确定事实、不得伪造运行观测。
- 新 RPC 端点 `view.summary`：输入 `{workspace,snapshot,subject_type?,subject_id?}`（subject 二者要么都省略，
  要么都提供；类型枚举；id 有界），映射 `view-summary`；返回 summary 列表 + gaps（无记录不报错）。
- `view.status` capabilities 增加 `ai_summary_store:true`（可写入/读取归纳缓存）；`ai_summary` 仍表示
  “插件自动生成正文”=false，gap 文案改为“归纳正文由 Agent 经 code_summary 写入；插件不调用模型”。

### 1.4 客户端

- 详情面板新增 AI 归纳区（函数/组/入口选择后按 `view.summary` 懒加载，选中变化防抖 ≤200ms）：
  - 有记录：`[data-code-view="ai-summary"]`、`[data-ai-summary-text]`（≤500 字原样，超长不可能）、
    `[data-ai-summary-generator]`（kind/ref）、`[data-ai-summary-generated-at]`、`[data-ai-summary-facts]`
    （事实引用数/列表）、`[data-ai-summary-labels]`（推断标签）、`[data-ai-summary-stale="true|false"]`
    （stale 显示“基于旧快照，待复核”警告）；
  - 无记录：`[data-ai-summary-gap]` 文案“AI 归纳未生成（Agent 可通过 code_summary 写入）”，不伪造正文；
  - 记录与当前 Selection 不匹配（subject 变化竞态）时丢弃过期响应；
  - 详情其它 tabs（source/subflow/resources）与布局保持；总结不写入 Selection（Selection 不含归纳文本）。
- 图例/缺口：`ai_summary` gap 文案更新为“归纳正文由 Agent 写入（code_summary），插件不自动生成”。

### 1.5 dsh-web 验收（`node tools/verify-summary.mjs --with-repo-tests`）

隔离 profile + 真实 dsh web，选中 `bus_send` 函数详情：
1. 未写入时 `[data-ai-summary-gap]` 存在且无 `[data-ai-summary-text]`；
2. 用真实引擎 CLI（模拟 Agent，隔离 state 内）`summary-put` 写入 ≤500 字、facts（含 `e_…` evidence id）、
   generator `{kind:'agent',ref:'verify-summary'}`、labels `from_static_structure`；
3. UI 点刷新/重选后出现 `[data-ai-summary-text]` 原文、facts 数、generator、generated_at、stale=false；
4. 超过 500 字/控制字符/非法 facts 的 put 被引擎拒绝且不显示；
5. 组 subject（`group:…`）写入/读取可用，UI 在组详情显示（组折叠态选中组时）；
6. 截图 `evidence/ai-summary/{gap,written}.png` + verification.json（in/out_of_scope）。
7. 回归：S3b/S3a/S2b/S2a/S1 探针、Cordis（含 code_summary 工具注册与一次真实 put/get）、Demo、仓库测试。

## 2. 性能实测（CW-11/A11）

设计 §5 拟验收预算（待实测校准）：在记录版本的 DSH 参考机上，对**已索引的 500 节点/800 边图**测冷/热各
20 次：缓存首屏 **p95 ≤ 500 ms**、跨视图定位 **p95 ≤ 120 ms**、拖动反馈 **p95 ≤ 32 ms**；无索引时约 1 s
内给出已知入口或后台状态；以 **2,000 节点/1 万时序事件**测分片/搜索/截断。记录每组样例的真实覆盖与失败数。

### 2.1 口径

| 指标 | 方法 | 样本 |
|---|---|---|
| 首屏 p95 | dsh-web 中点击入口/快照 → 视图根 `data-state=ready`（含 RPC+投影+渲染） | 冷 20 / 热 20 |
| 跨视图定位 p95 | coupling 资源节点点击 → 对应函数节点高亮完成；tree 节点点击 → file 行高亮完成 | 20 |
| 拖动反馈 p95 | end-to-end 图节点 pointermove 事件 → 下一 rAF 布局/边路径更新完成（浏览器内测量） | 20 |
| 引擎投影 p95 | 引擎 CLI 单视图调用（子进程）与 in-process 投影（python bench）计时 | 冷/热各 20 |
| 大图分片/搜索/截断 | 2000 节点/10k 事件：视图截断标记、搜索响应、事件序列截断反馈 | 各 ≥5 |

记录真实值 + 是否满足预算 + 覆盖/截断/失败数；不满足如实记录，不调整预算迎合结果。冷/热定义：冷=新进程/
首次选择；热=同进程再次选择。参考机信息（CPU/内存/OS）写入证据。

### 2.2 夹具与工具

- 合成图：`tools/perf/make-synthetic-graph.mjs`（或 py）生成合法 Atlas 0.1 envelope 的 500 节点/800 边
  与 2,000 节点/10k 事件 fixture（函数/objects/field_accesses/callsites/call_targets/flow_edges/evidence，
  含 graph_hash 与 analysis_manifest；**不伪造真实仓库**，README 标明合成）。
- `tools/verify-perf.mjs`：隔离 profile 导入合成快照 → 引擎 CLI/bench 计时 → 真实 dsh web + `tools/perf-probe.cjs`
  测 UI 三项 p95 → 写 `evidence/perf/verification.json`（含原始样本、p50/p95、预算比较、覆盖/失败数）
  与 README（机器信息、方法、局限）。
- 客户端无需为测量新增生产代码；如必须，仅允许只读 `performance.mark`（不得引入外部依赖）。

### 2.3 验收

- `node tools/verify-perf.mjs --with-repo-tests` 产出证据并在报告中明确：每项 measured p50/p95、预算、
  pass/fail、样本数与失败数；
- 500/800 图必须真实加载（截断时记录 `truncated` 与覆盖数）；2000/10k 必须给出分片/搜索/截断反馈证据；
- 与 S1/S2/S3 探针回归不冲突（独立 scratch/evidence 目录）。

## 3. 文件所有权（本轮）

| 负责人 | 写入范围 |
|---|---|
| Lead | `docs/`、`source.lock.json`、技能文档中归纳写入说明、`evidence/ai-summary|perf` 汇总、最终集成/提交 |
| engine | `engine/code_learning/summary.py`（新）、`cli.py`、`engine/tests/test_summary.py` |
| host | `lib/tools.mjs`、`lib/view-service.mjs`、`tests/node/view-rpc.test.mjs`、`tests/node/plugin.test.mjs` |
| client | `bundle/client.js`、`tests/node/client.test.mjs`、`tests/node/helpers/client-harness.mjs` |
| verifier | `tools/verify-summary.mjs`、`tools/summary-probe.cjs`、`tools/verify-perf.mjs`、`tools/perf-probe.cjs`、`tools/perf/`、`evidence/ai-summary/`、`evidence/perf/` |

跨范围修改先经 Lead；不 git 提交；不联网；不改真实 `~/.dsh`；不重启桌面宿主；插件内不运行编译器/构建。

## 4. 本轮验收结果（2026-11-15，S4-prep）

### 4.1 AI 归纳

`node tools/verify-summary.mjs --with-repo-tests`：`ok=true, verified=true`，**49/49 检查通过**，
`in_scope_not_verified=[]`；分层全 true。gap 阶段（选中 bus_send 无正文、`[data-ai-summary-gap]`）→ 真实引擎
`summary-put`（模拟 Agent：≤500 字、facts 含真实 `e_…`、generator `{agent, verify-summary}`、
`from_static_structure`）→ UI 刷新显示原文/facts/generator/generated_at/stale=false；非法 put
（501 字 `LIMIT_EXCEEDED`、控制字符/非法 facts `INVALID_ARGUMENT`）被拒且不覆盖原文；组 subject
`group:…` put/get 可用；Cordis `code_summary`（7 工具）真实 put/get + dispose/二次挂载缓存保留 TAP 1/1；
回归 S3b/S3a/S2b/S2a/S1 + Demo + 仓库测试（Node 164/164）全过；console=0、无绝对路径。证据
`evidence/ai-summary/`（`verification.json`、`gap.png`/`written.png`、host-runtime TAP/JSON、commands.log、README）。

### 4.2 性能实测（拟验收预算，如实记录未达标项）


ode tools/verify-perf.mjs --with-repo-tests：13 项检查 12 通过，**首屏 hot p95 未达 500 ms 预算**，
ok=false/verified=false（仅因预算未达标；结构完整、数字真实，未调预算）。参考机 i7-13700F/24 线程、
34.19 GB RAM、Win10.0.26200、Node 26.13.0；Lead 最终独立复跑 duration 140.8 s。

| 指标 | 样本 | p50 | p95 | 预算 | 判定 |
|---|---|---|---|---|---|
| 首屏 hot（点击入口→视图 ready） | 20/20 | 1078 ms | **1141 ms** | ≤500 ms | ❌ 未达标（verifier 早前独立 run 为 646/704 ms，两次均未达标） |
| 跨视图 coupling（资源行→函数高亮） | 20/20 | 3 ms | 6 ms | ≤120 ms | ✅ |
| 跨视图 tree→file 高亮 | 0 | — | — | ≤120 ms | 合成夹具无真实 file evidence，记 in_scope_not_verified（不伪造） |
| 拖动反馈（pointermove→rAF） | 0 | — | — | ≤32 ms | 合成邻域无可拖边目标，记 in_scope_not_verified（不伪造） |
| 首屏 cold（整页 reload×20） | 0 | — | — | ≤500 ms | 一次性 host URL token 使重复 reload 不稳定，记 in_scope_not_verified；冷引擎路径由 CLI 冷投影覆盖 |
| 引擎 CLI 冷投影（4 视图各 20） | 20/20 | 204–211 ms | 225–242 ms | — | 记录（子进程冷启动） |
| in-process 热投影（4 视图） | 20×4 | 33.1–38.6 ms | 36.1–66.0 ms | — | 记录（首调 33.0–48.1 ms） |
| 2000 节点/10k 事件 | 真实导入 | e2e 加载 1770 ms、入口 1600 | 搜索 5/5 p95 4 ms；事件序列 5/5 p95 5 ms | 分片/搜索/截断反馈 | ✅ 覆盖/截断数据保留；UI「已截断」文本本轮未显示记 not_verified |

### 4.3 首屏优化迭代（2026-11-15，T28；仍待达标）

client 已做首屏优化（getEntry/coupling/interfaces 同 tick 并行、entries 就绪 40ms 空闲预取首个入口、
hover/focus 预取、会话内只读 LRU≤32 + in-flight 去重、snapshot 切换/刷新清空；真实 payload 才 ready，
无假数据/延迟）。同机独立复测（T27 → T29）：

| 指标 | 优化前 | 优化后 | 变化 | 预算判定 |
|---|---|---|---|---|
| 首屏 hot p50 / p95 | 1078 / 1141 ms | **646–705 / 704–769 ms**（verifier 705/769，Lead 复跑 646/704） | −34.6%～−40.1% / −32.6%～−38.3% | ≤500 ms 仍 ❌ fail（如实记录） |
| coupling p50 / p95 | 3 / 6 ms | 2 / 4 ms | −33% | ≤120 ms ✅ pass |
| 引擎 CLI entries p50/p95 | 209 / 228 ms | 125 / 133 ms | −38%…−41% | 基线记录 |
| 引擎 CLI e2e/coupling/tree p95 | 227 / 218 / 232 ms | 133 / 132 / 134 ms | −41% | 基线记录 |
| in-process 热 p50（4 视图） | 34.7–37.0 ms | 21.5–23.4 ms | −38% | 基线记录 |
| 2000/10k 图 load | 1842 ms | 1054 ms | −42.8% | 实测记录 |

**为什么仍超预算**：Host lib/bridge.mjs 对 Engine CLI 串行执行；一次新入口首屏仍需 getEntry + coupling +
interfaces + 当前视图（如 end_to_end）4 个 RPC ≈ 4×130 ms + 渲染 ≈ 769 ms。T28 的并行只并行排队、不减少串行
总时长。**待实现（S4 后续）**：与设计 §5“Host 合并同键只读计算”一致的**批量首屏端点**（iew.firstScreen
一次返回 entry+五视图所需投影，Host/引擎各一次调用；客户端一次 RPC 装载并填缓存），或 Host 只读命令并发池；
目标把 hot p95 压到 500 ms 内后复测。该迭代未在本轮实现，不作达标声明。

结论：功能与数据链路可用；**首屏热路径实测 704–1141 ms 超 500 ms 拟验收预算**（两次独立 run 均未达标，
机器负载导致波动），需要在后续优化（投影/渲染裁剪、缓存首屏、减少重复 RPC）后复测；tree 定位与拖动反馈在
合成夹具上不可测、cold UI 受一次性 token 限制，均记 in_scope_not_verified 并保留失败数；合成图仅作规模/
截断证据，不代表真实仓库或 Linux/Kbuild。证据 evidence/perf/（erification.json、README.md 含方法/
机器信息/not_verified、commands.log、探针原始 JSON）。

**过程中修复的跨阶段缺陷**：Windows 上 State.secret 用 os.open 未带 O_BINARY，CRT 文本模式把随机
密钥中的 0x0A 扩展为 CRLF，导致签名文件平均约 12% 概率损坏、已签 profile/台账/plan/summary 随机
SCOPE_DENIED（正是 S3/S4 验收中偶发失败的根因）。已修复为二进制打开并严格校验 32 字节，增加回归测试
（engine/tests/test_io_robustness.py，构造含 0x0A/0x0D 的密钥验证签名 round-trip 与损坏文件报错）；
修复后引擎 Ran 309 tests, OK，S3/S4 验收复跑稳定。**本文件与证据均为修复后的最终结果**。

结论：功能与数据链路可用；**首屏热路径实测 704 ms 超 500 ms 拟验收预算**，需要在后续优化
（投影/渲染裁剪、缓存首屏、减少重复 RPC）后复测；tree 定位与拖动反馈在合成夹具上不可测，留待真实快照补测；
合成图仅作规模/截断证据，不代表真实仓库或 Linux/Kbuild。证据 `evidence/perf/`（`verification.json`
含原始样本/机器信息/p50/p95/预算判定/覆盖/失败数、`README.md`、`commands.log`）。