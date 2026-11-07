# learn-code-workspace 执行手册

本文件是 [SKILL.md](../SKILL.md) 的详细参考：需要状态机、停止规则、证据分级、续读或示例时再读；普通问答不必逐节执行。

## 1. 路径状态机

一条学习路径按下方表格顺序推进。状态和 cursor 通过 `code_learn` save 写入学习记录；未完成字段保持 pending。

| 状态 | 进入条件 | 允许动作 | 退出 |
|---|---|---|---|
| scoped | 已确认 workspace、variant 和一句可复述的问题 | `code_workspace` validate/import，确认 semantic_status/missing_inputs | → mapped |
| mapped | 已看过 `code_overview` 小地图、有入口候选 | 选定一个问题；必要时 `code_snapshot` import | → reading |
| reading | 正在沿一条路径逐边读源码 | `code_source` find/read/evidence；`code_path` 取有界路径 | → explanation_ready |
| explanation_ready | 已有带回文件/行号证据的 3–8 句解释 | 普通问答可在此结束；需要验证时请用户先给预测 | → prediction_pending 或 paused |
| prediction_pending | 已向用户提出一个具体预测问题 | 等待用户预测；绝不代填 | 用户给出预测 → verification_pending；暂停 → paused |
| verification_pending | 有用户预测，准备做最小授权核验 | 只做已授权的只读观察/查询；不自动运行构建或测试 | 有观察证据 → reflected；无法核验 → reflected（unknown）或 paused |
| reflected | 已比较预测与实际观察的差异，或明确记录未核验 | 写 difference、rules、unknowns；`code_learn` save | → paused 或 done |
| paused | 用户暂停或本轮结束，记录已保存或待保存 | `code_learn` resume 时先重核；恢复后回到 reading/explanation_ready | → reading |
| done | K1 能定位判断、K2/K3 无 G/Q 已学够，或用户结束 | 可 `code_learn` export；不再追加新问题 | 结束 |

普通问答允许在 explanation_ready 结束，不强制进入 prediction_pending；只有用户明确说「学完了」或要求「复盘」时才走完整复盘流程。

## 2. 停止规则

- K1：能定位位置并判断关键分支即可，细节可查，不必背下来。
- K2/K3：没有新的 G/Q（缺口/问题）时可以直接停，不把 20 分钟阅读升级为长期课程。
- 预算截断、unknown 边界或语义能力缺失时如实停止，不硬凑结论。
- 用户说“先这样/够了/暂停”时停止；需要时 `code_learn` save 后暂停。
- 每条回答最多一个 Next Action（动作 + 预计用时 + 完成标准），不叠加待办清单。
- 普通问答在给出解释后即可结束，不强制进入预测/核验状态。

## 3. 证据优先级

1. **编译器 exact**：Atlas `call_targets` 已解析目标；仍不证明运行时必达、所有配置相同。
2. **快照结构化事实**：may 候选、unknown_target_possible、coverage 的 failed/pending、预算 truncated 原样保留。
3. **源码文本 source_text**：source-only 模式下 semantic_status=blocked，只证明选定文本存在，不是编译事实。
4. **人工/Agent 桥接**：origin=agent/user_note 最多 may，不升级。
5. **unknown**：证据不足、边界或能力缺失；明确列出，不默认假设。

规则：文本证据与人工标注不得升级为 exact；跨仓 ABI 桥接最多 may，且需要两端证据与共享定义/版本；结构字节布局需要真实目标 ABI 与布局证据，缺证据记 unknown。

## 4. 安全续读

1. 先 `code_learn` resume，读取 freshness、changed_inputs 和 safe_cursor。
2. 先复核 safe_cursor 指向的证据（`code_source` evidence/read 重核 hash、byte 区间、存在性），再谈旧结论。
3. freshness=stale：重建 overview 或导入新快照后重走一条路径；旧行号只作历史导航，不能当当前事实。
4. freshness=unknown：输入缺失或不可读，补证据或请用户确认，不猜。
5. freshness=fresh：可以继续，但仍核对当前问题与 variant。
6. 新结论写新 revision；旧 revision 原样保留，不把旧预测改写成新观察。

## 5. 合成 ioctl 示例（synthetic fixture，不是真实驱动证明）

> **性质声明**：以下使用引擎自带的合成 UMD/UAPI/KMD fixture 演示编排顺序；它不是真实驱动证明，也不证明真实运行时、硬件完成或线程重叠。真实仓库必须重新登记并重跑证据。

场景问题：“用户库提交任务后，驱动如何排队并完成通知？”

fixture 中的关键位置（均为合成文本）：

- `umd/src/job_submit.c`：`job_submit()` 调 `ioctl(fd, JOB_IOCTL_SUBMIT, &local)`。
- `uapi/include/job_ioctl.h`：`JOB_IOCTL_SUBMIT` 由 `_IOW(JOB_IOC_MAGIC, 1, struct job_request)` 定义。
- `kmd/driver/job_queue.c`：`job_dispatch()` 的 `switch(cmd)` 匹配 `JOB_IOCTL_SUBMIT`，经 `job_enqueue()` 调 `queue_work()`；`job_complete()` 作为 work 回调。

推进步骤：

1. `code_workspace` validate：workspace=合成三仓，variant=source-only；semantic_status=blocked、missing_inputs=['compiler_build_context']，明确这是源码解释模式。
2. `code_overview`：给出 umd/uapi/kmd 组件、仓库边界和接口候选 job_submit / job_dispatch（候选，不是运行时入口）。
3. 选一个问题：“JOB_IOCTL_SUBMIT 从 UMD 到 KMD 的静态路径与未知边界”。
4. `code_source` find：在 uapi 中按 literal `JOB_IOCTL_SUBMIT` 查找，得到 path_ref/evidence_ref；read 有界字节区间，得到 source_text 证据。
5. `code_snapshot` import 合成 0.1 快照后，`code_path` 查 from=umd:job_submit 到 to=kmd:job_dispatch：同仓 `call_targets` 给 exact/may；跨仓无编译调用边时为 unresolved/external_boundary，若 binding supported 只给 abi_bridge, certainty=may。
6. 逐边解释：`ioctl` 调用点（exact 编译事实）、命令值宏展开（source_text，需 UAPI 与 KMD 两端核对）、`job_dispatch` switch 分支（exact）、`queue_work` 与 `job_complete`（静态注册/引用候选）；真实 fops 注册、调度时机、线程重叠记 unknown。
7. 先请用户预测：“queue_work 之后 job_complete 会在提交线程内同步执行吗？依据是什么？”用户未回答前 prediction=pending，绝不代填。
8. 最小授权核验：只读 fixture 与已登记证据（例如在 kmd 中定位 file_operations 注册点），不自动运行构建/驱动；有观察证据才写 observation=observed 和 difference，否则保持 pending 并记 unknown。
9. 写 1 条规则（例：“跨仓 ioctl 命令值必须在 UAPI 与 KMD 两端核对同一宏展开与 revision”，status=candidate）与 unknowns（真实 .unlocked_ioctl 指向、硬件完成、线程重叠）；Next Action 至多一条：“约 10 分钟，在 kmd 找到 file_operations 注册点并贴出 file/line 证据”，完成标准可观察。
10. 用户暂停时 `code_learn` save；下次先 resume 重核快照/源码 hash，再继续。

边界：以上编排只说明 skill 应如何组织证据、预测与停止；synthetic fixture 的结果不能外推为用户真实驱动的事实。

## 6. 常见失败与恢复

| 现象 | 处理 |
|---|---|
| 无 bootstrap / workspace 未登记 | 请用户提供本地 bootstrap 与 manifest；不自行扩大读取范围 |
| SCOPE_DENIED | 根未登记，拒绝绕过；请用户走本地登记入口 |
| INVALID_ARGUMENT | 按 error.message 修正参数；不改别人接口 |
| STALE_SOURCE / STALE_SNAPSHOT | 重新 find/read 或重新导入核验后的快照，旧证据只作历史 |
| AMBIGUOUS_SYMBOL | 把 choices 交给用户选择，不静默挑选同名目标 |
| CAPABILITY_UNAVAILABLE / EXECUTION_BLOCKED | 明确告知能力未启用，保留 unknown，不降级伪造 |
| STATE_CONFLICT / OPERATION_CONFLICT | 重新读取 record/generation 与 operation 摘要，不覆盖写 |
| freshness=unknown | 补证据或请用户确认，不猜 |
