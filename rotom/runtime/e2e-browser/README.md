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
fixture 站点在 `fixtures/server.mjs`，用 `fixtures.page(path, title, body)` 加页面。
