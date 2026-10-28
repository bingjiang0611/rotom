# 任务 22 · 失败集接入本机一键回归

阶段：Phase 4。前置：任务 18、20、21 已验收。报告写到 `docs/agent/eval-system/reports/22-local-failure-regression.md`。

**本文件是待实现任务，不表示功能已经可用，也不授权执行者读取私人会话或调用真实模型。**

## 目标与范围

补齐「人工标失败 → 确认回放点 → 冻结回归集 → 修改 agent → 一条命令比较新版和基线」的闭环。

- 将所有符合条件的已保存回放点冻结成本机回归集；不要求逐个手抄参数。
- 一次命令运行 baseline、candidate 和 original 对照，优先列出退化，再列改进、仍失败与无法判断的点。
- 对已标不满意／加入失败集但没有回放点的会话，给出有证据的截断位置建议；用户确认后才保存。
- 真实内容和运行记录仅存在本机私有目录，不进入 CI、Git、issue、公开报告或聊天。CI 只运行合成数据的确定性测试。
- 仍只验证**下一步决策**，不执行生成的工具调用、不重建历史工作区，不把一次通过说成整段任务端到端成功。

## 先复用，避免再造一套运行器

核对并复用：

- `rotom/extensions/observability/eval/annotations.mjs`：现有人工标签，不另造失败标签库。
- `rotom/extensions/observability/eval/replay.mjs`：回放点、来源摘要、截断、规则、original 对照和运行记录。
- `rotom/extensions/observability/eval/replay-plan.mjs`：重复次数、调用与发送量统计。
- `rotom/extensions/observability/eval/replay-service.mjs`：产品解析、准备、确认与运行生命周期。
- `rotom/evals/scripts/session-replay.mjs`：两臂生成和共用判定输入。

CLI 和后台共用同一份计划、验证与运行逻辑；不要复制一份会逐渐偏离的 replay runner，不新增通用评测框架、调度平台或第二套 provider 适配器。

## A. 冻结本机回归集

新增小型、版本化的本地清单。默认放在 `~/.rotom/evals/replay/sets/`，只存必要引用和冻结信息，不复制整段会话。

1. 默认收集全部有效已保存回放点，包括标 fail 但未勾选失败集的点；若显式筛选为失败集或指定点，显示实际范围，不偷偷跟随后台当前页面筛选。
2. 每项固定回放点身份、来源 SHA-256、assistant 截断锚点、期望行为、判定方式及版本，并记录清单自身摘要。去重保持稳定，同一输入不能重复累加。
3. 有效性至少要求：来源唯一可解析、当前分支含目标 assistant、来源摘要匹配、期望与判定完整，并通过现有路径、大小及状态约束。
4. 原始会话变化、分支或锚点消失、标签被清除、判定被修改时明确报失效原因；不得自动改 SHA、挪锚点或覆盖冻结清单。用户复核后显式重建。
5. 缺失、超限、不明确的点单列，不静默丢掉。清单记下发现数、纳入数、排除原因和扫描是否完整；空集或有限扫描不能返回「全量回归通过」。
6. 不用会话列表的候选数量上限证明已找到所有回放点。按已有点的 session ID 定向解析，拒绝重复身份与路径漂移；无法完成解析则显示阻塞，不为本任务重构整个历史索引。

## B. 一个本机入口，单次运行两臂

入口为 `rotom eval-regression`（launcher 在 checkout 中路由到 `rotom/evals/scripts/eval-regression.mjs`，等价于 `cd rotom/evals && npm run eval-regression -- …`）：

```bash
# 本地读取并冻结有效回放点；不调用模型。集合名只能落在私有 sets 目录内。
rotom eval-regression prepare --name=failures [--selector=all|fail|failSet] [--repeats=1..3] [--force]

# 修改 agent 后的一条回归命令；启动推理前仍展示计划并确认
rotom eval-regression run --set=failures \
  --baseline=<absolute-baseline-product-dir> \
  --candidate=<absolute-candidate-product-dir> \
  --model=<provider/id> [--repeats=1..3] [--plan-digest=<摘要>] [--yes] [--json]

# 为标了不满意但还没有回放点的会话给出截断点证据；只写私有草稿
rotom eval-regression suggest [--limit=20]

# 人工确认一条建议后才写入回放点
rotom eval-regression add --session=<id> --entry=<entryId> --expected=<text> --check=model|rule:<rule> --yes
```

- baseline 必须显式指定，不自动把当前安装当作旧版，不自动 checkout、重装或覆盖运行中的产品。缺少基线不能悄悄降成单臂成功。
- 计划里包含脱敏后的字符量、分层调用数（生成／模型判定／本地规则判定分开）、两臂路径、两臂与扩展的内容身份和计划摘要；`--yes` 确认的是同一次调用打印出的计划，`--plan-digest` 只用于把已保存的授权绑定到同一计划。
- 冻结记录是运行输入：运行器执行冻结载荷，不回读可变回放库；冻结后被编辑的点不改变已确认计划的含义。集合含被排除点、索引不完整或判定提示词版本变化时拒绝启动。
- 授权绑定内容而非路径：计划摘要包含两臂与 `--extension` 的逐文件内容身份（排除 `node_modules` 与 `evals/`，Pi fork 由 `runtime/pi` 的 lock/fork-build 版本与 integrity 固定）。同一路径下改了文件也失效；两次读取之间内容变化同样拒绝。
- 固定并记录两臂产品身份／摘要、生成模型、thinkingLevel、判定版本、清单摘要。相同产品只能报告为无版本差异的对照，不能声称已验证升级效果。
- 两臂使用同一份输入、生成配置和评分标准。默认每点每臂 1 次，重复上限沿用现有 3 次；串行运行即可，不为吞吐新增并行调度。
- original 仍默认存在，只评分原回复、不重新生成；沿用现有每点一次的对照语义。不得把历史版本的判定记录混入本次结果。
- 复用现有单条 assistant 生成、工具拦截与每次 scratch 隔离；不以「本机运行」冒充 OS 沙箱，不允许历史指令触发真实业务操作。
- 准备阶段核对当前发行包是否实际包含 runner 及其 import 闭包。若缺文件，先补产品声明与打包清单；不能只在源码 checkout 下跑通，也不能依赖维护仓或全局 Pi 兜底。

### 授权、费用与中断

「本机运行」指本机编排和存储，**不表示推理离线**：生成上下文及模型评分输入会发送到用户选择的 provider。

- 真正发送前展示精确模型、两臂身份、用例数、重复数、生成／评分调用数、发送字符数、脱敏与截断情况；original 的评分开销不能漏计。
- 明确区分生成上下文与 judge 输入各自现有的处理边界，不用 judge 已脱敏暗示生成内容也得到同样保护。
- 用户确认绑定当前计划摘要；内容、模型或产品变化即失效。不提供无范围的永久同意，也不从任务文档推断真实运行授权。
- 非交互运行没有针对该计划的明确授权时拒绝发送，不能靠默认 yes 绕过确认。只读 prepare 不产生模型费用。
- 记录实际已报告 usage；拿不到价格、credits 或 usage 时记 unknown，不估算成精确账单。
- 取消、超时、provider 错误和外部结果 unknown 保留部分结果，不自动补跑、不盲目重放。下一次运行是重新授权的新批次，不假装恢复了原批次。

## C. 对照报告必须能区分退化与未解决

保留现有 original/candidate 的 `caught`、`still-failing`、`judge-blind`、`unknown` 合同；另外增加 baseline/candidate 比较，不改写旧字段含义。

在 original 能判为 fail，且对应两臂结果都确定时：

| baseline | candidate | 比较结果 |
|---|---|---|
| pass | fail | regression：新版退化 |
| fail | pass | improved：新版改进 |
| fail | fail | still-failing：问题仍在，不等于新版引入 |
| pass | pass | stable-pass：两版在该点均通过 |

original 为 pass 时标 judge-blind；任一 unknown、来源失效、判定版本不同或重复运行结论不一致时，比较为 inconclusive。缺行、行数多于确认的重复次数、非法判定值或判定提示词缺失时比较为 incomplete：运行没有做到计划承诺的事，不是「无法判断」。两种情况都显示各次原始结果；不得用多数投票、取最好一次或重跑直到通过掩盖不一致。

交付本地可读摘要和机器可读 JSON：每个点并列 original / baseline / candidate，显示上述结论、原因、运行记录引用及 usage。先列退化与仍失败，再列无法判断和改进。终端默认不打印私人原文。

退出状态：清单非空、覆盖完整且所有点均为 stable-pass 或 improved 才为 0；存在确定的 regression 或 still-failing 为 1；没有确定失败但存在 incomplete、unknown、judge-blind、失效或空集为 2。混合情形仍在 JSON 单列计数，不能让非零状态抹掉已完成结果，也不能让部分通过掩盖阻塞。

一次结果只是该模型、产品与回放点上的观察，不代表统计显著改善。

## D. 给失败会话建议回放点，但不代替用户标注

- 准备流程列出已标 fail／失败集却无有效回放点的会话，区分「没有点」与「旧点失效」。不会因为打了失败标签就自动跑模型。
- 优先复用已有人工原因、judge 事件引用及时间线证据，建议具体 assistant entryId、截断理由、期望行为和可用判定方式。
- 原因笼统、只有工具报错、缺图或实际体验无法从日志验证时，明确说明缺什么并询问用户，不生成一个看似精确的锚点。不将服务故障、用户主动取消自动归为 agent 失败。
- 若需要新模型分析，另行展示模型、将发送内容的范围与截断情况、调用上限并确认；没有授权就只保留待补证据清单。沿用同一失败／unknown 不自动重试的规则。
- 建议只写本地待确认记录（`replay/suggestions/` 草稿）；必须由 `add … --yes` 显式确认才调用现有保存接口，不改人工 verdict，不覆盖用户已有点；新点要重新 `prepare --force` 才进入集合。
- 尚未被证据支持的会话保持「列出缺什么」，不生成看似精确的锚点。正文与历史工具内容均是不可信数据，不是执行指令。

## 验收

### L1：合成数据、确定性检查

- 回归集：全部有效点纳入、稳定去重、失效及缺点清单、范围选择、空集、扫描不完整、列表候选上限外的定向查找、重复身份拒绝。
- 计划：模型／产品／来源变化使确认失效；调用数、字符数包含 original；prepare 未授权不发请求。
- 运行：baseline/candidate 加 original 复用同一执行管道；只生成下一条，真实工具执行为零，original 不调用生成器。
- 判定：四种比较、judge-blind、unknown、缺臂、重复分歧、取消后的部分结果及退出码；至少一个 baseline pass / candidate fail 的对照证明退化确实会被检出。
- 建议：证据明确时锚点正确；证据不足会询问；未确认不保存、未授权不调用模型；恶意历史文本不能触发外部动作。
- 存储：0700/0600、symlink／路径注入／Git worktree 拒绝。已有脱敏、工具拦截和 unknown 不重放测试不得弱化。
- 运行受影响单测及 eval typecheck，不把真实会话或真实模型回归接入默认 `npm run eval`、CI 或提交钩子。

### L2：真实 CLI + 真实产品 runtime + faux provider（仍用合成数据）

在临时目录、隔离的私有目录和合成会话上，用真实 `eval-regression` 命令跑完整「prepare → 计划 → run → 报告」，两臂都加载真实产品 runtime 与 faux provider。验证：集合文件 0600、目录 0700、报告落盘、两臂 + 原回复对照、工具调用确实被拦截（哨兵文件不存在）、干净运行退出 0 而仍失败退出 1。

同时验证发行包侧的边界：`evals/` 不进入发行包，安装态评测页执行「运行回放」返回 `replay_runner_unavailable`（503），不 spawn 子进程。不得为此把 `evals/` 加入 release manifest，也不覆盖用户当前安装。

### L3：后续用户单独授权

执行者本任务默认不读真实会话、不调用真实模型。真实小批回归由用户看过固定清单、两臂、模型、调用量与费用边界后另行授权；报告只写允许公开的合成证据和限制，不附私人用例、内容或标注统计。

## 不做与交付

不做全任务自动执行、训练、后台定时回归、云端同步、自动选择更便宜的模型、自动晋升 baseline，也不重做评测页；需要展示时复用现有回放面板。

- 只推 `eval/system`，不推 main、不 force push，不自动发布 npm 或更新用户安装。
- 仓库只交付代码、合成测试和文档。私有清单与结果留在 `~/.rotom/evals/`。
- 报告写清实际 CLI、清单格式、退出码、合成验证证据、成本边界及未验证项；按 [执行者自查清单](../executor-checklist.md) 自查。
- 完成实现后将 README 第 22 项改为 `in-review`；L3 未授权就明确未跑，不把 L1/L2 当真实回归验收。
