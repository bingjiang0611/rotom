# Computer Use v2.1 第 24 轮审核：HANDOFF-6 阶段 2 第一步，签名与安装方式调查（`fa6b8d2..d41fa1e`）

## 结论

调查接受，结论清楚、证据扎实。它带出三件必须在打包时一起解决的事（U1–U3），版本号也要改（U4）。审核者还要更正 REVIEW-15 的一处错误判断。

## 调查结论（执行方，审核者核对）

- 用户日常 helper：`~/Applications/pi-computer-use.app`，bundle id `com.injaneity.pi-computer-use`，用户的 Apple Development 证书签名，严格校验通过；
  安装来源已无法确定。
- 默认升级**不替换已有 helper**；复制预构建 `.app` 时保留归档里的签名，不会自动生成 `pi-computer-use Local Signing`。
- `PI_COMPUTER_USE_CODESIGN_IDENTITY` 已存在，但只作用于构建器，不会重签默认复制的预构建 `.app`。
- 审核者核对：`setup-helper.mjs` 的源码回退只列了 4 个 Swift 文件（`agent_cursor`、`agent_cursor_motion`、`background_text`、`bridge`），
  而 `build-native.mjs` 需要 9 个（另有 `input_source`、`takeover_border`、`takeover_state`、`takeover_state_test`、`text_outcome`），走这条回退必然编译失败。
- 审核者核对：协议不匹配时的提示（`constants/copy.ts` 的 `helperMismatchMessage`）只说“关掉相关会话，再显式安装或重启新版 helper”，没有给出具体命令。

## 审核者更正 REVIEW-15

REVIEW-15 说“已合入 `main` 的 v2 也从未进入产品归档”，这是错的。`main` 在 2026-11-08 的 `6cb5ea7` 已把 v2 打包为 `0.5.1-rotom.3`（macOS helper 为 ad-hoc 签名），
产品配置也已指向它。审核者当时只查了 `0.5.1-rotom.2` 那个归档文件的更新时间，没有看产品配置实际指向的版本。v2.1 分支在这之前分出，它的产品配置仍指向 `rotom.2`，
所以执行方用 `ditto` 装测试版的判断仍然成立。

## 升级后会发生什么（这次调查的关键推论）

新版客户端要求 helper 协议 11，而升级不替换已有 helper；用户现有 helper 是旧协议，会被拒绝，**升级后 Computer Use 不可用，直到用户换上新 helper**。
在这台受管 Mac 上，归档里的 ad-hoc 签名 helper 会被端点安全终止，所以用户的新 helper 必须用其企业允许的身份（用户自己的 Apple Development 证书）签名。

## 阶段 2 第二步必须一起做的事

- **U1 修源码回退**：`setup-helper.mjs` 和 `build-native.mjs` 改为共用同一份 Swift 文件列表，补测试防止再次分叉。
- **U2 显式的 helper 更新命令**：提供一条由用户主动运行的命令，把新 helper 装到 `~/Applications/pi-computer-use.app`：
  - 检测到有会话的 helper 正在运行就拒绝，提示先退出这些会话（遵守“禁止覆盖存活会话的 helper”）；
  - 设置了 `PI_COMPUTER_USE_CODESIGN_IDENTITY` 时，用这个身份签名装上去的副本（或从源码构建并签名），保持 bundle id 不变，以便沿用已有的系统权限；
  - 不导出私钥，不改用户证书，不调用任何规避安全软件的手段；
  - 补测试：有运行中的 helper 时拒绝；指定身份时签名正确；未指定时行为与现在一致。
- **U3 不匹配提示给出具体命令**：`helperMismatchMessage` 写出 U2 的那条命令，以及在受管 Mac 上需要设置的签名身份变量。
- **U4 版本号改为 `0.5.1-rotom.4`**：`rotom.3` 已被 `main` 上的 v2 占用，不能装入不同内容。按 `UPSTREAM.md` 重建归档，保留旧归档，
  同步 vendored tgz、third-party lock、product-config。阶段 4 合入 `main` 时，`rotom.4` 取代 `main` 上的 `rotom.3`。

## 阶段 5 的补充闸门

在隔离的 HOME 和 prefix 里安装最终 tgz 后，按 U2 的命令用用户的 Apple Development 身份把 helper 装到**隔离路径**（不是日常 helper 的路径），
确认它能在这台 Mac 上启动、`diagnostics` 为协议 11。被端点安全终止就停止发布。发布说明里写清升级步骤：先退出会话，再运行 U2 命令。
