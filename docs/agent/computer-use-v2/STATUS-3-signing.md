# HANDOFF-6 阶段 2，第一步：签名与安装只读调查

调查基线：执行分支 `fa6b8d2c`；阶段 1 审核为审核分支 `114dbce` 的 REVIEW-23。本文只记录读取本机元数据和源码所得结论，不授权安装、签名、启动、重建或发布。公开文档省略个人姓名、邮箱、证书指纹及完整本机日志。

## 1. 日常 helper 的现状

| 项目 | 本次只读结果 |
| --- | --- |
| 安装路径 | `~/Applications/pi-computer-use.app`；可执行文件为 `Contents/MacOS/bridge` |
| plist bundle id | `com.injaneity.pi-computer-use` |
| codesign Identifier | `com.injaneity.pi-computer-use` |
| codesign Authority，叶证书 | `Apple Development: <个人身份省略>` |
| codesign Authority，中间/根 | `Apple Worldwide Developer Relations Certification Authority` → `Apple Root CA` |
| TeamIdentifier | `7USHN8Q8JL` |
| 完整性与进程 | `codesign --verify --strict` 通过；路径对应的日常进程仍在运行，未连接其 socket |
| plist 版本 | `CFBundleVersion=0.5.1`，`RotomForkVersion=0.5.1-rotom.3` |

这是 Apple Development 签名，不是 ad-hoc，也不是 `pi-computer-use Local Signing` 自签名。严格签名校验仅证明签名完整性；不是公证、企业策略准入或未来版本可运行的证明。

**安装来源不能仅凭这些文件确定。** 没有 `Contents/Resources/source.sha256` 标记；plist 与现有 `0.1.27-main.e9c3d5d1` 安装内的预构建 bundle 完全相同，但已签名二进制字节不同。这与复制预构建 app 后另行签名相容，不能据此区分“setup-helper 复制后重新签名”和“人工复制/构建/签名”。针对 helper 的 shell 安装命令检索无记录；签名当日的本机 npm 日志不存在，专用安装日志目录也不存在。源码不会记录可靠的安装者/安装方式收据。

结论：**当前签名已证实；最初是 setup-helper 还是人工安装仍为 unknown。** 需要原始安装记录或用户确认补足，不把缺少 marker 当作人工安装的证明。

## 2. setup-helper 何时运行

- Computer Use 组件自己的 `package.json` 声明 `postinstall: node scripts/setup-helper.mjs --postinstall`。正常单独安装组件且启用 npm scripts 时会运行；该模式失败仅警告并以 0 退出，不能用 npm 安装成功证明 helper 安装成功。
- rotom 产品 `package.json` 不声明 npm dependency 或 helper postinstall。`pack-release.mjs` 构建时安装内部依赖使用 `--ignore-scripts`；`update-product.mjs` 的产品更新也使用 `--ignore-scripts`。不能把内置组件的 postinstall 当作产品升级时必然执行的步骤。
- 真正使用 Computer Use 的 `ensureMacosReady` 调用 `ensureInstalled`：配置了外部 socket 时跳过安装；目标可执行文件已经存在时也直接返回；只有缺失时才运行 `setup-helper.mjs --runtime`。
- 随后检查 daemon 的实际协议与路径。与新版不兼容时拒绝，不自动覆盖或重启另一会话的 helper。

因此，在这台已有日常 helper 的 Mac 上，**升级产品不等于升级/重签 helper**。协议不匹配导致工具拒绝，与端点安全终止进程是两种不同故障。

## 3. 谁签名、用什么身份：必须分支判断

| 安装路径 | 实际签名行为 |
| --- | --- |
| 归档带 `.app`：优先 universal，其次当前架构 | `installPrebuiltHelperApp` 先验证源 bundle，再用 ditto 复制，保留原签名；不调用证书选择或重签函数 |
| 只有裸 `bridge`，或者源码回退生成裸二进制 | `installHelperApp` 生成 bundle，并由安装脚本在运行它的本机用户身份下调用 codesign |
| 无本地预构建产物，下载上游 release `.app` | 仍走保留签名的 bundle 分支；不是本机自动重签 |

当前 [UPSTREAM.md](../../../packages/rotom-computer-use/UPSTREAM.md) 要求发行归档用 `build-native.mjs --arch all --sign-identity -` 构建。这意味着维护者构建的是 **ad-hoc** bundle，默认安装分支保留 ad-hoc；不含用户 Apple Development 签名，也不会必然创建自签名证书。将默认升级概括为“setup-helper 会生成 Local Signing 并签名”是不准确的。

仅裸二进制/源码回退分支调用 `resolveCodeSignIdentity`，顺序为：

1. 显式 `PI_COMPUTER_USE_CODESIGN_IDENTITY`。
2. 本机有效的 `Developer ID Application` 身份（**不会自动选择 Apple Development**）。
3. 已有或新建的 `pi-computer-use Local Signing (com.injaneity.pi-computer-use)` 自签名身份。
4. 无可用身份时回落到 ad-hoc `-`。

创建 Local Signing 会生成新的密钥/证书并导入 login keychain，是实质写入，不是无副作用探测。本轮没有执行它。其自签名身份可能标为不受信任；可以用于 codesign 不等于端点安全允许执行。

已有 helper 被不同的 ad-hoc bundle 替换时，安装器默认拒绝。`PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1` 只是解除安装器自己的替换保护，**不改变企业安全策略，也不是本机签名问题的解决方案**。

## 4. 现有自定义身份入口与限制

- `setup-helper.mjs` 的 `PI_COMPUTER_USE_CODESIGN_IDENTITY` 接受 codesign 身份，可显式选已有 Apple Development 身份，但**不作用于优先的预构建 `.app` 复制分支**。单独设置它不能保证本次产品升级后的 helper 获得个人开发签名。
- `build-native.mjs` 已支持 `--sign-identity` 和同名环境变量，命令参数优先；默认是 ad-hoc。它不会自行生成 Local Signing 证书。无需新增身份配置能力即可对授权的独立构建副本使用现有身份。
- `PI_COMPUTER_USE_HELPER_APP_PATH` 与 `PI_CU_SOCKET_PATH` 是已有独立 helper 接入入口。它们只指定目标，不提供签名、不授予系统权限、不保证企业策略允许，也不迁移活跃会话。
- 不应删除已安装产品的预构建 bundle 来强迫进入回退分支，也不应把个人签名产物混入公开 vendor 归档。

另有一个静态代码问题：`setup-helper.mjs` 的源码回退仍只列四个 Swift 文件，而 `build-native.mjs` 已列九个；`bridge.swift` 引用的 `TakeoverBorder`、`TakeoverState`、`InputSourcePolicy` 等定义位于漏列文件。因此不能推荐该回退作为当前升级方案。此项来自源码阅读，未执行编译或安装；本轮不修代码。若后续要求支持该回退，执行方需获准补齐构建合同和回归。

## 5. 这台受管 Mac 的升级判断与可行方案

**不能承诺发布后不会被端点安全终止，也不能断言升级就一定会被终止。**

- 已证实：当前 Apple Development 签名的日常 helper 正在运行；历史独立签名测试也有运行证据。
- 历史记录出现过 ad-hoc/未知证书链拒绝，以及新 bundle id 的 fixture 被终止。单独一个 SIGKILL 不能归因于特定安全组件；路径、身份、内容和策略可能共同影响结果。
- 现有升级首先可能保留旧 helper 并被协议检查拒绝，而不是启动新 ad-hoc helper。只有实际安装并启动新产物后，才能观察其准入结果。
- 最终 `0.5.1-rotom.*` 新归档尚未生成，过去的成功不证明最终 tgz 的 helper 可运行。签名完整性或离线测试也不能替代最终产物启动验收。

可行方案，均需后续明确授权，本轮不执行：

1. **本机方案**：从最终产物取独立 helper 副本，保留 bundle id，用用户已有且企业允许的 Apple Development 身份签署，在企业允许的位置接入独立路径/socket；不修改证书，不导出私钥，不覆盖活跃安装。先验证最终副本的签名、实际启动、协议与 diagnostics，再由用户决定停止旧会话和切换。该方案使用已有签名及接入能力，但属于显式部署，不是普通 npm 升级自动完成。
2. **正式分发方案**：维护者取得适用的 Developer ID 分发身份，评估公证并通过企业管理员认可的准入流程。Developer ID/公证本身仍不能替代这台 Mac 的策略验收；不使用用户个人证书发布公共归档。
3. 若合法签名的最终副本仍被拦截，保留拒绝证据，交安全管理员审批所需身份、版本与安装位置。不得关闭安全软件、关闭系统保护、改名搬路径反复试探，或用替换现有可用路径来绕过策略。

[早期后台输入记录](../computer-use-background-text.md) 中“放到 HOME 即可正常运行”等表述，只能当作当时特定副本的观察，不能作为当前的通用准入保证或绕过策略的建议。

## 6. 第二步前必须确认的版本冲突

本次只读 fetch 得到公开 main `6a7e2b0848acf870ec73ba3a5fd3a720c0b83d74`：

- Computer Use 源码版本已经是 `0.5.1-rotom.3`。
- product-config 已固定 `vendor/injaneity-pi-computer-use-0.5.1-rotom.3.tgz` 及其 integrity；本机现有产品也使用该版本。
- 执行分支仍为 `0.5.1-rotom.2`，将其新内容直接重用 `.3` 会产生同版本不同归档。

因此，HANDOFF-6 原定第二步的 `.3` 已过时。**请审核者/用户确认一个新的、未占用的组件版本后再打包；本轮不擅自改为 `.4`，也不覆盖已有 `.3` 归档。**

## 7. 证据与本轮边界

源码入口：

- [setup-helper](../../../packages/rotom-computer-use/scripts/setup-helper.mjs)：分支优先级、复制保护、身份选择与创建。
- [build-native](../../../packages/rotom-computer-use/scripts/build-native.mjs)：维护构建与显式签名入口。
- [helper client](../../../packages/rotom-computer-use/src/platform/macos/helper.ts)、[readiness](../../../packages/rotom-computer-use/src/platform/macos/permissions.ts)：安装、外部 socket、协议拒绝。
- [product package](../../../rotom/package.json)、[组件 package](../../../packages/rotom-computer-use/package.json)、[更新器](../../../rotom/runtime/update-product.mjs)、[发行构建器](../../../rotom/scripts/pack-release.mjs)：npm lifecycle 与 ignore-scripts。

本机只读取 plist、codesign 元数据/严格校验、进程路径、相关安装记录与现有安装文件。原始签名输出仅留本机。没有运行 setup-helper/build-native，没有连接日常 helper socket，没有运行/重启 helper，没有写入 keychain、导出私钥、改权限、复制或替换安装。没有重建归档、改版本/lock/product-config、合并 main、发布或 npm login。

本轮只交付本 STATUS；完成文档检查与审计、推送后停下等待审核。安装来源由用户或原始记录补证；源码回退修复与新版本号由用户/审核者决定，不能默认为已经授权。
