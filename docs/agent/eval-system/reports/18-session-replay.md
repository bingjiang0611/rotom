# 任务 18 · 真实会话回放：从出错前一步接着跑

阶段：Phase 4。任务文件：[18-session-replay.md](../tasks/18-session-replay.md)。

**结论先说**：回放的后端（回放点存储、截断、运行器、三条规则、运行记录、看板进程控制）已经实现并测试通过；看板页面的回放面板已写好，但**缺少 HTTP 路由接线**——`dashboard.mjs` 单文件 116 KB，超过提交守卫的 20 KB 上限，无法提交任何对它的改动。这一条需要 bob 决定（拆分 `dashboard.mjs`，还是放宽守卫），见文末。按约束不读、不回放真实会话，全程只用合成会话。

## 一、做了什么

### 1. 回放点（`rotom/extensions/observability/eval/replay.mjs`，15 KB）

- 存储：`~/.rotom/evals/replay/cases/<sessionId>-<cutEntryId>.json`，字段 `sessionId`、`cutEntryId`、`expected`、`check`、`createdAt`、`sessionSha256`。
- 权限与边界：目录 0700、文件 0600；每条写入前 `assertPrivatePath`，拒绝 symlink 和 `..` 逃逸；`sessionId` / `cutEntryId` 都过长度与字符校验。
- 截断：`cutEntries(branch, cutEntryId)` 只认 assistant 消息作为回放点，取它**之前**的全部条目（压缩条目原样保留在前缀里）。找不到或不是 assistant 一律拒绝。
- 摘要：`sessionSha256` 记住会话文件当时的内容；重放前对不上就 `unknown: source_changed`，绝不猜。
- 规则：`checks-before-claiming`（下一步必须是 bash/read/grep/glob/ls/find 之一）、`no-identical-retry`（与截断点前最后一次失败调用同名同参即失败，找不到失败调用记 unknown）、`nonempty-handoff`（文本非空且说明进度或下一步）。
- 合并：规则与模型判定同时存在时，任一 fail 即 fail；两者都给不出结论记 `unknown`，不算通过。
- 记录：`~/.rotom/evals/replay/runs/<日期>/<key>-<arm>-<n>.json`，含首条 assistant 消息（文本 + 工具意图）、判定方式与版本、理由、用量、耗时。

### 2. 运行器（`rotom/evals/scripts/session-replay.mjs`，10 KB）

- 读回放点 → 校验 sha256 → `SessionManager.inMemory(cwd, {}, 截断点之前的条目)` 建不落盘会话 → `createAgentSession({ singleRequest: true })` → `session.agent.continue()`，只拿第一条 assistant 消息。
- **工具一定不执行**：临时扩展对每个 `tool_call` 返回 `block: true, reason: "replay: tools are not executed"`。工具定义照常提供，所以模型仍然可以选择调用工具，回放记录的是「调用意图」。
- 两臂：`--product` 为 candidate，`--arm-baseline` 给另一个产品目录；同回放点、同模型、同 thinkingLevel，重复次数默认 1、上限 3。
- 模型判定：复用 `eval/judge.mjs` 的静默启动与事件解析，输入先经 `redactSecrets` 脱敏，prompt 版本 `rotom-replay-judge/v1`，输出 `pass|fail|unknown` + 一句理由。
- 进度：每次运行向 stdout 打一行 `{"progress":{done,total}}`，结束时打 `{"runs":[...]}`。

### 3. 看板进程控制（`eval/replay-service.mjs`，4.8 KB）

- `cases()` / `add()` / `remove()` / `start()` / `status()` / `cancel()` / `close()`。
- `add` 自己算会话摘要，不接受调用方给的 sha。
- `start` 校验 `provider/model` 形状与用例列表，spawn 运行器，解析进度行，`cancel` 发 SIGTERM，关闭看板时清理仍在跑的进程。

### 4. 页面

- 失败会话（`verdict=fail` 或已加入失败集）的 assistant 事件旁出现「设为回放点」；表单含期望行为、判定方式（规则/模型）、规则选择，保存后刷新列表。
- 回放集列表：用例、期望行为、最近一次结果（通过/失败/unknown、哪一臂、时间）与理由，可删除；下方是运行控件（模型、重复次数、同时跑基线）+ 确认弹窗（用例数、总次数、模型、重复、基线）+ 进度 + 取消。
- 文案集中在 `eval/copy.mjs`，页面里没有硬编码中文。
- 为了不突破提交体积上限，`ui.mjs` 拆成 `ui.mjs`（17 KB）+ `annotation-ui.mjs` + `judge-ui.mjs` + `replay-ui.mjs`，浏览器端由 `evalScript` 把四个函数拼成一段脚本，依赖通过 `ctx` 传入。

## 二、卡住的地方：看板路由没有接线

`dashboard.mjs` 116 KB，提交守卫拒绝任何 ≥20 KB 的暂存文件，也不豁免既有大文件。因此：

- 已提交：回放点、运行器、进程控制、页面面板、测试。
- 未接线：`/api/eval/replay/{cases,case,case/delete,run,status,cancel}` 六个路由。当前打这些地址返回 404，页面的回放面板会显示「回放请求失败」。
- 需要的改动只有 12 行左右（创建 `replayService`、扩两个白名单、加三个分支），实现已经在 `eval/replay-service.mjs` 里；它被撤下只是因为 `dashboard.mjs` 无法提交。

**需要 bob 决定（二选一）**：
1. 把 `dashboard.mjs` 按职责拆开（HTML 外壳、trace 接口、eval 接口），之后任何改动都能提交；
2. 或放宽提交守卫的大文件限制。

在决定之前，回放只能用运行器脚本手动跑：`node rotom/evals/scripts/session-replay.mjs --product=<产品目录> --model=<provider/model> --cases=<key>`。

## 三、测试（L1/L2）

| 测试 | 覆盖 |
|---|---|
| `node --test rotom/extensions/observability/replay.test.mjs`（11 项） | 截断点取法（含压缩条目、非 assistant 拒绝）、sha256 变化与截断点丢失记 unknown、三条规则各合规/失败/unknown 样例、最后一次失败调用还原、unknown 不算通过、按臂×重复写记录、目录 0700/文件 0600、symlink 与路径注入拒绝、失败生成记 unknown、工具拦截理由与「不允许执行」、看板服务 spawn 参数/进度/结论/取消/非法请求、取消能杀掉运行器 |
| `node --test dashboard.test.mjs eval.test.mjs judge.test.mjs`（50 项） | 既有看板与 eval API 未回归 |
| `npm test -- …`（11 个文件 / 282 项） | eval 套件（行为回归三件套等） |
| `node eval-ui-smoke.mjs`（Playwright，合成数据） | PASS，0 页面错误：标注表单、judge 面板、时间线在拆分后仍正常 |
| `npm run typecheck` | 通过 |
| `python3 scripts/audit-public.py --root .` | PASS，0 findings |

## 四、未验证（诚实清单）

- **L2 缺口**：运行器本身的「只生成一条 assistant 消息」和「工具被 block」没有端到端跑过。测试只证明了拦截扩展的源码形状、以及记录结构；真正调用产品运行时需要本地装好 `rotom/runtime/pi` 并配一个可离线用的假 provider，这一步没做。
- **L3 缺口**：没有跑过真实模型，也没有在真实会话上回放（按约束禁止）。
- 回放面板的交互（设点、列表、运行、取消、删除）没有 Playwright 覆盖：面板的点位存在，但后端路由未接线，无法端到端冒烟。
- `nonempty-handoff` 的「说明进度或下一步」是本地实现，与合成题里的 `offersNextStep` 是两份代码（一个在 `.mjs`、一个在 `.ts`，浏览器与 eval 两侧无法共享），措辞覆盖可能漂移。
- 模型判定路径只做了代码复用，没有用假 launcher 跑通一次完整回路；`createModelJudge` 的事件解析依赖 `parseJudgeEvents` 的既有行为。

## 五、自查（按 `executor-checklist.md`）

1. 测试与审计：做了 —— 上面四条命令全跑过；审计 PASS 0；`git diff --check` 干净；只用 noreply 身份推 `eval/system`。
2. 判定：做了 —— 三条规则各有合规、失败、unknown 三个样例；`no-identical-retry` 在缺少失败调用时给 unknown 而不是 pass；数量类结论不适用（本轮判定不读回复里的数字）。
3. 用例与 fixture：不适用 —— 本轮没有新增合成题；测试用的合成会话来自既有 `eval-fixtures.mjs`，未写入设计意图。
4. 计数与汇总：做了 —— 计数相关的是 `runReplayPlan` 的进度（`done` 取结果数组长度，不累加渲染次数），同一输入重复跑结果一致；`unknown` 单独计，不算通过也不算失败。
5. 脱敏与隐私：做了 —— 模型判定前对上下文和 `expected` 都过 `redactSecrets`；会话原文、回放输出、判定结果只写 `~/.rotom/evals/replay/`，0700/0600；仓库里只有工具与合成会话。本轮没有改脱敏规则。
6. 真实模型运行：不适用 —— 本批明确不跑真实模型。
