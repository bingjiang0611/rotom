# 13 · Eval 页修正与手动模型分析

状态：in-review。交付范围仅 `eval/system`，不推 main、不发布，也不替换现有安装或重启正在使用的后台。

## 实现

- Trace / Eval 控件文案集中为中文，保留模型、工具、规则等技术标识；401、409、模型目录不可用等错误给出中文说明。
- 活动状态与人工结论分开，显示终端 / 后台来源。进行中的会话可按当前进度标注，记录 `atEntryId` / `atEntryCount`；后续追加显示「标注后有新进展」。未知状态仍拒绝标注。
- 默认筛选未标注，显示筛选计数、已标注进度与结论颜色。列表分页只绑定成员和稳定排序；时间线发生变化时最多自动重载一次。只有 header 的新会话也能打开，标注锚点为 null / 0；CLI 原有跳过空会话的行为不变。
- 模型目录通过产品 launcher 获取并在后台进程内缓存，默认模型由 Pi 原生解析。分析前展示模型、发送字符数、截断与费用提示；确认令牌绑定该份摘要，只能使用一次，五分钟过期。取消确认不会启动分析。
- 摘要仅来自当前分支，不包含人工标注。保留全部事件序号、用户消息和工具 outcome，在 80,000 字符内缩短文本字段并明确标记截断；连最低事件信息都无法容纳时，确认前拒绝，不静默删除后续用户指令。
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

## 验证

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

## 真实数据只读检查

检查时，在既有最近 500 个候选文件 / 有界目录扫描内：169 个有效会话，全部可加载；进行中 3、暂时写入停止 166、未知 0。已标注 44（满意 40、不满意 4）、未标注 125、失败集 0、规则命中 67。此为受限窗口，不是全库统计。

独立 headless 页面打开列表及一个真实详情 / 时间线：0 page errors、0 页面外部请求。真实目录的 POST 被测试拦截；annotation POST 尝试 0、judge 请求 0。卡片、annotation 与 labels 的前后摘要一致。没有真实截图，没有代替 bob 标注。

**真实模型：未验证，实际推理调用 0 次。** 当前源码 launcher 的首个阻碍是已安装 Pi fork（`@earendil-works/pi-telemetry`）与新归档 identity 不一致；另有既有 computer-use `.0` / 要求 `.2` 差异。只读模型目录子进程已退出且确认无残留；没有绕过 gate。真实分析的模型、耗时、token、费用均为 unknown，不能用 fake 结果代替。

## 限制与后续验证

- 真实 launcher / provider 端到端验证须在匹配的新运行时安装后，另按授权通过页面确认；真实会话的首次分析留给 bob。本次不修改活跃安装。
- 模型目录及其失败是进程级缓存；更换安装或登录后需重启后台。仅环境变量配置的 API key 不转交，需使用子进程原生登录存储。
- 摘要保留事件编号，但正文可能被缩短；超过最低事件信息上限则拒绝。若需要分析这种超长分支，应单独设计可核对的分段复盘，不静默扩大预算或调用次数。
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
