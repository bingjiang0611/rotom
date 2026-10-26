# 任务 06 · 第二次付费回放结果

## 结论与停止状态

本次唯一一次真实执行已停止：首个 `config-aggregate / baseline / N=1` 的任务判分正确，但没有阈值事件，触发 `threshold-not-reached` 熔断。回放验收失败；其余 17 次未执行。没有重跑或补采，candidate 尚未运行，不能评价卸载效果。

- 授权：`bb57fe6f18447e81428f51ec58fd6e41a09ef1aa`；请求上限 2,000，合计输入上限 100,000,000，N=3。
- 执行源码：`d84393eae481981f748e1b3e13c8762fdcd446e7`；从干净工作树启动，唯一落盘行 `sourceDirty=false`。
- UTC：`2026-10-26T06:56:34Z` 至 `2026-10-26T06:58:57Z`；CLI exit=1。外层约 143 秒包含启动；单 case 的 harness wall 为 83872.121 ms。
- `LIVE_AUTHORIZATION` 已置回 `null`。本次授权 receipt 保留，不能通过换目录绕过，也不能继续使用 04b 的旧授权。

## 准备、配置与验收

启用授权时发现两个测试把可变的生产常量写死为 `null`，首次零费用专项为 21 passed / 2 failed。经用户明确允许，仅将这两处测试改成使用显式 `null` 验证缺少授权必须拒绝，保留合法/非法授权、入口无副作用等检查；没有跳过测试或改运行时门禁。授权及测试修正提交为上述执行源码 commit。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 启用授权后的 live/entry 专项 | 23/23 | `live-entry-authorized.log` |
| 启用授权后的 typecheck | PASS | `typecheck-authorized.log` |
| CLI 首次失败停止负对照 | 预期 exit=1；第二个测试 pending | `bail-check.json` |
| 本次真实执行 | 1 failed，逐项记录另有 17 pending | `artifacts/vitest-results.json`、私有指标账本 |
| 授权恢复 null 后专项 | 23/23 | `live-entry-retired.log` |
| 授权恢复 null 后 typecheck | PASS | `typecheck-retired.log` |

零费用命令（在 `rotom/evals/`）：

```sh
ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE=0 npx vitest run --config vitest.test.config.ts \
  test/compaction-offload-live.test.ts test/compaction-offload-entry.test.ts
npm run typecheck
```

唯一一次真实命令使用任务 06 的六项环境变量，指定仓内产品 Pi，执行 `npm run eval -- cases/compaction-offload.eval.ts --bail=1`。`--bail=1` 使任何测试失败都停止后续 case；该选项不是重试，也没有改变熔断上限。

| 实际项 | 值 |
| --- | --- |
| provider / model / thinking | `openai-codex` / `gpt-5.6-luna` / `low` |
| Node / 产品 Pi | v24.18.0 / 1.4.0-rotom.2 |
| transport / maxRetries | SSE / 0 |
| contextWindow / reserveTokens | 272000 / 208000 |
| thresholdTokens / keepRecentTokens | 64000 / 5120 |
| 任务与配置 | 沿用任务 05；未改阈值、材料、工具或评分 |

## 逐次指标

`—` 表示未测，不是 0。私有 JSONL 只有首行真实记录；其余 17 行 `not-run` 根据固定执行顺序及 Vitest 逐项 `pending` 状态列出，未向 JSONL 补写伪造记录。reporter 顶层 `numPendingTests=0` 与逐项状态不同，本报告按 18 条 assertion 的实际状态核验。

`correct=true` 仅表示任务答案/文件判分正确，不表示达到了压缩实验的阈值要求。时间单位 ms，显示保留至三位小数。

| task | arm | N | status | correct | threshold | native | deferred | wait ms | obsRecall | recalledOffloaded | offloaded | turns | toolCalls | input | cacheRead | cacheWrite | output | wall ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| config-aggregate | baseline | 1 | failed | true | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 11 | 14 | 42399 | 97280 | 0 | 1733 | 83872.121 |
| config-aggregate | candidate | 1 | not-run | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| config-aggregate | candidate | 2 | not-run | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| config-aggregate | baseline | 2 | not-run | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| config-aggregate | baseline | 3 | not-run | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| config-aggregate | candidate | 3 | not-run | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| deferred-exact | baseline | 1 | not-run | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| deferred-exact | candidate | 1 | not-run | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| deferred-exact | candidate | 2 | not-run | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| deferred-exact | baseline | 2 | not-run | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| deferred-exact | baseline | 3 | not-run | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| deferred-exact | candidate | 3 | not-run | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| multi-file-fix | baseline | 1 | not-run | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| multi-file-fix | candidate | 1 | not-run | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| multi-file-fix | candidate | 2 | not-run | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| multi-file-fix | baseline | 2 | not-run | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| multi-file-fix | baseline | 3 | not-run | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| multi-file-fix | candidate | 3 | not-run | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |

## Candidate 的 offloadDecisions

9 次 candidate 均未执行，没有可报告的决定；不能填入 `no_candidates` 等未观察到的原因。下表的 T 也不是实测决定值；配置阈值 64,000 见上表。

| task | N | 状态 | 决定类型 | native 原因 | before | after | T | 候选数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| config-aggregate | 1 | not-run | — | — | — | — | — | — |
| config-aggregate | 2 | not-run | — | — | — | — | — | — |
| config-aggregate | 3 | not-run | — | — | — | — | — | — |
| deferred-exact | 1 | not-run | — | — | — | — | — | — |
| deferred-exact | 2 | not-run | — | — | — | — | — | — |
| deferred-exact | 3 | not-run | — | — | — | — | — | — |
| multi-file-fix | 1 | not-run | — | — | — | — | — | — |
| multi-file-fix | 2 | not-run | — | — | — | — | — | — |
| multi-file-fix | 3 | not-run | — | — | — | — | — | — |

## 按臂汇总

分母只包含已执行 case。`not-run` 不进入成功率、均值或中位数，也不作为 0 填充。首个 baseline 的任务正确率与回放验收成功率分别列出；没有完整的 baseline/candidate 配对。

| arm | 计划 | 已运行 | completed | failed | not-run | 任务正确率 | 回放验收成功率 | 触发阈值运行 | native 总数 | deferred 总数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 9 | 1 | 0 | 1 | 8 | 1/1 | 0/1 | 0/1 | 0 | 0 |
| candidate | 9 | 0 | 0 | 0 | 9 | — | — | — | — | — |

时间单位 ms。“仅阈值”只纳入 `thresholdCompactions > 0` 的已执行 case，本次该集合为空；“含 0”纳入所有已执行 case。

| arm | 阈值样本数 | wait 均值（仅阈值） | wait 中位数（仅阈值） | wait 均值（含 0） | wait 中位数（含 0） | wall 均值 | obsRecall 均值 | recalledOffloaded 均值 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0 | — | — | 0 | 0 | 83872.121 | 0 | 0 |
| candidate | 0 | — | — | — | — | — | — | — |

| arm | input 均值 | cacheRead 均值 | cacheWrite 均值 | output 均值 |
| --- | --- | --- | --- | --- |
| baseline | 42399 | 97280 | 0 | 1733 |
| candidate | — | — | — | — |

## 累计预算与停止原因

| 指标 | 实测 |
| --- | ---: |
| provider 请求尝试 | 11 |
| input | 42399 |
| cacheRead | 97280 |
| cacheWrite | 0 |
| 合计输入 | 139679 |
| output | 1733 |

usage 完整且已知；逐行 token 合计与最终累计计数一致。请求和输入预算均未耗尽；实际停止原因是 `threshold-not-reached`，不是预算超限、缺决定记录或模型任务判分错误。累计输入会重复计入多次请求的上下文，不能直接拿它与单次上下文阈值比较。没有可靠美元费用，保持 unknown，不记作 $0。

## 限制与后续决定

- 本次只验证了真实入口、一次任务正确判分、未到阈值熔断和首次失败后停止。没有验证任何 candidate 轨迹、真实卸载、原生压缩或召回效果；不能作 A/B 收益或显著性结论。
- 05 的 faux 压力轨迹没有在这个真实 case 上复现。仅凭 11 turns / 14 toolCalls 无法确定模型如何读取材料；内层正文与工具轨迹未保留，不能断言具体捷径或诊断卸载实现失败。
- 规划者应先决定如何零费用审查任务与压力设计，再决定是否安排新实验。调整任务、阈值或再次真实执行不在本次授权内；需另行确认，绝不自动补跑。

## 私有产物与交付范围

- 指标：`~/.rotom/evals/compaction-offload/2026-10-26T06-57-34.037Z.jsonl`；文件 0600、目录 0700。
- 日志、reporter、生成/交叉核验脚本：`/tmp/rotom-offload-06.WKFiMz/`。原授权 receipt 保留。
- 只提交本报告与授权恢复；模型输出正文、JSONL、receipt、认证文件和本机日志均不提交。未升级产品、发布 npm、改变当前安装或推送 main。

## 核验意见（规划者，2026-10-26）

**执行合规，结论接受；回放设计不合格，需要零费用返工（任务 07）。**

- 执行面：只用了授权 `bb57fe6…` 一次，熔断按设计在第一个未达阈值的运行后停下，总共 11 次请求、合计输入约 14 万，远低于上限；授权已置回 `null`，receipt 保留。两处测试修正只是把「授权常量为 null」的断言改为显式传 `null`，没有放宽门禁，接受。报告区分了 `correct` 与回放验收，`not-run` 没有被当 0 统计，接受。
- 根因（规划者推断，依据是数字而非轨迹）：第一阶段要读 81 份文件（manifest + 20 modules + 60 notes，每份约 8 KiB，逐份 `read` 合计远超 64K token），但模型只用了 14 次工具调用、11 轮，平均每次请求上下文约 1.3 万 token。只有一种解释能对上：模型用 `bash` 批量查看（`cat`/`grep`/`head` 一次处理多份，Pi 的 bash 输出还会截到 50 KB），或者干脆没读，而 prompt 里的「read every listed file individually」管不住它。05 的 faux 压力测试按「每轮 10 次 `read`」建模，没覆盖「一条 bash 看完全部」这条路径，所以 faux 过了、真实没过。
- 缺口：metrics 只有 `turns`/`toolCalls` 计数，看不到工具名、读了哪些文件、每轮上下文多大，这次只能推断。下一次真实运行之前必须补上。

下一步见 [任务 07](../tasks/07-pressure-redesign.md)：去掉 `bash`、改由判分器跑检查，补轨迹元数据和第一阶段覆盖率，faux 证明「只能逐份读」时必过阈值。之后再申请第三次授权。
