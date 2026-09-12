# Subagent 故障归因与定向回归（2026-09-05）

> 历史报告；下文安装状态与采用结论仅指该批。当前默认及旧命令的重放限制见 [历史索引](README.md)。

## 当前结论

**继续修上游核心，不全量重写，也不在产品 wrapper 中吞通知。** 当前上游候选已通过本文件限定的 L1，尚未启用，不能宣布 Subagent 整体稳定或候选可上线。

- Baseline：维护仓 `e87c9f1` 所锁定的 `pi-subagents@0.52.1`；实际依赖与上一轮相同。
- Candidate：同一源码临时副本，仅应用同目录 `subagent-wait-candidate.patch`；当前安装和 lockfile 未改变。
- 当前 55 个确定性 L1 场景：baseline **19 通过 / 36 失败**；candidate **55 通过 / 0 失败**。新增 G05 来自真实 Pi L2：原候选混淆文件路径 owner 与原生 UUID，现复用上游 `resolveCurrentSessionId`。这是合同断言，不是用户任务成功率。
- 后续真实模型、取消、SIGKILL 重启及 worktree 并发结果见 [有界真实评测](subagent-live-eval.md)。局部通知改善已复现，但完整上游 gate 未绿，重启后继续写入风险仍存在，不建议部署。
- 上一轮固定 24 个场景为 baseline 16/24、初版候选 22/24；当前候选在这原有 24 个场景也全部通过。新增 29 个场景覆盖代际、恢复、投递边界和损坏状态，不能把扩大题集后的数字直接当上一轮增益。
- 本次只覆盖 **nonBlocking wait subscription**；阻塞式 `subagent_wait`、真实取消、进程恢复与并发写仍不在已修复声明内。

## 历史证据与归属

回看窗口为 2026-08-22T03:52:53Z 至 2026-09-05T03:52:53Z。本地 JSONL 只用于定位；不提交原始对话、工具正文、凭据或业务内容。主/子会话、fork 继承和生成的任务 prompt 会污染简单计数，因此不报告窗口内的总失败率。

| 本地 session 前缀 / 日期 | 可确认的现象 | 归属与限制 |
| --- | --- | --- |
| `01a032b9` / 08-24 | 等待工具连续在 13ms、4ms、29ms 返回 attention，同时子任务仍有活动 | 早于最近两天；不是“运行很久”等于挂死。这里只确认等待与活动记录，不反推当时安装版本 |
| `01a065db` / 09-03 | 19 次独立 wait-subscription 的 needs-attention 通知，父会话检查后反复 re-arm | 插件的 level-trigger 判定与调用方式形成反馈循环；不是一个 token 被重复投递 19 次 |
| 同上 / 09-03 | 未注册模型 ID；acceptance-report 字段/类型不符合合同 | 分别涉及模型选择和报告生成/验收合同；不能全算调度器错误 |
| `01a0665d` / 09-03 | workflow 达到两小时 timeout；子任务也记录 timeout | 超时可确认；现有证据不足以证明死锁、取消失败或 orphan process |
| `01a05c88` / 09-01 | 历史排查报告将四个 unknown 状态定位到另一套 Agent UI 的取消终态补采 | 另一套子代理链路；不是 pi-subagents 缺陷证据，本次未重做其外部日志验证 |

`mission:false` 被拒和 Browser guard 作用域过宽属于已修复的产品组合层问题（`2bb8b8d`），不能拿旧记录证明当前插件仍有同样问题。

## 可复现缺口

| ID | 合成输入与期望 | 0.52.1 观察 | 候选 |
| --- | --- | --- | --- |
| G01 | 同一 run、未变化的 attention，连续重新订阅；期望同一信号不反复驱动父会话 | 19 次 re-arm 产生 19 次唤醒；同一订阅反复 reconcile 则只通知一次 | 候选 L1 通过；attention 不消费终态订阅，re-arm 幂等，新信号仍通知 |
| G02 | complete / failed / paused / stopped / rejected 携带旧 attention；期望终态优先 | 五种情况均误报 needs attention | 五个断言通过 |
| G03 | 已完成步骤残留 attention，下一步骤正常运行；期望保持订阅 | 错把已结束步骤当作当前 attention | 一个断言通过 |
| G04 | sendMessage 在接受前明确抛异常；期望保留可恢复的持久证据 | 先删订阅再发送，失败后只记录错误，持久订阅已丢失 | 候选 L1 通过；先写 attempt、回读 receipt 后收尾，无证据则保留且不重发 |

G01 的测试重现历史循环的机制，但没有历史私有状态快照，不能证明每条历史通知都由同一个底层原因产生。G02–G04 是合成故障注入发现，**不是已经确认发生过的用户事故**。

原有 16 个对照断言覆盖：正常运行保持等待、同一订阅只通知一次、五种无污染终态、attention 清除后新信号仍可唤醒、活跃步骤 attention、foreground supervisor attention、等待超时不改任务状态、同 session 恢复、跨 session 隔离、目标缺失诚实报告、completion replay/archive 保留，以及 dispose 清理事件监听但不消费持久订阅。

## 候选合同与新回归

候选仅修改上游三个源文件：`runs/background/wait-subscriptions.ts`、`runs/shared/subagent-control.ts`、`shared/types.ts`，不增加产品 wrapper、调度器或 Pi lifecycle。

### Attention 是中间态，不是订阅结束

- 同一 session、targetKind、精确 run 的 re-arm 返回原 token，**不延长原 deadline**。到达终态/超时并完成投递确认才消费订阅。
- 持久化已观察的 attention digest；普通 lastUpdate、工具/turn 计数增长不产生新提醒。观测到清除后再进入 attention、新步骤或新 supervisor 调用可再次提醒。
- producer 为 control event 生成 UUID，跨 event/intercom 渠道及重放保持同一 ID；不是 supervisor request ID。同 timestamp 的新事件仍可区分。
- 每个订阅保存最近 64 个 control metadata digest，避免双渠道/晚到重放反复切换 generation。native/external supervisor 的真实消息、steering 和 completion 出口没有被拦截或合并。
- 恢复同 session 时保持 attention 和记账；不同 session 不继承订阅。已完成步骤的旧 attention 不影响下一步骤，五种终态优先于旧 attention。

### 先记录尝试，按回执收尾

```text
持久 subscription
  -> 写入 delivery {attemptId, outcome, state: unknown, attemptedAt}
  -> sendMessage（带 sessionId / token / runId / attemptId / outcome）
       抛异常或进程中断：保留 unknown；不自动重发
       返回成功：写 accepted（只说明 API 接受，不说明会话已落盘）
  -> 当前 session 的公开 getBranch 回读同坐标 custom_message
       找到：attention 保持订阅；终态才清除记录
       缺失/上下文不可用/其他分支：保留等待回执；不能把缺失当作未投递
```

- 在派发前持久化失败，可以重试持久化，因为没有调用 send；一旦尝试派发，错误不能证明未接受。
- accepted 标记写入失败、清理失败、接受后抛异常、重入 reconcile、恢复和晚到 receipt 均有定向测试；不会以“先发再删”冒充 exactly-once。
- receipt 同时绑定 session、token、run、attempt 和 outcome；五个错坐标及错误 session context 都不确认。公开 branch 中可见只证明 session state 存在该消息，不是文件 fsync、模型消费或用户看到的证明。
- v2 记录使旧版拒绝读取，避免旧版忽略新 delivery 字段而重放；v1 可迁移。可识别目标的损坏记录禁止该目标通过 re-arm 绕过。
- 新记录权限为 0600；保存 metadata/digest，不保存消息正文或异常正文。

新增测试均是合成状态、发送/公开会话接口桩和同步文件系统故障注入。没有杀真实 Pi 进程，不能将其称作真实 crash/restart 或消息队列 L2。

## 为什么不在 wrapper 中直接拦截

以下定位针对锁定包的 `src/`，只用于维护面诊断，不导入运行时产品：

- `runs/background/wait-subscriptions.ts`：`settle()` 删除订阅后才调用 `sendMessage`。每次 arm 的 token 是新的订阅 UUID，不是 attention 或 supervisor request 身份。
- wait message details 只有 token、runId、outcome 和可选 completions；没有产生 attention 的 step、reason、generation。
- `extension/control-notices.ts`：control details 有 event/run/step/reason/ts，但没有 supervisor request ID。
- `intercom/native-supervisor-channel.ts`：真实 `subagent_supervisor_request` 有请求 ID；外部 intercom 也可能拥有请求，native pending 为空不等于没有待答问题。
- `runs/background/notify.ts`：completion 消息实际没有 details；发送未抛异常会被视为接受成功。不能从正文猜 runId 去重，也不能吞 completion。
- steering、completion_guard、compaction-resume、失败、暂停、停止和 unknown/reconciliation 通知不是普通重复 attention，必须保留。

因此 runId-only、TTL 或正文 hash 去重都无法证明不丢新请求。把消息改为静默/下轮投递，也不能声称原订阅仍 armed 或未来一定唤醒。修复应进入拥有信号生成、订阅与持久状态的上游模块，而不是复制一套调度器进 Proxy。

## 执行方式

从仓库根运行；先按根 `CLAUDE.md` 安装锁定依赖。需要 Node >= 产品最低版本和 `git`。测试将 installed `src/` 复制到私有临时目录（Node 不在 node_modules 中剥离 TS），运行结束只清理本次创建的目录。所有状态、replay、timer/event fixture 都隔离；不启动子进程 agent、不访问模型、真实会话或 `.pi` 运行时目录。

```bash
# 诊断模式：TODO 仍执行并显示失败，但已知缺口不改变退出码。
# 不能把 baseline 的 exit 0 报成“55 个场景全过”。
node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-wait-regression.test.mjs

# 同一测试集，候选补丁只在临时副本中应用。
SUBAGENT_WAIT_CANDIDATE=1 node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-wait-regression.test.mjs

# 采纳前的严格门禁：当前 baseline 应 exit 1，36 个失败。
SUBAGENT_WAIT_STRICT=1 node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-wait-regression.test.mjs

# 当前 candidate 应 exit 0，55 通过，0 TODO / skipped。
SUBAGENT_WAIT_STRICT=1 SUBAGENT_WAIT_CANDIDATE=1 \
  node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-wait-regression.test.mjs
```

这些维护资源不进入 `rotom/runtime/product-config.mjs`、launcher 或日常产品组合。候选为 zero-context diff，测试用 `git apply --unidiff-zero` 只作用于临时副本。版本升级时必须重新分类 TODO，不自动放宽基线版本断言。不要把候选 patch 应用到 installed `node_modules`。

## 限制、下一步与替换条件

1. **阻塞式等待未改。** 08-24 的阻塞式 `subagent_wait` 毫秒级 attention 返回仍需单独回归；本候选不宣称所有等待入口都修复。
2. **单 owner 前提。** 现有模型是一个 session 的一个存活 manager；没有新增跨进程 CAS/锁，不证明同一 session 被多个 Pi 进程同时恢复时不重复投递。
3. **有界不等于全局 exactly-once。** 64 个 control replay key 以外的旧重放可能再次提示；旧事件无 UUID 时只能使用 metadata fallback，不能证明同 timestamp 的不同旧事件可分。新生产者 UUID 也不替代现有 producer 的通知路由/过滤合同。
4. **缺失 receipt 是保守停留，不是自动恢复成功。** 只查看当前 branch 最近 4096 个 entry；较早/别的分支/尚在队列的消息不能据缺失而重发。未确认记录不按外国 session 的过期 sweep 删除，可能长期保留；正式采纳前需要明确人工核对、retention 和损坏 JSON 无法归属时的运维流程。
5. 后续有界真实评测已补上上游 typecheck、公开 Pi SDK 和真实模型/子进程，但完整上游 gate 未绿，父进程死亡后的子进程与副作用仍不安全。需继续完成合同测试迁移、真实队列/恢复和遗留多 token 迁移；本文件的确定性测试本身仍不是 L2。
6. L2 和采纳门禁通过后，优先提交上游并锁定修复版本；依赖 version/lock integrity/product identity 同步更新。当前没有上传 issue/PR、启用 fork 或修改当前安装。
7. 若修复必须长期访问私有状态或重复 Pi 生命周期，才评估最小 public-SDK 替代；不复刻整个 workflow 框架。

## 上一轮验证边界（6b294fa；后续见有界真实评测）

- Decision：**PASS（候选定向 L1）；运行时改善仍 INCONCLUSIVE**。Profile：fast。
- Configuration：Node v24.18.0，macOS，本地合成 fixture，model/thinking 不适用；baseline/candidate 使用相同 53 场景。候选不含模型调用。
- 首轮完整 53 场景 strict：baseline 约 0.74 秒，candidate 约 0.85 秒；这不是用户任务延迟收益。
- 严格 paired delta：19/53 → 53/53；candidate 无 TODO/skipped。baseline 的 34 个失败是复现的缺口/新合同要求，不作为本次修复成功计数。
- 日常 `rotom/bin/check-personal`：96 通过、0 失败、19 个已停用历史 Safety/确认合同按原有测试设置跳过；工具面 deterministic gate 为 PASS。该命令不运行补丁后的上游，不代表候选已完成真实 Pi L2。
- 未做：真实 Chrome/手机、外部平台、付费模型 A/B、真实子代理取消/重启/并发文件覆盖验证。维护测试中的事件/发送桩不构成 L2/L3。
