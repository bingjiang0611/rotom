---
name: agent-loop
description: "运行 rotom 的 Agent 优化循环：从本机会话挖掘失败（harvest）、分诊并做成回放用例、冻结基线复现后再修、同条件 candidate、跑回归 gate、写实验账本。用于‘看看最近 rotom 哪里让我操心’、‘把这次失败加进回归’、‘改了 policy/工具后跑 gate’、‘记录这次实验’。不用于普通单测选型、修复业务项目或发布产品。"
---

# Agent 优化循环

仓库维护 skill，不进入产品 bundle。合同、命令与授权范围见 [优化循环](../../../docs/agent/optimization-loop.md)；先确认 Git 根、当前 diff 和任务范围。

## 按意图选入口

- **找问题**：`npm --prefix rotom/evals run loop -- harvest`。读 `report.md` 的周介入率和分诊队列，再读 `incidents.jsonl` 前列事件对应的原始会话。只在本机读取；输出不入 Git。
- **新失败入集**：分类 → oracle → baseline → 修复 → candidate，顺序不可交换（见合同 ②–④）。
- **改了 Agent 行为**：改动涉及 coding-policy、工具、Goal 续跑、上下文/压缩或 Subagent 默认时，先 `gate --baseline <冻结产品> --smoke` 用一对样本审分数（两侧都出分、check 都是布尔、没有 check 读 `observe` 外的文件），再跑 `npm --prefix rotom/evals run loop -- gate --baseline <冻结产品>`。smoke 不算样本、不写 gate 历史。样本不足就加轮次，再用 `gate-pool --since <起跑时间> [--case ID]` 合并判定：合并只看 pass/fail 累加，后一轮通过不会抵消前一轮失败。
- **收尾**：每个实验（含撤回和未复现）在 `rotom/evals/loop/ledger.json` 追加一项，并跑 `npm --prefix rotom/evals run loop -- ledger`。

## 不可妥协

- 只有冻结基线上 `reproduced-regression`（3 次中 ≥2 次失败，或 gate-pool 合并后同门槛）才改 Agent；`not-reproduced`、`flaky-candidate` 不改。不为制造改善放宽 judge、删反例或改阈值。
- gate 结果只在 `~/.rotom/loop/gate-history.jsonl` 累加，不用重跑覆盖旧失败；判定按合并后的 pass/fail 数，不按最近一次。
- 优先改机制；纯提示改动没有 `evidence: improved` 不得 shipped，并报告 token 变化。
- baseline 与 candidate 同 case、fixture、judge、runner、模型、thinking、输入和重复数；中途改评测则两侧重跑。
- skip、超时、provider 错误、identity gate 失败和 unknown 单列，不算通过；gate 的 `unknown` 不是 `held`。
- 已授权：`qoder/dfmodel`、不设预算，用于 gate、回放与分诊；发送范围为脱敏 fixture、产品提示和分诊所需会话摘录。换模型或发送完整会话正文需另行询问。
- 真实会话、截图、凭据与运行产物不入 Git；公开用例必须重新虚构名称、路径与 ID。
- 推送前必须 `python3 scripts/audit-public.py --root . --history`，不能只跑 tree 模式：只扫树看不到提交身份。pre-push hook 会再拦一次非 noreply 身份；被拦就按提示 `--reset-author`，不绕 hook。

## 报告

依次给出：harvest 指标或事件来源、用例分类与 oracle 状态、baseline（模型、重复、逐例结果、作废样本）、改动与确定性验证、candidate 对比（改善/新退化/原有失败/unknown）、gate 结论、账本条目、token/耗时、commit/push。缺任一环节时明确写出停在哪一步。
