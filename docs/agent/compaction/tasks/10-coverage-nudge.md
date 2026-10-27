# 任务 10 · 覆盖不足时续读提示 + 无效样本不再停掉整个回放（零费用）

背景：[09 报告](../reports/09-third-replay.md)里 baseline 读满 120/120、两次触发阈值；candidate 只读 50/120 就回复 READY，未到阈值，按现规则整个 campaign 熔断，剩 16 次没跑。开关在阈值前不改变行为，这是模型偶发偷懒。现规则下 18 次几乎必然遇到一次，campaign 无法完成。

范围：只改 `rotom/evals/`（必要时 `pi-harness.ts` / `pi-harness-lifecycle.ts` 加最小接缝）。模型调用：**无**。`LIVE_AUTHORIZATION` 保持 `null`。不改 fixture、阈值、保留区、工具面、判分、预算上限和 sol-pi。报告写到 `docs/agent/compaction/reports/10-coverage-nudge.md`。

## A. 确定性续读提示（两臂相同）

- 第一阶段模型回复后，如果 `phase1Coverage` 未满，harness 自动再发一条 user 提示，最多 2 次，然后照常进入第二阶段。提示文本固定、两臂逐字相同，只说明还剩多少份没读并要求继续逐份读，例如：`Audit phase is not complete: {n} listed files have not been read yet. Continue reading the remaining files from manifest.json individually, then reply READY.` 不列出具体文件名（避免变成另一种输入差异），不提压缩、卸载、`obs_recall`。
- 续读算第一阶段：覆盖率、`phase1ReadCallsByTurn` 都包含续读期间的读取。metrics 新增 `coverageNudges`（0–2）。
- 接缝要小：例如给 scenario 加一个「某步之后的可选续写回调」，回调从当前分支算覆盖率、返回下一条提示或 `undefined`。现有其它 eval 的行为不变，补测试证明。

## B. 未达阈值改为无效样本

- 运行结束 `thresholdCompactions === 0` 时：该行 `status = "invalid"`，`reason = "threshold-not-reached"`，**不停 campaign**，继续下一次。
- campaign 级熔断：累计无效样本达到 **3** 次时 `halt("threshold-not-reached")`，剩余标 `not-run`。这仍然保护费用（偷懒运行便宜，且请求/token 停止线不变）。
- `decision-ledger-incomplete`、`run-error`、`persistence-error`、预算线等其它熔断不变，仍立即停。
- 不补跑、不替换：无效样本就是那一次的结果，不为它追加额外运行；N 仍按授权计。
- 汇总：成功率、等待时间等只在**有效配对**（同任务同 repetition 的 baseline 与 candidate 都有效）上比较；另列全部已执行运行的原始数字和无效样本数。

## C. faux 证明

1. 偷懒脚本第一次只读 50 份回复 READY，收到续读提示后读完剩下的：覆盖 120/120、`coverageNudges=1`、越过阈值、candidate defer。
2. 顽固偷懒脚本两次续读后仍只读 5 份：`coverageNudges=2`、运行 `invalid`、campaign 继续。
3. 连续 3 次无效：第 3 次之后熔断、剩余 `not-run`、请求不再增加。
4. 两臂续读提示逐字节相同；不偷懒的脚本 `coverageNudges=0`，请求序列与 08 完全一致。
5. 有效配对汇总：构造一组「1 对有效 + 1 次无效」的指标行，汇总只用有效那一对。

## D. 费用

按 09 的真实数字（baseline 完整一次约 20 次请求、54 万合计输入）重估 N=3 的期望和最坏值，对照现有 3,000 次 / 1.4 亿判断是否够用。不调用模型。

## 验收命令（规划者会重跑）

```sh
cd rotom/evals
npx vitest run test/compaction-offload-eval.test.ts
ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE=0 npx vitest run --config vitest.test.config.ts \
  test/compaction-offload-live.test.ts test/compaction-offload-entry.test.ts \
  test/compaction-offload-metadata.test.ts test/compaction-offload-read.test.ts
npm test && npm run typecheck
cd ../..
git diff --check origin/main...HEAD
python3 scripts/audit-public.py --root .
```
