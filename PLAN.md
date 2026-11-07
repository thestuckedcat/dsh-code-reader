# Code Learning Implementation Plan

> **2026-11-07 交付状态更新**：本文件是早期实施计划历史，保留用于追踪任务拆分与门禁。
> 首版已实现为可安装 `dsh-code-reader` plugin（Python 引擎 + DSH Host bundle + learn-code-workspace skill），
> 当前实现合同与验证入口见 [README](README.md)、[实施路线](docs/implementation-route.md)、
> [实施契约](docs/implementation-contract.md) 与 [机制说明](docs/mechanisms.md)。
> 真实 Linux/Kbuild/Atlas 执行、隔离 runner、native CFG 仍按本计划保留为未通过门禁。

状态（历史）：planned，2026-11-03。本轮不生成skill实现、不运行Atlas/doctor、不索引驱动仓库。

2026-11-06设计交接：[CL-DESIGN-1编码级软件设计](docs/software-design.md)补齐固定Atlas0.8.0/schema0.1来源摘要、真实Kbuild/compdb输入、受限执行、不可变查询view、学习记录与续读失效。首版skill＋本地证据导航/报告已确认，专用Harness交互学习面板后置。下方为早期任务拆分；实施前按新设计同步CLI/ref/schema和任务边界，不能把旧签名当作另一套并行合同。所有实施项仍未执行。

**Goal:** 让Agent围绕一个具体行为带用户学习Linux驱动与用户态单/多仓代码，并保留证据、预测、核验及续读状态。

**Architecture:** 学习编排skill消费固定Atlas CLI与schema产物；薄Python适配只负责登记输入、受限执行、snapshot验证与学习记录。Serena/MCP/DSH Viewer后置，Atlas现有离线HTML先复用，不开发第二套Clang解析器。

**Tech Stack:** Markdown skill、Python3.11+ stdlib unittest、固定SDK Code Atlas0.8快照/CLI与本地运行时、Clang真实compdb；Native CFG仅有独立Clang18 extractor时启用。

**Spec:** [共同合同](../docs/development-contract.md)、[形态](../docs/capability-forms.md)、[学习设计§3—4](../docs/ecosystem-learning-design.md)、[代码证据设计§4](../docs/code-memory-design.md)、`H:/VSCODE_READER/SKILL.md`与其当前schema。

## Global Constraints

- schema_version=1用于本模块记录/消息；不得擅改Atlas当前schema0.1或把Agent may提升为exact。
- 真实Kbuild/CONFIG/架构/生成头与用户态compdb；不把Linux驱动改成CMake，不从父目录扫兄弟仓；登记根外拒绝。
- 可信compiler probes可能执行，按已批准绝对路径/摘要限权；CMake仅对真实采用它的子项目且已有授权时可选，禁止隐式下载。
- H盘只读参考；未来在本目录固定副本/离线构件接入，不修改现有Atlas。本项目独立fixture，不要求03/05服务存在。
- 模型API用于批准讲解/提炼，秘密不入上下文；普通问答不强制考试，不伪造用户预测/观察/掌握。

## Review Focus

1. compdb恶意compiler/wrapper/response文件——Task1命令允许表与路径拒绝。
2. failed/pending/过期TU被当完整事实——Task1快照覆盖与freshness测试。
3. CONFIG与跨仓同名/ops引用误成调用——Task2证据分级fixture。
4. 回退、dirty变化、重复/乱序消息导致旧学习续读——Task2消费者和源码重核。
5. 普通问答升级考试/预测被代填/长期记忆误写——Task3行为用例和独立读任务。

## 未来工具与目录

以可信Linux环境分析Linux驱动；Windows可管理记录，但不伪造目标头文件。准备任务预置`runtime/bin/python`（Linux）或`runtime/python.exe`（Windows），固定Atlas到`runtime/atlas/`并锁其许可、commit、schema和依赖摘要；本轮不存在这些新文件。下方测试以Linux路径给出，Windows同参数替换为`& .\runtime\python.exe`；不运行H盘launcher。

## Task 1：登记范围与Atlas只读证据适配

**Files:** Create `code_learning/__init__.py`、`code_learning/workspace.py`、`code_learning/atlas_adapter.py`、`code_learning/provenance.py`、`schemas/workspace.schema.json`、`tests/test_atlas_adapter.py`、`tests/fixtures/atlas_snapshot/`、`source.lock.json`。

**Interfaces:** `validate_workspace(manifest_ref) -> Workspace`；`plan_atlas_run(workspace, goal_ref, policy) -> RunPlan`；`read_snapshot(out_ref) -> SnapshotEvidence`。RunPlan带argv、允许compiler、根/compdb摘要、variant和能力要求；执行入口`execute_plan(plan, runner)`仅在显式批准模式使用，runner可fake。

- [ ] 固定Atlas源码/产物/schema与离线runtime，核当前CLI和build.py probes；将预先授权参数复用，不每次重问；未获批准的新执行边界拒绝。
- [ ] 写失败测试：跨根/软链接/多仓同名根冲突、恶意compiler/wrapper/response路径、无真实compdb拒绝；nativeCFG缺失只返回不可用，不造数据；failed/pending TU显式覆盖；源hash变化标stale。
- [ ] Run `./runtime/bin/python -m unittest discover -s tests -p test_atlas_adapter.py -v`应因接口未实现FAIL，不能因runtime缺失算红灯。
- [ ] 最小实现manifest校验、固定Atlas argv、真实schema读取与证据投影；不执行CMake自动发现或解析器替代，失败TU不沿用旧事实。
- [ ] 同命令PASS；fixture验证只说明适配正确。未来独立在本目录runtime/atlas运行已批准合成compdb任务，实际记录doctor/capabilities与snapshot，不把历史CI/pass counts当当前实测。

## Task 2：路径证据与可恢复学习记录

**Files:** Create `code_learning/paths.py`、`code_learning/records.py`、`code_learning/invalidation.py`、`schemas/learning-record.schema.json`、`schemas/capability-event.schema.json`、`tests/test_learning_records.py`、`tests/test_invalidation.py`、`tests/fixtures/multi_repo/`。

**Interfaces:** `explain_path(snapshot_ref, endpoints, budget) -> {edges,unresolved,coverage,truncated}`；`save_learning_record(record,expected_generation) -> RecordRef`；`consume_event(event) -> {accepted,stale_refs}`。record含goal/scope/repo/variant/snapshot/evidence、mental_model、prediction/observation/difference（允许pending）、rules/unknowns/next_action，不存秘密。

- [ ] 写失败测试：两个CONFIG变体分开；同名静态函数不跨仓合并；ops取地址只是reference候选，只有call-expression/绑定目标才为call；跨仓ioctl需UAPI与版本证据，缺失保持unresolved；预算截断可见。
- [ ] 写续读失败测试：记录版本冲突拒绝覆盖，dirty/CONFIG变化标stale；schema_version1的session_surface_rewound/workspace_files_restored/session_removed事件按event_id去重，partial/unknown保守失效，丢事件仍可hash重核；旧/乱序generation不能把状态变回fresh。
- [ ] Run `./runtime/bin/python -m unittest discover -s tests -p test_learning_records.py -v`及`./runtime/bin/python -m unittest discover -s tests -p test_invalidation.py -v`应FAIL。
- [ ] 最小实现证据引用与record generation、共同事件消费者、暂停游标与重进freshness；03不存在时用fixture事件，不靠全局事务。不将人工图示或记忆作为新编译事实。
- [ ] 同命令PASS；检查所有记录的prediction/observation初始为pending，不代替用户声称理解或实际验证。

## Task 3：学习skill与独立CLI旅程

**Files:** Create `skill/learn-code-workspace/SKILL.md`、`skill/learn-code-workspace/references/workflow.md`、`code_learning/cli.py`、`tests/test_skill_contract.py`、`tests/test_cli_journey.py`、`USAGE.md`。

**Interfaces:** CLI `python -m code_learning.cli status --workspace FILE`、`path --snapshot DIR --from REF --to REF`、`resume --record FILE`；skill采用定界→小地图→走一条证据路径→解释→先预测再核验→规则/停止。此为拟议工具，只有实现后才能在skill里声明可调用。

- [ ] 写失败测试/对照对话fixture：普通“此函数做什么”直接回答不强制全套考核；明确学完时完整复盘；缺用户预测写pending；K2/K3无G/Q允许停止；每次学习Next Action最多一个且有时长/完成标准；只读解释不自动运行目标测试。
- [ ] 写CLI旅程失败测试：合成双仓输入→证据路径→保存pending预测→暂停→源码变化→resume要求重核；不安装Serena或其他插件也可完成；禁自动写05长期记忆。
- [ ] Run `./runtime/bin/python -m unittest discover -s tests -p test_skill_contract.py -v`及`./runtime/bin/python -m unittest discover -s tests -p test_cli_journey.py -v`应FAIL；用真实可观察旅程，不只断言文档含几个关键词。
- [ ] 最小实现CLI与skill说明，直接复用Atlas查询和offline HTML；按需请求定义/引用时才可接Serena。行为用例由独立Agent/人工逐条检查，不能把字符串测试当学习效果证明。
- [ ] 同命令PASS；未来使用公开合成仓实际跑一次已批准Atlas/CLI旅程并记录证据、用户预测待完成与所耗资源。独立评审后交付skill+适配，不宣称已有正式VSCode扩展或已读懂用户驱动。
