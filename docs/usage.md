# 使用指南

[返回首页](../README.md) · [构建与升级](agent/distribution.md)

本文保留安装、模型配置与 Qoder 的详细说明。除明确标为源码的路径外，运行时路径均相对安装后的 rotom 包目录。

## 本地发行包安装

项目源码位于 [bingjiang0611/rotom](https://github.com/bingjiang0611/rotom)。npm 产品仍为 private Alpha，未发布到 npm；不能直接执行 `npm install -g rotom`。

要求 Node.js 24+ 和 POSIX shell。macOS arm64 已有随包 Pi fork 的安装验证；旧版本曾完成隔离 Linux VM smoke，新内置依赖闭包的 Linux／其他 CPU 验证仍未完成。Windows 原生入口不受支持。

```sh
# 将占位路径替换为实际打包产物
npm install -g --ignore-scripts '/absolute/path/to/rotom-<version>.tgz'
cd /path/to/your/project
rotom
```

无需预先安装全局 Pi、编译源码或再次安装扩展。发行包携带锁定安装的 Pi fork 与扩展依赖；Pi 源码由 rotom 仓库的 `packages/rotom-pi/` 维护，默认仅从本包 `runtime/pi/node_modules/` 加载，不使用官方 npm Pi、PATH 或旁边的源码目录。`rotom --version` 显示 fork 版本 `0.85.1-rotom.1`；rotom 自身版本见本包 `package.json`。

`/model` 优先显示模型名称，保留 ID/provider；Shift+Tab 调整当前高亮模型的思考档位草稿，Enter 应用、Esc 丢弃，Ctrl+S 只保存默认模型。只开放 provider 声明支持的档位，不扩展 Qoder 能力边界。

首次使用仍需自行登录模型服务或配置 API key。Chrome relay 安装、Chrome 扩展加载/重载及系统权限需用户明确操作，不由 npm 安装脚本执行。入口为安装目录内 `extensions/browser/install-chrome-relay.mjs`。

`ROTOM_PI=/absolute/path/to/pi` 是维护者显式覆盖入口，仍验证 executable、package identity、公开 exports 与能力；它可以选择不同的兼容 Pi，因而不再代表默认固定版本的发行配置。`ROTOM_NODE` 仍只接受绝对、存在、可执行的普通文件路径。

上述全局安装方式升级前，应先退出使用该安装目录的全部会话，再重新安装本地归档；卸载用 `npm uninstall -g rotom`。有存活会话时，改用全新 prefix 安装、验收后只切换命令链接，保留旧目录，不原地覆盖或迁移会话。旁路 prefix 是独立安装，后续全局 npm 安装可能重新接管命令链接。不会自动删除凭据、会话或 Chrome relay 注册，后者需单独显式卸载。

默认 Subagent 为独立维护的 `pi-subagents@0.52.1-rotom.1`，不再依赖维护 patch 堆栈。worker/scout/reviewer 使用显式工具/扩展声明和 fresh 默认上下文，仍尊重用户/项目 overrides。源码修改须重新打包安装，不热加载。

**新会话默认使用 scoped 执行** `owned-process-groups-v2`：launcher 在启动前选定 scope，并在 `~/.local/state/rotom/subagent-store` 创建一次性 store 锚点（已存在则直接复用，不替换）。详细限制见 `extensions/third-party/node_modules/pi-subagents/docs/owned-execution.md`。

- 临时回到旧行为：`PI_SUBAGENTS_EXECUTION_SCOPE= rotom`（显式空值）。
- 自定 store 位置：`PI_SUBAGENTS_TEMP_ROOT=/absolute/path`。
- 其他值、相对路径、身份漂移或不可读 store 一律在启动 Pi 前失败退出，不回退旧 scope。
- `--version` 探测不创建任何 store。

scoped 执行是执行归属与资源关闭管理，**不是安全沙箱**；首个版本只接受已验证拓扑，nested/worktree/gate/fork/import/external job/独立 foreground 会在 writer 前拒绝。安装、升级或切换入口均不授权旧 unknown 工作的恢复/重放。

## Qoder：原生 provider（显式启用）

**独立浏览器登录（已在隔离原生凭据存储中完成真实登录与串行刷新；刷新测试仅强制隔离凭据的本地到期时间，未等待自然到期）**，无需安装或登录 Qoder CLI。从业务目录启动：

```sh
ROTOM_QODER=1 ROTOM_QODER_AUTH=browser rotom
```

在 rotom 内执行 `/login qoder-experimental`，打开显示的链接并在 Qoder 网页确认账号授权；成功后执行 `/new`，启动时会尝试读取账号模型目录；也可用 `/qoder-models` 手动刷新并查看每项状态，再用 `/model` 选择已通过验证的模型。以后可直接启动：

```sh
ROTOM_QODER=1 ROTOM_QODER_AUTH=browser rotom --provider qoder-experimental --model lite
```

- 浏览器模式由 Pi 原生 `/login`、`/logout` 和凭据存储管理，默认保存到 `~/.pi/agent/auth.json`（可通过 Pi 原生 `PI_CODING_AGENT_DIR` 改变用户目录）；令牌按 Pi 凭据文件方式落盘，不是系统钥匙串。不会读取或写入 `~/.qoder`，也不使用 `ROTOM_QODER_AUTH_DIR`。
- 复用公开 Qoder CLI `client_id`，不是 rotom 独立注册身份，也不代表官方支持。PKCE 链接有效期五分钟，取消/失败不自动重开登录。
- 到期前由 Pi 串行刷新并保存轮换令牌。刷新前在用户 Pi 目录的 `qoder-refresh-attempts/` 持久保存空文件及令牌摘要（不保存令牌正文），禁止同一个刷新令牌再次交换，包括超时、重启或凭据保存失败后。未知结果、非轮换令牌或刷新失败需重新登录；不要删除这些记录来强行重试。目录最多 4096 条，满时停止刷新，需维护者明确核实旧凭据已停用后再处理。
- 自动刷新保持会话绑定；**重新浏览器登录会生成新的机器标识，需要新会话**，即使账号相同。旧 CLI 会话不自动迁移到浏览器模式。

**默认即浏览器模式**：未设置 `ROTOM_QODER_AUTH` 时默认走上面的 `browser`（Pi 原生登录），不再依赖 Qoder CLI。**原只读 CLI 兼容路径改为显式 opt-in**——依赖 `~/.qoder` 登录态的旧用法在升级后默认行为会改变，需显式设置 `ROTOM_QODER_AUTH=qodercli` 才能保持原只读行为。先自行登录 Qoder CLI，再启动：

```sh
ROTOM_QODER=1 ROTOM_QODER_AUTH=qodercli rotom --provider qoder-experimental --model lite
```

`ROTOM_QODER_AUTH` 只接受 `browser` / `qodercli`。

扩展随包加载，但默认不注册 provider、不读取 Qoder 凭据、不外呼；不会更改默认模型或迁移活跃会话。`ROTOM_QODER` 只接受 `0` / `1`，其他值报配置错误。

- 直接调用模型 HTTP 接口，不启动 qodercli，不嵌套 agent 循环；工具、上下文、分支和压缩仍由 Pi 管理。
- `qodercli` 模式只读 `~/.qoder/.auth`，可用绝对 canonical `ROTOM_QODER_AUTH_DIR` 覆盖；拒绝 symlink、非私有/非本人文件。此模式不会刷新或写回 CLI 登录态；到期需用同账号正常登录后自行提交。两种模式都不能保证服务器在本地取消后停止计费。
- 保留 `qoder-experimental` 和原绑定 ID；会话绑定账号/组织/机器摘要，同账号 token 更新可继续，换账号或旧未绑定 Qoder 历史须新会话。摘要不进入模型上下文。
- 使用服务端原始 key，不根据截图猜 ID。当前 Default 目录的 **17 项**已适配：`auto`、`ultimate`、`performance`、`efficient`、`lite`；`smodel`（Sonus）；`qmodel_38max` / `qfmodel`（Qwen3.8-Max / Flash）；`qmodel_latest` / `qmodel`（Qwen3.7-Max / Plus）；`kmodel_latest` / `kmodel`（Kimi-K3 / K2.7-Code）；`gmodel` / `gfmodel`（GLM-5.3 / Flash）；`dmodel` / `dfmodel`（DeepSeek-V4-Pro / Flash）；`mmodel`（MiniMax-M3）。仍需出现在当前账号 enabled 目录；离线仅保留 Lite/Performance 基线。
- 除 Lite/Performance/Auto/Efficient 外，13 条路由支持原生推理与工具往返，其中八条按实测白名单与当前目录交集开放 thinking 档位（见下表）；其余仍固定 enabled，单一 medium 不代表测得的中等强度。Ultimate 旧双字段、新 COSY 三字段 item（含 `target_hash`）与 Sonus item 使用不同 Pi signature 格式完整保存/回传；不解密、不丢字段、不跨模型迁移。仅 Ultimate、Kimi-K3、DeepSeek-V4-Flash 开放图片和 272K 管理窗口（与 Codex 声明一致；已实测上游可吃超过 272K 输入）；其余仍为文本、≤32K。所有输出上限仍为 4096，不将目录的 1M 当成已验证容量。
- Efficient、Qwen3.8 两项、Qwen3.7-Max、Kimi-K3、GLM-5.3-Flash、DeepSeek-V4-Flash、MiniMax-M3、Sonus、Ultimate 明确选择固定 COSY 单次推理协议；其余七项使用原 direct endpoint。推理选中状态不照搬目录能力标记；没有 CLI 子进程、远程 agent 循环或失败后回退重试。
- **覆盖当前目录不等于任意未来模型可用**：未实测的新 key、BYOK/Enterprise、未知 opaque 形状仍不开放。工具往返、原生 signature 和磁盘恢复的证据及未验证项见维护面 `experiments/qoder-provider/ALL-MODELS-VERIFICATION.md`，不冒充真实 TUI 或完整业务验证。
- COSY 目录请求固定到 Qoder 的 `api2.qoder.sh`，无 CLI/WASM 依赖。兼容版本头为已核实的 `1.1.45`（影响 Sonus 目录可见性，不是 rotom 发行版本，也不表示官方支持）。目录仅内存保存、绑定账号、有效一小时；不共享或写入 Pi 的跨账号模型缓存。失败不重试，过期/账号变化需 `/qoder-models`。每次启动的目录读取不等于模型请求；浏览器令牌到期时仍按前述原生刷新规则处理。
- **Credit 不等于 USD 或最终账单**：完整流同时返回有效 `credits` / `billable` 才记为服务端 reported；缺失、畸形、错误或取消保持 unknown。本轮 Sonus 有明确 Credit，Lite 未返回该字段，不能据此说免费。状态栏显示 `USD cost unknown` 与本会话 **partial、billable-reported** 小计及 metered/unknown 数；记录包含整个会话树，但不归入继承自另一会话的费用。丢失作用域的迟到回调不写入新会话，计量不是完整审计账本或预算熔断。
- `/qoder-credits` 需要交互 UI，无 UI 不查询；仅请求当前账号的只读额度快照，分列 plan / addon / shared；不消费模型、不改变选中模型，不把快照差值归因到某次请求。余额只作 UI 通知，不写入对话、压缩或分支摘要。会话 Credit 观察单独落在非模型上下文的 custom entries；原始余额、模型倍率和 USD 不混算。Pi 的数字价格仍是零占位；headless/SDK 的 `usage.cost` 不能当账单。
- 本轮另通过 Lite/Sonus 的原生 AgentSession 合成文件修复、固定测试、分支隔离、磁盘恢复及手动压缩；真实 launcher 的 PTY 验证了额度命令和 80 列下的 Credit/USD 提示，不代表桌面终端视觉或任意业务验收。见维护面 `experiments/qoder-provider/CAPABILITIES-VERIFICATION.md`。
- 仍标记 experimental：未确认独立模型接口的长期支持与第三方使用许可，不适合公开代理、凭据池或宣称官方支持。产品集成不等于上游授权。

### Thinking 档位

在主输入界面用 `Shift+Tab`（或自定义 `app.thinking.cycle`）循环原生档位；不是只解锁 UI：选中值会进入 direct/COSY 请求，hook 不能偷换成另一档。

| 模型 | 已验证的可选档位 |
|---|---|
| Ultimate、Sonus | low / medium / high / xhigh / max |
| Qwen3.8-Max | off / low / medium / xhigh |
| Qwen3.8-Flash | low / medium / xhigh |
| Kimi-K3、DeepSeek-V4-Flash | low / high / max |
| GLM-5.3-Flash、DeepSeek-V4-Pro | high / max |

当前账号目录可能进一步收窄选项。未验证档位不映射成别的档位；尤其目录声明的 off 不一定真的关闭，除表中 Qwen3.8-Max 外不开放 off。缺少可信配置的模型退回固定 enabled。参数正确转发和工具往返通过，不证明不同档位具有单调 token/延迟差异。reasoning 请求总 deadline 为 180 秒，其余 60 秒；超时/取消不重试，也不承诺服务端停止计费。长会话、重复工具、压缩/恢复与实际安装证据见维护面 `experiments/qoder-provider/LONG-SESSIONS-VERIFICATION.md`。图片/大上下文的独立证据见维护面 `experiments/qoder-provider/IMAGE-CONTEXT-VERIFICATION.md`。

### 图片与大上下文

仅 `ultimate`、`kmodel_latest`、`dfmodel`：当前绑定账号仍须声明图片可用及有效 400K selector。产品管理窗口为 272K（与 Codex 一致，便于同一压缩百分比），后端固定 selector 为 400K；不是完整 400K/1M 输入承诺。Pi 的公式为 `输入 ≤ 窗口 − 8192` 才能拿满 4096 输出，因此单请求可用输入约 263,808；超出的单轮无法压缩时会削减回答预算而不是报错。日常由原生自动压缩（默认预留 16384，本机配置 27200 → 244,800 触发）兜住。

PNG/JPEG/WebP 支持用户多图、工具返回图片与原生 session 恢复；只接受内联 base64，单图 ≤4 MiB、当前历史图片合计 ≤6 MiB、≤32 张，COSY body ≤24 MiB。远程图片 URL 和其他格式不自动转换/抓取。目录收窄、未知 signature 或不合法图片会明确拒绝，不静默降级或切路由。模型视觉/检索并不保证每次正确；Credit 缺失仍为 unknown，Ultimate 的新路由不假定与旧 direct 同价。

关闭用 `ROTOM_QODER=0` 或不设置该变量；不要向 launcher 追加 `-e` 绕过资源合同。模型/API、账号和网络边界未验证时会失败关闭，不自动重放。

## 边界

本机执行不是安全沙箱，没有统一权限确认层。安装/确定性验证不等于真实模型效果、真实 Chrome 按键或跨平台验收。没有公开 benchmark 优势声明。

## 许可与发布状态

公开仓库保留 [MIT 许可证](https://github.com/bingjiang0611/rotom/blob/main/LICENSE)；npm 产品元数据仍为 `private: true`、`UNLICENSED`，源码公开不代表 npm 发布批准。rotom 是独立项目，不是 Pi 或宝可梦官方产品；MIT 许可不授予第三方商标权，名称／IP 使用仍需独立审查。第三方版权与许可证见[第三方声明](../rotom/THIRD_PARTY_NOTICES.md)和随依赖保留的原始许可证。
