# Pi 1.3.0 对齐

交付 fork：`1.3.0-rotom.1`，上游基点为 `v1.3.0`（`71023aec1546d6d677a65669c5665c0927ce0dd0`），跨越 1.2.0 与 1.3.0。

模型目录取自经 SRI 校验的官方 `@earendil-works/pi-ai@1.3.0`。

## 做法

- 以 `v1.1.0` 为 base，对 rotom 修改过的 64 个文件做三方合并（rotom `1.1.0-rotom.2` / `v1.1.0` / `v1.3.0`）。54 个文件自动合并；10 个文件共 12 处冲突手工解决：
  - `ai/src/utils/retry.ts`：同时保留上游新的 `provider returned an error` 匹配和 rotom 的 `upstream_error_frame`。
  - Codemode `host.ts`、`worker.ts`、`protocol.ts` 取 `v1.3.0`，再把 rotom 的 `directOnlyTools` 接到上游新的 `VmStartData` / `ExecutionOptions`；确定性 `start()` 传空列表。direct-only 测试改用上游 `describe.each` 下的 `newSandbox(...)`。
  - `agent-session.ts`、`extensions/codemode/execute.ts`：两侧都保留。
  - `settings-manager.ts`：上游改为 TypeBox schema，rotom 的 `compaction.thinkingLevel` 改为在 `settings-schema.ts` 中声明，并重新生成 `schemas/settings.schema.json`。
  - `test/model-resolver.test.ts`：上游删除了 `parseModelPattern`，改用 `ModelReferenceRequest`。
- 上游没有吸收 rotom 的任何补丁；`directOnlyTools`、`MAX_NESTED_TOOL_CALLS`、`refreshUnavailableDefaultModelInScope`、压缩 thinking level、扩展触发压缩等定制均保留。
- 上游删除的包（实验性 client/protocol/server 等）随之删除。`chord` 仍在 workspace 中，但不再是 coding-agent 运行时依赖，因此运行时从八包减为七包；构建、打包、分发测试和 Provider 检查的包清单同步更新。
- 上游删除的 `assistant-message-frame.test.ts` 从 Provider 检查清单移除；rotom 不使用该 API。
- 省略的维护文件同 1.1，另加上游新增的 `.pi/prompts/dup.md` 与 `.pi/skills/github-work.md`。

## 模型目录

- 来源：官方 registry `registry.npmjs.org` 上的 `@earendil-works/pi-ai@1.3.0`（2026-10-15 19:11Z 发布），tarball 的 sha512 与 registry `integrity` 一致；`dist/providers/data` 原样导入，42 个文件，记录在 `FORK.json` 的 `modelData`。
- 曾误判 npm 未发布：本机 npm 默认使用内部镜像，该镜像在 10-16 仍未同步 1.3.0，返回 E404。之后查询发布状态必须直接查官方 registry。
- 镜像未同步期间，曾临时使用上游 `v1.3.0` 的 `nix/model-catalog.json` 钉住的 revision。与官方包相比有 6 个文件不同，全是目录数据：NVIDIA/OpenCode/OpenRouter/Vercel 新增或移除少量模型，OpenRouter 12 个模型的价格或上下文窗口更新，`.manifest.json` 随之变化；kimi-coding 等其余 36 个文件相同。官方包更新，是因为上游在发布前把目录与最新 release 做了核对（`4954d760`）。临时目录已全部替换。

## 行为

- **Codemode 描述**：上游新增"声明返回对象的工具，失败时也会以该对象 resolve，需检查字段"一句，default、full、scoped 三个工具面 schema 各 +115 bytes（路径归一化后）。full/scoped 合同同时补记 `32029b3` 缩短 Subagent 描述带来的 −202 bytes：该提交只更新了参数表，没有更新这两个合同；用 0.1.23 已安装 runtime 复测，同样差 202。都是静态字节，不是 provider token。
- **Qoder 跨模型推理**：与上游 #11000 一致，其他 provider/model/api 的 thinking 在出站副本中直接丢弃，不再转成可见文本；只剩 thinking 的助手轮不发送。同模型的签名、redacted 与普通 thinking 不变；已保存历史不改写。
- **`before_agent_start`**：1.2 起 `sendMessage(..., { triggerTurn: true })` 也会触发，事件变为 `messageType: "user" | "custom"` 联合类型。coding-policy 因此也会注入 Ask 续跑和 Subagent 结果轮；这是预期行为。observability 对缺失的 `prompt` 已有默认值。
- **会话忙碌窗口**：1.2 起从 run 开始就算忙碌。Browser 的 `sendUserMessage` 由 `isIdle()` 守卫，覆盖该窗口。pi-subagents 在 `agent_start` 前以 auto 模式发送 steer 时会因缺少 `deliverAs` 报错（错误经 runner 上报）；按 1.1 代码推断，同一窗口在 1.1 中不被视为忙碌，会尝试再启动一个 run，所以不是新增风险（未运行验证）。本次不修改 vendored 包。
- **resume 恢复工具**：用真实 1.3 runtime 和全部产品扩展做了 resume 对照（faux provider，`search_tools` 加载 Subagent 后重开会话）：有 UI 时恢复后的工具集与加载后完全相同，`--tools -bash` 只去掉 `bash`；结果与 1.1 runtime 相同。无 UI（print）时 `ask_user_question` 按 `hasUI` 规则移除，与 1.1 的下一轮结果一致。
- **Codemode worker 上限 2**（代码阅读）：计数器按进程；Subagent 子会话运行在独立进程中，不共享该上限。

## 验证（macOS arm64 / Node 24.18.0，清空继承的 `ROTOM_*` / `PI_*` 环境）

| 检查 | 结果 |
|---|---|
| `npm run build:pi`（隔离锁定安装、全 workspace offline build、builder focused 回归） | PASS；`1.3.0-rotom.1`，lock 中无 chord/client/protocol/server |
| fork `tsc --noEmit`、pinned deps、runtime deps、ts imports、entry graphs、install lock；改动文件 Biome | PASS |
| ai 全量（排除需要本机 Ollama 的两个 E2E 文件） | 1361 passed |
| agent / codemode / mcp / tui | 95 / 229 / 45 passed；tui exit 0 |
| coding-agent 全量 | 见下方说明 |
| `check:pi`、`build-pi-fork.test.mjs`、`test:distribution`、`test:providers` | PASS；2 + 25 tests，Provider 矩阵 PASS |
| `verify-pi-runtime.test.mjs` + `context-footprint.test.mjs` | 49 passed |
| `rotom/bin/check-personal` | 328 + 87 tests PASS；Provider 离线矩阵与 default footprint PASS |
| default / full / scoped footprint | PASS（scoped 使用已初始化的隔离 execution store） |
| default / full `smoke-runtime.mjs` | PASS |
| Qoder 测试 | 244 passed；还原 `messages.mjs` 后新断言 10 个失败 |

coding-agent 全量：

- `interactive-mode-compaction` 因上游新增 `maybeSuggestBugReport` 调用而失败，已在测试替身中补上，现通过。
- `agent-session-concurrent` steering 与 `agent-session-runtime` settles 两个失败与 1.1 迁移记录中的既有失败相同，原因是 rotom agent loop 的 abort 守卫；纯净 `v1.3.0` 通过。`1.3.0-rotom.1` 没有修，`1.3.0-rotom.2` 已修，见下节。

## 事件记录

一次未过滤的 ai 全量运行触发了 Ollama E2E 测试，向本机 Ollama 拉取了 `gpt-oss:20b`（约 13 GB）并启动了 Ollama.app。已用 `ollama rm` 删除该模型并停止 Ollama 进程。之后的 ai 运行都排除这两个文件。

## 未验证

- 真实模型调用，包括 Qoder 跨模型切换的实际效果、kimi-coding 新端点和 GPT-6 缓存。
- 真实 TUI/PTY 的 resume 与模型切换。
- `pack:release`、tgz 安装、升级与卸载。

本次没有推送、npm 发布、全局安装切换或存活会话迁移。

## `1.3.0-rotom.2`

在 `1.3.0-rotom.1`（rotom 0.1.24 发布）之上的两项修改，随下一个 rotom 版本发布。

### 中止后不再请求 provider

- 问题：rotom 的旧守卫在 `turn_end` 之后发现 signal 已中止，就直接结束，不写入任何助手消息。这样有两个后果：
  - steering 消息排在中止之后时，会被丢弃。
  - 工具执行中途切换会话时，被切走的会话以 `toolResult` 结尾，没有收尾的助手消息。
- 修改：把守卫移到 `streamAssistantResponse` 的入口（`agent/src/agent-loop.ts`）。signal 已中止时：
  - 不解析 API key，也不请求 provider。
  - 在本地写入一条 0 用量的 `aborted` 助手消息，和 provider 收到中止请求时返回的结果相同。
  - 排队的 steering 消息仍写入对话。
- 结果：既保留了 rotom 原有的保证（中止后不再发请求），也恢复了上游的约定（中止的轮次以 `aborted` 助手消息结尾，UI 和 Goal 都按中断处理）。
- 测试调整：
  - `agent-session-runtime` 的 settles 用例不改，现在通过。
  - `agent-session-concurrent` 的 steering 用例原本断言 mock provider 在中止后仍收到请求。这正是 rotom 要避免的行为，所以改为验证三点：steering 消息已写入对话、provider 没有收到请求、对话以 `aborted` 结尾。
  - `agent-loop` 的 turn-end 中止用例改为断言多一条 `aborted` 消息，并且仍然只有 1 次 provider 请求。
- 对照：去掉守卫后，这两个 coding-agent 用例 19/19 通过，证明失败确实来自守卫。

### `pi.appendUsage`

- 扩展 API 增加 `pi.appendUsage(kind, provider, model, usage, note?)`，写入原生 `usage` 条目，并发出 `entry_appended`。footer、`getSessionStats`、按模型的用量拆分和 Goal 预算本来就会汇总这类条目。文档：`coding-agent/docs/extensions.md`。
- SoL-Pi `0.1.0-rotom.1` 用它记录 Reducer 的每次模型回复（`sol_pi_reducer`）。详见 `packages/rotom-sol-pi/UPSTREAM.md`。

### 验证（macOS arm64 / Node 24.18.0，干净 env）

| 检查 | 结果 |
|---|---|
| `npm run build:pi` / `check:pi` / `build-pi-fork.test.mjs` | PASS；`1.3.0-rotom.2`，builder 内 focused 回归全部通过；2/2 |
| coding-agent 全量 vitest | 2781 passed、50 skipped、0 failed（两个既有失败已消除） |
| agent 全量 vitest | 95 passed |
| 新增 `pi.appendUsage` 测试 | PASS；去掉 runner 里的接线后失败（runtime not initialized） |
| `rotom/bin/check-personal` | 329 + 87 PASS，default footprint PASS（第一次运行时 `process-tree` 超时用例在系统 load ≈168 下失败，单独重跑 3 次均 5/5，整套重跑全部通过） |
| full / scoped footprint | PASS（36,432 / 35,656 normalized schema bytes，与合同一致） |
| default / full `smoke-runtime.mjs` | PASS |
| `npm run test:distribution` | 25/25 |
| SoL-Pi 上游测试 + `tsc` | 依赖锁定的上游 Pi `0.85.1`（没有 `appendUsage`）：165 通过，另 2 个 `install-guide` 失败只因缺少上游 `AGENTS.md`/`CLAUDE.md`；`tsc` 0 错误。换成 fork `1.3.0-rotom.2` 包并补齐这两个文件：167/167，`tsc` 0 错误 |
| 离线端到端 | 用 `rotom/bin/rotom -p` 加 faux provider（主模型和 Reducer 都是 faux），走产品自带 SoL-Pi：Reducer 回复写入 1 条 `usage`（`sol_pi_reducer`、`fauxr/reducer`、1,935 token）；工具结果替换为 receipt；运行时的 `getUsageCostBreakdown` 单列 `fauxr/reducer` |

未验证：真实 Reducer 请求（需要 Codex 额度），以及真实 TUI 中 footer 的显示。footer 的汇总逻辑与 `getSessionStats` 读取同一类条目，这一点来自读代码，没有在真实 TUI 中看过。

## Goal 续跑的公开 settlement 边界

Scry 的非复用入口会在 RPC `agent_settled` 后关闭 Pi。原实现先发布该事件，再执行扩展 settlement handler 排入的续跑：Goal 的下一条原生 user 消息已经持久化，但续跑会被宿主收尾中止。问题不靠把 wrapper 改名为 `rotom` 解决；复用进程也不能补回已经结束的宿主观察范围。

修复在 `AgentSession._emitAgentSettled`：保留扩展逐段收到的 settlement 回调；SDK/JSON/RPC 订阅者只在整条延期续跑（包括同级多个动作）完成后收到一次公开事件。事件携带最后一段的取消状态，不用前一段成功覆盖后续中止。这是公开事件时序修正，不修改 schema，不重发历史工具，不伪造旧归档。

验证（离线，无真实模型费用）：

| 检查 | 结果 |
| --- | --- |
| 新增 session/RPC 回归的旧实现负对照 | 3 个失败，均捕获续跑前多出的公开 settlement |
| 真实 Goal + 原产品 Pi 的负对照 | 模型调用次数 2 和 5 时各发一次 settlement；应仅在 5 时发出 |
| 修复后的边界/RPC focused tests | 44/44；相邻并发、重试、runtime、状态报告 51/51 |
| `build:pi` / `check:pi` / builder tests / TypeScript / Biome | 通过；构建器 957 通过、3 个原有 skip；builder tests 2/2 |
| 隔离安装新 fork 的完整 Goal 测试 | 87/87，包含 100-response 上限、取消、恢复、不重放与 reviewer |
| Scry 真实适配器 + 新 fork CLI + `default.sh` + 离线流式模型 | 临时集成夹具通过；两次 `agent_start` / `agent_end` 后只有一次 `agent_settled`；第二段回复进入 Scry events，原生文件保留两条 assistant |

RPC 测试 helper 多次启动 `runRpcMode` 后会触发 Node listener 数量告警；断言均通过，不把该夹具告警当作真实进程泄漏结论。零延迟测试模型另触发 Scry 已有的“多个新增 user entries”身份歧义拒绝；集成验证使用流式速率，匹配本次先接纳首条输入、再执行续跑的场景，不宣称解决该独立身份问题。

未验证/未执行：真实账号模型、桌面 UI 重放、活跃安装替换、旧会话恢复。旧归档缺口仍按 unknown 保留；升级不自动补写旧记录或恢复任务。
