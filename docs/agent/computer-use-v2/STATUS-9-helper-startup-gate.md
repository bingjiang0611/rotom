# STATUS-9 · helper 同步失败不再阻断 rotom 启动

2026-11-17。用户报告在测试机（macOS 26.3.2，arm64，0.2.2 安装）上执行 `rotom` 直接退出。

## 现场

```
Cannot reuse the installed helper's signing identity: exactly one matching valid identity is required. The old helper has not been stopped or replaced.
rotom: rotom is installed, but automatic helper synchronization was not verified. ...
```

真实原因链：

1. 正常启动先跑强制 helper 同步（`rotom/runtime/launch-runtime.mjs` → `synchronizeHelper`），失败即 `throw`，`launchRuntime` 顶层 catch 退出码 1，会话从未开始。
2. `~/Applications/pi-computer-use.app`（2025-10-10 安装）带真实证书签名：`Authority=pi-computer-use Self Signed`。
3. 该证书已不在登录 keychain：`security find-identity -p codesigning` 与 `-v` 都是 `0 identities found`；keychain 文件在 2025-11-17 被重写。
4. 0.2.2 自带 helper 是 adhoc，且目标缺少 `Contents/Resources/source.sha256`，`helper-update.mjs` 判定“需要重新签名”。
5. `helper-update.mjs` 只在安装副本是 adhoc 时才允许跳过证书；否则要求 `find-identity -v` 里恰好一个 Authority 匹配的可用身份 → 0 个 → 抛 `signerUnavailable`。

即：Computer Use 这一可选能力的历史状态，变成了整个产品的启动门禁。

## 决定

- **启动不再被阻断**：`launch-runtime.mjs` 只把失败写成两行 stderr（原 helper 错误 + `helperUpdateCopy.startupSyncFailed` 引导），会话继续。拒绝替换本身保持不变：不降级签名、不停旧 helper、不重放。
- **不加“自动路径也认 `PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1`”**：那会把一次显式授权变成常驻的自动降级开关（profile 里留一个变量就每次启动把证书签名的 helper 换成 adhoc，重置 macOS TCC 授权）。现有回归 `automatic synchronization cannot downgrade a certificate-signed helper, even with a legacy ad-hoc opt-in` 表达的正是这条边界，不推翻。
- 提示里写明真正可用的两条出路，并声明 `ALLOW_ADHOC_UPDATE=1` 在自动同步里无效，避免再次踩同一个坑。

## 验证

- `rotom --mode rpc --no-session` 在装有不匹配/被拒 helper 的隔离 HOME 下退出码 0、stdout 只有 JSON、stderr 同时含 helper 错误与引导：新增回归 `a failed helper synchronization warns and still starts the session`（`rotom/runtime/automatic-helper-startup.test.mjs`）。撤回 `launch-runtime.mjs` 的改动后该用例失败（`1 !== 0`），即它确实能区分两种行为。
- 原有启动同步回归仍通过（`npm run test:distribution` 39/39；`update-helper`/`update-product` 15/15）。
- 组件侧 `test/helper-update.test.ts` 25/25 通过，含“自动同步不得降级证书签名 helper”用例。
- 真机（30.7.226.226）：`PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1 rotom helper update` 把失效证书签名的 helper 换成自带 adhoc 副本，退出码 0；随后自动同步写回 `source.sha256`、再次运行不再更新；`rotom --mode rpc --no-session` 正常启动。

## 未验证

- 该修复只进源码与发行流程，测试机上仍是 0.2.2，需要新版本才能拿到“不阻断启动”的行为。真机验证用的是同一台机器的 0.2.2 + 手工替换 helper，不是修复后的启动门禁。
- 未验证带可用 Developer ID / 自签名身份的自动重签路径；本次现场那条路径必然不可用。
- 真机 `rotom -p` 的模型请求经本机代理 `127.0.0.1:10808` 未返回，与本次缺陷无关，未继续排查。
