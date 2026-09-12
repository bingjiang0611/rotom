# 第十批：首版 admission、公开入口与显式初始化

**状态：隔离候选，尚不可宣称采用完成。** installed 仍是 `pi-subagents@0.52.1-dev-agent-followthrough.2`；未切换依赖、推送或迁移会话；本批未修复/新建 VM，后续独立授权的 Linux 验证见[第十一批](subagent-owned-linux.md)。承接[采用合同](../../../docs/agent/subagent-external-adoption-contract.md)中用户确认的首版收窄，以及[第九批](subagent-owned-session.md)的 v3 store / v2 opaque lease。Linux 真进程 gate 已在后续完成，独立发行身份和产品接入验收仍待完成。

## 实现与边界

- 第七层维护 patch：[subagent-owned-flat-candidate.patch](subagent-owned-flat-candidate.patch)，由 [prepare-owned-flat.mjs](fixtures/prepare-owned-flat.mjs)核验第九层精确 preimage 后，仅应用于私有源码副本。不修改 installed source。
- 在 executor 初始请求、原始 workflow admission、动态 child launch、最终 agent discovery snapshot 和恢复目标上核验首版路由。拒绝 nested、chains/tasks、managed worktree、gate/verify/review、fork/import、external-job、独立 foreground、foreground controller，以及非法 async/worktree 值、clarify/foregroundOnly 和伪造 child identity。workflow engine 会把 `async:null` 变成 false，因此类型检查必须早于该转换。
- Pi agent 须显式列出工具名称和 extensions，拒绝隐式工具、wildcard、工具扩展路径及 ambient discovery；native recovery 也检查这份合同。扩展仍是受信任的本机代码，不是经过能力认证的 sandbox。
- ownership admission 延迟至最后验证之后、writer setup 之前的已有 launch observer。明确拒绝没有悬空 admission；已经 admission 后的失联/缺证据仍保留容量，不伪造闭合。
- scoped 公开 `{agent, task, async:true}` 直接持有实际 single runner ID。旧公开转换会把它变成默认 foreground workflow child，使 external CLI 被拒绝；不能简单改为 async child receipt、让 parent result 提前完成。legacy 转换不变。
- 固定 scoped description/prompt 覆盖 full/compact/custom 文案；guide 明示完整上游指南仅是 legacy 参考；children.list 不再将 scoped workflow child 宣称为 resumable，也不建议 fallback replay。
- 候选包含公开 `owned-store.mjs init|inspect` 和 `docs/owned-execution.md`。初始化须显式确认组外风险，只创建/核验 metadata；inspect 只读。新会话使用输出的两个环境变量，运行时缺失/漂移不自动修复。
- Markdown agent 用逗号/块列表，空 extensions 必须写空值 `extensions:`，不能写 YAML flow list `extensions: []`。JSON/SDK 的空数组仍正常使用。真实 Markdown discovery 后的 agent 已用于整组公开 SDK 正例。

## 实际证据（macOS / Node 24.18.0 / 公开 Pi 0.85.1）

| 验证 | 结果 / 范围 |
|---|---|
| 同一 flat 候选回归 | **228/228，零 skip**：前序 lifecycle/owned/workflow/foreground/store/session + CLI 12 项 + flat SDK 3 项 |
| 首版拒绝 | **30 个 direct、24 个 workflow**；真实 writer/faux 调用均为 0；拒绝后容量为 0；随后 external 正控制和公开 single 正控制各只启动一次 |
| 公开 SDK 支持路径 | 15 类证据：超容量数量的顺序正常 external、stop/timeout、同组/escape、Pi native resume、mixed/foreground workflow、三种强关管道负例、owner loss；全部通过实际 executePublic 路径，零远端模型调用 |
| 显式配置 / 初始化 | 真正发现 Markdown agent；ambient extension 正控制确实加载，scoped 子进程不加载；真实 controller SIGKILL 后重开 reader，重复 init 的风险确认不改 terminal bytes、不释放容量 |
| 历史独立 SDK | 第五至九层分别重建，**10/10**，未用 flat 冒充历史源码 |
| pinned upstream unit | **189 pass / 0 fail / 1 Windows-only skip**；原 11 组加 retained-children、tool-description、public-execution |
| adapted upstream integration | **219/219**；保留原断言，明确使用下述两项 readiness 适配 |
| 静态 / 包 | 原类型 include 误指第八层，证据归属已撤回；第十一批按实际 213 TS 补跑 strict/noEmit/noUncheckedIndexedAccess。语法、diff、引用及 installed TS integrity；离线 ignore-scripts 私有 pack 与实际 tgz 审计、解包后 node_modules 布局的公开 CLI init/inspect |

受控关闭与容量释放仍不等于任意 descendants/effects 已验证。SDK 保留 `graph:unknown`、逃逸后续写入、held opaque lease、无 close 时不释放等负例；新初始化确认也不是恢复授权。

## 失败、适配与归因限度

1. 扩大到 executePublic 后，single external 正例暴露默认 foreground 转换问题；已修复并核验实际 single 身份，未使用提前完成的 workflow receipt 绕过。
2. 新增 malformed async 负例曾实际启动 foreground Pi：workflow engine 已把 null 归一为 false，后置检查来不及。已在原始 admission 回调拒绝；最终 54 个拒绝用例均无 writer。两个测试期望还需区分既有 `Scoped workflow child requires an in-process admission owner` 错误，不是放松运行时 guard。
3. 本批未适配 external readiness 的 upstream 首跑 **218/219**。保留的 runner stderr 证明：workflow receipt 完成后，约两秒的测试等待先到期并删除 fixture cwd；随后 external 子进程写 `external-started` 得到 ENOENT。该次有直接证据，不外推解释此前所有波动。
4. [subagent-external-readiness-test.patch](subagent-external-readiness-test.patch)等待真实 marker 和 runner terminal sidecar，再清理，使用有界事件观察。第九层基线与 flat 候选各 **3/3** focused 通过。与既有 [foreground readiness 适配](subagent-foreground-readiness-test.patch)一起由 [prepare-flat-upstream.mjs](fixtures/prepare-flat-upstream.mjs)应用；最终完整 219/219 不冒充原始上游未改测试。历史 7/12 vs 2/12 等其他原因仍未归因。
5. 打包准备曾因传错 preparer 目录层级及 npm 将同一 `/dev/null` 同时当 user/global config 拒绝而退出；修正为既有私有 root 和两个独立空配置后才生成包，未发生 install/publish。

## 复验与采用剩余门

主要测试入口：[flat unit](subagent-owned-flat.test.mjs)、[flat SDK](subagent-owned-flat-sdk.test.mjs)、[共享 SDK harness](fixtures/run-owned-execution-sdk.mjs)。同候选运行时，将各 `SUBAGENT_*_SOURCE` 指向 flat 私有 candidate；历史 SDK 去掉覆盖并使用各自 preparer。SDK 需预先验证的绝对 `ROTOM_PI`，不得回退 PATH/global Pi。

证据日志保存在本机 `/tmp/rotom-flat-*`：combined、historical-sdk、upstream-unit、upstream-integration、sdk-declared-agent；临时包指针为 `/tmp/rotom-flat-pack-artifact`。包仅用于 inventory/加载审计：当前仍沿用 seed `.2` identity，**不是可安装发行版本，不能复制进 vendor 或替换运行时**；实际 tgz 包含 CLI/docs、213 TS，不含测试、public loader、node_modules 或会话。审计不是任意秘密或所有权保证。

本批结束时 Linux 环境不可用；随后用户授权独立 VM，第十一批已完成真实进程矩阵，没有修复旧 VM 磁盘。仍须完成唯一包身份、archive/lock/integrity 与独立新产品会话的接入验收。用户当前的范围收窄不豁免这些门禁。
