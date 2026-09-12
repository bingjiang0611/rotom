# Subagent 有界真实评测（2026-09-05）

## 结论

**局部 wait 改善成立；不建议替换当前安装，不宣布整体稳定。**

真实 L2 找到了原候选的 session identity 缺陷，修正后两次配对均减少重复 attention，并保留完成订阅通知。但父进程 SIGKILL 后，任务被判为 failed，原 Bash 子进程仍继续执行并写入；baseline、原候选、修正候选均如此。上游完整 gate 也未通过。

本轮没有发布、推送、提交上游 PR、替换当前安装或执行外部平台写入。

## 配置与证据等级

- 用户授权：最多 2 小时、模型预算 20 美元；13:37:36Z 开始，15:37:36Z 截止。
- 维护基线：`6b294fa`；installed `pi-subagents@0.52.1` 未改。
- 隔离 baseline：Git archive 产品副本及锁定 npm ci。
- 原候选：补丁源码单独打包为 `0.52.1-dev-agent-wait-eval.1`，仅在隔离产品副本同步 package/lock/integrity/product-config 后 npm ci。
- 修正候选：同样方式构建 `0.52.1-dev-agent-wait-eval.2`。没有手改任何 installed node_modules。
- Node 24.18.0 / macOS；实际公开 Pi runtime **0.85.1**，不是 eval package 声明的 0.84.3。
- 模型固定 `openai-codex/gpt-5.4-mini`，thinking=off，父输出上限 512；真实既有 Codex 认证。首个请求因未启用 Node 环境代理而 fetch failed；设置 `NODE_USE_ENV_PROXY=1` 后同模型通过。失败请求单独保留计数，不混入有效配对。
- SDK 验证真实产品资源身份，加载六 extensions；关闭自动 Skill/template/context discovery，使用被动父 prompt。父调用由外部 driver 精确控制，真实子进程/模型执行子任务；这不是自主业务任务 benchmark。
- 非阻塞订阅需要 `ctx.hasUI`。attention 用例通过公开 SDK 绑定 RPC 模式 UI adapter，仅接收状态更新，意外对话框直接失败；真实 sendMessage、公开 SessionManager branch 和模型响应均执行。**不是实际 TUI 视觉验收**。
- 普通完成、stop、SIGKILL 重启、worktree 用例使用 print SDK。print 模式不支持 nonBlocking 注册，因此重启用例不构成非阻塞订阅迁移证明。
- 本机私有、ignored 评测根：`rotom/evals/.eval/subagent-ab-20260905T133736Z/`。`metrics.json`、gate metadata、`evidence-index.json` 保存选定指标、源码/原生日志 digest。提取后已清理本轮完成的临时原生会话及输出日志；它们不再是可 resume 的留存会话。未触碰用户历史会话或受保护 `.pi` 目录。
- 收尾停止了本轮本地 fixture server，核对无仍引用评测根的 Node runtime。未对整个宿主机作无 orphan 的保证。

## A/B：真实 attention 压力用例

子任务运行固定 45 秒的本地 Node 工具；首次真实 attention 后，driver 再订阅同一 run 四次。两个有效配对 trial 3/4 的顺序分别为 candidate→baseline、baseline→candidate。原候选失败的 trial 2 不并入修正候选结果。

| 指标（每次均值，n=2/组） | baseline | 修正候选 | 观察 |
| --- | ---: | ---: | --- |
| 父会话 total tokens（含 cacheRead） | 31,180 | 18,699 | −40.0% |
| 父＋子 total tokens（含 cacheRead） | 48,198 | 35,448 | −26.5% |
| 父 assistant turns | 8 | 5 | −37.5% |
| 同一 attention 的订阅通知 | 5 | 1 | −80% |
| 完成订阅通知 | 0/2 | 2/2 | 修正候选均收到 |
| 子任务实际完成 | 2/2 | 2/2 | 没有任务完成率提升证据 |
| workflow 实际耗时 | 57.007 秒 | 57.564 秒 | +1.0%，无提速证据 |
| 父＋子目录价格估算 | $0.014291 | $0.011946 | −16.4%，受 cache 分布影响 |

逐次父/子总 tokens：baseline 48,344 / 48,052；修正候选 35,589 / 35,307。逐次 workflow 耗时：58.613 / 55.401 秒，对应 59.527 / 55.600 秒。

限制：这刻意放大历史重订阅循环，是机制压力测试，不是随机任务样本。baseline 仍有独立 `subagent-notify` 完成出口，不能把“无 wait 完成通知”写成完全丢失结果。driver 对缺失完成订阅通知额外等待 15 秒，因此 **driver 总墙钟不可直接作为性能收益**；上表使用运行状态中的 workflow 起止时间。不同缓存命中、极小样本及共享宿主负载均不支持外推总体成本或延迟。

全轮已报告模型 usage（含预检及失败候选，不含本次主协调会话）：108 条去重 assistant 消息，1 条 error，551,715 total tokens（input 219,864 / output 5,195 / cacheRead 326,656）。目录价格合计 **$0.212775**。这是模型目录费率计算，不是账单；实际美元扣费 **UNKNOWN**，中断或失败请求未返回的 usage 也不能补造。

## 真实生命周期与文件安全

| 用例 | baseline | 原候选 | 修正候选 | 验收依据 |
| --- | --- | --- | --- | --- |
| 普通求和写文件 | PASS | PASS | PASS | 独立读取 result.json，sum=6 |
| stop 取消运行中的工具 | PASS | PASS | PASS | stop 已受理、目标 Node PID 消失、state=stopped、未写 done |
| 父进程 SIGKILL 后重启 | FAIL | FAIL | FAIL | 同一 session / run 恢复，无重复 root run，但 failed 后子进程仍执行并写入 |
| 两 writer 的 worktree 隔离 | PASS | PASS | PASS | 不同实际 child cwd；各自产生 A/B 修改；主工作树 ORIGINAL 保持不变 |

- stop 到目标工具进程消失分别约 12.3ms / 32.5ms / 7.9ms；每组仅一次，不作性能比较，也不据单个工具 PID 声称已穷尽整个进程树。
- 初始两次对 workflow root 使用 `interrupt` 被拒，按错误层级调用处理，不算取消实现失败；随后使用文档规定的 root `stop`。两次误用的持有工具均按已核对的唯一 fixture 进程身份清理。
- crash 用外部 driver 对自己创建的父进程发送 SIGKILL，再由新 OS 进程 `SessionManager.open` 同一文件。状态记录的 runtime PID 就是被杀父 PID。重启观察为 failed、原工具存活、doneCount=0；稍后仍为 failed，但 doneCount=1。这是**任务终态与实际副作用不一致**的实测，不是模拟 timer/replay。
- 持有工具本身有限时；最终核对其已结束。没有自动重启或重放任务，没有重复写入。**failed 不代表此时可以安全重试**。
- 并发初版 oracle 错误地期待完成后还保留 worktree；包会回收 worktree 并保存 diff。随后验证实际不同 cwd、两个独立 patch 与主树不变，baseline/原候选 patch 均独立 apply 验证。修正候选同样保留两个只修改 shared.txt 的 A/B patch。
- 未让两个 agent 直接覆盖同一物理 cwd，也未自动合并冲突 patch。这里证明的是 worktree 隔离，不是共享 cwd 的锁或冲突自动解决。

## G05：真实 L2 发现并修正的候选缺陷

包的 `currentSessionId` 采用 `getSessionFile() ?? getSessionId()`；原候选 receipt 校验只调用 `getSessionId()`。文件路径 owner 与原生 UUID 不相等，真实消息虽进入公开 branch，候选仍保留 accepted，四次 re-arm 全报错且没有终态订阅通知。

修正仅复用上游已有 `resolveCurrentSessionId`，不引入第二套身份规则。新增两个确定性回归：文件 owner 与 UUID 不同仍确认 receipt；foreign file 即使 UUID 匹配也不能确认。

- 同一新增 55 题：修正前候选 **53 pass / 2 fail**；修正后 **55 pass / 0 fail**。
- baseline strict：**19 pass / 36 fail**，exit 1，0 TODO；不是用户任务失败数。
- 原候选少发消息的表面 token 降低不算优化，因为当时 receipt 流程已卡住。

## 上游及本地 gates

> 本节保留当时结果。后续已完成八项定向旧合同的迁移及反事实验证，见 [上游测试合同迁移](subagent-upstream-contract.md)；完整门禁仍未通过，不能把历史数值当成本轮重跑结果。

上游 tag `v0.52.1`，commit `afa22c811f81883acdb248c84f116ac7534e2fb4`；三个改动源文件与 installed baseline 字节一致。单独 clone/npm ci，不改当前依赖。

| Gate | baseline | 修正候选 |
| --- | --- | --- |
| upstream typecheck | PASS | PASS |
| upstream unit（原脚本默认并发、继承环境） | 2197 pass / 13 fail / 3 skip | 2187 pass / 23 fail / 3 skip |
| upstream integration（原脚本默认并发、继承环境） | 684 pass / 7 fail | 683 pass / 8 fail |
| upstream E2E | 0 tests；suite 因 shim 不可用而跳过 | 同左，不是 E2E PASS |
| 清理 PI_SUBAGENT 环境、串行运行 wait/control/spawn 三组 | 42 pass / 0 fail | 34 pass / 8 fail |

首轮完整上游 gate 使用了原 npm scripts 的默认并发，且继承 `PI_SUBAGENT_MAX_SPAWNS_PER_SESSION`、`PI_SUBAGENT_PARENT_SESSION`。因此不能将所有失败或两组差值归因于补丁。清理环境的定向重跑消除了 baseline 失败；候选仍有 8 个 control/wait 合同失败，涉及新增事件 ID 与改为 receipt 后清理的语义。**没有跳过这些失败来宣称可上线**；上游测试迁移及完整干净环境 gate 仍是采纳阻塞项。

本仓：55 题候选 strict 全过；`check-personal` 96 pass / 0 fail / 19 个既有历史 Safety/确认测试 skip，deterministicGate PASS。它不覆盖补丁后的完整上游。

## Chrome、手机及桌面

| 对象 | 实际观察 | 结论 |
| --- | --- | --- |
| Chrome relay | 本地隔离 fixture 创建并首次渲染成功；后续 owned tab 丢失；原 tab recover 一次仍失败 | 交互 BLOCKED；未绕过 relay、重建标签冒充恢复 |
| iPhone | go-ios 无设备；已配对设备 tunnel unavailable；WDA 无响应 | 真机 BLOCKED；未修复配对/重装/操作业务 App |
| Etch | 初始可观察；动作时原窗口消失；重新定位新 PID 后未获得预期控件，等待超时 | 未完成交互验收，不判 App 功能失败 |
| Nib | 后续窗口 pairing low，AXApplication 递归直到 2000 节点上限 | 无可靠控件绑定，未盲点或修改业务文件 |
| 外部终端 App | 未获得可控窗口 | 未执行交互验收 |

这些不是 wait 补丁的配对 UI 结果。没有完成“真实 Chrome＋手机＋三个 App 全路径验收”，不能填成通过。

## 下一步

1. 保留当前安装；修正候选继续仅做维护面评测。
2. 优先给“父死亡后 failed 但副作用仍继续”建立进程树/终态联合合同，失败态应诚实反映未收敛执行，不允许盲目重试。后续无付费第一阶段见 [owner-loss 止损候选](subagent-owner-loss.md)：拒绝错误终态与直接 root resume，但尚未停止孤儿进程。
3. 更新受影响上游合同测试，在干净环境串行完成全部门禁；补真实非阻塞恢复、多 token 迁移和未知投递的运维策略。
4. 恢复 Chrome ownership / 原生 AX / 真机连接后另做真实 UI 验收。
5. 当前结果仍不足以证明重写执行器更便宜；若修复需要持续复制私有生命周期，再评估窄 public-SDK executor。
