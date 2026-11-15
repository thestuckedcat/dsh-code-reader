# S4 可行性探测（Linux 可移植性证据；非 S4 门禁通过）

`S4-FEAS-1` · 2026-11-15 · **目的**：在现有环境内如实探测 CW-T4/S4 所需的目标 Linux 能力，记录哪些层
已经能在 Linux 上运行、哪些仍缺外部前置。**本文件不声明 Kbuild/Atlas Linux/CFG/复核/OS 出口已通过。**

## 环境

- WSL2 Ubuntu 20.04（`Linux Stuckedcat-4090 6.6.87.2-microsoft-standard-WSL2 x86_64`），Python 3.8.10
  （Ubuntu 20.04 默认；引擎要求 `>=3.11`），Node v22.22.1。
- 仓库经 `/mnt/e/dsh/plugin/04-code-learning` 只读挂载运行；未联网、未改真实 `~/.dsh`、未动桌面宿主。

## 实测结果

| 层 | 命令 | 结果 | 证据 |
|---|---|---|---|
| Host/Client/工具 JS（Node 契约套件） | `node --test tests/node/*.test.mjs` | **164/164 pass**（Node v22.22.1，Linux） | `linux-node-suite.log` |
| 隔离 Wasm worker（真实 Demo bus.wasm） | `node --test tests/node/sim-runner.test.mjs` | **8/8 pass**（worker_threads + WebAssembly，Linux） | `linux-host-worker.log` |
| 引擎 CLI（Python 3.8） | `workspace-import` / `status` | 可运行：`status` exit 0、`valid=true`、`freshness=fresh`、`capabilities.source_text=ready`、无 `/mnt/e` 或 state 路径泄漏；重复 import 正确返回 `STATE_CONFLICT`（revision CAS） | `linux-engine-cli.log` |
| 引擎 unittest（Python 3.8） | `python3 -m unittest discover -s tests` | **FAILED**：255 errors（测试 helpers 使用 3.10+ `Path.write_text(newline=)`；引擎声明 `>=3.11`，环境不满足） | `linux-engine-unittest.log`（Ran 309） |
| 快照导入（Windows 构建的 Atlas 快照） | `snapshot-import` | 预期拒绝：`analysis_manifest.workspace_roots does not identify this registered workspace`——快照 manifest 绑定 Windows 工作区根路径，Linux 需要 **Linux 构建的同源快照** | `linux-engine-cli.log` |
| 真实内核/Kbuild、生成头、native CFG/locks/aliases、Atlas Linux runtime、复核数据、OS 出口认证 | — | **不可用**：本机无 Linux 内核源码/compdb/生成的头、无 Atlas 0.8 Linux runtime、无复核标注数据 | — |

## 结论（如实）

- 已获得：**Host/Client/工具与隔离 Wasm 执行的 Linux 可移植性证据**（Node 164/164、真实 Wasm worker 8/8），
  以及 **引擎 CLI 在 Linux/默认 Python 下的基本可运行性**（status/import；无路径泄漏）。
- 未获得、也不能声明：真实 Linux 内核索引与 Kbuild 编译、生成头、native CFG/locks/aliases、Atlas Linux
  runtime、复核 precision/recall、OS 出口认证。这些需要：固定 Linux 目标（Python>=3.11、构建工具链）、
  Linux 构建的 Atlas 0.8 快照与内核源码/compdb/生成头、以及复核数据；当前环境不具备。
- 因此 S4 门禁保持 **未验证**；本轮只交付可行性证据，供后续在具备上述前置时复用同一探针脚本与验收口径。

## 复现

```bash
# WSL2 Ubuntu（或任意 Linux）+ Node（>=22 可跑 JS 套件；产品宿主为 Node24）
node --test tests/node/*.test.mjs
node --test tests/node/sim-runner.test.mjs
# 引擎要求 Python>=3.11；3.11+ 环境下再跑
cd engine && python3 -m unittest discover -s tests
# 注意：Atlas 快照必须在目标 Linux 上构建；Windows 构建的快照 manifest 绑定 Windows 工作区根路径，会被拒绝
```

## 证据文件

`linux-node-suite.log`（164/164）、`linux-host-worker.log`（8/8）、`linux-engine-cli.log`（status/import/
snapshot 拒绝/路径泄漏检查）、`linux-engine-unittest.log`（Python 3.8 不满足要求的失败记录）、
`verification.json`（结构化结论）。
