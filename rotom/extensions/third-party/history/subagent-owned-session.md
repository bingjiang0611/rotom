# 第九批：scoped session 路由与不可 stale-reclaim 的 lease

> 历史报告；下文安装状态与采用结论仅指该批。当前默认及旧命令的重放限制见 [历史索引](README.md)。

**隔离候选；仍未完成采用。** 当前 installed Subagent 仍为 `.2`，不改 archive、依赖、lock/integrity，不迁移活跃会话、不推送、不调用远端模型，本批未创建或修复 Linux VM；后续单独授权的 Linux 验证及类型门补正见[第十一批](subagent-owned-linux.md)。

接在[第八批](subagent-owned-store.md)之后，第六层 `subagent-owned-session-candidate.patch` 修改九个精确 preimage；`fixtures/prepare-owned-session.mjs` 只在私有副本校验并应用，保留历史层的独立重放。

## 发现的真实缺口

第八批共享 v1 lease 不足以隔离旧 reader：真实 owner 和直接 writer 被杀后，同组后代仍存活并能写入 late effect；未修改的 `.2` reader 却可以 stale-reclaim 原 lease。新负例同时运行第八批基线与第九批候选：两者均确认同组存活和 late effect，只有基线的旧 reader 能重新取得 lease。

因此，第八批不能原样采用。容量与 lease 都不能仅凭记录中的两个 PID 消失就释放。

## 本批合同

- store anchor 改为 **version 3**，额外绑定共同 `session-leases` 和 namespace 内 `sessions` 的 canonical path、device/inode。初始化创建或绑定私有目录；runtime 仍只读打开，删除/替换/symlink 后拒绝重建或降级。v2 store 不自动升级，v2 reader 也不能接纳 v3 store。
- scoped 新 child session 放在 `<base>/owned-process-groups-v2/sessions`，不再落到旧 parent-session discovery tree。extension、fanout、foreground executor 和 async single/chain 使用同一 root；显式/default session destination、resume、recovery 路径需在 scoped root 内且不得经过 symlink。不是把外部旧 session 导入新 epoch 的授权。
- canonical lease 仍共用 `<base>/session-leases`，但 scoped owner 写 **v2 + scope/storeId**；旧 `.2` reader 将其视为 unreadable，无法按旧 PID stale 规则回收。scoped reader 也不能 stale-reclaim v1 owner。legacy 模式继续写 v1，并保留其历史行为。
- lease root override 不能制造第二把锁；slot/owner symlink 不算 free；update/release 比较 owner 身份，而非只比较 token。冲突说明不建议换 run ID/session 重放。
- fresh async Pi writer 在 spawn 前独占创建 session 文件、获取并绑定 v2 lease；使用公开 Pi `--session` 初始化 JSONL，不伪造 header。已有文件仅允许同 run 的先前已证明关闭尝试继续；native revival 复用其已有 lease。
- writer roster 明确记录持有的 canonical session、ID/token 与 release acknowledgment，或声明 session-disabled。真实 close、controlled group closure 和真实 lease release 缺一不可；当前 canonical lease 不 free 时，不产生 ownedClosure observed。
- revival 的 finalization/exit 不能绕过 owned writer closure 释放 lease。resource-close eligibility 与 lease-free projection 分开，避免循环依赖。
- async Pi 与 foreground 一样，在 direct exit 后共享一次 group cleanup；受控组关闭后才启动有界 pipe drain。**强关管道不是真实 close**，不得生成 writer close、释放 lease 或容量。迟到的逃逸写入/退出也不补造先前缺失的观察。

这里只隔离已选择 store 的默认路由，不是文件系统 sandbox。人为配置另一个 base、显式用旧二进制打开新路径、复制会话/证明或删除锁都不构成授权。未知资源不以手工删目录解锁；公开初始化入口仍未接入产品。

## 实际验证

macOS、Node 24.18.0、核验公开 Pi 0.85.1；SDK 使用隔离 HOME、local faux、禁止 fetch，零远端模型调用。

| 验证 | 结果 |
|---|---|
| 同一候选组合 | **216/216，零 skip**：17 个 session 检查、3 个新 SDK composite、前序 196 个检查。 |
| 历史第五至八批 SDK | **7/7**，使用各自原候选。 |
| 修改过的历史 workflow/store 单测 | **65/65**，不把新 lease 格式强加给旧层。 |
| 固定上游十一套 unit | **171 pass、0 fail、1 Windows-only skip**。 |
| 上游 single-execution integration | 最终 **219/219**，legacy 模式，沿用已披露的第七批 readiness fixture adaptation。中间失败见下，不冒充未修改上游或稳定性归因。 |
| 类型 | 原临时 include 误指第八层，不能计为本批类型证据；第十一批已按本批实际 213 TS 重新通过 strict/noEmit/noUncheckedIndexedAccess，见更正记录。 |
| 语法、链接、diff、安装完整性 | 受影响 `.mjs`、本地 Markdown 引用与 diff 检查通过；installed 209 TS 与锁定 `.2` 归档逐字节一致。 |

17 个 focused 检查覆盖 anchor/目录版本与身份、scope 内外路径、lease symlink/override、owner 身份漂移、旧新 stale 语义以及两个真实进程反例。旧 reader 为逐字节验证的 `.2` 私有副本（209 TS + package.json），聚合 digest 与第八批相同。

新 SDK composite 保留正常 external、stop/timeout、native resume、mixed/default foreground、owner-loss 等路径，并新增：

1. 正常 Pi 的 proof 必须携带已释放 lease、正确 scoped session 路径，实际锁目录已消失；JSONL native resume 保留前缀并追加。
2. fresh async Pi 与 native revival 各自产生继承管道的逃逸者：task 可以结束，但 close 缺失、v2 lease 和容量保留；放行 late effect 并等逃逸者退出后仍保留。
3. owner-loss 前读取真实 v2 writer lease，controlled children 退出后 lease 仍存在；旧 injected session root 未被使用。
4. 新 v3 store 在真实 controller crash/restart 后仍保留未封存容量；config-only scope 选择在任何 writer 启动前拒绝。

### 中间失败与证据边界

- 第一轮前序重放 **123/129**：版本漂移夹具把新合法版本 3 当作错误；复制/替换目录夹具遗漏新增 lease/session 根；旧 reader 对 v2 应为 unreadable；synthetic Pi writer 未声明 session-disabled。更新夹具以到达原有断言，旧层单独重放通过；没有放宽运行时 admission。
- 审查发现 background Pi 仍可能把 guard 强关管道后的 Node close 当成观察。修正后以 fresh async 与真实 revival 两条 SDK 负例验证 lease/容量均保留，不仅检查源代码字符串。
- 上游完整 integration 曾 **218/219**：external workflow 子进程在原有约 2 秒 marker 等待结束时文件不存在。相同未修改测试在第八批基线独立运行也失败一次；基线随后两次、候选随后两次 focused 均通过，另一次保留 runtime 的基线 probe 通过且 runner/external stderr 为空。**未捕获原失败的子进程原因，不宣称已归因或修复。** 最终完整 219/219 不抹除该波动；第七批 startup/fallback 与历史 7/12 vs 2/12 也仍未归因。

## 重放与剩余工作

```sh
# 仓库根；ROTOM_PI 为已核验的绝对公开 executable
node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-owned-session.test.mjs \
  rotom/extensions/third-party/history/subagent-owned-session-sdk.test.mjs
```

同候选回归把前序 source overrides 和 `SUBAGENT_OWNED_SESSION_SOURCE` 指向第六层 candidate；不设置则独立重建历史层。上游沿用[第七批准备器和命令](subagent-owned-foreground.md#重放)，清空凭据环境并传播公开 runtime loader，不使用 PATH/global Pi。

仍需完成[采用矩阵](README.md#历史采用合同)：nested/imported-root/external-job/worktree/gate 正面 ownership、完整 recovery/attach/steer/并发 release-transfer 与披露、公开入口及 Linux 真实进程验证。当前结果不授权打发行归档、切换安装或宣布可采用。
