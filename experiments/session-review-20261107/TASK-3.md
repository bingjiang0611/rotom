# 任务书 3：确认 error 与 aborted 停点的来源（小任务）

先读 `REPORT.md` 第 1、4 节。隐私规则同 `TASK.md` 第 0 节：仓库是公开的，原文、路径、项目名、URL、凭据一律不进仓库，全程只读。

## A. 重跑停点统计

`stop-context.mjs` 已更新，新增两个字段：

- `prevErrorCategory`：停点错误正文的本地正则归类，只输出类别名，不输出正文；
- `consecutiveErrorAttempts`：停之前连续出现的 error 尝试次数（分桶）。

```bash
node experiments/session-review-20261107/stop-context.mjs --days 7 --now 2026-11-07T05:00:00Z \
  --out experiments/session-review-20261107/results/stop-context.json \
  --samples "$TMPDIR/rotom-stop-samples.json"
```

报告以下数字：

- `byKind.*.prevErrorCategory` 与 `consecutiveErrorAttempts`，所有类别合计；重点看 `bare_continue`。
- 在 error 停点中，有多少次 `consecutiveErrorAttempts` ≥ 4，即 3 次重试都已耗尽？有多少次只有 1 次 error 就停了？后者说明错误不可重试，或者重试被跳过了。

## B. aborted 的来源（读样本）

从 `bare_continue` 前一条为 `aborted` 的 22 个停点中至少读 12 个，另加 `other` 类中前一条为 `aborted` 的 5 个。每个样本判断中断来源：

- `U` 用户主动按停：前后能看到用户插话、Esc 的痕迹，或者用户随后说明了原因；
- `C` 中断前紧挨着一次 compaction，或一次 `context_compress` / 扩展触发的压缩；
- `X` 扩展或工具触发：前后有扩展的 custom 条目、子 agent 控制通知等；
- `P` 进程或会话结束：之后是一次新的启动（例如出现 `model_change` 或 `thinking_level_change` 这类启动条目），中间间隔很长；
- `?` 无法判断。

同时把这些 aborted 消息的 `errorMessage` 归并成模板（具体值替换为 `<…>`），报告每个模板的次数。如果正文为空，就记为 `empty`。

## C. toolUse 停点

一共 17 次：`bare_continue` 5 次、`other` 11 次、纠正 1 次。这些停点的最后一条 assistant 消息停在工具调用上，后面没有结果和收尾。读其中 5 个，判断是进程崩溃或退出、用户关闭终端、工具一直挂住，还是其他原因（写一句话转述）。

## 产出与推送

- 更新 `results/stop-context.json`。
- 新增 `results/round3.md`，三节对应上面的 A/B/C，每节先给数字再给结论；最后一节写“对 REPORT.md P1 范围的影响”：P1 是否需要覆盖非用户 abort，以及是否有不可重试的 error 也该续跑。

推送前：

```bash
git diff --check
python3 scripts/audit-public.py --root . --deny-term "<你的用户名>" --deny-term "<主要项目名>"
```

审计 PASS 后，只提交 `results/` 下的文件，推到 `claude/optimistic-einstein-soq1sd`。推送后回报 commit SHA 和审计的 status 行。
