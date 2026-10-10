---
name: pi-subagents
description: |
  Delegate work to builtin or custom subagents with single-agent, parallel,
  scripted-chaining, async, forked-context, and coordinated workflows. Use
  for advisory review, implementation handoffs, and multi-step tasks where a
  single agent should stay in control while other agents contribute context,
  planning, or execution.
---

# Pi Subagents

仅主会话委派，子 Agent 不派生；能力以工具 schema 和当前 scope 为准。

## 委派

- 小任务自己完成；仅委派独立检索、评审或机械修改。主会话负责需求、决策、连续实现和验收，不强制流水线。
- 工具尚未加载时先用 `search_tools` 搜索 Subagent。角色不确定时用 `subagent` 的 `list`、`get`、`models` 查询，沿用已有角色和模型配置。
- 任务写明仓库的绝对 `cwd`、读写范围、必要文件/证据、验收和返回格式；子任务职责不得重复。
- 默认 scoped 使用 `context: "fresh"`，必要上下文写入任务。`fork`、worktree、嵌套、host gate 在 writer 前拒绝，不切换 scope 绕过。`fork` 仅限显式 legacy 配置，会继承父历史。

## 执行

单任务直接向 `subagent` 传 `agent`、`task`，不传 `action` 或 `workflowScript`。先替换示例路径和任务：

```json
{
  "agent": "scout",
  "task": "Read src/session.ts and its tests. Do not edit files or launch subagents. Return findings with file/line evidence and gaps.",
  "async": true,
  "context": "fresh",
  "cwd": "/absolute/path/to/repo",
  "output": false
}
```

只有多步骤或并行编排才用 `workflowScript`，不与顶层 `agent/task/action` 混用。串行用顶层 `await runs.run(key, options)` 和结果 `.output`，并行用 `await runs.all([...])`，显式 `return` 汇总；不定义嵌套 async 函数，不重复启动子任务。

- 显式使用 `async: true`；同一 cwd/worktree 只有一个 writer，子任务写入期间主会话也不并发修改。并行写入必须先明确隔离目录。
- 保留 run id，等待时做独立工作；本轮必须收结果时用 `subagent_wait` 指定 id，不 sleep 或轮询。
- 指定 id 的 `status` 显示任务、关闭证据、恢复拒绝原因和 8 行输出尾部；更多输出用 `view: "transcript"`、`lines`（≤500）。尾部不是全文，preflight 不是启动授权。用 `steer` 指导活跃任务，`children.list` 查看已结束子任务。scoped 仅允许原 Pi-only async run 通过 closure/canonical lease 后 `resume`；workflow/external/retained child 不可恢复，不能换 ID 重跑。
- 需要暂停/停止时用 `interrupt` / `stop` 指定 id；投递确认、超时或取消请求不证明 writer 已停止，结果未知时先核对原任务，不重放写入。

## 回收

子任务报告结论、文件/行号、改动、检查命令/结果、未验证项和阻塞；主会话核验、解冲突并验收。摘要/评审不等于验收；范围/权限/方案有歧义须交回主会话，不能将 `unknown` 写成成功。
