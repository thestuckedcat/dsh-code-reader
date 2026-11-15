# dsh-code-reader

DeepSeek Harness（DSH）插件 + `learn-code-workspace` skill + 本地 Python 引擎，用于 **Linux 驱动与用户态组件的单仓/多仓代码学习**：登记 workspace、受限读取源码、导入已核验的 SDK Code Atlas 0.1 快照、追踪证据路径、保存带预测/观察分离的版本化学习记录；并提供 **DSH 原生侧边栏「代码工作台」只读切片**（快照 → 入口 → 真实 C 源码与证据）。

本仓库是 04-code-learning 能力的首个可安装实现（`CL-IMPL-1`）。设计依据与全部边界见 [`docs/`](docs/)：

- [产品形态](docs/product-form.md)
- [软件设计](docs/software-design.md)及[分层阅读设计 CL-DESIGN-2.1（待实现）](docs/software-design.md#81-驱动代码分层阅读与函数定位)
- [交互式代码工作台插件设计 CL-VIEW-D2](docs/interactive-code-view-software-design.md)、[只读工作台实施/验收契约](docs/readonly-workbench-contract.md)及 [DSH 侧边栏指导 skill 草案](docs/dsh-code-view-ui/SKILL.md)
- [实施路线与来源](docs/implementation-route.md)
- [首版实施契约](docs/implementation-contract.md)
- [机制说明](docs/mechanisms.md)（交付时补全）
- [使用说明](USAGE.md)

## 状态（2026-11-15）

- **已实现并自测**：workspace 登记/校验、源码只读查找与引用、Atlas 0.1 快照导入与完整性校验、路径/关系查询（含跨仓 `abi_bridge` 候选）、学习记录 CAS/导出/resume 失效、`learn-code-workspace` skill、6 个 DSH Host 工具、安装后注册验证。
- **只读代码工作台 S2a 五视图（2026-11-15，CW-T2 首阶段）**：DSH 插件自带 client 半，侧边栏「代码工作台」keyed 主面板；**资源关系图**（三列 writers/resources/readers + 访问线 kind/certainty + 左栏全局资源 + 打桩占位）、**可折叠文字树**（调用点/guard/返回/局限）、**单入口端到端图**（竖排 H/V 正交折线、判断菱形、异常红色实线、外部边界虚线、拖拽/平移/缩放/适应/搜索/一键规整）、**时序图**（S2a 静态预测模式，明确 warning + observed=false）、**文件视图**（快照涉及文件 + 行号 + 联动高亮）；图例/详情/缺口/共享 Selection 跨视图联动。读模型 `view.status/listSnapshots/listEntries/getEntry` + `view.coupling/tree/endToEnd/fileTree/fileRead/sequence`（自有 `/code-view` RPC，连接准入 + 严格输入校验）。真实快照夹具与隔离 dsh-web 证据见 `evidence/code-view-slice/`、`evidence/readonly-slice/`、`evidence/five-views/`。
- **组折叠 / 基础接口库 / 子流程面包屑（2026-11-15，CW-T2 S2b）**：端到端图按「单入口私有子流程」结构自动分组（`groups`/`grouping`，默认折叠、可展开/一键折叠展开、跨组边保留原 edge 元数据、组名/描述可修订并标“已修订（结构归纳）”）；接口库 `view.interfaces` 规则候选（leaf/cross_file/副作用/入参 guard/理由/score，全部 may），可加入/移出并把函数收作黑盒（图/树折叠下游，可展开恢复）；函数详情新增子流程 tab 与调用面包屑（回主图或重新定根），Selection 扩展 `group_id/interface_id/subflow_root_id`。隔离 dsh-web 验收 `41/41`：`evidence/s2b/verification.json`（组/接口/子流程截图）。
- **受控场景 / 边界打桩 / 观测时序（2026-11-15，CW-T3 S3a）**：可信 Wasm 模拟 profile（隔离 inbox 导入、模块 sha 校验、绑定快照）→ 工作台左栏「打桩模拟」：profile 选择、有序步骤编辑器（接口/参数 min-max/上移下移/移除/stop-on-error）、用户点击运行；Host 在 `worker_threads` 内隔离执行（仅 `env.trace`、无 fs/网络、内存/超时限制），引擎 plan/record 写不可变运行台账（call_id、结果、事件、受影响资源、memory digest、records_digest、代次 CAS）；边界打桩（`set_platform_stub(-5)`）与失败传播（bus_send=-5、LOCK 1→0、无寄存器写）如实记录；时序图新增**运行观测**模式（observed=true，与静态预测分离）；回退/轨迹导入/真实设备以 gap 显示（S3b/后续）。读模型 `sim-profile-import/list`、`scenario-plan/module/record/list/get`、`view-sequence-observed` + RPC `scenario.*`。隔离 dsh-web 验收 `43/43`：`evidence/s3/verification.json`（打桩/台账/observed 截图）。
- **回退/前缀重放、轨迹导入、观测场景选择（2026-11-15，CW-T3 S3b）**：打桩面板支持**回退末尾 N 步**（重放前缀并逐条核对 memory digest → 发布前缀场景新 generation，附 `undo.state_digest_verified`；不一致返回 `STATE_CONFLICT/state_digest_mismatch` 且不发布）；轨迹导入（可信 inbox 轨迹 → 只读 imported 台账，不执行代码、幂等、undo 禁用）；时序观测新增台账场景选择器（多场景切换、imported 标记/label/limitations）；`view.status` capabilities `scenario_undo/trace_import=true`。读模型新增 `scenario-undo-plan/record`、`trace-import` + RPC `scenario.undoTail`、`trace.import`。隔离 dsh-web 验收 `58/58`：`evidence/s3b/verification.json`（回退/导入/多场景截图）。
- **真实 Atlas 0.8 产物对照（已做，非 Linux 门禁）**：Atlas trusted quickstart + 自建三函数 C 仓库（2026-11-08）与 Demo bus/platform C（2026-11-15）真实 0.1 快照被本适配器导入；真实 function 的 file/line 从 evidence 解析，exact 调用边与 `flow_legacy` 在真实产物上验证；本轮修复真实 `flow_edges.owner=null/sources=[]` 适配缺口（`engine/tests/test_atlas_flow_shape.py`）。见 [evidence/real-atlas/README.md](evidence/real-atlas/README.md)。
- **未声明通过**（需要目标 Linux/Kbuild/固定 Atlas runtime/强制隔离 runner/native CFG）：真实内核索引与编译、编译探针隔离、真实驱动运行时行为、AI 归纳正文、异步/IRQ 因果细化、真实设备下发与图内源码写回、S4 性能/复核。静态证据不证明运行时必达；Demo 的 Wasm 观测只作行为对照（`demo_observed`），不冒充设备行为。
- 当前测试：298 Python unittest + 152 Node tests + Demo 8/8；隔离 dsh-web 验收：S2a `37/37`、S2b `41/41`、S3a `43/43`、S3b `58/58`（`evidence/five-views/`、`s2b/`、`s3/`、`s3b/`），CW-T1 见 `evidence/readonly-slice/`。

## 组成

| 层 | 位置 | 作用 |
|---|---|---|
| DSH Host bundle | `index.js`、`lib/`、`cordis.patch.yml` | 注册 6 个 `code_*` 工具与 skill provider；固定 argv 调用本地引擎；嵌套 UI 子插件注册 `/code-view` RPC（view.*/scenario.*；缺 `connection`/`webServer` 时保持 pending，不影响旧工具）；`lib/sim-worker.mjs`/`sim-runner.mjs` 为隔离 Wasm 执行器 |
| DSH Client bundle | `bundle/client.js` | rc.5 原生 client 半：侧边栏「代码工作台」、keyed 主面板、五视图（资源关系图/文字树/端到端图/时序图/文件视图）、组折叠/接口库/黑盒、子流程与面包屑、左栏全局资源/打桩模拟（步骤编辑/运行台账/边界打桩/观测时序）、图例/详情、共享 Selection、跨视图联动、可注销 |
| 打包 skill | `skills/learn-code-workspace/` | 阅读顺序、讲解、预测/观察、停止规则；普通问答不强制复盘 |
| Python 引擎 | `engine/code_learning/` | workspace/source/snapshot/paths/bindings/records/invalidation + `views`/`five_views` 只读投影，只用标准库 |
| 合同与 schema | `engine/schemas/`、`docs/implementation-contract.md`、`docs/readonly-workbench-contract.md`、`docs/five-view-contract.md` | 自有对象 `schema_version=1`；Atlas 对象保持 `0.1` |
| 证据 | `engine/tests/`、`tests/node/`、`evidence/`、`tools/` | 合成 UMD/UAPI/KMD fixture、真实 Atlas 产物、只读工作台与五视图隔离 dsh-web 验收 |

## 快速开始

前置：Python 3.11+；DSH 已运行并可安装本地 bundle。

```bash
# 1) 在仓库根创建本地可信 bootstrap（只允许登记根，不扫全盘）
cd engine
python -m code_learning.cli bootstrap-init \
  --out ~/.dsh/code-reader/bootstrap.json \
  --state-dir ~/.dsh/code-reader/state \
  --import-inbox ~/.dsh/code-reader/inbox \
  --root synthetic-root=/path/to/your/repos \
  --profile-ref desktop --scope-ref local

# 2) 在 DSH 中安装 bundle（本地目录直接链接）
#    plugin_manager action=install_bundle target=<本仓库绝对路径>

# 3) 登记 workspace 并导入已核验快照后，从侧边栏打开「代码工作台」
#    安装/更新 bundle 后需重启宿主进程使 boot graph 生效
```

安装成功后 Agent 获得 `code_workspace`、`code_overview`、`code_source`、`code_snapshot`、`code_path`、`code_learn` 六个工具和 `learn-code-workspace` skill；Web/Host 侧边栏出现「代码工作台」。详细参数、JSON 形状与安全边界见 [USAGE.md](USAGE.md) 与[只读工作台契约](docs/readonly-workbench-contract.md)。

## 本地验证

```bash
cd engine
python -m unittest discover -s tests -v        # 引擎行为（合成 + 真实 Atlas fixture）
cd ..
node --test tests/node/*.test.mjs              # Host RPC / client / plugin 合同
node --test demo/code-view/demo.test.cjs       # Demo「登记 → 发送」对照（Wasm 模拟观测）
node tools/verify-readonly.mjs --with-repo-tests      # CW-T1 只读切片隔离 dsh-web 验收
node tools/verify-five-views.mjs --with-repo-tests    # CW-T2 S2a 五视图隔离 dsh-web 逐视图验收
node tools/verify-s2b.mjs --with-repo-tests           # CW-T2 S2b 组折叠/接口库/子流程隔离 dsh-web 验收
node tools/verify-s3.mjs --with-repo-tests            # CW-T3 S3a 打桩/运行台账/观测时序隔离 dsh-web 验收
node tools/verify-s3b.mjs --with-repo-tests           # CW-T3 S3b 回退/前缀重放/轨迹导入/多场景隔离 dsh-web 验收
```

隔离验收只使用独立 `DSH_HOME`、本仓真实快照夹具与本机已装宿主；不访问网络、不改真实 `~/.dsh`、不重启桌面宿主。

## 边界与数据位置

- 模型/浏览器永远不能指定绝对读取路径、bootstrap、状态目录、Python 解释器或 shell 片段；这些都来自人工/Host 配置与 `state.py` 的签名引用；只读 RPC 只接受 workspace/snapshot/entry 标识。
- 记录、快照导入副本与导出存本地 `state_dir`；不默认联动 05 长期记忆，不上传。
- 不默认运行 `make`/CMake/编译器/测试；`run` 在无强制隔离执行 profile 时固定返回 `EXECUTION_BLOCKED`。
- 源码含疑似秘密或二进制内容时返回 `ref_only`，不进入模型上下文；UI/RPC 不输出绝对路径。
- 代码工作台**只读视图 + 受控模拟**：执行只发生在 Host 隔离 worker（仅 registered Wasm 模拟 profile、用户点击触发、无 fs/网络/编译器），不写回源码；回退仅对可重放模拟台账（前缀重放 + memory digest 核验），导入轨迹只读不可回退；真实设备下发/图内源码写回仍未提供。

## License

MIT（见 [LICENSE](LICENSE)）。第三方引用与不随仓库分发的来源记录见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、[source.lock.json](source.lock.json)。
