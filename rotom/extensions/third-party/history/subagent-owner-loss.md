# Workflow owner 丢失：第一阶段止损候选

> 历史报告；下文安装状态与采用结论仅指该批。当前默认及旧命令的重放限制见 [历史索引](README.md)。

## 结论与边界

Decision：**PASS（定向止损合同）；整体可靠性仍 INCONCLUSIVE**。Profile：fast + 无模型 host-process smoke。配置：macOS / Node 24.18.0，固定 10 题，模型/thinking 不适用。

本阶段只修 **错误终态与直接恢复入口**：workflow owner PID 消失、过旧或无法确认时，不再凭 PID 补写 `failed`、结束时间和结果文件，而是明确报告 execution unknown。列表保留该任务为 needs-attention 的只读投影，不让一个坏任务隐藏其他健康任务。直接 root resume / stop 经同一 reconciliation 时拒绝继续。

**没有解决孤儿进程自动终止。** 真实 OS fixture 特意证明：父进程 SIGKILL 后，writer 仍可写入；候选只是不再把这一状态伪装成执行已结束。不得称为完整取消/恢复修复、全局写锁或部署完成。

当前产品安装、lockfile、runtime resources 均不变。候选仅为 `subagent-owner-loss-candidate.patch`，与既有 wait patch 分开；没有引入第二个调度器、私有 Pi API 或存活 PID 的盲杀。

## 为什么先止损

上一轮真实 Pi/模型验证发现，异步 script workflow 的 status.pid 就是父会话进程 PID，Pi/Bash writer 可以比它活得更久。`writeFailedRepair` 原本将父 PID 不存在或陈旧直接变成 failed，并制造可用于恢复的结果文件。这不构成 writer 终止证明。

恢复时只拿历史 PID，既无法可靠枚举已经 reparent 的后代，也存在 PID 复用风险。因此本候选不在 observer 中新增自动 kill 或自动重放，而先拒绝不具备证据的终态修复。

## 改动

仅修改隔离上游的两个文件：

- `src/runs/background/stale-run-reconciler.ts`：对 `mode=workflow` 的无结果 stale repair 抛出 `StaleWorkflowExecutionUnknownError`；保留原 status、steps 和 results。已有结果的 repair 路径保持原行为。
- `src/runs/background/async-status.ts`：列表仅捕获这一明确类型的 unknown，展示 needs_attention 与原因，继续展示健康任务；不吞其他错误，不将投影写回磁盘，不对 unknown root 自动 reconcile nested 后代。

直接 `resolveAsyncResumeTarget` 和 `stopAsyncRun` 沿用同一 guard。测试证明该 root resume 不返回新 writer 目标，stop 不发非零信号。**未证明所有 nested/foreground 恢复入口均被覆盖，更不能阻止用户另建 fresh run 写同一目录。**

## 无付费验证

Baseline 为锁定 `pi-subagents@0.52.1`。测试将 published src 复制到本次私有临时目录，可选地仅在副本应用 owner-loss patch；不读真实会话、不启动模型、不访问平台。

10 个固定断言覆盖：

1. owner 已死，不制造 failed/result。
2. 陈旧但 live PID 不等于 writer 终止。
3. EPERM 不等于执行结束。
4. 健康 workflow 正常保持 running。
5. 已存在的权威结果仍走原 repair 路径。
6. legacy single-run repair 保持原行为（不是其安全性证明）。
7. unknown root 不隐藏健康列表项，磁盘状态不变。
8. 直接 root resume 先拒绝 unknown。
9. stop 不对 unverified PID 发信号。
10. 真正创建 owner/writer，SIGKILL 本测试 owner，确认 writer 在 reconciliation 后仍能写入；候选必须拒绝终态 repair。

进程 fixture 用 ready/release 文件握手，有限 deadline；不靠固定 sleep 碰运气。清理 writer 前核对唯一 fixture 脚本路径，只处理本测试创建的进程和目录。

| Gate | 结果 |
| --- | --- |
| 同题 baseline strict | 3 pass / 7 fail，exit 1，0 TODO/skip |
| owner-loss candidate strict | 10 pass / 0 fail，重复两次一致 |
| 隔离上游 typecheck（wait + owner-loss 源码同时存在） | PASS |
| 上游 stale-run / async-resume / async-status-snapshot，清理 PI_SUBAGENT 环境，串行 | 42 pass / 0 fail |
| 既有 wait 定向回归（独立及 wait＋owner-loss 组合候选） | 各 55 pass / 0 fail |
| 本仓 check-personal | 96 pass / 0 fail / 19 个既有历史测试 skip；deterministicGate PASS |

7 个 baseline 失败是新合同断言，不是 7 类用户事故。真实进程 fixture 是 **host-process smoke**，不是完整 Pi loader、真实模型或 UI E2E。本轮无额外评测模型请求；不重报上一轮 token/费用收益。

## 重跑

从 dev-agent Git 根目录运行，需 Node >= 产品最低版本以及已安装的锁定依赖：

```bash
# 故障基线应 exit 1。
SUBAGENT_OWNER_LOSS_STRICT=1 \
  node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-owner-loss-regression.test.mjs

# 候选只应用到一次性源码副本，应 exit 0。
SUBAGENT_OWNER_LOSS_STRICT=1 SUBAGENT_OWNER_LOSS_CANDIDATE=1 \
  node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-owner-loss-regression.test.mjs

# 验证两个隔离补丁组合后仍满足既有 wait 合同。
SUBAGENT_WAIT_CANDIDATE=1 SUBAGENT_OWNER_LOSS_CANDIDATE=1 SUBAGENT_WAIT_STRICT=1 \
  node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-wait-regression.test.mjs
```

不设置 strict 时，baseline 的已知失败会标为执行过的 TODO；exit 0 不代表全部通过。Windows 跳过真实 SIGKILL fixture，不能写成该平台验证通过。

## 仍未完成

- 真正的父失联监护、当前工具 abort、后代进程树收敛及其可验证终态；不能靠本候选阻止已发出的外部写入。
- orphan writer 不结束时，此任务可长期占用 active 状态；需要受控人工核对/retention，而不是自动重试或清理状态文件。
- 已被旧版错误修复为 failed 的记录没有迁移/重新鉴证；single/chain/parallel、已有 result 的 writer 终止证明也未重做。
- 全部恢复路由、真实无模型 Pi SDK 组合、跨 session/多 manager 并发及完整干净环境上游 gate。上一轮上游 wait/control 合同测试仍未迁移，完整 gate 未绿。
- 本候选不进入当前运行时。第二阶段的 [owner lifeline 及无付费 SDK 证据](subagent-lifeline.md)、后续[完整包固定路径验收](subagent-workflow.md)已有有界证据；不响应取消的工具和漏加载 runtime 的 child 仍会继续写入。启动确认、完整恢复及全图终态合同未完成，不能据此上线或自动解除 unknown。
