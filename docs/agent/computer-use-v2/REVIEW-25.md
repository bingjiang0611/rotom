# Computer Use v2.1 第 25 轮审核：HANDOFF-6 阶段 2 第二步，helper 更新命令与 rotom.4 归档（`d41fa1e..7eea832`）

## 结论

阶段 2 通过，可以进入阶段 3（文档）和阶段 4（合入 `main` 的候选）。

## 审核要点

- **U1**：`scripts/macos-sources.mjs` 成为 `build-native.mjs` 和 `setup-helper.mjs` 共用的 Swift 文件列表（9 个），归档内源码也含全部 9 个文件。
- **U2 `rotom helper update`**（`scripts/helper-update.mjs`）：
  - 用 `lsof` 检查是否有进程打开着 helper 可执行文件；无法确认时按“在用”拒绝；签名完成、替换之前再检查一次。
  - 路径要求规范、拒绝符号链接；用锁目录防止并发更新；在同一目录准备副本后用 rename 原子替换；替换失败时保留旧 app 并报告位置，不自动重试。
  - 设置 `PI_COMPUTER_USE_CODESIGN_IDENTITY` 时用该身份重签副本，标识固定为 `com.injaneity.pi-computer-use`，便于沿用已有系统权限；
    已有 helper 而新副本仍是 ad-hoc 签名时**拒绝替换**（除非显式设置 `PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1`），防止把用户可用的 helper 换成会被端点安全终止的版本。
  - 不结束进程、不启动 helper、不生成证书、不导出私钥。
  - 启动器只在第一个参数是 `helper` 时拦截，并先校验第三方包合同和相关脚本是普通文件；其余参数照旧交给 Pi。
- **U3**：协议不匹配提示写明“退出会话和旧 helper，运行 `rotom helper update`；受管 Mac 先设置 `PI_COMPUTER_USE_CODESIGN_IDENTITY`”。
- **U4**：归档 `injaneity-pi-computer-use-0.5.1-rotom.4.tgz` 的实算 sha512 与 `product-config.mjs`、third-party lock 三处一致；
  归档中 universal、arm64、x64 三个 helper 都含本轮新增的不变量标记（`takeover-pause-resume-30s`），确为 v2.1 源码构建。

## 审核者复现

- Computer Use 包串行：311 项，305 通过、1 失败、5 跳过；唯一失败需要真实 TypeScript 编译器（审核容器未安装依赖）。
- `rotom/runtime/update-helper.test.mjs` 与 `third-party-archive.test.mjs`：12 项，10 通过、1 失败；该失败是启动器要求 Node ≥ 24，审核容器为 Node 22。
  执行方在 Mac（Node 24）上报告 `npm test` 311/311、产品与分发检查 75/75。
- 当前文件树审计 PASS 0。

## 推送

执行方的会话内推送以 `Killed: 9` 失败，原因未确定；用户在自己的终端推送成功，远端为 `7eea832`。

## 阶段 3 需要补的文档

- 根 `CLAUDE.md`：launcher 新增 rotom 自有子命令 `rotom helper update`（第一个参数为 `helper` 时由 launcher 处理，不交给 Pi），写进 launcher 合同；
  按 HANDOFF-6 的证据表如实更新 Computer Use 状态。
- 发布说明：升级步骤（先退出会话和旧 helper，受管 Mac 设置签名身份，运行 `rotom helper update`，再开新会话）。

## 阶段 4 的方式

干净副本重放后，**先推到候选分支**（例如 `claude/computer-use-v2.1-main-candidate`）供审核，审核通过后再 fast-forward 推 `main`。
