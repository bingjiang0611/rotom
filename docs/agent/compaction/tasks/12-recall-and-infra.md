# 任务 12 · 召回归属、错误类别、单次请求错误不停回放、按任务授权（零费用）

背景：[11 报告](../reports/11-fourth-replay.md)拿到了 6 个有效配对，但 `multi-file-fix` 没有数据：第 13 次运行里一个 provider 请求出错、usage 为 0，按现规则整个 campaign 以 `usage-unknown` 熔断。另外召回只计了次数，不知道归属哪次推迟、取回是否成功；错误原因也没有留下任何类别。

范围：只改 `rotom/evals/`。模型调用：**无**。`LIVE_AUTHORIZATION` 保持 `null`。不改 fixture、prompt、续读模板、工具面、阈值、保留区、判分、sol-pi。报告写到 `docs/agent/compaction/reports/12-recall-and-infra.md`。

## A. 召回归属（metrics，只存元数据）

每次 `obs_recall` 调用记一条：`{ turn, offloaded: boolean, offloadIndex: number | null, resultError: boolean }`。`offloadIndex` 是该 ID 所属卸载记录在当前分支里的序号（第几次 defer），未卸载的为 `null`；`resultError` 取对应 toolResult 的 `isError`。不存 ID、参数或返回正文。faux 覆盖：两次 defer 后分别召回各自批次的 ID、召回未卸载 ID、召回出错。

## B. 错误类别（allowlist，不存正文）

assistant 消息 `stopReason` 为 `error`/`aborted` 时，在 metrics 记 `errors: [{ turn, stopReason, category }]`。`category` 只能取固定枚举：`timeout`、`connection`、`rate_limit`、`http_4xx`、`http_5xx`、`stream_terminated`、`other`，由错误文本在内存里匹配得出，匹配后丢弃原文。预算器包装层自己合成的「Replay stream failed」也归为 `stream_terminated`。faux 用合成错误文本覆盖每个类别和 `other`，并断言输出里不含原文。

## C. 单次请求 usage 未知：悲观计费，不停回放

- 某次请求 usage 未知时，预算器按**该模型的 `contextWindow`** 计入 input（单次请求的输入上界），`usageKnown` 标记照样置 false，并新增累计字段 `pessimisticRequests`。**不再 `halt("usage-unknown")`**。
- 该次运行若因此未完成：`status = "failed"`，`reason = "provider-error"`，不补跑、不替换。
- 把「无效样本」计数扩展为「不可用样本」：`invalid` 与 `provider-error` 合计达到 **3** 次时熔断（`halt` 用原来对应的原因，最后一次是哪种就写哪种）。
- 输出 token 没有上界，报告与 summary 里要明确 output 是「已记录小计」。
- 其它熔断不变：`decision-ledger-incomplete`、`persistence-error`、`model-mismatch`、预算线立即停；`run-error`（harness 自身异常，不是 provider 错误）仍立即停。执行者需在报告里说明如何区分 provider 请求错误与 harness 异常。
- faux：一次请求出错 → 计入 contextWindow、该运行 failed/provider-error、campaign 继续；两次 provider-error + 一次 invalid → 熔断；悲观计费使输入线提前触发时按 `input-limit` 停。

## D. 按任务授权

- `ReplayAuthorization` 增加可选 `tasks: string[]`。设置后，环境变量 `ROTOM_EVAL_COMPACTION_OFFLOAD_TASKS`（逗号分隔）必须与之逐项一致，否则启动即报错、不发请求；未设置 `tasks` 的授权行为不变（跑全部任务，且不允许设置该环境变量）。
- 只跑选中任务，执行顺序、两臂交替与 repetition 规则不变。
- 测试：匹配、不匹配、授权无 tasks 却设了环境变量、授权有 tasks 却没设环境变量。

## E. 费用预估

按 11 的真实数字（每次完整运行约 13–29 次请求、23 万–80 万合计输入）估算「只跑 multi-file-fix，N=3，6 次运行」的请求数与合计输入，含一次悲观计费的影响，给出建议停止线。不调用模型。

## 验收命令（规划者会重跑）

```sh
cd rotom/evals
npx vitest run test/compaction-offload-eval.test.ts
ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE=0 npx vitest run --config vitest.test.config.ts \
  test/compaction-offload-live.test.ts test/compaction-offload-entry.test.ts \
  test/compaction-offload-metadata.test.ts test/compaction-offload-read.test.ts test/compaction-offload-coverage.test.ts
npm test && npm run typecheck
cd ../..
git diff --check origin/main...HEAD
python3 scripts/audit-public.py --root .
```
