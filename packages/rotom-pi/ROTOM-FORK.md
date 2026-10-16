# rotom Pi fork

本目录是 rotom 仓内维护的 Pi 源码，不是 sibling checkout、Git submodule 或已安装 node_modules 的副本。来源、上游 revision、fork 版本及明确省略的维护文件见 `FORK.json`；保留上游 MIT `LICENSE` 与 package identity。此目录的上游 README/CHANGELOG 描述上游工具，rotom 的实际产品合同以仓库根指南为准。

- 当前基线：Pi 1.3.0，fork `1.3.0-rotom.2`。`1.3.0-rotom.1` 由 `1.1.0-rotom.2` 以上游 `v1.1.0` 为 base 三方合并 `v1.3.0` 得到。OSC 7501 程序状态的 `app` 固定为 Pi 兼容身份 `pi`。上游功能代码全部保留，包括分类器模型/API、虚拟模型路由与内置 MCP；rotom 不自带分类器调用或虚拟模型。
- `1.3.0-rotom.2`：中止后的轮次在本地以 aborted 助手消息收尾，不再携带已中止的 signal 请求 provider；扩展 API 增加 `pi.appendUsage`，把扩展自行发起的模型请求写入原生 `usage` 条目。见 `docs/agent/pi-1.3-migration.md`。
- 保留差异：原生 `/model` 与 `/scoped-models` 统一优先显示名称并保留 ID/provider；支持 picker-local thinking 草稿、确认/取消及能力限制；带定向回归。
- 原始会话 fixture 不带入；大型压缩测试改为合成数据。未导入上游 Git 历史、个人状态、安装目录、CI 发布配置或 agent 指令。其余源码与开发 workspace 保留；上游已删除实验性 client/protocol/server，`chord` 仍在 workspace 中但不再是运行时依赖。
- `packages/ai/src/providers/data/` 来自经过 SRI 校验的官方 `@earendil-works/pi-ai@1.3.0` 发行包 `dist/providers/data`，是固定的公开模型目录输入。查询发布状态与下载时直接使用 `registry.npmjs.org`；本机默认镜像可能滞后。原样导入，不过滤分类器或 TypeSafe 条目。`FORK.json` 记录来源及导入摘要。普通构建不联网刷新模型，不代表目录中的每个模型都由 rotom 启用。
- 构建入口：在仓库 `rotom/` 下执行 `npm run build:pi`。隔离 HOME/cache，按本目录 lockfile 安装，执行上游 offline build 和定向测试，生成七个运行时归档及 `runtime/pi/package-lock.json`。
- 七个运行时包（`pi-telemetry`、`pi-ai`、`pi-tui`、`pi-agent-core`、`pi-codemode`、`pi-mcp`、`pi-coding-agent`；1.3 起不含 `chord`）保留上游名称，归档使用 `FORK.json` 的 `forkVersion`，含 `rotomFork` 来源摘要。上游源 package.json/lock 保持构建版本；不伪造这些源码属于已发布的 fork npm 包。
- 修改源码后必须重建；`npm run pack:release` 校验源码摘要，拒绝陈旧归档。fork 版本升级需先修改 `FORK.json`，再同步 product config、构建归档和 runtime lock。
- 发行安装携带独立 Pi runtime；不从这里直接运行存活产品会话，因此后续构建不会删除正在使用的 lazy chunks。显式 `ROTOM_PI` 仍是维护覆盖，不是日常配置。

上游同步：选择明确 revision，在此目录审阅/合并源码差异，更新来源记录和目录数据摘要，再执行上述构建及 rotom runtime/distribution gate。不要复制上游 `.git` 或运行其 publish/release 脚本；不自动发布或推送。
