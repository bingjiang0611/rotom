# rotom 0.1.15

状态：发布准备，尚未提交 npm、尚未核验公开结果或切换本机安装。用户明确授权 `0.1.15 / latest`；包 `@bingjiang0611/rotom`，access `public`，许可证 `UNLICENSED`。

## 发行说明

- 内置 Pi fork 升至 `1.0.4-rotom.2`，定向移植上游 1.1.0 的修复，不代表整体切换到上游 1.1.0。
- Codemode 明确异步 helper 的 await 合同，多段文本分隔并独立汇总 console 输出。
- settled 事件新增 aborted；工具执行耗时记录到事件与会话，Bash/PowerShell 恢复后可显示记录值。
- 调整上下文 token 估算，修复长 prompt 的分层计费；离线目录仅更新现有模型的价格，不增加新模型。
- 修复 Bedrock OpenAI reasoning effort、server-busy 重试分类和 Mistral error 终态映射，复用已有有界重试。
- 保留现有分类器/虚拟自动路由移除边界，不启用 MCP 或新增模型能力；产品 Subagent、Goal 与 Qoder 合同不借此升级。

源码范围、兼容性及非发行测试见 [Pi 1.1 backports](pi-1.1-backports.md)。正式交付只接受发布元数据 commit 冻结后构建的唯一 tgz；实际产物安装、smoke、摘要及公开 registry 核验另行记录，不能用此前源码测试代替。

npm 登录与 publish 由用户前台终端执行一次，Agent 不读取凭据。只有 registry version/tag/integrity/shasum、可信 tarball URL 和下载字节全部一致后才算发布完成。npm 自动审核期间不重发；验证公开后才交接全局安装，且不迁移存活会话。
