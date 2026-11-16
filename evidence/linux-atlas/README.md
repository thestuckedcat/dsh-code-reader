# Linux 构建的 Atlas 快照 → Windows DSH 插件（S4-prep 跨 OS 验证）

状态：**已验证（局部）**。本目录证明：用 **Atlas 0.8.0 Linux runtime** 在 Linux 上生成的快照，可以通过 **DSH 0.2.1-rc.5 插件**的显式 `path_aliases` 根映射导入 **Windows** DSH，并在隔离 dsh-web 中通过五视图验收；引擎测试在 Linux（WSL 与本地 QEMU Ubuntu 24.04 guest）上通过。

**这不等于 S4 目标门禁通过**：目标是 Demo C（用户态风格源码）的 Linux 构建产物；真实内核/Kbuild、生成头、native CFG/locks/aliases、复核 precision/recall、OS 出口仍未验证（见“限制”）。

## 1. 环境与来源

| 项 | 值 |
|---|---|
| Atlas | `H:/VSCODE_READER`，Atlas 0.8.0 / schema 0.1，Linux 运行时 `runtime/linux-x86_64`（probe：Python 3.12.14） |
| Linux 构建机 | WSL2 Ubuntu 20.04（gcc 9.4.0 生成 compdb；Atlas Linux venv 走 `/mnt/h`） |
| 源码 | 本仓 `evidence/code-view-slice/repo/{bus.c,platform.c}`（与 S1/S2a 相同 Demo C） |
| Windows 插件 | DSH 0.2.1-rc.5 隔离 profile，`@local/dsh-code-reader`（sha256 基线见 verification.json） |
| 第二 Linux 校验 | 本地 QEMU Ubuntu 24.04.5 guest `autoenv-ubuntu`（DSH remote-env `target-ubuntu-lab-ssh`，Python 3.12.3；无编译器/无网络） |

构建脚本：[`tools/build-linux-atlas-snapshot.sh`](../../tools/build-linux-atlas-snapshot.sh)。产物：

- `snapshot-linux/`：Linux 构建的 `graph.json` + `analysis_manifest.json`
  - snapshot_id `2ffddd4400b6400b8bdc55ffcd33bf76`
  - graph_hash `67aa438f7be00ec5c76370b4795db4466f26ecd816dcb358cfe3f5bde0bae795`
  - workspace_roots `["/root/atlas-demo/repo"]`（Linux 构建机的绝对路径；bootstrap 用 `path_aliases` 显式映射到本地 `slice-root`）
  - coverage parsed 2 / failed []

## 2. 跨 OS 根映射机制（`path_aliases`）

Atlas 在 manifest 的 `workspace_roots` 里记录**分析机的绝对根路径**。Windows 插件无法用该路径直接读取源码，原实现会以 `analysis_manifest.workspace_roots does not identify this registered workspace` 拒绝导入。本轮新增：

- bootstrap `candidate_roots[]` 增加可选 **`path_aliases`**（≤16 条、绝对路径、去重、控制字符拒绝）；它只声明“这个本地 root_ref 在构建机上对应哪个分析根”；
- 快照导入时 alias 仅参与**身份匹配**（`_check_manifest_provenance`），不参与文件读取；文件读取仍严格在本地 candidate root 下进行（越界/真实路径检查不变）；
- `_repo_roots` 把 alias 作为 foreign root 用于把 graph/evidence 的绝对路径转换为 repo 相对路径（`/root/.../bus.c` → `bus.c`），源码按本地 root 读取；
- 未声明 alias 时导入仍然拒绝；alias 挂在**非目标** root_ref 上不会满足目标仓库校验。

示例（隔离 home，仅测试）；生产使用时把 `path_aliases` 写进 bootstrap：

```json
"candidate_roots": [{
  "root_ref": "slice-root",
  "absolute_path": "E:\\dsh\\plugin\\04-code-learning\\evidence\\code-view-slice",
  "read_grant_ref": "grant-slice",
  "path_aliases": ["/root/atlas-demo/repo"]
}]
```

回归测试：`engine/tests/test_cross_os_snapshot.py`（8 项；含无 alias 拒绝、错误 root_ref 拒绝、POSIX/Windows alias 校验、bootstrap 校验）。

## 3. 验收结果（`node tools/verify-linux-snapshot.mjs`）

12 项检查全部通过（`verification.json`: `ok=true, verified=true`）：

- Linux 快照导入成功（Windows 插件 state）；
- `view-entries` 19 入口，`bus_send` file=`bus.c` line=152；
- `view-coupling`：routes 资源 + 5 functions + 11 edges，routes 字段 lane/max_len 与 evidence id 正常；
- `view-file-read` 读回 bus.c，sha256 与证据一致；
- **跨 OS 数据等价**：Windows 快照 vs Linux 快照的 functions/call_targets/objects/field_accesses/flow_edges/lock_events/alias_relations 计数一致（19/15/18/15/90/0/3）；15 条字段访问的 `(function, object, field, access, certainty)` 集合完全一致（max_len 写 exact + may，读 may）；
- 真实隔离 **dsh-web 五视图 Chromium probe** 通过：`coupling/tree/end_to_end/sequence/file/main` 全部 ready + 截图保存（`linux-*.png`），console error 0；
  - probe 原始 `ok=false` 只来自 `view_coupling_assertions.gapsOriginal`：该断言冻结于 S2a，要求“组折叠/接口库/AI 归纳/运行观测”仍为 gap，而 S2b/S3a/CW-09 已实现这些能力，故按既有 superseded 规则忽略；**残差失败步骤为 0**，其余步骤全部 true（详见 `five-views-probe.json`）。

## 4. Linux 引擎可移植性（QEMU + WSL）

- WSL2 Ubuntu 20.04 + Atlas bundled Python 3.12.14：`python -m unittest discover -s tests` → **331 tests OK**；
- 本地 QEMU Ubuntu 24.04.5（kernel 6.8.0-139，Python 3.12.3）：**331 tests OK**（2 项 Windows junction 回归按设计 skip），证据 `qemu-verification.json`；
- 注意 QEMU guest 无编译器（仅 gcc-14-base 运行库）且网络 `restrict=on`，因此 **Atlas 分析在 QEMU 上不可执行**；Atlas 快照构建在 WSL Linux 完成。

## 5. 限制与未验证（不可声明）

- 目标代码是 **Demo C 用户态风格源码**，不是内核/驱动；Kbuild、生成头、目标 ABI、Kconfig 组合未覆盖；
- Atlas Linux runtime 报告 `native_cfg=unsupported`、`data_flow=partial_path_insensitive`、`locks=lexical projection`；CFG/locks/aliases 深度仍是 S4 未验证项；
- 未做真实 Samba 挂载的远端云空间构建（本会话无该远端凭据）；本轮验证的是“Linux 构建 → Windows 插件导入”的路径与机制，远端 Kbuild 需在目标构建机执行 `build-linux-atlas-snapshot.sh` 等价流程；
- 未做复核 precision/recall、OS 出口认证、真实设备下发/写回。

## 6. 复现

```bash
# 1) Linux（WSL 或远端 Ubuntu）：生成 Linux 快照（需要 gcc 与 Atlas Linux runtime）
ATLAS_REPO=/mnt/h/VSCODE_READER bash tools/build-linux-atlas-snapshot.sh
# 2) Windows：隔离 dsh-web + 五视图 Chromium 验收（自动写 path_aliases 并导入）
node tools/verify-linux-snapshot.mjs
```

## 7. 独立复核（T48/T49，verifier，最终证据 2026-11-17）

verifier 于 T48 独立复核后，Lead 修复了复核提出的两点（verification 写 `checks_summary`；过期 gap 文案改为当前真实语义），
verifier 在 T49 重新跑验收并刷新本目录最终哈希：

- `node tools/verify-linux-snapshot.mjs`：exit 0（27.0s），`verification.json` **ok=true/verified=true，12/12 checks**，
  `checks_summary={"total":12,"passed":12,"failed":0,"in_scope_not_verified":0,"out_of_scope_not_verified":3}`；
  六张 `linux-*.png` 与 Lead/T48 证据 **逐字节相同**（T49 未改截图内容）。
- Chromium probe：原始 `ok=false` 只来自 `view_coupling_assertions.gapsOriginal`；**residual_failed_steps=[]**、
  console error=0；五个视图 ready、其余断言全 true。`gapsOriginal` 冻结于 S2a（要求组折叠/接口库/AI 归纳/运行观测
  仍为四类 gap），S2b/S3a/S3b/CW-09 已实现对应能力，故 **superseded 仍成立**。
- gap 文案修复已复核：
  - 新文案示例：`ai_summary` = “暂无 AI 归纳正文：Agent 可通过 code_summary 写入（插件不调用模型、不伪造正文）”；
    `run_observation` = “静态预测视图无运行观测；执行/导入场景后可在 observed 模式查看台账”；
    `scenario_execution` = “本视图不执行场景；场景执行/打桩/回退由场景接口提供（需已登记可信 Wasm profile）”。
  - probe gap 文本中不再出现 “S2b / CW-T3 / 未接入 / 后置” 等过期声明；
  - Windows fixture 与 Linux 快照的 coupling/tree/end_to_end/sequence **gap 列表逐项完全一致**（直接 CLI 对比 `EQUAL=True`）。
- 全量测试（T49 复跑）：engine **331 tests OK（42.5s；含 test_cross_os_snapshot 8 tests OK）**；
  Node **200/200 pass**；Demo **8/8 pass**。QEMU 复核沿用 T48 结论（任务不要求重跑）：
  guest Ubuntu 24.04.5 / Python 3.12.3 / 331 tests OK（skipped=2 Windows junction），与 `qemu-verification.json` 一致。
- 最终 sha256（本目录实际值）：
  `verification.json` `f7e4165568a0297e422d9671c6d293a503a93965d10e1f52603eabd85452f8d2`（27,826 B）；
  `five-views-probe.json` `426e57049c669d48e51a009d454404735fb87e737529734f2363059b5f90a087`（124,190 B）；
  `linux-coupling.png` `ef6e0dad…0571c`、`linux-tree.png` `ff83c647…055cb`、`linux-end_to_end.png` `4ff80776…e8f12`、
  `linux-sequence.png` `832ec03e…72573`、`linux-file.png` `c13dd454…83febe`、`linux-main.png` `a3dd4804…ed654`；
  `qemu-verification.json` 未改（`c6ed4927…`）；`independent-review.json`/本 README 以目录实际最终值为准。
- 与 Lead 证据的差异仅非语义字段（`generated_at`、operation-id/commands、probe URL/`duration_ms`）；
  不再有 `checks_summary` 缺失或过期 gap 文案差异；**无不可解释的语义差异**。
- 复核记录：`independent-review.json`（T49 final：命令/exit codes/12 项/superseded 审计/修复前后对比/not_verified）。
  `not_verified` 与 §5 相同：Demo C 用户态源码、native CFG/locks/aliases 深度、真实内核/Kbuild、
  跨参考机 precision/recall、QEMU 无编译器/无网络不能执行 Atlas 分析、真实设备/OS 出口。
