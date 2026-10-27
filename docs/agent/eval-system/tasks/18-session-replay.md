# 任务 18 · 真实会话回放：从出错前一步，让新旧版本接着跑

阶段：Phase 4（失败集 → 回归测试）。报告写到 `docs/agent/eval-system/reports/18-session-replay.md`。**任务 17 验收后再开工。**

## 为什么

合成题改了两轮，一直没有复现复盘里的失败。真实失败发生在长上下文、做到一半的会话里。回放的做法是：拿 bob 标为失败的真实会话，截到出错那一步之前，用当前产品从同一个位置**只生成下一步**，看它还会不会犯同样的错。这就是 bob 最早提的「有问题的会话加入 eval 集，形成循环」。

## 隐私边界（最重要）

- 会话原文、截断点之后的内容、回放输出、判定结果，**只放在** `~/.rotom/evals/replay/` 下（0700/0600，拒绝 symlink，拒绝放在 Git worktree 里）。不进仓库，不进 issue，不进聊天，不进报告。
- 仓库里只放回放工具、UI 和**合成**的测试会话。
- 回放会把截断点之前的上下文发给所选模型。这些内容当初就是发给同一类 provider 的，但每次运行前仍然要像后台 judge 一样，让用户确认模型、发送字符数和用例数。
- 执行 agent **不在真实会话上做回放**，只用合成会话测试。第一次真实回放由 bob 在后台触发。

## 做什么

### 1. 在后台 Eval 页标「回放点」

- 会话详情的时间线上，每条 assistant 事件旁边加一个「设为回放点」按钮。只对已标为 fail、或者已勾选加入失败集的会话显示。
- 点击后弹出一个小表单：
  - **期望行为**：一句话，例如「应该先查状态再回答」
  - **判定方式**：「规则」或「模型判定」
  - 规则模式下，从一个小规则表里选一条，见下文第 3 节
- 保存到 `~/.rotom/evals/replay/cases/<sessionId>-<entryId>.json`，字段至少有：`sessionId`、`cutEntryId`（这条 assistant 消息的 id；回放从它的父节点开始）、`expected`、`check`、`createdAt`、session 文件的 sha256（会话之后再变就能发现）。
- 如果后台 judge 对这个会话已有结论，并且指向了具体事件，表单里预填这个位置，但仍然由 bob 确认。
- Eval 页加一个「回放集」列表：列出所有回放点，显示最近一次回放的结果（通过 / 失败 / unknown、哪个版本、什么时候），并能删除回放点。

### 2. 回放运行器

- 新脚本 `rotom/evals/scripts/session-replay.mjs`，也可以放进 `rotom/evals/src/`，按现有风格选择：
  - 读回放点；
  - 校验 session 文件的 sha256，不一致就标 `unknown: source_changed`；
  - 取截断点之前的当前分支条目，用 `SessionManager.inMemory(...)` 建一个**不落盘**的会话；
  - 用指定产品（baseline 或 candidate 的 product 目录）和模型，从这里生成**下一条 assistant 消息**。
- **工具不真正执行**：工具定义照常提供，这样模型可以选择调用工具。但用 eval 侧扩展把所有 `tool_call` block 掉，原因写 `replay: tools are not executed`。只要拿到第一条 assistant 消息（文本加工具调用意图）就结束本次回放。真实工作区早就变了，执行工具既不可复现，也可能有副作用。
- 两臂（baseline / candidate）使用同一个回放点、同一个模型、同一个 thinkingLevel；每个回放点、每臂可以重复 N 次（默认 1，上限 3）。
- 输出写到 `~/.rotom/evals/replay/runs/<日期>/`：第一条 assistant 消息、工具调用意图、判定结果、用量、耗时。

### 3. 判定

- **规则**：先做 3 条，对应 bob 复盘里最常见的模式：
  - `checks-before-claiming`：下一步必须是一次查询类工具调用（如 bash 或 read），不能直接用文本下结论；
  - `no-identical-retry`：下一次工具调用的名字和参数，不能与截断点之前最后一次失败的调用完全相同；
  - `nonempty-handoff`：回复文本非空，并说明进度或下一步（复用合成题里的判定函数）。
- **模型判定**：复用后台 judge 的管道，包括脱敏、确认 token、一次只跑一个、超时和取消。输入为：截断点前最后几条事件（已脱敏、有上限）、`expected`、回放出的下一步。模型输出 `pass` / `fail` / `unknown` 和一句理由。prompt 单独定版本号，例如 `rotom-replay-judge/v1`。
- 每次结果都要记录判定方式和版本。规则和模型判定都给不出结论时记 `unknown`，不能算成通过。

### 4. 后台触发

- 「回放集」页加一个「运行回放」按钮：选模型、选臂（当前产品，或者再加一个 baseline 产品目录）、选重复次数。确认弹窗显示：用例数、总运行次数、预计发送字符数，以及脱敏统计（只针对发给 judge 的那部分）。
- 运行时有进度、可以取消、不自动重试。结果写回回放集列表。

## 测试

- 用合成会话（`eval-fixtures.mjs` 扩展）测试：截断点取法正确，包括分支和压缩条目；sha256 变化时标 unknown；工具一定被 block；只生成一条 assistant 消息；3 条规则各自有合规和失败的对照样例；模型判定用假 launcher 测试。
- 存储测试：权限是 0700/0600；拒绝 symlink、路径注入和 Git worktree。
- UI：用 Playwright 在合成数据上冒烟，覆盖设回放点、列表、运行（假 launcher）、取消、删除。
- CI 加上新的测试文件。

## 不做

- 不执行真实工具，也不重建当年的工作区。
- 不自动把 judge 的结论变成回放点，必须由 bob 确认。
- 不改 observability trace 合同。

## 约束

- 只推 `eval/system`，不推 main，不 force push，用 noreply 身份提交。
- 不读、不回放 bob 的真实会话。
- 提交前跑公开树审计。
- 完成后 README 第 18 行改成 `in-review`。报告里写清 L1/L2 跑了什么，以及哪些需要 bob 做真实验证（L3）。

---

## 第 2 轮（核验后补充）

先按报告末尾「核验」的第 1–4 条修复（第 6 条可选）。第 5 条 bob 在 2026-10-27 选择了**给 dashboard.mjs 加豁免**：

- 在 `scripts/check-staged-file-size.mjs` 里新增一个具名列表，例如 `legacyOversizedFiles`，**只放** `rotom/extensions/observability/dashboard.mjs` 一个文件。注释写明这是 bob 的决定，以及原因：看板主文件过大，暂不拆分。不要放宽 `maxBytes`，也不要把豁免写成目录或通配。
- 同步更新 `scripts/check-staged-file-size.test.mjs`：豁免文件超过上限能提交；其他超限文件仍被拒；把豁免文件改名或复制到别的路径，仍然被拒。
- 然后接上 `/api/eval/replay/*` 的 6 个路由。沿用现有安全约束：Bearer token、Host 校验、POST Origin、JSON 类型和体积上限。接口白名单要同步。
- 用 Playwright 在合成数据上冒烟回放面板，覆盖：设回放点、列表、运行（faux provider 或假运行器）、进度、取消、删除。

完成后在报告里追加「第 2 轮修改」一节，并按自查清单自查。README 第 18 行改回 `in-review`。
