# rotom browser 能力补齐与多 agent 并行技术方案

as of 2026-11-03。评审过的在线版本：<https://claude.ai/artifact/9tJpd2FnUjAPtUQqJbcVvH>。这份是给执行 agent 用的仓库内副本，以本文件为准。

## 1. 目标与范围

- 补齐和 Claude Code、Codex 相比缺的能力：开发调试（console、network、JS、trace）、交互动作、弹窗、上传下载、按站点授权、跨平台。
- 支持多个 agent（主 agent 加 subagents）在同一个 Chrome 里，**后台、并行**地操作各自的标签页，互不干扰，也不打断用户正在用的窗口。
- **不动的原则**：现有的强项都保留，包括未知写入不重放、坐标点击 hit-test、expect 校验、审计日志、后台不抢焦点、有界输出、页面内容视为不可信。新能力也按同样的标准接入。
- **不在范围内**：Computer Use、Firefox 和 Safari、无头 CI 模式、多 Chrome profile。

## 2. 现状

链路是：Pi 进程里的 browser 扩展（`rotom/extensions/browser/index.ts`）→ Unix socket → native host（`native-host.mjs`，由 Chrome 拉起）→ native messaging → 扩展 service worker（`chrome-extension/service-worker.js`）→ `chrome.debugger`（CDP 1.3）→ 标签页。

| 位置 | 现状 | 对并行的影响 |
| - | - | - |
| native host | 已支持多个 socket 客户端，按 `sessionId + generation + id` 路由，客户端断开时发 `client-disconnected` | 多进程并发已经可用；单帧上限 1 MiB |
| service worker | `sessionStates` 按 sessionId 分开，每个 session 一条 `operationChain` | 不同 agent 之间已经并行；同一 agent 的多个 tab 之间仍是串行 |
| Pi 工具 | `browser_inspect` 和 `browser_interact` 都是 `executionMode: "sequential"` | 单个 agent 内部没有并行 |
| tab 分组 | 所有 agent 的 tab 都放进同一个叫 "Pi" 的分组 | 分不清哪个 tab 属于哪个 agent |
| 持久化 | 每次 tab 更新都把全部 session 写入 `chrome.storage.session` | 写放大 |
| 后台交互 | `Emulation.setFocusEmulationEnabled` 加 `withBackgroundActivationGuard` | 多个 agent 同时恢复焦点时，可能恢复到错误的位置 |
| subagents | 独立的 pi 子进程，有自己的 sessionId；**拿不到 browser 扩展**（第 8 节） | 子 agent 目前根本不能用浏览器 |
| 平台 | socket 路径和安装器都写死 macOS；native host 的锁已兼容 Linux | Linux 和 Windows 不可用 |

## 3. 多 agent 后台并行

### 3.1 身份

- **browser principal**：`{ rootSessionId, agentId, sessionId, generation }`。主 agent 的 `agentId` 是 `main`，子 agent 用 subagent 的 run id。
- 子进程通过环境变量拿到 `ROTOM_BROWSER_ROOT_SESSION`、`ROTOM_BROWSER_AGENT_ID` 和 lease token，在 `hello` 时上报。
- 一个 tab 只属于一个 session。`discover` 不列出其他 agent 的 tab，`claim` 拒绝已被占用的 tab。新增 `transfer`，在同一个 root 下移交 tab，移交时所有旧 ref 失效。

### 3.2 并发

- agent 之间：维持现状，天然并行。
- 同一 agent 内部：拆成 session 锁（改动 tab 集合的操作）和 tab 锁（其余操作）。只读的 inspect 操作改成 parallel 执行模式；interact 保持 sequential。
- 收缩全局串行点：持久化按 session 拆 key 并合并写；大响应分块传输。

### 3.3 后台执行与焦点

- 防丢弃：`autoDiscardable: false`。防冻结：`Page.setWebLifecycleState("active")`。
- 后台节流没法完全避免（扩展不能给 Chrome 加启动参数）。默认用 `background-tab`，可选 `agent-window`（不聚焦的独立窗口，让页面处于 visible 状态）。结果里如实返回 `visibilityState`。
- 全局焦点协调器只记录**用户**的焦点，所有 agent 都恢复到这个值。

### 3.4 分组与清理

- 每个 agent 一个分组：`rotom` 或 `rotom · <agent>`，颜色按 agentId 轮换。
- 子 agent 结束时：关闭它自己 open 的 tab；claim 或 transfer 来的 tab 归还给主 agent。lease 里 `keepTabs: true` 时保留。

### 3.5 子 agent 接入与授权

- 参照 Qoder 的做法，由 launcher 在资源校验通过后下发 browser 扩展路径；子 agent 请求了 browser 工具时自动加载。
- lease 写明子 agent 能访问的 origin，以及是否允许 devtools、上传、下载，还有 tab 上限和过期时间。
- 子 agent 没有 UI：遇到未授权的情况返回 `needs-approval`，由父 agent 向用户确认后更新 lease。**子 agent 绝不自动放行。**

### 3.6 配额

默认：8 个 agent，每个 agent 4 个 tab，全局 24 个 tab，同一 origin 2 个 tab，都可以用环境变量覆盖。超限时直接报错，不排队。配额的作用是防止失控：agent 出 bug 不停开 tab、单线程 SW 被拖慢、缓冲区占用内存过多、同站并发过高被限流。

## 4. 能力补齐

| 工具 | 加载方式 | 内容 |
| - | - | - |
| `browser_inspect` | 默认 | 现有操作，加 navigate、console、network、downloads |
| `browser_interact` | 默认 | 现有动作，加完整按键、hover、dblclick、right_click、drag、upload、dialog，以及批量 `actions[]` |
| `browser_devtools`（新） | deferred，按需加载 | evaluate、viewport、screenshot_export、network_body、trace、record |

每个能力的具体做法、参数和上限见 [tasks.md](tasks.md)。原则：

- console 和 network 只保存元数据，用环形缓冲区，并标出 `captureSince` 和 `dropped`；不返回 Cookie 和 Authorization。
- 新的写类动作沿用 hit-test、audit、unknown 不重放。
- 上传只接受白名单之外的普通文件：拒绝凭据路径和硬链接，总大小 10 MB 以内。
- 弹窗出现时其他操作直接拒绝，由模型显式处理。
- 按站点授权的检查放在 Pi 侧，SW 侧在导航后再核对一次，防止重定向绕过。
- 敏感动作由工具层强制确认，不只是写在 prompt 里。

## 5. 分期

| 阶段 | 内容 |
| - | - |
| T0 | 隔离的真实 Chromium 端到端测试架子 |
| M1 并行底座 | T1 到 T11 |
| M2 调试 P0 | T12 到 T14 |
| M3 交互与安全 | T15 到 T21 |
| M4 devtools 与平台 | T22 到 T25 |

## 6. 测试

- L1：现有 fake chrome 单测方式，每个任务都补上反例。
- L2：T0 的隔离 Chromium e2e，不碰用户的 Chrome。
- 用户真实 Chrome 的 L3 不在执行 agent 的范围内，由评审方在里程碑验收时向用户申请。

## 7. 兼容与风险

- 协议每个里程碑升一版。旧扩展只能用旧能力，新操作在本地拒绝，并提示刷新扩展。新增 `downloads` 权限会让 Chrome 弹一次权限确认。
- 持久化从 V2 迁移到 V3。
- 反自动化检测：claim 来的用户 tab 延迟启用 Runtime 和 Network；同一 origin 有并发上限。
- 单个 SW 线程是性能上限，M1 要实测延迟。

## 8. 已确认的决定

| 问题 | 决定 |
| - | - |
| 子 agent 结束时怎么处理 tab | 关闭它自己 open 的 tab；claim 或 transfer 来的 tab 归还给主 agent |
| 是否支持多个 Chrome profile | 不支持 |
| 扩展是否上 Chrome 商店 | 要上，放在 M4；执行 agent 只做准备，不提交 |
| 默认配额 | 保留，可以用环境变量配置；M1 实测后再调整 |
| 子 agent 能否拿到 browser 工具 | 目前拿不到，M1 的 T8 补上 |

子 agent 的核实过程（读代码得出，没有实际运行）：

- 产品扩展只通过 `rotom/runtime/launch-runtime.mjs` 的 `productRuntimeArgs` 以 `--extension` 传给主 agent。
- 子 agent 由 `packages/rotom-subagents/src/runs/shared/pi-args.ts` 拼参数，只带 prompt runtime、Qoder、fanout、permission-system，以及 agent 定义里写明的扩展路径。
- 没有 `--no-extensions` 时，Pi 的 ambient 发现只看用户目录和项目目录，不包括产品目录下的 `extensions/browser`。
