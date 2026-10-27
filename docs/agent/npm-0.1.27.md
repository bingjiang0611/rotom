# npm 0.1.27 发布准备

- 用户明确授权：`@bingjiang0611/rotom@0.1.27`，dist-tag `latest`，access `public`，许可证 `UNLICENSED`。
- 状态：准备中，尚未执行 npm publish；准备记录不表示 registry 已公开，也不表示本机安装已升级。
- 产品来源：最新公开 main 的 `f6497ad22ebb91e308c6798ea2f9dbe1008ff0cd`，在独立干净 clone 中只提交版本与本发行说明。冻结提交 SHA 由 Git 读取并记录在后续产物验证证据中。
- 已执行 `npm run check:pi`，归档与源码/构建器摘要匹配，无须重建 Pi 或修改版本锁。
- 构建、实际 tgz 审计、隔离安装、default/full smoke、check-personal、升级和卸载须全部验证后，才进入用户前台认证与一次 publish 交接。

## 相对 0.1.26 的主要变化

- Pi fork 对齐至 `1.4.0-rotom.2`，保留 Codemode、分类/虚拟模型 API 与原生 MCP；修复压缩后的 deferred-tool 状态和持续执行指令处理，见 [Pi 1.4 迁移](pi-1.4-migration.md)。
- Compaction Offload 在没有 SoL-Pi 配置文件时默认开启：先卸载旧的中等文本工具结果，空间够时推迟摘要，否则走原生摘要；`ROTOM_COMPACTION_OFFLOAD=0` 可关闭。已有用户配置完全替代 rotom 默认，不自动迁移省略的字段；依赖 Observation Pack。回放证据和局限见 [压缩卸载](compaction-offload.md)。
- 默认内置 Context Layers 的分层摘要与只读召回工具；可用 `ROTOM_CONTEXT_LAYERS=0` 关闭。它不同于已移除的 Context Fold，不保证节省费用。
- Goal、Subagent、Ask、Computer Use 的生命周期、恢复和兼容性改进；macOS 后台文本能力仍有目标应用、文本范围和 helper 版本限制，不代表通用 GUI 隔离。
- 加强任务跟进、错误恢复观测和可执行质量检查。测试通过不等于任意真实模型、设备或浏览器路径均已验证。

内置版本由产品合同锁定：Subagent `0.52.1-rotom.11`、Goal `0.54.4-rotom.9`、Computer Use `0.5.1-rotom.2`、SoL-Pi `0.1.0-rotom.5`。本次只递增产品版本，不重新制作这些组件归档。

## 审计与发布边界

初始 tree+history 扫描只有一条身份 finding：`commit:f6497ad22ebb` / `non-noreply-committer` / digest `3c205d8fc749`。已独立核实该提交者恰为 GitHub 官方 `GitHub <noreply@github.com>`，不是个人邮箱。用户明确接受**仅此提交的此条误报**；不修改扫描规则、不重写历史、不扩展为通用豁免。历史扫描仍如实标为 BLOCKED with one accepted false positive，不写成零 finding。

本轮不调用真实模型、不重放付费回放、不自动更新活跃安装。实际 npm 认证、网页确认与发布由用户在自己的前台终端完成；Agent 不接触密码、OTP 或 token。发布后必须核对精确版本、标签、integrity、shasum、可信 URL 和下载字节，核验成功后才写正式发布记录与 tag。审核期间不重复 publish。
