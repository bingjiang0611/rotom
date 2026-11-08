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
