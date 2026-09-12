# Maka 2/3/4 实验与交付报告

日期：2026-09-08。方案：[maka-234-experiment.md](maka-234-experiment.md)。

> 以下原始实验与快照证据对应 `2339a08` 的长版指导；后续已按用户决定精简，见文末。原始 A/B 不代表短版效果。

## 结论

- **实现与本地验证：PASS。** 完成 Browser ownership/迟到结果隔离、Subagent 退休实例发布保护与直接 steer 禁用自动 replacement recovery，以及统一的 evidence-linked handoff/summary 指导。
- **模型质量收益：INCONCLUSIVE。** 三轮严格 full-pass 分别为 baseline→candidate **5/8→4/8、4/8→5/8、5/8→4/8**，方向不稳定；判分还存在标签/字面匹配局限，不能声称质量提升。
- **固定微评测 token/成本：增加。** 最终快照一轮 total tokens **+21.72%**，估算成本 **+21.65%**，累计 run elapsed **+9.54%**。不宣称省 token 或全局提速。
- **未做真实 Chrome/TUI 重放。** Chrome extension 安装/重载需要用户显式操作；本报告的 Browser 结论来自受控 Chrome API fixtures 与真实 Pi public-runtime 测试，不是已加载新代码的真实 Chrome L2/L3。

## 实现范围

1. **Browser**：退休时同步清空 epoch-bound 状态并捕获原 relay/store；迟到 connection/store-open 关闭自身；artifact close 等待已经接纳的写入，拒绝晚到 artifact 发布；最终 result、audit、cursor 和 observation 发布点再次校验 owner。Chrome scoped adapter 在 dispatch 前和 Promise 完成后检查 guard，显式覆盖后续 mouse/scroll、full-read restoration、attach catch、rollback 和 tab reservation；正常完成也使有界 readback 的迟到 continuation 失效。
2. **Subagent**：每 extension factory instance 一个不可复活的 lease。同步拒绝退休实例的 `sendMessage`、`sendUserMessage`、`appendEntry` 和迟到 `onUpdate`，拒绝迟到 result 返回。精确 `.2` notifier 收到抛错后返回未接受，原证据不被伪装成已投递。直接 steer 的 ID/dir 路由均强制 `steeringRecovery:false`，显式后续 resume 保持独立。
3. **Handoff/summary**：一条 runtime-injected guideline 保留 task/constraints、lane/run/session/cwd、native 与 work state、可读证据/命令/结果/scope、revision **及相关 dirty-file freshness**、unknown 与下一步；缺失证据需 bounded excerpt/重新核对。摘要不是验证事实。

未修改 `node_modules`、Pi 或第三方 installed source；未升级 package，仍为 `pi-subagents@0.52.1-dev-agent-followthrough.2`；未新增工具、scheduler、runtime、数据库、checkpoint store 或 compactor；未做真实业务/平台写入。

边界：fencing 不等于取消或撤销已发出的效果，不证明 orphan 已终止，也不隔离第三方任意内部文件写入；同一实例重新绑定多个 session 的假设不属于本次保证。summary 的语义完整性仍是 prompt 指导，不是强制 verifier。

## Advisor 与纠偏

第一次配置实际落到 **high**，不算用户指定的 xhigh 验收。第二次显式使用 `gpt-6-astra:xhigh`，会话 thinking event 确认为 xhigh，给出收窄方案 **GO**。

关键纠正：实际 Pi **0.85.1** 在 new/resume/fork/reload 时销毁旧 runtime；A→B→A 是三个实例。不能把虚构的 same-instance notifier reset 当作产品泄漏，也不能宣称 ALS 能解决共享队列内每一项的 ownership。

| Advisor 会话 | 实际 thinking | 会话壁钟 | input | output | cache read | total tokens | 目录估算成本 |
|---|---|---:|---:|---:|---:|---:|---:|
| 首次，不算指定配置验收 | high | 4分00.6秒 | 76,329 | 5,412 | 330,880 | 412,621 | $1.364770 |
| 正式方案 review | xhigh | 7分34.0秒 | 102,022 | 7,620 | 617,088 | 726,730 | $2.018308 |

两次上下文和任务不同，此表仅记账，不是 high/xhigh 性能 A/B。正式 review 的会话坐标仅保存在私有证据中，不进入公开报告。

## 验证证据

| 实际检查 | 结果 | 耗时 |
|---|---|---:|
| `rotom/bin/check-personal` 最终运行 | 136 passed，19 个既有停用 Safety tests skipped，0 failed | 71.48秒 |
| Browser relay + Chrome extension tests | 30 passed，0 skipped/failed | 7.39秒 |
| `verify-pi-runtime.test.mjs` | 32 passed，0 skipped/failed | 368.10秒 |
| full/deferred public-loader smoke 与 footprint | PASS；6 extensions、3 bundled skills、5 templates；lifecycle errors=0 | full footprint 2.36秒 |
| `rotom/evals`: `npm run typecheck` / `npm test` | typecheck PASS；78 passed，1 个未配置 sidecar 的测试 skipped | tests 15.98秒 |
| `git diff --check` | PASS | — |

新增测试均实际执行，未以 skip 代替验收。覆盖真实 public `createAgentSessionRuntime` 的 new/resume/fork/reload/A→B→A，exact `.2` notifier 150ms debounce/1000ms max-wait、steer ack timeout、迟到连接/store/写入/交互/游标、同实例 abort、overlapping tree cleanup、逐 mouse dispatch、full-read 失去 owner 后不恢复旧滚动位置、rollback exact-resource 与跨 session retiring-tab reservation。计时器测试使用可控回调，异步竞态使用 Promise readiness/release 握手。

对 baseline 原代码运行同一组最初九项 Browser ownership 回归：**1 passed / 8 failed**；candidate 对应九项全过。baseline 的迟到 interaction 已被 Pi 自身 stale-context 防护拒绝，因此这一项不冒充新增安全收益。其余失败包括迟到连接未关闭、store 迟到发布/清理以及 Chrome 后续命令/错误清理等。最终又验证了 late-open 清理期间的 reservation；第三轮最终快照中的全部 199 个 source-manifest 文件与交付前当前文件逐项 SHA-256 一致。

验证过程中保留的失败：第一次 identity suite 的 120 秒外层 deadline 中断了慢速资源测试；确认进程已经停止、部分输出持续推进后，以 600 秒范围单独重跑完成。full footprint 初次失败揭示既有合同漂移：exact baseline 实测 schema/guideline **40,411/12,983 bytes**，旧合同为 39,655/11,847；本次另增 **136/868 bytes** 到 **40,547/13,851**。已分别记账并更新 reviewed full 合同；默认 deferred surface 不变，不可变 reference 未改。

## 真实模型 paired A/B

设置：两臂均 `openai-codex/gpt-6-astra`、**medium**，实际 Pi **0.85.1**；eval package 的开发依赖为 0.84.3，但本次运行 manifest 明确记录使用传入的 0.85.1 executable。八个固定 synthetic cases、两个 canary 在集合内；逐题两臂交替顺序；独立 workspace、冻结产品资源、无工具/无业务副作用；投影各产品自身 guideline。48/48 runs 有 usage 与 elapsed，无重试、无缺失记为零、cache read/write 均为 0。

第一轮后补充最终发布点的 owner checks，避免只依赖请求层 post-await 检查，另冻 **candidate-v2** 并重复八组。第二轮后最后一次 cleanup 审查又补齐 late-open 删除期间的 tab reservation，防止删除未完成时被另一 session claim；新增握手回归通过，再冻 **candidate-final** 完成第三轮八组。三轮全部保留，没有根据回答修改 prompt/scorer，不把不同 candidate 当作同一版本的重复样本；没有第四轮。

### 最终快照：8 pairs / 16 runs

| 指标 | Baseline | Candidate-final | 差异 |
|---|---:|---:|---:|
| 严格 full-pass | 5/8 | 4/8 | −1题，不能外推 |
| 各题 checks 平均分 | 92.53% | 93.21% | +0.68个百分点 |
| input tokens | 5,836 | 7,106 | +21.76% |
| output tokens | 1,202 | 1,461 | +21.55% |
| total tokens | 7,038 | 8,567 | **+21.72%** |
| run elapsed 合计 | 109.83秒 | 120.30秒 | +9.54% |
| 平均 run elapsed | 13.73秒 | 15.04秒 | +1.31秒 |
| 目录估算成本 | $0.11846 | $0.14411 | +21.65% |

| 固定 case | 原始 score B→C | total tokens B→C | run 秒 B→C |
|---|---|---|---|
| launch-receipt（canary） | 1.000→0.875 | 827→1,006 | 18.25→14.95 |
| changed-source（canary） | 1.000→1.000 | 886→1,058 | 10.02→15.23 |
| steer-timeout | 0.875→1.000 | 858→1,066 | 14.70→11.73 |
| false-success | 1.000→1.000 | 832→1,009 | 8.66→12.48 |
| compact-handoff | 1.000→1.000 | 919→1,104 | 15.44→11.51 |
| unreadable-reference | 1.000→0.818 | 943→1,165 | 17.46→20.62 |
| conflicting-sources | 0.778→0.889 | 868→1,050 | 13.98→12.25 |
| retired-owner | 0.750→0.875 | 905→1,109 | 11.31→21.55 |

前两轮同样保留：

| 版本 | full-pass B→C | tokens B→C | run elapsed B→C | 估算成本 B→C |
|---|---|---|---|---|
| 首轮 candidate | 5/8→4/8 | 7,087→8,495 | 102.91→112.99秒 | $0.12051→$0.14035 |
| candidate-v2 | 4/8→5/8 | 7,167→8,539 | 102.19→107.38秒 | $0.12459→$0.14255 |

### 判分局限与人工核对

严格得分不是语义真值：

- `waiting` / `unknown` 对“任务等待、验证未知”存在口径分歧；candidate 的保守分类不等于错误完成声明。
- “先 inspect existing，再必要时 revalidate”与直接 `revalidate` 的 enum 不同，但都可能是合理步骤。
- literal anchor 把 `unresolved` 而非 `unknown`、`no-platform-writes` 而非 `no platform writes` 判为缺失；baseline 实际仍保留了该约束。
- 所有回答都拒绝立即 replacement/replay/stale publication。保留原分数，没有事后把合理同义表达改判为通过；因此不能把任何一轮 ±1题解释为可靠质量变化。

该 A/B 只测文本指导下的固定决策，不执行真实子进程/Browser 控制，不证明 fences 导致模型收益，也没有测真实长会话压缩前后的节省。样本量小、无重复随机化/显著性结论，延迟包含 runtime setup/provider 波动。

## 总记账与证据位置

- A/B 从 **06:46:14Z** 到 **07:21:26.741Z**，墙钟 **35分12.7秒**（含中途审查/验证）；48 次 run elapsed 相加 **10分55.6秒**。
- 全部 A/B：**46,893 supplied tokens，$0.790570 目录估算成本**；在授权 **$10 / 90分钟** 内。
- 两次 advisor 加 A/B：**1,186,244 tokens（含 advisor cache read），$4.173648 目录估算成本**。此数字**不包含主会话**的 token/费用，也不是整个项目账单；不补估不可见的 provider accounting。
- Baseline commit：`63dfc3c442e851b2f27db427b6cb0fc625b8bfa7`。
- 最终 snapshot source manifest SHA-256：`cde667659960b36b44172c177bb8b525ce61dd17501f0fb8a233e2e73f3c7d55`。
- 原始 runs、comparisons、native session、trace、source manifests、advisor metadata 和聚合结果仅保留在维护者私有证据中。公开报告只保留汇总指标与局限，不包含本机路径或原始会话。

**交付判断：保留经过确定性验证的防护与证据纪律；不宣传性能优化。** 真实 Chrome 新版本交互、orphan termination、长会话 compaction 收益及广泛 coding workload 效果仍未验证。

## 后续采纳：保留防护，精简指导

按用户确认执行：Browser/Subagent ownership 防护、publication lease 和 direct-steer 的 `steeringRecovery:false` 原样保留。仅将 handoff/summary 长清单缩为证据、unknown 和源码新鲜度原则，仍保留约束、下一步授权动作、可读证据及 command/result/scope；不再重复要求完整身份/状态表和 compactor 禁令。

- 指导文本 UTF-8：**729 → 305 bytes（−58.16%）**；增加 320-byte 文本上限回归，避免重新膨胀。
- 实测 full 工具 guideline：**13,851 → 13,427 bytes**；工具数 24、schema 40,547 bytes 不变。默认 deferred：19 tools、17,052 schema / 8,466 guideline bytes，全部不变。
- 验证：定向 publication/steer/文本合同 **4/4 PASS**；`check-personal` **136 passed / 19 既有 skipped / 0 failed**；full/deferred public-loader、package/resource identity 与 footprint **PASS**；`git diff --check` **PASS**。初次 full 检查仅因旧 guideline 字节合同失败，实测后按新文本更新合同并复跑通过。
- 没有改动评测题目/判分器，也未追加付费 A/B。这里只证明静态文本缩短和本地合同通过，**不证明短版模型质量、provider token 或延迟收益**；真实 Chrome 仍待显式重放。原始实验数据不覆盖此次精简。
- 本次检查日志保持本机私有；公开报告不包含临时日志路径。

随后又做了[本地设计消融](maka-234-ablation.md)：保留防护语义，合并 Subagent 双层 Proxy 与 Browser 分页嵌套包装；未追加模型调用。
