# browser relay 端到端测试架子（L2）

隔离的真实 Chromium 测试架子，用来在**不碰用户 Chrome** 的前提下验证 browser relay。
这是维护面资源，不进发行包。

```bash
# 一次准备：下载 Chrome for Testing（正式版 Chrome 137+ 忽略 --load-extension）
node rotom/runtime/e2e-browser/fetch-chrome.mjs

# 跑全部 suite，或指定名字
node --experimental-strip-types rotom/runtime/e2e-browser/run.mjs
node --experimental-strip-types rotom/runtime/e2e-browser/run.mjs baseline
```

退出码非零表示有断言失败；每条断言单独输出，失败会打印保留下来的现场目录。

## 隔离契约

- 每个 suite 一个新的临时根目录（`/tmp/rotom-e2e-*`）：浏览器 profile、native host
  的 HOME、socket、锁和日志都在里面。
- 浏览器用独立 `--user-data-dir`，native host manifest 只写在该 profile 的
  `NativeMessagingHosts/` 下。
- native host wrapper 把 `HOME` 指向临时根目录，因此 relay socket、锁和
  `chrome.storage.session` 之外的状态都与操作者的 relay 目录无关。
- **Chrome 进程本身不重定向 HOME。** 实测 Chrome for Testing 156 在 macOS 上把 HOME
  指到新目录后不再提交页面导航（用不带扩展的裸 Chrome 也能复现），所以浏览器保留真实
  HOME，只隔离 relay 侧。run.mjs 每次跑完都比对真实 HOME 下 `rotom` 产品目录没有变化。

## 现有 suite

| suite | 覆盖 |
| - | - |
| `baseline` | open / snapshot / interact / screenshot / close 的既有行为 |
| `isolation` | 跨 agent 的 tab 隔离、`transfer` 与 opener 归属 |
| `same-agent-parallel` | 同一 agent 两个 tab 的并发与结构操作独占 |
| `cleanup` | 子 agent 断开后自己开的关掉、claim 的交还主 agent |
| `focus` | 并发 agent 都不把用户焦点留在自己的 tab 上；`agent-window` 放置 |
| `visibility` | 后台 tab 的 `visibilityState` 与隐藏状态下仍能真实交互 |
| `chunked` | 超过 256 KiB 的响应分块、摘要校验与丢失/乱序拒绝 |
| `lease` | 子 agent 的 lease：未授权 origin 本地拒绝，站点从未收到请求 |
| `quotas` | per-agent / per-origin / 全局 / agent 数四个上限，超限即时拒绝且 close 后释放 |
| `pointer` | hover 出菜单、dblclick 计数、右键菜单、指针拖拽与 HTML5 拖拽换序（页面自证顺序） |
| `upload` | 文件输入上传后 fixture 服务端收到的 sha256 与本地一致；非 file input、敏感路径、符号链接、相对路径、超大文件都在本地拒绝 |
| `batch` | 一次 batch 填完并提交表单（页面自证提交值）；expect 不满足、单步校验失败、弹窗阻塞都立即停下且后续步骤不执行 |
| `downloads` | agent tab 的下载落到 `rotom/<agentId>/` 且 sha256 与 fixture 字节一致、结果无绝对路径；claim 来的用户 tab 下载不改路径（站点收到两次请求但 agent 列表仍只有一条）；子 agent 未声明 `allow.download` 时下载被取消并报 blocked，声明后真的落地 |
| `devtools` | isolated world 读不到页面全局变量而 main world 读得到；抛错作为数据、超大结果截断；非法参数在 relay 侧被拒；viewport 覆盖后 `innerWidth` 跟着变、`reset` 回到原始宽度且触摸模拟关闭、旧 epoch 的坐标点击被拒；`screenshot_export` 的 PNG/JPEG magic、字节数与尺寸、超限页面被拒；`network_body` 启用前取不到、启用后取到 JSON 并截断、二进制被拒；`trace_start` 全局唯一、`trace_stop` 返回可解析事件流且能再次开始；`record_start` 全局唯一、headless 下如实报 `no frames`、`ROTOM_E2E_HEADED=1` 时真的采到多帧 PNG |
| `confirm` | 敏感名称按钮与 `cc-*` 表单里的 Continue 都返回 `needs-approval`（无 UI）且页面状态不变；普通按钮照常执行；`ROTOM_BROWSER_CONFIRM=auto-approve-localhost` 打开后同一点击真的执行；开关值拼错仍然要确认；upload 在确认前不把文件交出去 |
| `policy` | blocklist 本地拒绝且页面没收到请求；`read`/`interact` 授权不含 `upload`；授权后上传真的发生；302 到 blocklist origin 后读和写都被拒、目标页没有被点击；raw relay 在派发写操作前复核 origin（拒绝与放行各一次，页面自证点击结果） |
| `dialog` | alert、confirm 两种选择、prompt 带文字、beforeunload（导航被挂起→接受后才离开）；弹窗期间读/写都返回 `dialog-blocking`，页面自证返回值 |
| `keyboard` | 白名单按键与 `modifiers`；页面自证 textarea 内容与 listbox 选中项，非法键本地拒绝 |
| `network` | 请求元数据（failedOnly/pattern/resourceType）、无 header/body、cursor 续读，并用 fixture 服务端确认那两个头真的发出去过 |
| `console` | console/异常捕获与堆栈、pattern/level 过滤、缓冲满后 dropped、claimed tab 懒启用 |
| `navigate` | URL 导航与 history back/forward/reload，换 document generation、旧 ref stale、lease 限制历史落点 |
| `parallel-4` | 4 个 agent 同 root session 并行跑 5 轮表单，无串台、用户 tab 保持 active、归属正确，并打印延迟 p50/p95 |

`parallel-4` 声明了 `startUrlPage = "/user"`：runner 会先起 fixture 站点，再让 Chrome
用这个页面作为启动 tab，这样“用户 tab 是否仍是 active”才有可断言的对象。其他 suite
不声明时仍从 `about:blank` 启动。

`lease` 是唯一直接驱动工具层（而不是 `BrowserRelayClientV1`）的 suite：lease 判定在
`rotom/extensions/browser/index.ts` 里，所以它用 `browser-tools.mjs` 把真实
`browser_inspect`/`browser_interact` 接到 harness 的 socket 上，再断言 fixture 站点
的请求记录——被拒绝的 `open` 不能留下任何 HTTP 请求。

`focus`/`visibility` 只断言可观察的事实：relay 不暴露非自有标签与 `windowId`，
所以“用户标签是不是前台”“窗口有没有复用”在 e2e 里不可见，由 SW 单测覆盖。

## 环境变量

| 变量 | 作用 |
| - | - |
| `ROTOM_CHROME_EXECUTABLE` | 指定 Chromium / Chrome for Testing 可执行文件 |
| `ROTOM_E2E_CHROME_CACHE` | Chrome for Testing 缓存目录 |
| `ROTOM_E2E_HEADED=1` | 有头运行（默认 `--headless=new`） |
| `ROTOM_E2E_KEEP=1` | 成功时也保留临时目录 |
| `ROTOM_E2E_CHROME_LOG=1` | 打开 Chrome verbose 日志（`<root>/chrome.log`） |
| `ROTOM_E2E_DEBUG_PORT=<port>` | 打开 `--remote-debugging-port` 供排查 |
| `ROTOM_E2E_CHROME_ARGS="..."` | 追加 Chrome 参数（仅排查用） |

## 加 suite

在 `suites/<name>.mjs` 导出 `description` 和 `run({ harness, fixtures, recorder })`，
再在 `suites/index.mjs` 注册。断言用 `recorder.check(name, fn)` 或
`recorder.assert(name, condition, detail)`，这样失败会单独命名。
fixture 站点在 `fixtures/server.mjs`，用 `fixtures.page(path, title, body)` 加页面，
内置页面有 `/baseline`、`/frame`、`/popup`、`/large`、`/form`、`/checkout`（含 `cc-*` 字段的表单 + 敏感名称按钮，用来验证确认流程）、`/download-page`（带下载链接的页面，与 `/baseline` 分开以便 referrer 归属无歧义）、`/user`、`/console`、`/network`、`/keys`、`/pointer`、`/upload`、`/dialog`、`/redirect-out`（302 到另一个 fixture 站点的 `/redirect-target`，用来验证重定向不能绕过 origin 复核）。runner 在每个 suite 开始前把该 suite 的 fixture origin 写进自己的策略文件（`ROTOM_BROWSER_POLICY_FILE`），所以 e2e 不会读到操作者真实策略；`policy` suite 会自己改写这份文件。harness 还会在启动 Chrome 前把 `download.default_directory` 指到隔离目录，因为 Chrome 解析默认下载目录时不看 `HOME`，否则下载套件会写进操作者真实的 `~/Downloads`。runner 同时设置 `ROTOM_BROWSER_CONFIRM=auto-approve-localhost`，否则每个敏感点击都会停在确认上；`confirm` suite 会自己关掉这个开关来观察拒绝路径。`/upload` 页面的文件输入在 `change` 后立刻把文件 POST 回 `/upload-echo`，fixture 只记录 sha256 与大小，便于断言“服务端真的收到了这些字节”。`/dialog` 页面的每个按钮打开一种弹窗，并把 `alert`/`confirm`/`prompt` 的返回值写进状态行，所以“弹窗真的被处理”由页面自证，而不是只看命令 ack。
需要真实“用户 tab”的 suite 导出 `startUrlPage`（`run.mjs` 会把它交给 Chrome 当启动 URL）。
