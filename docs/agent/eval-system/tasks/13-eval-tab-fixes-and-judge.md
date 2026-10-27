# 任务 13 · Eval 页修正 + 「让模型先分析一轮」

阶段：Phase 4。报告写到 `docs/agent/eval-system/reports/13-eval-tab-fixes-and-judge.md`。

## 背景：bob 试用任务 12 后的反馈（2026-10-26）

1. **没有翻译**：顶栏和页面里还有英文（`SESSION STATS`、`EXECUTION TRACE`、`Eval`、`SCAN LIMITED · N TRACES`、`LOCAL ONLINE` 等）。
2. **进行中的会话不能标注**：长期运行的会话（例如跑了上千分钟的）一直显示 active，标注按钮被禁用；但左侧列表又显示「满意」（来自终端 `review` 的旧标注），看不出以哪个为准。
3. **分不清哪些会话标过、哪些没标**。
4. 列表报「读取失败，请刷新重试（HTTP 409）」：有会话在持续写入时，分页 snapshot 就失效了。
5. **希望对要复盘的会话手动触发，让模型先 judge / 分析一轮，然后自己决策**。

bob 已明确要求第 5 点，所以本任务包含 LLM 调用：**只在 bob 点按钮时调用**，用他自己已配置的模型和登录。

## A. 界面中文化

- 后台所有用户可见文案改为中文，包括原 trace 视图的顶栏、状态行、切换按钮、页脚、错误提示。建议：`SESSION STATS`→「会话统计」，`EXECUTION TRACE`→「执行链路」，`Eval`→「评测」，`LOCAL ONLINE`→「本机在线」，`SCAN LIMITED`→「扫描受限（只读最近 500 个文件）」。
- 稳定的技术标识（span 名、规则 id、outcome 值、模型 id）保留英文，旁边加中文说明，例如「工具出错后重复调用（repeat-after-error）」。规则 id 的中文名放在 `copy.mjs` 里集中维护。
- 错误提示不能只给 HTTP 码：409 →「会话正在写入，列表已自动刷新」，401 →「访问 token 无效，请重新打开 rotom --trace 打印的链接」等。

## B. 「活动状态」和「标注状态」分成两件事

- 列表和复盘页把两个状态**分开显示**：
  - 活动状态：进行中 / 暂停写入 / 未知（沿用 5 分钟窗口）；
  - 标注状态：未标注 / 满意 / 不满意 / 失败集，并显示来源（后台 / 终端 review）。
- **进行中的会话也允许标注**。保存前提示「会话仍在进行，这次标注针对目前的进度」。annotation 增加 `atEntryId`（标注时当前分支最后一个 entry 的 id）和 `atEntryCount`。
- 如果标注之后会话又有了新进展（当前分支末尾的 entry 不再是 `atEntryId`），标注状态旁边显示「标注后有新进展」，提醒 bob 可以重新看一下。
- 后端相应地取消「active 拒绝标注」的限制；`unknown`（拿不到文件时间）仍然拒绝。同步更新 CLAUDE.md 第 5 条中的这句描述，以及 `change-checklists.md`。
- 复盘页的标注按钮要显示当前已有的标注（高亮对应按钮，并写「当前：满意（来自终端 review）」），不要只是一个看起来像选中、实际被禁用的按钮。

## C. 一眼看出标没标

- 列表每一行左侧加色条：未标注用醒目色，满意 / 不满意 / 失败集各用一种颜色，配文字徽章（不只靠颜色区分）。
- 筛选下拉显示计数，例如「未标注（130）」「不满意（4）」。**默认筛选改成「未标注」**。
- 列表顶部显示进度：「已标注 44 / 174」。

## D. 修好 409

- 分页 snapshot 只锁定**会话列表本身**（有哪些会话、排序），不因某个会话内容变化就整页作废。会话内容变化只影响该会话的时间线分页。
- 时间线分页遇到会话内容变化时，自动从第一页重新加载并提示一次，不弹错误。
- 合成测试：在翻页过程中持续 append 一个会话，列表翻页不报错；时间线给出「会话有更新，已重新加载」。

## E. 让模型先分析一轮（judge）

### 触发与调用

- 复盘页加按钮「让模型分析」和模型下拉框。可选模型来自 `rotom --list-models`（服务端调用一次并缓存），默认选中 Pi 当前的默认模型。
- 点击后先弹确认：所选模型、发送的字符数、是否被截断，以及一句话「会话内容会发送给所选模型的服务商；费用以服务商报告为准，缺失时显示未知」。确认后才调用。
- 服务端用 **argv 数组**（不经过 shell）启动产品自己的 launcher：同一个 node + `rotom/bin/rotom-launcher`，从 dashboard 文件位置解析，不走 PATH。参数基线：`-p --mode json --no-session --no-tools --no-skills --no-context-files --no-prompt-templates --model <id>`，输入通过 stdin 传入。
  - 是否还能加 `--no-extensions`，取决于所选 provider 是否依赖产品扩展（例如 qoder）。执行者核实后写进报告：能加就加，不能加的要说明原因。
  - cwd 用一个私有的空临时目录，避免加载任何项目资源。
  - `<id>` 必须在 `--list-models` 的结果里，否则拒绝。
- 同一时间只跑一个；超时 `JUDGE_TIMEOUT_MS`（默认 180 秒）；**不自动重试**；页面上有「取消」，会结束子进程。失败、超时或取消都记为相应状态，不伪装成成功。
- `--no-session` 保证这次调用不会产生新会话或 trace，也不会出现在 Eval 列表里。

### 发给模型的内容

- 由当前分支生成有界摘要，不超过 `JUDGE_MAX_INPUT_CHARS`（默认 80,000 字符）：首条请求、所有 user 消息、assistant 文本（单条截断）、每次工具调用的工具名 + outcome + 截断后的参数、错误、最终回复。每个事件带序号，便于模型引用；截断的地方明确标出。
- **不把 bob 已有的标注和原因发给模型**，judge 要独立判断。
- prompt 放在 `observability/eval/judge-prompt.mjs`，带版本号 `JUDGE_PROMPT_VERSION`。核心标准沿用标注时的那一条：「如果这是交给同事的活，你会不会满意」。要求模型只输出 JSON：

```json
{
  "suggestedVerdict": "pass | fail | unsure",
  "confidence": 0.0,
  "summary": "300 字以内的复盘",
  "firstProblem": { "event": 12, "description": "第一个出问题的地方" },
  "categories": ["tool_thrash | unverified_claim | ignored_instruction | ui_without_design | incomplete | wrong_result | gave_up | other"],
  "evidence": [{ "event": 12, "quote": "200 字以内" }],
  "suggestions": ["给 bob 的复盘建议"]
}
```

  没有问题时 `firstProblem` 为 null。输出必须严格校验；不合格就记为 `invalid_output`，并在私有文件里保留截断后的原始输出，方便排查。

### 存储与展示

- 私有存储 `~/.rotom/evals/judgments/<sessionId>/<UTC 时间戳>.json`（目录 0700、文件 0600、原子写入、拒绝 symlink），保留历史，不覆盖。字段包括：`schema: "rotom-eval-judgment/v1"`、`sessionId`、`atEntryId`、`model`、`promptVersion`、`inputDigest`（sha256）、`inputChars`、`truncated`、`status`（ok / invalid_output / failed / timeout / cancelled）、`durationMs`、`usage`（从 json 模式事件中取 token 和 cost，缺失记 null，标明 unknown）、`result`。
- 复盘页显示最新一次分析：建议结论、把握、复盘摘要、第一个问题（点击跳到时间线对应事件并高亮）、证据、建议；同时显示模型、耗时、费用、历史次数。
- 「采纳建议」按钮只**预填**标注区（结论 + 用 firstProblem 生成的一句原因），仍要 bob 点「保存标注」。**judge 永远不直接写 annotation**。
- 列表行上加一个小标记，表示「已有模型分析」以及建议结论，方便 bob 先看模型认为有问题的会话。
- `session-cards.mjs agreement` 增加一节：在同时有 judge（status ok 且 verdict 不是 unsure）和人工标注的会话上，输出 judge 与人工的 TP / FP / FN / TN 计数和 n；n < 10 标 `*`。这是以后判断 judge 可不可信的依据。

## 约束

- 不改 trace 记录合同；judge 子进程用 `--no-session`。
- 后台仍只监听本机端口，需要 token，不开 CORS；新增的 POST（触发 / 取消 judge）沿用任务 12 的 Origin、Content-Type、体积、Host 校验。
- 不读取、复制或传递任何凭据：认证完全由子进程里的 rotom 自己处理。
- 同步更新 CLAUDE.md 第 5 条与 `change-checklists.md`：Eval 页可在用户逐次确认后，把有界会话摘要发给用户所选的模型。

## 测试

- A–D：文案无遗留英文（合成页面上扫描可见文本，白名单是技术标识）；两种状态的组合显示；active 会话可以标注并写入 `atEntryId`；「标注后有新进展」；筛选计数与默认筛选；持续 append 下翻页不报 409。
- E：用**隔离的 fake launcher 可执行文件**测试（参照 verification.md 的外部 CLI 测试约定）：断言精确的 argv、cwd 为空临时目录、通过 stdin 输入、超时会结束子进程、取消、输出预算、非法 JSON → `invalid_output`、模型不在列表里时拒绝、同时只能跑一个、失败不重试、judge 不写 annotation、文件权限与原子写入。
- 摘要生成：截断标记、事件序号、不包含人工标注。
- Playwright（合成数据）：中文界面 → 默认未标注筛选 → 标注一个进行中的会话 → 触发分析（fake launcher）→ 看结果 → 采纳建议 → 保存 → 刷新后保留 → 点击第一个问题跳到时间线。附截图（放在仓库外）。

## 真实数据与费用

- 真实会话：只确认 A–D 在 bob 的会话目录上能正常加载，并报告聚合计数。**不对真实会话触发 judge**：第一次真实分析由 bob 自己点，因为会把他的会话内容发出去，也会产生费用。
- 允许对**一个合成会话**用真实模型触发至多 1 次，以验证真实 launcher 路径；报告写所用模型、状态、耗时、token 和费用（拿不到写 unknown）。如果本机 launcher 受既有 identity gate 阻断跑不起来，就写「未验证」，不要绕过 gate。

## 不在本任务范围

失败集导出与回放（第三步）、批量自动 judge、定时任务、改规则阈值、npm 发布、推 main。
