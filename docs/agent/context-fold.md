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

## 缓存代价（估算，非实测）

任何 fold 都会使最早被编辑位置之后的 provider 前缀缓存失效。以 Anthropic 价格比例（读 0.1×、写 1.25×）粗算：150K 上下文折叠 20K–100K 段，约需 9–10 次后续请求回本。因此工具指引要求"少折、大块、优先旧的工具密集段"。其他 provider 比例不同。

## 验证

| 检查 | 证明范围 |
| --- | --- |
| `node --experimental-strip-types --test rotom/extensions/context-fold/index.test.ts`（需 `ROTOM_PI`，`check-personal` 已纳入） | 真实 Pi SessionManager 投影：首个 assistant 与签名保留、摘要位置、角色序列、重开一致；各类非法范围被拒；嵌套吸收；分页召回与后续修改提示；隐藏历史搜索；提醒分桶；SDK + faux provider 中途 fold 后同一 run 的下一次请求已不含原文、recall 原文出现在末尾、重开 session 投影一致 |
| 对照 | 去掉 `turn_end` 提交草稿后 SDK 用例失败 |

未验证：真实 provider（含 Qoder）对折叠后请求的接受度、真实缓存命中率与 token 节省、模型是否会合理选择范围与写出足够摘要、与用户自装 context 改写扩展（如 SoL-Pi observation-pack）叠加。这些需要授权的真实长会话 A/B；在此之前不默认开启、不宣称收益。

## 升级条件

- 真实会话出现"recall 后仍基于旧内容误改"且来源头与修改提示未能阻止时，再评估原位解压。
- 出现同一步需要多个 fold 的证据时，再支持批量范围。
- 默认开启需要 L3 证据：provider 报告的 cacheRead/input、是否撞窗口与任务完成度对比原生压缩。
