# 运行时资源合同

> 本文原样搬自根 `CLAUDE.md` 第 2 节（2026-11-12 拆分，未改写语义），与 CLAUDE.md 具有同等约束力；改动本领域之前必须读完本文。文中出现的“本文件”指根 CLAUDE.md 连同本文。文中的具体版本号可能落后，以 `rotom/runtime/product-config.mjs` 与 `rotom/runtime/pi/fork-build.json` 为准。

extension、bundled skill 与第三方 package 是产品合同，不是“目录里碰巧存在的文件”。产品不再加载 bundled prompt template；用户自己的模板仍走 Pi 原生发现。

- 产品内置资源列表以 `rotom/runtime/product-config.mjs` 和 launcher 的显式声明为准；用户通过 Pi 原生 package、用户目录、受信项目目录或 `-e` 加载的资源不冒充产品资源，也不经过产品 identity gate。
- Qoder 为 bundled、默认启用的 `qoder` provider（`ROTOM_QODER=0` 可关闭），保留旧会话的 `qoder-experimental-account-v1` 绑定兼容读取与 `lite`/`performance` 离线基线；升级前的浏览器登录凭据不自动迁移。账号目录按原始 key 发现，只注册实测白名单 ∩ 当前账号 enabled 的交集，不改默认模型；未验证的 opaque 形状、档位与路由不启用。目录通过 Pi 原生 `models-store.json` 按非敏感账号摘要隔离持久化，过期后台刷新；缓存不含凭据，账号不匹配时不得恢复，可见不等于 direct endpoint 可调用。具体目录项、路由数、版本头与窗口大小随上游变动，不写进本文件。
- 凭据默认走 `browser`（Pi 原生登录/存储/串行刷新、复用公开客户端 ID，非官方支持），不读写 CLI 凭据；显式 `ROTOM_QODER_AUTH=qodercli` 回到只读 CLI 兼容模式。刷新前持久记录一次性尝试、unknown 不重放、只强制隔离凭据的本地到期（不冒充自然到期）。设备 ID 持久化在用户 Pi 目录的 `qoder-device-id`（`0600`，首次从在用凭据沿用机器标识，之后不随登录轮换），所以同一账号重新登录保持绑定；切换账号/组织、删除该文件或换安装仍须新会话。opaque signature 字段按各自 Pi signature 原样存回，不解密、不跨模型丢弃。
- 每条路由固定走 COSY 单次推理或 direct，不失败回退、不嵌套 agent；provider 自身不重试推理。推理前的目录刷新失败（`catalog_refresh_failed`）与传输失败（`request_failed` / `stream_failed` / `truncated_tool_call`）交给 Pi 有界重试预算——消息以 error 结束，其工具调用从不执行（`agent-loop.ts` 在 error/aborted 处结束整轮），所以整次重试不会重放工具副作用；维护者已接受重发可能重复计费，代替手动“继续”。协议缺陷（`invalid_tool_arguments` / `invalid_tool_choice` / `invalid_tool_id`）仍不可重试。只按实测交集开放 effort，其余固定 enabled，不伪造关闭/强度支持。服务尾帧仅在 finish、usage 与精确 metrics 同时成立时映射终止，不以 EOF 补成功。
- 仅图片档模型开放 PNG/JPEG/WebP 与受管上下文窗口，其余仅文本、上下文保持有界；默认不发送单次输出 token 上限（由服务端决定），调用方显式预算仍经 Pi 原生上下文预算裁剪；不设置独立的单图、历史图片总量或张数上限，最终请求体保持有界，拒绝远程 URL，不宣称完整 400K/1M。
- Credit 只记录完整流中有效的服务端 credits/billable，缺失/错误/取消/冲突保持 unknown；会话 subtotal 为 partial、billable-reported，不是完整账本或 USD。选中 Qoder 时，内置 Pi footer 的普通 usage 行用三位小数 `Cr` 只显示已记录小计；仅在没有任何已知小计但存在 unknown 时显示 `Cr?`，已知与 unknown 并存时不追加 partial 后缀；不显示 Pi 的 $0 占位。`/qoder-credits` 只读账号快照，不进对话/压缩/摘要，不由余额差值推断单次费用。美元费用未知与上游支持/许可未确认必须显式披露。
- 第三方 package 使用精确版本、lockfile integrity 和 installed package identity；`package.json`、`package-lock.json`、`product-config.mjs` 必须同步。发行包的 Pi fork 另由 `rotom/runtime/pi/package.json`、`package-lock.json`、`fork-build.json` 和 product config 固定版本/integrity；产品 `package.json` 不声明任何 npm dependency，也没有产品级 lockfile。
- 运行时资源拒绝 symlink、越界路径和 canonical 漂移。
- `node_modules/` 可用于本地调试和验证修改，但重装会覆盖；交付时将改动固化到受版本管理的源码或可复现 patch，并同步依赖与 identity 合同。不要原地覆盖存活会话使用的安装。
- 已退出产品面的 Verification、Experience、Safety、Containment、Background/Fusion、LSP、旧第三方 MCP adapter、旧自有 Execution/Subagent/Goal、compact-policy、task-state、baseline、`refine`、`simplify` 和独立 community 不因第三方包仍有同名实现而恢复。当前 Subagent 与 `/goal` 由显式声明的内化组件经自有 wrapper 接入，不是恢复旧框架。
- 模型驱动的 context fold（`ROTOM_CONTEXT_FOLD`）已在 L3 实测后删除：Qoder DeepSeek-Flash 上短/长会话计费 credits 均约中性（0.97× / 0.975×），开启侧方差远大于差距，请求数最多翻倍，并出现过折叠后中途弃任务。实现与实测记录只查 Git history（`25b5230`–`f2f0d86`）；没有新的收益证据时不重建。
