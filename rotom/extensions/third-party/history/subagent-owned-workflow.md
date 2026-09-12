# Owned workflow：第六批隔离候选

> 历史报告；下文安装状态与采用结论仅指该批。当前默认及旧命令的重放限制见 [历史索引](README.md)。

**状态：受支持的 async 子路径验证 PASS；完整采用仍 BLOCKED。** 第三层 `subagent-owned-workflow-candidate.patch` 基于 [第五批](subagent-owned-execution.md)，不改 `.2` 安装、vendor archive、依赖或活跃会话。无付费模型、发布、push 或 VM 修复。

后续[第七批 foreground 候选](subagent-owned-foreground.md)补了 fresh single Pi 的 foreground writer/group/lease 与双屏障。本文仍记录第六批及其独立历史测试，不把后续能力回填为当时已支持。

## 本批实现

复用现有 executor、workflow runtime、capacity owner 和 `process-terminal-candidate.json`，不新增调度服务或第二套生命周期。

1. **先登记，再执行**：workflow 在创建 worker 前持久化独立 controller instance 与父 capacity session/token/generation。每次 host launch 在调用 executor 前登记唯一 admission；已有 pre-spawn observer 再把真实 child run ID 绑定到该 admission。只有进程内 observer 能传递该绑定，调用者提供的 `workflowParentRunId`/`workflowKey` 不能借用父槽位或绕过登记。
2. **子证明带父身份**：async runner 的创建请求、roster 和 `ownedClosure` 携带 workflow/controller/admission/child 四项身份。父 reader 逐一核对子 status 的 run/session/parent、canonical 目录与带对应绑定的 owned proof；不以结果数组或 `status.steps` 代替创建期名单。
3. **controller 真实关闭**：`runWorkflowScript` 新增 scope-only 关闭回调。先停止接收新调用，再只请求一次 worker termination；仅在真实 worker `exit` 事件和所有已派发 launch/steer/status/state host Promise 完成后回调。任务结果可以先返回；未结束的 host 操作让证据继续 pending，而不是把完成结果无限阻塞或伪造 close。
4. **先持久化封存，再释放**：回调私有、原子封存 `ownedWorkflow`；新 owner 记录 controller identity。只有父任务终态、封存身份匹配、所有已登记 async child 的 owned proof 齐全才走既有 slot claim 释放。空名单也必须有真实 controller close。旧 v1 owner/reader 语义不变。
5. **释放不是恢复**：workflow 本身和已绑定 child 的 resume/transfer 均被 fence；不能换成 Pi child ID 绕过混合父任务限制。scoped workflow 的 steer/recovery 目前在派发前拒绝，避免未登记的替代 writer。result-only 沿用第五批 scope fence，retention 也识别 candidate-only 的 `ownedWorkflow`。

`ownedWorkflow` 使用 version 2 terminal candidate envelope；旧 v1 parser 不得误投影为 graph observed。它只证明受控 controller/登记关系，子证明仍保留组外后代与业务效果 `unverified`，不等于全图安全或业务回滚。

### 有意未放行

- **默认 foreground child（`async` 未设或为 false）仍保留槽位**，即使任务成功、controller 已关闭。它没有本批支持的 async writer proof；不偷偷把默认 child 改成 async receipt。
- resume、worktree、gate 或未绑定/启动失败的 admission 保留；完整 foreground、nested/imported roots、external-job 和多层 lease/revive 尚未验收。
- 父 controller 崩溃后没有关闭回调，就不补封存。Map 中找不到 controller、PID 已退出或重载 reader 都不构成关闭证明。
- 旧 retention 与新 scope 共目录使用仍不安全；采用前须解决旧 reader 的存储访问边界，不在本批迁移/停止活跃旧会话。

## 实际验证

macOS / Node 24.18.0 / 经核验的公共 Pi 0.85.1。所有写入在独立夹具目录；Pi 使用本地 faux provider 和 fetch 禁止钩子，不是远端模型 L3。

| 范围 | 结果 |
|---|---|
| 新 focused | **31/31**：24 项合成/本地文件检查、5 项真实 Node Worker 边界检查、2 项 SDK/独立进程综合夹具。 |
| 同一第六批候选回归 | 新 31 + 第五批 owned 34 + 既有 external/lifecycle/followthrough/lifeline 67 = **132/132，0 skip**。 |
| 第五批 SDK 旧合同 | 共用 driver 后单独在第五批重放 **1/1**，仍要求 workflow 槽位保留；不计为第六批运行结果。 |
| 固定上游原测试 | 原六套加 `scripted-workflow`，**148 pass、0 fail、1 Windows-only skip**；来源 `afa22c811f81883acdb248c84f116ac7534e2fb4`。 |
| 静态/安装 | 候选完整 strict/noEmit/ES2023/noUncheckedIndexedAccess、维护 JS 语法与 diff 检查 PASS；installed 209 个 TS 文件逐字节匹配 `.2` archive。 |

关键证据：

- 真正的 mixed async workflow 父先 complete，external child 仍运行时槽位保留；真实 Pi/external children 全关闭、父已封存后释放到 0。紧接着能启动独立 foreground workflow；后者成功但因缺 scoped foreground proof 保留槽位。
- SDK 检查实际 admission/controller/child 身份；伪造父 routing 字段在 executor 派发前被拒绝，external 启动计数仍为 1。分别尝试父 ID、Pi/external child alias 恢复均被拒绝，faux 调用数和 external 启动数不增加。
- coordinator crash 夹具先等待 Worker 发出 `OWNER_READY`，再仅对新建夹具进程自身发送一次 SIGKILL。新 reader 的 controller Map 为空，仍看到未封存名单并保留 capacity；该夹具没有启动模型 child，不冒充真实 nested writer crash 全图验证。
- 三个真实 Worker 场景让 run/status/state host Promise 晚于任务结果完成，关闭回调均不提前；真实超时的 Worker exit 与回调故障也分别验证。合成矩阵覆盖缺失/损坏/重复记录、token/generation/controller/child 身份漂移、目录漂移、未绑定 admission、TTL、重复关闭与只读恢复 fence。
- 开发首轮 focused 为 27/28：v2 workflow candidate 先进入了 v1 resume parser，虽然拒绝了恢复，但分类错误。将 workflow fence 移至 v1 parser 前后通过；没有把旧错误改成成功。补 child-alias 验证时另有一轮 30/31：external 已被更早的 native-resume 检查拒绝，夹具却只接受新 fence 文案；改为按 Pi/external 分别断言实际拒绝路径，继续核对调用数不增加，没有放宽运行时保护。

## 复现与基底

`fixtures/prepare-owned-workflow.mjs` 先重放第五批 helper，再核对六个文件的精确 SHA-256 和一个必须不存在的新文件；在私有副本用 `git apply --unidiff-zero --check` / apply。不得绕过 preimage gate；源码涉及七个文件。

先把 `ROTOM_PI` 设置为经核验的公共 Pi `bin.pi` 绝对路径，然后运行：

```sh
node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-owned-workflow.test.mjs \
  rotom/extensions/third-party/history/subagent-owned-workflow-sdk.test.mjs
```

原有回归可显式指向同一新副本：

```sh
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rotom-workflow-adoption.XXXXXX")"
export SUBAGENT_EXTERNAL_GROUP_SOURCE="$(node --input-type=module -e '
  import {prepareOwnedWorkflowCandidate} from "./rotom/extensions/third-party/fixtures/prepare-owned-workflow.mjs";
  console.log(prepareOwnedWorkflowCandidate(process.argv[1]));
' "$ROOT")"
export SUBAGENT_OWNED_EXECUTION_SOURCE="$SUBAGENT_EXTERNAL_GROUP_SOURCE"
export SUBAGENT_FOLLOWTHROUGH_SOURCE="$SUBAGENT_EXTERNAL_GROUP_SOURCE"
export SUBAGENT_LIFELINE_SOURCE="$SUBAGENT_EXTERNAL_GROUP_SOURCE"
node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-owned-execution.test.mjs \
  rotom/extensions/third-party/history/subagent-external-group.test.mjs \
  rotom/extensions/third-party/history/subagent-external-lifecycle.test.mjs \
  rotom/extensions/third-party/history/subagent-followthrough-regression.test.mjs \
  rotom/extensions/third-party/subagent/lifeline-regression.test.mjs
```

下一步是 foreground/nested 关闭证据、旧 reader 存储边界、并发/revive 扩大验证和经授权的 Linux 环境。没有运行当前产品 check-personal、完整/deferred footprint 或发布包 gate；并行 Qoder 的改动与检查不计入本批。完整完成线仍以 [采用合同](README.md#历史采用合同) 为准。
