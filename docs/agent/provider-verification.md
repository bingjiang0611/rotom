# Provider 离线验证

维护入口，不进入 npm 产品文件清单，不是模型质量或付费评测。

```bash
# 仓库根；也由 rotom/bin/check-personal 调用
npm --prefix rotom run test:providers
# JSON 报告写入已存在的 canonical 目录；文件必须不存在，权限 0600
npm --prefix rotom run test:providers -- --report /absolute/new-report.json
```

## 边界

- 只支持固定离线矩阵，不接受 `--live`、任意模型或额外测试参数。Pi AI 原始 `npm test` 仍混有真实请求测试，部分测试在模块加载时解析/刷新 OAuth；**不要把该宽入口当作离线门禁**。
- 子进程使用临时 HOME/agent/XDG 目录、白名单环境和合成凭据；不继承 key、代理、外部 preload、真实探针账本。SDK 用完的临时目录被删除，不覆盖存活安装。
- preload 阻断 Undici 请求、Node HTTP 请求和 Socket.connect；覆盖当前选用 Node 测试及 Pi loader realm，不是 OS 沙箱，不宣称约束任意 executable/native addon。维护回归分别测试 fetch、VM、worker、子进程、HTTP、TLS 与原始 TCP；合成 Response 不受影响。
- 默认通过现有 `resolveInstalledPi` 校验仓内运行时。失配时源码单测仍可运行，SDK 行明确 `BLOCKED`，整体非零退出，不降级到 PATH/global Pi。
- 既有 `ROTOM_PI=/canonical/pi/executable` 仅用于显式维护覆盖；报告记录 `explicit-override`，它不证明 bundled identity 或当前源码对应的 Pi 已安装。
- 不构建、不安装依赖、不刷新真实账号、不自动重试。缺依赖或运行时须在检查外显式处理。

## 固定矩阵

| Case | 现有检查 | 证明范围 |
|---|---|---|
| qoder-contracts | 全部 Qoder colocated tests + stream-shape | 协议、身份、目录、输入能力、计费与诊断边界 |
| pi-ai-contracts | retry、provider-retry、Responses terminal、provider error、message frame | Pi AI 源码的确定性合同；不是全 Provider live sweep |
| browser-oauth-lifecycle | oauth-smoke | 合成浏览器登录、磁盘恢复、串行刷新、密封请求、登出 |
| direct-tool-roundtrip-cli-fixture | smoke | lite 工具往返、usage、预取消；显式 CLI 认证 fixture |
| session-restore-compaction-cli-fixture | session-smoke --extended | 原生工具循环、会话分支/恢复/压缩、账号隔离 |
| stream-cancel-replay-cli-fixture | stream-smoke | 中途取消、独立后续请求、跨 Provider 工具历史 |
| cosy-tool-roundtrip | catalog-sdk-smoke --offline smodel | browser fixture、目录、COSY、签名回传、credits |
| cosy-late-error | 同上 --negative-trailer | 迟到错误不能映射为完成/已知费用 |
| native-output-budget | input-budget-smoke | 三模型 244K→4096、272K→1、调用方小上限；真实 bundled extension loader 的 direct 预算 |

三个历史 CLI fixture 显式指定 `authMode:qodercli`，不因产品默认 browser 改变而意外进入真实认证路径；browser 路径由独立用例覆盖。

## 报告与判定

`rotom-provider-verification/v1` 记录：

- Node 版本、起止时间、源码 commit/dirty、Git-owned 输入集合摘要及 Pi 源码摘要。
- 实际 Pi 入口、六个运行时包的 version/source/compiled 摘要，以及 `compiledPiMatchesSource`。
- 每项固定命令、cwd、执行/未执行、状态、实际测试计数、退出状态、时长与输出摘要；不保存输出正文、HTTP、凭据或合成会话。
- 执行前后重复核对源码和 Pi 字节/文件权限；Pi 包按实际 executable 的模块解析结果定位，包含可能的 nested dependency，不拿未使用的 sibling 包作证据。漂移或进程超时为 `UNKNOWN`；不重放。失败之后的用例为 `SKIPPED`。
- 复用 `executeProcessTreeV1` 管理每个检查的 owned process group。超时/输出超限停止该组；无法确认组已关闭时保留临时 HOME 并记录位置。进程组关闭不证明逃逸进程或外部业务效果。
- exit 0 不是充分条件：smoke 必须输出 `pass:true`；测试必须实际执行且没有失败、跳过、todo 或取消。全部选中项通过才整体 `PASS`。

该矩阵是**当前 Qoder 源码 + 明确标识的已安装 Pi**，不是实际 npm tgz 的完整验收。显式 override 下即使矩阵 PASS，`compiledPiMatchesSource:false` 仍意味着不能声称当前 Pi 源码已安装。报告不自动继承历史结果；live 始终 `not-run`。报告文件为空/不完整也不构成成功证据。

## 本次接入发现的回归

Qoder 自有请求构造曾仅限制 `maxTokens<=4096`，漏掉 Pi 原生上下文预算。现通过实际 Pi 的公开 `api/simple-options` 导出复用 `clampMaxTokensToContext`，保留 4096 safety、最小输出 1 和既有窗口，不复制预算算法。

Pi 的 jiti alias 会把任意 ai 子路径错误拼接到 compat.js；因此 helper 从 launcher 的 `ROTOM_VERIFIED_PI_EXECUTABLE`（维护 SDK 使用显式 `ROTOM_PI`）所关联的 Pi 包导出解析，不从业务 cwd 找依赖。不新增 fork 导出或修改存活安装。内部 factory 的 `clampMaxTokens` 注入仅供隔离单测；原生 SDK/实际 extension loader 回归使用真实 helper。

## 真实请求

仍使用 [Qoder 维护探针](../../experiments/qoder-provider/README.md) 的独立入口。必须先明确目标 model/route/effort、预算和外部权限，复用有界 ledger、串行执行、unknown 不重放；离线 PASS 不授予真实调用权限。现有账本是特定 Node/Undici 路径的请求次数约束，不是货币预算或通用网络隔离。

图片/长上下文、更多模型及实际安装的真实验收，按 [验证与交付](verification.md) 选择受影响专项，不自动扩大到全量付费矩阵。
