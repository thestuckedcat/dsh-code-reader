# S4-prep performance evidence（合成夹具，A11 实测；Lead 最终独立复跑）

生成命令：`node tools/verify-perf.mjs --with-repo-tests`（Lead 最终复跑 2026-11-15T21:25+08:00，
duration 140.8 s）。参考机：13th Gen Intel Core i7-13700F（24 逻辑 CPU）、34.19 GB RAM（采样时 5.82 GB 空闲）、
win32 x64 / Windows 10.0.26200、Node 26.13.0。固定宿主：`E:\dsh\DeepSeek Harness.exe`
sha256 `7ae939b5…0cc4`、`E:\dsh\resources\app.asar` sha256 `e1b6f25f…6915`、dsh `0.2.1-rc.5`
（内嵌 Node 24.21.0 / Electron 44.7.0）。

## 1. 结论（预算判定）

| 指标 | 样本 | p50 | p95 | 预算 | 判定 |
|---|---|---|---|---|---|
| 首屏 hot（点击入口→视图 ready） | 20/20 | **1078 ms** | **1141 ms** | ≤500 ms | ❌ **未达标** |
| 跨视图 coupling（资源行→函数高亮） | 20/20 | 3 ms | **6 ms** | ≤120 ms | ✅ 达标 |
| 跨视图 tree→file 行高亮 | 0 | — | — | ≤120 ms | in_scope_not_verified（合成夹具无真实 file evidence/可定位目标，不伪造） |
| 拖动反馈（pointermove→rAF 边路径更新） | 0 | — | — | ≤32 ms | in_scope_not_verified（合成 4 节点邻域无可拖边目标，不伪造） |
| 首屏 cold（20 次整页 reload/重选） | 0 | — | — | ≤500 ms | in_scope_not_verified（一次性 host URL token 使重复整页 reload 不稳定；不伪造；显式 `PERF_COLD_SAMPLES=20` 可开启） |
| 引擎 CLI 冷投影（4 视图各 20） | 20/20 | 204–211 ms | 225–242 ms | — | 记录（子进程冷启动） |
| in-process 投影（4 视图各 20） | 20×4 | 33.1–38.6 ms | 36.1–66.0 ms | — | 记录（首调 33.0–48.1 ms） |
| 2000 节点/10k 事件加载 | 真实导入 | e2e ready **1770 ms**、入口 1600 | — | 分片/截断反馈 | ✅（coverage=truncated 保留） |
| 2000/10k 搜索 / 事件序列 | 5 / 5 | 2 ms / 4 ms | 4 ms / 5 ms | — | ✅ |
| 2000/10k UI「已截断」文本 | 0 | — | — | — | in_scope_not_verified（本轮 UI 未显示，不伪造；coverage 数据保留） |

`ok=false, verified=false` **仅因首屏预算未达 500 ms 拟验收基线**（契约 §2“拟验收预算，待实测校准”），
未调整预算；其余 12/13 检查通过，layers `{engine:true, dsh_host:true, fixture:true}`。

说明：verifier 侧同工具早前独立 run 的首屏 hot 为 p50 646/p95 704 ms，本次 Lead 复跑为 1078/1141 ms；
两次都未达 500 ms 预算，机器负载不同导致波动，**结论一致：首屏热路径需要优化后复测**。耦合定位两次都
远低于 120 ms（3–6 ms）。

## 2. 方法

- 500 节点/800 边：引擎 CLI 冷样本（每样本新子进程，20）、in-process 投影（同进程，cold=首调、hot=其余）；
  真实 dsh web：点击入口→视图 ready（hot=同进程重选，20；cold=整页 reload/重选，默认关闭）、
  coupling 资源→函数高亮与 tree→file 行高亮（各 20）、pointermove→下一 rAF 边路径更新（20）。
- 2,000 节点/10k 事件：真实导入并选中（入口 1600），e2e 加载耗时、搜索 5 次、事件序列截断反馈 5 次，
  coverage/truncated 原样保留。
- p50/p95 为记录样本的 nearest-rank 百分位；预算是契约 §2 的拟验收基线，工具只记录不改预算。
- 探针时间盒：`RV_TIMEOUT_MS=600000`（<父进程 15 min），任何退出路径先写 `RV_OUT` partial 结果；
  cold/tree/drag 默认跳过并记 not_verified（`PERF_COLD_SAMPLES` 可显式开启 cold）。

## 3. 合成夹具声明与限制

- fixture 由 `tools/perf/make-synthetic-graph.mjs` 从 Demo Atlas 模板确定性生成，**SYNTHETIC、非真实仓库**；
  manifest `graph_hash=sha256(graph.json)`，经真实引擎 `snapshot-import` 校验后导入。
- 合成图只作规模/截断/搜索反馈证据，**不代表真实仓库或 Linux/Kbuild 行为**；入口邻域视图只渲染局部子图，
  “真实加载”证据以导入/entries/coverage 为准。
- cold/tree/drag 在合成夹具/一次性 token 限制下不可测，已如实记入 `in_scope_not_verified`，未伪造样本。

## 4. 产物

| 文件 | 说明 | sha256 |
|---|---|---|
| `verification.json` | 权威报告（56,464 B）：机器信息/原始样本/p50/p95/预算判定/覆盖/失败数/not_verified（56,464 B 为最终复跑值，每次运行重新生成） | `536f01aad2a7460df0d3ecc6f28f319bc26c2cee67ab51d4cb532e130c0b3f81` |
| `commands.log` | 实际命令（fixture 生成、in-process bench、Chromium 探针、仓库测试等 argv/exit/cwd） | `15708d54df9b262b5f3253d2c3943ecd19514917c84f16926c18d9c3b410a7d3` |
| `scratch/perf/perf-probe.json` | 探针原始结果（14,279 B；`metric_status`/`failures`/原始样本） | `0e2ead6d07085b6e198fd7ef0c1e4f308e920259081be4e122711c58cb46d6b8` |

工具：`tools/verify-perf.mjs`、`tools/perf-probe.cjs`、`tools/perf/make-synthetic-graph.mjs`、
`tools/perf/inproc-bench.py`（均非产品运行路径）。仓库 Node `164/164`、引擎 `309 tests OK`（含 Windows
签名密钥文本模式修复回归）见 `evidence/ai-summary/` 的测试日志。
