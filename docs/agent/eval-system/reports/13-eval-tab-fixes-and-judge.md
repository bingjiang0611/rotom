# 13 · Eval 页修正与手动模型分析

状态：in-review。交付范围仅 `eval/system`，不推 main、不发布，也不替换现有安装或重启正在使用的后台。

## 实现

- Trace / Eval 控件文案集中为中文，保留模型、工具、规则等技术标识；401、409、模型目录不可用等错误给出中文说明。
- 活动状态与人工结论分开，显示终端 / 后台来源。进行中的会话可按当前进度标注，记录 `atEntryId` / `atEntryCount`；后续追加显示「标注后有新进展」。未知状态仍拒绝标注。
- 默认筛选未标注，显示筛选计数、已标注进度与结论颜色。列表分页只绑定成员和稳定排序；时间线发生变化时最多自动重载一次。只有 header 的新会话也能打开，标注锚点为 null / 0；CLI 原有跳过空会话的行为不变。
- 模型目录通过产品 launcher 获取，成功结果在后台进程内缓存；读取失败可手动重试，默认模型由 Pi 原生解析。分析前展示模型、发送字符数、截断与费用提示；确认令牌绑定该份摘要，只能使用一次，五分钟过期。取消确认不会启动分析。
- 摘要仅来自当前分支，不包含人工标注。按下方核验意见改为 `rotom-eval-judge/v2`：保留用户消息、助手文本、非 ok 工具及邻近事件、首尾事件；其余连续成功工具折叠为保留原序号范围与计数的 `tool_run`。只允许引用未折叠事件，折叠后最低信息仍超出 80,000 字符才拒绝。
- 分析使用绝对路径产品 launcher、同一 Node、argv 数组、stdin 与私有空 cwd。单个后台同一时间只有一个分析；180 秒超时，可取消，不自动重试。复用既有 process-tree 实现，结束前确认进程组退出；无法确认时禁止继续启动，保留 unknown 边界。
- 判断输出严格校验字段、枚举、长度、事件引用和 confidence。`ok / invalid_output / failed / timeout / cancelled` 分开保存；缺失费用为未知，Pi 费用仅标为估算，不冒充服务商账单。
- judgments 使用 0700 目录、0600 文件、原子且不覆盖的追加写入，拒绝 symlink。非法输出仅有界保留在私有文件，不进入列表 / 详情 API；不写原始会话、trace 或 annotation。
- 页面显示最新分析、历史数量、模型、耗时、usage、建议和证据。点击问题定位时间线；「采纳建议」只预填，仍须人工保存。CLI `agreement` 增加最新成功且非 unsure 判断与人工标注的 TP / FP / FN / TN，n < 10 标星。

主要模块：`rotom/extensions/observability/eval/`、`dashboard.mjs` / `dashboard-copy.mjs`、`rotom/evals/scripts/session-cards.mjs`。产品 files / requiredFiles、CI、CLAUDE.md 第 5 条及变更清单同步更新。

## 单次推理与兼容性

现有 CLI 的「无工具」不等于只发一次请求，因此新增 Pi `--single-request`：关闭 agent / provider 两层重试、自动压缩与缓存预热，并在首次响应后停止，不执行工具或自动续跑。内存 settings override 在 reload / 保存设置后仍有效，但不落盘。普通模式保持原默认行为。

产品 launcher 仍执行完整 identity 校验；该模式只加载声明中的 Qoder provider，不加载第三方生命周期扩展、Claude skill bridge 或 Herdr。认证仍由子进程原生登录存储处理；后台不读取、复制凭据文件，也不转交 API-key/token 环境变量。

`--mode json --list-models` 新增机器输出，普通文本列表不变。分析的 `--model` 必须精确匹配 `provider/model`，不存在时拒绝，不使用原 CLI 的模糊匹配或 custom-model fallback。旧 Pi 不具备 single-request capability 时拒绝启动分析。

已重建七个 fork 归档并同步 lock / 元数据；版本仍为 `1.4.0-rotom.2`，源码指纹 `7a82e20ad4f9b106d60448efa83b6e913c9d1b28b97718137d0ee574bdd61ec4`。这不是安装或发布。

## 初版验证（9994a44）

环境：Node 24.18.0；Playwright 使用本机 Chrome 的独立 headless profile。

| 检查 | 结果 | 证据 / 范围 |
| --- | --- | --- |
| dashboard / Eval / judge / process-tree / distribution | 71 passed | Node 测试；包含 auth / Host / Origin / JSON / body 限制、持续 append、锚点、私有持久化与路径拒绝 |
| fake launcher | 7 个 judge 测试通过 | 精确 argv、stdin、空 cwd、目录缓存、未确认不运行、并发拒绝、超时 / 取消 / 输出预算 / 非法 JSON、失败不重试、关闭后台结束进程、judge 不写 annotation |
| eval focused | 242 passed，7 files | `npm test -- session-cards trace-assertions agreement review session-metrics error-breakdown command-failures` |
| eval typecheck | PASS | `cd rotom/evals && npm run typecheck` |
| 公开树隐私审计 | PASS | 7,857 个 tracked files，0 findings；合成截图与本地输出不提交 |
| 公开历史审计 | 既有 BLOCKED | 独立 `eval/system` 单分支副本的 292 个基线提交中，`fc539150e67d` 有 2 项既有非 noreply author / committer 记录；不新增此类记录、不重写历史 |
| Pi fork | PASS | `cd rotom && npm run build:pi`：主体 419 passed / 2 skipped；追加 focused 226 passed；`npm run check:pi` 通过 |
| 合成 Playwright | PASS | 0 page errors、0 页面外部请求、1 次 fake inference；中文扫描与技术标识白名单通过 |
| eval 全量 | 330 passed / 10 failed / 1 skipped | 10 项失败仍由已安装 `@injaneity/pi-computer-use` identity/version 不匹配阻断：pi-harness 3、coding-hygiene-rule-ablation 3、product-runtime 2、tool-surface-ablation 2 |
| installed runtime gate | 7 passed / 33 failed | `verify-pi-runtime.test.mjs` 仍被同一已安装第三方版本差异阻断，未放宽校验或替换安装 |

关键回归检查不是仅比截图：确认前及取消确认后 fake inference 都为 0；确认后仅一次；进程 PID 在取消 / 超时 / 关闭后不可存活；分析后 annotation 不变，采纳也不写盘，只有人工保存才改变标注；新增 exact-model 检查拒绝模糊匹配与 custom fallback。文本为空的最终回复仍校验真实 stopReason，不能拿更早的成功回复补位。

Playwright 完整流程：中文界面 → 默认未标注 → 标注进行中的会话 → 追加内容及分页恢复 → 取消一次确认（无推理）→ 确认 fake 分析 → 结果 → 采纳预填 → 保存 → 刷新保留 → 点击问题跳转并高亮 → 手机宽度及 401 提示。所有页面数据均为合成。

截图保存在仓库外 `/tmp/rotom-task13-ui-hppfTQ/`：

- `eval-default-progress.png`
- `eval-judge-confirm.png`
- `eval-judge-result.png`
- `eval-judge-evidence.png`
- `eval-active-mobile.png`

机械设计检查只有一项 advisory：Trace 原有空状态网格背景；本次保留既有视觉风格，没有新增该背景。

## 初版真实数据只读检查（9994a44）

检查时，在既有最近 500 个候选文件 / 有界目录扫描内：169 个有效会话，全部可加载；进行中 3、暂时写入停止 166、未知 0。已标注 44（满意 40、不满意 4）、未标注 125、失败集 0、规则命中 67。此为受限窗口，不是全库统计。

独立 headless 页面打开列表及一个真实详情 / 时间线：0 page errors、0 页面外部请求。真实目录的 POST 被测试拦截；annotation POST 尝试 0、judge 请求 0。卡片、annotation 与 labels 的前后摘要一致。没有真实截图，没有代替 bob 标注。

**真实模型：未验证，实际推理调用 0 次。** 当前源码 launcher 的首个阻碍是已安装 Pi fork（`@earendil-works/pi-telemetry`）与新归档 identity 不一致；另有既有 computer-use `.0` / 要求 `.2` 差异。只读模型目录子进程已退出且确认无残留；没有绕过 gate。真实分析的模型、耗时、token、费用均为 unknown，不能用 fake 结果代替。

## 限制与后续验证

- 真实 launcher / provider 端到端验证须在匹配的新运行时安装后，另按授权通过页面确认；真实会话的首次分析留给 bob。本次不修改活跃安装。
- 模型目录仅缓存成功结果；失败可点击「重试读取模型」，不自动重试。更换安装或登录后，已有成功目录仍需重启后台刷新。仅环境变量配置的 API key 不转交，需使用子进程原生登录存储。
- 摘要保留原始编号或折叠范围，正文可能被缩短；仅在折叠后仍超过最低信息上限时拒绝。若需要分析这种超长分支，应单独设计可核对的分段复盘，不静默扩大预算或调用次数。
- judgment 是第二意见，不是真实验收；agreement 未按不同标注进度对齐，不能当作模型可靠性结论。
- 未重启之前打开的后台实例，未安装、未发布。CI 的实际提交 SHA 与 Actions 链接在交接消息中给出。

## 核验意见（规划者，2026-10-26）

结论：**changes-requested**（主体通过，有 1 个需要修的功能缺口和 3 个小问题）。

已核实：
- 拉取 `9994a44`。本地重跑 dashboard / eval / judge / process-tree 44/44、eval 定向 242/242、typecheck 通过；Actions run 40278147869 success（同一 SHA）。
- 用预装 Chromium 复跑合成 Playwright：PASS，0 页面错误、0 外部请求、1 次 fake 推理。看了截图：界面已中文化；活动状态与标注状态分开，并标出来源；「会话仍在进行，这次标注针对目前的进度」「标注后有新进展」都正确显示；分析结果、第一个问题、证据、采纳建议（仅预填）都正常。
- judge 调用路径：绝对路径 launcher、拒绝 symlink、argv 数组、私有空 cwd、子进程环境变量只用白名单（不转交 API key / token）、确认令牌一次性且 5 分钟过期、同一时间只跑一个、无法确认进程退出时禁止再启动、模型 id 精确匹配。prompt 明确把会话当作不可信引用，不含人工标注。
- `--single-request`：Pi fork 改动的理由成立（`--no-tools` 不能保证只发一次请求，provider / agent 重试会让一次点击产生多笔费用）。普通模式不受影响：`applyOverrides` 只有 single-request 和 `--theme` 两个调用方；`process-tree` 新增 stdin 后，原调用方（`check-providers.mjs`）等价于空 stdin。build:pi / check:pi 的结果以执行者报告为准，规划者容器没有重跑。

需要修改：
1. **长会话无法分析（功能缺口）**。`buildJudgeInput` 要求每个事件的头部（序号、类型、工具名、outcome）全部放进 80,000 字符，一个事件约 60–100 字符，超过约 1,000 个事件就直接 413。bob 最想复盘的正是长会话（p90 工具调用 627 次，最长的超过 700 次，加上消息远超 1,000 个事件），现在恰好全部分析不了。请改成**折叠连续成功的工具调用**：保留全部 user 消息、assistant 文本、所有非 ok 的工具事件及其前后各 2 个事件、开头和结尾各 20 个事件；其余连续的 ok 工具事件合并成一行 `{ "events": "a-b", "kind": "tool_run", "count": n, "tools": { "read": 12, "bash": 3 } }`。事件序号保持不变；evidence 和 firstProblem 只能引用未被折叠的事件（校验同步更新）；prompt 说明折叠规则。只有折叠后仍然放不下时才 413。报告里写出：在 bob 的真实会话窗口里，用 `buildJudgeInput` **本地**（不调模型）算一遍，修改前和修改后分别有多少会话会被拒绝（只报计数）。
2. **模型列表失败会永久缓存**：`models()` 失败后，被拒绝的 promise 一直留在缓存里，只能重启后台。失败不要缓存；页面上给一个「重试读取模型」。
3. **筛选里混进不符合条件的行**：在「未标注」筛选下，当前打开的已标注会话仍留在列表顶部（合成截图里第一行是「标注状态：满意」）。bob 上次就是因为分不清才提的反馈。要么移出列表，要么明确标成「当前打开（不在此筛选中）」。
4. `eval-ui-smoke.mjs` 写死了 `channel: "chrome"`，没装 Chrome 的机器跑不了（任务 12 的核验里提过）。改成可选的环境变量，默认用 Playwright 自带的 Chromium。

给 bob 的试用说明（不在本任务改动范围，记在这里备查）：这次重建了 Pi fork 归档，旧的 `runtime/pi/node_modules` 会被 identity gate 拒绝。试用时不要在正在跑会话的 checkout 里重装（CLAUDE.md：不要覆盖存活会话使用的安装），应另开 `git worktree`，按 `docs/agent/architecture.md` 的源码维护安装步骤装 runtime 和 third-party。

## 核验意见修正与复验

本轮从 `d8ff3261a86a7c94bd1f28899fa763447395724c` 开始，只修正上述四项。未修改 Pi fork、产品安装、trace 合同或正在使用的后台；**真实模型调用 0 次**。

### 四项修正

1. **长会话折叠**：保留全部 user 消息与 assistant 文本、所有非 ok 工具（包括 unknown）及前后各 2 个事件、首尾各 20 个事件。其余连续 ok 工具按原序号合并为 `{events:"a-b",kind:"tool_run",count:n,tools:{...}}`，不跨保留事件合并。prompt 升为 v2 并说明规则；`eventIds` 只包含未折叠事件，所以 firstProblem / evidence 引用折叠范围会被拒绝。仍保持 80,000 字符上限，不扩大预算。
2. **目录读取重试**：服务端和页面都清除失败的 promise，仅缓存成功结果；新增「重试读取模型」。失败不会后台自动重试，手动重试不启动推理；无法确认进程退出时仍禁止再启动目录读取。
3. **筛选一致性**：选择「移出列表」，不把当前详情钉在筛选结果中。前后端复用同一个筛选谓词；切换 / 重载时立即清除旧列表，详情取得新标注后也重新过滤，避免请求在途时显示旧的不匹配行。右侧已打开详情可继续查看。
4. **浏览器选择**：smoke 默认 `chromium.launch({headless:true})`；只有设置 `PLAYWRIGHT_CHANNEL` 才传入 channel。默认随 Playwright 安装的 Chromium 与 `PLAYWRIGHT_CHANNEL=chrome` 两条路径都已实跑。

### 真实会话：只在本机内存中比较

使用同一个现有目录扫描窗口（最多最近 500 个候选文件、50,000 个目录条目），每个会话只加载一份当前分支数据。分别调用基线提交中的原始 `buildJudgeInput` 和修改后的函数，仅将 `judge_input_too_large` / 413 记为预算拒绝。没有启动模型 launcher，没有生成判断或改写标注；不输出或保存会话正文、参数、路径和 ID。统计脚本与计数结果留在仓库外的私有临时目录。

| 项目 | 数量 |
| --- | ---: |
| 窗口内有效会话 / 实际比较 | 168 / 168 |
| 修改前拒绝 | 20 |
| 修改后拒绝 | 6 |
| 仅修改前拒绝 | 14 |
| 修改前后都拒绝 | 6 |
| 新增拒绝 | 0 |
| 读取失败 / 非预期异常 | 0 / 0 |
| 真实模型调用 | 0 |

这是有界窗口的实测，不是全库统计。剩余 6 个会话在保留规定内容并折叠后仍超限，继续明确拒绝。

### 本轮验证

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| Node focused / distribution | 73 passed | `node --test --test-concurrency=1`，dashboard、eval、judge、process-tree、distribution 五个测试文件 |
| judge 回归 | 9 passed | 1,300 次工具调用的合成历史；编号完整覆盖、用户 / 助手文本、unknown / 错误邻域、首尾保护、工具计数、折叠引用拒绝、折叠后仍超限拒绝；目录失败后恢复及成功缓存 |
| eval focused | 242 passed / 7 files | `npm test -- session-cards trace-assertions agreement review session-metrics error-breakdown command-failures` |
| typecheck | PASS | `cd rotom/evals && npm run typecheck` |
| Playwright 默认 Chromium | PASS | 0 page errors、0 页面外部请求、1 次 fake inference |
| Playwright Chrome override | PASS | 同上；两次运行都只使用合成数据与 fake launcher |
| 机械设计检查 | PASS | 本轮改动的 UI / copy 无 findings |

新增 UI 检查：目录连续两次失败，分别手动点击重试后恢复；确认前始终 0 次 fake inference；成功目录跨详情切换仍缓存。暂停「未标注」响应时断言旧列表立即为空，返回后每行都未标注；保存当前会话后断言其移出未标注列表。保留原完整流程及截图检查。

本机一次并行 Node 检查为 72 / 73，唯一失败是 CLI 的 5 秒就绪等待；该测试单独重跑通过，之后串行完整 73 项通过。eval 242 项通过后，同一工具调用的 180 秒总时限中断了 typecheck，确认进程结束后单独执行通过。当时独立 Node 空进程启动实测 2,795 ms、系统 swap 使用约 17,969 MiB；这是环境压力证据，不断言所有延迟原因。合成 judge 的测试专用超时由 1 秒改为 5 秒，并加强取消 / 关闭前的进程就绪断言；**产品 180 秒期限、CLI 就绪断言及失败 / 取消 / 无重试断言均未放宽**。

本轮合成截图：`/tmp/rotom-task13-review-YYqtoP/screenshots/`，包括 `eval-model-retry.png`、`eval-default-progress.png` 及原完整流程四张截图。真实会话没有截图。本地比较脚本、仅计数 JSON 与验证日志在同一私有临时目录；临时测试浏览器在验证后删除，不影响本机 Chrome 或产品安装。

## 复核（规划者，2026-10-26）

结论：**accepted**。

- 拉取 `29a61f8`。本地重跑 dashboard / eval / judge / process-tree 46/46、eval 定向 242/242；Actions run 40285889828 success。
- 合成 Playwright 现在不传 channel 也能直接跑（规划者容器用的是 Playwright 自带的 Chromium）：PASS，新增了「重试读取模型」的截图。
- 折叠逻辑读过：保留所有 user / assistant 事件、非 ok 工具及前后各 2 个事件、首尾各 20 个事件；连续 ok 工具只在两个保留事件之间合并，序号连续不丢；`eventIds` 只含未折叠事件，引用折叠范围会被校验拒绝；prompt 升到 v2。模型列表失败后清掉缓存；列表筛选的修正有 UI 断言覆盖。
- 真实会话的本地对比（不调模型）：168 个会话里，修改前拒绝 20 个，修改后 6 个，没有新增拒绝。剩下的 6 个在保留规定内容后仍超过 80,000 字符，会被明确拒绝。以后如果 bob 需要复盘这类会话，再单独设计分段复盘，不在这里放宽预算。

仍未验证：真实模型调用（L3）。需要在单独的 worktree 里按锁文件安装新 runtime 后，由 bob 在页面上点第一次。

## bob 试用反馈与第二次核验意见（规划者，2026-10-26）

bob 在 worktree 里试用：页面显示「模型列表暂不可用」，点「重试读取模型」也一样，所以「让模型分析」一直是灰的。

**规划者已复现并定位根因**（Node 24.11、按锁文件新装的 worktree、隔离的空 HOME，不涉及凭据和模型调用）：

```
rotom/bin/rotom-launcher --single-request -p --mode json --no-session --no-tools --no-extensions --no-mcp --list-models 2>/dev/null | wc -c
0
```

`--mode json` 会触发 `takeOverStdout()`，把 `console.log` 改写到 stderr；而 `listModels()` 的 JSON 输出用的是 `console.log`，所以 JSON 全部进了 **stderr**，stdout 是空的。后台只解析 stdout，因此必然报 `models_unavailable`。fake launcher 直接把 JSON 写到 stdout，所以测试没能发现。合并 stdout 和 stderr 看时一切正常，这也是这个 bug 容易被看漏的原因。

结论：**changes-requested**。

1. **修根因**：`listModels` 的 json 分支改用 `output-guard.ts` 的 `writeRawStdout`（或等价方式），保证 JSON 只写到真正的 stdout，stderr 不混入。在 Pi fork 里补一个测试：在 stdout takeover 生效的前提下调用 json 模式的 list-models，断言 stdout 是一行合法 JSON、stderr 里没有它。改完按流程 `build:pi` / `check:pi` 并同步归档与 lock。
2. **补真实路径检查（不调模型）**：新增一个可复跑的脚本（例如 `observability/eval-launcher-check.mjs`），用**真实的** launcher（不是 fake）跑后台用的同一条 `--list-models` 命令，复用后台的校验函数，输出：退出码、stdout 字节数、是否通过校验、模型数、默认模型是否在列表里。报告附运行结果。fake launcher 的测试保留，但要另加一个用例，模拟「JSON 写在 stderr、stdout 为空」的情况，断言页面给出明确的诊断，而不是笼统的「暂不可用」。
3. **页面给出诊断原因**：模型列表失败时，按类别显示原因：launcher 不可执行、运行时校验失败（identity gate）、超时、退出码非 0、stdout 为空、JSON 不合法、模型 id 重复、默认模型不在列表中。再附一句可复制的排查命令（就是上面那条，不带 `2>/dev/null`）。stderr 原文可能含本机路径，**只在后台进程日志里打印，不进 API 响应**。
4. **检查推理路径有没有同类问题**：`-p --mode json` 的事件流是否确实写到真正的 stdout。用 Pi 自带的 faux provider（`packages/ai/src/providers/faux.ts`）或其它离线方式，经真实 launcher 跑一次 `--single-request`，确认 `parseJudgeEvents` 能从 stdout 解析出 `message_end` 和 `agent_end`。做不到完全离线时，说明原因，不要调用真实付费模型。

给 bob：本轮修好之后，worktree 里需要重新 `git pull` 并重装 `rotom/runtime/pi`（归档会变），然后重启后台。

## 第二次核验修正与复验（执行者）

上述四条已逐条修正；前面的核验意见保留。以下结果针对本轮新归档，不沿用前两轮验证。

### 修改

1. **stdout 根因**：Pi `list-models.ts` 的所有 JSON 路径统一使用 `writeRawStdout`，并在返回前 `flushRawStdout`，避免 `main` 立即退出丢写。空列表返回合法 JSON；过滤掉默认模型时返回 `null`。新增 takeover 开/关两种测试，断言 stdout 只有一行合法 JSON、诊断只在 stderr。已重建七个归档，同步 lock、fork-build 与产品摘要；版本保持 `1.4.0-rotom.2`，source SHA-256 为 `2d41890137654594966602eeeee021d1a3714fc78adbf0ca97490c59660b5924`。
2. **真实路径脚本**：新增 `rotom/extensions/observability/eval-launcher-check.mjs`，真实 launcher、同 Node、同 `JUDGE_BASE_ARGS`、argv 数组、stdin、空 cwd，复用后台 `parseModelCatalog` / `parseJudgeEvents`。默认隔离 HOME 并拦截 Node 网络；`--faux` 仅注册 Pi 自带的离线 provider。脚本处理 `/tmp` 等 canonical 路径差异，防止直接入口判断跳过执行。CI 新增运行时安装、`check:pi` 和真实离线检查，fork/runtime/launcher 变化也触发此工作流。
3. **明确诊断**：后台保留分类错误码；页面分别说明执行权限、identity gate、超时、异常退出、空 stdout、非法 JSON、非法目录结构、重复 id、默认模型缺失。launcher 为 identity/capability 校验失败输出稳定 `[runtime_validation_failed]` 标记，不放宽 gate。stderr 原文只写后台进程日志，不进入 API/trace/judgment；不合并 stdout 与 stderr。页面给出与后台 argv 一致的可复制命令；空目录提示配置/登录。fake 测试保留，并补 stderr-only 场景、分类边界与 API 不泄漏原文的断言。
4. **推理事件流**：真实 launcher 经单次模式加载原生 faux，`parseJudgeEvents` 成功解析合法结果；扩展主动打印的诊断只在 stderr，事件流保持纯 JSON stdout。未改推理路径来适配假结果，未调用任何付费模型。

### 真实 launcher 证据

在独立公开 clone 按当前 lock 新装 Pi 和第三方依赖；不覆盖正在运行的维护/试用安装。Node `24.18.0`，macOS。

可复跑命令：

```bash
node rotom/extensions/observability/eval-launcher-check.mjs --faux
```

| 检查 | 结果 | 证据 |
|---|---|---|
| 后台原样 list-models argv，隔离空 HOME | exit 0，stdout 34 bytes，校验通过 | 0 个模型、无默认模型（`defaultInList: null`）；无凭据时不是协议失败 |
| 真实 launcher + 原生 faux 目录 | exit 0，stdout 167 bytes，校验通过 | 1 个模型，默认模型在列表中 |
| 真实 launcher + faux 单次推理 | exit 0，stdout 11,985 bytes，`parseJudgeEvents.status=ok` | assistant `message_end=1`、`agent_end=1`、faux 调用 1 次；诊断在 stderr、不在 stdout |
| 完全离线保护 | 网络尝试 0 | fetch/http/https/net/tls 连接被测试预加载器禁止；临时 HOME/cwd/provider 数据已清理 |
| 原试用版负对照（只读 list-models） | exit 0，stdout 0 bytes，校验失败 | 正确归类 `models_stdout_empty`，复现 bob 故障；没有修改该安装 |
| 陈旧维护安装负对照（只读 list-models） | exit 1，stdout 0 bytes，校验失败 | 正确归类 `models_identity_failed`，没有绕过 gate |
| 已配置模型目录，只读真实 launcher | exit 0，stdout 7,244 bytes，校验通过 | 54 个模型，默认模型在列表中；仅原生子进程处理登录，后台不读取凭据；本次验收只报告数量与默认命中状态，不输出模型名称或会话内容，不进行推理 |

付费模型调用 **0**；真实会话分析请求 **0**；人工标注请求 **0**。faux 是离线合成实现，不宣称付费 provider 的端到端分析已验证。

### 回归与边界

| 检查 | 结果 | 范围 |
|---|---|---|
| `npm --prefix rotom run build:pi` / `check:pi` | 通过 | 构建期既有主要组 419 passed / 2 skipped；含本次 list-models 的 focused 组 227 passed，其他构建组亦通过 |
| `node --test --test-concurrency=1 …` | 76 passed | dashboard / Eval API / judge / process-tree / distribution |
| `node --test rotom/scripts/build-pi-fork.test.mjs` | 2 passed | 构建器合同 |
| 独立已安装 clone 的 `verify-pi-runtime.test.mjs` | 40 passed | 运行时 identity、资源、cwd/argv、启动合同 |
| eval 七文件测试与 `npm run typecheck` | 242 passed；类型检查通过 | session-cards / trace-assertions / agreement / review / session-metrics / error-breakdown / command-failures |
| Playwright 合成 UI，显式 Chrome channel | 通过 | stderr-only 错误提示、可复制命令、失败手动重试、完整确认/结果/标注流程；0 页面错误、0 页面外部请求、1 次 fake 推理 |
| Impeccable 定向检测 | `[]` | 本次 UI/copy 文件；截图另经目视检查 |

合成截图保留在 `/tmp/rotom-task13-second-M2A25b/screenshots/`，包括 `eval-model-stdout-diagnostic.png`，没有真实会话截图。安装报告 Pi 依赖 2 项既有漏洞（1 moderate、1 high），未借机升级依赖。产品实际模型调用仍必须由页面逐次确认，本轮只读模型目录不等于付费推理验收。

最终 diff 已检查；准备上传的公开树审计 **7,858 文件、0 发现**（包含新增检查脚本）。历史审计仍有公开基线 `fc539150e67d` 的 2 个既有 author/committer 非 noreply 发现，未新增、未改写历史。CI 结果与精确 SHA 在交付消息中提供。原试用 worktree 仍运行旧版：bob 需先停止该试用后台，再更新源码、按新 lock 重装其 Pi 运行时并重启；不要重装活跃的日常运行时。

## 第二次复核（规划者，2026-10-26）

结论：**accepted**。

- 在规划者自己复现问题的那套环境里（Node 24.11、按锁文件新装的 worktree、空 HOME）更新到 `65ab1e5` 并重装 `rotom/runtime/pi`：原来的复现命令 `... --list-models 2>/dev/null | wc -c` 从 0 变成 31,616 字节；`eval-launcher-check.mjs --faux` 输出 `passed: true`，诊断信息没有混进 stdout，阻断的网络请求 0 次。
- dashboard / eval / judge / process-tree 49/49 通过。
- Actions run 40299301713 success，而且 CI 现在会跑 `check:pi`、按锁文件安装产品 runtime、用**真实 launcher** 读取模型列表并跑一次离线 faux 推理。fake launcher 测不到的这类问题，以后在 CI 里就能发现。
- `listModels` 的 json 分支改为 `writeRawStdout` + flush；默认模型不在可用列表里时输出 null，避免触发后台的校验失败。失败时页面按类别显示原因，stderr 原文只进后台日志。

仍未验证：在 bob 的真实账号上做一次真实模型分析（L3），由 bob 在页面上点。
