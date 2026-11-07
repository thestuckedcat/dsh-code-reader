# 04 实施路线与来源（dsh-code-reader 首版）

更新：2026-11-07。状态：**本轮正式实现**。依据：[CL-DESIGN-2 软件设计](software-design.md)、[产品形态](product-form.md)、[开发合同](../../docs/development-contract.md)、[机制说明合同](../../docs/mechanism-document-contract.md)。

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
3. **Atlas 执行**：`plan` 只做数据/argv 计划；`run` 无强制隔离 profile 时返回 `EXECUTION_BLOCKED`，不裸跑 compiler probe。真实索引/编译留作运行门禁。
4. **关系查询**：flow_legacy 用快照内 flow_edges 投影；flow_cfg/locks/aliases 在快照 capability 不足时一律 `status=unavailable` 并列出 unknowns，不以空数组伪装完整。
5. **记录存储**：按设计使用 SQLite（Python 标准库）+ 不可变 revision JSON；未引入 FTS/外部依赖。
6. **测试**：设计列出的 `test_runner.py`/`test_egress.py` 等在上表偏离下改为等价边界测试（无执行后端 → blocked；无外发路径断言），未运行项在 mechanisms.md 明确标注 actual/blocked。

## 运行门禁（本版不声明通过）

- 真实 Linux Kbuild/compdb 上的 Atlas 索引（需目标 Linux 工具链、生成头与固定 Atlas runtime）。
- bwrap/OCI 强制隔离 runner、compiler probe 越根/无网负例。
- native CFG（需固定 Clang18 extractor，缺失时 capability=false）。
- 真实用户仓库/硬件行为证明：静态证据不证明运行时必达。

这些门禁未通过前，本版只声称“合成 fixture 上适配与学习流程自测通过”，不声称读懂用户真实驱动。

## 证据与完成标准

- 每次实现任务：真实行为测试先失败 → 最小实现 → 同命令复测通过 → 记录命令与输出摘要到 `evidence/`。
- 完整交付：各验收 ID（CL-001..CL-009 子集映射见 [实施契约](implementation-contract.md)）有测试、Node 插件桥接测试、安装后注册验证与一次实际工具旅程。
- 按机制说明合同在 `docs/mechanisms.md` 记录稳定机制 ID、参数、硬边界与证据；机制说明不早于实现。
