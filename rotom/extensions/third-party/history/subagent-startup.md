# Owner loss：先确认 runtime，再投递任务

## 结论

**隔离启动门 PASS；整体采用仍 BLOCKED，不部署。**

第四候选补上了 [上一阶段](subagent-workflow.md) 的 runtime omission 缺口：实验模式中，子进程先启动为空闲 RPC 服务，父进程收到本次 runtime/reader 就绪通知并确认 RPC 空闲后，才发送一次任务。整个 runtime 被移除时，不再把任务预先放入 argv。

这是维护面、显式 opt-in 的候选，不是已经启用的产品能力。安装仍为 `pi-subagents@0.52.1`；没有改 installed source、package/lock、launcher、Pi 源码，也没有推送、发布、外部平台写入或付费评测模型调用。

## 最小实现与信任边界

- 在隔离 package 中设置 `PI_SUBAGENT_STARTUP_GATE=1`，仅改变 POSIX foreground Pi 路径。默认仍走原 `json -p`；Windows 实验入口拒绝，external CLI 等路径不在验证范围。
- `buildPiArgs({deferTask:true})` 不把任务放入 argv，也不生成 `task.md`。任务帧限制为 1 MiB，包含 JSON 转义。
- 每次 spawn 使用新的 UUID，清除继承的 startup token；fd 3 仍由直接 owner 提供。
- runtime 注册原有 hooks 后，通过公开 `session_start`、`ctx.mode` 和 `ctx.ui.setStatus` 发出 `ready:v1`。就绪 getter 必须已打开 reader，且未观察到 owner loss/shutdown。
- 父进程只接受当前 token 对应的 RPC status。确认前连 `get_state` 都不发送；确认后经公开 RPC 检查 `isStreaming=false`、`isCompacting=false`、`pendingMessageCount=0`，再投递唯一 `prompt`。
- 这是本进程管道上的关联确认，不是密码、远程证明、全 extension 健康证明或 OS 沙箱；其他受信扩展的自主副作用不由此隔离。
- 10 秒启动截止未确认就拒绝投递，并对本次拥有的 ChildProcess 请求结束。超时不是“已就绪”，终止请求不是全 writer 停止证明。
- 写入前先记录 dispatched；EPIPE、拒绝响应或未 settled 就关闭，不能授权重发。该实验路径禁用包自身的 startup retry 和 model fallback；不重写 Pi 原生 retry/compaction 生命周期。
- RPC 响应和 UI 控制帧不进入新增的任务 transcript 路径；启动 transport 错误只给固定分类，不复制错误正文。JSONL 按 LF 传输。
- 只在公开 `agent_settled` 后请求 `ctx.shutdown()`；`agent_end` 不触发强制 final drain。后续 activity 会撤销 settled 判断。取消、timeout、协议超限会关闭投递门，迟到的 ready 不得启动任务。
- 暂不支持 child fanout（显式拒绝）及交互式 RPC dialogs（拒绝，不自动批准）。RPC 的 `hasUI` 与 print 不同，不能据单子任务通过宣称组合语义完全兼容。

这是一条有界 one-shot RPC transport，不是新的 scheduler、agent loop 或持久化恢复系统。实验环境变量尚不是可跨 session/resume 迁移的产品策略。

## 实际 package 证据

当前证据限于 fresh、单子任务。Pi **0.85.1**、Node **24.18.0**、macOS；完整 upstream extension → 公开 workflow → 真实 Pi CLI → 原生 Bash。私有 HOME/auth/cwd/session、固定本地 faux provider、阻断 fetch；这不等于网络/OS 沙箱。0 次外部评测模型请求，不统计协调助手用量，不推断实际账单。

| 场景 | 实验门结果 |
|---|---|
| healthy | 一次 RPC input，正常写入一次，root `complete`，已知进程退出 |
| owner SIGKILL + 同文件重开 | CLI/writer 停止、没有后写；磁盘 root 保持 `running`；合法 status/resume 返回 owner-unknown，不产生第二次执行 |
| lifeline 配置缺失 | 0 input、0 子模型调用、0 writer；启动拒绝后已知进程退出 |
| 整个 runtime 被移除 | 0 input、0 子模型调用、0 writer；不能用可响应的裸 RPC CLI 替代 guard 就绪 |
| token 不匹配 | 0 input、0 子模型调用、0 writer；不能借用另一次启动的确认 |
| reader/runtime 加载前杀 owner | 在指定 CLI preload 的显式 barrier 处杀 parent，再释放加载；0 input/model/writer，已知 CLI 退出 |

input/model 次数使用递增 metadata 计数，不把单个覆盖写入的 marker 文件误当成“仅调用一次”；不记录 input 正文。

early-owner-loss 必须在 parent 启动后 5 秒内、子 CLI 仍活着且尚无 session-start 标记时杀 owner，早于 10 秒 gate deadline。初版等待 workflow handoff 的做法可能先触发启动超时；该初版结果不作为 owner-loss 证据。已改为直接用 bootstrap PID/barrier，并重新验证。Barrier 同时检查已存在的 release，避免 fs.watch 注册竞态。

同一隔离源码关闭实验门后重跑旧路径：**7/7**，但这包含预期的不安全反例：
- missing-lifeline：已投递 1 次 input，0 模型调用、0 writer。
- omit-runtime：owner 死后 writer 仍写入；恢复隔离不能撤回副作用。

因此“7/7”不是安全通过，也不能与新 9 项套件直接比较通过率或速度。

## 回归与未通过门禁

> 下表是 `f1ca13a` 阶段证据。后续八项 wait/control 旧合同已迁移，最新矩阵及完整 unit 的超时边界见 [上游测试合同迁移](subagent-upstream-contract.md)。其余采用阻塞不因此消失。

| 验证 | 结果 |
|---|---|
| startup 协议/参数/reader L1 | **21/21** |
| 完整 package，实验门 | **9/9**：3 个本地检查 + 6 个真实 package 场景，重复通过 |
| 完整 package，旧 transport | **7/7**，包含继续写入的限制复现 |
| lifeline helper + 实际 SDK，叠加第四 patch | **19/19**，包含 noncooperative 继续写入的预期负例 |
| 四 patch 组合 wait 严格回归 | **55/55** |
| upstream typecheck + 7 个定向 unit 文件 | **PASS，158/158**（未开启实验门的兼容检查） |
| `check-personal` | **98 pass / 0 fail / 19 历史 skip**，deterministicGate PASS |

21 项覆盖重复确认、错误 token/version、非空闲/不完整状态、未授权早期 activity、未支持 dialog、写失败/backpressure、拒绝响应、agent_end/settled、取消后迟到确认、任务帧上限与 argv/file 排除。L1 mock 不替代真实进程结果。

没有重跑完整 upstream unit/integration/E2E；之前八个 wait/control 候选失败、完整套件差异和 integration timeout **没有在本轮解决**。没有产品六 extension/launcher、真实模型、UI、Windows、完整 session-switch/multi-manager/非阻塞订阅迁移验收。

仍需解决：noncooperative/逃逸 writer、远端已在途副作用、owner 挂住但 fd 未关闭、可信全图终止确认，以及 RPC 下实际 retry/compaction、steering、嵌套工作与交互兼容。启动确认不能自动清除 unknown，也不使旧的错误 failed 记录可安全重放。

## 复现

只对 **v0.52.1 / `afa22c811f81883acdb248c84f116ac7534e2fb4` 的独立副本**，按 wait → owner-loss → lifeline → startup 顺序 `git apply --unidiff-zero` 四个候选。不要应用到安装目录。完整 package harness 只读取已经准备好、依赖可解析的源码，不负责安装或补 patch。

以下从 dev-agent 根运行；`SOURCE` 必须是独立 package 根，`PI` 是已验证的真实 Pi CLI executable：

```bash
node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-startup-regression.test.mjs

OWNER_WORKFLOW_STARTUP=1 OWNER_WORKFLOW_PI="$PI" OWNER_WORKFLOW_SOURCE="$SOURCE" \
  node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-workflow-regression.test.mjs

# 同源码关闭实验门；保留 omission 继续写入的限制复现。
OWNER_WORKFLOW_STARTUP=0 OWNER_WORKFLOW_PI="$PI" OWNER_WORKFLOW_SOURCE="$SOURCE" \
  node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-workflow-regression.test.mjs

SUBAGENT_STARTUP_CANDIDATE=1 SUBAGENT_LIFELINE_CANDIDATE=1 OWNER_LIFELINE_PI="$PI" \
  node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/subagent-lifeline-regression.test.mjs

SUBAGENT_WAIT_CANDIDATE=1 SUBAGENT_OWNER_LOSS_CANDIDATE=1 \
SUBAGENT_LIFELINE_CANDIDATE=1 SUBAGENT_STARTUP_CANDIDATE=1 SUBAGENT_WAIT_STRICT=1 \
  node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-wait-regression.test.mjs
```

测试串行；faux 不需业务凭证。真实检查是本机公开 SDK/CLI，不是手工加载 guard 冒充 package 验收。对未知进程身份拒绝信号/删除，保留不确定 fixture；不清理历史未知目录或 `.pi` 运行时状态。

## 交付身份

- 已独立重放四 patch：**208 个 TypeScript 文件**与实测隔离树逐字节一致。
- **206 个 installed source 文件**仍逐字节匹配原 upstream tag；两个新 helper 均未安装。
- 摘要哈希和最终清理证据见下节；没有保留或上传业务会话正文。

## 最终证据

最终 package 套件 9/9，47.768 秒；旧 transport 7/7，21.786 秒。案例数量和截止等待不同，这些时长不是性能 A/B。最后观察到 workflow/startup-unit 临时目录均为 0，未发现匹配 fixture 标记的 Node/Pi 命令；各案例先验证其已知进程退出才清理。这不是主机全图无 orphan 证明。首次补充扫描遇到其他进程 argv 非 UTF-8，不能据此判断已停止；改用字节匹配后完成扫描，没有因此发信号或清理未知目录。

SHA-256（路径相对本目录）：

| 文件 | SHA-256 |
|---|---|
| `subagent-startup-candidate.patch` | `09c15f7ae05a3faeaf87682d262b7e710f6fbdb7fe6134bfa82733ede7e448fe` |
| `subagent-startup-regression.test.mjs` | `cf5f7040bf6f6e8eb7b9f24a1aebb0827dc0db6f010913b07b1f09f350faaa58` |
| `subagent-workflow-regression.test.mjs` | `0c7983d81e37986d8818d8af0c5a02a59cfe143c217ddf8685478b5790e516ff` |
| `fixtures/workflow-child-provider.mjs` | `6543e345e10616c9ecc3cb267cdbc37bcb371550d40c791d0c2bd8c5d99e1a43` |
| `fixtures/workflow-no-network.mjs` | `a83da89eeba9aaec6a900bcac4acaf7cc43737a8a455752202c0982de213f57f` |
| `subagent-lifeline-regression.test.mjs` | `bfe849f952f4bc6cc34b08f528af40cb0d16c067ba83e062dfd4b7600be55128` |
| `subagent-wait-regression.test.mjs` | `a82e8da116f7a4427a1d7eac688d14f9c7d69a052d86aed919eb854da4804de0` |

本机 metadata 日志：`/tmp/dev-agent-startup-{unit,package-final,legacy,upstream,wait,fast}.log`。历史报告中的哈希只标识历史快照，不代表当前修改过的 harness。
