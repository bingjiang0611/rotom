# rotom · Browser / Computer Use checklist

本页从 [change-checklists.md](change-checklists.md) 提取，专门覆盖 Browser Relay 与 Computer Use 边界。

### Browser / Computer Use

- 是否优先 Relay，并只用 socket 缺失/拒绝连接的类型化 pre-dispatch 证据允许一次 `launch_browser`？许可是否在 preflight 消费、不跨运行/会话继承、不因已派发请求后的重连失败重新授权？登录页/空结果/stale/timeout/unknown/取消/权限/协议错误不能授权回退；显式排除 Relay 的工具选择保留，回退说明独立登录态并使用新 CDP stateId。
- Browser 返回文本不扫描或替换凭据形状，可能将密码/Token 原文返回模型；长度、控制字符、URL query/hash 隐藏及 metadata-only audit 边界仍保留。不要将其描述成自动脱敏能力。
- 下载是否仍只重定向 agent 自有 tab（claim 来的用户 tab 与用户下载不动）？归属歧义时是否宁可不认领？`downloads` 结果是否只含相对路径、大小、MIME 与摘要，绝对路径没有泄漏到模型？子 agent 未声明 `allow.download` 时是否仍先取消再报 `needs-approval`？e2e 是否仍确认真实 `~/Downloads` 未被写入（harness 必须隔离下载目录，Chrome 解析默认目录时不看 HOME）？
- 主 agent 的敏感动作是否无需 UI、无需逐次询问？relay 的敏感目标探测是否仍先拒绝且不派发，再仅批准一次同 actionId 的 confirmed 请求？upload/beforeunload 是否在预检批准，审计是否标 auto-full-access 而非 user？子 agent 是否仍受限，localhost 开关是否只作为子任务本地开发例外？unknown 写入是否仍绝不重放？
- 主 agent 是否对新站点与所有 capability 默认放行、不调用 select、不写逐站授权？显式 blocklist、损坏/不安全策略的拒绝是否保留？父任务实际检查过的 origin+capability 是否仍发布给新子任务，而不是无限范围或自动扩大已有 lease？SW 的 origin 复核与 child capability 闸门是否仍保留？
- state/ref/document generation/viewport/observationEpoch 是否在动作前重验？
- recover 是否只针对原标签一次，且不影响同 session 其他标签？
- agent-created、claimed、pinned、其他窗口标签 ownership 是否保持？
- 子 agent 断开后的归属是否正确：自己 `open` 的 tab 关闭、claim/transfer 来的交还同 root 的在线主 agent、`keepTabs` 时只 detach 并回到可发现状态？每个 agent 的 tab group 标题与颜色是否仍按 agentId 稳定？

- 用户焦点是否仍只有一份记录（`focus-coordinator.js`）：只有非 agent 触发的 `tabs.onActivated`/`windows.onFocusChanged` 才更新它，agent 派发造成的激活不得被记成用户焦点？并发 agent 收尾时是否收敛到同一处，而不是各自恢复自己的旧位置？新启动的 service worker 是否先按真实活动 tab 播种？
- agent tab 是否在 `open`/`claim` 时设为 `autoDiscardable: false`，并在释放（close 保留的 claimed tab、`keepTabs`、handoff、交还/断开）时恢复原值？observation 是否带 `visibilityState`，未知取值是否 fail closed？
- `placement: "agent-window"` 是否每 agent 复用自己的窗口、从不聚焦用户窗口，非法值是否在打开任何 tab 前被拒绝？
- console 是否只捕获 agent 自己的 tab（open 时启用 `Runtime.enable`/`Log.enable`，claimed tab 首次调用才启用）、按 500 条 / 2 KB / 全局 8 MB 淘汰并用 `dropped` 报数、堆栈 ≤10 帧、`pattern` 只做子串不编译正则、结果按 128 KiB 截断并可续读？tab 关闭/移交/分离时缓冲必须清空，`captureSince` 不得暗示旧条目还在。
- hover/dblclick/right_click 是否复用同一套 ref → 坐标 → hit-test 路径，`dblclick` 的第二次按下带 `clickCount: 2`、`right_click` 用右键且 `buttons` 正确？drag 是否要求两个 ref、至少 5 次按住移动、并在 HTML5 拖放拿不到 `Input.dragIntercepted` 时用合成 `DragData` 派发 CDP 拖拽事件，同时把 `dragDataSource` 与 `dragstartFired` 如实上报（合成路径没有 `dragstart`）？
- 批量 `actions` 是否最多 10 步、与单个 `action` 互斥、拒绝工具级字段（`limit`/`cursor`/`tabName`）？每一步是否复用单动作路径（同样的校验/lease/audit），遇到 failed/unknown/navigation/dialog-blocking/expect-unmet/blocked 是否立即停下并给出 `stoppedAt` + `stopReason`，已派发的步骤不重放，结果只返回摘要而不是每步整页读回？
- JS 弹窗是否在 tab 上记录（类型、按码点截断的消息与 `defaultPrompt`、`beforeunload` 标 sensitive），弹窗期间除 `dialog`/`tabs`/`close`/`recover` 外全部在派发前返回 `dialog-blocking`，`tabs` 也能看到该状态？触发弹窗的输入是否用「派发 vs 弹窗检测」竞速，返回 `dialogOpened` + `dispatchSettled: false` 而不是等到超时？
- upload 是否只接受 `<input type="file">`、`paths` 是否为绝对真实路径，并在 Pi 侧逐条拒绝符号链接、`nlink > 1`、目录、敏感文件名/目录名（含解析后的真实路径）、超过 10 个文件或 10 MB？audit 是否只留文件名摘要和大小，子 agent 是否单独按 `allow.upload` 判定？
- keypress 是否只接受固定白名单的键（不提供“发任意字符串”的通路）、`modifiers` 去重且顺序固定、带 Control/Alt/Meta 时不带字符、Tab 只移动焦点不插入制表符、Shift 只影响字母大小写、全选走浏览器编辑命令，并且仍然先核验焦点、只用 CDP 按键事件（不用 `insertText`）？
- network 是否只捕获 agent 自己的 tab、`Network.enable` 的两个 buffer 为 0（body 不缓存）、条目里没有任何 header/body 字段、1000 条环形丢最旧、`failedOnly` 覆盖失败原因与 status ≥ 400、`pattern` 只做子串、结果按 128 KiB 截断并可续读？tab 关闭/移交/分离时缓冲必须清空。
- `navigate` 是否只用一个操作承担 URL 与 `history: back/forward/reload`，成功后 `documentGeneration` 加一（reload 不换 URL 也必须加），旧 ref/坐标作废；历史落点是否先解析 origin 再按 lease 判定，拒绝时不发导航命令？
- tab 配额是否仍在 service worker 计数（唯一全局视角）：`open` 与 `claim` 都过 `assertTabQuotaAllowed`，超限直接报错并写清上限、当前数量与“先 close 旧 tab”，不排队；`hello` 里的 `tabQuotas` 必须过 `sanitizeBrowserTabQuotasV1`，非法 `ROTOM_BROWSER_MAX_*` 报错而不是静默回退？
- 子 agent 的 lease 是否仍只在工具层判定：没有 token 的主 agent 不受限，有 token 但 lease 文件缺失/过期/origin 不在列表/devtools·upload·download 未开启时本地返回 `needs-approval`，不发出请求、不弹窗？lease 目录是否 0700、文件 0600、拒绝 symlink，且子 agent 不改写父 agent 发布的 scope？
- 新增的 browser 工具是否归入 deferred 组（`register.ts`）并显式 `defaultActive: false`？少了这一步，Pi 会把它当成默认激活工具在 fork/tree 导航时自己恢复，还会让延迟前置检查把未激活的 Subagent 工具当成致命缺失。
- 新增 `browser_devtools` 类能力时：操作与 world 是否都在白名单里、默认是否隔离世界、主 agent 的主世界是否无需确认、子 agent 是否仍上报 needs-approval、结果是否按字节截断、超时或不确定是否记 `unknown` 且不重放、audit 是否只留代码摘要？`ROTOM_BROWSER_DEVTOOLS=0` 是否真的不注册工具？
- 商店打包是否仍去掉 `manifest.json` 的开发用 `key`、两步打包字节一致、`unzip -t` 通过？上架后是否把商店分配的扩展 id 与开发 id 一起写进 native host 的 `allowed_origins`？
- 平台相关的路径（socket、锁、native host 注册位置）是否只由 `platform-paths.mjs` 生成，macOS 字符串是否保持不变（改动会让旧安装升级后连不上）？新增浏览器或平台是否同步 installer 分支与 `/browser install --browser`，并把未实测平台如实标为 L1？
- 持久化是否仍按 session 分 key（`browserRelayStateV3:<sessionId>`）、合并写并只写变化项，旧 `browserRelayStateV2`/`V1` 是否迁移后删除？
- 并发是否仍只有两层锁：结构性操作走 session 锁、其余按 tab 加锁；operation revision 是否按作用域隔离（一个 tab 结束不得作废另一个 tab 的操作）；超时重置是否仍只影响对应 tab？
- 跨 agent 是否仍只有一个 owner：`discover` 是否隐藏其他 session 的 tab、`claim` 是否只在 opener 属于另一个 session 时拒绝且不带出对方 tabName、`transfer` 是否换新 `documentGeneration`/`observationEpoch` 并作废旧 ref 与坐标？
- full snapshot、visible snapshot、screenshot 与 action readback 的证据等级是否清楚？
- 目标状态、`expect` 结果与 page-alert 是否保留 met/unmet/unknown 三态，且 changed=null 不被当成未变？
- click/type/select/keypress 的 unknown 是否只允许只读核对，不重发写动作（仅幂等 scroll 可重试一次）？
- keypress 是否仅允许 ref-bound Enter/Tab/Escape，派发前核验原对象焦点、document/frame generation，且复用后台保护与目标状态回读？不自动把 type 转成 Enter，不通过 insertText 换行或系统键盘冒充按键。
- desktop 写操作是否保持后台投递：失败时返回 unknown，而不是 activate 目标 app 抢走用户与其他 agent 共用的全机前台？
- 大响应是否仍按 256 KiB 阈值分块（`response-chunks.js`）、每块带整条响应的 sha256，客户端按序重组后才校验摘要？丢块、乱序、摘要不符是否都报错而不是返回拼出来的结果？native host 是否只按请求身份转发、在最后一块才释放路由？单帧 `MAX_MESSAGE_BYTES` 只约束一块，不冒充整条响应上限？
- 截图有两个不同的上限是否分开：传输 8 MiB（协议）、模型侧 768 KiB（`validateBrowserScreenshotV1` 默认值）？不要把传输上限当成模型可见上限。
- protocol/extension 变更是否要求用户重载，并明确 L1 与真实 Chrome L2/L3？
- Computer Use v2：桌面写是否经 Broker 租约并可解释 `resource_busy`/`stale`/`broker_unavailable`（而不是进程内互斥冒充跨进程仲裁）？App 分级与授权卡片是否在 Broker 侧判定（项目级只收紧）？审批是否只路由到最近有 UI 的祖先、模型无自我批准途径、无 UI 时 `approval_unavailable`？主机终端/IDE 是否已从 `find_roots` 剔除并拒绝作为目标？终止/停止是否撤销租约并把进行中的批次停在步骤边界、结果标 `stopped_by_user`？原生投递级别（L1/L2/L4）是否如实上报，L2 未在白名单或符号缺失时返回 `foreground_required` 而不静默转前台 HID？trace 是否只写允许的字段（输入只记长度+SHA-256）、权限/保留期/容量/关闭开关齐全且永不外传？
