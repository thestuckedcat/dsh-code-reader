# 资源变更链 UI 接入计划

目标：按 06531b3 Demo 实现第一版插件使用链路。保持原生右栏和同源 Demo 渲染。

- 状态模型：resource-chains-model.js 校验可恢复关注集、镜头及节点位置；先写失败回归，再实现。
- UI：resource-chains.js 保存函数实例；通信驱动/快照函数同步已有 focusPath，切入时高亮定位。窄栏资源选择可折叠但保留关注摘要。
- 会话桥：client/document.cjs 保存/恢复资源视图状态，不跨来源复用；测试验证实际序列化载荷。
- 验收：重建 index.html 和 bundle/client.js，Node 与 Demo 检查；浏览器操作并保存截图；独立复核后提交推送。

本轮不引入通用锁推理和新的 Host RPC。
