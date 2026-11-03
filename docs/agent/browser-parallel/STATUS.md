# 执行进度

由执行 agent 维护，每完成一个任务更新一次。评审 agent 从这里开始核验。

## 里程碑

| 里程碑 | 状态 | 最后 commit | 备注 |
| - | - | - | - |
| T0 测试架子 | ready-for-review | `browser(T0)` | 隔离 Chromium e2e 架子 + `baseline` suite；macOS 实测 |
| M1 并行底座 | not-started | | |
| M2 调试 P0 | not-started | | |
| M3 交互与安全 | not-started | | |
| M4 devtools 与平台 | not-started | | |

状态取值：`not-started`、`in-progress`、`ready-for-review`、`changes-requested`、`accepted`。
“最后 commit”用 commit message 里的任务标记引用，hash 见 `git log`。

## 任务

| 任务 | 状态 | commit | 验证命令与结果摘要 | 未验证项 |
| - | - | - | - | - |
| T0 | done | `browser(T0)` | `node --experimental-strip-types rotom/runtime/e2e-browser/run.mjs baseline` 连续 3 次 `7 passed, 0 failed`；每次跑完 `pgrep -f "Chrome for Testing"` 为 0。L1：`node --test rotom/extensions/browser/{chrome-extension,ownership,native-host,component-storage}.test.mjs` 62/62 通过；`./rotom/bin/check-personal` EXIT=0（393 + 99 条测试全通过，`deterministicGate: PASS`）。 | 验收要求“Linux 无头环境”，本机是 macOS arm64，Linux 未跑；Windows 不在范围 |

## 自行决定

<!-- 设计里没写到、由执行 agent 自己拍板的细节。每条写：任务、决定、理由、怎么回滚。 -->

- **T0 / Chrome 进程不重定向 HOME。** tasks.md 要求“建临时 HOME”。实测 Chrome for Testing 156（macOS arm64）把 `HOME` 指到新目录后**不再提交任何页面导航**：`chrome.tabs` 长期停在 `loading`、`url` 为空、fixture 服务器零请求。用**不带扩展的裸 Chrome** 也能复现（`Target.createTarget` 后请求不出网），`--no-sandbox`、`--single-process`、`--enable-features=NetworkServiceInProcess`、`CFFIXED_USER_HOME`、预建 `Library/Caches` 等子目录都无效，所以这不是产品或扩展的缺陷，也不能在架子一侧绕过。
  - 现在的做法：Chrome 保留真实 `HOME`，但用独立 `--user-data-dir`；native host manifest 只写在 profile 的 `NativeMessagingHosts/`（实测 Chrome 会读这里，2.5 秒内建立 relay）；wrapper 再把 native host 的 `HOME` 指向临时目录，于是 relay socket、锁、`chrome.storage.session` 之外的 relay 状态都在临时根目录。
  - 隔离证据：`run.mjs` 每个 suite 结束都对比真实 HOME 下 `Library/Application Support/rotom` 与 `.config/rotom` 的完整清单（路径 + 大小 + mtime），断言未变化。
  - 回滚：删掉 `nativeHostManifestDirs` 的多路径版本、恢复 Chrome 的 `env.HOME` 即可；代价是 e2e 无法跑通，所以不推荐。
- **T0 / 临时根目录固定在 `/tmp`。** socket 路径要放 `home/Library/Application Support/rotom/browser-relay/relay.sock`，macOS `sun_path` 只有 104 字节，`$TMPDIR`（`/var/folders/...`）加上这段会超限（第一次跑就是这样 listen 失败）。现在固定用 `/tmp`（不存在时回退 `os.tmpdir()`），并在超过 100 字节时直接报错说明是 sun_path 上限。T24 改路径模块后这里跟着换。
- **T0 / Chrome for Testing 由脚本下载，不进仓库。** 新增 `fetch-chrome.mjs`，默认落到 `~/Library/Caches/rotom-e2e`（Linux 用 `$XDG_CACHE_HOME/rotom-e2e`），也接受 `ROTOM_CHROME_EXECUTABLE`/`ROTOM_E2E_CHROME_CACHE`。正式版 Chrome 137+ 忽略 `--load-extension`，所以不回退到它。
- **T0 / `baseline` suite 复刻的是既有行为的关键子集，不是 smoke 脚本的全部断言。** 覆盖 open/wait/tabs 隔离、snapshot（含 document-text 与 OOPIF frame）、type/select/click 回读、视口外与遮挡层命中、脚本弹窗保持后台、screenshot、close。`smoke-browser-relay.mjs` 里更细的老断言（嵌套滚动、frame 滚动、密码框）留在原脚本，没有在新架子上重复；现有 L1 用例仍然覆盖这些路径。回滚：删掉 `suites/baseline.mjs`。
- **T0 / fixture 的 iframe 用 `localhost`，主站用 `127.0.0.1`。** 端口不同不等于跨站点，`127.0.0.1:portA` 与 `127.0.0.1:portB` 仍是同站，iframe 不会变成 OOPIF，`Target.setAutoAttach` 也拿不到子 session。换成两个 site name 后 `Cross-origin frame ready` 才能被 snapshot 读到，和原 smoke 脚本的做法一致。
- **T0 / 默认无头（`--headless=new`）并关掉后台节流。** `ROTOM_E2E_HEADED=1` 可切有头。加 `--disable-background-timer-throttling`、`--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding`，避免把 Chrome 的后台节流误判成 relay 行为（T6 要单独验证可见性，用 `visibilityState` 而不是超时）。
- **T0 / 失败保留现场，成功清理。** 失败时打印 `<root>` 路径并保留（`ROTOM_E2E_KEEP=1` 成功时也保留）；清理时会按 `--user-data-dir=<profile>` 精确清扫残留 Chrome（`spawn` 出来的进程组 kill 之后仍会有 helper 逃逸），不会全局 pkill。实测清理后 `pgrep` 为 0。
- **环境准备（不是代码改动）**：本 worktree 是干净 clone，跑 `check-personal` 前需要按 `docs/agent/architecture.md` 安装 `rotom/runtime/pi`、`rotom/extensions/third-party`，并按 `docs/agent/verification.md` 在 `packages/rotom-pi` 执行 `npm ci --ignore-scripts --no-audit --no-fund`。三者都在 `.gitignore` 的 `node_modules/` 下，没有进入提交。

## 阻塞与问题

<!-- 只写真正需要用户或评审方决定的事。写清楚已经尝试过什么、卡在哪、建议怎么做。 -->

暂无。

## 既有失败

<!-- 不是本次改动造成的失败：测试名、原因、证据。 -->

- README 提到的两条 Linux 环境失败（`chrome-extension.test.mjs` 的 installer 测试与 native host multiplex 测试依赖 macOS 路径）在 macOS 上通过（62/62），Linux 上是否仍失败本轮未验证，留给 T24。
