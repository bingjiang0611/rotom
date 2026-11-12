# CLAUDE.md

# rotom

rotom（原 Dev Agent）是独立维护的 Pi personal coding agent 能力包。仓库根目录是**维护面**，`rotom/` 才是运行时产品。

产品与仓库名均为全小写 **rotom**，唯一项目仓库为 [bingjiang0611/rotom](https://github.com/bingjiang0611/rotom)。源码公开不等于 npm 发布或许可证批准。npm 产品包位于 `rotom/`，公开命令为 `rotom`（公开 bin `rotom/bin/rotom` 只解析并 exec 唯一内部 launcher `rotom/bin/rotom-launcher`）。产品目录、`ROTOM_*` 环境变量与自有 package 名（如 `rotom-third-party-runtime`）已统一为 rotom；上游 identity 和下述兼容性标识有意保留。**本地维护仓目录 `dev-agent`** 保持不变，公开文档使用 checkout 无关路径；发行包接入不等于迁移活跃会话或浏览器绑定。

**有意保留的上游名称与兼容性标识**（不是品牌改名遗漏）：
- `@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`：上游 Pi package 名，不能按产品品牌改写。
- Rotom 的公开命令与 UI 品牌仍为 `rotom`，但主进程/RPC 的兼容身份保留为 `pi` / `pi-rpc`，使按进程识别 Pi 的外部集成继续生效。
- 内化组件仍使用 `pi-subagents`、`@injaneity/pi-computer-use`、`@narumitw/pi-goal` 等 npm identity，以及 `PI_SUBAGENTS_*` / `PI_COMPUTER_USE_*` 等上游配置合同。
- `dev-agent-deferred-tools-state`、`dev-agent-context-footprint/v1`、`dev-agent-context-footprint-report/v3` 保留为持久化/报告兼容性标识，不能只改文档或静默迁移。历史归档版本、实验身份与上游 CHANGELOG 也不按品牌批量替换。
- eval harbor 适配器里的 `dev-agent-pi` / `DevAgentPi` / `test_..._harbor_pi_agent` 是被保留的 `dev-agent` eval 身份与通用 "pi agent" 措辞，不是产品品牌串。

Browser relay 的协议 kind、native host id 与显示品牌已统一为 rotom；改名代价与旧 relay 的迁移方式见 [Browser 合同](docs/agent/contracts/browser.md)。

本文只约束在本仓库内工作的 Agent 与维护者，不是要注入目标 Pi session 的身份 prompt。用户的明确要求可以覆盖一般偏好，但不能静默绕过运行时资源身份、敏感数据边界或验证门禁。具体版本号以 `rotom/runtime/product-config.mjs` 与 `rotom/runtime/pi/fork-build.json` 为准，本文不抄写版本。

## 我们绝不妥协的事情

本节每条只给原则。各领域的完整合同在 `docs/agent/contracts/`，与本文具有同等约束力；**改动某个领域之前必须先读完对应合同**。

### 1. Pi 接入与维护 — [完整合同](docs/agent/contracts/pi-runtime.md)

- 通过仓内 `packages/rotom-pi/` 的 Pi fork 接入；默认只从产品 `runtime/pi/node_modules/` 解析固定 fork，不回退 PATH、global 或旁路 Pi。`ROTOM_PI`、`ROTOM_NODE` 是显式维护覆盖，仍须通过 identity/capability gate。
- 允许按任务需要修改或 fork Pi、使用私有 Extension API；相关改动要说明兼容性影响并完成对应验证。Pi 源码或构建器改动后必须 `npm run build:pi`，`check:pi` 通过才算可交付。
- launcher 保留业务 cwd 和用户 argv；仓库根不能冒充用户项目。
- **npm publish 是不可逆外部写入**：只有用户明确授权精确 version 与 dist-tag 才进入发布流程，缺任一项就停下询问；npm 认证与 publish 命令由用户在自己的前台终端执行，Agent 不接触密码、OTP 或 token。完整顺序见 [npm 发布顺序](docs/agent/contracts/npm-release.md)。

### 2. 运行时资源必须可证明 — [完整合同](docs/agent/contracts/runtime-resources.md)

- extension、bundled skill 与第三方 package 是产品合同，以 `product-config.mjs` 和 launcher 的显式声明为准；版本、lockfile integrity 与 installed identity 必须同步；拒绝 symlink、越界路径和 canonical 漂移。
- 不原地覆盖存活会话使用的安装；`node_modules/` 里的调试改动必须固化到受版本管理的源码或可复现 patch。
- Qoder provider 的凭据、路由、重试与 credits 计量（unknown 不冒充、美元费用未知须披露）按完整合同执行。
- 已退出产品面的能力不因第三方包仍有同名实现而恢复；已删除的实现只查 Git history，没有新证据不重建。

### 3. 工具面要小、显式且诚实 — [完整合同](docs/agent/contracts/tool-surface.md)

- deferred-tool loading 只按需扩展工具面；`ROTOM_DEFERRED_TOOLS=0` 必须恢复完整工具面；用户显式的工具选择与 runtime policy 优先。
- Goal、Context Layers、SoL-Pi、Compaction Offload 与 Provider 重试合同的细节以完整合同为准；模型行为指引不是权限拦截器，也不是安全沙箱。
- 不把静态 bytes、byte/4 或固定 canary 写成 provider 精确 token、成本或延迟收益；新能力只有通过对应 L1/L2/L3 后才能对外声明为已启用。

### 4. 本机执行不等于安全隔离 — [完整合同](docs/agent/contracts/local-execution.md)

- Pi 原生工具、Browser 和 Computer Use 都以本机用户权限运行；Computer Use 的确认面只是同意层，不是隔离层。
- 外部写执行一次，随后按同坐标 readback；失败、超时或无法证明时返回 `unknown`，不盲目重试或自动回滚。
- 环境、发布阶段和 scope 必须来自当前请求或权威 preflight；`.pi/tasks/`、`.pi/delegate/`、`.pi/fusion/` 可能属于存活会话，不能当临时垃圾删除。

### 5. Observability 只记录必要 metadata

本地 trace 用于诊断执行链路，不是 prompt/内容审计系统。

- 不记录 prompt、stream 文本、HTTP header、工具参数、错误正文或工具结果正文。
- 只记录关联 ID、耗时、状态、模型、usage 和 allowlisted metadata/digest。
- 文件与目录保持私有权限；拒绝 symlink；写入有界并可禁用。
- `--no-session` 不落 trace，`ROTOM_OBSERVABILITY=0` 关闭写入。
- dashboard 只监听随机 loopback 端口，要求 Bearer token，不开放 CORS、不加载外部资源、不自动开浏览器。
- 分页窗口中的跨页生命周期结论显示 `N/A`，不能把 partial window 冒充完整 session。
- **唯一例外**：Computer Use trace 会记录界面操作的目标、证据与截图（用户 2026-11-03 明确要求），因为“它点了哪个控件”无法用纯 metadata 回答。例外范围写死：输入文本只存长度与 SHA-256，不存明文；不记对话、prompt 与工具结果正文；`0700`/`0600`、拒 symlink、7 天/单会话 500 MB 有界、永不上传、`ROTOM_CU_TRACE=0` 可关。细节见 [Computer Use trace](docs/agent/computer-use-trace.md)。

### 6. Browser 必须 observation-bound — [完整合同](docs/agent/contracts/browser.md)

- 后台标签、AX/DOM ref、viewport、document generation 与 screenshot observationEpoch 都会失效：失效后必须重新 `observe`；坐标点击只用于无 ref 控件，并绑定最新截图与派发前的 DOM hit-test。
- timeout/detached 只对原标签 recover 一次，最多重试原动作一次；不回退到 shell 激活 Chrome、系统鼠标键盘或桌面截图。
- 子 agent 的浏览器权限由 lease 决定；安装、注册与重载浏览器组件是用户显式操作；代码级 L1 不能写成真实 Chrome L2/L3。

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
- **改写公开历史**（任何强推、filter-repo、对已推送 commit 的 rebase/amend）必须由用户逐次明确授权；完成后在报告与账本中写明改写范围、原因、改写前后的 SHA，并跑一次全量 `--history` 审计。其他分支若仍基于旧历史，一并报告。
- **不推送、不合并其他会话尚未推送的 commit**；在共享分支或共享工作区发现这类 commit 时，先问用户，不替那个会话决定合并方向。

## 按任务加载

不预读全部文档；需要定位时先检索并读取相关小节。改动下表左列的领域之前，必须先读右列文档。

| 场景 | 必读 |
|---|---|
| 术语、架构、代码定位或首次安装 | [架构与地图](docs/agent/architecture.md) |
| 修改对应领域/边界 | [检查清单](docs/agent/change-checklists.md)，只展开受影响领域 |
| 普通代码、UI、跨边界或发布验证 | [验证与交付](docs/agent/verification.md)，按下述范围选择小节 |
| Pi fork、launcher、runtime 解析 | [Pi 接入与维护合同](docs/agent/contracts/pi-runtime.md) |
| npm 打包与发布 | [npm 发布顺序](docs/agent/contracts/npm-release.md) |
| 产品资源、第三方包、Qoder provider | [运行时资源合同](docs/agent/contracts/runtime-resources.md) |
| 工具面、deferred loading、Goal、Context Layers、SoL-Pi、重试 | [工具面合同](docs/agent/contracts/tool-surface.md) |
| Computer Use、外部写入、本机权限 | [本机执行合同](docs/agent/contracts/local-execution.md) |
| Browser relay 与 chrome-extension | [Browser 合同](docs/agent/contracts/browser.md) |
| 改 Agent 行为（policy、工具、续跑、上下文）、挖掘真实失败、回归 gate 与实验账本 | [Agent 优化循环](docs/agent/optimization-loop.md) |

## 最小验证与完成条件

按风险选能证明本次改动的最小验证；具体命令、扩大门与发布 gate 见 [verification.md](docs/agent/verification.md)。

- 纯文档/Agent 配置：`git diff --check` 并核对引用路径、命令、合同与边界；不构建、不启动 App、不升版本。改可执行脚本按代码处理。
- 普通代码：运行受影响测试及本项目对应 type/lint/build，不把全量发布 gate 套到小改动。
- Browser 性能相关改动：同机跑 `bench.mjs` 对照基线，报告改动前后的 P50/P95；只快但少读了内容（`nodes`、`steps`、`contentCoverage` 变了）按错误处理。
- UI 修复：记录原始操作、预期及相邻路径，补 focused 回归，在当前版本真实 App 重放；构建/自动测试与真实交互结果分别报告，截图/设备/Provider 不可用则明确未验证。
- 跨核心安全/持久化边界、高风险合入或发布：真实外部操作、成本和设备授权不可由本地测试替代。
- **产品改动只有进入实际加载的 runtime 才算交付**：`check:pi` 通过、在 installed dist 中能找到改动、会话 build-info 的 commit 能追溯到它。只推了源码、没重建 fork 或没打进包，都不能报告为已交付。
- 可继续修授权范围内的本地失败并重跑受影响检查；既有失败单列、不顺手扩大，外部未知/授权不足/需用户决定时停下交接。
- 本仓库已明确要求持续同步公开仓库：完成并验证每次任务后，除非用户明确要求不推送，默认将本次相关改动以可读 commit 粒度同步到公开 `origin/main`，不等到 npm 打包或 release 才集中推送；已有 WIP、敏感内容和未验证改动不混入。
- 本地维护历史与公开历史分叉时，不直接或强制推送私有历史；从最新公开基线创建独立干净副本，以 GitHub noreply 身份重放本次 diff，运行 public audit 后仅作 fast-forward push。报告实际检查、未验证项和远端 commit，不用 L1/L2 冒充 L3。
- 改动 `rotom/extensions/**`、`rotom/runtime/**`、`rotom/skills/**`、`rotom/bin/**`、`packages/**` 的 commit 必须带 `Ledger: L-YYYY-MM-DD-slug` 或 `Ledger: none — <理由>` trailer（只改测试、文档或 evals 的除外）；commit-msg hook 会拦，被拦时补账本条目，不关 hook。
- 每次推送前跑 `python3 scripts/audit-public.py --root . --history-range <base>..<head>`（pre-push hook 会自动执行，并先拦非 noreply 身份）；被拦时按它打印的命令修正，不用 `--no-verify` 绕过。身份规则与豁免见 [privacy-release.md](docs/agent/privacy-release.md)。

## 代码风格与品味

先理解真实需求和调用链，在正确抽象层选择最小实现。机械合同交给确定性检查；需要判断的最小实现、失败边界、授权与表达规则只维护在 [质量规则与 Review](docs/agent/verification.md#质量规则与-review)，不再叠加另一套提示词。该节列出检查入口、例外和未覆盖范围；测试通过不替代真实任务验收。
