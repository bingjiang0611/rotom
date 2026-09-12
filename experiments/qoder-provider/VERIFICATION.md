# Qoder provider 修复与验证结论（d66676e 历史验收）

后续产品接入见 [产品验证](PRODUCT-VERIFICATION.md)。运行时与单测已迁至 `rotom/extensions/qoder/`；以下旧命令属于当时提交的证据，不应从当前树直接运行。

## 当前判定

**有界实验验收 PASS；正式产品/长期稳定性认证仍不具备。**

宿主 Pi `0.85.1`。本轮基于 `8843778` 修复协议和账号生命周期，未修改 Pi、installed package、rotom launcher、默认资源或发行包。上一轮报告可用 `git show 8843778:experiments/qoder-provider/VERIFICATION.md` 阅读，旧失败没有被删除或改写成成功。

## 修复内容与证据

### 1. SSE framing 与压缩

旧解析器在重组原始换行时，先丢弃看起来像 SSE comment/id/event 的行，可能破坏完整 JSON。现在：

- 优先解析标准 SSE，包括标准多行 data、注释、错误事件与 CR/LF/CRLF。
- 标准 JSON 不完整时，仅在同一帧内尝试重组原始续段；`:`、`data:`、`id:`、`event:` 等原始字节不会先被丢弃。
- 不添加引号、括号、工具参数、finish、usage 或 `[DONE]`，不跨帧拼接。有效标准 SSE error 仍失败；完整 JSON 字符串中的字面 `event: error` 不再误判。
- 每个字符边界的合成 usage、正文、工具参数切分回归均要求与未切分的归一化结果完全一致。
- 真实验证发现续段也存在于非空 choices 帧，不能限制为 usage-only。最新压缩诊断同时观察到 `frame_continuation` 和 `usage_continuation`，后者含 `fieldLike: 2`，压缩与摘要重放成功。

先前没有保留帧正文的失败样本，仍无法逐例确定根因；上述可复现缺陷和最新成功，不是“所有历史失败已精确归因”的证明。

### 2. 账号生命周期

- 首次 dispatch 前，按账号 uid、可用 org_id 与 machine_id 计算 HMAC 摘要，保存为 Pi 的非模型 custom entry。
- 整个会话树检查绑定；跨恢复、压缩及分支不能偷偷换账号。记录损坏、相互冲突、写入无法证明、session owner 失效时阻断。
- 旧 Qoder 历史缺少绑定，或未绑定压缩历史隐藏来源时，要求新会话，不推定它属于当前账号。
- 凭据读取前捕获 session lease；读取中取消或会话失效，不绑定、不 dispatch；预取消也不读取凭据。
- token 每次重新读取，同账号 token 更新可继续使用；不同账号/组织/机器摘要会拒绝。catalog availability 检查不会绑定或写入会话。
- 原生 OpenAI SDK 会把 fetch 抛错压成 “Connection error”。现在以本地合成 HTTP400 错误响应保留白名单 Qoder 错误码，并标注 `x-qoder-error-source: adapter`；不附上游正文、不增加 dispatch，不将其冒充上游成功响应。

只持久化摘要与 `pricing: unknown`，没有 token、原始账号 ID、refresh token 或机器 ID。摘要不进入模型上下文。直接实例化 provider 的 SDK 用户只有实例级绑定；持久绑定通过扩展 `index.ts` / `installQoderExtension()` 安装。

### 3. 到期与费用提示

到期仍按只读权限阻断；同账号正常登录更新后可继续，**没有实现/启用自动续期或自动重放**。状态栏提示费用未知，且在包含 Qoder 历史的混合会话中保留提示；custom metadata 标记 `pricing: unknown`。原生 Pi 必填数字价格仍为占位，不能据此计算真实费用。

## 实际检查

| 命令/范围 | 结果 |
|---|---|
| `node --test --test-concurrency=1 experiments/qoder-provider/*.test.mjs` | 58/58 PASS |
| `node --experimental-import-meta-resolve experiments/qoder-provider/smoke.mjs` | 离线原生 serializer/events、工具往返、预取消 PASS |
| `node --experimental-import-meta-resolve experiments/qoder-provider/session-smoke.mjs` | 离线真实 SDK：工具循环、绑定、分支、磁盘恢复、压缩、取消、外部 provider 合成历史、恢复后账号切换零 dispatch、截断工具不执行 PASS |
| `node --experimental-import-meta-resolve experiments/qoder-provider/stream-smoke.mjs` | 离线独立取消、后续请求、合成跨 provider 工具历史 PASS |
| `node --experimental-import-meta-resolve experiments/qoder-provider/session-smoke.mjs --live` | 最新 6 次真实请求全部完成对应检查：工具循环、账号绑定、磁盘恢复、手动压缩/摘要重放、流中取消及后续请求 PASS |
| `.mjs` 的 `node --check`、`index.ts` 的 TypeScript no-emit 检查 | PASS；不是全部 JS 的严格类型检查 |
| 隔离 cwd/agentDir 显式 `-e index.ts --list-models qoder` | PASS；不是 rotom launcher 集成 |
| `git diff --check -- experiments/qoder-provider` | PASS |
| 有界只读审查 | 发现字面 event:error 误判、预取消检查次序两个问题；主会话已修复并补回归 |

SDK smoke 在重建 session 时也重建 extension 实例，避免复用旧 ExtensionAPI；错误路径记录固定错误码，不输出 prompt、模型正文、工具参数/结果、凭据、header 或原始异常正文。只输出有界结构计数，不保存原始失败帧。

## 真实请求记账

本轮共 **15 次 dispatch**：

1. 加入结构诊断、尚未修 framing 前的 6 次 SDK 检查恰好通过，证明原问题具有条件性，不作为修复证据。
2. 中间版本 3 次：真实工具循环、绑定与恢复通过；usage-only 限制在压缩时触发 `nonstandard_content_frame`，立即停止。
3. 用户要求继续后，新的有界 6 次检查通过，并实际观察到 choices 和 usage 两类续段，含类似 SSE 字段的续段。

最后的字面 event:error、预取消、错误码显示和费用提示小修已由确定性/离线 SDK 回归复验；未为这些不改变已测 happy path 的修改额外消耗真实额度。

所有外呼仅发送合成数据和纯测试工具；没有读取并上传仓库文件，没有启动 Qoder CLI，没有刷新、复制或写回真实凭据。临时 SDK 会话只保存合成内容，脚本结束后清理自己创建的目录。取消只证明本地流终止，不能证明服务器停止生成或计费。汇总 usage 缺少被取消请求的完整数据，不能当账单。

## 不能宣称已解决的边界

- 上游接口支持、订阅适用/第三方使用许可、长期稳定性不能由代码或少量测试保证。
- 真实价格/额度/账单接口未核实，机器 Usage 中的数值占位仍不是真实费用。UI 提示经过 mock 与扩展加载检查，未做真实 TUI 视觉重放。
- 不刷新凭据的授权约束仍保留；自动续期、登录 UI 尚未实现。
- 长上下文/自动压缩、真实分支切换、多账号真实切换、真实断网、长期重复运行、图片、thinking、多模型发现、32K 容量都未获真实验证。账号切换阻断使用加密合成凭据和真实 Pi SDK 验证，不切换用户真实账号。
- 账号摘要绑定不是抵抗恶意本地文件修改的沙箱；不能替代同用户权限/凭据安全。
- 本轮没有把该实验接入 rotom 默认资源/发行合同，也没有运行全仓发布 gate。
