# npm 正式发布顺序

本文件是 `CLAUDE.md` 的强制发布合同，不是历史记录。处理 npm 发布前必须完整阅读；进入 `main` 还须先通过 [main 回归门禁](eval-system/main-regression-gate.md)。下列源码路径及命令均相对仓库根。

npm publish 是不可逆外部写入。只有用户明确授权精确 version 与 dist-tag 后才执行；缺少任一项就停下询问，不从“准备发布”推断写入授权。

1. **先收口产品改动。** 功能、修复和非发布记录文档先各自验证并同步公开 `main`；进入发布后不再混入其他改动。从最新公开 `origin/main` 建独立干净 clone，使用 GitHub noreply identity，并用 Git 命令读取 commit SHA，禁止手填。确认远端没有不兼容移动、工作区干净、目标 npm version 尚不存在。
2. **单独提交发布元数据并冻结。** 一次确定 package version、预期 dist-tag、`publishConfig.access=public`、`UNLICENSED` 与发行说明；同步 `rotom/package.json` 和相关文档并先 fast-forward 推送，以该 commit 作为唯一构建源。Pi 源码或构建器变化时在此之前完成 `build:pi` / `check:pi`。
3. **只接受一个最终产物。** 在公开 clone 中仅对冻结 commit 成功执行一次 `npm run pack:release -- /absolute/output-dir`；只继承标准代理路由变量，不读用户全局 npmrc，不并发重度任务，不循环 pack。任何会改变 package 内容的后续修改都会使 tgz 失效，必须回到第 1 步重新冻结和构建。
4. **围绕实际 tgz 验证。** 记录文件数、压缩/解包大小、SHA-256 与 SRI；审计实际 tgz，并按 [verification.md](verification.md) 在隔离 HOME/prefix、PATH 无全局 Pi 的环境完成安装、`rotom --version`、default/full smoke、`check-personal`、升级与卸载检查。不得用源码目录测试、dry-run 或旧 artifact 替代最终 tgz。
5. **npm 认证只交给用户的前台终端。** 已配置 GitHub Actions Trusted Publishing 时优先使用 OIDC；否则 Agent 不运行 `npm login`、不启动 Terminal/浏览器、不代填账号，也不接触密码、OTP、恢复码或短时 token。Agent 先用 `node scripts/npm-release-handoff.mjs commands <absolute-tgz> <tag>` 生成分阶段精确命令，向用户逐段贴出；用户在自己的前台终端执行 login、`npm whoami` 与网页确认并回报结果，Agent 独立只用 registry 查询核对公开状态。除非用户在看到精确命令后另行明确要求 Agent 执行，后续发布均遵守此交接方式。
6. **发布命令由用户执行一次。** Agent 再次确认公开 commit、目标 version 空缺、预期 dist-tag、固定 tgz 的 SHA-256/SRI 与授权一致，然后贴出 `npm publish <tgz> --ignore-scripts --access public --tag <tag> --registry=https://registry.npmjs.org`，不得自行执行。若出现 `EOTP`，用户只处理 npm 在该前台命令中显示的官方 challenge；Agent 先查 registry，不根据错误文本盲目要求重发。发布后运行 handoff helper 的 `verify`，只有 registry version/tag/digest 与下载字节全一致才进入安装阶段；本机切换命令也贴给用户执行，Agent 仅只读回验。
7. **区分 submitted、reviewing 与 verified。** HTTP 202、CLI exit 0 或“being processed”只表示 npm 已接收，不表示已公开。目标 version 在 registry 尚不可见时，若 Browser Relay 可用，先只读检查 npm 官方 package 的 Versions 页；页面明确显示该 version 为 `Validating` 或 “Automated review hasn't finished” 时，立即告知用户“npm 正在自动审核，审核完成前版本不可用”，将状态记为 `reviewing` 并暂停当前发布流程。审核期间绝不重复 publish，也不更新本机安装、不写正式发布记录、不创建 release tag；用户后续要求继续时先只读复核页面与 registry。无法证明处于审核中时，才每 30–60 秒只读查询精确 version 与 dist-tag，最多 30 分钟；到时仍不可见则标记 `unknown` 并交接。`0.1.0` 曾实测异步处理约 25 分钟，不能把等待误判为失败。
8. **用 registry 证明结果。** 只有精确 version、预期 dist-tag、integrity、shasum 与 tarball URL 同时出现，并且下载 tarball 的摘要及字节与最终 tgz 一致，才算 npm 发布完成。
9. **最后记录和清理。** 在公开 clone 记录构建源 commit、验证结果和 artifact 摘要，创建注解 `v<version>` tag，并将 release commit 与 tag 原子 fast-forward push；随后同步本地 tracked tree。Agent 向用户贴出 helper 生成的 logout、`npm whoami` 失败回读及临时认证目录删除命令，由用户在同一前台终端执行并回报；随后 Agent 再删除本次创建的 clone、staging 和 artifact 路径。
