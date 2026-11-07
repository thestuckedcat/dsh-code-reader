# dsh-code-reader 使用说明

版本 0.1.0（`CL-IMPL-1`，2026-11-07）。本文件面向使用者与后续 skill 维护者：怎样安装、怎样登记 workspace、六个工具怎么用、返回的 JSON 怎么读、哪些边界不允许越过。

设计背景：[软件设计](docs/software-design.md)、[实施契约](docs/implementation-contract.md)、[机制说明](docs/mechanisms.md)。

## 1. 前置条件

| 依赖 | 要求 | 说明 |
|---|---|---|
| DSH Harness | 当前 desktop profile 同版本 Host API（`ctx.tools` / `ctx.skills`） | 通过 `plugin_manager install_bundle` 安装本地 bundle |
| Python | 3.11+（`python3` 或 `python` 在 PATH，或配置 `pythonPath`） | 本版不 vendor 固定解释器；引擎只用标准库 |
| 数据 | 一个本地 workspace 根目录 + 可选 Atlas 0.1 快照 | 合成 fixture 见 `engine/tests/helpers.py` |

## 2. 首次安装

### 2.1 创建可信 bootstrap（人工执行，只做一次）

模型/工具 **不能** 创建或改写 bootstrap；这是人工授权的读取根表。在仓库 `engine/` 目录执行：

```bash
python -m code_learning.cli bootstrap-init \
  --out  ~/.dsh/code-reader/bootstrap.json \
  --state-dir ~/.dsh/code-reader/state \
  --import-inbox ~/.dsh/code-reader/inbox \
  --root dev=/path/to/your/repositories \
  --profile-ref desktop --scope-ref local --scope-generation 1
```

- `--root NAME=PATH` 可重复；之后 workspace manifest 只能用这些 `root_ref` 下的相对路径。
- `state-dir` 保存 sign key、workspace 登记、快照只读副本、学习记录与导出；不写源码仓库。
- `import-inbox` 是人工/外部工具放入 `workspace.json`、`<snapshot>/` 目录的地方；Agent 工具只能按文件名读取它，不能指定任意路径。
- 已有 bootstrap 不会被覆盖（`STATE_CONFLICT`）；确需重建请人工删除后重跑。

### 2.2 安装 bundle

在 DSH 内由 `plugin_manager` 安装本仓库目录（本地目录以链接方式安装）：

```
plugin_manager action=install_bundle target=<绝对路径>/04-code-learning
```

安装后检查（无需浏览器）：

- `cordis_inspect_query` Host `Tool.listTools` 中出现 `code_workspace`、`code_overview`、`code_source`、`code_snapshot`、`code_path`、`code_learn`；
- Host `Service`（skills）目录中出现 `learn-code-workspace`（来源 `custom`，provider `dsh-code-reader`）。

插件配置项（`cordis.patch.yml` 行的 `config`，全部可选）：

```yaml
- id: dsh-code-reader
  name: '@local/dsh-code-reader'
  config:
    bootstrapPath: 'C:/Users/you/.dsh/code-reader/bootstrap.json'  # 默认 CODE_READER_BOOTSTRAP 或 $DSH_HOME/code-reader/bootstrap.json
    pythonPath: 'C:/Python311/python.exe'                          # 默认 DSH_CODE_READER_PYTHON / python3 / python
    timeoutMs: 120000                                              # 1000..600000
```

## 3. 工具总览

六个工具都返回同一种外层 JSON：

```json
{"schema_version": 1, "ok": true, "exit_code": 0, "cli": { /* 引擎结果或公共错误对象 */ }}
```

- `ok=false` 且 `exit_code=2`：输入/scope/能力边界阻断（例如未登记、证据过期、缺少构建能力）；`cli.error.code` 给出稳定错误码。
- `exit_code=3`：执行失败；`exit_code=4`：结果未知（超时/取消，不能当成功）。
- 工具调用本身抛错只发生在参数非法、Python 缺失或输出不可解析等宿主侧问题。

### 3.1 `code_workspace` — 登记/校验/状态

| 参数 | 说明 |
|---|---|
| `action` | `import` \| `validate` \| `status` |
| `workspace` | 已登记 workspace_id（status 必需；validate 可省，仅有一个登记时自动选中） |
| `manifest` | import 用：inbox 内 manifest 文件名 |
| `expected_revision` | import 用：0 表示首次登记；已登记则传当前 revision |
| `operation_id` | 幂等 ID；省略时插件自动生成 UUID |

```json
// action=import 的 cli 结果（节选）
{"schema_version":1,"workspace_id":"synthetic-linux-ioctl","workspace_revision":1,
 "scope_ref":"local","manifest_digest":"…","variants":[{"variant_id":"source-only-x86_64",
 "analysis_mode":"source_only","semantic_status":"blocked","missing_inputs":["compiler_build_context"]}],
 "semantic_status_by_variant":{"source-only-x86_64":"blocked"},"missing_inputs":[],"freshness":"fresh"}
```

`workspace-validate` 不执行 probe；`semantic_status=blocked` 只代表缺编译输入，仍可 source-only 阅读。

### 3.2 `code_overview` — 先看小地图

参数：`workspace`、`variant`（必填）、`snapshot`（可选）、`max_components`（1..100，默认 20）。

返回 `components[]`（`origin=declared`，只表示 manifest 声明）、`interface_candidates[]`（binding 端点等，`certainty=may`）、`unknown_boundaries[]`、`truncated`。文件夹名/README/人工角色不是编译依赖。

### 3.3 `code_source` — 源码证据

| action | 参数 | 说明 |
|---|---|---|
| `find` | `workspace`、`repo`、`relative_glob` + 恰好一个 `literal`/`filename`，可选 `cursor` | 字面文本或文件名查找；预算 128 文件/32 MiB/200 命中；`next_cursor` 可续页；源码变化后游标 `STALE_SOURCE` |
| `read` | `workspace`、`path_ref`、`expected_sha256`、`byte_start`、`byte_end` | 区间 ≤16 KiB；核 hash 与签名；UTF-8 边界安全调整；二进制/疑似秘密返回 `ref_only` |
| `evidence` | `workspace`、`evidence_ref`，可选 `max_bytes` | 重读之前签发的证据；文件变化/丢失报 `STALE_SOURCE`/`NOT_FOUND` |

find 返回示例（节选）：

```json
{"schema_version":1,
 "matches":[{"path_ref":"v1.…","evidence_ref":"v1.…","source_sha256":"…",
             "byte_start":0,"byte_end":142,"line_start":1,"line_end":10,
             "safe_preview":"int job_submit(int fd, …)"}],
 "next_cursor":null,"scanned_files":3,"scanned_bytes":2231,"truncated":false,
 "semantic_status":"blocked","limitations":["text_only_not_compiler_fact"]}
```

文本证据只证明“这段文本存在”；不产生 exact 调用/锁/布局事实，也不能证明运行时行为。

### 3.4 `code_snapshot` — Atlas 0.1 快照

| action | 参数 | 说明 |
|---|---|---|
| `import` | `workspace`、`variant`、`repo`、`snapshot`（inbox 内目录名）、`operation_id` | 校验 envelope schema、manifest 必填字段、`payload.graph_hash == sha256(graph.json 原始字节)`、`workspace_roots` 至少一个条目指回**本次导入的目标 repo**；复制只读副本到 state |
| `status` | `workspace`、`snapshot_ref` | 返回 SnapshotEvidence：coverage（failed 数组、pending_units 路径数组原样保留）、capabilities、freshness、limitations |

导入不会运行 Atlas/CMake/编译器；`freshness` 在 workspace revision 或源清单摘要变化后为 `stale`，文件缺失为 `unknown`。`workspace_roots` 必须包含本次导入的目标 repo（同 workspace 其它 repo 不算），否则拒绝导入（独立验证 N1 修复），避免把别的仓库快照的 exact 边记到本仓；多根 Atlas 快照可在每个根对应的 repo 下分别导入。

### 3.5 `code_path` — 证据路径与关系

**path**：`workspace`、`variant`、`from`、`to`（函数 ref，如 `kmd:job_dispatch`），可选 `budget`（1..10000，默认 2000）、`max_depth`（1..100，默认 30）、`direction=down|up`。

返回 `nodes[]`、`edges[]`（来自 `call_targets`，带 `callsite/origin/certainty/evidence_ids`）、`unresolved[]`、`choices[]`、`coverage`、`truncated`、`freshness`。同 repo 内为有界 BFS；跨 repo 端点只在 `supported` 的跨仓 binding 上产生 `abi_bridge, certainty=may`，`incomplete/conflicting/stale` 只给 unresolved。

**relation**：`workspace`、`snapshot_ref`、`mode ∈ flow_legacy|flow_cfg|locks|aliases`，selector 按模式互斥。缺少对应分析能力时返回 `status=unavailable` 与 `unknowns`；空结果不代表“无竞争/无别名”。

### 3.6 `code_learn` — 版本化学习记录

| action | 参数 | 说明 |
|---|---|---|
| `save` | `workspace`、`input`（inbox 内记录草稿文件名）、`expected_generation`（新记录 0）、`operation_id` | CAS 写入不可变 revision；相同 operation+请求幂等，不同摘要 `OPERATION_CONFLICT` |
| `get` | `workspace`、`record` | 当前 revision |
| `resume` | `workspace`、`record` | 重核 workspace/build/证据；返回 `freshness`、`changed_inputs[]`、`required_rechecks[]`、`safe_cursor` |
| `export` | `workspace`、`record`、`format=markdown|json` | 只导出到本地 state/exports，不上传 |

硬规则：没有用户输入时 `prediction.status=pending`；`observation.status=observed` 必须同时有非空证据与 `experiment.status=executed`；Agent 解释不得写成用户已复述；`next_action` 至多一条；`DONE-APPLIED` 需实际证据。

保存时的额外校验（2026-11-07 独立验证修复）：

- 本版没有 execution backend，`experiment.status=executed` 必须指向本地 `runs` 账本中的真实运行，当前不存在 → 直接 `CAPABILITY_UNAVAILABLE`；因此 `observation.observed` 与 `DONE-APPLIED` 不可能靠伪造 `run_ref` 落盘。
- `experiment.status=planned` 的 `plan_ref` 必须是本地签名 plan（`SCOPE_DENIED` 否则）。
- 草稿引用的每条 source evidence 会在保存时重核签名/文件/byte 区间；伪造或已过期的引用不会以 `fresh` 保存，记录 freshness 会降为 `stale`/`unknown` 并写 `invalidation_reasons`。
- **残余信任边界**：`prediction.status=user_provided` 与 `mental_model.author=user` 是“对话来源”声明，引擎只能校验结构与时间戳，无法密码学认证“确实由用户说出”。Agent 必须遵守 skill 的“不得代填”规则；不要把该字段当作已验证事实。

## 4. 一次典型对话

1. 用户："帮我读懂 UMD 的 ioctl 提交到 KMD 队列完成通知。"
2. Agent 调 `code_workspace action=validate`，确认 variant/semantic_status。
3. `code_overview` 给出三仓职责与接口候选。
4. `code_source find` 找 `JOB_IOCTL_SUBMIT` → `read` 读带行号片段 → 解释。
5. 若已有快照：`code_snapshot import` → `code_path path from=umd:job_submit to=kmd:job_complete`，讲清 exact/may/unknown。
6. 用户要验证时先请用户给预测；记录用 `code_learn save`，预测保持 pending。
7. 暂停后源码/CONFIG 变了：`code_learn resume` 返回 stale 与 safe_cursor，先重核再续读；旧行号不能当当前事实。

普通知识问答直接回答，不强制建记录/测验；只有用户明确“学完了/复盘”才走完整复盘流程。

## 5. 安全与边界速查

- **模型不可指定**：绝对读取路径、bootstrap/state 目录、Python 解释器、Atlas argv、shell 片段、记录 DB 路径。
- 读取仅限 bootstrap 登记根内、workspace 登记 repo 内；不跟随 symlink/junction、不跨根；含秘密/二进制 → `ref_only`。
- 快照必须通过 envelope/hash/schema/图引用校验，且 `workspace_roots` 至少一个条目指回本 workspace 的 repo；不满足直接拒绝。
- 不默认运行构建/测试/Atlas/编译器；`run` 固定 `EXECUTION_BLOCKED`，`plan` 只产出计划。
- 跨仓 ABI 只是静态契约候选（最多 may）；运行时行为、硬件完成、线程重叠、字节偏移需要另行证据。
- 不自动写 05 长期记忆、不上传、不新增模型接收方。

## 6. 故障排查

| 现象 | 处理 |
|---|---|
| 工具返回 `CONFIG_UNAVAILABLE` | 未找到 bootstrap；运行 §2.1 或检查 `bootstrapPath`/`CODE_READER_BOOTSTRAP` |
| `DEPENDENCY_UNAVAILABLE` | Python 3.11+ 不可用；设 `pythonPath` 或 `DSH_CODE_READER_PYTHON` |
| `SCOPE_DENIED` | 路径/根不在 bootstrap 授权范围，或签名引用被篡改 |
| `STALE_SOURCE` | 文件/游标/证据签发后源码已变化，重新 find/read |
| `STALE_SNAPSHOT` / `UNSUPPORTED_SCHEMA` | 快照不是已核验的 Atlas 0.1 对，或 hash 不匹配；重新导入 |
| `STATE_CONFLICT` | revision/generation/锁冲突；先 `status`/`resume` 取当前值再重试 |
| 工具不存在 | 插件未激活：检查 `plugin_manager` 安装结果与 `inspect` 诊断 |
