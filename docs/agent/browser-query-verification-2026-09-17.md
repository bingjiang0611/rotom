# Browser 定向查询：Qoder Ultimate 真实 Chrome 验收

## 结论与配置

**PASS：下列五组合成本地用例完成真实模型 → 候选 Browser → 现有 Chrome Relay 的闭环。** 不代表任意网站、所有 Browser 操作或完整 npm 产品包验收。

- 候选代码：`a7347e516511d0d452226e4a7a85c74c95849faa`。
- 模型：`qoder/ultimate`，thinking `high`；19 条实际 assistant response 均记录相同 provider/model，未切换模型。
- 用户明确授权真实模型与 Chrome 验收、不设预算上限；随后授权更新 Relay 文件，并手动完成 Chrome 重载。
- Chrome extension `0.10.0` / protocol `20`；候选客户端真实握手验证 `snapshot-query` capability。已安装 component 摘要与候选一致：`651f5362af4fa27abbe73b0b89d4a7ca92ea7b1fcb304ab19cd21fe62ad9015d`；extension 摘要 `44eca7c4f0422b86b3f6b913acc6b0ae959c4b13d528d9e257aabed4ae6794e5`。
- 新建 scoped 子会话只显式加载候选 Browser extension 与 Qoder provider，工具仅 `browser_inspect` / `browser_interact`。未覆盖活跃 rotom 主程序、未发布 npm，不将这次结果当成完整 launcher/product smoke。
- 测试对象是独立 loopback HTTP fixture，不访问真实业务网站、不提交真实业务数据。源测试会话及工具结果保留私有，不提交 prompt、页面正文、签名或凭据。

## 固定 fixture 与用例

`/dense`：1,100 个普通原生按钮，之后是 `Tail target sentinel`，另有导航链接和跨 origin iframe（`127.0.0.1` 主文档、`localhost` iframe）。iframe 内有 `Frame sentinel`；`/after` 新文档有 `After navigation sentinel`。三个目标点击分别 POST 对应的本地计数器，页面回读显示确认次数。普通按钮无副作用。

| 用例 | 真实工具证据 | 独立结果 |
|---|---|---|
| 尾部目标 | `text:"TAIL TARGET", role:"button"` 返回 1 个 ref；扫描 3,518 原始 AX 节点、2,233 候选，scanTruncated=false、matchesTruncated=false | 按钮 ref 可点击，页面显示 `tail confirmed 1`，服务器 tail=1 |
| 跨 origin iframe | `Frame sentinel` 返回带 frame scope 的 `ax_1_f1_8` | 页面回读 `frame confirmed 1`，服务器 frame=1 |
| 匹配结果分页 | role=button、首批 limit=200；后续消费唯一 nextCursor，合计两页、600 个不重复 ref，epoch/digest/selection 一致 | matchesTruncated=true、scanTruncated=false；游标全部消费，不伪装全页面完成 |
| 零匹配 | 唯一不存在的名称 + role=button 返回 availableNodes=0，两个截断标志均 false | contentComplete=false，不将有界零匹配解释成全页面不存在 |
| 导航与 stale ref | 导航前 `ax_1_1112` / generation=1；导航后 generation=2。刻意提交旧 ref 一次，收到 `interaction target ref is stale or invalid`；重新观察后使用 `ax_2_2509` | 旧 ref 未增加 tail 计数；新目标页面显示 `after confirmed 1`，服务器 after=1 |

父会话程序化解析整个子会话 JSONL，核验调用与结果对应、所有 cursor 的消费、ref 去重、分页元数据一致、query/readback 字段、两次错误及 provider/model identity；再独立核对服务器事件恰为 `tail → frame → after`，各一次。不是仅采信子会话的 PASS 摘要。这个解析不等于逐字阅读全部会话正文。

测试 tab 在采集证据后由测试会话关闭；不关闭用户原有标签。

## 保留的错误

- 模型第一次尾部点击误传 `expect:"readback"`，被参数校验在派发前拒绝；随后去掉非法 expect，实际点击一次。不是未知写入重放，不隐去此模型使用失误。
- 导航后的旧 ref 错误是预先规定的负向用例，只尝试一次；随后重新观察，未重发旧 ref。
- 无模型认证或 Relay 协议阻塞。原维护目录此前的 Goal installed identity 漂移未在此任务顺手修复；它仍不能由这个只加载两项 extension 的验收消除。

## 用量与范围

- 19 次模型响应，18 次工具调用。
- Provider 报告的累计 input=639,540、output=3,212、totalTokens=642,752；另报告 reasoning=1,785，cacheRead/cacheWrite 均为 0。累计 input 含多轮重复上下文，不是单次上下文长度。
- 19 条独立请求的 credit observation 均为 `reported / complete / billable`；已记录小计 **38.737 Cr**，本测试会话未发现 unknown credit observation。它是服务端报告小计，不是完整账号账本或美元换算；USD 未知，Pi usage 中的 `$0` 占位不作为费用证明。上游官方支持/许可仍未确认。
- 首条到末条 assistant 记录间隔约 150.225 秒；不等同于纯推理延迟，也不包含全部环境准备时间。
- 未覆盖虚拟列表、扫描达到 20,000 上限的真实页面、超时/owner-loss、任意站点任务成功率、不同模型 A/B 或成本改善。需要这些结论时另建固定用例，不从五组通过推断整体性能提升。

最后验证层级：候选 Browser 的真实 Chrome L2，以及指定 Qoder Ultimate + 本地合成任务的 L3 闭环。若实际网站仍因扫描/深度边界无法返回目标 ref，再扩充对应样例并评估定向子树查询；不因预算开放而重复已经成功的写操作。
