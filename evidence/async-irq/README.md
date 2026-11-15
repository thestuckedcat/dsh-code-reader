# S4-prep 异步/IRQ 事件边界（T41）· dsh-web 独立验收证据

本目录是 **verifier（独立验收者）** 对 T39/T40 异步/IRQ 增量的验收产物
（契约 [docs/scenario-contract.md](../../docs/scenario-contract.md) §11.3）。验收只读：不改生产代码、
不联网（仅本机回环 HTTP/本地进程）、不写真实 `%USERPROFILE%\.dsh`、不重启桌面宿主、无 git 提交。

## 0. 夹具版本差异（rev1 vs rev2）

| 夹具 | sha256 | async 声明 | 用途 |
|---|---|---|---|
| `evidence/scenario-sim/inbox/sim-profile.json`（rev2，Lead 更新） | `1c9ae1553f06486353cb0044f11d96fc0f1fc58eca13e9fe8dfca99747c298d9` | 顶层 `async_events:["IRQ"]` | 本轮真实 wasm 运行 + async observed 验收 |
| `evidence/scenario-sim/inbox/bus.wasm` | `69c8622d3522f68f90450a2db36ee11a85c859c91bdf2b5df1688fd6acd1321c` | — | Demo Wasm 模块；`bus_irq` 真实产生 `IRQ[1,0,0]` |
| `evidence/scenario-sim/inbox/trace-bus-send.json`（rev1 轨迹） | `8860df515c39ae26cf62edfc8da74f454bcc3e65677092a7559aaf6d05d47e06` | 无 `async_events` | 旧行为回归：导入台账 observed 无 async 标记 |
| 构造导入轨迹 `trace-async-irq.json`（隔离 inbox，verifier 生成，不写本目录） | — | `async_events:["IRQ"]` | 备用/额外验证导入台账 async 声明路径（真实 bus_irq 已产生 IRQ，非必需 fallback） |

rev1 历史证据仍有效：`evidence/s3`（S3a）与 `evidence/s3b` 的 profile/trace digest 与行为记录不因 rev2 失效；
rev2 仅新增可选字段，rev1 缺省为空 = 无异步事件。

## 1. 最终结论（2026-11-15T14:55:46–14:58:28 UTC）

`node tools/verify-irq.mjs --with-repo-tests` → **运行 162.8 s（duration_ms 161,931）**；
**34 项检查全部通过（34/34），0 失败**；layers
`{atlas_snapshot:true, dsh_host:true, demo_observed:true}`；`in_scope_not_verified=0`、
`out_of_scope_not_verified=5`；**`ok=true, verified=true`**。
**参考 host**：DeepSeek Harness `0.2.1-rc.5`（exe sha256 `7ae939b5…0cc4`、app.asar `e1b6f25f…6915`，pinned gate 通过）。
**bus_irq 真实产生 IRQ（无需 fallback）**：`reset → bus_register(1) → bus_irq()` 真实 wasm 台账
records 结果 `[null, 0, 0]`，`bus_irq` 事件 `["IRQ"]`。

## 2. 引擎 / Host 分层证据

### atlas_snapshot（真实引擎 CLI）
- **rev2 profile 导入/list**：`sim-profile-import` 成功；`sim-profile-list` 的 profile 含
  `async_events:["IRQ"]`、7 个接口（含 `bus_irq` entry）；无绝对路径。
- **真实 wasm 运行 + 台账**（经 Host `scenario.run`，真实隔离 worker）：
  `{"generation":0,"stop_on_error":true,"steps":["reset","bus_register(1)","bus_irq"]}` →
  records 3 条（`reset` null / `bus_register` 0 / `bus_irq` 0），`bus_irq` 产生 `IRQ` 事件；
  scenario `scn_7b5258892e19`。
- **observed DTO**：`view-sequence-observed`（engine CLI）与 Host `view.sequence observed` 均返回顶层
  `async_events:["IRQ"]`；`IRQ` 消息 `async:true`（真机 message label `IRQ: write irq_count` / `IRQ`）；
  `imported async trace`（`scn_e301506ffcad`）亦 `async:true` + 顶层 async_events；无绝对路径。
- **非法 async_events 拒绝（且不写台账/profile）**：
  `duplicate` / `unknown` / `non_array` / `too_many(>16)` 四种变体对
  `sim-profile-import` 与 `trace-import` 均返回 `INVALID_ARGUMENT`（错误信息明确）；
  profile 数 1→1、scenario 台账数 1→1（无写入）。
- 导入轨迹声明：`trace-async-irq.json` 导入成功，limitations 含 `async_events_declared`；
  无声明 rev1 轨迹导入行为与 S3b 相同。

### dsh_host（真实 dsh web RPC + Chromium DOM）
- `scenario.listProfiles` 返回 profile `async_events:["IRQ"]`；`scenario.run` 真实执行 bus_irq（无绝对路径）。
- `view.sequence observed`：IRQ 消息 `async:true`、顶层 `async_events`；static 模式 `observed=false` 且无任何
  `"async":true`；rev1 导入轨迹 observed 的 async 消息数 **0**、无 `async_events` 声明（旧行为不变）。
- `trace.import` 携带非法 async_events → `INVALID_ARGUMENT`，台账前后数量一致（不写台账）。

## 3. 关键 DOM 证据（dsh-web observed，真实 Chromium 探针）

| 钩子/对象 | 实测 |
|---|---|
| `[data-sequence-async="true"]` | **1** 个（IRQ 消息）；文本含 `IRQ: write irq_count` / `event IRQ #17` / `异步` |
| `[data-sequence-async-chip]` | 1 个 `<span class="dcr-chip dcr-seq-async-chip">异步</span>` |
| `[data-sequence-async-note]` | 1 个，文案 **“异步：由中断/完成事件触发，仍来自已执行或导入的台账”** |
| static 模式 | `[data-sequence-async="true"]` 数量 **0**，无 chip/note |
| rev1 导入轨迹 observed | async 标记 **0**，无 chip/note（旧行为不变） |
| console error | **0** |
| 绝对路径泄漏 | **0**（panel 文本扫描） |
| 截图 | `evidence/async-irq/async-irq.png`（163,779 B，sha256 `36907e95…fe022`） |

## 4. 回归（同一 run，全部通过）

- S3b、S3a（`residual_failed_steps=[]`，console 0）、S2b、summary gap→真实 put→written（`perf-regressions` 包）；
- 5 个回归探针 console error = 0；
- 仓库 Node 全量：**195/195 pass**；Demo：**8/8 pass**。

## 5. `not_verified`

`in_scope_not_verified = 0`（契约 §11.3 全部检查通过）。`out_of_scope` 5 项：

1. **真实硬件 IRQ 因果/中断完成判定**：`async:true` 只表示该事件在 profile 中被声明为异步触发，
   不推断硬件中断已发生（契约 §11.2 明确）；
2. **真实设备/外部轨迹采集与下发**：S4 后续；本轮只验证已执行 Wasm 台账与导入轨迹的异步边界标记；
3. **跨进程异步调度/时序竞态证明**：台账只记录顺序与事件，不建模调度器；
4. **rev1 历史证据重跑**：rev1 profile/trace 的 S3a/S3b 证据在 `evidence/s3`、`evidence/s3b` 保持有效；
5. **480 KiB 内核/大 payload 的 async 变体**：限流路径由引擎/Node 测试覆盖，本轮夹具远低于上限。

## 6. 复现

```powershell
node tools\verify-irq.mjs --with-repo-tests
# 可选：--skip-probes / --skip-regression
```

流程：pinned host gate → 隔离 `DSH_HOME` + inbox（rev2 profile、bus.wasm、rev1 trace、构造 async trace）
→ 真实引擎 `workspace-import`/`snapshot-import`/`sim-profile-import`/`trace-import`（含非法 async 变体）
→ 启动真实 dsh web → RPC `scenario.run` bus_irq + `view.sequence` observed/static + `trace.import` 负例
→ Chromium 探针（observed async/chip/note，static/rev1 无标记，console/路径扫描，截图）
→ `perf-regressions` + Node 全量 + Demo → 写 `evidence/async-irq/`。

## 7. 产物与 sha256

| 文件 | 说明 | sha256 |
|---|---|---|
| `verification.json` | 34 checks / layers / config / 命令 / not_verified（46,736 B） | `3808090963607283cf329cad263f83d75a44d82a9d636fcf6bbe4a88fe3dcf94` |
| `async-irq.png` | observed [data-sequence-async] IRQ + 异步 chip/note 截图（163,779 B） | `36907e95a96fd29d3f47d16c9e2a1971a81a4ecd7219fbc5fb9da1de378fe022` |
| `commands.log` | 引擎/导入/RPC/探针/回归/Node/Demo 命令（6,398 B） | `bf4937846e14046b60cb1cbfb18850aedcfb8064f560c462672f465151d80409` |
| `README.md` | 本文件 | 见目录实际哈希 |

辅助：`scratch/irq/irq-probe.json`（DOM 探针原始结果，含 async chip/note/console 记录）、
`scratch/irq/irq-probe.log`、`scratch/perf/regressions/regressions.json`（回归包）。

工具：`tools/verify-irq.mjs`、`tools/irq-probe.cjs`（新增）；复用 `tools/readonly-slice/*`。

## 8. 已知限制

- Demo Wasm 夹具来自 `evidence/scenario-sim/inbox`；`IRQ` 是声明事件并由真实 wasm 执行产生，
  但**不代表真实硬件中断**，也不推断因果完成（out_of_scope 1）。
- rev2 fixture sha256 已固定为 `1c9ae155…`；rev1 历史证据不重跑；若后续 fixture 变更需重跑本工具。
- 非法 async_events 的失败路径只验证“拒绝且不写台账/profile”，不构造超大 payload/限流交互。
- UI 测量经隐藏窗口（opacity=0）与 DOM 探针；截图为主视图，不逐像素比对。
- in_scope 全部通过；out_of_scope 5 项已在 verification.json/README 明确列出，未写成已通过。
