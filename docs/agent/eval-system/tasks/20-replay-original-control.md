# 任务 20 · 回放加「原始回复」对照 + 真实数据暴露的修复

阶段：Phase 4。报告写到 `docs/agent/eval-system/reports/20-replay-original-control.md`。背景见 `reports/18-first-real-run.md` 末尾的核验。

## A. 原始回复对照（核心）

- 每个回放点的回放，都**默认附带**一个 `original` 臂：取截断点那条原始 assistant 消息（文本加工具调用），用同一条规则或同一次模型判定打分。这一步**不生成**新回复。
- 运行记录里，`arm` 增加 `original` 这个取值；`productDigest` 记为 null；`usage` 只记模型判定的那部分。
- 回放集列表和运行进度里，每个点并排显示：original 的结果、candidate 的结果（配置了基线时再加 baseline）。
- 再给每个点一个结论标签：
  - `caught`：original 失败，candidate 通过。判定抓得住，这个点上已经改进。
  - `still-failing`：original 失败，candidate 也失败。问题还在。
  - `judge-blind`：original 通过。这个点选错了，或者判定抓不住这类错误，要提示 bob 换点或换判定方式。
  - `unknown`：任一边是 unknown。
- 确认弹窗的次数和字符数要把 original 算进去：只有模型判定的点才发送内容，发送的是判定输入，不是整段会话。
- 测试要覆盖：四种标签各有合成样例；original 臂一定不调用生成器；模型判定的 original 臂走同一个判定管道和同一个 prompt 版本。

## B. 修复

1. **脱敏栈溢出。** 一个约 6 MB、以 `eyJ` 开头的长串会让 `jwt` 规则抛 `RangeError`。给 `redaction.mjs` 里所有规则的量词加上限：JWT 每段 `{8,4096}`；私钥块用有界的 `[\s\S]{0,8192}?`；其余规则也按合理长度加上限。加回归测试，覆盖约 9 MB 的 `eyJ…` 输入、约 9 MB 的 base64 输入，以及一个大字段里藏着一个真密钥的情况。要求不抛错，并且真密钥照样被脱敏。judge 和回放共用这套规则，两边都要测。
2. **回放记录 token 用量。** 从生成的 assistant 消息取 `usage`，口径和 judge 记录一致，拿不到就记 unknown。确认结果面板能显示总用量。
3. **每个臂只加载一次产品。** 一次运行里，同一个臂的多个点和多次重复共用同一份已加载的产品；scratch 目录和拦截扩展仍然每次生成单独创建（任务 18 的安全修复不能退化）。e2e 测试继续断言 `SENTINEL` 没有被创建。
4. **基线路径拒绝 symlink**（`resolveReplayBaseline` 加 `lstat`）。

## C. 用真实数据再跑一次（bob 已授权的范围内）

修完后，用 bob 现有的 3 个回放点再跑一次，单臂加 original，重复 1 次。报告只写每个点的三栏结果和结论标签，不写会话原文。

如果出现 `judge-blind`，在报告里给出建议：换哪个判定方式，或者把回放点挪到哪一步。不要自己改 bob 的回放点。

## 约束

- 只推 `eval/system`。
- 推送前按 `executor-checklist.md` 自查。
- 会话内容只放 `~/.rotom/evals/replay/`，报告不含原文。
- 完成后 README 第 20 行改成 `in-review`。
