# 压缩后真实模型续跑：固定诊断 A/B

## 冻结协议（先于 live dispatch）

- Baseline：公开 `a5bc1ecddbb3886762c3a0f72600ed2c55537112`。
- Candidate：公开 `b50617c855da276a4ad15afdc061e191f8a07f93`。
- 两臂从各自 Git tracked `rotom/` 独立提取，隔离 HOME 下按各自锁文件新安装 runtime；复用现有 `loadProductRuntime` 验证资源和 installed identity，不修改用户安装。模型配置 digest 必须一致，Pi fork 源码 digest 必须不同。
- 当前用户明确授权 `openai-codex/gpt-6-astra`、原生认证、6 题 × 2 次 × 2 臂、最多 120 次模型请求 / 60 分钟。不读取、打印或复制认证内容，不发送私人会话正文。
- 两臂均 `medium`，使用 SSE、关闭 SDK/provider retries 与 cache warming，不切换模型、不对 unknown 重发。每条链最多 6 次模型调用（1 次摘要 + 最多 5 次续跑，包含工具 finish 后的最终回复）；逐次 dispatch 前持久化 admission。遇到超时、流中断或额度耗尽，记 BLOCKED/censored，不当作产品失败。
- 请求传 `maxTokens=2048`；Codex transport 不保证把该值作为服务端硬输出上限，因此**不承诺 token 或美元硬上限**。实际硬边界为请求次数与时间，单调用还有 120 秒 abort。记录 provider usage，订阅美元费用 unknown。
- 每个 case/repetition 交替 A/B 顺序。两次同题 paired baseline PASS / candidate FAIL 才判明确回归并停止扩容；不根据一个随机失败临时换题或重跑。

## 固定题单

| ID | 摘要路径 | 最终状态检查 |
|---|---|---|
| tail-error | initial | 读取长日志尾部失败后修复，当前版本测试通过，不提交 |
| empty-parallel-error | initial | 区分并行的 lint PASS 与空正文 unit 错误，补齐 unit 验证 |
| stale-verification | initial | revision 1 的 PASS 不冒充 revision 2 已验证 |
| unknown-write | initial | 原请求已经产生一张 receipt；只读确认，不重复创建 |
| branch-failure | branch | 分支里的 patch 尝试并未修好，仍需修复与验证 |
| resolved-update-control | update | 新 PASS 覆盖旧摘要的 blocked，不无理由重新修改已验证代码 |

旧版和新版各自调用真实 native `generateSummaryWithUsage` / `generateBranchSummary`；写入原生 SessionManager，再从私有 JSONL 恢复后创建真实 AgentSession 续跑。任务的 OS/service 写入均为有状态模拟工具，模型决策是真实推理。grade 根据模拟环境最终状态和工具调用审计，不靠最终文本、关键词或 LLM judge。没有完整真实代码仓库修复任务，因此只属于**续跑合同诊断**，不是 SWE 成功率 benchmark。

初次、更新和 branch 摘要路径均覆盖；不覆盖 split-turn 的真实行为，也不覆盖连续两次真实生成摘要（update 使用固定旧 checkpoint）。这两个遗漏不能由先前 mock 测试替代。

## 运行

在仓库根，维护 Pi workspace 的依赖与构建输出就绪后：

```bash
node --test --test-concurrency=1 experiments/compaction-continuation/cases.test.mjs
node experiments/compaction-continuation/live.mjs /absolute/baseline/rotom /absolute/candidate/rotom /absolute/private-output --preflight
# 只有明确的本次授权，才能执行下一条：
node experiments/compaction-continuation/live.mjs /absolute/baseline/rotom /absolute/candidate/rotom /absolute/private-output --live
```

output 必须已存在且为私有目录。已有 `report.json` 时拒绝重跑；保留 uncertain admission，不通过换输出目录自动补跑。第五个参数可显式传入已结束的 prior report，固定 fixture/model/两臂身份并继承全部消耗与原截止时间。只有“摘要明确 `stop`、尚无 continuation/评分的首次本地 TypeError”可重建该失效槽位；除此之外只运行原计划里尚未启动的槽位，已成功、截断、错误或 unknown 的槽位全部保留并跳过。旧 artifact 不覆盖，成本不重置；不自动循环继续。已达到模拟状态但最终回复被 admission 截断的链单列 CENSORED，不计完整配对。预检不 dispatch 模型；`refreshOnCreate` 保留默认启用，仅离线初始化原生 auth availability snapshot，否则 `hasConfiguredAuth` 会错误地返回未配置。

结果保留于本机私有目录：摘要与消息仅使用原生 session 文件，公共报告只包含版本/源码摘要、通过结果、工具动作类别、耗时和 usage。网络计数只记录 `/responses` dispatch 的序号/时间，不记录 URL、header 或正文。对原始错误仅保存 class/digest。

## 首次脚本失败记录

首次 baseline summary 明确完成（1 请求、1,033 reported tokens），随后脚本误用未公开导出的 `estimateContextTokens`，未保留下该摘要、也未开始 continuation；这不是产品失败。改为公开的 `estimateTokens` 并补两臂原生 SDK/faux provider 的 summary → JSONL reload → continuation 演练后，才显式继续剩余预算。首版每链 5 请求改为 6，以包含 finish 工具后的最终回复；此调整发生在观察任何真实 continuation 结果之前，总上限仍为 120 / 原 60 分钟。

零费用演练：`node experiments/compaction-continuation/native-smoke.mjs /absolute/installed-product`，不作为真实模型证据。

本轮实测见 [RESULTS.md](RESULTS.md)，公开 metadata 见 [results.json](results.json)。生成汇总：`node experiments/compaction-continuation/summarize.mjs /absolute/private/report.json`。

## 解释边界

固定 6 题针对已改代码，是诊断集，不是代表性独立留出集。即使 12/12 全通过，也不能证明一般任务成功率提升、统计非劣或模型无回归；报告逐题 paired 结果、summary/continuation token 和时间。任何后续修复须建立新的候选身份及新授权额度，不能在这批结果里挑选最好的一轮。
