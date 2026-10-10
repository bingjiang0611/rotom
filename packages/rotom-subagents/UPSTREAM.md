# 来源与维护责任

- 原项目：<https://github.com/nicobailon/pi-subagents>
- 历史测试参照 commit：`afa22c811f81883acdb248c84f116ac7534e2fb4`。
- 原许可证：MIT；`LICENSE` 保留 `Copyright (c) 2026 Nico Bailon`，未改写归属。
- 直接导入：`pi-subagents@0.52.1-dev-agent-owned-flat.7`，维护提交 `8fdfcfc`。
- 原归档 SHA256：`89a2ff72d0615becb937ee28eac54efcbcab2983ab7e29d4a50fe11f2c7ed9c6`。
- 初始 213 TS 摘要：`d01b37e59e17abb0f95e5d123ba59d33f903e5176fb29fb9f798373477c77826`（排序相对路径、NUL、原字节、NUL）。
- `IMPORT.json` 固定原始 248 文件摘要，是历史来源记录，不是要求未来源码永久不变的 gate。

该导入已经包含 rotom 维护补丁：取消/owner lifeline、受控 POSIX process group、durable writer/controller/foreground roster、scope/store/session lease 身份、flat admission、public bootstrap、startup wait/auto-drain 与历史关闭证明分离。不是未经修改的上游原版；旧补丁及各批失败证据仍在仓库维护目录，当前实现不再通过它们生成。

源码内化这一批不改变 213 个 TS 的运行行为；只新增维护脚本、测试/依赖锁与来源说明，替换 package metadata 和维护 README。原 README 移至 `docs/upstream-readme.md`。初始内部版本为 `0.52.1-rotom.0`；npm package name、public exports、内部 resource/protocol IDs 继续使用 `pi-subagents`。Pi 依赖仍来自公开 npm 包，未复制 Pi 生命周期或私有 API。

本地问题由 rotom 维护者负责，不把自有修改的问题自动转给上游。没有自动同步上游的任务；安全公告、许可证变化和公开 Pi/Node 兼容更新仍需人工检查、选择性合入、说明来源并回归验证。

在 `0.52.1-rotom.1`，仅 `worker`、`scout`、`reviewer` 三个内置 agent 增加显式空 extensions 和 fresh 默认上下文；worker 的继承上下文说明同步修正。工具列表、模型与 213 TS 未改；用户/项目显式 overrides 仍走原生解析，不静默修补不兼容配置。

在 `0.52.1-rotom.3`，rotom 的共享 child launch plan 显式加载所选 Qoder 模型需要的产品 provider；路径来自已验证 launcher，扩展禁用和工具 ceiling 保持权威。同步、异步、workflow 与 preflight 同步 extension identity；不回退模型、不继承 ambient 扩展。此为 rotom 自有集成修复，不来自上游。

在 `0.52.1-rotom.5`，将 `.4` 之后的终态投影修复固化到新归档：投影失败保持 unknown，保留关闭证据及诊断，不伪造成功或授权重放；旧归档与存活会话不修改。

在 `0.52.1-rotom.4`，删除上游 schedule manager 与其 executor/selector，以及 goal-mission driver；启动/完成不再扫描或同步 mission observer。旧 schedule 与自动 goal-mission 路径即使在 legacy scope 也不再执行，不删历史记录。保留共享 mission helpers、历史 reader、project-panes API 与 fleet 依赖的 inspector 实现，未将整套模块盲目删除。async status 改为复用实际 resume preflight 和有界 transcript reader；诊断不是启动授权，不改变 canonical lease、关闭或业务效果边界。字段说明与重复提示由产品 wrapper 收敛。此批是 rotom 自有删减与诊断改进，不来自上游。

其余上游文档/agents/prompts 暂时保留以避免与功能裁剪混杂。这些资源的存在不是当前 rotom 产品启用能力的证明；只有产品 policy、显式 scope 合同和对应验证决定可用范围。
