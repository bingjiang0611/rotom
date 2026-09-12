# rotom · verification

按任务读取相关小节，不要求每次全文读取。代码块与行内路径均相对仓库根；命令执行前核对实际文件和 package scripts。当前根指南见 [CLAUDE.md](../../CLAUDE.md)。

## 测试约定

- 使用 Node 内置 test runner 的模块按现有 `*.test.ts` / `*.test.mjs` colocate；保持 `--test-concurrency=1` 的 process/runtime 确定性。
- 外部 CLI 使用隔离 fake executable，断言精确 argv、调用次数、timeout、output budget 和 readback；不要执行真实外部写操作作为普通单测。
- trust/identity/path 测试同时覆盖合法、symlink、越界、漂移、错误版本和命令字符串拒绝。
- async/runtime 修复测试 abort、timeout、late result、process descendant 和 shutdown，不用固定 sleep 掩盖竞态。
- Browser 代码 L1 与真实 Chrome L2/L3 分开记录；付费/真实外部 eval 需要用户明确授权。
- 结构性证据（代码存在、文档声明、L1 静态检查）不等于运行时证据。文档写着「支持」、代码里有对应分支，都不能证明这条路径在真实运行时成立。因此 L1（静态/单测）成立时不得声称 L2/L3（真实设备、真实外部、付费 A/B）已通过；对外声明「已启用」以运行时合同、对应层级测试和真实重放为准。
- eval 的 `.eval/`、node_modules、trace、临时 HOME 和本机安装不是提交内容。

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
- Qoder：追加 `node --test --test-concurrency=1 rotom/extensions/qoder/*.test.mjs` 和维护面 `smoke.mjs`、`session-smoke.mjs`、`stream-smoke.mjs`、`oauth-smoke.mjs`、`catalog-refresh-smoke.mjs`（真实 AgentSession/registry + 假上游，覆盖 browser/qodercli 的目录过期、工具续轮、压缩和失败不重试）、`history-handoff-smoke.mjs`（真实 SDK 切到 Ultimate high、异源签名出站移除、同模型签名回放、磁盘恢复；仅假上游）、`catalog-sdk-smoke.mjs --offline <受影响的已声明 key>`（本次覆盖全部 17 key，含 Sonus/MiniMax 的特殊帧） 离线 smoke；产品 smoke 覆盖 `ROTOM_QODER` 未设置/`1` 的默认启用与 `0` 的显式关闭，以及认证默认 browser、显式 browser / qodercli，真实请求需单独授权并共享有界 ledger。Credit/额度还需 `credits-session-smoke.mjs --offline` 与维护面的 `live-budget` / `probe-wire` / `tui-net-observer` 单测；真实 AgentSession 和 `credits-tui-smoke.py` 的 CLI/PTY 内容验证另需授权，后者强制禁止模型 dispatch，不能写成桌面视觉验收。可调 effort/长会话修复还需维护面的 `stream-shape.test.mjs`、`long-session-smoke.mjs --offline ultimate`；已授权的真实档位可用 `effort-probe.mjs <key> all --product`，长测用 `long-session-smoke.mjs --live <key> 20 <逗号分隔档位>`，源码与实际安装分别记录。长测保留 Pi 原生 reserve 默认、根据实测 tokenizer 提前压缩，不通过抬高容量掩盖溢出。只有显式授权才执行付费路径。历史与新验证报告见 `experiments/qoder-provider/`。
- Qoder 三模型图片/大上下文：另跑 `input-budget-smoke.mjs`（真实 SDK/假上游）、`vision-capacity-smoke.mjs --offline <key>`；已授权的源码/实际安装均跑 `vision-capacity-smoke.mjs --product <key>`，可用 `ROTOM_QODER_VISION_ROWS=12600` 验证大输入与四张图片共存，以及 `large-context-probe.mjs --live <key> 12600 250000`。后者设置 `ROTOM_QODER_PROBE_PRODUCT_ROOT` 才是产品路径；断言真实 input≥250K、400K selector、线上的4096，并保留原生272K管理窗口/安全和压缩余量；≥272K 单请求输入是上游能力记录，不再是产品窗口断言。Ultimate固定COSY还须旧版双字段→新Provider三字段同历史兼容、五档和真实长会话；不把raw adapter替代安装验收。见 `experiments/qoder-provider/IMAGE-CONTEXT-VERIFICATION.md`。
- Pi fork：源码/构建器改动先 `cd rotom && npm run build:pi`、`npm run check:pi`；构建器执行 offline workspace build 和 focused 回归。追加 `node --test rotom/scripts/build-pi-fork.test.mjs`（仓库根），再走下述 runtime/发行 gate。源码、运行时合同、当前验证与 PTY 未完成项见 [Pi fork](pi-fork.md)。
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
- 提交前检查 staged diff，只提交当前任务相关文件；除非用户明确要求，不推送。
