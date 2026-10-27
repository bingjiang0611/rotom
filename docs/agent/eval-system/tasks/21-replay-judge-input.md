# 任务 21 · 回放判定输入只看可读内容（judge v2）

阶段：Phase 4。报告写到 `docs/agent/eval-system/reports/21-replay-judge-input.md`。背景见 `reports/20-replay-original-control.md` 末尾的核验。

## 问题

模型判定的输入，是对最后 6 条消息直接 `JSON.stringify(entry)`，再取**最后** 6000 个字符。代码在 `rotom/evals/scripts/session-replay.mjs` 和 `eval/replay-plan.mjs` 两处。只要最近的消息里有图片或很长的 base64，判定看到的几乎全是不可读的数据。真实点 1 上，同样的输入两次判定，一次判 fail、一次判 unknown，就是这个原因。

## 改法

1. 抽一个共用函数，比如 `replayJudgeContext(entries, budgetChars)`。运行器、prepare 统计和原回复对照三处都用它，保证弹窗里的字符数和实际发送的内容一致。
2. 渲染方式参照后台 judge（`judge-prompt.mjs` 和 `session-data.mjs` 的 `contentText`），只保留可读内容：
   - user 和 assistant 的文本；
   - 工具调用：名字加参数，参数截到合理长度；
   - 工具结果：文本截到合理长度，并标出 isError；
   - 图片和 `data:` URI 替换成 `[图片已省略]`；
   - 长度超过阈值（比如 256 个字符）的连续 base64 段，替换成 `[二进制数据已省略 N 字符]`。
3. 按字符预算从**截断点往前**倒序装入，默认约 12000 字符，直到装满。每段先脱敏再截断，沿用 judge 的做法。期望行为和新回复照常附上。
4. prompt 版本升到 `rotom-replay-judge/v2`，运行记录写版本号。v1 的旧记录照常显示，但列表里标出版本。

## 测试

- 用合成会话测试：最后一条是大图片和长 base64 时，判定输入里不出现 base64，只出现占位符，前面的文本仍然在预算内被装入；预算正好卡在一条消息中间时也不出错。
- 三处调用同一个函数：对同一份输入，prepare 统计的字符数等于实际发送的字符数。
- 脱敏依然在截断前完成：在大字段里藏一个真密钥，不能泄露。
- e2e：模型判定的点在 faux provider 下走 v2 输入，记录里能看到版本号。

## 真实验证

修完后只重跑**点 1**：单臂加 original，重复 2 次。目标是两次的 original 判定一致，而且理由引用的是可读内容。点 2、点 3 不动，留给 bob 自己重标。报告只写结果和标签，不写会话原文。

## 约束

- 只推 `eval/system`。
- 推送前按自查清单自查。
- 完成后 README 第 21 行改成 `in-review`。
