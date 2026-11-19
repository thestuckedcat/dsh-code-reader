# CL-UI-R1 原生右栏与 Demo 同源验收

本轮以 `17607e3` 为重构起点，完成于 2026-11-20（UTC+8）。实际结果为 [verification.json](verification.json)：**49/49**，canonical_demo / snapshot / native_host 均通过，记录的 bundle SHA256 与当前发布文件相符。

- [右栏与聊天并排](host-before.png)
- 同视口 [独立 Demo](reference-same-viewport.png) / [插件内文档](plugin-same-viewport.png)：1586×918，节点位置、形状与颜色一致；不宣称逐像素差分为零。
- [Demo 资源关系图](demo-coupling.png)、[Demo 端到端](demo-flow.png)
- [真实快照资源关系图](snapshot-coupling.png)、[真实快照端到端](snapshot-flow.png)：初始 100% 可读比例，可平移浏览整图，短标签的完整源码通过详情/悬停查阅。

回归日志：[Node 108/108](node-tests.txt)、[Python 331/331](engine-tests.txt)、[Demo 8/8](demo-tests.txt)。Node 客户端的旧主区域假 DOM 断言已迁移为原生壳、模型及真实 Chromium 操作；历史 200 项统计不能作为新版测试总数。

独立审查确认修正：跨仓身份、库边界、组框与定位、锁/生命周期动作、快照/配置隔离、导入异步语义、异步完成保存、busy 互斥；独立复核客户端/模型 25 项通过后，本轮另补 LF 构建回归，最终发布一致性检查通过。

执行命令：仓库根 `node tools/verify-demo-rebuild.mjs`。仅启动并关闭 scratch 中的隔离 DSH/浏览器；本轮没有重启用户桌面宿主。

边界：内置 Demo 的流程含源码复核过的样例配置。真实仓库完整 CFG/路径敏感锁与别名、大仓性能预算重测、用户桌面热更新仍未验证；Host 事件未映射源码分支时界面明确提示尚未投影。详情见 [CL-UI-R1](../../docs/ui-demo-alignment.md)。
