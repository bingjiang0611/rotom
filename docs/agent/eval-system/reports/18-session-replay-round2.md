# 任务 18 · 第 2 轮（修改与自查）

## 第 2 轮修改

核验给了 4 条必须修、1 条已由 bob 决定、1 条小问题。逐条处理如下。

### 1. 工具拦截可能从第二次回放起失效（已修）

根因是 `createGenerator` 返回的闭包在每次生成结束时删掉了 scratch 目录，而同一个 generator 会被多个回放点和多次重复复用，第二回合起 `block-tools.mjs` 已经不在了。

修法：

- scratch 目录改为**每次生成**创建、`finally` 删除；产品加载留在 generator 里只做一次（那是只读的）。
- **fail closed**：拦截扩展在加载时往 `blocker.marker` 写一行 `loaded`；`openReplaySession` 建好会话后读这个文件，读不到就 `dispose` 并报错「Replay tool blocker did not load; refusing to generate.」，绝不返回可生成的对象。扩展加载错误、`bindExtensions` 错误同样直接抛。
- cwd 固定为运行器启动时建的**空临时目录**，不再使用 `--directory`（那是私有 eval 目录）。

### 2. 回放没有加载产品，两臂其实是同一个「裸 Pi」（已修）

新增 `rotom/evals/src/replay-session.ts`，直接复用 eval harness 的产品加载入口 `loadProductRuntime`（与 `pi-harness.ts` 同一个函数、同一次 Pi 身份与资源校验），并把同一套资源清单接进 `DefaultResourceLoader`：产品扩展 + 拦截扩展、产品 skills、产品 prompt 模板；provider 注册（`pendingProviderRegistrations` / `pendingNativeProviderRegistrations`）与 `modelRuntime.refresh` 也照 harness 的做法执行。

- 每臂各自调用 `loadReplayProduct({ productAgentDir })`，得到自己的扩展/skill/prompt 列表与**产品摘要**（`sha256(Pi 版本 + 资源路径)`）。
- 摘要写进每条运行记录（`productDigest`），运行器结尾输出 `arms: { candidate, baseline }`，两臂摘要不同即可自证加载的不是同一套系统。
- 会话本身仍是 `SessionManager.inMemory`，额外挂拦截扩展，`singleRequest: true`。

### 3. 模型判定一定得到 unknown（已修）

原来用 `node rotom-launcher …` 启动，而 `rotom-launcher` 是 `sh` 脚本，必然 `EACCES/ENOEXEC`。现在按 `judge.mjs` 的方式：`realpath` + `lstat` 校验普通文件 + `access(X_OK)`，然后**直接执行 launcher**，prompt 走 stdin，参数沿用 `JUDGE_BASE_ARGS`（其中 `-p` 已经表示从 stdin 读，去掉了多余的 `-`）。判定用的临时 cwd 用完删除，只在「进程终止无法确认」时保留。

### 4. 补离线端到端测试（已修，进 CI）

新增 `rotom/evals/test/replay-e2e.test.mjs`（node:test，`node --test rotom/evals/test/replay-e2e.test.mjs`，CI 在装好 runtime 之后单独一步执行）：

- 用既有 `eval-fixtures.mjs` 造合成会话，取**两个** assistant 消息作为两个回放点；
- faux provider 的回复是「文本 + 一次 `bash: touch <SENTINEL>` 工具调用」；
- 2 个回放点 × 2 臂 × 重复 2 次 = 8 次生成，逐条断言：判定为 pass、记录里有这次工具调用意图、只记录一条 assistant 消息；
- 断言 `SENTINEL` **没有**被创建（`stat` 报 ENOENT）；
- 断言两臂的 `productDigest` 不同（baseline 少声明一个资源）；
- 模型判定路径单独一条：用一个自己写的可执行 stub 当 launcher（`mode: 0o700`、带 shebang），断言判定真的执行了这个文件本身（不是 `sh -c`，否则收不到 marker）、`--model` 传到了子进程、prompt 走了 stdin、并且解析出 `pass`。**为什么不用真 launcher**：首次 CI 试跑时这条用例挂住 14 分钟被取消（真 launcher 需要隔离 HOME 和网络守卫才肯离线退出，见 `eval-launcher-check.mjs`），本地真 launcher 那次是通过的（12s，verdict 正常、无 `ENOEXEC`）。真 launcher 的离线行为仍由 CI 里既有的 `eval-launcher-check.mjs --faux` 一步覆盖；判定侧只要证明「直执行 + stdin + 参数」即可，属于本次改动的责任边界；
- 拦截扩展加载失败时报错并拒绝生成（把 marker 路径占成目录制造写失败）。

本地结果：3 项全部通过（8 次生成 + 判定 + 拒绝路径）。CI 结果见提交后的 Actions。

### 5. 看板路由（已接线）

按 bob 2026-10-27 的决定：`scripts/check-staged-file-size.mjs` 新增具名列表 `legacyOversizedFiles`，**只放** `rotom/extensions/observability/dashboard.mjs` 一个文件；`maxBytes` 未改，没有目录或通配。测试补充：该文件 90 KB 可提交；`dashboard-copy.mjs`、根目录 `dashboard.mjs`、`dashboard.mjs.keep` 仍被拒；把它 `git mv` 到别的路径后仍被拒。

接线六个路由：`GET /api/eval/replay/cases`、`GET /api/eval/replay/status`、`POST /api/eval/replay/case`、`POST /api/eval/replay/case/delete`、`POST /api/eval/replay/run`（202）、`POST /api/eval/replay/cancel`。沿用现有安全约束：Bearer token（`timingSafeEqual`）、Host 校验、POST Origin、`application/json`、body 体积上限、并发上限；`replay: false` 时返回 409 `replay_unavailable`。进程在 `close()` 里统一清理。

`replay-api.test.mjs`（2 项）覆盖：未授权 401、未知路径 404、非 POST 405、错误 content-type 415、跨站 Origin 403、建点/列表/运行 202/取消未知 run/非法请求 400/删除/再次列表为空，以及关掉服务后 409。

Playwright 冒烟（`eval-ui-smoke.mjs`，合成数据 + 假运行器）：把会话标为不满意 → 时间线上出现「设为回放点」→ 填期望行为保存 → 列表出现该点 → 填入模型运行 → 确认弹窗 → 「回放结束 · 已运行 1 / 1」→ 重复 3 次再跑，看到「已运行 1 / 3」→ 取消 → 「回放已停止」→ 删除 → 回到空状态。PASS，0 页面错误。

顺带修的两个 UI 问题：时间线事件此前不带 `entryId`（无法定位回放点），现在 `service.mjs` 的 user/assistant 事件带 `entryId`（tool 事件不带，因为回放点只允许 assistant）；保存标注后详情页会重新渲染，否则新标注的失败会话看不到回放按钮。

### 6. 判定词表共用（未做，需要决定）

`nonempty-handoff` 仍在 `.mjs`（浏览器可用）里，合成题的 `offersNextStep` 在 `.ts`（vitest）里。合并需要一个两边都能导入的纯常量模块（例如 `rotom/evals/src/handoff-words.json`），并让 `.mjs` 侧同步读取；这会改动浏览器端脚本的打包方式（当前 `evalScript` 把函数序列化，不能带 import）。属于结构调整，超出本轮范围，记在这里。

## 第 2 轮自查

1. 测试与审计：做了 —— `node --test`（dashboard/eval/judge/replay/replay-api）63 项、`check-staged-file-size.test.mjs` 12 项、eval 套件 11 文件 282 项、`replay-e2e.test.mjs` 3 项、typecheck 通过、`audit-public.py` PASS 0、`git diff --check` 干净。
2. 判定：做了 —— 三条规则本轮未改；新增的 `productDigest` 只记录不参与判定；`unknown` 仍单独计。
3. 用例与 fixture：做了 —— E2E 用的合成会话来自既有 `eval-fixtures.mjs`；faux 扩展只存在于测试临时目录，不进仓库；断言里检查的是文件系统副作用（`SENTINEL` 不存在），不是措辞。
4. 计数与汇总：做了 —— 进度 `done` 取结果数组长度；E2E 断言每个组合各生成一次（8 条记录），重复不串。
5. 脱敏与隐私：做了 —— 判定输入仍先 `redactSecrets`；回放点、运行记录只写 `~/.rotom/evals/replay/`（0700/0600）；E2E 用合成会话，不读真实会话；未改 trace 合同（新增的 `entryId` 在 eval API 的事件里，不属于 trace wire 格式）。
6. 真实模型运行：不适用 —— 本批明确不跑真实模型；faux provider 离线。

## 第 2 轮 L1/L2/L3

- **L1（已做）**：上述单元/集成测试、CI 单测步骤、审计、体积守卫测试。
- **L2（已做，离线）**：真实产品运行时 + faux provider 的端到端回放（工具不执行、只一条消息、两臂产品不同、launcher 直执行）；Playwright 冒烟覆盖面板全流程。
- **L3（未做）**：没有真实模型、没有真实会话回放。真实 provider 下的判定质量、长上下文截断后的行为仍未知，需要 bob 在后台首次触发。

### 7. CI 两轮失败的原因（都已处理）

第一轮（`40471906954`）：E2E 第 2 条用例挂在「真 launcher」上，14 分钟后被 15 分钟的 job 上限取消。原因是真 launcher 在 CI 的空 HOME 下不会自己退出（它需要隔离 HOME + 网络守卫才肯离线结束，见 `eval-launcher-check.mjs` 的做法）。改成 stub launcher（见上），真 launcher 的离线行为仍由 CI 既有那一步覆盖。

第二轮（`40474263432`）：三条用例全部 PASS，但 `node --test` 进程不退出，又在 15 分钟被取消。查实是产品运行时留下的 `fs.watch`：`after()` 现在打印 `leftover handles: FSEventWrap × 8`（两臂各 4 个，来自产品资源/设置目录的监视）。这类句柄对真正的运行器无影响（`session-replay.mjs` 是独立进程，跑完即退），只影响「在同一进程里反复加载产品」的测试宿主，所以处理方式是：`after()` 报告剩余句柄，仅在存在非管道句柄时短暂延迟后结束测试进程；断言一条没减。同时在测试文件顶部设 `ROTOM_QODER=0`、`ROTOM_OBSERVABILITY=0`，让这条离线用例不再触网、不写 trace。

第三轮（`40476428536`）：全部 success，含第 9 步这条 E2E。

**留作已知限制**：产品运行时不在 `close()` 后释放 `fs.watch`。如果以后有「长驻进程里多次加载产品」的需求（例如看板进程内直接跑回放），需要先给 `loadReplayProduct` / `openReplaySession` 加真正的 dispose；当前回放走独立子进程，所以不构成功能缺陷。没有改产品代码去动这些 watcher，是因为根因在 Pi 的资源加载生命周期，属于跨边界改动。
