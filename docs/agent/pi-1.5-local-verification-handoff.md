# 交接：在维护者 Mac 上验证 Pi 1.5.2 合并（2026-11-12）

读者是在维护者 Mac 上工作的 Agent。云端会话已把上游 Pi 1.5.2 合入 fork（`1.5.2-rotom.1`），过程和云端证据见 [Pi 1.5.2 对齐](pi-1.5-migration.md)。云端只有 Linux 容器（root、无 `fd`、受限网络），以下工作要在真实 macOS 上补齐。

**一次做完，不要每步停下来问。** 失败先自己定位、修复、重跑；做不了的写进结果文件的“待决问题”，然后继续下一步。只有第 5 节列出的情况才打断用户。完成后把结果推回本分支，由云端会话核验。

## 0. 边界（不可越过）

- 只在分支 `claude/fervent-wright-jdsxy1` 上提交和推送：先 `git pull --ff-only`，再普通 `git push`。不 force push，不 rebase 或改写已推送的提交，不合入 `main`。
- 用公开仓库 [bingjiang0611/rotom](https://github.com/bingjiang0611/rotom) 的**全新 clone**，不在本地维护仓 `dev-agent` 里做，避免私有历史进入推送。
- 不发布 npm，不运行 `install-release.sh`，不改动或覆盖正在使用的 rotom 安装和存活会话；安装验证只用隔离的 HOME 与 prefix。
- 不改这次合并的两个默认值：`cacheWarming: "streaming"` 与 Anthropic message threads 需显式开启。不放宽门禁、阈值或审计规则，不删除、跳过或弱化测试。
- 真实模型调用只在 S6，且仅当用户在本次会话里给了授权时执行。
- 结果文件只写聚合数字和命令，不写会话正文、密钥或带用户名的绝对路径（用 `~` 或 `$TMPDIR` 代替）。

## 1. 分支内容

基线 `8e1fe0c`（产品 0.2.0 冻结），之上一个提交 `3bdad05 feat(pi): merge upstream Pi 1.5.2 …`。包含：fork 源码与 8 个重建归档、runtime lock/`fork-build.json`/`product-config.mjs`、七包→八包合同、浏览器测试与 Qoder smoke 的 TypeBox 解析修正、Computer Use 审批测试夹具、三份 footprint 合同（guideline −250）、审计白名单、账本 `L-2026-11-12-pi-1-5-2-merge`、两份文档。

## 2. 准备（一次性）

```bash
git clone https://github.com/bingjiang0611/rotom.git rotom-pi15 && cd rotom-pi15
git checkout claude/fervent-wright-jdsxy1
node scripts/install-git-hooks.mjs
```

- 提交身份必须是 GitHub noreply 地址（pre-push hook 会拦，规则见 [privacy-release.md](privacy-release.md)）。在本 clone 里 `git config user.email` 设好再提交。
- Node 24+。在 `/tmp` 下工作时先 `cd "$(pwd -P)"`（见 [pi-1.4-migration.md](pi-1.4-migration.md) 的 canonical 路径说明）。
- 安装依赖（每个目录一次；命令依据 [verification.md](verification.md#依赖版本与交付)）：

```bash
(cd rotom/runtime/pi && npm ci --ignore-scripts)
(cd rotom/extensions/third-party && npm ci --ignore-scripts --omit=optional --legacy-peer-deps)
(cd packages/rotom-pi && npm ci --ignore-scripts --no-audit --no-fund)
(cd packages/rotom-subagents && npm ci --ignore-scripts)
(cd packages/rotom-sol-pi && npm ci --ignore-scripts)
(cd rotom/evals && npm ci --ignore-scripts)
```

## 3. 步骤（按顺序；每步结果写入结果文件对应小节）

每一步记录：命令、退出码、通过/失败/跳过数、与云端结果的差异。云端数字见 [pi-1.5-migration.md](pi-1.5-migration.md#验证与边界)。

### S1 fork 门禁与可复现性

1. `npm --prefix rotom run check:pi` 必须通过。
2. 在另一个临时 clone（同一提交）里跑 `npm --prefix rotom run build:pi`，比较新生成的 `rotom/runtime/pi/fork-build.json` 中 8 个 `integrity` 与已提交值。一致记为“可复现”；不一致只记录差异，**不提交**重建产物。

### S2 fork 各包全量测试（macOS）

```bash
cd packages/rotom-pi
for p in agent ai mcp codemode schema telemetry coding-agent; do (cd packages/$p && PI_OFFLINE=1 npx vitest --run) ; done
(cd packages/tui && node --test test/*.test.ts)
```

云端 coding-agent 有 25 个失败，全部归为容器条件：root 运行、无 `fd`、离线 catalog、路径过长。在 Mac 上应当消失。任何仍失败的测试：先在基线 `8e1fe0c` 的 worktree 上用同样命令对照；只在本分支失败的，按第 4 节修复。`pi-ai` 中需要真实凭据的 live 测试若被选中，记为跳过，不提供凭据。

### S3 rotom 产品门禁

1. `rotom/bin/check-personal`。云端 `rotom/extensions/third-party/index.test.ts` 的子测试全部通过，但进程不退出（基线也一样）。记录 Mac 上是否复现；复现时找出未关闭的句柄并在测试里修复，单独提交。
2. `npm --prefix rotom run test:distribution`。已知 `build-info.test.mjs` 断言版本以 `0.1.` 开头，而产品已是 `0.2.0`，基线同样失败。见 S7。
3. footprint 三个工具面都要 PASS。default 与 full 直接运行；scoped 需要先建一个 owned store，参照 `rotom/runtime/launch-runtime.mjs` 的 `initializeSubagentStore`：

```bash
PI=$(node rotom/runtime/resolve-installed-pi.mjs "$PWD/rotom")
node rotom/runtime/report-context-footprint.mjs "$PI" "$PWD/rotom"
ROTOM_DEFERRED_TOOLS=0 node rotom/runtime/report-context-footprint.mjs "$PI" "$PWD/rotom"
# scoped：ST=$(mktemp -d)，用 jiti 调 pi-subagents 的 initializeExecutionStore(ST)，再加
# ROTOM_DEFERRED_TOOLS=0 PI_SUBAGENTS_EXECUTION_SCOPE=owned-process-groups-v2 PI_SUBAGENTS_TEMP_ROOT=$ST
```

4. `node rotom/scripts/check-providers.mjs`（云端 9/9）；Goal 测试（`packages/rotom-goal`，云端 99/99）；`npm --prefix rotom/evals run typecheck` 与 `npm --prefix rotom/evals test`。
5. 组件自身测试：`packages/rotom-subagents`、`packages/rotom-sol-pi`、`packages/rotom-computer-use` 的 `test` 与 `typecheck` 脚本。这些包自带的开发期 Pi 版本可能不是 1.5.2；记录它们实际用的 Pi 版本。

### S4 打包与隔离安装

1. `npm --prefix rotom run pack:release -- "$OUT"`（`$OUT` 为空的绝对目录），再 `python3 scripts/audit-public.py --artifact "$OUT"/<tgz>`。
2. 在空 HOME、空 prefix、PATH 中没有全局 `pi`/`rotom` 的环境里，从这个 tgz 安装。验证 `rotom --version`；对安装后的 runtime 跑 default 与 full 的 public-runtime smoke 和 footprint；在 installed dist 里 grep 到 `cacheWarming: "streaming"` 和 `supportsMessageThreads: model.compat?.supportsMessageThreads ?? false`。然后卸载。步骤和要求见 [distribution.md](distribution.md)。

### S5 真实 TUI（不调用模型）

在一个临时 git 项目里，从 S4 的隔离安装启动 rotom（100×32 PTY 或真实终端），检查以下各项：
- 启动头部正常；
- `/model` 与 `/scoped-models` 以名称在前、`· id` 在后的格式显示；
- `/settings` 中 cache warming 为 streaming；
- `/login` 列表能打开（只看，不登录）；
- 退出后终端状态正常。

只记录观察结论；截图若含私人信息就不要提交。PTY 收尾超时记为 INCONCLUSIVE，不记为 PASS。

### S6 真实 Provider 冒烟（仅当用户授权）

只有用户在本次会话里明确给出 provider、模型和预算时才执行，否则整步记为“未授权，未执行”，不打断用户，继续往下做。授权后，用 S4 的隔离安装，在一个只含合成文件的临时项目里，以 print 模式完成：一次带工具调用的往返、一次 `/compact`、一次 `/tree` 分支摘要。记录 stopReason、usage 是否写入、Qoder 时 credits 是否记录或为 unknown。不重放 unknown 结果。

### S7 既有失败（单独提交，低优先级）

- `rotom/runtime/build-info.test.mjs:88` 的 `/^0\.1\./`：确认它只是没跟上 0.2.0 冻结的过期断言，再改成从 `rotom/package.json` 读取版本。若断言另有用意，不改，写进待决问题。
- `experiments/qoder-provider/catalog-refresh-smoke.mjs`：基线和本分支都在 “native compaction refresh” 之后的断言处失败。查清原因；属于产品缺陷的，写进待决问题，不在这里修。
- S3 里 `index.test.ts` 不退出的问题。

### S8 pi-schema 对第三方工具的影响

在 full 工具面（`ROTOM_DEFERRED_TOOLS=0`）上，对每个已注册工具：用 pi-schema 编译其参数 schema（`compile(schema, { coerce: true })`），不允许出现编译错误或 unresolved `$ref`。再从各组件已有测试或文档示例里取合法参数，确认能通过校验，并且强转后的值与 1.4 一致（例如数字字符串转成数字）。发现 1.5 改变了某个工具的实际入参时，写清工具名、字段和前后差异。

## 4. 修复规则

- 可以自行修复：适配 Pi 1.5 API 的测试与夹具、rotom 侧的适配代码、本次合并在冲突解决里引入的缺陷。每个修复要有一条回归：旧代码失败，新代码通过。修复按可读粒度分开提交。
- 改动 `packages/rotom-pi/**` 后必须 `npm --prefix rotom run build:pi`，并把 vendor tgz、`fork-build.json`、runtime lock 与 `product-config.mjs` 一起提交，`check:pi` 通过。只改源码、不重建，不算交付。
- 涉及 `rotom/extensions/**`、`rotom/runtime/**`、`rotom/skills/**`、`rotom/bin/**`、`packages/**` 的提交要带 trailer。修合并本身的问题用 `Ledger: L-2026-11-12-pi-1-5-2-merge`，其他用 `Ledger: none — <理由>`。只改测试、文档或 evals 的不需要。
- 被 pre-commit 或 pre-push hook 拦下时，按 hook 的提示修正，不用 `--no-verify`。文件大小豁免只覆盖已经提交的上游文件；本次新写的文件必须 ≤ 20,000 bytes。

## 5. 必须停下问用户的情况

- 修复需要改变上述两个默认值，或改变上游 1.5.2 的行为（不只是修合并缺陷）；
- 公开审计报出疑似真实凭据；
- 需要覆盖正在使用的安装、发布 npm 或改写已推送的历史。

其余情况自行处理并记录。S6 没有授权不算阻塞。

## 6. 记录与交回

- 结果写入 `docs/agent/pi-1.5-local-verification-results.md`（≤ 20,000 bytes）。内容依次为：环境（macOS 版本、CPU 架构、Node、npm）；S1–S8 每步的命令、退出码、计数及与云端的差异；本次的提交列表（SHA 与一句话说明）；待决问题，每条写明需要谁决定什么。
- 结果文件与修复一起推到 `claude/fervent-wright-jdsxy1`。最后一个提交的主题用 `docs(pi): local macOS verification results for 1.5.2-rotom.1`，方便云端会话找到。
- 不修改 [pi-1.5-migration.md](pi-1.5-migration.md) 的验证表，由云端会话核验后合并进去。
