# 任务 01 · 会话卡片 + 标注汇总

阶段：Phase 1（读会话、建失败分类）。模型调用：**无**。报告写到 `docs/agent/eval-system/reports/01-session-cards.md`。

## 目标

写一个本地脚本，把每个 rotom 会话的 Pi session 记录（`.jsonl`，有内容）和对应的 observability trace（`observability/<同名>.trace.jsonl`，只有元数据）拼成一张人能快速读完的 Markdown「会话卡片」，并让 bob 能在卡片里直接填标注、再汇总成 `labels.jsonl`。

这是后续 code evals、LLM judge 和每周闭环的数据入口，所以**正确地拼接**和**不丢标注**比好看重要。

## 交付物

| 文件 | 说明 |
|---|---|
| `rotom/evals/scripts/session-cards.mjs` | CLI，ESM，Node ≥ 24，无新增 npm 依赖 |
| `rotom/evals/scripts/session-cards.d.mts` | 导出函数的类型声明（参照现有 `eval-environment.d.mts`），保证 `npm run typecheck` 通过 |
| `rotom/evals/test/session-cards.test.ts` | vitest 单测，只用测试内生成的**合成** session/trace |
| `rotom/evals/README.md` | 加一小节：用途、命令、隐私边界（≤ 25 行） |
| `docs/agent/eval-system/reports/01-session-cards.md` | 执行报告 |

## 输入格式（已核对源码）

**Session**：默认根目录 `~/.pi/agent/sessions`（与 `dashboard.mjs` 的 `startTraceDashboard` 默认值相同），递归找 `*.jsonl`，排除 `observability/` 子目录。定义见 `packages/rotom-pi/packages/coding-agent/src/core/session-manager.ts`：

- 第一行是 header：`{type:"session", id, timestamp, cwd, version?}`。
- 之后每行一个 entry：`{type, id, parentId, timestamp, ...}`。**会话是树**（fork/重试会产生分支），卡片只展示**当前分支**：从文件里最后一个 entry 沿 `parentId` 回溯到根，再正序输出。
- `type:"message"` 的 `message.role`：
  - `user`：`content` 是字符串或 `{type:"text"|"image"}` 数组。
  - `assistant`：`content` 是 `text` / `thinking` / `toolCall{id,name,arguments}` 数组；另有 `provider`、`model`、`usage`、`stopReason`（`stop|length|toolUse|error|aborted|...`）。
  - `toolResult`：`toolCallId`、`toolName`、`content`、`isError`。
- 其它 entry：`compaction`（记一行「此处压缩，tokensBefore=N」）、`model_change`、`branch_summary`、`custom_message` 等。未知类型跳过并计数，不报错。

**Trace**：`<session 所在目录>/observability/<session 文件名去掉 .jsonl>.trace.jsonl`（见 `observability/index.ts` 的 `localTracePathForSessionFile`）。每行 `{schema:"rotom-local-trace/v1", kind:"span_start"|"span_end", traceId, spanId, parentSpanId?, name, attributes?, status?, durationMs?}`。

- 工具 span 名为 `pi.tool.execute`，`span_end` 上有 `pi.tool.name`、`pi.tool.outcome`、`pi.tool.fault_side`、`pi.tool.error_code` 等。
- **关联方式**：span 上的 `pi.tool.call_id_digest` = `sha256(toolCallId)` 的 hex。用 session 里的 `toolCall.id` 算同样的摘要来关联，不要按顺序猜。
- trace 可能缺失（`--no-session`、`ROTOM_OBSERVABILITY=0`、旧会话）或最后一行被截断：卡片照常生成，标 `trace: missing` 或 `trace: partial`。
- 可以复用 `rotom/extensions/observability/dashboard.mjs` 导出的 `readTraceTail`，也可以自写一个有界解析器；二选一，报告里说明。

## CLI

```sh
node rotom/evals/scripts/session-cards.mjs build  [--root <sessions>] [--out <dir>] [--since 7d] [--limit 50]
node rotom/evals/scripts/session-cards.mjs labels [--out <dir>]
```

- `build`：按会话修改时间倒序，取 `--since`（`Nd`/`Nh`）与 `--limit` 范围内的会话，每个生成 `<out>/<session-id>.md`。默认 `--out ~/.rotom/evals/cards`，`--limit 50`。stdout 只打印计数汇总（生成/跳过/trace 缺失/解析错误数），**不打印任何会话内容**。
- `labels`：扫描 `<out>/*.md` 的标注块，写 `<out>/../labels.jsonl`（每行 `{sessionId, verdict, categories[], note, cardPath, labeledAt}`，只收已填 verdict 的），stdout 打印 pass/fail 数和各 category 计数。

## 卡片格式

```markdown
---
session: <id>
file: <session 绝对路径>
cwd: <header.cwd>
started: <header.timestamp>
duration: <首末 entry 时间差>
models: [provider/model, ...]
turns: <assistant 消息数>
tool_calls: <数量>
tool_errors: {timeout: 1, tool_error: 2, ...}   # 来自 trace 的 pi.tool.outcome，非 ok 的计数
tokens: {input: N, output: N, cacheRead: N}      # session 里 assistant usage 求和
stop_reasons: {stop: 3, toolUse: 12, error: 1}
trace: ok | partial | missing
---

## 用户请求
<第一条 user 消息，截断到 2000 字符>

## 过程
### 第 1 轮 · user
<后续 user 消息，截断 1000>
- assistant：<text 截断 400；thinking 不输出，只记「(thinking N 字符)」>
- 🔧 `bash` `{"command":"npm test"}`（参数 JSON 截断 200）→ outcome=tool_error fault=environment · 结果：<前 300 字符>
- …（compaction / model_change 各一行）

## 最终回复
<当前分支最后一条 assistant 的 text，截断 4000>

<!-- label:begin -->
verdict:
categories:
note:
<!-- label:end -->
```

截断处标 `…[截断 N 字符]`。工具结果里的图片只记「(image)」。emoji 可换成纯文本，格式细节可调整，但上述字段都要有。

## 必须满足的行为

1. **不覆盖标注**：重新 `build` 时，若目标卡片已存在且标注块里 `verdict` 非空，保留原标注块原样，只重写上方内容。
2. **隐私**：输出目录用 `0700` 创建、卡片 `0600` 写入；`--out` 解析后若位于任何 Git 工作树内（向上找到 `.git`）则拒绝并退出非 0；session 根目录或输出目录是 symlink 时拒绝。
3. **有界**：单个 session 文件 > 32 MiB 跳过并计数；单行 > 1 MiB 跳过该行；一次 `build` 最多处理 500 个会话。
4. **容错**：坏 JSON 行跳过并计数，不中断其它会话；空会话（只有 header）跳过。
5. **只读输入**：绝不修改、移动、删除 session 和 trace 文件（可能属于存活会话）。

## 单测至少覆盖

- 分支会话：两个分支，卡片只含最后一个 entry 所在分支。
- trace 关联：用 `sha256(toolCallId)` 关联出 outcome/fault；trace 缺失 → `trace: missing`；末行截断 → `trace: partial`。
- 标注保留：先 build，写入 verdict，再 build，标注仍在且上方内容已更新。
- `labels` 汇总：两张已标注 + 一张未标注 → `labels.jsonl` 恰 2 行，category 计数正确。
- `--out` 在 Git 工作树内被拒绝；symlink 根被拒绝。
- 截断标记与「不打印内容到 stdout」。

## 验收命令（规划者会重跑）

```sh
cd rotom/evals
npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always
npm test -- test/session-cards.test.ts
npm test
npm run typecheck
cd ../..
git diff --check origin/main...HEAD
python3 scripts/audit-public.py --root .
```

## 真实数据冒烟（执行者在有真实会话的机器上做）

若你的环境有 `~/.pi/agent/sessions`：运行 `build --limit 5 --out <仓库外的临时目录>`，人工打开一张卡片看是否可读。报告里**只写计数和你观察到的格式问题**，不要粘贴任何卡片内容。没有真实会话就写「未做真实数据冒烟」。

## 不在本任务范围

失败检测规则、LLM judge、`/flag` 命令、改 observability 扩展、CI 配置、任何 UI。看到值得做的点写进报告的「遗留问题」，不要顺手做。
