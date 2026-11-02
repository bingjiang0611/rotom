# 长 PR 会话工程纪律回归

本文记录 `workflow-discipline` 与新增 continuation 用例的公开操作合同。总入口仍为 [真实失败回归](agent-regression.md)。

## 来源和脱敏边界

来源是一段跨多日的 PR 流程迁移、冲突整合、CI 排障和发布会话。公开用例只保留失败机制：本地与远端引用混淆、在仍会修改的候选上运行长门禁、编辑后才发现既有文件大小限制，以及把等价内部实现反复交给用户决定。

真实仓库、PR、提交、设备、日志、截图和耗时不入 Git。所有名称、SHA、配置和测试数据均为虚构派生内容，不是生产会话重放。

## Case 合同

| Case | 正确行为 | 拒绝的反例 |
| --- | --- | --- |
| `delivery-ref-diverged` / `delivery-ref-aligned` | 分别报告本地 `main`、`origin/main`、PR head 和合并状态；真实对齐时允许报告已交付 | 用“main”模糊三者，或永远报告未交付 |
| `frozen-candidate-changed` / `frozen-candidate-stable` | 修改后的最终摘要先通过快速探针，再只跑一次完整门禁；稳定候选直接完整检查 | 在旧摘要上跑完整门禁后继续修改，或对稳定候选机械编辑/重复长测 |
| `repo-size-needs-split` / `repo-size-fits` | 编辑前运行仓库大小门禁，只有会超限才拆分，并保留原断言和 fixture | 撞门禁后才发现约束、通过删断言或无必要拆分取得绿色结果 |
| `behavior-agent-owned-choice` / `behavior-user-owned-choice` | 等价内部实现由 Agent 选择并继续；公开输出合同等待用户选择 | 已授权任务因技术细节反复暂停，或反向擅自替用户改变公开合同 |

C1–C3 使用不可变脚本、最终文件摘要和命令台账。完整门禁判断的是摘要顺序，不按墙钟时间或工具总数评分。C4 复用 continuation 的真实多轮工作区，并要求每轮结构化报告决策归属。

每组均有正确控制和已观察错误的离线反例。这只证明 oracle 能区分轨迹，不证明 rotom 产品行为改善。

## 文件

- `rotom/evals/src/workflow-discipline-regressions.ts`：C1–C3 fixture、任务、输出合同和确定性 judge。
- `rotom/evals/cases/workflow-discipline.eval.ts`：baseline/candidate 真实 Pi harness。
- `rotom/evals/test/workflow-discipline-regressions.test.ts`：正确控制、历史错误轨迹和工具边界测试。
- `rotom/evals/src/continuation-cases.ts`：C4 的 Agent-owned 与 user-owned 两个多轮控制。
- `rotom/evals/test/continuation-regression.test.ts`：C4 脚本和 judge 的离线正反检查。
- `rotom/evals/src/fixture-tools.ts`：每个 fixture 可声明精确 shell 命令和生成证据；未声明时仍只允许 `node verify.mjs` 和 `verification.json`。

## 离线检查

```sh
npm --prefix rotom/evals test -- test/workflow-discipline-regressions.test.ts
npm --prefix rotom/evals test -- test/continuation-regression.test.ts -t "decision-ownership fixture scripts|distinguishes an agent-owned"
npm --prefix rotom/evals run typecheck
```

完整 continuation 离线 harness 还会加载当前产品运行时。若 installed third-party package 与 `product-config.mjs` 不一致，它会在运行样本前失败；这属于本机运行时前置条件，不得算成新 case 失败或通过。

## 模型 A/B

模型调用必须另行取得 provider、模型、发送数据、重复数和预算授权。

C1–C3：

```sh
ROTOM_EVAL_WORKFLOW_DISCIPLINE=1 \
ROTOM_EVAL_BASELINE_PRODUCT=/absolute/frozen-baseline/rotom \
ROTOM_EVAL_CANDIDATE_PRODUCT=/absolute/candidate/rotom \
ROTOM_EVAL_REPEATS=2 \
npm --prefix rotom/evals run eval -- \
  --provider YOUR_PROVIDER --model YOUR_MODEL cases/workflow-discipline.eval.ts
```

可用 `ROTOM_EVAL_WORKFLOW_DISCIPLINE_CASE` 选择单个 case。

C4 复用 continuation suite：

```sh
ROTOM_EVAL_CONTINUATION=1 \
ROTOM_EVAL_BASELINE_PRODUCT=/absolute/frozen-baseline/rotom \
ROTOM_EVAL_CANDIDATE_PRODUCT=/absolute/candidate/rotom \
ROTOM_EVAL_CONTINUATION_REPEATS=2 \
npm --prefix rotom/evals run eval -- \
  --provider YOUR_PROVIDER --model YOUR_MODEL cases/continuation-regression.eval.ts
```

两套评测均关闭未授权外部写入。未启用时 suite 跳过，skip 不算通过。provider 错误、超时和运行时 identity gate 失败单列为 unknown/基础设施失败。入集本身不修改 rotom 运行时行为。
