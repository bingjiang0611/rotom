# Context Layers

独立实现的默认启用产品 extension，位于 `rotom/extensions/context-layers/`。不加载旧实现，不增加代理或数据库，不修改 Pi fork，不增加独立摘要模型。`ROTOM_CONTEXT_LAYERS=0` 关闭工具和提醒；已存在的 Pi `context_edit` 仍由 Pi 投影，不隐式展开历史。

## 端到端链路

```text
session 原始条目（不修改）
  → buildSessionProjection → 划分完整步骤 → context_status
  → 模型编写摘要 → context_compress 校验并排队
  → 成功的 turn_end 再校验 → 追加块记录、摘要替换、原文隐藏、回执
  → Pi 刷新上下文 → 下一次请求只见摘要与近期原文

context_recall → 当前分支原始条目 → 分页工具结果（不展开旧前缀）
```

- 工具为 `context_status`、`context_compress`、`context_recall`，均 sequential、model-only。尊重显式工具选择；没有三工具的完整 active set 时不注入提醒。deferred loader 原有“保留非 deferred 工具”合同已覆盖，不新增分组。
- 步骤是用户消息，或助手消息及其全部工具结果。工具调用/结果不配对、已错误/中止的助手步骤不可压缩。系统提示和工具声明不参与压缩。保护第一条、最新用户请求以及最近四个步骤；当前长任务中已经结束的更早步骤仍可压缩。
- 首轮只压新完成的连续步骤。两个以上连续、同层活跃块可合并，最多三层；单块可改写，保留同层级和原始覆盖关系。新记录引用旧块，不修改旧记录。三级仍可改写，但不继续升层；达到此限制且无法缩小时交给 Pi 原生压缩，不假装无限容量。
- `context_status` 分页列出摘要块及可压范围，`query` 搜索当前分支摘要和原始文本。候选范围每组最多 16 步，只是展示单位，不丢历史。
- 净收益依据 Pi 原生 token 估算，不是计费量；计入摘要标记本身。零收益、负收益、重叠排队、外部编辑或待提交区间变化均拒绝。
- 从估算占用 30% 起，且有 ≥1024 可压 token 或至少两个活跃块时提醒；重复提醒须继续增长至少 `max(1024, 5% window)`。提醒只追加到当前请求末尾，不写 session，不强制循环或自动重试。30% 选在 32K 小窗口常见原生压缩余量之前；不是保证先于所有用户自定义阈值。

## 恢复与一致性

- 原文来自当前分支的 session 消息。`one` 返回子块摘要和本层直接原文；`full` 返回覆盖范围全部可呈现原始内容。可用 `@entryId` 精确回查。工具参数、错误标记、call ID 保留；provider-private thinking/signature 不作为工具文本回显，原始 session 不变。
- 文本页约 12000 UTF-16 字符，避免拆开代理对；图片单独分页，保持原始 mime/data。图片页遇到文本模型明确报错，不静默转文字。`nextOffset=null` 与 `complete=true` 只描述选定视图；query 结果标为 matching-parts，不冒充全文。
- session 启动、切换、分支切换、原生压缩与 shutdown 清除内存待提交项和提醒计数。块状态由当前分支及 Pi 可见投影重建，不从其他分支恢复。原生压缩覆盖的块标为 archived，只要原文仍在分支就可回查。
- Pi boundary 会预览草稿，但其 session 多条追加**不是磁盘事务**。因此记录顺序是块来源 → 摘要 → 隐藏原文 → 回执。进程中断最多留下重复上下文或 partial 状态，不先删原文再补摘要。每个中间前缀都有负向测试；不自动重放 partial 写入。`context_status` 暴露 partial，仍可回查；需要恢复一致可由用户另行执行原生 `/compact`，不静默修复。
- 其他 boundary handler 的冲突编辑/压缩会令本次队列拒绝。取消或 provider error 不提交可见性变更。排队回执不冒充成功，最终 applied 回执位于全部 edits 之后。
- 无独立内容日志。业务历史仍只在用户已有的 Pi session 存储中；没有新增 trace 内容记录。

## 验证（2026-10-20）

验证使用独立公开基线 clone 及其按 lock 新安装的 `1.3.0-rotom.2`，不覆盖存活安装。维护 checkout 原有 Pi installed source 摘要漂移、Subagent WIP 与 installed version 不一致曾使产品 gate 拒绝；独立 clone 没有这两个问题。无需为本次 extension 重建 Pi。

- `index.test.ts`：8/8。真实 SDK/faux 工具循环、增量/三级合并/改写、磁盘重启、分支切换、原生压缩后回查、中止、外部编辑冲突、每个中断写入前缀、工具配对、净收益、分页/Unicode/图片、provider-private reasoning 不外露。
- TypeScript strict/noEmit：四个运行时文件通过，使用固定 Pi 的类型及 TypeBox。
- launcher identity/resource：39/39；distribution：25/25；默认、全工具模式、Layers 关闭模式三组真实 loader smoke 通过，三工具实际 active 且 model-only，未改变默认模型。eval product-resource 测试 8 通过、1 个未配置 stock sidecar 的既有 skip。
- Harbor adapter suite 7 通过、2 失败（fixture 缺少 `bin/rotom`）；在未修改的公开 HEAD 导出副本重跑得到相同两处失败，未为此扩大修复。系统 Python 未装 Harbor 的首次尝试不作为测试结果，实际 suite 使用项目脚本指定的 Harbor Python。
- Qoder `dfmodel` 真实请求：最终四次有界运行均完成精确文件写入；候选 2/2 完成“压缩 → 磁盘重启 → 回查 → 写 result.json”。验收先确认两项随机细节不存在于任何模型可见消息，然后独立校验输出文件字节对应值，不以工具调用成功代替恢复。

| 轮次 | 模式 | 模型请求 | 服务端报告 credits | 原文回查验收 |
|---|---|---:|---:|---|
| 1 | Layers | 6 | 0.232638 | 通过 |
| 1 | 原生对照 | 3 | 0.159560 | 直接可见原文，输出通过 |
| 2 | 原生对照 | 3 | 0.154841 | 直接可见原文，输出通过 |
| 2 | Layers | 7 | 0.239635 | 通过 |

完整 metadata 见 [verification JSON](context-layers-verification.json)。候选在压缩提交前后估算输入约 `14657 → 3429`、`14626 → 3452`；最终这组 fixture credits 合计约 **0.786674 Cr**，候选/对照约 **1.502×**。两组都未触发原生压缩，因此这不是“优于原生压缩算法”的实证，不作省钱或统计显著性宣称。按用户明确要求默认开启，用途是控制上下文并保持回查能力。

保留失败：最初 live harness 重用了已 dispose session 的 extension 闭包，并把合成历史误标为 Qoder 历史，触发 stale context / unbound session 拒绝；修复为每次重开重载资源、独立 runtime，合成历史明确用 fixture provider。早期一轮候选通过，另一轮模型把测试 key 保留在摘要中，未满足 hidden-answer 控制；最终改为在压缩后选择确实不在可见消息中的随机观察值，没有删除隐藏性检查。早期已报告约 0.819519 Cr；第一次通过隐藏答案控制的四次运行已报告约 0.813299 Cr。自审修复“成功压缩后重置提醒增长基准”，补回归并重新跑最终四次，结果如上表。本次所有有界运行已报告合计约 2.419491 Cr，非完整账号账单，USD unknown。

L3 范围为 Qoder + Layers + 原生 read/write，禁用独立付费 Reducer，避免超出本次 Qoder 费用授权。完整默认工具加载由离线产品 smoke 验证。实际图片 Provider 往返、多日长期会话、多 Provider 和 Windows 未实测；图片保持字节及模型能力门由定向测试覆盖。摘要语义和模型何时回查仍依赖模型，不由状态一致性证明。

## 重复验证

```sh
# 在已按锁安装 Pi/third-party 的 checkout 根目录：
node --experimental-strip-types --test rotom/extensions/context-layers/index.test.ts
# 需要明确 Qoder credits 授权；不读凭据文件，不回退模型，不自动重试：
ROTOM_CONTEXT_LIVE=1 ROTOM_OBSERVABILITY=0 node rotom/extensions/context-layers/live.mjs \
  "$PWD/rotom" /absolute/private/results.json dfmodel
```

Live harness 每次最多 12 次请求、20 次工具执行，每个 prompt 180 秒截止；一轮失败立即停止并保留私有诊断目录，不重放已有成功写入。每次 AgentSession 单独加载 extension，正常结果只记录计量与摘要，不保存任务内容。验证脚本和测试不进入产品 package files。
