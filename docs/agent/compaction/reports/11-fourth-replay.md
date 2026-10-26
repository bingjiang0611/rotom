# 任务 11 · 第四次真实回放

## 结果与执行边界

唯一一次 campaign 已结束，CLI exit 1；已落盘 13 次，invalid=0，有效配对=6，未执行=5。停止原因：usage-unknown。没有重跑、补跑或替换样本。

授权 `04c04dc8727bc17db973349fdc49fe34b85ca938`；执行源码 `1c79edffd479feff59891df19f56289858496b41`，所有行 sourceDirty=false。provider/model/thinking=`openai-codex/gpt-5.6-luna/low`，N=3，3000 请求 / 140000000 合计输入停止线。使用 SSE、maxRetries=0、仓内 Pi 1.4.0-rotom.2、Node v24.18.0。

UTC：2026-10-26T14:33:17Z → 2026-10-26T15:00:05Z。contextWindow=272000，reserveTokens=208000，T=64000，keepRecentTokens=5120。未改 fixture、原 prompt、续读模板、工具面、判分、预算或停止规则。

结束后 LIVE_AUTHORIZATION 已恢复 null；收据保留，授权不可再次使用。原始会话按原 harness 清理；JSONL、reporter 及驱动证据仅留本机，没有模型输出正文进入本报告。

6 个有效配对中，两臂均为 6/6 正确。candidate 的平均压缩等待比 baseline 低 67.42%，但合计输入高 6.70%、平均 wallMs 高 1.01%；这是本次样本描述，不是总体收益或因果结论。candidate 共出现 9 次 defer 和 1 次 defer_stale，不能把计数10当作10次独立卸载。

## 每次运行（未执行不造行）

C=config-aggregate，E=deferred-exact，M=multi-file-fix；B=baseline，A=candidate；数字为 repetition。时间均为 ms。correct 是任务判分，status 是实验有效性，二者不互相替代。

| # | run | status/reason | correct | 请求 | threshold/native/defer | nudges | wait | wall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | C1B | completed | True | 29 | 2/2/0 | 1 | 7638.299 | 169727.966 |
| 2 | C1A | completed | True | 13 | 2/1/1 | 0 | 4001.507 | 83130.206 |
| 3 | C2A | completed | True | 24 | 2/0/2 | 0 | 267.386 | 176077.384 |
| 4 | C2B | completed | True | 27 | 2/2/0 | 1 | 9789.659 | 126709.958 |
| 5 | C3B | completed | True | 23 | 2/2/0 | 1 | 8497.885 | 152805.455 |
| 6 | C3A | completed | True | 21 | 2/0/2 | 1 | 127.384 | 123972.315 |
| 7 | E1B | completed | True | 24 | 2/2/0 | 0 | 8314.908 | 101296.347 |
| 8 | E1A | completed | True | 17 | 2/1/1 | 0 | 4660.592 | 137763.487 |
| 9 | E2A | completed | True | 12 | 3/1/2 | 0 | 8822.442 | 77890.993 |
| 10 | E2B | completed | True | 13 | 2/2/0 | 0 | 9330.207 | 78111.135 |
| 11 | E3B | completed | True | 17 | 2/2/0 | 0 | 11482.988 | 104817.485 |
| 12 | E3A | completed | True | 23 | 2/0/2 | 1 | 56.026 | 142029.954 |
| 13 | M1B | failed/usage-unknown | False | 24 | 0/0/0 | 2 | 0 | 128856.734 |

未执行：M1A, M2A, M2B, M3B, M3A。

| run | input | cacheRead | cacheWrite | output | 合计输入 | 累计请求 | 累计输入 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1B | 232312 | 411136 | 0 | 10325 | 643448 | 29 | 643448 |
| C1A | 189146 | 210304 | 0 | 4344 | 399450 | 42 | 1042898 |
| C2A | 181175 | 615040 | 0 | 9657 | 796215 | 66 | 1839113 |
| C2B | 229542 | 395136 | 0 | 5552 | 624678 | 93 | 2463791 |
| C3B | 253449 | 279680 | 0 | 10089 | 533129 | 116 | 2996920 |
| C3A | 180778 | 524416 | 0 | 9448 | 705194 | 137 | 3702114 |
| E1B | 215208 | 306944 | 0 | 4541 | 522152 | 161 | 4224266 |
| E1A | 224846 | 287616 | 0 | 9355 | 512462 | 178 | 4736728 |
| E2A | 168192 | 62464 | 0 | 4129 | 230656 | 190 | 4967384 |
| E2B | 216413 | 155520 | 0 | 4401 | 371933 | 203 | 5339317 |
| E3B | 244775 | 223360 | 0 | 9470 | 468135 | 220 | 5807452 |
| E3A | 165575 | 565888 | 0 | 9281 | 731463 | 243 | 6538915 |
| M1B | 71051 | 316288 | 0 | 4767 | 387339 | 267 | 6926254 |

第13次的 correct=false 是 failureMetrics 的失败占位，不是完成解题后的判分结论。该行 usageComplete=false、累计 usageKnown=false；其 token 和最后累计值均为已记录小计，未知请求不能按 0 费用计算。前12次两项 usage 标志均为 true。

## 轨迹元数据

覆盖是成功读取的 manifest 路径去重数，不保证每份读取完整；partialReads 单列。contextPeak 是 assistant usage 的 input+cacheRead+cacheWrite 峰值，不等于 Pi 在工具结果追加后的阈值估计。read 分布包含 manifest、失败/重复/非 manifest 请求；同回复多次 read 不证明实际并行。

| run | 覆盖/总数 | partial | turns | tools | contextPeak | 阈值轮 | recall/命中旧卸载ID | 卸载结果 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1B | 120/120 | 60 | 26 | read:126,edit:1 | 66628 | 14,21 | 0/0 | 0 |
| C1A | 120/120 | 0 | 12 | read:126,edit:1 | 63839 | 7,10 | 0/0 | 60 |
| C2A | 120/120 | 0 | 24 | read:126,obs_recall:1,edit:1 | 60744 | 12,17 | 1/1 | 91 |
| C2B | 120/120 | 0 | 24 | read:127,edit:1 | 64547 | 11,20 | 0/0 | 0 |
| C3B | 120/120 | 0 | 20 | read:129,edit:1 | 69030 | 9,15 | 0/0 | 0 |
| C3A | 120/120 | 0 | 21 | read:126,edit:1 | 59450 | 10,15 | 0/0 | 91 |
| E1B | 120/120 | 120 | 22 | read:123 | 64124 | 16,20 | 0/0 | 0 |
| E1A | 120/120 | 0 | 16 | read:124,obs_recall:1 | 66368 | 8,11 | 1/1 | 61 |
| E2A | 120/120 | 120 | 11 | read:122 | 101970 | 8,9,9 | 0/0 | 100 |
| E2B | 120/120 | 0 | 11 | read:123 | 64174 | 7,9 | 0/0 | 0 |
| E3B | 120/120 | 0 | 15 | read:124 | 66310 | 8,11 | 0/0 | 0 |
| E3A | 120/120 | 0 | 23 | read:122,obs_recall:1 | 61897 | 14,18 | 1/1 | 96 |
| M1B | 51/121 | 0 | 24 | read:52 | 45583 | — | 0/0 | 0 |

第一阶段 read 序列使用无损游程表示：v×n 表示连续 n 轮均为 v。min/median/max 分别列含 0 与去 0 两版；续读属于第一阶段。完整 contextByTurn 数组保留在私有 JSONL，不把峰值表称为完整逐轮文本。

| run | read 序列 | 含0 min/median/max | 去0 min/median/max |
| --- | --- | --- | --- |
| C1B | 1×8,6,7,10×2,20,0,1,10×5,9,0 | 0/3.500/20 | 1/6.500/20 |
| C1A | 1×3,18,20×2,40,20,0 | 0/18/40 | 1/19.000/40 |
| C2A | 1×6,10,5,10×4,0,10×6,0 | 0/10.000/10 | 1/10.000/10 |
| C2B | 1×7,14,20×3,0,1×3,10×3,8,0 | 0/1.000/20 | 1/1.000/20 |
| C3B | 1×5,16,20×3,0,1×3,38,0 | 0/1/38 | 1/1/38 |
| C3A | 1,2,1×2,6,10×5,0,10×6,0 | 0/10.000/10 | 1/10.000/10 |
| E1B | 1×11,10×3,20×2,1,20×2,0 | 0/1.000/20 | 1/1/20 |
| E1A | 1×4,17,20×2,10,0,20×2,1,11,0 | 0/5.500/20 | 1/10.500/20 |
| E2A | 1×6,15,100,0 | 0/1/100 | 1/1.000/100 |
| E2B | 1×3,18,20×2,60,1,0 | 0/1/60 | 1/9.500/60 |
| E3B | 1×3,10,8,20×3,1,20×2,1,0 | 0/8/20 | 1/9.000/20 |
| E3A | 1×7,10×5,0,10×6,5,0 | 0/10/10 | 1/10/10 |
| M1B | 1×12,0,1×6,10,12,0,12,0 | 0/1.000/12 | 1/1/12 |

## 卸载决定

baseline 关闭卸载，决定数组为空；下表为所有 candidate 决定，按每个 run 的 ledger 顺序。after 是比例校准估计，不是 provider 实测 token；defer 目标为 0.6×64000=38400。

| run/决定序号 | decision | reason | before | after | T | candidates | originalBytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1A/1 | native | insufficient_savings | 95359 | 48335.523 | 64000 | 61 | 184787 |
| C1A/2 | defer | — | 66292 | 16590.464 | 64000 | 60 | 182327 |
| C2A/1 | defer | — | 64632 | 22322.791 | 64000 | 51 | 154413 |
| C2A/2 | defer | — | 65966 | 31576.929 | 64000 | 40 | 121542 |
| C3A/1 | defer | — | 64424 | 22227.575 | 64000 | 51 | 154413 |
| C3A/2 | defer | — | 64672 | 30442.374 | 64000 | 40 | 121542 |
| E1A/1 | defer | — | 74064 | 23324.278 | 64000 | 61 | 184041 |
| E1A/2 | native | insufficient_savings | 65008 | 40739.544 | 64000 | 29 | 88128 |
| E2A/1 | native | insufficient_savings | 103239 | 88760.004 | 64000 | 21 | 62614 |
| E2A/2 | defer | — | 101993 | 18647.855 | 64000 | 100 | 303754 |
| E2A/3 | defer_stale | — | 101993 | 18647.855 | 64000 | 0 | 0 |
| E3A/1 | defer | — | 70196 | 23553.690 | 64000 | 56 | 168857 |
| E3A/2 | defer | — | 66089 | 31668.993 | 64000 | 40 | 121549 |

E2A/3 的 defer_stale 复用最近一次已确认的估计，candidates=0、originalBytes=0，未新卸载结果；其与前一决定对应同一 assistant 轮。源码 offload.ts 的 stale 分支直接取消重复压缩。因此表中的 deferred 总计包含这次取消，9次实际 defer 共卸载499个结果。

## 仅有效配对的比较

compactionOffloadPairedSummary：executedRuns=13，invalidRuns=0，validPairs=6，stopReason=usage-unknown。原始运行数字见上表；未配对或无效记录不混入以下均值。

### baseline（n=6）

| 项 | 值 |
| --- | --- |
| 任务成功 | 6/6 |
| 请求总数/均值 | 133/22.167 |
| threshold/native/defer 总数 | 12/12/0 |
| wait 均值/中位（含0） | 9175.658/8914.046 |
| wait 均值/中位（仅触发） | 9175.658/8914.046 |
| obsRecallCalls / recalledOffloaded 总数 | 0/0 |
| obsRecallCalls / recalledOffloaded 均值 | 0.000/0.000 |
| inputTokens 总数/均值 | 1391699/231949.833 |
| cacheRead 总数/均值 | 1771776/295296.000 |
| cacheWrite 总数/均值 | 0/0.000 |
| outputTokens 总数/均值 | 44378/7396.333 |
| wallMs 均值/中位 | 122244.724/115763.722 |

### candidate（n=6）

| 项 | 值 |
| --- | --- |
| 任务成功 | 6/6 |
| 请求总数/均值 | 110/18.333 |
| threshold/native/defer 总数 | 13/3/10 |
| wait 均值/中位（含0） | 2989.223/2134.446 |
| wait 均值/中位（仅触发） | 2989.223/2134.446 |
| obsRecallCalls / recalledOffloaded 总数 | 3/3 |
| obsRecallCalls / recalledOffloaded 均值 | 0.500/0.500 |
| inputTokens 总数/均值 | 1109712/184952.000 |
| cacheRead 总数/均值 | 2265728/377621.333 |
| cacheWrite 总数/均值 | 0/0.000 |
| outputTokens 总数/均值 | 46214/7702.333 |
| wallMs 均值/中位 | 123477.390/130867.901 |

逐对差值均为 candidate − baseline；请求包含摘要。

| task/rep | Δwait | Δ请求 | Δ合计输入 | Δwall | 两者任务都对 |
| --- | --- | --- | --- | --- | --- |
| C1 | -3636.791 | -16 | -243998 | -86597.760 | True |
| C2 | -9522.273 | -3 | 171537 | 49367.425 | True |
| C3 | -8370.501 | -2 | 172065 | -28833.140 | True |
| E1 | -3654.316 | -7 | -9690 | 36467.140 | True |
| E2 | -507.765 | -1 | -141277 | -220.142 | True |
| E3 | -11426.962 | 6 | 263328 | 37212.470 | True |

## defer 后召回与精确匹配

recalledOffloaded 的实现按分支时间顺序核对请求 ID 是否已经被卸载；它计数工具调用，不核验工具返回成功。现有指标不保存召回轮次、命中的具体卸载批次或结果状态。多次 defer 且召回非零时，不能把总计任意分配给每次 defer，也不能宣称每次都成功取回。原始 session 已按既有边界清理，本轮禁止新增观测代码或补跑，故下面如实保留 unknown。

| run/决定序号（含 stale） | 之后的 obs_recall 证据 |
| --- | --- |
| C1A/2 | 无：整个 run 的 obsRecallCalls=0 |
| C2A/1 | run 总计调用=1、命中此前卸载ID=1；本次归属与成功取回 unknown |
| C2A/2 | run 总计调用=1、命中此前卸载ID=1；本次归属与成功取回 unknown |
| C3A/1 | 无：整个 run 的 obsRecallCalls=0 |
| C3A/2 | 无：整个 run 的 obsRecallCalls=0 |
| E1A/1 | 唯一 defer 后发起 1 次命中卸载ID的调用；返回成功 unknown |
| E2A/2 | 无：整个 run 的 obsRecallCalls=0 |
| E2A/3 | 无：整个 run 的 obsRecallCalls=0 |
| E3A/1 | run 总计调用=1、命中此前卸载ID=1；本次归属与成功取回 unknown |
| E3A/2 | run 总计调用=1、命中此前卸载ID=1；本次归属与成功取回 unknown |

deferred-exact 的 grader 要求完整精确匹配并保护原材料；不输出答案内容。 本轮已执行结果：E1B=True (completed), E1A=True (completed), E2A=True (completed), E2B=True (completed), E3B=True (completed), E3A=True (completed)。

## 预算、局限与验证

最终累计请求=267/3000；input=2572462，cacheRead=4353792，cacheWrite=0，合计输入已记录小计=6926254/140000000；output 已记录小计=95359。最后一行 usageKnown/usageComplete=false；四项已报告 usage 与 campaign 累计独立求和一致，不代表完整计费。停止于 usage-unknown，而非已记录计数到达上限。美元费用 unknown，不写成 $0。

Vitest assertion 状态：{"failed": 1, "passed": 12, "pending": 5}，总数18；以逐项状态和 ledger 为准，不使用可能不一致的顶层 pending 总数。通用 eval reporter 因中断显示 comparisons unavailable；本报告采用实际 emitted compactionOffloadPairedSummary，并与私有逐行数字独立核对，不冒充通用 reporter 已完成比较。

第13次仅覆盖51/121，已尝试两次续读；最后 assistant 轮的 usage 合计为0，预算器据未知用量关闭 campaign。持久化边界只保留指标，底层错误正文未保存，不能确定是网络、服务端错误、流中断或其它原因；没有为查因发起额外推理。

已出现真实 defer 和对旧卸载 ID 的召回请求，是机制运行证据，不是稳定收益或成功取回的逐事件证明。续读次数、partialReads、批量大小和完整性在两臂间存在差异，等待、请求和 token 差值不能全部归因于卸载；样本小且非独立，不能据此作显著性或总体成本结论。

零费用门禁：真实运行前及恢复 null 后的 live/entry/metadata/read/coverage 专项均 34/34，typecheck PASS。未重复产品全量测试或真实 replay。staged 20,000-byte 门禁与 diff --check 通过；tracked-tree 公开扫描 7,837 项、0 finding。历史扫描仍为已接受的六个旧 commit 的 12 条 non-noreply 身份 finding（digest=cd29c5ac348a），不是全绿，没有新增例外或放宽规则。离线登录检查只确认存储凭据与模型目录存在，关闭 fetch、没有推理探针。

私有证据：`/tmp/rotom-offload-11.45xPFF`；ledger：`~/.rotom/evals/compaction-offload/2026-10-26T14-33-21.536Z.jsonl`，0600；父目录0700，授权 receipt 保留。执行命令仅一次：指定仓内 ROTOM_PI 及任务环境变量后 `npm run eval -- cases/compaction-offload.eval.ts --bail=1`。独占 live-started 标记、PID、UTC 起止、exit、source 与 reporter 均保留本机。

下一步由规划者决定是否另开零费用观测任务：记录最少的召回归属/返回状态，以及 allowlisted 错误类别（不记录正文），以便之后定位 usage-unknown；真实验证须重新授权。本轮不能从已丢弃的原始会话恢复这些证据，也不追加运行。
