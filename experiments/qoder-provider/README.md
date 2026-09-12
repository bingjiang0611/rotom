# Qoder provider：维护验证

实现与 colocated 单测已迁到 `rotom/extensions/qoder/`，不保留第二份实现或旧入口。产品将其作为第五个 bundled extension 加载，只有 `ROTOM_QODER=1` 才注册 provider。用户用法与边界见 [产品说明](../../rotom/README.md#qoder原生-provider显式启用)。

- 稳定身份仍为 `qoder-experimental`；原绑定 custom entry ID 不变，不自动迁移任何活跃会话。
- `lite` / `performance` 保留离线基线；账号目录按原始 key 发现并限制为实测白名单交集。当前 Default 目录 17 项（含 `smodel` Sonus）已适配，13 条 reasoning 路由支持原生推理，其中八条的 effort 取实测白名单与当前目录交集，其余固定 enabled；Ultimate/Sonus 的不同加密 item 完整保留，十条路线（含 Ultimate）固定 COSY 单次推理，不做失败回退。仅 Ultimate/Kimi-K3/DeepSeek-V4-Flash 的 PNG/JPEG/WebP 与 272K 管理窗口按已验证能力和当前目录交集开放，输出≤4096；未知 opaque 形状和未验证 effort 仍拒绝。历史见[目录验证](CATALOG-VERIFICATION.md)、[Ultimate/Flash 续查](REASONING-VERIFICATION.md)，基线见[全模型验证](ALL-MODELS-VERIFICATION.md)，后续见[长会话与档位验证](LONG-SESSIONS-VERIFICATION.md)，最新[图片与大上下文验证](IMAGE-CONTEXT-VERIFICATION.md)。
- 不启动 Qoder CLI，不刷新或写回 CLI 凭据，不嵌套 agent，不添加工具。启用 provider 后默认 browser 模式使用 Pi 原生 OAuth 存储/刷新，显式 `ROTOM_QODER_AUTH=qodercli` 才使用只读 CLI 兼容路径；独立登录与强制隔离凭据本地到期后的串行真实刷新已通过；不是自然到期测试。历史见 [浏览器认证验证](BROWSER-VERIFICATION.md)，本轮见 [能力与 Credit 验证](CAPABILITIES-VERIFICATION.md)。
- 完整流的 allowlisted Credit 可被记录；缺失/错误/取消保持 unknown，部分 billable-reported 小计不是余额或 USD。`/qoder-credits` 仅交互 UI 显示固定只读额度快照，不进入对话/压缩/分支上下文。美元费用、接口支持/订阅适用/第三方许可未确认；Pi 必填价格零只是占位，不代表免费。

## 离线检查

预先设置 canonical `ROTOM_PI`（当前验证 Pi 0.85.1）。没有全局/PATH fallback，不安装依赖：

```sh
node --test --test-concurrency=1 rotom/extensions/qoder/*.test.mjs
node --test --test-concurrency=1 experiments/qoder-provider/{live-budget,reasoning-probe,legacy-probe,probe-wire,tui-net-observer}.test.mjs
node --experimental-import-meta-resolve experiments/qoder-provider/smoke.mjs
node --experimental-import-meta-resolve experiments/qoder-provider/smoke.mjs --model=performance
node --experimental-import-meta-resolve experiments/qoder-provider/session-smoke.mjs --extended
node --experimental-import-meta-resolve experiments/qoder-provider/stream-smoke.mjs
node --experimental-import-meta-resolve experiments/qoder-provider/oauth-smoke.mjs
node --experimental-import-meta-resolve experiments/qoder-provider/credits-session-smoke.mjs --offline
node --experimental-import-meta-resolve experiments/qoder-provider/catalog-sdk-smoke.mjs --offline gmodel
node --experimental-import-meta-resolve experiments/qoder-provider/catalog-sdk-smoke.mjs --offline ultimate
node --experimental-import-meta-resolve experiments/qoder-provider/catalog-sdk-smoke.mjs --offline dfmodel
node --experimental-import-meta-resolve experiments/qoder-provider/catalog-sdk-smoke.mjs --offline smodel
node --experimental-import-meta-resolve experiments/qoder-provider/catalog-sdk-smoke.mjs --offline smodel --negative-trailer
node --experimental-import-meta-resolve experiments/qoder-provider/catalog-sdk-smoke.mjs --offline mmodel --negative-trailer
# 全目录变更时，对 SUPPORTED_MODEL_IDS 的全部 key 逐个运行普通 SDK smoke
node rotom/runtime/smoke-runtime.mjs "$ROTOM_PI" "$PWD/rotom"
ROTOM_QODER=1 node rotom/runtime/smoke-runtime.mjs "$ROTOM_PI" "$PWD/rotom"
```

`--negative-trailer` 只允许离线 Sonus/MiniMax：验证实际 native SDK 在 metrics 后出现额外数据时报告 error，而不是在 DONE 处提前认定成功。测试工具校验 nonce 后返回新 marker，并非 echo nonce；严格校验最终答案，失败不降为 contains 即通过。

`--extended` 增加分支隔离、合成长输入、降低阈值后的自动压缩及摘要重放。它不是 32K 容量、持续多日运行或服务端停止计费证明。

## 真实检查（每轮另需授权）

所有脚本只发合成内容；`credits-session-smoke.mjs` 仅修改私有合成文件并运行固定测试，不是通用执行沙箱。单次失败即停，不自动重试。为了跨脚本记账，预先在私人临时目录新建内容为 `0` 的 mode 0600 普通 ledger 文件，将其 canonical 绝对路径设为 `ROTOM_QODER_PROBE_LEDGER`，**仅串行运行**。通过 `--import ./experiments/qoder-provider/live-budget.mjs` preload 订阅 Node 进程级 `undici:request:create`、在请求构造时累计 dispatch，默认上限 30。只有当前轮明确获准时才设置 `ROTOM_QODER_PROBE_LIMIT`（1–10000 的十进制整数）；配置不是用户授权，不能重置、挪用其他轮 ledger 或并发使用。该预算是请求数，不是货币预算、通用网络隔离或运行时产品功能。历史 Ultimate/Flash 轮采用 30 次自限；此前全模型轮另获“不限次数”授权，以独立账本采用 100 次自限。本轮能力/Credit/隔离认证另获不限调用及 Credit、共享池消费授权，采用新账本，初始 1000 次维护自限；后续按用户要求验证长会话/档位及实际安装，上调维护自限到 1500，继续原 ledger 不清零；三模型图片/大上下文的最终安装复验将维护自限调至1700，范围不变。账户余额不等于消费授权。历史 fetch monkeypatch 在真实 launcher 内漏计，该旧轮次保持 INCONCLUSIVE；目录轮次使用新授权、新 ledger 与进程级计数，详见对应报告。每次完成后必须对比计数与实际终止消息/预期请求数，差异即停止，不能把 ledger=0 当作无外呼证明。

```sh
# 2 次：原生流工具往返（lite 或 performance）
node --experimental-import-meta-resolve --import ./experiments/qoder-provider/live-budget.mjs \
  experiments/qoder-provider/smoke.mjs --live --model=performance
# 最多 12 次：SDK extended；本轮实际 11 次
node --experimental-import-meta-resolve --import ./experiments/qoder-provider/live-budget.mjs \
  experiments/qoder-provider/session-smoke.mjs --live --extended
```

`reasoning-probe.mjs <ultimate|dfmodel> <on|off|text>` 输出脱敏字段结构；`legacy-probe.mjs --live [legacy-key] [text|tool]` 为目录 key 的单请求对照，不执行工具。旧版 probe/SDK 必须显式设置 `ROTOM_QODER_PROBE_LEGACY=1`，仅额外授权固定 POST，不允许刷新或任意 COSY 路径。`catalog-probe.mjs --live --legacy-version` 可对照 1.0.0 版本头；产品默认 1.1.45。SDK 对全部 key 在两轮之间使用 Pi 公开 SessionManager 落盘/恢复；真实 `--discover` 每个用例为 1 次目录 + 2 次模型，均独立保存结果、不自动重试。不冒充真实 TUI 或完整业务 AgentSession。

raw legacy 探针仍要求字面 DONE/标准 finish 才记 pass；Sonus/MiniMax 可以输出有效 framing 线索但 pass=false，最终接入结论以 native SDK 用例为准。

`capability-probe.mjs <tier...>` 与 `modal-probe.mjs <lite|performance> <image|thinking>` 是维护面 raw HTTP 探针，不能注册/启用未验证模型或能力。模型 tier 来自官方 CLI 文档；图片使用随机纯色合成 PNG，thinking 要求原生思考字段，不把回答里自述“思考过”视作通过。四条具名路由随后完成 plain `reasoning_content` 的原生 SDK/工具往返验证；这不扩大 lite/performance 的 thinking 或图片能力。

`launcher-smoke.mjs <canonical-isolated-install-work>` 通过真实 npm bin 从合成业务 cwd 调用，只启用 read，并断言工具/回答与 ledger 增量；需要该 work 下预先隔离安装 prefix、bin、home、business，不安装到用户全局。其真实通过边界及计数缺陷见本轮报告。

探针输出只有固定状态、白名单模型 tier、事件/结构计数及 usage，不打印模型正文、凭据、header 或错误正文。凭据按当前授权只读，外部失败不自动刷新或重放。真实业务 cwd 的完整产品集成验证必须另做，不能把 standalone SDK 当 launcher 验收。

## Credit / 认证 / UI 专项

- `auth-live-smoke.mjs --live`：需新的私有 `isolated-auth` 或 `isolated-auth-1`…`-99` sibling 目录、只读参考凭据、OAuth scope 和人工网页确认；一次性登录标记不可清掉复用。只在新隔离凭据中强制本地到期并验证真实串行刷新，不复制其令牌去重放刷新。
- `credits-probe.mjs`：固定 `GET /api/v2/quota/usage`；需显式 `ROTOM_QODER_PROBE_CREDIT=1`。原始账户余额只留私有证据。
- `credits-session-smoke.mjs --live smodel` / `--live lite`：固定读文件、失败测试、唯一补丁、通过测试，随后分支、磁盘恢复、手动压缩及精确 marker 召回；每次新案例最多 14 个模型调用，另计目录、额度和可能的认证请求。`ROTOM_QODER_PROBE_PRODUCT_ROOT` 可指向实际隔离安装，所有运行时模块从该根加载。
- `credits-tui-smoke.py --launcher <canonical-bin/rotom> --work <private-work> [--pi-entry <maintenance-Pi>]`：通过真实 CLI/PTY 输入一次额度命令，模型 dispatch 被 ledger 明确禁止；可读入本轮合成会话的私有副本验证 Credit footer，`--columns 80` 覆盖窄宽度。它验证内容/命令，不冒充桌面截图或完整布局；原始终端 bytes 含余额，不能提交。
- `vision-sdk-probe.mjs --offline auto png jpeg` / `--live <key> png jpeg`：维护 wire 上的原生用户图像、工具图像及磁盘重放研究；需 Python Pillow，仅转换合成图，不安装依赖。失败不进入下一轮；raw/研究 adapter 的通过不是产品能力。详细状态见能力报告。
- `long-cli-smoke.mjs --capacity`：实际launcher/RPC的≥250K实测输入+图片（272K管理窗口）、手动压缩、同session进程重启、新图片/anchor恢复；`--preflight`仍禁止模型请求。子进程明确授权固定COSY，不继承维护Pi覆盖。
- `input-budget-smoke.mjs`：真实 SDK/假上游的输出预算回归；断言 272K 窗口下 244K 历史仍保留 4096，而 272K 历史被压成 1，明确记录悬崖而不是隐藏。
- `vision-capacity-smoke.mjs --offline|--research|--product <ultimate|kmodel_latest|dfmodel>`：四张不同 PNG/JPEG/WebP、用户多图、工具图、两次恢复及逐请求 image/opaque replay；`ROTOM_QODER_VISION_ROWS=12600` 加入产品窗口内大输入，带填充请求的真实 input usage 须≥250K；272K 是管理窗口，不是最低输入断言。
- `large-context-probe.mjs --live <key> 12600 250000`：八位置精确检索、工具/磁盘恢复。设置 canonical `ROTOM_QODER_PROBE_PRODUCT_ROOT` 才调用真实产品 Provider，否则仍是研究；固定272K管理窗口/400K selector/4096输出，且断言最低输入不超过窗口−8192。`ROTOM_QODER_OLD_PRODUCT_ROOT` 仅用于小型旧版direct会话桥接，不是运行时回退。
- `vision-probe.mjs` / `probe-wire.mjs`：随机网格图片与显式 raw route/effort/context selector 调研。catalog 的 context selector 不是已验证输入容量；raw 成功不启用产品图片或其他能力。

## 长会话与原生 thinking controls

- `effort-probe.mjs <key> all --product` 使用真正产品 provider 和 Pi native stream、工具往返、磁盘恢复；无 `--product` 是显式研究 adapter，不当产品验收。每档一个独立案例、两轮相连的合成模型调用，另计目录；案例失败不重放，可继续下一独立档位案例。
- `long-session-smoke.mjs --live <key> 20 low,medium,high,xhigh,max` 使用完整 native AgentSession、严格 fixture read/inspect/record、重复压缩与磁盘恢复，逐请求核对档位。每例最多 100 个模型调用，默认每六轮手动压缩；Qwen3.8-Max 用 `ROTOM_QODER_LONG_COMPACT_EVERY=3` 与 `off,low,medium,xhigh` 留足 token headroom。原生 reserve 保持默认，不能把 819-token 摘要截断当 provider 不支持。`--offline ultimate` 强制网络阻断另测规范化的双工具批次；不是通用 shell 执行沙箱。
- `long-cli-smoke.mjs [--preflight]` 运行指定实际包的 launcher/RPC；隔离 HOME/cwd/凭据，不设维护用 `ROTOM_PI`，显式禁用全部模型工具。preflight 强制禁止模型 dispatch；完整模式验证 20 轮、五档切换、手动压缩、一次真实进程恢复和 idle 后受控终止。fixture 的 recent window 明确设为 1024，不改用户配置；不是默认自动压缩或桌面视觉验收。
- SDK 两者支持 canonical `ROTOM_QODER_PROBE_PRODUCT_ROOT` 与其实际 Pi dependency 的 `ROTOM_PI` 做安装验收。`stream-shape.mjs` 仅保留有界结构/usage metadata，不落原始 SSE、ID、参数、ciphertext 或错误正文；clone 缓冲时间不是首 token 性能证据。

## 证据与来源

- [目录与具名模型验证](CATALOG-VERIFICATION.md)
- [历史产品接入及能力验证](PRODUCT-VERIFICATION.md)
- [d66676e 历史修复验收](VERIFICATION.md)（历史路径/命令不代表当前树）
- [Qoder CLI models](https://docs.qoder.com/cli/model.md)、[usage](https://docs.qoder.com/cli/usage.md)、[SDK overview](https://docs.qoder.com/cli/sdk/overview.md)。官方 SDK 封装 CLI agent，不是独立推理 API 合同。
- 本机 CLI 1.1.45 的 serializer、`bundle/proto/chat.proto`：直连接口与请求字段线索。目录通过固定 `https://api2.qoder.sh/algo/api/v2/model/list?Encode=1` 的独立 COSY 适配获取 `assistant` 场景，没有猜测 `/v1/models`，也没有加载 native/WASM。参考来源与 MIT 通知见产品 `THIRD_PARTY_NOTICES.md`。
- [社区桥接线索](https://github.com/bzym2/QoderGateway/blob/main/src/qoder2api/bridge.py)：没有安装、运行或复制。

产品 parser 保留同帧原始续段，标准 SSE 优先；不跨帧拼接、不补 JSON/结束标记，不吞上游 error。HTTP 200 本身不算成功。未来新增能力仍需实测、回归、产品合同与文档同步。
