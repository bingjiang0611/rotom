# harvest 契约

[Agent 优化循环](optimization-loop.md) 第 ① 步的细节：检测器、指标口径与全部拆分。命令与输出位置只在上层文档写一次。

## 哪些文件被读、哪些被跳过

不管检测器怎么写，读取 `$PI_CODING_AGENT_DIR/sessions`（默认 `~/.pi/agent/sessions`）的会话 JSONL 与同目录 `observability/` trace，**不调用模型**。输出写到 `$ROTOM_LOOP_DIR`（默认 `~/.rotom/loop/harvest-<时间>/`），目录 `0700`、文件 `0600`，拒绝 symlink 输出；永不入 Git。跳过的条目按原因计数并写进 `report.md`（`symlink`、`artifact-store`（`observability/`、`observation-pack/`、含 `subagent` 的子树）、`deep-directory`（深度 > 4 的子树）、`outside-window`、`no-user-turns`、`not-a-session`），这样单个 `skipped` 数字可以被审计而不是被信任。`artifact-store` 与 `deep-directory` 计的是目录，其余计文件。只按会话文件 mtime 过滤时间窗。

| 类别 | 检测 | 含义 |
| --- | --- | --- |
| 介入 | `user_correction` | 用户在助手回复后纠正（中英强短语，宁漏勿滥） |
| 介入 | `user_repeat` | 最近三条内重复同一请求（字符 bigram ≥ 0.8；provider 错误或中断后的重发除外）；窗口内同一句话出现 ≥3 次且前一次回答正常收尾时记为常规重发（`detail.routine`），不计入介入数 |
| 介入 | `bare_continue` | 助手正常结束后用户只回“继续/continue” |
| 介入 | `user_interrupt` | 助手消息 `stopReason: aborted` |
| 失败 | `tool_error_streak` | 同一动作（工具 + 相同命令/路径）在没有同动作成功的情况下第 2 次报错 |
| 失败 | `edit_retry_without_read` | 文件写入本身失败后，未重新 read 同一路径就再改；Action Fusion 的 `[then_run:failed]` 表示改动已写入、后续命令失败，不算写入失败 |
| 失败 | `provider_error` / `length_stop` | `stopReason` 为 `error` / `length`；一次连续重试算一条，`detail.attempts` 记录尝试次数。`provider_error` 另记 `provider`/`model`、`category`（trace 的 `pi.ai.error.category`，否则按错误消息归类为 connect / 429 / 5xx / timeout / `qoder:<code>` / other）、`categorySource`，以及 `final`（这次重试运行最后是否以成功的助手消息结束）。`final: true` 表示被后续成功回答吸收，`final: false` 才是用户真正看到的失败——字段名叫 `final` 但含义是“恢复了”，`report.md` 用 recovered / user-visible 两种取值呈现，避免读反；按 provider × 类别 × 结果汇总 |
| 失败 | `goal_pause` | Goal 暂停且原因不是用户暂停、会话恢复或 `agent_interruption`（后者是上游错误的后果，由对应事件记录） |
| 失败 | `compaction_failed` | trace 中压缩 span 以 error 结束 |

**北极星指标**：每 100 个用户 turn 的介入次数（同一 turn 多个信号只计一次，中断单独计）。`report.md` 同时给出两个口径与 95% 泊松区间（周样本小时只有区间能说明“尖峰”是否超出噪声）、按权重排序的分诊队列，以及下面这些拆分；`incidents.jsonl` 的 `entryId` 可直接定位到会话分叉点。

- **v1**：所有介入。
- **v2**：纠正 + 重复 + 单独回“继续” + `quality` 中断。中断分三类：`self-retract`（还在等第一个字节且 < 2 s，多半是人自己改主意）、`quality`（Agent 已在执行工具、输出文字或发起工具调用，或等待/思考 ≥ 10 s）、`other`（其余，含没有下一条 turn 的中断）。v2 是“产品让它多做/做错”的那部分，v1 保留为完整背景，两者都要报。

周与周之间模型构成变化大，所以除周表外还按模型、runtime、产品版本和 SoL-Pi 版本分别给 v2 每百 turn 与区间：

- **模型**：分母用**每个模型的 turn 数**（不是会话的主模型）。
- **runtime**：读 trace 的 `pi.session.runtime` span 的 `pi.runtime.version`（Pi fork 版本）；没有 trace 的会话记 `unknown`，不归给某个版本。
- **产品版本**：同一个 span 的 `rotom.product.version`，与 fork 版本分开列——依赖和机制改动是按产品版本发出去的，两者合在一个标签里就分不出来。没有该属性记 `unknown`。
- **SoL-Pi 版本**：只从会话自己记录过的 `sol-pi-<版本>.tgz` 归档路径读；当前产品不逐会话写这个值，所以多数会话是 `unknown`，不按“它当时可能加载过哪个版本”推断。
- **敏感性**：把 v2 事件最多的那个会话剔除后重算每模型比率。只有包含它才成立的比率描述的是一次对话，不是一个模型。模型表与产品版本表各有一列“去掉本行最大会话后”的比率：模型行只减掉该模型自己在这条会话里的 turn 与 v2 事件，产品版本行减掉整条会话；行内没有 v2 事件时写 `same (no v2 events)`，并在后面标出被去掉的会话 id。
- **任务规模**：每模型附每会话 turn 数中位数与每 turn 工具调用数中位数（会话归给回答 turn 最多的模型），用来判断“难任务是否专挑某个模型”，避免把任务难度读成模型质量。

`--experiment default-model` 追加默认模型对照视图：按会话日期的日数奇偶分组（奇数日 `openai-codex/gpt-6-astra`、偶数日 `openai-codex/gpt-6.1-sol`），只统计第一条 assistant 消息就用了当天默认模型的会话；中途手动换过模型的会话单独列表，不进主指标；从未用过当天默认模型或没有记录首条 assistant 模型的会话也只计数、不推断。视图另给三件事：每组会话数与 95% 泊松区间；**遵守率**——窗口内所有能读出日期的会话里，首条 assistant 消息就是当天默认模型的比例（没记录首条 assistant 模型的会话留在分母里，因为“看不出它用了默认模型”不等于“它用了”）；**敏感性**——去掉计数会话里 v2 事件最多的那一条后重算两组。日期读不出的会话仍列在排除表里，但不进遵守率分母。中断后在下一条用户消息之前出现 `model_change` 的，单独统计“换掉的 provider/model”与“中断前已等待时长”。只计**换成不同模型**的：Pi 在中断后即使模型没变也会写一条 `model_change`（2026-11 窗口里 258 条有 241 条写的是同一个模型），把这些当成换模型会把结论读反。

`user_interrupt` 另记 `activity`（`waiting-first-byte` / `streaming-text` / `streaming-thinking` / `streaming-tool-call` / `tool-executing` 及工具名）、`elapsedMs` 与 `nextUser`（下一条用户消息的类别），并在结构上区分来源：助手被中断后若第一个非控制 entry 是注入的 goal 合同、压缩标记或系统消息，记 `injected` / `compaction` / `system` 并从介入计数里排除（`interruptExcluded`），剩余算 `human`；中断后没有下一条 turn 记 `no-following-turn`。`tool_error_streak` 同时记工具名与错误类别（timeout / command-failed / not-found / ambiguous-match / stale / other），所以“哪个工具在什么错误上重复”可以直接读出来。模型占比按 turn 计，逐周列出领先的 provider/model。会话自身时间戳缺失或早于 2000 年时回退到会话文件 mtime，并在 Provenance 一节写明有多少条来自回退，不生成 1970 周。

局限：`/skill:<name>` 展开的模板文本与 `/goal resume` 重新投递的 goal 合同都会被剥掉，只比较用户真正输入的部分（被剥掉的消息仍计为用户 turn）；其他经 `sendUserMessage` 注入的 user 消息仍无法与人工输入区分；关键词检测是候选排序，不是结论；单人数据有偏。同一段对话被 fork 到多个会话文件时，用户 turn 与事件按 entryId 只计一次。不把 harvest 数值写成产品质量结论，只比较同一来源的周趋势。
