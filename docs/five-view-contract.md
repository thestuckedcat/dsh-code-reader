# 04 五视图契约（CL-VIEW-T2 / 阶段 S2a）

`CL-VIEW-T2-CONTRACT` · 2026-11-15 · 本文件固定只读五视图（资源关系图、可折叠文字树、单入口端到端图、
时序图、文件视图）的读模型 DTO、派生规则、DOM 验收钩子与逐阶段 dsh-web 验收方式。产品语义依据
[交互式代码工作台软件设计](interactive-code-view-software-design.md)（CW-02..CW-10、§6 规范），
实现/验收依据本文件；S2a 只做**只读**五视图与联动，场景执行/打桩/回退（CW-T3）与目标验证（CW-T4）后置。
[只读工作台契约](readonly-workbench-contract.md) 的 Selection、证据分级、RPC 载波、缺口规则继续有效。

## 0. 阶段与 dsh-web 验收

| 阶段 | 范围 | dsh-web 验收 |
|---|---|---|
| S2a（本轮） | 五视图读模型 + Host 端点 + client 五视图渲染 + 跨视图选中 + 左栏「全局资源」+ 打桩占位 + 图例 + 详情面板（源码/资源/缺口）+ 文件视图 + 时序「静态预测」模式 | 隔离 `dsh web` profile + Chromium 探针逐视图断言 + 每视图截图 + console clean |
| S2b（下一阶段） | 组折叠/展开（CW-06）、基础接口库（CW-07）、资源相关函数定位高亮细节、面包屑、AI 归纳占位、性能实测 | 追加探针 + 截图 |
| S3 | 场景执行/打桩/回退、轨迹导入、时序实际观测（CW-08） | 追加运行态探针 |
| S4 | Linux/Kbuild、CFG/locks/aliases、复核与性能（CW-T4/CW-11） | 目标环境证据 |

S2a 不提供：组折叠、接口库、AI 归纳正文、运行观测、场景执行/打桩、写回源码。以缺口/占位如实显示。

## 1. 数据来源与硬规则

- 全部只读自**已核验 Atlas 0.1 快照**（`load_snapshot_bundle`）与已登记源码；不新增解析器、不执行编译/Atlas。
- 派生只使用快照已有实体：`functions`、`objects`、`field_accesses`、`call_targets`、`callsites`
  （含 `guards`）、`flow_edges`（`relation ∈ argument_binding|assignment|return|initializer`）、`boundaries`、
  `issues`、`evidence`。**缺失层一律 `gaps`，不得用空数组伪装“无关系”**。
- 证据分级沿用：`exact`→静态确定、`may`→候选、`unknown`→未知、`observed`→运行观测（S2a 无运行观测）。
  `flow_edges` 全部自带 `path_insensitive/alias_not_solved` 限制，投影必须保留 `certainty` 与 `limitations`。
- 所有输出只含仓库相对路径；绝对路径、bootstrap/state 路径不得出现。节点/边/资源 id 必须稳定可复现
  （`function_id`、`callsite_id`、`call_target_id`、`field_access_id`、`object_id`、`flow_edge_id`）。
- 共享 `Selection`（只读契约 §2）跨视图保持；S2a 新增 `focus_resource_id`、`focus_callsite_id`（可为 null）。
- 预算：coupling 资源 ≤100 / 访问 ≤400；tree 节点 ≤500、深度 ≤8；end-to-end 节点 ≤120 / 边 ≤240；
  fileTree 文件 ≤2000；fileRead ≤64 KiB / 2000 行；sequence 消息 ≤200。超限 `truncated:true` + `gaps`。

## 2. 端点（引擎 CLI + Host RPC 同名）

| endpoint | 引擎 argv | 输入 | 说明 |
|---|---|---|---|
| `view.coupling` | `view-coupling --workspace W --snapshot S [--entry E]` | `{workspace,snapshot,entry?}` | 资源关系图 + 左栏全局资源 |
| `view.tree` | `view-tree --workspace W --snapshot S --entry E` | `{workspace,snapshot,entry}` | 入口可折叠文字树 |
| `view.endToEnd` | `view-end-to-end --workspace W --snapshot S --entry E` | 同上 | 单入口端到端图 |
| `view.fileTree` | `view-file-tree --workspace W --snapshot S` | `{workspace,snapshot}` | 文件树（快照涉及文件） |
| `view.fileRead` | `view-file-read --workspace W --snapshot S --repo R --path P [--max-lines N]` | `{workspace,snapshot,repo,path,max_lines?}` | 只读文件窗口（行号） |
| `view.sequence` | `view-sequence --workspace W --snapshot S --entry E [--mode static]` | `{workspace,snapshot,entry,mode:'static'}` | 静态预测时序（S2a 唯一模式） |

Host 校验：`workspace` `^[a-z0-9][a-z0-9._-]{0,63}$`；`snapshot` 有界安全字符集；`entry` 有界 id；
`repo` `^[a-z0-9][a-z0-9._-]{0,63}$`；`path` 只允许仓库相对 POSIX 路径、拒绝 `..`/绝对路径/反斜杠（长度 ≤512）；
`max_lines` 1..2000。失败语义沿用只读契约 §4（engine JSON 原样、BridgeError 映射、失败信封含 `details:{}`）。

## 3. DTO

所有端点公共前缀：
```jsonc
{"schema_version":1,
 "snapshot":{"workspace_id":"…","snapshot_id":"…","variant_id":"…","repo_id":"…",
             "freshness":"fresh","coverage":{…},"capabilities":{…},"limitations":[…]},
 "selection":{ /* 只读契约 §2 + focus_resource_id, focus_callsite_id */ },
 "gaps":[{"code":"…","status":"unavailable|degraded","reason":"…"}],
 "truncated":false}
```
`view.coupling` 追加：
```jsonc
{"scope":{"mode":"entry_neighborhood|snapshot","entry_id":"f_…|null"},
 "resources":[{
   "resource_id":"s_…","name":"routes","type":"struct Route[4]","storage":"STATIC","lifetime":"static",
   "file":"bus.c","line":26,"evidence_ids":["e_…"],
   "fields":[{"field_id":"s_…","field_name":"max_len","field_path":["max_len"]}],
   "write_count":2,"read_count":5,"related_function_ids":["f_…"],
   "accesses":[{"access_id":"field_…","access":"write|read|rmw|init|deinit|alloc|free|acquire|release",
                "certainty":"exact|may|unknown","function_id":"f_…","function_name":"store_route",
                "function_file":"bus.c","function_line":43,"location":{"file":"bus.c","line":46},
                "field_name":"max_len","expression":"routes[channel].max_len",
                "evidence_ids":["e_…"],"limitations":["unresolved_or_multiple_base_objects"]}]}],
 "functions":[{"function_id":"f_…","name":"store_route","file":"bus.c","line":43,
               "role":"writer|reader|both","is_entry":false,
               "access_summary":{"exact":2,"may":3}}],
 "edges":[{"edge_id":"access:field_…","from_function":"f_…","to_resource":"s_…",
           "access":"write","certainty":"exact","field_name":"max_len",
           "location":{"file":"bus.c","line":46},"evidence_ids":["e_…"],"limitations":[]}],
 "external_nodes":[{"function_id":null,"name":"platform_write","kind":"external|candidate",
                    "callsite_id":"c_…","file":"bus.c","line":113,"certainty":"may","reason":"implementation_not_found"}]}
```
- 资源 = 被选中 scope 内 `field_accesses` 引用的 `objects` 实体；`fields` 从访问的 `field_id/field_name/field_path` 去重。
- scope=`entry_neighborhood`：入口经 `call_targets` 向下可达函数（≤200）+ 这些函数访问资源的全部 writer/reader
  函数（≤300）；无 `entry` 时为 `snapshot`（全快照，受预算限制）。
- **写/读事实必须保留 certainty 与 limitations**；`routes[channel].max_len` 在 bus Demo 中 write=exact、
  read=may 是预期形态，不得升级。
- `external_nodes`：`callsites.callee` 不在 functions 中的调用（如 `trace`/`platform_write`），结合
  `boundaries`/`issues(kind=external_boundary)` 标 `kind` 与 `reason`。

`view.tree` 追加：
```jsonc
{"entry":{"entry_id":"f_…","name":"bus_send","file":"bus.c","line":152,"signature":"…"},
 "nodes":[{"node_id":"n_1|f_…/c_…/…","parent_node_id":null,"depth":0,
           "kind":"entry|call|external|recursion",
           "symbol":{"function_id":"f_…","name":"bus_send","file":"bus.c","line":152,"signature":"…","storage":"NONE"},
           "callsite":null|{"callsite_id":"c_…","file":"bus.c","line":160,"expression":"lookup_route(channel)"},
           "guards":[{"kind":"IF_STMT","expression":"if (!check_length(route, length))"}],
           "returns":[{"expression":"-90","certainty":"may","limitations":["path_insensitive","alias_not_solved"]}],
           "children_count":3,"expandable":true,"cycle":false,
           "limitations":[]}],
 "max_depth":8}
```
派生：从入口按 `call_targets`（source→target）向下 DFS，同一函数若在本路径重复出现标记 `cycle:true` 且不再展开；
子节点按 `callsite` 源码行排序；`guards` 原样取自 callsite；`returns` 取 `flow_edges(owner=该函数, relation=return)`；
外部 callee（不在 functions）生成 `kind:"external"` 叶子（`implementation_not_found`）。

`view.endToEnd` 追加：
```jsonc
{"entry":{…},
 "nodes":[{"node_id":"entry:f_…|fn:f_…|decision:c_…|exit:f_…:return:…|external:c_…",
           "kind":"entry|process|decision|exit|external|io",
           "label":"bus_send","sublabel":"bus.c:152",
           "file":"bus.c","line":152,"function_id":"f_…","callsite_id":null,
           "shape":"ellipse|rect|diamond|rectangle|parallelogram",
           "role":"normal|error|boundary","certainty":"exact|may|unknown",
           "evidence_ids":["e_…"]}],
 "edges":[{"edge_id":"call:edge_…|guard:c_…|return:flow_…|external:c_…",
           "from":"…","to":"…","kind":"call|guard|return|exception|external",
           "label":"lookup_route(channel)","certainty":"exact|may|unknown","origin":"deterministic_analysis",
           "callsite_id":null,"evidence_ids":["e_…"],"limitations":[],
           "style":{"line":"solid|dashed","color":"normal|exception"}}],
 "exits":[{"node_id":"exit:f_…:return:…","label":"返回 -90","expression":"-90",
           "role":"error|normal","certainty":"may"}],
 "legend":[{"key":"exact","label":"静态确定"},{"key":"may","label":"候选"},
           {"key":"unknown","label":"未知"},{"key":"error","label":"异常返回"},
           {"key":"boundary","label":"分析域边界"}],
 "layout":{"direction":"DOWN","edge_routing":"ORTHOGONAL"}}
```
派生（确定性、可复算）：
1. `entry` 节点（椭圆，顶部）。
2. 向下 ≤6 层、≤100 函数：每函数一个 `process` 矩形节点（label=函数名，sublabel=file:line）。
3. 调用边：`call_targets(source,target)` → `kind:"call"`，label 用 callsite.expression（截断 120 字符），
   certainty/origin/evidence 原样；带 `guards` 的 callsite 先插入 `decision` 菱形节点
   （label=guard.expression 截断 160 字符），caller→decision 为 `kind:"guard"` 普通实线，decision→callee
   的边带 guard 标签。
4. 外部 callee（`callsites.callee` 不在 functions）→ `external` 边界框节点 + `kind:"external"` 边（虚线），
   证据仅来自 callsite/boundaries，certainty 最多 `may`。
5. 返回/异常：`flow_edges(owner=入口函数, relation=return)` → `exit` 节点（负数字面量 → `role:"error"` 红色实线，
   其余 `role:"normal"`），边 `kind:"return"`（正常实线/异常红色实线），certainty 原样（多为 `may`，不得升级）。
   非入口函数的 return 不单独展开，汇总为 process 节点 `sublabel` 旁的 `returns` 计数（避免节点爆炸），
   并写入 `gaps` code=`callee_returns_summarized`（degraded）。
6. 图内不含运行信息；不画静态未解析的猜测边（候选仅 `may` 虚线/标记）。

`view.fileTree` 追加：
```jsonc
{"repos":[{"repo_id":"bus","role":"other","files":[{"path":"bus.c","bytes":4744,"sha256":"…","has_evidence":true},
                                                   {"path":"platform.c","bytes":751,"sha256":"…","has_evidence":true}],
           "truncated":false}],
 "gaps":[…]}
```
文件集合 = 快照 `evidence[].file` 映射到仓库相对路径后的去重集合（不扫目录、不列未参与分析的仓库文件）；
排序按 path。缺失映射的文件计入 `gaps: code=file_unmapped`，不输出绝对路径。

`view.fileRead` 追加：
```jsonc
{"repo_id":"bus","path":"bus.c","sha256":"…","bytes":4744,"total_lines":174,
 "line_start":1,"line_end":174,"truncated":false,
 "lines":[{"n":1,"text":"enum Event {"},…],
 "evidence_ref":"<签名证据，可供 code_source evidence 复核>",
 "gaps":[]}
```
读取窗口 = 请求/默认前 2000 行且 ≤64 KiB；sha256 必须与快照 evidence 记录的该文件 hash 一致，
不一致返回 `STALE_SOURCE`（引擎错误 JSON，不静默降级）；二进制/疑似秘密返回 `ref_only` 语义（无 text + reason）。

`view.sequence` 追加（S2a 仅 `mode:"static"`）：
```jsonc
{"mode":"static","observed":false,
 "warning":"静态预测：无运行观测，不表示实际执行顺序或取值",
 "participants":[{"participant_id":"caller|driver|resource|external|platform|irq|...",
                  "label":"调用方|驱动|资源|设备/库边界"}],
 "messages":[{"message_id":"m_1","index":1,"kind":"call|return|access|external|error",
              "from":"driver","to":"resource","label":"store_route(channel, lane, max_len)",
              "function_id":"f_…","callsite_id":"c_…","entry_id":"f_…","depth":2,
              "certainty":"exact|may","evidence_ids":["e_…"],"limitations":[]}],
 "gaps":[{"code":"run_observation","status":"unavailable","reason":"S2a 无运行观测；场景/轨迹导入在 CW-T3"}]}
```
静态序列 = 按源码调用顺序的 DFS 前序：入口调用 + 各层 callee 调用（`call_targets` 按 callsite 行排序），
参与者按函数所在 TU/角色与边界归类（本切片：`driver`=主仓函数，`resource`=对象/寄存器写访问所在函数，
`external/platform`=未解析边界 callee）；`access` 消息来自资源写/读；**必须显示 warning + observed:false**。

## 4. 客户端五个视图与左栏（CW-02..CW-10）

视图切换标签：`资源关系图` / `文字树` / `端到端图` / `时序图` / `文件视图`，`[data-view]` 取值
`coupling|tree|end_to_end|sequence|file`；每个视图根 `data-state="ready|loading|error|empty"`（S2a 不再用
`not_available_in_readonly_slice`，除真正的后置能力——组折叠/接口库/运行观测——用 gap 行表示）。

- **资源关系图**：三列布局（左 writers / 中 resources / 右 readers，`both` 归属左或右之一并在详情标注）；
  资源节点始终带名称/类型/用途（用途可为 null → 显示“字段说明待复核”缺口）；访问线颜色与图例区分
  read/write/rmw/init/deinit/alloc/free/acquire/release，线旁标字段名；点击资源选中并高亮其函数（只高亮，
  详情保持收起）；点击函数节点等价选中该函数（详情可展开）。
- **左栏「全局资源」**：资源行显示名称、类型、简短用途、字段来源；与当前入口/选择直接相关的资源置顶并高亮；
  初始化/修改/释放/Read 用浅色栏+文字；点击行在图中定位/高亮；「打桩模拟」入口保留，S2a 显示
  `data-stub-panel` 占位 + 原因（场景执行在 CW-T3）。
- **文字树**：入口选择器（当前快照入口列表）+ 逐层展开；每个节点显示符号、调用点 `file:line`、guard 条件、
  返回表达式（若有）、局限徽标；点击跳转文件视图对应行；折叠状态保留在视图状态内。
- **端到端图**：单入口；**竖排、带箭头实线正交折线**；入口椭圆在顶、正常出口在底、失败/异常出口红色实线走侧面；
  判断菱形、条件在线上；外部边界为标签框（虚线）；提供拖拽节点、平移、缩放、适应、搜索、一键规整；
  画布随内容扩展；滚动容器内 SVG（或绝对定位 DOM + SVG 连线）实现，不得依赖外部图库/网络。
- **时序图**：S2a 顶部显示静态预测警告；参与者生命线 + 消息箭头（call/return/access/external/error 分色）；
  消息可点击定位源码；返回/错误用虚线或红色；S2a 不提供真实执行。
- **文件视图**：文件树 + 完整只读源码（行号、当前选中行高亮、按钮/键盘跳转）；与共享 Selection 联动
  （选中函数/资源时定位其文件与行）；只列快照涉及文件。
- **详情面板**：选中函数/资源时显示源码窗口（行号+高亮）、资源分析（读/写条目）、证据分级徽标；
  `≤500 字 AI 归纳` S2a 显示占位缺口（不伪造）；点画布空白关闭详情、拖动保留选择。
- **图例**：右上角 `?` 打开图例，说明所有颜色/形状/证据分级/边界；两种主题可读；窄屏 ≤720px 折成抽屉。

## 5. DOM 验收钩子（新增；原有钩子保留）

`[data-code-view="tabs"] button[data-view]`；视图容器 `[data-code-view="view"][data-view=…][data-state=…]`；
coupling：`[data-coupling-column="writer|resource|reader"]`、`[data-resource-node][data-resource-id]`、
`[data-function-node][data-entry-id]`、`[data-access-edge][data-access][data-certainty]`；
tree：`[data-tree-node][data-node-id][data-depth]`、`[data-tree-toggle]`；
end-to-end：`[data-graph-node][data-node-id][data-node-kind][data-shape]`、`[data-graph-edge][data-edge-kind][data-certainty][data-color]`、
`[data-graph-fit]`、`[data-graph-search]`；
sequence：`[data-sequence-message][data-message-kind]`、`[data-sequence-warning]`；
file：`[data-file-tree] [data-file-path]`、`[data-file-line][data-line]`；
左栏：`[data-rail="resources|stub"]`、`[data-resource-row][data-resource-id]`、`[data-stub-panel]`；
`[data-code-view="legend"]`、`[data-code-view="details"]`、`[data-code-view="gap-code"]`；
共享选择 `[data-code-view="selection"]` 追加 `focus_resource_id/focus_callsite_id`。

## 6. 跨视图联动矩阵

| 动作 | coupling | tree | end-to-end | sequence | file | details |
|---|---|---|---|---|---|---|
| 选入口 | 重算 scope=entry_neighborhood | 重算 | 重算 | 重算 static | 保留 | 收起 |
| 点资源 | 高亮+selected | 不高亮 | 不高亮 | 不高亮 | 定位其定义行 | 展开资源详情 |
| 点函数 | 高亮+selected | 选中并滚动 | 选中并高亮 | 定位消息 | 定位函数首行 | 展开函数详情 |
| 点空白 | 清 selected | — | 清 selected（保留拖动） | — | 保留 | 关闭 |
| 返回聊天/重开 | 保留 workspace/snapshot/entry/view/selection | 同 | 同 | 同 | 同 | 同 |

## 7. dsh-web 阶段验收（必须用真实 `dsh web` 隔离 profile）

在同一隔离 profile（沿用 `tools/readonly-slice/isolated-home.mjs` 机制）中新启动一份 `dsh web`，Chromium 探针：
1. 打开「代码工作台」→ 五标签存在且可切换；每视图 `data-state=ready`。
2. coupling：`routes` 资源节点存在；`[data-access-edge][data-access="write"][data-certainty="exact"]` 含
   `max_len`/`bus.c:46`；`read`/`may` 含 `bus.c:92/93/98`；左栏资源行点击后图中高亮。
3. tree：入口 `bus_send` 树根；展开出现 `lookup_route`/`check_length`/`dispatch_transfer`；带 guard 的
   `check_length` 节点显示条件文本；点击节点后 file 视图定位到对应行。
4. end-to-end：入口节点 `bus_send`；存在 decision 节点（guard）、exit 节点（`-90` 角色 error、红色实线）、
   external 边界节点（`platform_write` 虚线）；正交折线（横竖线段）与排布方向向下；适应/规整按钮可用；
   `[data-graph-node]` 拖拽后位置变化，点「一键规整」恢复。
5. sequence：`[data-sequence-warning]` 含“静态预测”；消息含 `bus_send`、`lookup_route`、`check_length`、
   `platform_write` 外部边界；`observed:false`。
6. file：`bus.c` 文件树可得；174 行；`[data-file-line="46"]` 存在；从树/资源链接跳转高亮行。
7. legend/details/rail/stub 占位 + gaps（组折叠、接口库、AI 归纳、运行观测）原样显示。
8. 五视图截图各 1 张（`evidence/five-views/<view>.png`）+ 主流程图；console error=0；无绝对路径泄漏。
9. 既有只读切片断言（入口/快照/源码/返回/二次打开）继续通过，旧 `code_*` 工具仍注册可用。

## 8. 文件所有权（S2a）

| 负责人 | 写入范围 |
|---|---|
| Lead | `docs/`（本契约、实施路线/证据）、`source.lock.json`、最终集成/提交、`evidence/five-views/` 汇总 |
| engine | `engine/code_learning/five_views.py`（新）、`cli.py`、`engine/tests/test_five_views.py` |
| host | `lib/view-service.mjs`、`lib/http-rpc.mjs`（如方法白名单需扩展）、`tests/node/view-rpc.test.mjs` |
| client | `bundle/client.js`、`tests/node/client.test.mjs`、`tests/node/helpers/client-harness.mjs` |
| verifier | `tools/`（新增 S2a 编排/探针）、`evidence/five-views/` |

跨范围修改先经 Lead；不 git 提交；不联网；不改真实 `~/.dsh`；不重启用户桌面宿主。

## 9. 本轮验收结果（2026-11-15，S2a）

`node tools/verify-five-views.mjs --with-repo-tests`：`ok=true, verified=true`，**37/37 检查通过**，
`in_scope_not_verified=[]`；`out_of_scope_not_verified` 4 类（S2b 组/接口库/AI 归纳、S3 场景/运行观测、
S4 目标验证/性能、OS 出口）如实列出。分层：`demo_observed` Demo 8/8、`atlas_snapshot` 六端点真实 Python、
`dsh_host` 隔离 rc.5 web（boot graph/bundle 前缀/401 准入/旧 4+新 6 端点/Chromium 五视图/S1 回归/Cordis
挂载-卸载-二次挂载）。另：引擎 `Ran 261 tests, OK`、Node `83/83`。dsh-web 逐视图证据见
`evidence/five-views/`（`verification.json`、五视图截图、`main.png`、`host-runtime.json/tap`、`commands.log`）。
S2a 未实现能力（组折叠、接口库、AI 归纳、运行观测、场景执行）继续以面板 gaps 显示，未写成已通过。
