# Computer Use v2 审核意见（第 2 轮）

审核对象：`4b209f2`、`ef861ce`。审核日期 2026-11-04。

结论：进展很大。第 1 轮的 4 个阻断项都已修复，真机跑通了协议 8 和 8 个语义动作，还修掉了 3 个只有真机才能发现的缺陷，这部分证据可信。但**核心目标“多 agent 后台并行且不影响用户”还没有任何真机证据**，另外有一处文档和实际不符。这一轮仍然不合入。

## 审核者本地复现

- Linux，Node 22.23.4，使用与第 1 轮相同的 peer 依赖桩：72 个用例，71 通过、0 失败、1 跳过，连跑 3 次结果一致。
- 去掉依赖桩：`cu-v2-tools.test.ts` 仍然失败（I3 只做了一部分，STATUS 里已如实写明）。

## 第 1 轮问题核对

| 项 | 结论 |
|---|---|
| B1 安装版 Broker | 已修。packaged 测试先复现旧错误，再证明新入口可用。staging 的位置有问题，见 R4 |
| B2 新工具绕过策略和租约 | 接线已修：剪贴板用 `clipboard:system` 租约，并以 “System Clipboard” 身份触发审批卡。但测试只是对源码做字符串匹配，第 1 轮要求的三个行为测试没有写；`manage_app quit` 也没有走敏感确认。见 R3 |
| B3 模型停止其他 agent | 已修。schema 删掉了 `stop`，Broker 只接受 `role=helper` 发起的停止 |
| B4 剪贴板恢复 | 已修。按 item 和类型做快照，`changeCount` 变化就不恢复，有对应测试 |
| I1 trace 白名单 | 已修 |
| I2 helper 侧强制 | 未做，STATUS 已如实写明。但根 `CLAUDE.md` 还没改，见 R1 |
| I3 peer 依赖 | 部分完成，接受，后续再处理 |
| I4 STATUS | 已修。`evidence/milestones-m5-m8.md` 第 63 行还写着“全部原生行为只到编译通过”，和现状矛盾，顺手更新 |
| I5 CLAUDE.md 矛盾 | 未提交，见 R1 |

## 本轮必须处理

### R1 已提交的 CLAUDE.md 仍然夸大了能力

`main` 分支上的根 `CLAUDE.md` 第 86 行仍写着“只保证不会有两个 agent 同时写同一个 App”。而仲裁目前是协作式的，helper 侧没有强制。STATUS 第 104 行说“已按此如实改写”，但这个改动其实没有提交，因为 `CLAUDE.md` 本身就超过 20 KB，会被钩子拦下。

**用户已于 2026-11-04 同意**：根 `CLAUDE.md` 加入钩子豁免名单。现在豁免名单共三个文件：`bridge.ts`、`bridge.swift`、`CLAUDE.md`。请提交第 4 节的修改，commit message 写“钩子豁免：仅 CLAUDE.md（用户 2026-11-04 决定）”。修改内容是：删掉第 83 行的“没有……统一确认层”；把第 86 行改成“协作式仲裁，helper 侧尚未强制”。

### R2 核心验收和 L2 一次都没有在真机上跑过

- PLAN 第 10 节的验收（用户模拟器持续打字，同时 3 个 agent 在后台操作）没有运行。兼容矩阵的 10 个单元格全是 `not-run`。
- `live-check.md` 里没有任何一行用到 `l2` 投递，`SLEventPostToPid` 从来没有执行过。
- `milestones-m5-m8.md` 第 33 行声称已覆盖“后台不变量（前台 App 与光标不变）”，但 live-check 表格里没有光标位置这一行。前台 App 那一行的结果是 `inconclusive`（Google Chrome → Qoder），而且这个变化正是 HID 点击那一步造成的。

要求：
1. live check 增加两行检查：动作前后的系统光标坐标，以及前台 App。HID 那一步只在显式传入 `--with-hid` 时才运行，并且要和后台不变量检查分开跑，避免互相污染结果。
2. 实现第 10 节的验收脚本：3 个 fixture 实例（不同 bundle id）、用户模拟器（向 TextEdit 输入固定文本，并移动鼠标），断言 4 项结果。
3. 补一个 L2 的单项检查：对白名单 App 和 fixture 各跑一次定向点击和定向输入，记录光标是否移动、事件是否被接收。签名错误导致崩溃也算一种结果，如实记录。
4. 这些检查会在用户的 Mac 上输入文字、移动鼠标，所以**必须在用户约定的、用户离开电脑的时间段内运行**。审核者会和用户约时间。在此之前，只把脚本写好，并在 Linux 上用假 backend 跑通脚本逻辑。
5. 在证据补齐之前，把 `milestones-m5-m8.md` 里那句“前台 App 与光标不变”改成“未验证”。

### R3 B2 的测试要改成行为测试

源码字符串匹配挡不住接线被改坏后的回归。参考 `broker-scheduler.test.ts` 的写法，用真实 Broker 加假 backend，补上以下 4 个测试：
- 对 `view` 级 App 执行 `manage_app quit` 被拒绝。
- 没有 UI 祖先的 agent 读剪贴板，得到 `approval_unavailable`。
- 对另一个 agent 持有的 App 做 `manage_window resize`，得到 `resource_busy`。
- `manage_app quit` 触发敏感确认：在 `sensitive.ts` 里按动作名加一条规则，`force: true` 时必须确认。

### R4 daemon 源码 staging 的位置不安全

`daemon-entry.mjs` 把源码复制到 `os.tmpdir()/rotom-cu-broker-stage-<指纹>/`。这里有三个问题：目录名可以预测；只要 `.complete` 标记存在就直接 import 里面的代码，不校验内容；目录用的是默认权限。macOS 上 `$TMPDIR` 是每个用户私有的，风险较低；但在共享 `/tmp` 的环境里，其他用户可以抢先放入恶意的 `daemon.ts`。

要求：staging 改到 Broker 自己的私有目录下（复用 `ensurePrivateDir`，目录 0700、拒绝 symlink）。写到临时目录后用 rename 原子替换。import 之前重新计算 staged 内容的指纹并比对，不一致就重新 staging。补一个测试：预先放入被篡改的 staged 文件，确认它不会被执行。

## 后续项（可以留到合入后）

- I2：helper 侧租约强制和截图排除。
- 第 1 轮的 F1 到 F5。
- 用户已决定 v2 新逻辑要从 `bridge.ts` 移到新模块，但本轮 `bridge.ts` 从 141 KB 增长到 146 KB。请在下一轮把剪贴板、App 管理、窗口管理、cu_session 这四个执行器移到 `src/tools/` 下。

## 合入前需要在文档里写明的行为变化

合入后，macOS 上 Broker 默认开启，每个 App 第一次被写入时都会弹授权卡。没有 UI 的运行方式（`-p`、RPC、eval）里，未预先授权的 App 会直接返回 `approval_unavailable`，相当于以前能用的无人值守 Computer Use 流程会失败。请在 `docs/agent/computer-use-trace.md` 或新文档里写明两种做法：在 `policy.json` 里预先写好 “always” 授权，或者设置 `ROTOM_CU_BROKER=0`。同时补一个测试：已预先授权的 App 在无 UI 时可以写入。
