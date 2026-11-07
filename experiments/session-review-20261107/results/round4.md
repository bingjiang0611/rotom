# rotom 会话复盘第四轮：单次即停 error 的稳定错误码

## A. 错误码计数

固定窗口内共有 57 个 error 停点。Qoder 错误使用代码中定义的固定标识符；其他 provider 只保留去敏后的稳定模板。连续尝试次数与 `stop-context.json` 使用同一口径。

| 错误码或模板 | provider | 停点数 | 其中连续=1 | 其中连续=2 | 其中连续≥4 | 其中下一条用户消息是“继续” |
|---|---|---:|---:|---:|---:|---:|
| `fetch failed` | `openai-codex` | 12 | 0 | 1 | 11 | 1 |
| `catalog_refresh_failed` | `qoder` | 9 | 8 | 0 | 1 | 8 |
| `stream_failed` | `qoder` | 8 | 8 | 0 | 0 | 8 |
| `upstream_error_frame` | `qoder` | 6 | 0 | 0 | 6 | 6 |
| `request_failed` | `qoder` | 5 | 5 | 0 | 0 | 4 |
| `authentication error` | `radius` | 4 | 4 | 0 | 0 | 0 |
| `Bad Request` | `openai-codex` | 2 | 2 | 0 | 0 | 2 |
| `Codex SSE response headers timed out after <n>ms` | `openai-codex` | 2 | 0 | 0 | 2 | 2 |
| `invalid_choices` | `qoder` | 2 | 2 | 0 | 0 | 0 |
| `rate limit` | `other-provider` | 2 | 0 | 0 | 2 | 0 |
| `fetch failed (connection timeout after <n>ms)` | `openai-codex` | 1 | 0 | 0 | 1 | 1 |
| `opaque` | `openai-codex` | 1 | 0 | 1 | 0 | 0 |
| `invalid_tool_arguments` | `qoder` | 1 | 1 | 0 | 0 | 1 |
| `service overloaded` | `openai-codex` | 1 | 0 | 0 | 1 | 0 |
| `terminated` | `openai-codex` | 1 | 0 | 0 | 1 | 1 |
| **合计** |  | **57** | **30** | **2** | **25** | **34** |

结论：

- 单次即停的 30 个 error 中，Qoder 固定代码占 24 个：`catalog_refresh_failed` 8、`stream_failed` 8、`request_failed` 5、`invalid_choices` 2、`invalid_tool_arguments` 1。
- `catalog_refresh_failed` 是单次即停中数量最多的单一固定代码之一，并且 9 次里有 8 次需要用户手动回复“继续”。
- 已耗尽至少 3 次重试的 25 个停点以 `fetch failed`、`upstream_error_frame` 和超时类错误为主。
- Jev 对 57 个去敏模板做了辅助分类，其中 15 个判断置信度低于 0.7。最终计数采用确定性模板匹配，不使用 Jev 推断替换固定代码或模板。

## B. 重试配置

`retry`：未设置，用默认值。

因此，本窗口中的行为不是用户级 `retry.enabled`、`maxRetries`、延迟参数或 provider 覆盖造成的。

## C. P0 的实际收益估算

`catalog_refresh_failed` 出现 9 次；`catalog_refresh_required` 没有出现。9 次均能与 trace 中的 operation 时长一一匹配，因此分桶优先使用 trace，而不是会话时间戳。

| 错误码 | 停点数 | trace 匹配 | `<1h` | `1–2h` | `>2h` | 下一条是“继续” |
|---|---:|---:|---:|---:|---:|---:|
| `catalog_refresh_failed` | 9 | 9 | 6 | 3 | 0 | 8 |
| `catalog_refresh_required` | 0 | 0 | 0 | 0 | 0 | 0 |

结论：

1. P0 在本窗口可把 9 次直接终结转换为有界重试机会，其中 8 次已经由用户手动“继续”证明任务仍需推进；现有数据不能证明自动重试一定成功。
2. 只有 3 次发生在连续运行 1–2 小时后；其余 6 次发生在不足 1 小时的 operation。目录 TTL 跨 operation 生效，因此问题不只影响单次超长运行，也会影响目录过期后的短运行或恢复运行。
3. 8 次是第一次 `catalog_refresh_failed` 就停止。另 1 次属于连续 error 已达到 4 次以上，但最终停点代码仍是 `catalog_refresh_failed`。
4. 结合 REPORT.md 已确认的机制，这些失败发生在推理请求发出前。把该固定代码纳入有界重试，可让这 9 个停点都进入重试分支，同时不重放推理请求或工具调用。若重试仍耗尽，应继续返回同一个稳定错误代码。
