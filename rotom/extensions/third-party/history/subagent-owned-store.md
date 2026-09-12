# 第八批：显式存储 namespace 与跨版本 lease

**隔离候选验证通过；不是完整采用 PASS。** 当前安装仍为 `.2`。本批不改 installed source、archive、lock/integrity，不迁移会话、不推送、不调用远端模型，也不创建或修复 Linux VM。

**后续发现：** [第九批](subagent-owned-session.md)已用真实进程证实下述共享 v1 lease 可被旧 reader 在同组后代仍存活时 stale-reclaim。本页保留第八批历史合同和验证范围，不能据此原样采用；第九批改为绑定 session/lease 根的 v3 store 与旧 reader 不可读的 v2 lease。

接在[第七批 foreground 候选](subagent-owned-foreground.md)之后，第五层 `subagent-owned-store-candidate.patch` 修改十个精确 preimage、增加一个文件。`fixtures/prepare-owned-store.mjs` 只在私有副本校验并应用；前四层仍独立重放。

## 本批合同

`src/shared/execution-store.ts` 是一个不可变的存储身份标记，不是新任务 registry、调度服务或 Pi 生命周期。

- 未选择 `PI_SUBAGENTS_EXECUTION_SCOPE`：维持旧目录和旧运行语义，不初始化目录。
- 选择 `owned-process-groups-v2`：普通运行时**只读打开**已初始化的 store；缺目录/标记即拒绝，不自动初始化或回退旧 scope。
- 显式维护函数 `initializeExecutionStore(baseRoot)` 才能首次初始化。namespace 为 `<baseRoot>/owned-process-groups-v2`，私有 anchor 为 `<baseRoot>/.owned-process-groups-v2.json`。base 必须归当前用户所有且不允许 group/world 写；已有 0755 base 保留原 mode，不擅自 chmod。anchor 在 namespace 外，持久化 store ID、canonical 路径、base/namespace device 与 inode。
- 初始化只接受新 namespace。已有有效标记仅只读打开；损坏/丢失标记、已有未标记目录、删除 namespace 后留下的标记都不修复。标记用私有临时文件和原子 no-replace hard link 发布，不覆盖既有标记。
- 普通启动、配置、executor、容量读写、关闭证据与 lease 操作核对当前身份。配置文件单独设置 scope、无限容量、错误 store ID，都不能绕过启动期选择。scoped 配置损坏不能回退 `{}`。
- capacity owner、runner request/roster/proof、workflow 与 foreground 证明绑定同一 `storeId`。删除/篡改身份不成为零占用；旧 generation、未知 writer 与丢失证明原有 fence 不变。
- `TEMP_ROOT_DIR` 及其默认 runs/results/capacity 等子目录进入新 namespace；**canonical session lease 仍在共同 base 的 `session-leases`**，保持 v1 lease 格式。不能把同一 Pi session 拆成两个互不认识的锁。
- scoped async resume/transfer 不接纳缺少当前 store 关闭证明的旧记录；已允许的 Pi-only transfer 申请新槽时仍携带 scoped 身份，不退回 v1 owner。

初始化不是原任务恢复、旧 writer 关闭、业务效果确认或活跃会话迁移的授权。禁止把删目录/标记后重新初始化当作解锁手段。整个 base 被人为删除或重新配置、显式让旧二进制指向新目录，仍属于不支持的外部重绑定；这里不是文件系统 sandbox。不同自定义 base 不承诺共享 lease。

**公开启动/初始化入口尚未接入产品包。** 当前只有隔离候选里的维护函数，测试明确初始化新建的私有临时 base；不能直接让当前 `.2` 安装采用该环境变量。本批也没有完成 session-root/imported-root 的全部跨版本路由审查。

## 实际验证

macOS、Node 24.18.0、核验的公开 Pi 0.85.1；SDK 使用隔离 HOME、local faux provider、禁止 fetch，远端模型调用为零。

| 验证 | 当前结果 |
|---|---|
| 同一第五层候选组合回归 | **199/199，零 skip**：36 个新 storage/准备器检查、3 个新 SDK composite、前序 160 个检查。 |
| 历史第五/六/七批 SDK | **4/4**，各自原 scope 断言保留。 |
| 固定上游十一套 unit | **171 pass、0 fail、1 Windows-only skip**。 |
| 上游 single-execution integration | **219/219**，legacy 模式；沿用第七批明确披露的 readiness 测试补丁，不冒充未改上游。 |
| 类型 | 私有候选全 source strict/noEmit/ES2023/noUncheckedIndexedAccess 通过。 |
| 语法、链接、diff | 受影响 `.mjs`、文档引用及 `git diff --check` 检查。 |

新检查包含：

1. runtime open 不写新目录；删除 namespace 后，重启和维护初始化都拒绝重建空池。symlink、复制目录、public/corrupt/missing marker、base inode 替换均拒绝。
2. 容量 owner、runner request、workflow/foreground proof 的 foreign store ID 不放行；无限容量也不绕过 scope gate。
3. 用**逐字节核对的 `.2` 私有副本**运行旧 retention：它会删除故意暴露在旧目录中的 single-run scoped 未决记录，但不会发现或改动新 namespace 的记录，其未封存容量仍为 1。旧 workflow-reference 本来就有保护，不以此假称所有旧记录都会被删。
4. 旧/新 reader 共用 canonical lease，双向拒绝重复获取；两个独立 OS 进程同时争用，恰好一个成功，并在实际 release 与进程 close 后完成。
5. 真实 public SDK：config-only scope 请求在任何 writer 启动前拒绝；正常 external、取消/timeout、混合和默认 foreground workflow 均保留先前行为，关闭证明携带正确 store ID。owner-loss、controller crash、继承管道的逃逸负例仍保留容量。
6. 真 SDK 下校验环境选择的默认配置；损坏 JSON、未知 scope 均失败，不退回 legacy。
7. Pi-only 正面 native resume：释放原槽后仍生成当前 store 的 v2 证明；canonical session 相同，原 JSONL 内容保留并追加，真实 revival lease release acknowledged，随后释放新槽。没有把它替换成 fresh Pi 重跑。

36 个新 storage/准备器检查包含 synthetic artifact 与独立本机 Node/retention Worker；不能把全部数字称作真实模型测试。旧 reader 的 **209 个 TS 文件加 package.json** 由锁定 `.2` 归档的聚合 SHA256 `8fe0ee443eeedc633566b8575358609e952d69bf6971dcd21b80e26d1be022b6` 核对，复制后复核；Node 不在 installed `node_modules` 内做 type stripping。

### 中间失败与修正

- 撤回自动初始化中间方案：namespace 删除后的下一次启动不能重新获得空容量池。改为外置 anchor、显式初始化与只读 runtime open。
- 第一轮 storage **23/26**：Node 不支持直接 strip `node_modules` TS；复制目录的权限先触发拒绝。改用固定字节的旧源码私有副本，并使复制负例真正到达 canonical/inode 检查。
- 下一轮 **24/26**：夹具遗漏 lease 的必填 `sourceRunId`；旧 retention 因 workflow-reference 正确保留，未到达所需 single-run 负例。修正夹具，不放宽运行时。
- 扩展 focused 曾 **32/34**：两个夹具把可变的完整 capacity handle 当成绑定，`markWorkflowStarted` 后触发一致性拒绝。改成真实 producer 使用的三字段创建期 binding；拒绝和容量断言不变。
- 审查时补强基础候选准备器：不再只假定调用方提供 mkdtemp；要求私有且由当前用户拥有的目录、位于本仓库和 node_modules 之外，检查 canonical/大小写别名，独占创建 candidate/dependency 目录，拒绝既有目标与 dangling symlink。负例不改 installed 字节。
- 第七批两项 startup/fallback 波动仍无归因。本批完整 integration 通过不能解释历史 7/12 vs 2/12，也不把历史失败擦成成功。

## 重放与剩余工作

```sh
# 仓库根；ROTOM_PI 必须是核验的绝对公开 executable
node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-owned-store.test.mjs \
  rotom/extensions/third-party/history/subagent-owned-store-sdk.test.mjs
```

全量前序回归将原有 source overrides 及 `SUBAGENT_OWNED_FOREGROUND_SOURCE`、`SUBAGENT_OWNED_STORE_SOURCE` 指向同一第五层 candidate。`owned-store-test-runtime.mjs` 只给新层显式初始化测试 base；legacy-owner 负例在同一源码的独立 legacy 模式副本中生成，不能靠关闭生产 guard 来维持旧断言。

上游使用[第七批准备器及命令](subagent-owned-foreground.md#重放)，本批在清空凭据环境的 legacy 模式执行。新层 SDK 则在初始化后设置 scope，再启动独立进程。

仍需[采用合同](../../../docs/agent/subagent-external-adoption-contract.md)的 nested/controller 正面覆盖、worktree/gate/imported-root/external-job 路由、完整恢复/steer/attach 与并发组合、session-root 和公开初始化/披露接入，以及 Linux 真实进程验证。跨版本 lease 目前只验证所列互斥路径；旧 reader 的 stale-lease 回收与 owner-loss/存活组后代组合仍需审查，不能以 v1 格式共享就宣称未知资源无法被旧 reader 回收。完成前不生成发行 archive、不更新依赖、不升级活跃会话。
