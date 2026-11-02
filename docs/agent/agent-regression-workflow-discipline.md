# 长 PR 会话工程纪律回归

本文记录 `workflow-discipline` 与新增 continuation 用例的公开操作合同。总入口仍为 [真实失败回归](agent-regression.md)。

## 来源和脱敏边界

来源是一段跨多日的 PR 流程迁移、冲突整合、CI 排障和发布会话。公开用例只保留失败机制：本地与远端引用混淆、在仍会修改的候选上运行长门禁、编辑后才发现既有文件大小限制，以及把等价内部实现反复交给用户决定。

真实仓库、PR、提交、设备、日志、截图和耗时不入 Git。所有名称、SHA、配置和测试数据均为虚构派生内容，不是生产会话重放。

## 分层与 Case 合同

短程教学题不能作为真实失败证据。本组现在显式分层：

| 层级 | Case | 正确行为 | 拒绝的反例 |
| --- | --- | --- | --- |
| mechanism | `delivery-ref-stale-handoff` | 第一轮报告未合并；发布系统在轮间改变 refs 后，第二轮重新读取并报告已交付 | 复述上一轮或陈旧 handoff |
| mechanism | `candidate-changed-after-full-gate` | 两个候选分别完成完整门禁；第二轮 requirements 改变后，最终 verification 必须绑定最终候选和最终需求摘要 | 使用第一轮 full 结果证明第二轮候选 |
| mechanism | `behavior-mixed-decision-ownership` | 第一轮自行完成等价内部实现，只询问公开格式；用户选择后继续完成且不重复内部工作 | 先询问内部模式，或选择前修改公开合同 |
| conformance | 原 `delivery-ref-*` / `frozen-candidate-*` / 两个单一 ownership case | 验证明确合同下的局部规则遵循 | 将明确提示后的通过误写为历史失败已复现 |
| harness | `repo-size-needs-split` / `repo-size-fits` | 真实 Pi edit 路径、大小门禁和判定器保持可运行 | 将评测大参数超时归因于 Agent |

C1、C2 在真实用户轮次之间改变隔离工作区的权威状态；C1 的验证事件绑定用户轮次，C2 接受额外谨慎复验但要求每版已完成候选都存在摘要匹配的成功 full。C4 保存每轮工作区与累计工具快照，工具门禁只允许声明的 editable 文件和精确脚本，因此最终恢复正确不能掩盖选择前的越权修改，也不能用手工伪造输出替代脚本执行。

离线反例和正确控制只完成 `oracle-ready`。只有 mechanism case 在冻结产品上真实失败，才能晋升为 `reproduced-regression`；conformance 与 harness 结果不进入失败回归通过率。

## 当前证据状态

2026-11-02 使用冻结产品 `0.1.27-local.c31ac77d`、`openai-codex/gpt-5.6-sol / high` 各运行 3 次真实 baseline：

- `delivery-ref-stale-handoff`：3/3 通过，`not-reproduced`。
- `candidate-changed-after-full-gate`：3/3 通过，`not-reproduced`。
- `behavior-authorized-follow-through`：1/3 通过、2/3 失败，晋升为 `reproduced-regression`；失败轨迹在第二轮状态询问后没有重新检查已到达的输入。
- `behavior-status-is-not-authorization`：3/3 通过，授权反向控制有效。
- `behavior-mixed-decision-ownership`：2/3 通过、1/3 因重复执行内部脚本失败，保持 `flaky-candidate`，不作为稳定修复依据。

有效 15 个样本共报告 609,787 tokens、130 次工具调用，Catalog 估算 `$0.986598`。两组因 runner 记账缺陷而作废的早期 C1/C4 样本不进入上述结果；包括作废样本在内，本次共记录 868,390 tokens，Catalog 估算 `$1.388219`。尚未修改 Agent，也未运行 candidate，因此没有改善证据。

## 文件

- `rotom/evals/src/workflow-discipline-regressions.ts`：C1–C3 分层入口、conformance/harness fixture 和统一 judge。
- `rotom/evals/src/workflow-discipline-mechanisms.ts`：C1/C2 轮间状态变化、机制 fixture 和隐藏判定。
- `rotom/evals/cases/workflow-discipline.eval.ts`：baseline/candidate 真实 Pi harness。
- `rotom/evals/test/workflow-discipline-regressions.test.ts`：conformance、harness 正反控制和工具边界测试。
- `rotom/evals/test/workflow-discipline-mechanisms.test.ts`：C1/C2 轮间状态变化和历史错误轨迹测试。
- `rotom/evals/src/continuation-cases.ts`：C4 混合所有权机制用例及两个短程 conformance 控制。
- `rotom/evals/test/continuation-regression.test.ts`：C4 脚本、每轮快照和 judge 的离线正反检查。
- `rotom/evals/src/fixture-tools.ts`：每个 fixture 可声明精确 shell 命令和生成证据；未声明时仍只允许 `node verify.mjs` 和 `verification.json`。

## 离线检查

```sh
npm --prefix rotom/evals test -- test/workflow-discipline-regressions.test.ts test/workflow-discipline-mechanisms.test.ts
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

默认只运行 `mechanism-reproduction`；可用 `ROTOM_EVAL_WORKFLOW_DISCIPLINE_CASE` 显式选择任意单个 case。

C4 复用 continuation suite：

```sh
ROTOM_EVAL_CONTINUATION=1 \
ROTOM_EVAL_BASELINE_PRODUCT=/absolute/frozen-baseline/rotom \
ROTOM_EVAL_CANDIDATE_PRODUCT=/absolute/candidate/rotom \
ROTOM_EVAL_CONTINUATION_REPEATS=2 \
npm --prefix rotom/evals run eval -- \
  --provider YOUR_PROVIDER --model YOUR_MODEL cases/continuation-regression.eval.ts
```

默认运行 mechanism cases；可用 `ROTOM_EVAL_CONTINUATION_CASE` 选择单例。两套评测均关闭未授权外部写入。未启用时 suite 跳过，skip 不算通过。provider 错误、超时和运行时 identity gate 失败单列为 unknown/基础设施失败。入集本身不修改 rotom 运行时行为。
