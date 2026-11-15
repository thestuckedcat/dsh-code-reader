# 04 只读五视图 S2b（组折叠 / 基础接口库 / 子流程+面包屑）· 独立黑盒验收证据

本目录是 **verifier（独立验收者）** 对 S2b 阶段的验收产物。验收只读：不修改插件实现、
不联网（仅本机回环 HTTP）、不写真实 `%USERPROFILE%\.dsh`、不重启用户桌面宿主、不做 git 提交。
契约依据：[五视图契约 §10](../../docs/five-view-contract.md)（S2b 增量：§10.1 groups / §10.2 view.interfaces /
§10.3 客户端行为 / §10.4 DOM 钩子 / §10.5 dsh-web 验收 / §10.6 所有权）；S2a 成果见
`evidence/five-views/`，S1 成果见 `evidence/readonly-slice/`（两者均未改动）。

## 1. 最终结论（2026-11-15T15:26+08:00）

| 层 | 结果 | 证据 |
|---|---|---|
| `demo_observed`（Demo/Wasm 行为对照，非宿主） | ✅ 8/8 | `verification.json` → `demo.code_view_demo_tests` |
| `atlas_snapshot`（真实 Atlas 0.1 快照 + 真实 Python: S2a 六端点 + S2b groups/interfaces/breadcrumb） | ✅ 9/9 | `atlas.view_*` / `atlas.end_to_end_groups` / `atlas.end_to_end_breadcrumb` / `atlas.view_interfaces` |
| `dsh_host`（pinned rc.5 宿主：隔离 profile → boot graph → `/code-view`（11 端点）→ Chromium S2a 回归 + S2b 组/接口库/子流程 → S1 回归 → 真实 Cordis 生命周期） | ✅ | `host.*` / `regression.*` / `dsh_host.*`；`groups/interfaces/subflow/main.png` |
| 仓库 Node 测试（附加检查） | ✅ 96/96 | `commands.log` 末行 |
| **总体** | **`ok=true, verified=true`**：41/41 检查通过，`in_scope_not_verified=[]` | `verification.json` |

> 分层口径：`demo_observed` 是 Demo 的 Wasm/JS 行为模型；`atlas_snapshot` 是已导入并核验的真实
> Atlas 0.1 快照（snapshot `ed326d554334432b907de21297207eb8`，graph sha256 `c6e49fe9…207c`）经真实
> Python 读模型得到的 groups/interfaces/breadcrumb 等投影；`dsh_host` 是本机 pinned rc.5 宿主实测。
> 三层分别标注、互不冒充。S2b 仍无运行观测/AI 正文。

## 2. 运行命令（复现）

在 `E:\dsh\plugin\04-code-learning` 下：

```powershell
# 全量 S2b 验收（门禁 → 隔离 profile + 真实快照 import → S2a 六端点 + S2b 引擎投影
#   → 真实 dsh web（boot graph/401 准入/11 端点 RPC）→ Chromium: S2a 五视图回归探针 +
#   S2b 组/接口库/子流程探针 + S1 只读切片回归探针 → 真实 Cordis 运行时 → Demo + 仓库 Node 测试）
node tools\verify-s2b.mjs --with-repo-tests

# 单项
node tools\verify-s2b.mjs --skip-probes        # 跳过 Chromium 探针
node tools\verify-s2b.mjs --skip-regression    # 跳过 S1 探针
node tools\verify-s2b.mjs --skip-host-runtime  # 跳过 Cordis 运行时
node tools\verify-s2b.mjs --skip-demo          # 跳过 Demo 层
node tools\verify-s2b.mjs --skip-http          # 跳过 web 启动（只跑门禁/引擎/测试）
```

隔离运行时树在 `04-code-learning/scratch/readonly-home/`（`scratch/` 已被 `.gitignore` 忽略）；
探针中间 JSON：`scratch/s2b/s2b-probe.json`、`scratch/s2b/s2a-probe.json`。

## 3. 产物清单与 sha256（Lead 最终独立复跑后目录内当前值；每次运行会重新生成报告/截图，值随之变化）

| 文件 | 说明 | sha256 |
|---|---|---|
| `verification.json` | 权威报告：layers/checks/not_verified/commands/limitations（90,768 B） | `dfccdf39ccf6b6244b1c87cc0fa26d7e27417ae83cef2eee5a0ed9753c5e2ef5` |
| `groups.png` | 端到端图 + 组折叠（组框、折叠全部/展开全部、组编辑入口） | `1026d7a8b8609bc0fe6586c3fe89a0a970d34e4eccfb09b617720ea847f33a13` |
| `interfaces.png` | 接口库候选卡 + 黑盒接口加入后的端到端图（"黑盒接口 1"） | `4256549abf6c6f64ef16e326fbe7d2332343bde0f2ce94d056cd71a839499afd` |
| `subflow.png` | 详情子流程 tab + 面包屑「根入口 bus_send / check_length」+ check_length 子图 + 缺口 | `ba3a4cb98cf8655af73d3770651ef45cbba1f80fe4dc4f42c84bb0d32a3012ed` |
| `main.png` | 主流程图（bus_send 主图，组全部展开） | `7365f7d909eeae7396fe563032581707e14c20cc94628464d087bee57fbc7221` |
| `s2a-{coupling,tree,end_to_end,sequence,file,main}.png` | S2a 五视图回归截图（同一探针在 S2b 构建上重跑） | 见 `verification.json` → `regression.five_views_probe` |
| `regression-readonly-slice.png` | S1 只读切片回归截图（入口/源码/返回/重开） | `91f3c163a77876b1e70620430e02ead05431d8a8fbaaefd3b9ec0a1e0420e795` |
| `host-runtime.json` / `.tap` | 真实 Cordis 运行时 TAP+JSON（S2b 端点） | `68b78ffd72b0e1ade6188b2c670d486610fa1ff568a151d797146fc9a2e425aa` / `a4821789a507b5bec68319edefff11eb62e3c379373b83ee5bf9a40039346a42` |
| `commands.log` | 本次实际命令（含 exit code/cwd） | `734c26c15336b491f15a1c2a9c0e9a4b22d74cffb9420f311cd856d1c9fa3a0a` |

探针/工具源码：`tools/s2b-probe.cjs`、`tools/verify-s2b.mjs`、`tools/s2b-host-runtime.test.mjs`。

## 4. 隔离运行环境（断言前提）

- 固定宿主：`E:\dsh\DeepSeek Harness.exe` SHA256 `7ae939b5…0cc4`；`E:\dsh\resources\app.asar`
  SHA256 `e1b6f25f…6915`；dsh `0.2.1-rc.5`；内嵌 Node `24.21.0` / Electron `44.7.0`；
  6 个已核 seam 文件逐字节 SHA+关键字复核。
- 隔离 `DSH_HOME`：`scratch/readonly-home/home`（非真实 `~/.dsh`）；web profile
  `bundles = base + web-app + @local/dsh-code-reader`，模块 junction 指向本仓库，`cordis.patch.yml = []`。
- 隔离 bootstrap：`candidate_roots slice-root → evidence/code-view-slice`，state/inbox/output 隔离；
  真实 `E:\Anaconda-main\python.exe` 3.11.4 执行 `workspace-import` + `snapshot-import`。
- Client bundle（最终）：`bundle/client.js` 203,520 B；服务端返回 203,600 B = 仓库字节精确前缀
  （+ sourceMappingURL 后缀），含 `window.__ModuleLoader__.load(` 与 `@local/dsh-code-reader`。
- Chromium 探针：本机 `C:\Users\admin\.dsh\electron\electron.exe` 仅作测试工具；窗口 `opacity=0 +
  showInactive`，截图前关闭宿主浮层、滚动到目标区域、invalidate + 连拍三帧取后一帧；工作台 DOM
  断言不依赖宿主浮层。

## 5. 关键验收证据（最终运行，契约 §10.5）

### 5.1 S2a 五视图回归（同一 S2a 探针在 S2b 构建上重跑）
- 五视图 `data-state=ready`；console error=0；无绝对路径；截图 6 张（互异）。
- coupling 三列/资源节点/write exact max_len@46/read may 92/93/98/左栏点击高亮/stub 占位；
  tree 根/展开/guard/点击定位；e2e 入口/decision/exit -90 error/exception 红边/external 虚线/
  全 M-H-V 正交/方向向下/适应+规整+拖拽恢复；sequence 静态预测+observed=false+38 消息+platform_write；
  file 174 行+`[data-file-line="46"]`+点击高亮+资源定位。
- 唯一被 S2b 正当取代的断言：coupling 的 S2a `gapsOriginal`（组折叠/接口库在 S2b 已实现，不再是
  缺口）记录在 `regression.five_views_probe.detail.coupling_ignored_superseded`；其余全通过。

### 5.2 组（CW-06）
- 引擎 `view.endToEnd.groups`：**2 组** — `commit_transfer 下游子流程`（encode_doorbell、write_doorbell）
  与 `dispatch_transfer 下游子流程`（submit_buffered、submit_direct）；`grouping.algorithm =
  private_callee_subflow`，`groups:2 / members:4`，`group_semantics` degraded gap（结构归纳，可修订）；
  **边不合并**：31 条原边 id/元数据保持（与 S2a 口径一致）。
- Chromium：`[data-graph-group][data-group-id][data-collapsed]` ≥2（两种 label）；`[data-group-toggle]`、
  `[data-graph-collapse-all]`、`[data-graph-expand-all]` 可用；折叠后成员节点隐藏（19→15）、组框可见；
  **跨组边保留原 `data-edge-id/data-certainty/data-edge-label`**（before/after 全量比对，
  31 条 survivor 元数据零变化）；展开后节点/边集合与元数据 **精确恢复**（19 nodes / 31 edges）；
  单组 toggle 折叠/展开正常；组名编辑（`[data-group-edit]` → label 输入 → `[data-group-edit-save]`）
  后出现 `[data-group-revised="true"]`「已修订（结构归纳）」标记，切换视图刷新数据后修订保留；
  Selection 含 `group_id`。

### 5.3 基础接口库（CW-07）
- 引擎 `view.interfaces`（entry 邻域，10 候选；快照全范围为 12）：`platform_write` 为
  `mixed` + `cross_file:true` + `side_effects_present`（field write `simulated_doorbell@platform.c:25`），
  reasons 含 leaf_callee/cross_file_boundary/stable_signature/side_effects_present，入参
  address/value、返回 int、callers write_doorbell(bus.c:110→113)；**independent ≥2** 实际 3：
  encode_doorbell / check_length / lookup_route；全部候选 `certainty:"may"`；`external_boundaries`
  （trace 等）只读展示；无绝对路径。
- Chromium：`[data-code-view="interface-library"]`（10 卡，可展开/收起）显示签名/入参/返回/理由/
  副作用/入参 guard；`platform_write` 卡标注 cross-file 与字段写副作用；点 `[data-interface-action="add"]`
  → 端到端图出现 `[data-blackbox-node][data-interface-id=iface:…platform_write]`（显示签名摘要、
  「展开原有步骤」），原 external process 节点隐藏（工具栏「黑盒接口 1」）；点 `remove` → 黑盒消失、
  原节点恢复；Selection 含 `interface_id`。

### 5.4 子流程与面包屑（CW-09）
- 选中 `check_length` process 节点 → 详情 `[data-code-view="details-tab"][data-tab="subflow"]`
  （源码/子流程图/资源分析三 tab）→ `[data-code-view="subflow"]` 出现并完成异步加载；
  `[data-breadcrumb] [data-crumb]` = **「根入口 bus_send」→「check_length」**（index 0/1）；
  子图含 check_length/trace/返回 allowed 与 ai_summary/run_observation/domain_boundary_heuristic gaps；
  点根 crumb → 回到主图（`end_to_end` ready），节点集合（19）与边 id/元数据（31）**与基线精确一致**，
  子流程区域关闭；Selection 含 `subflow_root_id = bus_send entry`。
- 引擎 `view-end-to-end --entry check_length --root <bus_send>` 返回
  `breadcrumb=[bus_send(bus.c:152) → check_length(bus.c:96, callsite c_2d6e…)]`，无绝对路径。

### 5.5 宿主与回归
- boot graph 71 条含 `@local/dsh-code-reader` 且 inject 一致；bundle 精确前缀；无 cookie POST
  `/code-view/view.status` → **401**（admission 生效，未伪造 cookie）；带宿主自签 cookie 时旧 4 +
  S2a 6 + `view.interfaces` + `view.endToEnd{root}` 均 200 + 冻结信封 + 真实 Python；路径穿越
  `INVALID_ARGUMENT`。
- 真实 Cordis 运行时 TAP 1/1：6 工具注册 → 真实 Python 调用 → 11 端点（含 groups/interfaces/
  breadcrumb）真实引擎调用 → dispose 注销 → 二次 apply 再注册并再次成功。
- S1 只读切片回归子集（旧探针 23 项：入口/source bus.c:152+164/165/证据分级/资源 read+write exact/
  返回/二次打开/console=0）全通过；Demo 8/8；仓库 Node 96/96。

## 6. `not_verified` 与范围限制（如实声明）

最终运行 `in_scope_not_verified=[]`（S2b 契约内 41 项全部通过）；`out_of_scope_not_verified` 4 项
（本阶段明确不提供，UI 以 gaps/占位显示）：

1. AI 归纳正文（模型出口未接入；仅显示"AI 归纳未接入" gap，不伪造）；
2. 场景执行/打桩/回退、运行观测、时序 observed 模式（CW-T3 / S3）；
3. 真实 Linux/Kbuild 索引、CFG/locks/aliases/dataflow、目标验证与性能预算（CW-T4 / S4）；
4. OS 级出口认证（仅本机回环 HTTP 与本地进程观测）。

另：engine 全量 unittest（267 tests）与 Host 全量 Node（84/84）由 Lead/engine/host 执行并报告，
本工具实际运行的是仓库 `node --test tests/node/*.test.mjs`（96/96，含 client）与 Demo；引擎侧本工具
只运行六个 view CLI 与 S2b 新 CLI，未重复跑引擎 unittest。宿主兼容性仅限 pinned rc.5。

## 7. 工具与来源机制

| 工具 | 作用 | 说明 |
|---|---|---|
| `tools/s2b-probe.cjs` | Chromium S2b 探针：组折叠/边元数据 before-after/rename、接口库 add-remove/黑盒、subflow/breadcrumb/Selection、截图 | 复用 S2a/S1 verifier 的不可见窗口截图与宿主浮层关闭机制；按契约 §10.4 钩子断言 |
| `tools/verify-s2b.mjs` | 分层编排：门禁→隔离环境→引擎读模型→真实 dsh web/RPC→Chromium 探针（S2a 回归+S2b+S1）→Cordis→Demo/测试→证据 | 复用 `tools/readonly-slice/*`（asar/host-baseline/isolated-home/web-host）机制 |
| `tools/s2b-host-runtime.test.mjs` | 真实 Cordis 上 11 端点（含 S2b）调用、dispose/二次挂载 TAP | 08 真实 Context+服务替身机制，04 自有实现 |

## 8. 已知限制与风险

- 探针使用本机通用 Electron 作为 Chromium 测试仪器（不随包分发）；窗口 opacity=0 显示，截图前
  invalidate+连拍三帧，仍属渲染时序观测而非确定性像素基线。
- 宿主首次运行浮层出现时机由宿主决定；探针只在其遮挡时关闭并记录；若宿主浮层导致 shell 导航
  （观测到一次宿主侧导航），探针会重开面板并记录 `panelLosses`，最终运行未发生。
- 组折叠是客户端投影；验收按 before/after 全量比对 `data-edge-id/certainty/label` 与节点集合，
  位置/端口像素布局不作确定性断言。
- 组名/描述为结构归纳，验收只检查"已修订"标记与刷新后保留，不评估语义正确性（用户可修订）。
- 接口库为规则候选（全部 `certainty:"may"`），验收检查候选规则字段与展示/加入移出行为，
  不把它当作语义断言。
- 探针基于 DOM 钩子与等待轮询（每视图/步骤有界超时，整体 420s），非确定性快照；失败时保留
  `scratch/s2b/s2b-probe.json` 与日志供复核。
- 隔离路径/宿主 SHA 为 Windows 本机固定值；换机复现需同步固定环境值（门禁立即暴露差异）。
- 证据中不含 `dsh web` 一次性 token（已 redact），不写凭据/密钥。
