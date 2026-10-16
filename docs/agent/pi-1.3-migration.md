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
- `agent-session-concurrent` steering 与 `agent-session-runtime` settles 两个失败与 1.1 迁移记录中的既有失败相同，原因是 rotom agent loop 的 abort 守卫；纯净 `v1.3.0` 通过。本次没有修。

## 事件记录

一次未过滤的 ai 全量运行触发了 Ollama E2E 测试，向本机 Ollama 拉取了 `gpt-oss:20b`（约 13 GB）并启动了 Ollama.app。已用 `ollama rm` 删除该模型并停止 Ollama 进程。之后的 ai 运行都排除这两个文件。

## 未验证

- 真实模型调用，包括 Qoder 跨模型切换的实际效果、kimi-coding 新端点和 GPT-6 缓存。
- 真实 TUI/PTY 的 resume 与模型切换。
- `pack:release`、tgz 安装、升级与卸载。

本次没有推送、npm 发布、全局安装切换或存活会话迁移。
