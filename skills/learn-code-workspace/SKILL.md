---
name: learn-code-workspace
description: 在已登记的 Linux 单仓或多仓 workspace 中围绕一个具体问题学习代码，沿源码与快照证据解释调用、数据、生命周期和同步路径，保留证据等级、用户预测与续读状态。
whenToUse: 用户要快速理清或学习某个 Linux 驱动或用户态仓库中的 API、ioctl、调用链或行为时使用；普通代码询问也可以直接用。先登记并选择 workspace 与 variant，再沿一条证据路径解释；不能用来证明运行时行为。
---

# 在已登记的代码 workspace 中学习

围绕**一个具体问题**学习 Linux 驱动与用户态代码：先确认已登记的 workspace/variant，再看小地图，沿一条证据路径读到源码行，给出带回文件/行号证据的解释，并保留事实、候选、未知和用户自己的预测。静态证据不能证明运行时行为。

详细状态机、停止规则、证据优先级、安全续读和合成示例见 [references/workflow.md](references/workflow.md)；证据分级与 ABI 边界见 [references/evidence-and-limits.md](references/evidence-and-limits.md)。

## 何时使用

- 用户说“学习/理清/追踪/这个函数做什么/从 A 到 B 发生了什么”，且涉及已登记的单仓或多仓代码。
- 用户已给出具体问题（API、ioctl、调用链、对象生命周期、错误或同步路径），需要能回到源码的解释。
- 普通代码问题也可以直接问：先直接回答，不强制完整记录，也不要求先做测验或复盘。
- 不用于：证明运行时行为、硬件完成、线程重叠或字节布局（见“证据与边界”）。

## 可用工具

工具返回单个 JSON 对象；参数以工具 schema 为准，下面是典型参数。域内失败返回 `{ok:false,error}`，按 `error.code` 处理（见 workflow 的失败恢复表）。

| 工具 | action | 典型参数 | 用途 |
|---|---|---|---|
| `code_workspace` | import / validate / status | manifest、expected_revision、operation_id；workspace | 登记或校验 workspace；首次登记 expected_revision=0 |
| `code_overview` | — | workspace、variant、可选 snapshot | 组件、仓库边界、接口候选和 unknown 边界的小地图 |
| `code_source` | find / read / evidence | workspace、repo、relative_glob、literal 或 filename；path_ref、expected_sha256、byte_start/byte_end；evidence_ref | 有界查找/读取源码，取得 source_text 证据 |
| `code_snapshot` | import / status | workspace、variant、repo、snapshot 名称、operation_id；snapshot | 导入已核验的 Atlas 0.1 快照，查看覆盖与 freshness |
| `code_path` | path / relation | workspace、variant、from、to、budget、max_depth、direction；snapshot、mode、selector | 取有界路径或关系查询（flow/locks/aliases） |
| `code_learn` | save / get / resume / export | workspace、draft、expected_generation、operation_id；record；format=markdown 或 json | 保存/读取/续读/导出学习记录（导出仅在用户要求时） |

## 标准工作流

1. **登记/校验**：`code_workspace` 先 validate；未登记时 import。确认 workspace、variant、semantic_status 和 missing_inputs；source-only 也能开始读源码。
2. **概览**：`code_overview` 取组件、仓库边界、接口候选和 unknown 边界；先给用户小地图和可选入口，不猜运行时入口。
3. **选一个问题**：只确定本轮一个具体行为作为目标，不把整个仓库当课程。
4. **一条证据路径**：需要结构化证据时先用 `code_snapshot` 导入已核验快照，再用 `code_path` 取一条有界路径；逐边用 `code_source` 读有界源码片段。
5. **解释**：用文件、行号和 evidence 引用说明对象/生命周期、关键数据和失败边界；3–8 句，先讲机制再讲代价。
6. **先预测**：要进行验证时，先请用户给出一个具体预测；用户没给就保持 pending，绝不代填。
7. **最小授权核验**：只做用户已授权的最小只读观察或查询；没有证据就保留待验证，不自动运行目标构建或测试。
8. **规则与未知**：留下 1–3 条可迁移规则（candidate 或 supported）和未解问题；不把推测写成事实。
9. **记录或停止**：用户要保存或暂停时用 `code_learn` save；没有剩余价值时直接停。普通问答可只解释并在此结束，不必创建完整记录。

## 复盘（完整流程）

只有用户明确说「学完了」或要求「复盘」时，才进入完整复盘：Knowledge → Level/Nature → Mental Model → Prediction → Experiment → Observation → Difference → Rules → Question → Decision。未完成字段保持 pending；用户自己的预测、观察和“已理解”只能由用户提供，绝不替用户写。

普通问答不触发这个流程，也不需要为了“完整”补题或补记录。

## 证据与边界

| 等级 | 含义 | 可以说什么 |
|---|---|---|
| exact | 编译器证据（Atlas `call_targets` 已解析目标） | “该编译上下文解析到……”；仍不等于运行时必达 |
| may | 候选：派生、桥接、间接调用或 Agent/人工标注 | “候选/可能”，保留 unknown_target_possible |
| unknown | 证据不足、预算截断或语言/系统边界 | 明确列出未知，不猜测 |
| source_text | 源码文本证据（source-only 模式，semantic_status=blocked） | 只证明选定文本存在，不是编译事实 |

- 文本证据不得升级为 exact 或编译器事实；人工/Agent 桥接最多 may。
- 证据优先级：编译器 exact > 快照结构化事实（保留 may/unknown/coverage）> source_text 文本证据 > 人工备注；未知不靠猜补齐。
- 没有证据的观察不写 observed（observation 必须有 evidence_refs，experiment 必须 executed）；Agent 的 mental_model 不能写成用户已复述。
- 没有目标 ABI 证据时，不声称字节布局、线程重叠、硬件完成或运行时必达。
- `ref_only`：二进制或疑似秘密内容不进入解释正文；只在需要时引用 evidence_ref。秘密、凭据、token 不写进解释、记录或导出。

## 下一步与停止

- 每条回答最多给一条 **Next Action**，必须同时包含：动作（做什么）、预计用时（分钟）、完成标准（可观察结果）。
- K2/K3 在没有 G/Q 时可以直接停；没有新的可迁移规则或问题时也停。
- 暂停前用 `code_learn` save 保存 cursor；下次先 `code_learn` resume 重核证据再继续。
- 只在用户明确要求时导出 markdown/json；不自动上传或同步。
- 不自动运行目标仓库的构建、测试或设备命令；不自动写 05 长期记忆。capability 05 只在用户明确要求时通过正式导出交接，本 skill 不直接调用。

## 续读与失效

- 源码、构建配置或 CONFIG 变化后，先用 `code_learn` resume 重核证据，不要沿用旧结论；旧行号只作历史导航。
- freshness=stale 时先复核 safe_cursor 指向的证据，再重走受影响路径；freshness=unknown 时补证据或请用户确认，不猜。
- 保存新 revision，不覆盖旧记录；旧记录保留原样，不能就地改写成“已验证”。

## 不要这样做

- 把 may 候选说成 exact，或把 source_text 当编译事实。
- 用户没给预测就写“用户预测……”或“用户已理解”。
- 一条回答给多个 Next Action，或把阅读升级成长期课程。
- 普通问答强行建完整记录、先出题或要求填模板。
- 还没核验就声称运行时、硬件或线程行为已验证。
- 擅自运行构建/测试、擅自写入 05 长期记忆或导出上传。
