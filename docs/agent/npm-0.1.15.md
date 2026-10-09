# rotom 0.1.15

状态：已发布并独立核验 `0.1.15 / latest`。registry 的 version、dist-tag、integrity、shasum、可信 tarball URL 与下载字节全部匹配唯一最终 tgz；已全局安装并回读 `rotom 0.1.15` / `Pi fork 1.0.4-rotom.2`，命令 realpath、包 identity 与 fork build metadata 一致。包 `@bingjiang0611/rotom`，access `public`，许可证 `UNLICENSED`。构建源、摘要和实际产物验证见 [发行证据](npm-0.1.15-verification.json)。

## 发行说明

- 内置 Pi fork 升至 `1.0.4-rotom.2`，定向移植上游 1.1.0 的修复，不代表整体切换到上游 1.1.0。
- Codemode 明确异步 helper 的 await 合同，多段文本分隔并独立汇总 console 输出。
- settled 事件新增 aborted；工具执行耗时记录到事件与会话，Bash/PowerShell 恢复后可显示记录值。
- 调整上下文 token 估算，修复长 prompt 的分层计费；离线目录仅更新现有模型的价格，不增加新模型。
- 修复 Bedrock OpenAI reasoning effort、server-busy 重试分类和 Mistral error 终态映射，复用已有有界重试。
- 保留现有分类器/虚拟自动路由移除边界，不启用 MCP 或新增模型能力；产品 Subagent、Goal 与 Qoder 合同不借此升级。

源码范围、兼容性及非发行测试见 [Pi 1.1 backports](pi-1.1-backports.md)。本次只对冻结的发布元数据 commit 成功构建一次最终 tgz，在空 HOME/prefix/cache、PATH 无全局 Pi 的环境安装并验证版本、default/full SDK smoke、check-personal、0.1.14→0.1.15 升级与卸载。维护测试入口使用干净 clone 的锁定依赖和实际 tgz Pi executable；产品 smoke 则加载实际安装包资源。未用此前源码验证替代发行包验证。

验证准备阶段曾误将维护 smoke 入口视为产品内文件，并缺少维护 clone 的依赖；补齐维护入口与锁定安装后通过，未改产物、未重打包或放宽门禁。没有真实模型、Chrome/设备或跨平台验收。

npm 登录与 publish 由用户前台终端执行一次，Agent 不读取凭据。只有 registry version/tag/integrity/shasum、可信 tarball URL 和下载字节全部一致后才算发布完成。npm 自动审核期间不重发。本次用户明确要求 Agent 直接升级并接受存活会话的热替换风险；Agent 在独立空 npm 配置/HOME/cache 下，对既有 Node 全局 prefix 执行一次固定 tgz 安装，不读取用户认证、不终止会话。版本回读不等于运行中会话迁移，旧会话仍须重启；以后默认仍先退出存活会话，不能沿用本次例外。临时 npm 认证注销及删除仍待用户在原前台终端完成。
