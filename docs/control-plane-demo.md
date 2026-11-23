# 管控面资源关系与调用上下文 Demo

`CL-READ-DEMO-01 / CL-READ-OUTLINE-01` · 更新 2026-11-24。用户纠正默认界面过细：先提取从零搭建业务时的大纲，帮助把控主要阶段并快速进入源码。默认显示五阶段业务骨架，不自动展开资源/锁/条件/证据。原资源详情仍按需提供；本切片不表示已实现通用业务归纳、锁分析或完整管控面索引。

## 打开与确认

打开 `demo/code-view/index.html#control-plane`，或在“资源变更链”的数据来源选择“UBS Engine 管控面 · NUMA 内存借用 · 源码案例”。预览服务器需要从该目录提供页面；`python -m http.server 8876 --bind 127.0.0.1 --directory demo/code-view` 后访问 `http://127.0.0.1:8876/index.html#control-plane`。

默认只看：**接收并分派 → 调度资源 → 登记状态 → 下发方案 → 节点执行与进度更新**。点击一块后列出少量关键函数，再点击函数进入源码。骨架是按源码归纳的业务阶段顺序，不是逐函数调用图，也不证明作者历史思考过程；末端虚线表示异步接续。校验、同步原语及清理留在具体实现与可选详情中。

需要追踪资源时再切到“资源关系”，按以下步骤展开：

1. 在“资源关系”点击 `UbseMemNumaBorrow` 的“发布 · state / expectState”关系，先看资源效果和符号化实例键。
2. 对比共用 `PutResource<ExportObj>(const T&)` 的两处调用：借用流程的业务锁作用域源码可见；`NumaExportUpdateState` 的外层业务保护未知。不能将后者标成无锁。
3. 点击“查看条件与保护”，区分业务键锁、类型账本内部锁和节点 map 内部锁；查询源码依据。
4. 点击“定位调用路径”，在同一画布看已核对的关键步骤及高亮资源效果。该路径不是完整调用树，不补全未知调用者。
5. 点击资源节点查看账本单例入口、字段解释和原始行号；源码页签保留摘录的真实行号、文件哈希和语法配色。

画布复用原有拖动、平移、缩放和规整。总览实体唯一，读边从资源到函数，发布/更新/移除边从函数到资源。关注资源有颜色，背景资源灰淡；移除登记不等于释放物理内存。窄窗口使用可关闭的右侧浮动详情；需要选择被遮住的关系时先关闭详情。

## 来源、状态与范围

- 来源：UBS Engine 上游 `https://atomgit.com/openeuler/ubs-engine`，固定提交 `0f8a279278433914c9bd1d4f3a2c3a40572cc40a`。
- 数据：[control-plane-case.json](../demo/code-view/control-plane-case.json)，5 个业务阶段、5 条资源关系、5 个上下文、19 段人工核对摘录；原始头部、完整 MulanPSL-2.0 许可、文件 SHA-256 与行号随数据保留。页面“来源、范围与许可”可查，另见 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)。
- 本轮仅读取上游文件，不构建或执行管控面；`source_reviewed` 不等于编译器 `exact`，不证明实际线程时序、全路径锁覆盖或设备行为。
- 当前只覆盖所列 NUMA 发布/更新/移除和回调查询片段。回调后续写入/通信、完整生命周期及所有调用者没有自动提取；条件为人工源码归纳。
- 这是第六视图中的独立来源案例，不将其他五视图伪装成完整管控面数据。真实快照模式不能选择此案例；切回通信来源时恢复原画布，案例符号不写入真实 Selection。

## 机制与文件职责

`resource-context-model.js` 根据数据建立唯一实体的关系图、保留上下文并归纳业务保护状态，`contextAccessEdge` 保证读取/写入方向一致。`resource-context-view.js` 负责效果、调用差异、条件/锁和源码的逐层展示；不按仓库名、函数名或成功码决定语义。`control-plane-case.json` 是仓库专属的人工标注输入，`tools/collect-control-plane-demo.py` 核对固定提交、源码片段和哈希后重新生成；它不是通用 C++ 解析器。

依赖已有 [CL-READ-01](repository-understanding-framework.md)、[差距分析](repository-understanding-gap-analysis.md) 和 CL-GEN-01。此切片只验证视图设计与已知数据的呈现，不将 GAP-06/07/08/10/14 等底层能力标为已修复。实现与来源边界必须由插件数据模型/引擎执行，skill 只能调整解释顺序和长度。

## 本轮核验

2026-11-23 历史详情切片见[核验记录](../evidence/control-plane-demo/verification.json)：134 项 Node/Demo 测试、331 项宿主 Python 测试通过，Demo/client 同源检查通过；独立复核了当时的 15 段源码摘录及许可。浏览器实际检查了点击关系、共用实现的上下文对比、条件/两层锁说明、原始源码行号、资源定义、路径定位、来源切换、拖动及规整，保留[效果截图](../evidence/control-plane-demo/effect-contexts.jpg)。该记录保留当时版本与范围，不作为 11-24 业务骨架交互的通过证明。

2026-11-24 骨架修订见[范围记录](../evidence/control-plane-outline/verification.json)：135 项 Node/Demo、24 项阅读指导合同通过，同源构建检查和独立源码复核通过。浏览器观察到初版五阶段骨架及默认关闭详情；随后控制连接中断，最终的小幅高度/文案修订和阶段点击未完成浏览器复核，保留 not_verified。

**接下来该怎么做：** 用约 1 分钟看五阶段骨架，点一个你准备阅读的阶段；完成标准是能找到从哪一个关键函数开始看源码。
