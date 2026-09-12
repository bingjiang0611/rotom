# 第十二批：真实产品入口的 startup / wait / drain 收敛

**结论：隔离首版 `rotom@0.1.0-owned-flat.7` / `pi-subagents@0.52.1-dev-agent-owned-flat.7` 通过本批采用门，可供显式 opt-in 的新隔离会话使用。当前维护安装仍为 `followthrough.2`，未切换默认 scope、迁移会话、发布或推送。**

产品输入固定为 `fe95d07` 的 tracked tree；后续并行 Qoder WIP 没有混入。首版拓扑与风险仍以[采用合同](../../../docs/agent/subagent-external-adoption-contract.md)为准：组外后代和业务效果保持 unverified，释放受控容量不是 replay 许可。本批是实际 npm 安装、真实本机进程与本地 SSE/faux provider，不是远端模型、生产业务或 GUI 的 L3。

当前开发单源已内化到 [`packages/rotom-subagents`](../../../packages/rotom-subagents/README.md)，不再叠加本批 patch 生成新实现；本文及 `.7` 归档保留为历史验证基线。[内化交付记录](../../../docs/agent/subagent-source-maintenance.md)说明独立版本、构建与不迁移当前安装的边界。

## 产品入口找到的缺陷

SDK 的显式等待磁盘状态曾掩盖真实 CLI 间隙：launch receipt 已返回，但 detached runner 仍在冷启动，active index/status 尚未发布；立即 `subagent_wait` 返回 Nothing to wait，父进程退出后 child 才写出效果。

- `.0` 保留了原始失败。`.1/.2` 的 roster 补偿还错误地把 transport root 当作 async run identity；两者实际可以不同，不能按 nestedRoute 标签排除正常根任务。
- `.3` 的显式 wait 修复通过，但实际 headless 测试又证明 `auto-drain` 的独立 disk-only precheck 会跳过整个等待。
- `.4/.5` 补共享 precheck 与缺记录的终态 roster fence。`.5` 的真实 native resume 再暴露历史问题：新 run 合法持有同一 session lease 时，重新检查旧 run 的“当前 lease 必须空闲”条件使已观察的旧关闭被误判为 unknown；等待提前返回、fixture server 随父进程关闭，恢复 child 随后出现 Connection error。这不是远端 provider 故障。
- `.6` 区分历史关闭事实和当前 lease 授权检查，真实 native 恢复及 flat mixed/foreground workflow 在两种 OS 的实际 npm bin 上通过。但最终审查新增的合成同 PID / 不同 runner identity 反例令 `.6` 返回 Nothing to wait（17 pass / 1 fail），随后撤回 `.6` 采用结论。
- `.7` 把当前 runner identity 检查放到历史判断之前，并保留当前 reservation token/generation 绑定；只有真正 transferred source 使用其旧关闭事实。19 项定向测试及完整两平台验收通过。没有模拟成“真实 OS PID 已复用”。失败目录、归档和日志均保留；没有对失败 run 执行恢复、重放或清空状态。

## 最小 seam

[readiness patch](subagent-owned-readiness-candidate.patch) 是第八层维护补丁，叠加在 flat 候选上；[preparer](fixtures/prepare-owned-readiness.mjs) 检查四个精确 preimage，在现有私有临时根内生成候选，拒绝 installed source。

1. `activeRunsForSession` 复用既有 started-event roster，补偿未发布 status/index 的已接收任务；只处理当前 session / 本 namespace，区分 transport root 和实际 run dir。内存 terminal、磁盘记录缺失返回 unconfirmed，不当作空等待。
2. scoped wait 不把 task complete 当作资源关闭；workflow 与 capacity 共享同一个只读 controller/child closure predicate，保留 sealed roster、lineage、真实 foreground 双屏障与 child close 要求。无 capacity slot 不是关闭证明。
3. `auto-drain` 使用相同的 pending-work predicate；process-terminal event 也唤醒等待。不加 provider 延迟、固定 sleep 或新的调度 registry。
4. `ownedClosureWasObserved` 只用于 wait 的历史事实判断，仍需完整 owned proof、已记录的 lease release 与真实 group/close 形状。`ownedClosureObserved` 保留当前 canonical lease free 要求；capacity、recovery、transfer 没有改用历史谓词。新 lease 不会重开旧 writer 的历史关闭，也不能借历史事实授权新 writer；当前 admission 的 runner/capacity 绑定仍优先，PID 相等不是同一实例。

## 当前源验证

Node 24.18.0，公开 Pi 0.85.1；TypeScript 5.9.3。完整候选 **213 TS**，macOS/Linux `--listFilesOnly` 绑定同一源摘要：

`d01b37e59e17abb0f95e5d123ba59d33f903e5176fb29fb9f798373477c77826`

| 检查 | macOS | 独立 Linux VM |
|---|---:|---:|
| combined + 本批 SDK | 250/250 | 247/247 + 3/3 |
| 新 wait/drain 确定性单测（含在 combined） | 19/19 | 19/19 |
| 当前候选 SDK（含在上行） | 3/3 | 3/3 |
| 上游 unit + 新增 wait/drain unit | 233 pass / 1 skip | 232 pass / 2 skip |
| adapted 上游 single integration | 219/219 | 219/219 |
| 真实输入集 strict/noEmit | PASS | PASS |
| 实际 npm bin 六种模式 | PASS | PASS |

combined 中原 flat SDK 仍独立重建历史 flat；**不能**仅凭 source override 把这些结果归给新源。因此另有 [readiness-sdk](subagent-owned-readiness-sdk.test.mjs)，明确调用新 preparer：真实正常/stop/timeout/escape、Pi native resume、mixed workflow、foreground/stop/timeout、三类 pipe escape、owner-loss，以及 54 类 admission 拒绝/零 writer、SIGKILL 后未封存占用和 acknowledgment 不解锁。独立任务重复超过容量上限后可释放；unknown writer/lease 仍占用，旧未知工作不能恢复。

上游仍使用已注明的 readiness adaptations，不叫“未修改 upstream”。补充 wait/drain 两份 unit 以 [preparer](fixtures/prepare-readiness-upstream.mjs) 中 SHA256 固定；原 199 文件 pin 的范围不因此扩大。Linux 两个 skip 分别为 Windows-only 和无 native start probe 的平台用例；Linux 有 `/proc`。

### 实际产品而非 SDK 的验收

[owned-product-cli](fixtures/owned-product-cli.mjs) 只运行安装后的 npm `rotom` bin，通过隔离 HOME 的 `models.json` 注册 loopback SSE；不注入额外 Pi extension、不改 installed source。每次独立私有 store、业务 Git cwd、PATH 无全局 Pi、无真实账号/key，观测不落产品 trace。

六种模式：full immediate wait；full persistent parent；headless auto-drain；deferred + `search_tools`；Pi fresh + 已关闭 session 的 native resume；后台 controller 的 async Pi/external + fresh foreground Pi。断言包括 Unicode argv、业务 cwd（Pi 使用相对 read）、拒绝在 writer 前发生、真实 owned close/lineage、session 原字节保留并追加、lease release acknowledgment。每种 OS 都实际执行；全部 remote model calls 为 0。

macOS 另完成 default/full public-runtime smoke、distribution/runtime contracts **48/48**。独立 prefix 的 `.5`→`.6` 与最终 `.6`→`.7` 升级、公开版本入口、read-only store inspect、卸载均通过，安装外 v3 marker 的 SHA256 未改变；这不冒充存活 session 升级测试。

### 保留的失败与修正

- Linux 首次本批 combined **240/243**：两个 lifeline SDK JSON 结果在最终文件创建但尚未写完时被读取；一个单测原地同大小覆盖 status 与 metadata cache 相撞。fixture 改为原子发布，原断言未放宽；重跑旧组合 243/243，最终 `.7` 新组合 247/247。`lifeline-sdk-child.mjs` 的改动只属于测试发布协议。
- Linux `.6` 首次上游 integration **218/219**：external marker 已存在但内容仍为空。沿用原断言，只移至真正的 runner terminal publication 之后；两种 OS 最终 219/219。先前其他历史波动仍不据此归因。
- 一次误发无文件列表的 `node --test` 自动发现了无关 Vitest/Browser 测试并超时；确认无该测试进程残留，不计有效门禁。另一次 macOS upstream 未隔离 HOME/Pi 环境，出现参数/配额偏差；改用 `env -i` 和隔离 HOME 后完整通过。这些执行错误不是候选的 PASS。
- 原维护 Pi dist executable 被外部改动移除时，显式 version probe 拒绝；改用独立安装的 Pi 0.85.1 经同一 identity gate 验证，不走 PATH/global fallback。
- 安装遇到 ETIMEDOUT / offline ENOTCACHED 时保留日志，只在安装阶段使用既有无凭据代理；运行验证不继承代理。未修改旧默认 Colima VM、磁盘、Docker context 或共享范围。

## 私有发行身份

实际产物经 `pack:release` 隔离 HOME/cache 和 fresh locked install 构建；没有复制维护者 node_modules。archive、package、lock、product-config version/integrity 在私有产品副本同步，公开 Pi pin 不变。

| 产物 | 字节 | SHA256 |
|---|---:|---|
| `rotom-0.1.0-owned-flat.7.tgz` | 9353335 | `0f90e34d2faa02827026552f370a173564f12d5aa935ca78b49955719855fb34` |
| `pi-subagents-0.52.1-dev-agent-owned-flat.7.tgz` | 979109 | `89a2ff72d0615becb937ee28eac54efcbcab2983ab7e29d4a50fe11f2c7ed9c6` |

Product integrity：`sha512-q3GdG35yxsgeQ5FCo13o7WEy/jx/wDUQwpNcRAnEyYgGpQIn67bq3Ns40QuvtKQB4N4fJlL+1uBFULhJBvj9fw==`。

Subagent integrity：`sha512-bTImsA6KBQ2bVj3BemtoVgSb7Hq6lvo1Eyy6aMEu4NbUUTibpP0os7TlH6c1BzPjzGk1rZMeRsAJqccQ+iHBZw==`。

Product pack 3803 files；实际 artifact audit 展开内嵌归档共 4052 entries、0 findings。Subagent pack 248 files / 213 TS，audit 249 entries、0 findings，无 tests、public-runtime-loader、node_modules 或 session。扫描不是任意秘密/所有权无风险证明，不是发布授权。

本机交付目录 `/tmp/rotom-owned-flat.7/` 含两份归档、manifest、SHA256SUMS 与新隔离安装说明。详细私有根由 `/tmp/rotom-owned-adoption-root` 指向；日志 `readiness-combined-final-v7.log`、`readiness-upstream-{unit,integration}-final-v7.log`、`readiness-types-v7.log`、`product-v7-*.log`、`product-smoke-v7-{0,1}.log`、`product-contract-v7.log`、`upgrade-v7-*.log`。Linux 原件在独立 VM 的 `owned-validation/readiness-v7-*.log` / `product-v7-*.log`。归档 `.0` 至 `.6` 均不作为当前采用产物。

只在新私有 prefix、新 store、新进程采用。保持 `private:true`，不推送、不发布、不更新当前安装；初始化 acknowledgment 不解除既有 unknown。Windows、远端模型/业务效果、真实 GUI 与存活会话升级没有因此得到验证。
