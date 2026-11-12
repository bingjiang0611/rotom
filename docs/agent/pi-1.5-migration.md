# Pi 1.5.2 对齐

## 范围与来源

- fork：`1.5.2-rotom.1`；产品版本不变，不是 npm 发布或本机安装切换。
- 三方合并 base：上游 `v1.4.0` / `4a080252f06caf63a525d7873c5d94d3c23887e0`。
- 目标：上游 `v1.5.2` / `b4afdddf44e059c67ccf5097e5317d913521b470`（跨 `v1.5.0`、`v1.5.1`，共 703 个上游提交）。
- fork 相对 1.4.0 改过 86 个文件，其中 51 个上游也改了：31 个自动合并，20 个文件 25 处需人工解冲突（7 个测试、1 个文档、12 个源码）。此计数是文件级三方合并结果，不是逐行安全审计。
- 模型目录来自官方 `@earendil-works/pi-ai@1.5.2` 的 44 个数据文件（新增 `qwen-token-plan-individual-cn.json`），下载后核对 registry SHA-512 SRI 与 SHA-1，再更新 `FORK.json` 中的逐文件摘要。
- **运行时从七包变为八包**：新增 `@earendil-works/pi-schema`（`pi-ai` 与 `pi-agent-core` 依赖它）。`typebox` 不再是 `pi-ai`/`pi-agent-core` 的运行时依赖。chord、durable、env 仍是维护 workspace，不进入产品边界。
- 外部运行时依赖变化：`grok-mermaid` 换成 `lovely-mermaid@0.3.3`，`minimatch` 升到 `11.0.3`，`undici` 升到 `8.12.3`（安全公告）。

## 不导入的上游内容

- `apps/`（上游 1.5 新增的 p2、p3 应用，953 个文件）：不属于 Pi 运行时包，夹具里有 `auth.json`、sqlite 数据库和会话目录，与公开前隐私边界冲突。根 `package.json` 的 `apps/*` workspace 声明与上游 lockfile 保持原样；已实测缺少该目录时 `npm ci --ignore-scripts` 仍按锁安装成功（293 个包）。
- 新增的维护文件 `.github/workflows/p2-cloud-bundle.yml`、`.github/workflows/preview-packages.yml`、`.pi/skills/p2-ui.md`，以及 chord 的两份存储夹具：被根 `.gitignore` 的 `*.db` 规则命中的 `packages/chord/test/schema/stored/store.db`，和被公开审计按 `.jsonl` 判为会话数据的同目录 `archive.jsonl`（依赖它们的 chord 测试在本仓库不可运行；chord 不是运行时包）。
- 清单见 `FORK.json` 的 `omittedMaintenanceFiles` 与 `omittedDirectories`。

## 与上游不同的两处默认值

这两项是 rotom 的选择，不是合并遗漏；恢复上游行为各只需一行用户配置。

| 项 | 上游 1.5.2 | rotom | 恢复上游行为 |
|---|---|---|---|
| `cacheWarming` | `"idle"`：两次运行之间最多 30 分钟保持 prompt cache 热 | `"streaming"`（1.4 的默认值） | 全局 `settings.json` 里写 `"cacheWarming": "idle"` |
| Anthropic message threads | `anthropic` provider 且 `api.anthropic.com` 时默认开启 | 默认关闭 | `models.json` 里对该模型写 `compat.supportsMessageThreads: true` |

- `cacheWarming`：空闲期刷新会在用户没有操作时产生请求；Qoder credits 计量下更不应默认花费。
- message threads：每次只发新消息、由服务端续接。它与 Context Layers 投影（会改写较早的上下文）的交互只能用真实 Provider 验证，离线测试证明不了，所以在验证前保持完整请求。

`packages/rotom-pi` 下的上游 README/CHANGELOG 仍按上游默认值描述；`docs/settings.md`、两个 schema JSON 与 `compat-schema.ts` 的说明已改成 rotom 的默认值。

## 主要行为变化（来自上游）

- 工具参数校验改走 pi-schema：纯 JSON Schema 工具（含 MCP）也做类型强转；`Type.Refine()`、codec、`Format.Set()` 等 TypeBox 专有特性对工具参数不再生效。`rotom/extensions` 源码没有使用这些特性；继续从 `@earendil-works/pi-ai` 导入 `Type` 的扩展由 Pi 的扩展加载器映射到 compat 入口。
- 流式工具调用参数改为增量解析（#9265），代码高亮与 Markdown 渲染结果复用。
- `read`、`grep`、`edit` 不再整文件读入内存；`grep` 的 `glob` 相对 `path`；`edit` 只改动涉及的行，不再重写其他行的换行符。
- 会话写盘失败不再在内存里留下磁盘上没有的条目（#11460）；RPC 模式空闲时响应 `ctx.shutdown()`，关闭期间一次信号不打断清理（#11599）；退出时等待进行中的 OAuth 刷新落盘。
- 连续读图不再并发启动 resize worker（macOS arm64 + Node 24 上的 `zsh: abort`，#10695）。
- 「回复开始后被截断」的断流进入自动重试；智谱 1308 用量上限不再当 429 重试。
- `/tree` 分支摘要遵守 context edits 与会话思考档位；截断不再切开代理对。
- `tool_search` 支持非 ASCII 查询；MCP OAuth 拒绝非 http(s) 的元数据 URL；glob DoS 修复。
- 系统提示词被上游收紧；多个 provider 的默认模型更新；`/login` 列表把 Radius 与 OpenRouter 置顶。这三项按上游原样保留。

## 冲突的解决方式

| 文件 | 处理 |
|---|---|
| `ai/src/utils/error-body.ts`、`api/anthropic-messages.ts` | 上游的 `withCauseDetail`（追加最深层 cause）与 rotom 的 `withConnectFailureCause`（连接阶段标记）都保留；后者只在上游文本没带出连接原因时追加。连接失败分类依赖的模式串两种措辞都能命中，已加回归。 |
| `coding-agent/src/core/tools/bash.ts` | 保留 rotom 的内部环境变量剔除与带错误码的 `bashError`；超时信息采用上游的 shell 退出码说明（#11613）。 |
| `core/tools/edit.ts` | 保留 rotom 的「本次调用未写入」回执；采用上游的写前 diff 与按原文拼接。 |
| `core/compaction/utils.ts`、`branch-summarization.ts` | 保留 rotom 的头尾各半截断与扩展消息标注；切片改用上游不切代理对的 `sliceHead`/`sliceTail`；分支摘要采用上游的 context-edit 投影。 |
| `core/agent-session.ts` | rotom 的 `_appendModelChangeIfChanged` 与上游的 `_recordThinkingLevel` 并存。 |
| `modes/rpc/rpc-mode.ts` | 保留 rotom 的「stdin 先监听、再绑定会话」启动顺序；采用上游的空闲关闭与信号计数。启动期的关闭检查移到绑定完成之后；初始化失败时仍移除信号处理器。 |
| `modes/interactive/interactive-mode.ts` | rotom header 的资源快照与上游的全屏 model-scope 提示并存。 |
| 两个 model selector 及其测试 | 保留 rotom 的名称优先标签与 picker 内思考档位；上游新增的测试改为断言 rotom 的标签格式。 |
| `cli/auth-command.ts` | 采用上游的 `auth login`/`logout` 帮助文本，命令名继续用 `APP_NAME`。 |
| `docs/extensions.md` | 采用上游重写后的文档，补回 `pi.appendUsage()` 一句。 |

## 验证与边界

环境：Linux x64 容器，Node 24.22.1 / npm 11.19.1。只使用本地 fixtures、faux provider 与隔离 HOME；没有发起真实模型请求。对照组是同一容器里未改动的 `1.4.0-rotom.4` 工作树（同一套命令）。

| 检查 | 结果 |
|---|---|
| `npm run build:pi`（非 root 用户，隔离 HOME/cache） | 通过；锁定安装 + 上游 offline build，8 批定向回归 1183 通过 / 3 跳过 / 0 失败 |
| `npm run check:pi` | 通过；源码与构建器摘要匹配，八个归档、runtime lock 与 product-config 同步 |
| 安装后的 runtime | `npm ci` 按锁安装八包；`pi --version` = `1.5.2-rotom.1`；installed dist 中可找到 `withConnectFailureCause`、`cacheWarming: "streaming"` 与 `supportsMessageThreads … ?? false` |
| fork 各运行时包的全量 suite（Linux 容器） | agent、mcp、codemode、schema、telemetry 全部通过；tui 1104 通过 / 2 跳过；coding-agent 3226 通过 / 53 跳过 / 25 失败——25 个都是容器条件：以 root 运行（权限类断言）、无 `fd`、离线 catalog、路径过长，没有一个落在本次冲突文件的逻辑上 |
| `rotom/bin/check-personal` 的 Node 测试段 | 598 项：592 通过 / 2 跳过 / 4 失败。4 个失败中 3 个与对照组相同（`third-party/index.test.ts` 子测试全过但进程不退出、被手动结束；两个测试缺少未安装的开发依赖，补装后 9/9 通过）；第 4 个是 Computer Use 审批测试的夹具缺 Pi 1.5 新增的实例字段，已修，11/11 通过 |
| 浏览器扩展测试（全部 `browser-*.test.ts` 与 `*.test.mjs`） | 302 通过 / 0 失败（修正 jiti 别名后：`@earendil-works/pi-ai` 指向 Pi 1.5 的扩展视图） |
| Provider 离线矩阵 `check-providers.mjs` | PASS，9/9（Qoder 维护 smoke 改为从同一 Pi 安装解析 `typebox`） |
| 矩阵外的 Qoder 离线 smoke | history-handoff、credits-session、long-session（ultimate）、vision-capacity（ultimate）通过；`catalog-refresh-smoke.mjs` 在对照组同一断言处失败，属既有问题，未在本次处理 |
| Goal 源码测试（对已安装 Pi） | 99/99 |
| 上下文 footprint（默认 / `ROTOM_DEFERRED_TOOLS=0` / owned-process-groups-v2） | 三者均 PASS。工具数与规范化 schema 字节不变；guideline 字节各 −250，全部来自上游合并的 `edit` 工具提示，已实测更新三份冻结合同 |
| `npm run test:distribution` | 38 通过 / 1 失败；失败的 `build-info.test.mjs` 断言产品版本以 `0.1.` 开头，而产品已冻结为 `0.2.0`，对照组同样失败，未在本次处理 |
| `build-pi-fork.test.mjs`、`verify-pi-runtime.test.mjs`、`context-footprint.test.mjs` | 2/2、41/41、11/11 |
| `python3 scripts/audit-public.py --root .` | PASS；10,638 个文件，0 findings。新增 46 行上游公开示例（chord 文档/测试、JSON-Schema-Test-Suite 的地址向量、coding-agent/ai 的测试与 CHANGELOG），每行都与 `v1.5.2` 同路径逐字节核对后，按精确路径+行 SHA-256 写入 `scripts/pi-public-examples.json`；`undici` 记录随依赖升到 8.12.3 |
| 审计器回归 `test_audit*.py` | 21/21 |
| `git diff --check` | rotom 自有文件无问题；10 个上游导入文件带既有行尾空白，与 tag 逐字节一致，按惯例不改写 |

文件大小门禁：本次提交含 316 个超过 20,000 bytes 的上游文件，另有 `docs/agent/architecture.md`（20,652 bytes，本来就超限，这次只改一个字）。用户明确批准仅本次同步一次性豁免，与 1.4 同步相同；不修改门禁规则，不豁免构建、行为测试或公开审计。

未做：真实 Provider/付费调用、真实 Chrome、桌面 TUI 验收、macOS 上的构建与测试、`npm publish`、替换存活安装。message threads 与 Context Layers 的交互、`cacheWarming` 的真实费用、pi-schema 对第三方 vendored 包（pi-subagents、pi-goal、sol-pi、pi-computer-use）工具 schema 的强转影响，只有离线证据。
