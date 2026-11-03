# 任务拆分

按顺序做。同一个里程碑里，没有依赖关系的任务可以调换顺序。每个任务的“验证”一栏是**最低要求**，可以多做，不能少做。

## 通用要求（每个任务都适用）

- **新增文件**：产品运行时用到的新文件，要同时加进 `rotom/package.json` 的 `files` 和 `rotom/runtime/product-config.mjs` 里 browser 资源的 `requiredFiles`。只给测试或维护用的文件不要加。
- **协议**：每个里程碑把 `BROWSER_RELAY_PROTOCOL_REVISION_V1` 加一，并同步 `chrome-extension/manifest.json` 的 `version`。每项新能力加一个 capability 常量，命名沿用现有风格，例如 `console-capture`。Pi 端连到不支持该能力的旧扩展时，**本地拒绝**这个操作，并提示用户去 `chrome://extensions` 点刷新，不要把请求发出去。
- **输出有界**：所有新返回值都要有字节或条数上限，并标出 `truncated` 或 `dropped`。URL 的 query 和 hash 沿用 `safeDisplayUrlV1` 脱敏。
- **写操作语义**：沿用现有规则。写操作派发后如果结果不确定，返回 `unknown`，只允许只读核对，不允许重放。新增的写类动作（hover 除外）都要写 interaction audit entry。
- **错误语言**：面向用户和模型的错误信息用中文，identifier 用英文，和现有代码保持一致。
- **文档**：行为合同变化时，同步 `docs/usage.md` 的浏览器部分、`docs/agent/change-checklists.md` 的 Browser 清单，必要时也改根 `CLAUDE.md` 第 6 节，只做最小改动。
- **上下文占用**：动了工具 schema 或 promptGuidelines 的任务，跑 `rotom/bin/check-personal`，在 STATUS 里记下 context footprint 前后的对比。默认的两个 browser 工具合计增量不超过 30%。

## 常用命令（仓库根目录，Node 24+）

```bash
# 扩展侧与 native host 单测（不需要 Pi fork）
node --test rotom/extensions/browser/chrome-extension.test.mjs rotom/extensions/browser/ownership.test.mjs \
  rotom/extensions/browser/native-host.test.mjs rotom/extensions/browser/component-storage.test.mjs
# Pi 侧单测（需要先 cd rotom && npm run build:pi）
node --experimental-strip-types --test rotom/extensions/browser/*.test.ts
# 日常产品 gate，含 context footprint
rotom/bin/check-personal
# T0 之后：真实 Chromium 端到端
node --experimental-strip-types rotom/runtime/e2e-browser/run.mjs [suite ...]
```

---

## T0 隔离的真实 Chromium 端到端测试架子

**目标**：执行 agent 不依赖用户的 Chrome，就能自己跑真实浏览器验证。后面每个任务都在这里加 suite。

**改动**：新建 `rotom/runtime/e2e-browser/`（维护面，不进发行包）。
- `harness.mjs`：
  1. 建临时 `HOME`，在里面建 `Library/Application Support`。现有 socket 路径是 `homedir()/Library/Application Support/rotom/...`，Linux 上只要 HOME 指向临时目录也能用。T24 改完路径之后，这里改成调用新的路径模块。
  2. 建临时 Chromium profile。
  3. 从 `manifest.json` 的 `key` 算出扩展 id：对 base64 解码后的 DER 做 SHA-256，取前 32 个十六进制字符，再把 0 到 f 映射成 a 到 p。
  4. 写 native host manifest `dev.rotom.browser_relay.json`，`path` 指向一个 wrapper 脚本。wrapper 以临时 HOME 执行 `node native-host.mjs`，`allowed_origins` 填上一步算出的扩展 id。manifest 同时写到 `<profile>/NativeMessagingHosts/` 和 `$HOME/.config/chromium/NativeMessagingHosts/`（macOS 写 `$HOME/Library/Application Support/Chromium/NativeMessagingHosts/`），实测哪个路径生效后，在注释里写明。
  5. 用 `ROTOM_CHROME_EXECUTABLE` 指定的 Chromium 或 Chrome for Testing 启动，参数参照 `rotom/runtime/smoke-browser-relay.mjs`；无头环境加 `--headless=new`。
  6. 提供 `connect(sessionId, extra)`，返回 `BrowserRelayClientV1`，socketPath 走临时 HOME。
  7. 结束时清理进程和临时目录。失败时保留目录，并打印路径方便排查。
- `fixtures/`：本地 HTTP 测试站，后面各任务按需加页面。至少包括：表单页、带 iframe 的页、故意抛异常和 `console.error` 的页、一个返回 500 的 fetch、`alert`/`confirm`/`prompt`/`beforeunload`、hover 菜单、HTML5 拖放和鼠标拖拽列表、`<input type=file>`、下载链接、依赖 `requestAnimationFrame` 才会渲染完成的列表。
- `run.mjs`：按名字跑 suite，输出每条断言的通过和失败，退出码非零表示失败。
- 把 `smoke-browser-relay.mjs` 现有的断言搬成第一个 suite `baseline`（或者让它也能接受 harness 注入 socketPath），保证老行为在新架子上能复现。

**验收**：在 Linux 无头环境下，`run.mjs baseline` 通过，全程不读写真实 HOME（可以用 `strace` 或检查真实 HOME 下没有新文件来证明，二选一）。

**验证**：`node --experimental-strip-types rotom/runtime/e2e-browser/run.mjs baseline`，连续跑三次都通过，排除偶发。

---

## M1 并行底座

### T1 browser principal

- 客户端在 `hello` 的 payload 里带上 `{ agentId, rootSessionId, leaseToken? }`。来源依次是：环境变量 `ROTOM_BROWSER_AGENT_ID`、`ROTOM_BROWSER_ROOT_SESSION`、`ROTOM_BROWSER_LEASE`；都没有时，`agentId` 取 `main`，`rootSessionId` 取自己的 sessionId。
- service worker 在 session state 上记录这些字段，`tabs` 的结果里返回 `agentId`。
- 旧客户端不带这些字段时，按主 agent 处理，保持兼容。
- **验证**：在 `chrome-extension.test.mjs` 和 `browser-relay.test.ts` 加用例，覆盖带字段和不带字段两种 hello。

### T2 跨 agent 的 tab 隔离与 transfer

- `discover` 不返回其他 session 拥有的 tab。`claim` 遇到别人的 tab 时拒绝，错误信息里不泄露对方的 tabName。
- 新增 `transfer` 操作，参数 `{ tabName, toAgentId }`。只允许在同一个 `rootSessionId` 下的 session 之间移交；移交后 `documentGeneration` 和 `observationEpoch` 都要换新，旧 ref 和坐标全部失效；接收方用新 tabName（`<原名>@<from>`）。
- 弹出的新 tab 在 `discover` 里标 `openerOwnedByYou`，只有 opener 的拥有者可以 claim。
- **验证**：单测覆盖“A 看不见 B 的 tab”“A claim B 的 tab 被拒”“transfer 后旧 ref 报 stale”“不同 root 之间 transfer 被拒”。e2e suite `isolation`：两个客户端，一个 transfer 给另一个，两边都断言。

### T3 两层锁

- 把 `state.operationChain` 拆开：session 锁管 `open`、`claim`、`close`、`tabs`、`switch`、`transfer`、`handoff`、`recover`、`hello`；tab 锁管其余按 tabName 定位的操作。拿 tab 锁之前先短暂拿 session 读锁，保证 tab 不会在操作中途被关掉。
- 超时重置（`resetAfterOperationTimeout`）只影响对应的 tab，不影响同 session 的其他 tab。这条本来就在 change-checklists 里，要继续成立。
- Pi 侧：`browser_inspect` 里的只读操作（snapshot、snapshot_visible、read_full、screenshot、tabs、wait，以及 M2 加的 console、network）改成 `executionMode: "parallel"`。Pi 支持 `"parallel"`，见 `packages/rotom-pi/packages/agent/src/types.ts`。注意：`smoke-runtime.mjs` 现在断言它是 sequential，要同步改这条断言并写明原因。`browser_interact` 保持 sequential。
- **验证**：单测里用可控延迟的 fake chrome，证明同一 session 两个 tab 的 snapshot 是重叠执行的，同一个 tab 的两个请求仍然串行，open 和 snapshot 不会交错。e2e suite `same-agent-parallel`。

### T4 按 session 持久化

- `chrome.storage.session` 从单个 `browserRelayStateV2` 改成每个 session 一个 key（`browserRelayStateV3:<sessionId>`），加 100ms 合并写，只写有变化的 session。
- 启动时读到 V2 就迁移成 V3，然后删掉 V2。V1 的兼容读取保持现状。
- **验证**：单测覆盖迁移、合并写，以及 SW 重启后状态恢复。

### T5 每个 agent 一个 tab 分组与退出清理

- `shared-tab-group.js` 改成按 agentId 分组：主 agent 的分组标题是 `rotom`，子 agent 是 `rotom · <agentId 前 12 位>`；颜色按 agentId 哈希在 Chrome 的 8 种颜色里选。
- 收到 `client-disconnected` 时，如果这个 session 不是主 agent：关掉它自己 `open` 的 tab；它 claim 或被 transfer 来的 tab 归还给同 root 下的主 agent（主 agent 不在线时就只 detach）。主 agent 断开时维持现在的行为。
- 子 agent 的 lease 里有 `keepTabs: true` 时，不关 tab，只 detach。
- **验证**：单测和 e2e suite `cleanup`：子客户端开两个 tab、claim 一个，断开后检查剩下的 tab 和归属。

### T6 后台执行与焦点协调

- 把 `withBackgroundActivationGuard` 里“记下用户的 active tab 和聚焦窗口，再恢复”的逻辑抽成全局单例 `focus-coordinator.js`。它只根据**非 agent 引起**的 `tabs.onActivated` 和 `windows.onFocusChanged` 更新“用户焦点”；判断是不是 agent 引起的，用一个短时间窗口内 agent 操作的标记。所有 agent 恢复焦点时都恢复到这个值。
- open 或 claim 时设置 `chrome.tabs.update(tabId, { autoDiscardable: false })`，释放时恢复原值。
- 每次操作前发 `Page.setWebLifecycleState({ state: "active" })`。失败只记诊断，不让操作失败。
- 观察结果里加 `visibilityState`（用 `Runtime.evaluate` 读 `document.visibilityState`）。
- 新增 open 参数 `placement: "background-tab" | "agent-window"`，默认 `background-tab`。`agent-window` 是给这个 agent 开一个 `focused: false` 的新窗口，后续这个 agent open 的 tab 都放进去。
- **验证**：e2e suite `focus`：4 个客户端同时 open，并点击会弹窗的按钮，整个过程中“用户” tab（harness 先开好并激活的那个）一直保持 active。`visibility`：`agent-window` 下 `visibilityState` 是 visible。

### T7 大响应分块

- SW 发给 native host 的单条消息超过 256 KiB 时分块，帧上带 `chunk: { index, count, sha256 }`；native host 原样转发给客户端，客户端重组并校验摘要。native host 的 `MAX_MESSAGE_BYTES` 只限制单块大小。
- 截图上限从约 950 KB 提到 8 MB，供 M4 的整页截图使用；给模型看的截图仍保持现在的大小。
- **验证**：native-host 单测验证“一个客户端收大响应时，另一个客户端的小响应不被阻塞”，用两个响应完成的先后顺序断言。客户端单测覆盖块丢失、乱序和摘要错误这三种情况都报错。

### T8 子 agent 加载 browser 扩展

- 现状：产品扩展只通过 `rotom/runtime/launch-runtime.mjs` 的 `productRuntimeArgs` 传给主 agent，子 agent 拿不到 browser 工具（核实过程见 design.md 第 8 节）。
- 改法参照 Qoder：`launch-runtime.mjs` 在资源校验通过后，设 `ROTOM_SUBAGENT_BROWSER_EXTENSION` 为 `extensions/browser/index.ts` 的绝对路径；`packages/rotom-subagents/src/runs/shared/pi-args.ts` 在请求的工具包含 `browser_inspect` 或 `browser_interact`、且 `capabilityCeiling.denyExtensions` 不为 true 时，把这个路径加进扩展参数，并做和 Qoder 一样的路径校验。
- 同时把 `ROTOM_BROWSER_AGENT_ID`（子 agent 的 run id）、`ROTOM_BROWSER_ROOT_SESSION` 和 lease token（T9）放进子进程环境变量。
- `packages/rotom-subagents` 是内化组件，改完要按 `docs/agent/subagent-source-maintenance.md` 重新构建，并同步 vendor 归档、lock、integrity 和 `product-config.mjs`。不要直接改 installed source。
- **验证**：`packages/rotom-subagents` 里加 pi-args 单测，覆盖“请求了 browser 工具就带上路径”“没请求就不带”“denyExtensions 时不带”。再跑一次真实子 agent，用不调模型的 fixture 或现有 owned-execution 测试方式，证明子进程里注册了 `browser_inspect`。

### T9 lease 与 needs-approval

- 父 agent 的 browser 扩展在派生子 agent 前生成 lease：`{ token, rootSessionId, agentId, origins: string[], allow: { devtools, upload, download }, maxTabs, keepTabs, expiresAt }`。lease 写到私有目录（权限 0700 和 0600，拒绝 symlink，参照 `BrowserArtifactStoreV1`），token 通过环境变量传给子进程。
- lease 怎么生成：默认 origins 等于父 agent 当前已经授权过的站点（T20 之前就是父 agent 已打开 tab 的 origin），其他 allow 全部为 false。如果需要和 subagent 的派生流程挂钩，优先找 Pi 已有的事件或环境注入点；找不到就在 T8 的 pi-args 里一起注入，并在 STATUS 里写明选了哪种。
- 子 agent 的 Pi 侧在每次 open、navigate 和写操作前，检查目标 origin 是否在 lease 里。不在就返回结构化错误 `{ kind: "needs-approval", origin, capability }`，不弹窗，也不发请求。
- 父 agent 收到子 agent 上报的 needs-approval 后怎么处理，放在 T20 做（向用户确认，再更新 lease 文件）。lease 文件要设计成可以被更新，子 agent 每次检查都重新读。
- **验证**：单测覆盖没有 lease、lease 过期、origin 不在列表、更新 lease 后放行。e2e suite `lease`：子客户端访问未授权的 origin 时拿到 needs-approval，而且 SW 没有收到 open 请求（在 fixture 服务器端断言没有访问记录）。

### T10 配额

- 默认值：同时连接 browser 的 agent 8 个；每个 agent 自己 open 的 tab 4 个；全局 agent tab 24 个；同一 origin 同时 2 个 tab。可以用环境变量覆盖：`ROTOM_BROWSER_MAX_AGENTS`、`ROTOM_BROWSER_MAX_TABS_PER_AGENT`、`ROTOM_BROWSER_MAX_TABS`、`ROTOM_BROWSER_MAX_TABS_PER_ORIGIN`。
- 计数放在 SW（唯一知道全局状态的地方），超限时 `open` 直接返回错误，错误里写清楚是哪个上限、当前数量，以及“先 close 旧 tab”。不排队。
- **验证**：单测覆盖每个上限和环境变量覆盖。

### T11 M1 端到端

- e2e suite `parallel-4`：4 个客户端，每个以不同的 agentId、同一个 rootSessionId 连接，同时在各自的 tab 上完成一套表单流程（open、snapshot、type、select、click、readback），每个重复 5 轮。
- 断言：没有串台（每个客户端读到的都是自己表单里填的值）；“用户” tab 始终 active；tab 分组和归属正确；记录每个操作延迟的 p50 和 p95，写进 STATUS。
- **M1 完成标准**：`parallel-4` 连续三次通过，`rotom/bin/check-personal` 通过（既有环境失败除外），STATUS 里有延迟数据。

---

## M2 调试 P0

### T12 navigate 与历史

- `browser_inspect` 新增 `navigate`：参数 `url`，或者 `history: "back" | "forward" | "reload"`。用 `Page.navigate`、`Page.getNavigationHistory` 加 `Page.navigateToHistoryEntry`、`Page.reload`。完成后 `documentGeneration` 加一，坐标失效，等页面到 `complete`（复用 wait 的超时逻辑），返回 observation。
- URL 校验复用 `canonicalBrowserUrlV1`。子 agent 走 lease 检查。
- **验证**：单测和 e2e suite `navigate`：前进、后退、刷新以后旧 ref 报 stale。

### T13 console

- open 时对 agent 自己的 tab 启用 `Runtime.enable` 和 `Log.enable`；claim 来的 tab 要等第一次调用 console 才启用。
- 每个 tab 一个环形缓冲区：500 条，每条最多 2 KB，内容是 level、文本、来源 URL（脱敏）、行号、时间。异常带截断到 10 帧的堆栈。全局上限 8 MB，超出时先丢最旧的条目。
- `browser_inspect` 新增 `console`：参数 `level?`、`pattern?`（大小写不敏感的子串，不支持正则，避免 ReDoS）、`sinceCursor?`、`limit?`（默认 50）。返回 `captureSince`、`dropped`、`nextCursor`。SW 重启后缓冲区会清空，`captureSince` 要反映这一点。
- **验证**：e2e suite `console`：fixture 页抛异常和 `console.error`，能读到堆栈；pattern 过滤有效；缓冲满了以后 `dropped` 大于 0。

### T14 network

- `Network.enable`，`maxTotalBufferSize` 和 `maxResourceBufferSize` 设为 0，即不缓存 body。每个 tab 一个环形缓冲区，1000 条，内容是 requestId、URL（脱敏）、method、资源类型、status、mimeType、耗时、失败原因、是否来自缓存。不保存任何请求头和响应头。
- `browser_inspect` 新增 `network`：参数 `failedOnly?`、`pattern?`、`resourceType?`、`sinceCursor?`、`limit?`。
- `network_body` 放到 T23 的 `browser_devtools` 里做，因为需要先启用 body 缓存，而且要单独授权。
- **验证**：e2e suite `network`：fixture 页的 500 请求能用 failedOnly 筛出来，结果里不出现 `Cookie` 和 `Authorization`（fixture 故意带上这两个头，断言整个返回 JSON 里都找不到它们的值）。
- **M2 完成标准**：三个 suite 和 check-personal 通过，并记录 footprint 对比。

---

## M3 交互与安全

### T15 完整按键

- `BROWSER_INTERACTION_KEYS_V1` 扩到固定白名单：方向键、Backspace、Delete、Space、Home、End、PageUp、PageDown、F1 到 F12、单个字母和数字。新增 `modifiers: ("Shift"|"Control"|"Alt"|"Meta")[]`。用一张表生成 `Input.dispatchKeyEvent` 需要的 key、code、windowsVirtualKeyCode 和 text。
- 仍然必须带 targetRef，派发前核验焦点，和现在的 keypress 一样。不要用 insertText 冒充按键。
- **验证**：e2e：在 textarea 里用 `Meta+A`（macOS）或 `Control+A` 全选后按 Backspace，内容变空；方向键能移动 listbox 的选中项。

### T16 hover、双击、右键、拖拽

- 新动作 `hover`、`dblclick`、`right_click`：复用 `dispatchPoint` 和 hit-test。hover 之后的 readback 要能看到新出现的菜单节点。
- 新动作 `drag`：参数 `targetRef` 加 `dropRef`，或者终点坐标加 `observationEpoch`。普通拖拽发 pressed、多次 moved（至少 5 次）、released；如果页面用的是 HTML5 拖放，用 `Input.setInterceptDrags` 加 `Input.dispatchDragEvent`。起点和终点都要过 hit-test。结果不确定时按 unknown 处理。
- **验证**：e2e suite `pointer`：hover 菜单出现；双击触发 dblclick 计数；右键触发 contextmenu；两种拖拽都能把第 1 项移到第 3 项。

### T17 上传

- 新动作 `upload`：参数 `targetRef`（必须是 file input）加 `paths: string[]`。
- Pi 侧先校验：路径要是绝对路径并做 realpath；拒绝 symlink 和 `nlink > 1`；拒绝文件名或任一级目录名命中 `.env*`、`*.pem`、`*.key`、`id_*`、`.ssh`、`.aws`、`.gnupg`、`.netrc`、`.npmrc`；单次总大小不超过 10 MB；子 agent 还要 lease 里 `allow.upload` 为 true。
- SW 用 `DOM.setFileInputFiles`。audit 记录文件名摘要和大小，不记录内容。
- **验证**：单测覆盖每一条拒绝规则。e2e：fixture 服务端收到的文件和本地文件的 sha256 一致。

### T18 JS 弹窗

- 启用 `Page.javascriptDialogOpening` 和 `Page.javascriptDialogClosed`，把当前弹窗 `{ type, message(截断), defaultPrompt }` 记在 tab 上。
- tab 上有弹窗时，除了 `dialog`、`tabs`、`close`、`recover` 以外的操作都返回 `{ kind: "dialog-blocking", dialog }`，不派发。
- 新动作 `dialog`：参数 `accept: boolean` 加 `promptText?`。`beforeunload` 类型算敏感操作，要走 T21 的确认。
- **验证**：e2e suite `dialog`：alert、confirm（两种选择）、prompt（带文字）、beforeunload 都覆盖。

### T19 批量动作

- `browser_interact` 新增可选的 `actions: Action[]`（最多 10 步），和单个 action 参数互斥。按顺序执行，遇到失败、unknown、导航、`dialog-blocking` 或 expect 不满足就停下，返回每一步的结果和停在哪一步。每一步单独写 audit；已经派发过的步骤不重放。
- **验证**：单测覆盖每一种停止条件。e2e：一次批量填完整个表单并提交。

### T20 按站点授权

- 策略文件放在 `<用户配置目录>/rotom/browser-policy.json`（权限 0600，拒绝 symlink）。格式是 `{ blocklist: string[], allowlist: { origin: string, capabilities: ("read"|"interact"|"devtools"|"upload"|"download")[] }[] }`，origin 支持 `*.example.com`。
- 检查顺序：先查 blocklist，再查 allowlist，都没有就问。主 agent 用 `ctx.ui.select`，选项是“允许一次 / 本会话允许 / 总是允许 / 拒绝”；总是允许就写回策略文件。没有 UI 时（`ctx.hasUI` 为 false）按拒绝处理，返回 needs-approval。
- 检查放在 Pi 侧。SW 侧在导航之后的第一个写操作之前，再核对一次当前 origin 和 Pi 侧传过来的已授权 origin 集合是否一致，防止被重定向绕过。
- 主 agent 收到子 agent 上报的 needs-approval 时，走同一个确认流程，确认后更新子 agent 的 lease 文件。
- localhost 和 127.0.0.1 默认允许 read 和 interact，免得本地开发也要一次次确认。
- **验证**：单测覆盖顺序、通配、写回和无 UI 的情况。e2e：fixture 页 302 重定向到未授权的 origin 后，写操作被 SW 拒绝。

### T21 敏感动作确认

- 触发条件：目标在含 `autocomplete="cc-*"` 字段的 form 里；目标的可访问名称命中词表（中英文的 提交/submit、支付/pay、购买/buy、删除/delete、发送/send、确认订单/place order 等，词表放在单独的模块里）；以及 `beforeunload`、`upload`、`evaluate`。
- 主 agent 用 `ctx.ui.confirm`，子 agent 返回 needs-approval。用户拒绝时返回明确的“用户拒绝”，不当作失败重试。
- 测试 fixture 用 localhost，可以用环境变量 `ROTOM_BROWSER_CONFIRM=auto-approve-localhost` 只对 localhost 自动放行，供 e2e 使用。这个开关在非 localhost origin 上必须无效，要有单测证明。
- **验证**：单测覆盖词表命中、cc 字段、开关对非 localhost 无效。
- **M3 完成标准**：所有 M3 suite、check-personal 通过，footprint 增量在 30% 以内（超出就把不常用的说明移进 `browser_devtools` 或精简 guidelines）。

---

## M4 devtools 与平台

### T22 下载

- manifest 增加 `downloads` 权限，在 STATUS 里写明这会让用户看到一次新的权限提示。
- 只处理 agent tab 发起的下载：在 `chrome.downloads.onDeterminingFilename` 里用 `referrer` 或 tabId 判断，把文件放到 `rotom/<agentId>/` 子目录下（相对于用户的下载目录）。用户自己的下载一律不碰。
- `browser_inspect` 新增 `downloads`：返回状态、相对路径、大小、MIME。下载完成后 Pi 侧计算 sha256。子 agent 需要 lease 里 `allow.download` 为 true，否则取消这次下载并返回 needs-approval。
- **验证**：e2e：fixture 的下载能拿到，sha256 一致；harness 在“用户” tab 里触发的下载不被改路径。

### T23 `browser_devtools` 工具

- 新的 model-only 工具，放进 deferred-tools 的 Browser 组（`rotom/extensions/third-party/deferred-tools/register.ts`），默认不常驻。同步 `context-footprint.mjs` 的分组。
- 操作：
  - `evaluate`：默认在 `Page.createIsolatedWorld` 的 isolated world 里执行，`world: "main"` 需要单独确认。`returnByValue`、`awaitPromise`、超时 10s、结果上限 64 KB。audit 记录代码摘要。按写操作处理：结果不确定就返回 unknown，不重放。需要 devtools 授权。
  - `viewport`：`Emulation.setDeviceMetricsOverride` 加可选的 UA 和 touch，内置 `iphone-15`、`pixel-8`、`ipad`、`desktop-1440` 几个预设，`reset` 恢复。改完以后坐标失效。
  - `screenshot_export`：整页或当前视口，PNG 或 JPEG，经 T7 的分块传过来，写到用户给的路径（必须在当前项目目录里，拒绝 symlink）。
  - `network_body`：按 requestId 取响应体，只要 JSON 和文本，上限 64 KB。需要 devtools 授权。首次调用时要用较小的 buffer 重新 `Network.enable`，并在结果里说明“只能取到启用之后的请求”。
  - `trace_start` / `trace_stop`：全局同一时间只能有一个 trace。`IO.read` 分块写盘，Pi 侧做摘要（long task 数量和最长的 10 个、CLS、最慢的 10 个脚本）返回给模型，完整文件路径一起返回。
  - `record_start` / `record_stop`：`Page.startScreencast`，2 fps，最长 2 分钟，帧写进私有临时目录；stop 时合成 GIF，用纯 JS 实现，不加新的 npm 依赖。如果确实做不到不加依赖，先在 STATUS 的“阻塞”里说明，这一项暂时跳过，继续做其他任务。
- `ROTOM_BROWSER_DEVTOOLS=0` 时整个工具不注册。
- **验证**：每个操作都有 e2e；evaluate 的 isolated world 读不到页面的全局变量，main world 读得到。

### T24 跨平台路径与多浏览器

- 新建 `platform-paths.mjs`，统一生成 socket 路径、锁和 native host manifest 位置。`browser-relay.ts`、`native-host.mjs`、`install-chrome-relay.mjs` 都改成用它。
  - macOS：现有路径不变，保证升级之后不断连。
  - Linux：socket 放在 `$XDG_RUNTIME_DIR/rotom/browser-relay/relay.sock`，没有 `XDG_RUNTIME_DIR` 时用 `~/.local/state/rotom/browser-relay/`；锁用现有的 flock 分支。
  - Windows：named pipe `\\.\pipe\rotom-browser-relay-<用户名哈希>`，manifest 的路径写进注册表 `HKCU\Software\<浏览器>\NativeMessagingHosts\dev.rotom.browser_relay`，锁用命名 mutex 或独占打开的 lock 文件。Windows 没法在这个环境里实测，写清楚是 L1，放进 STATUS 的未验证项。
- `install-chrome-relay.mjs` 新增 `--browser chrome|chromium|edge|brave|arc|vivaldi`，不带参数时自动探测已安装的浏览器，`/browser install` 里让用户选。把 `process.platform !== "darwin"` 的硬性拒绝改成按平台分支。
- `rotom/package.json` 的 `os` 字段现在是 darwin 和 linux，Windows 先不加，只保证代码能跑通。
- 把 README 里说的两条既有环境失败（installer 测试、multiplex 测试里的 `/private/tmp`）修成跨平台。
- **验证**：Linux 上完整单测通过；`run.mjs` 全部 suite 通过；macOS 路径有单测断言保持不变。

### T25 Chrome 商店上架准备

- 新增 `rotom/scripts/pack-chrome-extension.mjs`：从 `chrome-extension/` 打出商店用的 zip（去掉 `key` 字段，商店会自己分配 id；同时记下来，上架以后要把 native host 的 `allowed_origins` 改成商店 id，和现有 id 一起保留）。
- 在 `docs/agent/browser-parallel/chrome-web-store.md` 起草商店需要的材料：单一用途说明、每项权限的理由（debugger、nativeMessaging、tabs、tabGroups、storage、alarms、downloads）、隐私说明（数据只在本机流转，不上传）。
- **不要提交上架**：需要用户的开发者账号，到这里就停下，在 STATUS 里写“等用户提交”。

**M4 完成标准**：全部 suite 和 check-personal 通过；STATUS 里列清楚 L1 和 L2 分别覆盖了什么，Windows 标为未验证。
