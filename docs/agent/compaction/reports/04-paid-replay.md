# 任务 04a · 零费用受控回放报告

## 结论与范围

基于 `8c10047a` 完成 04a：三个固定合成任务、确定性判分、同产品开关对照、事件/usage 指标、faux 测试与费用量级预估。专项 12/12、实际 case 的 N=3 faux 回放 18/18 通过；全量 eval 单测在显式选择当前产品 Pi 后 110 passed / 1 既有条件跳过，typecheck 通过。

**没有调用真实模型，04b 未执行。** 授权记录仍为空，未改动它。当前 case 为 faux-only，显式选择真实 provider 会立即报错；即使以后填好记录，也不能绕过尚未实现的 04b 预算控制自动开始付费调用。

没有改动 `rotom/extensions/` 或 `packages/`，没有产品版本、归档、当前用户安装或发布变更。以下成功率、耗时和 token 都来自脚本化 faux，不代表真实模型质量、速度或费用收益。

## 文件与实现

| 文件（除报告外均相对 `rotom/evals/`） | 作用 |
|---|---|
| `cases/compaction-offload.eval.ts` | 默认 skip；显式开关运行本地 faux；N=3/5、两臂按重复轮次交替排序，拒绝真实 provider。 |
| `src/compaction-offload-cases.ts` | 固定 fixture、分阶段任务、独立判分、共同配置及 harness；完整 run 边界计 wallMs。 |
| `src/compaction-offload-faux.ts` | 唯一本地响应脚本；记录真实发送的完整 system prompt/工具 schema，验证准确细节确实从工具结果取回。 |
| `src/compaction-offload-metrics.ts` | 阈值事件计时、原生/推迟计数、按时间顺序归属 recall、原始分支 usage 求和及聚合。 |
| `test/compaction-offload-eval.test.ts` | 12 项零模型测试，含三个任务的正反判分和实际产品 A/B、计数压力轨迹、入口门禁。 |
| `src/pi-harness.ts` | 显式可选的只读 inline 探针优先顺序；其余调用方默认顺序不变；回复索引改用持久化分支。 |
| `src/pi-harness-lifecycle.ts` | 按职责抽出原有回复/等待生命周期函数，修复压缩清掉活动 messages 后找不到末尾回复的问题。 |
| `test/pi-harness.test.ts` | 原空回复测试改用权威 sessionManager 分支 fixture，不降低原断言。 |
| `vitest.config.ts` | 仅显式指定本专项文件时选择单测 include；普通 eval 仍只发现 cases，不悄悄运行 unit faux。 |
| `README.md` | 新增 11 行说明、零费用启用方式、实际 Pi 测试路径、付费门禁与限制。 |
| `docs/agent/compaction/reports/04-paid-replay.md` | 本报告。 |

### 为什么需要两处 harness 修复

- Pi 的 `session_before_compact` 遇到 cancel 就停止调用后续 handler，而现有 inline extension 默认在产品 extension 后面。仅追加普通探针会漏掉 candidate 的开始事件。新增 opt-in `inlineExtensionsFirst`，本 case 只放不改事件的 metrics 探针；两臂同样启用，system/schema 相同已经实测。
- 原 harness 按 `session.messages.length` 定位本轮回复。原生压缩会重建活动 messages，压力用例真实失败为 `Agent run completed without an assistant message`。现在从 sessionManager 原始分支按 entry 边界定位，摘要不会抹掉回复；原异常/空回复语义保留。压力轨迹及既有 harness 单测通过。
- 原 harness 文件已超过 20,000 bytes；按回复生命周期职责抽出后为 19,300 bytes。没有借 README 的例外放行它。

## 两臂控制与配置路径

两臂指向当前分支同一个 `rotom/` 和其安装的 Pi `1.4.0-rotom.2`，同一 `rotom-offload-faux/replay`、thinking=off、工具集 `read/bash/edit/write/obs_recall`。产品资源相同，不删产品 extension。

唯一实验开关为 `ROTOM_COMPACTION_OFFLOAD=0/1`，通过现有 `environment` / `withExclusiveEnvironment` 串行覆盖并恢复。每次都是新的临时 workspace、configDir 和 sessionsDir。

**已核实 configDir 不能单独代表 SoL-Pi 配置目录。** wrapper 默认调用 `getAgentDir()`。本 case 在已有独占环境作用域内把 `PI_CODING_AGENT_DIR` 绑定到本次 configDir，再写完全相同的 `sol-pi.json`：Action Fusion/Observation Pack 开、Reducer/Online Context Compact 关，文件里不写 compactionOffload。测试断言产品 `getAgentDir() === configDir`、配置逐项一致、两臂工作区不同、结束后两个环境变量均还原。失败测试日志场景也没有额外 provider 请求。

### 阈值方案与负对照

选方法 1：只改 `compaction.reserveTokens`，**阈值固定为 64,000 tokens**；当前 faux 声明窗口 256,000，所以 reserve=192,000。keepRecentTokens 保持 Pi 默认 20,000，retry=false。

没有照搬示例的 40K：保留默认 recent 历史和产品 prompt/schema 后，0.6×40K 的目标太紧。实测临时改成 40,000，`deferred-exact` A/B 用例因 candidate 的 offloadedResults=0 失败。已恢复 64,000 并复验所有专项。这是阈值实验参数的明确调整，不是降低 keepRecentTokens 或改卸载算法以凑成功。

当前 fork `compaction.ts#createSummarizationOptions` 不设置 maxTokens，generateSummary 的 reserve 参数为 `_reserveTokens`。faux 捕获实际摘要请求也证明 maxTokens 未设置；没有把大 reserve 当作摘要输出上限。此结论绑定当前 Pi 版本，04b 更换运行时须重验。

三个正常任务都在第 **40 个 assistant turn** 触发首次 threshold：baseline 原生压缩一次；candidate 推迟一次、记录 27 个卸载结果。不是靠手动 compact，也不改 provider/model 声明窗口。

## 固定任务与判分

每个任务有 48 份约 6 KiB 的主要材料（均在 1.5–10 KiB 范围），分两个用户阶段，后阶段要求使用先前细节。20 份主要模块/日志加 28 份合成审计资料；先读 manifest，再逐份读。内容由固定种子 SHA-256 派生，无真实会话。

| 任务 | 后阶段与判分 |
|---|---|
| config-aggregate | 用 4 个指定模块常量改 summary.mjs，执行 node check.mjs；该文件其余字节及所有其他 fixture 必须不变。 |
| deferred-exact | 原样给出第一份日志中间的 40 字符 EXACT_CODE，文件不得修改。faux 在 candidate 中真实调用 obs_recall，并检查返回内容包含准确细节；baseline 从工作区重读。 |
| multi-file-fix | 修 3 个函数并运行 node test.mjs；测试脚本和其他 fixture 不变，原注释保留。正确性由测试脚本判断，不要求与参考修复字节相同。另测等价正确实现通过、保留错误函数失败。 |

任务 prompt 没有压缩、卸载、obs_recall 提示。faux 响应本来就是已知解脚本，**不能用它的成功率证明 LLM 能推理完成任务**；它证明请求、实际工具、存档取回、判分和测量链路工作。

## 指标依据

- threshold/native/deferred 来自优先只读探针的 session_before_compact / session_compact / session_compact_failed；本实验统计 threshold 路径，aborted 计推迟。异常运行不伪造成功行。
- compactionWaitMs 从 before_compact 到 compact/failed，包含推迟时的存储开销。wallMs 在 harness.run 外层计时，包含配置/loader、任务、判分、shutdown 和 artifact capture，不只是模型回合。
- 从原始 sessionManager 分支读取 assistant/tool-call、卸载记录和 usage，不从已经摘要过的 session.messages 统计。
- recall 按时间顺序与当时已经存在的 observationIds 对照；稍后卸载同名 id 不会倒算早期 recall。
- 累加 assistant、compaction entry 的 summary usage，以及辅助 usage entry；缺失用量标 partial，未知价格返回 null，不把 faux 的 $0 报成付费估价。
- 压力用例：1 次推迟 + 1 次原生压缩 + 1 次卸载 id recall + 1 次普通 Observation Pack id recall，数字精确。一次 split-turn 原生压缩实际有 history/turn-prefix **两次摘要请求**，不是两次 compaction。普通 Observation Pack 首两次仍发原文，脚本等足两个请求后才取回其 pointer。
- 注入时钟的单测精确验证 2ms 推迟 + 30ms 原生 = 32ms，并验证 summary usage 不漏计/不重复、cacheRead/cacheWrite、费用未知和均值/中位数。压力用例的故意超长 faux 回复不参与费用预估。

## 最终专项中的正常 faux 观察值

以下是一组 3 任务×2 臂（每格 1 次）的校准行；全部 correct=true、usageComplete=true，cacheRead/cacheWrite=0（faux 显式禁用缓存模拟）。数值为合成代理的字符估算，不是任何真实 provider 的 tokenizer。

| 任务 | 臂 | 请求数（含摘要） | assistant turns | toolCalls | inputTokens | outputTokens | compactionWaitMs | wallMs |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| config-aggregate | baseline | 55 | 54 | 52 | 1,802,890 | 530 | 2.640 | 3,140.752 |
| config-aggregate | candidate | 54 | 54 | 52 | 1,832,365 | 498 | 14.905 | 1,299.975 |
| deferred-exact | baseline | 53 | 52 | 50 | 1,722,800 | 468 | 0.702 | 793.636 |
| deferred-exact | candidate | 52 | 52 | 50 | 1,745,553 | 437 | 10.621 | 941.619 |
| multi-file-fix | baseline | 58 | 57 | 55 | 1,940,158 | 5,216 | 0.639 | 1,208.402 |
| multi-file-fix | candidate | 57 | 57 | 55 | 1,979,381 | 5,186 | 11.882 | 1,187.192 |

| 汇总 | baseline | candidate |
|---|---:|---:|
| faux 判分通过 | 3/3 | 3/3 |
| compactionWaitMs 均值 / 中位数 | 1.327 / 0.702 | 12.469 / 11.882 |
| 原生压缩 / 推迟总数 | 3 / 0 | 0 / 3 |
| obsRecallCalls / recalledOffloaded 均值 | 0 / 0 | 1 / 1 |
| offloadedResults 均值 | 0 | 27 |
| inputTokens 均值 | 1,821,949.333 | 1,852,433 |
| outputTokens 均值 | 2,071.333 | 2,040.333 |
| cacheRead / cacheWrite 均值 | 0 / 0 | 0 / 0 |
| 估算美元均值 | unknown | unknown |
| wallMs 均值 | 1,714.263 | 1,142.929 |

candidate 在这个脚本中保留了更多历史，输入代理量反而约高 1.7%；faux 摘要几乎即时，因此存档操作的 compactionWaitMs 更高。wallMs 又受首次模块加载/本机调度影响。**不做显著性、实际提速或省钱结论。**

## 04b 调用量与费用预估（没有运行 04b）

建议先 **N=3**，不直接 N=5。6 个正常校准运行合计 329 请求（326 assistant + 3 摘要）、11,023,147 input proxy tokens、12,335 output proxy tokens。固定脚本外推：N=3 为 987 请求，N=5 为 1,645 请求。

下面是用于选预算的**情景区间，不是保证的上下界或统计置信区间**：

- 请求量按固定脚本的 1–2 倍考虑自然模型增加工具轮次；模型批量调用多个 read、失败或提前退出，都可能让实际请求显著少于脚本。
- 输入按 faux 字符/4 代理量的 0.5–3 倍考虑 tokenizer、摘要保留和执行轨迹差异，全部按未缓存输入预算。
- 输出下情景 = 脚本输出 + 每次原生摘要 1,024 tokens；上情景 = 2×脚本输出 + 2×assistant turns×512 + 2×原生摘要次数×4,096。这是规划假设，不是模型输出 cap。
- 额外重试、更多摘要、长输出或反复回读可能超过区间；04b 必须靠授权预算停止，不得把估算上界当限额。

| 建议重复数 | 运行数 | 请求情景 | 输入 token 量级 | 输出 token 量级 | 美元 |
|---|---:|---:|---:|---:|---|
| N=3（建议） | 18 | 987–1,974 | 16.5M–99.2M | 46K–1.15M | 模型/单价未确定，unknown |
| N=5 | 30 | 1,645–3,290 | 27.6M–165.3M | 77K–1.92M | 模型/单价未确定，unknown |

取得授权模型的单价后，按 input/cacheRead/cacheWrite/output 的对应费率计算；不要用 faux cost=0、token 代理量或 USD/credit 未知模型的占位价推断免费。这里的 987/1,645 是外推的**请求**，不是 18/30 次单次模型调用。本次所有运行只用本地 faux，真实模型调用与模型费用均为 0。

## 验收记录

环境：Node v24.18.0、npm 12.2.0、vitest 4.1.9，实际产品 Pi 1.4.0-rotom.2；eval 的开发类型依赖仍为锁定的 Pi 0.84.3，没有升级依赖或改锁文件。

| 命令/检查 | 结果 |
|---|---|
| evals 下 `npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always` | 退出 0。 |
| `npx vitest run test/compaction-offload-eval.test.ts` | 退出 0，12/12，确实发现并执行专项，不是 no-tests 成功。 |
| 原样 `npm test` | 首次 10 失败 / 99 通过 / 1 跳过；npm PATH 选中了 devDependency Pi 0.84.3，全部失败都指向缺 createCodemodeExtension 的 identity gate，尚未发起模型请求。 |
| 选择当前产品 Pi 后 `npm test` | 退出 0，15 文件，110 passed / 1 skipped；跳过项为未设置 ROTOM_TEST_SIDECAR 的既有 sidecar 测试。 |
| `npm run typecheck` | 退出 0。 |
| 显式启用 case、固定 faux、N=3 | 退出 0，18/18；顺序为 baseline/candidate、candidate/baseline、baseline/candidate，每个任务如此。 |
| 默认不启用 case | 子进程报告 1 skipped、0 passed；不会构造 runtime 或发请求，即使环境选了非法真实 provider。 |
| 显式启用但选择真实 provider | 子进程按预期退出 1，`04a is faux-only`；不会退回用户默认模型。 |
| 40K 阈值负对照 | 按预期失败：candidate offloadedResults=0；恢复 64K 后专项通过。 |
| 旧回复读取路径的回归证据 | 压力轨迹曾真实报无 assistant message；持久化分支修复后通过，没有删掉该轨迹。 |
| `git diff --check origin/main...HEAD` / 工作树 diff check | 退出 0；提交后复核。 |
| 禁改目录 | `git diff --exit-code -- packages rotom/extensions` 退出 0。 |
| `python3 scripts/audit-public.py --root .` | PASS，7,811 项、0 findings。 |
| 独立公开副本 `python3 scripts/audit-public.py --root . --history` | BLOCKED，260 commits / 38,859 项；仅下述已授权的 12 项身份命中，0 新增。保留失败状态，不放宽规则。 |

全量测试所需环境（在 evals 目录，PI 必须是绝对路径）：

```sh
PI="$(cd ../runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle && pwd -P)/cli.js"
ROTOM_PI="$PI" ROTOM_TEST_PI="$PI" npm test
ROTOM_EVAL_COMPACTION_OFFLOAD=1 ROTOM_EVAL_PROVIDER=rotom-offload-faux \
  ROTOM_EVAL_MODEL=replay npx vitest run cases/compaction-offload.eval.ts --reporter=json
```

这不是通过修改产品或弱化 identity gate 消除旧 Pi 的失败。正常 eval 默认发现范围不变；仅明确传入专项文件的 CLI 才切到该 unit include。

## 已授权交付例外与未完成项

用户分别选择了：

1. **仅本次豁免** `rotom/evals/README.md` 大小门禁（原 38,044 bytes）。临时 whitelist 只含此文件，原脚本/长期 Git 配置不改；其他文件保持门禁，harness 已按职责拆至上限内。
2. **接受既有问题继续**：仅接受已公开的 `ba9288fd`、`e6da2afa`、`b358d3c1`、`dd68b62d`、`ec14cce5`、`8c10047a` 六个提交的 author/committer 共 12 项非 noreply 身份。扫描规则不放宽，新提交用 noreply，不改写历史、不 force push。历史结果不能称为全绿，且不得有新增命中。

从 GitHub 单分支、无 tags 的独立公开 clone 重放本次 diff；暂存树须与通过验证的 worktree 一致，不携带共享维护仓其他 refs。仅向 compaction/offload-first 提交/推送，不推 main，提交后历史复核不得新增命中。会话、trace、完整本机检查日志不提交；没有后台服务、真实模型请求或安装升级。

**04b 下一步 owner：bob / 规划者。** 先确认模型、thinking=off 是否适用、N 和预算上限并填写任务末尾授权记录；执行者后续还需接真实模型 runtime、累计预算停止/失败保留与授权核对，重新验证所选模型的阈值/摘要预算。当前入口故意不提供真实模型执行路径，不把 04a 完成冒充 04b 可直接收费运行。

## 核验意见（规划者，2026-10-25）

结论：**04a accepted**（`bc41304`）。

重跑结果（cloud 环境，Linux；先在 Node 22 上跑，专项因产品 Node ≥24 门禁失败，换 Node v24.22.1 后重跑）：

- `npm ci` 通过；`test/compaction-offload-eval.test.ts` 12/12。
- 按报告方法选当前产品 Pi 后 `npm test`：15 文件，110 passed / 1 skipped；`npm run typecheck` 通过。
- 显式启用 faux case、N=3：18/18。
- `git diff --check origin/main...HEAD` 通过；`packages/` 与 `rotom/extensions/` 相对 `8c10047` 无改动；`audit-public.py` tracked-tree PASS。

审阅要点：

- 两处 harness 修复理由成立。`session_before_compact` 被取消后不再调用后续 handler，探针必须排在产品 extension 前面；压缩会重建 messages，按 `messages.length` 找回复确实会丢。改动都是 opt-in 或保持原语义，既有 harness 测试仍过。
- 阈值从 40K 调到 64K 有负对照证据，合理。摘要请求不设 maxTokens 的结论绑定当前 Pi 版本，04b 换运行时要重验，报告已写明。
- 用 `PI_CODING_AGENT_DIR` 让 SoL-Pi 配置读到本次 configDir，两臂配置逐项断言一致，可以。

提醒（不阻塞）：faux 的 input 代理量每次运行约 1.8M，是因为 50 多轮、每轮重发 40–64K 上下文。真实 provider 通常有前缀缓存，大部分会计成 cacheRead；04b 报告要把 input / cacheRead / cacheWrite 分开列，不能只看 input 总量判断费用。

规划者自身问题：`ba9288f` 等 6 个规划提交使用了 `Claude <noreply@anthropic.com>` 身份，触发历史审计。已不改写历史，之后的规划提交改用 `bingjiang0611@users.noreply.github.com`。
