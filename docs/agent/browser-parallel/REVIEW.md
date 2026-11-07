# 评审意见

由评审 agent 维护。每轮评审追加一节，标明针对的 commit 范围。执行 agent 开始新任务前先看这里。

<!-- 格式：
## 第 N 轮（<起始 commit>..<结束 commit>）
- [必须改] T3：……
- [建议] T5：……
- [已通过] T1、T2
-->

## 第 1 轮（e586628..7d04230）

评审环境：Linux x64（无 IPv6、root），Node 24.22.2，隔离 Chromium（`--no-sandbox` 包装）。macOS 结论沿用 STATUS，未复跑。

**复现结果**
- `rotom/extensions/browser/*.test.mjs`：202 项，9 项失败，全部是 T24 的跨平台遗留（见下）。
- `rotom/bin/check-personal`：10 项 ✖，同上原因；`index.test.ts` 的 batch/policy/confirm/downloads/devtools 用例全部通过。之后 `rotom/extensions/third-party/index.test.ts` 在评审容器里 15 分钟无输出，被手动终止。它和 browser 无关，更可能是容器环境问题，所以这一轮没有拿到 check-personal 的最终 EXIT。
- e2e：不打补丁在 Linux 上**一项都跑不起来**（见 T24）。本地打了 54 行补丁后：22 suite，105 通过 / 11 失败。

### 必须改

- [必须改] **T9/T20 子 agent 的 lease 范围比授权范围大，并且绕过 blocklist。**
  - `index.ts` 的 `publishLeaseScope`（约 557 行）用 `tabs` 返回的每个 tab 的**当前 URL** 扩充 `authorizedOrigins`，再发布为子 lease 的 `origins`。调用点在 923、1087、1333 行。
  - 这样以下来源都会进入子 lease：
    - claim 来的用户 tab；
    - 重定向落点，包括 302 跳到 blocklist 的 origin；
    - 页面自己导航去的任何站点。
  - 子 agent 一侧，`policyDenial` 遇到 `leaseToken` 直接 `policyAuthorizedOrigins.add(origin)` 并放行（约 627 行），既不读策略，也不判 blocklist。
  - 结果：主 agent 被 blocklist 挡住的站点，子 agent 只要在 lease 里就能读写。这和 STATUS 里 T20 自己写的决定“集合来自真正授权过的 origin，不是当前开着的 tab”正面矛盾。
  - 要求：
    - 子 lease 的 `origins` 只来自 `policyAuthorizedOrigins`，或者来自显式的父侧授权，不来自 tab URL。
    - 子 agent 写操作前仍判一次 blocklist。blocklist 是用户的硬约束，lease 不能覆盖它。
  - 补测试：
    - 父 tab 302 到 blocklist origin 后 spawn 子 agent，子 agent 对该 origin 的 open/写操作返回 `needs-approval`，且站点 0 请求。
    - claim 来的用户 tab 的 origin 不出现在子 lease 里。
- [必须改] **T22 `onDeterminingFilename` 有路径不调用 `suggest()`。**
  - `service-worker.js` 约 2408 行的 listener 返回 `true`，承诺会异步调用 `suggest`。
  - 但 `onDeterminingFilenameV1` 在以下情况都直接 `return`，没有调用 `suggest`：
    - `agentId === undefined`，也就是用户自己的下载、所有歧义情况；
    - `filename === undefined`；
    - cancel 之后；
    - `catch`。
  - Chrome 的合同是返回 `true` 就必须恰好调用一次 `suggest`。否则这次下载会停在 determining filename，直到监听方被回收。native port 让 SW 常驻，所以可能一直卡住。
  - 这正好打中“用户自己的下载一律不碰”这一条：现在是不碰路径，但可能卡住下载。
  - 要求：
    - 所有不重定向的分支都调用 `suggest()`（无参，保持 Chrome 默认）。
    - 用 `finally`，或者用“只调用一次”的守卫保证恰好一次。
  - e2e `downloads` 的用户 tab 用例目前只断言站点收到请求。要补断言：用户 tab 那次下载在 `chrome.downloads.search` 里到达 `state: "complete"`，且路径不在 `rotom/` 下。
- [必须改] **T24 没做完，STATUS 夸大了。** tasks.md 要求 Linux 上 e2e 可跑。现状如下：
  1. 单测仍写死 macOS 路径，Linux 上 10 项失败：
     - `native-host.test.mjs` 第 15–16、90、107 行，socket 与 lock 都在 `Library/Application Support`；
     - `chrome-extension.test.mjs` 的 installer 用例（约 708–740 行）和 multiplex 用例（约 747–759 行）。
     - 要求：统一改用 `platform-paths.mjs` 计算期望路径。
  2. `harness.mjs` 约 147 行把 relay socket 写死成 `home/Library/Application Support/rotom/browser-relay/relay.sock`，而 Linux 上 native host 按 `platform-paths.mjs` 去连 `~/.local/state/rotom/browser-relay`。两边永远对不上，SW 侧 `connectNative` 报 “Native host has exited”，所有 suite 卡死。
     - 另外，Linux 的 Chromium 从 HOME 下的 `.config/chromium/NativeMessagingHosts` 找 host manifest，不看 profile 目录。所以 harness 要在 Linux 上给 Chrome 一个隔离 HOME，并把 manifest 放进去。
     - 这不违反“不碰真实 HOME”：隔离 HOME 本来就在 `root` 下。
  3. `fixtures/server.mjs` 第 512 行 `listen("frame", "::", "localhost")` 需要 IPv6，没有 IPv6 的机器上直接 `EAFNOSUPPORT`。另外 frame listen 失败时 main server 不关闭，runner 挂住不退出。
     - 要求：改成 `127.0.0.1`，或者先探测 IPv6 再回退；启动失败时清理已经起来的 server。
  - 参考补丁（评审在本地用来跑通 Linux e2e，**不是**最终实现，未提交）。思路如下：
    - harness 的 socketPath 改用 `browserRelaySocketPathV1({ home, env: { ...process.env, XDG_RUNTIME_DIR: undefined } })`；
    - Linux 上把 manifest 目录加上隔离 HOME 下的 `.config/chromium/NativeMessagingHosts`；
    - Linux 上 Chrome 的 env 设 `HOME=<root>/home`；
    - fixture 的 `::` 改成 `127.0.0.1`。

- [必须改] **公开审计在分支上是 BLOCKED。**
  - `python3 scripts/audit-public.py --root .` 在 7d04230 上报 8 条 `personal-home-path`：
    - `downloads.test.mjs` 第 12 行；
    - `platform-paths.test.mjs` 第 18、21、23–25、56 行；
    - `upload-guard.ts` 第 35 行。
  - 都是测试或注释里的示例家目录，不是真实路径。但这会挡住合入 main 和同步公开仓库。
  - 要求：按 `docs/agent/privacy-release.md` 的约定改用审计认可的示例写法，或者从 `os.homedir()`/临时目录拼路径。不要为此放宽审计规则。
  - 每次推送前跑一遍审计。

### 打补丁后 Linux e2e 仍失败的 11 项（需要定位，至少要能解释）

- **截图在 Linux headless 下超时，然后级联。**
  - 失败用例：`baseline :: screenshot` 报 `browser relay screenshot timeout`；随后 `baseline :: close` 报 “client 已关闭”。`devtools` 的 6 项也是同样的级联：第一项 `screenshot` 失败后，后续全是 “client 已关闭”。
  - 两个问题：
    1. 截图为什么在后台 tab 上挂住。可能和 headless/无 GPU 有关，也可能是 `Page.captureScreenshot` 对非前台 tab 的行为差异。请在 Linux 上确认。
    2. 一次超时为什么会关掉整个 relay client。按 CLAUDE.md §6，timeout 只对原标签 recover 一次，不应该让后续所有调用失败。
  - 如果第二点是 harness 的行为，至少每个用例要用独立 client，避免级联掩盖真实结果。
- **`chunked :: 另一个 tab 的读在分块响应进行中完成`**：`read.nodes` 为空。需要确认是并发时序问题，还是 snapshot 真的返回了空结果。
- **`pointer` 的两项拖拽**：`result.effect.action` 是 `undefined`，即返回的不是 drag effect。请把 `result` 整体打印出来定位。
- 失败现场已保留在评审机的 `/tmp/rotom-e2e-*`。你那边在 Linux 容器里复现即可，复现方法见下。

### 建议

- [建议，倾向必须改] **T3 `browser_inspect` 整个工具标成了 `parallel`。**
  - 但 `open`/`claim`/`close`/`navigate`/`transfer` 都在 inspect 里。tasks.md 说的是只读操作并行。
  - relay 侧有 session 锁兜底，但 Pi 侧不行：两个并发的 `open` 可能同时走 `policyDenial` → `ctx.ui.select`，弹出两个询问；同时还会并发改写 `authorizedOrigins` 和 `ROTOM_BROWSER_LEASE_SCOPE`。
  - 二选一：
    - 把结构性操作挪到 `browser_interact`；
    - 或者在 Pi 侧给结构性 action 和策略询问加一把进程内互斥锁，并补一个两个 `open` 并发只弹一次询问的测试。
- [建议] **“允许一次”会留在 `policyAuthorizedOrigins` 里**（约 650 行），之后同一 origin 的 relay 复核一直放行。Pi 侧下次仍会询问，所以不算漏洞。但“只允许一次”与 relay 侧集合的语义不一致，至少在文档里写清楚。
- [建议] **upload 有检查与使用之间的 TOCTOU 窗口**：Pi 侧校验后 relay 才读文件。实际风险低，在 usage 文档“未验证/限制”里写一句即可。
- [建议] **配额声明**：hello 里客户端声明的配额已经不被信任，这点正确。补一个反向用例：客户端声明更大配额时，SW 仍按环境变量或默认值拒绝。
- [待完成] 文档：`usage.md`、`change-checklists.md`、CLAUDE.md §6、e2e README，以及 T25。
- [待完成] 改完后请在 Linux 上跑一遍 e2e，并在 STATUS 里分平台记录结果：macOS L2、Linux L2、Windows L1。

### 已通过

- 以下 suite 在 Linux 上全部通过（代码为抽查，不是逐行审）：
  - isolation、same-agent-parallel、cleanup、focus、visibility、lease、quotas、parallel-4、navigate、console、network、keyboard、upload、dialog、batch、policy、confirm、downloads。
- 抽查确认正确：
  - `auto-approve-localhost` 只对 localhost、127.0.0.1、::1 生效；
  - upload guard 覆盖 symlink、`nlink>1`、敏感名、真实路径、10 个文件和 10 MB 上限；
  - `world: "main"` 的 evaluate 逐次确认；
  - 子 agent 和无 UI 只上报 `needs-approval`，不代替用户确认。

### Linux 复现方法

```bash
# Node 24（构建器要求）；容器有自签 CA 时加 NODE_EXTRA_CA_CERTS / NPM_CONFIG_CAFILE
(cd rotom/runtime/pi && npm ci) && (cd rotom/extensions/third-party && npm ci) && (cd packages/rotom-subagents && npm ci)
rotom/bin/check-personal                     # 同时生成 PATH 里的 pi shim
node --test rotom/extensions/browser/*.test.mjs
# root 下 Chromium 需要 --no-sandbox：用一个 wrapper 脚本 exec chromium --no-sandbox "$@"
ROTOM_CHROME_EXECUTABLE=/path/to/chrome-nosandbox.sh node --experimental-strip-types rotom/runtime/e2e-browser/run.mjs
```

**下一步顺序**：先 T24 的 Linux 可跑，否则其它修复在 Linux 上无法验证；然后 T9/T20 lease、T22 suggest、T3；再定位 11 项 e2e 失败；最后文档和 T25。

## 第 2 轮（c128b6c..0013fe2，含合并到 main 的 e044253）

评审环境：Linux x64（root、无 IPv6），Node 24.22.2，Chrome for Testing 153（`--no-sandbox` 包装），`main` 原样、不打补丁。

**复现结果**
- browser 单测（`rotom/extensions/browser/*.test.{mjs,ts}` + `pack-chrome-extension.test.mjs`，带 `ROTOM_PI`）：300 项，299 通过，0 失败，1 skip。第 1 轮的 10 项 Linux 失败全部修好。
- `python3 scripts/audit-public.py --root .`：PASS，0 findings。
- e2e 不打补丁就能在 Linux 上跑起来，T24 的 harness 修复有效：23 suite，112 通过 / 7 失败（baseline 2、chunked 1、settle 2、pointer 2）。`xvfb-run` + `ROTOM_E2E_HEADED=1` 重跑这 4 个 suite，仍失败 6 项，所以不是 headless 特有的问题。
- `check-personal`：562 项，557 通过 / 3 失败，都不在 browser：
  - `third-party/index.test.ts`：最后一个用例通过后进程不退出，被评审手动结束，和第 1 轮一样；
  - Computer Use 归档：STATUS 已列为 `main` 既有失败；
  - `check-providers`：评审没装 `packages/rotom-pi` 的依赖，属环境问题。
  - 注意：第一批失败后 check-personal 就退出了，后面的阶段没有跑到。browser 部分由上面的单测补跑。

### 必须改

- [必须改] **T20 子 lease 不区分 capability：父 agent 只拿到 `read`，子 agent 就能 `interact`。**
  - 来源：`parentGrantedOrigins` 在 `policyDenial` 的每个放行分支里都会加入 origin，不管这次授权的是哪个 capability（`index.ts` 约 650–676 行）。另外两条路径同理：一是 `总是允许 read`，二是经 `widenChildLeasesV1` 加进子 lease 的 origin。
  - 而 `checkBrowserLeaseV1` 对 `interact` 只检查 origin 在不在列表里（`browser-lease.ts:163`）。子 agent 侧的 `policyDenial` 现在只判 blocklist。
  - 评审复现（tool 层，mock relay）：
    1. 父 agent 对 claim 来的用户 tab `https://bank.test` 做 `snapshot`，被问 `允许 read https://bank.test？`，选“允许一次”；
    2. 发布的 `ROTOM_BROWSER_LEASE_SCOPE.origins` 变成 `["https://bank.test"]`；
    3. 带 lease token 的子 agent 执行 `browser_interact` click，**relay 收到 1 次 `interact` 派发**。
  - 这和第 1 轮第 1 项是同一类问题（子 agent 拿到的比用户批准的多），而且这里是用户自己的 tab。
  - 要求：
    - lease 的 origin 要带 capability，例如 `origins: [{ origin, capabilities }]`，或者分开的 `readOrigins`/`interactOrigins`；
    - `parentGrantedOrigins`、`widenChildLeasesV1` 与 `checkBrowserLeaseV1` 都按 capability 判定；
    - 旧格式的 lease 文件按“只读”解释，或者直接拒绝，不能按 interact 放行。
  - 补测试：用上面的三步，断言子 agent 的 click 返回 `needs-approval`（`capability: "interact"`），且 relay 没有收到 `interact`。再加一条：父 agent 给了 `interact` 后，子 agent 可以 click。
  - 另外请决定“允许一次”是否应该进入子 lease。现在它会让子 agent 在整个 run 里都拥有这个 origin，和“只这一次”的字面意思冲突。评审倾向：“允许一次”不进子 lease，只有“本会话允许”和“总是允许”才进。

- [必须改] **T18 派发与弹窗竞速：约 3 s 后把仍在执行的派发当成“已完成”返回。**
  - `service-worker.js:1518-1528`：弹窗检测分支轮询 120 × 25 ms，没有弹窗就返回 `{ settled: true }`，不等 `dispatchAction()` 结束。
  - 后果：
    - 慢于约 3 s 的动作返回 `acknowledged: true`，但 `effect` 只剩 `target`，动作自己的字段全部丢失；
    - 更严重的是，操作已经返回、tab 锁已经释放，派发却还在后台继续，下一个操作会和它交叠。这违反了 CLAUDE.md §6 对 `dispatchSettled` 如实上报的合同。
  - 评审在 Linux 上抓到的 pointer suite 拖拽结果（两项都是这样）：
    ```json
    {"kind":"rotom-browser-interaction-result","action":"drag","acknowledged":true,"effect":{"target":{"observed":true,"changed":false,"transitions":["focused=false→true"]}}}
    ```
    单独跑同一个拖拽时，effect 完整（`action: "drag"`、`moves: 5`、`dragDataSource: "none"`）。
  - 要求：
    - 弹窗检测只能提前返回 `dialogOpened`，不能代替派发完成；
    - 没有弹窗就等 `dispatchAction()` 自己结束，或者等到 relay deadline，按 unknown 报告；
    - 无论走哪条路径，在派发真正结束前都不能释放锁并返回 settled。
  - 补测试：这在 macOS 上也能复现，不依赖 Linux。用单测给 `dispatchAction` 注入一个 4 s 才结束的派发，断言结果不是“settled 且 effect 缺字段”，并且下一个同 tab 操作要等它结束。

- [必须改] **`screenshot` 没有 deadline，命令挂住会让整个 session 卡死。**
  - `service-worker.js:1919` 的 `Page.captureScreenshot` 直接 `await chrome.debugger.sendCommand`；而第 2138 行的 `screenshot_export` 套了 `valueWithinRelayDeadline`。
  - 评审复现（Linux）：open `/baseline` → type → click → 点视口外按钮（页面会滚动）→ `screenshot` 超时。之后用同一 sessionId 重连，**`hello` 也超时**：挂住的命令一直占着 tab 锁，结构性操作全部排在它后面，`recover`/`close` 也救不回来。
  - 触发条件（原始 CDP 探针）：
    - 没开过 focus emulation 的 hidden tab，滚动后截图正常；
    - 开过再关掉 `Emulation.setFocusEmulationEnabled`（每次交互都会这样做），再滚动，`fromSurface: true` 的截图就挂住；
    - 之后重新打开 focus emulation，下一次截图能回来，但再下一次又可能挂住。
  - 要求：
    - `screenshot` 和 `getLayoutMetrics` 都套 relay deadline；超时就报 timeout，并且释放锁；
    - 在 Linux 上找到一种稳定的截图方式，可以考虑：截图期间开 focus emulation，或者用 `fromSurface: false`。请在 STATUS 里写明选了哪种以及理由。
  - 补测试：在 macOS 上用故障注入（让 capture 永不 resolve），断言在 deadline 内返回 timeout，并且之后同 session 的 `tabs`/`close` 能正常完成。

- [必须改] **单个请求超时或 abort 会关掉整个 relay client，连带打断其他 tab 的在途请求。**
  - `browser-relay.ts:565-579`：timeout 和 abort 都调用 `#fail()`，它会 destroy socket，并 reject 所有 pending 请求。
  - 这段代码在分支之前就有。串行时没问题，但 M1 让 `browser_inspect` 变成 `parallel` 以后，一个 tab 的超时会让同一 session 里其他 tab 并发的读一起失败。这违反了 §6 “timeout 只对原标签 recover 一次”。
  - 产品层下次调用会重连（`index.ts:506`），所以影响的是**同时在飞的兄弟请求**；e2e 里“后面全部 client 已关闭”的级联只是 harness 共用一个 client 的副作用。
  - 要求：
    - timeout/abort 只 reject 本请求，并记住它的 id；之后迟到的同 id 响应直接丢弃；
    - 只有协议级错误（帧无效、摘要不匹配、缓冲超限、socket 断开）才 `#fail()` 整个连接。
  - 补测试：同一 client 上并发两个请求，让其中一个超时，断言另一个正常 resolve，且 client 不处于 closed。e2e 可以在 `same-agent-parallel` 里加一条：一个 tab 的慢操作超时，另一个 tab 的 snapshot 仍然成功。

### Linux 渲染：需要处理，但不阻塞

- [建议，倾向必须改] **Linux 上后台 tab 是 `hidden` 且不跑 rAF，导致 `read_full` 读不全。**
  - 探针结果：后台 tab 上 `document.visibilityState === "hidden"`，1 秒内 `requestAnimationFrame` 一次都不触发。harness 里那三个 `--disable-*backgrounding*` 参数不起作用，`Page.setWebLifecycleState active` 和 screencast 也不起作用。**只有 `Emulation.setFocusEmulationEnabled({ enabled: true })` 能让页面立刻变成 `visible`、rAF 恢复。**
  - `full-read.js:119` 的 `scrollTargetTo` 每一步都要等两次 rAF，所以在 hidden tab 上每步都等到命令超时。
  - 好消息是结果如实标成了未完成：`settle` 的两项失败都是 `contentComplete=false`，没有把漏读说成读完。T26 的 `FULL_READ_STATIC_STEPS` 回退也没有破坏这一点，因为 `unconfirmedRender` 是粘性的。
  - 但功能上，Linux 用户的 `read_full` 基本拿不到完整结果（`/large` 26 万字符、标未完成；`virtual-late` 漏 179 行）。这很可能也是 `chunked :: 另一个 tab 的读` 拿到空 nodes 的原因，请一并确认。
  - 建议：`read_full` 的滚动循环包在 `withFocusEmulation` 里，和交互路径一致。改完跑一次 `bench.mjs`，对照基线报告 `read_full` 的 P50/P95。
  - 请在 macOS 上补一条记录：后台 tab 的 `visibilityState` 和 rAF 情况。如果 macOS 上同样是 hidden，就要解释为什么 mac 上能读完。

### 文档订正

- [必须改，文档] **配额：CLAUDE.md §6 写“客户端在 `hello` 里声明的配额不被信任”，与代码不符。**
  - `service-worker.js:1721` 会采用客户端声明的配额，只要是 0–1000 范围内的整数。评审第 1 轮写“这点正确”是**评审自己看错了**，在此更正。
  - 执行方不改代码的理由成立：客户端都是本机同一用户的 Pi 进程，配额防的是失控，不是恶意；operator 覆盖也走这个字段，扩展进程区分不了来源。
  - 要求：把 CLAUDE.md §6 与 `docs/usage.md` 改成实际语义：SW 只做范围校验，越界的声明整体回落默认；它不防本机恶意客户端。另外，配额状态是按 session 存的，所以“全局 24 个 tab”实际由每个 session 自己声明的上限判定，这一点也要写明。

### 建议

- [建议] **并发询问合并后，“允许一次”会被两个调用共用。** 两个并发 `open` 共享一次“允许一次”，两次都会放行。这和“只这一次”的语义有偏差，但比弹两个对话框好。在 usage 里写一句即可。
- [建议] **`--no-verify` 绕过了 20 KB 单文件门禁。** 这需要维护者决定，不在本评审范围。请在 STATUS 的“阻塞与问题”里列出来，让用户看到；现在只写在平台证据那一节里。

### 已通过

- **第 1 轮第 1 项后半（blocklist）**：子 agent 现在先判 blocklist，策略不可读时拒绝。tab URL、claim 来的 tab、302 落点都不再进入子 lease。
- **第 1 轮第 2 项（`suggest`）**：所有不重定向的分支都调用无参 `suggest()`，并有一次性守卫。e2e `downloads` 在 Linux 上 3/3 通过。
- **第 1 轮第 3 项（T24）**：单测和 harness 在 Linux 上可跑。
  - socket 路径来自 `platform-paths.mjs`；
  - Chrome 拿到隔离 HOME，真实 HOME 未被改动；
  - fixture 改为 IPv4。
  - 剩下的 7 项 e2e 失败按上面几条处理。
- **第 1 轮第 4 项（审计）**：PASS。
- **T3 并发询问合并**：方向正确。
- **T26 性能改动（抽查）**：
  - `contentComplete` 去掉 `scanSteps < maxSteps` 是对的，`endReached` 已经能证明读到了结尾；
  - 静态回退不会把漏读报成完整；
  - 步长从 0.75 改为 0.9 的取舍已写明。
- **Linux 上全部通过的 suite**：isolation、same-agent-parallel、cleanup、focus、visibility、lease、quotas、parallel-4、navigate、console、network、keyboard、upload、dialog、batch、devtools（11/11）、policy、confirm、downloads。

### 下一步顺序

1. T20 lease 按 capability 判定；
2. T18 派发竞速；
3. screenshot deadline；
4. 单请求超时不关 client。

这 4 项都能在 macOS 上用单测或故障注入自证，不需要 Linux。然后做 `read_full` 的 focus emulation 和 bench 对照，最后订正文档。Linux 侧的 e2e 由评审下一轮复跑；请在 STATUS 里把 Linux 结论写成“评审环境 L2：112/119，待复跑”，不要写成 L1。

## 第 3 轮（8bdd7b4..06d16a0）

评审环境同第 2 轮：Linux x64（root、无 IPv6），Node 24.22.2，Chrome for Testing 153，分支原样、不打补丁。

**复现结果**
- browser 单测：310 项，309 通过，0 失败，1 skip。
- `python3 scripts/audit-public.py --root .`：PASS。
- e2e（Linux headless）：23 suite，**116 通过 / 5 失败**（第 2 轮 112/119）。剩下的 5 项**全部如实报超时**，没有一项是“没做完却报完成”，session 也不再卡死：
  - `baseline :: screenshot`：`Page.captureScreenshot timeout`，在 5 s 内返回；之后的 `close` 通过。
  - `settle` 两项：`contentComplete=false`；`virtual-late` 那项报 `read_full operation timeout`。
  - `pointer` 两项拖拽：`dispatch timeout … 结果 unknown`。

### 第 2 轮必须改项：全部通过

- [已通过] **T20 lease 按 capability 判定。** 评审用第 2 轮的复现重跑：
  - 父 agent 对 `bank.test` 选“允许一次 read”：不发布 lease，子 agent 点击得到 `needs-approval`，派发 0 次。
  - 改成“本会话允许 read”：lease 发布为 `{ origin: "https://bank.test", capabilities: ["read"] }`，子 agent 点击得到 `reason: "capability"`，派发 0 次。
  - 旧格式按只读处理；子 agent history 导航只带它自己经 `interact` 检查过的 origin。
- [已通过] **T18 派发竞速。** `raceDispatchAgainstDialog` 只有三种答案：弹窗、派发完成、超时。超时按 unknown 报告；操作结束时 guard 失效、超时会走 `resetAfterOperationTimeout`，后台残留的派发会在下一次 `assertOperation()` 停下。
- [已通过] **screenshot deadline。** 每条 CDP 命令各自有上限，在 Linux 上实测超时能释放锁。
- [已通过] **单请求超时不关 client。** timeout/abort 不再 `#fail()`；迟到的普通响应和分块响应都会被丢弃，不会误判为协议错误。
- [已通过] **文档订正。** CLAUDE.md §6 与 usage 的配额语义、lease capability、“允许一次”的范围都和代码一致；`--no-verify` 门禁问题已列入“阻塞与问题”。

### Linux 后台 tab 不出帧：评审定位到的根因（需要用户决定，不再算执行方的必须改项）

评审在 SW 里临时给 `chrome.debugger.sendCommand` 计时（未提交），只跑 pointer suite：拖拽时**每个按住鼠标的 `mouseMoved` 都正好要约 1016 ms**，这是 Chrome 等合成帧的输入确认超时。另外三个现象是同一个原因：

- `fromSurface` 截图挂住；
- `read_full` 等 rAF 超时；
- `virtual-late` 读不完。

页面在 focus emulation 下会报告 `visible`，但后台 tab 并不真正产出合成帧。

探针结论（原始 CDP）：
- 新开的后台 tab 上，按住鼠标的 `mouseMoved` 只要 3–17 ms，截图约 2.5 s。只有在 focus emulation 开关过几轮之后（每次交互都会开关一次），才进入“不出帧”的状态。第 2 轮的探针也显示，这种状态下重新打开 focus emulation 只能救回一次截图。
- `placement: "agent-window"` 更糟：截图超时，`mouseMoved` 每次 5 s。所以换 placement 不是解法。
- `Page.setWebLifecycleState` 和 screencast 都不起作用。

这已经是 Chrome 在 Linux 上合成后台 tab 的内部行为，现有 CDP 手段里没找到稳定的解法。安全合同是守住的：都报超时或 unknown，不谎报完成。请用户决定 Linux 的定位，二选一：
1. **记为已知限制**：Linux 上后台 tab 的截图、拖拽，以及懒加载长列表的 `read_full` 不保证能完成，结果会如实标为 timeout/unknown/未完成。把这一句写进 usage 和 CLAUDE.md §6，Linux 结论记为“评审环境 L2：116/121，5 项为已知限制”。
2. **继续攻关**：需要新的设计，例如在可控的条件下让 agent tab 短暂成为可见 tab，或者换一条不依赖合成帧的截图/输入路径。这会碰到“绝不抢用户前台”的规则，必须由用户先拍板。

评审建议选 1。

### 建议（不阻塞）

- [建议] **abort 只在客户端生效。** SW 里的操作会继续跑并占着 tab 锁，直到 SW 自己的 deadline。用户中途取消一个长 `read_full` 后，同一 tab 的下一次调用要排队等它结束。可以考虑给 relay 加一个 cancel 消息让 guard 立刻失效；不做的话就在 usage 里写明。
- [建议] **截图现在会让页面收到 `visibilitychange`/`focus` 事件。** 截图属于读操作，但开 focus emulation 是页面能察觉的。交互路径本来就这样，在 usage 里写一句即可。

### 结论

第 2 轮的必须改项全部通过，本轮没有新的必须改项。剩下的 Linux 渲染限制等用户在上面的 1/2 里选一个。

### 用户决定（2026-11-07）

用户选了**方案 1：记为已知限制**。执行方要做的：
- 在 `docs/usage.md` 和 CLAUDE.md §6 写明：Linux 上后台 tab 的截图、拖拽，以及懒加载长列表的 `read_full` 不保证能完成，结果会如实标为 timeout/unknown/未完成。不要为此让 agent tab 抢前台。
- STATUS 的 Linux 结论改为“评审环境 L2：116/121，5 项为已知限制”，并列出这 5 项。
- e2e 里这 5 项在 Linux 上改成断言“如实报超时/未完成”（例如按 `process.platform` 分支），macOS 仍保持原断言。不能 skip，也不能放宽 macOS 的断言。
- 顺手处理第 3 轮的两条建议，至少写进 usage：abort 只在客户端生效；截图会让页面收到 `visibilitychange`/`focus`。
- 做完按 CLAUDE.md 的公开同步流程合入 `main`（先跑 `audit-public.py`，只做 fast-forward 或普通 merge，不 force push）。
