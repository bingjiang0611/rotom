# rotom · change-checklists

按任务读取相关小节，不要求每次全文读取。代码块与行内路径均相对仓库根；命令执行前核对实际文件和 package scripts。当前根指南见 [CLAUDE.md](../../CLAUDE.md)。

## 最容易伤到自己的做法

1. **从维护仓根启动后忘记业务 cwd。** launcher 必须保留调用者目录，不能让维护仓的上下文污染业务项目。
2. **接受命令字符串 override。** `ROTOM_NODE`/`ROTOM_PI` 只能是 canonical executable 文件，不能 `eval` 或经 shell 重新解析。
3. **只在 node_modules 留下修改。** 允许本地修改，但下一次 `npm ci` 会丢失，且可能造成 package identity 漂移；交付前固化源码或可复现 patch，同步依赖合同并验证，不覆盖活跃安装。
4. **只改 package.json 不改 lock/identity。** verifier 会 fail closed；版本、integrity、installed identity 要一起验证。
5. **把 package 能力等同于产品能力。** package 内存在 mission/refine/schedule 不代表 rotom 暴露它们。
6. **恢复已退役资源。** 旧会话只能丢弃已退役的 capability ID，不能重新注册其工具或技能。
7. **把 unknown 当失败重试。** 外部写可能已经成功；先 readback，不能自动重放。
8. **泄露正文。** trace、audit、error、test snapshot 和 eval artifact 都不能带 token、cookie、prompt 或工具结果正文。
9. **删 Pi runtime 目录清理 status。** `.pi/tasks/`、`.pi/delegate/`、`.pi/fusion/` 可能被当前或其他存活会话使用。
10. **把 mocked L1 写成真实 L3。** fault injection、loopback fixture、extension reload、fake CLI 和 static footprint 都有明确边界。
11. **把浏览器全文与可见快照混用。** `snapshot_visible` 不代表全文；只有完整 scroll-end 且分页读完才是全文证据。
12. **改动 Pi 生命周期却不验证兼容性。** Context compaction、session 与 Skill reload 等优先复用原生能力；允许修改 Pi、使用私有 API 或自行实现，但需说明必要性并覆盖相关回归。
13. **在根目录增加运行时配置。** 不新增 `.pi/`、`.claude/`、`.agents/` 资源，也不发布 `AGENTS.md`；本文件是仓库维护指南。
14. **恢复历史死入口。** 删除的 capability 只从 Git history 查，不保留空目录、兼容壳或误导文档。

## 跨边界检查清单

### Launcher / runtime contract

- cwd、argv、`--approve/--no-approve` 和所有普通 Pi 参数是否原样保持？
- Node/Pi override 是否只接受绝对 executable 并锁定 realpath？
- `--version` 是否只做 identity probe，不启动完整 runtime？
- resource descriptor、launcher 声明、required file 与 verifier 顺序是否一致？
- 是否拒绝未声明的私人 recorder，避免按维护者 HOME 路径自动接入日志采集？合法可选集成仍须通过 identity 与 canonical path 验证。

### Extension / Skill / prompt

- 能力应放 extension、skill、脚本还是用户项目规则？是否出现第二个 registry？
- 五个 extension 的加载顺序是否有意变化，并同步 launcher、`product-config.mjs`、本文件和测试？
- Claude user/project Skill discovery 是否覆盖 HOME、Git root、nested cwd 与 `--no-approve`？
- 新增资源是否真的要进入 launcher，还是仅维护工具？

### Qoder provider

- Qoder provider 是否默认注册、`ROTOM_QODER=0` 是否能完整关闭，且默认启用仍不改变默认模型？
- `qoder-experimental` 和账号绑定 ID 是否保持稳定，resource/package 是否与 `product-config.mjs` 的 Qoder `requiredFiles` 完整同步（当前 13 个文件，含 `credits.mjs`、`messages.mjs`、`session-policy.mjs`）？
- 目录是否只从固定 COSY endpoint 读取 `assistant` 的 system 条目，按原始 key 映射而非显示名造 ID？只将实测白名单与当前账号 enabled 目录的交集注册；目录仅内存、账号隔离、过期/代际检查、取消和失败不重试是否覆盖？过期前置刷新是否走同会话原生 registry、有界且同作用域合并，工具续轮/压缩均覆盖；是否按刷新后的目录重新验证模型/上下文/effort，失效作用域与迟到结果不能继续推理，且不以路由 sessionId 冒充 SessionManager 身份？
- 模型声明与 onPayload 后检查是否同时拒绝未验证图片、effort、opaque 形状、BYOK/custom 路由与 endpoint 漂移？图片/272K 管理窗口是否仅限 Ultimate/Kimi-K3/DeepSeek-V4-Flash 与当前目录交集，固定400K selector、输出≤4096，覆盖原生≥272K历史后的回答预算、用户多图/工具图片/磁盘恢复及 base64/格式/数量/大小/角色/别名拒绝？13 条 reasoning 路由中的可调档位是否严格取实测白名单与当前目录交集，并核对 simple/raw API、post-hook 与 COSY 的同一选中 effort/enable_thinking？其余仍固定 enabled，能力标记不替代选中模式；Ultimate/Sonus 的不同加密 item 经原生 signature 完整保存/回传并检查模型 provenance；十条 legacy key（含 Ultimate）固定 endpoint，认证元数据来自同一次账号绑定凭据读取，不作回退重试。不把目录的容量/模态声明直接启用。Sonus 与 Ultimate COSY 的 `target_hash` 是否按独立格式完整保留，并验证旧 Ultimate 双字段会话兼容？MiniMax/Sonus/Ultimate 的 metrics 终止桥接是否同时要求 finish、usage、合法工具和精确尾帧，且不按 EOF 补成功？Ultimate 旧 direct 串行工具 index 重用是否只在完整参数/新且非碎片 ID/已声明函数边界规范化，不改变工具 ID 或放过冲突？SSE 前缀续行是否只恢复同 frame 内已有字节，不跨空行或吞迟到错误？
- 默认 browser 与显式 `ROTOM_QODER_AUTH=qodercli` 只读兼容模式是否隔离？浏览器令牌是否由 Pi 原生存储/串行刷新，刷新一次性记录是否跨重启阻止 unknown 重放？新登录/换来源须新会话，续期保留绑定。跨账号阻断、取消、不泄露令牌、费用未知是否保留？分发含 provider 不代表上游授权或新模型已验证。
- Credit 是否仅接收完整流的有限非负数与显式 billable；累积帧不重复相加，取消/尾帧错误/缺失保持 unknown，observer 不影响推理？是否在源 EOF 验证结束前扣留 DONE？同请求去重/冲突、分支树与继承 session、原地换 session/复用 ctx、过期作用域和不可表示的总额是否覆盖？
- `/qoder-credits` 是否在无 UI/作用域、错账号或坏绑定时先拒绝，固定只读 endpoint、不重试、不换模型；余额只 UI 通知，不进 session message、压缩或分支摘要？Credit 小计是否标 partial/billable-reported，并在窄终端仍保留 USD unknown 提示？
- 验证脚本在 `experiments/qoder-provider/`，单测在 `rotom/extensions/qoder/`；迁移后不得调用旧单测路径。

### Third-party / deferred tools

- package、lock、integrity、installed identity 和 `product-config.mjs` 是否同步？Subagent 当前默认为内化组件 `0.52.1-rotom.1`；源码在 `packages/rotom-subagents`，旧归档仅用于历史比较。不要原地覆盖存活会话的安装目录；默认命令切换仅影响新启动。**scoped 执行现为发行包默认**（launcher 选定 scope 并锚定 `~/.local/state/rotom/subagent-store`）；改 launcher 这段默认时必须同步 `verify-pi-runtime.test.mjs` 的 scope/store/opt-out/漂移断言与实际 CLI fixture，且不得在运行时重建或回退。worker/scout/reviewer 的 fresh/空 extensions 声明不覆盖用户或项目显式配置。
- full-tool opt-out 与用户 tools policy 是否保持优先？
- 中英文 capability map、group allowlist、canonical active/state order、additive/resume/fork 是否有测试？live tree 不卸载工具；replacement/reload 只从选中分支恢复，不将 abandoned discovery 静默写回新分支，见 [状态合同](harness-hardening.md)。
- Subagent action/command schema 是否仍收窄，普通执行是否固定 `mission:false`？
- 自有 Subagent skill 是否与当前工具面一致、示例仍可执行，且 launcher/resource contract 未回退到上游完整指南？
- 以下 wait/owner-loss/lifeline/workflow 记录描述旧版本及采用过程，不是当前默认仍停留在 `.2` 的声明；当前 scope 与边界见 [默认执行合同](subagent-owned-default.md)。Subagent wait 的历史缺口与维护面候选见 `rotom/extensions/third-party/history/subagent-regression.md`；这些历史候选当时仅用于隔离维护评测、未应用到 installed source，不构成当前禁止修改安装源码的规则。有界真实模型/L2 结果见 `rotom/extensions/third-party/history/subagent-live-eval.md`：局部 wait 改善不代表完整门禁通过，父进程死亡后的继续写入风险仍未修复。不得外推通知、取消或恢复已整体修复，也不能在 wrapper 中吞掉已消费订阅的通知。
- Workflow owner 丢失的止损见 `rotom/extensions/third-party/history/subagent-owner-loss.md`；pipe/公开 abort 候选见 `rotom/extensions/third-party/history/subagent-lifeline.md`；完整包固定路径与缺配置修复见 `rotom/extensions/third-party/history/subagent-workflow.md`。仅隔离验证；不响应取消的工具、漏加载 runtime 的 child 仍可能写入，启动确认未完成，不能据此解除 unknown、自动重试或部署。
- Subagent 启动回执、workflow/wait 结果与 process-terminal 是否保持分层？不得把父 workflow complete 或直接 runner close 当成所有 child 完成，也不得以短窗口测试 teardown 删除仍在写的夹具；external-CLI 与当前 product-config 固定版本的 lifeline/SDK 回归纳入 check-personal，不替换历史失败 gate；保留 noncooperative 与 stop-residual 的负对照，PASS 不代表残留写入已被消除。普通 stop management 回执也不得被误解为 writer 终止。
- Ask `continueExecution` metadata 是否在进入锁定 package 前剥离，并仅在正常 `stop`、未取消且尚未调用下一工具时补一次 follow-up？模型可见的继续指令也只能附加到明确选中的 continuation option，停止/偏好不附加。Goal 上限中止、错误、取消或未知结束不得触发补跑；session 切换/重载/树导航及迟到答案不得复活旧意图。Goal 安全暂停仍需用户显式 `/goal resume`，不通过 Ask 自动恢复或重置上限。

### Browser / Computer Use

- 是否优先 Relay，并只用 socket 缺失/拒绝连接的类型化 pre-dispatch 证据允许一次 `launch_browser`？许可是否在 preflight 消费、不跨运行/会话继承、不因已派发请求后的重连失败重新授权？登录页/空结果/stale/timeout/unknown/取消/权限/协议错误不能授权回退；显式排除 Relay 的工具选择保留，回退说明独立登录态并使用新 CDP stateId。
- Browser 返回文本不扫描或替换凭据形状，可能将密码/Token 原文返回模型；长度、控制字符、URL query/hash 隐藏及 metadata-only audit 边界仍保留。不要将其描述成自动脱敏能力。
- state/ref/document generation/viewport/observationEpoch 是否在动作前重验？
- recover 是否只针对原标签一次，且不影响同 session 其他标签？
- agent-created、claimed、pinned、其他窗口标签 ownership 是否保持？
- full snapshot、visible snapshot、screenshot 与 action readback 的证据等级是否清楚？
- 目标状态、`expect` 结果与 page-alert 是否保留 met/unmet/unknown 三态，且 changed=null 不被当成未变？
- click/type/select/keypress 的 unknown 是否只允许只读核对，不重发写动作（仅幂等 scroll 可重试一次）？
- keypress 是否仅允许 ref-bound Enter/Tab/Escape，派发前核验原对象焦点、document/frame generation，且复用后台保护与目标状态回读？不自动把 type 转成 Enter，不通过 insertText 换行或系统键盘冒充按键。
- desktop 写操作是否保持后台投递：失败时返回 unknown，而不是 activate 目标 app 抢走用户与其他 agent 共用的全机前台？
- protocol/extension 变更是否要求用户重载，并明确 L1 与真实 Chrome L2/L3？

### Observability

- 新字段是否真有诊断价值且不含敏感正文？工具面只记有界 public-metadata digest/bytes，不记录 schema 正文、不把它称作 wire/token/cache 证据；unavailable 样本打断相邻比较。
- dispatch、execution/verification、business、process-terminal 与 contentComplete/truncated 是否独立保留？字段缺失不写 false；未知/未验证业务结果不能被正常返回或 failed 后置条件伪装成成功。
- span start/end、parent/child、compaction sequence、shutdown flush 是否仍配对？
- partial page 是否避免跨页生命周期推断？
- parser、文件大小、flush deadline、权限、symlink、loopback/auth/CSP 是否有界？
- 无 trace、disabled、temporary session、orphan empty launch 是否诚实表示？

### Eval / capability evidence

- eval 是否有固定 task、baseline、judge、重复次数、环境和外部 verifier？
- teardown 是否先 await shutdown/trace flush，再快照 artifact，最后清理？
- artifact 是否 metadata-only、有界并记录 truncation？
- 结论是否只覆盖实际样本，不把 L1/L2 或单 pair 外推？
- 能力、禁区或验证等级变化是否同次更新本文件中的对应边界，并由可执行合同/测试证明？
