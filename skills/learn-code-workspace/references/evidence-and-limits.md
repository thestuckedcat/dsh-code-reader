# 证据分级与限制

本文件说明 learn-code-workspace 如何区分编译器事实、候选、未知和文本证据，以及在什么条件下不能声称运行时、硬件或布局结论。

## 1. 证据等级

| 等级 | 来源 | 能证明什么 | 不能证明什么 |
|---|---|---|---|
| exact | Atlas `call_targets`（已分析的编译上下文） | 该上下文中 call-expression 解析到目标 | 运行时必达、所有 CONFIG 相同、跨仓调用 |
| may | 派生路径、跨仓 abi_bridge、间接调用候选、Agent/人工标注 | 有静态依据的候选，保留 unknown_target_possible | 唯一目标、真实运行 |
| unknown | 边界、预算截断、缺能力、缺目标 ABI | 明确“不知道”并保留原因 | 不能补成事实 |
| source_text | source-only 的源码文本（origin='source_text'，semantic_status='blocked'） | 选定文本存在，内容 hash 与 byte 区间一致 | 编译语义、调用关系、锁、布局 |

## 2. 不得升级的规则

- 文本证据不得升级为 exact 或编译器事实；不得把 may 候选写成 exact。
- 人工/Agent 桥接最多 may；用户备注也只是 user_note，不回写编译器事实。
- 跨仓 ioctl/ABI bridge 需要两端证据、共享定义、命令值/版本与适用 variant；缺一端即 incomplete，不给可用路径。
- `coverage.failed`、`pending_units`、`truncated` 必须原样呈现；不把部分覆盖当完整。
- 快照 freshness 不是 fresh 时，相关解释只能标为历史或 stale，不能继续当当前事实。

## 3. ABI 与运行时边界

- 字节布局/偏移需要真实目标 ABI（架构、字节序、指针位宽、compat）与布局证据；缺证据记 unknown。
- 静态图不能证明运行时行为、硬件完成、线程重叠、完整 happens-before 或模块实际装载。
- 即使有 runtime 观察，也要区分“观察到一次”和“所有配置必然”；观测不到不等于不存在。
- 注册点/导出符号只证明注册或导出，不证明实际调用、装载或执行顺序。

## 4. 秘密与 ref_only

- 二进制、疑似秘密/凭据/密钥内容返回 ref_only；不进入解释正文、学习记录或导出。
- 只引用 evidence_ref/path_ref；不把原始 compdb、整仓源码或秘密投影发给模型。
- 用户要求时也不自动上传/同步；导出只写本地。

## 5. freshness 与失效

| freshness | 含义 | 动作 |
|---|---|---|
| fresh | 输入摘要与证据重核一致 | 可继续，但仍核对当前问题与 variant |
| stale | workspace revision、BuildIdentity 或证据 hash 变化 | 先重核 safe_cursor，再重走受影响路径 |
| unknown | 输入缺失/不可读，或 revision 变化但摘要相同（保守） | 补证据或请用户确认，不猜 |

静态证据不是运行时行为的证明；任何结论都必须能回到 evidence_ref 与文件/行号。
