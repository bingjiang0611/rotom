# STATUS-2：显式 AXOpen 与投递证据

> 本页保留该轮历史记录。后续 Finder 验收状态、O1/S2 实现与当前验证见 [打开目标确认与测试闸门](STATUS-2-open-target-guard.md)。

## 范围和状态

基于已审核的 `8b55ca0`。用户批准本轮只改独立开发 checkout、做离线验证、推送送审；不覆盖或停止活跃安装/helper，不做真机操作，不重放此前 unknown，不改 S2。

本轮没有重建测试安装、更新原生归档或启动 helper。新增动作尚未证明能在真实 Finder 中切换目录，也未证明 AXOpen 自身绝不影响前台。须审核通过后另行冻结、重建并授权一次新测试。

## 已有真机证据（旧测试版 `8b55ca0`）

会话记录中的本次 `act_ui` 于 2026-11-11 07:48:17 UTC 开始：

- 普通 Finder 窗口精确配对，当前为 Recents；Downloads 的观察节点为 `AXCell`，仅提供 `AXOpen`，`canPress=false`，不是 picture-only。
- 授权记录有 `received`、`prompt_requested`；约 90 秒后收到 `decision=allow_session` 和 `response_ack`。本次未触发旧的 45 秒提前退出。`prompt_requested` 本身仍不证明卡片被看见。
- 实际执行的动作是一次 `click`。原始 `details.execution.steps` 报告 `performed.delivery=pid`、`outcome=unknown`，窗口标题回读仍为 Recents；不能证明目录切换成功，也不据此授权重放。
- 调用链表明旧 `click` 对不支持 AXPress 的该节点进入进程定向鼠标事件路径，而非 AXOpen。该次 Finder 是否消费了鼠标事件仍未知。
- 用户明确回答“没有”观察到前台、焦点或光标干扰。这是用户报告，不是仪表验证。
- 原始 details 中有投递证据，但 Pi 给模型的 content 没有该字段。此前把模型总结缺失归因为“漏读”不准确，本轮补正文证据。

## 改动

1. `act_ui.actions` 增加显式 `{ action: "open", ref }`。只接受有 wire ref、非 picture-only 且当前观察列出 `AXOpen` 的节点；不接受坐标。普通 `click`/`press` 不自动变为 open。
2. open 沿用 click 级授权、敏感动作检查、租约和 native 写入检查。native 再核验 AXOpen，调用一次受管 AX 写入方法；不刷新后补发、不走鼠标、不激活窗口、不回退到前台。
3. AX 返回 success 只表示该 API 接受操作，不证明目录或业务状态变化。open 初始结果始终为 unknown，带 `delivery=ax`、`grounding=description`、`axAction=AXOpen`、`verification=caller_required` 和 AX 返回码。调用方须用准确的 expect 或只读后继状态核对；已有条件不冒充操作效果。
4. 同一批次不能对同一 ref 混用 open/click/press 作为重试。跨调用的 unknown 不重放继续依赖既有合同，不宣称新增了全局去重器。
5. `computerUseEvidenceResult` 把每步实际 delivery 和 AXOpen 枚举写入模型可见正文；最多 20 步，只显示允许的枚举，不把 App、标签、任意错误正文带入新增摘要。策略选择的 `deliveryLevel` 不冒充实际投递方式。
6. macOS helper/client 协议同步由 9 升到 10，阻止新客户端把旧 helper 当成支持新动作的版本；沿用不自动重启其他会话 helper 的规则。当前运行的协议 9 测试版保持不动。Browser、Windows 和 Linux 不因此获得 AXOpen 能力。

## 离线验证

| 检查 | 结果与边界 |
| --- | --- |
| `node --test --test-concurrency=1 --experimental-strip-types test/*.test.ts`（包目录） | 289/289 通过，0 跳过；包括新动作约束、请求参数、同批重复拦截、正文证据、旧协议不重启 |
| Swift 动作控制流 | 提取实际 open 分支，在 Swift 中替换 AX 调用为确定性桩；无能力时 0 次派发，success/error 各 1 次且保持 unknown；从 pid/coordinates 初始值纠正为 ax/description。不是 GUI 或真实 AX 调用 |
| 负对照 | 在临时源码副本删除观察到 AXOpen 的准入检查，新回归按预期失败；原开发树未回退 |
| `xcrun swiftc -typecheck` | 按 build-native 的 9 个源文件和框架，arm64 / macOS 14 target 通过；仅编译检查，没有生成或运行 helper |
| `node scripts/cu-v2-script-dry-run.mjs` | 38 项、0 失败、3 项真机检查跳过 |
| `npm run typecheck` | 仍失败：146 项；去掉行号后的诊断多重集与本轮前完全一致，无新增错误。`npm test` 的 pretest 门仍未修复，不能写成 npm test 通过 |

首次默认并发跑套件时，同时在做 Swift 编译检查，既有 `helper-install.test.ts` 的 15 秒子进程截止触发，出现 1 项失败。检查后无该安装测试进程残留；未改测试或延长时限。该测试单独运行约 1.15 秒通过，完整串行套件也通过。资源争用是推测，不写成已证明的根因。

独立只读审查发现并修正了 AXOpen 错误继承 pid 投递标记、测试未提供真实请求上下文两项问题；上述完整串行套件和最终 Swift 编译检查均在修正后执行。

## 审核后的下一步

维护者先审核本轮提交。获准后才使用产品原本身份和同一证书，在新的独立 checkout、HOME、helper/broker socket 下重建协议 10 测试版。用户再授权一次新的 Finder AXOpen 测试，记录授权卡片、目录回读和前台干扰；不得把本轮代码或离线测试当作该真机结果，也不得补发旧 unknown 操作。
