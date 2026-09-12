# Qoder Default 全模型适配（历史验收）

> 本页矩阵、路由和安装产物属于本批快照；后续已增加可调 effort、三模型图片/272K 管理窗口、Ultimate 固定 COSY，并改为默认 browser 认证。当前用法见 [产品说明](../../rotom/README.md#qoder原生-provider显式启用)，后续证据见 [图片与大上下文](IMAGE-CONTEXT-VERIFICATION.md)。旧 PASS/FAIL 和请求账本不改写为当前版本验收。

## 授权、范围与状态

接续 `e0b3e0c`。用户提供四张 Default 模型截图，明确授权本轮全部模型真实验证 **不限次数**。仍只使用合成输入/无副作用测试工具；现有 Pi browser 凭据只读，不登录、不刷新、不读 CLI 凭据，不迁移活跃会话，不更新全局安装，不推送。

本轮新账本 `/private/tmp/rotom-qoder-all-models.lQ82kl/ledger`，mode 0600、父目录 0700。首次目录请求沿用默认 30 自限；随后明确设置 `ROTOM_QODER_PROBE_LIMIT=100`，不重置计数，不使用先前账本。配置上限不是用户授权、价格预算或通用网络沙箱。

**目标是当前账号 Default 目录 17 项的文本/原生工具往返与恢复，不是全部模态、1M 容量、Enterprise/BYOK 或未来任意模型。** 探索阶段的不同候选实现不冒充最终统一版本；最终以实际安装包逐项结果为准。

## 发现与协议边界

- 旧 `Cosy-Version: 1.0.0` 返回 16 项；改为官方 CLI 静态实现中核实的 `1.1.45` 后返回 17 项，新增真实 key **`smodel` / Sonus**。后续恢复 1.0.0 的对照仍无 Sonus。不是猜 `smodel` 或更换账号权限。header 是兼容版本，不是 rotom 发行版本或官方支持承诺；COSY 信封其余已验证格式保持不变。
- 八条路线保持 direct，九条明确选择 legacy 单次模型生成；不在请求失败后尝试另一条路线。Kimi-K3 曾单独比较 direct（失败），最终使用修正后的 legacy。
- 目录 `is_reasoning` 仅描述能力，不是选中的请求模式。legacy 的 `model_config`、`chat_context`、parameters 必须与固定模式一致；Kimi-K3 的工具后续在修正后通过。
- GLM-5.3-Flash 的简单首轮不一定返回 thinking；一次 off 用例反而返回了推理。不能由前者断言不支持推理，也不能声称可以可靠关闭。最终只开放经过新用例验证的固定 enabled。
- Sonus 的完整 item 为 `{id, encrypted_content, target_hash}`，使用独立 `rotom-qoder-sonus-v1` native signature 格式封装全部字段；不解密、不重算 target_hash，不丢字段。Ultimate 的旧双字段格式和历史签名不变；不同模型/protocol 的 opaque 历史拒绝互换。
- Sonus 的 `function_call` finish enum 搭配现代 `tool_calls` deltas，仅在该 legacy 路线上映射为 Pi 的 tool_calls。
- MiniMax/Sonus 的已观测 legacy 流没有字面 `[DONE]`。仅在 **显式 finish + 实际 usage + 完整合法工具参数 + 精确三数值 metrics 尾帧** 同时成立时映射 native DONE；不凭 EOF、单独 metrics 或残缺流补成功。后续内容、错误或重复尾帧仍拒绝。其余路线的旧 DONE 门禁不放宽。

静态线索：官方 CLI 1.1.45 bundle 的 `listModelsFromRemote`、`Yp().scene` 和 `Cosy-Version` 注入；源文件只读，不执行 CLI/WASM。只读 scout 未找到静态 Sonus key，实际 key 来自授权目录。scout 的唯一自动产物已移至本轮私有目录，不进入产品或提交。9router MIT 协议参考/通知继续保留，没有复制其 EOF 补 DONE 或丢弃密文逻辑。

## 最终声明矩阵

所有行仍受账号 enabled、当前目录 TTL、source=system 和已验证格式约束。Lite/Performance 以外没有离线 availability fallback。

| Key | 当前名称 | 固定传输 | 思考模式 |
|---|---|---|---|
| auto | Auto | direct | 不启用 |
| ultimate | Ultimate | direct | enabled；双字段 opaque |
| performance | Performance | direct | 不启用 |
| efficient | Efficient | legacy | 不启用 |
| lite | Lite | direct | 不启用 |
| smodel | Sonus | legacy | enabled；三字段 opaque |
| qmodel_38max | Qwen3.8-Max | legacy | enabled |
| qfmodel | Qwen3.8-Flash | legacy | enabled |
| qmodel_latest | Qwen3.7-Max | legacy | enabled |
| qmodel | Qwen3.7-Plus | direct | enabled |
| kmodel_latest | Kimi-K3 | legacy | enabled |
| kmodel | Kimi-K2.7-Code | direct | enabled |
| gmodel | GLM-5.3 | direct | enabled |
| gfmodel | GLM-5.3-Flash | legacy | enabled |
| dmodel | DeepSeek-V4-Pro | direct | enabled |
| dfmodel | DeepSeek-V4-Flash | legacy | enabled |
| mmodel | MiniMax-M3 | legacy | enabled |

13 条 reasoning 路线仅显示 Pi medium（enabled），不是可调强度。legacy 内部固定 high，另外四条不开放 reasoning；上下文仍最多 32K，输出最多 4096，text-only。

## 源码探索计数与不成功记录

| Dispatch 序号 | 用例 | 结果/处置 |
|---|---|---|
| 1–2 | 原版本头 / CLI 兼容版本头目录 | 16 / 17 项，均完整成功 |
| 3–4 | Efficient SDK | PASS |
| 5–6 | Qwen3.8-Max，父批处理执行被中断 | **UNKNOWN**：计数增加 2，但捕获于父进程内的结果丢失；确认相关进程已结束。不重放原请求，不补写成功/凭据摘要证据 |
| 7–8 | Qwen3.8-Flash SDK | PASS |
| 9–10 | Qwen3.7-Max SDK | PASS（早期候选模式字段） |
| 11–12 | Kimi-K3 legacy | 第一轮成功，第二轮 envelope 403；不自动重试 |
| 13 | GLM-5.3-Flash high | 首轮工具完成但没返回 thinking，未进行第二轮，不认作完整 PASS |
| 14 | MiniMax SDK | 未识别的服务终止；失败保留 |
| 15 | Sonus SDK | 未支持的 finish enum；失败保留 |
| 16–17 | MiniMax / Sonus 独立 framing 探针 | 识别 finish/usage/metrics 及 Sonus opaque 差异 |
| 18–19 | MiniMax 终止桥接新用例 | PASS |
| 20 | Kimi-K3 direct enabled 对照 | upstream error，失败保留 |
| 21–23 | Sonus schema / 非工具文本 / key schema | 固定错误类别/字段结构；未执行工具；确认 function_call、target_hash 和无字面 DONE |
| 24–25 | Sonus 完整协议新 SDK 用例 | PASS，opaque 回传与 diskResume |
| 26–27 | Kimi-K3 请求模式一致性修正后 | PASS |
| 28 | GLM-5.3-Flash off 独立对照 | 服务仍返回 reasoning，adapter 拒绝；不宣称 off 可用 |
| 29–30 | GLM-5.3-Flash 固定 enabled 新用例 | PASS |
| 31–32 | 修订实现与不同合成输入的 Qwen3.8-Max 独立验证 | PASS；全新 nonce/session，不使用 5–6 的请求 ID/工具结果，原 UNKNOWN 不改写 |
| 33 | 恢复 1.0.0 header 的目录对照 | 仍为 16 项，无 Sonus |

源码阶段 **33 次：目录 3 + 模型 30**，其中 2 次模型请求的结果为 UNKNOWN。之后每个进程直接将输出保存到独立私有文件，不再仅在父进程内缓存。所有有完整结果的探针均核对 dispatch 增量与前后凭据文件摘要；缺失的那次不声称摘要检查通过。没有自动恢复、写回或刷新真实凭据的流程。

## 本地验证

- `node --test --test-concurrency=1 rotom/extensions/qoder/*.test.mjs experiments/qoder-provider/{live-budget,legacy-probe,reasoning-probe}.test.mjs`：**142 PASS**。
- `rotom/bin/check-personal`（显式维护 Pi）：**285 PASS**，deterministicGate PASS。
- resource/distribution tests：**48 PASS**（本轮约 394 秒，包含维护树复制；不是模型延迟）。
- targeted TypeScript、MJS syntax、diff 检查 PASS。
- 进程级阻断网络、隔离 HOME：全部 17 key 的 native SDK/disk roundtrip、原 Lite/Performance、extended session、stream、OAuth、source default/CLI/browser runtime 均 PASS。
- 测试涵盖版本头、17 项声明、source/disabled/unreviewed 过滤、精确 legacy key/body/header 一致性、模式字段一致性、Sonus 全字段签名/跨模型拒绝、终止证据组合及反例、默认和显式账本上限。

最终在并行的无关 `f8a7ae6` 提交后重跑 targeted 与 check-personal，仍为 142 / 285 PASS；该提交未修改发行资源。本任务未混入其 owned-store/session 改动。

日志 `/tmp/rotom-qoder-all-{unit-final,unit-recheck,check-personal,check-personal-recheck,resource}.log`；本轮目录下 `offline-final/` 与逐探针 JSON。报告不包含模型正文、推理文本、密文、账号/认证值或服务错误原文。

## 实际发行包验收

同一个实际 tgz：

- `/private/tmp/rotom-qoder-all-release.jfnij0/rotom-0.1.0-alpha.0.tgz`
- **9,289,654 bytes / 3796 files / Pi 0.85.1**，private、unpublished。
- Integrity：`sha512-2oLuVii071TE7iuTsOBwYfdEXLqh2qVUXHTNqotWbUsVEKFkCsYBudsgenc+0LjBinyrclAV5BEBQCCI4fcQAA==`
- `npm run pack:release -- <absolute-output>` 使用隔离 HOME/cache 与锁定的新依赖安装；实际 tgz 隐私审计通过，不复制维护者 node_modules。
- `/private/tmp/rotom-qoder-all-installed.Z4FSYx/`：隔离 prefix/HOME/cache，PATH 无全局 Pi；实际安装、十文件源码身份、公开 rotom bin、default/browser/full runtime、全部 17 key 离线 SDK 均 PASS。
- 从上一轮 Ultimate/Flash tgz 安装后升级到本 tgz，随后进行真实模型验收；最后再次核对十文件与当前源码逐字节一致，卸载并确认私有 package/bin 均移除。全局 rotom 未更新，活跃会话未迁移。

### 真实安装包结果（全部使用上述同一 tgz）

第一次串行批次，按矩阵的 17 行顺序，每项独立 **1 次实际目录 + 2 次模型**，对应 dispatch **34–84**。16 项完整 PASS；Ultimate 在 **37–39** 的两轮均有合法 toolUse/stop、usage、opaque 回传和 diskResume，但最终回答未通过精确字符串断言。该次保留 **NOT PASSED**，没有将协议成功冒充用例成功，也没有保留原文来推测具体不匹配原因。

维护 smoke 的旧描述称工具为 echo，实际校验 nonce 后返回另一个新 marker；测试定义存在歧义。修正说明，并取消 Ultimate 不必要的算术指令（不修改产品/传输，不放宽答案断言）；以全新 nonce/session 发起独立用例 **85–87**，精确答案、opaque 回传、diskResume 全部 PASS。新增答案匹配布尔与字节长度 metadata，不保存正文。原 37–39 仍失败，不将新用例解释为必然证明旧失败原因。

最终 **17 个不同模型各有完整 PASS**，但不是首批 17/17 全过。安装包共 **18 用例 / 54 次请求：目录 18 + 模型 36**；均有完整结果、计数对齐、凭据文件前后摘要相等。每项 PASS 都验证真实 terminal pair、工具参数、结果引用及公开 SessionManager 恢复；13 项 reasoning 验证 plain 或 opaque 回传。文件为 `live/<key>.json`，Ultimate 的补充独立用例为 `live/ultimate-unambiguous-tool.json`；`live/progress.jsonl` 保留首批开始/结束记录。

更新后的 smoke 又在同一安装包对全部 17 key 离线通过；Sonus/MiniMax 的 `--negative-trailer` 均证明 **实际 native SDK** 会在合法 metrics 之后遇到额外数据时报 `data_after_done`，不会因已经收到 DONE 而提前成功。这不是只有 raw normalizer 测试。

### 最终账本

**87 / 100 自限 = 21 次目录 + 66 次模型**。包含探索失败、一次安装包答案不匹配、以及最初两次结果 UNKNOWN；并非 87 次成功。没有修改旧轮额度、清零或漏记上述失败。费用仍未知。

最终 MJS syntax、`git diff --check` 与 tracked-tree 隐私扫描 PASS（扫描不是任意秘密/所有权保证；包含新报告的暂存树亦再审计）。打包后的改动仅为维护报告/探针，不在 tgz 中，不改变已经实测的产品字节。

## 不扩大结论

Pi native stream/serializer 和公开 SessionManager 的工具消息往返不等于真实 TUI 点击、完整业务 AgentSession、业务文件工具执行或大上下文压缩验证。独立浏览器登录/真实刷新、多模态、可调 reasoning、1M 容量、跨区域/VPC、Linux fsync、长期稳定性、计费与官方第三方许可仍未验证；截图倍率和 Pi 零价格不等于实际费用。
