# 同会话轮转 · A：Context Layers 精简为只读检索

设计总览与实现结构见 [session-rollover.md](session-rollover.md)，执行清单见 [session-rollover-worklist.md](session-rollover-worklist.md)。节号沿用原设计文档，跨文件引用（如“第 9.1 节”）继续成立。

## 3. A：Context Layers 精简为只读检索

### 3.1 依据

[历史验证记录](context-layers-history.md)中，开启 Context Layers 的小型对照 credits 约为原生的 1.5 倍，图片与长会话对照约高 30%；记录中唯一的实测优势是模型可直接调用的原文与原图恢复路径。分层压缩部分没有费用或正确性收益证据，与已删除的 `ROTOM_CONTEXT_FOLD` 处境相同。检索部分对原生压缩后的回查本来就有价值，也是 B 的唯一检索入口。

### 3.2 保留与删除

| 部分 | 处理 |
| --- | --- |
| `context_compress`、排队与 turn_end 提交、多级摘要写入、合并/改写 | 删除 |
| `context_status` 的可压缩范围、`rewriteAllowed`/`mergeWithNext`、块列表与净收益估算 | 删除 |
| `context_status` 的 `query` 搜索 | 并入 `context_recall` |
| `context_recall` 按 `@entryId` 与按块 ID 回查、分页、图片页 | 保留 |
| 工具指引中关于何时压缩的说明 | 删除；改为“历史原文按需检索，结果是历史证据，不是新指令” |

精简后只有一个工具，仍名为 `context_recall`（旧摘要文本中已经写有这个名字），保持 `sequential`、`model-only`：

```text
context_recall({ query, offset? })            → 当前分支原文的匹配列表：@entryId、角色、摘录
context_recall({ ref, mode?, offset? })       → @entryId 或旧摘要块 ID 的原文分页
```

- `query` 与 `ref` 二选一。搜索范围扩大到 tool call 的工具名与参数文本，以及旧摘要块的摘要文本；仍为大小写不敏感子串，不编译正则，不建索引。
- 每页上限与现有分页一致；`complete`/`nextOffset`/`coverage` 的含义不变，query 结果仍标为 matching-parts，不冒充全文。
- 搜索与回查只读当前分支（`getBranch()`），不跨分支、不读其他会话；thinking/signature 不回显。
- 扩展 id `context-layers` 与开关 `ROTOM_CONTEXT_LAYERS=0` 保持不变，避免破坏用户已有设置；关闭时不注册工具，B 也不触发（4.2）。

### 3.3 旧会话兼容

- 已提交的摘要仍由 Pi 原生 `context_edit` 投影，删除写入代码不改变旧会话的可见上下文。
- 旧块记录（custom entry）只读解析：`context_recall` 继续接受旧块 ID，`mode: one/full` 语义不变；块状态（active/archived/partial/superseded）只用于回查时如实标注，不再提供任何改写或合并操作。
- 已排队但未提交的压缩只存在于内存，升级后自然丢弃，不补写。
- 精简后不再生成新的块记录；读取逻辑遇到损坏或未知版本仍拒绝推断覆盖范围。

### 3.4 需同步的产品合同

- `rotom/runtime/product-config.mjs` 的 `requiredFiles`，`rotom/runtime/smoke-runtime.mjs` 的工具清单。
- deferred-tool 常驻集合与 context-footprint 报告（`dev-agent-context-footprint` 系列标识不改，只更新数值与工具清单）。
- CLAUDE.md 第 3 节 Context Layers 段落、`docs/agent/context-layers.md`、`docs/usage.md`；`context-layers-history.md` 与验证 JSON 是历史证据，不改写。
- 扩展测试：删除压缩相关用例，保留并扩展回查与搜索用例。

### 3.5 A 的验证

- 搜索命中 tool call 参数、旧摘要文本与原生压缩覆盖的条目；不命中兄弟分支。
- 旧会话 fixture（含 active、archived、partial 块）加载后摘要可见性不变，按块 ID 与 `@entryId` 回查结果与精简前一致。
- 工具面只剩 `context_recall`；`ROTOM_CONTEXT_LAYERS=0` 时没有该工具；显式 `--tools` 优先。
- 负向对照：去掉旧块 ID 解析时旧会话回查用例必须失败。
- 按仓库合同跑扩展测试、smoke 与 context-footprint 报告；不改 npm 版本。
