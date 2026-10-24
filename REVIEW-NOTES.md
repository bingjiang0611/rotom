# Design review #1–#8

## 范围与提交

- 分支：`fix/design-review`。只交付该分支，不合入或推送 `main`。
- 基线：`origin/main` = `600d5f4c40250aafda03f9fbb2b1a85fe66f1f22`；交付前 fetch 后仍为该 SHA。
- 最终实现及配套文档 SHA（本记录提交前）：`91a103ca177b2dc1b1ed9ebcff4ca4a257299ca4`。
- 实际 tgz 构建源：`52102a4052934c1d5d97430e59a332e1fe850640`。之后只改 eval 注释/README 和本记录，不改变发行包内容。
- 包含本记录的最终分支 SHA 由 `git rev-parse HEAD` 读取，并在交付回复中提供；文件不能包含其自身提交的 SHA。
- 产品版本保持 **0.1.26**。未 publish、创建 release tag、合并 PR 或覆盖活跃安装。工作在独立 clone；安装与升级检查只使用新建的隔离 HOME/prefix。
- **没有修改项目 skills 注入或其信任逻辑。**

| 问题 | 独立提交 | 结果与主要文件 |
| --- | --- | --- |
| #1 | `2b0ce3e` | 归档校验移到构建阶段；启动只承诺元数据、identity/capability/canonical path 校验。`rotom/runtime/{verify-pi-runtime,resolve-installed-pi,update-product,product-config}.mjs`、`rotom/scripts/pack-release.mjs`、`rotom/package.json`、distribution/archive tests、`docs/agent/pi-fork.md`、`CLAUDE.md`。 |
| #2 | `d6b01d0` | 在 Pi 共享本机 shell spawn 边界删除七个内部变量；覆盖默认 env 和显式 spawn-hook env，不修改宿主 env。`packages/rotom-pi/packages/coding-agent/src/core/tools/bash.ts`、`test/bash-internal-env.test.ts`、`docs/agent/internal-environment.md`。重建由 #8 提交承接。 |
| #3 | `1d57b53`；回归修复 `db172c7`、`52102a4`；文档 `91a103c` | Subagent 的工具 schema/action/证据投影移到原生 `src/extension/ephemeral-surface.ts`；Computer Use 的 schema/guideline/recovery/证据移到原生 `extensions/computer-use.ts`、`src/recovery.ts`。产品 `subagent/policy.ts` 只保留宿主发布租约及 command/shortcut 选择；`computer-use/recovery.ts` 只保留跨组件 Relay-first 策略。Ask 新增 `ask/schema.ts` 逐层断言，删除静默空对象兜底。同步 native tests、loader/ownership/publication/fixture/smoke/eval readers、manifest、lock、vendor 与文档。 |
| #4 | `5ec8680` | SoL-Pi `src/sol-pi/extensions/action-fusion/then-run.ts` 返回结构化 mutation/followup 结果；后续命令失败保留已写入事实并设置 `isError`。`rotom/extensions/coding-policy/index.ts` 只读结构字段，不解析正文。更新两侧测试、SoL-Pi dev SDK 基线、组件版本、归档及文档。 |
| #5 | `3188e6a` | `deferred-tools/register.ts` 在缺少前置工具时发出 `ROTOM_DEFERRED_PRECONDITION`，列出固定工具名。没有改变常驻工具集合、additive 加载机制或持久化标识。 |
| #6 | `9961d3a` | Provider 诊断归 Qoder 所有：`qoder/diagnostics.mjs`、`provider.mjs`、`session-policy.mjs`、`translate.mjs`；发出通用 `rotom:provider:metadata:v1` 事件。`observability/index.ts` 校验 active provider/字段边界，不含 Qoder 专有逻辑；trace 复用固定 FD，保留权限、路径身份、queue/close 有界检查。同步 tests 和产品资源清单。 |
| #7 | `19e7c5c` | `bin/rotom-launcher` 的首轮参数扫描在 `--` 停止；`runtime/launch-runtime.mjs` 删除全局 warning 吞噬。没有证据证明某条 Node warning 必须过滤，因此全部保留。新增 runtime 回归；herdr 只评估，见下文。 |
| #8 | `6f573c7`、`93f546c` | Pi fork 升为 `1.3.0-rotom.3` 并重新构建七包；同步 `FORK.json`、`fork-build.json`、runtime manifest/lock、归档摘要及 product config。更正当前组件文档、notices、history index，并新增版本漂移断言。历史发布/验证记录保留当时版本。 |

## 关键边界与兼容性

### #1：不再把启动检查称为文件完整性证明

- 维护树保留锁定 tgz；构建时显式校验摘要和源码合同，然后复制到隔离 staging 供 `npm ci` 使用，安装后删除。
- 发行包不含重复 vendor tgz。基线 `files` 列表包含 11 个 tgz，共 **15,902,366 bytes**；最终产物 vendor tgz 数为 **0**。
- `rotom update` 继续验证整个下载 tgz 的 registry SRI，不要求产物内还有 vendor tgz。已用实际最终产物执行真实 updater 安装与链接切换；registry 元数据模拟，没有向 registry 写入。
- 启动检查**不能检测任意 installed 源码篡改**，也不防范可修改本地 verifier/config 的攻击者。测试明确记录该限制，而不是宣称更强的保护。

启动测量：同一机器、Node `v24.18.0` / npm `12.2.0`、隔离 HOME，每侧 1 次 warm-up + 10 次测量。

| 命令 | 改前中位数 | 改后中位数 | 可支持的结论 |
| --- | --- | --- | --- |
| `rotom --version` | 123.320 ms | 98.185 ms | #1 改动时的 identity 快速探针约快 20.4%；不是完整启动。 |
| `rotom --help` | 964.115 ms | 964.785 ms | 最终产物对比基线 `600d5f4`，交替顺序测量，基本持平；包含 CLI identity/SDK gate 与 scoped store 路径，不是交互首 token 延迟。 |

`--help` 原始样本（ms）：

- 改前：933.24, 924.15, 961.65, 989.51, 923.61, 983.99, 919.93, 976.47, 966.58, 968.76。
- 改后：1005.30, 969.05, 933.88, 947.83, 960.04, 1004.62, 960.52, 943.90, 984.51, 984.08。

### #2：变量仍可用于宿主与显式子 Pi，不泄露到普通 shell

清理 `PI_SUBAGENTS_EXECUTION_SCOPE`、`PI_SUBAGENTS_TEMP_ROOT`、`PI_SUBAGENT_MAX_SPAWNS_PER_SESSION`、`ROTOM_VERIFIED_PI_EXECUTABLE`、`ROTOM_VERIFIED_PI_VERSION`、`ROTOM_DEFERRED_DEFAULT_SURFACE`、`ROTOM_SUBAGENT_QODER_EXTENSION`。逐项保留理由见 [internal-environment.md](docs/agent/internal-environment.md)。这是普通 shell 的配置隔离，不是 OS 沙箱，也不阻止本机用户读取文件或主动重新设置变量。

### #3/#4：原生合同和版本

| 组件 | 最终版本 | 验证/兼容边界 |
| --- | --- | --- |
| Pi 七包 | `1.3.0-rotom.3` | build/check 与实际产物身份一致。 |
| pi-subagents | `0.52.1-rotom.11` | 产品显式选择 `{ surface: "ephemeral" }`；standalone 默认保持原有宽工具面。原生选项负责工具面，产品 commands/shortcut 与宿主发布生命周期仍由组合层负责。 |
| Computer Use | `0.5.1-rotom.2` | TS 原生合同更新；重打时保留已验证旧归档的 native helper 字节/签名。未重编、安装或启动真实 helper。 |
| SoL-Pi | `0.1.0-rotom.3` | 结构化 error result 在 Pi 1.3.0 验证；旧 0.85.1 host 不尊重返回的 `isError`，不再作为该能力的支持基线。 |
| Goal | `0.54.4-rotom.8`（未变） | 审查未发现产品 wrapper 改写 Goal schema/action；仅组合 exposure，故没有无意义升版。 |

SoL-Pi 结果为 `details.actionFusion = { version: 1, mutation: "applied", followup: "succeeded" | "failed" | "skipped" }`。写入本身失败仍沿原错误路径；写后 follow-up 失败不能诱导重做写入。实际安装产物的离线 SDK 检查确认：一次 `write` 后 `exit 7`，文件只写一次、`isError: true`、结构字段仍到达 coding-policy，且未发远程请求。

### #6：诊断与写入安全

Qoder 提供的字段先在 provider 内做 allowlist/sanitization；错误路径在抛出终止 error 前发布。通用观测层保留 HTTP status 优先级和 generic error 分类，并防止跨 provider 元数据串线。FD 复用不删除路径替换、symlink、权限、关闭后拒绝 append、accepted queue drain 或有界 close 检查。测试覆盖这些行为；不声称消除了所有文件系统竞争窗口。

### #7：herdr 评估（本次不改）

硬编码的可选 `$HOME/.pi/agent/herdr-agent-state.ts` 接入仍存在。移除涉及自动启用语义、重复加载和用户安装兼容，不属于纯参数修复。建议后续由维护者明确“保留自动启用”还是“用户显式配置”，再迁到 Pi 原生用户扩展发现/配置并删除产品特判；本次按允许的评估范围结束，不引入另一个私有路径兜底。

## 验证命令与结果

除特别说明，命令在独立仓库根执行。直接运行产品/SDK 测试时清除继承的 scope，并固定本仓库 Pi：

```sh
export ROTOM_PI="$PWD/rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
export ROTOM_VERIFIED_PI_EXECUTABLE="$ROTOM_PI"
export ROTOM_TEST_PI="$ROTOM_PI"
unset PI_SUBAGENTS_EXECUTION_SCOPE PI_SUBAGENTS_TEMP_ROOT
```

下列分组有重叠，不相加为“唯一测试总数”。早期 focused 计数对应所在提交；最终 `check-personal` 覆盖最新集成树。

| 检查 | 实际命令 | 结果 |
| --- | --- | --- |
| #1 focused | `node --test rotom/runtime/{distribution,third-party-archive,update-product}.test.mjs` | #1 提交时 47 pass / 0 fail。最终 distribution/archive 另有 36/36，且通过最终综合门禁。 |
| #2 bash env | 在 coding-agent 包运行 `npx vitest run test/bash-internal-env.test.ts` | 2 pass / 0 fail；真实执行 `env`，含显式 hook 环境，并检查宿主不变。最终 tgz 安装后的同类检查也通过。 |
| #3 Subagent | `npm --prefix packages/rotom-subagents test`；`npm --prefix packages/rotom-subagents run test:sdk`；`npm --prefix packages/rotom-subagents run typecheck` | 单元 60/60，SDK 6/6，typecheck exit 0。 |
| #3 Computer Use | `npm --prefix packages/rotom-computer-use test` | 最终 `.2`：16 pass / 0 fail。 |
| #3 Ask | `node --test rotom/extensions/third-party/ask/schema.test.ts` | 2 pass / 0 fail；畸形节点拒绝、验证元数据保留、原 schema 不被改写。 |
| #3 产品 loader / archive | `node --test --test-concurrency=1 rotom/extensions/third-party/index.test.ts rotom/runtime/third-party-archive.test.mjs` | 最终 native ownership 组 19/19；另含 publication/runtime ownership 的 focused 组 34/34。 |
| #4 focused | `(cd packages/rotom-sol-pi && npx vitest run tests/action-fusion.test.ts)`；`node --test rotom/extensions/coding-policy/index.test.ts` | Action Fusion 35/35；coding-policy 2/2。 |
| #4 SoL-Pi 完整检查 | `npm --prefix packages/rotom-sol-pi run typecheck`；`npm --prefix packages/rotom-sol-pi test` | typecheck exit 0；完整测试 **166 pass / 2 fail**，原因见下。 |
| #5 deferred | `node --test rotom/extensions/third-party/deferred-tools/register.test.ts` | 11 pass / 0 fail。初始工具集合未变；最终 footprint deterministic gate PASS。 |
| #6 provider / trace | `node --test --test-concurrency=1 rotom/extensions/observability/index.test.ts rotom/extensions/qoder/*.test.mjs` | 288 pass / 0 fail。 |
| #7 launcher/runtime | `node --test --test-concurrency=1 rotom/runtime/verify-pi-runtime.test.mjs` | 最终 40 pass / 0 fail，含 `--` literal flag 与未被吞掉的 warning。 |
| #8 build | `npm --prefix rotom run build:pi` | exit 0；六批测试分别 170、42、156、95、81、415 pass，合计 3 skipped，0 fail。 |
| #8 build identity | `npm --prefix rotom run check:pi` | exit 0；builder focused tests 2/2。 |
| #8 drift/archive | `node --test rotom/runtime/distribution.test.mjs rotom/runtime/third-party-archive.test.mjs` | 最终 36 pass / 0 fail，含当前文档版本漂移断言。 |
| eval 基础设施（无模型 A/B） | `npm --prefix rotom/evals run typecheck`；`npm --prefix rotom/evals test` | typecheck exit 0；14 个 test files，98 pass / 0 fail / 1 skipped。固定上述 Pi 后执行。 |
| 最终综合门禁 | `rotom/bin/check-personal` | exit 0：主组 357/357，Qoder 265/265，Pi AI 74/74，Goal 87/87；离线 provider fixtures 与 context footprint PASS。 |
| 公共审计测试 | `python3 -m unittest discover -s scripts -p 'test_audit_public.py'` | 14 pass / 0 fail。 |
| 公开树/历史 | `python3 scripts/audit-public.py --root . --history` | PASS，0 finding。 |
| 实际 tgz 审计 | `python3 scripts/audit-public.py --artifact /private/tmp/rotom-review-artifact/bingjiang0611-rotom-0.1.26.tgz` | PASS，0 finding；启发式检查，不是任意秘密或知识产权保证。 |
| Diff | `git diff --check` | PASS。 |

负例不是只看“绿灯”：Ask 畸形 schema、缺失 deferred 前置工具、archive 缺失/篡改/symlink、trace 目标替换/权限漂移均有拒绝断言。最终安装产物还实际执行失败 follow-up，并验证已应用 mutation 仍有证据。

## 实际产物验证

仅执行一次成功的最终构建：

```sh
npm --prefix rotom run pack:release -- /private/tmp/rotom-review-artifact
```

| 项目 | 结果 |
| --- | --- |
| 产物 | `/private/tmp/rotom-review-artifact/bingjiang0611-rotom-0.1.26.tgz`（仅本地测试，未发布） |
| 文件数 / 压缩 / 解包 | 18,884 / 32,901,744 bytes / 143,782,434 bytes |
| SHA-256 | `4c7c93e26cd0cfbad27a0a86fbfb2f7571af247e6fcccf552395d4ceacd0ca36` |
| SRI | `sha512-5YiBYgWnVIIMeUC6++tM+9eClZNC4FSvl9URm9YB0S1d1W4mTd8eVhp60W2zka1ASggn7mqaXuA5u6eTSDsJIQ==` |
| 重复 vendor tgz | 0 |
| 安装文件比对 | 18,884 个 regular files 与实际 tgz 逐文件字节一致 |
| 隔离安装 | 空 HOME、独立 prefix、PATH 无全局 Pi；`npm install --offline --ignore-scripts` 安装 tgz；`rotom --version --verbose` = 产品 0.1.26 / Pi 1.3.0-rotom.3 |
| default/full smoke | `node rotom/runtime/smoke-runtime.mjs "$INSTALLED_PI" "$INSTALLED_PRODUCT"`，分别默认与 `ROTOM_DEFERRED_TOOLS=0`：均 PASS，各 2 次 faux response、0 lifecycle errors；真实 SDK/工具调度，不是付费 provider L3 |
| 升级 | registry 只读下载的 0.1.25 经 SRI 校验；隔离 npm 安装从 0.1.25 升到实际最终 tgz 成功 |
| updater | 实际 `updateRotom()` + 最终 tgz + 模拟 registry metadata，真实 npm 安装/原子链接切换/版本回读通过，旧 release 保留 |
| 已安装行为 | 七个内部 env 在真实 bash 消失、宿主保留；SoL-Pi → Pi → coding-policy 结构化失败链路通过 |
| 卸载 | 独立 prefix 的 `npm uninstall --ignore-scripts @bingjiang0611/rotom` 成功，包目录与 `.bin/rotom` 均不存在 |

## 失败、跳过与未验证项

- **SoL-Pi 两个既有失败**：`tests/install-guide.test.ts` 读取未导入维护树的 `AGENTS.md`、`CLAUDE.md`，报 ENOENT。基线 `600d5f4` 也没有这两个文件，测试源码未修改。没有为通过测试而引入禁止的 Agent 配置或弱化断言。后续若要恢复完整上游测试，由维护者单独决定这些文档如何纳入。
- **Computer Use 标准 typecheck 未通过**：`npm run typecheck` 报 `tsc: command not found`；维护树也缺少该脚本引用的 `tsconfig.json` 和 lockfile（基线如此）。使用现有 TypeScript 对新增 `src/recovery.ts` 的定向检查通过，但不冒充全组件 typecheck。恢复完整 gate 需要单独补齐维护包工具链；本次不引入猜测配置。
- **Pi 构建跳过 3 个在线测试**：1 个 Bedrock E2E、2 个 Anthropic OAuth summarization，未配置相应认证，也未获付费验证授权。eval 基础设施另跳过 1 个未配置 `ROTOM_TEST_SIDECAR` 的兼容 sidecar 检查。
- **没有真实模型 A/B、在线 Qoder、Chrome Relay、桌面输入或 native helper L2/L3 验证**。它们需要另行授权真实设备/账号/费用；上述 faux/离线结果不替代这些验证。
- 首轮 `check-personal` 的 2 个 external-CLI fixture 失败是搬迁后旧 import 导致；已在 `db172c7` 修正。随后发现 smoke 仍读旧常量，已在 `52102a4` 修正；最终完整门禁通过。两个失败 fixture writer 已确认退出，不是机器负载问题。
- eval 测试首次未固定本仓库 Pi，10 个 case 因所选旧 host 缺少 `createCodemodeExtension` 失败；固定上述当前 fork 后 98 pass / 1 skipped。没有删除测试。
- herdr 仅完成评估；#1 的完整 CLI 启动没有测得速度收益。两者均不写成已修复/已优化。

## 交付与可追溯记录

本机记录保留在 `/tmp/rotom-review-*.log`；最终综合门禁为 `/tmp/rotom-review-check-personal-pass.log`。隔离产物检查脚本和测量 JSON 位于 `/private/tmp/rotom-review-install/`，tgz 位于 `/private/tmp/rotom-review-artifact/`。这些含机器路径的运行日志不入 Git，也不随产品发布。

关键归档 SHA-256：

- Subagent `.11`：`834c462374e3491ddaf6bb62e6f95e6dc11778065bc45b127483859a0f7f4da7`。
- Computer Use `.2`：`6c401991d1854180954663621ba85cde978608b14abe7297c993f1de1fded9b8`。
- SoL-Pi `.3`：`bb352d13af8d51354aa1257277f81b4be377be95c4279dbe55e2300e152c98ab`。

推送前检查分支、暂存 diff、公开审计和待推送提交。唯一目标为 `HEAD:refs/heads/fix/design-review`，不 force-push；最终提交/推送状态以交付回复和远端 SHA 回读为准。

## 第二轮（基于 d023f69）

本轮只更新 `fix/design-review`；产品版本仍为 0.1.26。上一节的 tgz 摘要和安装结果仅属于第一轮产物，不能证明本轮代码。

### A / #6：trace 热路径

- 打开 FD 时完成目录/文件权限、uid、dev/ino 校验并缓存 FD identity。后续每条写入只做一次路径检查：并行 `lstat(parent)` 与 `lstat(file)`，对文件做一次 cached dev/ino 比对，同时检查二者的类型/权限/uid；不再 `fstat`，不做写后检查。保留两个 pathname 查询是为了及时检测父目录权限或 symlink 漂移，不能仅看文件 inode。写入仍绑定原 FD，不能消除检查与写入间的所有竞争窗口。
- 稳态每条记录从 6 次 stat-family 调用 + 1 次 write，降到 2 次 lstat + 1 次 write（这是代码路径的 Node FS 操作数，不是内核 tracing 结果）。
- `node --test rotom/extensions/observability/index.test.ts`：**28 pass / 0 fail**。保留 replacement、权限漂移、queue/close 检查；新增文件/父目录 symlink 漂移和“打开后零 fstat”断言。将新断言用于 d023f69 的旧 writer：**1 个预期失败**，观察到 4 次多余 fstat，证明该检查能抓住旧实现。
- 同机 macOS arm64、Node v24.18.0，打开 FD 后每批 2,000 条 append + flush（不含 fsync），每侧 1 次 warm-up + 10 批，交替先后顺序。`node /tmp/rotom-round2-trace-bench.mjs`：中位数 **97.911 → 39.798 μs/条**，约降低 **59.4%**。不是持久化落盘延迟或模型端到端收益。
- 原始 μs/条：改前 `[137.111,112.783,98.840,100.966,93.379,100.230,95.076,96.666,96.982,96.940]`；改后 `[38.822,40.852,42.500,39.757,39.839,46.515,41.340,37.475,38.818,37.615]`。脚本/JSON 与测试日志保留于 `/tmp/rotom-round2-*`；旧 writer 由 `git show d023f69:rotom/extensions/observability/index.ts` 提取，不是模拟旧路径。

### B / #8：fork 文档和精确漂移断言

- `packages/rotom-pi/ROTOM-FORK.md` 将“当前基线”独立成唯一一行；与 `product-config.mjs` 的版本精确相等，不再用 contains 证明当前版本。两份 fork/migration 文档补齐 `.3` 的 `06697a9` RPC settlement 修复与 #2 shell 环境剔除说明。
- `node --test rotom/runtime/distribution.test.mjs`：**27 pass / 0 fail**。新测试在改文档前 **1 个预期失败**；还拒绝“旧基线 + 别处出现新版本”、同一基线行混入版本说明、重复基线行。
- B 提交时当前基线为 `.3`；后续 C 的新源码修复依法升 fork `.4`，该精确断言随 product-config 检查 `.4`，而 `.3` 的历史条目保留。

### C / #2：补充环境边界与机制评估

- `ROTOM_PRODUCT_VERSION` 是宿主品牌/trace 元数据，加入默认与显式 hook 环境的剔除列表；过滤项从七项变八项，宿主不被修改。
- `PI_COMPUTER_USE_HEADLESS` 保留：原生 `packages/rotom-computer-use/src/config.ts` 默认 `headless:false`，环境覆盖具有公开跨进程语义。剔除会使从 bash 启动的 Pi/Computer Use 丢失后台策略；显式 `0`/`1` 都应传递。没有声称 arbitrary GUI 都能后台运行。
- 不引入 `PI_INTERNAL_ENV_KEYS`：技术上可行，但名单缺失/旧宿主/显式子 Pi/hook 覆盖都新增传播合同，保留旧名单又形成双轨。目前八项稳定名称不值得新增该协议。若多宿主确需不同名单或频繁增项，再评估显式 tool-construction 参数；理由与触发条件已写入 `docs/agent/internal-environment.md`。
- `(cd packages/rotom-pi/packages/coding-agent && ../../node_modules/.bin/vitest run test/bash-internal-env.test.ts)`：**4 pass / 0 fail**，真实 shell 覆盖八项剔除与 headless 两个值（默认、显式 hook）。
- 新源码升 fork **1.3.0-rotom.4**；`npm --prefix rotom run build:pi` 成功重建七包，六批分别 170/42/156/95/81/417 pass，0 fail、3 个原有在线 skip；`npm --prefix rotom run check:pi` 通过。manifest/lock/integrity/product-config/当前文档同步，产品仍 0.1.26，没有覆盖活跃安装。
- `node --test rotom/runtime/distribution.test.mjs`：最终 **27 pass / 0 fail**。中间忘记同步 product-config 的版本常量时为 18 pass / 9 fail；已修正，说明版本/精确基线门禁确实拒绝不一致。

### D / #3：Ask schema 漂移只关闭 continuation

- 原有结构断言保留；引入明确的 `UnsupportedAskSchemaError`，组合层仅处理该预期错误，其他异常仍抛出。漂移时原版 Ask schema/execute/result 保持不变，不附加 continuation guideline，也不武装自动续跑。后续 SoL-Pi、context-view、延迟加载器继续注册。
- 在 `session_start` 发可观测告警：有 UI 时 `ctx.ui.notify(..., "warning")`；无 UI 时发 `ROTOM_ASK_SCHEMA` warning，不直接在交互式终端写 stderr。
- `node --test --test-concurrency=1 rotom/extensions/third-party/index.test.ts rotom/extensions/third-party/ask/schema.test.ts`（固定当前 Pi、清除继承 scope）：**12 pass / 0 fail**。新增真实 SDK session 测试只替换 upstream Ask 为不兼容 schema，其余组件仍加载真实代码；断言 native Ask 可执行、无 continuation、告警一次，Computer Use/Subagent/Goal/SoL edit-write/obs_recall/search_tools 和 `/context` 均正常注册。未调用模型。

### E / #5、#7：真实交互启动与告警路由

- 用 Python PTY 启动真实 `rotom/bin/rotom --no-session`，不是 `--print`/RPC/faux session：独立空 HOME、独立 cwd、120×40 终端、只含 Node/系统命令的 PATH；分别捕获 stdout 的 ANSI 渲染与 stderr，回应终端查询，等待启动后用 Ctrl-D 退出。未提供任何模型认证或 prompt；界面显示 `No model selected`，未调用模型。
- `python3 /tmp/rotom-round2-tui.py`：默认启动正常，stderr **0 bytes**。为覆盖警告分支，用临时 `-e` fixture 调用真实 deferred 注册器，仅从前置检查视图中去掉 Subagent，不改安装包或实际工具实现。`python3 /tmp/rotom-round2-tui.py forced`：改前 **192 bytes stderr**，确认告警绕过 TUI renderer。
- deferred 缺少前置工具时改为：有 UI 用 `ctx.ui.notify(..., "warning")`；无 UI 保留 `ROTOM_DEFERRED_PRECONDITION` warning。未恢复全局吞噬 Node warnings，未改变 active tools 或兼容 state。
- 修改后强制缺失场景：stderr **0 bytes**，同一条告警可在 TUI 渲染输出中读到；最终默认启动再次验证 stderr **0 bytes**。两次都进入 raw/bracketed-paste 交互模式、显示 rotom 主界面，并以 exit 0 正常退出，无强制终止。空 HOME 触发的 fd/rg 下载提示也在 UI 输出中，不在 stderr。
- `node --test rotom/extensions/third-party/deferred-tools/register.test.ts`：**12 pass / 0 fail**，覆盖 UI notify、非 UI warning、工具集合/持久 state 不变。PTY 脚本与三份有效的 default/before/after JSON 及原始流保留在 `/tmp/rotom-round2-*` 指向的独立临时目录。最早一次注入 fixture 使用错误导出名导致启动失败，已更正后取得上述结果；不把该失败算作 TUI 告警验证。
- 验证范围是当前 macOS arm64 / Node v24.18.0 下的真实交互终端协议和 stderr，不是 OS 终端窗口的像素截图，也不保证未来任意 Node/用户扩展 warning 均不会直接写 stderr。
