# Ultimate / DeepSeek-V4-Flash 协议续查

> 本文保留 `e0b3e0c` 的历史范围与独立 21 次账本。当前 Default 17 项的后续工作见 [全模型验证](ALL-MODELS-VERIFICATION.md)，不回写本轮结果或额度。

## 范围与结论

本次接续 `b4d2041` 的目录验证，不改 provider / session 绑定 ID，不迁移活跃会话，不更新全局安装或推送。

- **Ultimate：PASS（限定协议）**。支持已观测的单个 `{id, encrypted_content}`，通过 Pi `reasoning_details` / `thinkingSignature` 无损保存和回传；不解密、不伪造、不丢弃。只允许同 provider / model / API 的历史，未知字段、多个 item、跨模型及 tool thoughtSignature 仍拒绝。补充其显式 `stop` 但没有 `delta` 的终止帧；不推断 finish、usage 或 DONE。
- **DeepSeek-V4-Flash：PASS（限定协议）**。准确 key 仍是 `dfmodel`。新 thinking-on 请求在原 direct endpoint 返回错误，而相同账号目录及旧版 COSY 推理协议可用；这不是账号 entitlement 或 thinking 开关结论。产品为该 key 明确选择固定旧版单次模型生成端点，不先试 direct、不回退重试、不启动 CLI 或远程 agent 循环。
- Flash 使用目录元数据和固定内部 `high`；Pi 仍只提供一个 `medium`（enabled）选项。把纯文本 message content 规范成字符串，保留工具和 reasoning 字段；仅接受在完整 DONE 后的一个精确三字段数值计时 trailer，其他尾部数据仍报错。
- 六条 reasoning 路由、九条总路由进入已验证白名单；仍需当前账号 enabled 目录。图片、可调 effort、更大容量、其余目录 key 不因此启用。

## 授权与请求账本

用户为本次 Ultimate/Flash 续查明确授权真实请求“不限次数”。继续只发合成内容/无副作用测试工具，现有 Pi 浏览器凭据只读，不登录、不刷新，不重放未知结果；费用未知。维护 preload 仍保留 **30 次单账本自限**，并非本次用户额度。

新账本：`/private/tmp/rotom-qoder-reasoning-investigation.Yl22Vj/ledger`（私有普通文件）。上一轮 30/30 账本不动；更早漏计轮次仍为 INCONCLUSIVE。

| 顺序 | 新用例 | 实际请求 | 结果 |
|---|---|---:|---|
| 1 | Flash direct thinking-on | 1 | 错误帧，未通过 |
| 2 | Ultimate opaque 结构探针 | 1 | 完整 tool_calls / usage / DONE，识别双字段 item |
| 3 | 聚焦账号目录 | 1 | 两个原始 key 均 enabled，未发现替代 server_model |
| 4–5 | Ultimate 首次 native SDK | 2 | 第一轮成功；第二轮 `invalid_delta`，未重放 |
| 6 | 独立 Ultimate 文本 framing 探针 | 1 | 证明 stop 帧没有 delta |
| 7–8 | 修正 framing 后的新 Ultimate SDK 用例 | 2 | 两轮 PASS，密文原样回传、磁盘恢复 |
| 9 | Flash legacy 合成文本对照 | 1 | 完整文本/推理/usage/DONE |
| 10 | Flash 首次 native SDK | 1 | `data_after_done`，未执行/回传工具 |
| 11 | 独立 legacy 文本尾帧诊断 | 1 | 识别三个数值 duration 的 trailer |
| 12–13 | 修正尾帧后的 Flash 新用例 | 2 | 第一轮成功，第二轮错误；未重放 |
| 14–15 | 按 legacy 合同规范 null/纯文本 content 后的新用例 | 2 | 两轮 PASS，plain reasoning 回传、磁盘恢复 |
| 16–18 | 实际安装包 Ultimate + 真实目录 | 3 | 目录 + 两轮 PASS，opaque 回传、磁盘恢复 |
| 19–21 | 实际安装包 Flash + 真实目录 | 3 | 目录 + 两轮 PASS，plain 回传、磁盘恢复 |

**最终累计 21：目录 3 + 模型 18**，全部逐探针对账；未继续消耗自限的剩余空间。

源码阶段累计 **15：目录 1 + 模型 14**。每个进程串行执行并核对自身 dispatch 增量；凭据文件摘要逐次未变。错误用例的结果保留，不用后续 PASS 覆盖。原始正文、推理、密文与服务错误原文不进入报告；临时合成 SessionManager 文件只在私有目录保存，完成后删除本脚本创建的目录。

旧版额外 scope 仅在 `ROTOM_QODER_PROBE_LEGACY=1` 下允许以下 POST：

```text
https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
```

它和目录 GET / 原 direct POST 共用进程级 `undici:request:create` 账本。刷新、其他路径、方法与重定向不允许；不是通用网络沙箱。维护探针不包含发行包。

## 实现与本地验证

- 十个 runtime 文件；新增 `legacy.mjs` 同步进入 package files / resource requiredFiles。无新依赖、不修改 installed Pi/CLI/WASM。
- 浏览器加密请求信封同时封存 uid/org/machineId；旧版签名从同一次绑定 token 读取的 request-local 凭据取得身份，不能在 await 后重新取 mutable current-user。
- 9router 开源协议参考与完整 MIT 通知保留；没有复制其“忽略所有 DONE 后数据、丢弃密文、EOF 补 DONE”的行为。
- `node --test --test-concurrency=1 rotom/extensions/qoder/*.test.mjs experiments/qoder-provider/{live-budget,reasoning-probe,legacy-probe}.test.mjs`：**136 PASS**（provider 127 + 维护 9）。
- `rotom/bin/check-personal`（显式维护 Pi executable）：**280 PASS**，deterministicGate PASS。
- resource/distribution：**48 PASS**；targeted TypeScript、MJS syntax、diff 检查 PASS。
- 隔离 HOME 与进程级禁止网络下：Lite/Performance、extended session、stream、OAuth、gmodel / ultimate / dfmodel SDK，以及 source runtime default/CLI/browser 均 PASS。
- SDK 的工具往返使用 Pi 原生 stream 事件与消息序列化；Ultimate/Flash 两轮之间经公开 SessionManager 落盘/恢复，再验证实际 wire 中的 reasoning 回传。不是在真实 TUI 点击模型或完整用户业务任务的证据。

日志：`/tmp/rotom-qoder-reasoning-{unit-final,check-personal,resource}.log`；离线结果在 `/private/tmp/rotom-qoder-reasoning-offline.UlBGkp/`；真实用例结果在账本同目录。

## 发行产物验收

**PASS，未更新全局安装。** 实际产物：

- `/private/tmp/rotom-qoder-reasoning-release.zOs1a1/rotom-0.1.0-alpha.0.tgz`
- 9,288,513 bytes / 3796 files，Pi 0.85.1；未升版本、未发布。
- Integrity：`sha512-OvOhQF77yKCB4kSFa9iETL7YXsrJhP0bLHzCBLdugJPz8TteTc8gBkdXOcyiaPXU6V5nfjp0m+/0kPLz33cGbw==`。
- `cd rotom && npm run pack:release -- <absolute-output>`：隔离重装锁定依赖、tree/tgz 隐私审计与实际文件清单 PASS。未包含实验探针、测试或无关 WIP。
- 独立 HOME/cache/npm configs/prefix，PATH 没有全局 Pi；从实际 tgz 安装，十个 Qoder runtime 文件逐字节与本次源码相同。`rotom --version`、default/browser/full runtime、installed Ultimate/Flash 离线 SDK 均 PASS。
- 从上一版 catalog tgz 升级到本产物，十文件身份再次核对；随后用安装包内的 provider / Pi 执行两组三请求实测。均为 `toolUse → stop`、真实目录一次、两次模型请求、diskResume=true、凭据摘要前后相同。此后隔离卸载 PASS。
- 安装证据：`/private/tmp/rotom-qoder-reasoning-installed.72lzPZ/` 的 `identity.log`、`upgraded-identity.log`、`runtime-*.json`、`live-ultimate.json`、`live-dfmodel.json`、安装/升级/卸载日志；pack 日志 `/tmp/rotom-qoder-reasoning-pack.log`。临时安装产品已卸载，tgz 与脱敏证据保留。

这些真实结果针对上面的同一个最终 artifact，不用源码目录成功替代安装包。

## 未验证与限制

独立浏览器登录/真实刷新、真实 TUI 选择、完整业务 AgentSession 行为、图片、可调 thinking、容量上限、真实长对话/压缩、跨区域/VPC、Linux fsync、长期稳定性、计费与官方第三方支持仍不因本次通过而得到证明。仅凭目录 enabled 不能声称所有模型可用，Pi 零价格占位不代表免费。
