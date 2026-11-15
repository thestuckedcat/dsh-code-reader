# 04 只读五视图（S2a）· 独立黑盒验收证据

本目录是 **verifier（独立验收者）** 对 S2a「只读五视图」阶段的验收产物。验收只读：不修改插件实现、
不联网（仅本机回环 HTTP）、不写真实 `%USERPROFILE%\.dsh`、不重启用户桌面宿主、不做 git 提交。
契约依据：[五视图契约](../../docs/five-view-contract.md) §5（DOM 钩子）/§7（dsh-web 逐视图验收）；
上一阶段：[只读工作台切片契约](../../docs/readonly-workbench-contract.md) 与
`evidence/readonly-slice/`（S1 证据保留未动）。

## 1. 最终结论（2026-11-15T14:55+08:00，tree 14:45:42 后未变）

| 层 | 结果 | 证据 |
|---|---|---|
| `demo_observed`（Demo/Wasm 行为对照，非宿主） | ✅ 8/8 | `verification.json` → `demo.code_view_demo_tests` |
| `atlas_snapshot`（真实 Atlas 0.1 快照 + 真实 Python 六端点读模型） | ✅ 6/6 | `atlas.view_coupling` / `view_tree` / `view_end_to_end` / `view_file_tree` / `view_file_read` / `view_sequence` |
| `dsh_host`（pinned rc.5 宿主：隔离 profile → boot graph → `/code-view` → Chromium 逐视图 → 真实 Cordis 生命周期） | ✅ | `host.*` / `dsh_host.*`；`coupling/tree/end_to_end/sequence/file/main.png` |
| 仓库 Node 测试（附加检查） | ✅ 83/83 | `commands.log` 末行 |
| **总体** | **`ok=true, verified=true`**：37/37 检查通过，`in_scope_not_verified=[]` | `verification.json` |

> 分层口径：`demo_observed` 是 Demo 的 Wasm/JS 行为模型；`atlas_snapshot` 是已导入并核验的真实
> Atlas 0.1 快照（snapshot `ed326d554334432b907de21297207eb8`，graph sha256 `c6e49fe9…207c`）；
> `dsh_host` 是本机 pinned rc.5 宿主实测。三层分别标注、互不冒充。S2a 不提供运行观测。

## 2. 运行命令（复现）

在 `E:\dsh\plugin\04-code-learning` 下：

```powershell
# 全量 S2a 验收（门禁 → 隔离 profile + 真实快照 import → 六引擎端点 → 真实 dsh web
#   → boot graph/401 准入/10 端点 RPC → Chromium 五视图探针 + S1 回归探针
#   → 真实 Cordis 运行时 → Demo + 仓库 Node 测试），约 40–60s
node tools\verify-five-views.mjs --with-repo-tests

# 单项
node tools\verify-five-views.mjs --help            # 无 --help；参数见下
#   --skip-probe / --skip-regression / --skip-host-runtime / --skip-demo / --skip-http
#   --with-repo-tests （包含 node --test tests/node/*.test.mjs）
node tools\readonly-slice\host-baseline.mjs        # pinned 宿主门禁
node tools\readonly-slice\asar.mjs list --filter dsh-client-ui-layout
```

隔离运行时树在 `04-code-learning/scratch/readonly-home/`（`scratch/` 已被 `.gitignore` 忽略；
运行中日志/截图中间件保留，可随时删除）。探针中间 JSON：`scratch/five-views/five-views-probe.json`。

## 3. 产物清单与 sha256（Lead 最终独立复跑后目录内当前值；每次运行会重新生成报告/截图，值随之变化）

| 文件 | 说明 | sha256 |
|---|---|---|
| `verification.json` | 权威报告：layers/checks/not_verified/commands/limitations（96,493 B） | `2ce16854f02ecca884a0a7bafe28bb442e24ccf970d08ac1d3c35a53e83df726` |
| `coupling.png` | 资源关系图（152,889 B） | `19107fa241d76ff2d0cf6625b98a9ce30170dc2eea251bf7b4f40cafcdcd4805` |
| `tree.png` | 可折叠文字树（294,409 B） | `d757d65fd892061a1547bdec930baaef45ec365eed863d12142b50478a2e1d08` |
| `end_to_end.png` | 端到端图（198,163 B） | `9ef8a256ddcb0b0657e5fb941648696cd08f471841e84872378cb13b6f3c3cb0` |
| `sequence.png` | 静态预测时序图（374,135 B） | `80d4f5d11ce33c0b55111fd61037fd6096fe2b7078eb6cb34107367bb21f3da7` |
| `file.png` | 文件视图（219,935 B） | `ab62966196878cbfb3e633f8076e59e5e298e875b8a872de3f8de1b5b85011df` |
| `main.png` | 主流程图（端到端 + 适应，图例关闭） | `d0e6935e8c454f735515c2c3664b7ff904dd5a28fe4a1a68408ebe64941dc11c` |
| `regression-readonly-slice.png` | S1 回归探针截图 | `8d12d99508a1e8d6556de27030246f42cce34bfc1e5948ff09277fc7947817f7` |
| `host-runtime.json` / `.tap` | 真实 Cordis 运行时 TAP+JSON | `8db5f55dd0c33bcd34aa277aff73cbc5f78e90e8a94b644b8670e46718a27331` / `77ffb73af82d23aba68a23d219bdf6112cfeddacdae29212d9f513d2ef089d1b` |
| `commands.log` | 本次实际命令（含 exit code / cwd） | `4903cc7afcb26c6a2a129eb6a1bdb0ea3a2a35815422cd1cf502490fa35a9b18` |

## 4. 隔离运行环境（断言前提）

- 固定宿主：`E:\dsh\DeepSeek Harness.exe` SHA256 `7ae939b5…0cc4`；`E:\dsh\resources\app.asar`
  SHA256 `e1b6f25f…6915`；dsh `0.2.1-rc.5`；内嵌 Node `24.21.0` / Electron `44.7.0`；
  6 个已核 seam 文件逐字节 SHA+关键字复核（`host.pinned_baseline`）。版本/SHA 不符即失败。
- 隔离 `DSH_HOME`：`scratch/readonly-home/home`（非用户真实 `~/.dsh`）；web profile 的
  `bundles = ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@local/dsh-code-reader']`，
  `node_modules/@local/dsh-code-reader` junction 指向本仓库，`cordis.patch.yml = []`。
- 隔离 bootstrap：`home/code-reader/bootstrap.json`，candidate_roots `slice-root` →
  `evidence/code-view-slice`；state/inbox/output 隔离；用真实 `E:\Anaconda-main\python.exe`（3.11.4）
  执行 `workspace-import` + `snapshot-import`（snapshot `ed326d55…`）。
- Chromium 探针：本机 `C:\Users\admin\.dsh\electron\electron.exe` 仅作测试工具；窗口 `opacity=0 +
  showInactive`（用户不可见）以取得当前 composited 帧；宿主自身「预览版说明/开始使用」浮层仅在宿主 UI
  层关闭并在探针 JSON 记录，**工作台 DOM 断言不依赖浮层**。每个证据截图前滚动到视图、关闭宿主浮层并
  连拍两帧取后一帧，避免隐藏窗口的陈旧帧。
- Client bundle（最终）：仓库 `bundle/client.js` 162,105 B；服务端返回 162,185 B（精确前缀 +
  sourceMappingURL 后缀），含 `window.__ModuleLoader__.load(` 与 `@local/dsh-code-reader`。

## 5. 关键验收证据（全部来自最终运行）

### 5.1 dsh_host：隔离 profile / boot graph / RPC 接缝
- `dsh web` 真实启动；`__DSH_BOOT__` 71 条 client 条目含 `@local/dsh-code-reader`，其 `inject` 与
  `package.json` 的 `dsh.client.inject` 完全一致。
- 服务端 client bundle 200，字节 = 仓库 bundle 精确前缀。
- **无浏览器 cookie 直连 `POST /code-view/view.status` → 401 unauthorized**（connection admission
  拒绝，未伪造 cookie）；使用宿主自签 session cookie 时旧 4 端点 + 新 6 端点（`view.coupling`/
  `view.tree`/`view.endToEnd`/`view.fileTree`/`view.fileRead`/`view.sequence`）均 HTTP 200 +
  冻结信封 + 真实 Python，payload 无绝对路径；`view.fileRead` 路径穿越输入 → `INVALID_ARGUMENT`。
- 定义行提示（供探针文件跳转）：由真实 `view-entries` 投影得到 `lookup_route:89` 等。

### 5.2 dsh_host：Chromium 逐视图（契约 §7）
探针 `ok=true`，`duration≈14s`，`console error=0`，无面板丢失/恢复（`recoveries=[]`）。
- **五标签** `[data-code-view="tabs"] button[data-view]` = coupling/tree/end_to_end/sequence/file，
  逐一切换后视图根 `[data-code-view="view"][data-view=…]` 均 `data-state="ready"`。
- **coupling ✅**：`[data-coupling-column]` = writer/resource/reader；`routes` 资源节点；
  `[data-access-edge][data-access="write"][data-certainty="exact"]` 含 `max_len`/`bus.c:46`；
  read may 覆盖 `bus.c:92/93/98`；左栏 `[data-rail="resources"]` + `[data-resource-row]` 点击后
  资源节点由 `dcr-dim` 变为 `dcr-selected dcr-highlight`（class/attr 变化取证）；
  `[data-rail="stub"]` 点击后 `[data-stub-panel]` 显示「打桩模拟（S2a 未提供）」+ 场景执行/CW-T3
  原因 + 禁用按钮。
- **tree ✅**：根 `bus_send`（入口 chip）；展开后含 `lookup_route`/`check_length`/`dispatch_transfer`；
  `check_length` 节点显示 guard 条件 `if (!check_length(route, length)) return -90`；点击
  `lookup_route` 节点自动切到 file 视图，`[data-file-line="89"]` 带 `data-highlight="true"` 且
  `dcr-line-hit`。
- **end_to_end ✅**：entry 节点 `bus_send`；decision 3 个（guard 菱形）；`exit` 节点 `返回 -90`
  `data-role="error"`；`[data-graph-edge][data-edge-kind="return"][data-color="exception"]` 红色
  返回 -90；external 节点 `platform_write`；external 边 `dcr-graph-edge-dashed` +
  `stroke-dasharray="5px, 4px"`；31 条边 93 段几何全部 M/H/V（diagonal=0, curves=0，正交/向下）；
  `[data-graph-fit]` 适应 + 「一键规整」可用；拖拽节点位移（pointer 事件，x+140/y+90）后点
  「一键规整」位置恢复（容差 ≤24px）。
- **sequence ✅**：`[data-sequence-warning]` 含「静态预测」且 `data-observed="false"`；38 条
  `[data-sequence-message]` 覆盖 `bus_send`、`lookup_route`、`check_length`、`platform_write`
  （external 边界消息）；消息 kind 含 call/external 等；`run_observation`/`scenario_execution` 缺口原样。
- **file ✅**：`[data-file-tree] [data-file-path]` 含 bus.c/platform.c；点 bus.c 后 174 行
  `[data-file-line][data-line]`；**`[data-file-line="46"]` 存在**（行号值，Lead 裁定）且文本含
  `max_len`；点击后 `data-highlight="true"`；从 coupling 资源行 → details「定位源码」→ file 视图
  定位 `bus.c:26`（行存在且 marked/in-viewport）。
- **chrome ✅**：`[data-code-view="legend"]`（右上角「?」/aria 颜色图例）打开后可见，含证据分级/
  形状/边界说明；`[data-code-view="details"]` 函数详情与「定位源码」；`[data-code-view="gap-code"]`
  原样显示 `group_collapse`/`interface_library`/`ai_summary`/`run_observation` 等；共享选择
  `[data-code-view="selection"]` 含 `focus_resource_id`/`focus_callsite_id`；探针扫描面板文本无
  盘符绝对路径。
- 截图：五视图 `coupling/tree/end_to_end/sequence/file.png` + 主图 `main.png`（均见 §3）。

### 5.3 dsh_host：真实 Cordis 运行时（内嵌 Node 24.21.0）
`host-runtime.tap` 1/1 通过（真实 `@deepseek-ai/cordis@4.0.5` Context）：
6 个 `code_*` 工具注册 → 真实 Python `code_workspace status` 成功 → `/code-view` prefix 路由
注册 → 旧 4 端点 + 新 6 端点经载体真实引擎调用成功（无绝对路径）→ `view.fileRead` 路径穿越
`INVALID_ARGUMENT` → dispose 后工具/路由注销 → 二次 apply 再注册且 `view.coupling`/`view.status`
再次成功。

### 5.4 atlas_snapshot 与 demo_observed
- 六端点：coupling（scope entry_neighborhood、routes bus.c:26、write exact max_len@46、read may
  92/93/98、external 合并 trace/platform_write）；tree（根/子节点/guards）；endToEnd（19 nodes /
  31 edges，entry/process/decision/exit/external，legend 5 项，layout DOWN+ORTHOGONAL，external
  合并）；fileTree（bus.c/platform.c）；fileRead（174 行、sha256 与快照证据一致）；sequence
  （static/observed=false/38 消息/run_observation+scenario_execution gaps）。全部无绝对路径。
- Demo：`node --test demo/code-view/demo.test.cjs` 8/8。

### 5.5 S1 回归
旧 `tools/readonly-slice/electron-probe.cjs` 子集（23 项）全通过：入口/快照/source `bus.c:152`+
164/165/证据分级/资源 read+write exact/返回聊天/二次打开保留 selection/console error=0/
截图。旧探针唯一被 S2a 正当取代的是 `data-view` 占位断言（契约 §4 明确 S2a 不再使用
`not_available_in_readonly_slice`），验收按子集判定并在 `dsh_host.s1_regression_probe.detail` 记录
`ignored_steps`；截图 `regression-readonly-slice.png`。

## 6. `not_verified` 与范围限制（如实声明）

最终运行 `in_scope_not_verified=[]`（S2a 契约内 37 项全部通过）；`out_of_scope_not_verified` 4 项
（S2a 明确不提供，UI 以 gaps 原样显示）：

1. 组折叠/接口库/AI 归纳（CW-06/CW-07 等，S2b）；
2. 时序 observed 模式 / 运行观测 / 场景执行/打桩/回退（CW-T3，S3）；
3. 真实 Linux/Kbuild 索引、CFG/locks/aliases/dataflow、目标验证与性能预算（CW-T4，S4）；
4. OS 级出口认证（本工具仅本机回环 HTTP 与本地进程观测）。

另：engine 全量 `python -m unittest discover -s tests`（261 tests）与其它阶段测试由 Lead/engine
执行与报告，本工具未重复运行、未纳入 `checks`。宿主版本兼容性仅固定本机 rc.5（门禁拒绝其他版本）。

## 7. 工具与来源机制（自行实现，不 import 08 代码）

| 工具 | 作用 | 借鉴机制 |
|---|---|---|
| `tools/five-views-probe.cjs` | Chromium 五视图逐项断言 + 交互（拖拽/规整/跳转）+ 每视图截图 | 08 `tools/isolated-profile/electron-probe.cjs` 的宿主浮层关闭/截图机制；DOM 断言按 04 契约 §5/§7 自写 |
| `tools/verify-five-views.mjs` | 分层编排与证据输出（门禁/隔离 profile/引擎端点/RPC/探针/回归/Cordis/测试） | 08 `tools/isolated-profile-verify.mjs` 的分层报告结构；04 契约定制 |
| `tools/five-views-host-runtime.test.mjs` | 真实 Cordis 上旧+新端点调用、dispose/二次挂载 TAP | 08 `tests/host-rpc.test.mjs` 的真实 Context + 服务替身机制 |
| 复用 `tools/readonly-slice/{asar,host-baseline,isolated-home,web-host,electron-probe}.mjs` | 只读 asar、宿主门禁、隔离 home/profile、真实 dsh web 启动、S1 回归探针 | S1 阶段 verifier 自有实现（已随 CL-VIEW-T1 提交） |

## 8. 已知限制与风险

- 探针使用本机安装的通用 Electron 作为 Chromium 测试仪器（不随包分发）；窗口以 opacity=0 显示，
  不可见但参与合成；截图前连拍两帧，仍属渲染时序观测而非确定性像素基线。
- 宿主首次运行浮层出现时机由宿主决定；探针只在其遮挡时关闭并记录，工作台断言不依赖浮层。
- 拖拽用 PointerEvent 注入（client 以指针事件实现拖拽），失败时有鼠标事件兜底并记录 method；
  规整恢复断言为位置容差（≤24px），不是像素级布局基线。
- 探针基于 DOM 钩子/等待轮询与固定超时（每视图 ≤45s，整体 360s），非确定性快照；失败时保留
  `scratch/five-views/five-views-probe.json` 与日志供复核。
- 隔离路径/宿主 SHA 为 Windows 本机固定值；换机复现需同步固定环境值（门禁会立即暴露差异）。
- 证据中不含 `dsh web` 一次性 token（已 redact），不写凭据/密钥。
