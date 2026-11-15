# S4-prep AI 归纳（含入口 subject，T44）· 独立黑盒验收证据

本目录是 **verifier（独立验收者）** 对 S4-prep AI 归纳切片的验收产物。验收只读：不改插件实现、
不联网（仅本机回环 HTTP）、不写真实 `%USERPROFILE%\.dsh`、不重启桌面宿主、无 git 提交。
契约依据：[docs/ai-summary-perf-contract.md](../../docs/ai-summary-perf-contract.md)、
[docs/five-view-contract.md](../../docs/five-view-contract.md)。S1/S2a/S2b/S3a/S3b 成果分别在
`evidence/readonly-slice/`、`five-views/`、`s2b/`、`s3/`、`s3b/`（均未改动）。

## 1. 最终结论（T44，2026-11-15T23:19–23:22 UTC；上一轮 49/49 → 本轮 56/56）

`node tools/verify-summary.mjs --with-repo-tests` → **`ok=true, verified=true`，56/56 检查通过**，
`in_scope_not_verified=[]`、`out_of_scope_not_verified=5`；layers 全 true；
**运行 193.2 s（duration_ms 177,442）**。

| 层 | 结果 | 证据 |
|---|---|---|
| `demo_observed` | ✅ Demo 8/8 | `demo.code_view_demo_tests` |
| `atlas_snapshot`（真实引擎 summary-put/view-summary；function/entry/group + 非法 payload） | ✅ | `atlas.summary_*` |
| `dsh_host`（隔离 dsh web gap/written + **entry 子块/另一个无 entry 归纳入口** + RPC + Cordis + 回归） | ✅ | `host.summary_*` / `host.rpc_*` / `dsh_host.summary_host_runtime` |
| 仓库 Node 全量 | ✅ **200/200** | `dsh_host.repo_node_tests` |

## 2. 本轮新增：entry subject 归纳（T44）检查项

引擎/证据（real CLI，隔离 state）：
- `atlas.summary_entry_put`：真实 `summary-put` 写 `subject_type=entry, subject_id=f_afa8298f2d197e5fd110e49a`
  （bus_send 入口函数 id），text≤500、facts 含真实 `e_231505a73a485bc1d8c9249d`、
  generator `{agent, verify-entry}`、labels `from_static_structure`；投影 text/facts/generator/generated_at/
  stale=false，无绝对路径。
- `atlas.summary_entry_view`：`view-summary --subject-type entry --subject-id …` 读回一致。

dsh-web（真实 Chromium 探针）：
- `host.summary_entry_probe`：选中 bus_send 详情 → **`[data-ai-summary-entry]` 出现**，
  `[data-ai-summary-entry-text]` 原文精确匹配；`[data-ai-summary-entry-generator]` = `agent / verify-entry`、
  `[data-ai-summary-entry-generated-at]` 为 ISO 时间、`[data-ai-summary-entry-facts]` 含 `e_…`、
  `[data-ai-summary-entry-labels]` = from_static_structure、`data-ai-summary-entry-stale="false"`；
  **函数归纳仍正常显示**（written 原文仍在），console=0、无绝对路径。
- `host.summary_entry_absent_probe`：选中 **无 entry 归纳**的入口 bus_register → 无
  `[data-ai-summary-entry]` 子块、无 `[data-ai-summary-entry-gap]`、无新增 gap；函数归纳缺口逻辑不变
  （`[data-ai-summary-gap]` 仍只有 1 个，文案“AI 归纳未生成（Agent 可通过 code_summary 写入）”）。
- `host.summary_entry_screenshots`：新增 `entry.png`（与 gap/written 不同帧）。
- `host.summary_entry_console_clean`：entry/absent 两阶段 console error = 0。
- `host.rpc_summary_entry`：真实 RPC `view.summary {subject_type:'entry'}` 返回同一条记录
  （text/facts/generator/stale=false，无路径）。
- `dsh_host.summary_host_runtime`：真实 Cordis 工具 put/get 仍通过；因 entry subject 与入口函数共享 id，
  verifier 测试按 `subject.type` 一并过滤（tools-only 修正，不改插件）。

## 3. 关键 DOM / 数据（实测）

- entry 子块文本：`bus_send 入口归纳：先校验通道与长度，再查路由表；长度上限取 route->max_len，
  超长返回 -22。此归纳基于静态结构与源码文本，未含运行观测。`
- `[data-ai-summary-entry-generator]`：`generator：agent / verify-entry`
- `[data-ai-summary-entry-generated-at]`：`生成于 2026-11-15T15:19:48Z`
- `[data-ai-summary-entry-facts]`：`事实引用 1（evidence×1）：e_231505a73a485bc1d8c9249d`
- `[data-ai-summary-entry-labels]`：`推断标签：from_static_structure`；`data-ai-summary-entry-stale="false"`
- 函数归纳原文仍可见（written 阶段同一详情）；无 entry 归纳的 bus_register：entry 子块不存在，
  gap_count=1（仅函数归纳缺口），无 entry-gap；两阶段 console=0、绝对路径=0。

## 4. 运行命令

```powershell
node tools\verify-summary.mjs --with-repo-tests
# 单项开关：--skip-probes / --skip-regression / --skip-host-runtime / --skip-demo / --skip-http
```

隔离运行时在 `04-code-learning/scratch/summary/`（`.gitignore` 覆盖 `scratch/`）。
工具：`tools/verify-summary.mjs`、`tools/summary-probe.cjs`、`tools/summary-host-runtime.test.mjs`。

## 5. 产物与 sha256

| 文件 | 说明 | sha256 |
|---|---|---|
| `verification.json` | 权威报告 56 checks / layers / 命令 / not_verified（206,895 B） | `398279282ede2f0ca956cf8820c5ac64adc7275229cd00aec3b31bccf65afcf3` |
| `entry.png` | bus_send 详情：函数归纳 + **入口归纳子块**（167,954 B） | `dc151ab77810498b6383859c618432e9c1727887bbcccd5c0681c8f9588421bd` |
| `written.png` | 函数归纳写入后详情（185,829 B） | `3983b5411060c8d352267565ad44728a539c1ed34f067d572e5f4297013c35fb` |
| `gap.png` | 未写入：函数/入口归纳 gap 阶段（141,363 B） | `50a5f79c1239e1b92e20216a4fb93a265f20c34538f62c0eacea3c859888414d` |
| `host-runtime.tap` | 真实 Cordis code_summary put/get（TAP 1/1） | `43bd83816c326b6695a10b3d0562191c57736c046ee5427c0fd98a356b73b10d` |
| `commands.log` | 引擎/RPC/探针/回归/Node/Demo 命令（14,694 B） | `f05c14d19a0c6421a15e581116c65a3ccd4eb1abd3a6af558f81bc9116e58284` |
| `README.md` | 本文件 | 见目录实际哈希 |

## 6. 回归（本轮同一 run + 独立 perf-regressions 包）

- verify-summary 内：S3b 探针、S3a 回归（`residual_failed_steps=[]`）、S2b、S2a、S1 探针全过；
  Cordis host runtime 1/1；仓库 Node **200/200**、Demo **8/8**；console=0、无绝对路径。
- 独立 `node tools/perf-regressions.mjs`（S3b/S3a/S2b/summary 四探针，117.9 s）→ **4/4 检查通过**；
  S3a `residual_failed_steps=[]`；5 个探针 console error=0。
- 结论：**未发现 entry subject 归纳引入的真实回归**；入口子块静默语义与旧有函数归纳/缺口行为一致。

## 7. `not_verified`

`in_scope_not_verified=[]`（T44 检查全部通过；无新增 not_verified）。
`out_of_scope_not_verified=5`：
1. 插件/模型侧自动生成归纳正文（插件不调用模型；正文由 Agent 经 code_summary/summary-put 写入）；
2. 真实 Linux/Kbuild + CFG/locks/aliases 深分析（S4 后续）；
3. 真实设备下发/图内源码写回；
4. 真实 Linux/Kbuild index、CFG/locks/aliases/dataflow、目标验证、性能预算（S4 范围）；
5. OS 级出口认证（仅本机回环 HTTP/本地进程观测）。

## 8. 已知限制

- 入口归纳的 subject_id 使用入口函数 id（bus_send `f_afa…`）；与 function subject 同 id 时靠
  `subject.type` 区分（引擎/RPC/UI 均按 type+id 匹配）。
- 入口归纳请求失败静默为契约行为；本轮 entry 成功与 entry 缺失两条路径均验证，未构造网络层失败注入。
- AI 归纳语义质量不做评分；只校验结构（text/facts/generator/labels/stale）与 subject 归属。
- 恢复/刷新时入口子块与函数归纳一起 abort/丢弃旧响应；本轮以重选/刷新序列验证，未做长期竞态压测。
