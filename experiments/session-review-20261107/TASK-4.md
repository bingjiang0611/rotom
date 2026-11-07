# 任务书 4：单次即停 error 的稳定错误码（小任务）

先读 `REPORT.md` 的 §1b 和 P0。隐私规则同 `TASK.md` 第 0 节：仓库是公开的，原文、路径、项目名、URL、凭据一律不进仓库，全程只读。

## A. 错误码计数

范围：本窗口（`--now 2026-11-07T05:00:00Z`，7 天）内 57 个 error 停点，也就是用户下一条消息之前、最后一条 assistant 消息 `stopReason=error` 的情况。

对每个停点：

1. 如果 `errorMessage` 匹配 `Qoder: <code>`，记录 `<code>`。这些是代码里定义的固定标识符，可以原样写出。
2. 其他 provider 的错误，记录**稳定模板**：用 `<…>` 替换数字、id、URL、路径、请求 id 和任何上游正文，只保留错误类型或固定前缀。例如 `fetch failed`、`Request timed out after <n>ms`、`stream disconnected before completion`。如果无法确定哪部分是固定的，就记为 `opaque`。
3. 同时记录这个停点之前连续出现了几次 error，取值 `1`、`2`、`≥4`，口径与 `stop-context.json` 的 `consecutiveErrorAttempts` 一致。

输出一张表：

```
| 错误码或模板 | provider | 停点数 | 其中连续=1 | 其中连续≥4 | 其中下一条用户消息是“继续” |
```

## B. 核对重试配置（只读）

读 `~/.pi/agent/settings.json`，如果设置了 `PI_CODING_AGENT_DIR`，就读该目录下的 `settings.json`。只报告 `retry` 字段的值，包括 `enabled`、`maxRetries`、`baseDelayMs`、`maxAgentDelayMs`、`provider.*`。没有这个字段就写“未设置，用默认值”。不要输出其他字段。

## C. 估算 P0 的实际收益

上表中 `catalog_refresh_failed`（以及 `catalog_refresh_required`）出现了几次？这些停点之前，这一轮已经连续运行了多久？优先取 trace，取不到就用会话时间戳，写成分桶：`<1h`、`1–2h`、`>2h`。

## 产出与推送

新增 `results/round4.md`，只提交这一个文件。推送前：

```bash
git diff --check
python3 scripts/audit-public.py --root . --deny-term "<你的用户名>" --deny-term "<主要项目名>"
```

审计 PASS 后，推到 `claude/optimistic-einstein-soq1sd`。推送后回报 commit SHA 和审计的 status 行。
