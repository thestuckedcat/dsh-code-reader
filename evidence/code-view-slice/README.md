# 04 只读工作台真实快照夹具（CL-VIEW-T1）

更新：2026-11-15。目的：给「代码工作台」只读切片提供**已登记且已核验的真实 Atlas 0.1 快照**，
使 UI 能从一个入口（`bus_send`）定位到真实 C 源码，并用真实 `objects`/`field_accesses` 层核对
`routes[channel].max_len` 的写入/读取；Demo 只作为行为对照，不当真实设备证据。

## 来源与边界

| 项 | 固定值 |
|---|---|
| Atlas | `H:\VSCODE_READER`，git commit `c33320a98face14c5f6e5e817beaccf52b9bbb93`，TOOL_VERSION `0.8.0`，SCHEMA `0.1` |
| Atlas runtime | `H:\VSCODE_READER\runtime\windows-x86_64\venv\Scripts\python.exe`（Python 3.11.4） |
| 编译器（仅 compdb/复核） | `C:\mingw64\bin\clang.exe`，clang 16.0.4 (mingw build) |
| 被分析源码 | 本仓 Demo `demo/code-view/bus.c`、`platform.c` **字节级复制**到本目录 `repo/` |
| 分析范围 | 合成 C 两文件、整仓模式（`selected_scope.mode=repository`），`--dataflow off` |
| 快照 | snapshot_id `ed326d554334432b907de21297207eb8`，functions 19，call_targets 15，coverage `failed=[]`、`pending_units=[]`、`whole_program_complete=false` |

边界：只分析本仓合成 Demo C；**不是** Linux 内核/Kbuild，**不是**用户真实驱动；未联网、未运行 H 盘
launcher、未执行用户仓库；H 盘只读。因此只关闭「真实 Atlas 产物 → 只读工作台」这一项，不声称
Linux/Kbuild、native CFG/锁/别名或真实设备行为通过。

## 复现命令

```powershell
$repo = "E:\dsh\plugin\04-code-learning\evidence\code-view-slice\repo"
$out  = "E:\dsh\plugin\04-code-learning\evidence\code-view-slice\atlas-run"
$py   = "H:\VSCODE_READER\runtime\windows-x86_64\venv\Scripts\python.exe"
$env:PYTHONDONTWRITEBYTECODE = "1"
$env:PATH = (Split-Path -Parent $py) + ";" + $env:PATH
& $py "H:\VSCODE_READER\scripts\sdk_atlas.py" run `
  --repo $repo --compdb "$repo\compile_commands.json" --out $out `
  --max-tu 8 --tu-timeout 60 --dataflow off --html "$out\overview.html"
```

`compile_commands.json` 必须是无 BOM 的 UTF-8（首版带 BOM 时 Atlas 报
`Unexpected UTF-8 BOM (decode using utf-8-sig)`；已修正）。

## 文件、字节与 SHA256

| 文件 | 字节 | SHA256 |
|---|---:|---|
| `repo/bus.c`（= `demo/code-view/bus.c`） | 4744 | `b2ec232896c2680d4eb3e68e3c34681d2ceb9f0fe5fa17a1d32be9ea77f1c6cf` |
| `repo/platform.c`（= `demo/code-view/platform.c`） | 751 | `6bfe0b0be3246dca1e344b965fb9acca2bc9df7b57d4a1dbb7339e25e7773162` |
| `repo/compile_commands.json`（无 BOM） | 1057 | `8cb56ee1b4fc310ffdc294990915360066b2b89bd8f2b891484cdf3a4cf01f27` |
| `snapshot/ed326d…/graph.json`（=`inbox/snapshot-bus/graph.json`） | 279230 | `c6e49fe9a774ff02961b0417ce7a79b15e6630a03a7e8c42750d236cbef4207c` |
| `snapshot/ed326d…/analysis_manifest.json` | 2143 | `6fc22d8408f3956094e42718926da125900ba662d3305796df8588adda06c4b6` |
| `inbox/workspace.json`（WorkSpaceManifestV1） | 778 | `15993cdcfcd2cc364a3bfc2cee542cf4fc0476649c687d45467cc4bfb0bfd5b4` |

`analysis_manifest.payload.graph_hash` 逐字节等于 graph.json SHA256，已由引擎导入校验。
演示 C 与 Demo 源文件字节一致（同一 SHA256），但**运行证据不同**：Demo 是 Wasm 模拟观测，本快照是静态 Atlas 产物。

## 登记与导入（已在本机临时隔离 state 实测通过）

隔离 bootstrap 的候选根指向本目录、state/inbox 在隔离目录；`inbox/workspace.json` 使用
`root_ref=slice-root`、`repo=bus`、`variant=semantic-x86_64`、`compdb_refs=["bus:compile_commands.json"]`。

```text
workspace-import -> workspace_revision=1, repositories=[bus], freshness=fresh
snapshot-import  -> snapshot_ref=ed326d554334432b907de21297207eb8, graph_sha256=c6e49f…207c,
                    freshness=fresh, coverage.failed_count=0, whole_program_complete=false
snapshot         -> 同一快照证据投影（fresh）
```

**消费真实产物发现并修复的适配问题（本轮）**：真实 Atlas 0.8 会为文件级初始化产生
`flow_edges.owner=null`、`sources=[]` 的边；旧校验要求 owner 为非空字符串、sources 为非空数组，导致
本快照被拒绝。已放宽为「owner 可为 null、sources 可为空 id 数组」，其余恒等字段/确定性检查不变，
回归见 `engine/tests/test_atlas_flow_shape.py`（4 项）。这与 2026-11-08 记录“真实产物含合成 fixture
未覆盖的可选字段”属同一类适配问题。

## `routes[channel].max_len`：真实快照静态事实

`routes` 对象：`s_0860e6738eaa8c95f37d0d03`，`struct Route[4]`，`lifetime=static`，定义 `bus.c:26`。

| 事实 | 证据 | 分级 |
|---|---|---|
| `bus_register` 调用 `store_route`（调用点 `bus.c:58`） | call_target `c_a686c6765d3c70ca8a66ad50`，`exact` | 静态确定 |
| `store_route` 写 `routes[channel].max_len`（`bus.c:46`） | field_access `field_4a5beba32f2b4e170fabb37f`，`access=write`，`certainty=exact`，对象 `s_0860…` | 静态确定 |
| `reset` 初始化写 `routes[channel].max_len=0`（`bus.c:35`） | field_access `field_066ce4856e9b8ce75067b4e9`，`may`，limitation `unresolved_or_multiple_base_objects` | 候选 |
| `lookup_route` 读 `route->max_len`（`bus.c:92-93`） | field_access `field_0cd71f83a2f771a91f2dd939`/`field_200c5e486931ded49e62166a`，`may` | 候选（别名/基对象歧义，快照如实标限制） |
| `check_length` 读 `route->max_len` 并比较长度（`bus.c:98-99`） | field_access `field_0574079c4daf7fd7ca66a33d`/`field_82c087ffda6cefc30d3ada85`，`may` | 候选 |
| `bus_send` 调用 `lookup_route`/`check_length`/`dispatch_transfer`（调用点 `bus.c:160/164/170`） | 三条 `exact` call_target | 静态确定 |
| 超限返回 `-90`（`bus.c:164-165`） | 源码证据行 + `bus_send→check_length` exact 调用；Atlas 0.1 无 return-code 边 | 源码事实（source-only），不是运行证明 |

`resource_status` 因此是 `partial`：写为 exact，读为 may（`unresolved_or_multiple_base_objects`）。
快照同时有 `objects` 18、`field_accesses` 15、`shared_accesses` 27、`state_events` 44；本轮 UI 只显示
资源标识与写/读事实，资源关系图后置（CW-T2）。

## Demo 对照（不同证据类，不得混写）

`node --test demo/code-view/demo.test.cjs`：8/8 通过（2026-11-15 实测）。其中与 `max_len` 直接相关：

- `bus_register(1)` 选默认路由，`bus_send(1,48)` 成功并在平台侧观测到寄存器写 `0x20030`（lane 2, len 48）。
- `stub_route(1,3,96)` 后 `bus_send(1,48)` 写 `0x30030`；`reset()` 后 `bus_send(1,48)` 返回 `-2`（未登记）。
- `bus_send(0,48)` → `-2`；`bus_send(1,65)` → `-90`（超过 max_len 64）；`bus_send(1,0)` → `-22`。
- 48 字节走直发、49 字节先暂存；平台返回 `-5` 时透传到入口且 `transfer_lock` 1→0。

这些是 **Wasm 模拟观测（demo_observed）**，证明 Demo fixture 的 C 语义与事件序列；不证明真实设备或
任何 Atlas 静态边在运行时必达。

## 仍未验证

- Linux/Kbuild、生成头、目标 ABI、native CFG/锁/别名深分析。
- 真实硬件/用户驱动行为；`-90` 等返回码的运行时证据（本轮只有源码事实 + Demo 观测）。
- 五视图图形、资源关系图布局、场景执行/回退（CW-T2/T3 后置）。
