# 长会话：证据范围与编辑恢复

## 本次范围

只修改 rotom 的 coding-policy 与现有离线回归，不增加工具、持久化状态、自动重试或进度提醒机制；不改 Pi fork，不覆盖活跃安装，不发布 npm。

长会话复盘的有效证据是：局部/旧构建验收被扩大为整体完成；全文结构统计与实际阅读范围混淆；已有 repair hint 的同一 edit 失败后仍发生相同重试。会话里确实已出现旧版 `Repair hint:`，因此不能把问题归因为尚未加载该机制。单次会话不足以证明总体失败率或模型能力变化；会话跨度含人工等待，其他项目的 idle 会话不是闲置子 Agent。

## 产品改动

- `rotom/extensions/coding-policy/index.ts` 复用既有 `before_agent_start` 注入，仍仅在 bash/edit/write 激活时生效，不覆盖显式工具选择。
- 完成声明绑定场景与 artifact/version，区分验证证据、未验证项/限制和 commit/install/push 状态；build、短样本、dispatch 或旧版测试不证明当前完整链路。未知业务结果保持 unknown，不为了报告完整而擅自执行外部动作。
- 区分完整文件解析、完整内容阅读和定向抽样；统计、摘要、头尾或首个召回页不能证明全文阅读。需全文声明时完成源分页，否则如实报告检查范围。这是证据约束，不要求所有任务都读全文。
- `repair-hints.ts` 在 oldText 首行已不存在时，尝试用后续唯一整行给出重读行号。只返回位置线索，不声称整个 block 已匹配；不改变原错误/isError，不执行 edit/then_run，不自动重放。

定位沿用 4 MiB 文件探测上限，最多检查后八行，忽略空行、重复行和子串。无可靠锚点时保留原有重读建议。只有新增失败证据证明锚点经常落在该窗口外才考虑扩大有界窗口，并补相应负向测试；不要用模糊自动替换绕过精确编辑合同。

## 离线验证

复用现有 coding hygiene cases/judges，不建立新的评测框架，不提交原始会话、设备坐标或凭据。

| 检查 | 证明范围 | 本机结果 |
| --- | --- | --- |
| `node --experimental-strip-types --test --test-concurrency=1 rotom/extensions/coding-policy/index.test.ts rotom/extensions/coding-policy/repair-hints.test.ts` | 注入边界、真实临时文件的行号提示、重复/子串/窗口限制、原错误保留和文件不变 | 9 passed |
| `cd rotom/evals && npm run typecheck` | eval 类型检查 | PASS |
| `cd rotom/evals && npm test -- test/coding-hygiene-rule-ablation.test.ts` | 新决策样例正反例、规则绑定、真实 SDK + faux provider 接收到产品 prompt，重建/逐条消融合同不漂移 | 7 passed |
| `env -u ROTOM_OBSERVABILITY rotom/bin/check-personal` | 产品组合确定性回归与 context footprint 合同 | 462 passed，runtimeContractGate / deterministicGate PASS |

新决策样例覆盖：短样本不代表长历史/证书到期，旧构建不代表当前版本，dispatch 不代表业务成功，commit 不代表 install/push，完整解析不代表完整阅读。judge 使用合成答案验证评分器；faux provider 仅证明提示实际送达，**不证明模型已遵守或节省了 token/时间**。

保留的开发失败：新增 judge 测试首次 typecheck 缺少标准 JudgeContext 字段；按依赖类型补齐无工具调用的合成 run 后通过，没有改变产品合同来跳过检查。未执行付费模型 A/B、真实设备/浏览器验收或安装升级。

## 未修改：用户额外加载的 SoL-Pi

已定位召回套娃来自独立 SoL-Pi package 的 `src/sol-pi/extensions/observation-pack/`，不在 rotom 产品清单中。其 `index.ts` 的召回页上限为 16 KiB，`observation.ts` 的打包阈值为 10 KiB，且未排除召回结果；较大的页经过两次请求后会被再次归档成新 observation。

用户明确选择只改 rotom，因此不添加跨包拦截层，也不改该安装或源码。未来修复须在该所有者实现中保持原 observation ID/offset 可达，补上多次 context 投影、跨页 UTF-8 重建、resume/compaction 和错误结果不重打包回归；本次只记录根因，不宣称召回机制已修复。
