# Qoder 能力、独立认证与 Credit：阶段验收

> 后续 `invalid_tool_id`、SSE 前缀续行、真实 thinking 档位和多组长会话/安装交付，见 [长会话与档位验收](LONG-SESSIONS-VERIFICATION.md)。三模型图片/大上下文与 Ultimate 固定 COSY 的最新候选验收见 [图片与大上下文](IMAGE-CONTEXT-VERIFICATION.md)。本页保留各历史阶段的原始结论与计数，不把当时的 text-only/32K 描述当成后续合同。

## 范围与当前结论

本轮基于 `55db1f9` 的 17 项 Default 目录适配，继续覆盖认证、费用与更完整的原生工作流。Enterprise/BYOK 排除。用户另行授权不限调用/Credit，并在看到共享池后明确授权共享池消费；1000 次仅为维护自限。该 Credit 阶段没有购买、充值、全局更新、推送或公开发布；后续全局修复交付见文末。

- **PASS：独立认证**。从空隔离原生凭据存储完成浏览器登录、持久化、并发请求下恰好一次真实刷新及 runtime 重建。仅修改新隔离凭据的本地 expiry 来触发刷新；**未等待自然到期**。不是复制 CLI 凭据做登录，也不证明官方支持。
- **PASS：全部 17 项在实际 tgz 安装中重新完成原生往返**。九条 legacy 路线均得到两份 reported Credit；八条 direct 路线均为两份 unknown，不能写成免费。Credit、账号余额、模型倍率和 USD 不混算。
- **PASS：合成 AgentSession 工作流**。Lite/Sonus 完成真实私有文件修复、固定测试由失败到成功、唯一补丁、分支隔离、整树计量、磁盘恢复、手动压缩及精确 marker 召回。不是任意 shell/文件系统沙箱或任意业务验收。
- **PASS：最终实际安装的真实 CLI/PTY 内容检查**。真实 launcher 中输入一次 `/qoder-credits`，确认额度通知；用合成历史副本恢复 Credit footer，80 列同时显示 USD unknown 与 Credit。模型 dispatch 明确被禁止，原历史/全局凭据未改。不是桌面截图、字体/完整布局或跨平台验收。
- **研究证据，不启用产品能力**：目录标为图片可用的 16 项，各至少有一次 raw 随机网格定位成功；尚非全模型原生图片/工具图片/磁盘重放验收。实际大上下文、可调 effort、其他模态仍待继续验证。
- 当前产品仍为 **text-only、≤32K / 4096、13 条 fixed-enabled reasoning**。不以目录的 1M、图像标记或 context selector 声明已支持。

## 计量与隐私合同

1. 仅 allowlist `credits` / `original_credits` / `billable`，有限非负数与显式布尔值；累积帧取最新，不逐帧相加。畸形、缺失、错误、取消均 unknown，不是零。
2. 每次实际 dispatch 最多一个观察，dispatch 前失败不制造请求记录。必须验证源流 EOF 后才释放 DONE，迟到非法尾帧不能让 SDK 先认定完成/已知费用。observer 失败不影响推理。
3. `qoder-credit-observation-v1` 是非模型上下文 custom entry；按原 session ID 聚合整个树，排除继承会话费用。重复去重、冲突 unknown、溢出总额为不可表示。当前账号/epoch/session ID 失配的迟到回调不写到新会话；subtotal 因而明确为 **partial、billable-reported**，不是完整审计账本或预算熔断。
4. `/qoder-credits` 需 UI 与有效作用域；坏绑定/错账号先拒绝，固定只读 `GET https://openapi.qoder.sh/api/v2/quota/usage`，有界、不重试、不换模型。plan/addon/shared 仅作 UI 通知，不写对话、压缩、分支摘要或恢复历史；不从余额差值推断某次扣费。原始账户余额与终端 bytes 只留私有证据。
5. Pi `usage.cost` 仍为 USD 零占位，不代表免费。原生 UI 的单行截断会隐藏后置提示，因此 Credit 状态本身以 `USD cost unknown` 开头。SDK/headless 也不能把零占位当账单。

## 实测与保留失败

### 认证

- 第一轮登录超时：76 polls；无 profile/refresh，失败保留，没有自动重开。
- 人工协调后新的独立尝试：12 polls + 2 profiles + 1 refresh = 15；PASS。
- 新机器标识、相同账号/组织、持久化、并发下恰好一次刷新、runtime 重建与参考凭据 hash 不变均已验证。刷新 tombstone 不删除、不重放。

### Credit 与原生会话

- Sonus 两轮原生 SDK Credit 示例：`0.34175042000000005`、`0.28308082000000007`，均服务端 reported/billable；不是 USD 或最终结算凭证。
- 首个 Sonus 文件修复/恢复用例：6 个模型请求，6 reported / 0 unknown，合计 `1.9052952600000004` Credit；另 2 catalog + 1 quota。
- 扩展 Sonus/Lite 初次在压缩断言失败，但文件修复、分支和计量恢复已过。探针错误要求摘要包含仅位于 retained recent messages 的 RESUMED marker；两份失败保留，不能改判为 PASS。
- 修正后先证明 FIXED marker 确实存在于发送给压缩模型的 source，再要求摘要保留并在后续不提供值的请求中精确召回。两个新 nonce/session 用例均 PASS：各 9 个模型请求、2 catalog、1 quota；Sonus 9 reported / 0 unknown，`4.478690590000001` Credit；Lite 0 reported / 9 unknown。
- 离线工作流调用原生 `ModelRuntime` / `DefaultResourceLoader` / `AgentSession` / `SessionManager`，真实执行固定 Node 测试和单个获准补丁。UI callback 测试与后续真实 CLI/PTY 单独记录，不混用证据级别。

### 图片调研

- 16 项初轮：11 个严格坐标成功、5 个失败。Qwen3.7-Plus/GLM 的独立新例证明 JSON fence 格式问题；MiniMax 独立新例通过，旧不匹配仍保留。
- Auto/Performance 的原 direct 或 32K legacy 设置没有通过坐标断言。显式 legacy + 目录默认 context selector 后坐标正确；首次检查器又错误排除了精确 metrics trailer，失败结果保留。研究 normalizer 显式允许该尾帧后，Auto default/none、Performance high/none 的新例通过。
- 这些只是小型图片请求上的 selector/route 组合证据，**不是实际 272K/1M 输入容量测试，也不触发产品自动路由回退**。

## 本轮 ledger（Credit 阶段 checkpoint：274）

与此前目录 30、reasoning 21、全模型 87 三份账本分离；旧失败/UNKNOWN 不清零。

| 累计区间 | 实际范围 |
|---|---|
| 1–76 | 首次登录超时 |
| 77–91 | 新登录与一次真实刷新 |
| 92 | 初次只读额度快照，之后取得共享池消费授权 |
| 93–98 | Lite/Sonus 原生工具往返及 raw usage 计量 |
| 99 | 扩展目录 metadata |
| 100–127 | 16 项初轮图片与独立新配置/格式案例 |
| 128–133 | 新原生 Credit callbacks：Sonus reported、Lite unknown |
| 134–142 | Sonus 文件修复、额度与恢复 |
| 143–154 / 155–165 | Sonus/Lite 扩展用例；压缩目标放置错误，保留失败 |
| 166–177 / 178–189 | 修正目标后的新 Sonus/Lite 扩展用例，PASS |
| 190–191 | 新会话真实 CLI/PTY 额度命令 |
| 192–193 | 合成计量历史副本的真实 CLI/PTY |
| 194–195 | 80 列修正状态行后的 source CLI/PTY |
| 196–246 | 实际 tgz 安装中全部 17 项，每项 1 catalog + 2 model，全部 PASS |
| 247–258 / 259–270 | 最终实际安装 Sonus/Lite AgentSession，各 9 model + 2 catalog + 1 quota，PASS |
| 271–272 / 273–274 | 最终实际安装的新会话 / 80 列历史副本 CLI/PTY，各 1 catalog + 1 quota，模型禁止 |

274 = **91 auth + 41 catalog + 13 quota + 129 model**。上述完整案例的全局/隔离凭据 hash 不变；真实 TUI 案例原会话文件也不变。实际数字余额不提交。

## 验证与发行状态

- 当前 focused：`node --test rotom/extensions/qoder/*.test.mjs experiments/qoder-provider/{live-budget,probe-wire,tui-net-observer}.test.mjs`：**169 PASS**。
- 当前 `credits-session-smoke.mjs --offline`：PASS，网络 blocker 下完整修复/分支/恢复/压缩路径。
- 最终 `check-personal`：**304 PASS**；runtime/resource-distribution：**48 PASS**；TypeScript、syntax、tree/artifact privacy audit、diff check PASS。
- source 与实际安装均通过 default / opt-in CLI / browser / full public-runtime smoke。新增所需文件 `credits.mjs`，Qoder resource 必需文件从十个变为十一个。
- 实际安装：17 项离线 SDK/磁盘往返、Lite/Ultimate/Sonus/MiniMax delayed-trailer 拒绝、完整离线 AgentSession，以及 17 项新 live SDK 用例全部 PASS。九条 legacy 共 18 reported；八条 direct 共 16 unknown。
- 最终实际安装 Sonus/Lite 的文件修复、固定测试、分支、恢复、压缩 source marker 与精确召回均 PASS；Sonus 9 reported、`4.39948663` Credit，Lite 9 unknown。原会话归属/无 UI guard 已包含在该产物和真实 CLI/PTY 验证中。
- 第一轮 pack 因 npm 读取 ETIMEDOUT 失败，未生成产物；保留日志、检查进程已结束和 registry direct 可达后，新的隔离构建 PASS，不复制维护者 node_modules。最终 tgz：**9,295,951 bytes / 3797 files / Pi 0.85.1**；integrity `sha512-3ujGpz5LsCbxzdswqbRwHWzqYwNUSrT46p6pE/wp9KL4MLtqfcmI1M9mxvm/cFIF/1UX4km57L+QnDgkDEg19g==`。
- 隔离 HOME/prefix 从旧全模型 tgz 升级到新包，十一文件合同与源码 digest 相符；PATH 无全局 Pi，默认依赖解析/version 检查、升级和卸载均过。测试安装已卸载，认证与证据仍在独立私有目录。
- 未做本轮全局安装、发布或 push。后续图片、effort、长上下文不能凭本报告的 raw/目录证据启用。

私有证据包括每次结果、源模块 digest、累计 ledger、认证一次性记录、合成会话与仅本地终端原始输出；仓库仅记录必要聚合与边界，不包含凭据、账号标识、原始 reasoning ciphertext 或账户余额。

## 后续图片研究 checkpoint（306；不改变已验收产品）

`vision-sdk-probe.mjs` 是独立维护 wire + Pi 原生 OpenAI serializer/SessionManager，不是产品 provider，也不能替代最终产品门禁。第一张 PNG 的坐标须进入严格工具参数；工具返回新的 JPEG 和 marker，磁盘恢复后须用第二张图精确回答。两图的红/蓝位置分别不同，不把重用首图算通过；返回 opaque 时要求原样 replay，未返回时标记 not observed，不伪造推理证明。

- 275 为新目录；276–306 共 31 个模型请求。累计 **91 auth + 42 catalog + 13 quota + 160 model = 306**。
- 12/16 项在该研究配置下完成用户 PNG → 工具 JPEG → 原生磁盘恢复与精确回答：Sonus、Ultimate、Efficient、Qwen3.8-Max/Flash、Qwen3.7-Plus、Kimi 两项、GLM-5.3-Flash、DeepSeek 两项、MiniMax。
- Auto/Performance 的显式 legacy 路线在现代 tool_calls 下返回 `finish_reason:function_call`，当前 normalizer 保守拒绝；不靠设置 Sonus 身份来绕过检查。Qwen3.7-Max/GLM-5.3 首轮工具参数严格校验失败，未发送第二轮；细分参数诊断尚待新案例，不能把它们写成图片已支持。
- Ultimate 观察到 opaque 并完成 replay；Sonus 的该图像配置没有观察到 opaque。Sonus 最初用例在包含额外 opaque 要求的末尾断言失败，结果保留；后续独立用例仅证明图像/工具图像，不能追认旧失败或据此声称完整推理兼容。
- 初版离线探针误用 SDK 导出名、随后 legacy fixture 缺少 envelope，均在无网络时发现并修正。一次 Pillow 合成图转换在 5 秒上限超时，进程被终止且未增加 ledger；保留空结果/stderr，确认属于本地预处理后将转换上限改为 30 秒，新案例单独记录。
- 当前产品仍 text-only/32K/fixed reasoning。**产品图片接入、WebP 等格式真实调用、可调 effort、实际长上下文和其他模态尚未完成**；不使用 raw 或这个研究 adapter 的 PASS 冒充启用。

## Ultimate 连续工具调用修复 checkpoint（315）

用户实际会话两次出现 `invalid_delta`，均在 Ultimate 工具调用生成阶段。只读会话 metadata 不足以恢复上游响应，未重放业务命令；改用原隔离账号、合成历史与无副作用工具独立定位。

- 307–309：新目录与原生两轮工具/opaque/磁盘往返正常，未复现错误，不能据此否定用户报告。
- 310–311：合成 assistant tool call → tool result → 新 nonce 请求，在原生 SDK 呈现同类错误：工具参数已经完全匹配，随后收到省略 `delta` 的显式 `tool_calls` 结束帧。该轮没有观察到 opaque；结构观察只记录字段类型、固定结束枚举与计数，不保存正文或 ciphertext。失败保留。
- 修复仅把 Ultimate 已支持的无 delta `stop` 扩展到实测的 `tool_calls`；不接受 `null`、带 `message`、未知终止枚举或其他模型，不制造 opaque。完整工具名/参数、usage、DONE、尾部数据校验及错误计费 unknown 保持不变。
- 312–313：源 provider 的独立新 nonce 连续工具调用 PASS；314–315：实际 tgz 安装的 provider 与其依赖 Pi 完成相同原生路径，精确工具参数与正常 `toolUse` 终止 PASS，均没有 opaque。不是用户业务操作重放，也不是本次新增完整 AgentSession/桌面验收。
- 回归先在旧代码得到 `invalid_delta`，修复后 **152 Qoder tests / 305 check-personal / 48 resource-distribution PASS**。四条基础离线 smoke、源与实际安装的全部 17 项 SDK/磁盘用例、Ultimate 迟到尾帧拒绝、实际安装四种 runtime profile 均 PASS。Ultimate 离线 fixture 同时覆盖无 delta 的文本和工具结束帧。
- 发行使用干净 tracked-tree 快照，仅叠加修复后的 transport；新旧 tgz 全文件 bytes 比较确认 **只有 `extensions/qoder/transport.mjs` 改变**，无维护者 node_modules 或并行第三方 WIP。第一轮因快照缺 Git index 被隐私 gate 阻断、未产出；建立仅本地无历史 index 后新构建 PASS。资源测试第一次整体 150 秒上限中断，确认进程结束后独立 400 秒上限执行通过，旧日志保留。
- 新 tgz **9,296,005 bytes / 3797 files / Pi 0.85.1**，integrity `sha512-CG1beIuZVFnqbCiRmtBrqNEEbKAWe+qdKH/QawVjRgD0pvxoQUmGfTsvqf8WOwONLBGCof2j0AD9hRySikt8Lw==`。tree/artifact audit、隔离离线安装与上述验收后，已离线更新用户的普通全局 rotom；3797 个产物文件逐一匹配。安装后立即核验时，受检全局/CLI 认证、zsh 配置、scoped 包 manifest、入口 symlink 与 launcher/config hashes 不变；不是整个 HOME 等价证明。隔离安装随后已卸载，全局安装保留。稍后收尾复核发现 CLI `.qoder/.auth` 目录摘要发生变化，来源未确定，其余受检项仍匹配；未覆盖或回滚该目录，也不把最初的 PASS 冒充全时段凭据不变。未 push/publish，存活会话须退出重启后加载新 adapter。

累计 **91 auth + 46 catalog + 13 quota + 165 model = 315**；本修复新增 4 catalog + 5 model，隔离凭据 hash 不变，费用未知不是免费。此前 306 checkpoint 的能力边界不变，尤其 **本修复不开放 Qoder thinking-level 控制**。私有结果以 `delta-sdk-307`、`delta-continuation-310/312`、`delta-installed-314` 与对应 shape 记录为准；全局安装另有 `global-result.json`。
