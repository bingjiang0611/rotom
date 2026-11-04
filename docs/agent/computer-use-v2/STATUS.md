# Computer Use v2 执行状态

由执行 agent 维护。每个里程碑结束时更新并推送。审核者只看这个文件和提交。

## 总结

（全部做完后填写：完成了什么、验证到哪一层、没做什么以及原因。）

## 执行环境

- OS / 架构 / 版本：macOS `27.2` (build `26B123`) / `arm64`，内核 `Darwin 27.2.0`
- Xcode / swiftc：Xcode 26.6，Apple Swift 6.3.3（`/usr/bin/swiftc`、`/usr/bin/xcodebuild` 可用）；`node scripts/build-native.mjs --arch arm64 --output /tmp/cu-baseline-bridge` 在本机 25 秒编译成功（baseline，未改动源码）
- Accessibility、Screen Recording 是否已授权：**否，且本机执行策略拒绝运行本地编译产物**。`swiftc` 能编译，但未签名或 ad-hoc 签名的可执行文件一执行就被 SIGKILL（`Killed: 9`），本机 baseline `prebuilt/macos/arm64/bridge` 同样被杀。因此 M5 只能验证“编译通过”，M7 无法在本机运行（详见“既有失败”）。
- 使用的独立 helper 路径与 socket：本次未启动任何 helper，未触碰 `~/Applications/pi-computer-use.app` 或用户 daemon；测试只用临时目录下的 broker socket。
- 依赖状态：`packages/rotom-computer-use` 无 `node_modules`（仓库不提交），纯 Node 测试（`node --test --experimental-strip-types`）不需要依赖即可运行；`tsc`、`tsx` 与 `rotom/extensions/third-party/node_modules` 均未安装，相关脚本无法运行（见“既有失败”）。

## 里程碑

状态取值：未开始 / 进行中 / 完成 / 部分完成 / 阻塞。验证层级：L1 单测与静态检查；L2 macOS 真机。

| 里程碑 | 状态 | 验证层级 | 提交 |
|---|---|---|---|
| M1 Broker 核心 | 完成 | L1 | 见下 |
| M2 bridge 接入 Broker | 未开始 | | |
| M3 策略与审批 | 未开始 | | |
| M4 Trace | 未开始 | | |
| M5 macOS 原生能力 | 未开始 | | |
| M6 工具面 | 未开始 | | |
| M7 真机验收与兼容矩阵 | 未开始 | | |
| M8 文档、版本与打包 | 未开始 | | |

## 每个里程碑的记录

### M1 Broker 核心

- 实现摘要：新增 `src/broker/`（`protocol.ts`、`core.ts`、`server.ts`、`client.ts`、`daemon.ts`、`registry.ts`、`leases.ts`、`epochs.ts`、`paths.ts`）。Unix socket + JSON-lines，request id 回显；目录 0700、socket 0600、symlink 拒绝（目录与 socket、lock 都检查）。每次写租约分配全局 epoch，续期也算一次新写（旧观察被消耗）。`wait: true` 按资源 FIFO，30 秒封顶。断开、心跳超时（10s）、TTL 到期都会撤租约并推送 `revoked` 事件；转交子 agent 后父 agent 拿不到写权。多余留了一个 `core.ts`（纯语义、无 socket）以便用假时钟做确定性测试；socket 层只做 framing。
- 新增或修改的测试（列出会因旧行为失败的反例）：`test/broker-core.test.ts`（8 个）、`test/broker-socket.test.ts`（7 个）。旧状态机完全没有跨进程仲裁，这些用例在旧代码上不可能通过：例如“第二个客户端立即拿到 `resource_busy` 并带 holder 与剩余毫秒”“另一个 agent 用旧 epoch 写得到 `stale`”“socket 关闭后租约自动释放、另一个客户端接管”“两个进程同时拉起 broker 只得到一个 pid”。
- 自证命令与结果（命令原文 + 通过数 / 失败数；失败要贴关键输出）：
  - `npm test` → 31 pass / 0 fail（含 baseline 16 个）
  - `node --test --experimental-strip-types "test/broker-core.test.ts"` → 8 pass / 0 fail
  - `node --test --experimental-strip-types "test/broker-socket.test.ts"` → 7 pass / 0 fail
  - `git diff --check` → clean；`python3 scripts/audit-public.py --root .` → PASS（0 findings）
- 未验证项：没有在真实多 Pi 会话（多进程）下验证；socket 测试用两个 client 对象在同一进程内，只有 broker 本身是真独立进程。`npm run typecheck` 无法运行（仓库未提交 `tsconfig.json`，见既有失败）。
- 与 PLAN 的偏差及原因：①新增 PLAN 未列的 `core.ts`（语义层）以便假时钟测试；②`baseEpoch` 省略时不做 stale 校验（视为“调用方没有可失效的观察”），显式 epoch 严格校验；③daemon 直接 `node daemon.ts` 运行（依赖 Pi 要求的 Node ≥ 22.19 默认类型擦除）。

### Mx 名称

- 实现摘要：
- 新增或修改的测试（列出会因旧行为失败的反例）：
- 自证命令与结果（命令原文 + 通过数 / 失败数；失败要贴关键输出）：
- 未验证项：
- 与 PLAN 的偏差及原因：

## 决定记录

| 日期 | 问题 | 选择 | 理由 |
|---|---|---|---|

## 既有失败

（开工前就失败的测试，不在本分支修。）

## 需要审核者回答的问题

（只放不可逆、超出授权或会改变已定决策的问题。）
