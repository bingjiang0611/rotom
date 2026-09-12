# Owned execution：第五批隔离候选

> 历史报告；下文安装状态与采用结论仅指该批。当前默认及旧命令的重放限制见 [历史索引](README.md)。

**状态：本机候选验证 PASS，完整采用仍 BLOCKED。** 这是 [采用合同](README.md#历史采用合同) 的首批实现，不是运行时升级；当前安装仍为 `pi-subagents@0.52.1-dev-agent-followthrough.2`，无付费调用、发布、push 或活跃会话迁移。

第六批已在独立第三层补入受支持的 async workflow/controller 证据，见 [owned-workflow 候选](subagent-owned-workflow.md)。本页及第二层 patch 保留第五批合同，默认 foreground/nested 与完整采用仍未完成。

## 实现边界

`subagent-owned-execution-candidate.patch` 是 [第四批候选](subagent-external-group.md) 之上的第二层；`fixtures/prepare-owned-execution.mjs` 先应用已校验的第四批，再核对十个源码 SHA-256 和一个必须不存在的新文件，最后在私有副本以 `git apply --unidiff-zero --check` / apply 应用零上下文 patch；不得绕过 preimage gate。共涉及上游 `src/` 的十一个文件，不编辑 installed source。

- **显式 opt-in**：候选配置 `asyncExecutionScope: "owned-process-groups-v2"` 只用于新建 run/owner。旧 owner 不因新 sidecar 自动迁移，旧 v1 proof 仍按旧语义读取。新 scoped capacity owner 使用 version 2，旧 capacity reader 将其保留为 occupied/unreadable，不套用旧释放 shortcut。
- **创建期 roster**：`owned-execution.ts` 复用 `process-terminal-candidate.json`。runner 开始 scope；每次 Pi/external spawn 前同步、私有、原子登记 writer identity、kind、step、attempt；真实 close 与组核验分别记录；runner 终局 seal。新登记/重复 close/错误身份/损坏持久化 fail closed。不是另一套 registry 或调度生命周期。
- **独立关闭证据**：原 terminal envelope 中增加 v2 `ownedClosure`，绑定 run、runner、roster 和 capacity session/token/generation；要求 runner close、所有 writer close、组正面核验以及已有 lease release 条件成立。`descendantCoverage`、`effectVerification` 始终 `unverified`；external v1 全图仍 `unknown`。
- **仅释放已证明的 runner 槽位**：沿用既有 slot claim/generation 释放；缺字段、不完整拓扑、未 seal、active lease、写盘失败、身份漂移均保留。旧 `not-started` shortcut 不得绕过新 scope proof。
- **恢复 fence 独立**：external/mixed 继续拒绝 resume/transfer。带 scope 的 Pi 记录若缺 owned proof，也在 reconciliation 前拒绝恢复；result-only 和损坏 scope 标记不能降级为 legacy。该初版也会拒绝缺 proof 的 scoped live resume，不声称所有 steer/revive 路径已完成适配。
- **保留证据**：status/result 携带 scope 标记；retention 不按 TTL 删除 scoped 记录，即使槽位已释放、只剩 result 或 active index 缺失。尚无精简归档或人工解除机制，记录会增长。
- **后台 Pi lifeline**：真实 Pi writer 回归暴露后台 spawn 缺少 fresh fd-3 pipe，子 Pi guard 在 provider 调用前中止。候选补齐 `OWNER_LIFELINE_ENV` 与 `trackOwnedLifeline`，不关闭 guard；owner-loss 使用公共 Pi abort/shutdown 收敛，不把它当作副作用回滚。

### 明确保留的未实现范围

**scoped workflow 不释放槽位。** 现有 `status.steps` 不是已封存的创建期 child roster；本地 controller Map 中不存在，也不是 reload 后可验证的 controller-close。即便父 complete、所有已知 async child 的独立 proof 均齐全，仍保留 workflow capacity。中间版本曾允许据 child proofs 释放；复查发现缺少上述证据，已撤回该放行并新增回归，不能沿用中间结果。

runner 中有 nested children、imported roots 或 external-job 路径时，coverage barrier 不完整，同样保留。这里是诚实的 fail-closed 初版，**不是完整采用矩阵通过**。

## 实际验证

环境：macOS、Node 24.18.0、经 identity/capability 检查的公共 Pi 0.85.1。真实写入只在新建夹具目录，provider 为本地 faux，禁止 fetch；不算真实模型或远端 L3。

| 检查 | 结果 / 能证明的范围 |
|---|---|
| 新 scope 定向回归 | 35/35：34 项合成/本地文件回归 + 1 项真实 SDK executor 综合测试；不是 35 个真实执行场景。 |
| 同一最终候选的第四批 external/lifecycle、followthrough、lifeline | 67/67；与新 scope 合计 **102/102，0 skip**。原断言保留，两个 external 套件仅新增显式 source override 以测试第二层。 |
| 原上游六套测试 | **76 pass、0 fail、1 Windows-only skip**；`owned-process-tree`、`process-terminal`、`active-async-capacity`、`async-retention`、`async-resume`、`external-cli-runner`，来源为固定上游 `afa22c811f81883acdb248c84f116ac7534e2fb4`，复制到候选测试目录运行。 |
| 完整候选类型 | strict / noUncheckedIndexedAccess / ES2023 / noEmit PASS，使用公开 Pi 类型；不是 product-installed 类型检查。 |
| 安装不变 | 209 个 TS 文件逐字节匹配 `.2` vendor archive。 |

真实 SDK 综合夹具分别确认：

1. limit=1 下连续三个正常 external runs，每个 owned proof 完整后释放到 0；全图仍 unknown，resume 被拒绝、启动次数仍为 1。
2. stop、timeout 关闭受控组后释放；仍有 writer 时新 admission 被拒绝。
3. setsid/独立 stdio 逃逸负对照：槽位释放后，逃逸者仍可在放行时写文件，证明 scoped release 绝不等于全树安全；随后只核验本夹具进程退出。
4. 单独 Pi-only 与 mixed workflow 的 Pi child 都真实经过公共 CLI/local faux，任务 complete、Pi writer roster/组证据存在；不能把 failed child 的资源关闭冒充模型成功。
5. mixed workflow 父先 complete 时保留槽位；已知 Pi/external children 全部关闭后仍保留，原因是 controller/创建期 roster 尚未实现，恢复被拒绝。
6. 在独立 fixture session 中，仅对经命令路径和唯一 run ID 核对的当前 runner 派发一次 SIGKILL；fd-3 lifeline 使真实 Pi/Bash child 退出。但未 seal 的 owned proof 为 unknown、槽位仍占用；没有因为另读到子进程退出而伪造完整证明。

开发中的失败未计为通过：最初夹具落到 PATH 产品 launcher，修正为已验证的 `PI_SUBAGENT_PI_BINARY`；随后暴露真实后台 lifeline 缺失，修复前 Pi child aborted，修复后 local faux 正常执行。四 fd spawn 的公开 Node 类型退化也曾使 typecheck 失败，修复后才重跑。workflow 过早释放的中间行为已撤回。

## 复现

先把 `ROTOM_PI` 设为经验证的公共 Pi `bin.pi` 绝对路径；不是产品 wrapper，也不要绕过现有 identity gate。

```sh
node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-owned-execution.test.mjs \
  rotom/extensions/third-party/history/subagent-owned-execution-sdk.test.mjs
```

前两项自动准备新副本。要将既有 67 项也指向第二层：

```sh
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rotom-owned-adoption.XXXXXX")"
export SUBAGENT_EXTERNAL_GROUP_SOURCE="$(node --input-type=module -e '
  import {prepareOwnedExecutionCandidate} from "./rotom/extensions/third-party/fixtures/prepare-owned-execution.mjs";
  console.log(prepareOwnedExecutionCandidate(process.argv[1]));
' "$ROOT")"
export SUBAGENT_FOLLOWTHROUGH_SOURCE="$SUBAGENT_EXTERNAL_GROUP_SOURCE"
export SUBAGENT_LIFELINE_SOURCE="$SUBAGENT_EXTERNAL_GROUP_SOURCE"
node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-external-group.test.mjs \
  rotom/extensions/third-party/history/subagent-external-lifecycle.test.mjs \
  rotom/extensions/third-party/history/subagent-followthrough-regression.test.mjs \
  rotom/extensions/third-party/subagent/lifeline-regression.test.mjs
```

## 下一道采用门

- 实现 controller/child 创建期 roster、父 capacity lineage 与 durable close；补真实 nested、同 runner Pi/external 混合、多 Pi writer 并发、lease/revive、并发 release/transfer、reload 组合。现有 synthetic lease/token/TTL 检查不替代这些真实路径。
- 完成用户可见 scope 披露、旧 reader、live recovery/attach/steer 与 retention 的全入口审查。capacity v2 拒绝旧 reader 不等于所有旧 reader 已安全：旧 retention 不会自动理解新 scope 标记，采用前须保证旧版本不操作新 scope 存储；同目录并存的活跃旧会话尚不支持。
- Linux 仍未验证；沿用此前环境阻塞，不启动/修复旧 Colima 磁盘。需明确授权的可用环境。
- 未重跑当前产品 `check-personal`、完整/deferred footprint、发布包验收；没有采用候选，且工作区存在并行 Qoder 改动，其测试不计入本批。
- 满足采用合同后再决定 archive/package/lock/integrity 更新；本批不更新依赖，不迁移活跃会话。
