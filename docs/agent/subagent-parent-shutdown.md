# 父运行时关闭：等待真实子任务终态

## 问题与证据边界

旧任务 `78932666-fa35-4cb1-abb4-2f5887fbb612` 被中断后留下候选关闭记录，但没有最终 `process-terminal.json`。最终证明原本依赖启动父进程的 `ChildProcess.close` 回调。隔离对照使用生产 finalizer 和 macOS kqueue：父观察者保留时证明正常落盘；父观察者提前退出时，内核确认 runner 已退出，状态仍停在 pending。原任务失去观察者的具体触发原因没有留下足够日志，不能把旧的 edit 错误认定为根因。

当前 PID 不存在、candidate、paused、旧测试通过或另一个新会话成功都不能补成原任务的历史退出证明。重启不能补收已丢失的 close 事件。本次不修改旧任务/lease 状态、不自动恢复或替代其 writer。

## 实现：`pi-subagents@0.52.1-rotom.8`

- `async-execution.ts` 按 ExtensionAPI 实例保存实际启动的 ChildProcess 句柄，复用 `createRunnerDrain`。不读取历史 PID 来发信号。
- `session_shutdown` 先关闭新 runner 准入，向所属活跃 runner 发送中断，等待实际 close 回调完成 finalizer，再清理运行时。重新 ref ChildProcess，避免只有未完成 Promise 时 Node 提前退出。
- 正常退出、reload、new/resume、SDK dispose 都退休原运行时的 authority：其子任务先暂停并回收，不继续跨越运行时销毁。其他运行时的任务不受影响；已关闭子任务不重发信号。
- finalizer 仍独立核对进程组、canonical lease 和证据持久化；失败保持 unknown，不默认成功。新运行时只能在原有关闭/身份/租约检查通过后恢复同一会话。
- 不改变异常强杀、owner loss、逃逸后代、workflow 的 unknown 和拒绝重放合同；不承诺阻止所有本机副作用。

## `.rotom.8` 初版验证（历史记录，不代替最终候选验证）

证据根：`/tmp/rotom-parent-shutdown-root`（本机私有目录链接）。macOS arm64，Node 24.18.0。所有模型输入均为本地 faux，没有远端模型调用。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 组件 unit（含实际离线打包） | 56/56 | `component-unit-v8.log` |
| 五种 shutdown reason | 等到 close 才清理、拒绝新任务、另一运行时不受影响 | `retired-runtime.test.mjs`，包含在 unit 中 |
| 组件 SDK/真实本地进程 | 两套入口各 6/6 | `component-sdk-v8.log`（公共 Pi 0.85.1）；`sdk-pi-1.3.log`（安装包 Pi 1.3.0-rotom.2） |
| 新 parent-shutdown 场景 | 正在执行工具的 Pi 进程及进程组退出；drain 返回时证明已落盘；新运行时恢复同一 canonical session | SDK 场景；另在安装包中的 Pi 1.3.0-rotom.2 入口 focused 通过 |
| 行为负对照 | 私有源码快照去掉 live runner 登记，新场景立即因返回时缺少关闭证明失败 | `negative-control.log`；不修改真实工作区保护逻辑 |
| strict/noEmit | 212 TS 输入通过 | `typecheck-v8.log` |
| 私有组件归档 | 白名单文件集、离线 npm pack、实际 tgz 隐私审计通过 | `component-pack.log`、`component/` receipt |
| 产品 archive/distribution 合同 | 33/33 | `product-contracts.log`；版本、lock、integrity 与资源白名单同步 `.rotom.8` |

### 首次失败与未通过入口

- 两次直接调用测试分别误用了 Rotom 产品入口和 Pi 兼容入口。identity/bin gate 拒绝，随后依据 package.json 的 `bin.pi` 使用真实入口；没有放宽验证。
- 新测试最初调用了不存在的 drain 计数 API，改为断言另一 runtime 仍可准入、只在其自身 drain 时收到停止信号。
- 新进程测试最初错误要求工具 abort 回调一定执行。print-mode 中断可以直接结束进程，不保证该回调。改为核对运行工具的真实 PID、登记进程组均已退出且最终证明存在；没有删除关闭要求或增加等待。
- `npm run test:all` 的 unit 与 SDK 通过，随后 compat 因既有陈旧路径失败：`check.mjs` 仍引用 third-party 根目录的历史测试，部分已移入 history，`owned-flat`/`lifeline-regression` 文件已不存在。原 HEAD 已是该状态。本次不删测试、不降低门禁，不把 test:all 报成通过；typecheck 单独执行通过。兼容入口修复需另行处理。

## `.rotom.9`：结果先于 close 回调的竞态

实际私有 npm 包的 persistent 场景揭示另一个窗口：结果已落盘，原父进程的 close 回调尚未处理，stale reconciliation 却提前写入 observer-unavailable。原失败的 wait 在 `07:56:30.524Z` 返回拒绝，最终证明到 `07:56:30.568Z` 才发布。

修复只在本进程持有与 asyncDir/runId/runner instance 匹配的真实 close 观察者时保留 pending。观察者登记在 finalizer 之后释放，不是关闭证明；新进程、错误实例或已释放的观察者仍不能凭结果文件恢复 writer。新增四种状态单测，并在私有快照去掉这个判断，确认 live-observer 场景从 pending 错变 unknown，断言失败。

最终组件归档：`pi-subagents-0.52.1-rotom.9.tgz`，SHA256 `03723a1f494c1f87777817fe0b3819d26210ffdeadbccdb3513c84020b9db3fd`，source digest `9e57c2f4f6781621e3cec7c3cb2329c9bb46d9cdbb54e18808c765b9a681c935`。产品 manifest/lock/白名单固定此归档。实际消费验证使用提交 `e70edb5` 的私有源码快照，加此归档与唯一测试版本 `0.1.27-parent-shutdown.1`；未混入并行 Qoder 改动。该轮先在私有前缀验证，随后按用户要求切换日常入口，见下节。

| 最终候选检查 | 结果 | 证据根下文件 |
| --- | --- | --- |
| unit | 60/60 | `component-unit-v9.log` |
| strict/noEmit | 212 TS 输入通过 | `typecheck-v9.log` |
| 公共 Pi 0.85.1 SDK | 六个场景分段通过，不是一轮全绿 | `component-sdk-v9.log` 前四项、`sdk-v9-remaining.log` 准入项、`sdk-v9-public-paths-recheck.log` 完整路径项 |
| Pi 1.3.0-rotom.2 parent-shutdown | 1/1，真实工具回收、证明落盘、同一会话恢复 | `sdk-v9-pi-1.3-parent-shutdown.log` |
| observer 竞态负对照 | 去掉判断后按预期失败 | `observer-race-negative.log` |
| 离线组件打包与实际 tgz 审计 | 通过 | `component-pack-v9.log`、`component-v9/` |
| 实际私有产品打包、全新离线安装、npm bin | 六个场景通过；transient/persistent/deferred/native resume/workflow 均检查登记资源关闭 | `product-pack-v9.log`、`consumer-install-v9-distinct-config.log`、`product-v9-notification-contract.log` |
| 当前产品 archive/distribution 合同 | 33/33 | `product-contracts-v9.log` |

### 保留的失败与验收修正

- 组合命令在机器 load average 约 624 时超过外层 300 秒预算；unit、types 和前四项 SDK 已完成，其余不追认为通过。未增加测试超时；核对自有进程后按剩余场景继续。
- 完整 SDK 路径首次因 `timeout writer ready` 失败：4000 ms 总预算中的约 3400 ms 已在 runner 启动前消耗，工作进程尚未 ready 即正确超时，随后登记进程组关闭证明存在。机器负载降低后，保留原 4000 ms 和原测试，单独重验通过；首次失败留在 `sdk-v9-remaining.log` 和所指临时现场。
- 产品工作流首次因第五次 controller 请求被 fixture 标为 replay。日志证明该请求携带迟到的 workflow 完成通知，native 请求仍为四次。旧 `.8` 对照在另一通知时序下只有四次 controller 请求；不能据此宣称存在/不存在产品回归。`subagent_wait` 证明关闭，不保证通知已全部投递，通知本身允许唤醒父 Agent。
- 仅修 fixture：允许一次携带本轮 workflow 返回内容及其真实 native child ID 的完成唤醒。仍严格检查四次 native 请求、四个 run 目录、三个 admission、全部关闭证明和外部效果；任意额外请求仍拒绝。最终六场景通过，但该次 workflow 未触发迟到分支。另用首次失败保留的真实通知重放该校验，并确认错误角色、其他 run ID、普通重复消息均被拒绝：`late-notification-control.log`。不把这个记录级检查称为新的迟到投递端到端验收。
- 临时 npm 配置曾把 user/global 同时指向 `/dev/null`，在解析配置前被拒绝；改为两个隔离空配置文件。产品检查首次还因未创建私有输出目录而在启动 fixture 前失败。两份原日志均保留，未重放未知写入。
- `.rotom.8` persistent 失败保留在 `consumer-product-tests.log`；`.rotom.9` 两轮 persistent 均通过。旧 `test:all` compat 路径问题仍未修复，不宣称全量门禁通过。

## 日常入口激活：只面向新进程

用户明确选择“旧任务不用管了，新任务生效即可”。使用既有 `scripts/install-release.sh` 离线安装已验证的本地修复包 `0.1.27-parent-shutdown.1`，未公开发布。实际包 SHA256：`068129f12dd32dc3fac5c5273c097be62c0b433205c0cccaee9a503903ac172c`。对比旧安装的分发文件，变化仅涉及 Subagent 及配套元数据；不带入并行 Qoder 改动。

- 当前 Node bin 中的 `rotom` 已指向新版本目录；`rotom --version` 回读正确。`0.1.26` 原目录保留，不原地改写。
- 安装后的 212 个组件 TS 文件与已验证归档逐字一致。实际日常命令入口在隔离 HOME/workspace 中启动新 native 子任务，确认登记资源关闭、canonical session/lease 保持和安全恢复；四次 native 请求全部来自本地假上游，远端模型调用为零。
- 实际安装的 default/full public-runtime smoke 均通过。首次源码 smoke 在执行前因缺少 TypeBox 宿主依赖而失败；私有测试 bootstrap 改为从该安装的 Pi 解析同一个宿主依赖后通过，没有修改安装源码或验证断言。
- 日常进程未退出或重启；旧会话已加载的扩展不会热更新。用户需手动重开 Rotom，后续任务才使用新运行时。
- 证据位于证据根的 `daily-activation-jrrHFT/`：`activation-result.json`、`install.log`、`version.log`、`installed-new-task.log` 与两份 `public-runtime-*-host-dependency.log`。按本次测试脚本路径核对，无已知残留测试进程；这不是对未知逃逸后代的保证。

## 旧孤立任务与剩余限制

用户已决定不再处理旧任务。本次不做事后核验、不改恢复合同、不修改旧任务或 lease，不恢复或替代旧 writer；原 unknown/blocked 记录保持原样，不追认为已经关闭。

没有真实在线 Provider 业务验收、Linux 验收或当前日常运行实例重启。安装验证不代表当前会话已加载新版本。
