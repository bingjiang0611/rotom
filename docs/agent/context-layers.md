# Context Layers

独立实现的默认启用产品 extension，位于 `rotom/extensions/context-layers/`。不加载旧实现，不增加代理或数据库，不修改 Pi fork，不增加独立摘要模型。`ROTOM_CONTEXT_LAYERS=0` 关闭工具；已存在的 Pi `context_edit` 仍由 Pi 投影，不隐式展开历史。

## 端到端链路

```text
session 原始条目（不修改）
  → buildSessionProjection → 划分完整步骤 → context_status
  → 模型编写摘要 → context_compress 校验并排队
  → 成功的 turn_end 再校验 → 追加块记录、摘要替换、原文隐藏、回执
  → Pi 刷新上下文 → 下一次请求只见摘要与近期原文

context_recall → 当前分支原始条目 → 分页工具结果（不展开旧前缀）
```

- 工具为 `context_status`、`context_compress`、`context_recall`，均 sequential、model-only。尊重显式工具选择。deferred loader 原有“保留非 deferred 工具”合同已覆盖，不新增分组。
- 步骤是用户消息，或助手消息及其全部工具结果。工具调用/结果不配对、已错误/中止的助手步骤不可压缩。系统提示和工具声明不参与压缩。保护第一条、最新用户请求以及最近四个步骤；当前长任务中已经结束的更早步骤仍可压缩。
- 首轮只压新完成的连续步骤。两个以上连续、同层活跃块可合并，最多三层；单块可改写，保留同层级和原始覆盖关系。新记录引用旧块，不修改旧记录。三级仍可改写，但不继续升层；达到此限制且无法缩小时交给 Pi 原生压缩，不假装无限容量。
- `context_status` 每页最多 24 项，先列出**最大连续可压范围**，再列出可改写或可合并的摘要块，最后列出不可操作的摘要块（含 archived）；历史块保留分页、搜索和回查，不挤占候选首页。不再按 16 步切段；不同 range 行之间必有保护步骤，不可跨行选取。范围仍只返回端点、步数、估算量和有界预览，不输出整段原文。摘要的 `rewriteAllowed` 表示能否改写，`mergeWithNext` 指向当前投影中可合并的相邻同层块（无则为 null）；跨页可沿链接组成有序链，三级块只可改写。`query` 搜索当前分支摘要和原始文本，搜索命中不是压缩候选。
- 净收益依据 Pi 原生 token 估算，不是计费量；计入摘要标记本身。零收益、负收益、重叠排队、外部编辑或待提交区间变化均拒绝。
- 不注入自动的上下文占用提醒（已于 2026-10-27 移除，见[历史验证记录](context-layers-history.md)）。是否压缩只由模型依据工具说明与指引自行判断，或由用户要求；原生压缩设置不变。保持历史前缀有助于缓存复用，压缩后 token 更少不代表费用更低。

## 恢复与一致性

- 原文来自当前分支的 session 消息。`one` 返回子块摘要和本层直接原文；`full` 返回覆盖范围全部可呈现原始内容。可用 `@entryId` 精确回查。工具参数、错误标记、call ID 保留；provider-private thinking/signature 不作为工具文本回显，原始 session 不变。
- 文本页约 12000 UTF-16 字符，避免拆开代理对；图片单独分页，保持原始 mime/data。图片页遇到文本模型明确报错，不静默转文字。`nextOffset=null` 与 `complete=true` 只描述选定视图；query 结果标为 matching-parts，不冒充全文。
- session 启动、切换、分支切换、原生压缩与 shutdown 清除内存待提交项。块状态由当前分支及 Pi 可见投影重建，不从其他分支恢复。原生压缩覆盖的块标为 archived，只要原文仍在分支就可回查。
- Pi boundary 会预览草稿，但其 session 多条追加**不是磁盘事务**。因此记录顺序是块来源 → 摘要 → 隐藏原文 → 回执。进程中断最多留下重复上下文或 partial 状态，不先删原文再补摘要。每个中间前缀都有负向测试；不自动重放 partial 写入。`context_status` 暴露 partial，仍可回查；需要恢复一致可由用户另行执行原生 `/compact`，不静默修复。
- 其他 boundary handler 的冲突编辑/压缩会令本次队列拒绝。取消或 provider error 不提交可见性变更。排队回执不冒充成功，最终 applied 回执位于全部 edits 之后。
- 无独立内容日志。业务历史仍只在用户已有的 Pi session 存储中；没有新增 trace 内容记录。

## 历史验证

初始实现、图片与长会话对照、本地安装门禁、提醒节奏及候选诊断的版本绑定证据见 [历史验证记录](context-layers-history.md)。

## 重复验证

```sh
# 在已按锁安装 Pi/third-party 的 checkout 根目录：
node --experimental-strip-types --test rotom/extensions/context-layers/*.test.ts
# 需要明确 Qoder credits 授权；不读凭据文件，不回退模型，不自动重试：
ROTOM_CONTEXT_LIVE=1 ROTOM_OBSERVABILITY=0 node rotom/extensions/context-layers/live.mjs \
  "$PWD/rotom" /absolute/private/results.json dfmodel
# 图片与 32 轮真实长会话；两条独立执行，不并发：
ROTOM_CONTEXT_LIVE=1 ROTOM_OBSERVABILITY=0 node experiments/context-layers/stress.mjs \
  "$PWD/rotom" /absolute/private/images.json images
ROTOM_CONTEXT_LIVE=1 ROTOM_OBSERVABILITY=0 node experiments/context-layers/stress.mjs \
  "$PWD/rotom" /absolute/private/long.json long
node --test experiments/context-layers/budget.test.mjs
```

Live harness 每次最多 12 次请求、20 次工具执行，每个 prompt 180 秒截止；一轮失败立即停止并保留私有诊断目录，不重放已有成功写入。每次 AgentSession 单独加载 extension，正常结果只记录计量与摘要，不保存任务内容。验证脚本和测试不进入产品 package files。新 `stress.mjs` 每个对照臂最多 180 次主请求、每 prompt 180 秒、整个套件 45 分钟/30 Cr 软保护；计量在请求完成后获得，保护不保证零超支。失败保留私有诊断目录，默认不自动续跑或重放；`images attachment-only` 可单独重测附件场景。
