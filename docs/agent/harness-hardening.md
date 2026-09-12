# Harness hardening：组合层回归与证据

> 本页为分批历史记录，`.2` 安装、工具数量/字节和采用阻塞只属于对应快照。当前内化组件及 scope 见 [scoped 默认](subagent-owned-default.md)。源码/测试路径已按重构同步，但当前 harness 不等于旧实验输入；重放限制见 [历史索引](../../rotom/extensions/third-party/history/README.md)。

第 1–4 节及首个验证小节记录第一批，后续小节按批次记录。历史失败和验证数量不互相覆盖。

范围：借鉴 Harness Playbook 的状态与执行证据边界，不复制 Pi 生命周期、不新增工具、不改变默认能力面、不调用付费模型。实现入口仍为既有 observability / third-party wrapper / context footprint；未升级第三方包、未改 installed source。

## 1. Subagent：结果不是执行终止

该批固定 `pi-subagents@0.52.1-dev-agent-followthrough.2`。

对上游 commit `afa22c811f81883acdb248c84f116ac7534e2fb4` 的 `test/integration/single-execution.test.ts` 中 `runs an external CLI workflow child with subagents.defaultModel configured` 做隔离复现：

- 原断言先等父 workflow 结果，再以 100 × 20 ms 等 external marker；`afterEach` 随后删除工作目录。
- 本轮 baseline 和当前源码都复现 marker ENOENT。保留的 child status 表明：external Node 已启动，但写 marker 时目录已由失败测试 teardown 删除。父结果完成不构成 child 完成屏障；固定短窗口会把启动延迟变成 teardown 竞态。
- 独立回归 `rotom/extensions/third-party/subagent/external-cli-evidence.test.mjs` 用真实 external Node writer 的 ready/release 握手固定这个先后关系：父 `complete`、child `running`、marker 不存在；显式放行后才有 marker、external exit 0 和直接 runner 的 `observed` 证据。先确认该受控夹具关闭，才删除夹具目录。
- 这是独立回归，**没有延长原测试窗口使其变绿**。它定位了当前复现的失败链路，但不能解释历史 7/12 对 2/12 的频率差异，也不把历史候选评估升级成 PASS。未因此修改依赖、放宽产品限额或上线新的终止机制。

`rotom/extensions/third-party/subagent/policy.ts` 在该批仅投影已返回的结构化证据：启动回执、workflow/wait 结果和 process-terminal 各自说明其范围，保留原始 `details`、正文和错误标记，不解析 prose、不改任务状态、不自动恢复/重放。`observed` 仍不等于整棵进程树或远端副作用结束。失败的 admission 不标成启动回执。

## 2. 状态生命周期合同

| 状态 | 权威来源 | tree / replacement 语义 |
|---|---|---|
| Deferred capability | 当前分支 `dev-agent-deferred-tools-state` custom entries | 存活 runtime 的 tree 导航不卸载工具；new/resume/fork/reload 创建的新 runtime 只按选中分支恢复。导航本身不把旧分支 discovery 复制到新分支；新分支再次 search 可显式记录当前能力。显式 tools policy 保持优先。 |
| Ask continuation | 当前问答的显式 `continueExecution` 与 generation | 不持久化续跑意图。取消、树导航、切换、reload/shutdown 后失效；迟到答案不能重启旧意图。选择停止/仅记录偏好时，既不补跑，也不向模型追加要求继续的文字。 |
| Browser observation/ref/epoch | 当前 relay 观察与 owner | 不是可回放的会话状态；恢复历史不恢复 ref 有效性。沿用既有 stale/unknown/只读核验边界。 |
| Subagent publication | 当前 Pi factory 的不可复活 lease | shutdown 起拒绝迟到发布；拒绝发布不意味着底层工作已停止。历史任务状态是核验入口，不是重跑授权。 |
| Trace measurement | 当前 runtime 的可选观测 | 不作为任务权威；新 runtime 重置比较窗口，无法测量的样本中断 digest 连续性。 |

已补充 deterministic 矩阵与真实公开 Pi runtime 的 fork/reload/tree/new/resume 回归。不能把 live tree 的 additive 行为误报成权限撤销失败，也不能承诺在未记录 discovery 的分支上 reload 后仍保留全部内存能力。

## 3. 独立结果证据

Observability 只按固定字段读取 allowlisted metadata：

- `pi.tool.dispatch_acknowledged`
- `pi.tool.execution_outcome`、`pi.tool.verification_status`、`pi.tool.business_outcome`
- `pi.tool.process_terminal_state`（来自 `details.lifecycleStatus.processTerminal`）
- `pi.tool.content_complete`、`pi.tool.result_truncated`

缺少截断字段时省略 `result_truncated`，不再伪造 `false`；同时识别 Pi `details.truncation.truncated`。`truncated=false` 也不意味着全文完整。Browser 的 `unverified`、Computer Use 的 `unknown/didnt` 或失败后置条件不再被 span 分类为成功。工具查询正常返回与任务/进程/业务成功仍是不同事实。

这些字段是报告的证据，不是观测器自行验证的外部事实；不读取任务文件补齐缺证，不记录错误、工具、schema 正文或凭据。现有禁用、no-session、私有权限、有界写入与 partial dashboard 窗口规则不变。

## 4. 工具面：先量化，不盲目缩减

在 `before_provider_headers` 通过公开 `getActiveTools/getAllTools` 采样有序 active 名称和 `{name,description,parameters}`：记录数量、UTF-8 bytes、两个 digest 和相邻有效样本的 `schema_changed`。最多 256 active tools、1 MiB schema 序列；异常或超限返回 unavailable，不阻断模型请求。未记录名称列表、描述、参数 schema、prompt 或 HTTP headers。

`pi.tools.measurement=public-metadata-not-wire`：该数据**不是** provider 序列化后的请求、实际 token、cache miss 或成本证明；compaction 等请求也不能据 active roster 推断实际发送了工具。schema 未变也不代表 system prompt 未变。

维护报告增加 description/parameter bytes 与重复 guideline 的 digest/次数，不输出重复正文。Pi 可能去重最终 prompt，因此元数据重复不能当成可节省的 prompt token。

该批公开 loader 测量（Pi 0.85.1；无模型请求）：

| 模式 | Active tools | Schema bytes | Guideline bytes |
|---|---:|---:|---:|
| 默认 deferred | 19 | 16,853 | 8,264 |
| `ROTOM_DEFERRED_TOOLS=0` | 20 | 31,507 | 10,193 |

full 没有 `search_tools`，但多两个 Subagent 工具。默认 schema 中 Computer Use 7,814 bytes、Ask 4,047 bytes。发现 7 组重复 guideline 元数据，额外字节合计 1,366；它们包含跨工具必要约束，**本批不删除约束，不改默认工具 roster**。未来是否延迟加载 Computer Use 或精简 schema，需要单独的产品合同决策与明确授权的模型 A/B。

## 验证与复现

先把 `ROTOM_PI` 指向与当前 package.json 的 `bin.pi` 一致的绝对 executable；本地 Pi 构建中它可能是 `dist/bundle/cli.js`，不能用同目录的 `dist/cli.js` 冒充通过 executable identity gate。

```sh
export ROTOM_PI=/absolute/path/to/pi-package/bin-entry
rotom/bin/check-personal
node --test --test-concurrency=1 rotom/runtime/verify-pi-runtime.test.mjs
node rotom/runtime/report-context-footprint.mjs "$ROTOM_PI" "$PWD/rotom"
ROTOM_DEFERRED_TOOLS=0 \
  node rotom/runtime/report-context-footprint.mjs "$ROTOM_PI" "$PWD/rotom"
```

本轮：check-personal 130/130（无 skip），runtime identity 32/32；default/full footprint 和 public loader 均 PASS；受影响运行时 TS 的 strict/noEmit 检查、脚本语法检查及 `git diff --check` 通过。原始 marker gate 的失败、夹具初次直接 jiti 缺 peer/ESM resolution 失败以及第一次误选非 bin executable 的 identity 失败均保留；改用公开 ResourceLoader 与正确 bin 后完成上述验证。

早期定向试跑还使用过 eval 包中的 Pi 0.84.3；最终结论以 Pi 0.85.1 的重跑为准。不声称修复任意孤儿进程、跨进程 exactly-once、远端一致性或提升模型成功率；未运行付费 A/B、真实 Chrome、原生 GUI 或 Windows 验证。未推送或发布。

## 第二批：无模型取消、失联与残留写入回归

**Decision：定向回归 PASS；完整取消与历史 flaky 因果仍 INCONCLUSIVE。** 仍使用 Pi 0.85.1 / Subagent `.2`，不改包、archive、默认工具 schema 或 installed source，不做 dashboard 和付费模型 A/B。

### 实际覆盖

将原维护面 `subagent-lifeline-regression.test.mjs` 的默认入口迁移到当前固定 `.2`，不再因默认期待旧 `0.52.1` 而无法运行。默认复制 installed source 到隔离临时目录（Node 不剥离 node_modules 内的 TS），不重放历史补丁。历史 baseline / 预补丁源码仅可通过显式 `SUBAGENT_LIFELINE_SOURCE` 指定，不能把产品源码冒充 baseline。

该套件现有 14 个底层合同检查，以及 6 个真实公开 Pi SDK + 本地 faux provider 场景：

| 场景 | 本轮观察与断言 |
|---|---|
| healthy | 放行后 writer 正常完成；健康 lifeline 不钉住 SDK 进程。 |
| owner-loss | SIGKILL 本夹具 owner；确认 guard 请求 abort 后，合作的 Bash 工具及其受控后代退出，放行不再产生写入。 |
| cascade | 中间 owner 仍存活时向下一层传递 pipe 失联，验证受控后代收敛。 |
| early-loss | 启动前 owner 消失，工具没有启动。 |
| cancel | owner 保持存活，通过真实 `session.abort()` 取消已 ready 的 Bash 工具；受控后代退出、没有迟到写入。 |
| noncooperative | 工具明确收到 AbortSignal，但不遵守它；先确认收到取消，再放行，仍能写入。**这是残留风险的负对照，不是取消成功。** |

取消由文件/pipe 握手触发，noncooperative 不再靠等待若干秒猜测 abort 是否发生。夹具使用净化环境、独立 HOME、禁止网络的 faux provider、独立硬 deadline；失败时保留 cwd/证据，不因未知启动状态删除可能仍被使用的目录。清理只针对可核验脚本路径的本夹具进程。迟到发布隔离继续由 `rotom/extensions/third-party/subagent/publication.test.ts` 与真实 runtime ownership/notifier 回归验证；拒绝发布不意味着底层 writer 停止。

### 新确认的 external CLI 缺口与本批修复

`rotom/extensions/third-party/subagent/external-cli-evidence.test.mjs` 在该批覆盖 complete、stop-direct、stop-residual 三种真实本机 external CLI 情况：

1. complete 保留第一批“父先完成、child 后完成”的独立握手回归。
2. stop-direct 验证停止直接 CLI：实际 `action=stop` 只派发一次；随后 child `stopped`、external SIGTERM 与 runner `observed`，放行不再写入。
3. stop-residual 让 CLI 创建一个独立 stdio 的受控后代。**即使 child 已 `stopped` 且 runner 已 `observed`，后代仍存活；此后放行仍能写入。** 最后独立确认该后代退出，才清理成功夹具。

已沿代码定位边界：`src/runs/shared/external-cli-runner.ts` 的 stop/timeout 只对直接 ChildProcess 发信号；process-terminal 的 writer 证明跟踪的是 Pi writer，不覆盖该 external CLI 自行创建的后代。因而不能将这个 `observed` 外推成 external 进程树关闭。

必要的组合层修复在 `rotom/extensions/third-party/subagent/policy.ts`：过去普通 stop management 回执没有 lifecycle 字段，会绕过第一批证据提示；现在单独识别非错误 stop 返回，明确说明它不证明取消收敛或 writer 终止。保留原始 details、正文和失败标记，不追加 follow-up、不重放 stop、不制造新的任务状态或调用 kill。

**本批没有修复任意 external 后代终止。** wrapper 没有该进程树的创建期 ownership/进程组证据，不能事后靠历史 PID 补杀。真正收敛需要在第三方执行路径的创建、取消、close 和 proof 合同上一并实现并验证；不以本地 warning 替代这种修复，也不直接改 installed source。

### 对历史失败率的进一步核验

在独立握手夹具中做了 4 组交替先后顺序的 baseline/product 配对，每次 fresh HOME/TMP、同一公开 Pi、无真实模型调用。记录“观察到父 complete → writer ready”的墙钟差值：

| Pair | Baseline ms | Product `.2` ms |
|---|---:|---:|
| 1 | 1148 | 1142 |
| 2 | 1193 | 1193 |
| 3 | 1402 | 1334 |
| 4 | 1329 | 1275 |

8 个受控夹具均完成并核验退出。本轮没有重现明显的产品启动拖慢；**这不是原上游 marker gate，也不是统计显著性/因果证明**。观察受文件轮询和本机负载影响；baseline 没有 `.2` 的 terminal proof，只独立核验本夹具 runner 退出，不能伪造 `observed`。历史 7/12 对 2/12 保持未归因，未改原测试或将原 gate 宣称为 PASS。`timing.json` 和 source digest 仅用于这次隔离诊断，不是生产性能或 token 收益。

### 第二批验证

```sh
export ROTOM_PI=/absolute/path/to/pi-package/bin-entry
node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/subagent/lifeline-regression.test.mjs \
  rotom/extensions/third-party/subagent/external-cli-evidence.test.mjs \
  rotom/extensions/third-party/subagent/publication.test.ts
rotom/bin/check-personal
```

上述取消/失联套件已纳入 check-personal。最终 **153/153、0 fail、0 skip**；default/full footprint 与真实 public loader PASS，受影响运行时 TS strict/noEmit、脚本语法和 diff 检查 PASS。此轮未重跑第一批的整文件 runtime identity 32 项，不把旧结果计为新测试。无真实模型、远端平台、Chrome/GUI、Windows 或生产进程操作；没有包发布或推送。

## 第三批：隔离源码中的 external 进程组候选

已实现创建期 POSIX 进程组、一次性 TERM/KILL/核验、直接进程先退出时的同组后代清理，以及组级/全图证据分离。主动脱离组的后代仍属于 unknown，不能自动恢复成替代 writer。定向 22/22、原 external CLI 7/7、followthrough 15/15、候选全源码类型检查通过；当前产品门禁仍为 153/153。

**暂不更新锁定依赖或已安装运行时。** 通用 group controller、混合任务/恢复及跨平台的扩大门禁尚未完成；不得将这些候选结果称为产品已启用。方案、失败记录、验证和采用条件见 [External CLI 进程组候选](../../rotom/extensions/third-party/history/subagent-external-group.md)。

## 第四批：采用审查，发现并修复候选缺口

候选补上共享控制器在探测暂不可用时仍执行有界取消、result-only/混合恢复 fence、external step 假 `not-started` 投影，以及 active index 缺失后的 retention 保证。新增采用测试与候选 followthrough/lifeline 合计 67/67；原上游六套测试 76 pass、1 Windows-only skip；完整候选类型检查通过。未改 `.2` 安装，未将第三批产品门禁计为本批验证。

**采用仍 BLOCKED，而不是继续按定向 PASS 自动安装**：保守 external unknown 会保留并发槽位、阻止 resume 并保留过期记录，正常完成的 external CLI 也受影响；需要明确产品取舍。Linux 本机容器环境启动受既有 Colima 磁盘布局冲突阻塞，未修磁盘或冒充已验证。真实共享 Pi writer 并发/混合恢复仍有缺口。详见上述候选文档的第四批记录。
