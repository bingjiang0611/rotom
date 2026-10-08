# 真实模型压缩续跑 A/B 结果

**Decision: INCONCLUSIVE — 未观察到完整配对中的正确性退化，但没有证明净收益；新版 token 开销更高。**

## 身份与配置

- Baseline：`a5bc1ecddbb3886762c3a0f72600ed2c55537112`。
- Candidate：`b50617c855da276a4ad15afdc061e191f8a07f93`。
- 模型：`openai-codex/gpt-6-astra`，两臂 `medium`，相同配置 digest；responseModel 记录同一模型 ID，不是后端权重版本证明。
- 独立安装各 commit 固定的 Pi fork 归档，原生摘要函数 → 原生 SessionManager 持久化/恢复 → 真实 AgentSession + 有状态模拟工具。
- 题单、初始状态及 grader 在首次 live dispatch 前固定。不是私人轨迹回放，也不是代表性 SWE 数据集。
- 2 repetitions / arm，SSE，无模型自动重试、无 cache warming。无 LLM judge。完整合同见 [README](README.md)。

## 逐题结果

| 场景 | 旧版（两次） | 新版（两次） | 完整可比 pairs |
|---|---|---|---:|
| 长日志尾部错误 | CENSORED / BLOCKED | PASS / PASS | 0 |
| 并行工具的空错误结果 | PASS / PASS | PASS / PASS | 2 |
| 修改后旧验证过期 | PASS / PASS | PASS / PASS | 2 |
| unknown 写入不重放 | PASS / PASS | PASS / PASS | 2 |
| 分支摘要中的失败结果 | PASS / CENSORED | PASS / PASS | 1 |
| 新证据覆盖旧 blocked | PASS / PASS | PASS / PASS | 2 |

- 新版 12 条正常完成；旧版 9 条正常完成、2 条 CENSORED、1 条 BLOCKED。
- **9 组完整配对全部为两臂 PASS**，没有观察到 baseline PASS / candidate FAIL。
- 两个旧版 CENSORED 已达到模拟任务的正确最终状态，但调用 finish 后的最终回复触及单链 6 请求上限；不算产品失败，也不算正常完整完成。
- 一个旧版摘要请求以 `stopReason=error` 结束，未得到可用摘要，usage 为占位 0。该次没有记录足够的 HTTP/error 分类来归因到上游、网络或客户端；记调用链 BLOCKED，不算产品失败，不补跑。
- 所有有 grade 的链均无模拟重复 receipt、无 commit 调用。BLOCKED 链不据此推断安全结果。

## 仅比较 9 组完整配对

| 指标 | Baseline | Candidate | 差值 |
|---|---:|---:|---:|
| 正常完成 | 9 | 9 | 0 |
| 模型请求 | 38 | 39 | +1 |
| 工具动作 | 20 | 21 | +1 |
| 摘要阶段 reported tokens | 6,381 | 8,632 | +35.3% |
| 续跑阶段 reported tokens | 20,664 | 22,053 | +6.7% |
| 总 reported tokens | 27,045 | 30,685 | **+13.5%** |
| 链路总耗时（九条合计） | 193.603 s | 196.709 s | +1.6% |

这些是本批实测数，不是 provider 精确账单或统计显著性结论。额外 inspect 不自动等于无效操作。两次空结果错误场景中，新版均先多做一次 inspect；其他场景存在相反方向的动作差异，没有稳定的全局效率改善。

尾部错误场景中，旧版先重现失败测试再修复，新版直接修复后验证；这是可观察的行动差异，但旧版对应链有截断/阻塞，不能把它写成完整 paired 成功率提升。

## 额度、失败与修正

- 总共 **109 次 model dispatch / 109 次 admission**，含首次脚本失败消耗的 1 次请求；未超过授权 120 次。
- 从首次 live 开始到最终结束 **18.87 分钟**，包含暂停修复脚本的时间；未重置原 60 分钟 deadline。
- 全过程 **83,434 reported tokens**，包含首次失效摘要的 1,033 tokens；错误请求的真实用量可能缺失，因此总量为 reported/partial。订阅美元成本 unknown，不能报告 `$0`。
- 首次脚本使用了未公开导出的 SDK helper，摘要虽成功返回但未保存。修正公开 API 用法、补零费用双臂 native 演练后，显式继承剩余额度执行，未隐去这笔消耗。
- 首版 chain admission 未把 native loop 捕获的本地上限错误单列，导致一条已达正确状态但未生成最终回复的旧版链暂记 PASS。核验原生 session 后纠正为 CENSORED，保留原始报告及更正记录；没有把它纳入完整配对。
- 遇到摘要调用错误后，仅继续固定题单中**尚未启动的槽位**。已成功、截断、错误或 unknown 的槽位均不重放，题单不更换。

## 可复核证据与门禁

- [results.json](results.json)：允许公开的版本/配置摘要、逐 pair 状态、分阶段 tokens、时间及原始最终报告 SHA-256；不含原生消息、认证、会话路径或工具参数。
- 统计生成器：`node experiments/compaction-continuation/summarize.mjs /absolute/private/report.json`。原始 session 与逐请求记录保留于本机私有 artifact 目录，不提交。
- 确定性 fixture/grader/admission/统计测试：9 passed。
- 两个实际安装的 native SDK/faux 模型链路演练：各 4 个假响应、0 网络模型调用，summary → JSONL reload → continuation → final-state grade 通过。
- 本次没有修改生产代码、再次重建 Pi、升级用户安装或进行 npm 发布。

## 结论与下一步边界

可以确认：在这 6 个固定合成场景中，新版 12 条链正常结束，完整配对未见正确性退化。**不能确认**：一般任务成功率提升、统计非劣、真实仓库编码收益或总体成本下降。

建议保留“序列化不丢错误/关联信息”的确定性修复，不以本轮结果宣传总体改善。若要优化净收益，下一轮应另行授权“只保留序列化修复”与“完整修复”的消融，并使用新的独立任务，检查共享提示增长是否值得。不得用剩余额度擅自加入第三臂、调提示后挑最好结果。

仍未覆盖：split-turn 的真实模型行为、连续两次真实生成摘要、真实代码仓库/外部服务、多模型和更大样本。
