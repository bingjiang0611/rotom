# Context Layers

独立实现的默认启用产品 extension，位于 `rotom/extensions/context-layers/`。不加载旧实现，不增加代理或数据库，不修改 Pi fork，不增加独立摘要模型。`ROTOM_CONTEXT_LAYERS=0` 关闭工具；Pi 自己的 `context_edit` 投影和原生压缩不受本 extension 影响。

## 当前合同：只读检索

```text
原生压缩 / 同会话轮转清出可见上下文（原文仍在 session 分支上）
  → context_recall 按 @entryId 或块范围取回当前分支的原始条目
  → 有界分页工具结果（只读、不展开旧前缀、不写入）
```

- 唯一工具是 `context_recall`：`sequential`、model-only、默认激活，尊重显式工具选择；`ROTOM_CONTEXT_LAYERS=0` 不注册。它不声明、不合并、不修改摘要，也不改变模型下一次看到的上下文。
- 结果是普通工具结果：它留在后续请求的上下文中（因此可能再次被压缩或清出），不会自动重新展开历史，也不会改变被清出条目的可见性。
- `query` 在当前分支的**全部**消息里做大小写不敏感的子串搜索，不只是被清出的部分；`ref` 按 `@entryId` 或摘要块读取。
- 原文来自当前分支的 session 条目。`one` 返回子块摘要与本层直接原文；`full` 返回覆盖范围全部可呈现原始内容；可用 `@entryId` 精确回查。工具参数、错误标记与 call ID 保留；provider-private thinking/signature 不作为工具文本回显，原始 session 不变。
- 文本页约 12000 UTF-16 字符，不拆开代理对；图片单独分页并保持原始 mime/data。图片页遇到文本模型明确报错，不静默转文字。`nextOffset=null` 与 `complete=true` 只描述选定视图；query 结果标为 matching-parts，不冒充全文。
- 块状态由当前分支及 Pi 可见投影重建，不从其他分支恢复。原生压缩或轮转覆盖的块标为 `archived`，只要原文仍在分支上就能回查。
- 无独立内容日志，不新增 trace 内容记录；业务历史仍只在用户已有的 Pi session 存储中。

## 已删除的能力

`context_status`、`context_compress`、三级摘要、块改写/合并、收益估算、待提交队列、partial 写入与恢复路径全部删除，只保留在 Git history 与 [历史验证记录](context-layers-history.md) 中。没有兼容开关或回退路径：旧会话里的块记录仍可被 `context_recall` 读取（它只依赖 session 条目），但不会再被改写。

## 重复验证

```sh
# 在已按锁安装 Pi 的 checkout 根目录：
ROTOM_PI="$(node rotom/runtime/resolve-installed-pi.mjs rotom)" \
  node --experimental-strip-types --test rotom/extensions/context-layers/*.test.ts
```

`live.mjs` 是检索臂的真实模型对照脚本，需要 Qoder credits 授权，不属于验证门禁。`experiments/context-layers/` 只保留 credits/time 预算保护（`budget.mjs` 与 `budget.test.mjs`）；测量压缩收益的 `stress.mjs` 随写入能力一起删除。
