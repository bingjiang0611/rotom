# Owner loss：完整 package workflow 验收

> 历史快照：`6b22cc0`，以下结果与摘要哈希对应当时文件。后续 harness 增加了启动门及 metadata 断言；当前第四候选与最新验证见 [启动确认实验](subagent-startup.md)。未开启实验门时，runtime omission 的继续写入反例仍成立。

## 结论

**有界进程路径 PASS；启动确认与整体可靠性仍 BLOCKED，不部署。**

本轮不再只测试 guard helper：真实 Pi SDK 加载完整 upstream extension，由公开 `subagent` workflow 启动真实 Pi CLI，再执行原生 Bash。父 SIGKILL、同一持久 session 的重开及合法 resume 拒绝均已验收。

同时修复了一个新发现：**已加载 runtime 的托管 POSIX child 丢失 lifeline 配置时，不得静默降级为无监护执行。** 但如果整个 child runtime 被漏加载，writer 仍能运行、父死后仍会写入。这个反例保留为阻断证据，不是“启动安全通过”。

安装仍为 `pi-subagents@0.52.1`。未修改 installed source、package/lock、产品资源或 Pi 源码；只更新隔离候选与维护测试。没有发布、推送、外部平台写入或付费模型调用。

## 实际链路与断言

1. 私有 HOME/auth/cwd、临时 Git 项目；禁止自动 context/skill/template discovery。固定 faux provider 产生一次 workflow tool call。
2. SDK 加载完整 `src/extension/index.ts`；调用 `workflowScript: return await runs.run(...)`，`async:true`、`mission:false`，单 writer、非 worktree。
3. 包自身的 foreground execution 启动经 package/bin/public-export 验证的真实 Pi CLI。fixture 只提供本地 provider，**不手动注册 guard，也不替换 child CLI**。
4. 验证实际 CLI、runtime argv、物理 cwd、父子 PID 关系。原生 Bash 使用 `exec Node writer`；ready/release 文件握手控制写入时机。
5. 独立 driver 对其拥有的 parent ChildProcess 发 SIGKILL。观察 CLI/writer，不把 `ps` 错误、超时或未知状态当成死亡。
6. 新 SDK 进程通过 `SessionManager.open` 打开同一私有 session 文件。通过实际注册的工具直接执行 status/resume；resume 带合法 message。检查 owner-unknown、磁盘 root 状态、run 目录集合和 child 数量，防止把参数错误当恢复隔离证明。

启动由 faux 模型驱动；重启后的管理调用由测试 driver 直接调用 SDK 中注册的真实工具，不是模型决策验收。基线不尝试已知不安全的 resume。

## 缺配置修复

第二阶段 `b880196` 的 guard 把未设置 `PI_SUBAGENT_OWNER_LIFELINE_FD` 当成可选模式。完整包 fault injection 证明：即使父已提供 pipe，移除该环境配置仍会启动 writer，父死后继续写。

当前 `subagent-lifeline-candidate.patch` 增加：

- helper 的内部 `required` 参数；必需但缺配置时在启动阶段请求 abort，并阻止工具 dispatch。
- 现有 child runtime 对 `PI_SUBAGENT_CHILD=1` 的 POSIX Pi child 设置 `required:true`。
- 未标记的独立使用者仍保持 opt-in；Windows 不启用该 pipe 合同。

候选的缺配置场景现在没有启动 writer，CLI/parent 均退出，root 为 `failed`。这与“owner 丢失但 writer 是否停止未知”不同，后者仍保留磁盘 `running`，不能自动改成 cancelled 或解除 unknown。

**这不是 reader-load acknowledgment。** 若 runtime 本身没加载，上述 required 检查也不会执行。

## 结果

2026-09-06，macOS / Node 24.18.0 / 公开 Pi SDK 与 CLI 0.85.1，faux provider、thinking off。只使用本地 faux，隔离凭证并阻断 `fetch`；不是网络或 OS 沙箱。外部评测模型请求 **0**，不包含协调会话用量，不报告 token/费用收益。

源：upstream `v0.52.1` / `afa22c811f81883acdb248c84f116ac7534e2fb4`，加 wait、owner-loss、lifeline 三个候选补丁；不是一个已发布的新版本。最终逐文件核对：安装的 **206** 个源文件与该 tag 一致；在私有副本重放三补丁后，**207** 个 TypeScript 源文件与受测隔离树一致；安装中没有新增 helper。

| 实际包场景 | 锁定 baseline | 当前 candidate |
| --- | --- | --- |
| healthy | 一次写入，root `complete`，退出 | 同样通过 |
| SIGKILL + 重开 session | writer 仍活；root 被改 `failed`；放行后写入 | 已知 writer/CLI 停止；无 late write；root 保持 `running`；status/resume 返回 owner-unknown；无第二次执行 |
| 缺 lifeline 配置 | writer 启动；父死后写入 | 启动即阻断；writer 未启动；root `failed` |
| **整个 runtime 被省略（限制反例）** | 父死后写入，root `failed` | **仍写入**；重启只隔离恢复，root 保持 `running/unknown` |

`omit-runtime` 在真正 CLI 的 preload 阶段移除 `--extension <child-runtime>`。它模拟 runtime 缺席，不声称覆盖每一种模块加载异常。其测试通过表示**正确重现不安全行为**。

| Gate | 实际结果 |
| --- | --- |
| 完整包 candidate | **7 pass / 0 fail / 0 skip**，exit 0；3 个本地/预检断言 + 上述 4 场景 |
| 完整包 baseline | **5 pass / 2 fail / 0 skip**，exit 1；失联、缺配置正例失败 |
| 更新后的 helper + 真实 SDK suite | **19 pass / 0 fail / 0 skip**；仍包含不合作工具继续写入的反例 |
| 隔离 upstream typecheck | PASS |
| 七个相关 upstream unit 文件 | **158 pass / 0 fail** |
| 三补丁组合的既有 wait 回归 | **55 pass / 0 fail** |
| 当前 `check-personal` | **98 pass / 0 fail / 19 历史 skip**；deterministicGate PASS |

最终完整包 pair：candidate 22.608 秒，baseline 40.884 秒。**不是速度提升证据**：baseline 等待缺失的停止证据，分支和等待时间不对称。helper suite 21.985 秒。fast 的 98 项包含主仓此前 `842aaa0` 的独立用例增加，不归功于本次候选。

### 夹具修正与边界

- 修正了不合法的 `clarify:false`、缺失 resume message，以及把磁盘状态 `complete` 写成 `completed` 的 oracle。修正前结果不作为产品缺陷。
- 最初 omission fault 也影响 Node writer 的 preload，导致 writer 自身启动失败；现限定真实 CLI 主线程，并加入独立回归，验证 Node tool descendants 不受该 fault 影响。不能把该夹具错误算成 guard 成功。
- 临时原生 session/状态用于真实重开；诊断只投影 metadata，不保留工具正文报告。确认已知 fixture 进程终止后异步清理；观察失败、身份无法确认或 accepted workflow 没有观察到 child 时，保留目录并报失败。
- 最终未发现匹配 fixture 命令的存活 Node 进程，当前 workflow 临时目录为零；结合逐例 PID 检查，而不是把目录消失单独当成终止证据。这不是全主机 orphan-process 证明，未清理历史失联目录。
- 仅证明这条单-child 包路径。没有验证当时完整的产品 extensions/launcher、真实模型决策、UI、全部 restart 时序、session switch、多个实际 manager/loader、非阻塞订阅迁移。
- 不合作工具、逃逸后代、远端/in-flight 写入、owner 挂起但 fd 未关闭仍未解决。`abort requested` 不等于全图终态。
- 此前 wait/control 的 8 项合同迁移失败仍未解除。本轮未重跑完整 upstream unit/integration/e2e；先前 integration 超时不能被定向通过覆盖。

## 重跑

从本仓根运行；`OWNER_WORKFLOW_SOURCE` 指向已按三补丁准备、依赖已安装的隔离 upstream 根。测试只读该源码，不修改安装或应用补丁。不能指向聚合 workspace。当前现成源树是 `rotom/evals/.eval/subagent-ab-20260905T133736Z/upstream-git`。

```bash
# 未显式给 Pi 时只有 3 个本地检查，4 个实际链路场景跳过。
node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-workflow-regression.test.mjs

# 完整包 baseline：预期 exit 1，两项失联/启动安全失败。
OWNER_WORKFLOW_PI=/absolute/path/to/pi \
  node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-workflow-regression.test.mjs

# 完整包 candidate；SOURCE 必须是隔离源树，不是 installed node_modules。
OWNER_WORKFLOW_PI=/absolute/path/to/pi \
OWNER_WORKFLOW_SOURCE=/absolute/path/to/isolated/pi-subagents \
  node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-workflow-regression.test.mjs
```

串行运行 process-heavy gate，不因超时盲目重放。Windows 跳过实际链路，不能计作验证。

当前 SHA-256：

- lifeline patch：`28733cd28d1c4dd6ba84d9d374600a627f64b437f79e3c211add2246bfa2daec`
- helper harness：`d9e38a9b8694e4c3dfcc69589cf917b8ed727c4ae9d076081399405eaa9aa978`
- workflow harness：`50d0ee0558b241cd1c77652666c982784e336b8c5fd48be0627d41bf6d396ebe`
- child provider：`985c4675a450ee798d4eff15e93e038abbd0644802ebcbc607ad6f7bce9006c7`
- no-network/fault preload：`a7817f70da4c74a2a62232e955cc4abf3e8eaca875af75530b31d1faed49888c`
- parent SDK fixture：`51b6dc404093d892c1ffc625e654160b25827c693f4ec38903fd7130fe9a7418`

## 下一步

优先建立**必需 child runtime 已就绪后才投递任务**的启动合同，并继续使用公开 Pi 生命周期；不是添加更多 PID 猜测或用超时冒充确认。然后补实际多-loader/manager、订阅恢复与完整 upstream gate。现有证据不足以部署，也不足以证明重写整个 subagent 系统更划算。
