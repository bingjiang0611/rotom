# 任务 04 · 受控回放报告

04a 的实现、费用预估和核验记录完整归档于 [04a 零费用回放](04a-faux-replay.md)。以下保留 04b 实现与开跑说明。

## 04b 实现补记：本轮仅零费用

已 pull 到 `3a919229`。授权常量同步为 `openai-codex/gpt-5.6-luna`、low、N≤3、2,000 请求、100M 合计输入；本轮不执行真实回放，不消费该授权。

- 入口须原开关和 `ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE=1` 同时启用；逐字核对模型/思考档位，拒绝空授权或超额 N。原凭据路径在隔离配置前捕获，只有执行时才读取。
- 单 campaign 共享请求尝试及四项 usage 计数，含原生摘要；等待在途流结算，未知 usage 停止。当前失败行保留，剩余标 `not-run`。两臂固定 **SSE、maxRetries=0**：Codex 默认 WebSocket 内部重试/回退会绕过 SDK 调用计数，因此不能用来代表默认 WebSocket 性能。
- 每行落盘并 fsync；默认 `~/.rotom/evals/compaction-offload/<时间戳>.jsonl`，0700/0600，拒绝工作树和符号链接目标。只保留指标、状态、源码版本和运行配置，不向 reporter 转交模型正文。本机独占 receipt 拦截同目录重跑；写入未知不补写、不续跑。
- 从实际 model 元数据计算 `reserveTokens=contextWindow-64000`；faux 的 192K/320K 窗口均验证通过，SDK 摘要参数 maxTokens 均为空，keepRecent 默认不变。真实 adapter 的模型自身输出限制不等于 reserveTokens。

| 检查 | 结果 |
|---|---|
| npm ci / typecheck | 通过；lock 未变，npm 仍报既有 8 项依赖告警 |
| 原 04a 专项 / N=3 faux case | 12/12；18/18 |
| live / entry 新专项 | 20/20：门禁、N、缓存计数、原生摘要、私有落盘、故障封停 |
| npm test（按上文指定产品 Pi） | 130 passed / 1 既有条件 skip |
| 预算负对照 | 暂停 admission 后 N+1 测试失败；逐字恢复后通过 |
| diff / 公开审计 | diff 通过；tree 7,816 项 PASS；history 仅既有 12 项身份，0 新增，非全绿 |

日志在 `/tmp/rotom-offload-04b.atvVW4`。仅修改 eval 与本报告，不改 packages/extensions，不安装、不升级。请求数上限严格阻止下一次派发；token 在回包后计量，在途请求可能越过 token 线。强杀或落盘失败只保证此前已同步行保留，当前行可能 unknown。真实账户、路由、服务端行为及性能尚未验证；评测模型费用为零，美元报价仍 unknown。需要执行真实回放时，由 bob 另行发起；中断后重新执行须新确认。

## 核验意见（规划者，2026-10-25，04b 入口）

结论：**changes-requested**（`9a64f92`），只差一处，修完即可开跑。

重跑（Node v24.22.1）：live/entry 专项 20/20（用 `vitest.test.config.ts`）；04a 专项 12/12；faux case N=3 18/18；`npm test` 130 passed / 1 skipped；typecheck 通过；`ROTOM_EVAL_REPETITIONS=5` 的真实入口在加载阶段就被拒（`Replay repetitions exceed authorization or are invalid`），没有构造 runtime；diff check、tracked-tree 审计通过；`packages/`、`rotom/extensions/` 无改动。授权常量与授权记录逐字一致。

审阅认可：请求数在派发前拦截；四项 usage 在下一次请求前入账；未知 usage、流异常、模型不符都停整个 campaign；每行 fsync 落盘；凭据只在 runtime factory 里按原 agent dir 读取，不复制到临时目录。两臂固定 SSE、`maxRetries=0` 为了计数准确可以接受，报告里要说明测到的是 SSE 下的摘要等待。

**必须修：单次运行会撞上 vitest 的 120 秒超时。** `vitest.config.ts` 的 `testTimeout` 是 120,000 ms，`cases/compaction-offload.eval.ts` 没有为单个 case 设超时。真实模型一次运行约 50 轮，加上一次原生摘要（历史上中位数约 85 秒），远超 120 秒。超时后 vitest 中止测试 → `abort` → `budget.halt("run-error")` → 后续 17 次全部 `not-run`，而按授权记录，中断后重跑需要 bob 重新确认，等于浪费这次授权。

修法：

1. live 模式下每个 case 显式设置超时（建议 30 分钟，常量导出），faux 模式保持现状。
2. 加一个零费用测试，证明 live 模式注册的 case 带有这个超时（例如检查注册参数，或用 faux runtime 走 live 路径并人为让一次运行超过 120 秒的假时钟，二选一）。
3. 顺便确认 `hookTimeout`（30 秒）不会卡住 live 路径的 setup/teardown；如果会，同样在 live 模式放宽。

修完推送后，由执行者直接按下一节开跑，不用再等规划者核验（改动小且有测试；我会在结果出来后一起复核）。

## 04b 开跑说明（修完上面一处后执行）

- 在 bob 本机、已登录 `openai-codex` 的环境，Node ≥ 24，按 README 中本 case 的命令运行，环境变量逐字为：`ROTOM_EVAL_COMPACTION_OFFLOAD=1`、`ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE=1`、`ROTOM_EVAL_PROVIDER=openai-codex`、`ROTOM_EVAL_MODEL=gpt-5.6-luna`、`ROTOM_EVAL_THINKING=low`、`ROTOM_EVAL_REPETITIONS=3`。
- 开跑前确认工作树干净（`sourceDirty` 必须为 false），记录 commit。
- 只跑一次。熔断或失败停下就停下，不要自行重跑，把已有结果报告上来。
- 报告新增「04b 结果」：每次运行一行（任务、臂、轮次、状态、correct、thresholdCompactions、nativeCompactions、deferred、compactionWaitMs、obsRecallCalls、recalledOffloaded、offloadedResults、turns、toolCalls、input、cacheRead、cacheWrite、output、wallMs），再按臂汇总（成功率分子/分母、compactionWaitMs 均值与中位数、wallMs 均值、obs_recall 均值、四项 token 均值）。注明累计请求数与 token、是否触发熔断、实际 contextWindow / reserveTokens。不写任何模型输出正文，不提交 JSONL。

## live 超时修复与开跑前验收

导出 `LIVE_REPLAY_TIMEOUT_MS=30*60_000`，只用于 live 注册的每一个 case；faux 与其他 eval 仍使用全局 120 秒，hookTimeout 仍为 30 秒。注册参数测试验证全部 18 个 live case 的超时，并验证 faux 未覆盖全局值。

已检查生命周期：工作区 setup、session 创建、推理、session abort/dispose 和工作区清理都在 `harness.run()` 内，受单 case 的 30 分钟限制；不是 before/after hook。唯一共享 afterEach 调用 `recordEvalRunArtifacts`；live 外层仅暴露指标和任务标识，无原始 session/trace artifact，该函数直接返回，不等待模型。因此不扩大 hookTimeout，也不改其他 eval。

历史报告原已超过 20,000-byte 门禁，按阶段归档 04a，没有删减原验收证据或放宽门禁。本节验证完成后先提交/推送，再从干净工作树开始唯一一次真实 campaign。

验证环境：本机 Node v24.18.0、产品 Pi 1.4.0-rotom.2。全部为零费用测试。

| 检查 | 结果 |
|---|---|
| `npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always` | 通过，依赖声明及 lock 无改动 |
| `npx vitest run test/compaction-offload-eval.test.ts` | 12/12 |
| `npx vitest run --config vitest.test.config.ts test/compaction-offload-entry.test.ts test/compaction-offload-live.test.ts` | 21/21 |
| 显式 faux case，N=3、LIVE=0 | 18/18 |
| 指定产品 `ROTOM_PI`/`ROTOM_TEST_PI` 后 `npm test` | 131 passed / 1 既有条件 skip |
| `npm run typecheck` | 通过 |
| 超时负对照 | 去掉 live 的 timeout 参数后注册测试失败，原样恢复后通过 |
| diff / 大小门禁 / 公开审计 | 通过；tracked-tree 7,817 项 PASS；历史仍只有此前接受的 12 项旧身份记录，无新增 |

完整测试日志保存在本机 `/tmp/rotom-offload-04b-run.JqL6LH`，不提交运行产物。
