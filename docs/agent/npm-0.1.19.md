# npm 0.1.19 发布准备

- 授权目标：`@bingjiang0611/rotom@0.1.19`，dist-tag `latest`，access `public`，许可证 `UNLICENSED`。
- 状态：已冻结，待构建唯一最终 tgz 并由维护者在前台终端发布；发布与核验结果在验证后记录。
- 基于公开 `main`，独立干净 clone 构建；最终 source commit 由 Git 读取并记录在验证报告中。

## 相对 0.1.18 的变化

- 修复 Qoder legacy（COSY）模型丢失系统提示：`ultimate`、`qmodel_latest`、`smodel` 等 legacy 路由此前只把系统提示放在请求顶层 `system` 字段，服务端忽略该字段，模型看不到 AGENTS.md、skills、cwd 与工具规则。现与官方 CLI 一致，同时把系统消息保留在 `messages` 首位（`0d11ea1`）。
- 真实账号验证（`ultimate`，源码路径，非安装包）：A/B 探针中仅顶层 `system` 时回答 `NONE`（23 prompt tokens），加入 `messages[0]` 后答对仅在系统提示中的口令；经 `buildQoderPayload`/`openQoderStream` 发送 4 万字符项目提示时，0.1.18 三个仅存在于系统提示的事实均答“没有”（70 prompt tokens），修复后全部答对（14998 prompt tokens）。
- Pi fork、Subagent、Goal 与 computer-use 组件版本不变。不迁移活跃会话，不改变本机安装。

## 验证与限制

最终 tgz 须通过独立 HOME/prefix 安装、版本回读、default/full SDK smoke、`check-personal`、从 0.1.18 升级与卸载，以及实际包和 tree/history 隐私审计。执行结果在验证后记录。
