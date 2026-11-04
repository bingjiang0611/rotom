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
内置页面有 `/baseline`、`/frame`、`/popup`、`/large`、`/form`、`/user`、`/console`。
需要真实“用户 tab”的 suite 导出 `startUrlPage`（`run.mjs` 会把它交给 Chrome 当启动 URL）。
