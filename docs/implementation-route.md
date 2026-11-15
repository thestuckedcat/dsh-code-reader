# 04 实施路线与来源（dsh-code-reader 首版）

更新：2026-11-15（新增 §CL-VIEW-D2 只读工作台开工说明）；首版实现记录 2026-11-07。依据：[CL-DESIGN-2 软件设计](software-design.md)、[产品形态](product-form.md)、[开发合同](../../docs/development-contract.md)、[机制说明合同](../../docs/mechanism-document-contract.md)。

用户 2026-11-07 指示：按 04 设计文档完成 plugin 并自调试，完成后同步到 `https://github.com/thestuckedcat/dsh-code-reader.git`。本文件是该指示下的开工说明与实施路线，本轮据此开始编码。

## 实施顺序

1. **固定来源与边界**：读取 `H:/VSCODE_READER`（SDK Code Atlas 0.8.0 / schema 0.1）实际源码与 schema，重新计算关键文件 SHA256 写入 `source.lock.json`；H 盘只读，不启动其 launcher，不执行 Atlas / doctor / 索引 / 编译。
2. **Python 薄适配**（沿用设计 §3 模块划分）：`types/errors/util/validation/state` → `workspace/scope/source/build` → `snapshot/atlas/paths/bindings` → `records/invalidation/learning`。
3. **合成证据**：UMD/UAPI/KMD 三仓 fixture + 真实 0.1 envelope 形状的 graph/manifest 快照 fixture；完成一条 ioctl 学习路径，区分事实（exact）、候选（may）、未知（unknown）与未完成的用户预测（pending）。
4. **DSH Host plugin**：`ctx.tools.register` 注册代码学习工具，`ctx.skills.registerProvider` 分发 `learn-code-workspace` skill；按本机实际 Host API 写（见 §来源）。
5. **自调试**：各验收 ID 的 `unittest` → Node 插件桥接测试 → 安装到 `desktop` profile 后用 `cordis_inspect_query` 验证工具与 skill 已注册，并以合成 workspace 实际调用一次工具旅程。
6. **交付**：USAGE、docs/mechanisms.md、source.lock.json、README；git 初始化并推送指定仓库。

## 首个可验交付

合成三仓（UMD 用户态 ioctl 提交、UAPI 共享头、KMD 驱动排队完成通知）上：首次登记 → source-only 小地图/字面查找 → 有界源码证据 → 导入校验后的 Atlas 0.1 快照 → 路径查询（exact/may/unknown、跨仓 abi_bridge 候选）→ 保存含 pending 预测的学习记录 → 修改源码/CONFIG 后 resume 返回 stale 并给出安全重新核验入口。

## 来源与具体机制

| 来源（固定基线） | 借鉴机制 | 采用方式与边界 |
|---|---|---|
| `H:/VSCODE_READER` scripts/atlas/domain/contracts.py（TOOL_VERSION 0.8.0 / SCHEMA_VERSION 0.1） | 版本词表、阶段词汇 | 只读核对；本模块自有 schema_version=1，不覆写 Atlas 0.1。 |
| `scripts/atlas/interfaces/cli.py` | run、重复 `--root/--compdb`、trace/flow/locks/aliases、`--interface` vs `--select-function` 的实际语义 | 仅借鉴 argv 形状与真实开关；本模块以只读快照读取与本地图查询实现，不虚构 Atlas 开关，不调用 Atlas。 |
| `scripts/atlas/pipeline.py` | 不可变 snapshot、coverage（failed 数组、pending_units 路径数组、whole_program_complete=false）、graph_hash 为 envelope 文件 SHA | 直接按该语义校验/保留；failed/pending 不隐藏。 |
| `scripts/atlas/graph.py` | trace 的 BFS/nodes/callsites/common_prefix/first_divergence_choices；边 certainty 在 call_targets 而非路径线条上 | 自行实现等价只读 BFS，并用 callsite→call_targets 回连恢复每边 origin/certainty/evidence。 |
| `scripts/atlas/infrastructure/store.py` | envelope `{schema_version,record_kind,record_id,payload,provenance}`、原子写 | 只读消费；自有记录库与 Atlas DB 分离。 |
| `scripts/atlas/application/service.py`、dataflow/concurrency/aliasing | 关系查询的既有输入/限制语义 | 仅调查对照；首版 flow_cfg/locks/aliases 在快照缺对应分析时返回 unavailable，不伪造数据。 |
| 本机 DSH Host 0.2.1-rc.5（Electron Node24 运行时） | `ctx.tools.register(ToolDefinition)`、`ctx.skills.registerProvider`、loader patch/bundle | 直接按本机实际接口实现；自写 plugin，不复制 Host 代码。已通过 `cordis_inspect_query` 读取精确签名。 |
| [superpowers-dsh 0.4.0](https://github.com/LayneChai/superpowers-dsh)（本机 profile 已装） | 打包 skill provider 的目录扫描/frontmatter/rank 模式 | 只借鉴骨架写法；skill 内容与 provider 实现为本项目自写。未合入其代码。 |
| 用户指定 `C:/Users/admin/.codex/行为守则.md` | 普通问答不强制考试、明确学完才复盘、先预测后验证、K2/K3 无 G/Q 可停、Next Action 最多一条 | 直接作为 skill 与 learning 规则的来源。 |

Serena/clangd、codegraph MCP、ops-codegraph 只作调查对照；本版未集成，不声称已合入。Atlas 完整发行包/固定 Python runtime/bwrap 隔离容器/native CFG extractor 均未引入，见 §运行门禁。

## 与设计的已知偏离（有意、可审阅）

1. **语言与载体**：设计主形态是 skill + Python CLI 薄适配，DSH Viewer plugin 后置；本轮按用户指示先交付可安装 Host plugin：Python 引擎保持设计模块划分与 CLI JSON 合同，插件层是薄 Node 桥（固定 argv、无 shell 插值）并分发 skill。插件不是第二套解析器。
2. **runtime**：暂用系统 Python 3.11+（本机 3.11.4）。不 vendor 固定解释器/Atlas 包；`source.lock.json` 记录依赖与来源，后续补固定 runtime 时 CLI 合同不变。
3. **Atlas 执行**：`plan` 只做数据/argv 计划；`run` 无强制隔离 profile 时返回 `EXECUTION_BLOCKED`，不裸跑 compiler probe。**2026-11-08 增强**：为验证真实产物适配，用 Atlas 自带 Windows runtime 直接调用 `scripts/sdk_atlas.py`，只分析合成 C 仓库（Atlas trusted quickstart + 自建三函数 C 仓库）并消费其真实 0.1 快照；不执行用户仓库、不分析 Linux/Kbuild、不联网、不运行 H 盘 launcher。真实 Linux/Kbuild 索引门禁保持不变。
4. **关系查询**：flow_legacy 用快照内 flow_edges 投影；flow_cfg/locks/aliases 在快照 capability 不足时一律 `status=unavailable` 并列出 unknowns，不以空数组伪装完整。
5. **记录存储**：按设计使用 SQLite（Python 标准库）+ 不可变 revision JSON；未引入 FTS/外部依赖。
6. **测试**：设计列出的 `test_runner.py`/`test_egress.py` 等在上表偏离下改为等价边界测试（无执行后端 → blocked；无外发路径断言），未运行项在 mechanisms.md 明确标注 actual/blocked。

## 运行门禁（本版不声明通过）

- 真实 Linux Kbuild/compdb 上的 Atlas 索引（需目标 Linux 工具链、生成头与固定 Atlas runtime）。
- bwrap/OCI 强制隔离 runner、compiler probe 越根/无网负例。
- native CFG（需固定 Clang18 extractor，缺失时 capability=false）。
- 真实用户仓库/硬件行为证明：静态证据不证明运行时必达。

**已完成的真实产物对照（不等于上述门禁通过）**：2026-11-08 用 Atlas 自带 Windows runtime 在合成 C 仓库上生成真实 0.1 快照，验证 envelope/graph_hash/coverage/真实 file/line/路径与 flow_legacy；证据与复现见 [evidence/real-atlas/README.md](../evidence/real-atlas/README.md)。

这些门禁未通过前，本版只声称“合成 fixture + Windows 合成 C 的真实 Atlas 产物对照上适配与学习流程自测通过”，不声称读懂用户真实驱动或通过 Linux/Kbuild 门禁。

## 证据与完成标准

- 每次实现任务：真实行为测试先失败 → 最小实现 → 同命令复测通过 → 记录命令与输出摘要到 `evidence/`。
- 完整交付：各验收 ID（CL-001..CL-009 子集映射见 [实施契约](implementation-contract.md)）有测试、Node 插件桥接测试、安装后注册验证与一次实际工具旅程。
- 按机制说明合同在 `docs/mechanisms.md` 记录稳定机制 ID、参数、硬边界与证据；机制说明不早于实现。

## CL-VIEW-D2 只读代码工作台开工说明（2026-11-15，本轮开工）

依据用户 2026-11-15 指示与[详细设计 CL-VIEW-D2](interactive-code-view-software-design.md) §10：本轮只做
**只读切片 CW-T1**（DSH 插件侧边栏「代码工作台」+ 已核验 Atlas 快照读取 + 入口到真实 C 源码）。用户已给
正式开工授权，本节即为开工说明，实施与验收契约见[只读工作台契约](readonly-workbench-contract.md)。

### 实施顺序

1. **固定来源与本机基线**（本节）：复核本机 DSH 可执行/归档 SHA、Atlas 源码提交与 runtime、Python/clang
   实际版本，写入 `source.lock.json`。
2. **真实快照夹具**：用 Atlas 0.8.0 自带 Windows runtime 分析本仓 Demo 的合成 C（`bus.c`/`platform.c`
   字节级复制到 `evidence/code-view-slice/repo/`），生成真实 0.1 快照对（graph + manifest），记录哈希。
   这是「已登记且已核验」验收快照，不是手写 fixture。
3. **引擎只读投影**（`engine/code_learning/views.py` + CLI 3 命令）：快照清单/入口列表/入口详情，仓库
   相对路径、函数位置、调用边 certainty/origin、签名源码证据、覆盖与缺口；复用现有 `load_snapshot_bundle`
   哈希核验与 `scope`/`source` 签名证据，不新增解析器。
4. **Host UI 服务**：自有 `webServer` prefix `/code-view` + `connection.admit` 载波（沿用 08 已核接缝形态，
   本插件独立实现），4 个严格校验端点；UI 通过 Cordis 嵌套插件声明 `connection/webServer`，缺失时不拖垮
   旧工具。
5. **Client 侧边栏入口与面板**：rc.5 原生 `__ModuleLoader__` bundle，keyed main + `sidebar.panellist`
   注册、`代码工作台` 入口、快照/入口/源码/证据/缺口、返回聊天、可注销；共享 `Selection` 与五视图占位。
6. **隔离 profile 验收 + 独立复核**：独立 `DSH_HOME` 与 web profile 启动真实 `dsh web`，boot graph 与
   浏览器渲染验收入口/导航/卸载/二次挂载；真实 rc.5 Cordis 宿主运行时验证旧工具注册与一次真实工具调用；
   Demo 对照单独运行。证据按 Demo / 真实 Atlas 快照 / DSH 宿主分层记录。
7. **交付**：契约、证据、`source.lock.json`、README/USAGE 修订；机制说明在五视图与场景实现后再按合同补，
   本轮不把切片进度写成完整机制说明。

### 首个可验收交付

在独立 DSH profile 中：侧边栏「代码工作台」→ 选中已登记且已核验的 `code-view-bus-demo` 真实 Atlas 快照 →
入口列表出现 `bus_register`/`bus_send` → 点 `bus_send` 显示 `bus.c:152` 起的真实 C 源码、调用边
（`lookup_route`/`check_length`/`dispatch_transfer`，exact/may 分级）与源码证据 → 缺口栏显示资源图/五视图/
运行观测未提供 → 返回聊天后二次打开保留选择。对照验收：Demo「登记 → 发送」8 项通过；`routes[channel].max_len`
的写入行（`bus.c:46`）、读取行（`bus.c:93`、`98`）、超限返回行（`bus.c:165`）可从 UI/证据定位；旧
`code_*` 六工具在更新后的插件上仍注册并可真实调用。

### 来源固定版本与借鉴机制

| 来源（本机固定值/提交） | 借鉴机制 | 采用方式与边界 |
|---|---|---|
| 本仓 04 `d884bd4`（2026-11-08 real-atlas 轮） | workspace/快照/源码证据/学习记录/CLI 合同与验收 ID | **直接复用**本仓现有引擎模块与 CLI 合同；本轮只加只读投影，不重写解析器。 |
| SDK Code Atlas `H:/VSCODE_READER`：git `c33320a98face14c5f6e5e817beaccf52b9bbb93`、TOOL_VERSION `0.8.0`、SCHEMA `0.1`、Windows runtime `runtime/windows-x86_64/venv/Scripts/python.exe`（3.11.4） | 0.1 envelope、`graph_hash` 逐字节校验、coverage（failed/pending/whole_program_complete=false）、函数位置在 evidence 实体、call_targets certainty/origin、`objects/field_accesses/locks` 等可选层 | **直接消费**已核验快照 + **本仓薄适配**读模型；Atlas 只对合成 Demo C 执行一次，不分析用户仓库/Linux Kbuild，不联网，不运行 H 盘 launcher。 |
| 本机 DSH Harness `0.2.1-rc.5`，build `d4db512a969fccf0c5cc7ec8fe38e9c1d27af916`；`DeepSeek Harness.exe` SHA256 `7ae939b5…dd0cc4`；`resources/app.asar` SHA256 `e1b6f25f…32c6915`（2026-11-15 本机复核一致） | rc.5 loader、`ctx.slots` 侧栏/main、`layout.selectPanel`、`connection.admit` + `webServer.register` 载波、client 静态种子、disposer/effect 生命周期 | **直接依赖已核宿主接口**并按本机实际签名实现；客户端 bundle 只 `require('react')`。 |
| 08 工作台 `bundle/client.js` / `src/http-rpc.mjs` / `tools/isolated-profile-verify.mjs`（本机已自测 rc.5） | 原生 client bundle 包装、sidebar.panellist+keyed main 注册形态、连接准入信封、隔离 profile 启动与 Chromium 探针方法 | **借鉴机制 + 薄适配**到 04 的包名/通道/DOM 钩子；不依赖 08 包，不同时运行 08。 |
| 本仓 Demo `demo/code-view/`（`bus.c`/`platform.c`/wasm bundle/`demo.test.cjs`，clang 16.0.4 mingw 构建产物） | `routes[channel].max_len` 登记/发送/超限语义、事件 trace、五种视图的样例交互 | **对照与夹具**：Demo 只提供 Wasm 模拟观测，不当作真实设备行为；本轮以它为行为对照并复制 C 源进真实快照夹具。 |
| clang `C:\mingw64\bin\clang.exe` 16.0.4（mingw build） | compdb 预检 | 仅用于生成/复核合成 C 的 `compile_commands.json`；Atlas 用自带 libclang 18.1.1 解析。 |

ELK/elkjs、React Flow、Monaco、Perfetto/UML 等（设计 §8）仍为**待实施验证**的技术候选，本轮不引入、
不声称合入；五视图的图形与布局实现后置。

### 源码范围、运行状态与权限边界

- **源码范围**：只读取 bootstrap 候选根内、已登记仓库的常规文件；Atlas 证据路径映射为仓库相对路径后
  才出 Host，绝对路径、bootstrap/state 路径不进入 UI/RPC/证据 JSON。
- **运行状态**：本轮不执行仓库构建、不跑用户代码、不启动场景/打桩/回退、不写回源码；Demo 的 Wasm 执行
  仅在本仓 fixture 上作为对照观测（`demo_observed`）。Atlas 只对合成 Demo C 执行一次（既有授权范围）。
- **权限边界**：RPC 只接受 workspace/snapshot/entry 标识，不接受路径/argv；Host 重核输入长度/字符集，
  引擎按已登记状态解析；模型不能指定 Python、工作目录或 bootstrap。UI 服务经 `connection.admit` 准入，
  浏览器会话为 owner；缺失服务时只显示缺口。
- **本轮补足的边界**：① 插件包内新增自有 `/code-view` prefix 路由，不共用 `/api`，不依赖 08；② UI 子插件
  与工具子插件解耦，UI 服务缺失时旧工具合同不变；③ 读模型统一 `file:line` 与 `Selection` 共享标识，后续
  五视图直接复用；④ 缺口/证据分级字段化，防止把静态 exact 或 Demo 观测写成运行事实。
- **首个验收动作**：见契约 §9 六层命令；先跑引擎单测与 Demo 对照，再跑 Node/Host 与隔离 profile 浏览器验收。

### 待验证（本轮不声明通过）

真实 Linux/Kbuild 与生成头索引、CFG/locks/aliases 深分析、五视图图形/布局与交互、场景执行与回退、真实设备
行为、跨仓真实快照、性能预算实测，以及 DSH 桌面宿主热更新（本机运行中的桌面 profile 未重启，验收用独立
profile）。这些按设计 §10 的 CW-T2/T3/T4 继续。

### 本轮实施结果（2026-11-15，只读切片交付）

**实际改动**（04 仓库，`d884bd4` 之后）：`engine/code_learning/views.py` 只读读模型 + `cli.py` 3 个 `view-*`
命令；`lib/http-rpc.mjs`（自有 `/code-view` prefix carrier：`webServer.register` + `connection.admit`）+
`lib/view-service.mjs`（4 端点严格校验）；`index.js` 嵌套 UI 子插件、`package.json` client 声明；
`bundle/client.js`（rc.5 原生 client 半：侧边栏「代码工作台」、keyed main、快照/入口/源码/证据/资源/缺口）；
`engine/code_learning/atlas.py` 真实 Atlas `flow_edges.owner=null/sources=[]` 适配修复 + 回归
`engine/tests/test_atlas_flow_shape.py`；真实快照夹具 `evidence/code-view-slice/`（Demo `bus.c`/`platform.c`
字节级复制，Atlas 0.8.0 产物 snapshot `ed326d554334432b907de21297207eb8`）；独立验收工具与证据
`tools/readonly-slice/`、`tools/verify-readonly.mjs`、`evidence/readonly-slice/`；契约
[只读工作台契约](readonly-workbench-contract.md) 与本文开工说明。

**验证命令与结果**（本机 Windows，2026-11-15）：

| 命令 | 结果 | 证据 |
|---|---|---|
| `cd engine && python -m unittest discover -s tests -v` | Ran 240 tests, OK（新增 test_views 18、test_atlas_flow_shape 4） | `evidence/readonly-slice/engine-tests.txt` |
| `node --test tests/node/*.test.mjs` | 56/56 pass（bridge/plugin/view-rpc/client） | `evidence/readonly-slice/node-tests.txt` |
| `node --test demo/code-view/demo.test.cjs` | 8/8 pass（登记→发送、max_len 超限 -90、非法 -22、未登记 -2、平台失败 -5、锁 1→0） | `evidence/readonly-slice/verification.json → demo_comparison` |
| `node tools/verify-readonly.mjs --with-repo-tests` | `ok=true, verified=true`，26/26 检查、`not_verified=[]`，三层全 true（verifier 与 Lead 各独立跑一次） | `evidence/readonly-slice/verification.json`、`render.png`、`render-resources.png`、`host-runtime.json/tap`、`commands.log` |

**各层结论与来源**：

- **Demo（`demo_observed`，Wasm 模拟观测）**：`bus_register(1)` → `bus_send(1,48)` 平台侧观测写 `0x20030`；
  `bus_send(1,65)` 返回 `-90`（max_len 64 超限）、`bus_send(1,0)` `-22`、未登记 `-2`；48/49 分支；平台失败
  `-5` 透传且锁 1→0。**不证明**真实设备或静态边运行时必达。
- **真实 Atlas 快照（`atlas_snapshot`，静态 + 源码证据）**：快照 `verified/fresh`、19 入口；`bus_send`
  源码 `bus.c:152–174`（首行含函数签名、164/165 行含 `if (!check_length(...))` / `return -90;`），三条
  `exact` 调用边（`lookup_route` 160、`check_length` 164、`dispatch_transfer` 170）；资源层真实可用：
  `routes` 对象 `bus.c:26`；`bus_register→store_route` 路径的 `routes[channel].max_len` **write exact**
  `bus.c:46`；`bus_send→lookup_route/check_length` 的 `max_len` **read may** `bus.c:92/93/98/99`
  （`unresolved_or_multiple_base_objects` 如实保留，`resource_status=partial`）。全程仓库相对路径、无绝对路径。
- **DSH 宿主（`dsh_host`，pinned rc.5 隔离 profile 实测）**：`__DSH_BOOT__` 71 条 client 条目含
  `@local/dsh-code-reader`，inject 与 package.json 一致；服务端 bundle 字节为仓库 `bundle/client.js` 精确前缀；
  无 cookie 直连 `/code-view` → 401（准入真实生效），宿主 self-signed session cookie 下四端点 200 + 冻结信封 +
  真实 Python；Chromium 32 步全 true：侧栏「代码工作台」（aria-label）→ 面板 → verified 快照 → `bus_send`
  `[data-line="152"]` + 164/165 行 → `[data-evidence-class]` exact/may/source_text → 资源 read may 与
  `bus_register` 的 write exact `bus.c:46` → gaps 5 项 → 返回聊天 → 二次打开 `selection.entry_id` 保留；
  console error=0；`decode`/卸载后二次挂载：真实 Cordis 4.0.5 Context 下 6 个 `code_*` 工具注册、一次真实
  Python 工具调用成功、`/code-view` 注册、dispose 注销、二次 apply 再注册再调用成功（host-runtime TAP 1/1）。

**本轮未验证（不得写成已通过）**：真实 Linux/Kbuild、生成头与目标 ABI 索引；native CFG/locks/aliases 深分析
（快照 `cfg=unsupported`、`data_flow=partial_path_insensitive`）；五视图图形/布局、场景执行/打桩/回退、运行
观测；真实设备行为；跨仓真实快照；性能预算实测；桌面宿主热更新（验收用独立 profile，未重启用户桌面宿主）；
OS 出口认证。机制说明按合同在 CW-T2/T3 完整交付时补。

## 目标「完成全部开发并逐阶段在 dsh-web 验收」的路线（2026-11-15 起）

用户目标：参考 Demo 与设计文档完成全部开发，并逐阶段在 DSH web 完成测试。路线按设计 §10 的 CW-T2/T3/T4，
每个阶段都以**真实 `dsh web` 隔离 profile + Chromium 探针 + 分层证据**收口，而不是只在单测中声明完成。

| 阶段 | 内容 | dsh-web 阶段验收 |
|---|---|---|
| **S2a 五视图只读**（2026-11-15 完成） | 资源关系图、可折叠文字树、单入口端到端图（竖排正交、菱形判断、红色异常）、时序（S2a 仅静态预测并标注）、文件视图；左栏「全局资源/打桩占位」、图例、详情面板、跨视图选中 | `node tools/verify-five-views.mjs --with-repo-tests` → `ok=true, verified=true`，37/37，三层全 true，in-scope `not_verified=[]`；证据 `evidence/five-views/`（五视图截图 + verification.json）；[五视图契约](five-view-contract.md) §9 |
| **S2b 组/接口库/细节**（2026-11-15 完成） | 组折叠展开（CW-06）、基础接口库（CW-07）、子流程/面包屑、组名修订、AI 归纳占位 | `node tools/verify-s2b.mjs --with-repo-tests` → `ok=true, verified=true`，41/41，三层全 true，in-scope `not_verified=[]`；证据 `evidence/s2b/`（组/接口/子流程截图 + verification.json）；契约 §11 |
| **S3 场景/打桩/时序运行**（2026-11-15 S3a 完成） | **S3a 完成**：可信 Wasm 模拟 profile 导入、Host worker 隔离执行、场景 plan/run/record 台账、边界打桩、失败传播、时序 observed；**S3b 待做**：回退末尾 N 次/前缀重放、轨迹导入、异步/IRQ 细化、observed 多场景选择 | S3a：`node tools/verify-s3.mjs --with-repo-tests` → `ok=true, verified=true`，43/43，三层全 true，in-scope `not_verified=[]`；证据 `evidence/s3/`；契约 [scenario-contract](scenario-contract.md) §10 |
| **S4 目标验证** | Linux/Kbuild 生成头、CFG/locks/aliases、复核差分、性能预算（CW-T4/CW-11） | 目标环境证据；A05/A07/A11 |

S2a 的读模型 DTO、派生规则、DOM 钩子与预算固定在[五视图契约](five-view-contract.md)；实现顺序仍为
引擎读模型 → Host 端点 → client 渲染 → 隔离 dsh-web 探针 → 证据/提交。每个阶段完成时更新本节与证据目录，
未完成能力继续以缺口显示，不提前写成已通过。

