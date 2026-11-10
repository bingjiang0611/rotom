# 公开 main 复验：`655c35f`（原请求目标 `b8ee813`，2026-11-10）

历史改写后对公开 `main` 的本机（macOS）复验。只在干净的单分支 clone 里做，不用维护仓；未动本机正在使用的 rotom 安装、存活会话和旧 worktree。

- 机器：macOS 27.3、Node v24.18.0、npm 12.2.0
- clone：`<repo>/../rotom-main-verify`（`git clone --single-branch --branch main`）
- 模型：`qoder/dfmodel`（只有冒烟调用它）

## 与交接说明的偏差

1. **HEAD 不是 `b8ee813`。** clone 下来的 `main` 已经是 `655c35f`（`fix(distribution): include Qoder model catalog and check local dependencies`），`b8ee813` 是它的父提交、仍是祖先。交接说明要求 SHA 不一致就停下，实际停过一次；得到“继续”的指示后改在当前 `main` 顶端 `655c35f` 上复验——它包含 `b8ee813` 的全部内容，多出的一个提交只改 `rotom/package.json`、`rotom/runtime/distribution.test.mjs`、`rotom/runtime/product-config.mjs`、`rotom/scripts/pack-release.mjs`（4 个文件，51 增 21 删），不涉及 Pi 源码、提示词或 gate 用例。若需要严格钉在 `b8ee813` 上的证据，需要另跑一次。
2. **多装了一个 workspace。** 交接说明列的 4 个 `npm ci` 之外，还执行了 `packages/rotom-pi` 的 `npm ci --ignore-scripts`：`rotom/scripts/check-providers.test.mjs` 会 `access()` 它选中的 `packages/rotom-pi/node_modules/vitest/vitest.mjs`，不装就失败（见 M1 的说明）。
3. **hook 安装要先绕开全局 hooksPath。** 本机全局 `core.hooksPath` 指向 `~/.cloudshell-gitsync/hooks`，`scripts/install-git-hooks.mjs` 因其中已有同名 `pre-push` 而拒绝安装（脚本设计如此，避免替换别人的 hook）。为满足交接说明，先在这个临时 clone 里设了**仅本仓**的 `core.hooksPath=<clone>/.git/rotom-hooks`，再执行安装，三个 hook 装好并生效；这不会影响其他仓库，删掉 clone 即完全还原。

4. **推送时 `main` 又前进了。** 本次复验跑在 `655c35f` 上；提交本文档前 `origin/main` 已到 `2544a63`（其后 6 个提交，集中在 `rotom/evals/src/loop/` 的 gate 预检、replay、weekly 报告与 hook 安装脚本，1832 增 91 删）。本文档提交已 rebase 到 `2544a63` 之上；这 6 个提交**不在本次 macOS 复验范围内**，需要时另行验证。

其余准备与说明一致：提交身份设为 `bingjiang0611 <bingjiang0611@users.noreply.github.com>`；`rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent/package.json` 的 `version` = **`1.4.0-rotom.4`**。

## M1 确定性检查（不调用模型）

| 检查 | 命令 | 结果 |
|---|---|---|
| Pi fork 合同 | `npm --prefix rotom run check:pi` | exit 0（1.1 s） |
| 维护面测试 | `rotom/bin/check-personal` | 见下：完整脚本在 `rotom/extensions/third-party/index.test.ts` 不退出；该文件之外的同一清单 **557/557 通过** |
| 固定 provider 矩阵 | `rotom/scripts/check-providers.mjs`（由 check-personal 调用） | **9 项全 PASS** |
| Goal 源码测试 | 同上调用 | **99/99 通过** |
| 上下文足迹报告 | 同上调用 | exit 1，`deterministicGate=REGRESSION`，`activeToolSchemaBytes` 31,448 对合同 29,684（交接说明列出的既有漂移，未修） |
| Subagent 单测 | `npm test`（`packages/rotom-subagents`） | **71/71 通过** |
| Subagent SDK | `npm run test:sdk` | **6/6 通过** |
| Subagent 类型 | `npm run typecheck` | exit 0 |
| evals 套件 | `npm --prefix rotom/evals test` | 39 个文件：**343 通过、1 失败、1 跳过**（404 s）；唯一失败见下 |
| evals 类型 | `cd rotom/evals && npx tsc --noEmit -p tsconfig.json` | exit 0 |
| 账本 | `npm --prefix rotom/evals run loop -- ledger` | **42 条**，无报错（3 条 `measured improvement`） |
| 发行合同 | `npm --prefix rotom run test:distribution` | **29/29 通过** |
| Hook 脚本 | `node --test scripts/hook-identity.test.mjs scripts/hook-ledger.test.mjs scripts/hook-audit.test.mjs scripts/check-staged-file-size.test.mjs` | **40/40 通过** |
| 审计单测 | `python3 scripts/test_audit_public.py` | exit 0（OK） |
| 历史审计单测 | `python3 scripts/test_audit_history.py` | exit 0（OK） |

### 已知问题的处理

- **`third-party/index.test.ts` 不退出。** 跑完整 `check-personal` 时该文件 14 个子测试全过、0 失败，随后进程不再前进（8 分钟无新输出，`ps` 显示子进程仍停在 `--test-isolation=process ... index.test.ts`）。按上次的做法，用同一脚本的未提交副本去掉这一行跑完其余清单（12 分钟），再单独跑该文件：同样 14/14 后挂起。这是交接说明列出的既有问题。
- **上下文足迹合同漂移**在复验中同样出现，数值与合并前一致（31,448 对 29,684），未改合同。
- **`check-providers.test.mjs` 首轮 1 项失败**（`every selected source command exists`，`ENOENT … packages/rotom-pi/node_modules/vitest/vitest.mjs`）：`packages/rotom-pi` 的依赖没装。装完该 workspace 后该文件 **8/8 通过**，第二遍完整清单 **557/557** 无失败。不是代码问题。
- 除上面这些，没有出现偶发失败。

### evals 唯一失败的定位（不是本提交引起）

失败用例：`test/quality-regressions.test.ts > authenticated-cli-success-path > accepts an actual repair and preserves unrelated files`。验收脚本在 `assert.equal(run('init').status, 0)` 处拿到 `null`，即它 `spawnSync(process.execPath, ['client.mjs','init'], { timeout: 3000 })` 的子进程被 3 s 超时 SIGTERM 掉。

- 同一用例在 `main` 合并前提交 **`2b4ea53`** 的独立 worktree 上同样失败（2/2 次，症状相同）；`rotom/evals/src/quality-regressions.ts` 与对应测试文件在 `2b4ea53..655c35f` 之间**没有改动**。
- 在本 clone 上单独重跑 6 次全部失败（3 次直接跑、3 次在整轮里），失败稳定复现，但原因是本机子进程启动时间不稳定：同一句 `spawnSync(process.execPath, ['-e','0'])` 实测 **39 ms 到 4.6 s** 波动，换取环境变量（去掉代理、`NODE_USE_ENV_PROXY`、`NODE_EXTRA_CA_CERTS`）都不改变这种抖动。用例内层预算固定 3 s，所以慢的那次必然超时。
- 结论：这是**本机执行环境**导致的既有脆弱点（云端 Linux 上 344/344 通过），与 `b8ee813` 及历史改写无关；未改测试、未放宽超时。

## M2 真实会话冒烟

临时目录建 Git 小项目（`notes.txt` 三行），用本 clone 的 `rotom/bin/rotom-launcher --print --provider qoder --model dfmodel --session-dir <临时目录>` 跑“读一个文件并改一行”，完成后只读会话 JSONL 与 trace 核对。

- `rotom-launcher --version --verbose`：`rotom 0.1.27` / **`Pi fork 1.4.0-rotom.4`**。
- 会话 system `sections`：`preamble`、`tools`、`rules`、`docs`、`project_context`、`skills`、`cwd`、**`coding_policy`（7,161 字节）**；整块 `content` 为空字符串。
- 结束状态：`stopReason` 依次 `toolUse`×3 → **`stop`**，assistant 错误 **0** 条；stderr 中 error/warn 行 **0** 条（`grep -ic` = 0）。
- 改动落盘并回读一致：`notes.txt` 第二行变为 `beta-edited`，模型随后 `read` 回读确认；会话 17 条、工具调用 `read`/`edit`/`read`。
- 本地 trace：54 个事件，非 OK 状态 **0** 个。
- 登录修复按要求没有重放真实 OAuth 登录，只由 `check-personal`（含 `cascade`/provider 相关用例）与 `check:pi` 的构建期测试覆盖。

## M3 harvest 冒烟（只读本机会话，不调用模型）

`npm --prefix rotom/evals run loop -- harvest --days 7 --no-excerpts` → exit 0，18 s：`sessions=277 incidents=759`，跳过计数 `artifact-store:718, deep-directory:59, outside-window:699, no-user-turns:2`。输出目录 `~/.rotom/loop/harvest-2026-11-10T15-55-52-429Z`（不入 Git）：

- 有 `compactions.jsonl`（264 行）；
- `summary.json` 顶层键含 **`compactions`**：`{"compactions":264,"rereadRate":0.258,"recallCompactions":5,"userTurnsAfter":505,"interventionsAfter":104,"interventionsPer100TurnsAfter":20.6,"goalPausesAfter":2,"medianSummaryOutputTokens":6423,"cacheDrops":259}`；
- `report.md` 有 **`## After compaction`** 一节（第 369 行），其中“整体介入率 12.3/100 轮”与“压缩后 20.6/100 轮”并列展示。

再加 `--experiment default-model` 跑一次：exit 0（14 s），打印 `experiment openai-codex/gpt-6.1-sol: sessions=16 turns=61 v2=4 per100=6.6`、`compliance: 33/277 sessions opened on that day's default (11.9%); switched=9 off-default=244`，以及一条灵敏度检查，无报错。

## 推送前审计

- `python3 scripts/audit-public.py --root . --history`（干净单分支 clone）：**PASS，0 发现**，`commitsChecked: 491`、`filesChecked: 25342`、`skippedAuditedArchives: 317`。历史改写后已无 `personal-home-path` 发现。
- 推送时另跑 `--history-range origin/main..HEAD`，只审这次推送新增的提交与其引入的 blob。

## 未验证与已知限制

- 未在 `b8ee813` 这一精确提交上跑：实测起点是 `655c35f`（见“与交接说明的偏差”）。
- `third-party/index.test.ts` 的**进程退出**仍未验证（本机挂起，与是否合并无关）。
- evals 的 `quality-regressions` 1 个用例在本机稳定失败，原因是本机子进程启动抖动叠加用例内 3 s 预算；未在云端之外的 Linux 机器复核。
- 上下文足迹合同 `activeToolSchemaBytes` 仍是既有漂移，本次未修。
- gate 没有重跑（按要求：本分支改动的 gate 证据在 `7df482a` 上已测，`main` 新增提交不涉及提示词）。
- 没有做 `pack:release`、npm 发布、`build:pi`，也没有用本机正在使用的 rotom 安装复测；冒烟只有 1 次真实会话，只能证明链路通、无 provider/扩展错误。
