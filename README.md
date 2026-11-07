# dsh-code-reader

DeepSeek Harness（DSH）插件 + `learn-code-workspace` skill + 本地 Python 引擎，用于 **Linux 驱动与用户态组件的单仓/多仓代码学习**：登记 workspace、受限读取源码、导入已核验的 SDK Code Atlas 0.1 快照、追踪证据路径、保存带预测/观察分离的版本化学习记录。

本仓库是 04-code-learning 能力的首个可安装实现（`CL-IMPL-1`）。设计依据与全部边界见 [`docs/`](docs/)：

- [产品形态](docs/product-form.md)
- [软件设计 CL-DESIGN-2](docs/software-design.md)
- [实施路线与来源](docs/implementation-route.md)
- [首版实施契约](docs/implementation-contract.md)
- [机制说明](docs/mechanisms.md)（交付时补全）
- [使用说明](USAGE.md)

## 状态（2026-11-07）

- **已实现并自测**：workspace 登记/校验、源码只读查找与引用、Atlas 0.1 快照导入与完整性校验、路径/关系查询（含跨仓 `abi_bridge` 候选）、学习记录 CAS/导出/resume 失效、`learn-code-workspace` skill、6 个 DSH Host 工具、安装后注册验证。
- **未声明通过**（需要目标 Linux/Kbuild/固定 Atlas runtime/强制隔离 runner/native CFG）：真实内核索引与编译、编译探针隔离、真实驱动运行时行为。静态证据不证明运行时必达；本版只声称“合成 fixture 上适配与学习流程自测通过”。

## 组成

| 层 | 位置 | 作用 |
|---|---|---|
| DSH Host bundle | `index.js`、`lib/`、`cordis.patch.yml` | 注册 6 个 `code_*` 工具与 skill provider；固定 argv 调用本地引擎 |
| 打包 skill | `skills/learn-code-workspace/` | 阅读顺序、讲解、预测/观察、停止规则；普通问答不强制复盘 |
| Python 引擎 | `engine/code_learning/` | workspace/source/snapshot/paths/bindings/records/invalidation，只用标准库 |
| 合同与 schema | `engine/schemas/`、`docs/implementation-contract.md` | 自有对象 `schema_version=1`；Atlas 对象保持 `0.1` |
| 证据 | `engine/tests/`、`tests/node/`、`evidence/` | 合成 UMD/UAPI/KMD fixture 与负例 |

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
```

安装成功后 Agent 获得 `code_workspace`、`code_overview`、`code_source`、`code_snapshot`、`code_path`、`code_learn` 六个工具和 `learn-code-workspace` skill。详细参数、JSON 形状与安全边界见 [USAGE.md](USAGE.md) 与 [实施契约](docs/implementation-contract.md)。

## 本地验证

```bash
cd engine
python -m unittest discover -s tests -v        # 引擎行为（合成 fixture）
cd ..
node --test tests/node/bridge.test.mjs tests/node/plugin.test.mjs
```

测试只使用合成 fixture，不访问网络、不执行 Atlas/编译器/构建。

## 边界与数据位置

- 模型永远不能指定绝对读取路径、bootstrap、状态目录、Python 解释器或 shell 片段；这些都来自人工/Host 配置与 `state.py` 的签名引用。
- 记录、快照导入副本与导出存本地 `state_dir`；不默认联动 05 长期记忆，不上传。
- 不默认运行 `make`/CMake/编译器/测试；`run` 在无强制隔离执行 profile 时固定返回 `EXECUTION_BLOCKED`。
- 源码含疑似秘密或二进制内容时返回 `ref_only`，不进入模型上下文。

## License

MIT（见 [LICENSE](LICENSE)）。第三方引用与不随仓库分发的来源记录见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、[source.lock.json](source.lock.json)。
