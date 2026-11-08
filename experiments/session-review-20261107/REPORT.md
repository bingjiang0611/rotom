# rotom 近 7 天会话复盘：结论与改进方案（云端 agent）

数据来源：本地 agent 两轮产出，包括 `results/findings.md`、`metrics.json`、`round2.md` 和 `stop-context.json`。窗口为 2026-10-31 至 2026-11-07，共 183 个会话，其中 10 个是子 agent 会话。云端 agent 只看得到聚合数据和本地 agent 写的转述，看不到会话原文。

## 1. 第二轮核验

- `stop-context.json` 与 `round2.md` 的数字一致：554 次交还控制权；`bare_continue` 74 次，其前一条的 stopReason 为 error 34、aborted 22、stop 13、toolUse 5；`bare_approve` 9 次；中断 38 次。
- 脚本修正 `adbe9bf`（排除 `--now` 之后的条目）合理。
- 第一轮的 A 节修正已落到 findings.md。维护者确认 Jev 和 radius 都可以公开。
- 隐私审计 PASS。
- **两处需要修正的解读：**
  1. **第一轮“477 次 assistant error”把被重试掉的失败尝试也算进去了。** Pi 重试前会把失败的尝试保留在会话原始历史里，只是不再送给模型（`agent-session.ts` 中的 `_omitRecoveryAttempt`）。真正把控制权交还给用户、以 error 结束的只有 57 次（`stop-context.json` 中各类用户消息前一条 stopReason=error 的合计）。provider 的“用户可见失败”应该以 57 为准，477 是含重试的尝试数。
  2. **把“aborted 后回‘继续’”的 22 个样本也归为 E4（本应自动恢复）缺少依据。** 如果 aborted 是用户自己按停的，agent 本来就不应该自动续跑。aborted 可能有几个来源：用户 Esc、扩展调用 `ctx.abort()`、手动或扩展触发的 compaction（`_runRequestedCompaction` 会先 abort 当前操作，且不重试）、进程退出时 dispose。需要区分来源，见 `TASK-3.md`。在拿到结果前，只把 error 后的 34 个算作确定的“停太早”。

## 1b. 第三轮核验（`8554cfe`）

- `stop-context.json` 与 `round3.md` 一致。
  - 57 个 error 停点中，有 25 个连续失败 ≥4 次，说明 3 次重试已经耗尽；有 30 个只出现 1 次 error 就停了。
  - 34 个“error 后回‘继续’”的停点中，有 12 个是重试耗尽，22 个是单次即停。
  - aborted 的正文只有两个模板，`Request was aborted` 和 `Qoder: aborted`，都不带中断来源。
  - 17 个 aborted 样本中，有 1 个是用户插话、5 个是跨进程恢复、11 个来源不明，没有一个与 compaction 或扩展相关。
- 本地 agent 对 P1 范围的四条结论我全部采纳：只覆盖明确可重试且预算已耗尽的 error；不覆盖 aborted；不覆盖不可重试的 error；toolUse 停点不纳入，先只读核验。
- **新发现（代码核对）**：单次即停里最常见的“目录刷新失败”是 `Qoder: catalog_refresh_failed`。
  - Qoder 目录的 TTL 是 1 小时（`rotom/extensions/qoder/catalog.mjs` 中的 `CATALOG_TTL_MS`）。目录过期后，下一次请求（包括工具续接）都会先阻塞刷新目录（`provider.mjs` 的 `prepare`，30 秒上限）。
  - 刷新失败时，`session-policy.mjs` 中的 `refreshRegistry` 有意抛出一个稳定且**不可重试**的错误，测试 `catalog-refresh.test.mjs` 也断言“不重试”。
  - 这个错误发生时推理请求还没有发出，没有计费或重复执行的风险，正是最安全的重试场景。按现在的设计，长任务每运行满一小时，就可能因一次网络抖动直接结束。
  - 具体次数还没有确认，见 `TASK-4.md`。

## 1c. 第四轮核验（`bd5b28e`）

- 表格逐列核对无误：合计 57 个停点，其中连续=1 的 30 个、连续≥4 的 25 个、下一条消息是“继续”的 34 个。用户的 `retry` 未设置，用默认值。
- **P0 的次数已确认**：`catalog_refresh_failed` 共 9 次，其中 8 次是第一次失败就停，8 次之后用户回了“继续”；trace 显示 6 次发生在运行不足 1 小时的 operation 里。因为目录 TTL 是跨 operation 计算的，短运行和恢复后的运行也会碰到。
- **新发现**：Qoder 的 `stream_failed`（8 次）和 `request_failed`（5 次）也都是单次即停，之后有 12 次用户回了“继续”。代码里这是**有意的计费保护**：请求体可能已经发出、被计费，所以不重试（`transport.mjs` 中 `request_failed` 处的注释）。这比 Pi 的通用策略更严。Pi 对“发出后才断开”的错误（例如 Codex 的 `fetch failed`、流中断）给的是有界重试预算。但现实是：用户手动回“继续”同样会再发一次请求、再计费一次。不重试并没有省钱，只是把重发这一步交给了用户。
- 其余单次即停的错误都不该自动续跑：`radius` 鉴权 4 次是用户环境问题；`Bad Request` 2 次；`invalid_choices` 2 次是协议异常；`invalid_tool_arguments` 1 次。

## 2. 核心结论

维护者的头号抱怨是“停得不对”。数据给出的主要原因是 **provider 失败把普通运行直接终结了**，而不是模型主动停下来问。

- 74 个 `bare_continue` 中，只有 13 个前一条是正常 stop；34 个是 error 结束。
- Pi 默认 `retry.maxRetries: 3`、`baseDelayMs: 2000`（`packages/rotom-pi/packages/coding-agent/src/core/settings-defaults.ts`），退避 2s/4s/8s，大约 14 秒就会耗尽。一次 30 秒的抖动或一个 60 秒的 429 限流窗口，就足以结束一次长时间运行。
- 连接阶段失败（请求肯定没发出）已经会无限重连。但 `fetch failed`、限流、过载、流中断都走这 3 次预算。
- Goal 模式在预算耗尽后有 5/15/30 分钟的持久等待和自动续跑；普通运行没有。本周 Goal 使用量为 0，所以这套恢复机制一次都没有生效。
- 模型主动停下来问的情况很少：`bare_approve` 9 次里有 7 次问得合理；正常 stop 后的 `bare_continue` 13 次，抽样中 E2 占 2 个。coding-policy 现有的“继续做完”规则基本有效，不是主要矛盾。

## 3. 改进方案（按收益和证据强度排序）

### P0. Qoder 目录刷新失败不再直接终结运行【证据强（机制已在代码确认，次数待 TASK-4），改动小】

- **问题**：`catalog_refresh_failed` 发生在推理请求发出之前，却被标成了不可重试。目录每小时过期一次，过期后第一次请求遇到一次网络抖动，整个运行就结束了。
- **方案**（二选一，需要维护者决定，因为这是有意设计的合同）：
  1. **把它标为可重试**：让 `Qoder: catalog_refresh_failed` 进入 Pi 的有界重试（`packages/rotom-pi/packages/ai/src/utils/retry.ts` 的 retryable 列表，或在 provider 侧把它映射成一个已在列表里的形态）。目录刷新会随重试一起再做一次。错误正文仍然保持稳定、不泄露上游信息。需要把测试改成“不发推理，按预算重试，耗尽后报同一个错误”。
  2. **过期后先沿用旧目录**：同一账号指纹下，过期目录在一个短宽限期（例如 15 分钟）内继续用于推理，同时后台刷新。这更符合 CLAUDE.md 写的“过期后台刷新”，但会放宽“过期即阻断”的现有合同。账号不一致时仍然一律阻断。
- **推荐**：选方案 1。改动最小，不改变“目录过期不使用”的语义，并且和 P1 自然叠加。
- **本周收益**：9 次直接终结可以变成有界重试，其中 8 次用户已经手动回了“继续”。数据不能证明重试一定成功。

### P0b. Qoder `stream_failed` / `request_failed` 是否进入有界重试【证据强，需维护者决定计费策略】

- **问题**：本周 13 次单次即停，其中 12 次用户手动回了“继续”。
- **取舍**：
  - 现在：失败一次就停，由用户决定是否重发，最多被重复计费一次，但需要人工介入。
  - 改成有界重试：遵循 Pi 的通用策略，最多 3 次，所以最坏情况会多计费 3 次。但用户手动回“继续”本身就是一次重发。
- **折中**：只在“还没有收到任何可见内容或工具调用”时才重试（例如响应头之前就失败的 `request_failed`，或者首个内容帧之前就失败的 `stream_failed`）。一旦已经流出了内容，仍然不重试。credits 照常记录，unknown 仍然记为 unknown。

### P1. 普通运行在重试预算耗尽后有界自动续跑【证据强】

- **问题**：可重试的 provider 错误在约 14 秒内耗尽预算，长任务直接结束，用户只能手动回“继续”。第三轮确认，本周 57 个 error 停点中有 25 个属于这种情况（连续失败 ≥4 次），其中 12 个之后用户只回了“继续”。单次即停的 30 个不在 P1 范围内，由 P0 和 TASK-4 处理。
- **方案**：把 Goal 已经实现、也已经验证过的“耗尽后持久等待 → 提交一次全新续跑”的机制下沉，让普通运行也能用。默认开启，阶梯建议 1/5/15 分钟，最多 3 次，可通过设置关闭；`retry.enabled:false` 时不启用。保持现有边界不变：
  - 只对“可重试且已耗尽”的错误生效；400、鉴权、上下文溢出、非重试类限额不续跑；
  - 用户输入或 Esc 立即取消等待；
  - 续跑提交的是一条新的 continuation 提示，不重放工具调用；如果最后一次工具结果是 unknown 写入，就不续跑，交还给用户；
  - TUI 显示“Waiting to resume (n/3)…”，并在会话中写一条 custom 状态，保证恢复和 fork 后状态一致。
- **代码位置**：`agent-session.ts` 的 `_prepareRetry` 和运行结束处理；参照 `packages/rotom-goal/src/runtime.ts` 里 `provider_retry_exhausted` 的等待阶梯。也可以把这套逻辑从 Goal 抽成共享 helper。
- **风险**：可能被已计费的请求重复计费，但这和用户手动回“继续”的代价相同。改动涉及 Pi fork，需要 `build:pi`，并补 L1 测试：耗尽→等待→续跑；用户打断；unknown 写入时不续跑；restore 后行为。
- **备选（更小的改动）**：只对带 `Retry-After` 的 429 和过载错误把预算放宽到服务端建议的时间。改动小，但覆盖不到 `fetch failed` 和流中断。

### P2. Computer Use helper 版本不匹配：首次即失败，而且没有出路【证据强，改动小】

- **问题**：14 次 `find_roots` 失败中，13 次是 `helper mismatch … The running helper was not restarted`，分布在 12 个会话里，每个会话的第一次调用就失败，之后从未成功；2 个会话还重复调用了同一个失败的请求。按设计，存活 helper 不能自动覆盖（CLAUDE.md §4），所以“失败”本身是对的。问题在于：旧 daemon 在升级后一直残留，没有人提示用户。
- **方案**：
  1. 会话启动时做一次只读 preflight。发现不匹配，就在 TUI 提示一次，并给出明确的修复步骤：确认没有存活会话占用 helper 后，用显式命令重启它。
  2. 同一会话内如果 helper 状态没变化（同一协议和可执行文件），不匹配错误直接返回缓存结果，避免模型重复调用。
  3. 错误文本里加上“本会话内 Computer Use 不可用，请改用 Browser 或请用户处理”，让模型马上换路。
- **代码位置**：`packages/rotom-computer-use/src/constants/copy.ts`、`bridge.ts` 的连接与 preflight 路径。

### P3. `subagent_wait` 超时后给出可判断的进度，不鼓励盲等【证据中】

- **问题**：100 次调用里有 65 次传了 30 分钟；17 次超时时子 agent 都还在运行；超时后有 8 次又原样再等。现在的超时文案本身就写着“call subagent_wait again or inspect status”（`packages/rotom-subagents/src/runs/background/subagent-wait.ts`）。
- **方案**：超时结果里附上每个子任务最近一次活动距今多久、本轮工具调用数和错误数、是否在等 supervisor 回复，并给出建议：长时间没有活动就先 status 或中止，有进展再等。同时在工具描述里建议单次等待 ≤10 分钟，期间穿插主会话自己的独立工作。
- **注意**：不要自动取消子任务，这属于用户或主 agent 的决定。

### P4. 长运行中途汇报进度（不是停下）【证据中，偏提示词】

- **问题**：中断样本里有 4/10 属于 L4：单轮 113–325 次工具调用、7–15 次错误，用户看不到进展只能打断。全量 38 次中断里，5 次单轮超过 100 次调用。
- **方案**：在 coding-policy 加一条，单轮工具调用超过约 60 次或连续错误时，输出一段简短的进度说明（做了什么、剩什么、是否换路），然后**继续执行**。不要做成运行时强制停顿，否则会制造更多“停太早”。
- **验证**：只能靠真实会话前后对比。没有 L3 证据前，不要声称它降低了中断率。

### P5. 观测口径修正【小、确定】

- `model_change` 921 条里有 584 条和前一条完全相同。真正在会话中切换模型的约 60 次。值得查清是哪条路径在重复写同样的模型（`agent-session.ts` 第 2602、2669、2704 行，以及 `sdk.ts:448`），对同模型做去重。这同时减少会话文件噪声。属于 Pi 的会话格式行为，改之前先确认没有扩展依赖“每轮一条”。
- 复盘脚本和 dashboard 统计 provider 错误时，应区分“被重试吸收的尝试”和“终结运行的失败”。

### 暂不建议做的

- **大改 coding-policy 的停点规则**：E1 和 E2 证据只有 4 个样本，现有规则基本有效。最多补一句：“说了会继续，就必须在同一回合继续调用工具”（对应 round2 的模板 3）。
- **Context Layers / Compaction 的改动**：没有看到压缩后“忘事”的证据，现有数据也无法单独归因 token 收益。

## 4. 还缺什么

- 第三轮已经回答了 P1 的范围问题，结论见 §1b。
- 第四轮已经回答了错误码问题，结论见 §1c。复盘到此结束，下一步等维护者决定 P0 用哪个方案，以及 P0b 是否放开。

## 5. 实现状态（2026-11-07）

维护者决定：P0 选方案 1；P0b 选折中方案（只在没有任何可见输出时重试）。

| 项 | 状态 | 改动 | 已跑的验证 |
|---|---|---|---|
| P0 | 已实现，随产品生效 | Pi `retry.ts` 把 `Qoder: catalog_refresh_failed` 列为可重试；provider 内仍然不重试；同一错误码的 UI 提示在 2 分钟内只显示一次 | Pi `build:pi`（各包 focused 回归全通过）、`check:pi`；Qoder 270/270；`retry.test.ts` 新增正反例 |
| P0b | 已实现，随产品生效 | `translate.mjs` 和 `provider.mjs`：没有任何文本、reasoning 或 tool call 时，`request_failed` / `stream_failed` 改为 `*_before_output`，Pi 列为可重试；已经流出内容的失败保持原码、不重试；diagnostics 仍归类为 `transport_failure` / `network` | 同上；另有 translate 单测覆盖“只有 usage”“已有文本”“已有 reasoning”“已有工具调用”“aborted”五种情况 |
| P2 | 源码已改；**尚未进入产品**（需要按维护流程重打 vendor 归档） | helper 不匹配时，有 UI 的会话问一次是否重启；用户确认后才重启并复检；拒绝或没有 UI 时本会话不再询问，同时告诉模型“本会话内不可用，改用 Browser 或向用户报告” | `helper-protocol.test.ts` 7/7；Computer Use 套件 74/76，唯一失败 `cu-v2-tools.test.ts` 在改动前同样失败。**没有在真实 Mac 上验证** |
| P3 | 源码已改；**尚未进入产品**（同 P2） | `subagent_wait` 超时结果附上每个子任务最近一次活动距今多久、工具调用数、轮数和当前工具；10 分钟没有活动时建议先查 status、不要原样长等，否则建议做其他事或用 ≤10 分钟的等待 | `wait.test.mjs` 21/21（新增 2 条） |
| P1 | 维护者决定不做 | — | — |
| P4 | 已实现，随产品生效（只改提示词） | `FOLLOW_THROUGH_POLICY` 新增一条：长运行中大约每 50 次工具调用、或连续 3 次工具失败后，在**下一次工具调用的同一条回复里**写一段进度说明（做完了什么、还剩什么、是否换路），然后继续执行；进度说明不是停点 | coding-policy 10/10（去掉这条规则后对应测试失败）；评测里解析该常量的单测 9/9。效果尚未测量，下周用 `stop-context.mjs` 复测 |
| P5a | 已实现，随产品生效 | Pi `setModel` 和两条切换模型的路径：分支当前记录的模型和新模型相同时，不再写 `model_change`；`model_select` 事件的行为不变 | 新增回归测试（去掉改动后失败）；`build:pi` 的回归测试全部通过，`check:pi` 通过 |
| P5b | 已实现（复盘脚本） | `extract-session-metrics.mjs` 新增 `assistantErrorOutcomes`，区分 `absorbedByRetry`（之后还有 assistant 回复，说明重试成功）和 `endedRun`（错误就是这一轮的最后一条回复） | 合成会话验证 |

运行时与发行门：
- `verify-pi-runtime.test.mjs` 40/40、`test:distribution` 28/28、`build-pi-fork.test.mjs` 2/2、observability 51/51。
- `smoke-runtime.mjs` 默认和全量两种工具面都失败：预期列表里有 Computer Use v2 的工具（`cu_session`、`clipboard` 等），但 vendor 里的 Computer Use 归档还是旧版。改动前同样失败，差异完全一致，不是本次引入。
- `pack:release` 和真实安装还没跑，是否发布由维护者决定。

构建环境说明：
- 云端容器需要代理 CA。构建脚本隔离环境时不传 CA 变量，所以临时在容器的 npm 内置配置里加了 cafile。
- 以 root 运行时，EACCES 相关测试不成立；`find` 相关测试需要 `fd`。因此装了 `fd`，并改用非 root 用户构建。
- 这个容器里的 npm 10.9.9 重新生成 `runtime/pi/package-lock.json` 时漏掉了一条嵌套依赖，导致 `npm ci` 失败。所以保留原来的 lock 结构，只替换 7 个 Pi 归档的 integrity，之后 `check:pi` 和 `npm ci` 都通过。
- 以上都没有修改构建脚本或发布脚本。

## 6. Mac 验证（`results/verify-impl.md`，`1a4ec0e`）

- **Pi fork 可以重现。** 在 Mac 上（Node 24.18、npm 12.2）从源码 `build:pi`，结果与提交版本逐字节一致：7 个归档、lock 和 `fork-build.json` 都没有差异，各包回归测试 1074 通过 / 3 跳过 / 0 失败。云端手工保留 lock 结构的做法和 Mac 的结果一致。
- **测试结果与云端一致。** 唯一的失败是 `cu-v2-tools.test.ts`（模块解析错误），`main` 上同样失败。云端 `model-selector` 的那个失败在 Mac 上没有复现。启动 smoke 在本分支和 `main` 上的失败完全一致（vendor 里的 Computer Use 归档仍是旧版）。
- **抽查**：P0/P0b 的分类在安装后的产物上成立，P4 的规则唯一存在。
- **P5b 口径**：
  - 合计 484 比 477 多 7，是脚本的 bug：`--now` 只用来算窗口起点，没有限制终点，本轮运行时比 `--now` 晚约 24 小时，这段时间的活动也被算进去了。已修复，现在窗口是 `[since, now]`，会话条目和 trace 都按这个范围过滤，合成数据已验证。本地 agent 用加了上界的口径复算，结果正好是 477（吸收 391 / 终结 86）。
  - `endedRun` 不是 57，是因为任务书的预期写错了，不是脚本有问题。57 只统计“错误后紧跟用户消息、且排除子 agent 会话”的情况；`endedRun` 按 P5b 的定义还包括“错误是窗口内最后一条记录”（26 条）和子 agent 会话。两个桶合计等于全部 error 数，字段本身是自洽的。
- **仍未验证**：P2 的真机端到端流程；P2、P3 进入产品（需要重打 vendor 归档）；P0/P0b 对真实 provider 失败的恢复效果；P4 的效果；`pack:release` 和安装、升级路径。
- **`main` 已经前进了 16 个 commit**（都是 Browser 相关），和本分支 `git merge-tree` 检查无冲突。
