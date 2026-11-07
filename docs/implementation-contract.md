# 04 首版实施契约（dsh-code-reader）

版本 `CL-IMPL-1`，2026-11-07。所有实现者以本文件为跨模块接口权威；设计背景见 [software-design.md](software-design.md)，路线见 [implementation-route.md](implementation-route.md)。**本文件只描述本轮真实实现的契约，不冒充设计全文。**

## 1. 仓库布局与写入范围

```text
04-code-learning/                    # git 仓库根（dsh-code-reader）
  package.json cordis.patch.yml index.js icon.svg locale/   # DSH Host bundle（Lead）
  lib/                                # Node 桥：bridge/tools/skills（Lead）
  skills/learn-code-workspace/        # skill 文件（skill-agent）
  engine/
    code_learning/                    # Python 引擎（按模块分派）
      __init__.py errors.py util.py validation.py state.py                     # Lead
      service.py cli.py                                                         # cli-agent
      workspace.py scope.py source.py build.py                                 # ws-agent
      snapshot.py atlas.py paths.py bindings.py                                # snap-agent
      records.py invalidation.py learning.py                                   # rec-agent
    schemas/                          # 自有 JSON Schema（Lead）
    tests/                            # unittest（各 owner 只写自己的文件）
      helpers.py __init__.py          # Lead
      test_workspace.py test_source.py                                          # ws-agent
      test_snapshot.py test_paths.py test_bindings.py                           # snap-agent
      test_records.py test_invalidation.py                                      # rec-agent
      test_skill_contract.py                                                    # skill-agent
      test_cli_journey.py                                                       # cli-agent
    tests/fixtures/trees/             # 共享合成源码树（Lead 在 helpers 生成）
    tests/fixtures/                   # winner 写在对应子目录
  docs/ USAGE.md source.lock.json THIRD_PARTY_NOTICES.md
  tests/node/                         # Node 桥/插件契约测试（Lead）
  evidence/                           # 命令与结果证据（Lead）
```

写作用域是建议而非锁：除自己列出的文件/目录外不得修改；发现别人接口不足时先按本契约实现并用 `send_message` 报告 Lead，不跨范围改文件。所有 JSON/I/O 一律 UTF-8、LF 可选；时间 UTC RFC3339；hash 小写 SHA256。

运行位置：**cwd = `engine/`** 执行 `python -m code_learning.cli ...` 与 `python -m unittest discover -s tests -p test_xxx.py -v`。插件从包根定位 `engine/`，以该 cwd 启动 Python。

## 2. 通用约定

- `schema_version` 自有对象一律 `1`；Atlas 对象一律保持 `'0.1'`，两者不混写。
- 本模块自有 ID 形态：`ws_`/`sc_`/`se_` 等为服务签发；`record_id`/`workspace_id`/`repo_id`/`variant_id` 由 manifest 声明，只允许 `[a-z0-9][a-z0-9._-]{0,63}`。
- 错误：`raise CodeLearningError(code, message, retryable=False, details=None)`（`code_learning.errors`）。CLI 输出公共失败对象并映射退出码；有效工具结果（即使含 unknown/unavailable）exit 0。
- 严格输入校验：未知字段拒绝（`INVALID_ARGUMENT`）；字符串长度受限；路径不得绝对/含 `..`（除 manifest 明确字段）；不跟随 symlink、不越出登记根。
- 预算默认：find 128 文件/32 MiB/200 命中；source-read ≤16 KiB；path budget 默认 2000（上限 10000）、depth 默认 30（1..100）；relation budget 默认 2000、max_items 默认 200（上限 2000）。超限返回 `truncated` 并说明，不静默截断。
- 证据优先级：`exact` 只来自编译器证据（Atlas call_targets）；人工/Agent 桥接最多 `may`；文本证据 `origin='source_text'`、`semantic_status='blocked'`，绝不升级为编译器事实。

## 3. 状态目录（Lead 的 `state.py` 实现，其他人只消费）

`State` 由 `--bootstrap <path>` / `CODE_READER_BOOTSTRAP` / `$DSH_HOME/code-reader/bootstrap.json` 解析。BootstrapConfigV1：

```json
{"schema_version":1,"profile_ref":"desktop","scope_ref":"local","scope_generation":1,
 "state_dir":"<abs>","import_inbox_dir":"<abs>","output_root":"<abs>",
 "candidate_roots":[{"root_ref":"synthetic-root","absolute_path":"<abs>","read_grant_ref":"grant-1"}]}
```

`State` 提供（签名固定）：

```python
state = load_state(bootstrap_path=None)          # -> State；bootstrap 非法 -> INVALID_ARGUMENT/DEPENDENCY_UNAVAILABLE
state.bootstrap          # dict（只读）
state.state_root         # Path
state.inbox_dir          # Path；inbox 内文件按 name 解析，拒绝越出
state.output_root        # Path
state.secret             # bytes（首次创建 state_root/secret.key）
state.sign(payload: dict) -> str                 # HMAC 令牌：'v1.<b64url-json>.<b64url-mac>'
state.verify(token: str, max_age_s: int | None = None) -> dict   # 篡改/过期 -> SCOPE_DENIED/STALE_SOURCE
state.resolve_root(root_ref) -> Path             # 未登记 -> SCOPE_DENIED
state.require_in_root(path, root_ref=None) -> Path  # realpath 后必须位于登记根内，且路径本身非 symlink
state.workspace_dir(wid) -> Path
state.read_registration(wid) -> dict | None      # 内部 registration（含 absolute_path，不对模型暴露）
state.write_registration(wid, registration: dict) -> None  # 原子写
state.list_workspaces() -> list[str]
state.workspace_lock(wid) -> ContextManager      # 写锁（文件锁，超时 -> STATE_CONFLICT）
state.operation_get(operation_id) -> dict | None
state.operation_put(operation_id, request_digest, result) -> None
state.inbox_json(name) -> (Path, dict)           # 只接受 inbox 内单层文件名；超量/非法 -> INVALID_ARGUMENT
state.snapshot_dir(sid) -> Path
state.snapshots_index() -> dict                  # {"schema_version":1,"entries":[...]}
state.write_snapshots_index(index) -> None
state.learning_db_path() -> Path                 # state_root/learning.sqlite3
state.exports_dir() -> Path
```

内部 registration（只由 workspace.py 写）：

```text
{"schema_version":1,
 "workspace":{"workspace_id","revision","scope_ref","scope_generation","created_at","updated_at",
   "manifest_name","manifest_sha256","source_manifest_digest","roots_digest",
   "repositories":[{"repo_id","root_ref","relative_path","absolute_path","role","vcs":{...}}],
   "variants":[{"variant_id","analysis_mode","architecture","target_triple","config_refs","compdb_refs",
                "generated_header_sets","toolchain_ref","sysroot_ref","include_root_refs",
                "link_evidence_refs","uapi_revision_refs","execution_profile_ref",
                "semantic_status","missing_inputs","diagnostics","build_identity"}],
   "bindings":[<已在 import 时评估的 CrossRepoBindingV1 + status>],
   "toolchains":[...manifest 原样...]}}
```

`state.write_registration` 只在 `workspace_lock` 内调用；revision CAS 由 workspace.py 负责。

## 4. WorkspaceManifestV1 与公共投影

manifest 文件（inbox 内 JSON）：

```json
{"schema_version":1,"workspace_id":"synthetic-linux-ioctl","scope_ref":"local",
 "repositories":[{"repo_id":"umd","root_ref":"synthetic-root","relative_path":"umd","role":"umd","vcs":{"kind":"none","commit":null}},
                 {"repo_id":"uapi","root_ref":"synthetic-root","relative_path":"uapi","role":"uapi"},
                 {"repo_id":"kmd","root_ref":"synthetic-root","relative_path":"kmd","role":"kmd"}],
 "variants":[{"variant_id":"source_only-x86_64","analysis_mode":"source_only","architecture":"x86_64",
   "target_triple":null,"config_refs":[],"compdb_refs":[],"generated_header_sets":[],
   "toolchain_ref":null,"sysroot_ref":null,"include_root_refs":[],"link_evidence_refs":[],
   "uapi_revision_refs":[],"execution_profile_ref":null}],
 "allowed_read_roots":["synthetic-root"],
 "output_root_ref":"synthetic-root",
 "cross_repo_bindings":[]}
```

规则：
- `repositories`：`root_ref` 必须在 `bootstrap.candidate_roots` 中；实际根 = `candidate.absolute_path / relative_path`，realpath 必须存在、是目录、realpath==输入（根自身非 symlink/junction），且互不嵌套/重复；`role ∈ umd|uapi|kmd|library|other`。
- `variants`：`analysis_mode ∈ source_only|semantic`。`semantic` 时必须给出 compdb/config/生成头/工具链等真实输入，缺失 → `semantic_status='blocked'` + `missing_inputs`，不自动用宿主编译器。`source_only` 允许为 null/空，`semantic_status='blocked'` 且 `missing_inputs=['compiler_build_context']`。
- 引用字段统一 `"<repo_id>:<relpath>"`（relpath 为该 repo 根内 POSIX 相对路径，非空、无 `..`、非绝对）；`toolchain_ref` 指向 manifest 顶层 `toolchains[]` 项的 `toolchain_ref`（编译器等绝对路径只允许出现在这里，且必须非 shell 元字符）。
- `cross_repo_bindings` 元素按设计 `CrossRepoBindingV1`（schema 见 `engine/schemas/cross-repo-binding.schema.json`），import 时由 bindings.py 评估 status 并写回 registration。
- `allowed_read_roots`、`output_root_ref` 是 `root_ref`；输出仍写 state 的 exports 目录，`output_root` 只作边界声明。

`workspace-import` 返回公共投影 `WorkspaceProjectionV1`：

```text
{"schema_version":1,"workspace_id","workspace_revision","scope_ref","scope_generation",
 "manifest_digest","repositories":[{"repo_id","root_ref","role","vcs"}],
 "variants":[{"variant_id","analysis_mode","architecture","target_triple","semantic_status",
              "missing_inputs","build_identity":{...摘要...}}],
 "bindings":[{"binding_id","revision","kind","from_repo_id","to_repo_id","status"}],
 "semantic_status_by_variant":{variant_id: status},
 "missing_inputs":[...], "freshness":"fresh"}
```

模块接口（固定签名，返回上述/下节 JSON dict，内部异常用 CodeLearningError）：

```python
# workspace.py
validate_workspace(state, manifest_ref: str | None = None, workspace_ref: str | None = None) -> dict
import_workspace(state, manifest_name: str, expected_revision: int, operation_id: str) -> dict
load_workspace(state, workspace_ref: str) -> dict            # 内部 registration["workspace"]
workspace_status(state, workspace_ref: str) -> dict
build_identity(workspace: dict, variant_id: str) -> dict     # 见 §5
source_manifest_digest(root: Path, limit: int = 20000) -> str
public_projection(workspace: dict) -> dict
overview(state, workspace_ref: str, variant_id: str, snapshot_ref: str | None = None, max_components: int = 20) -> dict
```

`load_workspace` 未登记 → `NOT_FOUND`；`validate_workspace` 同时返回 `valid/diagnostics/freshness`。

## 5. BuildIdentity（写入 registration 与记录）

```text
{"workspace_revision","variant_id","roots_digest","source_manifest_digest",
 "compdb_digests":{ref:digest|null},"config_digests":{...},"generated_header_digests":{...},
 "toolchain_digest":digest|null,"atlas_lock_digest":null,"sysroot_manifest_digest":null,
 "binding_digest":digest}
```

`source_manifest_digest` = 对登记 repo 根内普通文件（跳过 `.git/node_modules/__pycache__`）排序后的 `relpath\0size\0mtime_ns\n` 流 SHA256；只作为保守变化探测，不冒充内容 hash。引用文件 digest 用文件内容 SHA256（≤16 MiB；超过用 size+mtime 摘要）。`roots_digest` 对 `repo_id+realpath` 排序摘要。

## 6. 源码只读入口（ws-agent）

```python
find_source(state, workspace_ref, repo_id, relative_glob, literal=None, filename=None,
            cursor=None) -> dict
read_source(state, workspace_ref, path_ref, expected_sha256, byte_start, byte_end) -> dict
read_evidence(state, workspace_ref, evidence_ref, max_bytes=16384) -> dict
```

- `find_source` 返回 `{schema_version:1, matches:[{path_ref, evidence_ref, source_sha256, byte_start, byte_end, line_start, line_end, safe_preview}], next_cursor, scanned_files, scanned_bytes, truncated, semantic_status:'blocked', limitations:['text_only_not_compiler_fact']}`。`literal` 与 `filename` 恰一个（均无则 `INVALID_ARGUMENT`）；literal 长度 1..256、非正则；`relative_glob` 用受限 glob（`*`/`**`/`?`，无字符类越界）；命中上限 200、扫描上限 128 文件/32 MiB，游标=签名令牌（含 offset、workspace_revision、扫描清单摘要），源码变化后游标 STALE_SOURCE。二进制/疑似秘密命中返回 `ref_only` 原因而非正文。
- `read_source` 返回 `{schema_version:1, evidence:<SourceEvidence>, safe_text|ref_only, actual_byte_start, actual_byte_end, reason?}`；必须核 path_ref MAC、workspace/scope、repo 归属、文件 SHA256；UTF-8 边界安全调整；二进制/疑似秘密 → `ref_only`。
- `SourceEvidence` 字段：`evidence_ref, repo_id, variant_id, snapshot_id:null, source_ref, source_sha256, byte_start, byte_end, line_start, line_end, origin:'source_text', semantic_status:'blocked', limitations:['text_only_not_compiler_fact'], observed_at`。`path_ref` = `state.sign({"kind":"path","w":wid,"r":repo,"p":relpath,"s":sha,"g":scope_generation})`；`evidence_ref` kind=`source`，含 byte 区间与 variant。解码统一走 `state.verify`，然后独立复核文件 hash 与路径边界。
- `build.py`：`preflight_variant(state, workspace, variant_id) -> {semantic_status, missing_inputs, diagnostics, compdb_digests, config_digests, generated_header_digests, toolchain_digest}`。只读 compdb JSON 做 argv 预检：拒绝 shell 链/重定向/环境赋值、非绝对 compiler、未登记 wrapper、`-include/-imacros/sysroot` 越出登记根、`-Xclang -load`/plugin/VFS；response 文件递归 ≤8 层/≤1 MiB 且不越根；不执行 compiler probe、不调 CMake。`workspace.py` import/validate 时调用。

## 7. 快照、路径与跨仓桥接（snap-agent）

```python
import_snapshot(state, workspace_ref, variant_id, repo_id, snapshot_name, operation_id) -> dict
load_snapshot(state, workspace_ref, snapshot_ref) -> dict
snapshot_evidence(state, workspace_ref, snapshot_ref) -> dict
snapshot_for_repo(state, workspace_ref, variant_id, repo_id) -> str | None
query_path(state, workspace_ref, variant_id, from_ref, to_ref, budget=2000, max_depth=30, direction='down') -> dict
query_relation(state, workspace_ref, snapshot_ref, mode, **selectors) -> dict
evaluate_bindings(workspace, manifest_bindings) -> list[dict]     # bindings.py，workspace import 调用
```

- `snapshot_name` 是 `bootstrap.state_dir` 之外的只读导入目录？**不**：必须位于 inbox 下的单层目录名（`inbox_dir/<snapshot_name>/`），内含 `graph.json`、`analysis_manifest.json` 两个 Atlas envelope。`import_snapshot` 校验 envelope `schema_version=='0.1'`、`record_kind` 分别为 `graph`/`analysis_manifest`、`payload` 必填字段、`payload.graph_hash == sha256(graph.json 原始字节)`；把两文件复制到 `state.snapshot_dir(snapshot_id)` 并写 `import.json`（workspace/variant/repo/两 hash/build_identity_digest/imported_at）与 `current.json`（只读 view：`{"snapshot_id":...,"manifest_hash":...}`）；更新 `snapshots_index`。snapshot_id 取 manifest `payload.snapshot_id`；重复导入同 id 同 hash 幂等，不同 hash → `STATE_CONFLICT`。operation_id 幂等同 `state.operation_*`。
- `load_snapshot` 每次复核两文件 hash 与 schema；freshness：导入后 workspace revision / source_manifest_digest 变化 → `stale`；文件缺失/不读 → `unknown`；否则 `fresh`。`SnapshotEvidence` 按设计 §4.2 投影，coverage 原样保留（`failed` 数组/`pending_units` 路径数组），另给 `failed_count`。
- `query_path`：`from_ref`/`to_ref` 形如 `repo_id:function_ref`（也接受裸 function_ref，当 variant 下恰好一个 repo 快照）。优先按函数 `id` 精确匹配，其次 `name`/`display_name`；多义 → `AMBIGUOUS_SYMBOL`（details 含 choices）。同 repo：对 `graph.payload.call_targets` 做 BFS（direction down/up），预算/深度上限，返回 `PathResultV1`：`{schema_version:1,snapshot_refs,nodes,edges,unresolved,choices,coverage,truncated,budget_used,freshness}`。`nodes` = functions 投影；`edges` 每条来自一个 call_target，含 `callsite,origin,certainty,evidence_ids,unknown_target_possible`（可空），禁止把路径线条升级为 exact。`unresolved` 收录 issues（`semantic_unresolved`/`external_boundary`）与边界/递归/深度停止原因。跨 repo 两端：各自图内做 `down`/`up` 到接口候选，然后按 `evaluate_bindings` 的 `supported` binding 生成 `abi_bridge,certainty='may',origin='derived'` 连接；`incomplete/conflicting/stale` → unresolved（不给可用路径）；不得在图中制造 call 边。
- `query_relation`：`mode ∈ flow_cfg|flow_legacy|locks|aliases`；selector 互斥规则按设计 §5 表；`flow_legacy` 在 snapshot 有 `flow_edges` 时返回 `RelationResultV1`（certainty may、原 limitations、budget/max_items 截断）；`flow_cfg` 需 coverage.capabilities.cfg 为真实 CFG 能力且有 value/CFG 数据，否则 `status='unavailable'` + unknowns，绝不降级为 legacy；`locks/aliases` 无对应分析数据 → `unavailable` + unknowns，空结果不证明无竞争/无别名。所有模式拒绝非法 selector（`INVALID_ARGUMENT`）。
- `bindings.py`：严格校验两类端点（repo/variant/interface_ref/evidence/variant 组合/ABI/selector）；`status` 由证据重算：缺接口版本/共同定义/一端证据 → `incomplete`；同 binding_id 重复且 revision 不连续、或同 from+selector 指向不同 to → `conflicting`；身份/证据摘要变化 → `stale`；全部证据齐 → `supported`（仍最多 `may`）。`evaluate_bindings` 返回带 `bridge_candidate` 的列表；`binding_digest` = 规范摘要（build identity 用）。

## 8. 学习记录与失效（rec-agent）

```python
save_record(state, workspace_ref, draft: dict, expected_generation: int, operation_id: str) -> dict
get_record(state, workspace_ref, record_ref: str) -> dict
export_record(state, workspace_ref, record_ref: str, fmt: str = 'markdown') -> dict
resume_record(state, workspace_ref, record_ref: str) -> dict
consume_event(state, workspace_ref, event: dict) -> dict
validate_record_draft(draft: dict) -> dict        # learning.py；records.py 调用
default_record(workspace, goal: dict) -> dict     # learning.py
```

- 存储：`state.learning_db_path()` SQLite（`PRAGMA user_version=1`、WAL）；表按设计 §4.3：`workspaces`、`records`、`revisions`、`operations`、`event_inbox`、`consumer_cursors`（可再加 `runs` 空表）。正文写 `state.state_root/'records'/<record_id>/<generation>.json`（临时文件+fsync+rename），事务写 revisions/records/operations。CAS：current generation ≠ expected → `STATE_CONFLICT`；operation_id 幂等：相同 request_sha256 返回原结果，不同摘要 → `OPERATION_CONFLICT`。
- `LearningRecordV1` 字段按设计 §4.3（严格，未知拒绝）。硬规则：`prediction.status` 无用户输入只能是 `pending`；Agent 解释 `mental_model.author='agent'`，不得写成用户已复述；`observation.observed` 必须有非空 evidence_refs 且 `experiment.status='executed'`；`decision=DONE-APPLIED` 需实际证据；`next_action` 至多一条且含 `text/estimated_minutes/completion_criterion`；`freshness ∈ fresh|stale|unknown`；`archived` bool。`record_id` 缺省由服务生成（`rec_` + uuid hex）；`draft` 不接受 `generation`。
- `export`：markdown 标明 pending/stale 字段与证据；json 为当前 revision 原样 + sha256；只允许本 workspace 记录；不自动上传/同步。
- `resume`：重核 workspace revision→BuildIdentity 摘要→每条 evidence_ref（MAC、文件存在、SHA256、byte 区间）与 config/compdb/toolchain/生成头 digest；变化 → `stale` + `changed_inputs`；丢失/不可读 → `unknown`；workspace revision 变化但所有摘要相同 → `unknown`（`reason: workspace_revision_changed`，保守不宣称 fresh）；否则 `fresh`。返回 `{schema_version:1, record, freshness, changed_inputs, required_rechecks, safe_cursor}`；`safe_cursor` 指向“先复核这条证据”，不直接续接旧结论，旧行号不得当当前事实。
- `consume_event`：事件 v1 字段 `event_id,kind,source_capability,scope_ref,session_ref?,operation_id,generation,affected_refs,outcome,before_snapshot?,after_snapshot?,occurred_at`；kind 仅 `session_surface_rewound/workspace_files_restored/session_removed`；按 event_id 幂等；旧/乱序 generation 只留审计，不把记录置 fresh；`outcome ∈ partial|unknown` 或影响不可精确定位 → 相关 scope 记录 `unknown`/`stale`；source cursor 出现 generation 缺口 → `gap_detected=true` 且 `requires_local_recheck=true`。返回 `{schema_version:1,accepted,stale_record_refs,unknown_record_refs,next_cursor,requires_local_recheck,gap_detected}`。

## 9. service.py + cli.py（skill-agent 与 Lead 对接）

`service.py` 只做组合与参数校验，调用上面模块；`cli.py` argparse 解析后调用 service，stdout 输出一个 JSON 对象，诊断写 stderr；public 失败对象：

```json
{"schema_version":1,"error":{"code":"INVALID_ARGUMENT","message":"...","details_ref":null,"retryable":false},"operation_id":null}
```

退出码：0=有效工具结果（可含 unknown/unavailable/truncated）；2=输入/策略/能力阻断；3=执行失败；4=结果未知。命令与参数：

```text
bootstrap-init --out PATH --state-dir DIR --import-inbox DIR --root NAME=PATH [--profile-ref P] [--scope-ref S] [--scope-generation N]
workspace-import --manifest NAME --expected-revision N --operation-id UUID
workspace-validate [--workspace WID]
status --workspace WID
overview --workspace WID --variant VID [--snapshot SID] [--max-components N]
source-find --workspace WID --repo RID --relative-glob G (--literal TEXT | --filename TEXT) [--cursor REF]
source-read --workspace WID --path REF --expected-sha256 HASH --byte-start N --byte-end N
source --workspace WID --evidence REF [--max-bytes N]
snapshot-import --workspace WID --variant VID --repo RID --snapshot NAME --operation-id UUID
snapshot --workspace WID --snapshot SID
path --workspace WID --variant VID --from REF --to REF [--budget N] [--max-depth N] [--direction down|up]
relation --workspace WID --snapshot SID --mode MODE [--function F] [--parameter P] [--value V] [--symbol S] [--object O] [--lock L] [--direction D] [--budget N] [--max-items N]
plan --workspace WID --variant VID --goal-file NAME
run --plan PLAN_ID --operation-id UUID          # 本版恒 EXECUTION_BLOCKED
record-save --workspace WID --input NAME --expected-generation N --operation-id UUID
record-get --workspace WID --record RID
resume --workspace WID --record RID
export --workspace WID --record RID --format markdown|json
consume-event --workspace WID --event-file NAME
```

`plan` 返回 `RunPlan`（同设计字段；`argv` 由固定 Atlas 0.8 CLI 形状生成，`--repo/--root/--compdb/--out/--interface/--max-tu/--tu-timeout/--dataflow/--html`，不执行）；`run` 恒返回 `EXECUTION_BLOCKED`（无强制隔离 profile），不裸跑。

## 10. DSH Host plugin（Lead）

- `index.js` ESM：`export const name='dsh-code-reader'`、`export const inject=['tools']`（skills 用 `ctx.inject` 或 `inject:['tools','skills']`）、`export function apply(ctx,config)`；所有注册用 `ctx.effect` 或 `ctx.on` 并返回清理。
- 工具（6 个，名字前缀 `code_`）：`code_workspace`（action import|validate|status）、`code_overview`、`code_source`（find|read|evidence）、`code_snapshot`（import|status）、`code_path`（path|relation）、`code_learn`（save|get|resume|export）。工具 `execute` 固定 argv 数组 spawn Python（无 shell），解析 stdout JSON；域内失败返回 `{ok:false,error}` 值，spawn/解析失败 throw；`output.render` 返回 `[{type:'text',text:JSON.stringify(value,null,2)}]`。
- Config：`{bootstrapPath?: string, pythonPath?: string, timeoutMs?: number(默认 120000，限 1000..600000)}`；`bootstrapPath` 缺省依次 `CODE_READER_BOOTSTRAP`、`$DSH_HOME/code-reader/bootstrap.json`、`$HOME/.dsh/code-reader/bootstrap.json`；Python 缺省依次 `DSH_CODE_READER_PYTHON`、`python3`、`python`。
- Skill：`ctx.skills.registerProvider` 注册 `learn-code-workspace`（`skills/learn-code-workspace/SKILL.md`，frontmatter `name/description/whenToUse`，正文含定界→小地图→一条证据路径→解释→先预测再核验→规则/停止；普通问答直接答；K2/K3 可停；Next Action≤1；预测不得代填；不自动写 05 记忆、不自动跑目标测试/构建）。
- bundle：`package.json` 的 `dsh.bundle.patch='./cordis.patch.yml'`，patch insert 行 `id: dsh-code-reader`、`name: '@local/dsh-code-reader'`（包名与 id 固定）；`locale/en.json`、`locale/zh.json` 含 `meta.title/description`；`icon.svg` 原创作（≤256 KiB）；`files` 覆盖运行文件与 locale/icon/skills。
- 安装验证：`plugin_manager install_bundle` → `application: applied`；`cordis_inspect_query` host Tool.listTools / Service(skills) list 确认；再用合成 workspace 调一次工具。

## 11. 测试与验收 ID 映射

| 本版测试 | 覆盖设计验收 | 关键负例 |
|---|---|---|
| `test_workspace.py` | CL-001-A | 跨根/未知根/根重叠/symlink 根拒绝；无 compdb 仍可 source-only；revision CAS；CONFIG/dirty/新文件变化失效 |
| `test_source.py` | CL-001-A source-only | 越根 path_ref、hash 不符、区间/UTF-8、二进制/秘密 ref_only、游标失效 |
| `test_snapshot.py` | CL-003-A | envelope/schema/hash 篡改、graph_hash 不符、current 漂移无关（只读副本）、failed/pending 保留 |
| `test_paths.py` | CL-004-A | ops 取地址仅 reference 候选非 call；同名 static 不跨仓合并；may/unknown；预算截断；跨仓 binding 缺证不给可用路径 |
| `test_bindings.py` | CL-004-A binding | incomplete/conflicting/stale/supported 判定；variant 组合不匹配；重复 binding_id CAS |
| `test_records.py` | CL-005-A | 未预测 pending；无证据不能 observed；operation 冲突；导出范围 |
| `test_invalidation.py` | CL-006-A/F | CONFIG/源码变化 stale；乱序/缺口事件；partial/unknown；丢事件仍本地重核 |
| `test_skill_contract.py` | CL-007-A | skill frontmatter/行为条款；普通问答不强制记录；停止规则；预测/Next Action 条款 |
| `test_cli_journey.py` | CL-009-A | 登记→源码→快照→路径→pending 记录→暂停→改源码→resume stale |
| `tests/node/bridge.test.mjs` | 插件桥 | 工具→CLI argv 映射、JSON 解析、错误映射、Python 缺失降级 |
| `tests/node/plugin.test.mjs` | 插件注册 | apply 注册 6 工具+skill provider、Config 校验、cleanup |

命令：`engine/` 下 `python -m unittest discover -s tests -v`；仓库根 `node --test tests/node/*.test.mjs`；H 盘只读，不执行 Atlas/编译/联网。
