# Owner lifeline：第二阶段隔离候选

> 历史报告；下文安装状态与采用结论仅指该批。当前默认及旧命令的重放限制见 [历史索引](README.md)。

## 结论

**Decision: PASS（有界失联/取消合同）；整体可靠性仍 INCONCLUSIVE，不部署。**

真实 Pi SDK / 本地 faux provider 的固定夹具中，父进程 SIGKILL 后，候选能通过公开 `ctx.abort()` 中止原生 Bash 及受测后代。中间 owner 尚存活时，失联信号也能向下传递。

**不响应 AbortSignal 的工具仍会继续写入。** 第一阶段的 unknown / 禁止自动恢复必须保留；本阶段没有全图终态回执，不能自动改成 cancelled 或授权重试。

当前安装仍是 `pi-subagents@0.52.1`，未替换 installed source、lockfile 或产品资源。补丁只应用于隔离上游及测试的私有副本。

后续[完整 package workflow 验收](subagent-workflow.md)补齐了真实 CLI / SIGKILL / 同 session 重开，并修复托管 POSIX child 缺配置时静默降级的问题；当前 helper/SDK suite 为 **19/19**。整个 runtime 未加载仍会继续写入，启动确认与部署门未通过。

## 实现

`subagent-lifeline-candidate.patch` 修改 upstream 四个文件：

- `src/runs/shared/owner-lifeline.ts`（新增）：通过 POSIX fd 3 的 EOF / error 识别失联；调用公开 Extension API 请求 abort / shutdown，阻止后续工具调用。无 PID 轮询，不向旧 PID 发信号。
- `src/runs/foreground/execution.ts`：为 process-mode Pi child 增加独立 pipe；保留 stdout/stderr，跟踪本进程持有的通道。
- `src/runs/shared/pi-args.ts`：清除继承的 descriptor 数字；每次 foreground spawn 建立自己的通道，不能把祖先 fd 当新 owner 的凭证。
- `src/runs/shared/subagent-prompt-runtime.ts`：在现有 child runtime 中注册 guard，不增加产品 extension。后续修订对标记的 POSIX child 设置 `required:true`；缺 descriptor 配置时阻断启动，独立使用者仍 opt-in。

失联的中间 owner 关闭自己持有的下游 lifeline。不同 loader 对同一模块的多次求值共享 process-local symbol/handle set；不依赖 Pi 私有字段，不建立第二套调度器。

不能只等 child `close` 才释放 pipe：被后代继承的 reader 可能阻塞 close。因此在 child `exit` 时释放额外 fd。健康 reader 使用 `unref`，不阻止已完成的 child 退出；正常 session shutdown 不制造失联通知。

## 第二阶段验证快照（`b880196`）

Profile：**fast + 无网络 host-process/SDK smoke**，不是付费 canary 或产品发布门。

配置：macOS、Node 24.18.0、实际公开 Pi SDK 0.85.1；faux provider、thinking off。SDK 使用私有 auth 路径、内存 session，禁用自动 context/skill/template discovery，并阻断 `fetch`。外部评测模型请求 **0**；不是整个协调会话的费用声明。

源基线：upstream `v0.52.1` / `afa22c811f81883acdb248c84f116ac7534e2fb4`。SDK 对照不加载 lifeline guard，不是完整 baseline 产品启动。

以下 SHA-256 与 18 项结果属于 `b880196`，不是当前修订文件的哈希；当前哈希与完整包结果见上方后续报告。

- patch：`7d0afeb5c307755fcd95d064ce1f21753d983120c11f257df70e6e774bc5ea85`
- regression harness：`5eb2a7a28e25f7c93369d19c92cc68e11d5b56c1258e6fda00799aa9e9c1dd77`
- SDK fixture：`27c8d03d563fa624268623105066dfa6cd2de653a62c194e883654ed7a1855a6`

该阶段固定 suite 为 **18 项：12 个 candidate helper、1 个公共进程观察断言、5 个 SDK 场景**。

| Gate | 结果 |
| --- | --- |
| Candidate，含当前 5 个 SDK 场景 | **18 pass / 0 fail / 0 skip**，exit 0 |
| Baseline，同一 SDK 夹具 | **3 pass / 3 fail / 12 skip**，exit 1；helper 在 baseline 中不存在 |
| 无 SDK 默认门 | **13 pass / 0 fail / 5 skip** |
| 该阶段隔离 upstream typecheck | PASS |
| 隔离 upstream 七个定向 unit 文件 | **158 pass / 0 fail** |
| wait + owner-loss + lifeline 三补丁组合的既有 wait 回归 | **55 pass / 0 fail** |
| 该阶段 `check-personal` | **96 pass / 0 fail / 19 既有历史 skip**，deterministicGate PASS |

SDK 场景分别为：

| 场景 | Baseline | Candidate |
| --- | --- | --- |
| healthy | 正常写入并退出 | 正常写入并退出，健康 pipe 不阻塞退出 |
| owner-loss | SIGKILL 后仍存活，放行后写入 | 原生 Bash 两个已知 Node writer 停止；放行后无 late write |
| cascade | 放行后仍写入 | 中间 Node owner 仍活着，末端 SDK 的 writer 已停止 |
| early-loss | 初始化前 owner 已死，仍启动 writer | 此夹具没有启动 Bash writer |
| noncooperative | 忽略取消的 custom tool 继续写入 | **同样继续写入**；这是已知限制的反例，不是取消成功 |

leaf 故意忽略 SIGTERM；写入使用 ready/release 文件握手，不靠固定 sleep 假装取消。进程观察拒绝把 `ps` 错误/超时当成退出；清理无法确认时保留 fixture 并失败。正常收尾使用异步目录清理，避免同步删除阻塞测试报告。

该阶段最后有效运行记录：candidate suite 21.791 秒；baseline 85.039 秒。**不可据此声称提速**：baseline 会等待缺失的完成证据，而且主机时延有明显波动。没有真实模型 token/费用收益数据。

该阶段收尾已检查：没有命令匹配本轮 lifeline fixture 的存活进程；安装版本、三个既有被补丁涉及的源文件与 upstream baseline 相同，安装中不存在新增 helper。这不是全主机 orphan-process 证明。

### 失败和证据边界

- 中途修正了两个夹具问题：已注册 test 后异步初始化导致提前 cleanup；把 Pi 0.85.1 的 `tools` string[] 误当 Tool[]。最终使用 `customTools` 注册反例并断言工具确实激活。
- 出现过 SDK 启动期限、进程查询和同步临时目录清理超时。诊断明确观察到同步 cleanup 阻塞；改为异步清理后定向门恢复。**不能把所有超时都归因于同一个原因或声称环境问题已根治。** 这些失败不混入最后有效 pair。
- 三个较大的 upstream integration 文件整组执行超过 180 秒，无完整结果；没有记为通过，也没有盲目重复整组。此前 wait/control 合同迁移与完整 upstream gate 仍未完成。
- SDK smoke 通过公开 loader 加载同一个 guard helper，但 parent spawn 是夹具，cascade 的中间 owner context 也是夹具。不是完整 `subagent` 工具、script workflow 或六个产品 extensions 的端到端验收。
- 仅观察了已知 fixture writer；不是任意 escaped process、远端副作用或全机器收敛证明。

## 历史重跑设置

以下变量与计数仅适用于当时 harness，**不能在当前树据此重跑 baseline/candidate**。现有文件已迁至 `rotom/extensions/third-party/subagent/lifeline-regression.test.mjs`，默认测试 installed product；精确候选输入要求见历史索引。

```text
# 当时默认在私有副本中应用 candidate；14 个本地断言，未配置的 SDK 场景跳过。
node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/subagent/lifeline-regression.test.mjs

# 当时固定 5 个无网络 SDK 场景；baseline 的三个失联正例预期失败。
SUBAGENT_LIFELINE_CANDIDATE=0 OWNER_LIFELINE_PI=/absolute/path/to/pi \
  node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/subagent/lifeline-regression.test.mjs

SUBAGENT_LIFELINE_CANDIDATE=1 OWNER_LIFELINE_PI=/absolute/path/to/pi \
  node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/subagent/lifeline-regression.test.mjs

SUBAGENT_WAIT_CANDIDATE=1 SUBAGENT_OWNER_LOSS_CANDIDATE=1 \
SUBAGENT_LIFELINE_CANDIDATE=1 SUBAGENT_WAIT_STRICT=1 \
  node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-wait-regression.test.mjs
```

`LIFELINE_DIAGNOSTICS=1` 只输出 harness 阶段 metadata。不要并行跑不同的 process-heavy gate。Windows 未启用此 pipe 路径，SDK 测试在 Windows 跳过，不能写成该平台验证通过。

## 下一步与禁区

1. 完整包的单 child / SIGKILL / 同文件 session 重开已在后续报告验收；继续补必需 runtime 的启动确认、session switch、多个实际 loader / manager 和订阅恢复。
2. 为不响应取消的工具、未加载 reader、escaped descendants 建立独立监护和可信终态合同；不能仅凭 abort 或当前 pipe 状态解除 unknown。
3. 完成 upstream wait/control 合同迁移及干净环境完整 gate 后，再考虑 upstream PR / package pinning / 产品 canary。本轮不发布、不推送、不部署。

不覆盖：owner 挂起但 fd 仍打开（没有 heartbeat）、Windows、external CLI、独立 background runner、已经发出的外部写入，以及旧版已伪造 failed 记录的自动修复。
