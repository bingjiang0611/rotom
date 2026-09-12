# CLAUDE.md

# rotom

rotom（原 Dev Agent）是独立维护的 Pi personal coding agent 能力包。仓库根目录是**维护面**，`rotom/` 才是运行时产品。

产品与仓库名均为全小写 **rotom**，唯一项目仓库为 [bingjiang0611/rotom](https://github.com/bingjiang0611/rotom)。源码公开不等于 npm 发布或许可证批准。npm 产品包位于 `rotom/`，公开命令为 `rotom`（公开 bin `rotom/bin/rotom` 只解析并 exec 唯一内部 launcher `rotom/bin/rotom-launcher`）。产品目录、`ROTOM_*` 环境变量与自有 package 名（如 `rotom-third-party-runtime`）已统一为 rotom；上游 identity 和下述兼容性标识有意保留。**本地维护仓目录 `dev-agent`** 保持不变，公开文档使用 checkout 无关路径；发行包接入不等于迁移活跃会话或浏览器绑定。

**有意保留的上游名称与兼容性标识**（不是品牌改名遗漏）：
- `@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`：上游 Pi package 名，不能按产品品牌改写。
- 内化组件仍使用 `pi-subagents`、`@injaneity/pi-computer-use`、`@narumitw/pi-goal` 等 npm identity，以及 `PI_SUBAGENTS_*` / `PI_COMPUTER_USE_*` 等上游配置合同。
- `dev-agent-deferred-tools-state`、`dev-agent-context-footprint/v1`、`dev-agent-context-footprint-report/v3` 保留为持久化/报告兼容性标识，不能只改文档或静默迁移。历史归档版本、实验身份与上游 CHANGELOG 也不按品牌批量替换。

Browser relay 的 wire-protocol message kind（`rotom-browser-*`）、native messaging host id（`dev.rotom.browser_relay`）与显示品牌（"Rotom Browser Relay" / "Rotom Trace Dashboard"）已随全量改名统一为 rotom，TS relay 与 `chrome-extension/` 两侧同步。**代价（维护者已确认接受）**：任何在改名前安装的旧 Chrome relay 会因协议 kind 与 host id 变化而失联；用户须显式重装/重载 extension 并重跑 `install-chrome-relay` 以按新 host id `dev.rotom.browser_relay` 重新注册 native host。旧的 `dev.pi_agent.browser_relay.json` host manifest 会成为孤儿文件，可自行清理。

（eval harbor 适配器里的 `dev-agent-pi` / `DevAgentPi` / `test_..._harbor_pi_agent` 用的是被保留的 `dev-agent` eval 身份与通用 "pi agent" 措辞，非产品品牌串，保持不变。）

本文只约束在本仓库内工作的 Agent 与维护者，不是要注入目标 Pi session 的身份 prompt。用户的明确要求可以覆盖一般偏好，但不能静默绕过运行时资源身份、敏感数据边界或验证门禁。

## 我们绝不妥协的事情

### 1. Pi 接入与维护

rotom 当前通过仓内 `packages/rotom-pi/` 的 Pi fork 接入 `@earendil-works/pi-coding-agent`，不再默认依赖官方 npm Pi 或旁边的 Pi checkout。公开 API 与组合层是优先方案，不是强制边界；允许按任务需要修改或 fork Pi、使用私有 Extension API，以及调整或自行实现生命周期。相关改动需说明兼容性影响并完成对应验证。

- `rotom/bin/rotom` 是 npm 公开入口，只解析 bin symlink 并 exec 唯一内部 launcher `rotom/bin/rotom-launcher`。
- 默认仅从产品 `runtime/pi/node_modules/` 解析固定 Pi fork；六个运行时包由仓内源码构建，归档、lock、源码/构建器摘要和 installed identity 必须匹配，不查 ancestor hoisting、不回退 PATH/global/旁路 Pi。`ROTOM_PI` 是显式维护覆盖，仍过原有 identity/capability gate，不代表默认发行版本。
- Pi 源码或构建器改动后先 `cd rotom && npm run build:pi`；发布维护命令为 `npm run pack:release -- /absolute/output-dir`：拒绝陈旧 fork 归档，隔离 HOME/cache、按锁文件新安装 Pi fork 与第三方依赖后打包；禁止复制维护者 node_modules 或把评测、会话、凭据带入发行包。保持 `private: true`，直到发布与许可证另获批准。
- `pack:release` 偶发 `spawnSync npm ETIMEDOUT` 先排查是不是自己造成的资源/网络争用（把多次 pack 塞进循环、同时跑重度任务、残留 staging 堆积），不是脚本 300s/单调用 cap 太紧或基础设施故障：隔离单次 `npm ci` 实测远低于该 cap（根与第三方各数十秒）。清掉 `$TMPDIR/rotom-release-*` 残留后单次干净重跑即可，不要为此放宽 timeout 或改发布脚本。
- launcher 保留业务 cwd 和用户 argv；仓库根不能冒充用户项目。
- `ROTOM_PI`、`ROTOM_NODE` 只接受绝对、存在、可执行的普通文件；解析 realpath 后固定同一 executable。
- Pi package identity、`bin.pi`、公开 exports 和当前能力必须在启动前验证。
- 允许直接修改 Pi 或第三方 package 的源码及 installed source；选择源码、wrapper、adapter 或 policy seam 时以问题归属和可维护性为准。

### 2. 运行时资源必须可证明

extension、bundled skill 与第三方 package 是产品合同，不是“目录里碰巧存在的文件”。产品不再加载 bundled prompt template；用户自己的模板仍走 Pi 原生发现。

- 资源列表以 `rotom/runtime/product-config.mjs` 和 launcher 的显式声明为准。
- Qoder 为 bundled opt-in provider（`ROTOM_QODER=1`），保留 `qoder-experimental` 身份与 `lite`/`performance` 离线基线；账号目录按原始 key 发现，只注册实测白名单 ∩ 当前账号 enabled 的交集，不改默认模型；未验证的 opaque 形状、档位与路由不启用。目录只在账号隔离内存中、过期需刷新，可见不等于 direct endpoint 可调用。具体目录项、路由数、版本头与窗口大小随上游变动，不写进本文件。
- 凭据默认走 `browser`（Pi 原生登录/存储/串行刷新、复用公开客户端 ID，非官方支持），不读写 CLI 凭据；显式 `ROTOM_QODER_AUTH=qodercli` 回到只读 CLI 兼容模式。刷新前持久记录一次性尝试、unknown 不重放、只强制隔离凭据的本地到期（不冒充自然到期）；重新登录或认证来源变化须新会话。opaque signature 字段按各自 Pi signature 原样存回，不解密、不跨模型丢弃。
- 每条路由固定走 COSY 单次推理或 direct，不失败回退、不嵌套 agent；只按实测交集开放 effort，其余固定 enabled，不伪造关闭/强度支持。服务尾帧仅在 finish、usage 与精确 metrics 同时成立时映射终止，不以 EOF 补成功。
- 仅图片档模型开放 PNG/JPEG/WebP 与受管上下文窗口，其余仅文本、上下文与输出均有界；单图与历史图片总量有预算，拒绝远程 URL，不宣称完整 400K/1M。
- Credit 只记录完整流中有效的服务端 credits/billable，缺失/错误/取消/冲突保持 unknown；会话 subtotal 为 partial、billable-reported，不是完整账本或 USD。`/qoder-credits` 只读账号快照，不进对话/压缩/摘要，不由余额差值推断单次费用。美元费用未知、Pi $0 占位与上游支持/许可未确认必须显式披露。
- 第三方 package 使用精确版本、lockfile integrity 和 installed package identity；`package.json`、`package-lock.json`、`product-config.mjs` 必须同步。发行包的 Pi fork 另由 `rotom/runtime/pi/package.json`、`package-lock.json`、`fork-build.json` 和 product config 固定版本/integrity；顶层 `npm-shrinkwrap.json` 不再声明外部 Pi。
- 运行时资源拒绝 symlink、越界路径和 canonical 漂移。
- `node_modules/` 可用于本地调试和验证修改，但重装会覆盖；交付时将改动固化到受版本管理的源码或可复现 patch，并同步依赖与 identity 合同。不要原地覆盖存活会话使用的安装。
- 已退出产品面的 Verification、Experience、Safety、Containment、Background/Fusion、LSP、MCP、旧自有 Execution/Subagent/Goal、compact-policy、task-state、baseline、`refine`、`simplify` 和独立 community 不因第三方包仍有同名实现而恢复。当前 Subagent 与 `/goal` 由显式声明的内化组件经自有 wrapper 接入，不是恢复旧框架。

### 3. 工具面要小、显式且诚实

默认 deferred-tool loading 常驻 core、Ask、Browser/Computer Use、Goal 三工具与 `search_tools`，只把 Subagent 按需 additive 激活。Goal `0.54.4-rotom.0` 从启动起保持稳定 schema；工具可见不等于 Goal 模式启用，无 active goal 时拒绝执行，也不覆盖显式工具限制。它是 context-footprint 优化，不是安全沙箱。

- `ROTOM_DEFERRED_TOOLS=0` 必须恢复完整工具面。
- 用户显式 `--tools`、`--exclude-tools` 或 runtime policy 优先；launcher 仅在没有 tool-selection flag 时授权 loader 收窄 reviewed default，extension/SDK 直载默认保留调用方 active set。
- 已加载 specialized tools 在当前 session 内不主动移除；group state 与 active tool 子序列按 product declaration order canonicalize，相同 group 集合不因加载顺序产生不同最终 identity。
- resume/fork 必须恢复 capability state；升级前无 deferred state 的旧 session 允许首次多一次 `search_tools`。
- 不把静态 bytes、byte/4 或固定 canary 写成 provider 精确 token、成本或全局延迟收益。
- 新能力只有接入完成并通过对应 L1/L2/L3 后才能对外声明为已启用；当前事实以运行时合同、测试和本文件为准。

### 4. 本机执行不等于安全隔离

Pi 原生工具、Browser 和 Computer Use 都以启动 Pi 的本机用户权限运行。产品当前没有 Safety、Containment、QEMU、权限 preset/profile 或统一确认层。

- 外部写执行一次，随后按同坐标 readback；失败、超时或无法证明时返回 `unknown`，不盲目重试或自动回滚。
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

### 6. Browser 必须 observation-bound

Browser relay 的后台标签、AX/DOM ref、viewport、document generation 和 screenshot observationEpoch 都会失效。

- stale/ref evicted/受控窗口失效后，必须重新 `observe`，不能继续复用旧 state/ref。
- 坐标点击只用于无 ref 控件，并绑定最新 screenshot、CSS viewport、observationEpoch 与 dispatch 前 DOM hit-test。
- timeout/detached 只对原标签 recover 一次，最多重试原动作一次；不通过 close/open/claim 新标签伪装恢复。
- 默认先走 `browser_inspect/browser_interact`，仅当前运行尚未派发 Relay 页面请求、且本机 socket 缺失/拒绝连接时允许 `launch_browser` 一次；回退须说明独立 profile 不继承 Chrome 登录态。不以登录页、空结果、stale、timeout、unknown、取消、协议或权限错误授权回退，不跨浏览器重放写操作。显式排除 Relay 工具的调用方保留其工具选择。
- 不回退到 shell 激活 Chrome、系统鼠标键盘或桌面截图。
- Chrome extension 安装与重载是用户显式操作；代码级 L1 不能写成真实 Chrome L2/L3。

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

## 最小验证与完成条件

按风险选能证明本次改动的最小验证；具体命令、扩大门与发布 gate 见 [verification.md](docs/agent/verification.md)。

- 纯文档/Agent 配置：`git diff --check` 并核对引用路径、命令、合同与边界；不构建、不启动 App、不升版本。改可执行脚本按代码处理。
- 普通代码：运行受影响测试及本项目对应 type/lint/build，不把全量发布 gate 套到小改动。
- UI 修复：记录原始操作、预期及相邻路径，补 focused 回归，在当前版本真实 App 重放；构建/自动测试与真实交互结果分别报告，截图/设备/Provider 不可用则明确未验证。
- 跨核心安全/持久化边界、高风险合入或发布：真实外部操作、成本和设备授权不可由本地测试替代。
- 可继续修授权范围内的本地失败并重跑受影响检查；既有失败单列、不顺手扩大，外部未知/授权不足/需用户决定时停下交接。
- 默认只提交本次相关改动、不 push，已有 WIP 不混入；报告改动、实际检查、未验证项，不用 L1/L2 冒充 L3。

## 代码风格与品味

- 先理解真实能力边界，再选择最小合适改动面；组合层与 Pi 源码修改均可。
- 优先扩展现有小合同和 wrapper；需要新增 registry 或 lifecycle 实现时，说明必要性与维护成本，避免 speculative abstraction。
- fail closed 用于 executable/resource identity、路径、授权 scope；fail open 只用于不应阻断用户工作的可选观测附加路径。
- `unknown`、unavailable、partial 和 blocked 是一等状态，不压成布尔成功/失败。
- 注释解释信任边界、失败模式、为何必须如此，不逐行翻译代码。
- 中文用于维护/用户边界说明，代码 identifier 与稳定合同保持英文。
- 如果规则与真实任务冲突，先说明冲突并取得维护者明确同意，不要静默绕过。
