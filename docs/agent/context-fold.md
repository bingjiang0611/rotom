# Context fold：模型驱动的上下文折叠（opt-in 实验）

`rotom/extensions/context-fold/` 让模型自己把已完成的旧工具步骤折叠成摘要，需要细节时再召回原文。思路借鉴 billion-context，但不 patch `fetch`、不启动代理：只用 Pi 1.1 公开的 `context_edit` 条目与 `turn_end` boundary。

默认关闭。`ROTOM_CONTEXT_FOLD=1` 开启，`0` 或未设置关闭，其他值报配置错误。开启后 `context` 工具常驻（`model-only`，Codemode 不可调用）；关闭时不注册任何工具或事件，默认工具面与 context footprint 不变（`check-personal` 的 runtime smoke 断言关闭态，开启时该 smoke 会按设计拒绝未审核工具面）。开启后每次请求多一个工具：schema 约 1132 bytes、prompt snippet + guidelines 约 476 bytes（本地 JSON 字节，不是 provider token）。子 Agent 不加载本扩展。

## 合同

```
context outline            列出可见历史（旧→新）：step id、工具、chars/4 估算、已有 fold
context fold from to summary
  校验 → 暂存 → 本步 turn_end 提交 context_edit 草稿 + 一条 rotom-context-fold 记录
context recall block=bN    分页读取折叠原文（12K chars/页），追加在上下文末尾
context recall query=...   搜索当前不可见的历史（折叠目标 + 原生压缩前的条目）
```

- **结构不变量**：fold 只覆盖同一用户段内的完整工具步骤。user、custom、bash、compaction 消息从不编辑，范围不能跨越它们。第一个 assistant 原样保留（thinking 签名、toolCall id 仍有效）；它的第一个 tool result 被替换为摘要，同批其他结果替换为 `[folded into bN]`，范围内其余消息 omit。结果始终是"完整 assistant→toolResult 对"的子序列，不制造新的角色相邻关系。
- **拒绝**：起点不是可见的工具步骤；终点在起点之前；包含当前步骤；跨越边界消息；摘要超过被折叠内容（不含保留的首个 assistant）的一半；同一步已有一个 fold 待提交。
- **嵌套**：新范围包含旧 fold 的 holder 时，旧 block 被吸收，新记录继承其全部目标；旧 block id 仍可 recall。
- **持久化**：状态全部是 session 条目，resume/fork 由 Pi 投影恢复，不新增存储。原文本来就在 session 文件里。
- **提交语义**：工具结果只表示 "scheduled"。若同一 boundary 中其他 handler 产生非法草稿，Pi 会丢弃全部草稿，fold 不生效；`outline` 是已提交状态的唯一依据。
- **召回防误读**：每页带 `historical originals, not current state` 头。若页内工具调用的 `path`/`file_path` 之后被 `edit`/`write` 修改过（精确匹配），附注修改步骤并提示重新 `read`。`bash` 等无法可靠解析路径的修改不报告。
- **提示**：上下文达到窗口 50% 时，在下一个非 `context` 工具结果末尾追加一次提醒，之后每增长 10 个百分点再提醒一次；fold 让占比下降后重新计数。提醒写在真实工具结果里，后续请求字节稳定，不移动缓存前缀。
- **与原生压缩共存**：不取消 Pi 自动压缩；它照常作为溢出/阈值兜底，并按编辑后的投影估算 token。

## 缓存代价

任何 fold 都会使最早被编辑位置之后的 provider 前缀缓存失效，并额外产生 outline + fold 两次请求。相对优势取决于该 provider 的缓存读折扣：缓存读越便宜，fold 越可能只是把便宜的重发换成一次全额重填。**下面的实测显示，在 Qoder DeepSeek-Flash 上这个交换基本中性，不是收益。**

## 验证

| 检查 | 证明范围 |
| --- | --- |
| `node --experimental-strip-types --test rotom/extensions/context-fold/index.test.ts`（需 `ROTOM_PI`，`check-personal` 已纳入） | 真实 Pi SessionManager 投影：首个 assistant 与签名保留、摘要位置、角色序列、重开一致；各类非法范围被拒；嵌套吸收；分页召回与后续修改提示；隐藏历史搜索；提醒分桶；SDK + faux provider 中途 fold 后同一 run 的下一次请求已不含原文、recall 原文出现在末尾、重开 session 投影一致 |
| 对照 | 去掉 `turn_end` 提交草稿后 SDK 用例失败 |
| L3 真实 provider（Qoder `dfmodel` = DeepSeek-Flash，272K 窗口，10 次 A/B 运行 + 1 次 resume） | 见下节实测 |

未验证：折叠后请求在 dfmodel 之外的 provider（含 Anthropic/OpenAI 系）上的接受度、与用户自装 context 改写扩展（如 SoL-Pi observation-pack）叠加、以及折叠后长会话的**回答质量**是否下降（本次只验证任务完成信号 `DONE 160 last=tag-159-1` 正确，未做质量评估）。

## L3 实测（2026-10-12，Qoder DeepSeek-Flash，272K 窗口）

工作负载：同一份 160 个日志文件（约 870KB 内容）按文件名顺序逐个 `read`，两个 arm 使用完全相同的 prompt；除 fold 开关外无差异。每 arm 运行 5 次（其中 3 对为"每步 20 个文件"的等批量 prompt，消除批量差异）。

| 指标 | fold 关闭 | fold 开启 |
| --- | --- | --- |
| 全部运行结果 | 160/160 个文件、最终答案正确、0 个 provider 错误 | 同左，0 个 provider 错误 |
| 计费 credits（等批量 3 对） | 4.15 / 4.15 / 4.16，均值 4.15 | 3.40 / 4.56 / 4.16，均值 4.04（0.97×） |
| 峰值上下文 | 237K tokens（3 次全部一致） | 134K / 202K / 237K |
| 原生压缩 | 每次运行都触发 1 次（265K） | 仅未发生 fold 的那次触发 |
| fold 次数 | 0 | 0 / 1 / 4 |
| 累计 prompt tokens | 1.01M | 0.82M–2.41M |

结论：

- **机制在真实 provider 上可用**：模型被提醒后会调用 outline/fold，Qoder 接受折叠后的请求（10 次运行 0 错误），任务照常完成。
- **计费成本基本中性（0.97×）**，没有可测量的节省。单个开启运行的区间（3.40–4.56）大于相对基线的差异，且基线极稳定（4.15±0.01），因此差异主要由模型行为决定，不能归因于功能。
- **可观测的收益是峰值上下文下降**（最低 134K vs 基线 237K）以及由此避免原生压缩；节省的是窗口压力，不是 credits。
- **累计 prompt tokens 反而可能更高**（最高 2.4×）：fold 开启后旧前缀以缓存读价重复发送，credits 便宜但占用 provider 速率/TPM 配额。
- **模型是否折叠不稳定**：3 次等批量运行分别为 0、1、4 次 fold；其中一次连续收到 60%/74%/88% 三次提醒仍完全不折，直接落到原生压缩。提醒可靠送达（计数与分桶符合设计），遵从率不确定。
- 提醒首次出现可能高于 50%（分桶不回溯）：实测首次提醒出现在 50%、60% 或 74%。

Resume：重新打开已折叠的 session（`--session <file>`）后询问只存在于折叠内容里的 `part000.txt` 的 deploy_tag，模型用 `context recall block=b1` 取得 `tag-000-1`，正确；session 中 fold 记录仍为 `b1`/`b2`，无重复写入。召回页头正确显示 `historical originals, not current state`。

成本：本次全部验证共 127 次计费请求、42.19 credits（含 Phase 1 与 resume）。

## L3 实测二：长会话（700 个文件，fold 对比原生压缩）

工作负载：同上但 700 个文件（约 3.7MB 内容，约 950K tokens），两 arm 同一 prompt，每步 20 个 `read`。

| 指标 | fold 关闭 | fold 开启 |
| --- | --- | --- |
| 完成度 | 3/3 跑完 700 个文件，答案正确 | 2/3 跑完；**1/3 中途放弃任务** |
| 计费 credits（完成的运行） | 19.10 / 19.74 / 19.47，均值 19.44 | 15.52 / 17.42，均值 16.47（0.85×） |
| 峰值上下文 | 241K / 245K / 245K | 129K / 205K |
| 原生压缩 | 每次运行 5 次 | 0 次 |
| fold 次数 | 0 | 29 / 12 |
| 请求数 | 36 / 36 / 36 | 70 / 54 |
| 提醒送达 | 不适用 | 0 / 7 次 |

完成的运行里 fold 开启约便宜 15%、峰值上下文减半、完全不触发原生压缩。**但代价是 1/3 的长运行没有完成任务。**

### 失败模式（l-b3，已定位为功能副作用）

第 3 次 fold 开启运行在第 150/700 个文件处停下并拒绝作答。它的理由：折叠后它看不到自己之前的读取，只能看到 fold 摘要，于是判定"摘要声称的读取不是我请求过的"，认为继续输出 `DONE` 会是编造（它的原话："a summary claiming a read is not a read"）。

后果：

- 模型的自我叙事变错：它报告"我实际只读了 30 个文件"，而它确实读过 150 个。
- 它虽然拿到了 `context recall` 入口（holder 文本里就有），仍选择不相信摘要并向用户提问。

这不是单纯模型波动：折叠确实移除了模型核对自己早期工作的能力。在弱模型上，这可以把长任务变成中途弃任务。任何默认开启或推广到子 Agent 之前必须先解决这一点。

另一处低效：l-b2 读了 720 次（重复读了 20 个文件），说明折叠后的"我读到哪里了"也会误导模型重复劳动。

### 提醒机制未被使用

两次完成的 fold 开启长运行里提醒送达 0 次——模型在上下文达到 50% 之前就主动折叠，把峰值压在 129K/205K。也就是说，长会话的有效触发不是提醒文案，而是工具本身的存在。反之，短会话里模型收到 3 次提醒也可以完全不折。提醒的文案强度已试过一个更强版本，无效果（见下）。

### 已试过且无效的改进

把提醒改得更具体（指明"否则会被原生压缩"）、并在工具指引里加一句"收到提醒就折叠"，然后用同一短工作负载跑 3 次：fold 0/0/0 次（对照组之前为 1/4/0 次），credits 4.16–4.22（基线 4.15–4.16），原生压缩各 1 次。无改善证据，因此这两处文案改动已回退；保留的是 `outline` 输出具体可折范围（它以可验证合同提高了模型折叠时的确定性，长运行中 `context` 调用共 58 次，均为 outline→fold 配对）。

## 升级条件

- **不得默认开启**：长运行虽便宜 15%，但出现 1/3 的任务中途弃任务，原因是折叠后模型无法核对自身早期工作。
- 若要继续，优先解决可核验性：例如让 holder 文本明确标出这是模型自己已经完成的步骤（而非外部声称的读取），或让 `recall` 成为模型在回答前验验历史的常规步骤；但任何方案都必须用同一 700 文件工作负载重测完成率，而不是只看 credits。
- 提高遵从率需要新证据：提醒文案已试过两个版本，未区分出效果；短会话遵从率 0/3 与 1/3、长会话为 0 次提醒却多次自主折叠，说明主导因素是模型策略而非文案。不以单次运行调参。
- 真实会话出现"recall 后仍基于旧内容误改"且来源头与修改提示未能阻止时，再评估原位解压。
- 出现同一步需要多个 fold 的证据时，再支持批量范围。
