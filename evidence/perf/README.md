# S4-prep performance evidence（合成夹具，A11 实测；Lead 最终独立复跑，含 T28 优化前后对比）

生成命令：`node tools/verify-perf.mjs --with-repo-tests`（Lead 最终复跑 2026-11-15T21:52+08 启动，
duration 251.9 s；verifier 同工具复测 257.4 s，两次独立实测）。参考机：13th Gen Intel Core i7-13700F
（24 逻辑 CPU）、34.19 GB RAM（复跑时 12.57 GB 空闲）、win32 x64 / Windows 10.0.26200、Node 26.13.0。
固定宿主：`E:\dsh\DeepSeek Harness.exe` sha256 `7ae939b5…0cc4`、`E:\dsh\resources\app.asar`
sha256 `e1b6f25f…6915`、dsh `0.2.1-rc.5`（内嵌 Node 24.21.0 / Electron 44.7.0）。

## 1. 结论（预算判定；两次独立 run 均为 p95 未达 500 ms）

| 指标 | 样本 | p50 | p95 | 预算 | 判定 |
|---|---|---|---|---|---|
| 首屏 hot（点击入口→视图 ready） | 20/20 | **646 ms**（verifier run 705） | **704 ms**（verifier run 769） | ≤500 ms | ❌ **未达标** |
| 跨视图 coupling（资源行→函数高亮） | 20/20 | 2 ms | **3 ms** | ≤120 ms | ✅ 达标 |
| 跨视图 tree→file 行高亮 | 0 | — | — | ≤120 ms | in_scope_not_verified（合成夹具无真实 file evidence/可定位目标，不伪造） |
| 拖动反馈（pointermove→rAF 边路径更新） | 0 | — | — | ≤32 ms | in_scope_not_verified（合成 4 节点邻域无可拖边目标，不伪造） |
| 首屏 cold（整页 reload/重选 ×20） | 0 | — | — | ≤500 ms | in_scope_not_verified（一次性 host URL token 使重复 reload 不稳定；不伪造；`PERF_COLD_SAMPLES=20` 可显式开启） |
| 引擎 CLI 冷投影（4 视图各 20） | 20/20 | 132–138 ms | 135–150 ms | — | 记录（子进程冷启动） |
| in-process 投影（4 视图各 20） | 20×4 | 21.4–24.0 ms | 22.9–26.6 ms | — | 记录（首调 26.3–27.8 ms） |
| 2000 节点/10k 事件加载 | 真实导入 | e2e ready **957 ms**、入口 1600 | — | 分片/截断反馈 | ✅（coverage=truncated 保留；UI「已截断」文本未显示记 not_verified） |
| 2000/10k 搜索 / 事件序列 | 5 / 5 | 1 ms / 3 ms | 2 ms / 4 ms | — | ✅ |

19 项检查 **18 通过，1 失败（仅首屏预算）**；`ok=false, verified=false` 仅因首屏预算未达拟验收基线
（未调预算），layers `{engine:true, dsh_host:true, fixture:true, demo_observed:true}`。
2000/10k 图「已截断」UI 文本本轮未显示，不伪造，单列 not_verified（真实加载/搜索/事件序列已实测）。

## 2. T28 优化前后对比（同机独立实测）

| 指标 | T27 优化前 | T29/T28 优化后（Lead 复跑） | 变化 |
|---|---|---|---|
| 首屏 hot p50 / p95 | 1078 / 1141 ms | **646 / 704 ms** | −40.1% / −38.3% |
| coupling p50 / p95 | 3 / 6 ms | 2 / 3 ms | −33% / −50% |
| 引擎 CLI entries p50/p95 | 209 / 228 ms | 132 / 135 ms | −37% / −41% |
| 引擎 CLI e2e p50/p95 | 212 / 227 ms | 138 / 150 ms | −35% / −34% |
| 引擎 CLI coupling p95 / tree p95 | 218 / 232 ms | 145 / 139 ms | −33% / −40% |
| in-process 热 p50（4 视图） | 34.7–37.0 ms | 21.4–24.0 ms | −35% |
| 2000/10k 图 load | 1842 ms | **957 ms** | −48% |
| 2000/10k 搜索 / 事件 p95 | 5 / 6 ms | 2 / 4 ms | −60% / −33% |

优化手段（T28，client only）：入口选择 `getEntry/coupling/interfaces` 同 tick 并行；entries 就绪后 40 ms
空闲预取首个入口、hover/focus 预取；会话内只读 LRU≤32 + in-flight 去重；snapshot 切换/刷新清空缓存；
ready 仍由真实 payload 决定（无假数据/延迟），既有 DOM/gap/error 语义不变。**验证 174/174 Node 测试**。

**为何仍超预算**：Host `lib/bridge.mjs` 对 Engine CLI 串行执行；新入口首屏仍需 4 个 RPC
（getEntry + coupling + interfaces + 当前视图）≈ 4×130 ms + 渲染。**待实现（下一轮）**：与设计 §5
“Host 合并同键只读计算”一致的**批量首屏端点**（一次 RPC 返回 entry+所需视图投影并填充缓存），目标把
hot p95 压到 500 ms 内后复测；本轮不作达标声明。

## 3. 方法 / 证据 / 限制

- 500/800：引擎 CLI 冷样本（每样本新子进程，20）、in-process 投影（cold=首调、hot=其余）、真实 dsh web
  首屏 hot（同进程重选 20；cold 默认关闭）、coupling 资源→函数高亮（20）、tree→file（20，夹具限制跳过）、
  pointermove→rAF（20，夹具限制跳过）。
- 2,000/10k：真实导入并选中（入口 1600），e2e 加载、搜索 5、事件序列截断 5；coverage/truncated 原样保留。
- p50/p95 为记录样本 nearest-rank；“首屏≤500 ms / 定位≤120 ms / 拖动≤32 ms”为契约 §2 拟验收基线，只记录
  不改预算；T29 起 `verify-perf` 附带 perf-regressions（S3b/S3a/S2b/summary、console clean、Demo、Node）。
- **合成夹具声明**：`tools/perf/make-synthetic-graph.mjs` 从 Demo Atlas 模板确定性生成，合法 Atlas 0.1
  envelope（manifest graph_hash=sha256(graph.json)）经真实引擎 `snapshot-import` 校验；**SYNTHETIC、非真实
  仓库**，只作规模/截断/搜索反馈证据，不代表真实仓库或 Linux/Kbuild 行为。
- 机器信息（CPU/RAM/OS/Node/宿主）与原始样本、p50/p95、预算判定、覆盖/失败数见 `verification.json`。

## 4. 产物（Lead 最终复跑后当前值）

| 文件 | 说明 | sha256 |
|---|---|---|
| `verification.json` | 权威报告（63,907 B）：containers/layers/19 项检查/原始样本/p50/p95/预算/not_verified | `ff777227965aa658e7f660d869c43ce5443180cb4eb182c0234b7a44dd235538` |
| `commands.log` | 实际命令（fixture 生成、in-process bench、Chromium 探针、perf-regressions、仓库测试） | `1755273952ea16208744cafee9e6daec36e63e262eb033c44fee809adf6e88d0` |
| `scratch/perf/perf-probe.json` | UI 探针原始结果（14,257 B，含 metric_status/原始样本/failures） | `8db34acb68e9a0504fd91fe5253fa34cc0dfe9e3be99a78db20d367210defb44` |
| `scratch/perf/regressions/regressions.json` | T29 回归包结果（S3b/S3a/S2b/summary 四探针 + console/Demo/Node） | 见该文件 |

工具：`tools/verify-perf.mjs`、`tools/perf-probe.cjs`、`tools/perf/make-synthetic-graph.mjs`、
`tools/perf/inproc-bench.py`、`tools/perf-regressions.mjs`（均非产品运行路径）。
