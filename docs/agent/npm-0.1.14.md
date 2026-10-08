# rotom 0.1.14

状态：发行准备，尚未证明 npm 发布成功。用户授权版本 `0.1.14`、dist-tag `latest`；包 `@bingjiang0611/rotom`，access `public`，许可证 `UNLICENSED`。

## 发行说明

- Pi fork 升至 `1.0.4-rotom.0`，保留 rotom 模型选择器、品牌、Qoder Credit、产品更新及压缩/取消定制。
- 默认提供 Codemode；Goal/Ask/Subagent/Browser 等控制工具保持模型直接调用。MCP 不注册或自动连接；Jev 不默认自动路由。
- Qoder 适配新 transcript 的提示词和工具增删；Goal `0.54.4-rotom.6` 适配辅助 usage 与虚拟模型 reviewer。
- 运行时八个包保持固定来源、归档及 installed identity 校验。

源码迁移与非发布候选验证见 [Pi 1.0 迁移](pi-1.0-migration.md)。该页的旧候选摘要不能用于本次正式包。正式发布需对本次冻结 commit 的唯一 tgz 独立验证，再以 registry version/tag/digest 和下载字节一致性确认。

没有真实模型、Chrome/设备或跨平台验收；完整终端交互仍未验证。本机安装须退出存活 rotom 会话后在用户前台终端切换，不热替换本次会话。
