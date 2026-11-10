# Computer Use v2.1 第 15 轮审核：并排安装方案与打包缺口（基于 `c5376b7`）

## 结论

- 执行方的并排安装方案批准，作为**开发态测试布局**使用：独立 checkout、独立 helper（新 bundle id、独立 socket、独立 broker socket）、
  独立 HOME 和配置，不碰现有安装和正在运行的 helper。
- 方案揭示了一个更大的问题（P1）：**v2 和 v2.1 的 Computer Use 代码从来没有进过产品实际加载的归档**，包括已经合入 `main` 的 v2。
  打包是合入 `main` 前必须补的一步。

## 审核者对方案的核对

| 方案里的说法 | 核对结果 |
| --- | --- |
| 只跑 `npm ci` 会装到旧扩展 | 属实。产品从 `rotom/extensions/third-party/vendor/injaneity-pi-computer-use-0.5.1-rotom.2.tgz` 安装，该归档最后一次更新在 `7e7ba06`（2026-10-25），早于 v2。`main` 上的归档与 v2.1 完全相同。 |
| 用 `ditto` 把源码包替换进新 checkout 的 `node_modules` | 可行。源码包只有 peer 依赖、没有运行时依赖；`product-config.mjs` 要求的入口 `extensions/computer-use.ts` 存在；启动期只校验元数据和 installed identity（名称、版本不变），不校验解压后的文件内容。 |
| 新 bundle id 只隔离权限记录 | 属实。`HELPER_BUNDLE_ID` 只被导出，没有别处使用；helper 排除自己的窗口按进程号（`getpid()`），不按 bundle id。 |
| 用 `open --env` 传 `ROTOM_CU_BROKER_SOCKET` | 必要。helper 总会去连这个变量指的 broker，不设就连正式版的默认 socket；而正式 broker 已有 helper，第二个会被拒绝。 |
| 先启动 helper、后启动测试版 rotom | 可行。`BrokerLink` 每次请求时按需重连，helper 每 2 秒上报活动，测试 broker 起来后会自动连上。 |
| Node ≥ 24 | 属实，`rotom-launcher` 要求 `>=24.0.0`。（审核者此前在 mac2 清单里写过 Node 22+，是错的。） |
| `build-native.mjs --sign-identity / --sign-identifier`、`ROTOM_CU_POLICY`、`ROTOM_CU_TRACE`、`PI_CU_SOCKET_PATH`、`PI_COMPUTER_USE_HELPER_APP_PATH` | 都在源码里存在。 |

补充两点，不阻断：

- 测试版用独立 HOME，测试会话里没有用户的 `~/.gitconfig`、ssh key 和 npm 配置。测 Computer Use 不受影响，但别在测试会话里做需要这些身份的事。
- 端点安全的停止条件写得完整：被拦或原因不明地退出就停，保留日志交 IT，不关安全软件、不加排除项、不改路径、bundle id、证书或签名标志去绕过。

## P1（高，合入 `main` 前必须完成）：打包

第一期 `HANDOFF.md` 第 147 行要求“按 `UPSTREAM.md` 的 Rebuilding the archive 重建 vendored tgz，同步 third-party lock 和产品 integrity pin，
这一步需要 macOS 构建 helper”。这一步在 v2 合入 `main` 时没有做，v2.1 也没有做。所以用户现在日常用的 rotom 跑的仍是 10-25 的 Computer Use，
v2 和 v2.1 的改动都只存在于源码里。

要做的：

1. 在 Mac 上按 `packages/rotom-computer-use/UPSTREAM.md` 重建归档（恢复未改动的 Windows、Linux 产物，`build-native.mjs --arch all`，`npm pack --ignore-scripts`）。
2. 内容变了，版本号也要变（例如 `0.5.1-rotom.3`），不要沿用 `0.5.1-rotom.2`，否则同一个版本号对应两份不同的内容。
3. 同时更新：vendored tgz、`rotom/extensions/third-party/package.json` 和 `package-lock.json`、`rotom/runtime/product-config.mjs` 的
   version、integrity 和 archive。
4. `UPSTREAM.md` 的重建命令用 ad-hoc 签名（`--sign-identity -`）。这台公司 Mac 上的 amfid 和端点安全都拒绝过 ad-hoc 程序，
   所以发行包里 ad-hoc 签名的 helper 在受管 Mac 上能不能用，需要在打包时一并说明，不能假定可用。

打包会产生新提交，按“先审后冻结”审过之后再合入。

## 下一步

1. 用户按批准的方案安装测试版，手动跑提示词测试。
2. 执行方另起一轮做 P1 打包。
3. 合入 `main` 之前：全库和历史公开审计跑完并通过（REVIEW-14 复核已记录）、H2 和 HANDOFF-5 已完成、L2 的真机问题如实写进根 `CLAUDE.md`。

## 2026-11-10 安装结果：测试 helper 被端点安全终止

- 前置检查、独立 checkout（`c5376b7`）、依赖构建、`ditto` 替换、helper 构建与签名全部成功；`codesign --verify --strict` 通过，
  证书链为 Apple Development → Apple WWDR → Apple Root CA。
- 只执行了一次 `open --env`。helper 15 秒内没有创建 socket，进程已退出；系统日志：`termination reported by launchd (27, 1, 9)`。
  namespace 27 与此前 fixture 那条 `OS_REASON_ENDPOINTSECURITY` 相同，判断为同一端点安全机制。具体产品和规则未确定。
- 执行方按方案停止：没有重试、没有绕过、没有动现有安装和正在运行的 helper；没有取得 diagnostics，也没有授权任何权限。
  测试目录 `~/rotom-cu-c5376b7/` 和日志保留。
- `npm ci` 报告 runtime 依赖 2 个 moderate、1 个 high 告警。这是锁文件里已有的依赖，与本轮无关，单独处理，测试中不升级。

结论：

1. **这台公司 Mac 上无法手动测试新构建的 Computer Use。** 合规路径只有两条：IT 按日志批准例外，或在不受管的机器上测（mac2 或虚拟机）。
2. **对日常使用的影响（重要）**：用户现在日常用的 helper 能运行。但 P1 打包后更新 rotom，会装上一个新构建的 helper 二进制；
   按目前的证据（新构建的 fixture 和测试 helper 都被终止），它在这台 Mac 上很可能同样被终止，导致更新后 Computer Use 无法使用。
   **在这台 Mac 上更新日常安装之前，必须先取得 IT 批准，或先在不受管的机器上确认新版本可用。**

## 暂停（2026-11-10）：用户决定跳过真机验证

用户的两台 Mac 都受同一类公司端点安全管控，新构建的 helper 无法运行。用户决定暂时跳过真机验证。审核者的处理：

- **不打包，不在用户的受管 Mac 上更新 rotom。** 现有日常安装（10-25 的 Computer Use）可以运行，保持不动；新 helper 在这些机器上很可能被终止。
- **v2.1 不合入 `main`。** 根 `CLAUDE.md` 要求未验证的改动不混入公开 `main`；同意层、租约、前台接管属于安全边界，要求真实设备验证，
  不能用 L1 代替。代码与审核记录保留在 `claude/computer-use-v2.1` 和 `claude/dazzling-mccarthy-lf6mz2`。
- 已在 `main` 上的 v2 源码同样从未打包进产品归档（见 P1），本次不改变它的状态，也不在根 `CLAUDE.md` 里把它写成已启用。

恢复条件（满足任一）：IT 按日志批准测试程序例外；或者有一台不受管的 Mac（个人机器、云上 Mac，或不受管机器上的虚拟机）。

恢复后的顺序：

1. 按 REVIEW-15 批准的并排安装方案安装（不受管机器上可用自签名证书；Node ≥ 24）。
2. 跑 B0 投递矩阵，确定 L2 失败在哪一层；用户手动跑提示词测试。
3. P1 打包（新版本号，同步归档、lock、integrity），在不受管机器上确认新 helper 可用。
4. 全库与历史公开审计、根 `CLAUDE.md` 如实更新，然后按公开同步规则合入 `main`。

测试目录 `~/rotom-cu-c5376b7/` 可以只保留 `logs/` 交 IT；其余按安装方案第 6 步清理（本次未授予任何权限，无需 `tccutil`）。

## 更正（2026-11-10）：被终止的是新身份，不是新构建

审核者回查记录后更正上面“新构建的 helper 很可能被终止、更新后会坏”的判断：

- 11-06 第三次窗口记录：helper 从冻结提交**重新构建并重新签名**（同一 Apple Development 身份、同一 bundle 路径、bundle id 为
  `build-native.mjs` 默认的 `com.injaneity.pi-computer-use`），之后正常监听；11-07、11-08 的窗口里重建的 helper 也都正常运行。
  近两天日志中该 id 的端点安全终止记录为 0 条。
- 被终止的都是**新身份**：每次运行换一个新 bundle id 的 fixture 副本，以及安装方案为隔离权限而改成新 id 的测试 helper
  （`dev.rotom.cu.test.c5376b7`）。
- fixture 源码里没有任何 `CGEvent`、`AXUIElement`、事件 tap 或 `SLEventPostToPid` 调用，仍然被终止。所以端点安全的判断依据不是程序
  的功能，去掉功能不会让它放行。

修正后的判断：用产品原本身份（`com.injaneity.pi-computer-use`，同一证书）构建的新版本，按已有证据能在这台 Mac 上运行；
是否放行仍由端点安全决定。下一次安装测试版改用产品原本身份（`build-native.mjs` 的默认值，不传 `--sign-identifier`）。
这是产品正常的运行方式，也是此前所有成功窗口的做法，不是为了规避检查而修改任何参数；如果仍被终止，就停下交给 IT。

改用原本身份后，测试 helper 与日常 helper 共用同一份系统权限记录（同一 bundle id、同一证书），清理时**不得**对
`com.injaneity.pi-computer-use` 执行 `tccutil reset`，也不得注销日常 helper 的 LaunchServices 记录，否则会清掉日常使用的权限。
