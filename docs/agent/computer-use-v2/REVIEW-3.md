# Computer Use v2 审核意见（第 3 轮）

审核对象：`6b92ec6..5e5cc7a`。审核日期 2026-11-04。

结论：PLAN 第 10 节的核心验收在真机上通过了，证据可信。3 个 agent 在后台并行操作，用户同时打字，文本逐字一致，前台 App 和焦点窗口都没有变化。这证明了**语义动作（L1/AX）路径**能做到“多 agent 后台并行且不影响用户”。R1、R3 已完成。

但 R4 引入了一个启动竞态，另外证据里有一处把投递方式写错了。修完下面两个必须项（M1、M2）就可以合入，L2 和兼容矩阵放到合入之后再做。

## 审核者本地复现

Linux，Node 22.23.4，使用 peer 依赖桩。全量测试 78 个用例，连跑 3 次，其中 2 次出现 1 个失败：`broker-socket.test.ts` 的 “two clients spawning at once converge on one broker”，报错 `Broker daemon exited with code 1`。单独跑这个用例 8 次失败 1 次。把 `daemon-entry.mjs` 换回 R4 之前的版本后，8 次 0 失败。

## 必须修（合入前）

### M1 两个进程同时拉起 Broker 时，其中一个会失败

`stageDaemonSources` 的流程有竞态。进程 A 把 staging 目录 rename 到最终位置，通过校验，开始 import。这时进程 B（它更早看到“未就绪”）执行 `rmSync(stagedRoot)`，把 A 正在 import 的目录删掉，于是 A 以 exit 1 退出。真实场景里，父会话和 subagent 同时启动就会触发；而写操作在连不上 Broker 时是失败关闭的，所以一方的 Computer Use 会直接不可用。

要求：
1. 目标目录已存在且校验通过时，绝不删除，直接使用。只有校验失败（被篡改）时，才先把旧目录 rename 到一个唯一的废弃名，再把自己的目录 rename 进去。不要原地 `rm`。
2. 客户端侧也要兜底：daemon 以非 0 退出时，如果 socket 已经可以连接（说明别的进程赢了），就继续连接，不要直接抛错。
3. 回归测试：用 3 到 5 个进程同时调用 `stageDaemonSources` 并 import 结果，重复 20 次，0 失败。原来那个双客户端用例连跑 20 次 0 失败。

### M2 投递方式记错了，“L2 首个正例”不成立

`acceptance-run.md` 里切 tab 的 3 行写的都是 `delivery=ax`，而 `real-machine-session.md` 和提交说明里说这一步走的是 pid 定向投递，并称之为“`SLEventPostToPid` 路径的首个正例”。这里有两个问题：
- 证据里记录的投递方式和描述不一致。要么 helper 的 `performed.delivery` 填错了（实际走了 pid 却报 ax），要么这一步其实是 AX 点击。请查清楚。如果是 helper 报错了，这就是一个会影响 trace 和 `deliveryLevel` 的真实 bug，需要修复并补测试。
- 按本分支自己的设计，`pid` 是公开 API `CGEvent.postToPid`，`l2` 才是 SkyLight 的 `SLEventPostToPid`。fixture 不在 L2 白名单里，不可能走 l2。

要求：把 `real-machine-session.md`、STATUS 和 `milestones-m5-m8.md` 里关于 “L2 / SLEventPostToPid 首个正例” 的说法全部改成如实描述。L2 仍然记为“未在真机执行”。

## 证据整理（本轮一起改）

- `real-machine-session.md` 第 3 节写着 “fixture 定向点击 pass”，但 `l2-check.md` 里没有这一行（fixture 窗口 fail）。证据文件每跑一次就被覆盖，早期的结果丢失了。要求以后每次运行另存一份带时间戳的日志（`evidence/runs/<时间戳>-<脚本名>.md`），汇总表里引用具体是哪一次运行。
- `real-machine-session.md` 第 4 节说，IntelliJ 越界之后“按规则停止真机部分，不再重试”。但 `acceptance-run.md` 的时间戳是 15:33，晚于 L2 检查的 15:19。也就是说，停止之后又跑了验收，而且当时前台是 Google Chrome，用户很可能已经回到电脑前。请把实际的时间顺序如实写出来。
- L2 检查脚本加了 `--allow-l2-app` 开关，这很好。另外请默认排除所有在脚本启动前就已经在运行的 App，只允许操作脚本自己启动的进程。

## 接受

- R1：CLAUDE.md 第 4 节的表述已改成“同意层、协作式仲裁”，接受。
- R3：`cu-v2-authority.test.ts` 用真实 Broker 和策略门跑了 5 个行为用例，`src/tools/intents.ts` 集中构造意图，接受。
- 提交钩子：把豁免写进了 `scripts/check-staged-file-size.mjs` 的 `oversizedByDecision`，比到处用 `--no-verify` 更好，因为其他钩子仍然会执行。接受，审核者会告诉用户这个豁免现在是长期生效的。
- 行为变化文档 `behaviour-changes.md`：接受。

## 合入之后再做

- L2 真机执行与兼容矩阵（需要再约一段用户不用电脑的时间；跑之前先解决 LaunchServices -10825 的问题，比如每次运行都用新的 bundle id 和新路径）。
- `--with-hid` 单独运行。
- I2 helper 侧强制、I3 peer 依赖、第 1 轮的 F1 到 F5，以及把 bridge.ts 里的四个执行器移到 `src/tools/`。
