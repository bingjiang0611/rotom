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

仅供主会话使用；子 Agent 不继续派生。仅使用当前工具 schema 暴露的能力。

## 委派

- 小任务直接完成；只委派边界清晰的检索、独立评审或机械修改。主会话保留需求、方案取舍、连续判断的实现和最终验证，不强制多阶段流水线。
- 工具尚未加载时先用 `search_tools` 搜索 Subagent。角色不确定时用 `subagent` 的 `list`、`get`、`models` 查询，沿用已有角色和模型配置。
- 每个任务写明目标仓库与绝对 `cwd`、只读或可写范围、必要文件/证据、完成标准和返回格式；不同子任务必须有不同职责。
- 检索、评审优先 `context: "fresh"`；只有确需父会话历史时才用 `"fork"`，它会继承历史，不是精简摘要。

## 执行

使用 `subagent` 的 `workflowScript`，不传 `action`。单任务用 `runs.run(key, options)`，串行用顶层 `await`，并行用 `runs.all([...])`，显式 `return` 汇总结果。脚本不要定义嵌套 async 函数。

下例参数传给 `subagent`；先替换仓库路径和任务范围：

```json
{
  "async": true,
  "context": "fresh",
  "cwd": "/absolute/path/to/repo",
  "workflowScript": "return runs.run('scan', { agent: 'scout', task: 'Read src/session.ts and its tests. Do not edit files or launch subagents. Return findings with file/line evidence and gaps.', output: false });"
}
```

- 默认异步；同一 cwd/worktree 只有一个 writer，子任务写入期间主会话也不并发修改。并行写入必须先明确隔离目录。
- 返回后保留 run id，先做独立工作，再消费完成通知；当前轮必须等结果时用 `subagent_wait` 指定 id，不用 sleep 或循环查状态。
- 活跃任务用 `status` 核对、`steer` 补充指令；已结束任务先用 `children.list` 确认可恢复，再 `resume` 最新 run id。不要为同一职责重复启动继承全量历史的 worker。
- 需要暂停/停止时用 `interrupt` / `stop` 指定 id；投递确认、超时或取消请求不证明 writer 已停止，结果未知时先核对原任务，不重放写入。

## 回收

子任务返回结论、文件/行号、改动、检查命令及结果、未验证项和阻塞。主会话核对证据、解决冲突并决定下一步；摘要或评审通过不等于验收。范围、权限或方案有歧义时交回主会话，不能将 `unknown` 写成成功。
