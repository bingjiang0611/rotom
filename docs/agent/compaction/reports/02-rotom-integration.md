# 任务 02 执行报告：实现及本地验证完成，待规划者核验

## 结果与边界

基于 `b358d3c1` 完成 A→B→C→D：修复观测影响决定的问题，打包并接入 `sol-pi@0.1.0-rotom.4`，新增默认关闭的 `ROTOM_COMPACTION_OFFLOAD` 覆盖，更新文档。组件专项与第三方集成通过；组件全量仍只有任务已知的 2 个安装指南失败。完整/deferred、卸载开/关四组本地 public loader smoke 均 PASS。

没有调用真实模型、修改 Pi fork/observability/Context Layers、提升 rotom 产品版本、执行 pack:release、发布 npm 或更新活跃安装。版本升级仅属于 SoL-Pi 组件。独立 worktree 中安装的运行时依赖只用于本地验证。

## 改动文件

| 文件 | 说明 |
|---|---|
| `packages/rotom-sol-pi/src/sol-pi/extensions/observation-pack/offload.ts` | ledger/TUI best-effort，不改变确认推迟；增加 root+id 投影验证缓存，session_start/session_tree 清空。 |
| `packages/rotom-sol-pi/src/sol-pi/constants/copy.ts` | 英文推迟文案，配合既有 formatSavingsCount 显示千分位数字。 |
| `packages/rotom-sol-pi/tests/compaction-offload.test.ts` | 更新 ledger 失败回归，确认成功追加和 stale 检查仍取消摘要。 |
| `packages/rotom-sol-pi/tests/compaction-offload-observability.test.ts` | 新增 6 个针对观测、英文提示、缓存命中/失效/隔离的测试。 |
| `packages/rotom-sol-pi/docs/configuration.md` | 同步观测 best-effort 和投影缓存限制，避免声称每次都验证对象。 |
| `packages/rotom-sol-pi/package.json` | 组件版本升至 `0.1.0-rotom.4`，无新增依赖。 |
| `packages/rotom-sol-pi/package-lock.json` | 只同步根版本与 packages 根条目版本。 |
| `packages/rotom-sol-pi/UPSTREAM.md` | 记录 .rotom.4、默认关闭、依赖、unknown 语义；修正验证依赖说明为实际 Pi 1.3.0。 |
| `rotom/extensions/third-party/vendor/sol-pi-0.1.0-rotom.4.tgz` | 新归档，全部 37 个文件与当前组件源码逐字节一致。 |
| `rotom/extensions/third-party/vendor/sol-pi-0.1.0-rotom.3.tgz` | 删除已被替代的归档；更新引用后没有测试或现行文档依赖该归档路径。历史版本说明仍保留。 |
| `rotom/extensions/third-party/vendor/README.md` | 更新选定版本、摘要、大小、测试数和默认关闭说明。 |
| `rotom/extensions/third-party/package.json` | 精确选择 sol-pi 0.1.0-rotom.4。 |
| `rotom/extensions/third-party/package-lock.json` | 更新根依赖、安装版本、相对归档路径与 integrity，未改变其他依赖。 |
| `rotom/runtime/product-config.mjs` | 同步 version/integrity/archive 三项身份合同。 |
| `rotom/extensions/third-party/sol-pi.ts` | 最终配置之后处理环境变量；Observation Pack 关闭时开启请求只提示、不使启动失败。 |
| `rotom/extensions/third-party/index.test.ts` | 保留既有断言，补默认关闭和环境变量七种场景；测试后还原环境。 |
| `docs/usage.md` | 修正旧 .rotom.2 版本说明；新增不超过 15 行的压缩卸载说明和配置优先级。 |
| `CLAUDE.md` | 只在第 3 节既有 SoL-Pi 句子补充默认关闭、开启变量及收益待实测。 |
| `rotom/THIRD_PARTY_NOTICES.md` | 第三方版本表同步 .rotom.4，许可证不变。 |
| `docs/agent/compaction/reports/02-rotom-integration.md` | 本报告。 |

`docs/agent/verification.md` 没有需要同步的 SoL-Pi 版本或测试数，未修改。看板和任务说明未改，accepted 仍由规划者裁定。

## A：三处修复的证据

1. **观测不改变决定**：append 正常返回后立即清除 unknown 标记。ledger 的每次调用独立捕获失败；TUI 通知另行捕获失败，均只记录固定的一行错误。`ledger failure after append or stale check preserves a confirmed defer` 与 `TUI failure does not undo a confirmed defer or stale cancellation` 验证 `{cancel:true}` 和后续 stale 取消；投影 ledger 失败也不隐藏已验证的指针。原 ensureStored/真实 EISDIR 失败用例仍通过，不重放追加。
2. **英文与数字格式**：文案为 `compaction deferred, ~… context tokens offloaded`，调用已有 formatSavingsCount；`TUI formats the English offload estimate with grouped digits` 验证真实通知内容包含英文和 `~N,NNN` 格式。
3. **进程内验证缓存**：键为 `${root}\0${id}`。采用任务允许的**删除文件法**：第一次投影验证成功后删除对象，第二次仍返回相同占位符；分别触发 session_start/session_tree 后，下一次投影发现缺失而保留原文。另有 runtime root 隔离用例，不能借用另一会话的缓存。

**缓存边界**：外部删除/篡改发生在首次验证之后、清缓存之前时，投影可能仍返回指针，obs_recall 可能失败。此行为是本次缓存方案的明确限制，已同步组件文档；不再声明每次投影都会重读对象。未测实际 I/O/速度收益。

## B：最终归档

| 项目 | 值 |
|---|---|
| 路径 | `rotom/extensions/third-party/vendor/sol-pi-0.1.0-rotom.4.tgz` |
| 文件数 | 37 |
| 压缩大小 | 53,232 bytes |
| 解包大小 | 181,755 bytes |
| SHA-256 | `25dfa84e37b39a2ab386b5667a6146718f0169c8ab7951dc1d17a874779d0527` |
| SHA-512 SRI | `sha512-fGLoYQmNI3vqr3w7OTjepvx/SYvhyBMRwdSgkZLt2sdij9fLxXJBn5G5PYtijc/5H97xdxh884c3o8yJsdwBQA==` |

实际生成命令（组件目录）：`npm pack --json --pack-destination ../../rotom/extensions/third-party/vendor`。只生成过一次最终归档，没有复制维护者 node_modules。npm 12 的 JSON 按包名组织，而不是旧版数组；第一次读取打包结果的辅助脚本因此失败，已直接读取现有归档和 JSON 修正取值，**没有重跑 npm pack**。

独立检查：归档 SHA-512 与 package/lock/product-config 三处一致，installed package 版本也是 .rotom.4；tarfile 遍历实际 tgz，37 个文件全部与源码字节一致。实际 tgz 公共审计 PASS（38 项，含归档本身；0 findings）。

## C：环境变量实际行为

始终先加载合法的默认/用户配置，再覆盖 compactionOffload；既有配置类型与依赖关系校验不放宽。

| 值/配置 | 实际行为 | 测试名/断言 |
|---|---|---|
| 默认、无配置文件 | false | `offload defaults off` |
| 未设置 | 保留用户 true | `unset preserves user true` |
| 空串 | 保留用户 true | `empty preserves user true` |
| `1`，rotom 默认 Observation Pack 开启 | true | `1 enables rotom default` |
| `1`，用户关闭 Observation Pack | false，单行提示，不抛错 | `1 with Observation Pack disabled stays off` |
| `0`，用户配置 true | false | `0 overrides user true` |
| 非法值 | 不覆盖、单行提示 | `invalid value preserves user true` / `invalid value preserves rotom default false` |

## 验收命令与结果

环境：macOS，Node v24.18.0，npm 12.2.0；组件依赖为锁定 npm Pi 1.3.0，产品运行时依赖为仓内归档安装的 Pi 1.4.0-rotom.2。

| 命令 | 结果 |
|---|---|
| 组件目录 `npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always` | 退出 0，167 包；现有 8 项 npm 审计提示（6 moderate、2 high），未运行 audit fix。 |
| `npm run typecheck` | 退出 0。 |
| `npx vitest run tests/compaction-offload.test.ts` | 退出 0，32/32。 |
| `npx vitest run tests/compaction-offload-observability.test.ts --reporter=verbose` | 退出 0，6/6。 |
| `npm test` | 退出 1，204 passed / 2 failed，共 206 用例、21 文件；仅已知 install-guide 的 AGENTS.md/CLAUDE.md 缺失，无新增失败。 |
| `npm pack --dry-run` | 退出 0，37 文件。随后实际 npm pack 的摘要见上表。 |
| 第三方目录 `npm ci --ignore-scripts --omit=optional --legacy-peer-deps --replace-registry-host=never` | 原命令遇 npm 12 `EALLOWREMOTE`：本机默认 registry 与 lockfile 的官方 registry 不同。未修改全局配置或放开 allow-remote。 |
| 同一安装命令追加 `--registry=https://registry.npmjs.org` | 退出 0，14 包、0 vulnerabilities，保留 lockfile 地址和原安全设置。 |
| `node --experimental-strip-types --test --test-concurrency=1 index.test.ts`（设置下述临时运行时路径） | 退出 0，18/18，包含七个环境变量子用例；没有换测试入口。 |
| rotom 目录 `shasum -a 256 extensions/third-party/vendor/sol-pi-0.1.0-rotom.4.tgz` | 与上表一致。 |
| `node -e "const c=require('node:fs').readFileSync('runtime/product-config.mjs','utf8');console.log(/sol-pi.*rotom\\.4/.test(c))"` | 输出 true；此外做了真实摘要及版本等值断言，不只依赖 regex。 |
| 仓库根 `git diff --check origin/main...HEAD` | 退出 0；同时检查工作树/暂存区，提交后再检查此命令。 |
| `python3 scripts/audit-public.py --root .` | 退出 0；tracked-tree PASS，7,802 项、0 findings，包含新源码、测试、归档及本报告。 |

为验证独立 worktree，在 `rotom/runtime/pi` 执行了 `npm ci --ignore-scripts --omit=optional --registry=https://registry.npmjs.org --replace-registry-host=never`，安装 120 包；现有 2 项审计提示（1 moderate、1 high），未改锁文件或源码。

### Package identity / footprint：L1 与本地 L2

命令中的 `PI` 指本 worktree 的绝对路径 `rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`，`PRODUCT` 指其 `rotom/` 目录。测试使用隔离临时 HOME，不接触登录凭据或活跃安装；第三方测试用 `ROTOM_PI=$PI ROTOM_VERIFIED_PI_EXECUTABLE=$PI`，清空 Subagent execution-scope/temp-root，按文档使用 test-concurrency=1。

| 检查 | 实际命令与结果 |
|---|---|
| Package identity、归档、footprint/deferred 单测 | `node --experimental-strip-types --test --test-concurrency=1 rotom/runtime/third-party-archive.test.mjs rotom/runtime/verify-pi-runtime.test.mjs rotom/runtime/context-footprint.test.mjs rotom/extensions/third-party/deferred-tools/register.test.ts`：73/74 通过。package identity 检查本身通过；1 个 launcher 用例受测试环境污染，见下段。 |
| 失败用例定向复验 | 移除本次额外设置的 PI_CODING_AGENT_DIR，保留隔离 HOME，运行 `node --experimental-strip-types --test --test-concurrency=1 --test-name-pattern='launcher 保留业务 cwd' rotom/runtime/verify-pi-runtime.test.mjs`：1/1 通过；未改生产代码或测试。 |
| Public loader + footprint | 下述四组均由真实产品公开 loader / createAgentSession 加本地 faux provider 执行；全部 PASS。 |

首次 identity 套件的失败是本执行者同时设置 `HOME` 和 `PI_CODING_AGENT_DIR` 造成的：该用例在自己的临时 HOME 下写 computer-use 用户配置，但继承的 PI_CODING_AGENT_DIR 将查找指向另一个目录，错误地注入默认 headless=1。读过失败断言与 launcher 调用后移除这个测试环境变量，单项复验通过。**没有把第一次 73/74 写成完整套件 74/74，也没有为通过测试修改实现。**

public loader 命令（仓库根，四组分别运行）：

```sh
# 使用隔离 HOME；unset PI_CODING_AGENT_DIR；清空 PI_SUBAGENTS_EXECUTION_SCOPE / PI_SUBAGENTS_TEMP_ROOT
ROTOM_DEFERRED_TOOLS=<1或0> ROTOM_COMPACTION_OFFLOAD=<0或1> \
  node rotom/runtime/report-context-footprint.mjs "$PI" "$PRODUCT"
```

此入口实际调用 `rotom/runtime/smoke-runtime.mjs`，不只是静态计算 schema。

| deferred | offload | gate | 活跃工具 | 归一化 schema bytes | 模型调用 |
|---|---|---|---:|---:|---|
| 1 | 0 | PASS | 28 | 26,425 | faux 2、真实 0 |
| 0 | 0 | PASS | 29 | 38,506 | faux 2、真实 0 |
| 1 | 1 | PASS | 28 | 26,425 | faux 2、真实 0 |
| 0 | 1 | PASS | 29 | 38,506 | faux 2、真实 0 |

## 未验证与限制

- 组件/配置/身份检查属于 L1；public loader + 安装归档的实际本地 AgentSession smoke 属于无真实模型的本地 L2。均不是 L3。
- 未测真实会话的摘要等待、recall 频率、任务成功率或费用；默认仍关闭，任务 03 需另行授权。footprint 字节数不是 provider token 或收益。
- 没有在当前用户安装中升级或实际操作 TUI；通知内容由单测验证。cache 的外部删除窗口见 A。
- 本次没运行完整 check-personal / 发行 gate；按任务只执行受影响的第三方、identity、footprint 和 public loader 检查。

## 大文件门禁例外与最终状态

曾暂停：任务要求 CLAUDE 只改单点，但当前 CLAUDE.md（27,143 bytes）、docs/usage.md（31,040 bytes）、index.test.ts（28,560 bytes）均已超提交门禁 20,000 字节上限。用户随后明确授权：**“这次例外 可以不用拆分”**。

据此不拆分、不扩大重构；仅本次提交对这三个路径采用临时大小豁免，其他 staged 文件仍按原门禁检查。仓库原钩子和长期 Git 配置不修改。提交仍只到 compaction/offload-first，不改写历史、不 force push、不推 main。

当前树审计 PASS（7,802 项、0 findings），实际归档审计 PASS。共享维护仓的 --history 会遍历所有本地 refs，包含不属于本任务的旧私有维护历史，不能用其结果代替公开目标的检查。因此从 GitHub 以 --single-branch --no-tags 独立克隆任务分支，仅重放本次 staged diff；没有携带维护仓其他 refs。

**公开副本全历史审计 BLOCKED，既有 6 项已获用户明确接受**：`python3 scripts/audit-public.py --root . --history` 检查 256 commits、38,784 项、715,079,143 bytes，跳过账本内 198 个已审计归档，发现 6 项：已公开基线提交 `ba9288fd2b2d`、`e6da2afa5739`、`b358d3c15964` 各有 non-noreply-author 与 non-noreply-committer。报告不回显邮箱值；没有本次文件/归档的新增命中。这不是完整历史 PASS，也未修改扫描规则或增加邮箱例外。

文件大小例外没有自行扩张为隐私例外。执行者另行询问后，用户明确选择 **“接受既有问题继续”**：只接受上述三个已公开提交的 6 项身份命中，不改写历史、不放宽扫描规则；新提交使用 GitHub noreply 身份，只推任务分支。历史审计结果仍诚实保留为 BLOCKED，不写成 PASS；提交后复核不得新增命中。

独立 worktree、公开交付副本、隔离依赖和本机聚合验证日志保留；没有后台服务、真实模型任务或发行版安装。本次提交从干净公开副本产生，暂存树与通过验证的 worktree 完全一致，不携带维护仓其他 refs。下一步 owner 为规划者：核验任务 02 并裁定 accepted，再安排任务 03。
