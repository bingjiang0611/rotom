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
