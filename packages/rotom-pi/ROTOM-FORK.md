# rotom Pi fork

本目录是 rotom 仓内维护的 Pi 源码，不是 sibling checkout、Git submodule 或已安装 node_modules 的副本。来源、上游 revision、fork 版本及明确省略的维护文件见 `FORK.json`；保留上游 MIT `LICENSE` 与 package identity。此目录的上游 README/CHANGELOG 描述上游工具，rotom 的实际产品合同以仓库根指南为准。

- 当前基线：Pi 1.0.4，fork `1.0.4-rotom.2` 定向移植 1.1.0 的 Codemode async/输出、settled aborted、工具耗时、上下文估算、分层计费与 Provider 修复；不引入 OSC、新模型能力或 assistant/durable 计时。保留普通聊天、Codemode 工具编排、图片生成、全屏及上下文管理；删除分类器类型/实现/目录和虚拟自动路由 API、示例与调度。旧会话仍可读取，不删除历史自定义记录。MCP 源码/依赖保留，但不注册内置 MCP、不自动发现或连接服务器。
- 保留差异：原生 `/model` 与 `/scoped-models` 统一优先显示名称并保留 ID/provider；支持 picker-local thinking 草稿、确认/取消及能力限制；带定向回归。
- 原始会话 fixture 不带入；大型压缩测试改为合成数据。未导入上游 Git 历史、个人状态、安装目录、CI 发布配置或 agent 指令。其余源码与开发 workspace 保留，实验性 server/client 不随 rotom 发行。
- `packages/ai/src/providers/data/` 来自官方 `@earendil-works/pi-ai@1.0.4` 发行包，是固定的公开模型目录输入；另从经过 SRI 校验的 1.1.0 发行包补齐 154 个现有目录项的分层价格，仅在基础价格一致时复制 cost，不改变模型 identity/能力。Haiku latest 别名基础价格已变化，未借此升级别名。`FORK.json` 记录来源及导入摘要。普通构建不联网刷新模型，不代表目录中的每个模型都由 rotom 启用。
- 构建入口：在仓库 `rotom/` 下执行 `npm run build:pi`。隔离 HOME/cache，按本目录 lockfile 安装，执行上游 offline build 和定向测试，生成八个运行时归档及 `runtime/pi/package-lock.json`。
- 八个运行时包（原六包加 `pi-codemode`、`pi-mcp`）保留上游名称，归档使用 `FORK.json` 的 `forkVersion`，含 `rotomFork` 来源摘要。上游源 package.json/lock 保持构建版本；不伪造这些源码属于已发布的 fork npm 包。
- 修改源码后必须重建；`npm run pack:release` 校验源码摘要，拒绝陈旧归档。fork 版本升级需先修改 `FORK.json`，再同步 product config、构建归档和 runtime lock。
- 发行安装携带独立 Pi runtime；不从这里直接运行存活产品会话，因此后续构建不会删除正在使用的 lazy chunks。显式 `ROTOM_PI` 仍是维护覆盖，不是日常配置。

上游同步：选择明确 revision，在此目录审阅/合并源码差异，更新来源记录和目录数据摘要，再执行上述构建及 rotom runtime/distribution gate。不要复制上游 `.git` 或运行其 publish/release 脚本；不自动发布或推送。
