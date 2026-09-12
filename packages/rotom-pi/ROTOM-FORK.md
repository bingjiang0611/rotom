# rotom Pi fork

本目录是 rotom 仓内维护的 Pi 源码，不是 sibling checkout、Git submodule 或已安装 node_modules 的副本。来源、上游 revision、fork 版本及明确省略的维护文件见 `FORK.json`；保留上游 MIT `LICENSE` 与 package identity。此目录的上游 README/CHANGELOG 描述上游工具，rotom 的实际产品合同以仓库根指南为准。

- 初始差异：原生 `/model` 优先显示名称，支持 picker-local thinking 草稿、确认/取消及能力限制；带定向回归。
- 原始会话 fixture 不带入；大型压缩测试改为合成数据。未导入上游 Git 历史、个人状态、安装目录、CI 发布配置或 agent 指令。其余源码与开发 workspace 保留，实验性 server/client 不随 rotom 发行。
- `packages/ai/src/providers/data/` 是固定的公开模型目录输入；`FORK.json` 记录导入摘要。普通构建不联网刷新模型，不代表目录中的每个模型都由 rotom 启用。
- 构建入口：在仓库 `rotom/` 下执行 `npm run build:pi`。隔离 HOME/cache，按本目录 lockfile 安装，执行上游 offline build 和定向测试，生成六个运行时归档及 `runtime/pi/package-lock.json`。
- 六个运行时包保留上游名称，归档使用 `FORK.json` 的 `forkVersion`，含 `rotomFork` 来源摘要。上游源 package.json/lock 保持构建版本；不伪造这些源码属于已发布的 fork npm 包。
- 修改源码后必须重建；`npm run pack:release` 校验源码摘要，拒绝陈旧归档。fork 版本升级需先修改 `FORK.json`，再同步 product config、构建归档和 runtime lock。
- 发行安装携带独立 Pi runtime；不从这里直接运行存活产品会话，因此后续构建不会删除正在使用的 lazy chunks。显式 `ROTOM_PI` 仍是维护覆盖，不是日常配置。

上游同步：选择明确 revision，在此目录审阅/合并源码差异，更新来源记录和目录数据摘要，再执行上述构建及 rotom runtime/distribution gate。不要复制上游 `.git` 或运行其 publish/release 脚本；不自动发布或推送。
