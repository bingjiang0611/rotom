# 同会话轮转 · 产品接入、终验与收尾决策

本册承接[工作包回报](session-rollover-report-workpackages.md)的 W5、W6 与新增决策记录；概览、基线、索引与待决事项在[执行回报](session-rollover-report.md)。

## W5：产品接入与文档

### 改动摘要（文件级）

| 文件 | 改动 |
|---|---|
| `rotom/runtime/product-config.mjs` | `RESOURCE_DESCRIPTORS_V1` 在 `third-party` 之前声明 `session-rollover`（`loadPath: extensions/session-rollover/index.ts`，`requiredFiles` 为四个运行期文件） |
| `rotom/package.json` | `files` 增加四个运行期文件；测试与 `test-helpers.ts` 不进包 |
| `rotom/bin/check-personal` | 测试列表并列加入 `rotom/extensions/session-rollover/*.test.ts` |
| `rotom/runtime/smoke-runtime.mjs` | 扩展数量断言 7 → 8 |
| `rotom/runtime/verify-pi-runtime.test.mjs` | 三处 launcher argv 期望值加入新扩展；`--extension` 计数 6 → 7 |
| `rotom/evals/test/product-runtime.test.ts` | 资源列表加入 `extension:session-rollover` |
| `CLAUDE.md` | 第 3 节 Context Layers 段改为单一只读检索，并新增一段轮转扩展（默认关闭、opt-in、未实测不宣称收益） |
| `docs/usage.md` | “Context Layers：原文回查”重写；新增“同会话上下文轮转（默认关闭）”小节 |
| `docs/agent/context-layers.md` | 按精简后的合同重写链路与工具说明，保留历史链接，列出已删除能力 |
| `docs/agent/session-rollover.md` | 状态行；8.2 末尾加“实现回填”偏差说明 |
| `docs/agent/session-rollover-verification.md` | 第 10 节进度行改为 W1–W4 已实现、实测未执行 |

launcher 没有环境变量白名单（`ROTOM_SESSION_ROLLOVER` 原样透传），因此只改文档，没有改 launcher 逻辑。

### 测试

| 检查 | 结果 |
|---|---|
| `node --test rotom/runtime/verify-pi-runtime.test.mjs` | 40 passed / 0 failed |
| `node --test rotom/runtime/verify-pi-runtime.test.mjs rotom/runtime/distribution.test.mjs` | 68 passed / 0 failed |
| `node --experimental-strip-types rotom/runtime/smoke-runtime.mjs "$(node rotom/runtime/resolve-installed-pi.mjs rotom)" rotom` | exit 0，加载 8 个扩展 |
| 同上并设 `ROTOM_SESSION_ROLLOVER=1` | exit 0（扩展不新增工具，默认工具面不变） |
| `npm --prefix rotom/evals run test test/product-runtime.test.ts` | 13 passed / 1 skipped（与基线一致） |
| `npm --prefix rotom/evals run typecheck` | exit 0 |
| `node rotom/runtime/report-context-footprint.mjs … rotom` | 26 tools / 31 670 schema / 9 939 guideline，与接入前逐字节相同（新增扩展不注册工具）；`runtimeContractGate=REGRESSION` 的既有 +1 986 字节漂移不变 |

`check-personal` 现在包含新扩展测试，整包一遍放到 W6。

### 负向对照

接入前后的自然对照：先只改 `product-config.mjs` 而不改期望值，`verify-pi-runtime.test.mjs` 有 3 个用例失败（`expected 7 to be 6`、argv 深比较差一个 `session-rollover` 项），`product-runtime.test.ts` 失败于 `+ "extension:session-rollover"`；更新期望后全部通过。这说明这些断言确实绑定产品资源声明，不是空断言。

### 未验证项与原因

- 发行包（`pack:release` 与真实 tgz 安装）未跑：本轮不发布、不改版本号，`files` 只做静态核对 + `distribution.test.mjs`。
- 设计文档只更新了状态行、8.2 偏差说明与第 10 节进度；4.1 水位取值在 W2 已写回，本轮未再改。

## W6：最终验证

| 检查 | 结果 |
|---|---|
| `git diff --check` | exit 0 |
| `rotom/bin/check-personal` | **无法完成**（既有失败，见下） |
| 同脚本去掉 `third-party/index.test.ts` 一行 | 主清单 567 tests / 567 pass / 0 fail；Goal 套件 99 / 99 pass；最后一步 `report-context-footprint.mjs` 以 `runtimeContractGate=REGRESSION` 退出 1 |
| `cd rotom && npm run check:pi` | exit 0（fork `1.4.0-rotom.2`，源码摘要 `c69b9f9c…`） |
| `node --experimental-strip-types rotom/runtime/smoke-runtime.mjs "$(node rotom/runtime/resolve-installed-pi.mjs rotom)" rotom` | exit 0，8 个扩展 |
| `node --test rotom/runtime/verify-pi-runtime.test.mjs` | 40 passed / 0 failed |
| `npm --prefix rotom/evals run typecheck` | exit 0 |
| `python3 scripts/audit-public.py --root .` | `PASS`：8 536 文件 / 169 975 115 字节 / 0 findings |
| `rotom/extensions/context-layers/*.test.ts` | 10 passed |
| `rotom/extensions/session-rollover/*.test.ts` | 19 passed |
| `packages/rotom-pi/packages/coding-agent` → `npx vitest run test/session-rollover-seam.test.ts` | 8 passed |
| `npm --prefix rotom/evals run test test/rollover-stats.test.ts` | 20 passed |
| `node --test rotom/extensions/qoder/tool-arguments.test.mjs` | 6 passed |
| `npm --prefix rotom/evals run test test/product-runtime.test.ts` | 13 passed / 1 skipped |

`check-personal` 的失败是既有问题，不是本次改动：`rotom/extensions/third-party/index.test.ts` 的 24 个用例全部通过后，文件级 promise 永不结算（`Promise resolution is still pending but the event loop has already resolved`），串行队列因此卡在该文件，`--test-force-exit` 也不生效。用基线 fork（`f266b305` 的 `packages/rotom-pi`，摘要 `d3001527…`）单跑同一文件复现同样结果（24 pass，300 秒超时未退出），随后已恢复 `HEAD` 源码、重跑 `build:pi` 并 `npm ci`，`git status` 干净、`check:pi` exit 0。该文件本身在本分支未被修改。

### 未验证项与原因

- Context Layers 的 `live.mjs` / `experiments/context-layers/stress.mjs` 未运行：需要真实模型与 Qoder credits 授权，本轮明确排除；且它们测量的是已删除的压缩写入路径。
- 轮转的真实模型对话（设计 9.3 的 L3）未执行：同上，需要真实模型与费用授权。因此“省费用/省请求”没有任何实测证据，B 仍默认关闭。
- TUI 中的轮转提示真实渲染未验证（print 模式为空实现）。
- `pack:release`、真实 tgz 安装与升级未跑：本轮不发布、不改版本号。
- `subscription`/`context-footprint` 的 `REGRESSION` 需要维护者决定是否更新合同数字（既有问题，未改）。

## 决策记录（W5/W6 补充）

| 位置 | 设计未覆盖或偏离之处 | 决定 | 理由 |
|---|---|---|---|
| `check-personal` 的既有挂起 | 清单要求跑完整脚本，但既有失败使脚本无法结束 | 先原样运行确认卡点，再用同脚本删掉该文件一行重跑，两者都写进回报 | 既不改仓库门禁，也不把“跑不完”说成通过；基线复现证明与本次改动无关 |
| `build:pi` 与安装 | 重建归档不会安装到 `runtime/pi/node_modules` | 需要时显式 `cd rotom/runtime/pi && npm ci --ignore-scripts` | 安装目录才带 `rotomFork.sourceSha256`，否则 `resolve-installed-pi` 的 identity 校验失败 |
| 基线对照实验 | 为确认既有失败与本次无关，需要一份旧 fork 产物 | 临时 `git checkout f266b305 -- packages/rotom-pi` → `build:pi` → `npm ci` → 复现 → `git checkout HEAD --` → `build:pi` → `npm ci` | 结论需要因果证据；恢复后 `git status` 干净、`check:pi` exit 0 |

## 第 1 轮返工

依据 [第 1 轮核验意见](session-rollover-review-1.md) 的 R1–R5，连续完成、不中途提问；授权范围与停止条件不变。

### R1（必须修）：压缩后的 `stale` 估算不再触发轮转

- **复现先行**：把评审给的用例加进 `index.test.ts` 并跑出失败（`actual: ["native","rotom-rollover"]`、`expected: ["native"]`）；`eligibility.test.ts` 同时新增单条用例并失败（`allowed: true` 对 `stale-estimate`）。
- **修复**：`RolloverEstimate` 增加必填 `stale`；`index.ts` 的 `readEstimate()` 只搬运 `getContextThresholdEstimate()` 的五个字段（含 `stale`）；`eligibility.decideRollover` 在 `enabled` 之后、水位之前返回新的阻止原因 `stale-estimate`。该判断对 `input` 与 `after-run` 两个触发都生效，因此轮末也不会为一份过期估算取消压缩——与 `_checkCompaction` 的 `if (estimate.stale) return false` 同口径。
- **其他 `stale` 路径**：新增“恢复会话时最新条目是压缩条目”的用例（harness 增加 `resumeFrom`，用 `SessionManager.open` 重开同一会话文件），确认 `stale: true` 且不轮转。
- **已有用例的修正**：原用例 `a second submission above the water mark rolls over again` 断言的是错误行为——它依赖“压缩前的旧 usage 仍然算当前占用”，正是 R1 要禁止的。改为 `a rollover resumes only from a fresh estimate`：轮转后第一次提交（估算 stale）不轮转，之后由新回复更新估算、再按真实保留量轮转。
- **测试**：`session-rollover/*.test.ts` 24 passed（新增 4 条：eligibility 1、index 3）。
- **负向对照**：① 删掉 `if (estimate.stale) …` → 4 条失败；② `readEstimate` 里写死 `stale: false` → 3 条失败。均恢复后复跑 24/24。

### R2（必须修）：轮中越线跨过压缩条目仍算轮中

- 新增失败用例（评审的分支形状，按 10 000 窗口 / 1 000 reserve 缩放）：`user → 5 000 → 9 500 → compaction → 3 000 → 4 000 → 下一个 user`，旧脚本给出 `midTurn: 0 / turnEnd: 1`。
- **修复**：`segmentsOf()` 改为返回 `[globalIndex, entry]`；新增 `turnOwnershipOf(branch)`，在**整条分支**上算每个请求的回合归属与“该回合最后一次请求”，分类改读这个全局结论，不再用段内列表。
- **测试**：`rollover-stats.test.ts` 22 passed（新增 1 条）。
- **负向对照**：退回段内判断（`turns[crossingTurnIndex].requests.at(-1) === crossing`）→ 该用例失败；恢复后通过。

### R3（必须修）：会话占比只看首次越线段

- 新增失败用例：一个会话第一段越线不可接管、第二段可接管（7 500 > 10 000 − 3 × 1 000），旧实现把会话计为可接管。
- **修复**：`analyzeSession` 新增 `firstCrossingTakeover`（只在该会话第一个越线段累加）；`aggregate` 的会话占比改读它；段占比仍累计所有越线段。`judge` 的文档说明与 `rollover-stats.d.mts` 同步。
- **测试**：同文件 22 passed（新增 1 条）。
- **负向对照**：会话占比改回 `analysis.takeover` → 该用例失败；恢复后通过。

### R4（必须修）：文档表述

| 位置 | 修正 |
|---|---|
| `CLAUDE.md` 第 3 节 | 删掉“检索结果不进入下一轮请求”，改为“检索结果是普通工具结果，会留在后续请求的上下文中，可能再次被压缩或清出”；“只把被压缩或轮转清出的…临时展开”改为“按子串搜索或按 `@entryId` 读取当前分支上的原始文本与图片——搜索覆盖分支上的全部消息” |
| `CLAUDE.md` 默认工具面段落 | “Context Layers 三工具”→“Context Layers 的 `context_recall`” |
| `docs/usage.md` | 同一处不准确表述改为“返回的是普通工具结果，会留在后续请求的上下文中” |
| `docs/agent/context-layers.md` | 结果说明同上；补充 `query` 覆盖整条分支 |
| `docs/agent/session-rollover.md` 第 2 节表格 | 把“`context_status` 带 `query` …”改为精简后的 `context_recall({query})` / `context_recall({ref})` |
| `docs/agent/session-rollover-rules.md` 4.2 | 删除“本地命令”一条的旧表述（见 R5），新增 `stale` 规则 |
| `experiments/context-layers/stress.mjs` | 删除：它只调已删除的 `context_status` / `context_compress`，属残留三工具表述；`budget.mjs`/`budget.test.mjs` 保留 |

全仓复查（排除历史记录、评审文档、发布记录与 `report-context-footprint.mjs` 里解释 W1 差值的注释）已无“三工具/`context_status`/`context_compress` 能力描述残留。

### R5（建议修）：斜杠输入不再一律跳过

- **证据**：`agent-session.ts` 的 `prompt()` 先执行扩展命令（`_tryExecuteExtensionCommand`），再发 `input`（注释原文 “before skill/template expansion”），最后才展开 `/skill:name` 与模板；TUI 的内置命令也不走 `prompt()`。因此到达 `input` 处理器、以 `/` 开头的文本一定展开成真实模型请求。
- **修复**：删除 `local-command` 阻止原因与 `text.startsWith("/")` 判断。扩展内无法枚举已注册 Skill/模板（`ExtensionAPI` 不暴露），所以按“判断不了就不用前缀猜测”处理，比“只在非 Skill/模板时跳过”更简单且不会漏接管。
- **测试**：新增 2 条（`/skill:review the diff` 在资格层允许、在集成层真的轮转）。
- **负向对照**：加回前缀跳过 → 这 2 条失败；恢复后通过。

### 阶段 0 重跑（R2、R3 之后，本机）

`./rotom/evals/bin/rollover-stats --json`，914 个会话回放：越线段 329 / 会话 113，轮中 316 / 轮末 13，候选 2× / 3× / 4× 的**会话占比 26.6% / 41.6% / 48.7%**，段占比 31.6% / 46.8% / 57.8%。**门槛不达标**，2× 从 52.2% 掉到 26.6%。

按设计 9.1“不达门槛时 B 不合入 `main`”：不改门槛、不改选 3×/4×（设计变更需用户决定），B 保持默认关闭的 opt-in，设计 4.1 与 9.1 的结论同步改为“未达门槛”。完整数字与旧值对照见[阶段 0 统计](session-rollover-report-stats.md)。

### 本轮验证

| 检查 | 结果 |
|---|---|
| `git diff --check` | exit 0 |
| `rotom/extensions/session-rollover/*.test.ts` | 24 passed |
| `rotom/extensions/context-layers/*.test.ts` | 10 passed |
| `npm --prefix rotom/evals run test test/rollover-stats.test.ts` | 22 passed |
| `npm --prefix rotom/evals run typecheck` | exit 0 |
| `cd rotom && npm run check:pi` | exit 0（本轮未改 Pi 源码） |
| `node … smoke-runtime.mjs …` | exit 0 |
| `python3 scripts/audit-public.py --root .` | `PASS`：8 537 文件 / 0 findings |

未验证项与第 5–6 节相同：真实模型对话（设计 9.3）未执行；TUI 提示渲染未验证；`check-personal` 仍受既有 `third-party/index.test.ts` 不退出影响。R1 对 `stale` 的处理只覆盖了“最近 usage 早于最新压缩”这一条 Pi 提供的判定，没有新增 Pi 侧估算语义。
