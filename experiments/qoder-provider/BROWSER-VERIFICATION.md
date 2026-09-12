# Qoder 独立浏览器认证：验证记录

> 本文记录浏览器认证初次实现时的历史验证。后续已有浏览器凭据的真实目录/模型验证见 [CATALOG-VERIFICATION.md](CATALOG-VERIFICATION.md)；不据此补写真实登录或刷新成功。

## 授权与结论

用户明确接受复用公开 Qoder CLI client ID、非官方支持的兼容实现。本轮只实现并验证本地代码：**没有真实 Qoder 登录、刷新或模型请求**，没有读取真实 CLI 凭据，没有改全局安装或推送。旧的请求预算账本仍为 INCONCLUSIVE，不据此推断有剩余额度。

状态：**离线 PASS；真实浏览器/服务端链路 INCONCLUSIVE（未执行）**。历史 CLI 只读模式的成功不能替代新登录链路验收。

## 实现边界

- `ROTOM_QODER=1 ROTOM_QODER_AUTH=browser` 注册原生 OAuth，接入 Pi `/login`、`/logout`、凭据存储及串行刷新。未设置认证模式仍使用旧 `qodercli` 只读路径，默认模型、provider ID、session binding ID 不变。
- PKCE S256、随机 nonce/机器 ID、固定 HTTPS origin、禁止重定向；15 秒单请求 deadline、5 分钟登录总 deadline、64 KiB 响应限制。只对明确的 404 pending 继续轮询；不重试未知结果。
- 登录/刷新需有效期限、账户及组织身份验证；不猜测 token lifetime，不缓存服务器额外字段。
- Pi 的 `auth.json` 持久化 OAuth token；不是系统钥匙串。请求时通过进程内 AES-GCM 封装传递 token/fingerprint/expiry，最终 transport 解封并绑定账号。封装不是第二套持久化或 credential registry，避免共享“当前账号”变量和可伪造的 request auth override。
- 刷新前，用户 Pi 目录的私有 `qoder-refresh-attempts/` 创建并 fsync 一次性空记录，文件名只有 refresh token 的 SHA-256 摘要。O_EXCL 阻止并发/跨进程/重启后使用同一 token；成功也保留，以覆盖 Pi 后续持久化失败。最多 4096 条，满时 fail closed，不自动删除。
- 若服务器不轮换 refresh token、返回字段不满足合同、账户变化或交换结果未知，停止并要求新登录；不自动撤销服务器令牌或补发模型请求。
- 自动续期维持会话 fingerprint；重新登录生成新机器 ID，须新会话。不会将 CLI 绑定迁移到浏览器绑定。
- 仅 lite/performance 文本/工具；图片、thinking、目录与其他 tier 不扩展。费用与上游第三方支持/许可仍未知。

## 已运行的确定性验证

使用支持的 Pi 0.85.1 公共 exports，`ROTOM_PI` 指向本机经验证的 canonical executable；下列命令从仓库根执行。

| 检查 | 结果 |
|---|---|
| `node --test --test-concurrency=1 rotom/extensions/qoder/*.test.mjs` | 89 passed |
| `rotom/bin/check-personal` | 242 passed；footprint deterministic gate PASS |
| `node --test --test-concurrency=1 rotom/runtime/verify-pi-runtime.test.mjs rotom/runtime/distribution.test.mjs` | 48 passed |
| `node --experimental-import-meta-resolve experiments/qoder-provider/oauth-smoke.mjs` | 原生 ModelRuntime 登录→真实临时 auth.json→重建 runtime→并发串行刷新一次→重建 runtime→合成流式模型 dispatch→logout 全通过 |
| 原有 `smoke.mjs`（lite/performance）、`session-smoke.mjs --extended`、`stream-smoke.mjs`，均带 `--experimental-import-meta-resolve` 且不带 `--live` | 全部 PASS |
| `node rotom/runtime/smoke-runtime.mjs "$ROTOM_PI" "$PWD/rotom"` | `ROTOM_QODER=0`、`1 + qodercli`、`1 + browser` 三种模式通过，无模型选择或工具面变更 |

OAuth fixture 覆盖错误/超大响应、PKCE、secret-free 事件、取消、账号核对、令牌轮换、未知刷新后重建 guard 与真正子进程拒绝重放、私有路径/目录 symlink、封装篡改/过期/跨实例及 dispatch 前账号绑定。所有 HTTP 都是注入的合成 Response，不是服务端证据。

## 分发与静态检查

- 新增模块 `node --check`、入口定向 TypeScript 检查通过。源码目录未安装 Pi 依赖，首次仅用 baseUrl 的 tsc 解析失败；改用已核对 package exports 的公共 `.d.ts` 路径映射后通过，没有改 installed source。
- `cd rotom && npm run pack:release -- /absolute/output-directory` 通过：隔离 HOME/cache，锁定新安装，实际 tgz 文件清单及隐私扫描通过。
- 产物 `rotom-0.1.0-alpha.0.tgz`：9,280,419 bytes，3793 files，Pi 0.85.1，integrity `sha512-KBqOykuggzykuCdcNil0MetvcA9iMQo64drzJTPtoERUD3MhZ+UVwtApPp+05Y27OJT828/QUWJAK4jjgQ5vgg==`。仍 private/unpublished，没有升版本。
- 实际 tgz 安装到临时 HOME/prefix（PATH 无 global Pi）：`rotom --version`、默认/browser/full 模式的 runtime smoke、实际 installed OAuth 模块的原生登录/磁盘恢复/串行刷新/流式 dispatch/logout 合成 smoke、同版本重装及卸载全部通过。用户全局安装未动。
- 未登录时 installed `--list-models qoder` 返回 `No models available`，不是已认证成功；模型/provider 注册由上述 runtime smoke 单独确认。
- 首次隔离 runtime smoke 的维护命令误将 resolver 自执行输出与调用输出拼成双行 executable 路径，ENOENT 后停止；修正参数使 resolver 不自执行后重跑通过。此失败没有发起认证或模型请求。
- `git diff --check` 通过。源码树与实际 tgz 的隐私扫描都是启发式文本扫描，不是任意秘密/代码所有权保证。

## 静态研究来源

- [官方 CLI 认证](https://docs.qoder.com/cli/authentication)：浏览器登录与 PAT；不是第三方 OAuth 注册文档。
- [官方 SDK 认证](https://docs.qoder.com/cli/sdk/authentication)：PAT/SAT/local CLI 集成；SDK 自身包裹 CLI，不用于此产品运行时。
- 已安装 CLI 的 device-token flow 静态协议：`/device/selectAccounts`、`/api/v1/deviceToken/poll`、`/api/v1/deviceToken/refresh`、`/api/v1/userinfo`；未运行 CLI。
- [9router PR #2952](https://github.com/decolua/9router/pull/2952)，研究时为 open/unmerged；参考 revision `d2fd11b11698795a2c4479ef6906304f22162475` 的 `src/lib/oauth/services/qoder.js` 和 `open-sse/protocol/qoder/profile.js`。只作兼容协议交叉核对；不复制其过期时间推测、身份降级或第三方代码，不声明其真实验证可信或官方认可。

## 未验证与下一步

真实网页登录、客户端 ID 当前是否接受、token scope 对现有模型 endpoint 是否有效、真实刷新是否轮换及字段兼容、真实 UI 取消、Linux fsync 行为都未验证。下一步需单独明确认证请求上限（轮询也计请求）及模型调用额度，由用户在浏览器完成账号授权；不沿用旧预算、不自动探测其他 endpoint/client ID，也不启用外呼 canary。
