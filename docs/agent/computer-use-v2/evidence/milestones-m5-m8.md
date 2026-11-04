# 里程碑详细记录（M5–M8）

从 `STATUS.md` 迁出，保留原始记录以免丢证据；STATUS 只保留摘要、当前轮次与未完成项。

### M8 文档、版本与打包（部分完成）

- 已完成：
  - 根 `CLAUDE.md` 第 4 节更新为“同意层而非隔离层”，写明协议 8、L2 白名单与 `ROTOM_CU_L2=0`、只有编译级证据；第 5 节记录了 trace 唯一例外。
  - `docs/agent/change-checklists.md` 的 Browser / Computer Use 小节新增 8 条 v2 审查项（Broker 仲裁、分级/审批路由、宿主排除、停止语义、投递级别、trace 边界）。
  - 新增 `docs/agent/computer-use-trace.md`（trace 合同、路径、权限、关闭方式、导出、未验证项）。
  - `rotom/extensions/third-party/computer-use/regression.md` 增加 v2 段落，指向本 STATUS，说明新工具默认 deferred。
  - `docs/agent/computer-use-v2/evidence/` 的 live-check / compat-matrix 记录“未运行”与运行命令。
- 未做，以及为什么：
  1. **组件版本与 vendored tgz 未改**。HANDOFF 要求升到 `0.5.1-rotom.3` 并重建 `rotom/extensions/third-party/vendor/injaneity-pi-computer-use-0.5.1-rotom.2.tgz`、同步 third-party lock 与产品 integrity pin。这台机器能编译 helper，但**不能运行**本地编译产物（`Killed: 9`），`rotom/` 也没有安装 node_modules，因此 `test:distribution`、`verify-pi-runtime` 都无法执行。只改版本号会让 `packages/rotom-computer-use/package.json` 与 vendored tgz 不一致；只重建 tgz 而不跑上述验证，等于把未验证二进制连同新的 integrity pin 留给产品。两者都会削弱“可证明”的要求，所以停在重建之前，保持 `0.5.1-rotom.2` 一致。
  2. 因此 `pack:release` 不能在本次产出可发布 tgz；本分支的产物只是源码改动。
- 恢复这一步的确切命令（在能运行 helper 的机器上，按 UPSTREAM.md）：
  ```sh
  cd packages/rotom-computer-use
  tar xzf ../../rotom/extensions/third-party/vendor/injaneity-pi-computer-use-0.5.1-rotom.2.tgz --strip-components=1 package/prebuilt/windows package/prebuilt/linux
  node scripts/build-native.mjs --arch all --sign-identity -
  npm pack --ignore-scripts
  # 然后更新 vendored tgz、third-party lock 与 product integrity pin，并跑 test:distribution
  ```

### M7 真机验收与兼容矩阵（live check 已跑通；矩阵未跑完）

- 实现摘要：
  - `native/macos-fixture/FixtureApp.swift`：SwiftUI fixture App，含文本框、复选框、滑块、DisclosureGroup 树、列表、TabView、右键菜单，每个控件带 accessibilityIdentifier。**已编译通过**：`xcrun swiftc -O -parse-as-library native/macos-fixture/FixtureApp.swift -o /tmp/cu-fixture`（153 KB）。
  - `scripts/check-cu-v2-live.mjs`：`PI_CU_LIVE=1` 才运行；检查协议 8、Accessibility、用户活动 tap、fixture 后台启动、observe 能定位六类控件、七个语义动作逐个 `worked`、前台 App 与光标坐标不变、没有 `interferedWithUser`。结果写 `docs/agent/computer-use-v2/evidence/live-check.md` 与带时间戳的日志。
  - `scripts/cu-v2-compat-matrix.mjs`：按 App × 动作 × 投递策略（`ax_only`/`background`/`foreground`）生成矩阵，单元格只有 `pass`/`fail`/`unknown`/`refused`/`skip`/`not-run`，只写实际观测；`l2-compat.ts` 只允许在整行 `pass` 之后扩展。
  - `evidence/compat-matrix.md` 与 `evidence/live-check.md` 记录“未运行”的现状与运行命令，不填造假数据。
- 自证命令与结果：`node scripts/check-cu-v2-live.mjs` → 正确输出 `skipped: PI_CU_LIVE is not 1` 并退出 0；`node scripts/cu-v2-compat-matrix.mjs` → 正确输出 `not run` 并退出 0；fixture 编译成功。
- 2026-11-04 真机补跑（自签 helper 副本 + fixture）：`PI_CU_LIVE=1 node scripts/check-cu-v2-live.mjs --fixture ~/cu-v2-test/Fixture.app` → **34 行 / 0 失败**（含 `--with-hid` 变体，见 `evidence/live-check.md`）。覆盖 observe+截图、8 个语义动作、窗口 move/resize/list_displays、剪贴板 set/get/clear、4 个系统表面、后台不变量（前台 App 与光标不变）、agent 事件标记（HID 点击后 `agentEventCount 2 → 4`、`userEventCount` 不变）。
- 未验证项：兼容矩阵单元格（fixture 反复启停后不再暴露窗口、TextEdit 启动后被系统退出，本轮没拿到有效单元格；`evidence/compat-matrix.md` 仍是 `not-run`）；`foreground` 投递策略整列未跑（会抬窗口、移动真实光标，用户正在使用该机器）；L2 白名单是否需扩充；第 10 节“用户模拟器并行打字”的验收。
- 与 PLAN 的偏差及原因：用户模拟器（每分钟 300 字符 + 随机移动鼠标）没有单独实现成脚本，改为在 live check 里用 `--with-user-simulator` 显式标注“需人工并行运行”，因为我不能在未授权环境里验证它会真的输入到前台 App；宁可留人工步骤，也不写一个自己都没跑过的“自动模拟用户”脚本冒充验收。

### M6 工具面

- 实现摘要：
  - `act_ui` 新增 `hover`/`select`/`setChecked`/`expand`/`collapse`/`scrollTo`/`focus`/`clear`/`setValue`/`showMenu`；`contract.ts` 增加 `UiActionName`/`SEMANTIC_ACTION_NAMES`/`option`/`checked`/`value`；`prepareAction` 为语义动作强制要求可访问性 ref（坐标或 pictureOnly 节点直接拒绝），并校验 `setChecked.checked`/`setValue.value`。
  - 新增 deferred 工具 `manage_app`、`manage_window`、`clipboard`、`system_surface`、`cu_session`：`extensions/computer-use.ts` 给 schema，`src/bridge.ts` 给执行器（平台缺能力时返回结构化 `unsupported`，不做假成功）。
  - `clipboard set` 默认 30 秒把用户原剪贴板写回（`scheduleClipboardRestore` + 新配置 `clipboard_restore`，`ROTOM_CU_CLIPBOARD_RESTORE=0` 可关）；剪贴板文本不进 trace 正文。
  - 结果字段：`execution.deliveryLevel`（ax→L1，pid/l2→L2，hid→L4）、`interferedWithUser`、`stoppedByUser`；`leaseHolder`/`retry` 已在 M2 落地。`preempted_by_user` **未实现**（见“需要审核者回答的问题”）。
  - `rotom/extensions/third-party/deferred-tools/register.ts` 新增能力组 `computer_use_admin`（含中英文别名），五个新工具因此默认不常驻、可用 `search_tools` 加载；常驻清单 `RESIDENT_BROWSER_TOOL_NAMES` 不变。
- 新增或修改的测试：`test/cu-v2-tools.test.ts`（5 例：语义动作必须有 wire ref、参数校验、剪贴板恢复定时器、无需恢复的两个分支、deferred 组声明与常驻清单不包含新工具）。会因旧行为失败的反例：`setChecked` 用坐标默默点一下（旧 `prepareAction` 只有 8 个动作）；`option`/`checked`/`value` 缺失时静默取默认值；剪贴板写完不恢复；把 `manage_app` 放进常驻清单。
- 自证命令与结果：`npm test` → 62 pass / 0 fail；`node --experimental-strip-types -e "await import('./src/bridge.ts')"` 与 extension 加载成功（16 个 execute* 导出）。
- 未验证项：①五个新工具在真实 Pi 会话里的 schema 渲染与 `search_tools` 加载路径——`rotom/` 目录没有安装 node_modules，`register.test.ts`/`index.test.ts` 因缺 `typebox` 无法运行（既有环境限制，不是我引入的失败）；②`manage_window`/`system_surface` 的真实返回（依赖 M5 未运行的原生能力）；③`scripts/check-tool-schemas.mjs` 在本仓库不存在（既有失败），无法按 HANDOFF 更新。
- 与 PLAN 的偏差及原因：`cu_session` 的 `stop` 语义是“停掉除自己以外的 agent”，与 Broker 的 `stop` 定义一致；`preempted_by_user` 需要 L4 接管租约，第一期未做。

### M5 macOS 原生（协议 8）

- 实现摘要：`native/macos/bridge.swift` 协议 7 → 8。
  - **用户活动**：`UserActivityMonitor` 常驻 listen-only `CGEventTap`（`cgSessionEventTap`/`tailAppendEventTap`），统计不带 agent 标记的真实输入，`userActivity` 命令返回 `lastUserInputAt/idleSeconds/listening/userEventCount/agentEventCount`；helper 每 2 秒用 `ping.lastUserInputAt` 把时间推给 Broker（复用 M1 已有字段，没有新增协议通道）。
  - **agent 标记**：所有合成事件写 `eventSourceUserData = 0x524F544F`，用户活动 tap 据此区分 agent 事件。
  - **干扰检测**：动作结束时若前台 pid 变化且 2 秒内有真实用户输入，`performed.interferedWithUser = true`。
  - **L2 定向投递**：`SkyLight` 的 `SLEventPostToPid` 运行时 `dlopen`/`dlsym` 解析，缺失即抛 `foreground_required`（不回退 HID）；新增 `src/policy/l2-compat.ts` 白名单（仅 IntelliJ 两个 bundle id）+ `ROTOM_CU_L2=0` 强制回到 pid 投递；`nativeInputDelivery()` 在后台策略下按白名单选择 `l2`/`pid`。
  - **语义动作**：`act` 新增 `select`（含 popup/combo 的 `option` 菜单项）、`setChecked`、`expand`/`collapse`、`scrollTo`、`focus`、`clear`、`setValue`、`showMenu`、`hover`（无定向通道时 `foreground_required`）；每个分支写完都回读校验，角色不支持时返回 `unsupported_action` 而不是退化成坐标点击。
  - **新命令**：`clipboardGet/Set/Clear`、`manageApps`（list/launch 不激活/quit 礼貌退出 + 是否仍在运行）、`manageWindow`（list/move/resize/minimize/restore/maximize/list_displays，全部不 raise）、`systemSurfaces`（通知中心/菜单栏 extras/ControlCenter/Dock 的 AX 根）。
  - **用户停止**：菜单栏状态项列出 Broker 里每个 agent 及其占用 App，可单独停或全部停；`Ctrl+Option+Cmd+.` 全局快捷键用 headInsert 主动 tap **只吞这一个组合键**，其余按键原样放行，仅在已获得 Accessibility 时安装，tap 被系统禁用会自动重开。helper 通过 `BrokerLink`（Unix socket + `hello`/`status`/`stop`/`ping`）直接找 Broker 要状态。
- 新增或修改的测试：`test/l2-compat.test.ts`（3 例，白名单/理由/`ROTOM_CU_L2=0`）；`test/helper-protocol.test.ts` 改为按导出的 `HELPER_PROTOCOL_VERSION` 断言（协议 7 现在正确判为不匹配）。会因旧行为失败的反例：非白名单 App 拿到 `l2`；`ROTOM_CU_L2=0` 仍走定向投递；协议 7 的 helper 被当成匹配。
- 自证命令与结果：`node scripts/build-native.mjs --arch arm64 --output /tmp/cu-bridge-m5` → 成功（698 KB arm64，5 次迭代修正编译错误）；`npm test` → 57 pass / 0 fail。
- 未验证项（本机不能运行任何本地编译产物，`Killed: 9`，见环境记录）：
  1. 全部原生行为只到**编译通过**：协议 8 握手、listen-only 活动 tap、`SLEventPostToPid` 是否存在/是否真的不移动光标、L2 点击能否被 IntelliJ 接受、语义动作的实际回读、剪贴板 30 秒恢复、窗口 move/resize/maximize、系统表面 AX 根、菜单栏项与快捷键。
  2. 活动 tap 与主动 tap 的 CPU 开销、tap 被系统禁用的频率未测。
  3. `SLEventPostToPid` 是私有符号，签名按社区惯例写为 `(pid_t, CGEventRef)`；若签名不符会崩溃而不是报错。
  4. 剪贴板 `set` 后 30 秒恢复用户原剪贴板**尚未实现**（只在 helper 侧有 get/set/clear），需要 M6 工具面配合实现，见“需要审核者回答的问题”。
- 顺带修正：`connectWithRetry` 的等待预算从 5 秒提到 15 秒。全量测试并行启动多个 broker 时，5 秒会被慢机超出，导致 `broker-socket`/`broker-scheduler` 间歇失败（同一用例单独跑 6 次全过，全量跑 3 次里有 2 次失败）。提高到 15 秒后连续 3 次全量 57/57。这是测试/启动健壮性修正，不改变仲裁语义。
- 与 PLAN 的偏差及原因：①`hover` 与 `L2` 失败一律 `foreground_required`，不静默降级；②L2 白名单在 TS 侧，helper 不判断 App 名；③停止快捷键只在 Accessibility 已授权时安装（主动 tap 会进入每个按键的处理路径，未授权时宁可没有快捷键）。
