# npm 0.1.19 发布准备

- 授权目标：`@bingjiang0611/rotom@0.1.19`，dist-tag `latest`，access `public`，许可证 `UNLICENSED`。
- 状态：已发布并独立核验 `0.1.19 / latest`。registry 的 version、dist-tag、integrity、shasum、可信 tarball URL 与下载字节全部匹配唯一最终 tgz；构建源及验证见 [发行证据](npm-0.1.19-verification.json)。未改变本机全局安装。
- 基于公开 `main`，独立干净 clone 构建；最终 source commit 由 Git 读取并记录在验证报告中。

## 相对 0.1.18 的变化

- 修复 Qoder legacy（COSY）模型丢失系统提示：`ultimate`、`qmodel_latest`、`smodel` 等 legacy 路由此前只把系统提示放在请求顶层 `system` 字段，服务端忽略该字段，模型看不到 AGENTS.md、skills、cwd 与工具规则。现与官方 CLI 一致，同时把系统消息保留在 `messages` 首位（`0d11ea1`）。
- 真实账号验证（`ultimate`，源码路径，非安装包）：A/B 探针中仅顶层 `system` 时回答 `NONE`（23 prompt tokens），加入 `messages[0]` 后答对仅在系统提示中的口令；经 `buildQoderPayload`/`openQoderStream` 发送 4 万字符项目提示时，0.1.18 三个仅存在于系统提示的事实均答“没有”（70 prompt tokens），修复后全部答对（14998 prompt tokens）。
- Pi fork、Subagent、Goal 与 computer-use 组件版本不变。不迁移活跃会话，不改变本机安装。

## 验证与限制

最终 tgz 须通过独立 HOME/prefix 安装、版本回读、default/full SDK smoke、`check-personal`、从 0.1.18 升级与卸载，以及实际包和 tree/history 隐私审计。执行结果在验证后记录。

## 发布结果

最终 tgz 已通过上述全部安装包门禁（314 产品测试、87 Goal 测试、default/full smoke、0.1.18→0.1.19 升级与卸载、实际包与 tree/history 审计），并以实际安装包的 Qoder 代码用真实 `ultimate` 账号复核修复，详见验证 JSON。全局 npm 12.2.0 的 `pack --json` 返回对象而非数组，`pack:release` 因此在产物生成前失败；改用与 0.1.18 相同的隔离 npm 11.13.0 后成功打包一次。npm 登录和 publish 由维护者在前台终端执行，Agent 未读取凭据。
