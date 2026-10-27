# 任务 13 · multi-file-fix 单任务真实回放

## 执行结果与边界

唯一一次 campaign 已结束，CLI exit 0。已记录 6 次：completed=6，invalid=0，provider-error=0，unusable=0；有效配对=3，计划中未执行=0。累计 stopReason=null（未触发熔断）。无重跑、补跑或替换。

授权 `0422d9564678a97593f085ecd32db19c41657398`；执行源码 `a6c014a109680db907217e6608609b1d27369883`，全部 sourceDirty=false。只选择 multi-file-fix，openai-codex / gpt-5.6-luna / low，N=3；上限800请求、40000000合计输入（未知按contextWindow计入）。UTC：2026-10-27T03:06:02Z → 2026-10-27T03:17:31Z。

环境：Node v24.18.0、产品 Pi 1.4.0-rotom.2；contextWindow=272000，reserveTokens=208000，T=64000，keepRecentTokens=5120。SSE、maxRetries=0。fixture、prompt、续读模板、工具、Action Fusion关闭、判分及停止规则均未改。结束后 LIVE_AUTHORIZATION 已恢复 null，授权 receipt 保留且已消费。

实际结果：两次真实 defer 各卸载46个结果，随后各有一次命中该批次的召回，工具均未标记错误，最终修改均判分正确。两次召回都发生在第一阶段；第二阶段没有 obs_recall。M2A 没有卸载，但同样比配对 baseline 更快，不能把本轮 candidate 的全部优势归因于卸载。

## 每次运行

M=multi-file-fix；数字为repetition；B=baseline，A=candidate。时间单位ms。correct是任务判分，status是回放有效性；failed行的correct=false可能只是failureMetrics占位，不能当作完成答题后的错误结论。

| # | run | status/reason | correct | 请求 | threshold/native/deferred | nudges | wait | wall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | M1B | completed | true | 43 | 2/2/0 | 2 | 9410.571 | 149528.259 |
| 2 | M1A | completed | true | 24 | 2/1/1 | 0 | 4346.735 | 86326.711 |
| 3 | M2A | completed | true | 16 | 1/1/0 | 0 | 4243.003 | 74363.800 |
| 4 | M2B | completed | true | 31 | 2/2/0 | 0 | 9815.208 | 140061.588 |
| 5 | M3B | completed | true | 36 | 2/2/0 | 2 | 8882.447 | 138883.419 |
| 6 | M3A | completed | true | 18 | 2/1/1 | 0 | 8075.422 | 95865.339 |

| run | input | cacheRead | cacheWrite | output | 合计输入 | pessimistic增量 | usageComplete | 累计请求/输入 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M1B | 225357 | 827136 | 0 | 11938 | 1052493 | 0 | true | 43/1052493 |
| M1A | 199558 | 416000 | 0 | 5158 | 615558 | 0 | true | 67/1668051 |
| M2A | 177630 | 345728 | 0 | 4404 | 523358 | 0 | true | 83/2191409 |
| M2B | 233495 | 529280 | 0 | 12207 | 762775 | 0 | true | 114/2954184 |
| M3B | 232446 | 563456 | 0 | 10547 | 795902 | 0 | true | 150/3750086 |
| M3A | 213169 | 317056 | 0 | 9322 | 530225 | 0 | true | 168/4280311 |

inputAccounting=reported-or-context-window，outputAccounting=reported-subtotal。悲观请求用整个contextWindow替换该请求的部分input/cacheRead/cacheWrite，非叠加；输出只保留有效已报告小计。累计usageKnown一旦false就不恢复，后续单次usageComplete仍可为true。

## 轨迹与决定

coverage为成功读取的manifest路径去重数，partialReads单列，不等于全文读取证明。contextPeak是assistant usage合计的峰值，不等于工具结果追加后的Pi阈值估计；同回复批次不证明物理并行。

| run | coverage | partial | turns | tools | contextPeak | 阈值轮 | 卸载结果 | recall/命中 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M1B | 121/121 | 0 | 40 | read:129,edit:3 | 57452 | 27,32 | 0 | 0/0 |
| M1A | 121/121 | 0 | 23 | read:125,obs_recall:1,edit:3 | 57468 | 16,18 | 46 | 1/1 |
| M2A | 121/121 | 121 | 15 | read:128,edit:3 | 73639 | 9 | 0 | 0/0 |
| M2B | 121/121 | 20 | 29 | read:151,edit:3 | 66518 | 11,18 | 0 | 0/0 |
| M3B | 111/121 | 0 | 32 | read:116,edit:3 | 57588 | 20,26 | 0 | 0/0 |
| M3A | 121/121 | 0 | 17 | read:125,obs_recall:1,edit:3 | 62288 | 11,13 | 46 | 1/1 |

需要特别区分有效性与等量工作：M3B 两次续读后仍仅覆盖111/121，但已触发阈值并正确修复，因此按既定规则仍有效；M2A 有121次partialReads，M2B有20次。各臂实际读取的材料量、批次与续读轨迹不相同。

第一阶段read序列用v×n表示连续n轮均为v；包括续读、manifest、失败/重复请求和零read回复。完整contextByTurn在私有JSONL中，不将峰值冒充全文。

| run | phase1 read序列 | 含0 min/median/max | 去0 min/median/max |
| --- | --- | --- | --- |
| M1B | 1×21,10,0,10×2,0,10×7,1×2,0 | 0/1.000/10 | 1/1/10 |
| M1A | 1×13,8,25×2,0,50,1,0 | 0/1.000/50 | 1/1.000/50 |
| M2A | 1×6,15,50×2,1,0 | 0/1/50 | 1/1.000/50 |
| M2B | 1×7,14,20×3,10,1,10×5,1×2,0 | 0/1/20 | 1/5.500/20 |
| M3B | 1×13,8,10,1,0,10×4,0,10×4,0 | 0/1/10 | 1/1.000/10 |
| M3A | 1,3,1×6,11,25×2,0,51,0 | 0/1.000/51 | 1/1.000/51 |

baseline的offloadDecisions为空。下表保留所有candidate决定及其顺序；after是比例校准估计，非provider精确token。defer_stale仅取消重复触发，不是一次新卸载；0.6×T=38400。

| run/决定 | decision | reason | before | after | T | candidates | originalBytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M1A/1 | defer | — | 69341 | 33108.744 | 64000 | 46 | 139134 |
| M1A/2 | native | insufficient_savings | 77958 | 58901.756 | 64000 | 25 | 75974 |
| M2A/1 | native | insufficient_savings | 112988 | 58588.249 | 64000 | 71 | 215108 |
| M3A/1 | defer | — | 71400 | 34975.170 | 64000 | 46 | 139134 |
| M3A/2 | native | insufficient_savings | 82523 | 63236.962 | 64000 | 25 | 75974 |

## 逐次召回、错误与修改结果

turn为该run的1基assistant轮号。offloadIndex为此前已提交卸载记录的1基编号，不把native/defer_stale计为新批次；不能直接拿它索引上表所有ledger行。resultError=false只证明工具未标记错误，true为标记错误，null为未见对应结果；不把false扩大为语义完整恢复。

| run | turn | offloaded | offloadIndex | resultError | 阶段 |
| --- | --- | --- | --- | --- | --- |
| M1A | 17 | true | 1 | false | 第一阶段 |
| M3A | 12 | true | 1 | false | 第一阶段 |

主assistant的errors全部为空。

errors类别分布：{}；pessimisticRequests=0。分类只来自固定规则，不是根因证明；摘要请求错误不必对应主assistant错误条目，因此二者数量不必相等。未保存错误正文、工具参数、ID或输出内容。

M1A：deferred=1，recall=1（命中此前卸载ID=1），correct=true，status=completed。召回与判分是观察结果，不能据此断言召回是完成修改的必要条件。

M2A：deferred=0，recall=0（命中此前卸载ID=0），correct=true，status=completed。召回与判分是观察结果，不能据此断言召回是完成修改的必要条件。

M3A：deferred=1，recall=1（命中此前卸载ID=1），correct=true，status=completed。召回与判分是观察结果，不能据此断言召回是完成修改的必要条件。

当前元数据不保存召回对应的文件路径，也没有edit/write逐事件时间；因此不能证明召回对象就是被卸载的源文件，或精确证明调用发生在某次修改之前。上述阶段归属只用第一阶段轮数分界。不能把“曾召回且最后正确”写成“必须先取回才能改对”；因果必要性没有做额外干预实验，本轮也不补跑。

## 仅有效配对的汇总与差值

实际compactionOffloadPairedSummary：executedRuns=6，invalidRuns=0，providerErrorRuns=0，unusableRuns=0，validPairs=3。只比较同task/repetition两臂均completed的记录；有效但correct=false也保留分母。rawRuns与原始行逐项核对。

### baseline

| 项 | 值 |
| --- | --- |
| 成功 | 3/3 |
| 请求总数/均值 | 110/36.667 |
| threshold/native/deferred总数 | 6/6/0 |
| wait均值/中位（含0） | 9369.409/9410.571 |
| wait均值/中位（仅触发） | 9369.409/9410.571 |
| recall/命中总数 | 0/0 |
| recall/命中均值 | 0.000/0.000 |
| inputTokens 总数/均值 | 691298/230432.667 |
| cacheRead 总数/均值 | 1919872/639957.333 |
| cacheWrite 总数/均值 | 0/0.000 |
| outputTokens 总数/均值 | 34692/11564.000 |
| wall均值/中位 | 142824.422/140061.588 |

### candidate

| 项 | 值 |
| --- | --- |
| 成功 | 3/3 |
| 请求总数/均值 | 58/19.333 |
| threshold/native/deferred总数 | 5/3/2 |
| wait均值/中位（含0） | 5555.053/4346.735 |
| wait均值/中位（仅触发） | 5555.053/4346.735 |
| recall/命中总数 | 2/2 |
| recall/命中均值 | 0.667/0.667 |
| inputTokens 总数/均值 | 590357/196785.667 |
| cacheRead 总数/均值 | 1078784/359594.667 |
| cacheWrite 总数/均值 | 0/0.000 |
| outputTokens 总数/均值 | 18884/6294.667 |
| wall均值/中位 | 85518.617/86326.711 |

| 配对 | Δwait | Δ请求 | Δ合计输入 | Δwall | 两臂都正确 |
| --- | --- | --- | --- | --- | --- |
| M1 | -5063.836 | -19 | -436935 | -63201.548 | true |
| M2 | -5572.205 | -15 | -239417 | -65697.788 | true |
| M3 | -807.025 | -18 | -265677 | -43018.079 | true |

差值为candidate−baseline。样本小，续读/partialReads/请求批次等轨迹可能不同；不从均值或单对差值推断显著性或卸载的独立因果收益。

## 与任务11有效配对合并列示（仅原值）

C=config-aggregate，E=deferred-exact，M=multi-file-fix。每格B/A均为原始两臂值；不合并计算跨任务均值或显著性。任务11的失败M样本不进入此表；任务11已消费，不曾补跑。

| 任务来源/配对 | 请求B/A | 输入B/A | wait B/A | wall B/A | correct B/A |
| --- | --- | --- | --- | --- | --- |
| 11/C1 | 29/13 | 643448/399450 | 7638.299/4001.507 | 169727.966/83130.206 | true/true |
| 11/C2 | 27/24 | 624678/796215 | 9789.659/267.386 | 126709.958/176077.384 | true/true |
| 11/C3 | 23/21 | 533129/705194 | 8497.885/127.384 | 152805.455/123972.315 | true/true |
| 11/E1 | 24/17 | 522152/512462 | 8314.908/4660.592 | 101296.347/137763.487 | true/true |
| 11/E2 | 13/12 | 371933/230656 | 9330.207/8822.442 | 78111.135/77890.993 | true/true |
| 11/E3 | 17/23 | 468135/731463 | 11482.988/56.026 | 104817.485/142029.954 | true/true |
| 13/M1 | 43/24 | 1052493/615558 | 9410.571/4346.735 | 149528.259/86326.711 | true/true |
| 13/M2 | 31/16 | 762775/523358 | 9815.208/4243.003 | 140061.588/74363.800 | true/true |
| 13/M3 | 36/18 | 795902/530225 | 8882.447/8075.422 | 138883.419/95865.339 | true/true |

## 预算、验证与证据

最终累计：请求168/800，input=1281655，cacheRead=2998656，cacheWrite=0，合计输入=4280311/40000000，output已报告小计=53576，usageKnown=true，pessimisticRequests=0。所有逐行四项usage与累计独立求和一致。本轮 pessimisticRequests=0，全部六行 usageComplete=true，输入没有混入悲观估算；output字段仍遵守已报告小计合同。美元费用unknown。

Vitest逐项状态：{"passed": 6}；六个计划位置均是multi-file-fix。以逐项状态和ledger为准，不把顶层pending总数或工具exit单独当作业务结果。

真实运行前及恢复null后的七个零费用专项各60/60，typecheck通过；没有另跑真实探针或补跑。staged 20,000-byte 门禁与diff --check通过，无豁免；tracked-tree公开扫描7,843项、0 finding。历史扫描仍只有已接受的六个旧commit的12条non-noreply身份finding（digest=cd29c5ac348a），不是全绿，没有扩大例外或放宽规则。离线认证检查禁用fetch，只检查存储凭据与模型目录。本轮仅改授权常量及本报告，不改任何运行逻辑。

证据目录：`/tmp/rotom-offload-13.WZfKcO`；私有ledger：`~/.rotom/evals/compaction-offload/2026-10-27T03-06-05.703Z.jsonl`。JSONL为0600，父目录0700，原授权receipt保留；原始会话按原harness清理，JSONL与模型输出正文不入Git。

只执行一次命令：指定仓内ROTOM_PI，设置任务要求的六个环境变量及ROTOM_EVAL_COMPACTION_OFFLOAD_TASKS=multi-file-fix后，`npm run eval -- cases/compaction-offload.eval.ts --bail=1`。独占live-started目录、PID、源码SHA、UTC起止、退出码、console和reporter均保留本机。

本轮没有触发 provider-error 继续、悲观计费或三次不可用熔断；不把任务12的faux验证冒充本轮真实触发。如果规划者需要证明“召回的是源文件且在修改前”，应另行授权最小的非正文对象类别/修改时序观测；现有指标不能回填这些事实，真实验证须另获授权，不能补跑本次。
