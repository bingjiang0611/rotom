# 2026-11-25 两台机器的 loop 记录汇入与 harvest 用例

本文记录两件事：把两台机器各自的 gate/weekly 结果并进仓库，让池化按产品指纹而不是按提交合并；再从真实会话的分诊结果里挑机制，做成新用例。文末把「实测到的」和「推断的」分开列。

## 1. 两台各自做了什么

| 步骤 | mac3 | mac1 |
| --- | --- | --- |
| 建分支 | `eval/harvest-cases-20261125`，从 `origin/main` 69e47f0 建，`git merge-base --is-ancestor 69e47f0 HEAD` 退出码 0 | 同一分支名、同一基线，同一检查退出码 0 |
| 依赖重装 | 三个 `npm ci` 全部成功 | 三个 `npm ci` 全部成功 |
| 机器标签 | `loop machine mac3` | `loop machine mac1` |
| records import | 7 次 gate 运行 | 25 次 gate 运行 |
| weekly | 生成 `weekly/mac3/2026-11-25.json` | 生成 `weekly/mac1/2026-11-25.json` |
| harvest | `--days 28`：83 个会话、127 条事件 | `--days 28`：658 个会话、1631 条事件 |

分支、提交、汇总和提交动作都在 mac3 上做；mac1 只跑本机命令，产物用 tar 传回 mac3。mac1 的默认 node 是 22.x，而 evals 要求 ≥23.6，所以两台都用各自机器上已有的 24.18.0 跑 `loop`。

传输链路期间出现过多次 TCP 22 不通（ICMP 通、同网段其他端口也不通，公网 TCP 正常）。所有跨机命令都改成长命令 `nohup` 写远端日志、短命令带重试，日志和产物都在目标机器留下，没有靠反复重跑凑结果。

## 2. records 导入清单

- mac3：7 个文件，`gate/mac3/gate-2026-11-25T02-49-06-998Z.json` 到 `…04-02-32-611Z.json`，覆盖 6 个用例与 3 个 candidate 指纹。
- mac1：25 个文件，`gate/mac1/gate-2026-11-09T11-52-58-618Z.json` 到 `gate-2026-11-25T03-02-35-420Z.json`。

导入范围说明：`loop records import` 只按「本机历史里尚未记录的运行」判断，所以 mac1 把 11-09 以来的历史一并补录，不只 11-25 之后的那几次。两台合计 32 个文件，全部对 `/Users`、工作区目录名、三台主机名做过 grep，0 命中；文件里只有机器标签、运行 id、提交、产品指纹、用例 id、通过计数和判定。

两台各生成一份 `weekly/<machine>/2026-11-25.json`，同样没有路径和主机名。

## 3. gate-pool 合并结果

`loop gate-pool --since 2026-11-01T00:00:00Z` 在合并提交之后跑：

- 28 组判定：19 组 held、8 组 regressed、1 组 generalizes。
- 其中 6 组的 `runs:` 同时列出 mac1 与 mac3，说明同一产品指纹的样本确实跨机器合并，而不是按机器各算一份。例如 candidate `product:9eb198b0f15e8e42` / baseline `product:2ff2ce5cb703aed0` 这一组把 mac1 的 11-25 运行和 mac3 的两次运行放在一起，判 held。
- 早期运行的 baseline 指纹多为 `commit:unknown`，因为当时的私有历史没有记录冻结基线，这类样本只能按提交合并，不能与别人的样本池化。

`loop status` 在账本校验通过后正常输出；账本引用本文，所以本文先落地再跑 `loop ledger`。

## 4. 两台介入率（weekly，实测）

| 机器 | 用户轮次 | v2 事件 | 每 100 轮 | 95% 带 | 去掉最大单会话后 |
| --- | ---: | ---: | ---: | --- | ---: |
| mac1 | 3993 | 222 | 5.6 | 4.8–6.3 | 4.9 |
| mac3 | 503 | 61 | 12.1 | 9.1–15.2 | 3.3 |

mac3 的 12.1 几乎全部来自一个会话：那 46 条 `user_repeat` 是 Goal 自动续跑注入的同一段文本，检测器把它算成了用户重复。去掉这个会话后 3.3，与 mac1 同一量级。这不是产品变差，是检测器把注入消息当成了用户行为。

## 5. 分诊表（mac1 前 15，mac3 前 5）

按 `report.md` 的分诊队列顺序（不是 incidents.jsonl 的文件顺序）。只写事件类型、脱敏机制、分类和理由。

### mac1 前 15

| # | 分数 | 主要事件 | 分类 | 理由 |
| ---: | ---: | --- | --- | --- |
| 1 | 153.5 | `bare_continue`×23、`user_interrupt`×22、`edit_retry_without_read`×15、`provider_error`×109 | conformance | 用户已给出「不需要我决策的不要停下来、允许所有授权」，agent 仍反复停下等确认。机制与既有 `behavior-authorized-follow-through` 同族，不新增用例 |
| 2 | 89 | `compaction_failed`×51、`edit_retry_without_read`×9、`provider_error`×17 | mechanism-reproduction | 压缩连续失败是本轮最明确的机制信号；但压缩失败由模型摘要不可解析触发，无法在续跑用例里确定性复现，只写设计说明 |
| 3 | 45 | `compaction_failed`×40、`edit_retry_without_read`×3 | mechanism-reproduction | 同 #2 的同一机制，另一个会话 |
| 4 | 40 | `bare_continue`×17、`provider_error`×8 | conformance | 用户只需反复说「继续」；停止边界已由既有用例覆盖 |
| 5 | 37 | `compaction_failed`×32、`length_stop`×4 | mechanism-reproduction | 同 #2 的机制，第三次出现；三次合计 123 次，值得单独做机制级验证 |
| 6 | 33 | `edit_retry_without_read`×9（其中编辑工具报歧义匹配）、`user_correction`×2 | mechanism-reproduction | 已经做成新用例（见第 6 节） |
| 7 | 31.5 | `tool_error_streak`×15（子 agent 等待超时×15）、`user_correction`×3（用户两次说「还是不行」） | mechanism-reproduction | 等待超时后重复等待；续跑用例的工具面只允许 read/edit/bash，装不进子 agent 形状，只写设计说明 |
| 8 | 30.5 | `provider_error`×17、`user_interrupt`×9、`user_repeat`×3 | 外部因素 | 主要是供应商网络错误，用户重复下发同一条任务说明 |
| 9 | 28 | `provider_error`×22、`user_interrupt`×9 | 外部因素 | 同上 |
| 10 | 27.5 | `provider_error`×17、`edit_retry_without_read`×4 | 外部因素 | 主导项是供应商错误，编辑重试只是伴随信号 |
| 11 | 24 | `provider_error`×18、`user_correction`×2 | 外部因素 | 同上 |
| 12 | 19.5 | `provider_error`×15、`edit_retry_without_read`×3（含一次写文件失败） | 外部因素 | 主导项是供应商错误 |
| 13 | 19 | `provider_error`×16、`tool_error_streak`×6（浏览器探测超时） | 外部因素 | 浏览器中继不可用的环境问题 |
| 14 | 19 | `bare_continue`×6、`provider_error`×4、`tool_error_streak`×3 | conformance | 停止边界，已覆盖 |
| 15 | 18.5 | `tool_error_streak`×12（浏览器探测超时×9）、`provider_error`×9 | 外部因素 | 浏览器中继超时 |

分类合计：mechanism-reproduction 5（#2、#3、#5、#6、#7），conformance 3（#1、#4、#14），外部因素 7，harness-regression 0。mac1 没有出现 mac3 那种「注入消息被算成用户重复」的主导项。

### mac3 前 5（补充）

| # | 主要事件 | 分类 | 理由 |
| ---: | --- | --- | --- |
| 1 | `user_repeat`×46 + `user_interrupt`×1 | harness-regression | 46 条文本完全相同且是 Goal 续跑注入；检测器把注入当用户重复，直接抬高了本机介入率 |
| 2 | `tool_error_streak`×3、`edit_retry_without_read`×4、`provider_error`×7、`user_correction`×2 | mechanism-reproduction | 编辑重试机制的主要来源 |
| 3 | `computer-use` 桥接 socket 缺失、`user_correction`×1 | 外部因素 | 桥接进程没起，且 agent 只能从远程 shell 干活，需要真机图形桌面才能验证 |
| 4 | 工具审批超时后停下、`bare_continue`×1 | mechanism-reproduction | 审批超时被当成停止条件；续跑用例没有审批超时能力，只写设计说明 |
| 5 | 浏览器中继 socket 缺失、`user_correction`×1（成本取舍请示） | 外部因素 | 中继不可用；用户纠正是要 agent 在成本取舍上做决定，而 agent 停下来问是对的 |

## 6. 新用例：一行生成配置按真实字节修改

### 来源与机制

分诊里 `edit_retry_without_read` 是最分散的产品行为信号：mac1 144 次 / 68 个会话，mac3 10 次 / 7 个会话，占了 28 天窗口里几乎每个有代码编辑的会话。另有一类同族事件「编辑文本歧义」在 mac1 记了 10 次 `tool_error_streak`。观察到的手法是：第一次编辑用「记得的样子」拼 oldText，工具拒绝（找不到唯一匹配）后不先读，直接重试同一个猜测。

用例把这条机制的可观察前提保留下来：对一行压缩生成的配置，第一次编辑的 oldText 必须在原文件里恰好出现一次——既是工具能接受它的唯一方式，也是「真的看过文件」的证据。

### 设计

- fixture：`conf/release.json` 是一行压缩 JSON，`edge` 出现两次（通道值 + `publish.tags`），所以替换裸 token 会因歧义被拒；README 说明这是生成器写的一行、重排会被拒。
- 任务文本（中文，单轮）：把通道从 edge 改成 beta，其他字段不动，改完跑 `node verify.mjs`。
- checks：`channelChanged`、`generatedLayoutPreserved`（除通道值外与生成器写出的字节完全一致）、`firstEditTargetsRealBytes`（第一次编辑的每个 oldText 在原文中恰好出现一次）、`reportedCheckPasses`（`verify.log` 末行是 PASS）、`fixturePreserved`。
- 工具面：`read`、`edit`、`bash`，bash 只允许 `node verify.mjs`；可编辑文件只有 `conf/release.json`。这一点决定了「写整个文件」不是合法路径，所以两份手写正确答案都用编辑，只是换了一种仍然精确的切法。

用例写在 `rotom/evals/src/harvested-cases.ts`；`continuation-cases.ts` 只加了三处：import、展开数组、id 联合类型。另外 `test/continuation-regression.test.ts` 里那条固定枚举 mechanism-reproduction 用例 id 的断言多了一个 id——它是防止用例集惄悄变化的守卫，不是改判分口径。

### 离线 oracle（实测）

`rotom/evals/test/harvested-cases.test.ts`，3 个用例全部通过：

| 场景 | 期望 | 结果 |
| --- | --- | --- |
| 记住的样子（带空格拼 oldText）后重试 | 拒 | `firstEditTargetsRealBytes` 假，整体失败 |
| 裸 token `edge`（出现两次） | 拒 | 同上 |
| 改对值但重排成多行 | 拒 | `generatedLayoutPreserved` 假 |
| 只回复「已改好」但文件没动 | 拒 | `channelChanged` 假 |
| 中文回复 + 精确单值编辑 | 收 | 五项检查全真 |
| 英文回复 + 更宽的精确区域替换 | 收 | 五项检查全真 |

另外两条证明：接受轨迹的 `missingObservation` 为空；反向对照 `unobservedReads` 能把未声明的路径报出来，说明前面那个空列表不是恒空。检查读的文件只有 `observe` 里的四个。

## 7. 冻结的基线

`loop freeze 95777adb`。依据：本机安装的产品版本 0.2.4，其 `runtime/product-config.mjs` 与提交 `95777adb` 逐字节相同，说明日常在跑的就是这个提交写出的产物；`origin/main` 之后的改动落在 vendor 包与其余文件上，产品指纹不同，所以不能拿 main 冒充 0.2.4。

冻结产物路径由 `loop freeze` 打印，`ROTOM_EVAL_BASELINE_PRODUCT` 用它。

## 8. baseline 逐次结果与判定

命令：`ROTOM_EVAL_CONTINUATION=1 ROTOM_EVAL_CONTINUATION_CASE=behavior-generated-file-real-bytes ./bin/eval --provider qoder --model dfmodel cases/continuation-regression.eval.ts`，`ROTOM_EVAL_CONTINUATION_REPEATS=1` 先冒烟，之后 `=3`。

| 轮次 | 冻结臂 | 候选臂 | 两臂检查 |
| --- | --- | --- | --- |
| 冒烟 | 1.00 | 1.00 | 全布尔，无缺观察 |
| 3 次 | 3/3 通过 | 3/3 通过 | 全布尔，无缺观察 |

六个计分项（3 对 × 2 臂）的 `checks` 都是布尔，`missingObservation` 全为空，从这次运行的 `vitest-results.json` 里读出来核对过。

判定：冻结臂 0/3 失败，按规则是 **not-reproduced**。读运行记录确认不是 fixture 或判分坏了——每个 run 都是先 `read` 再 `edit`，oldText 恰好出现一次，最后跑 `node verify.mjs`；有一次先试了 `bash cat`，被 fixture 的命令白名单拒掉，随后仍然读文件成功。也就是说：机制没有在这个产品版本上出现，不是用例写坏了。

按「不放宽标准」的约定，没有为了让冻结臂失败去改 fixture 的难度。用例保留（冻结臂通过，未来候选失败即回归），`loop/ledger/2026-11-harvest.json` 里记 `not-reproduced`。

## 9. 只写设计说明的机制

- **压缩连续失败**（mac1 135 次、9 个会话，其中最集中的三次占 123 次）。机制：上下文压缩失败后没有降级路径，同一会话里反复失败。装不进续跑用例的原因：压缩失败由模型摘要不可解析触发，无法确定性复现；要做需要能注入坏的摘要，属于 harness 能力，不是用例。
- **子 agent 等待超时后重复等待**（mac1 13 次）。机制：等待超时被当成可重试状态，而不是「去核对原运行」。续跑用例的工具面只允许 read/edit/bash，没有子 agent，装不进。
- **工具审批超时被当成停止条件**（mac3 1 次）。机制：单次审批超时后停下要求用户说「继续」。续跑 harness 没有审批门，装不进。
- **浏览器中继 / 计算机使用的 socket 缺失**（多会话）。机制属环境：中继或桥接进程没起，agent 只能报错或把步骤推回用户。需要真机 GUI 才能验证，属另一条验证线。

## 10. 实测与推断分开

实测到的：

- 两台的 records、weekly 文件落盘，跨机 grep 无路径无主机名；合并后 6 组池化样本同时含两台运行。
- 两台 weekly 介入率 5.6 与 12.1；mac3 去掉最大单会话后 3.3，该会话 46 条重复是注入文本。
- 冻结提交 `95777adb` 与安装产物逐字节一致。
- 新用例离线 oracle 3 个用例通过；实跑冒烟 1 对、正式 3 对，两臂全过，判定 not-reproduced。

推断的（未直接验证）：

- 「mac3 12.1 主要是检测器把注入算成重复」是从事件文本与去最大会话敏感性表推出来的，没有改检测器做对照，所以只能说是解释，不是已证因果。
- 分诊里「机制」的一句话描述来自结构化事件字段与少量脱敏片段，没有再回到会话里逐条复现原始操作；分类是判断，不是验证。
- 压缩失败、子 agent 等待、审批超时三条只做了形状判断（能不能装进续跑用例），没有做机制级复现实验。

## 11. 未验证项

- mac1 上没有再跑一次独立的分诊抽样核对；分类只在本次数据上做了一次。
- 新用例只在 qoder/dfmodel 上跑过，没有第二个模型。
- 冻结基线与候选用的是不同提交（`95777adb` 对 `69e47f0`），两者之间的 evals 改动不影响产品指纹但没有单独验证。
- 跨机链路的不稳定（TCP 22 间歇不通）没有定位根因，只是用重试和远端日志绕过去了；后续跨机任务仍可能遇到。
