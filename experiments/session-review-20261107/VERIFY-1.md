# 第一轮核验（云端 agent）

核验对象：`ddae22f`（`results/findings.md`、`results/metrics.json`）以及脚本修正 `292aac9`。

## 隐私

- `python3 scripts/audit-public.py --root .`：PASS，0 findings。
- 人工 grep `/Users/`、`/home/`、URL、邮箱：结果文件里没有命中。
- 案例卡只有转述，没有原文、路径或项目名。
- 待维护者确认两处：
  1. `metrics.json` 的 `usageByModel` 里有 `radius/*`、`cc-switch/*` 两组自定义 provider。`cc-switch` 是公开工具；如果 `radius` 是公司内部网关的名字，需要换成占位名。
  2. findings §5 最后一条提到的“Jev 分类器”没有任何解释。如果这是本机私有工具，应该删掉或改成“本地分类器”。

## 脚本修正 `292aac9`

修正合理：按条目时间截窗口、按条目 id 去掉 fork 复制的重复条目、合并 span start/end 的属性，这三处都是我原脚本的真实 bug。goal-state 即使不在窗口内也会推进 `goalPrev`，这个处理也是对的。

## 数字对照

与 `metrics.json` 一致：数据范围；usage 和按模型的 token/费用占比（57.94 / 19.45 / 17.49，74.35% / 24.31%）；工具错误表；loops；compaction；provider 请求延迟、HTTP 状态和错误类别；版本；search_tools、subagent、context_* 和 obs_recall 的计数。

不一致或证据不足：

1. **§2.10 延迟有错。** findings 写 bash p50 2.040s、codemode p50 2.170s、ask_user_question p50 342s / p95 960s。`metrics.json` 实际是：
   - bash p50：trace 0.607s，会话侧 0.378s；
   - codemode p50：0.413s / 0.410s；
   - ask_user_question：trace p50 63.2s，p95 2668s。
   browser_inspect 的 p50 用了会话侧的值，p95 却用了 trace 的值。需要统一取 trace 值重写，并注明来源。
2. **§2.9 对 find_roots 的归因没有证据支撑。** 17 次调用分布在 13 个会话里，失败 14 次。这更像“每个会话的第一次调用就失败”，即环境或权限问题（helper 未运行、辅助功能权限缺失），而不是“调用合同用错”。另外我的分类器在“validation”类里匹配了 `required`，“permission is required”这类错误也会被归进 validation，所以这个类别名本身不可信。需要错误模板（见 TASK-2 第 E 节）。
3. **§2.2 的 bash 1069 次错误不能直接当作工具缺陷热点。** 其中 704 次只是非零退出码，包括 grep 没有匹配、TDD 时测试故意失败等预期结果。
4. 以下数字来自本地阅读，`metrics.json` 无法复核，按“本地证据”接受：
   - Qoder credit unknown 96 条；
   - Reconnecting 出现 9 次；
   - edit 失败后下一步的分布（66 / 30 / 27 / 1）；
   - 纠正关键词误报率 55%–65%。

## findings 漏掉的信号

| 信号 | 值 | 为什么重要 |
|---|---|---|
| 用户只回“继续”类消息 | 892 条用户消息里有 74 条（8.3%） | 直接对应维护者的头号抱怨“停得不对”：停太早 |
| assistant `aborted` / 中断后下一条用户消息 | 55 / 47 | 停太晚：用户只能手动打断 |
| `model_change` 条目 | 921 条，对应 172 个会话 | 每个会话约 5 次，原因不明 |
| `context_edit` 条目 | 2614 | Compaction Offload / SoL-Pi 的实际写入量，可以和 obs_recall 的 50 次调用对照 |
| compaction 摘要大小 | p50 24.7 KB，p95 63.7 KB | 摘要本身偏大 |
| `subagent_wait` 时长 | p90 ≈ p95 ≈ 1800s | 撞上 30 分钟上限；17 次 timeout 很可能都是这个上限 |

这些问题进入第二轮：`TASK-2.md`。
