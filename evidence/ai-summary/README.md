# S4-prep AI 归纳（CW-09）· 独立黑盒验收证据

本目录是 **verifier（独立验收者）** 对 S4-prep AI 归纳切片的验收产物。验收只读：不改插件实现、
不联网（仅本机回环 HTTP）、不写真实 `%USERPROFILE%\.dsh`、不重启桌面宿主、无 git 提交。
契约依据：[docs/ai-summary-perf-contract.md](../../docs/ai-summary-perf-contract.md) §1（CL-VIEW-T4A）。
S1/S2a/S2b/S3a/S3b 成果分别在 `evidence/readonly-slice/`、`five-views/`、`s2b/`、`s3/`、`s3b/`（均未改动）。

## 1. 最终结论（2026-11-15T19:50+08:00）

`node tools/verify-summary.mjs --with-repo-tests` → **`ok=true, verified=true`，49/49 检查通过**，
`in_scope_not_verified=[]`，`out_of_scope_not_verified=5`；layers 全 true。

| 层 | 结果 | 证据 |
|---|---|---|
| `demo_observed` | ✅ 8/8 | `demo.code_view_demo_tests` |
| `atlas_snapshot`（真实引擎 summary-put/view-summary，含非法 payload 拒绝与组 subject） | ✅ | `atlas.summary_*` |
| `dsh_host`（隔离 dsh web 两阶段探针 + RPC + Cordis code_summary put/get + 回归） | ✅ | `host.summary_*` / `host.rpc_*` / `dsh_host.summary_host_runtime` |
| 仓库 Node 测试 | ✅ 164/164 | `commands.log` 末行 |

## 2. 运行命令

```powershell
node tools\verify-summary.mjs --with-repo-tests
# 单项开关：--skip-probes / --skip-regression / --skip-host-runtime / --skip-demo / --skip-http
```

隔离运行时在 `04-code-learning/scratch/summary/`（`.gitignore` 覆盖 `scratch/`）。

## 3. 产物与 sha256（Lead 最终独立复跑后目录内当前值；每次运行重新生成报告/截图，值随之变化）

| 文件 | 说明 | sha256 |
|---|---|---|
| `verification.json` | 权威报告（159,320 B） | `3ac29d50d5f528542f53a464454c54eccef2f69c13e821c52ac9f1376ca7b974` |
| `gap.png` | 未写入：详情显示「AI 归纳未生成（Agent 可通过 code_summary 写入）」gap、无正文 | `50a5f79c1239e1b92e20216a4fb93a265f20c34538f62c0eacea3c859888414d` |
| `written.png` | 写入后：原文、generator `agent / verify-summary`、generated_at、事实引用 `e_…`、推断标签、stale=false | `724c7ca8dd6d62e3bf1fcf1d535053dcaeb2217656ac61047f3e230fee7d0baf` |
| `host-runtime.tap/json` | 真实 Cordis：code_summary 工具 put/get、非法 put 拒绝、dispose/二次挂载持久化 | TAP 1/1（`2e9c2356…9439` / `b875fa65…e835`） |
| `s3a-*` / `s2a-*` / `s2b-*` / `s1-regression.png` | S3b/S3a/S2b/S2a/S1 回归截图 | 见 `verification.json` |
| `commands.log` | 实际命令（含真实 summary-put argv/exit code） | `666b6707388a262cce0de7514c4596fb8a696551f7133d17c29bcd88badc7dc3` |

工具：`tools/verify-summary.mjs`、`tools/summary-probe.cjs`、`tools/summary-host-runtime.test.mjs`。

## 4. 关键验收证据（契约 §1.5）

1. **未写入 gap**：选中 `bus_send` 函数详情 → `[data-ai-summary-gap]` 存在，`[data-ai-summary-text]` 不存在；
   探针 console=0、无绝对路径，截图 `gap.png`。
2. **真实引擎写入（模拟 Agent）**：隔离 state 内
   `summary-put --workspace code-view-bus-demo --snapshot <snap> --payload-json <b64>`，payload：
   subject `{type:function,id:f_afa8298f2d197e5fd110e49a}`、text（约 120 字 ≤500）、
   facts `[{kind:'evidence',ref:'e_231505a73a485bc1d8c9249d'}]`（真实 e_ evidence id）、
   generator `{kind:'agent',ref:'verify-summary'}`、labels `['from_static_structure']`；
   返回投影含 text/facts/generator/generated_at/snapshot_graph_sha256/stale=false，`view-summary` 读回一致。
3. **UI 显示**：页面重新加载/重选后 `[data-ai-summary-text]` 原文、`[data-ai-summary-facts]` 含 e_ 事实、
   `[data-ai-summary-generator]`=agent / verify-summary、`[data-ai-summary-generated-at]`、stale=false、
   gap 消失；探针 17 项全 true（`host.summary_written_probe`），截图 `written.png`。
4. **非法 put**：>500 码点 → `LIMIT_EXCEEDED`；控制字符 → `INVALID_ARGUMENT`；facts ref 非法
   （`../etc/passwd`）→ `INVALID_ARGUMENT`；三次均被拒且**原 summary 未被覆盖**（`atlas.summary_invalid`）。
5. **组 subject**：`group:f_ec61140249f393550eb97946:294d40d8` put/get 成功，投影含
   `limitations:["subject_existence_not_verified",…]`，RPC `view.summary` 可读（`atlas.summary_group`、
   `host.rpc_summary_group`）。
6. **View.status**：caps `ai_summary_store=true`、`ai_summary=false`；gaps `ai_summary`（reason：
   「归纳正文由 Agent 经 code_summary 写入；插件不调用模型」）+ `real_device_dispatch`。
7. **RPC**：`view.summary` 读回（无写时 gaps 含 `ai_summary_not_generated`，本验收在写入后读取）；
   `view.status`/`listSnapshots`/401 准入等基础检查通过。
8. **Cordis**：真实挂载后 `code_summary` 工具注册（7 工具），经工具 handler→bridge→真实 Python
   写读成功；非法 501 字被 Host 拒；dispose/二次挂载后缓存仍在且再次 put/get 成功（TAP 1/1，1.2s）。
9. **回归**：S3b 探针 ok、S3a 探针 `residual_failed_steps=[]`（`s3bGap/traceImportGap/capabilityGaps/undoDisabled`
   属 S3b 已实现而正当取代）、S2b 全过、S2a 全过（`gapsOriginal`/`stubPanel` superseded）、S1 全过；
   console 均 0。Demo 8/8、仓库 Node 164/164。

## 5. 实际 DOM 钩子（契约 §1.4）

实际实现与契约一致：`[data-code-view="ai-summary"]`、`[data-ai-summary-text]`、
`[data-ai-summary-generator]`、`[data-ai-summary-generated-at]`、`[data-ai-summary-facts]`、
`[data-ai-summary-labels]`、`[data-ai-summary-stale]`、`[data-ai-summary-gap]`、
`[data-ai-summary-error][data-error-code]`（本次未触发错误态）。组详情：点击组框打开「组详情」并显示组归纳
（验收以 RPC/引擎投影与探针对照记录；组详情 UI 截图未作为独立证据帧，组数据面已由 atlas/RPC 覆盖）。
未记录到契约差异需要 client 修改。

## 6. `not_verified` 与局限（如实声明）

`in_scope_not_verified=[]`（契约 §1.5 全部通过）；`out_of_scope_not_verified` 5 项：

1. 插件/模型侧自动生成归纳正文（插件不调用模型；正文由 Agent 经 code_summary 写入——本验收以模拟 Agent 的
   真实 CLI 与工具调用证明写入/读取/展示链路）；
2. AI 归纳的语义质量（是否把候选/未知写成确定事实）不做评分，仅校验 facts/generator/labels/stale 结构；
3. 真实 Linux/Kbuild 与 CFG/locks/aliases 深分析（S4 后续）；
4. 真实设备下发 / 图内源码写回；
5. OS 级出口认证（仅本机回环 HTTP/本地进程观测）。

另：本工具以真实引擎 CLI `summary-put` 模拟 Agent 写入（与 Host `code_summary` put 使用同一引擎路径）；
Cordis 测试额外通过真实工具 handler 完成一次真实 put/get。engine 307 unittest 由团队执行与报告。
