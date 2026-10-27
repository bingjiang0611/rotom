# 任务 04 · 规则与人工标注的一致性报告

阶段：Phase 2。模型调用：**无**。报告写到 `docs/agent/eval-system/reports/04-agreement-report.md`。前置：任务 03 已 accepted。

## 目标

bob 标完以后，用一条命令回答两个问题：每条规则和人工判断有多一致；人工归纳的每类失败，现有规则能抓到多少。之后任务 05 的 LLM judge 要用**同一套计算**来验证，所以计算部分要写成通用的：输入是「会话 → 人工 verdict + 若干信号的 hit/clear/unknown」，不能绑死在规则上。

## 交付物

| 文件 | 说明 |
|---|---|
| `rotom/evals/scripts/agreement.mjs` | 纯函数 `computeAgreement(rows)` 和 `renderAgreementMarkdown(result)`；不读文件 |
| `rotom/evals/scripts/agreement.d.mts` | 类型声明 |
| `rotom/evals/scripts/session-cards.mjs` | 新增子命令 `agreement [--out <cards dir>]` |
| `rotom/evals/test/agreement.test.ts` | 合成数据单测 |
| `rotom/evals/README.md` | 在 session-cards 小节补一段用法（≤ 10 行） |

## 输入

`rows = [{ sessionId, verdict, categories, signals: { <name>: "hit"|"clear"|"unknown" } }]`。`agreement` 子命令从 `<out>/../labels.jsonl` 读取，把 `findings` 作为 `signals` 传入。只统计 verdict 为 `pass` 或 `fail` 的行；其它 verdict 计入 `ignoredVerdicts`。

## 计算

对每个信号（排除 `unknown`）：

| | 人工 fail | 人工 pass |
|---|---|---|
| 信号 hit | TP | FP |
| 信号 clear | FN | TN |

输出 `tp, fp, fn, tn, unknown`，以及：

- `precision = TP / (TP + FP)`：命中的会话里，人工确实判 fail 的比例。
- `recall = TP / (TP + FN)`：人工判 fail 的会话里，信号抓到的比例（任务 05 里就是 TPR）。
- `specificity = TN / (TN + FP)`：人工判 pass 的会话里，信号没有误报的比例（TNR）。

分母为 0 时值为 `null`，Markdown 里显示 `n/a`。分母小于 10 时，比例后面标 `(n<10)`，表示样本太少、不下结论。不算 F1，也不合成单一总分。

按类别：对人工标注的每个 category，统计带这个类别的 fail 会话数，以及每个信号在其中 hit 的数量，输出一张「类别 × 信号」的计数表。还要列出**没有任何信号 hit 的类别**，这些就是下一步要补规则或交给 judge 的方向。

## 输出

- stdout：JSON，只含计数和比例，**不含** session id。
- `<out>/../agreement.md`（私有文件，`0600`，路径同样要求在 Git 工作树外）：上面的两张表，再加上每个信号的 FP 和 FN 会话 id 列表，方便 bob 回到对应卡片复核。

## 单测至少覆盖

- 四格计数和三个比例，含分母为 0 和 `(n<10)` 标记。
- unknown 不进四格；非 pass/fail 的 verdict 计入 ignoredVerdicts。
- 类别表和「没有信号 hit 的类别」。
- 新增信号名不需要改代码（用一个规则表里没有的信号名测试）。
- stdout 不含 session id；agreement.md 的权限和 Git 工作树检查。

## 验收命令

同任务 03（定向测试换成 `test/agreement.test.ts test/session-cards.test.ts`）。全量测试允许那 10 项既有失败，不能新增失败。

## 真实数据

bob 可能还没标完。有 `labels.jsonl` 就跑一次，报告里只写行数和各信号四格计数；没有就写「未运行，等任务 02」。不要替 bob 填标注。

## 不在本任务范围

LLM judge、CI、修改规则条件、根据结果自动调整阈值。
