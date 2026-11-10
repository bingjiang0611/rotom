# CLAUDE.md

# rotom

rotom（原 Dev Agent）是独立维护的 Pi personal coding agent 能力包。仓库根目录是**维护面**，`rotom/` 才是运行时产品。

产品与仓库名均为全小写 **rotom**，唯一项目仓库为 [bingjiang0611/rotom](https://github.com/bingjiang0611/rotom)。源码公开不等于 npm 发布或许可证批准。npm 产品包位于 `rotom/`，公开命令为 `rotom`（公开 bin `rotom/bin/rotom` 只解析并 exec 唯一内部 launcher `rotom/bin/rotom-launcher`）。产品目录、`ROTOM_*` 环境变量与自有 package 名（如 `rotom-third-party-runtime`）已统一为 rotom；上游 identity 和下述兼容性标识有意保留。**本地维护仓目录 `dev-agent`** 保持不变，公开文档使用 checkout 无关路径；发行包接入不等于迁移活跃会话或浏览器绑定。

**有意保留的上游名称与兼容性标识**（不是品牌改名遗漏）：
- `@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`：上游 Pi package 名，不能按产品品牌改写。
- Rotom 的公开命令与 UI 品牌仍为 `rotom`，但主进程/RPC 的兼容身份保留为 `pi` / `pi-rpc`，使按进程识别 Pi 的外部集成继续生效。
- 内化组件仍使用 `pi-subagents`、`@injaneity/pi-computer-use`、`@narumitw/pi-goal` 等 npm identity，以及 `PI_SUBAGENTS_*` / `PI_COMPUTER_USE_*` 等上游配置合同。
- `dev-agent-deferred-tools-state`、`dev-agent-context-footprint/v1`、`dev-agent-context-footprint-report/v3` 保留为持久化/报告兼容性标识，不能只改文档或静默迁移。历史归档版本、实验身份与上游 CHANGELOG 也不按品牌批量替换。

Browser relay 的 wire-protocol message kind（`rotom-browser-*`）、native messaging host id（`dev.rotom.browser_relay`）与显示品牌（"Rotom Browser Relay" / "Rotom Trace Dashboard"）已随全量改名统一为 rotom，TS relay 与 `chrome-extension/` 两侧同步。**代价（维护者已确认接受）**：任何在改名前安装的旧 Chrome relay 会因协议 kind 与 host id 变化而失联；用户须显式重装/重载 extension 并重跑 `install-chrome-relay` 以按新 host id `dev.rotom.browser_relay` 重新注册 native host。旧的 `dev.pi_agent.browser_relay.json` host manifest 会成为孤儿文件，可自行清理。

（eval harbor 适配器里的 `dev-agent-pi` / `DevAgentPi` / `test_..._harbor_pi_agent` 用的是被保留的 `dev-agent` eval 身份与通用 "pi agent" 措辞，非产品品牌串，保持不变。）

本文只约束在本仓库内工作的 Agent 与维护者，不是要注入目标 Pi session 的身份 prompt。用户的明确要求可以覆盖一般偏好，但不能静默绕过运行时资源身份、敏感数据边界或验证门禁。

## 我们绝不妥协的事情

### 1. Pi 接入与维护

rotom 当前通过仓内 `packages/rotom-pi/` 的 Pi fork 接入 `@earendil-works/pi-coding-agent`，不再默认依赖官方 npm Pi 或旁边的 Pi checkout。公开 API 与组合层是优先方案，不是强制边界；允许按任务需要修改或 fork Pi、使用私有 Extension API，以及调整或自行实现生命周期。相关改动需说明兼容性影响并完成对应验证。

- `rotom/bin/rotom` 是 npm 公开入口，只解析 bin symlink 并 exec 唯一内部 launcher `rotom/bin/rotom-launcher`。
- 默认仅从产品 `runtime/pi/node_modules/` 解析固定 Pi fork；七个运行时包（含 Codemode 与 MCP）由仓内源码构建，构建期归档、lock、源码/构建器摘要必须匹配；启动期只验证元数据、installed package identity 和 capability，不证明解压文件未被修改。发行包不携带构建用 vendor tgz，不查 ancestor hoisting、不回退 PATH/global/旁路 Pi。`ROTOM_PI` 是显式维护覆盖，仍过原有 identity/capability gate，不代表默认发行版本。
- Pi 源码或构建器改动后先 `cd rotom && npm run build:pi`；发布维护命令为 `npm run pack:release -- /absolute/output-dir`：拒绝陈旧 fork 归档，隔离 HOME/cache、按锁文件新安装 Pi fork 与第三方依赖后打包；禁止复制维护者 node_modules 或把评测、会话、凭据带入发行包。npm 发布固定使用公开作用域包 `@bingjiang0611/rotom`；许可证仍为 `UNLICENSED`。
- `pack:release` 偶发 `spawnSync npm ETIMEDOUT` 先排查是不是自己造成的资源/网络争用（把多次 pack 塞进循环、同时跑重度任务、残留 staging 堆积），不是脚本 300s/单调用 cap 太紧或基础设施故障：隔离单次 `npm ci` 实测远低于该 cap（根与第三方各数十秒）。清掉 `$TMPDIR/rotom-release-*` 残留后单次干净重跑即可，不要为此放宽 timeout 或改发布脚本。
- launcher 保留业务 cwd 和用户 argv；仓库根不能冒充用户项目。
- `ROTOM_PI`、`ROTOM_NODE` 只接受绝对、存在、可执行的普通文件；解析 realpath 后固定同一 executable。
- Pi package identity、`bin.pi`、公开 exports 和当前能力必须在启动前验证。
- 允许直接修改 Pi 或第三方 package 的源码及 installed source；选择源码、wrapper、adapter 或 policy seam 时以问题归属和可维护性为准。

#### npm 正式发布顺序

npm publish 是不可逆外部写入。只有用户明确授权精确 version 与 dist-tag 后才执行；缺少任一项就停下询问，不从“准备发布”推断写入授权。

1. **先收口产品改动。** 功能、修复和非发布记录文档先各自验证并同步公开 `main`；进入发布后不再混入其他改动。从最新公开 `origin/main` 建独立干净 clone，使用 GitHub noreply identity，并用 Git 命令读取 commit SHA，禁止手填。确认远端没有不兼容移动、工作区干净、目标 npm version 尚不存在。
2. **单独提交发布元数据并冻结。** 一次确定 package version、预期 dist-tag、`publishConfig.access=public`、`UNLICENSED` 与发行说明；同步 `rotom/package.json` 和相关文档并先 fast-forward 推送，以该 commit 作为唯一构建源。Pi 源码或构建器变化时在此之前完成 `build:pi` / `check:pi`。
3. **只接受一个最终产物。** 在公开 clone 中仅对冻结 commit 成功执行一次 `npm run pack:release -- /absolute/output-dir`；只继承标准代理路由变量，不读用户全局 npmrc，不并发重度任务，不循环 pack。任何会改变 package 内容的后续修改都会使 tgz 失效，必须回到第 1 步重新冻结和构建。
4. **围绕实际 tgz 验证。** 记录文件数、压缩/解包大小、SHA-256 与 SRI；审计实际 tgz，并按 [verification.md](docs/agent/verification.md) 在隔离 HOME/prefix、PATH 无全局 Pi 的环境完成安装、`rotom --version`、default/full smoke、`check-personal`、升级与卸载检查。不得用源码目录测试、dry-run 或旧 artifact 替代最终 tgz。
5. **npm 认证只交给用户的前台终端。** 已配置 GitHub Actions Trusted Publishing 时优先使用 OIDC；否则 Agent 不运行 `npm login`、不启动 Terminal/浏览器、不代填账号，也不接触密码、OTP、恢复码或短时 token。Agent 先用 `node scripts/npm-release-handoff.mjs commands <absolute-tgz> <tag>` 生成分阶段精确命令，向用户逐段贴出；用户在自己的前台终端执行 login、`npm whoami` 与网页确认并回报结果，Agent 独立只用 registry 查询核对公开状态。除非用户在看到精确命令后另行明确要求 Agent 执行，后续发布均遵守此交接方式。
6. **发布命令由用户执行一次。** Agent 再次确认公开 commit、目标 version 空缺、预期 dist-tag、固定 tgz 的 SHA-256/SRI 与授权一致，然后贴出 `npm publish <tgz> --ignore-scripts --access public --tag <tag> --registry=https://registry.npmjs.org`，不得自行执行。若出现 `EOTP`，用户只处理 npm 在该前台命令中显示的官方 challenge；Agent 先查 registry，不根据错误文本盲目要求重发。发布后运行 handoff helper 的 `verify`，只有 registry version/tag/digest 与下载字节全一致才进入安装阶段；本机切换命令也贴给用户执行，Agent 仅只读回验。
7. **区分 submitted、reviewing 与 verified。** HTTP 202、CLI exit 0 或“being processed”只表示 npm 已接收，不表示已公开。目标 version 在 registry 尚不可见时，若 Browser Relay 可用，先只读检查 npm 官方 package 的 Versions 页；页面明确显示该 version 为 `Validating` 或 “Automated review hasn't finished” 时，立即告知用户“npm 正在自动审核，审核完成前版本不可用”，将状态记为 `reviewing` 并暂停当前发布流程。审核期间绝不重复 publish，也不更新本机安装、不写正式发布记录、不创建 release tag；用户后续要求继续时先只读复核页面与 registry。无法证明处于审核中时，才每 30–60 秒只读查询精确 version 与 dist-tag，最多 30 分钟；到时仍不可见则标记 `unknown` 并交接。`0.1.0` 曾实测异步处理约 25 分钟，不能把等待误判为失败。
8. **用 registry 证明结果。** 只有精确 version、预期 dist-tag、integrity、shasum 与 tarball URL 同时出现，并且下载 tarball 的摘要及字节与最终 tgz 一致，才算 npm 发布完成。
9. **最后记录和清理。** 在公开 clone 记录构建源 commit、验证结果和 artifact 摘要，创建注解 `v<version>` tag，并将 release commit 与 tag 原子 fast-forward push；随后同步本地 tracked tree。Agent 向用户贴出 helper 生成的 logout、`npm whoami` 失败回读及临时认证目录删除命令，由用户在同一前台终端执行并回报；随后 Agent 再删除本次创建的 clone、staging 和 artifact 路径。

### 2. 运行时资源必须可证明

extension、bundled skill 与第三方 package 是产品合同，不是“目录里碰巧存在的文件”。产品不再加载 bundled prompt template；用户自己的模板仍走 Pi 原生发现。

- 产品内置资源列表以 `rotom/runtime/product-config.mjs` 和 launcher 的显式声明为准；用户通过 Pi 原生 package、用户目录、受信项目目录或 `-e` 加载的资源不冒充产品资源，也不经过产品 identity gate。
- Qoder 为 bundled、默认启用的 `qoder` provider（`ROTOM_QODER=0` 可关闭），保留旧会话的 `qoder-experimental-account-v1` 绑定兼容读取与 `lite`/`performance` 离线基线；升级前的浏览器登录凭据不自动迁移。账号目录按原始 key 发现，只注册实测白名单 ∩ 当前账号 enabled 的交集，不改默认模型；未验证的 opaque 形状、档位与路由不启用。目录通过 Pi 原生 `models-store.json` 按非敏感账号摘要隔离持久化，过期后台刷新；缓存不含凭据，账号不匹配时不得恢复，可见不等于 direct endpoint 可调用。具体目录项、路由数、版本头与窗口大小随上游变动，不写进本文件。
- 凭据默认走 `browser`（Pi 原生登录/存储/串行刷新、复用公开客户端 ID，非官方支持），不读写 CLI 凭据；显式 `ROTOM_QODER_AUTH=qodercli` 回到只读 CLI 兼容模式。刷新前持久记录一次性尝试、unknown 不重放、只强制隔离凭据的本地到期（不冒充自然到期）；重新登录或认证来源变化须新会话。opaque signature 字段按各自 Pi signature 原样存回，不解密、不跨模型丢弃。
- 每条路由固定走 COSY 单次推理或 direct，不失败回退、不嵌套 agent；provider 自身不重试推理。推理前的目录刷新失败（`catalog_refresh_failed`）与没有任何可见输出的传输失败（`request_failed_before_output` / `stream_failed_before_output`）交给 Pi 有界重试预算——维护者已接受后者重发可能重复计费，代替手动“继续”；已流出文本、reasoning 或 tool call 的失败保持原码不重试。只按实测交集开放 effort，其余固定 enabled，不伪造关闭/强度支持。服务尾帧仅在 finish、usage 与精确 metrics 同时成立时映射终止，不以 EOF 补成功。
- 仅图片档模型开放 PNG/JPEG/WebP 与受管上下文窗口，其余仅文本、上下文保持有界；默认不发送单次输出 token 上限（由服务端决定），调用方显式预算仍经 Pi 原生上下文预算裁剪；不设置独立的单图、历史图片总量或张数上限，最终请求体保持有界，拒绝远程 URL，不宣称完整 400K/1M。
- Credit 只记录完整流中有效的服务端 credits/billable，缺失/错误/取消/冲突保持 unknown；会话 subtotal 为 partial、billable-reported，不是完整账本或 USD。选中 Qoder 时，内置 Pi footer 的普通 usage 行用三位小数 `Cr` 只显示已记录小计；仅在没有任何已知小计但存在 unknown 时显示 `Cr?`，已知与 unknown 并存时不追加 partial 后缀；不显示 Pi 的 $0 占位。`/qoder-credits` 只读账号快照，不进对话/压缩/摘要，不由余额差值推断单次费用。美元费用未知与上游支持/许可未确认必须显式披露。
- 第三方 package 使用精确版本、lockfile integrity 和 installed package identity；`package.json`、`package-lock.json`、`product-config.mjs` 必须同步。发行包的 Pi fork 另由 `rotom/runtime/pi/package.json`、`package-lock.json`、`fork-build.json` 和 product config 固定版本/integrity；产品 `package.json` 不声明任何 npm dependency，也没有产品级 lockfile。
- 运行时资源拒绝 symlink、越界路径和 canonical 漂移。
- `node_modules/` 可用于本地调试和验证修改，但重装会覆盖；交付时将改动固化到受版本管理的源码或可复现 patch，并同步依赖与 identity 合同。不要原地覆盖存活会话使用的安装。
- 已退出产品面的 Verification、Experience、Safety、Containment、Background/Fusion、LSP、旧第三方 MCP adapter、旧自有 Execution/Subagent/Goal、compact-policy、task-state、baseline、`refine`、`simplify` 和独立 community 不因第三方包仍有同名实现而恢复。当前 Subagent 与 `/goal` 由显式声明的内化组件经自有 wrapper 接入，不是恢复旧框架。
- 模型驱动的 context fold（`ROTOM_CONTEXT_FOLD`）已在 L3 实测后删除：Qoder DeepSeek-Flash 上短/长会话计费 credits 均约中性（0.97× / 0.975×），开启侧方差远大于差距，请求数最多翻倍，并出现过折叠后中途弃任务。实现与实测记录只查 Git history（`25b5230`–`f2f0d86`）；没有新的收益证据时不重建。

### 3. 工具面要小、显式且诚实

Context Layers 是用户明确要求独立实现并默认启用的产品 extension（`ROTOM_CONTEXT_LAYERS=0` 可关闭），不是恢复旧 `ROTOM_CONTEXT_FOLD`。它已收敛为单一只读检索工具 `context_recall`（`sequential`、model-only、只读当前分支），按子串搜索或按 `@entryId` 读取当前分支上的原始文本与图片——搜索覆盖分支上的全部消息，不只是被压缩清出的部分；它不提供摘要、合并或写入，不改原文，也不自动展开历史。检索结果是普通工具结果，会留在后续请求的上下文中，可能再次被压缩或清出。slimmed 之前的 `context_status` / `context_compress` 与三级摘要已删除，只查 Git history，不提供兼容壳。合同、证据和限制见 [Context Layers](docs/agent/context-layers.md)。

默认 deferred-tool loading 常驻 core、Codemode、Ask、Browser/Computer Use、Goal 四工具、Context Layers 的 `context_recall` 与 `search_tools`，只把 Subagent 按需 additive 激活。内置 SoL-Pi 在无用户配置文件时默认开启 Action Fusion（替换 `edit`/`write`）、Observation Pack（`obs_recall`）与会额外请求 `openai-codex/gpt-5.6-luna` 的 Reducer（`ROTOM_EVIDENCE_REDUCER=0|1` 只覆盖 Reducer，优先于默认与配置文件）；Compaction Offload 默认开启（`ROTOM_COMPACTION_OFFLOAD=0` 关闭）：阈值压缩前先把旧的中等工具结果换成 `obs_recall` 指针，空间够就推迟原生摘要；回放实测见 `docs/agent/compaction-offload.md`；内置 pi-context-view 只加 `/context` 命令。Goal `0.54.4-rotom.11` 默认自动响应次数为 Unlimited，显式保存的数值上限仍生效；已用次数与最后记录的续跑计划仅供状态展示，不证明进展、不授权重放；从启动起保持四个稳定 schema；工具可见不等于 Goal 模式启用，无 active goal 时拒绝执行，也不覆盖显式工具限制。活跃且非 waiting 的正常运行结束后默认自动续跑，`goal_continue` 只是可选的下一步计划，可与普通工具混批且不作废兄弟工具；连续三次自动运行没有非控制工具调用才以 `empty_responses` 暂停，重复指纹先注入一次换思路提示，再次达到阈值才暂停。单次 Provider 请求仍只由 Pi 按统一预算有界重试；Goal 不放宽该预算，也不重放工具。Pi 恢复耗尽后，Goal 依次进入 5/15/30 分钟的持久 wait，再各提交一次全新续跑；用户输入或 `/goal pause` 可打断，任一成功运行重置序列，第四次连续耗尽才以持久 `provider_retry_exhausted` 暂停。恢复与 wait activity 均公开。唯一例外是可证明请求未发出的连接阶段失败（DNS、拒绝/不可达连接、连接超时、代理隧道或 TLS 建立失败，错误显示为 `… (caused by: <socket 原因>)`，及 `Qoder: connection_failed`）：参照 Codex 只对 connect 错误无限重试，Pi 以同一封顶退避等待网络恢复，不占 `retry.maxRetries` 额度，TUI 显示 “Reconnecting... waiting for network”，用户中断或 `retry.enabled:false` 才停止。无原因的 `fetch failed`、发送后重置（可能已被处理计费）与流中断开（`terminated`、WebSocket、超时）仍走有界预算。会话恢复默认由 `resumeOnRestore:true` 在空闲时为非 waiting、非 recovery 的活跃目标续跑一次；显式 false 保留 `session_restored` 暂停。恢复与 idle-active resume 都不得抢占运行、恢复或已排队工作，也不重放保存计划或成功/unknown 工具操作。共享提示合同先查证目标、验收与写入边界；缺少授权或关键决策时优先用 Ask 等待用户，Ask 不可用时以 `goal_blocked.needs_user_decision:true` 明确停止且不要求三轮；重试须有新证据或可检验假设；三轮只限制普通重复 blocker，单一路径受阻时继续其他需求，全部剩余工作都依赖外部动作时才 `goal_blocked`，不为凑轮次重复检查。外部写入 unknown 只读核验、不盲目重放；审阅拒绝只表示验收未获支持，不授权重做成功/unknown 写入，缺证据先只读核验并继续其他需求，全部剩余要求都依赖不可得证据时才 `goal_blocked`。这是模型行为指引，不是权限拦截器，不缩小原始目标或降低完成标准。`goal_complete` 默认按模型声明完成；显式 `completionReview:true` 才启用有界、当前模型、文件只读的 completion reviewer，不创建嵌套 AgentSession、不加载项目资源；额外用量单列且计入 Goal token admission，USD/credits unknown。审计尝试先持久化；unknown 不自动重放同一候选，模型可继续其他工作或只读补证，新候选仍可使用剩余次数与 token 额度；同一候选重复提交只返回拒绝信息，新候选遇到固定审阅额度耗尽则以 `review_exhausted` 暂停并要求人工验收后 `/goal clear`，或由用户显式关闭审阅后 `/goal resume`，resume/edit 不补额度。结果绑定当前 Goal/run 及实读证据；是第二意见，不是真实外部验收或 OS 沙箱。显式 `completionReview:false`（默认值）跳过 reviewer。它是 context-footprint 优化，不是安全沙箱。

- Pi 基线为 `1.4.0-rotom.4`（上游 `v1.4.0` 合并，见 [Pi 1.4.0 对齐](docs/agent/pi-1.4-migration.md)）；Codemode 独立启用。上游分类模型/API、虚拟模型路由 API 与内置 MCP 均保留：产品不自带分类器调用或虚拟模型，只有扩展注册虚拟模型或用户在 `mcp.json` 配置 server 时才生效；`rotom mcp …` 与 Pi 包管理命令一样原样透传。Goal/Ask/Subagent/Browser/Computer Use 使用 `model-only`，不可从 Codemode 嵌套调用；普通文件工具仍可编排。显式工具选择仍优先。
- Goal 预算计入已报告的 tool-result/model/summary usage；旧 Goal 基线一次迁移、不追收历史辅助用量。reviewer 使用当前选中的普通模型，不进行分类或自动路由；没有选中模型保持 unknown。
- `ROTOM_DEFERRED_TOOLS=0` 必须恢复完整工具面。
- 用户显式 `--tools`、`--exclude-tools` 或 runtime policy 优先；launcher 仅在没有 tool-selection flag 时授权 loader 收窄 reviewed default，extension/SDK 直载默认保留调用方 active set；用户 extension 新增的非 deferred 工具同样保留。
- 已加载 specialized tools 在当前 session 内不主动移除；group state 与 active tool 子序列按 product declaration order canonicalize，相同 group 集合不因加载顺序产生不同最终 identity。
- resume/fork 必须恢复 capability state；升级前无 deferred state 的旧 session 允许首次多一次 `search_tools`。
- 不把静态 bytes、byte/4 或固定 canary 写成 provider 精确 token、成本或全局延迟收益。
- Browser relay 的性能基线以 [performance-baseline.md](docs/agent/browser-parallel/performance-baseline.md) 为准，用 `rotom/runtime/e2e-browser/bench.mjs` 在同机复测。改动观察、交互、滚动、持久化或 `read_full` 路径后应跑一次基准并对照基线；新增的"先等一段时间再读"写法必须说明在等什么，能轮询到条件满足的不要固定睡。基线与其中数字只描述这台 Mac、headless Chrome 与本地 fixture 的单次调用成本，不是端到端任务延迟，也不是对外性能承诺；换机器只比量级，不减内容地变快不算优化。
- 新能力只有接入完成并通过对应 L1/L2/L3 后才能对外声明为已启用；当前事实以运行时合同、测试和本文件为准。

### 4. 本机执行不等于安全隔离

Pi 原生工具、Browser 和 Computer Use 都以启动 Pi 的本机用户权限运行。产品没有 Safety、Containment、QEMU 或权限 preset/profile；Computer Use v2 新增的确认面只是一层**同意层**（App 分级、授权卡片、敏感动作确认、用户停止），它不是隔离层，也不覆盖 Pi 原生工具与 Browser 的写操作。

- 外部写执行一次，随后按同坐标 readback；失败、超时或无法证明时返回 `unknown`，不盲目重试或自动回滚。
- Computer Use 仍是本机用户权限，不是安全沙箱。v2 增加的是**同意层**而不是隔离层：跨进程 Broker 仲裁 + App 分级/授权卡片 + 敏感动作确认 + 用户停止（菜单栏项与 `Ctrl+Option+Cmd+.`）。仲裁目前是**协作式**的：helper 侧尚未校验 lease token 的 HMAC 与撤销列表，所以它约束我们自己的客户端，不阻止别的进程直接调用 AX/HID。这些只保证“通常不会有两个 agent 同时写同一个 App”“用户能被问道并随时停掉”，不限制 agent 在本机还能做什么。
- Computer Use `0.5.1-rotom.3` 的 macOS headless 文本路径仅对 IDEA 提供精确窗口绑定、内部合成焦点和逐字符完整回读；限可打印 ASCII、256 字符及有界等待，未知即停批次，不代表任意 GUI 或绝对无干扰。helper 协议已升到 8（用户活动、剪贴板、App/窗口管理、系统表面、语义 AX 动作、L2 定向投递）；协议不匹配仍不自动重启已有 daemon，禁止覆盖存活会话的 helper。新 macOS 归档为 ad-hoc 签名，覆盖已有 helper 需显式授权。L2（`SLEventPostToPid`）按运行时解析、白名单（仅 IntelliJ）与 `ROTOM_CU_L2=0` 开关；该路径**至今未在真机执行**（只有编译级证据）。真机跑通的是语义 AX 路径：3 个 fixture 实例后台并行时前台 App 与光标不变；pid 投递（`CGEvent.postToPid`）在真机上也还没有正例（见 v2 状态与 `docs/agent/computer-use-v2/evidence/real-machine-session.md`）。真实插件检查、Swift 测试执行受限和未验证范围见 [后台文本输入](docs/agent/computer-use-background-text.md) 与 [v2 状态](docs/agent/computer-use-v2/STATUS.md)。
- 环境、发布阶段和 scope 必须来自当前请求或权威 preflight；不把预发扩大到生产、单机扩大到全量。
- `.pi/tasks/`、`.pi/delegate/`、`.pi/fusion/` 可能属于存活会话，不能当临时垃圾删除。

### 5. Observability 只记录必要 metadata

本地 trace 用于诊断执行链路，不是 prompt/内容审计系统。

- 不记录 prompt、stream 文本、HTTP header、工具参数、错误正文或工具结果正文。
- 只记录关联 ID、耗时、状态、模型、usage 和 allowlisted metadata/digest。
- 文件与目录保持私有权限；拒绝 symlink；写入有界并可禁用。
- `--no-session` 不落 trace，`ROTOM_OBSERVABILITY=0` 关闭写入。
- dashboard 只监听随机 loopback 端口，要求 Bearer token，不开放 CORS、不加载外部资源、不自动开浏览器。
- 分页窗口中的跨页生命周期结论显示 `N/A`，不能把 partial window 冒充完整 session。
- **唯一例外**：Computer Use trace 会记录界面操作的目标、证据与截图（用户 2026-11-03 明确要求），因为“它点了哪个控件”无法用纯 metadata 回答。例外范围写死：输入文本只存长度与 SHA-256，不存明文；不记对话、prompt 与工具结果正文；`0700`/`0600`、拒 symlink、7 天/单会话 500 MB 有界、永不上传、`ROTOM_CU_TRACE=0` 可关。细节见 [Computer Use trace](docs/agent/computer-use-trace.md)。

### 6. Browser 必须 observation-bound

Browser relay 的后台标签、AX/DOM ref、viewport、document generation 和 screenshot observationEpoch 都会失效。

- stale/ref evicted/受控窗口失效后，必须重新 `observe`，不能继续复用旧 state/ref。
- 坐标点击只用于无 ref 控件，并绑定最新 screenshot、CSS viewport、observationEpoch 与 dispatch 前 DOM hit-test。
- timeout/detached 只对原标签 recover 一次，最多重试原动作一次；不通过 close/open/claim 新标签伪装恢复。
- 默认先走 `browser_inspect/browser_interact`，仅当前运行尚未派发 Relay 页面请求、且本机 socket 缺失/拒绝连接时允许 `launch_browser` 一次；回退须说明独立 profile 不继承 Chrome 登录态。不以登录页、空结果、stale、timeout、unknown、取消、协议或权限错误授权回退，不跨浏览器重放写操作。显式排除 Relay 工具的调用方保留其工具选择。
- 不回退到 shell 激活 Chrome、系统鼠标键盘或桌面截图。
- 同一 session 内两层锁：结构性操作（`open`/`claim`/`close`/`tabs`/`switch`/`transfer`/`handoff`/`recover`/`hello`）独占 session 锁，其余按 tab 加锁，所以两个 tab 的读取可以真正并发；`browser_inspect` 因此是 `parallel`，`browser_interact` 仍是 `sequential`。operation revision 按锁作用域生效：一个 tab 结束不能作废另一个 tab 在飞的操作。
- 每个 tab 只属于一个 relay session：`discover` 不返回其他 agent 的 tab，`claim` 只在 opener 属于另一个 session 时拒绝，错误信息不带出对方 tabName。`transfer` 只能在同一个 `rootSessionId` 内移交，接收方得到 `<原名>@<来源 agent>` 并换新 `documentGeneration`/`observationEpoch`，移交前的 ref 与截图坐标一律作废。
- `console` 只捕获 agent 自己的 tab（`open` 时启用 `Runtime.enable`/`Log.enable`，claim 来的 tab 首次调用才启用），缓冲 500 条 / 2 KB / 全局 8 MB、丢最旧并用 `dropped` 报数，堆栈 ≤10 帧；`pattern` 只做大小写不敏感子串，不编译正则；结果按 128 KiB 截断并用 `nextCursor` 续读。tab 关闭、移交或分离时清空缓冲，service worker 重启后 `captureSince` 必须反映新的起点。
- 指针动作 `hover`/`dblclick`/`right_click` 复用 ref → 坐标 → hit-test 路径（dblclick 第二次按下带 `clickCount: 2`，right_click 用右键）；`drag` 要求 `targetRef` + `dropRef` 且至少 5 次按住移动，HTML5 拖放在拿不到 `Input.dragIntercepted` 时用合成 `DragData` 派发 CDP 拖拽事件——合成路径不触发 `dragstart`，页面必须从 `dataTransfer` 取数据，结果用 `dragDataSource`/`dragstartFired` 如实标注。拖拽不接受坐标参数。
- `upload` 只接受 `<input type="file">` 目标与绝对、真实的普通文件路径：符号链接、`nlink > 1`、目录、敏感文件名或目录名（含解析后的真实路径）、超过 10 个文件或 10 MB 一律在 Pi 侧拒绝，relay 收不到这些路径；audit 只留文件名摘要和大小。子 agent 另按 lease 的 `upload` capability 与 `allow.upload` 开关单独判定，缺省视为不允许。
- `browser_devtools` 是默认不常驻的延迟工具（`ROTOM_BROWSER_DEVTOOLS=0` 不注册），必须归入 deferred 组并显式 `defaultActive: false`：否则 Pi 在 fork/tree 导航时会把它当默认激活工具恢复，连带让延迟前置检查把未激活的 Subagent 工具判成致命缺失。`evaluate` 默认在 `Page.createIsolatedWorld` 的隔离世界执行，`world: "main"` 进页面 realm 对主 agent 不再逐次确认；子 agent 仍只上报 `needs-approval`（本地开发例外除外），超时或结果不确定按 unknown 处理且不重放；`viewport` 走 `Emulation` 并提升 observation epoch，改完坐标与视口测量全部作废。
- JS 弹窗（`alert`/`confirm`/`prompt`/`beforeunload`）挂起渲染进程：tab 上记录类型与按码点截断的消息，弹窗期间除 `dialog`/`tabs`/`close`/`recover` 外所有操作在派发前返回 `{ kind: "dialog-blocking", dialog }`，只有 `browser_interact` 的 `dialog`（`accept` + 可选 `promptText`）能推进。触发弹窗的输入用「派发 vs 弹窗检测」竞速：`mouseReleased` 要等弹窗被处理才被 ack，所以如实返回 `dialogOpened` + `dispatchSettled: false`，不谎称已派发完成，也不等到超时把结果说成 unknown。`beforeunload` 标 `sensitive: true`，人工确认在 T21 接入前不由本层提供。
- 批量动作 `actions`（≤10 步，与单个 `action` 互斥）逐步复用单动作路径，因此校验、lease、上传与弹窗闸门都不能被批量绕过；每一步单独写 intent/terminal audit，遇到 failed/unknown/navigation/dialog-blocking/expect-unmet/blocked 立即停下并报 `stoppedAt`+`stopReason`，已派发步骤绝不重放，结果只回摘要（不回每步整页内容）。
- `keypress` 只接受固定白名单（Enter/Tab/Escape/Backspace/Delete/Home/End/PageUp/PageDown/方向键/F1–F12/单个字母和数字/Space）加去重后的 `modifiers`；带 Control/Alt/Meta 时不带字符，macOS `Meta+A` 与其它平台 `Control+A` 走浏览器全选命令，Tab 只移动焦点不插入制表符，Shift 只改字母大小写。仍然先核验焦点、只用 CDP 按键事件，不用 `insertText` 冒充按键；白名单外的键在客户端与 SW 两侧都拒绝。
- `network` 只捕获 agent 自己的 tab（attach 时 `Network.enable`，两个 buffer 为 0，body 永不进 relay），缓冲 1000 条、只存 requestId/脱敏 URL/method/资源类型/status/mimeType/耗时/失败原因/是否来自缓存，绝不存请求头、响应头和 body；`failedOnly` 覆盖失败原因与 status ≥ 400，`pattern` 只做子串，结果按 128 KiB 截断并可续读。捕获从 attach 开始，打开页面的首个文档请求可能缺失；tab 关闭、移交或分离时清空缓冲。
- `navigate` 用一个操作承担新 URL 与 `history: back/forward/reload`：成功后 `documentGeneration` 加一（`reload` 不换 URL 也照样加），旧 ref 与截图坐标作废；历史落点先由扩展解析 origin 再按 lease 判定，拒绝时不发导航命令。导航等待 `complete` 的超时只说明“命令已发出”，不是失败回滚。
- tab 配额在扩展 service worker 里计数（`ROTOM_BROWSER_MAX_AGENTS` / `_TABS_PER_AGENT` / `_TABS` / `_TABS_PER_ORIGIN`，默认 8 / 4 / 24 / 2），`open` 与 `claim` 超限即时报错并提示先 close 旧 tab，不排队。SW 只做范围校验：客户端把环境变量解析成 `hello` 里的配额声明，任一字段不是 0–1000 的整数就整个声明回落到默认；四个上限连同“全局 24 个 tab”都按**请求方自己声明的值**判定，计数虽然跨 session 读取，阈值却不来自其它 session。它防的是失控而不是本机恶意客户端（对方可以自己声明 1000），所以别把它当强制总量。非法环境变量在客户端直接报错。
- 主 agent 的 Browser 默认完全访问，不再按站点或 capability 询问，`ctx.hasUI:false` 也可运行。显式 blocklist 仍优先：`~/Library/Application Support/rotom/browser-policy.json` 保持 0600、拒绝 symlink 与非法内容；旧 allowlist 继续可读，但新站点不需要保存授权。`read`/`interact`/`devtools`/`upload`/`download` 的区分继续用于子 lease；完全访问不取消上传文件校验、observation-bound 派发、origin 复核或 unknown 不重放。
- 下载只重定向 agent 自己打开的 tab：`rotom/<agentId>/` 子目录，claim 来的用户 tab 与用户自己的下载一律不碰；归属优先用 Chrome 的 `tabId`，缺失时只在该页面只有一个 agent tab 且没有用户 tab 同页时才认领（歧义即不动）。`browser_inspect` 的 `downloads` 只回相对路径/大小/MIME/`sha256`（>64 MB 只报大小），绝对路径留给 Pi 自己算摘要；子 agent 另按 `allow.download` 判定，未授权由 relay 取消并返回 `needs-approval`。`downloads` 是扩展新增的唯一权限，用户会看到一次新的权限提示。
- 主 agent 的敏感动作不再询问用户：命中敏感词或 `cc-*` 表单时，relay 仍先返回 `{kind:"needs-confirmation"}` 且不派发；Pi 自动批准并仅重发一次 `confirmed:true`，不是 unknown 重放。`upload` 与 `beforeunload` 在 Pi 预检时自动批准；审计记 `auto-full-access`，不伪称用户确认。主 agent 的 devtools 主世界同样不询问。子 agent 仍上报 `needs-approval`，不代替用户确认；旧 `ROTOM_BROWSER_CONFIRM=auto-approve-localhost` 仅保留子 agent 的本地开发例外。安装、注册或重载浏览器组件仍须用户显式操作。
- 重定向不能绕过授权：relay 在派发写操作前用 `chrome.tabs.get` 取当前 origin，与 Pi 侧本次会话真正授权过的 origin 集合比对，不匹配就返回 `{kind:"needs-approval",reason:"origin"}` 且不派发；客户端把 policy 拒绝和 relay 拒绝都当作干净拒绝（不是 unknown），调用方不得重试。
- 子 agent 的浏览器权限仍由 lease 决定：父 agent 实际检查过的 origin **和 capability**（`read`/`interact`/`devtools`/`upload`/`download`）发布为子任务范围，不从列出的 tab URL 推断授权，也不把所有网站交给子 agent。私有 lease 文件保持目录 0700、文件 0600、拒绝 symlink；子 agent 每次 `open`、页内写操作与 `devtools` 前重读。父 agent 的完全访问不自动扩大已运行子任务的 lease；只读 grant 不会变成 interact。缺失、过期、origin/capability 不匹配或开关未开启时，返回 `{kind:"needs-approval",origin,capability,reason}` 且不派发、不询问；只读操作仍不受 lease 限制。旧字符串 origin 按只读解释。lease 不是 OS 安全沙箱。
- 安装与重载是用户显式操作；代码级 L1 不能写成真实 Chrome L2/L3。
- Linux 上后台 tab 不保证产出合成帧：页面在 focus emulation 下会报告 `visible`，但渲染进程可能不再给帧（评审在 Linux 上实测：focus emulation 开关过几轮后，按住指针的每次 `mouseMoved` 要约 1 s 等合成帧确认）。因此 `drag`、`screenshot` 与依赖渲染帧的懒加载长列表 `read_full` 可能完不成，结果如实报 timeout/unknown/`contentComplete: false`，之后同 session 的 `tabs`/`close` 仍可用。这是 Chrome 在 Linux 上合成后台 tab 的内部行为，用户已决定记为已知限制（2026-11-07）；不得为绕过它把 agent tab 变成用户前台的可见 tab，也不得把超时改写成成功。macOS 的后台 tab 同样没有环境帧（实测 1.5 s 内 0 帧 rAF），但读路径靠 focus emulation 能正常完成。
- 客户端取消（用户中断或 Pi 侧超时）只终止客户端等待，扩展里的操作会跑到自己的 deadline 并一直占着该 tab 的读锁；relay 没有“取消某次操作”的消息。`recover` 不是脱身手段：结构性操作（`recover`/`open`/`claim`/`close`/`tabs`/`switch`/`transfer`/`handoff`）要拿 session 写锁，而写锁必须等所有在跑的 tab 操作结束，所以它同样卡到那个 deadline；FIFO 队列还让排着的结构性操作挡住之后所有 tab 的读写。能立刻继续的只有“在另一个已打开的 tab 上读写且队列里没有结构性操作在等”。`screenshot` 期间会开 focus emulation，所以页面会收到 `visibilitychange`/`focus`（`document.visibilityState` 短暂变成 `visible`），这是读操作对页面的可观察副作用。
- socket、锁与 native host 注册位置只由 `rotom/extensions/browser/platform-paths.mjs` 决定：macOS 字符串冻结（改了就断升级），Linux 走 XDG runtime，Windows 是命名管道与 `HKCU` 注册表。Windows 分支只有代码与单测证据，安装器只打印 `reg add` 命令，不冒充实测通过。

## 公开前隐私边界

命令、精确例外与上游误报清单见 [privacy-release.md](docs/agent/privacy-release.md)。

- 公开前对准备上传的独立仓库跑 `python3 scripts/audit-public.py --root . --history`，npm 构建还须审计实际 tgz；扫描只报位置与摘要，不回显敏感值。
- 含私有维护历史的仓库不能直接推送：只删当前文件清不掉旧提交，须从清理后的 tracked tree 以 GitHub noreply 身份另建无旧历史的公开副本，不复制 `.git`、HOME、会话或凭据。
- `.pi/` 靠 ignore 隐藏、不清理活跃运行时；不得按维护者 HOME 自动接入私人 recorder。
- 不修改锁定归档或 installed source 来消除误报；扫描通过不是“无任意秘密或代码所有权风险”的证明。

## 补充安全边界

- 不在仓库根新增运行时 `.pi/.claude/.agents` 资源或 AGENTS；现有维护 skill 不进入产品 bundle。被撤销的能力只查 Git history，不恢复兼容壳。
- 真实全文需完整 scroll-end 与读完分页；visible snapshot 不能冒充全文。未知取消/owner-loss 不重放。
- 主会话保留决策、实现和最终验证；仅按需要委派边界清晰的检索/机械工作，不把普通任务强制升级为 scout→批准→worker→多 reviewer 流程。单 writer、取消和 unknown 边界不变。

## 按任务加载

不预读全部文档；需要定位时先检索并读取相关小节。

| 场景 | 参考 |
|---|---|
| 术语、架构、代码定位或首次安装 | [架构与地图](docs/agent/architecture.md) |
| 修改对应领域/边界 | [检查清单](docs/agent/change-checklists.md)，只展开受影响领域 |
| 普通代码、UI、跨边界或发布验证 | [验证与交付](docs/agent/verification.md)，按下述范围选择小节 |
| 改 Agent 行为（policy、工具、续跑、上下文）、挖掘真实失败、回归 gate 与实验账本 | [Agent 优化循环](docs/agent/optimization-loop.md) |

## 最小验证与完成条件

按风险选能证明本次改动的最小验证；具体命令、扩大门与发布 gate 见 [verification.md](docs/agent/verification.md)。

- 纯文档/Agent 配置：`git diff --check` 并核对引用路径、命令、合同与边界；不构建、不启动 App、不升版本。改可执行脚本按代码处理。
- 普通代码：运行受影响测试及本项目对应 type/lint/build，不把全量发布 gate 套到小改动。
- Browser 性能相关改动：同机跑 `bench.mjs` 对照基线，报告改动前后的 P50/P95；只快但少读了内容（`nodes`、`steps`、`contentCoverage` 变了）按错误处理。
- UI 修复：记录原始操作、预期及相邻路径，补 focused 回归，在当前版本真实 App 重放；构建/自动测试与真实交互结果分别报告，截图/设备/Provider 不可用则明确未验证。
- 跨核心安全/持久化边界、高风险合入或发布：真实外部操作、成本和设备授权不可由本地测试替代。
- 可继续修授权范围内的本地失败并重跑受影响检查；既有失败单列、不顺手扩大，外部未知/授权不足/需用户决定时停下交接。
- 本仓库已明确要求持续同步公开仓库：完成并验证每次任务后，除非用户明确要求不推送，默认将本次相关改动以可读 commit 粒度同步到公开 `origin/main`，不等到 npm 打包或 release 才集中推送；已有 WIP、敏感内容和未验证改动不混入。
- 本地维护历史与公开历史分叉时，不直接或强制推送私有历史；从最新公开基线创建独立干净副本，以 GitHub noreply 身份重放本次 diff，运行 public audit 后仅作 fast-forward push。报告实际检查、未验证项和远端 commit，不用 L1/L2 冒充 L3。
- 改动 `rotom/extensions/**`、`rotom/runtime/**`、`rotom/skills/**`、`rotom/bin/**`、`packages/**` 的 commit 必须在消息里带 `Ledger: L-YYYY-MM-DD-slug` 或 `Ledger: none — <理由>` trailer；只改测试、文档或 evals 的 commit 不受这条限制。commit-msg hook 会拦，被拦时补账本条目而不是关 hook：循环之外做的机制或提示改动同样要入账，否则历史里只剩一个说不清归属的 diff。
- **每次推送前**跑 `python3 scripts/audit-public.py --root . --history-range <base>..<head>`（pre-push hook 已自动执行同一命令）：它扫这次推送新增的 commit、其 blob 和提交身份，只跑 tree 模式看不到提交身份，而身份泄露只能靠改写历史修复。发布独立仓库或改写历史后仍须跑全量 `--history`。历史模式（`--history` 与 `--history-range` 共用同一套规则）只放行 `*@users.noreply.github.com`、提交者为 `noreply@github.com`（GitHub 网页合并）和精确地址 `noreply@anthropic.com`（维护者已同意的历史豁免），同域名其他地址照样拦。pre-push hook 先按这条规则拦身份、再跑范围审计，被拦下时按它打印的命令改写，不用 `--no-verify` 绕过。

## 代码风格与品味

先理解真实需求和调用链，在正确抽象层选择最小实现。机械合同交给确定性检查；需要判断的最小实现、失败边界、授权与表达规则只维护在 [质量规则与 Review](docs/agent/verification.md#质量规则与-review)，不再叠加另一套提示词。该节列出检查入口、例外和未覆盖范围；测试通过不替代真实任务验收。
