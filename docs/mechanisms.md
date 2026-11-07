# dsh-code-reader 机制说明（04 代码学习首版）

版本：`MECH-04-1`，2026-11-07。对应实现 `CL-IMPL-1`（仓库 `dsh-code-reader` v0.1.0）。本文按[机制说明合同](../../docs/mechanism-document-contract.md)交付：以 **场景→触发→输入与前置条件→判断规则→工具动作→状态/输出→证据→失败与恢复** 为主线，说明为什么这样设计、代价与已知限制，并区分 **skill 可调策略** 与 **plugin/CLI/Host 必须执行的硬边界**。

**证据边界**：本文只记录本轮实际运行过的合成 fixture 证据（200 Python 测试、11 Node 测试、安装后 Host 工具旅程）。真实 Linux/Kbuild 索引、编译器探针隔离、native CFG、真实驱动运行时行为 **未验证**，见 §9。设计文档中的“未来合同”不等于已实现。

---

## 0. 机制总表

| ID | 机制 | 主要代码 | 类别 |
|---|---|---|---|
| M-04-01 | 可信 bootstrap 与 scope 根表 | `engine/code_learning/state.py` | 硬边界 |
| M-04-02 | Workspace 登记与 revision CAS | `workspace.py`、`state.py` | 硬边界 + 可调（何时登记） |
| M-04-03 | 变体与 BuildIdentity 身份 | `workspace.py`、`build.py` | 硬边界 |
| M-04-04 | compdb/config 只读预检 | `build.py` | 硬边界 |
| M-04-05 | 签名 path_ref/evidence_ref 与安全路径 | `scope.py`、`state.py` | 硬边界 |
| M-04-06 | 有界源码 find（预算/游标/脱敏） | `source.py` | 预算可调，边界硬 |
| M-04-07 | 有界源码 read/evidence（hash/UTF-8/ref_only） | `source.py` | 硬边界 |
| M-04-08 | Atlas 0.1 快照导入与复核 | `atlas.py`、`snapshot.py` | 硬边界 |
| M-04-09 | 快照 freshness 与只读隔离 | `snapshot.py`、`state.py` | 硬边界 |
| M-04-10 | 路径查询与 certainty 回连 | `paths.py` | 查询策略可调 |
| M-04-11 | 跨仓 Binding 评估与 abi_bridge | `bindings.py`、`paths.py` | 硬边界（不得升 exact） |
| M-04-12 | 关系查询模式与 capability 门禁 | `paths.py` | 硬边界（不得伪造） |
| M-04-13 | 学习记录存储/CAS/导出 | `records.py`、`learning.py` | 硬边界 |
| M-04-14 | 预测/观察/决策的 pending 规则 | `learning.py`、`records.py` | 硬边界 |
| M-04-15 | resume 失效重核与事件消费 | `invalidation.py` | 硬边界 |
| M-04-16 | 计划 / 执行阻断 | `service.py`、`cli.py` | 硬边界 |
| M-04-17 | 工具注册、固定 argv 桥、技能分发 | `index.js`、`lib/*.mjs` | 硬边界 + 可调预算 |
| M-04-18 | 学习编排 skill（阅读顺序/讲解/停止） | `skills/learn-code-workspace/` | skill 可调 |

---

## 1. 来源与复用方式

| 来源（固定基线） | 借鉴机制 | 采用方式 |
|---|---|---|
| SDK Code Atlas 0.8.0 / schema 0.1（`H:/VSCODE_READER`，只读） | envelope 形状、`graph_hash`=图 envelope 文件 SHA、`coverage.failed`/`pending_units` 原样语义、trace 的 BFS/nodes/callsites、call_targets 上的 certainty、CLI argv 形状（不调用） | **只读借鉴/格式兼容**：`atlas.py`/`snapshot.py`/`paths.py` 自行实现消费者；不 vendor Atlas 源码/运行时，不执行 Atlas。SHA 记录见 `source.lock.json`。 |
| CL-DESIGN-2 设计文档（`docs/software-design.md`） | DTO 字段、CLI 合同、pending 记录字段、resume 失效顺序、跨仓 binding DTO | **直接实现设计**（模块级），偏差记录在 `docs/implementation-route.md` §偏离与本文 §8。 |
| 用户 `C:/Users/admin/.codex/行为守则.md` | 普通问答不强制考试、明确学完才复盘、先预测后验证、K2/K3 无 G/Q 可停、Next Action 最多一条 | **直接实现为 skill 文本与 `learning.py` 硬规则**。 |
| 本机 DSH Host API（0.2.1-rc.5 / Electron Node24） | `ctx.tools.register(ToolDefinition)`、`ctx.skills.registerProvider`、`ctx.effect`、bundle patch | **按实际接口自行实现**；签名经 `cordis_inspect_query` 核对。 |
| superpowers-dsh 0.4.0（本机已装） | 打包 skill provider 的目录扫描/frontmatter/rank 骨架 | **仅借鉴模式**，provider 与 skill 内容自写；未合入其代码。 |
| Serena/codegraph/clangd | 符号导航、图谱查询 | 仅调查对照，本版未集成。 |

判定“直接复用源码/薄适配/仅借鉴机制/自行实现”的原则：本仓库不复制上游代码；Atlas 只被消费格式；设计文档只作为合同来源。详见 `source.lock.json` 的 `redistributed: false`。

---

## 2. 分机制说明

### M-04-01 可信 bootstrap 与 scope 根表（硬边界）

- **场景**：Agent 想读“某个仓库”，但不能自行决定能读整块磁盘。
- **触发**：每次 CLI 调用前由 `--bootstrap`/`CODE_READER_BOOTSTRAP`/`$DSH_HOME/code-reader/bootstrap.json` 解析。
- **输入与前置**：`BootstrapConfigV1 {schema_version:1, profile_ref, scope_ref, scope_generation, state_dir, import_inbox_dir, output_root, candidate_roots[{root_ref,absolute_path,read_grant_ref}]}`；由人工 `bootstrap-init` 创建，已存在则拒绝覆盖（`STATE_CONFLICT`）。
- **判断规则**：绝对路径/字段白名单校验；`root_ref` 唯一；state/inbox/output 目录必须存在；模型参数中永远不出现绝对路径。
- **动作/状态**：`State` 持有 layout、HMAC secret（首次创建 0600）、workspace 锁、operation 幂等文件、snapshots 索引。
- **输出**：`state_root`、`inbox_dir`、`output_root`、candidate roots。
- **证据**：`engine/tests/test_workspace.py`（未知根/跨根/符号链接拒绝）、`test_cli_journey.py::test_bootstrap_init_command`；安装旅程中 bootstrap-init 实测 exit 0。
- **失败与恢复**：缺失 → `CONFIG_UNAVAILABLE`（exit 2）；非法/残留 → 人工修正 bootstrap，不自动重建。**代价**：需要一次人工配置；换来“模型无法扩权”的边界。

### M-04-02 Workspace 登记与 revision CAS（硬边界 + 可调触发）

- **场景**：把单仓/多仓登记为一个可验证的学习范围；首次登记与后续重登记都不能静默覆盖。
- **触发**：`workspace-import --manifest NAME --expected-revision N --operation-id UUID`（`code_workspace action=import`）。
- **输入**：inbox 内单层 manifest（`WorkspaceManifestV1`），引用 `root_ref + relative_path`。
- **判断规则**：schema 严格校验、`scope_ref` 匹配、根 realpath 一致性/不嵌套/不重复/拒绝 symlink-junction；`expected_revision` 必须等于当前 revision（首次=0）；operation_id 相同请求摘要幂等返回原结果，不同摘要 `OPERATION_CONFLICT`。
- **动作/状态**：`workspace_lock` 内原子写 `workspaces/<id>/registration.json`，revision+1；source manifest 摘要与 roots 摘要入登记。
- **输出**：`WorkspaceProjectionV1`（不含绝对路径），含每个 variant 的 `semantic_status`/`missing_inputs`/`build_identity`、bindings 摘要。
- **证据**：`test_workspace.py`（CAS 冲突、operation 冲突、manifest 漂移、junction 负担）、`test_cli_journey.py`。
- **失败与恢复**：`STATE_CONFLICT`→先 `status` 取当前 revision 重试；`SCOPE_DENIED`→修正根/清单，不扫描父目录。**可调**：何时登记/重登记由 skill 决定；**不可调**：CAS 与根校验。

### M-04-03 变体与 BuildIdentity 身份（硬边界）

- **场景**：不同 CONFIG/架构/工具链/生成头不能共用“编译事实”。
- **输入与判断**：`variant.analysis_mode ∈ source_only|semantic`；semantic 必须有 compdb/config/generated headers/toolchain，否则 `semantic_status=blocked` + `missing_inputs`；source_only 允许 null/空。
- **动作/输出**：`BuildIdentity {workspace_revision, variant_id, roots_digest, source_manifest_digest, compdb_digests, config_digests, generated_header_digests, toolchain_digest, atlas_lock_digest, sysroot_manifest_digest, binding_digest}`。
- **判断规则**：`source_manifest_digest` = 登记 repo 内普通文件排序后的 `repo_id/relpath\0size\0mtime_ns\n` 流 SHA256（保守变化探测，不冒充内容 hash；>limit 明确 `LIMIT_EXCEEDED` 不静默截断）；引用文件 digest 用内容 SHA256（≤16 MiB）。
- **证据**：`test_workspace.py::test_build_identity_digests_change_with_config_compdb_and_source`、`test_public_projection_and_build_identity_from_synthetic_workspace`、`test_semantic_variant_*`。
- **失败与恢复**：build 输入缺失 → blocked 但仍可 source-only 阅读；变体身份变化 → 旧记录/快照 stale（M-04-15）。**代价**：mtime 摘要可能误报变化（保守方向），不误报 fresh。

### M-04-04 compdb/config 只读预检（硬边界）

- **场景**：恶意/错误的编译数据库可能诱导执行任意 wrapper、越根读头文件、插件加载或 shell。
- **触发**：`workspace-import`/`workspace-validate` 的 semantic 变体预检（不执行 probe）。
- **判断规则**：拒绝 shell 链/重定向/环境赋值包装、非绝对 compiler、未登记 wrapper、`-Xclang -load`/plugin/VFS/动态 module、`-include/-imacros/-I/-isystem/--sysroot` 越出登记根；response 文件递归 ≤8 层/≤1 MiB、防环/防越根；源文件必须属于登记 repo；错误使 variant `blocked` 并给 diagnostics，不删除参数后假装构建相同。
- **动作/输出**：`{semantic_status, missing_inputs, diagnostics, compdb_digests, config_digests, generated_header_digests, toolchain_digest}`。
- **证据**：`test_workspace.py::test_semantic_variant_blocked_for_untrusted_compdb`、`test_semantic_variant_ready_with_fixture_build_context`。
- **失败与恢复**：blocked 时只开放源码阅读；**未验证**：真实执行隔离（M-04-16 的 run 仍阻断）。

### M-04-05 签名 path_ref/evidence_ref 与安全路径（硬边界）

- **场景**：模型只应引用“服务签发过的文件/区间”，不能自造路径或跨 workspace 复用。
- **规则**：`state.sign(payload)` = `v1.<b64url-json>.<HMAC-SHA256>`；path_ref 含 `{kind:'path', w,r,p,s,g}`；evidence_ref 含 `{kind:'source', w,r,p,s,b,e,ls,le,v,g,t}`。校验 MAC、scope_generation、workspace/repo 归属、文件 SHA256、byte 区间、变体；读取前 lstat/realpath 拒绝 symlink-junction 越界。
- **输出**：`SourceEvidence {evidence_ref, repo_id, variant_id, snapshot_id:null, source_ref, source_sha256, byte_start, byte_end, line_start, line_end, origin:'source_text', semantic_status:'blocked', limitations:['text_only_not_compiler_fact']}`。
- **证据**：`test_source.py`（篡改、跨 workspace、跨 repo、forged range）、`test_workspace.py`（junction）。
- **失败与恢复**：`SCOPE_DENIED`/`STALE_SOURCE`；重新 find/read 获取新引用。**代价**：引用不可跨 scope 复用；换来可审计来源。

### M-04-06 有界源码 find（预算可调、边界硬）

- **规则**：`literal` 与 `filename` 恰一个；literal 是字面文本（非正则）、长度 1..256；`relative_glob` 受限（`*`/`**`/`?`）；跳过 `.git/node_modules/__pycache__` 与链接；预算默认 128 文件/32 MiB/200 命中；`next_cursor` 是签名令牌（query digest + workspace_revision + 文件清单摘要 + offset），任何相关文件变化 → `STALE_SOURCE`。
- **输出**：`matches[{path_ref,evidence_ref,source_sha256,byte_start,byte_end,line_start,line_end,safe_preview}]`、`next_cursor`、`scanned_files/bytes`、`truncated`、`semantic_status:'blocked'`、`limitations`。
- **脱敏**：疑似秘密行（password/token/secret/api_key/private_key 等赋值）与二进制文件返回 `ref_only` 原因，不进入上下文；preview 限长。
- **证据**：`test_source.py`（预算滚动、游标失效、bin/secret、glob 语义）。
- **失败与恢复**：预算用尽带 `next_cursor` 继续；源码变化重查。**可调**：skill 可选择更小 glob/更窄路径；**不可调**：单次预算上限、脱敏、不跟链接。

### M-04-07 有界源码 read/evidence（硬边界）

- **规则**：仅接受签名 `path_ref`+`expected_sha256`+区间；区间 0≤start<end、单次 ≤16 KiB；先核 hash 再核区间（文件被改短 → `STALE_SOURCE`，hash 相符但调用区间越界 → `INVALID_ARGUMENT`）；UTF-8 边界安全调整（向外扩到字符边界）；二进制/疑似秘密 → `ref_only`。
- **输出**：`evidence` + `safe_text|ref_only` + 实际区间；`origin='source_text'`、`semantic_status='blocked'`。
- **证据**：`test_source.py::test_read_source_*`、`test_read_evidence_roundtrip_limits_and_staleness`、`test_suspected_secret_returns_ref_only`。
- **恢复**：`STALE_SOURCE` → 重新 find/read；**限制**：文本证据永不升级为编译器事实，行号仅导航。

### M-04-08 Atlas 0.1 快照导入与复核（硬边界）

- **场景**：复用 Atlas 的编译事实，但不能信任任意传入的快照目录。
- **触发**：`snapshot-import --workspace --variant --repo --snapshot NAME --operation-id`（`code_snapshot action=import`）。
- **规则**：NAME 只能是 inbox 内单层目录；读 `graph.json`/`analysis_manifest.json` 两个 envelope；校验 `schema_version='0.1'`、`record_kind∈{graph,analysis_manifest}`、payload 必填字段、`payload.graph_hash == sha256(graph.json 原始字节)`；严格图引用校验（call_targets 的 callsite/source/target/evidence id 必须存在）；同 snapshot_id 不同内容 → `STATE_CONFLICT`；operation_id 幂等。
- **动作/状态**：原子复制到 `state/snapshots/<id>/`，写 `import.json`（workspace/variant/repo/两 hash/build_identity/imported_at）与 `current.json` 只读 view；更新 snapshot index（key=workspace+variant+repo）。
- **输出**：`SnapshotEvidence`（coverage 原样保留，`failed` 数组/`pending_units` 路径数组不改成数字；另加 `failed_count`；`whole_program_complete` 不升级）。
- **证据**：`test_snapshot.py`（21+ 测试：hash/schema 篡改、整数 coverage 拒绝、missing copy 修复、current/inbox 漂移不影响已导入副本）、`test_snapshot.py::test_import_snapshot_for_real_registered_workspace`。
- **失败与恢复**：`UNSUPPORTED_SCHEMA`/`STALE_SNAPSHOT` → 重新导出/导入；损坏副本可用同 hash 重新导入修复；**不**去改 Atlas DB/current。

### M-04-09 快照 freshness 与只读隔离（硬边界）

- **规则**：每次 `load_snapshot`/`snapshot_evidence` 重新核两文件 hash 与 schema；freshness：导入后 workspace revision 或 `source_manifest_digest` 变化 → `stale`；文件缺失/不可读 → `unknown`；否则 `fresh`。查询只读 state 内副本，不读 Atlas `current` 指针，因此不会被另一次 run 漂移影响。
- **输出**：`SnapshotEvidence`、`freshness`、`capabilities`、`limitations`。
- **证据**：`test_snapshot.py::test_freshness_stale_after_workspace_revision_or_source_change`、`test_current_and_inbox_drift_do_not_change_loaded_snapshot`、`test_tampered_copy_is_rejected_on_load`。
- **恢复**：stale/unknown 时重新导入或重跑分析（本版不执行）；skill 必须先提示 freshness。

### M-04-10 路径查询与 certainty 回连（查询策略可调）

- **触发**：`path --workspace --variant --from REF --to REF [--budget --max-depth --direction]`（`code_path action=path`）。
- **规则**：REF=`repo:function` 或单快照裸 ref；先按 `id` 再按 `name/display_name` 解析，多义 → `AMBIGUOUS_SYMBOL`（给 choices，不批量跑）；同 repo 对 `graph.payload.call_targets` 做 BFS（down/up），预算默认 2000、深度 30；每条边从 `call_targets` 回连 `callsite` 取 origin/certainty/evidence_ids，**绝不把路径线条升级为 exact**；边界/递归/深度/预算停止进 `unresolved`；结果含 `common_prefix`、`choices`、`truncated`、`freshness`。
- **输出**：`PathResultV1`（nodes/edges/unresolved/choices/coverage/truncated/budget_used/freshness）。
- **证据**：`test_paths.py`（31 测试：certainty join、同名 static 不跨仓合并、歧义 choices、预算/深度截断、direction up、reference candidate 不伪造 call）、`test_cli_journey.py`。
- **代价/恢复**：只覆盖“已分析图”内的关系，`completeness` 不声称全程序；stale 快照仍可查但结果标 stale。

### M-04-11 跨仓 Binding 评估与 abi_bridge（硬边界）

- **场景**：UMD ioctl ↔ UAPI ↔ KMD dispatch 无编译 call 边，需要显式 ABI/接口事实。
- **规则**：`CrossRepoBindingV1` 严格校验（端点 repo/variant/interface_ref/evidence、variant 组合精确匹配、ABI/selector）；status **按证据重算**：缺一端证据/接口版本/共同定义/selector 值证据 → `incomplete`；同 binding_id 修订不连续、同 from+selector+variant 指向不同 to、端点 interface revision 不一致 → `conflicting`；身份/证据摘要变化 → `stale`；全部证据齐 → `supported`。`supported` 最多产生 `abi_bridge, certainty='may', origin='derived'` + `static_contract_not_runtime_call`，**不产生 call 边**。
- **输出**：路径结果中的 `edges[]` 或 `unresolved[]`；`binding_digest` 进入 BuildIdentity。
- **证据**：`test_bindings.py`（19 测试）、`test_paths.py::CrossRepoPathTests`、Host 旅程中 umd→kmd 得到 `abi_bridge may` 且无 call 边。
- **限制/恢复**：导入时 workspace.py 会重建 bindings 列表且未传旧评估结果，因此“stale”目前主要靠显式 `previous_bindings` 交接触发（模块已测）；真实跨进程调用、结构布局仍需目标 ABI 证据。skill 不得据此声称“实际调用”。

### M-04-12 关系查询模式与 capability 门禁（硬边界）

- **规则**：`mode ∈ flow_cfg|flow_legacy|locks|aliases`，selector 按模式互斥（如 flow_cfg 必须 function_ref + 恰一个 parameter/value，拒绝 symbol/object/lock）；`flow_legacy` 仅在存在 `flow_edges` 时投影，certainty=may 并保留原 limitations；`flow_cfg` 必须有真实 CFG capability+数据，否则 `status=unavailable`，**不自动降级为 legacy**；locks/aliases 无分析数据同样 `unavailable`+unknowns，空结果不证明“无竞争/无别名”；budget/max_items 截断显式。
- **证据**：`test_paths.py::RelationQueryTests`（模式互斥、capability 不可用不降级、truncation）；Host 旅程 `locks` 返回 `status=unavailable`。
- **代价**：首版多数关系查询在合成快照上不可用；本版不伪造。

### M-04-13 学习记录存储/CAS/导出（硬边界）

- **触发**：`record-save --input NAME --expected-generation N --operation-id UUID`、`record-get`、`export`（`code_learn`）。
- **规则**：Draft 严格 schema（`schema_version=1`，未知字段拒绝，不接受 `generation`）；SQLite `PRAGMA user_version=1`+WAL，表 `workspaces/records/revisions/operations/runs/event_inbox/consumer_cursors`；正文写 `state/records/<rid>/<gen>.json`（临时+fsync+rename），事务更新 revision/record/operation；CAS：current generation ≠ expected → `STATE_CONFLICT`；operation_id：同请求摘要返回原结果，不同摘要 `OPERATION_CONFLICT`；导出 markdown 标明 pending/stale 字段与证据、json 为 revision 精确副本+sha256；只允许本 workspace；`uploaded=false`。
- **证据**：`test_records.py`（32 测试：CAS、幂等、body 篡改、archived 增长拒绝、导出 pending 标记、scope）。
- **失败与恢复**：冲突先 get/resume；归档记录不销毁证据；**限制**：resume 只读不自动写新 revision（调用方保存新 generation）。

### M-04-14 预测/观察/决策的 pending 规则（硬边界）

- **规则**（`learning.py` 校验，`records.py` 强制）：
  - 无用户文本/时间 → `prediction.status='pending'`；`user_provided` 必须带 `text+provided_at`。
  - `mental_model.author='agent'` 的 `agent_explanation` 不能写成用户已复述（`user_provided` 需 author=user）。
  - `observation.status='observed'` 必须非空 `evidence_refs` 且 `experiment.status='executed'`（有 run_ref）。
  - `decision='DONE-APPLIED'` 需 observed+executed+记录证据；`supported` 规则需证据。
  - `next_action` 至多一条，且 `text/estimated_minutes(1..240)/completion_criterion` 完整。
- **证据**：`test_records.py::DraftValidationTests`、`test_skill_contract.py` 条款；Host 旅程保存的记录 prediction/observation 保持 pending。
- **意义**：Agent 不能代替用户声称“已理解/已验证”，也不能把索引成功当学习完成。

### M-04-15 resume 失效重核与事件消费（硬边界）

- **触发**：`resume --record RID`（`code_learn action=resume`）；可选 `consume-event --event-file NAME`。
- **顺序**：workspace revision → 记录 BuildIdentity 与当前登记身份逐项摘要 → 重新计算 `source_manifest_digest` → config/compdb/generated 文件内容 sha256 → 每条 evidence_ref 的 MAC/文件存在/内容 SHA256/byte 区间/变体。
- **判断**：任一变化 → `stale` + `changed_inputs/required_rechecks`；文件丢失/不可读 → `unknown`；workspace revision 变但摘要全同 → `unknown`（`workspace_revision_changed`，保守不宣称 fresh）；否则 `fresh`。返回 `safe_cursor`（“先复核这条证据”，禁止直接用旧行号/旧结论）。
- **事件**：`CapabilityEventV1` 只接受 3 种 kind；按 event_id 幂等；旧/乱序 generation 只审计不置 fresh；`partial/unknown`/不可定位 → 相关记录 `unknown`；cursor 缺口 → `gap_detected=true, requires_local_recheck=true`；事件丢失仍靠本地 hash 重核。
- **证据**：`test_invalidation.py`（25 测试）、Host 旅程改源码后 resume 返回 `stale` + `changed_inputs`。

### M-04-16 计划 / 执行阻断（硬边界）

- **规则**：`plan` 只做数据/摘要与固定 Atlas 0.8 argv 形状（引用字符串，不 embedding 绝对 host 路径，不执行）；`plan_id` 是签名令牌（TTL 600s）；`run` 校验签名/过期后**始终**返回 `EXECUTION_BLOCKED`（exit 2），因为未提供强制隔离 execution profile。没有裸跑 compiler probe/Atlas/CMake 的路径。
- **证据**：`test_cli_journey.py::test_plan_is_reference_only_and_run_is_blocked`。
- **恢复**：真实执行需未来固定 Linux 隔离 runner + 固定 Atlas runtime + 授权（未实现）。

### M-04-17 工具注册、固定 argv 桥、技能分发（硬边界 + 预算可调）

- **触发**：插件 bundle `apply(ctx, config)` 激活时注册 6 个工具与 skill provider。
- **规则**：
  - `inject=['tools','skills']`；`ctx.effect` 注册/清理；`ctx.tools.register` 6 个 `code_*`；`ctx.skills.registerProvider` 扫描 `skills/*/SKILL.md`（frontmatter/rank=550/source=custom）。
  - 每次工具调用 → `lib/bridge.mjs` 解析 Python（配置 `pythonPath`/`DSH_CODE_READER_PYTHON`/`python3`/`python`，探测 `--version`）→ `spawn(python, ['-m','code_learning.cli','--bootstrap',bootstrapPath,...固定 argv])`，`cwd=engine/`，**无 shell**；环境变量白名单，剥离 API key 等凭据；stdout 必须是一个 JSON（>8 MiB 截断保护），域内错误以 `{schema_version,ok,exit_code,cli}` 返回，spawn/超时/取消抛 `BridgeError`（超时=`OUTCOME_UNKNOWN/4`）。
  - 工具层内 `code_*` 参数只填 typed slots，不能提供可执行文件、cwd、根表、bootstrap；插件内串行化 CLI 调用避免同一 sqlite writer 竞争。
- **可调**：`bootstrapPath`、`pythonPath`、`timeoutMs(1000..600000)`、以及 skill 选择更小查询预算；**不可调**：argv 形状、环境白名单、JSON/退出码合同、写作用域。
- **证据**：`tests/node/bridge.test.mjs`（11 含 argv/凭据剥离/错误映射）、`tests/node/plugin.test.mjs`（6 工具+provider+display 元数据）、安装后 Host 工具真实调用旅程（`evidence/plugin-install-verification.json`）。

### M-04-18 学习编排 skill（skill 可调）

- **规则**：workspace 优先 9 步（登记/校验→概览→选一个问题→一条证据路径→解释→先预测→最小授权核验→规则/未知→记录/停止）；普通问答直接答、不强制记录/测验；仅用户明确“学完了/复盘”走完整 11 阶段，未完成字段保持 pending；Next Action ≤1（动作+分钟+完成标准）；K2/K3 无 G/Q 可停；证据分级 exact/may/unknown/source_text；不自动跑构建/测试、不自动写 05、不代填预测。
- **可调**：阅读顺序、每次讲多少、何时建记录、是否总结、预算内查询范围、停止时机。
- **不可调**：M-04-01/05/08/11/12/13/14/15/16 的硬边界（skill 不能绕过 scope、不能把文本当编译事实、不能把 pending 写成 user、不能执行 run）。
- **证据**：`test_skill_contract.py`（19 条款测试）。**仍需**独立对话评审学习质量（结构测试不等于效果证明）。

---

## 3. 硬边界 vs skill 可调（改 skill 不能越过的项）

| 边界 | 强制位置 | 为什么不能靠 skill/prompt |
|---|---|---|
| 读取根/路径 | `state.py`/`scope.py` | 模型无法传绝对路径；签名引用抵御伪造 |
| 快照可信 | `atlas.py`/`snapshot.py` | hash/schema/图引用硬校验；伪快照不能因“用户说可以”通过 |
| certainty 不升级 | `paths.py`/`bindings.py` | text/derived 最多 may；exact 只来自编译器证据 |
| pending 规则 | `learning.py`/`records.py` | Agent 不能替用户声称预测/观察/理解 |
| 执行阻断 | `service.py` (`run`) | 无隔离 profile 时任何提示都不能裸跑 |
| 导出/记忆出口 | `records.py`/`cli.py` | 只写本地 state，不上传、不自动写 05 |
| 记录不可覆盖 | SQLite CAS + revision 文件 | 提示层无法伪装 revision |

## 4. 可调参数（默认值/范围/影响）

| 参数 | 默认 | 范围 | 影响 |
|---|---|---|---|
| find 扫描文件 | 128 | 固定单次预算 | 超限返回 `next_cursor`，不静默 |
| find 扫描字节 | 32 MiB | 固定单次预算 | 同上 |
| find 命中 | 200 | 固定单次预算 | 同上 |
| source read 区间 | — | ≤16 KiB/次 | 超限 `INVALID_ARGUMENT` |
| path budget | 2000 | 1..10000 | 超限 `truncated` |
| path depth | 30 | 1..100 | 超限 `truncated` |
| relation budget | 2000 | 1..10000 | 超限 truncated |
| relation max_items | 200 | 1..2000 | 截断披露 |
| record generation | — | CAS 精确匹配 | 冲突 `STATE_CONFLICT` |
| plugin timeoutMs | 120000 | 1000..600000 | 超时 `OUTCOME_UNKNOWN/4` |
| bootstrap scope_generation | 1 | ≥1 | 变化使旧签名引用 `SCOPE_DENIED` |

## 5. 规则间依赖

1. `scope_generation`（M-04-01）→ 所有签名引用（M-04-05/06/07）有效性。
2. `source_manifest_digest`（M-04-03）→ 快照 freshness（M-04-09）与 resume（M-04-15）。
3. `BuildIdentity`（M-04-03/04）→ 记录保存时的身份与 resume 的重核项。
4. `binding status`（M-04-11）→ 跨仓路径能否产出 `abi_bridge`（M-04-10）。
5. `coverage.capabilities`（M-04-08）→ 关系查询可用性（M-04-12）。
6. 记录 generation/CAS（M-04-13）→ 事件失效与 resume 的“不覆盖旧修订”（M-04-14/15）。
7. `run` 阻断（M-04-16）→ 本版不存在“实验已执行”的真实来源，因此 observation 只能是 pending（M-04-14）。

## 6. 最小验证清单（改 skill/机制后至少重跑）

```bash
cd engine && python -m unittest discover -s tests -v          # 200 tests
cd .. && node --test tests/node/bridge.test.mjs tests/node/plugin.test.mjs  # 11 tests
```

对应关系：CL-001（M-04-01/02/03/05/06/07）、CL-003（M-04-08/09）、CL-004（M-04-10/11/12）、CL-005（M-04-13/14）、CL-006（M-04-15）、CL-009（M-04-16/17 端到端）、CL-007（M-04-18 文档条款）。真实 Linux/Kbuild 门禁见 `docs/implementation-route.md`。

## 7. 失败与恢复总表

| 失败 | 输出 | 恢复 |
|---|---|---|
| bootstrap 缺失/非法 | `CONFIG_UNAVAILABLE`/`INVALID_ARGUMENT` | 人工 bootstrap-init / 修文件 |
| Python 不可用 | `DEPENDENCY_UNAVAILABLE`（工具值） | 配置 `pythonPath` |
| 越根/篡改引用 | `SCOPE_DENIED` | 重新 find/read |
| 源码变化 | `STALE_SOURCE` | 重新查询/复核 |
| 快照坏/不支持 | `STALE_SNAPSHOT`/`UNSUPPORTED_SCHEMA` | 重新导入 |
| revision/generation 冲突 | `STATE_CONFLICT` | 取当前状态重试 |
| operation 摘要不同 | `OPERATION_CONFLICT` | 新 operation_id |
| 能力缺失（CFG/locks/aliases） | `status=unavailable`（exit 0） | 保持 unknown，不补造 |
| 超时/取消 | `OUTCOME_UNKNOWN`(4) | 不重试成“成功”；核对后新 operation |
| 无隔离执行 profile | `EXECUTION_BLOCKED`(2) | 仅读已有证据 |

## 8. 已知偏差、限制与待验证假设

**已记录偏差**（相对 CL-DESIGN-2，详见 `docs/implementation-route.md`）：
1. DSH 可安装 Host 插件提前落地（设计原为后置可选）；Python 引擎保持设计模块划分，插件是薄桥。
2. 使用系统 Python 3.11，不 vendor 固定 runtime/Atlas 包。
3. `run` 恒阻断；`plan` 为引用字符串计划，无 plan 持久化。
4. 关系查询在快照无分析数据时 `unavailable`；不执行 Atlas 数据流/锁/别名分析。
5. `overview` 增加 `missing_inputs`；BOM 容忍的 JSON 读取。
6. `bindings` 导入时重建列表，未传旧评估结果 → `stale` 主要靠显式 `previous_bindings` 交接（模块已测，集成待后续）。
7. `find` 无 variant 参数（固定签名），SourceEvidence 的 variant 取确定性首 variant。

**待验证改进假设**（需要真实环境，不得当已实现）：
- 真实 Linux Kbuild + 固定 Atlas 0.8 runtime 上 graph/manifest 字段与 fixtures 一致；失败 TU 诊断可保留并解释。
- bwrap/OCI 强制隔离能挡住 compiler probe 越根写/网络；负例通过前 `run` 保持阻断。
- native CFG（Clang18 extractor）可用时 flow_cfg 结果正确；缺失时 capability=false 分支保持。
- 大仓库下 find/overview 的性能与预算；当前“候选枚举不计入读取预算”可能成为热点（ws-agent 风险报告）。
- 事件来源 03 的真实 event_id/generation 语义；本版仅 fixture/fixture 兼容。
- 独立对话评审 skill 的实际学习行为（结构测试不能证明学习质量）。
- 结构布局/compat 只有真实目标 ABI 证据才可解释字节偏移。

## 9. 状态：actual / planned / blocked

| 项 | 状态 | 说明 |
|---|---|---|
| 合成 fixture 上 workspace/source/snapshot/path/binding/record/resume/CLI/Host 工具旅程 | **actual** | 200+11 测试、安装后 Host 工具旅程、`evidence/*` |
| Atlas 0.1 快照格式消费 | **actual（合成）** | 未用真实 Atlas 产物验证；只按已读 schema/代码实现 |
| plugin 安装/工具与 skill 注册 | **actual** | `application: applied`、6 工具可见、skill 进入目录 |
| 真实 Linux/Kbuild 索引与失败 TU 覆盖 | **blocked** | 需目标 Linux 工具链 + 固定 Atlas runtime |
| 强制隔离执行/compiler probe 负例 | **blocked** | 未提供 execution profile；`run` 恒阻断 |
| native CFG / 数据流 / 锁 / 别名分析 | **blocked** | 合成快照不含这些数据；返回 `unavailable` |
| 真实驱动运行时/硬件/线程重叠/字节布局 | **blocked** | 静态证据不证明；设计边界 |
| 05 长期记忆联动、上传/云 | **not implemented（有意）** | 只本地导出 |

**结论**：本版可作为“合成 fixture 上可安装、可自测、边界清晰”的首版交付；不得据此声称已读懂用户真实驱动或通过 Linux/Kbuild/隔离/native CFG 门禁。
