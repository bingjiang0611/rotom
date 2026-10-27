# 任务 07 · 压力重设计（零费用）

## 结论

A→B→C→D 已完成，零费用验证通过。没有调用任何真实模型；`LIVE_AUTHORIZATION` 始终为 `null`，06 的授权和 receipt 未动。代码仅改 `rotom/evals/`，另新增本报告；未改 sol-pi、Pi fork、产品默认、64K 阈值、5,120 keepRecentTokens、预算或停止规则。

**不能把标题中的“必然越过阈值”理解为真实模型保证。** 合规的每轮 20 次 read 在三个任务、两臂中均于第一阶段触发阈值；只读 5 份的轨迹仍会被 `threshold-not-reached` 熔断。真实模型尚未验证。

另一项重要结果：20 次 read 同轮返回时，candidate 的三次阈值决定全部为 `native / insufficient_savings`，并未卸载。10 次 read/轮和逐份 read 的原有正向轨迹仍能 defer。没有为让实验“看起来成功”而改卸载逻辑或留存窗口。

## A. 轨迹元数据

`src/compaction-offload-metrics.ts` 从持久化当前分支计算，而不是从压缩后会丢失旧轮次的 `session.messages` 计算：

| 字段 | 口径 |
| --- | --- |
| `toolNames` | 全运行中 assistant 发出的各工具调用数，包括失败调用；总和等于 toolCalls |
| `phase1Coverage.readFiles` | 第一个 user prompt 到其最终 assistant 回复之间，成功 read 的 manifest 条目去重数 |
| `phase1Coverage.totalFiles` | manifest 条目总数，不含 manifest.json 本身 |
| `phase1Coverage.partialReads` | 上述成功 read 中实际 offset/limit 未覆盖全文件，或工具报告截断的调用数；重复部分读取分别计数 |
| `contextByTurn` | 每个持久化 assistant usage 的 input + cacheRead + cacheWrite，按顺序排列；不混入原生摘要的额外 usage 条目 |
| `contextPeak` | contextByTurn 的最大值；完整性仍由 usageComplete 标记，错误/中断时不能把缺失 usage 的 0 当成已证实空上下文 |

路径只用于内部判定是否属于 manifest，不进入这些输出字段；正文也不进入字段。匹配当前 ASCII fixture 的相对路径、绝对路径、`./`、`..` 和 Pi 的 `@` 前缀。第二阶段补读不回填第一阶段覆盖率。旧 JSONL 不补写。

精确数值检查：合成消息序列包含重复 read、失败 read、非 manifest read、offset/limit、工具截断和最终回复之后的 read，得到 `toolNames={read:8}`、覆盖 `1/3`、`partialReads=3`、`contextByTurn=[12,29,40,10]`、`contextPeak=40`。序列中的私有路径/正文均不出现在输出。将实现临时改为只计 input 的负对照按预期失败（数组变为 `[7,20,30,8]`），已恢复并通过验证。

实际产品 faux 的完整 20-read 轨迹，两臂的这些聚合相同：

| task | toolNames（全运行） | 第一阶段覆盖 | partialReads | contextPeak（全运行） |
| --- | --- | --- | ---: | ---: |
| config-aggregate | read=82, write=1 | 80/80 | 0 | 47702 |
| deferred-exact | read=82 | 80/80 | 0 | 47613 |
| multi-file-fix | read=83, write=3 | 81/81 | 0 | 55508 |

## B. 工具与 fixture

- 两臂均只开放 `read/edit/write/obs_recall`；不开放 bash、codemode 或其它执行工具。测试核对每个请求的工具 schema 相同。
- **只删 bash 不足够。** Action Fusion 的 edit/write `then_run` 会直接创建并执行 Bash tool，不依赖 bash 是否在可见名单中。因此仅将隔离的 `REPLAY_CONFIG.actionFusion` 置为 false，两臂一致；产品默认未变。实际 schema 的负对照在旧配置下因仍含 `then_run` 失败，关闭后所有可见工具均无该字段。没有修改 sol-pi 源码或新增拦截框架。
- config-aggregate 和 multi-file-fix 不再让模型运行 node 检查，完成后回复 DONE。deferred-exact 仍回复精确代码，不能为了统一 DONE 而改变原判分。
- multi-file-fix 的 `logs/test-output.txt` 含同一份 failureLog 和原有断言说明，纳入 manifest；prompt 要求读取它。`test.mjs` 保留且仍受保护；`gradeReplay` 在模型结束后运行检查，规则未变。
- faux 不再发 bash 调用；压力/普通召回路径的检查点改用 read。运行时没有额外 summary、模型分类器或模型 judge。
- prompt 保持中性，不提示压缩、卸载或 obs_recall。现有工具仍允许模型少读、部分读或不遵守阶段约定；这是测量与熔断问题，不宣称工具白名单构成 OS 安全沙箱。

材料：config-aggregate、deferred-exact 各 80 个 manifest 条目，multi-file-fix 为 81 个（仅多了失败日志）。未增加其它材料份数。主要文件仍约 8 KiB，新增日志约 4.5 KiB。

### 实际 Pi read 行为

在当前产品 Pi 1.4.0-rotom.2 上直接调用原生 read，非 mock：三个任务的全部 manifest 与条目共 244 次检查，返回文本均与 fixture 完全一致、没有截断。

| 输入 | 实测行为 |
| --- | --- |
| 单个约 8 KiB fixture | 完整返回；一次调用只有一个 path |
| 目录 | EISDIR，不枚举或递归读取 |
| 通配符路径 | ENOENT，不展开 glob |
| 超过 2,000 行 | 按行截断并提示继续 offset |
| 超过 50 KiB | 按字节截断并提示继续 offset |
| 单行超过 50 KiB | firstLineExceedsLimit，只给提示，不返回完整行 |
| offset/limit | 按所选行读取，尚有内容时给继续位置 |

超长单行的原生提示会建议 bash；本工具面无 bash，不能当作可用的后备能力。现有 fixture 不触及该限制；未来扩大压力应增加文件数，而不是依赖超长单行。

## C. 两种轨迹

### 每轮 20 次 read

“并行”指同一个 assistant 回复提交 20 个 read toolCall，不等于 20 次模型请求。保留每轮 10 次和逐份读取的相邻回归。

以下是第一阶段的 **assistant usage 上下文数组**；同一 task 的两臂数组相同：

| task | contextByTurn（第一阶段） | 阶段峰值 | 首阶段材料 token 代理总量 |
| --- | --- | ---: | ---: |
| config-aggregate | [3670,4161,45722,45499,45421,45523] | 45722 | 165303 |
| deferred-exact | [3670,4131,45758,45469,45391,45493] | 45758 | 165396 |
| multi-file-fix | [3684,4174,45757,45493,45414,45516,46697] | 46697 | 166496 |

材料按 05 faux 的逐文件 `ceil(chars/4)` 口径，均超过所要求的 83K，远大于 64K 的 30% 余量。它是局部文本代理，不是真实模型 tokenizer 或计费值。

三个任务、两臂均在 assistant 第 `[3,4,5]` 轮之后触发阈值，早于 READY；各有 3 次原生压缩、0 次 defer，任务判分均正确。candidate 决定记录完整，全部是 `insufficient_savings`。

**为什么 usage 峰值不到 64K，却已触发阈值？** usage 是发起模型请求时的上下文。该轮返回 20 个工具结果后，上下文才变大；Pi 在下一次请求之前检查阈值并压缩。candidate 的阈值 before 约 87K，尝试卸载后的 after 约 47K，仍高于目标 `0.6 × 64000 = 38400`。代码核对：Pi 的切分点不允许落在 toolResult，保留尾部退回发出这批调用的 assistant 边界；这 20 份工具结果一起留存。卸载只处理切分点之前的候选，因此本轨迹必须原生兜底。不能用请求时 usage 峰值否定这些阈值事件，也不能把累计材料 token 冒充同时留存上下文。

最初把既有 10-read 的“必须 defer”断言直接用于新 20-read 场景时，三个新测试失败。核实决定记录后，新 20-read 测试改为严格断言原生次数与 `insufficient_savings` 原因；既有 10-read 的 defer 断言保留。这是区分压力覆盖与卸载成功，不是降低任务要求。

### 只读 manifest 与 5 个条目

| task | 第一阶段 contextByTurn | 全运行 contextByTurn | 全运行峰值 | 第一阶段覆盖 | 请求数 |
| --- | --- | --- | ---: | --- | ---: |
| config-aggregate | [3670,4161,14592] | [3670,4161,14592,14632,16725,16772] | 16772 | 5/80 | 6 |
| deferred-exact | [3670,4131,14526] | [3670,4131,14526,14559,16646] | 16646 | 5/80 | 5 |
| multi-file-fix | [3684,4174,14601] | [3684,4174,14601,14648,16738,18968,21189,23412] | 23412 | 5/81 | 8 |

三者 partialReads=0，thresholdCompactions=0。toolNames 分别为 `{read:7,write:1}`、`{read:7}`、`{read:7,write:3}`：额外一次 read 是第二阶段补读，不计入第一阶段覆盖。

三个 case 虽然任务判分正确，既有 campaign 均将其标为 `failed / threshold-not-reached`；下一运行标 `not-run`，runtime factory 不再调用、请求数不再增加。停止发生在整 case 结束后的既有检查点，不声称在 READY 当场新增熔断。低覆盖率是这条已知脚本轨迹的证据，不从调用数反推 06 的未知具体操作。

## D. N=3 费用规划（不是新授权）

以下从最终代码的每任务、每臂一次 faux 测量外推 N=3，共 18 次；包含原生摘要请求，cacheRead/cacheWrite 在 faux 中为 0。不是付费实测，也不是统计区间。

| 每轮 read 数 | 请求数外推 | 合计输入代理 | output 代理 |
| --- | ---: | ---: | ---: |
| 1 | 1566 | 53542605 | 54111 |
| 10 | 273 | 9217287 | 53793 |
| 20 | 228 | 7243218 | 54756 |

241 个材料的 chars/4 平均约 2,063 token。按任务要求，用真实每份 2,500–3,000 token 假设，将上述合计输入整体乘以 `2500/2063.05` 至 `3000/2063.05`：

- 1–20 read/轮场景的输入估算约 **8.78M–77.86M**。
- 对上端另留 **25% 规划余量**：约 **97.32M** 输入；请求上端 `ceil(1566 × 1.25) = 1958`。
- 对照参考停止线 2,000 次 / 100M：在这些假设下够用，但只余约 42 次请求、2.68M 输入，余量很薄。建议下一份授权仍将它们视为停止线，不能承诺完成全部 18 次；本轮不建议或执行自动上调。

25% 是人为规划余量，不是置信区间。真实模型可能多读、分页召回、输出更长摘要，或采用未覆盖的并行度；没有证明真实请求/输入的硬上界。缓存占比未沿用 04b 的旧测量，因为工具面已变；输入预算本来就计入 cacheRead/cacheWrite。output 没有独立熔断，美元价格仍 unknown。**06 授权已消费，后续真实运行仍需新记录及 bob 确认。**

## 验证与范围

环境：Node v24.18.0，产品 Pi 1.4.0-rotom.2，Vitest 4.1.9；Mac 本机，无真实模型。

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| 指定 registry 的 npm ci --ignore-scripts | PASS，lockfile 未变 | npm-ci.log |
| 指定 compaction-offload-eval 专项 | 21/21 | focused-final.log |
| LIVE=0 的 live/entry 专项 | 25/25 | live-entry-final.log |
| 新元数据与实际 read 专项 | 2/2 | metadata-read.log，且全量复验 |
| 显式 faux provider，N=3 case | 18/18 | faux-n3.json |
| 指定产品 ROTOM_PI / ROTOM_TEST_PI 的 npm test | 146 passed / 1 既有 skip | full-test.log |
| npm run typecheck | PASS | typecheck-final.log |
| 两个负对照 | 按预期失败，修复已恢复 | action-fusion-negative.log、context-negative.log |
| diff 与 staged 文件大小检查 | PASS | 提交前验证 |
| tracked-tree 公开审计 | PASS，7,827 项、0 findings | worktree-audit.log |

完整命令沿用任务 07 的验收清单；所有 faux/live-entry 命令显式关闭 LIVE，真实授权未填入。全量的唯一 skip 是未设置 `ROTOM_TEST_SIDECAR` 的既有条件测试。

初次把 npm ci/typecheck 串在 300 秒命令中，npm ci 用时约 4 分钟后，typecheck 被外层 timeout 终止；检查日志与进程后仅单独重跑 typecheck，未重复安装。其后专项和全量均正常完成，未放宽测试内部超时。npm ci 仍报告既有 8 项漏洞（3 moderate、5 high），未扩大本任务去升级依赖。

本机证据保留在 `/tmp/rotom-offload-07.D97U6g/`，包含日志、faux reporter、规划数据。报告仅含聚合指标，不提交 JSONL、原始工具内容或认证文件。真实模型的合规率、阈值覆盖率、卸载收益及费用仍未验证；下一步由规划者先评审“20-read 会原生兜底”及预算余量，再决定是否新授权。

## 核验意见（规划者，2026-10-26）

**accepted（`9c93646`）。** 规划者在本环境（Node 24.22.1）重跑：`compaction-offload-eval` 21/21；LIVE=0 下 live/entry/metadata/read 四个专项 27/27；typecheck 通过；`git diff --check origin/main...HEAD` 干净；tracked-tree 公开审计 PASS、0 findings。全量 `npm test` 未重跑，采信报告的 146/1 skip。

- 发现 Action Fusion 的 `then_run` 会绕过工具白名单直接跑 shell，并只在回放配置里关掉，这是任务说明漏掉的点，处理正确。代价是回放与生产配置多了一处差异（生产默认开 Action Fusion），它只影响 edit/write 的形态，不影响卸载候选，接受。
- 最重要的结果是「每轮 20 次 read 时 candidate 三次都只能原生摘要」，执行者没有为了好看去改断言或卸载逻辑，做得对。规划者核对了原因：Pi 的切分点不能落在 toolResult 上，最后一批 20 份结果（约 41K token）整体留在保留区；而推迟目标是 `0.6 × 64K = 38.4K`，单批就已经超过目标，不管卸载掉多少旧结果都不可能推迟。
- 这是**缩小阈值带来的比例失真**，不是卸载机制在生产里的真实表现：生产阈值约 255K，同样一批 20 份 8 KiB 的读取只占约 16%。06 里模型恰恰是一次看很多份的风格，按现在的 fixture 去跑第三次付费回放，很可能 candidate 全部原生兜底，钱花了却只能得到「回放设计失真」这个结论。
- 预算余量：最坏情形（每轮 1 次 read）外推上端约 97M 输入、1,958 次请求，贴着现有停止线，执行者已如实标出。

因此第三次付费回放之前，先做[任务 08](../tasks/08-batch-share.md)：把单份材料缩小，使一批 20 份读取占阈值的比例接近生产。
