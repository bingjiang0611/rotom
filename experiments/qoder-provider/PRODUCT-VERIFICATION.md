# Qoder 产品接入与扩展验证

> 初次产品接入的历史记录：Lite/Performance、text-only 和未开放目录等限制仅属于当时快照。当前能力与默认 browser 认证见 [产品说明](../../docs/usage.md#qoder原生-provider显式启用)，后续分批证据见 [维护索引](README.md)。保留当时产物、请求账本和失败，不冒充最新版本验收。

**产品组合与本地分发 PASS；扩展能力部分通过；本轮真实请求预算证明 INCONCLUSIVE。** 保留 experimental 和显式 opt-in，不把这个结论写成全部剩余问题已解决。

## 授权与交付范围

用户选择“能力补齐 + 正式接入”，本轮上限 30 次真实请求，凭据保持只读。未授权自动刷新/写回 Qoder 凭据；不改默认模型、不迁移活跃会话、不推送或公开发布。

- 运行时与 colocated tests 从实验目录迁至 `rotom/extensions/qoder/`，没有第二份实现。
- 第五个 bundled extension：默认 inert；`ROTOM_QODER=1` 才注册现有 `qoder-experimental` provider。显式 `0` 关闭，非法值报错。
- 保留账号绑定 custom ID，开启的会话继续检查 uid/org/machine 摘要；同账号 token 更新允许，跨账号/未绑定旧历史拒绝。
- 白名单仅 `lite` / `performance` 文本与工具，不修改 Pi 或 installed dependencies。launcher/resource/required files/npm files/门禁已同步。
- post-hook payload 再验模型/图片/思考/输出上限，强制 `enable_thinking=false`、`reasoning_effort=none`；不可用 onPayload 静默扩大能力。

## 真实能力结果

宿主 Pi 0.85.1，使用当前 Qoder CLI 本地登录态，只发送合成数据。模型名是服务端路由 tier，不是固定底层模型或官方支持承诺。

| 项目 | 结果 / 边界 |
|---|---|
| lite 文本 | PASS：原样返回随机标记，真实 usage |
| performance 文本 + 原生工具往返 | PASS：toolUse → 纯宿主工具执行一次 → 独立请求完整历史 → stop，正确宿主标记 |
| efficient | BLOCKED：HTTP200 后收到上游 SSE error，未重试、未注册，不把 200 当成功 |
| lite / performance 图片 | FAIL：随机纯色 PNG 测试均未答对；不启用，不推断整个 Qoder 服务不支持图片 |
| performance thinking | FAIL：未收到可验证的 reasoning_content 流；不启用，不把正文推理当独立思考协议 |
| lite SDK extended | PASS：真实工具循环、账号绑定、无摘要的真实树分支隔离、磁盘恢复、手动压缩与重放、流中取消和后续请求 |
| 合成长输入 + 自动压缩重放 | PASS：单请求上游 input/cache 总数最大 25,319 tokens；SDK threshold compaction entry 增加，后续正确召回工具标记。降低 reserve 以触发阈值，不是 overflow recovery、32K 极限或长期多轮可靠性证明 |
| 动态目录/具体前沿模型 | 未启用：CLI 使用 `/api/v2/model/list?Encode=1` 与客户端请求准备/解码；没有猜测通用 /v1/models、没有运行 native auth 模块 |

自动压缩后仍保留较长的近期内容（后续请求 25,198 input/cache tokens）。通过只说明触发与重放成立，不宣称压缩率、成本降低或上下文已缩小到某固定值。真实 SSE 历史失败未逐例追溯归因。

## 本地验证

| 检查 | 结果 |
|---|---|
| Qoder colocated tests | 68 PASS（旧 58 + 产品 opt-in/catalog/post-hook 等 10） |
| 原生 stream smoke（lite/performance）/ SDK extended / stream smoke | 离线 PASS |
| maintenance ledger 回归 | 4 PASS：跨 realm/串行进程计数、真实 native fetch 在 socket 前阻断、预算耗尽、错误目标；修复版未再次外呼 |
| `.mjs` node --check / launcher sh -n / index.ts TypeScript no-emit | PASS；不是全部 JS 严格类型检查 |
| check-personal | 221/221 PASS：产品组合、Qoder 新测试、footprint gate；不把静态 bytes 当 provider token |
| runtime smoke | PASS：默认、ROTOM_QODER=1、ROTOM_QODER=1 + full tools；5 extensions，保留原工具面和已选 faux model |
| resource + distribution | 最终 48/48 PASS；首次运行 recorder 测试旧数量断言 4→5 未更新，已修正 |
| pack:release | PASS：独立 HOME/cache/staging 新 npm ci、实际 tgz inventory/privacy audit |
| 实际 npm 安装 | PASS：独立 HOME/prefix/PATH（无全局 Pi），默认 resolver 的 Pi0.85.1，default/opt-in/full public-runtime smoke 均 5 extensions / 1 bundled skill / lifecycleErrors=0 |
| 安装后的 launcher 模型可用性 | opt-in --list-models 可见 lite/performance；没有凭据复制、默认模型更改或追加资源绕过 |
| 安装后的 lite 真实 read 往返 | 功能检查通过：仅一次 read，正确合成文件标记；整个探针 FAIL，因为跨进程 ledger 没计数（详见下文）。performance 未继续进行 installed live |
| 隔离同版本重装/卸载 | PASS：--version 0.85.1，卸载 bin/package 消失，临时 HOME 的 session sentinel 保留；未更新用户全局安装 |

本地构建产物 `rotom-0.1.0-alpha.0.tgz`，9,275,600 bytes / 3,791 files，SRI `sha512-X6pEGU8aZ1v18aUYrC3txb180mb6VHfrCP/oI7IhhiVK6GZjP/lUvDCukogI/CgP9+9aIny+6Ecw2BTNV4jTWw==`。包含五个 Qoder 运行时文件，不含维护探针、tests、会话或凭据。没有公开发布。

## 请求记账

最初 maintenance `live-budget.mjs` 替换 globalThis.fetch，私人 ledger 只存整数，脚本串行运行、不重置预算。以下直接模块/SDK 探针累计计数为 19：

1. lite、efficient、performance 纯文本探针：3 次（efficient 失败后停止该脚本）。
2. lite image、performance image、performance thinking：3 次，各一次独立检查，无失败重放。
3. performance 原生工具闭环：2 次。
4. lite extended SDK：11 次。

随后两次 installed launcher 探针的 ledger 增量都为零，但第二次补充的安全元数据证明有 `toolUse` / `stop` 两个模型终止消息，一次 read 与正确回答。第一轮没有保留事件明细，不能从旧 ledger 恢复精确请求总数。第一次把 ledger=0 当成“没有外呼”而再次执行诊断是不成立的判断；本报告保留该验证缺陷。

**不能声称本轮所有请求都严格计入 30 次预算，也不把未计数写成零费用。** 发现后停止所有后续真实调用，没有再测 performance installed live，没有做真实账号切换/断网等。

根因边界：Pi loader 的其他 JS realm 可以保留自己的 fetch 引用，主 realm 的 fetch monkeypatch 不是全进程 dispatch 约束。已将 preload 改为 Node 进程级 `undici:request:create` 构造事件、同步私人 ledger 和超限/错误 scope 时立即终止探针；本地跨 realm 与真实 native fetch socket 前阻断回归通过。未通过新的付费请求复验，也不是所有第三方网络栈的通用预算隔离。探针仍要求完成后比较 ledger 增量与预期调用数，差异即停止。

usage 不含全部取消/未计数请求，费用仍 unknown。

## 上游资料与未完成边界

- [模型说明](https://docs.qoder.com/cli/model.md) 给出 tier/前沿模型与近似 Credits 倍率，但明确倍率不是固定任务价格，依赖上下文、cache、thinking 和工具。
- [usage 文档](https://docs.qoder.com/cli/usage.md) 指向 CLI `/usage` 的真实账户额度，不提供本适配器已核实的逐请求货币价格合同。
- 独立模型接口的稳定支持、第三方使用许可及订阅适用未确认；本次主页检索仅确认 privacy 链接，猜测的 terms URL 返回404，不能据此作许可结论。
- 自动续期明确排除；图片、thinking、efficient/auto/ultimate 及动态目录不启用。保留 text-only fail closed。
- 未真实切换用户账号、未做真实断网/服务端停止生成证明、跨 provider 实际切换、真实 /fork 文件替换、长期重复、满32K或更大容量、Linux、真实 TUI 视觉交互。
- 原生 Pi 的必填零价格仅占位，UI `cost unknown` 与 metadata 保留；不得当作零费用。绑定不是同用户权限沙箱。
- 本轮局部产品接入不解除 rotom 私有发布、第三方许可与其他已有产品边界。
