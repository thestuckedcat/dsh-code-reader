# 04 最终验收汇总（分阶段 dsh-web 证据）

`FINAL-ACCEPT-04` · 2026-11-15 · 目标：“参考 demo 以及设计文档完成所有开发，并逐阶段在 dsh-web 完成测试”。
本目录把各阶段真实验收结果汇总为一份可核对的清单；**不是**新增测试运行，而是对已提交证据的汇总与索引
（`summary.json` 由 `verification.json` 结构化聚合，含各阶段 sha256）。完整机制说明见
[../../docs/mechanisms.md](../../docs/mechanisms.md)，产品形态与边界见
[../../docs/product-form.md](../../docs/product-form.md)。

## 1. 阶段汇总（全部 dsh-web 真实隔离 profile 验收）

| 阶段 | 能力 | 检查 | 结果 | 证据 |
|---|---|---|---|---|
| S1 | 只读切片：侧边栏工作台→已核验快照→入口→真实 C 源码/证据 | 26/26 | ✅ ok/verified | `evidence/readonly-slice/` |
| S2a | 五视图（资源关系图/文字树/端到端图/静态预测时序/文件视图）+ 共享 Selection | 37/37 | ✅ ok/verified | `evidence/five-views/` |
| S2b | 组折叠 / 接口库（黑盒 add/remove）/ 子流程面包屑 | 41/41 | ✅ ok/verified | `evidence/s2b/` |
| S3a | 受控 Wasm 场景执行 / 边界打桩 / 不可变运行台账 / observed 时序 | 43/43 | ✅ ok/verified | `evidence/s3/` |
| S3b | 回退末尾 N 步+前缀重放 / 轨迹导入 / observed 多台账选择 | 58/58 | ✅ ok/verified | `evidence/s3b/` |
| CW-09 | AI 归纳（Agent 经 `code_summary` 写入/签名/失效；函数/组/**入口 subject** 展示与“入口归纳”子块；插件不调用模型） | 56/56 | ✅ ok/verified | `evidence/ai-summary/` |
| A11 | 性能实测：合成 500/800、2000/10k；首屏 hot p95 382–387 ms ≤500 ms 预算、coupling p95 3–4 ms | 25/25 | ✅ ok/verified（4 项 not_verified 如实保留） | `evidence/perf/` |
| S4-prep-async | 异步/IRQ 事件边界：`async_events` 声明 + observed `async:true` + “异步”chip；真实 Wasm `bus_irq` 与导入异步轨迹 | 34/34 | ✅ ok/verified | `evidence/async-irq/` |
| S4-prep-linux | Linux 构建的 Atlas 0.8 快照经 bootstrap `path_aliases` 导入 Windows DSH；跨 OS 图/字段访问等价 + 隔离 dsh-web 五视图探针（残差失败 0） | 12/12 | ✅ ok/verified | `evidence/linux-atlas/` |

合计 **9/9 阶段全绿、332/332 项检查通过**；仓库测试 **331 Python / 200 Node / Demo 8/8**（Linux 引擎测试在 WSL + QEMU Ubuntu 24.04 另计，见兼容补充）。
S1–S4-prep 均在与用户桌面宿主无关的**隔离 rc.5 dsh web profile**（隔离 DSH_HOME、真实 Electron/Chromium
探针、真实 Cordis、固定宿主 sha256）中运行并留证；关键 dsh-web 证据含截图、`verification.json`、
`host-runtime` TAP/JSON、`commands.log`。

## 2. 已实现能力（相对设计文档）

1. 读同一入口的源码/证据/调用/数据/对象生命周期/错误/不确定性与 ABI 边界（S1/S2a）。
2. 交互式代码视图五视图 + 折叠/黑盒/子流程 + 共享 Selection 跨视图联动（S2a/S2b）。
3. 受控场景执行（可信 Wasm profile、Host 隔离 worker、签名 plan、不可变台账、代次 CAS）、边界打桩、失败传播、回退/前缀重放、轨迹导入、observed 时序与异步边界（S3a/S3b/async）。
4. AI 归纳：Agent 写入 ≤500 字、事实引用/生成版本/推断标签、快照变更 stale、UI 只读展示（函数/组/入口 subject，含“入口归纳”子块，无记录静默）；插件不调用模型（CW-09）。
5. 批量首屏端点 `view.firstScreen`（entry+interfaces+当前视图+coupling_aux；逐字段等于单独端点；480 KiB 预算；失败回退）+ 性能实测口径与达标（A11）。
6. 分层阅读与函数定位（CL-007-D1..D3 / CL-PF-02/03 补充）：skill 四层流程与“先定位再解释”工作流 + 合同测试（`skills/learn-code-workspace/references/layered-reading.md`、`engine/tests/test_skill_contract.py`）。
7. 真实 Atlas 0.8 只读产物的导入/投影证据；Linux 可移植性探测（`evidence/s4-feasibility/`）。
8. 跨 OS 快照：Atlas 0.8 Linux runtime 在 WSL2 Ubuntu 构建 Demo C 快照，bootstrap `path_aliases` 映射构建机根路径后由 Windows 插件导入，图计数/字段访问 certainty 与 Windows 快照一致；隔离 dsh-web 五视图通过。引擎 331 tests 在 WSL 与本地 QEMU Ubuntu 24.04 guest 通过（`evidence/linux-atlas/`，`tools/build-linux-atlas-snapshot.sh`，`tools/verify-linux-snapshot.mjs`）。

## 3. 未验证/不可声明（如实保留）

- **S4 目标门禁**：真实 Linux 内核索引与 Kbuild 编译（生成头）、native CFG/locks/aliases、复核
  precision/recall、OS 出口认证——需要固定 Linux 目标（Python≥3.11、Linux 构建的 Atlas 快照、内核源码/
  compdb/生成头、复核数据）。**已补充**：引擎 331 tests 在 WSL + 本地 QEMU Ubuntu 24.04.5 通过；Atlas
  0.8 Linux runtime 生成的 Demo C 快照经 `path_aliases` 导入 Windows 插件并在隔离 dsh-web 五视图通过
  （`evidence/linux-atlas/`）。早期探测 `evidence/s4-feasibility/` 记录 Node 契约 164/164、真实 Wasm
  worker 8/8；Windows 构建的 manifest 路径绑定被 Linux 拒绝（跨 OS 导入需显式 alias）。真实 Kbuild/
  CFG/locks/aliases/复核/OS 出口仍不可声明。
- **产品范围待确认/未授权**：真实设备下发、图内源码写回。
- **已知限制**：AI 归纳正文由 Agent 写入（插件不调用模型）；
  observed 异步标记仅表示声明为异步触发，不推断中断发生；性能达标仅限合成 500/800 夹具+本机（cold UI
  20 冷样本、tree→file、拖动、2000/10k UI 截断文本仍 not_verified，跨参考机校准未做）；真实硬件行为/
  跨进程异步调度/ABI 布局仍为 unknown；历史 S3a/S3b 证据使用 profile rev1，异步证据使用 rev2
  （`evidence/scenario-sim/README.md` 记录版本差异）。
- out_of_scope：真实 Linux/Kbuild 环境、跨参考机性能校准、桌面宿主热更新与其它 OS 出口。

## 4. 复现

```bash
# 各阶段（均需隔离 profile；产品宿主为 Windows DSH rc.5，脚本自带隔离 scratch/门禁）
node tools/verify-readonly.mjs --with-repo-tests      # S1
node tools/verify-five-views.mjs --with-repo-tests    # S2a
node tools/verify-s2b.mjs --with-repo-tests           # S2b
node tools/verify-s3.mjs --with-repo-tests            # S3a
node tools/verify-s3b.mjs --with-repo-tests           # S3b
node tools/verify-summary.mjs --with-repo-tests       # CW-09
node tools/verify-perf.mjs --with-repo-tests          # A11
node tools/verify-irq.mjs --with-repo-tests           # async/IRQ
node tools/verify-linux-snapshot.mjs                  # Linux 构建快照 → Windows 插件（需先构建快照）
bash tools/build-linux-atlas-snapshot.sh              # 在 Linux/WSL 生成 Demo C 的 Atlas Linux 快照
node tools/perf-regressions.mjs                       # 跨阶段回归（S3b/S3a/S2b/summary）
cd engine && python -m unittest discover -s tests     # 331 tests
node --test tests/node/*.test.mjs                     # 200 tests
node --test demo/code-view/demo.test.cjs              # Demo 8/8
```

## 5. 提交索引

`2694ee5` CW-T1 S1 · `c7c5d4f` S2a · `c7c6f8d` S2b · `a18ffcc` S3a · `295f2fe` S3b ·
`bbd42d6` AI 归纳+性能基线+Windows 签名密钥修复 · `0098942` 首屏优化+Linux 探测 · `69a1173` 批量首屏
（首屏预算达标）+机制文档 · 本轮（async/IRQ + 最终验收汇总）见 git log。
