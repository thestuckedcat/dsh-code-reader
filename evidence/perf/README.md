# S4-prep performance evidence（合成夹具，A11 实测；Lead 最终独立复跑，**首屏预算已达标**）

生成命令：`node tools/verify-perf.mjs --with-repo-tests`（Lead 最终复跑 2026-11-15T22:42+08 启动，
duration 270.4 s；verifier 同工具复测 270.7 s，两次独立 run 均 25/25）。参考机：13th Gen Intel Core
i7-13700F（24 逻辑 CPU）、34.19 GB RAM、win32 x64 / Windows 10.0.26200、Node 26.13.0。固定宿主：
`E:\dsh\DeepSeek Harness.exe` sha256 `7ae939b5…0cc4`、`E:\dsh\resources\app.asar` sha256
`e1b6f25f…6915`、dsh `0.2.1-rc.5`（内嵌 Node 24.21.0 / Electron 44.7.0）。

## 1. 结论（预算判定；最终两位独立 run 均 25/25 全绿、首屏达标）

| 指标 | 样本 | p50 | p95 | 预算 | 判定 |
|---|---|---|---|---|---|
| 首屏 hot（点击入口→视图 ready，batch+aux） | 20/20 | **328 ms**（verifier 330） | **382 ms**（verifier 387） | ≤500 ms | ✅ **达标** |
| 跨视图 coupling（资源行→函数高亮） | 20/20 | 2 ms | 4 ms（verifier 3） | ≤120 ms | ✅ 达标 |
| 跨视图 tree→file 行高亮 | 0 | — | — | ≤120 ms | in_scope_not_verified（合成夹具无真实 file evidence/可定位目标，不伪造） |
| 拖动反馈（pointermove→rAF 边路径更新） | 0 | — | — | ≤32 ms | in_scope_not_verified（合成 4 节点邻域无可拖边目标，不伪造） |
| 首屏 cold（整页 reload/重选 ×20） | 0 | — | — | ≤500 ms | in_scope_not_verified（一次性 host URL token 使重复 reload 不稳定；不伪造；`PERF_COLD_SAMPLES=20` 可显式开启） |
| 引擎 CLI 冷投影（4 视图各 20） | 20/20 | 133–140 ms | 139–147 ms | — | 记录（子进程冷启动） |
| in-process 投影（4 视图各 20） | 20×4 | 22.0–24.6 ms | 22.9–26.4 ms | — | 记录（首调 26.3–27.8 ms） |
| 2000 节点/10k 事件加载 | 真实导入 | e2e ready 1413 ms、入口 1600 | — | 分片/截断反馈 | ✅（coverage=truncated 保留；UI「已截断」文本未显示记 not_verified） |
| 2000/10k 搜索 / 事件序列 | 5 / 5 | 1 ms / 4 ms | 2 ms / 4 ms | — | ✅ |

**`ok=true, verified=true`；25 项检查全部通过（0 失败）**；layers
`{engine:true, dsh_host:true, fixture:true, demo_observed:true}`；in_scope_not_verified 4、
out_of_scope 5；未调预算。检查构成：核心 13（含 budget_first_screen/cross_view/drag、
first_screen_batch、big_graph_truncation、repo_tests Node 191/191）+ batch/coupling_aux 一致性 5 +
回归 5（S3b/S3a residual=[]/S2b/summary/console，Demo 8/8）。

## 2. 首屏优化三轮对比（同机同口径，budget 500 ms 未调整）

| 迭代 | 首屏 hot p50 / p95 | 说明 |
|---|---|---|
| T27 基线 | 1078 / 1141 ms | 入口选择 4 个串行 RPC（getEntry+coupling+interfaces+当前视图），Host bridge 串行 CLI |
| T29 client 优化 | 646–705 / 704–769 ms | getEntry/coupling/interfaces 并行 + entries 空闲预取 + hover/focus 预取 + 会话 LRU≤32；仍 4 次 RPC |
| T33 批量首屏 | 455 / 527 ms（三次 p95 461/507/527） | `view.firstScreen` 一次 RPC 返回 entry+interfaces+当前视图；非 coupling 活动视图仍多 1 次 coupling RPC；越接近预算但未稳定 |
| **T37 + coupling_aux** | **328–330 / 382–387 ms** | batch 在 view!=coupling 时附带 `coupling_aux`，client 省掉单独 coupling RPC（≈140 ms）；**稳定达标** |

batch 使用证据：20/20 hot 样本采集 `[data-first-screen]` 共 60 处全部 `"batch"`（fallback=0）；
`coupling_aux` 一致性 8/8：view!=coupling 时 CLI 5/5 视图与单独 view-coupling 逐字段一致（signed
`evidence_ref` 按解码 claims 归一化、忽略签发时间）、RPC 5/5 一致；view==coupling 时字段省略/
`sizes.coupling_aux=0`；`sizes` 固定 4 键且各值精确等于组件 canonical JSON UTF-8 字节数；未知 view
`INVALID_ARGUMENT`（优先于 entry）、未知 entry `NOT_FOUND`；CLI/RPC 无绝对路径。

## 3. 方法 / 限制

- 500/800：引擎 CLI 冷样本（每样本新子进程，20）、in-process 投影（cold=首调、hot=其余）、真实 dsh web
  首屏 hot（同进程重选 20；cold 默认关闭）、coupling 资源→函数高亮（20）、tree→file（20，夹具限制跳过）、
  pointermove→rAF（20，夹具限制跳过）。
- 2,000/10k：真实导入并选中（入口 1600），e2e 加载、搜索 5、事件序列截断 5；coverage/truncated 原样保留。
- p50/p95 为记录样本 nearest-rank；预算是契约 §2 拟验收基线（500/120/32 ms），只记录不改预算；
  `verify-perf` 附带 perf-regressions（S3b/S3a/S2b/summary 四探针、console clean、Demo、Node）。
- **合成夹具声明**：`tools/perf/make-synthetic-graph.mjs` 从 Demo Atlas 模板确定性生成，合法 Atlas 0.1
  envelope（manifest graph_hash=sha256(graph.json)）经真实引擎 `snapshot-import` 校验；**SYNTHETIC、非真实
  仓库**，只作规模/截断/搜索反馈证据，不代表真实仓库或 Linux/Kbuild 行为。
- 未验证项如实保留：cold UI 20 冷样本（一次性 token）、tree→file 行高亮与拖动（合成夹具限制）、
  2000/10k UI「已截断」文本（本轮未显示；加载/搜索/事件已实测）。机器信息/原始样本/p50/p95/预算判定/
  覆盖/失败数见 `verification.json`。

## 4. 产物（Lead 最终复跑后当前值）

| 文件 | 说明 | sha256 |
|---|---|---|
| `verification.json` | 权威报告（116,133 B）：layers/25 项检查/原始样本/p50/p95/预算/not_verified | `e350ed99fa73072c2493305ef6832021f7c3187dbca9e4669c8b2c9c7358fa0c` |
| `first-screen-consistency.json` | batch vs 单独端点一致性（38,950 B：5 视图 CLI+RPC、coupling_aux、sizes、负例、路径） | `8bb859f90f30909d18a7020d706e94172b2005ae056509af5d13568ec7784393` |
| `commands.log` | 实际命令（fixture 生成、in-process bench、Chromium 探针、perf-regressions、仓库测试） | `a62f894264497fa1776737144f319d9288b841ecd1103f24dca0893e7bfb0d5c` |
| `scratch/perf/perf-probe.json` | UI 探针原始结果（含 metric_status/原始样本/data-first-screen 采样） | 见 `scratch/perf/`（每次运行重新生成） |
| `scratch/perf/regressions/regressions.json` | 回归包结果（四探针 + console/Demo/Node） | 见该文件 |

工具：`tools/verify-perf.mjs`、`tools/perf-probe.cjs`、`tools/perf/make-synthetic-graph.mjs`、
`tools/perf/inproc-bench.py`、`tools/firstscreen-consistency.mjs`、`tools/perf-regressions.mjs`（均非产品运行路径）。
