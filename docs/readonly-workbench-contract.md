# 04 只读代码工作台切片契约（CL-VIEW-T1）

2026-11-19：客户端承载、DOM 钩子与会话恢复合同已由 [CL-UI-R1](ui-demo-alignment.md) 修订为原生右栏和 Demo 同源渲染。本文保留 T1 历史验收；RPC/CLI DTO、来源核验与 Host 准入继续适用。当前 GUI 验收使用 `tools/verify-demo-rebuild.mjs`，旧主页面探针不能作为新版通过证据。

`CL-VIEW-T1-CONTRACT` · 2026-11-15 · 本文件是本轮只读切片的实现与验收契约。详细产品语义见
[交互式代码工作台软件设计](interactive-code-view-software-design.md)（CL-VIEW-D2），本文件只固定
**本轮**要交付的 DSH 插件入口、读模型、共享标识、DOM 验收钩子和分层证据口径。冲突时以详细设计为
产品依据，以本文件为实施/验收依据，并先修订本文件再改实现。

## 0. 本轮范围

做：DSH 插件原生侧边栏入口「代码工作台」→ 打开 keyed 主面板 → 选择**已登记且已核验**的 Atlas 0.1
快照 → 查看入口（函数）列表 → 从一个入口定位到**真实 C 源码**（仓库相对路径 + 行号 + 源码文本 +
证据），并显示覆盖/能力缺口；共享的选择标识为后续五视图保留。用 Demo 的「登记 → 发送」作为行为对照，
核对 `routes[channel].max_len` 的写入、读取和超限返回。

不做：五视图正式投影、资源关系图/文字树/端到端图/时序图/文件视图的图形实现、场景执行、打桩、回退、
真实设备下发、图内源码写回、真实 Linux/Kbuild 索引、按需深分析（CFG/locks/aliases/dataflow）。
这些在 UI 中以「本切片未提供 + 具体原因」占位，不得用假数据冒充。

## 1. 入口、模块与通道（固定值）

| 项 | 固定值 |
|---|---|
| 包名 / client module id | `@local/dsh-code-reader` |
| Host 插件驱动入口 | 现有 `index.js`（`name = 'dsh-code-reader'`） |
| 侧边栏面板键与主面板 key | `dsh-code-reader`（二者必须相等，rc.5 sidebar 行点击即 `layout.selectPanel(id)`） |
| 侧边栏显示名 | `代码工作台` |
| 主面板标题 | `代码工作台` |
| 客户端 bundle | `bundle/client.js`，rc.5 原生 `window.__ModuleLoader__.load({id:'@local/dsh-code-reader', factory})`，只 `require('react')` |
| 客户端服务注入 | 模块 `inject: ['slots', 'layout', 'connection']`；`package.json` 的 `dsh.client.inject = ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-renderer']`，`dsh.client.platform = 'web'` |
| Host RPC 通道 | `POST /code-view/<endpoint>`（自有 prefix 路由，不与 `/api` 共用） |
| Host 侧栏注册 | `ctx.slots.register({name:'sidebar.panellist', id:'dsh-code-reader', order: 30, label: () => '代码工作台'}, Icon)`；主面板 `{name:'main', key:'dsh-code-reader'}` |
| 返回聊天 | 面板内按钮「返回聊天」调用 `layout.selectPanel(null)` |

**Host 侧注册边界**：`index.js` 的 `inject` 保持 `['tools','skills']`，不得把 `connection`/`webServer`
变成硬依赖（否则旧工具在无 UI 服务的宿主失效）。UI 服务通过 Cordis 嵌套插件声明
`inject: ['connection','webServer']` 挂载；服务缺失时该嵌套插件保持 pending，旧工具不受影响，UI 打开时
显示实际缺口（见 §6）。

## 2. 共享标识 `Selection`（五视图保留）

所有读模型端点返回同一个共享选择对象。字段一旦引入保持稳定；本轮不提供的字段使用 `null` 或空数组 +
`*_status` 说明，不得删除字段。

```jsonc
{
  "workspace_id": "code-view-bus-demo",     // 已登记 workspace
  "variant_id": "semantic-x86_64",          // 已登记构建变体
  "snapshot_id": "22a7…",                   // 已导入并核验的 Atlas 快照
  "repo_id": "bus",                         // 目标仓
  "entry_id": "f_…",                        // 入口函数（函数实体 id）
  "symbol_id": "s_…",                       // 稳定符号 id（Atlas base_id），缺失时 null
  "callsite_ids": ["c_…"],                  // 当前选中的调用点 id（列表页为空）
  "callsite_path": [],                      // 预留：从入口到当前符号的 call_target id 路径
  "resource_ids": [],                       // 预留：资源/字段标识；本轮 [] 且 resource_status='unavailable'
  "resource_status": "unavailable",         // unavailable | partial | ready
  "evidence_ids": ["e_…"],                  // 当前选择引用的 Atlas evidence id
  "run_id": null,                           // 预留：运行记录 id（本切片只读，无运行）
  "event_id": null                          // 预留：运行事件 id
}
```

定位与联动规则（后续视图沿用）：先按 `entry_id`/`symbol_id` 精确匹配；其次按仓库相对 `file:line`；
再次按名称匹配并显式列出多候选。不得把同名不同快照/变体的结果直接合并。

`resource_ids` 在本轮从真实 Atlas 快照的 `objects`/`field_accesses` 层产生（见 §5.3）；该层确实缺失时
才置 `[]` 且 `resource_status:'unavailable'`。真实 bus Demo 快照中 `routes` 对象与 `routes[channel].max_len`
的写/读访问可用，必须投影出来，不得因为「资源图未实现」而丢弃。

## 3. 证据分级（UI 必须显示，不得混写）

| UI 标签 | 来源 | 判定 |
|---|---|---|
| 静态确定 | 快照 `call_targets.certainty == 'exact'` | 仅表示「在该分析产物中已解析」，不是运行必达 |
| 候选 | `certainty == 'may'` | 约束不足的静态候选 |
| 未知 | `certainty == 'unknown'`，或目标不在分析域（external/unknown node） | 显示原因，不画成确定边 |
| 源码证据 | 引擎签名的 `source`/`evidence` 文档（文件摘要 + 字节区间 + 行号） | 只证明该段文本存在，不是编译器语义 |
| 运行观测 | `run_id/event_id` 或 `observation_refs` | 本轮无运行观测：UI 显示「本切片未提供运行观测」 |

同一事实若只有 Demo（Wasm 模拟）证据，必须在证据说明中标为 `demo_observed`；真实 Atlas 快照证据为
`atlas_snapshot`；DSH 宿主行为为 `dsh_host`。三类不得互相冒充。

## 4. Host RPC

### 4.1 载波

沿用 08 已核的 rc.5 接缝形式（`ctx.webServer.register({kind:'prefix'})` + `ctx.connection.admit(req)`，
见 08 `src/http-rpc.mjs`；本插件独立实现，不依赖 08 包）：

请求 `POST /code-view/<endpoint>`，`content-type: application/json`，body：
`{"type":"client-request","rpcId":"<1..128 [A-Za-z0-9._:-]>","method":"<endpoint>","payload":{…}}`

成功：HTTP 200 `{"type":"server-response","rpcId":"…","result":{"ok":true,"value":<engine payload>}}`
桥接/宿主失败：HTTP 200 `{"type":"server-response","rpcId":"…","result":{"ok":false,"error":{"code":"…","message":"…","details":{}}}}`。
`error.details` 必须是对象（rc.5 浏览器 `connection.rpc.call` 的响应校验器要求 `details` 为 record，缺失会抛
TypeError；本插件只给空对象，不写入内部信息）。引擎逻辑错误（CLI 返回 JSON 且 exit 2/3/4）按 §4.2 以
`result.ok:true,value:<engine JSON>` 原样返回，`value` 形如 `{schema_version,error:{code,message,…}}` 且
**没有 `ok` 字段**；客户端必须把 `value.error.code` 识别为业务失败，不得当成功数据渲染。
非法请求仍以固定 `gateway/bad-request` 响应，永不回传 Host 内部错误文本或绝对路径。

固定限制：请求体 ≤ 16 KiB；响应体 ≤ 512 KiB；`rpcId` 必须回填；方法名不得用于拼接任意 URL；
连接准入失败返回 401/403 后直接结束。

### 4.2 端点与输入（严格校验，拒绝未知字段）

| endpoint | 输入 | 说明 |
|---|---|---|
| `view.status` | `{}` | Host/引擎/引导文件可用性摘要；不启动分析，可频繁调用 |
| `view.listSnapshots` | `{}` | 已登记 workspace + 已导入快照及其核验状态 |
| `view.listEntries` | `{workspace, snapshot}` | 某快照内的入口/函数列表 |
| `view.getEntry` | `{workspace, snapshot, entry}` | 入口详情：位置、源码窗口、调用/被调用边、证据、缺口 |

输入串长度上限：workspace/snapshot ≤ 128，entry ≤ 512；`workspace` 允许 `^[a-z0-9][a-z0-9._-]{0,63}$`，
`snapshot` 允许 `^[0-9a-f]{32}$` 或以 `snapshot-` 开的已导入 ref（以引擎实际接受为准，Host 只做有界字符
与长度校验，不解释语义）。错误码：`INVALID_ARGUMENT`（输入非法）、`BRIDGE_UNAVAILABLE`（Python/引导
不可用）、`ENGINE_BLOCKED`（引擎 exit 2）、`ENGINE_FAILED`（exit 3）、`OUTCOME_UNKNOWN`（exit 4/超时）。

### 4.3 `view.status` 值

```jsonc
{"schema_version":1,
 "host":{"plugin":"dsh-code-reader","package":"@local/dsh-code-reader","version":"0.1.0",
         "panel_key":"dsh-code-reader","rpc_channel":"/code-view","node":"24.x","platform":"win32"},
 "engine":{"python":"available"|"missing","bootstrap":{"configured":true,"exists":true}},
 "capabilities":{"readonly_workbench":true,"five_views":false,"resource_graph":false,
                 "scenario_execution":false,"run_observation":false},
 "gaps":[{"code":"scenario_execution","status":"unavailable",
          "reason":"本轮只读切片；场景执行/打桩/回退未实现"}]}
```

`python:"missing"` 或 `bootstrap.exists:false` 时仍返回 200 `ok:true`，由 UI 显示具体缺口；
禁止因此隐藏面板。

## 5. 引擎 CLI（固定 argv，stdout 单个 JSON）

新增三个命令，与现有 `code_learning.cli` 合同一致（exit 0 结果、2 输入/能力阻断、3 失败、4 unknown）：

- `view-snapshots`
- `view-entries --workspace WID --snapshot SID`
- `view-entry --workspace WID --snapshot SID --entry ENTRY_ID`

### 5.1 `view-snapshots`

```jsonc
{"schema_version":1,
 "host":{"engine":"code-learning","scope_ref":"local","scope_generation":1,"profile_ref":"desktop"},
 "workspaces":[{
   "workspace_id":"code-view-bus-demo","revision":1,"semantic_status":"semantic",
   "repositories":[{"repo_id":"bus","role":"other","root_ref":"slice-root","relative_path":"repo"}],
   "variants":[{"variant_id":"semantic-x86_64","analysis_mode":"semantic"}],
   "snapshots":[{
     "snapshot_id":"<32hex>","variant_id":"semantic-x86_64","repo_id":"bus",
     "status":"verified"|"invalid",
     "freshness":"fresh"|"stale"|"unknown",
     "graph_sha256":"<64hex>","manifest_sha256":"<64hex>",
     "tool_version":"0.8.0","atlas_schema":"0.1","imported_at":"2026-11-15T…Z",
     "entry_count":14,
     "coverage":{"failed_count":0,"pending_count":0,"whole_program_complete":false},
     "capabilities":{"direct_calls":"ready","cfg":"unsupported","data_flow":"partial_path_insensitive"},
     "limitations":["whole_program_incomplete"],
     "error":null   // status=invalid 时为 {"code":"STALE_SNAPSHOT","message":"…"}，不抛出整页错误
   }]
 }],
 "gaps":[]}
```

规则：逐个快照重新核验（graph/manifest 哈希、envelope、coverage），单个快照损坏只标该快照
`status:'invalid'`，整请求仍成功；**不得输出绝对路径**，仓库只暴露 `root_ref` 名与 `relative_path`；
`entry_count` 为该快照 graph 内函数实体数。

### 5.2 `view-entries`

```jsonc
{"schema_version":1,
 "snapshot":{"workspace_id":"…","snapshot_id":"…","variant_id":"…","repo_id":"…",
             "freshness":"fresh","coverage":{…},"capabilities":{…},"limitations":[…]},
 "selection":{ …\u00a72，entry_id=null … },
 "entries":[
   {"entry_id":"f_…","symbol_id":"s_…","name":"bus_send","display_name":"bus_send(unsigned, unsigned)",
    "kind":"function","storage":"GLOBAL","signature":"int (unsigned, unsigned)",
    "file":"bus.c","line":152,"is_entry":true,"callers":0,"callees":3,
    "file_status":"ok"}
 ],
 "external_nodes":[],
 "gaps":[{"code":"resource_graph","status":"unavailable","reason":"atlas_snapshot_has_no_resource_layer"}],
 "truncated":false}
```

排序：`is_entry` 优先，再按 `file`、`line`、`name`；`is_entry` 表示该快照调用边中无入边。
`file` 一律仓库相对路径；无法映射到已登记仓库根时 `file:null, file_status:"path_unresolved"` 并计入
`gaps`，绝不回退成绝对路径。函数条数上限 2000，超出 `truncated:true`。

### 5.3 `view-entry`

```jsonc
{"schema_version":1,
 "snapshot":{…},
 "selection":{…,"entry_id":"f_…","symbol_id":"s_…","callsite_ids":[],"evidence_ids":["e_…"]},
 "entry":{"entry_id":"f_…","symbol_id":"s_…","name":"bus_send","display_name":"…","kind":"function",
          "storage":"GLOBAL","signature":"…","return_type":"int",
          "parameters":[{"name":"channel","type":"unsigned"},{"name":"length","type":"unsigned"}],
          "file":"bus.c","line":152,"is_entry":true,
          "summary":null,"summary_origin":"missing"},
 "source":{"status":"ok"|"unavailable","path":"bus.c","sha256":"…",
           "path_ref":"<签名引用>","evidence_ref":"<签名引用>",
           "byte_start":4311,"byte_end":4735,"line_start":152,"line_end":174,
           "lines":[{"n":152,"text":"int bus_send(unsigned channel, unsigned length)"}, …],
           "highlight":{"line_start":152,"line_end":174},
           "truncated":false,"reason":null},
 "calls":[{"edge_id":"edge_…","callsite_id":"c_…",
           "callsite":{"file":"bus.c","line":160,"expression":"lookup_route(channel)"},
           "target":{"entry_id":"f_…","name":"lookup_route","file":"bus.c","line":90},
           "certainty":"exact","origin":"deterministic_analysis",
           "evidence_ids":["e_…"],"limitations":[]}],
 "callers":[{…与 calls 同形状，target 换成 source…}],
 "evidence":[{"evidence_id":"e_…","kind":"call","file":"bus.c","line":160,
              "text":"lookup_route(channel)","truncated":false}],
 "resources":{"status":"partial","reason":null,
   "objects":[{"resource_id":"s_…","name":"routes","type":"struct Route[4]","storage":"STATIC",
               "lifetime":"static","file":"bus.c","line":26,"evidence_ids":["e_…"]}],
   "field_accesses":[
     {"access_id":"field_…","object_ids":["s_…"],"object_names":["routes"],
      "field_name":"max_len","field_path":["max_len"],"expression":"routes[channel].max_len",
      "access":"write","certainty":"exact",
      "owner":{"entry_id":"f_…","name":"store_route","file":"bus.c","line":43},
      "location":{"file":"bus.c","line":46},
      "evidence_ids":["e_…"],"limitations":[]}],
   "gaps":[],"truncated":false},
 "coverage":{…},"capabilities":{…},"limitations":[…],
 "gaps":[…],"truncated":false}
```

规则：源码窗口 = 该函数定义 evidence（`start` 最小的 evidence）的 `[start,end)`，按行对齐后最多
16384 字节 / 400 行；返回 `path_ref`/`evidence_ref` 供后续 `code_source action=evidence` 复核。
源码读取失败（文件缺失/摘要不符/二进制/疑似秘密）不使整个请求失败：`source.status='unavailable'`
+ `reason`，其余字段照常返回。`calls`/`callers` 各最多 100 条，超出 `truncated:true`。
**所有输出不得包含绝对路径、bootstrap/state 路径或秘密值。** `resources.status` 只反映实际快照能力；
不得用空数组伪装成"无资源"。

资源投影规则（`view.getEntry`）：从快照 graph 的 `objects` 与 `field_accesses` 取 owner ∈ {本入口} ∪
{一跳直接调用者/被调用者} 的字段访问（最多 100 条，超出 `truncated:true`）；`objects` 取这些访问引用到的
对象并补全 `file/line`（由对象 `evidence_ids` 解析，仓库相对路径）。`access` 只允许
`read|write|rmw|init|deinit|alloc|free|acquire|release` 中实际出现的值，`certainty` ∈
`exact|may|unknown`；`limitations` 原样保留（如 `unresolved_or_multiple_base_objects`）。
`selection.resource_ids` = 投影对象的 resource_id 去重列表；`selection.resource_status`：
全 exact 为 `ready`、存在 may 为 `partial`、无对象/访问为 `unavailable`。资源图本身仍不渲染（后置），
但资源标识与写/读事实必须保留并在面板显示。

## 6. 缺口显示（硬要求）

宿主或分析能力缺失时，UI 必须在面板内显示**实际缺口**，至少覆盖：
引擎不可用（`BRIDGE_UNAVAILABLE`/Python missing）、引导文件缺失、未登记 workspace、无已导入快照、
快照损坏/过期（`invalid`/`stale`）、入口位置未知、源码不可读、资源图不可用、五视图未实现、
运行观测缺失。缺口行使用 `code`/`status`/`reason` 原文，不得改写成"暂无数据"。

## 7. 客户端 DOM 验收钩子（固定，验收工具依赖）

面板根 `[data-code-view="panel"]`；状态区 `[data-code-view="status"][data-state="loading|ready|empty|error|gap"]`；
快照候选元素带 `data-snapshot-id`（可点击）；入口行 `[data-entry-id][data-entry-name]`（`bus_send` 可出现为
`data-entry-name="bus_send"`）；源码区 `[data-code-view="source"]`，行 `[data-line="152"]`，命中高亮行
`data-highlight="true"`；证据分级徽标 `[data-evidence-class="exact|may|unknown|observed|source_text"]`；
缺口区 `[data-code-view="gaps"]` 内 `[data-gap-code]`；共享选择 `[data-code-view="selection"]`
（`textContent` 为 Selection JSON，便于验收取证）；资源标识区 `[data-code-view="resources"]` 内
对象行 `[data-resource-id]`（含对象名）、字段访问行 `[data-field-access][data-access="read|write"][data-certainty="exact|may|unknown"]`
（显示 owner 函数、`file:line`、字段名）；五视图占位 `[data-view="coupling|tree|end_to_end|sequence|file"]`，
`data-state="not_available_in_readonly_slice"`；返回聊天按钮文本含「返回聊天」；
错误区 `[data-code-view="error"]` 带 `data-error-code`。

验收工具依赖以上选择器，实现可增不改；新增状态必须同时更新本节。

## 8. 文件所有权（本轮写入边界）

| 负责人 | 写入范围 |
|---|---|
| Lead | `docs/`, `source.lock.json`, `evidence/code-view-slice/`（真实 Atlas 快照与对照数据）, 最终集成与提交 |
| engine | `engine/code_learning/views.py`, `engine/code_learning/cli.py`, `engine/tests/test_views.py`, `engine/tests/fixtures/` |
| host | `lib/http-rpc.mjs`, `lib/view-service.mjs`, `index.js`, `package.json`, `cordis.patch.yml`, `tests/node/view-rpc.test.mjs`, `tests/node/plugin.test.mjs` |
| client | `bundle/client.js`, `tests/node/client.test.mjs`, `tests/node/helpers/client-harness.mjs` |
| verifier | `tools/`（新增脚本）, `evidence/readonly-slice/` |

跨范围修改先经 Lead。新文件不得写入其他负责人的目录。

## 9. 验收动作（本轮 Definition of Done）

1. `cd engine && python -m unittest discover -s tests -v`：现有测试 + `test_views.py` 全通过。
2. `node --test tests/node/*.test.mjs`（04 根目录）：bridge/plugin 现有断言 + view RPC + client harness 全通过。
3. `node --test demo/code-view/demo.test.cjs`：Demo「登记 → 发送」8 项对照通过（`routes[channel].max_len`
   写入 0x20030/0x30030、未登记 -2、超限 -90、非法 -22、48/49 分支、平台失败 -5 与锁 1→0）。
4. 隔离 DSH profile（独立 `DSH_HOME` + web profile，预置本仓为 bundle）：
   `dsh web` 启动 → boot graph 含 `@local/dsh-code-reader` 客户端条目且注入等于 `package.json` →
   `/code-view` 路由服务实际 bundle 字节 → Chromium 探针：侧边栏入口「代码工作台」→ 面板 →
   选中已核验快照 → `bus_send` 入口 → `bus.c:152` 源码与调用边 → 返回聊天 → 二次打开保留选择 →
   截图 + 控制台无 error。
5. 真实 rc.5 Cordis 宿主运行时（内嵌 Node 24.21.0，隔离 DSH_HOME）：
   插件挂载 → 6 个 `code_*` 工具注册且其中一次真实工具调用经 Python 引擎成功 → 卸载（工具/路由注销）→
   二次挂载 → 再次注册且工具调用成功。
6. 证据分层 JSON：Demo（Wasm 观测）/ 真实 Atlas 快照（静态 exact/may + 源码行）/ DSH 宿主（入口、
   导航、卸载重挂、工具可用）分别标注，写入 `evidence/readonly-slice/verification.json`。

未通过项如实列为 `not_verified`，不得在 README/证据中写成已通过。

## 10. 本轮验收结果（2026-11-15）

`node tools/verify-readonly.mjs --with-repo-tests`：`ok=true, verified=true`，26/26 检查通过，
`not_verified=[]`，三层 `demo_observed`/`atlas_snapshot`/`dsh_host` 全部 true（verifier 与 Lead 各独立跑一次）。
另：Python `Ran 240 tests, OK`、Node `56/56`、Demo `8/8`。证据见 `evidence/readonly-slice/`
（`verification.json`、`render.png`、`render-resources.png`、`host-runtime.json/tap`、`commands.log`、
`engine-tests.txt`、`node-tests.txt`）。本轮**未验证**的外层能力（Linux/Kbuild、CFG/locks/aliases、五视图
图形、场景执行、真实设备、性能、桌面宿主热更新、OS 出口认证）见[实施路线](implementation-route.md)本轮结果节，
不得据本契约的 26 项检查推断这些能力已通过。
