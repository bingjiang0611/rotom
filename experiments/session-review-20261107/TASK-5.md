# 任务书 5：在维护者的 Mac 上验证 P0、P0b、P2、P3、P4、P5

被验证的分支：`claude/optimistic-einstein-soq1sd`。改动内容见 `REPORT.md` 第 5 节。这些 commit 是在云端 Linux 容器里写的，测试也在那里跑过。这一轮要在真实的 Mac 上重新确认，并补上容器里做不到的检查。

## 0. 边界（必须遵守）

- **不碰正在用的 rotom。** 不覆盖、不重装正在使用的 rotom 安装，不动 `~/.pi/agent/` 下的会话、trace 和 `.pi/` 目录，不停止或重启正在运行的 Computer Use helper。所有操作都在下面新建的独立 clone 里进行。
- **不做外部写入。** 不 `npm publish`，不合并到 `main`，不开 PR，不发真实 Qoder 或其他 provider 的模型请求（除非维护者在本轮另行明确授权）。
- **隐私规则同 `TASK.md` 第 0 节。** 仓库是公开的，结果里不能出现路径、用户名、项目名、URL 或凭据。
- **只记录事实。** 测试失败如实记录，不改代码去“修绿”；如果发现问题，只写现象和复现步骤。

## 1. 准备独立 clone

```bash
git clone https://github.com/bingjiang0611/rotom.git "$TMPDIR/rotom-verify" && cd "$TMPDIR/rotom-verify"
git checkout claude/optimistic-einstein-soq1sd
git log --oneline -9
```

确认最近 9 个 commit 里有以下这些（SHA 用 `git log` 读出来，不要手抄）：
- `feat(qoder): retry catalog refresh …`
- `feat(computer-use): ask once …`
- `feat(subagents): report run progress …`
- `feat(coding-policy): report progress …`
- `fix(pi): record model_change only when …`
- `feat(session-review): separate retry-absorbed …`

## 2. Pi fork 的可重现性（最重要）

云端用的 npm 版本（10.9.9）重新生成 `rotom/runtime/pi/package-lock.json` 时漏了一条嵌套依赖。云端的处理是：保留原来的 lock 结构，只换 7 个 Pi 归档的 integrity。这一步要确认，在 Mac 上从源码重新构建，结果和提交的版本一致。

```bash
cd rotom
npm run check:pi
npm run build:pi
git status --short
git diff --stat
```

需要报告：
- `check:pi` 的退出码。
- `build:pi` 是否成功，各包的回归测试是否全部通过。如果有失败，列出失败的测试名。
- 构建之后 `git status` 是否干净：
  - **干净**：说明 Mac 上的构建和提交的完全一致。
  - **不干净**：列出改动的文件。对 `rotom/runtime/pi/package-lock.json`，给出 `git diff` 中**除 integrity 以外**的结构变化（新增或删除了哪些包条目，只写包名和版本）；对 vendor tgz 和 `fork-build.json`，说明 integrity 是否不同。**不要提交这些改动。**
- 记录 `node --version` 和 `npm --version`。

如果 `git status` 不干净，先执行 `git checkout -- .` 和 `git clean -fd rotom/runtime/pi` 恢复到提交的状态，再继续后面的步骤。

## 3. 安装运行时并跑测试

```bash
cd rotom/runtime/pi && npm ci --ignore-scripts --no-audit --no-fund && cd ../..
cd extensions/third-party && npm ci --ignore-scripts --no-audit --no-fund --legacy-peer-deps --omit=optional --bin-links=false && cd ../..
```

逐项运行，记录通过数和失败数（云端结果写在括号里供对照）：

| 检查 | 命令（在 clone 根目录下执行） | 云端结果 |
|---|---|---|
| 运行时合同 | `node --test rotom/runtime/verify-pi-runtime.test.mjs` | 40/40 |
| 发行包 | `(cd rotom && npm run test:distribution)` | 28/28 |
| Pi 构建器 | `node --test rotom/scripts/build-pi-fork.test.mjs` | 2/2 |
| Qoder | `(cd rotom/extensions/qoder && node --test *.test.mjs)` | 270/270 |
| coding-policy | `node --experimental-strip-types --test rotom/extensions/coding-policy/*.test.ts` | 10/10 |
| observability | `node --experimental-strip-types --test rotom/extensions/observability/*.test.ts rotom/extensions/observability/*.test.mjs` | 51/51 |
| Computer Use | `(cd packages/rotom-computer-use && node --test --experimental-strip-types test/*.test.ts)` | 74/76，`cu-v2-tools.test.ts` 失败（改动前也失败） |
| subagents wait | `(cd packages/rotom-subagents && npm ci --ignore-scripts --no-audit --no-fund && ROTOM_PI="$(realpath ../../rotom/runtime/pi/node_modules/.bin/pi)" node --experimental-strip-types --test test/wait.test.mjs)` | 21/21 |
| Pi model_change | `(cd packages/rotom-pi && npm ci --ignore-scripts --no-audit --no-fund && cd packages/coding-agent && npx vitest --run test/suite/agent-session-model-extension.test.ts test/model-selector.test.ts)` | 新测试通过；`model-selector` 的 “keeps the current model marked while browsing” 在云端直接跑时失败（改动前也失败） |

对每个失败项，再切到 `main` 跑一次同样的测试，判断是本次引入的还是本来就有。切换方法：在同一个 clone 里 `git stash -u` 或另建一个 clone，跑完再切回来。

## 4. 启动 smoke（默认和全量工具面）

```bash
P="$(realpath rotom/runtime/pi/node_modules/.bin/pi)"
node rotom/runtime/smoke-runtime.mjs "$P" rotom
ROTOM_DEFERRED_TOOLS=0 node rotom/runtime/smoke-runtime.mjs "$P" rotom
```

云端这两个都失败，原因是：预期列表里有 Computer Use v2 的工具（`cu_session`、`clipboard`、`manage_app`、`manage_window` 等），但 vendor 里的 Computer Use 归档还是旧版。改动前同样失败，差异完全一致。

在 Mac 上分别跑本分支和 `main`，回答两个问题：失败信息是否和云端一样？两边的差异是否完全一致？

## 5. 行为抽查（离线，不发真实请求）

1. **P0 / P0b 的分类**：运行下面这段，应输出 `true true true false false`。

   ```bash
   node --input-type=module -e "
   import { isRetryableAssistantError as r } from '$(realpath rotom/runtime/pi/node_modules/@earendil-works/pi-ai/dist/utils/retry.js)';
   const m = e => ({ stopReason: 'error', errorMessage: e, content: [] });
   console.log(['Qoder: catalog_refresh_failed','Qoder: request_failed_before_output','Qoder: stream_failed_before_output','Qoder: request_failed','Qoder: stream_failed'].map(e => r(m(e))).join(' '));"
   ```

2. **P4**：`grep -n "in the same response as your next tool call" rotom/extensions/coding-policy/index.ts` 应该恰好命中一行。

3. **P5b**：用新版脚本对维护者真实会话再跑一次统计，和第一轮的 477 / 57 对照。只报告新增字段 `fleet.assistantErrorOutcomes`，即 `absorbedByRetry` 和 `endedRun` 各类别的计数：

   ```bash
   node experiments/session-review-20261107/extract-session-metrics.mjs --days 7 --now 2026-11-07T05:00:00Z --out "$TMPDIR/m.json"
   node -e "console.log(JSON.stringify(require(process.env.TMPDIR + '/m.json').fleet.assistantErrorOutcomes, null, 1))"
   ```

   `endedRun` 的合计应该接近 57（第二轮统计的 error 停点数），`absorbedByRetry` 与 `endedRun` 合起来应该等于 477。如果不一致，报告两者的差值。

## 6. 产出

在 clone 里新增 `experiments/session-review-20261107/results/verify-impl.md`，内容依次为：

1. 环境：macOS 版本、Node、npm、被验证的分支 HEAD SHA；
2. 第 2 节：可重现性结论；
3. 第 3 节：结果表，每项列出本分支和 `main` 的结果；
4. 第 4 节：smoke 结论；
5. 第 5 节：三项抽查的结果；
6. 发现的问题：现象和复现步骤，不带原文；
7. 没能验证的内容。

推送前在 clone 根目录执行：

```bash
git diff --check
python3 scripts/audit-public.py --root . --deny-term "<维护者用户名>"
```

审计 PASS 后，**只提交 `results/verify-impl.md` 这一个文件**，推到 `claude/optimistic-einstein-soq1sd`。推送后回报 commit SHA 和审计的 status 行。最后删除 `$TMPDIR/rotom-verify` 和 `$TMPDIR/m.json`。
