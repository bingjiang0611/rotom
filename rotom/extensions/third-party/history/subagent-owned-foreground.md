# 第七批：foreground workflow 的独立关闭证明

> 历史报告；下文安装状态与采用结论仅指该批。当前默认及旧命令的重放限制见 [历史索引](README.md)。

**隔离候选验证通过；完整采用仍未完成，产品继续安装 `.2`。** 本批接在[第六批](subagent-owned-workflow.md)后，不改 installed source、不迁移存活会话、不推送、不调用远端模型。用户本轮选择先完成本地实现，未授权创建 Linux VM。

后续[第八批存储候选](subagent-owned-store.md)补了显式初始化、只读打开与跨版本 lease；本文仍保留第七批的独立合同和验证结果。

## 实现边界

- 第四层 `subagent-owned-foreground-candidate.patch`：七个精确 preimage 与一个新文件；只经 `prepare-owned-foreground.mjs` 在私有副本应用。前面三层及各自历史 SDK 断言仍独立保留。
- 默认 foreground child **仍等待原来的结果**，没有转换成 async receipt。workflow 创建期 admission 增加 foreground kind，绑定真实 child run ID。
- 新 `owned-foreground.ts` 在现有 `process-terminal-candidate.json` 内保存 `ownedForeground`，不是第二个任务 registry。foreground controller 用 admission identity，不伪造 runner OS-process close。
- 每个 Pi attempt 在 spawn 前登记；新建空 session 文件使用 `wx`，由公开 Pi `--session` 初始化，不手写 Pi header、不截断 forked session。先获得既有 canonical session lease，再启动独立 POSIX 组。
- 实际 `close`、受控组终止和真实 lease release acknowledgement 全部齐备后才能关闭 writer。直接 writer 关闭时立即禁用 detach/interrupt，再等待组核验；多次取消请求共享同一 bounded cleanup。
- 两个独立屏障：host dispatch 返回，以及 authoritative `runSync` pipeline（含 detached completion）结束。早到的 detach receipt 不是 pipeline 结束；已关闭 pipeline 不再登记新 attempt，但允许已登记 writer 的真实晚到 close。
- child directory 拒绝 symlink，持久化 canonical directory identity，拒绝跨目录导入证明；lease 必须属于该 child/workflow。丢证据、身份漂移、写盘失败、lease active/unreadable 都不释放。
- 恢复 fence 覆盖 ID、前缀、目录和已知 session alias；父 admission 及 scoped status/result 只作**拒绝重放**的证据，不能补造关闭证明。子 candidate、父 candidate/status 丢失后，result-only lineage 仍阻止启动替代 writer。
- `descendantCoverage`、`effectVerification` 保持 `unverified`。逃逸进程持有管道时，bounded 强关 stdio **不生成** writer close，lease/容量保持未决；后来逃逸进程退出也不回填丢失的观察。

仅支持 fresh single Pi foreground child。worktree、gate、resume 等尚未绑定的 admission 继续保留容量；观察到 `subagent` tool invocation 时先标记 coverage unavailable。标记写失败会在内存中先置不可恢复的 coverage 标志，后续成功写入 pipeline barrier 不能遗忘它。**nested 的正面关闭证明尚未实现。**

## 实际验证

环境：macOS、Node 24.18.0、显式核验的公开 Pi 0.85.1。真实 SDK 使用独立 HOME、local faux provider、禁止 fetch；不把 mock/faux 当远端模型或业务服务验证。

| 范围 | 结果 |
|---|---|
| 同一第四层候选回归 | **161/161，0 skip**：新增 30 个 synthetic/local 检查、1 个真实 SDK composite；前序 130 个回归。 |
| 历史第五/六批 SDK | **3/3**；原来的 workflow/foreground 保守断言不因新实现而改绿。 |
| 固定上游十一套 unit | **171 pass、0 fail、1 Windows-only skip**。新增 session lease、foreground control、detach reconcile、stdio guard；其余沿用前批七套。 |
| 上游 single-execution integration | 当前版本 **219/219，0 skip**，使用本地 mock CLI；一项 intercom 夹具作明确的 readiness 修正，另两项仅增加失败诊断，见下文。不是未修改上游的完整 PASS。 |
| 类型/语法 | 私有候选全 source strict/noEmit/ES2023/noUncheckedIndexedAccess；受影响 `.mjs` 的 `node --check` 通过。 |
| 准备器负例 | installed target 拒绝；上游 fixture 漂移在写入前拒绝，目标测试文件保持不变。 |
| 安装隔离 | installed **209 个 TS 文件**与锁定 `.2` 归档逐字节相同。 |

SDK 除前序 normal/stop/timeout/escape、Pi-only、混合 workflow、owner-loss 外，还实际验证：

1. 同一 session、limit=1 下两次独立的默认 foreground workflow 均正常完成并释放；未替换等待语义。
2. foreground tool 已开始后 stop 与 timeout，真实 controller/writer/group/lease 关闭后释放。任务取消不是业务回滚。
3. foreground 逃逸后代继承管道：父任务可完成，但容量保留；通过夹具自己的 release 文件，观察到逃逸后代的晚到 marker 写入，随后等待其退出，容量仍不回填释放。
4. ID/prefix/dir 的 resume/steer 拒绝，faux 调用数不增加；删除已关闭夹具的 child candidate、父 candidate/status 后，result-only resume 仍拒绝且无新调用。

Windows 分支只做 synthetic unsupported 检查；没有 Windows 真机或 Linux 结果。

### 失败记录与测试适配

- 首轮 foreground 无法获得新 session 的 canonical lease，因为文件尚不存在；修正为独占创建空文件，再走公开 CLI 初始化，未绕过 lease。
- 夹具曾错误使用旧 `@sinclair/typebox` 包名；改为从核验 Pi 的依赖布局解析公开 `typebox`。retention 单测也修正了 `now` 回调及遗漏的 `await`。
- 扩大测试初次未把 public-exports resolver 传给后台子进程，外部 child marker 未出现；准备器现在生成 resolver，使用 `NODE_OPTIONS` 传递，不用 PATH/global Pi 替代真实 SDK 验证。
- 原 intercom 夹具的 500ms 启动窗口在第六批基线连续 **3/3 失败**。独立 `subagent-foreground-readiness-test.patch` 保留原断言，改为观察 mock startup、显式释放 quiet child、等待 detached completion，并设置夹具 deadline。
- 另有一轮 integration **217/219**（两个 startup/fallback 检查失败），未取得当时的具体结果错误，**不能认定原因或声称已修复**。补充 failure-only diagnostics 后，基线/候选定向各三轮均通过，完整复验也通过；保留该未归因记录，后续采用门须继续检查。这里不解释或消除历史 7/12 vs 2/12。

## 重放

先核对 `ROTOM_PI` 是绝对、已核验的公开 executable，不使用 PATH launcher。维护面直接运行：

```sh
node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-owned-foreground.test.mjs \
  rotom/extensions/third-party/history/subagent-owned-foreground-sdk.test.mjs
```

完整前序回归把 `SUBAGENT_EXTERNAL_GROUP_SOURCE`、`SUBAGENT_OWNED_EXECUTION_SOURCE`、`SUBAGENT_OWNED_WORKFLOW_SOURCE`、`SUBAGENT_LIFELINE_SOURCE`、`SUBAGENT_FOLLOWTHROUGH_SOURCE` 指向同一第四层私有 candidate。历史 SDK 则继续各自重建旧层。

上游来源固定为 `nicobailon/pi-subagents@afa22c811f81883acdb248c84f116ac7534e2fb4`。`prepareForegroundUpstreamTests({ source, upstream, executable })`（`fixtures/prepare-foreground-upstream.mjs`）核验所用 **199 个 test/support/fixture 文件**的聚合 digest，复制测试并应用单独的测试补丁；不安装 peer、不改上游/installed source。它返回 public resolver 路径。以隔离 HOME、清空凭据环境、`NODE_OPTIONS=--import=<返回的 loader>` 运行：

```sh
# cwd 为私有 candidate；不是仓库根或 node_modules
node --experimental-strip-types --import ./test/support/isolated-temp-root.mjs \
  --test --test-concurrency=1 test/unit/{owned-process-tree,process-terminal,active-async-capacity,async-retention,async-resume,external-cli-runner,scripted-workflow,session-lease,workflow-detach-reconcile,foreground-control,close-grace-timer}.test.ts
node --experimental-strip-types --import ./test/support/register-loader.mjs \
  --test --test-concurrency=1 test/integration/single-execution.test.ts
```

## 剩余采用门

[采用合同](README.md#历史采用合同)仍适用：nested/imported-root/external-job、worktree/gate 等 coverage；旧 reader 存储隔离；完整 recovery/attach/steer 与并发 release/transfer；用户可见 scope 披露；Linux 真实进程验证。未通过前不生成新发行 archive、不更新 version/lock/integrity、不切换当前安装。
