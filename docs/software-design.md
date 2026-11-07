# 04 Linux 单仓/多仓代码学习软件设计

版本：`CL-DESIGN-2`，2026-11-07。状态：**编码设计；skill、适配器、学习记录服务尚未实现**。独立评审状态见[复核记录](../../docs/design-review-learning.md)。本轮只读调查 `H:/VSCODE_READER` 和既有设计；未执行 Atlas/doctor/索引、编译、安装或模型API。下述目录、API、测试和隔离是拟实现合同。产品范围见[已确认产品形态](product-form.md)。

## 1. 最终功能、入口与首版旅程

最终产品帮助用户围绕具体问题学习Linux驱动与用户态代码：从一个API/行为出发，追踪单仓或多仓中的控制、数据、对象生命周期、错误和同步路径，解释每条关系来自哪份源码/构建配置，保留事实、候选、未知及用户自己的预测，源码变化后能够续读并识别过期结论。用户得到的是能回到源码的解释与学习记录，图谱不能充当程序真实运行的证明。

用户已明确：Linux驱动和用户态组件，单仓/多仓都要；主形态 **learn-code-workspace skill + 既有 SDK Code Atlas CLI 薄适配**，不重写解析器，不把Kbuild迁成CMake。真实compdb、CONFIG、架构、工具链、生成头和间接调用可信度都是首版必需边界。

**已确认 `CL-PF-UI-01`（本轮集中确认Q04）：首版为skill＋本地证据导航/报告，专用Harness交互学习面板后置。** 在Harness对话中提出“从用户库提交任务到驱动排队发生什么”，选择已登记workspace/variant；skill调用本地CLI，先呈现小地图和可选入口，再读一条证据路径，解释机制、代价、未知；用户需要验证时先提供预测，再做已授权的最小观察；保存pending/已观察字段，暂停后可resume。Atlas原有离线HTML用于导航，学习记录和源位置在对话中可点开。方向确认不等于已实现或运行验收通过；参见根[产品决定记录](../../docs/product-decisions.md)。

首版可见产物：workspace/variant身份卡、当前快照及TU覆盖、小范围调用/数据/所有权解释、源码证据列表、未解决问题、版本化学习记录、续读状态和一个下一步。自动行为限于已有范围内的证据查询、时效重核和本地保存；新的仓库、构建执行、真实测试或新的模型接收方不由“继续学”隐式授权。用户可手动切换variant、暂停/续读、导出Markdown/JSON并归档记录。删除/归档学习记录不删除源码或Atlas快照，默认不联动05长期记忆。

已确认后置：专用Harness交互学习面板。设计决定暂不纳入首版：VSCode扩展、Serena符号导航MCP、另一套结构索引、跨团队共享进度、长期自动课程、实时设备探测。首版不证明任意运行时调用、线程重叠或硬件行为；遇到这些边界明确保留unknown，不用LLM补成事实。停用skill/CLI后本地记录仍可读取，更新先保留旧schema/source-lock，失败回到只读记录模式。

## 2. 固定来源与复用映射

实际本地源码 `H:/VSCODE_READER` 的 `scripts/atlas/domain/contracts.py` 是 **TOOL_VERSION=0.8.0 / SCHEMA_VERSION='0.1'**；README与SKILL一致。Git commit在当前权限下未可靠读取，使用逐文件SHA256固定本轮证据；下表不是完整发行source lock，正式实施还须固定完整包、许可证、运行时清单和依赖闭包。H盘全程只读，不启动其launcher或改动其源码。

已读取顶层LICENSE：Atlas为MIT，分发固定包须保留版权/许可。已读THIRD_PARTY_NOTICES：它记载Linux CPython3.12.14、Windows3.12.10、libclang18.1.1及Clang资源头llvmorg-18.1.8（commit `3b5b5c1ec4a3095ab096dd780e84d7ab81f3d7ff`）；这是上游物料说明，非本轮检测已安装版本。新runtime采用经source-lock验证的对应平台物料，保留PSF/LLVM等许可，不能用旧0.1离线ZIP冒充当前0.8源码完整发行。

| 本地来源文件 | 本轮SHA256 | 实际机制与采用方式 |
|---|---|---|
| `SKILL.md` | `eb4f8cae141dc8aa593c8ac10dc5e4c182a52131acabf66fd87e1028318e5b28` | 借鉴证据解释、exact/may/unknown与Native CFG限制；新学习skill独立编排，不把原分析skill当完整学习产品 |
| `scripts/atlas/domain/contracts.py` | `a1c3ab3792a1e8d3a94e2a57c0332373c041b3b9818aea1dbbda2b769e705846` | 直接复用0.8.0/0.1版本、已有阶段词汇；本模块自有schema=1不能覆写它 |
| `scripts/atlas/interfaces/cli.py` | `7de8dfc91e6b593a8503cf96c485ae99da4bd91a5c4839e5dc7e7379850b8052` | 直接复用run、重复root/compdb、trace/flow/locks/aliases、validate/export；薄argv适配，不虚构CLI开关 |
| `scripts/atlas/build.py` | `5885cad2d022fc19a1d15c21c6bcbf5aca9a2cd96f449fac2ced6f563330ad00` | 复用compdb归一化与CMake路径；注意compiler的`-dM -E`、`-print-file-name=include`探测会执行，外层先预检/隔离 |
| `scripts/atlas/pipeline.py` | `5f0d4cf8ec3b6aca21b41a31a96344f386137a8bc51127b7ae042f8fdcc0c7ee` | 复用TU增量、失败隔离、不可变snapshot和current指针加载；适配补外部构建身份/freshness，不另造解析缓存 |
| `scripts/atlas/graph.py` | `260d2d8ee25564b7912327079302a5abb188c6c3bc5f74f94e782173bb6db8c2` | trace有预算/递归/边界/歧义；路径结果通过callsite再join原call_targets恢复每条边certainty，不能只展示路径线条 |
| `scripts/atlas/infrastructure/store.py` | `335fe178f925b1956d6c99790d6df57e923e50f7d96630b57c9446de79ddf455` | envelope、内容寻址、writer lock/WAL与原子写；只读消费已有格式，不共享修改Atlas的DB |
| `scripts/atlas/review.py` | `88987f2b8ae5c8266343887ec90c2b4e77a826f68def8bff5eff888be197a482` | review-import核snapshot/input/read_set，Agent候选强制origin=agent/certainty=may；默认学习解释不自动import |
| `schemas/graph.schema.json` | `e0611f026a78ef733ab9ecc29aff0ba9ca88a6882fd8be7c02746cc277910c7b` | 直接复用functions/callsites/call_targets/evidence等字段及exact/may |
| `schemas/analysis_manifest.schema.json` | `1f0235446ebfa8247290f67e89a844744273db2ce503ce99d4a9d1b55b2ffd10` | 直接复用snapshot_id/analysis_id/input_files/roots/revisions/scope/coverage/graph_hash |

其他依据：[现有学习调查](../../docs/ecosystem-learning-research.md)、[既有学习设计](../../docs/ecosystem-learning-design.md)和[代码证据设计](../../docs/code-memory-design.md)。Serena/clangd、DSH codegraph、ops-codegraph只作调查对照/后置缺口候选，本设计不声称已集成，也不把调查时远端HEAD当交付source-lock。学习行为直接采用用户指定`C:/Users/admin/.codex/行为守则.md`：普通知识问答不强制考试，明确学完时才完整复盘，先预测后验证，K2/K3无G/Q允许停止，最多一个立即可执行下一步。

实现路线：固定Atlas/离线runtime和manifest → compdb/工具执行预检 → 独立合成双仓快照 → 薄查询与证据分级 → 学习记录/失效/续读 → skill和CLI旅程 → 独立评审。首个可验交付是合成UMD/UAPI/KMD fixture的一条ioctl学习路径，能区分事实、候选、未知和未完成的用户预测。正式开工前仍须按AGENTS补`docs/implementation-route.md`；本文不是已开工或完整机制交付。

## 3. 目录与模块边界

```text
code_learning/
  types.py                 # 自有DTO/错误/状态，不定义新的Clang事实
  workspace.py             # workspace/variant/根登记、realpath与身份
  build_context.py         # compdb/CONFIG/toolchain/generated-header预检
  runner.py                # 固定argv、进程树、无网profile、超时取消
  worker.py                # 持久后台run所有者，账本心跳与取消请求
  atlas_adapter.py         # 调用固定Atlas CLI，读取/核验0.1 envelope
  snapshot_view.py          # 为指定快照构造只读query view，避免current漂移
  provenance.py            # source-lock、覆盖、hash/freshness、安全投影
  paths.py                 # bounded查询结果与原边证据join、跨仓桥接候选
  records.py               # 原子版本化学习记录、CAS、导出/归档
  invalidation.py          # 本地重核及可选03事实事件消费者
  learning.py              # 一条问题路径、pending字段、停止规则
  service.py               # scope/动作/保存用例组合
  cli.py                   # JSON stdout、诊断stderr；skill唯一执行入口
schemas/                   # workspace/plan/result/record/event v1
skill/learn-code-workspace/ # SKILL.md及workflow/证据说明，均待创建
tests/fixtures/            # 合成双仓、CONFIG变体、错误compdb、Atlas快照
runtime/                   # 固定Python/Atlas/Clang资源、离线依赖
source.lock.json           # 包版本/许可/摘要/能力清单，不写用户秘密
state/<profile>/<scope>/   # SQLite、records、run plans、query views
USAGE.md / docs/mechanisms.md # 最终实际使用与机制证据，后者交付时才完成
```

不直接import H盘模块；固定Atlas完整包在本模块runtime内以原生CLI调用，保留它的离线HTML。`paths.py`只关联已有结构化事实与人工/Agent桥接候选，不写C/C++解析器。记录数据库与Atlas index.sqlite分离，学习记录绝不直接改compiler_facts。可选03/05不存在仍可独立使用；事件用fixture，记忆输出只显式导出，不自动变长期事实。

## 4. 自有数据模型与schema

所有自有JSON Schema采用Draft2020-12，`schema_version:1`、拒绝未知字段、有限长字符串/数组；字段中`ref`均本地登记非秘密引用，不能任意路径。Atlas的envelope及payload继续遵守0.1，二者不可混写。时间UTC RFC3339，hash小写SHA256；ID随机UUID/确定性内容键，均不含源码正文。

### 4.1 Workspace与构建身份

```text
Workspace = {
  schema_version:1, workspace_id, scope_ref, revision, repositories:[{
    repo_id, root_ref, vcs:{kind,commit|null,dirty_digest,untracked_digest},
    role:umd|uapi|kmd|library|other
  }], variants:[{
    variant_id, analysis_mode:source_only|semantic, architecture, target_triple, config_refs[],
    toolchain_ref, compdb_refs[], generated_header_sets[], sysroot_ref?,
    include_root_refs[], link_evidence_refs[], uapi_revision_refs[]
  }], allowed_read_roots[], output_root_ref, allowed_model_route_ref?,
  execution_profile_ref, cross_repo_bindings:CrossRepoBindingV1[]
}
ToolchainRecord = {toolchain_ref, compiler_path, compiler_sha256,
  version_evidence_ref, wrapper_policy, resource_dir_ref, builtin_roots[],
  allowed_probe_argv[], native_extractor_ref?}
BuildIdentity = {workspace_revision, variant_id, roots_digest,
  source_manifest_digest, compdb_digests[], config_digests[],
  generated_header_digests[], toolchain_digest, atlas_lock_digest,
  sysroot_manifest_digest?, binding_digest}
```

源码模式允许`toolchain_ref=null`、`execution_profile_ref=null`及空compdb/生成头集合；架构/target_triple未知为null，不能填宿主值。`analysis_mode=semantic`时这些必需构建条件按目标类型完整校验，否则`semantic_status=blocked`，不能自动改用系统编译器。BuildIdentity在源码模式的toolchain/sysroot摘要可null，source/roots/binding摘要仍必需；semantic与source_only身份永不互换。

`CrossRepoBindingV1`是自有schema，不是Atlas事实格式：

```ts
type BindingEndpointV1 = {
 repo_id:string; variant_id:string; interface_ref:string;
 source_evidence_refs:string[]; interface_revision_ref:string|null;
 snapshot_ref:string|null;
};
type CrossRepoBindingV1 = {
 schema_version:1; binding_id:string; revision:number;
 kind:'uapi_ioctl'|'shared_abi'|'protocol_message'|'shared_header';
 from:BindingEndpointV1; to:BindingEndpointV1;
 applicable_variant_pairs:{from_variant:string;to_variant:string}[];
 abi:{architecture:string|null;endianness:'little'|'big'|null;
      pointer_bits:32|64|null;compat_mode:'native'|'compat32'|'unknown';
      layout_evidence_refs:string[]};
 selector:{kind:'ioctl_command'|'message_id'|'symbol_contract';
           declared_value:string;value_evidence_refs:string[]};
 shared_definition_evidence_refs:string[];
 origin:'source_derived'|'agent'|'user_note';
 status:'candidate'|'supported'|'incomplete'|'conflicting'|'stale';
 assumptions:string[];limitations:string[];
};
```

两端必须属于已登记workspace且不同repo，variant组合精确匹配；interface_ref是登记符号/有界源码区域引用，不是自由函数名。所有evidence引用在读取时核repo/variant/内容摘要，不能为空的两端source evidence用于证明文本位置。selector.declared_value只作显示；需从两端及共享定义证据核值/版本/compat对应后才可为`supported`。缺接口版本/共同定义或一端证据即`incomplete`，值冲突/同一variant下多个互斥binding即`conflicting`，身份变化为`stale`；这些状态不产可用桥接路径。重复binding_id必须CAS更新revision，不按同名接口合并。`supported`最多形成`abi_bridge,certainty=may`，表示有静态契约依据，不是跨进程真实call证明；agent/user_note不能升级为compiler来源。结构布局只有真实目标ABI和布局证据才能解释字节偏移，缺失字段输出unknown。整个binding规范摘要进入BuildIdentity，修改使既有路径/记录stale。

### 4.1a 首次登记与无语义证据入口

首次运行从可信本地`BootstrapConfigV1 {schema_version:1,profile_ref,scope_ref,scope_generation,candidate_roots:[{root_ref,absolute_path,read_grant_ref}],import_inbox_ref,output_root_ref}`开始；这是人工/Host既有配置持有的授权根表，不从Agent工具payload接收。`workspace-import`只接受inbox内manifest_ref；manifest使用上述root_ref，不含可扩权的任意绝对路径。服务校验root真实身份、junction/symlink、范围、输出分离及当前grant，然后原子写workspace登记/manifest摘要，返回workspace_id/revision。首次expected_revision=0；已登记更新必须带当前revision，operation_id重复相同摘要返回原结果、不同摘要拒绝。登记不会执行git hook/build/compiler，也不把候选根自动全部加入项目；未知根返回SCOPE_DENIED，新增读取范围须走已有本地登记入口，不扫描整个盘。`workspace-validate`重核同一manifest并返回各variant的semantic_status/missing_inputs，不执行probe。

没有snapshot时仍可用`source-find`和`source-read`：前者仅在workspace选定repo的显式relative_glob内做文件名或**字面文本**查询（非正则、不执行忽略文件中的代码），预算默认128文件/32MiB、最多200命中；预算耗尽标truncated并返回继续游标，该游标绑定workspace_revision/文件清单摘要，源码改变即stale。后者只接受服务签发的path_ref、expected_content_sha256与`byte_start/byte_end`，区间最多16KiB、UTF-8边界安全调整后返回实际区间；句柄读前/读后核身份及内容摘要，变化返回STALE_SOURCE。两者先授权再读，不跟随链接、不穿出登记repo；二进制/秘密内容返回ref_only及原因，不给模型正文。

源码证据由service按`repo_id+content_sha256+实际byte区间`签发，不由Agent自行声明。`SourceEvidence.snapshot_id=null, origin='source_text'`，另带`semantic_status='blocked'`和`limitations:['text_only_not_compiler_fact']`；仅证明选定文本内容存在，不能产exact调用/锁/布局事实。以后有可信snapshot可建立新的compiler证据引用，保留旧文本记录，不原地抬高certainty。source-only旅程因此是登记→小地图/字面查找→有界源码→解释与unknown→记录；无需构建才能开始阅读。

仓库根realpath不得重叠到造成身份歧义；相同文件明确登记归属，不按父目录扫描兄弟仓。允许读的外部sysroot/工具链include根独立登记，不能把整块盘加入allowlist。source manifest包含选定根内源码/构建文件、dirty/untracked摘要；Atlas实际input_files用于精确证据复核，新增文件清单用于保守失效。commit无法读时null+完整内容摘要，不猜HEAD。variant是CONFIG/架构/工具链/生成头联合身份，不同CONFIG不共用事实。

Kbuild项目必须提供由真实构建形成的compdb及`.config`、对应generated/autoconf、include/generated和arch生成头；可附Module.symvers、modules.order、实际链接/模块版本作为关系证据。生成compdb使用目标内核树自身的`gen_compile_commands.py`或既有可信导出流程，**本模块不默认运行make/配置/构建**。若用户后续授权生成，作为单独build_context任务固定脚本hash/工作目录/输出/执行profile，目标build产物是输入证据。用户态组件各自提供真实compdb，不用伪造一个CMake工程。缺头/compdb时只允许源码解释模式，记录`semantic_status=blocked`，不能称完整Clang路径。

### 4.2 计划、快照和边证据

| 类型 | 必填字段/语义 |
|---|---|
| `RunPlan` | `plan_id,workspace_id,workspace_revision,variant_id,build_identity,goal,argv[],cwd_ref,env_profile_ref,read_roots[],write_root_ref,required_capabilities[],execution_profile_ref,request_digest,budgets,expires_at`；默认10分钟有效，执行前再次核hash |
| `RunStatus` | `run_id,operation_id,plan_id,generation,state:planned\|queued\|running\|completed\|failed\|cancel_requested\|cancelled\|outcome_unknown,stage,snapshot_ref?,diagnostics_ref?,coverage?,exit_code?,reason?`；completed表示运行结束，不代表全仓完整 |
| `SnapshotEvidence` | `snapshot_ref,atlas_schema:'0.1',tool_version,analysis_id,snapshot_id,manifest_sha256,graph_sha256,build_identity,coverage:{parsed,reused,failed,pending_units,total_available_units,selected_scope},freshness:fresh\|stale\|unknown,capabilities,limitations[]` |
| `SourceEvidence` | `evidence_ref,repo_id,variant_id,snapshot_id:string\|null,source_ref,source_sha256,byte_start,byte_end,line_start,line_end,origin:compiler\|source_text\|runtime\|user_note,semantic_status:ready\|blocked,limitations[],observed_at`；行号仅导航，byte区间+hash才定位证据 |
| `PathEdge` | `edge_id,from_ref,to_ref,relation:call\|reference\|dispatch_candidate\|abi_bridge\|data_flow\|ownership,certainty:exact\|may\|unknown,origin:compiler\|derived\|agent\|user_note,evidence_refs[],unknown_target_possible,assumptions[],limitations[]` |
| `PathResult` | `snapshot_refs[],nodes[],edges[],unresolved[],choices[],coverage,truncated,budget_used,freshness`；跨variant比较返回两个分离结果，不能混图冒充同一执行 |

Atlas快照实际文件是envelope `{schema_version:'0.1',record_kind,record_id,payload,provenance}`，manifest的`payload.graph_hash`对应**整个graph envelope文件**SHA，而非payload重新序列化摘要；`current.json.manifest_hash`同理。读取先核文件hash、record_kind/schema，再用固定Atlas schema及图引用验证；不对远端`$schema`发网络请求。`coverage`字段按真实版本读取并原样保留，failed/pending不能用默认0遮盖；未知字段保留在原证据，投影器遇必需字段缺失返回unsupported_schema。

当前pipeline的`coverage.failed`是失败TU对象数组、`pending_units`是路径数组，摘要另计算`failed_count=len(failed)`；不能将源字段改成整数后还称原样保留。`parsed/reused/total_available_units`为计数。`coverage.whole_program_complete=false`即使requested_scope_complete=true也必须保留。`--interface`实际匹配函数**name**，`--select-function`才是辅助精确ID选择，二者不能混用。

Atlas CLI `trace/flow`默认读`--out/current.json`，不能假设有`--snapshot`参数。`snapshot_view.py`创建每次查询独立的只读view：在受限state根复制已核验`snapshots/<id>/{graph,analysis_manifest}.json`并生成指向该ID/hash的current.json，全部普通文件且无跨根symlink；CLI只读view。这样复用原CLI而不会在学习期间被另一次run移动current。view缓存键为manifest+graph hash，查询前复核，禁止从用户自由传入view路径。

### 4.3 学习记录、续读与事件

```text
LearningRecord = {
  schema_version:1, record_id, generation, workspace_id, workspace_revision,
  variant_ids[], scope_ref, goal:{question,level:K0|K1|K2|K3,nature:[F|G|E|Q]},
  snapshot_refs[], build_identities[], evidence_refs[], path_refs[],
  mental_model:{status:pending|user_provided|agent_explanation,text?,author},
  prediction:{status:pending|user_provided,text?,provided_at?},
  experiment:{status:pending|planned|executed,plan_ref?,run_ref?},
  observation:{status:pending|observed,text?,evidence_refs[]},
  difference:{status:pending|compared,text?},
  rules:[{text,evidence_refs,applicable_scope,status:candidate|supported}],
  unknowns[], next_action:{text,estimated_minutes,completion_criterion}|null,
  cursor:{current_question,read_evidence_refs[],chosen_path_ref?,pending_choice?},
  freshness:fresh|stale|unknown, invalidation_reasons[],
  decision:DONE-KNOW|DONE-APPLIED|CONTINUE|QUESTION|STOP|null,
  created_at, updated_at, archived:false
}
```

author区分agent/user；Agent解释不能写成用户已复述。没有用户预测时prediction=pending；没有运行证据时experiment不能executed/observation不能observed；DONE-APPLIED需实际证据及用户已完成的最小应用，不能仅因为索引成功。普通问答可只生成轻量解释，不强制创建完整LearningRecord；用户要求保存/复盘时再使用完整结构。

记录用SQLite事务+不可变revision JSON：`save(record,expected_generation,operation_id)`进行CAS，失败返回STATE_CONFLICT而非覆盖。相同operation+同请求hash返回已有revision，hash不同冲突；唯一writer锁每workspace，读并发。保存成功后原子更新current revision引用；导出只取scope内该revision，Markdown标明pending/stale。归档不销毁证据；用户显式删除记录则留无正文tombstone/generation，阻止旧请求恢复正文，物理证据保留策略单独说明。

自有DB为`state/<profile>/<scope>/learning.sqlite3`，`PRAGMA user_version=1`，WAL。表定义：`workspaces(workspace_id PK,revision,manifest_ref,manifest_sha256)`；`records(record_id PK,workspace_id,generation,current_revision_ref,freshness,archived,tombstoned)`并索引`(workspace_id,freshness)`；`revisions(record_id,generation,sha256,relative_path,created_at)`复合主键；`operations(caller,operation_id,request_sha256,result_ref)`前两列主键；`runs(run_id PK,workspace_id,variant_id,plan_ref,generation,state,worker_identity_ref,snapshot_ref,cancel_requested,heartbeat_at)`；`event_inbox(event_id PK,source,generation,outcome,affected_digest)`；`consumer_cursors(source PK,last_sequence,generation,gap_detected)`。正文写临时/fsync/rename后在单事务更新revision/record/operation；无索引文件为orphan，不能自动发布记录。DB与引用目录受相同scope ACL管理，模型不能自由指定DB路径。

默认不自动清除学习证据；显式删除记录只删除该记录正文/派生导出与引用，其他记录共享快照保留，删除原始快照另用引用计数和显式管理操作。升级先停worker/写入，SQLite backup及revision清单备份到本地，迁移副本核ID/generation/tombstone不回退后原子切换；失败返回旧runtime只读。回退旧版本不直接读新schema，不从旧备份绕过tombstone复活已删除记录；明确保留历史备份窗口，未来物理清除需同时维护该窗口与删除账本。

可选03事件消费遵守根v1：`event_id,kind,source_capability,scope_ref,session_ref?,operation_id,generation,affected_refs,outcome,before_snapshot?,after_snapshot?,occurred_at`；kind只接受`session_surface_rewound/workspace_files_restored/session_removed`。按event_id幂等，乱序/旧generation只保留审计不置fresh；partial/outcome_unknown影响相关scope记录为unknown或stale。会话事件缺session_ref不能猜会话；只保守失效可定位scope并提示不完整，不删除无关数据。事件丢失检测依source journal cursor/generation，发现缺口必须重核本地manifest；没有03也每次resume独立hash检查，不靠消息可靠性保真。

## 5. CLI、内部API及输入输出

本能力首版不新增常驻MCP；skill通过固定模块CLI消费JSON，只有后续专用导航需要时才做只读MCP薄映射。拟议命令所有JSON stdout只一份结果，诊断stderr且本地脱敏；`--workspace/--record/--snapshot`值是登记ID或登记文件，不能借路径越scope。

| CLI命令（拟） | 输入 | JSON输出 |
|---|---|---|
| `workspace-import --manifest REF --expected-revision N --operation-id UUID` | 可信inbox中的Workspace manifest；首次N=0 | `schema_version,workspace_id,workspace_revision,scope_generation,semantic_status_by_variant,missing_inputs[],manifest_digest` |
| `workspace-validate --workspace REF` | 当前scope已登记workspace | `workspace_revision,valid,semantic_status_by_variant,missing_inputs[],diagnostics[]`；不执行probe |
| `status --workspace REF` | 本地登记workspace | `schema_version,workspace_revision,variants[],freshness,capabilities,missing_inputs[],active_runs[]` |
| `overview --workspace REF --variant ID [--snapshot REF] --max-components N` | 单variant；N默认20上限100；snapshot可省略 | `workspace_revision,semantic_status,components[],interface_candidates[],evidence_refs[],unknown_boundaries[],truncated`；先快速概览，再选一个问题 |
| `source-find --workspace REF --repo ID --relative-glob G --literal TEXT [--cursor REF]` | scope内repo；TEXT长度1..256；文件名查找以`--filename TEXT`替代literal，二者互斥 | `matches:[{path_ref,evidence_ref,source_sha256,byte_start,byte_end,line_start,line_end,safe_preview}],next_cursor,scanned_files,scanned_bytes,truncated,semantic_status:'blocked'` |
| `source-read --workspace REF --path REF --expected-sha256 HASH --byte-start N --byte-end N` | 已签发path_ref；0≤start<end，区间≤16KiB | `SourceEvidence,safe_text\|ref_only,actual_byte_start,actual_byte_end,reason?`；无snapshot也可用 |
| `plan --workspace REF --variant ID --goal-file REF` | 问题文件、单variant、预算配置 | `RunPlan`，不执行Atlas/compiler |
| `run --plan ID --operation-id UUID` | 未过期/未变更plan、已匹配执行授权/profile | `RunStatus`；只启动一次，长任务立即返回run_id |
| `poll --run ID` / `cancel --run ID --operation-id UUID` | 本scope run引用 | `RunStatus`；cancel确认前仍cancel_requested |
| `snapshot --run ID` | 已发布不可变快照 | `SnapshotEvidence`；失败run没有快照不取旧current冒充 |
| `path --snapshot REF --from REF --to REF --budget N` | 已锁snapshot/function ID；budget默认2000上限10000 | `PathResult`；默认depth30，可配置1..100；同名返回choices |
| `relation --snapshot REF --query-file REF` | 登记inbox内`RelationQueryV1`；见下方模式合同 | `RelationResultV1`；锁/别名/数据入口统一经service，不绕CLI |
| `source --evidence REF --max-bytes N` | 已登记source区间，默认/上限16KiB | 安全投影+SourceEvidence或ref_only；不返回无界源码 |
| `record-save --input REF --expected-generation N --operation-id UUID` | 合同校验记录草稿 | `record_id,generation,revision_ref` |
| `resume --record REF` | 固定revision/record ID | `record,freshness,changed_inputs[],required_rechecks[],safe_cursor` |
| `export --record REF --format markdown\|json` | scope内记录 | `export_ref,sha256,bytes`，不自动上传/同步 |

公共失败对象`{schema_version:1,error:{code,message,details_ref?,retryable},operation_id?}`；最少错误码 `INVALID_ARGUMENT/NOT_FOUND/SCOPE_DENIED/STALE_PLAN/STALE_SNAPSHOT/STALE_SOURCE/AMBIGUOUS_SYMBOL/CAPABILITY_UNAVAILABLE/UNTRUSTED_COMPILER/EXECUTION_BLOCKED/DEPENDENCY_UNAVAILABLE/UNSUPPORTED_SCHEMA/STATE_CONFLICT/OPERATION_CONFLICT/LIMIT_EXCEEDED/OUTCOME_UNKNOWN`。退出码0表示工具结果有效，2输入/策略阻断，3执行失败，4结果未知；有效PathResult可以有unknown，不能用进程exit0宣传关系已验证。

`overview`从登记repo角色/版本/variant和显式bindings产组件图；有快照时补已有结构化入口证据。文件夹名/README/人工角色是`declared`或`text_candidate`，不能标编译依赖；没有快照时同样给仓库边界、已登记接口候选及missing_inputs，不悄悄全仓语义扫描。最多列N组件与200接口候选，省略计数明确，来源等级随项返回。

`RelationQueryV1 {schema_version:1,mode:'flow_cfg'|'flow_legacy'|'locks'|'aliases',function_ref?,parameter_ref?,value_ref?,symbol_ref?,object_ref?,lock_ref?,direction?:'forward'|'backward',budget:number,max_items:number}`。budget默认2000上限10000，max_items默认200上限2000；所有ref从同一snapshot实体表解析为固定Atlas ID，不允许自由拼argv。模式互斥如下：

| mode | 合法输入与真实Atlas argv（所有OUT为已核只读query view） | 缺能力/投影语义 |
|---|---|---|
| flow_cfg | 必需function_ref，parameter_ref/value_ref恰一个；拒绝symbol/object/lock；`flow --out OUT --function F --parameter P`或`--value V`，加`--direction D --budget N` | 先核该function的CFG/value节点和dataflow状态；没有则CAPABILITY_UNAVAILABLE，不自动以legacy冒充CFG |
| flow_legacy | 必需symbol_ref，拒绝function/parameter/value/object/lock；direction固定forward；`flow --out OUT --symbol S --direction forward --budget N` | 仅允许无CFG value_nodes且有对应legacy数据边的snapshot；否则要求选flow_cfg或明确不可用，防上游按value_nodes隐式转模式；输出certainty=may及path_insensitive/alias_not_solved等原限制 |
| locks | object_ref/lock_ref至少一个，可同时；拒绝其他selector/direction；`locks --out OUT [--object O] [--lock L]` | 原生无budget参数；runner以时间/输出上限约束，结果投影max_items并标截断；没有锁分析状态/证据返回不可用，空匹配不证明无竞争 |
| aliases | object_ref/function_ref至少一个，可同时；拒绝parameter/value/symbol/lock/direction；`aliases --out OUT [--object O] [--function F]` | 原生无budget参数，同上做runner与输出限额；保留alias_status/原限制，空结果不证明不别名 |

`RelationResultV1 {schema_version:1,mode,query_digest,snapshot:SnapshotEvidence,status:'ok'|'partial'|'unavailable'|'ambiguous',capability,selection,items:[{item_id,relation,origin,certainty,evidence_refs[],source_entity_refs[],limitations[]}],unknowns:[{reason,evidence_refs[]}],choices[],truncated,budget_used,limitations[],raw_result_ref}`。这里`selection`为本次已验证selector引用回显；capability为`{available:boolean,reason:string|null}`，budget_used为`{elapsed_ms,items_emitted,bytes_captured}`；未知或unsupported保留原因，不补空数组伪装完整。结果只有原证据明确支持时才保留其exact，数据推导/别名/锁集结论不能抬成真实runtime时序。Atlas原payload原样落本地raw_result_ref，对模型只返回有界安全投影。身份/参数非法用公共失败，缺分析能力返回status=unavailable并给unknowns（有效工具结果exit0），不是执行成功的语义证明；CLI外层缺固定运行时仍DEPENDENCY_UNAVAILABLE。函数/对象歧义返回choices，不批量跑所有同名目标。

selector到原CLI的映射按实际0.8实现：function_ref用function ID；parameter_ref先定位该function内唯一kind=parameter的value node，再传其symbol（或唯一十进制index），**不能传value node ID给`--parameter`**；value_ref用原value node ID；object_ref/lock_ref分别用原objects/locks可接受的ID。映射前核owner/variant；引用错属另一函数返回INVALID_ARGUMENT，不交给上游模糊匹配。原始flow/locks/aliases实现分别位于`application/service.py`、`dataflow.py`、`concurrency.py`、`aliasing.py`，本次仅实读，完整source-lock仍待准备。

内部签名与职责：

```text
validate_workspace(manifest_ref, context) -> Workspace
import_workspace(manifest_ref, expected_revision, operation_id, bootstrap) -> WorkspaceRegistration
find_source(workspace, repo_id, selector, cursor, budgets) -> SourceMatches
read_source(workspace, path_ref, expected_hash, byte_range) -> SourceProjection
overview(workspace, variant_id, snapshot_ref?, max_components) -> WorkspaceOverview
preflight_build(workspace, variant_id, policy) -> ValidatedBuildContext
plan_atlas_run(workspace, goal, build_context, budgets) -> RunPlan
execute_plan(plan_id, operation_id, runner: RestrictedRunner) -> RunStatus
RestrictedRunner.spawn(argv, cwd, env, limits, execution_profile) -> ProcessHandle
read_snapshot(snapshot_ref, scope) -> SnapshotEvidence
query_path(snapshot_refs, endpoints, budget) -> PathResult
query_relation(snapshot_ref, RelationQueryV1) -> RelationResultV1
save_learning_record(record, expected_generation, operation_id) -> RecordRevision
resume_record(record_ref, workspace) -> ResumeResult
consume_event(event, consumer_cursor) -> {accepted, stale_record_refs, next_cursor}
```

CLI只调用service，不能任意拼Atlas参数；所有ref解析由workspace/provenance完成。`query_path`调用固定Atlas `trace`，将from→to可达路径有界筛选；跨ABI无编译call边时返回两端路径+`abi_bridge`候选而不是在Atlas事实库制造call。锁/别名/CFG查询复用Atlas `locks/aliases/flow`，仅按具体问题调用，不启动另一套全仓索引。

## 6. compdb预检与受限执行的实现决策

`plan`只做数据读取/摘要，不调用doctor/compiler。预检每个compdb entry的directory/file/arguments/command：源文件归属登记根；cwd为登记构建目录；有arguments优先；command按平台原生规则解析，不执行shell；拒绝命令链、重定向、环境赋值包装、未知wrapper和非绝对compiler。仅显式登记的ccache/sccache映射可归一化为锁定compiler，记录原命令；不实际运行wrapper。kernel常见GCC风格参数不因阅读方便悄悄删CONFIG或变换目标架构。

response文件递归最多8层、总1MiB，固定hash/根、拒绝环和越根；预检展开后的argv也要验证，不能只检查顶层。include/sysroot/resource-dir、`-include/-imacros`读路径必须在登记源码/生成头/工具链只读根内；拒绝未登记plugin/`-Xclang -load`、动态module、VFS overlay和会引入任意读写/加载的参数；已知不可支持选项明确阻断该TU或variant，不能删掉后称相同构建。预检生成sanitized compdb副本，记录原hash→规范化hash/差异；编译语义变化不允许作为自动清洗。

当前Atlas `build.normalize`仍可能调用所选compiler探测，因此`run`必须在**实际强制**execution_profile中运行：源与toolchain/sysroot只读挂载，唯一可写out/temp；无凭据目录、无网络，子进程只能固定Python/native extractor/compiler/CMake（后者仅真实CMake项目且已授权）路径和hash；环境无代理、插件加载路径和未知PATH。Linux目标优先隔离容器/受限账户+进程树监督，平台具体实现准备时验证；仅写环境变量/允许表不构成沙箱。缺可用profile则run返回EXECUTION_BLOCKED，仍可读已有snapshot与源码，不静默裸跑。

首版执行后端确定为Linux隔离runner：优先固定本地`bwrap`构件（精确版本/许可/hash在准备任务登记），argv包含`--die-with-parent --new-session --unshare-net --unshare-pid --clearenv`，只ro-bind已登记runtime/工具链/源码/sysroot，bind本run输出，tmpfs工作临时目录、proc/dev最小挂载；worker监督其进程组。动态loader/系统库须列入固定toolchain运行闭包，不ro-bind整个宿主home或磁盘。源目录禁止作为可执行搜索根，CMake未授权分支不挂其可执行文件。若本机namespace不可用，使用已预置且无网络的固定OCI分析容器profile，等价挂载/只读/资源限制；两者均不可用时确定进入snapshot-only模式。是否实际挡住exec/任意写由逃逸负例验证，profile不通过则不得启用run；不把应用argv检查宣传成内核执行白名单。

Atlas实际argv示意（Linux，准备完成后的未来调用）：

```text
<locked-python> <runtime/atlas/scripts/sdk_atlas.py> run
  --repo <registered-umd-root> --root <registered-kmd-root>
  --root <registered-uapi-root>
  --compdb <validated-umd-compdb> --compdb <validated-kmd-compdb>
  --out <new-run-output> --interface <chosen-function-name>
  --max-tu 128 --tu-timeout 120 --dataflow off --html <output/overview.html>
```

传argv数组，无shell插值；只用真实CLI已有选项。没有`--variant`参数，variant写入外层run目录与build identity并以对应compdb/config实现隔离。CFG只在固定Clang18 native extractor身份/能力实际验证通过时改`--dataflow cfg --native-extractor <locked-path>`；core ready不等于CFG ready。`doctor/verify-runtime`是未来准备/验收动作，不能因本文提到就本轮执行。

若同名函数歧义，先向skill返回候选及source/variant，用户在学习内容层面选择入口；已有当前快照精确ID时才加`--select-function <id>`与对应name。不得把同名全合并或在重建后沿用不再存在的旧ID。

Windows可管理记录、读Linux生成的证据；不以Windows假头和删参数模拟目标Linux。若暂无可信Linux分析环境，首版可先用固定Linux发行包在离线受限容器/目标分析主机生成snapshot，再导入hash验证后的包，在本机只读学习。分析主机是明确登记目标，传输采用独立已授权渠道；04不依赖02已实现，也不暗建SSH客户端。

## 7. 关系可信度与跨仓路径

每个节点身份为`workspace_id/repo_id/variant_id/snapshot_id/atlas_entity_id`；同名static函数、同USR在不同变体不得合并。Atlas exact是已分析编译上下文中的解析目标，不意味着运行必达；may保留所有候选及unknown_target_possible。`PathResult`从trace的nodes/callsites回连graph.call_targets，不丢origin/certainty；无法唯一关联则unknown，不能选一条最近名字连线。

| 场景 | 可以记录的事实 | 不能自动提升的结论 |
|---|---|---|
| 直接call-expression | Clang解析到的callee/位置/CONFIG变体 | 运行时必执行、所有配置都相同 |
| `ops.foo = fn` /取函数地址 | 源码赋值/引用；已解析有限别名候选 | 已实际调用fn；完整回调生命周期 |
| 函数指针/虚调用 | Atlas当前候选、final封闭条件、open_world未知 | workspace等于封闭程序，消除所有未知 |
| UMD ioctl→UAPI→KMD dispatch | 两端命令值、头文件hash/版本、结构布局/compat、file_operations/分派源码 | 单凭同名宏或同值就证明同一驱动ABI |
| EXPORT_SYMBOL/模块依赖 | 导出点、Module.symvers/Kbuild/链接产物版本的证据引用 | 导出等于调用，文件存在等于实际装载 |
| workqueue/IRQ/DMA/firmware | 注册点、队列/对象/缓冲区/边界与锁的静态证据 | 硬件完成、线程重叠、完整happens-before |

跨仓桥接用`cross_repo_bindings`显式登记共享UAPI/接口版本、对应两端source refs和适用variant；`paths.py`核命令值/字段证据后产生`abi_bridge,certainty=may`与前提列表。结构布局缺真实目标ABI/编译信息时unknown，不从文本字段顺序猜字节偏移；compat路径独立。可提供用户确认的协议binding作为user_note，仍不能变compiler call事实。图中每边都可打开证据，边界保留unknown，人工标注不回写exact。

## 8. 学习编排与续读状态机

普通问题直接回答所问，给关键源码与可信度；不要求先答3–8句才能获得解释。用户明确“学完了/复盘”时使用行为守则固定Knowledge→Level/Nature→Mental Model→因果/系统映射→Prediction→Experiment→Observation→Difference→Rules→Question→Decision流程，未完成字段明确pending；不把20分钟阅读升级为长期课程。

一条路径的状态为`scoped → mapped → reading → explanation_ready → prediction_pending → verification_pending → reflected → paused/done`，允许普通问答在explanation_ready结束。最小验证前请用户预测，未获得预测不代填；独立软件测试的合成断言不算用户已预测/已理解。K1重点能定位和判断，细节可查；K2/K3无G/Q明确已经学够可停止；Next Action最多一条，含动作、预计用时和完成标准。没有现实主线价值的问题记E，不自动入backlog。

`resume`先核workspace revision与BuildIdentity，再核已读evidence的文件hash/byte区间。source/compdb/CONFIG/toolchain/生成头任一变化→stale；文件丢失/输入不可读→unknown；新增源文件触发保守重新分析。仅显示旧记录为historical，禁止用旧行号对当前源码作事实声明。安全cursor指向“先复核这条证据”，不直接接上旧结论；完成重核后新revision写fresh，旧revision保持原样，不能就地换snapshot把旧预测变成新观察。

无需跨模块全局事务；03事件可加速失效但不替代本地重核，05记忆只作为用户请求时的非权威旁证。新的学习/总结请求如需模型，只使用入队时固定的已批准主模型route/scope/purpose；这里不新增后台反思、embedding或备用API。

## 9. 并发、超时、取消与失败恢复

每workspace+variant一个Atlas writer，其余query使用独立不可变view并发读；records按record CAS写。`operation_id`按scope+caller唯一；相同标准化请求hash返回已存在run/revision，不重跑，hash不同OPERATION_CONFLICT。plan包含输入摘要与10分钟有效期；启动前再次核输入与锁，旧计划不适配到新版本。worker先持久reserve后spawn，记录PID/启动代数/argv摘要，不用PID单独当进程身份。

`run` CLI登记queued后启动固定runtime的`python -m code_learning.worker --run-id ID --launch-token REF`后台进程，stdin接DEVNULL、stdout/stderr到run受限日志，不开交互窗口；CLI立即返回run_id。worker持workspace/variant lease，心跳1秒，launch-token仅本地一次性文件不入模型；把已核plan交给runner，只有worker是进程树owner。poll读取账本并核worker PID+系统启动时间+launch-token摘要；cancel先事务写cancel_requested，worker每100ms检查并停止自己的runner进程组。worker死亡或身份不匹配时不对复用PID发信号，状态unknown并保留诊断。无常驻全局服务、无Web listener；后台worker退出后poll仍能读完成账本。

建议工程默认预算：max-tu128、每TU120秒、整体20分钟、查询2秒/2000边、stdout/stderr各8MiB、源码单投影16KiB；均是可配置上限，不是用户性能承诺。预算耗尽返回partial/truncated和已发布snapshot（若有），不能把pending TU计为完成。CLI run worker捕获Atlas stdout为本地诊断，不直接流到模型；大错误输出只返回safe summary/ref。

取消：置cancel_requested→向受监督进程组发终止→最多5秒→强杀本次进程树→确认退出才cancelled；不能kill用户其他同名compiler。服务重启只依据账本/进程身份查询，无法确认则outcome_unknown；从已发布且校验过的snapshot恢复查询。未完成run目录保留diagnostics，不能指向上一个run的current冒充本次成功。再次分析是新operation/new run，由用户已有授权范围决定，不在重启时自动执行仓库脚本。

Atlas具有自身writer.lock/增量缓存；外层不修改它的锁，也不在未知活进程时删除锁。若其恢复合同不支持当前崩溃，复制已核不可变快照作只读学习，新的分析out另建目录，不绕锁强写旧cache。碎片临时文件只在已核本scope根内清理，保留失败journal供排查。

## 10. 离线依赖、模型与唯一出口

Python3.11兼容基线，正式准备时固定补丁版本；Atlas0.8.0源码/发布物、Clang内建头资源、libclang18.1.1等按source.lock逐字节锁定。当前requirements列cmake4.4.3/ninja1.13.2/jsonschema4.26.0等是源码声明，不代表已安装；只读CLI旅程不需要额外Serena/codegraph/浏览器下载。Native CFG需另固定Clang18 extractor，不可用时输出capability=false且不造CFG。运行时缺依赖失败，不执行setup/pip/git/远端fetch或降级系统全局工具；HTML内嵌/本地资源，禁止公共字体/图片/图示托管。

唯一允许外部接收方为**已批准主模型API，以及本任务明确登记的可信分析/数据目标**。正常Atlas/查询进程离线无网；模型仅由Harness已配置route处理本次必要解释/提炼，CLI本身不持key、不调用模型。禁未知Provider/环境变量key、遥测、通知、更新、远程索引、权重下载、云embedding/rerank；如需检索先用Atlas本地查询/词法，不为“语义”暗下模型。

模型上下文只取scope内选定源片段和safe_projection，限制大小、保留出处；含秘密的文件/区间拒绝进入上下文，未知输出可ref_only。源代码和编译命令也可能含凭据，不能仅靠名为password的键脱敏；预检允许列表字段、敏感模式/已知秘密金丝雀和人工可审阅投影策略共同控制，不能承诺自动识别任意嵌入秘密。原始compdb、源码全集、core等不自动发送；用户授权的主模型API可能公网，不能误写成“一律禁止公网”。

权限由OS/容器profile和进程树监督强制，覆盖编译器probe、native extractor、CMake、动态库、DNS/代理、浏览器HTML资源；仅stdio/本地地址/提示词不是边界。本轮没有部署或外发实测，不声称安全保证已达成。实施验收需观察未登记连接被阻断并查明任何额外尝试来源；未验证profile仅允许读现有证据，不解锁源码执行路径。

## 11. 稳定需求映射、实施任务与验收命令

旧设计`REQ-L01..`继续保留，本地新增CL-ID用于代码/测试追踪；`CL-001/002`覆盖REQ-L01/L02及工具链边界，`CL-003/004`覆盖原证据与路径要求，后续根合同变化只更新引用，不重编号。

| ID | 功能/边界 | 拟代码/API | 拟验证 |
|---|---|---|---|
| CL-001 | 单/多仓、首次登记、source-only、Kbuild/真实compdb/variant身份 | workspace/build_context；workspace-import/validate/source-find/read/overview | test_workspace.py：首次CAS登记、未知根/链接/跨根拒绝、无compdb有界读源码、非编译来源、CONFIG/dirty/新文件变化失效 |
| CL-002 | 固定Atlas CLI、可信probe、离线受限执行 | runner/atlas_adapter；plan/run | test_atlas_adapter.py/test_runner.py：恶意compiler/wrapper/response/插件、超时、取消/进程树 |
| CL-003 | 0.1快照完整性、coverage、不可变query view | snapshot_view/provenance；snapshot | test_snapshot.py：envelope/hash篡改、current漂移、failed/pending、不支持schema |
| CL-004 | 真实边/间接候选/ABI桥/锁/别名/数据/预算 | paths；path/source/relation、CrossRepoBindingV1 | test_paths.py：ops仅reference、同名static、binding值/版本/compat冲突与缺证、关系模式互斥/CFG不可用不降级、原生argv无虚构budget、may/unknown和截断 |
| CL-005 | 学习记录/CAS/预测与观察分离 | records/learning；record-save/export | test_records.py：未预测pending、无证据不能observed、operation冲突、导出范围 |
| CL-006 | 本地hash及可选事件失效、续读 | invalidation；resume/consume_event | test_invalidation.py：CONFIG变化、乱序/缺事件、partial/unknown、旧generation |
| CL-007 | 问题驱动skill与停止规则 | skill/learning/USAGE | test_skill_contract.py及独立对话评审：普通问答、学完复盘、K2停止、Next Action最多一条 |
| CL-008 | 唯一模型/可信目标出口与上下文投影 | provenance/runner/部署profile | test_egress.py/test_projection.py：compiler/HTML无网、秘密金丝雀、无API fallback |
| CL-009 | 首版学习旅程与管理/恢复体验 | service/cli，必要后置Host | test_cli_journey.py：首次登记→source-only概览/源码→导入真实构建快照→双仓桥接/关系→pending→暂停→源码变化→安全续读 |

CLI子命令名为稳定接口ID，内部签名按本设计命名；验收ID固定`CL-001-A`至`CL-009-A`对应各行，另`CL-002-F`（worker崩溃/PID复用不误杀）、`CL-006-F`（丢事件后本地重核）、`CL-009-L`（停用/更新失败仍可只读记录、卸载保留用户证据）。测试名可调整，ID在fixture/test说明中保留，便于局部改动追踪。

未来任务均未执行；每项写真实行为失败测试→确认收集且因未实现失败→最小实现→同命令复测→独立评审。runtime缺失或0 tests不能作红/绿证明。

1. **Task1 输入与执行底座**：创建types/workspace/build_context/runner、workspace/plan schemas、source.lock与离线runtime。实现CL-001/002/008硬边界；先以fake runner测计划，再在受限Linux fixture实测compiler probe只落预期参数/读根，无网与越根写被拒。H盘不改动。
2. **Task2 Atlas快照与查询**：创建atlas_adapter/snapshot_view/provenance/paths，完成CL-003/004。先用固定snapshot fixture验证join/模式，再运行合成UMD/UAPI/KMD真实compdb；记录doctor能力/解析失败覆盖/CLI输出。真实Kbuild fixture只在对应Linux工具链可用后执行，不靠Windows伪头通过。
3. **Task3 学习记录与恢复**：创建records/invalidation/learning及schemas，完成CL-005/006；事件用fixture，不依赖03服务。故障注入保存中崩溃、CAS冲突、断档事件；暂停后改CONFIG/源hash，resume明确stale并重核，预测仍pending。
4. **Task4 CLI/skill与可见旅程**：创建service/cli/skill/USAGE，完成CL-007/009；按CL-PF-UI-01明确答复固定首版入口。独立对话评审检查普通问答不考试、学完才完整复盘、先预测、边界、可停止。字符串测试仅合同辅助，不能当用户学习效果证明。
5. **Task5 交付与改进依据**：真实合成双仓分析/查询/记录续读旅程，执行出口与秘密投影负例；记录source-lock、命令/输出、skip/blocked和真实驱动覆盖缺口；补docs/mechanisms.md稳定机制ID→代码→证据→skill可调点，最终完整验收后才标完成。

准备完成后的可运行命令（**未来执行；runtime/tests尚不存在，本轮未运行**），在本能力目录执行；Windows记录层测试可将解释器替换为`& .\runtime\python.exe`，Linux语义测试必须用真实目标环境：

```bash
./runtime/bin/python -m unittest discover -s tests -p test_workspace.py -v
./runtime/bin/python -m unittest discover -s tests -p test_atlas_adapter.py -v
./runtime/bin/python -m unittest discover -s tests -p test_runner.py -v
./runtime/bin/python -m unittest discover -s tests -p test_snapshot.py -v
./runtime/bin/python -m unittest discover -s tests -p test_paths.py -v
./runtime/bin/python -m unittest discover -s tests -p test_records.py -v
./runtime/bin/python -m unittest discover -s tests -p test_invalidation.py -v
./runtime/bin/python -m unittest discover -s tests -p test_cli_journey.py -v
./runtime/bin/python -m unittest discover -s tests -p test_egress.py -v
./runtime/bin/python -m unittest discover -s tests -v
```

`test_linux_atlas_journey.py`和`test_kbuild_context.py`为拟创建的强制集成门禁，命令同上`-p test_linux_atlas_journey.py`/`-p test_kbuild_context.py`；缺nativeCFG可明确验证capability=false分支，但声称CFG交付必须另执行真实native fixture。缺Linux/真实Kbuild输入时记录blocked，不以skip或合成compdb冒充真实内核覆盖；首版功能验收合成驱动不代表已读懂用户仓。

## 12. 变化方法与仍需验证的技术项

新增/微调需求先定位CL-ID与受影响API/schema/验收，保持旧ID加revision；skill只调整阅读顺序、预算、解释与停止策略。构建身份、证据certainty、scope/执行/出口硬边界必须在CLI/Service/runner和负例中改，不能靠prompt绕过。新可选字段兼容读取需显式默认语义，破坏语义升自有schema主版本，绝不修改Atlas0.1假装兼容；上游升级先保存字节/版本再重跑快照/查询与probe合同。产品入口或首版范围实质变化仅重核相关PF项。

局部新增示例：增加按`relation`筛选路径只扩展path CLI/schema、paths投影和CL-004-A；默认不过滤，query view/构建身份不变，无需重问首版面板。若改成跨项目自动共享学习规则，新增需求与scope/模型接收方/删除传播验收，重核受影响高层产品与权限，不当作一个布尔参数悄悄启用。v1严格schema不识别的字段仍拒绝，兼容扩展以明确CLI capability修订声明后再发送。

| 修订 | 来源/变更 | 受影响ID | 状态 |
|---|---|---|---|
| CL-DESIGN-1 / 2026-11-06 | 本轮编码级设计、真实源SHA、Q04首版确认、worker/快照边界 | CL-001..009、CL-PF-UI-01 | 产品方向已确认；设计待独立复审；实现未开始 |
| CL-DESIGN-2 / 2026-11-07 | 响应独立评审CL-R1..3：具体跨仓binding、关系查询与真实argv、首次登记/source-only入口及快速概览 | CL-001/003/004/009、CL-PF-01..04 | 设计修订待原评审者复核；未实现/未运行 |

明确验证与替代：Atlas对目标内核GCC扩展/生成头可能不完整，未来在真实Kbuild fixture记录失败TU及诊断，缺口保留源码阅读+unknown而非自造parser；跨仓ABI布局没有真实目标证据就停在may/unknown；Native CFG缺少Clang18时明确禁用该分支，仍可完成带限制的call学习；无法提供强制隔离runner时只读导入的已核snapshot，不裸跑probe。上述替代不等于完整能力已通过，相关集成门禁仍保留。

本轮已有证据只覆盖源码读取、文件SHA和文档自检；不宣称已完成索引、出口测试、用户预测、实验观察或掌握。未来每次报告明确actual/planned/blocked；正式完成机制文档不得用此设计充数。

**接下来该怎么做：** 用约15分钟让独立评审者沿合成ioctl路径核对CL-001→CL-009的输入、接口、置信度和续读失效；完成标准是每条学习关系可指回证据，设计缺口已关闭或成为明确运行门禁，本轮不执行索引。
