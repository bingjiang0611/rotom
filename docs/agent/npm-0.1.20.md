# npm 0.1.20 发布准备

- 授权目标：`@bingjiang0611/rotom@0.1.20`，dist-tag `latest`，access `public`，许可证 `UNLICENSED`。
- 状态：准备中。基于公开 `main`，在独立干净 clone 中构建；最终 source commit 由 Git 读取并记录在验证报告中。

## 相对 0.1.19 的变化

- Pi fork 重建（版本仍为 `1.1.0-rotom.2`，构建摘要更新）：
  - 拆分轮次压缩时，两次摘要请求并行执行，任一失败会中止另一次；`session_compact` 新增每次调用的耗时与首个流事件时间（`summaryCalls`）。
  - 新增可选设置 `compaction.thinkingLevel`。未设置时沿用会话级别，并按模型可用档位收敛。
  - 工具失败结果在 `details.code` 中给出原因，例如 `validation_error`、`tool_not_found`、`aborted`、`command_timeout`、`nonzero_exit`（附 `exitCode`）。模型可见文本不变。
- Observability：压缩期间并发请求记为一个 request span，不再误报 superseded；记录白名单内的工具错误码和退出码；请求结束原因写为 `end_reason`，未验证的副作用不再归因。
- Browser relay：
  - 不可报告的标签 URL 不进入标签列表。
  - owned tab 名称失效时，说明最近一次被移除的路径。
  - 客户端超时改为晚于扩展 deadline 与超时清理之和，扩展返回的有界超时错误可以到达，连接不会被提前断开。
  - 扩展侧代码变化需要重新运行 `install-chrome-relay install` 并在 `chrome://extensions` 重载。
- Codemode：限制嵌套工具调用次数，阻止失控脚本；对只能直接调用的工具给出明确提示。
- Subagent：`pi-subagents@0.52.1-rotom.7` 移除总是失败的 `subagent_supervisor` `send`/`ask`。
- Herdr：集成修订版本可独立更新，不再固定在单一已验证版本。
- 发行：产品包不再包含 `npm-shrinkwrap.json`（npm 12 不再打包或读取它）；`pack:release` 兼容 npm 12 的 `pack --json` 输出。

## 验证与限制

最终 tgz 须通过独立 HOME/prefix 安装、版本回读、default/full SDK smoke、`check-personal`、从 0.1.19 升级与卸载，以及实际包和 tree/history 隐私审计。执行结果在验证后记录。
