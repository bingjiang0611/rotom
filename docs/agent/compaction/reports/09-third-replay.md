# 任务 09 · 第三次真实回放结果

## 结论与停止状态

唯一一次真实 campaign 已停止，未补跑：第 1 次 `config-aggregate / baseline / repetition=1` 完成；第 2 次同任务 candidate 触发 `threshold-not-reached`，CLI exit 1；其余 16 次未执行。两次任务本身的判分均正确，但 candidate 不满足回放验收条件。

baseline 完整读取 120/120 份材料、产生 2 次原生压缩；candidate 仅完整读取 50/120 份，partialReads=0、阈值事件=0，contextPeak=57,046。证据指向**第一阶段覆盖不足**，不是已观察到的部分读取，也没有证据证明卸载判定失败。candidate 没有进入阈值处理，不能据此评价卸载效果。两臂工作量不同，不能把耗时或 token 差异归因于 offload。

授权 `3c5d1a297f0bbb285f95990504384c4458cab688` 已消费，receipt 保留；`LIVE_AUTHORIZATION` 已恢复 `null`。没有重试真实命令，没有提高上限，没有执行剩余 case。

## 配置、来源与执行边界

- 按任务先拉取 `compaction/offload-first`。旧 `/tmp` 工作树已不存在，因此从该分支创建独立干净 clone；未切换或改动原 `eval/system` 工作区。
- 用户额外确认允许“补最小计数”：原实现只有工具总数，没有第一阶段每轮 read 数量。新增纯数字 `phase1ReadCallsByTurn` 和零费用测试，不修改 fixture、prompt、工具面、阈值、保留区、判分或熔断。
- 授权与计数的已推送构建源：`287fe7c97413daef9bbc491b71f46ad3c0b7d060`。两条实际记录的 sourceDirty 均为 false。
- `openai-codex / gpt-5.6-luna / low`，计划 N=3、18 次；共享上限 3,000 请求、140,000,000 合计输入。
- Node v24.18.0、npm 12.2.0、产品 Pi `1.4.0-rotom.2`。实际 contextWindow=272,000，reserveTokens=208,000，thresholdTokens=64,000，keepRecentTokens=5,120。
- 两臂沿用 08 fixture 和 `read/edit/write/obs_recall` 工具；eval 的 Action Fusion 仍关闭。SSE、maxRetries=0；不能代表默认 WebSocket 的性能。
- 本机 OAuth 存储检查通过，网络在该预检中被禁止；未通过额外推理探测账号。初始 available snapshot 为空不是登录结论，最终采用 SDK 的只读 checkAuth 确认存在 OAuth 凭据，实际可调用性由随后这唯一 campaign 验证。
- UTC：2026-10-26T11:40:36Z 至 11:43:26Z，外层命令约 170 秒。每个 case 的 wallMs 见下表，不包含全部启动/收尾开销。

执行一次的命令（启动前工作树干净；单次目录标记和私有 receipt 双重防止本机重入）：

```sh
cd rotom/evals
ROTOM_PI="$PRODUCT_PI" \
ROTOM_EVAL_COMPACTION_OFFLOAD=1 ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE=1 \
ROTOM_EVAL_PROVIDER=openai-codex ROTOM_EVAL_MODEL=gpt-5.6-luna \
ROTOM_EVAL_THINKING=low ROTOM_EVAL_REPETITIONS=3 \
ROTOM_EVAL_ARTIFACT_DIR="$PRIVATE_ARTIFACT_DIR" \
npm run eval -- cases/compaction-offload.eval.ts --bail=1
```

`PRODUCT_PI` 为本 clone 的 `rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` 绝对路径。没有变更当前用户的产品安装。

## 逐次运行指标

时间单位 ms。not-run 的 N/A 表示没有测量，不是零；计划顺序与入口一致。

| # | task | arm | rep | status | correct | threshold | native | defer | wait | recall | recalledOffloaded | offloadedResults | turns | tools | input | cacheRead | cacheWrite | output | wall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | config-aggregate | baseline | 1 | completed | true | 2 | 2 | 0 | 8755.917 | 0 | 0 | 0 | 18 | 127 | 223830 | 320640 | 0 | 5250 | 81438.673 |
| 2 | config-aggregate | candidate | 1 | failed | true | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 15 | 53 | 65347 | 326144 | 0 | 4773 | 79669.818 |
| 3 | config-aggregate | candidate | 2 | not-run | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 4 | config-aggregate | baseline | 2 | not-run | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 5 | config-aggregate | baseline | 3 | not-run | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 6 | config-aggregate | candidate | 3 | not-run | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 7 | deferred-exact | baseline | 1 | not-run | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 8 | deferred-exact | candidate | 1 | not-run | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 9 | deferred-exact | candidate | 2 | not-run | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 10 | deferred-exact | baseline | 2 | not-run | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 11 | deferred-exact | baseline | 3 | not-run | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 12 | deferred-exact | candidate | 3 | not-run | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 13 | multi-file-fix | baseline | 1 | not-run | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 14 | multi-file-fix | candidate | 1 | not-run | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 15 | multi-file-fix | candidate | 2 | not-run | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 16 | multi-file-fix | baseline | 2 | not-run | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 17 | multi-file-fix | baseline | 3 | not-run | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 18 | multi-file-fix | candidate | 3 | not-run | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |

JSONL 只有两条真实已执行记录。第 3–18 行是根据计划及 Vitest 的 16 条 pending assertion 标出的 not-run，不伪造持久记录。Vitest 顶层 numPendingTests=0 与逐条状态不一致，本报告采用逐条 assertion、exit 1 及持久日志交叉核对。

## 轨迹元数据与 read 批量分布

“并发数”在这里严格指**同一 assistant 回复请求了多少次 read**，不证明工具在墙钟时间上并行执行。计数包括 manifest/非材料路径、失败或重复请求；第一阶段中的零-read 回复也计入，第二阶段及原生摘要不计入。另列非零回复分布，避免终止回复中的 0 掩盖批量形态。新增计数只保存数字，不包含路径、参数或正文。

| arm | toolNames | phase1Coverage | partialReads | 总轮数 | contextPeak | 第一阶段轮数 | read 最小/中位/最大（含零） | read 最小/中位/最大（非零） | 第一阶段 read 请求数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | {"read":126,"edit":1} | 120/120 | 0 | 18 | 64377 | 14 | 0/1/20 | 1/1/20 | 121 |
| candidate | {"read":52,"edit":1} | 50/120 | 0 | 15 | 57046 | 12 | 0/1/14 | 1/1/14 | 51 |

其余 16 次的上述元数据均为 N/A。contextByTurn 和逐轮 read 数列只保存在本机私有 JSONL，本报告不复制数列。

两次的 read 中位数均为 1，但最大值分别为 20、14，属于混合批量，不是稳定的 1/10/20-read 脚本。baseline 的真实完整读取能触发阈值，说明该 fixture 并非在此模型上必然无法形成压力。candidate 的问题发生在覆盖不足、未达阈值阶段；其 phase1Coverage=50/120，不能按 08 的“读满材料”faux 结果推定它也应当 defer。这里只描述轨迹，不推断模型意图。

contextPeak 是已记录 assistant 请求 usage 的峰值；Pi 的阈值估算还可能计入新追加 tool result，二者不能直接等同。

## offloadDecisions

| run | arm | 阈值轮 | threshold / native / defer | 决定记录 | before / after / T / candidates |
| --- | --- | --- | --- | --- | --- |
| 1 | baseline | [11,16] | 2 / 2 / 0 | []（未启用卸载） | N/A |
| 2 | candidate | [] | 0 / 0 / 0 | []（未触发阈值） | N/A |

不存在可列出的 candidate 卸载决定；这不是“缺决定记录”熔断。没有 before/after 值可分析，也不能把本次称为 insufficient_savings 或机制拒绝。其余 16 次未运行，决定元数据同样 N/A。

## 按臂汇总

仅统计实际执行的各 1 次；不把未执行的 8 次计入成功率分母。任务判分与回放成功分列。每臂只有一个样本，以下均值就是该次值，wait 中位数也等于该次值；不作显著性结论。

| arm | 已执行/计划 | 任务判分成功 | 回放成功 | 触发阈值/执行 | native 总数 | defer 总数 | wait 均值及中位（含零） | wait 均值及中位（仅触发） | wall 均值 | recall 均值 | recalledOffloaded 均值 | input 均值 | cacheRead 均值 | cacheWrite 均值 | output 均值 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 1/9 | 1/1 | 1/1 | 1/1 | 2 | 0 | 8755.917 | 8755.917 | 81438.673 | 0 | 0 | 223830 | 320640 | 0 | 5250 |
| candidate | 1/9 | 1/1 | 0/1 | 0/1 | 0 | 0 | 0 | N/A | 79669.818 | 0 | 0 | 65347 | 326144 | 0 | 4773 |

candidate 没有触发阈值的样本，因此“仅触发”wait 为 N/A，而不是 0。两臂 offloadedResults 均为 0；没有任何真实卸载收益证据。

## 累计预算与账目

| 项目 | 已报告值 | 授权停止线 |
| --- | ---: | ---: |
| provider 请求（含摘要） | 35 | 3000 |
| input | 289177 | 合计输入内 |
| cacheRead | 646784 | 合计输入内 |
| cacheWrite | 0 | 合计输入内 |
| 合计输入 | 935961 | 140000000 |
| output | 10023 | 无独立上限 |

baseline 消耗 20 请求、544,470 合计输入；candidate 增加 15 请求、391,491 合计输入。两条 metrics 的各 usage 分量求和与末条 cumulative 完全一致。usageComplete、usageKnown 均为 true；美元费用 unknown，不写作 $0。

请求/输入额度均未触线，实际 stopReason 是 `threshold-not-reached`。预算剩余不是重新执行的授权；本次许可已经消费。

## 验证、限制与交付边界

| 检查 | 结果 |
| --- | --- |
| 授权启用前 live/entry/metadata（仅 faux） | 27/27 |
| 授权启用后同组测试（LIVE=0）与 typecheck | 27/27；PASS |
| 计数负对照：强制记 0 | 两项 metadata 测试均按预期失败 |
| 恢复计数实现 | metadata 2/2 |
| 真实单次命令 | exit 1；1 passed、1 failed、16 pending |
| 授权恢复 null 后同组测试与 typecheck | 27/27；PASS |
| 数字核对 | 2 条日志、18 条计划/测试状态、usage 累计和元数据长度一致 |
| diff / staged 文件大小 | PASS |
| 公开 tracked-tree 扫描 | PASS，7,831 项，0 finding |
| 历史扫描 | 仍有原先已接受的 12 项旧身份 finding；不声称全绿 |

第三方安装初次普通 npm ci 因 peer dependency 解析与锁文件不符失败；按仓库现有 canonical 的 `--legacy-peer-deps --ignore-scripts --omit=optional` 重装成功，没有更新锁文件或依赖版本。这是本地环境准备，不是重跑真实 campaign。没有放开 npm 被阻止的依赖安装脚本。

本轮未跑全量测试或重复真实模型验收；新增逻辑由 focused 测试和这次实际记录覆盖。授权常量已撤销，后续只允许继续零费用检查；若要再次真实运行，必须由 bob 另行授权。规划者下一步应先评审第一阶段覆盖不足的轨迹，不能从本轮数据直接判断 offload 成败。

本机证据目录：`/tmp/rotom-offload-09.me2OT2/`（命令、日志、reporter、核对脚本）。私有指标：`~/.rotom/evals/compaction-offload/2026-10-26T11-40-44.796Z.jsonl`，文件 0600、目录 0700；授权 receipt 保留。没有模型输出正文或 JSONL 进入提交，原始会话仍由既有 harness 清理。

## 核验意见（规划者，2026-10-26）

**执行合规，结论接受；停止规则需要调整（任务 10）。** 本轮只有 docs/evals 指标改动，规划者未重跑测试，采信报告的 27/27 与 typecheck。新增的 `phase1ReadCallsByTurn` 只存数字，属于 bob 明确允许的最小计数，接受。

- 这次比 06 前进了一大步：baseline 真实地逐份读完 120/120、两次触发阈值，证明 08 的 fixture 在这个模型上能形成压力。candidate 只读了 50/120 就回复 READY，没碰到阈值。两臂配置只差开关，而开关在阈值前不改变任何行为（卸载只在 `session_before_compact` 里发生），所以这是模型这一次偷懒，不是卸载造成的差异。
- 问题出在规则上：「任何一次没到阈值就停掉整个 campaign」在 06 是对的（那时设计本身有问题），但现在模型的合规率看起来只有一半左右，18 次里几乎必然出现一次偷懒，campaign 永远跑不完。偷懒的运行本身很便宜（这次 15 次请求、约 39 万合计输入），真正的费用保护是请求和 token 停止线。
- 附带观察：baseline 两次原生压缩合计只等了约 8.8 秒，远低于生产的 85.6 秒中位数，因为 64K 阈值下要摘要的内容少得多。回放能比较「有没有等待、任务对不对」，但等待秒数不能直接外推到生产，最终结论需要单独换算或用日常数据补。

下一步见[任务 10](../tasks/10-coverage-nudge.md)：两臂用同一条确定性的「还有 N 份没读」续读提示补足覆盖，未达阈值的运行改记为无效样本而不是停掉全部，只有无效样本累计过多才熔断。
