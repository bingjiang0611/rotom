# Qoder 账号目录与具名模型：验证记录

> 本文保留 `b4d2041` 的历史结果及已用尽的 30 次授权。Ultimate/Flash 的后续适配使用独立新授权，见 [推理协议续查](REASONING-VERIFICATION.md)；不回写本轮失败为成功。

## 授权与当前结论

用户要求补齐模型选择，并另行允许本轮最多 **30 次目录/模型请求**。新 ledger 与历史漏计轮次完全分离；所有真实调用使用同一个进程级 `undici:request:create` 计数器、串行进程、合成输入与无外部效果的测试工具。只读现有 Pi 浏览器凭据，不刷新、不登录、不读 CLI 凭据，不发送业务内容。

**部分能力 PASS，不是 CLI 全目录 parity。** 初次账号目录读取有 16 项。新增 Auto 以及四条 plain-reasoning 路由通过测试；连同历史 Lite/Performance，共七条适配器白名单。目录可见、账号 enabled 与 direct endpoint 调用成功分开记录。

## 目录与 ID 证据

- 官方 CLI 1.1.45 静态路径：`listModelsFromRemote` 读取 `/api/v2/model/list?Encode=1`；`NnA` 加 `/algo`；生产 fallback 为 `api2.qoder.sh`。`Dkc` / `U3e` / `V0n` 将普通 system 条目的原始 `key` 放进 direct HTTP 的顶层 `model`，并非显示名 slug，也不要求另起嵌套 agent。
- 独立 COSY header 参考 [9router PR #2952](https://github.com/decolua/9router/pull/2952)，revision `d2fd11b11698795a2c4479ef6906304f22162475`。公开 RSA 服务端加密 key、AES-CBC 和 MD5 是该兼容协议，不是 rotom 自选通用认证方案。MIT 通知保留在产品 `THIRD_PARTY_NOTICES.md`；未加载 CLI/WASM、未修改 installed source，也不声称官方支持。
- 首次真实 `GET https://api2.qoder.sh/algo/api/v2/model/list?Encode=1` 返回 HTTP 200 和 JSON 场景目录；使用 `assistant` 的 system 条目，不混入 chat/enterprise/BYOK 场景。没有猜测 `/v1/models`，没有把官方 Cloud Agent `agent.model` 合同当 direct API 合同。

| 原始 key | 本轮 assistant 显示名 | 实测与产品状态 |
|---|---|---|
| lite | Lite | 历史文本/工具 PASS；保留基线，本轮不重复消费请求 |
| performance | Performance | 历史文本/工具 PASS；保留基线，本轮不重复消费请求 |
| auto | Auto | 文本与工具往返 PASS；启用 |
| qmodel | Qwen3.7-Plus | Pi 原生 plain reasoning/工具往返 PASS；启用 |
| kmodel | Kimi-K2.7-Code | Pi 原生 plain reasoning/工具往返 PASS；启用 |
| gmodel | GLM-5.3 | Pi 原生 plain reasoning/工具往返 PASS；启用 |
| dmodel | DeepSeek-V4-Pro | Pi 原生 plain reasoning/工具往返 PASS；启用 |
| ultimate | Ultimate | enabled 新用例遇到 opaque reasoning；不启用 |
| efficient | Efficient | 首次用例 upstream_error_event；不启用 |
| qmodel_38max | Qwen3.8-Max | 首次用例 upstream_error_event；不启用 |
| qfmodel | Qwen3.8-Flash | 首次用例 upstream_error_event；不启用 |
| qmodel_latest | Qwen3.7-Max | 首次用例 upstream_error_event；不启用 |
| kmodel_latest | Kimi-K3 | 首次用例 upstream_error_event；不启用 |
| gfmodel | GLM-5.3-Flash | 首次用例 upstream_error_event；不启用 |
| dfmodel | DeepSeek-V4-Flash | 首次用例 upstream_error_event；不启用 |
| mmodel | MiniMax-M3 | enabled 新用例 upstream_error_frame；不启用 |

这些错误只说明当前 direct 请求未通过；不证明账号没有权限、官方 CLI 不能使用，或补充参数后永远不可用。未读取/记录错误正文以推测权限或进行盲目重试。服务端可能改变路由对应的底层模型，显示名与 `is_reasoning`/`is_vl` 声明也不能代替实测。

## 请求账本

新授权 ledger：`/private/tmp/rotom-qoder-catalog-budget.DyrqJe/ledger`，初始值 0、mode 0600。目录 scope 需显式 `ROTOM_QODER_PROBE_CATALOG=1`，只增加上述精确 GET；模型仍只允许固定 `api2-v2.qoder.sh/model/v1/chat/completions` POST。刷新/其他 URL 被阻断。计数器不是通用网络沙箱，不跨并发进程使用。

1. 目录：1 次。
2. 首批 14 条新增 key 的 text/off 协议用例：15 次。Auto 两次完成工具往返；六条返回 plain reasoning，被当时的保守 parser 拒绝；七条返回上游错误。没有重放原请求。
3. 加入 plain reasoning 后，六条**独立 nonce、不同 enabled 协议的新合成用例**：10 次。Qwen Plus、Kimi Code、GLM、DeepSeek 各两次完成原生 thinking events、工具结果及推理回传；Ultimate/MiniMax 各一次遇到未支持/上游错误即停。七条首批上游错误路径未再次调用。
4. 第一份隔离安装包：1 次真实目录 + 2 次 GLM 原生 thinking/工具往返 PASS，合计 29。
5. 终检收紧 `filterModels`（不能复活调用方已删除的模型），重新打包；最终包只做 1 次真实目录及筛选检查 PASS，没有再发模型请求。

**最终合计 30/30，预算耗尽，已停止外呼。** 3 次目录 + 27 次模型请求；所有进程 ledger 增量与各自 dispatch/目录计数一致。

每个 probe 都核对 ledger 增量与实际 dispatch 计数，并对凭据文件前后做摘要比对；已有结果均未变化。摘要比对只证明该次进程内前后相同，不是跨所有进程的长期凭据审计，也不证明账单或服务器取消完成。旧漏计 ledger 仍为 INCONCLUSIVE，不能合并或重置。

## 产品边界

- opt-in、provider ID、绑定 ID、默认模型、CLI 只读与独立 browser 认证边界不变。没有新增 model tool 或第二套 agent 生命周期。
- `catalog.mjs` / `catalog-auth.mjs` 进入九文件资源与 npm allowlist。只读取固定目录，不跟随 redirect、不重试；15 秒总 deadline、512 KiB 上限、严格 assistant/system/schema/ID 去重。
- 使用 Pi 公开 `Provider.refreshModels` / generation-checked `publish`，不使用它的账号无关持久 overlay。目录仅内存、指纹隔离、1 小时 TTL，过期/换账号/读取凭据时目录代际改变均阻断 stale 模型 dispatch。失败保留上次目录，但不绕过 TTL 或账号检查。
- 注册已验证 ID 的占位声明，让 Pi 在 session_start 前解析显式选择/磁盘恢复；没有新目录时可用列表仍只显示 Lite/Performance，新增 ID 不能凭声明发请求。启动/`/qoder-models` 完成目录读取后取 enabled/实测白名单交集，名称来自服务器。
- `qmodel/kmodel/gmodel/dmodel` 只接通固定 enabled 的 `reasoning_content`；Pi 仅声明 medium 一个可用档，不承诺强度控制。允许 Pi 原生 plain 字段签名用于 assistant 历史回传；opaque/其他 reasoning 格式和 custom/BYOK 路由仍 fail closed。
- 图片关闭，32K/4096 保守上限不扩大；目录中的百万窗口、VL/effort 元数据不直接启用。价格仍是未知占位，不能按 Pi `$0` 解释为免费。
- 独立浏览器登录、真实刷新/轮换、跨区域/VPC、真实 TUI 选择、具名模型大上下文/真实压缩/长期运行仍未验证。现有浏览器凭据被服务接受不补写这些成功。

## 本地与分发验证

- `node --test --test-concurrency=1 rotom/extensions/qoder/*.test.mjs experiments/qoder-provider/live-budget.test.mjs`：120 PASS（115 provider + 5 ledger）。
- `catalog-sdk-smoke.mjs --offline gmodel`：原生 thinking events、工具往返、plain reasoning 回传 PASS，无真实请求。
- `ROTOM_PI=<verified canonical Pi> rotom/bin/check-personal`：268 PASS，deterministicGate PASS。
- `node --test --test-concurrency=1 rotom/runtime/verify-pi-runtime.test.mjs rotom/runtime/distribution.test.mjs`：48 PASS。首次 120 秒工具 deadline 在资源复制测试期间终止；确认进程已退出、无断言失败后，发现测试复制了包含 1.3 GiB evals 的 1.4 GiB 产品维护树，以 600 秒 deadline 重跑，实际约 155 秒通过。未清理 evals 或活跃运行时。
- MJS syntax、以公开 `.d.ts` 路径映射执行的定向 TypeScript、`git diff --check`、源码及实际 tgz 隐私扫描 PASS。
- 原有 `smoke`（Lite/Performance）、`session-smoke --extended`、`stream-smoke`、`oauth-smoke` 与新 `catalog-sdk-smoke --offline gmodel` PASS。源码 runtime default/CLI/browser PASS；均隔离 HOME，并用进程级离线网络阻断器防止意外外呼。
- 最终 tgz 的隔离 HOME/prefix、PATH 无全局 Pi 安装、九个 Qoder 运行时文件内容比对、default/browser/full public-runtime、原生 SDK 离线 thinking/工具往返、卸载 PASS。此前还执行旧浏览器 artifact → 新目录 artifact 的同版本升级并核对文件替换；用户全局安装未改动。
- 实际包内 GLM 的两次真实模型往返在第一份 artifact（`/private/tmp/rotom-qoder-catalog-release.0RHqrZ/rotom-0.1.0-alpha.0.tgz`）通过；最后一版仅收紧 availability filter，最终 artifact 自身的真实目录/筛选通过，未重复模型请求。逐文件比较两份 tgz 的九个 Qoder 运行时文件，只有 `provider.mjs` 的 availability filter 改变。区分这两份证据，不把先前包的完整模型 L3 冒充最终包重新测过。

最终 artifact：`/private/tmp/rotom-qoder-catalog-final-release.2vsxgQ/rotom-0.1.0-alpha.0.tgz`，9,284,262 bytes、3795 files，Pi 0.85.1；integrity `sha512-FEqL8WCDj6sIpbMZ15A0+gn2GHj1JNwhnBkvOnG0YbtbTP+s/miUbBhZHWbaNhYPdncbaqKfVZmolc3a7hfIyA==`。未公开发布、未推送。

本地证据：
- `/tmp/rotom-qoder-catalog-live.json`、`/tmp/rotom-qoder-catalog-model-checks/`、`/tmp/rotom-qoder-catalog-reasoning-checks/`。
- `/tmp/rotom-qoder-catalog-final-unit.log`、`/tmp/rotom-qoder-catalog-check-personal-final.log`、`/tmp/rotom-qoder-catalog-resource-tests-recheck.log`。
- `/private/tmp/rotom-qoder-catalog-installed.p96063/sdk-live-final.json`（第一份 artifact，3 次 PASS）、`final-live-catalog.json`（最终 artifact，1 次 PASS）；同目录保留安装、升级、卸载、offline/runtime logs，临时安装的产品本体已卸载。
- `/tmp/rotom-qoder-catalog-final-pack.log`。扫描仅是启发式结果，不保证无任意秘密或 IP 风险。

## 维护命令

先按 README 设置 canonical `ROTOM_PI`、新的授权 ledger、私有 canonical `ROTOM_QODER_PROBE_AUTH_FILE`。只读 Pi 浏览器凭据；不要通过 native `getAuth()` 让维护 probe 自动刷新。

```sh
node --experimental-import-meta-resolve experiments/qoder-provider/catalog-sdk-smoke.mjs --offline gmodel
# 两次模型请求；从已核实的脱敏目录快照注入，不重复查目录
node --experimental-import-meta-resolve --import ./experiments/qoder-provider/live-budget.mjs \
  experiments/qoder-provider/catalog-sdk-smoke.mjs --live gmodel
# 一次真实目录 + 两次模型；可指定 ROTOM_QODER_PROBE_PRODUCT_ROOT 为隔离安装根
ROTOM_QODER_PROBE_CATALOG=1 node --experimental-import-meta-resolve \
  --import ./experiments/qoder-provider/live-budget.mjs \
  experiments/qoder-provider/catalog-sdk-smoke.mjs --live gmodel --discover
# 仅一次真实目录与 availability 筛选检查，不发模型请求
ROTOM_QODER_PROBE_CATALOG=1 node --experimental-import-meta-resolve \
  --import ./experiments/qoder-provider/live-budget.mjs \
  experiments/qoder-provider/catalog-sdk-smoke.mjs --live gmodel --catalog-only
```

`catalog-probe.mjs` 与 `catalog-model-probe.mjs` 记录首轮侦察；后者始终服从当前产品白名单，不能拿历史命令再次调用已撤回的 key。目录快照路径由 `ROTOM_QODER_PROBE_CATALOG_FILE` 指定；只输出状态、路由 key、事件计数及 usage，不输出真实 credential/header、模型或错误正文。
