# rotom · verification

按任务读取相关小节，不要求每次全文读取。代码块与行内路径均相对仓库根；命令执行前核对实际文件和 package scripts。当前根指南见 [CLAUDE.md](../../CLAUDE.md)。

## 测试约定

- GitHub Actions `Evals L1` 覆盖 eval 工具及 observability dashboard / Eval API 的 L1，不代表全量测试或 L2/L3 通过；workflow 为 `.github/workflows/evals-l1.yml`。
- 使用 Node 内置 test runner 的模块按现有 `*.test.ts` / `*.test.mjs` colocate；保持 `--test-concurrency=1` 的 process/runtime 确定性。
- 外部 CLI 使用隔离 fake executable，断言精确 argv、调用次数、timeout、output budget 和 readback；不要执行真实外部写操作作为普通单测。
- trust/identity/path 测试同时覆盖合法、symlink、越界、漂移、错误版本和命令字符串拒绝。
- async/runtime 修复测试 abort、timeout、late result、process descendant 和 shutdown，不用固定 sleep 掩盖竞态。
- Browser 代码 L1 与真实 Chrome L2/L3 分开记录；付费/真实外部 eval 需要用户明确授权。
- 结构性证据（代码存在、文档声明、L1 静态检查）不等于运行时证据。文档写着「支持」、代码里有对应分支，都不能证明这条路径在真实运行时成立。因此 L1（静态/单测）成立时不得声称 L2/L3（真实设备、真实外部、付费 A/B）已通过；对外声明「已启用」以运行时合同、对应层级测试和真实重放为准。
- eval 的 `.eval/`、node_modules、trace、临时 HOME 和本机安装不是提交内容。

## 质量规则与 Review

本节承接根指南的代码质量规则，不修改产品 system prompt。先复用已有结构和检查；不要为同一合同再增加一份提示词或 registry。

### 已自动约束的合同

| 合同 | 执行入口与证据 | 范围 / 合法例外 |
|---|---|---|
| 不覆盖全局 Node warning；写入阶段不读取展示文本 | `npm --prefix rotom/evals run check:quality`：TypeScript AST 扫描真实入口，含错误、正确和合法例外样例 | 入口固定于 `src/quality-contracts.ts`；支持字面属性访问，不做任意别名/跨函数数据流。测试 mock、展示层读取 content 合法；不是安全沙箱 |
| 当前版本精确匹配，而非历史段落包含版本 | `rotom/runtime/distribution.test.mjs` 已有唯一“当前基线”与配置精确相等的正反例 | 历史版本说明可以保留，不全局禁止旧版本字符串 |
| 自有 fork 的工具合同不被 wrapper 二次定义 | `rotom/extensions/third-party/index.test.ts` 比较真实 native/product loader 的 schema、描述、guideline | 产品可选择 ephemeral surface、exposure/defaultActive；`launch_browser` 的 Relay-first 描述是明确的组合层例外，schema 不例外 |
| 内部环境不进入普通 bash；公开策略仍继承 | `rotom/runtime/quality-boundaries.test.mjs` 执行安装的真实 bash 工具，覆盖默认和 spawnHook 环境、headless=0/1、调用方环境不变 | 变量用途以 [内部环境](internal-environment.md) 为准，不按 `PI_*` / `ROTOM_*` 前缀一刀切删除 |
| 可选 Ask 适配失败不影响其余组件 | `rotom/extensions/third-party/index.test.ts` 对三种 schema 漂移加载真实 session，调用原版 Ask 并检查后续组件 | 只降级已识别的 schema 不兼容；未知异常不静默吞掉 |
| 启动告警走交互渲染，不破坏 stderr | `rotom/runtime/quality-boundaries.test.mjs` 在隔离 HOME 下启动真实 rotom PTY，覆盖正常和缺失前置工具场景 | 无模型调用；需要 POSIX + Python 3，Windows 明确 skip；不证明桌面视觉效果或运行期间所有告警路径 |

边界测试已进入 `rotom/bin/check-personal`。质量 AST 和合成任务的验收器也随 eval 的默认 `npm test` 执行。定向入口（仓库根，Node 24+，先按现有安装说明准备依赖）：

```bash
npm --prefix rotom/evals run check:quality
npm --prefix rotom/evals run typecheck
ROTOM_PI="$(node rotom/runtime/resolve-installed-pi.mjs "$PWD/rotom")" \
node --experimental-strip-types --test --test-concurrency=1 \
  rotom/runtime/distribution.test.mjs \
  rotom/runtime/quality-boundaries.test.mjs \
  rotom/extensions/coding-policy/index.test.ts \
  rotom/extensions/third-party/index.test.ts \
  rotom/extensions/third-party/deferred-tools/register.test.ts
```

新增入口绕开上述固定扫描范围时，先扩展目标文件与正反例；需要别名或跨模块判断时再升级分析，不宣称当前检查能覆盖它们。版本来源仍是 `product-config.mjs`，不新增版本清单。

### 仍需 Review 判断

- **需求与抽象层**：最小实现必须满足完整需求，不以演示、占位或缩减验收替代。先复用，再考虑标准库和现有依赖；自有组件合同放源码，组合策略才留 wrapper。新增 registry/lifecycle 必须说明真实调用方和必要性。
- **限制与失败边界**：新增限制、校验、重试须有合同、失败证据或明确安全理由。identity、路径、授权失败必须拒绝；可选增强失败只影响增强本身，并保留可观测诊断。`unknown`、unavailable、partial、blocked 不压成成功或失败。
- **调查与授权**：查到能区分竞争解释的证据，不停在猜测。已有授权内可继续的任务继续；明确请求覆盖一般偏好，但不扩大到新的外部写入、费用、权限或数据损失。需要决定时指出缺少什么、由谁处理，不反复询问同一已定事项。
- **验收与成本**：关键行为至少一个旧错误会失败的反例，不能改弱测试迁就实现。性能改动比较实际成本并保留安全检查。历史模式的合成任务见 [评测说明](../../rotom/evals/docs/coding-evals.md#历史纠正回归quality-regressionsevalts)；验收器通过不代表模型行为改善，真实模型运行另需授权。
- **表达**：维护和用户边界用中文，identifier 与稳定合同保持英文；注释解释原因、信任边界和失败模式。交付区分实现、验证、提交、推送、安装；剩余事项给责任人和动作，不重复机械规则或用简洁掩盖未知。

## 验证与交付

默认选择能证明本次改动的最小验证，不无条件运行真实 Chrome、外部平台 L3、付费模型 A/B 或完整 container eval。

### 纯文档或 Agent 配置

```bash
git diff --check
```

同时核对 Markdown、本地路径、命令、数量、版本和 L1/L2/L3 表述。纯维护文档不运行 runtime 全量 gate。

### 普通代码改动

开发中运行受影响测试。涉及常规产品组合时，日常快速门是：

```bash
rotom/bin/check-personal
```

它覆盖 process tree、context footprint/discovery、五个 extension 的核心定向测试、第三方组合与当前工具面。对小改动可先直接运行受影响的 `*.test.ts` / `*.test.mjs`；交付前至少执行受影响测试、必要 runtime smoke 和：

```bash
git diff --check
```

### 公开前隐私检查

```bash
python3 -m unittest discover -s scripts -p 'test_audit_public.py'
python3 scripts/audit-public.py --root . --history
```

`--history` 对准备上传的仓库运行，不把原私有维护历史冒充已清理。可用 `--deny-term` 传入需额外检查的私有标记；不要把真实组织信息写进公共规则文件。默认树扫描及 npm tgz 扫描由 `pack:release` 接入；完整历史检查仍是 Git 发布前独立门禁。

### 扩大验证的条件

- launcher、resource、public contract：追加 `verify-pi-runtime.test.mjs` 与 `smoke-runtime.mjs`。
- Provider 离线维护入口：`npm --prefix rotom run test:providers`，由 `check-personal` 接入；固定源码单测与原生 SDK smoke、隔离 HOME/Node 网络、输出版本绑定报告。范围和 `ROTOM_PI` 显式覆盖的证据边界见 [Provider 离线验证](provider-verification.md)。Pi AI 原始 `npm test` 包含 live 测试及模块加载期 OAuth 解析，不作为安全离线入口。
- Qoder：按本次受影响合同选择下表中的定向测试和离线 smoke；仅跨多个合同、高风险合入或发布时运行完整矩阵。当前模型 key 从产品声明读取；历史覆盖数量留在 `experiments/qoder-provider/` 报告，不作为每次任务的固定配额。真实请求须已有目标、档位、预算和外部权限的明确授权，并共享有界 ledger。

| Qoder 改动范围 | 对应检查 |
|---|---|
| 目录 / 认证 / 注册 | 受影响的 `rotom/extensions/qoder/*.test.mjs`；`oauth-smoke.mjs`、`catalog-refresh-smoke.mjs`、`catalog-sdk-smoke.mjs --offline <受影响 key>`；启用开关变化才检查默认/`1`/`0` |
| 流式输出 / 工具续轮 | 受影响单测及 `smoke.mjs`、`session-smoke.mjs`、`stream-smoke.mjs` |
| 历史 / 压缩 / effort | `history-handoff-smoke.mjs`、`stream-shape.test.mjs`、`long-session-smoke.mjs --offline ultimate` 中的受影响路径 |
| Credit / 额度 | `credits-session-smoke.mjs --offline` 及 `live-budget`、`probe-wire`、`tui-net-observer` 相关单测；真实 AgentSession/CLI-PTY 验收另按已有授权执行，`credits-tui-smoke.py` 保持禁止模型 dispatch |
| 图片 / 大上下文 | 下述图片与上下文专项检查，仅在对应改动时运行 |

维护面 smoke 位于 `experiments/qoder-provider/`，执行前核对脚本及参数。CLI/PTY 检查不冒充桌面视觉验收；长测保留 Pi 原生 reserve 与管理窗口，不通过抬高容量掩盖溢出。已授权真实 effort/长测及源码/安装分别验收的命令按该目录现有说明执行。

- Qoder 三模型图片/大上下文：另跑 `input-budget-smoke.mjs`（真实 SDK/假上游）、`vision-capacity-smoke.mjs --offline <key>`；已授权的源码/实际安装均跑 `vision-capacity-smoke.mjs --product <key>`，可用 `ROTOM_QODER_VISION_ROWS=12600` 验证大输入与四张图片共存，以及 `large-context-probe.mjs --live <key> 12600 250000`。后者设置 `ROTOM_QODER_PROBE_PRODUCT_ROOT` 才是产品路径；断言真实 input≥250K、400K selector、线上的4096，并保留原生272K管理窗口/安全和压缩余量；≥272K 单请求输入是上游能力记录，不再是产品窗口断言。Ultimate固定COSY还须旧版双字段→新Provider三字段同历史兼容、五档和真实长会话；不把raw adapter替代安装验收。入口和当前边界见 `experiments/qoder-provider/README.md` 与 `provider-verification.md`。
- Pi fork：源码/构建器改动先 `cd rotom && npm run build:pi`、`npm run check:pi`；构建器执行 offline workspace build 和 focused 回归。追加 `node --test rotom/scripts/build-pi-fork.test.mjs`（仓库根），再走下述 runtime/发行 gate。干净 clone 默认没有 fork 的开发依赖（vitest、tsc、biome）：`build:pi` 在隔离副本里自带 `npm ci` 并跑 focused 回归；要在 clone 内直接跑其它 fork 测试，先在 `packages/rotom-pi` 执行 `npm ci --ignore-scripts --no-audit --no-fund`。源码、运行时合同、当前验证与 PTY 未完成项见 [Pi fork](pi-fork.md)。
- npm 分发：追加 `cd rotom && npm run test:distribution`、`pack:release`，从实际 tgz 在隔离 HOME/prefix 安装（PATH 无全局 Pi），验证 `rotom --version`、default/full public-runtime smoke、升级/卸载及产物文件清单。不得用源码目录运行代替 node_modules 内真实安装，Node 不支持对 node_modules 中的 `.mts` 原生剥离类型。
- Browser：追加 browser relay tests/smoke；只有用户明确要求才做真实 Chrome L2/L3。
- 第三方 package/deferred/context：追加 package identity、完整/deferred 两套 footprint 和 public loader smoke。
- Skill：产品 Subagent 指南运行 `node --experimental-strip-types --test rotom/extensions/third-party/subagent/skill.test.ts`，涉及发现/打包时追加 launcher resource contract；其他 skill 只运行其实际存在的校验入口，不假定仓库提供 `quick_validate.py`。
- eval harness：运行 `rotom/evals` typecheck/test；container、host model、付费 A/B 不是普通提交门禁。

测试失败不得静默忽略；先判断是本次改动、既有缺陷还是本机环境/ignored artifact 污染，并说明实际验证范围。

## 依赖、版本与交付

rotom 没有需要每次源码改动递增的统一 App 版本。普通提交不自动升版本。

- 更新第三方 package 时，同步 `extensions/third-party/package.json`、lockfile、`runtime/product-config.mjs` 的 version/integrity、本文件中的数量/版本描述和 package identity tests。
- 允许为本地调试和验证编辑 Pi / third-party `node_modules`，但不覆盖活跃安装；交付前固化为受版本管理的源码或可复现 patch，并同步依赖与 identity 合同。标准依赖安装仍使用[架构文档](architecture.md#启动与依赖入口)中的 `npm ci --ignore-scripts --omit=optional --legacy-peer-deps`，重装后验证改动可复现。
- 更新 eval harness 依赖时只修改 `rotom/evals` 自己的 package/lock，不把 eval dependency 带入运行时产品。
- 修改 launcher/runtime 组合后，从仓库外临时业务 Git 项目验证 cwd/argv、五 extensions（Qoder 默认启用 / `ROTOM_QODER=0` 关闭）、一个 skill、无 bundled templates 和 Claude Skill bridge。
- 不把 token、密码、cookie、私钥、业务正文或本机 trace/eval artifact 提交进仓库。
- 提交前检查 staged diff，只提交当前任务相关文件；提交与推送授权统一遵守根 `CLAUDE.md`，此处不另设相反默认。
