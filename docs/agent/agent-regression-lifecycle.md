# 新失败回归闭环

本文是 `/skill:agent-regression` 的强制执行顺序。命令、现有 suite 边界和产物格式仍以 [真实失败回归](agent-regression.md) 为准。

```text
建立能拒绝旧错误的 oracle
          ↓
用冻结产品和真实 Agent 跑 baseline
          ↓
baseline 复现失败后，按证据修改 Agent
          ↓
同 case / judge / 工具 / 模型 / 输入跑 candidate
```

## 1. 建立 oracle

先固定用户目标、实际错误、运行版本、工具证据、允许的操作和预期结果。基础设施故障、余额不足、超时和业务结果 unknown 与模型决策失败分开。

将真实证据改写为最小的虚构派生 fixture。替换仓库、人物、设备、路径、ID、截图和凭据，但保留导致失败的区别。真实会话和运行产物不进入公开 Git。

验收优先检查最终文件、环境、工具完成事件和不可变验证程序。必须包含：

- 已观察错误的反例；
- 至少一个正确控制；
- 能证明反例失败、控制通过的离线测试；
- 稳定 case ID 和明确的工具/写入边界。

这一阶段完成后只能报告 `oracle-ready`。它证明 judge 有判别力，不证明当前 Agent 失败或通过。

## 2. 跑真实 baseline

模型调用前确认：

- 精确 provider 和 model；
- 将发送的脱敏数据范围；
- 重复数；
- 时间和预算授权；
- 冻结 baseline 产品根和 commit；
- 私有产物目录。

使用新建的同一 suite 运行真实 Agent。核对实际样本数、manifest、逐例 judge 证据、工具错误和 stop reason。skip、超时、取消、provider 错误或 runtime identity gate 失败均为 unknown/基础设施失败，不能计为 baseline 通过或失败。

结果分支：

| Baseline 结果 | 后续动作 |
| --- | --- |
| 稳定复现已观察错误 | 进入 Agent 修复 |
| 通过 | 标记 `not-reproduced`；检查 fixture 是否丢失关键区别，不修改 Agent 制造改善 |
| 波动 | 增加已授权重复或收紧确定性证据；保持 `inconclusive` |
| 基础设施失败 | 修前置条件后重跑同一 baseline；不得用离线控制替代 |
| 未授权 | 标记 `baseline-pending`，询问缺失授权，不宣称入集闭环完成 |

用户明确要求“只记录失败，不修 Agent”时，可以在 baseline 稳定复现后交付 open regression；必须明确 candidate 未运行、问题未修复。

## 3. 按 baseline 证据修 Agent

只有 baseline 已稳定复现时，才根据工具轨迹、最终状态和 judge 失败项定位产品根因。修改应位于正确产品层，不在 fixture、judge 或 prompt 中为 candidate 特判。

先运行受影响的确定性检查。不得：

- 放宽 judge、阈值或工具边界来迁就实现；
- 删除反例或缩小工作负载；
- 用另一模型、另一输入或旧历史结果替代 baseline；
- 将 A/A 结果写成收益；
- 因 candidate 失败而只修改 candidate 一侧看到的 fixture。

如果确实发现 oracle 错误，先修 oracle，再用新版本同时重跑 baseline 和 candidate。旧分数作废。

## 4. 同条件跑 candidate

candidate 必须与 baseline 固定：

- case、fixture 和 judge；
- provider/model 和 thinking；
- 工具面、系统合同和输入；
- 重复数和 arm 顺序；
- 超时、retry/compaction 和外部权限。

逐例比较：

| Baseline | Candidate | 结论 |
| --- | --- | --- |
| fail | pass | 改善证据 |
| fail | fail | 未修复 |
| pass | fail | 新退化 |
| pass | pass | 用例未证明本次改动收益 |
| known | unknown | candidate 结果不可判定 |
| unknown | known | baseline 不可用于收益比较 |

只有实际样本数正确、candidate 通过目标合同、没有未解释的新退化时，才可以报告“该回归闭环完成”。这仍只覆盖所运行的 suite，不等于真实 App、设备或外部业务验收完成。

## 报告顺序

最终报告固定为：

1. **Oracle**：case ID、来源范围、脱敏变化、错误反例和正确控制；
2. **Baseline**：冻结产品、模型、重复数、实际样本和逐例结果；
3. **Agent change**：根因、修改层和确定性验证；
4. **Candidate comparison**：改善、新退化、原有失败、unknown；
5. **Limits**：未运行的真实设备/外部验收、费用性质和样本限制；
6. **Delivery**：产物路径、commit 和 push。

禁止使用以下混淆表达：

- 把“离线测试通过”写成“Agent 通过”；
- 把“eval suite skipped”写成“评测通过”；
- 把“baseline 未运行”写成“失败已入集并修复”；
- 把 judge 分数写成真实业务成功；
- 把估算费用写成实际账单。
