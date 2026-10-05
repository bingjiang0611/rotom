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

## 后续：工具参数与分阶段证据

针对调用合同误用和整次调用红绿灯掩盖阶段差异，追加以下小范围改动，不新增工具或重试：

- Browser `expect` 的 16 个合法值由页面侧解析器与模型 schema 共享，`action` 标为必填，open/claim 的参数说明明确依赖。交互的纯参数校验在连接/列举 Relay tabs 之前完成；本地错误既不授予也不消费既有 fallback 许可。
- 只读 reviewer/scout 默认验收本来就是轻量合同。产品 schema 和 prompt 明确：不要给无 shell 的 reviewer 强加 `checked`；workflow 验收会传给子任务，evidence 是追加而非替换，supervisor 自然语言回复不能改写已冻结合同。本次不按 agent 名称猜权限、不静默降级显式验收；这是调用指引，尚未证明真实模型误配率下降。
- coding-policy 仅对带 `then_run` 输入、且开头严格匹配已知 edit/write 回执的结果投影 `codingPhases`。分别记录工具报告的 mutation applied 与 follow-up succeeded/failed，保留原 isError 和结果正文，失败时提醒不重放成功写入。后续命令可能是构建、安装或启动，因此不把 exit 0 标成业务验证通过。
- Subagent 的启动/停止回执增加 `subagentPhase`，不改变底层 results、任务终态或取消逻辑。trace 仅新增白名单枚举，不记录命令、路径或错误正文；inspector 独立显示阶段、目标检查和业务效果，不改写原 span 状态。

兼容边界：既有合法 Browser 值和 wire protocol 不变；`chrome-extension/interaction-target-state.js` 字节变化后，安装新版仍须用户显式重载扩展，本次未执行。旧 trace 没有阶段字段时不追认成功；未知工具回执形状保持原样，不从任意输出猜结果。只有新增实际回执证据证明当前精确投影不够时，才在相应工具所有者补结构化阶段信息或增加有界合同测试，不做通用文本分类器。

验证使用 synthetic receipts、真实 Pi loader、SDK faux provider 和隔离 external-CLI fixture，无真实模型、Chrome 写入或安装升级。阶段投影的测试证明 dispatch/原错误/原结果被保留，不证明文件最终内容、业务完成、真实模型遵守提示或耗时下降。完整 `check-personal` 首轮两个停止 fixture 仍要求 details 引用相同，因新增只读投影失败；改为校验保留原字段、原对象未修改，并继续通过原进程关闭与 residual-write 断言，未放宽取消验收。default/full/scoped context footprint 均重新实测并同步当前合同，不修改历史参考。

## 未修改：用户额外加载的 SoL-Pi

已定位召回套娃来自独立 SoL-Pi package 的 `src/sol-pi/extensions/observation-pack/`，不在 rotom 产品清单中。其 `index.ts` 的召回页上限为 16 KiB，`observation.ts` 的打包阈值为 10 KiB，且未排除召回结果；较大的页经过两次请求后会被再次归档成新 observation。

用户明确选择只改 rotom，因此不添加跨包拦截层，也不改该安装或源码。未来修复须在该所有者实现中保持原 observation ID/offset 可达，补上多次 context 投影、跨页 UTF-8 重建、resume/compaction 和错误结果不重打包回归；本次只记录根因，不宣称召回机制已修复。
