# 任务 03 · 规则检查（code evals）接入会话卡片

阶段：Phase 2。模型调用：**无**。报告写到 `docs/agent/eval-system/reports/03-trace-assertions.md`。前置：任务 01 已 accepted。

## 目标

用纯函数实现一组确定性规则，输入是一个会话的当前分支（session entries）加上 trace 里的工具属性，输出命中的问题。把结果写进卡片，再随标注一起导出。这样 bob 标注完以后，就能直接算出每条规则和人工判断的一致程度：命中的会话里人工判 fail 的比例，以及人工判 fail 的会话里规则命中的比例。

这一步只搭框架、先放几条**不依赖 bob 分类结果**的通用规则。等任务 02 的类别出来，再按类别补规则。

## 交付物

| 文件 | 说明 |
|---|---|
| `rotom/evals/scripts/trace-assertions.mjs` | 规则与 `evaluateSession({ branch, traceTools, traceStatus })`，纯函数，不读文件 |
| `rotom/evals/scripts/trace-assertions.d.mts` | 类型声明 |
| `rotom/evals/scripts/session-cards.mjs` | 调用 `evaluateSession`，写入卡片和导出（见下文） |
| `rotom/evals/test/trace-assertions.test.ts` | 每条规则的命中、不命中、无法判断三类合成用例 |
| `rotom/evals/test/session-cards.test.ts` | 补充卡片和 labels 里带上规则结果的断言 |
| `rotom/evals/README.md` | 在 session-cards 小节下加规则表（≤ 15 行） |

## 结果模型

每条规则输出 `{ rule, status, count, evidence }`：

- `status`：`hit` / `clear` / `unknown`。依赖的数据缺失时（比如 trace 缺失、属性没有）必须是 `unknown`，不能当成 `clear`。这条沿用仓库的约定：unknown 是一等状态。
- `evidence`：只放 entry id、工具名、outcome、数字这类元数据，**不放**参数或结果正文。
- 规则 id 用稳定的 kebab-case 英文，以后加规则不改已有 id。

## 第一批规则

| id | 命中条件 | 数据来源 |
|---|---|---|
| `repeat-after-error` | 某次工具调用的结果 `isError=true`，紧接着的下一次工具调用工具名相同、参数也相同（按 key 排序后的 JSON 比较） | session |
| `ended-after-tool-error` | 当前分支最后一次工具调用的 trace outcome 不是 `ok`，而且之后最后一条 assistant 的 `stopReason` 是 `stop`（agent 在工具出错后直接收尾） | session + trace；trace 缺失或这个 span 没结束时为 `unknown` |
| `ended-on-provider-error` | 最后一条 assistant 的 `stopReason` 是 `error`，或者是 `aborted` 且之后没有新的 user 消息 | session |
| `schema-errors` | trace 里 `pi.tool.outcome = schema` 至少 2 次；`count` 记次数 | trace |
| `oversized-tool-result` | 某个工具 span 的 `pi.tool.result_text_bytes` 大于 50 000；`count` 记次数 | trace |
| `harness-fault` | 存在 `pi.tool.fault_side = harness` 的工具 span，这说明是 rotom 自己的问题，不是模型的问题 | trace |

阈值写成模块顶部的具名常量。实现时发现哪条规则的条件在真实 trace 里没有对应属性（比如属性名不一样），**不要改条件去凑**，在报告里写明，这条规则一律返回 `unknown`。

## 接入卡片

- frontmatter 新增 `findings: {"repeat-after-error":"hit", ...}`，每条规则都要出现，值为 status。
- 「最终回复」之前加一节 `## 规则命中`，每个 `hit` 一行：`- <rule>（count=N）：<evidence 摘要>`。没有命中时写 `(无)`。
- `build` 的 summary 新增 `findings` 计数表：`{ <rule>: { hit, clear, unknown } }`。
- `labels.jsonl` 每行新增 `findings` 字段，内容和 frontmatter 一致。
- 重建卡片时标注块照旧保留。

## 顺带：把解析错误拆成原因

`sessionParseErrors` 拆成 `badJson`、`lineTooLong`、`entryMissingId`、`danglingParent`、`cycle`、`messageMissing`（总数保留）。上一轮真实冒烟还有 26 个错误原因不明，这次报告里写出拆分后的计数。

## 验收命令

```sh
cd rotom/evals
npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always
npm test -- test/trace-assertions.test.ts test/session-cards.test.ts
npm test
npm run typecheck
cd ../..
git diff --check origin/main...HEAD
python3 scripts/audit-public.py --root .
```

全量 `npm test` 允许出现任务 01 报告里那 10 项既有失败，但不能新增失败。

## 真实数据冒烟

`build --limit 50 --out <仓库外目录>`，报告里写出 `findings` 计数表和解析错误拆分，只写计数。随机挑 3 张有 `hit` 的卡片人工核对，看规则是不是误报，结论写成「N 张里 M 张命中合理」，不贴内容。

## 不在本任务范围

LLM judge、`/flag` 命令、CI、修改 observability 扩展、根据规则结果自动判 fail。
