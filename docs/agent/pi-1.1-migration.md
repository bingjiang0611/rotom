# Pi 1.1.0 对齐

交付 fork：`1.1.0-rotom.1`，上游基点为 `v1.1.0`（`abe508e1b89912adde45528136c3221eb69acdd7`）。此版本取代 [Pi 1.1 backports](pi-1.1-backports.md) 中只移植部分修复的 `1.0.4-rotom.2`。

## 做法

- 先把 `1.0.4-rotom.2` 的 Git 源码树作为一个提交放在上游 `v1.0.4` 之上，再执行三方合并 `v1.1.0`。之前提前移植的 10 个 1.1.0 提交已包含在新基线中。
- 32 个冲突文件的处理：
  - 维护文件（`.github`、`.pi`）：继续省略。
  - 分类器代码：继续删除。
  - `outputPad` 和程序状态上报：与 rotom 的改动并存。
  - rotom 自有的测试和启动计时：保留。
- 上游 package.json 与 lock 文件和 `v1.1.0` 完全一致。rotom 自己没有修改过这些依赖声明。
- 模型目录取自经 SRI 校验的 `@earendil-works/pi-ai@1.1.0` 发行包的 `dist/providers/data`。导入时：
  - 删除分类器 API 分组（`cloudflare-workers-ai-system-one`、`typesafe-system-one`、`openai-decisions`）；
  - 删除只含分类器的 `typesafe.json`；
  - 删除所有 `typesafe/` 条目（与生成器的过滤规则一致）；
  - 重算 manifest。
- 用同一规则处理 1.0.4 发行包，可以复现旧目录的 `structureHash`（`a9413450…`）。

## 行为变化

- **新增 1.1.0 功能**：
  - Claude Haiku 5.5 及其他新目录项；
  - `--tools` / `defaultTools` 支持只含 `+name`/`-name` 的增减语法；
  - 输出边距 `outputPad`；
  - 记录响应与 durable 任务耗时；
  - MCP OAuth 与 Termux 剪贴板等修复。
- **OSC 7501 程序状态上报**：终端回应支持查询后才发送。`PI_PROGRAM_STATUS=0` 关闭，`=1` 跳过查询直接发送。报告中的 `app` 固定为 Pi 兼容的进程身份 `pi`，不随 UI 品牌改成 `rotom`。这与主进程/RPC 保留 `pi` / `pi-rpc` 身份的合同一致。
- **`--tools +name` 也算显式工具选择**：launcher 遇到它时不收窄 deferred 默认工具面。这沿用现有的"显式选择优先"合同。
- **llama.cpp**：只能输出 decisions 的模型不进入聊天目录，也不会被探测。分类器调用路径没有恢复。
- **不恢复的能力**：OpenAI Decisions/GPT-6 Luna 分类、llama.cpp System One、分类器图片输入、`noRetryStatuses`（只被 Decisions 使用）。上游 CHANGELOG 中的相关条目作为历史记录保留。

## 验证（macOS arm64 / Node 24.18.0）

| 检查 | 结果 |
|---|---|
| `npm run build:pi`：隔离锁定安装、全 workspace offline build、builder focused 回归 | 685 passed，3 skipped |
| fork 全 workspace `tsc --noEmit`；本次改动的 TS 文件跑 Biome | PASS |
| 改动包全量套件：ai / agent / codemode / tui | ai 1270 passed（排除需要本机 Ollama 的两个 E2E 文件）；agent 93、codemode 74 passed；tui `node --test` PASS |
| coding-agent 全量 | 2773 passed，6 failed；见下方说明 |
| `check:pi`、`build-pi-fork.test.mjs`、`test:distribution` | PASS；2 + 25 tests |
| runtime 按新 lock 重新 `npm ci`，`verify-pi-runtime.test.mjs` | 39 passed |
| `rotom/bin/check-personal`（清空继承的 `ROTOM_*`/`PI_*` 环境） | 314 + 87 tests PASS；Provider 离线矩阵、footprint runtimeContractGate PASS |
| default / full `smoke-runtime.mjs` | PASS；真实 `createAgentSession`，0 lifecycle errors，无真实模型调用 |
| 仓库外临时 Git 项目运行 launcher 的 `--version` / `--help` | `0.1.17`；help 含 `+name/-name` |

coding-agent 的 6 个失败中，4 个在 `1.0.4-rotom.2` 基线上以完全相同的错误失败，属于既有问题，本次没有修：

- `agent-session-concurrent` steering
- `interactive-mode-compaction` 的 partial output（`maybeSuggestBugReport`）
- `model-catalog-protocol` 仍期望 `classifier` 类型
- `agent-session-runtime` settles

`experimental-remote-runtime` 只在全量并行时出现锁竞争，单独运行通过。剩下一个是 rotom 测试替身缺少新的 `programStatus` 字段，已经修复。

开发中的其他修正：

- rotom 保留的两个工具耗时测试改用上游的 `createAssistantMessageEventStream()`，因为上游已删除 `MockAssistantStream`。
- 新增回归测试：在 rotom 品牌下 OSC 7501 的 `app` 仍为 `pi`。该测试在旧实现上失败，修复后通过。

## 未验证

- 真实 Provider 调用和计费。
- 真实终端中的 OSC 7501 效果。
- 跨平台、桌面 GUI、PTY。
- npm `pack:release` 与 tgz 安装。

本次没有 npm 发布、全局安装切换或存活会话迁移。
