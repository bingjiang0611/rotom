# Pi 1.1.0 对齐

交付 fork：`1.1.0-rotom.2`，上游基点为 `v1.1.0`（`abe508e1b89912adde45528136c3221eb69acdd7`）。

此版本取代 [Pi 1.1 backports](pi-1.1-backports.md) 中只移植部分修复的 `1.0.4-rotom.2`，也取代已推送到公开 `main`、但未发布到 npm 的 `1.1.0-rotom.1`。

## 版本说明

- **`1.1.0-rotom.1`**：合并 v1.1.0，但继续删除分类器、虚拟模型路由，也不注册内置 MCP。
- **`1.1.0-rotom.2`**：按用户决定，恢复上游全部功能代码。只继续省略两类文件：
  - 上游维护文件：`.github`、`.pi`、`AGENTS.md`、`.husky`、`.npmrc`；
  - 两份录制的会话 fixture。

  省略清单见 `FORK.json` 的 `omittedMaintenanceFiles`。

## 做法

- 把 `1.0.4-rotom.2` 的源码树作为一个提交放在 `v1.0.4` 之上，再三方合并 `v1.1.0`。之前移植的 10 个 1.1.0 提交已经包含在新基线中。
- 恢复功能代码时，以 `v1.1.0` 为准，逐文件对比 rotom 的差异：
  - 82 个文件的差异只是删除分类器、虚拟模型或 MCP，直接取 `v1.1.0` 版本。
  - 24 个被删除的功能文件直接恢复，包括：分类器 API 与 provider、TypeSafe、`virtual-models.ts`、`docs/virtual-models.md`、`jev-router` 示例及其测试。
  - 另有 17 个文件同时含 rotom 定制，逐个 hunk 判断。例如 `agent-session.ts` 恢复了虚拟模型状态和 `_failedResponse`，保留了 rotom 的手动压缩来源、取消处理和 picker thinking。footer 恢复了 `→ 实际模型` 显示，保留了 Qoder `Cr` 和会话 ID。
- 模型目录取自经 SRI 校验的 `@earendil-works/pi-ai@1.1.0` 发行包 `dist/providers/data`，原样导入（42 个 provider 文件，含 `typesafe.json`）。
- 上游的 package.json 与 lock 文件和 `v1.1.0` 一致。

## 行为

- **分类器**：`models.classify`、分类器目录、llama.cpp System One 与 OpenAI Decisions 均已恢复。产品本身不调用它们。只有用户脚本、Codemode 脚本或扩展显式调用时，才产生请求和费用。
- **虚拟模型**：`registerVirtualModel` API、会话里的选择与路由记录、footer 的 `→` 显示均已恢复。产品不注册任何虚拟模型；扩展注册后才会出现。
- **内置 MCP**：
  - 读取 `~/.pi/agent/mcp.json`，以及受信项目中的 `.pi/mcp.json`。没有配置时不连接任何 server。
  - 工具默认通过 Codemode 暴露，`--no-mcp` 可以关闭。
  - rotom 的 Codemode wrapper 复用上游的 `createCodemodeExtension()`。
  - launcher 把 `rotom mcp …` 当作 Pi 子命令原样透传，与 `install/list/config` 等命令的处理方式相同。如果不这样做，产品会在参数前插入 `--extension`，Pi 就识别不到 `mcp` 子命令。
- **工具面字节数**：Codemode 描述恢复为上游措辞，default、full、scoped 三个工具面的 schema 字节数都比原合同少 2，合同已同步更新。这是静态字节差，不是 provider token 数。
- **其他 1.1.0 功能**：
  - `--tools +name/-name` 语法；
  - `outputPad` 输出边距；
  - 响应与 durable 任务计时；
  - MCP OAuth 修复。
- **OSC 7501**：`app` 字段固定为 `pi`，与主进程/RPC 保留 `pi` 身份的约定一致。
- **`--tools +name`**：同样算作显式工具选择，launcher 不收窄默认工具面。

## 验证（macOS arm64 / Node 24.18.0）

| 检查 | 结果 |
|---|---|
| `npm run build:pi`：隔离锁定安装、全 workspace offline build、builder focused 回归 | 687 passed，3 skipped |
| fork 全 workspace `tsc --noEmit`；本次改动的 TS 文件跑 Biome | PASS |
| ai 全量（排除需要本机 Ollama 的两个 E2E 文件）；`check:model-data` | 1323 passed；目录有效 |
| agent 全量 | 93 passed |
| coding-agent 全量 | 见下方说明 |
| `check:pi`、`build-pi-fork.test.mjs`、`test:distribution` | PASS；2 + 25 tests |
| runtime 按新 lock 重新 `npm ci`，`verify-pi-runtime.test.mjs` | 39 passed，包含 `mcp list --json` 透传 |
| `rotom/bin/check-personal`（清空继承的 `ROTOM_*`/`PI_*` 环境） | 314 + 87 tests PASS；Provider 离线矩阵与 default footprint PASS |
| full / scoped footprint | PASS |
| default / full `smoke-runtime.mjs` | PASS；真实 `createAgentSession`，0 lifecycle errors |
| 真实 launcher 的 RPC `get_commands` | 有 `/mcp`，来源为 `builtin:mcp` |
| 真实 launcher 的 `rotom mcp list --json`，隔离 HOME，接上游 stdio fixture server | `state: connected`，tools `["echo"]` |

coding-agent 全量的结果：

- 3 个失败在 `1.0.4-rotom.2` 基线上以相同错误失败，属于既有问题，本次没有修：
  - `agent-session-concurrent` steering
  - `interactive-mode-compaction` 的 partial output
  - `agent-session-runtime` settles
- `model-catalog-protocol` 原本期望 `classifier` 类型，恢复分类器后通过。
- rotom 自己的两个测试原先断言"没有分类器、没有 MCP"，已改为断言这些能力存在。改动前，这两个测试在恢复后的代码上失败。
- find/grep 测试在隔离 HOME 下失败，因为找不到 `fd`，且离线模式无法下载。把 `fd` 放进 PATH 后 91 个测试全部通过。

## 未验证

- 真实模型调用分类器或虚拟模型，以及相关费用。
- 产品交互会话中让模型通过 Codemode 调用 MCP 工具。上游的 session 级 MCP 测试已通过。
- OAuth MCP server。
- 真实终端中的 OSC 7501 效果。
- 跨平台、桌面 GUI、PTY。
- `pack:release` 与 tgz 安装。

本次没有 npm 发布、全局安装切换或存活会话迁移。
