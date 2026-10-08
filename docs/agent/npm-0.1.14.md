# rotom 0.1.14

状态：发行暂停；用户已确认未执行 publish。此前冻结候选及其发布命令已撤销，不得复用。用户授权版本 `0.1.14`、dist-tag `latest`；包 `@bingjiang0611/rotom`，access `public`，许可证 `UNLICENSED`。

## 发行说明

- Pi fork 升至 `1.0.4-rotom.1`，保留 rotom 模型选择器、品牌、Qoder Credit、产品更新及压缩/取消定制。
- 默认提供 Codemode；Goal/Ask/Subagent/Browser 等控制工具保持模型直接调用。MCP 不注册或自动连接；分类器及虚拟自动路由实现全部移除，保留普通聊天与图片生成。
- Qoder 适配新 transcript 的提示词和工具增删；Goal `0.54.4-rotom.7` 保留辅助 usage 计账，reviewer 使用当前普通模型，不分类或自动选路。
- 运行时八个包保持固定来源、归档及 installed identity 校验。
- Subagent 单任务优先直接传 `agent/task/async:true`；只为多步骤或并行任务使用 `workflowScript`，同步产品 skill 与工具提示。

此前候选曾因 Subagent 修复重新冻结；最新候选又因用户要求删除分类器/路由而撤销。须先完成本次功能改动及验证，再重新冻结公开 commit、构建并独立验证唯一最终 tgz；此前摘要、命令与验证结果均不能替代新产物证据。

源码迁移与非发布候选验证见 [Pi 1.0 迁移](pi-1.0-migration.md)。该页的旧候选摘要不能用于本次正式包。正式发布需对本次冻结 commit 的唯一 tgz 独立验证，再以 registry version/tag/digest 和下载字节一致性确认。

没有真实模型、Chrome/设备或跨平台验收；完整终端交互仍未验证。本机安装须退出存活 rotom 会话后在用户前台终端切换，不热替换本次会话。
