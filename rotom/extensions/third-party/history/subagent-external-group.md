# External CLI 进程组：第三批隔离候选

> 历史报告；下文安装状态与采用结论仅指该批。当前默认及旧命令的重放限制见 [历史索引](README.md)。

**Decision：macOS 扩大候选回归 PASS；采用仍 BLOCKED。** 当前产品仍为 `0.52.1-dev-agent-followthrough.2`。本页不是“运行时已启用”的声明；没有改 installed source、archive、package/lock、默认工具面或发布包。

## 已实现的修复

候选文件：`subagent-external-group-candidate.patch`，以当前 `.2` 为基底。仅在私有临时副本中应用，目前涉及七个源码文件（第三批为六个，采用审查新增 retention）：

| 文件（均位于上游 `src/`） | 改动 |
|---|---|
| `runs/shared/external-cli-runner.ts` | POSIX 创建时使用 detached 独立进程组。stop、timeout、直接进程 exit 共用一次 cleanup；不等可能被后代持有的 stdio close 才开始处理。 |
| `runs/background/owned-process-tree.ts` | 复用现有控制器，不建第二套注册表。对创建期拥有的组执行 TERM → KILL → 核验；终止 Promise 不可复活，观察到不存在后不再发送信号。 |
| `shared/types.ts` | 区分 `externalProcess.processGroup`、`directCloseObserved` 和 `descendantScope: unverified`；增加 `external-descendants-unverified` reason。 |
| `runs/background/subagent-runner.ts` | 将 external writer 未核验标记写入持久化 terminal candidate，而非只靠进程内变量。 |
| `runs/background/process-terminal.ts` | external 的组级观察不再变成整个 writer graph 的 `observed`；保留 unknown，不执行本函数的 observed-index release 分支。 |
| `runs/background/async-resume.ts` | 在 reconciliation 前检查 status、terminal candidate/proof 和 result-only 的 external 证据；混合任务不能通过选择 Pi index 绕过 run 级 fence。拒绝不修改任务文件，不输出“另建 writer”建议。 |
| `runs/background/async-retention.ts` | active index 缺失时也保留带 external 未核验证据的过期任务和结果文件；age/任务完成不是 writer 关闭证据。复用 process-terminal 的固定字段判定，不解析正文。 |

### 有界探测与 close

- `kill(-pgid, 0)` 的 ESRCH 可直接证明该组不存在；其他错误不能当成不存在。
- 对仍可能存在的组读取完整 `ps` 快照：500 ms / 1 MiB 上限，超时、截断、非零退出、stderr、空/损坏记录均 unavailable。EPERM 只可经独立完整快照确认没有活成员（例如 zombie-only），绝不直接映射为成功。
- 保持 external 的 TERM 等待 2 s，KILL 后核验 1 s。探测暂时 unavailable 不得使创建期拥有的 writer 跳过整个取消序列：仍执行同一次 TERM → 完整 grace → 必要时 KILL → 核验，读探测失败不提前消耗 grace。只有正面关闭证据可返回 observed；最终 unknown 后不重放 kill、不切换 PID、不创建替代进程。
- 直接进程退出时即收敛同组后代，即使其继承 stdio 导致 `close` 迟迟不发生。
- 组处理完成后最多再等 close 1 s。若仍无 close，只关闭本方管道并返回 unknown；不捏造 `endedAt`，不将强制关闭管道当成实际进程退出。上述为本机事件循环/系统调用的有界策略，不是 OS 强实时保证；完整日志 flush 沿用原实现。

## 能证明什么

真实本机夹具确认：

1. 普通退出、stdin/argv、输出尾部和完整日志仍符合原合同。
2. stop / timeout 后，同组且忽略 SIGTERM 的后代由 SIGKILL 收敛；放行文件写入后不再有残留写。
3. 直接进程先 exit 时，仍能清理持有管道的后代，不在 close 上死等。
4. 主动 detached/setsid 的后代可以逃逸。无论继承管道还是独立 stdio，都不能据组级观察宣称全树终止；负对照证明它仍可在随后放行时写入。
5. 真实公开 Pi loader + async runner 的 complete / stop-direct / stop-residual 路径持久化组证据与 unknown 全图证据；resume 被拒绝，任务文件保持不变。status 暂缺时，durable unknown proof 仍阻止恢复。

主测试为 `subagent-external-group.test.mjs`，自动通过 `fixtures/prepare-external-group.mjs` 复制固定产品与必要依赖、校验七个源码 preimage 的 SHA-256，再以 `--unidiff-zero` 检查并应用候选 patch。不要绕过这个基底检查直接应用零上下文补丁。所有真实写入仅在新建夹具目录；无真实模型或远端 API 调用。失败保留目录、日志和可用 metadata；独立测试清理只处理可核验 executable + 唯一脚本路径的本夹具 PID，不以历史 PID 补杀用户进程。

## 第三批实际验证（历史候选）

配置：macOS、Node 24.18.0、公开 Pi 0.85.1。运行前将 `ROTOM_PI` 设为该 package.json 的真实 `bin.pi` 绝对路径。

```sh
export ROTOM_PI=/absolute/path/to/pi-package/bin-entry
node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-external-group.test.mjs
rotom/bin/check-personal
```

| Gate | 结果与范围 |
|---|---|
| 候选定向套件 | 22/22、0 skip：12 个确定性检查、7 个真实 CLI、3 个公开 loader / async runner 场景。 |
| 原上游 external-cli-runner 单测 | 原测试文件复制到隔离候选，7/7；包括 argv/stdin、2 MiB stdout/stderr flush、日志写失败、非零退出、spawn error、timeout、stop。 |
| 既有 followthrough source 回归 | 对同一隔离候选执行，15/15、0 skip；等待、取消和 owner/unknown 合同。 |
| 候选完整源码 typecheck | PASS；沿用 ES2023、strict、noUncheckedIndexedAccess，用 Pi 0.85.1 公开类型。没有为了新语法提高包的编译 target。 |
| 当前产品 check-personal | 153/153、0 skip、footprint PASS。**这是未安装候选的产品 gate，不是候选完整产品验收。** |
| installed source 保持不变 | 209 个 TS 文件与固定 vendor archive 逐字节相同。 |

保留的失败：首次完整候选运行 18/20，有两例返回 unknown；其后观察到本机 load average 160，但首轮未记录细分探测原因，不能直接断言都是负载导致。增加证据记录和内核不存在快捷检查后，一轮仍为 18/20，捕获到 `Process group probe unavailable`；之后修正“非 ESRCH 探测失败只能由独立完整快照核验”的分层逻辑，并补确定性回归。没有提高探测超时或将 unknown 算作通过；补齐 preimage 回归后最终 22/22。第一次源码 typecheck 缺少公开 pi-tui / pi-ai/compat 类型映射，补齐映射后全源码通过。旧失败与临时证据不清除、不改写为 PASS。

## 为什么暂不更新依赖

这是执行/持久化合同变更，不是给 stop 多发一次信号：

- 通用 group controller 也服务 Pi writer；本轮没有完成其所有真实执行、并发与全图组合门禁。
- 保守 external unknown 会影响混合任务、resume 和清理/retention 语义，需要单独验收；本轮不迁移旧 observed 记录，不声称所有 result-only / 任意自定义 workflow 恢复或 fresh-run 路由均已覆盖。
- 未做 Linux 真机/容器验证、真实 Windows（只有 unsupported 分支检查）、真实模型或完整发布包验收。
- 进程组不是 sandbox；不能捕获任意 setsid/跨 session 后代、已经提交的远端写入或消除所有 PID/PGID 竞态。仅保存历史 PID 无法补出 ownership。

因此只交付可重放的隔离候选和证据，不改 `.2` 安装。若采用，需要补齐上述合同验证，再同步 package/lock/integrity 与 vendor archive，并在新会话中验证；不得把本提交描述成所有现有会话已获得进程树终止能力。

## 第四批：采用审查与实际修复

扩大检查确实找到第三批定向套件漏掉的四类问题，不是再补一轮 stop 提示：

1. **共享控制器取消退化**：首次 `ps` 不可用会在发送 TERM 前返回 unknown；TERM 后的一次不可用也会跳过 escalation。改为保持创建期 ownership 下的单次有界清理，等待 grace 后必要时 KILL；探测仍不可用则最终 unknown，绝不把失败读证据当成空组。新增失败回归，且原上游 TERM-resistant/短暂枚举失败真实进程测试通过。
2. **恢复入口漏检**：只有结果文件时，external 或混合结果可被选择为 revive；只剩 terminal candidate 时也没有 external 专用 fence。改为在 reconciliation 前读取固定结构化证据。Pi-only result fallback 仍保持既有内部合同。candidate-only 原来会因无 status 拒绝，本批将其明确归类为 external unknown，不把该项描述成已发生重放。
3. **子任务假未启动**：external 不计入 Pi `expectedWriters`，原投影把它标成 `not-started`。现在 external step 为 unknown，整个 external-unknown run 的 resumeDisposition 为 unavailable；组 observed 不再变成“没启动过”。
4. **retention 丢证据**：缺失 active marker 时，旧任务/孤立结果可因年龄被删除。本批保留 external 未核验证据，包括任务目录中的 durable candidate/proof 和 result-only。回归使用真实过期 mtime、有效 status，并断言具体保留原因，避免因夹具 malformed/recent 而假通过。

### 本批证据

- 新增回归先在第三批候选上失败，再修复。只剩 candidate 的测试失败是错误分类不同；result-only 与混合 index 则确实返回了 revive。retention 夹具最初被 recent/invalid-status 条件保护，修正夹具后两条均先失败，最终因 external evidence 保留。
- `subagent-external-group.test.mjs` + `subagent-external-lifecycle.test.mjs`：**32/32**，含 10 个真实 external CLI/公开 loader 场景；混合恢复、容量、retention 为合成生命周期证据，不是真实混合 writer 全图验收。
- 同一隔离候选的 followthrough **15/15**、lifeline **20/20**（6 个真实 Pi SDK + 本地 faux provider），合计 **67/67、无 skip**。
- 固定上游 `afa22c811f81883acdb248c84f116ac7534e2fb4` 的原始 `owned-process-tree`、`process-terminal`、`active-async-capacity`、`async-retention`、`async-resume`、`external-cli-runner` 六套测试在候选副本运行：**76 pass、0 fail、1 skip**。skip 是仅 Windows 的原测试；候选本地测试覆盖 unsupported 分支，但不算 Windows 真机。
- 完整候选源码 strict/noEmit + noUncheckedIndexedAccess / ES2023、三个维护脚本语法和 diff 检查 PASS。installed 的 **209 个 TS 文件**仍逐字节匹配 `.2` vendor archive。
- 未重跑当前产品 `check-personal`；本批没有改 runtime 安装，且工作区有并行 Qoder 接入，不把第三批的 153/153 或并行工作测试计入本批候选验收。

复现新增采用门禁（维护副本自动创建，不改 node_modules）：

```sh
export ROTOM_PI=/absolute/path/to/pi-package/bin-entry
node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-external-group.test.mjs \
  rotom/extensions/third-party/history/subagent-external-lifecycle.test.mjs
```

### 采用阻塞，不以测试数量替代决策

- **可用性代价已证明**：所有 external CLI（包括正常结束）都无法证明任意逃逸后代关闭。当前候选因此保留全图 unknown、拒绝 resume、保留 active capacity 和过期证据；有限并发槽位会逐步耗尽。混合任务同样受影响。不能未经产品决策就把该候选替换为默认运行时，也不能为了可用性伪造 observed 或释放 unknown writer 的槽位。
- **Linux 尚未验证**：本机 Docker daemon 不可用；尝试以不切换 context、不保存配置方式启动已有 Colima，发现既有磁盘布局与配置冲突（实际 100 GiB / 请求 60 GiB，拒绝 shrink）。第二次显式指定现有大小仍失败并报告旧 data disk 布局缺失。未删除/重建磁盘，未进入容器，停止扩大环境修复。
- 真实共享 Pi writer 的并发/混合/revive 全图组合仍需扩大验证；本批原控制器真实进程测试和合成生命周期矩阵不替代它。

采用审查后，用户选择先重设合同。设计与未来验收矩阵见 [External CLI 采用合同](../../../../docs/agent/subagent-external-adoption-contract.md)：区分受控资源容量与原任务恢复授权，保留组外 unknown；其首批实现和证据见 [第五批 owned-execution 候选](subagent-owned-execution.md)，以第二层 patch 独立存在，不改变本页第四批候选的保守行为。第五批只对有完整证明的 runner 释放，workflow/controller roster 尚未完成，采用仍阻塞。Linux 应使用明确授权的新隔离环境或修复已有环境后验证；当前不更新包、lock、integrity 或活跃会话。
