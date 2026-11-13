# Pi 1.5.2 本机验证结果（macOS，2026-11-13）

在维护者 Mac 上执行 [本机验证交接](pi-1.5-local-verification-handoff.md) 的 S1–S8。全程使用公开仓库 `bingjiang0611/rotom` 的全新 clone 与分支 `claude/fervent-wright-jdsxy1`（起点 `418ffed`），没有改动正在使用的 rotom 安装或存活会话，没有发布 npm，也没有运行 `install-release.sh`。结果只含聚合数字和命令。

## 环境

| 项 | 值 |
|---|---|
| 系统 | macOS 27.3（build 26C5035r），arm64 |
| Node / npm | v24.18.0 / 12.2.0 |
| clone | `$TMPDIR/rotom-pi15`（canonical：`cd "$(pwd -P)"`） |
| 全局 hooks | 本机 `core.hooksPath` 指向 `~/.cloudshell-gitsync/hooks`；安装器拒绝覆盖，本 clone 用 `--local core.hooksPath` 指向 `.git/rotom-hooks` 后安装仓库钩子，全局配置未改 |
| 提交身份 | `bingjiang0611@users.noreply.github.com` |

依赖按交接命令在各目录 `npm ci --ignore-scripts`（第三方目录追加 `--omit=optional --legacy-peer-deps`）。`packages/rotom-computer-use` 没有 lockfile，`npm ci` 失败，改用 `npm install --ignore-scripts --no-package-lock --no-save`。

fork 包测试需要 workspace 的 `dist`：干净 clone 里直接跑会因 `@earendil-works/pi-schema` 等入口缺失产生 213 个文件级失败。先在 `packages/rotom-pi` 执行 `npm run build`（成功；该命令会重写 `packages/ai/src/providers/data/*.json`，属构建噪声，已 `git checkout` 还原，不提交）。

机器负载：验证期间 load average 长期在 100–316（Scry、Electron、DingTalk、Xprotect）。多个 spawn 型测试只在并行满负荷时超时，单独重跑稳定通过；下文逐项标注。

## S1 fork 门禁与可复现性

| 检查 | 结果 |
|---|---|
| `npm --prefix rotom run check:pi` | exit 0 |
| 第二 clone（同提交）`npm --prefix rotom run build:pi` | exit 0；构建过程 31 文件/491 测试 + 3 文件/14 测试通过 |
| 生成的 `fork-build.json` 8 个 `integrity` | 与已提交值逐项一致 |
| 同名 header 字段（version、upstreamRevision、sourceSha256、builderSha256） | 一致 |
| 构建后 `git status` | 干净（8 个 vendor tgz 字节级一致） |

结论：可复现。重建产物未提交。

## S2 fork 各包测试（macOS）

| 包 | 文件 | 测试 | 失败 | 说明 |
|---|---|---|---|---|
| agent | 6 | 99 | 0 | |
| ai | 190 | 2824（855 skip） | 5 | 见下 |
| mcp | 14 | 132 | 0（重跑） | 首次 3 个超时，隔离重跑连续 3 次通过 |
| codemode | 6 | 234 | 0 | |
| schema | 8 | 8755（9 expected fail） | 0 | |
| telemetry | 6 | 52 | 0 | |
| coding-agent | 365 | 3304（53 skip） | 7 | 见下 |
| tui | `node --test test/*.test.ts` | 1130 | 1 | 见下 |

ai：`context-overflow` 的 `gpt-5.6-sol` 用例在基线 `8e1fe0c` 同样失败；两个 `radius-thinking-replay-e2e` 是 live 测试，返回 403 ToS（基线同样失败，未提供凭据）；`fireworks`/`opencode` 的 model-generation 用例只在本轮失败，依赖模型目录网络，上一条记录轮次通过。

coding-agent：`clipboard-command`（3）、`package-command-paths`（2）与基线同样失败（基线跑同样三个文件时仅 2 个 clipboard 与 2 个 package 失败）；`subagent-extension`（2）只在本轮出现。这些文件单独重跑全部通过，满负荷并行时超时。

tui：`exit-restore.test.ts` 的 `does not restore twice after a normal stop()` 在 `spawnSync` 10 s 超时处失败；单独重跑 2/2 通过。

云端 coding-agent 的 25 个失败（root、无 `fd`、离线 catalog、路径过长）在 Mac 上没有一个复现。

## S3 rotom 产品门禁

| 检查 | 结果 |
|---|---|
| `rotom/bin/check-personal` | exit 0；`third-party/index.test.ts` 的子测试全部通过且进程正常退出 |
| `npm --prefix rotom run test:distribution` | 38/39；唯一失败是 `runtime/build-info.test.mjs:88` 的 `/^0\.1\./`（基线同） |
| footprint default | PASS：26 工具，schema 31 850 原始 / 31 720 归一，guideline 9 689 |
| footprint full（`ROTOM_DEFERRED_TOOLS=0`） | PASS：33 工具，48 489 / 48 359，11 605 |
| footprint scoped（full + `owned-process-groups-v2`，`PI_SUBAGENTS_TEMP_ROOT` 为 jiti 初始化的 owned store） | PASS，exit 0 |
| `node rotom/scripts/check-providers.mjs` | 9/9 PASS（`status: PASS`，`compiledPiMatchesSource: true`，`inputsStable: true`） |
| Goal 测试 | 99/99 |
| `npm --prefix rotom/evals run typecheck` / `test` | exit 0 / 45 文件 417 通过 + 1 skip |
| rotom-subagents `test` / `typecheck` | 71 通过 / exit 0（修复见 S7 说明的 RPC lifeline）；开发期 Pi 0.85.1 |
| rotom-sol-pi `test` / `typecheck` | 324/326 / exit 0；开发期 Pi 1.3.0 |
| rotom-computer-use `test`（含 pretest typecheck） | 325/325，exit 0；版本 0.5.1-rotom.4，无 Pi 依赖 |

rotom-sol-pi 的 2 个失败是 `tests/install-guide.test.ts` 读取 `packages/rotom-sol-pi/AGENTS.md` 与 `CLAUDE.md`：这两个维护文件不在公开仓库，基线同样失败。

本机上 `third-party/index.test.ts` 不退出的问题没有复现。

## S4 打包与隔离安装

| 检查 | 结果 |
|---|---|
| `npm --prefix rotom run pack:release -- $OUT` | exit 0；1.5.2-rotom.1；19 436 文件；34 946 978 字节；`sha256 c032ad71090c3b2695637a7527da9390f812ade96af747e1500f3453bd2c6abe` |
| `python3 scripts/audit-public.py --artifact <tgz>` | PASS；19 437 文件 / 185 095 762 字节；0 finding |
| 隔离安装（空 HOME、空 prefix、PATH 无全局 `pi`/`rotom`） | exit 0 |
| `rotom --version` | `0.2.0` |
| public-runtime smoke default（安装树） | exit 0；26 active，`subagentExecutionScope: unscoped`，0 lifecycle error |
| public-runtime smoke full | exit 0；33 active，31 850/48 489 原始、归一 31 720/48 359，guideline 9 689/11 605 |
| 安装树 footprint 合同（default / full） | PASS / PASS（用同一 smoke 输出套 `buildContextFootprintReport`；发行包不带 footprint 报告脚本，见限制） |
| 安装 dist grep | `cacheWarming: "streaming"` 命中 3 处；`supportsMessageThreads: model.compat?.supportsMessageThreads ?? false` 命中 2 处 |
| `npm uninstall -g --prefix` 卸载 | exit 0；`bin/rotom` 消失，安装树剩余 0 个文件 |

## S5 真实 TUI（不调用模型）

100×32 PTY，从 S4 的隔离安装启动，临时 git 项目，隔离 HOME 只复制用户既有 `auth.json` 与 `models-store.json`（0600，只读用途）。

| 检查 | 观察 |
|---|---|
| 启动头部 | `rotom v0.2.0`、skills/extensions 列表、默认模型 `gpt-6.1-sol` |
| `/settings` | `Cache warming  streaming` |
| `/model` | `GPT-6.1 Sol · gpt-6.1-sol [openai-codex]`（名称在前，`· id`，再 provider） |
| `/scoped-models` | `GPT-5.6 Luna · gpt-5.6-luna [openai-codex]`，同格式 |
| `/login` | 列表打开：`Sign in with an account` / `API key` / `Radius ✓ stored`，只看未登录 |
| 退出 | exit 0、stderr 空；PTY 尾部含 `?1049l`、`?25h`、`<u`、`?1006l`、`?2004l` |

该次运行没有产生任何会话消息，即零模型调用。过程中两次探索性运行把 `/exit` 当成提示词提交（TUI 的退出是 Ctrl+D、Ctrl+C 或 `/quit`），触发了 2 次真实 openai-codex 请求（各约 11 k input，合计约 $0.044），不是 S6 授权范围；最终记录以零调用的一次为准。

## S6 真实 Provider 冒烟（qoder/dfmodel）

用户已有 Qoder 登录（只读复制到隔离 HOME），未重新登录，未改用户凭据。合成 fixture。

| 场景 | 结果 |
|---|---|
| print 模式工具往返 | exit 0；`read fixture.txt` → `stop: stop`，输出 `LANTERN`；usage 已写入（1094/39 与 260/3）；credits 记录 0.023811 + 0.005523 |
| RPC 多轮 + `/compact` | 2 段大合成提示词后 compaction entry：`tokensBefore 62507`，summary usage 25 848 tokens，credits 字段缺失（unknown） |
| 压缩后续跑 | context 37 812 tokens；`stop: stop`，输出 `CONTINUE` |
| `/tree` 分支摘要（同一会话在 TUI 重开） | 选中前一条 → `Summarize branch?` → `Summarize`；`branch_summary` entry，usage 565 tokens，credits unknown |
| thinking low / high / max | 三次 print 均 `stop: stop`，`message.thinkingLevel` 分别为 low/high/max；各 credits 0.243403 |
| provider 重试 | 无重试事件；compaction trace `will_retry: false`、`attempts: 1`、`status: ok` |
| trace 错误类计数 | 0（各次运行的 trace 均无 error 事件） |

已记录 credits 合计约 5.74（自定义 credit 事件求和；compaction 与 branch summary 的 credits 缺失，计 unknown，不按 0 处理）。

基线对照：在 `8e1fe0c` 上 `pack:release`（1.4.0-rotom.4；19 049 文件；34 088 284 字节）并隔离安装，print 工具往返同样通过（`read` → `stop`，credits 0.029153）。**偏差**：因为 1.5.2 上没有出现“只在 1.5.2 失败”的场景，没有在基线上重复整套 S6 矩阵，只做代表性对照，避免双份真实调用成本。

## S7 既有失败

1. `rotom/runtime/build-info.test.mjs:88` 的 `/^0\.1\./` 只是没跟上 0.2.0 冻结：改成从 `rotom/package.json` 读版本并与 `rotom --version` 精确比较。改后 5/5 通过；撤回改动的对照下该用例失败。单独提交。
2. `experiments/qoder-provider/catalog-refresh-smoke.mjs` 在 “native compaction refresh” 之后失败，分支与基线一致：`failCatalog` 后 `catalogReads=5`，但 `dispatches=5`、`stopReason=stop`、没有 `catalog_refresh_failed`（预期 dispatch 停在 4 且请求以错误结束）。两个版本数字相同，属既有问题，记入待决问题，未在此修复。
3. `third-party/index.test.ts` 不退出的问题在本机没有复现（`check-personal` 正常退出）。

另修一处本分支测试夹具缺陷：`packages/rotom-subagents/test/provider-extension.test.mjs` 的 RPC 模型探针在 1.5 下读不到输出。原因是 `PI_SUBAGENT_CHILD=1` 的受管子进程在 1.5 的 `session_start` 里发现没有 fd 3 owner lifeline 就立即 shutdown（真实启动总会传）。探针现在为该次运行提供 fd 3 与 `PI_SUBAGENT_OWNER_LIFELINE_FD=3`；旧代码失败、新代码通过。单独提交。

## S8 pi-schema 对第三方工具的影响

在 full 工具面（`ROTOM_DEFERRED_TOOLS=0`，33 个工具）上，用产品 Pi 自带的 `@earendil-works/pi-schema` 对每个工具参数 schema 执行 `compile(schema, { coerce: true })`：

| 检查 | 结果 |
|---|---|
| 编译成功 | 33/33 |
| 未解析 `$ref` | 0 |
| 代表性合法参数（read、bash、browser_inspect、browser_interact、browser_devtools、context_recall、ask_user_question、codemode、四个 Goal 工具、subagent、observe_ui、act_ui） | 15/15 解析通过 |
| 强转 | `amount: "5"` → `5`；`resume_after_ms: "15000"` → `15000`；`repeated_turns: "3"` → `3` |

与 1.4 对照：用同一枚举脚本在基线产品（1.4.0-rotom.4）上导出 33 个工具的 schema，两边工具集合完全相同，**33/33 的 schema JSON 逐字段一致**（排序后比较）。1.5 没有改变任何工具的实际入参。1.4 没有独立 pi-schema 包（沿 pi-ai 的 TypeBox 导出），因此基线侧只导出 schema、不编译。

## 待决问题

- `catalog-refresh-smoke.mjs` 的 “refresh failure stops without native retry” 约定在 1.4 与 1.5.2 都不成立（catalog 刷新失败后仍发出推理请求且成功）。是实验预期过期还是产品缺陷需要单独判定，本次未改。
- `packages/rotom-sol-pi/tests/install-guide.test.ts` 依赖公开仓库不存在的私有 `AGENTS.md`/`CLAUDE.md`，公开 clone 必然 2 个失败。
- 本机 `clipboard-command`、`package-command-paths` 与基线同样失败；属于本机环境还是代码需要另一次低负载复核。
- 高负载下的 spawn 型测试会超时（clipboard、mcp pipe/stdio、startup-session-name、subagent-extension、tui exit-restore），单独重跑通过；未定位到具体资源阈值。
- TUI 里 `/exit` 不是内置命令，会被当作提示词发给模型（退出用 Ctrl+D / Ctrl+C / `/quit`）。是否应把 `/exit` 设为命令，留给维护者决定。

## 未覆盖与限制

- footprint 报告脚本不在发行包里；安装树的 default/full 合同用安装树 smoke 输出套同一报告函数计算，不能等同于“在安装树内运行报告脚本”。
- `/tree` 分支摘要经 TUI 真实驱动完成，但收尾时进程在 20 s 内没有自行退出（驱动超时后终止），摘要 entry 已落盘；没有继续判定退出挂起是产品还是驱动问题。
- ai 的 live（Radius、Codex）与 model-generation 用例依赖外部凭据/网络，按跳过或环境失败处理，不提供凭据。
- 真实 Chrome、真实 Computer Use 桌面交互和跨平台（Linux/Windows）不在本次范围。
- 本机没有验证 npm 发布、`install-release.sh` 或本机安装切换。
