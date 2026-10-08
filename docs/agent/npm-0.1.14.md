# rotom 0.1.14

状态：已发布并核验 `0.1.14 / latest`；registry 的 version、dist-tag、integrity、shasum、tarball URL 与下载字节全部匹配唯一最终 tgz。已全局安装并回读 `rotom 0.1.14` / `Pi fork 1.0.4-rotom.1`。旧候选与命令仍撤销。包 `@bingjiang0611/rotom`，access `public`，许可证 `UNLICENSED`。最终摘要、构建源及验证范围见 [发行证据](npm-0.1.14-verification.json)。

## 发行说明

- Pi fork 升至 `1.0.4-rotom.1`，保留 rotom 模型选择器、品牌、Qoder Credit、产品更新及压缩/取消定制。
- 默认提供 Codemode；Goal/Ask/Subagent/Browser 等控制工具保持模型直接调用。MCP 不注册或自动连接；分类器及虚拟自动路由实现全部移除，保留普通聊天与图片生成。
- Qoder 适配新 transcript 的提示词和工具增删；Goal `0.54.4-rotom.7` 保留辅助 usage 计账，reviewer 使用当前普通模型，不分类或自动选路。
- 运行时八个包保持固定来源、归档及 installed identity 校验。
- Subagent 单任务优先直接传 `agent/task/async:true`；只为多步骤或并行任务使用 `workflowScript`，同步产品 skill 与工具提示。

此前候选曾因 Subagent 修复重新冻结，随后因删除分类器/路由而撤销。本次使用最新公开 main（包含压缩改动回滚，不恢复被撤销的压缩/轨迹实验），以本次发布元数据 commit 为唯一构建源；commit SHA 由 Git 读取，唯一 tgz 摘要及实际安装验证单独记录。此前摘要、命令与验证均不能替代新产物证据。

发布助手改用 npm 全局安装已验证的作用域 tgz，不使用旧无作用域安装脚本。本次认证与 publish 由用户前台终端执行；Agent 只读核验公开结果后，用户明确要求 Agent 直接安装并接受存活会话的热替换风险，Agent 执行一次全局安装并回读版本，未读取用户认证文件或终止会话。

源码迁移与非发布候选验证见 [Pi 1.0 迁移](pi-1.0-migration.md)。该页的旧候选摘要不能用于本次正式包。正式发布需对本次冻结 commit 的唯一 tgz 独立验证，再以 registry version/tag/digest 和下载字节一致性确认。

本次发行没有真实模型、Chrome/设备、完整终端或跨平台验收；当前存活会话仍须重启，不把版本回读冒充运行中会话迁移。后续安装默认仍须先退出存活会话；本次热替换仅为用户明确接受的例外。临时 npm 认证由用户在原前台终端 logout 与删除，Agent 不接触凭据。
