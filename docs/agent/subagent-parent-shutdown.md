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

## 验证

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

## 旧孤立任务与剩余限制

正常 teardown 的预防修复不会补回过去的关闭事件。旧任务仍按当前合同 blocked。若增加事后恢复，必须单独设计：核验不可替换的 run/store/session 身份与登记集合、保留原 unknown、明确区分当时观察到的 close 与当前核验，不能编造 exitCode 或仅靠 PID 消失放行。改变当前“真实 close 后才能恢复”的合同需要明确批准，不能伪装成维护锁文件。

本次没有真实在线 Provider 业务验收、Linux 验收、当前日常运行实例重启或旧任务恢复。产品安装不会随源码或私有组件版本变化而自动更新。
