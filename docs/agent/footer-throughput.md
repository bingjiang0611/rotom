# 底部状态栏：输出速度

内置 footer 在累计输出 token 后显示 `42.6 t/s`，保留一位小数。

- 数值是会话记录中最后一条 assistant 响应的 `usage.output / (durationMs / 1000)`，不是累计 token 除以会话时长。
- 复用 Pi `AssistantMessageEventStream` 的单调时钟计时：包含首 token 等待，不包含后续工具执行。因此这是客户端请求平均输出速度，不是模型纯解码速度。
- 仅完成状态 `stop`、`length`、`toolUse` 且输出 token 和耗时均为正的有限值时显示。失败、取消、pending、deferred、旧记录缺少计时或零耗时均不显示，也不沿用前一条成功响应的速度。
- 在响应结束、记录入会话后更新，不是流式实时计数器。恢复已有计时的会话可以显示；不估算旧记录的耗时。
- 与现有 footer 累计统计一致，读取全部会话条目，不只读取当前分支；窄终端继续沿用现有截断规则。自定义 footer 不受影响。
- 不增加 Provider 请求、不新增持久化字段、不改变 Qoder credits 或美元费用统计。

## 验证

- `test/footer-width.test.ts` 新增 14 个用例，覆盖请求级计算、工具用量不混入速度、完成状态、缺失/无效计时、失败后清除旧值、切换会话及 20/60/93 列宽。
- `packages/ai/test/event-stream.test.ts` 验证复用的计时来源。
- `cd rotom && npm run build:pi && npm run check:pi` 验证隔离构建、相关回归与七包来源合同。
- 当前构建的 CLI 在隔离 HOME、无扩展、离线 PTY（160 列）中恢复三种合成会话：100 output tokens / 2000 ms 显示 `50.0 t/s`；旧记录与失败响应均不显示。三次进程正常退出。

PTY 检查证明当前 CLI 的内容呈现，不是桌面截图或真实 Provider 测速。未执行付费模型调用、npm 发布或替换现有安装。
