# 任务 10 · 覆盖续读与无效样本（零费用）

## 结论与边界

A–D 已完成。第一阶段覆盖不足时，两臂使用同一确定性模板，最多追加两次续读；读满后或两次用完后进入原第二阶段。未达压缩阈值的运行记为 invalid，前两次不停止 campaign，累计第三次才停止。对比汇总仅使用同一授权、任务、repetition 下两臂均有效的配对。

本轮没有真实模型调用，`LIVE_AUTHORIZATION` 始终为 `null`。09 授权仍已消费，没有重新启用。只修改 `rotom/evals/` 与本报告；没有修改 fixture、原 scenario prompt、64K 阈值、5,120 保留区、工具面、判分函数、请求/token 预算、sol-pi 或 Pi fork。

起始基线：`b0e6f36a5ea0b2fea52449020a9518f7d3640ac5`。工作副本为 `/tmp/rotom-offload-09.me2OT2/repo`；原 `eval/system` 工作区未动。证据目录为 `/tmp/rotom-offload-10.21WOmN/`。

## A. 确定性续读

### 实现

- `pi-harness.ts` 增加可选 `continuePrompt({session, stepIndex})` 接缝；`pi-harness-lifecycle.ts` 在成功回复后调用它，返回 undefined 就结束当前 prompt。未配置回调的其它 eval 仍只发一次原 prompt。异常或取消不被当作可续读回复，也不重试失败推理。
- `compaction-offload-cases.ts` 只在既有第一步之后查询当前分支覆盖率。缺失数为 `totalFiles - readFiles`，大于 0 且尚未追加两次时，记录一次 coverageNudges 并发送模板。上限属于 replay 调用方，不增加通用重试框架。
- 续读仍使用原 session、同一运行、同一 runtime 和共享预算。一次续读 user 提示可能引发多个 provider 请求，不能把“最多两次提示”误读为“最多两次额外模型请求”。
- metrics 将最初 user 提示及随后 coverageNudges 条提示归入第一阶段。终止回复中的零-read 轮保留；第二阶段仍排除。coverageNudges、phase1Coverage、phase1ReadCallsByTurn 一并保存，路径和正文不进入新增指标。coverageNudges 记录选择并尝试的续读次数；异常路径不据此证明提示已成功送达，failed 行不进入有效配对。

模板只有缺失份数这个变量，不包含具体文件名或卸载指引：

```text
Audit phase is not complete: {n} listed files have not been read yet. Continue reading the remaining files from manifest.json individually, then reply READY.
```

两臂使用同一函数；缺失数量相同，发送文本逐字节相同。数量不同时只改变 n，不给任一臂额外文件清单。

### 覆盖语义

保持 07/09 的现有定义：readFiles 是成功读取的 manifest 路径去重数，partialReads 单独计数。续读没有把部分读取重新定义为未读，也没有改变任务判分。阶段归属依赖当前两步 scenario：第一步及其续读之后才是第二步；若以后插入其它 user 消息或改变阶段结构，须先扩展阶段标记与测试，不能直接套用当前计数。

## B. invalid、campaign 熔断与入口

| 情形 | 该行状态与原因 | campaign 行为 |
| --- | --- | --- |
| 未达阈值，第 1、2 个无效样本 | invalid / threshold-not-reached | cumulative.stopReason 仍为 null，继续既定下一次 |
| 累计第 3 个无效样本 | invalid / threshold-not-reached | halt(threshold-not-reached)，后续不再请求模型 |
| 已达阈值但缺少 candidate 决定记录 | failed / decision-ledger-incomplete | 立即停止，规则不变 |
| run-error、未知 usage、取消、预算或持久化错误 | 沿用原失败/停止路径 | 不等待累计三个无效样本 |

无效样本不替换、不重做，不创建额外 repetition；原 N=3 仍只有 18 个计划位置。原始 metrics、任务 correct、usage 和每行原因照常写入私有 JSONL。预算/未知 usage 的失败优先，不会被改写成可继续的 invalid。

### `--bail=1` 不能漏改

只改 campaign 还不够：原 automatic judge 在 invalid 上得 0，会先于测试体抛错，使 `--bail=1` 仍在第一次无效后停止。

因此 live 入口保留原判分公式和逐行 score，但将自动阈值设为 null，再显式处理：

1. 尚未触发 campaign 停止的 invalid 使用 Vitest skip，既不是成功，也不触发 bail。
2. 第三次 invalid 已有 stopReason，显式断言失败，触发 bail。
3. failed、not-run 及任务判分错误的 completed 仍失败；正确 completed 才通过。

真实 Vitest 子进程、`--bail=1`、mock campaign 的零模型检查得到以下顺序：

```text
invalid(skipped) → completed(passed) → invalid(skipped)
→ 第三个 invalid(failed) → 剩余 14 个 pending
```

执行计数恰为 4，没有进入第五次。这里的第 4 个计划位置是累计第 3 个 invalid；夹在中间的 completed 不重置计数。直接调用 campaign 时停止后的调用返回并持久化 not-run；CLI 使用 bail 时未进入的测试是 pending，未来报告应据计划标为 not-run，不伪造未执行行的 metrics。

### 配对汇总

`summary()` 在 live afterAll 输出 `compactionOffloadPairedSummary`：已记录的执行数、无效数、有效配对数、两臂汇总及 stopReason。另以 rawRuns 列出所有已记录执行的 task/arm/repetition/status/reason/metrics，包含无效和失败样本，不只给过滤后的均值。配对键包含授权 ID、task、repetition，只有两行都为 completed 才进入对比。

- invalid、failed、not-run 和孤立的有效单臂不进入比较；原始数字仍留在逐行日志，不删除不利样本。
- completed 但任务 correct=false 的有效样本仍保留在成功率分母，不能靠删掉答错样本提高成功率。
- 没有有效配对时，两臂汇总为 null，不填 0。所有统计以提供的已持久化记录为范围，持久化 unknown 不补造数据。

## C. Faux 证据

### 1. 先读 50 份，续读后读满

两个实际产品 faux session 使用同一脚本：先读 50 份回复 READY，再根据一条续读提示完成剩余 70 份。

| arm | 覆盖 | coverageNudges | 阈值次数 | native / defer | provider 请求 | 第一阶段 read 请求合计 |
| --- | --- | ---: | ---: | --- | ---: | ---: |
| baseline | 120/120，partial=0 | 1 | 1 | 1 / 0 | 20 | 121 |
| candidate | 120/120，partial=0 | 1 | 1 | 0 / 1 | 18 | 121 |

两者提示的 Buffer 字节比较相等，任务判分正确。121 包含 manifest 的一次读取。baseline 的这一次压缩包含两个摘要请求，因此比 08 的对应 10-read 正常轨迹多两次请求；candidate 多一次。这也说明不能只按 user 提示数估算推理开销。

### 2. 两次续读仍只读 5 份

| task | 覆盖 | nudges | threshold | 单次请求 | contextPeak | 后续行为 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| config-aggregate | 5/120 | 2 | 0 | 8 | 9191 | invalid 后下一臂仍运行 |
| deferred-exact | 5/120 | 2 | 0 | 7 | 9067 | invalid 后下一臂仍运行 |
| multi-file-fix | 5/121 | 2 | 0 | 10 | 11630 | invalid 后下一臂仍运行 |

三者 partialReads=0、任务判分正确，但回放样本无效。阶段 read 数列为 `[1,5,0,0,0]`，两个续读中的零-read 回复属于第一阶段，不把第二阶段读操作混入。

### 3. 累计无效停止

| 运行轨迹 | 到停止时请求数 | 停止后一次调用 | 证明 |
| --- | ---: | --- | --- |
| invalid → invalid → invalid | 24 | not-run | 第三个之后 factory 不再调用，请求不增加 |
| invalid → completed → invalid → invalid | 35 | not-run | 计数是累计的，不被有效运行重置 |

保存的行与返回行逐项相等，包含 invalid 和停止后的 not-run；全程没有补跑或替换。预算线、native summary 预算、缺决定记录、持久化失败及 unknown append 的原回归仍通过。

### 4. 不偷懒轨迹保持原序列

完整专项给三个任务、两臂、1/10/20-read 轨迹都断言 coverageNudges=0；检查每轮 read 批次序列和结束回复中的 0，保留两臂 prompt/schema 一致性、同轮阈值与真实 read 工具检查。provider 请求数固定对照 08 的黄金值（含摘要）：

| task | 1-read baseline/candidate | 10-read baseline/candidate | 20-read baseline/candidate |
| --- | --- | --- | --- |
| config-aggregate | 126 / 125 | 18 / 17 | 12 / 11 |
| deferred-exact | 125 / 124 | 17 / 16 | 11 / 10 |
| multi-file-fix | 129 / 128 | 21 / 20 | 15 / 14 |

原 scenario、材料与 grader 未改，没有额外 user 提示；不把不同临时目录下的微小 token 代理或时间差说成收益。通用 promptAgent 单元检查也证明没有回调时只发原请求，失败时不调用续写回调。

### 5. 配对汇总与负对照

构造“一对有效 + 一次 invalid”：两条有效记录的 wait 为 10/20，无效记录为 999999。汇总只得到一对、wait 均值 10/20；有效 candidate 故意 correct=false，仍保留为 0/1 成功，无效样本不污染均值或分母。缺少完整配对时返回 null。rawRuns 的 metrics 与三条输入逐项一致，无效样本的 999999 仍可见；已停止后的 not-run 不混入已执行列表。

三项负对照均按预期失败，之后恢复实现并通过最终验证：

| 临时撤销 | 被哪项检查识别 |
| --- | --- |
| 禁用续读回调 | 50→120 的覆盖/nudges 断言失败 |
| 第一次 invalid 就 halt | 两个累计序列测试均在首条 stopReason 断言失败 |
| 恢复 automatic judgeThreshold=1 | 真实 Vitest 子进程在首个 invalid 就失败，序列检查失败 |

## D. 费用重估与停止线

### 依据与假设

09 只有一个完整 baseline：20 次 provider 请求、544,470 合计输入，含 cacheRead，平均 **27,223.5 输入 token/请求**。无法用一个样本估出统计意义的期望、续读成功概率或严格最坏值。以下是明确假设下的规划情景，不是新付费结果，也不是费用上界。

| N=3 情景（18 次运行） | 请求数 | 合计输入估计 | 请求加 25% | 输入加 25% |
| --- | ---: | ---: | ---: | ---: |
| 基准外推：每次接近 09 完整 baseline | 360 | 9800460 | 450 | 12250575 |
| 两次续读的保守批量情景：每段续读各再花一个完整 baseline 的量 | 1080 | 29401380 | 1350 | 36751725 |
| 逐份 read 压力情景：08 的 2271 + 36 个额外回复 + 18 个额外摘要 | 2325 | 63294637.5 | 2907 | 79118297 |

第二行情景假定续读最终得到有效样本；若始终无效，第三个 invalid 已提前停，不会跑完 18 个 invalid。第三行输入沿用 09 平均输入/请求，18 个额外摘要是规划余量，不是最多两个提示所能证明的摘要硬上限。25% 是人为余量，不是置信区间。

**对照 3,000 请求 / 140M 合计输入：上述按 09 平均量估算的情景够用，但不能保证所有允许轨迹都跑完 N=3。** 逐份情景加余量后请求只余 93 次，重复读取、更多摘要或持续多轮推理可能先触线。

再作 token 密度敏感性检查：08 较保守的逐份输入规划上端（已含 25%）约 136.98M。若另有 54 个新增请求：按 09 平均输入加算约 138.45M，已很接近 140M；若这些请求都接近 09 实测模型的 272K 窗口，则约 151.67M，会先触发原输入停止线。这不是预测它一定发生，而是说明不能把 09 的平均请求大小当作“最坏”。

严格能承诺的仍是原合同：不准入第 3,001 个请求；输入在 usage 返回后结算，已准入请求可能越过 token 线。最多两次续读不是每次最多一次 provider 调用，存在重读或模型迟迟不结束时仍靠原预算与 case 超时停止。没有改上限、输出预算或重试策略；美元费用 unknown。若下一步需要真实验证续读成功率，须另行明确授权，不复用 09。

## 验证与自审

环境：Node v24.18.0、Vitest 4.1.9、产品 Pi 1.4.0-rotom.2。本轮未安装新依赖或修改版本。

| 检查 | 结果 | 本机证据 |
| --- | --- | --- |
| compaction-offload-eval 专项 | 21/21 | focused.log |
| LIVE=0 的 live/entry/metadata/read 专项 | 29/29 | live-entry.log |
| 新 coverage 与 entry 专项 | 11/11 | coverage-final.log |
| 指定产品 ROTOM_PI / ROTOM_TEST_PI 的 npm test | 153 passed / 1 既有 skip | full-test.log |
| npm run typecheck | PASS | typecheck-final.log |
| 三项负对照 | 按预期失败，已恢复 | nudge-negative.log、invalid-negative.log、bail-negative.log |
| git diff --check origin/main...HEAD 与工作区 diff | PASS | 本地检查 |
| staged 20,000-byte 文件门禁 | PASS，无新增豁免 | check-staged-file-size.mjs |
| tracked-tree 公开扫描 | PASS，7,835 项，0 finding | audit-tree.json |
| tree+history 公开扫描 | BLOCKED，仅原来已接受的 12 条身份 finding，0 新增 | audit-history.json |

唯一 skip 是未设置 ROTOM_TEST_SIDECAR 的既有条件测试。入口测试曾发现连续替换同一异步 mock 不能稳定得到 null 授权，改为一次传入目标授权值；缺授权拒绝测试仍严格保留。Vitest 子进程区分已执行的 skipped 与未执行的 pending，测试按实际状态核对，而非把两者混为成功。

历史扫描没有变成全绿：仍仅为六个旧 commit 的 author/committer 各一条 non-noreply finding，摘要均为 cd29c5ac348a；未修改扫描规则或扩大既有例外。

自审核对了 continuation 的默认行为、预算覆盖、累计计数不重置、CLI bail 顺序、判分失败保留、空配对 N/A、原始行保留和范围限制。没有修改 `packages/` 或 `rotom/extensions/`，也没有重新启用真实入口。

本轮只证明 faux 与本地控制流。真实模型是否会服从提示、达到阈值或成功卸载仍未知；不从这些脚本推断真实成本/性能改善。原始日志、测试 JSON 与规划脚本留在本机证据目录，不提交 JSONL 或模型输出正文。
