---
name: agent-regression
description: "维护 rotom 的真实失败回归：将新失败整理为脱敏用例入集；修改 rotom 后选取相关用例，与冻结基线比较。用于‘把这次失败加进回归集’、‘修改后跑 Agent 回归’、‘对比 baseline/candidate’。不用于解释 eval 文章、普通单测选型、修复业务项目或发布产品。"
---

# Agent regression

这是仓库维护 skill，不进入产品 bundle。先确认 Git 根、当前 diff 和任务范围。[操作合同与命令](../../../docs/agent/agent-regression.md)是总入口；新失败必须遵守 [完整闭环](../../../docs/agent/agent-regression-lifecycle.md)。

## 新失败的强制顺序

以下四步不能交换，也不能用后一步掩盖前一步缺失：

1. **建立 oracle**：核对原始证据，提取最小脱敏场景；加入已观察错误的反例和至少一个正确控制。先证明旧错误轨迹被拒绝、正确轨迹被接受。
2. **跑真实 baseline**：取得模型、数据发送、重复数和预算授权后，用冻结产品和真实 Agent 运行新用例。离线 judge 通过只表示 `oracle-ready`，不表示 Agent 通过，也不表示入集闭环完成。
3. **按证据修 Agent**：baseline 复现失败后，才修改正确的产品层。baseline 若通过或结果 unknown，先检查用例代表性、运行条件和证据；不要为了制造改善而改 Agent 或放宽 judge。用户明确要求“只记录、不修复”时，保留为 open regression，并明确没有 candidate 改善证据。
4. **同条件跑 candidate**：固定同一 case、judge、工具、模型、thinking、重复数和输入，对修改后的产品重跑。若中途修改 fixture 或 judge，旧 baseline 作废，必须用新版本同时重跑两侧。

未获得真实 baseline 授权时，停在 `baseline-pending` 并询问所缺的模型、发送数据、重复数或预算；不得把离线测试绿色写成“Agent 已通过”。

## 判定与交付门禁

- baseline 失败、candidate 通过才是改善证据；两侧都通过是未复现，两侧都失败是未修复。
- skip、超时、provider 错误、运行时 identity gate 失败和外部写入 unknown 单列，不进入通过率。
- A/A 只验证 runner，不证明改动收益；另一模型的旧结果不能充当本次 baseline。
- 先报告 oracle 状态，再报告 baseline、Agent 改动、candidate；四项缺一时不得写“回归闭环完成”。
- 交付包含：用例 ID、来源范围、脱敏变化、反例/正确控制、实际样本、逐例结果、私有产物路径、token/耗时/估算费用、commit/push 状态。

## 修改后回归

已有 rotom 改动时，按 diff 和失败机制选集，先跑离线检查，再取得真实模型授权并与冻结 baseline 同条件比较。分列新退化、改善、原有失败和 unknown；Judge 分数不是业务成功。

Jev 可辅助分流，但置信度不能替代事实验收。
