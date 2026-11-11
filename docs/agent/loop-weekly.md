# 每周检查合同

固定步骤见 [优化循环 §⑥](optimization-loop.md#⑥-账本与节奏)。本节保留报告字段与验收统计细节。

建议节奏：

- **每周**：`loop weekly`。它自己跑 28 天 harvest，写 `~/.rotom/loop/weekly-<YYYY-MM-DD>/`（`report.md` + `summary.json`，0700/0600，不入 Git）。四段内容：
  1. North Star v2 总计、按模型、按产品版本（每行带 95% Poisson 区间和去掉最大一次会话后的敏感度列）；
  2. 默认模型对照实验：**只**给每条臂的会话数与遵守率，窗口关闭前不给结果指标（类型里没有这些字段），判定只在窗口关闭后按预注册规则读；
  3. 每条 `decision=shipped` + `evidence=unmeasured` 的记录：用它自己的 `acceptance` 只看验收起点之后的数据，给 `improved / no-change / worse / insufficient-exposure / no-metric`；没声明指标报 `no-metric`，不猜。暴露量 = 基线速率预测出 10 个事件的 turn 数，预先登记且由 `loop ledger` 校验；没到量只报 `insufficient-exposure`。到量后用单侧精确泊松检验（alpha 0.05），`no-change` 只表示没显出差异，并给出还差多少天。机制记录还登记“首个包含该修复的提交”（`acceptance.firstCommit`）：只有会话自己记录的 build commit 是该提交或其后代（`git merge-base --is-ancestor`）时才计入 turn；没有 build commit 的会话一律 unknown，另报条数。release 标签是从会话文本里匹配出来的，不再参与验收。`loop versions` 用同一份 harvest 打印产品版本时间线（谁切换的未知）；
  4. 按 provider 的“用户可见失败/100 turns”，以版本切换时刻分为 before/after 两段；失败归到其会话所在的段。

  切换时间与对照窗口写在 `rotom/evals/loop/weekly.json`。看完报告再决定要不要深度分诊某条记录；不因为新数字改判定规则。
- **实验窗口与暴露期内**：每周只跑一次 `weekly`，只做一个聚焦修复。窗口开着时不看任何一组的结局指标，暴露期没走完的记录只报 `insufficient-exposure`，都不构成开大轮的理由。**大轮只在两种情况下开**：出现新的可复现失败，或某条记录的暴露期走完。
- **每次相关改动**：`gate`。改 coding-policy、工具描述或续跑/停止逻辑之前先跑 `loop replay-gate --product <候选产品>`：只要有一条用例在候选上仍然失败，这次改动就不该进下一轮。用例与检查只存本机 `~/.rotom/loop/replay-cases/`（0700/0600，不入 Git），`gate.json` 的 `replays` 只登记 id、`kind: "replay"` 与脱敏摘要；产品没启动或没跑完记 `unknown`，不算通过。
- **每次发版**：`gate` + 记录当周介入率；Terminal-Bench `release-smoke` 接入 Linux 容器后加入发版检查（见 `rotom/evals/README.md`）。
