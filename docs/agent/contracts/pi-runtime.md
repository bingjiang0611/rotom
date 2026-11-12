# Pi 接入与维护合同

> 本文最初原样搬自根 `CLAUDE.md` 第 1 节（2026-11-12 拆分；本次同步 Computer Use 候选合同），与 CLAUDE.md 具有同等约束力；改动本领域之前必须读完本文。文中出现的“本文件”指根 CLAUDE.md 连同本文。文中的具体版本号可能落后，以 `rotom/runtime/product-config.mjs` 与 `rotom/runtime/pi/fork-build.json` 为准。

rotom 当前通过仓内 `packages/rotom-pi/` 的 Pi fork 接入 `@earendil-works/pi-coding-agent`，不再默认依赖官方 npm Pi 或旁边的 Pi checkout。公开 API 与组合层是优先方案，不是强制边界；允许按任务需要修改或 fork Pi、使用私有 Extension API，以及调整或自行实现生命周期。相关改动需说明兼容性影响并完成对应验证。

- `rotom/bin/rotom` 是 npm 公开入口，只解析 bin symlink 并 exec 唯一内部 launcher `rotom/bin/rotom-launcher`。
- `rotom helper update` 是 **rotom 自有子命令**：第一个参数为 `helper` 时由 launcher 处理，交给 `runtime/update-helper.mjs`，不透传 Pi，也不启动 AgentSession。当前只接受 `helper update`；它显式更新 `~/Applications/pi-computer-use.app`，不启动 helper。用户须先退出所属会话和旧 helper；受管 Mac 先设置 `PI_COMPUTER_USE_CODESIGN_IDENTITY` 为已有、获准的签名身份。更新失败或状态 unknown 不自动重放。
- 默认仅从产品 `runtime/pi/node_modules/` 解析固定 Pi fork；七个运行时包（含 Codemode 与 MCP）由仓内源码构建，构建期归档、lock、源码/构建器摘要必须匹配；启动期只验证元数据、installed package identity 和 capability，不证明解压文件未被修改。发行包不携带构建用 vendor tgz，不查 ancestor hoisting、不回退 PATH/global/旁路 Pi。`ROTOM_PI` 是显式维护覆盖，仍过原有 identity/capability gate，不代表默认发行版本。
- Pi 源码或构建器改动后先 `cd rotom && npm run build:pi`；发布维护命令为 `npm run pack:release -- /absolute/output-dir`：拒绝陈旧 fork 归档，隔离 HOME/cache、按锁文件新安装 Pi fork 与第三方依赖后打包；禁止复制维护者 node_modules 或把评测、会话、凭据带入发行包。npm 发布固定使用公开作用域包 `@bingjiang0611/rotom`；许可证仍为 `UNLICENSED`。
- `pack:release` 偶发 `spawnSync npm ETIMEDOUT` 先排查是不是自己造成的资源/网络争用（把多次 pack 塞进循环、同时跑重度任务、残留 staging 堆积），不是脚本 300s/单调用 cap 太紧或基础设施故障：隔离单次 `npm ci` 实测远低于该 cap（根与第三方各数十秒）。清掉 `$TMPDIR/rotom-release-*` 残留后单次干净重跑即可，不要为此放宽 timeout 或改发布脚本。
- launcher 保留业务 cwd 和用户 argv；仓库根不能冒充用户项目。
- `ROTOM_PI`、`ROTOM_NODE` 只接受绝对、存在、可执行的普通文件；解析 realpath 后固定同一 executable。
- Pi package identity、`bin.pi`、公开 exports 和当前能力必须在启动前验证。
- 允许直接修改 Pi 或第三方 package 的源码及 installed source；选择源码、wrapper、adapter 或 policy seam 时以问题归属和可维护性为准。
