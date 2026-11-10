# 优化方案执行记录（2026-11-09，云端容器）

对应 [优化方案](optimization-plan-2026-11-09.md)。

## P0 已实施

| 项 | 改动 | 证据（本地，无付费调用） |
|---|---|---|
| P0-1 | `coding-policy` 写入 `systemPromptOptions.sections.coding_policy`，不再返回 `systemPrompt`；eval 注入镜像同步 | 真实 AgentSession + faux：旧实现在加载新工具后开头 system 消息 13,541→13,627 字节被改写；新实现 13,642 字节逐字节不变，新工具作为第二条 system 消息追加。`request.test.ts` 在旧实现上失败。eval `coding-policy-request` / rule-ablation 9/9 |
| P0-2 | Pi fork `1.4.0-rotom.3`（2026-11-10 合并 main 后改名 `1.4.0-rotom.4`，因 main 已把 rotom.3 用于重试策略）：摘要序列化工具结果保留头尾、工具参数按 2000 字符截断 | 压缩相关 vitest 61 通过 / 2 跳过（需真实模型）；两个新用例在旧序列化上失败；`build:pi` 定向测试全过 |
| P0-3 | **未实施**。可行做法是 `context_recall` 的一句 guideline（不改 Pi fork 的摘要前缀：fork 不应知道产品工具名，且 `ROTOM_CONTEXT_LAYERS=0` 时该工具不存在） | 它是未测的提示改动，每次请求固定多 278 guideline 字节；按账本“提示房租”规则不能上线，登记为 `kept-off`，等 P1-1 验证 |
| P0-4 | Subagent `0.52.1-rotom.15`：屏蔽 `share`、`sessionDir` | 已确认 `share:true` 在 scoped 异步路径会走到 `gh gist create`；新用例覆盖 schema 与参数拒绝 |
| P0-4 | `scout` 只读：去掉 `write`、默认 `output: context.md`、`defaultProgress` | 显式 `output` 仍由运行时代写（`single-output.ts` 对无写工具的角色改为代写） |
| P0-5 | 完成通知 >8 KB 保留首 6 KB/尾 2 KB，全文写执行 store `completion-output/`（0700/0600、拒 symlink、`O_EXCL`），写入时清理超过 7 天的文件 | `test/notify.test.mjs` 5 例，各自在对应旧实现上失败 |
| P0-6 | `subagent_wait` 工具层（新 `wait-timeouts.ts`）把阻塞等待改为默认 10 分钟、上限 15 分钟；`nonBlocking` 订阅不变；核心 `waitForSubagents()` 与超 20 KB 的 `subagent-wait.ts`/`schemas.ts` 未改动（文件大小门禁） | 策略用例；已注册工具的参数说明用例在旧 `wait-tool.ts` 上失败。`execute` 套用策略只由代码审阅证明 |
| P0-7 | 产品与组件 SKILL 描述改为与 scoped 能力一致；写明子任务工具面、等待与截断规则 | 产品 SKILL 3,014 字节，仍小于组件 SKILL 的一半（skill 测试门槛） |

组件门禁：unit 71/71、SDK 6/6、strict typecheck 通过；最终归档 `pi-subagents-0.52.1-rotom.15.tgz` 的实际 tgz 审计 PASS。

产品门禁 `rotom/bin/check-personal`（Linux 容器）：574 项中 571 通过、2 跳过，唯一失败见下文既有问题 1；其后的离线 Provider 矩阵通过、Goal 99/99 通过、footprint 见既有问题 2。eval 离线测试 29 个文件 262 通过 / 1 跳过（含 `coding-policy-request` 与 rule-ablation）；`check:pi` 通过；账本校验通过。

## 既有问题（单列，未在本次修复）

1. **Linux 上 `third-party/index.test.ts` 不退出。** Subagent intercom 在非 macOS 平台使用原生 `fs.watch`（`watch-strategy.ts:9`），根目录监听没有 `unref`（`native-supervisor-channel.ts:776`），测试会话未触发 `dispose`；该文件 24 个用例全部通过后子进程仍挂起。维护者在 macOS 上跑不到这条路径。本次用只结束该子进程的看守脚本完成门禁。
2. **footprint schema 合同在 HEAD 上已不成立。** 干净 HEAD worktree 实测规范化 schema 31,448 字节，合同 29,684（+1,764）；本次改动后数值相同，guideline 与工具数仍与合同一致。需要维护者确认是哪次改动（疑似 Computer Use v2 归档刷新）并更新合同说明。
3. **`npm run test:compat` 无法运行。** `scripts/check.mjs` 仍指向已移入 `history/` 的文件，其中 `subagent-owned-flat.test.mjs` 已不存在。
4. **`docs/usage.md`（53 KB）超出 20 KB 暂存文件预算。** distribution 测试要求它写明当前 Subagent 版本，所以每次升版都要改这一行；与 `5255910` 等既有提交相同，本次只改该行。

环境说明：容器以 root 运行且无 `fd`，Pi 定向测试中 2 个 EACCES 用例和 5 个 find 用例因此失败；安装 `fd-find` 并以非 root 用户重跑后全部通过。隔离 npm HOME 不继承本容器代理 CA，使用只设置 `NODE_EXTRA_CA_CERTS` 的本地 npm 包装，未改构建或发布脚本。

## P1：离线部分已实施

| 项 | 改动 | 证据 |
|---|---|---|
| P1-2 | harvest 新增每次压缩的后续观察（`compactions.jsonl`、报告 “After compaction” 节、`summary.json` 汇总）：压缩前 token、摘要 token、前后 cacheRead、5 条助手消息内重读摘要所列文件与回查次数、3 个用户轮内介入与 Goal 暂停，并列全局介入率 | 合成会话单测；尚未在真实会话上运行 |
| P1-1 | 两个压缩后续跑用例（长期指令、精确参数），第 1 轮后真实 `session.compact()`，`keepRecentTokens: 1` | 离线 oracle 6 例：压缩后第 1 轮原文不在上下文；正确轨迹通过，再问、未压缩、忘参数、先错后改均失败。状态 `oracle-ready`，未跑 baseline |

| P1-3 / P1-5 | 同一产品的特性开关对照：`ROTOM_EVAL_BASELINE_EXCLUDE_RESOURCES`、`ROTOM_EVAL_BASELINE_ENV` 只作用于 baseline 臂；产品新增 `ROTOM_EVIDENCE_REDUCER=0|1` | 单测与一次端到端 faux 请求（baseline 臂请求里没有 coding-policy，candidate 臂有）；Reducer 开关测试在旧代码上失败。未做付费配对 |

| P1-4 | Subagent 有/无配对套件 `cases/subagent-ab.eval.ts`：同一产品，两臂只差 `subagent`/`subagent_wait`；清点与审查两个任务按生成 fixture 的答案判分 | 离线 oracle 4 例：答案键与 fixture 一致、判分区分漏报/误报/干扰项、真实会话两臂工具只差 Subagent。子任务需要真实模型，未运行 |

P1 的付费运行见下节。

## P1 / gate：付费部分被环境阻塞

`docs/agent/optimization-loop.md` 要求改 coding-policy、上下文/压缩、Subagent 默认策略后跑 gate，且用户已授权 gate/回放使用 `qoder/dfmodel`。本容器没有 Qoder 登录凭据，也没有本机会话目录（harvest 的输入），因此 P1-1～P1-5 与 gate 都未运行。账本新增三条 `open` 机制条目与一条 `kept-off` 提示条目（P0-3），等待本机执行：

```sh
npm --prefix rotom/evals run loop -- gate --baseline /absolute/frozen/rotom
npm --prefix rotom/evals run loop -- harvest --days 28
```

## P2：按 2026-11-10 结论处理

P1 已在本机跑完（[结果](optimization-results-2026-11.md)）。第四节六项决策的结论见方案“2026-11-10 结论”：不删 Offload/`obs_recall`、Reducer 不关而改为补测、`explore` 与进程内运行暂缓、Subagent 不改 opt-in、coding-policy 暂不删规则。唯一落地的改动是修正 `completion evidence scope` 用例的题面歧义与逐字判分。
