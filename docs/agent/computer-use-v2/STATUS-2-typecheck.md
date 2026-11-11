# Computer Use v2.1：T1 类型检查恢复

> 本页保留该轮历史记录。当前 S2 已恢复完整类型门禁，见 [HANDOFF-6 阶段 1](STATUS-3-typecheck.md)；此前 O1/S2 的分段实现见 [打开目标确认与测试闸门](STATUS-2-open-target-guard.md)。

## 范围与环境

- 基于 `cbfac06`（含 `024d058` 的 observe_ui 修复），按 REVIEW-16 执行。
- 仅代码和离线测试；独立开发 checkout 复用测试 checkout 的产品依赖副本，安装开发依赖时使用 `--ignore-scripts`。没有改活跃安装、重建/重启 helper 或调用桌面工具。
- Node `24.18.0`、TypeScript `7.0.2`、`@types/node 26.6.6`。
- 新增包级 `tsconfig.json`：NodeNext ESM、ES2024、strict、noEmit、allowImportingTsExtensions。包含 `src/**/*.ts`、`extensions/**/*.ts`、`test/**/*.ts`；不声称检查了原生代码或所有 JavaScript 脚本。
- Pi peers 与 TypeBox 的声明从 checkout 的产品安装目录解析；开发依赖仍按本包 package.json 安装。检查产品声明使用 skipLibCheck，不屏蔽本包错误。

## 本轮修复

1. 默认 scheduler 的运行时值是对象，BrokerCore 与 LeaseManager 却按函数调用。统一成与调用方、fake clock 一致的函数合同；保留取消与 unref 行为。
2. 删除无调用方的 `ClientLeaseBroker.reportPreempted`：它转发到已不存在的 `BrokerClient.reportPreempted`。不恢复旧的用户输入即结束接管协议，也不改变现有暂停/恢复路径。
3. `pretest: npm run typecheck` 接入 npm 测试闸门。没有错误码白名单、忽略退出码或放宽 strict；残余错误清零前，`npm test` 会在执行测试体前失败。冻结前必须运行该闸门，当前不是可冻结的全绿状态。

## 验证

| 检查 | 结果 |
| --- | --- |
| 默认 scheduler 新回归（修复前） | 2/2 失败，分别为 realSchedule / this.schedule is not a function |
| scheduler、broker-core、broker-approval、outline-render、outline-secure focused tests | 20/20 通过；直接 node 执行，仅证明这些测试，不冒充 npm test 闸门通过 |
| typecheck 负对照 | 在独立开发副本临时移除 displayName 导入，确实报 TS2304；随后恢复，未变更该已审核修复 |
| npm run typecheck -- --pretty false | 非零退出；157 项降至 147 项 |
| 名字/模块/导出不存在及不可调用错误 | 当前 TS 程序中为 0；TS7016 是已有 .mjs 缺声明，不是模块文件不存在 |
| npm test | pretest 实际执行 tsc，147 项错误使闸门拒绝，未执行测试体 |

复现 focused tests（在 `packages/rotom-computer-use/`）：

```sh
node --test --experimental-strip-types test/broker-real-schedule.test.ts test/broker-core.test.ts test/broker-approval.test.ts test/outline-render.test.ts test/outline-secure.test.ts
npm run typecheck -- --pretty false
npm test
```

## 剩余类型错误（本轮不修）

以下是本轮环境下完整的 147 项诊断清单。错误码按编译器原值汇总，不将类型错误都等同于运行时故障。
后续由维护者/审核者分轮处理，并重新运行完整 typecheck；本轮不加 any、ts-ignore 或排除文件来消除它们。

| 错误码 | 数量 |
| --- | ---: |
| TS18046 | 21 |
| TS18048 | 1 |
| TS2322 | 3 |
| TS2339 | 4 |
| TS2353 | 64 |
| TS2365 | 2 |
| TS2366 | 1 |
| TS7005 | 4 |
| TS7006 | 21 |
| TS7016 | 16 |
| TS7019 | 1 |
| TS7031 | 6 |
| TS7034 | 3 |
| 合计 | 147 |

```text
src/actions.ts(114,94): error TS2366: Function lacks ending return statement and return type does not include 'undefined'.
src/actions.ts(129,3): error TS2322: Type '{ action: UiActionName; target: ActionTarget; params: Record<string, unknown>; establishesFocus: false; usesCurrentFocus: false; needsForeground: false; }' is not assignable to type 'PreparedAction'.
  Type '{ action: UiActionName; target: ActionTarget; params: Record<string, unknown>; establishesFocus: false; usesCurrentFocus: false; needsForeground: false; }' is not assignable to type '{ action: "click" | "press"; target: ActionTarget; params: { button?: MouseButtonName | undefined; clickCount?: number | undefined; }; establishesFocus: boolean; usesCurrentFocus: false; needsForeground: boolean; } | ... 7 more ... | { ...; }'.
    Type '{ action: UiActionName; target: ActionTarget; params: Record<string, unknown>; establishesFocus: false; usesCurrentFocus: false; needsForeground: false; }' is not assignable to type '{ action: "clear" | "collapse" | "expand" | "focus" | "scrollTo" | "select" | "setChecked" | "setValue" | "showMenu"; target: ActionTarget; params: Record<string, unknown>; establishesFocus: false; usesCurrentFocus: false; needsForeground: false; }'.
      Types of property 'action' are incompatible.
        Type 'UiActionName' is not assignable to type '"clear" | "collapse" | "expand" | "focus" | "scrollTo" | "select" | "setChecked" | "setValue" | "showMenu"'.
          Type '"click"' is not assignable to type '"clear" | "collapse" | "expand" | "focus" | "scrollTo" | "select" | "setChecked" | "setValue" | "showMenu"'.
src/bridge.ts(1385,48): error TS18046: 'action.params.text' is of type 'unknown'.
src/bridge.ts(2530,4): error TS2322: Type '"approval_denied" | "approval_unavailable" | "broker_unavailable" | "denied" | "paused_interfered" | "preempted_by_user" | "resource_busy" | "stopped_by_user" | "takeover_conditions"' is not assignable to type '"approval_denied" | "approval_unavailable" | "broker_unavailable" | "denied" | "resource_busy" | "stopped_by_user"'.
  Type '"paused_interfered"' is not assignable to type '"approval_denied" | "approval_unavailable" | "broker_unavailable" | "denied" | "resource_busy" | "stopped_by_user"'.
src/broker/client.ts(174,53): error TS2353: Object literal may only specify known properties, and 'leaseId' does not exist in type 'Omit<BrokerRequest, "id">'.
src/broker/client.ts(179,40): error TS2353: Object literal may only specify known properties, and 'leaseId' does not exist in type 'Omit<BrokerRequest, "id">'.
src/broker/client.ts(183,56): error TS2353: Object literal may only specify known properties, and 'leaseId' does not exist in type 'Omit<BrokerRequest, "id">'.
src/broker/client.ts(188,47): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
src/broker/client.ts(196,46): error TS2353: Object literal may only specify known properties, and 'targetAgentId' does not exist in type 'Omit<BrokerRequest, "id">'.
src/broker/client.ts(206,54): error TS2353: Object literal may only specify known properties, and 'evidence' does not exist in type 'Omit<BrokerRequest, "id">'.
src/broker/client.ts(211,48): error TS2353: Object literal may only specify known properties, and 'targetAgentId' does not exist in type 'Omit<BrokerRequest, "id">'.
src/broker/client.ts(215,48): error TS2353: Object literal may only specify known properties, and 'op' does not exist in type 'Omit<BrokerRequest, "id">'.
src/broker/server.ts(195,24): error TS2353: Object literal may only specify known properties, and 'id' does not exist in type '{ ok: true; type: "release_on_yield"; }'.
src/broker/takeover-lifecycle.ts(1,39): error TS7016: Could not find a declaration file for module '../policy/global-input-quiet.mjs'. '<checkout>/packages/rotom-computer-use/src/policy/global-input-quiet.mjs' implicitly has an 'any' type.
src/platform/macos/backend.ts(167,8): error TS2353: Object literal may only specify known properties, and 'takeoverBegin' does not exist in type 'Pick<ComputerUsePlatformBackend, "act" | "actBatch" | "clipboardClear" | "clipboardGet" | "clipboardRestore" | "clipboardSet" | "clipboardSnapshot" | ... 10 more ... | "waitFor">'.
src/policy/gate.ts(80,3): error TS2353: Object literal may only specify known properties, and 'allowForeground' does not exist in type 'PolicyGate'.
src/tools/clipboard.ts(72,2): error TS2322: Type 'number | Timeout' is not assignable to type 'Timeout | undefined'.
  Type 'number' is not assignable to type 'Timeout'.
src/tools/clipboard.ts(85,2): error TS18048: 'clipboardRestoreTimer' is possibly 'undefined'.
src/trace/recorder.ts(331,20): error TS2365: Operator '-' cannot be applied to types 'number | bigint' and 'number | bigint'.
src/trace/recorder.ts(386,3): error TS2365: Operator '+=' cannot be applied to types 'number' and 'number | bigint'.
test/act-request.test.ts(4,67): error TS7016: Could not find a declaration file for module '../scripts/lib/l2-direct.mjs'. '<checkout>/packages/rotom-computer-use/scripts/lib/l2-direct.mjs' implicitly has an 'any' type.
test/b-window-contract.test.ts(24,8): error TS7016: Could not find a declaration file for module '../scripts/lib/b-window.mjs'. '<checkout>/packages/rotom-computer-use/scripts/lib/b-window.mjs' implicitly has an 'any' type.
test/b-window-contract.test.ts(125,74): error TS18046: 'contract' is of type 'unknown'.
test/b-window-contract.test.ts(128,40): error TS7006: Parameter 'row' implicitly has an 'any' type.
test/b-window-contract.test.ts(130,40): error TS7006: Parameter 'row' implicitly has an 'any' type.
test/b-window-contract.test.ts(131,40): error TS7006: Parameter 'row' implicitly has an 'any' type.
test/b-window-contract.test.ts(133,35): error TS7006: Parameter 'row' implicitly has an 'any' type.
test/b-window.test.ts(36,8): error TS7016: Could not find a declaration file for module '../scripts/lib/b-window.mjs'. '<checkout>/packages/rotom-computer-use/scripts/lib/b-window.mjs' implicitly has an 'any' type.
test/b-window.test.ts(42,77): error TS7006: Parameter 'sha' implicitly has an 'any' type.
test/b-window.test.ts(43,10): error TS7006: Parameter 'command' implicitly has an 'any' type.
test/b-window.test.ts(43,19): error TS7006: Parameter 'args' implicitly has an 'any' type.
test/b-window.test.ts(60,18): error TS7006: Parameter 'runsDir' implicitly has an 'any' type.
test/b-window.test.ts(60,27): error TS7006: Parameter 'name' implicitly has an 'any' type.
test/b-window.test.ts(60,35): error TS7031: Binding element 'step' implicitly has an 'any' type.
test/b-window.test.ts(60,41): error TS7031: Binding element 'commit' implicitly has an 'any' type.
test/b-window.test.ts(60,49): error TS7031: Binding element 'verdict' implicitly has an 'any' type.
test/b-window.test.ts(67,15): error TS7019: Rest parameter 'args' implicitly has an 'any[]' type.
test/b-window.test.ts(78,130): error TS18046: 'error' is of type 'unknown'.
test/b-window.test.ts(82,152): error TS18046: 'error' is of type 'unknown'.
test/b-window.test.ts(87,145): error TS18046: 'error' is of type 'unknown'.
test/b-window.test.ts(92,145): error TS18046: 'error' is of type 'unknown'.
test/b-window.test.ts(108,120): error TS18046: 'error' is of type 'unknown'.
test/b-window.test.ts(109,115): error TS18046: 'error' is of type 'unknown'.
test/b-window.test.ts(110,168): error TS18046: 'error' is of type 'unknown'.
test/b-window.test.ts(111,127): error TS18046: 'error' is of type 'unknown'.
test/b-window.test.ts(153,150): error TS18046: 'error' is of type 'unknown'.
test/b-window.test.ts(194,150): error TS18046: 'error' is of type 'unknown'.
test/b-window.test.ts(208,155): error TS18046: 'error' is of type 'unknown'.
test/b-window.test.ts(228,150): error TS18046: 'error' is of type 'unknown'.
test/b-window.test.ts(235,86): error TS2339: Property 'includes' does not exist on type '{}'.
test/b-window.test.ts(244,128): error TS18046: 'error' is of type 'unknown'.
test/b-window.test.ts(268,161): error TS18046: 'error' is of type 'unknown'.
test/b-window.test.ts(269,121): error TS18046: 'error' is of type 'unknown'.
test/b-window.test.ts(282,116): error TS18046: 'error' is of type 'unknown'.
test/b-window.test.ts(283,135): error TS18046: 'error' is of type 'unknown'.
test/b-window.test.ts(284,124): error TS18046: 'error' is of type 'unknown'.
test/b-window.test.ts(288,9): error TS7034: Variable 'warned' implicitly has type 'any[]' in some locations where its type cannot be determined.
test/b-window.test.ts(289,80): error TS7006: Parameter 'message' implicitly has an 'any' type.
test/b-window.test.ts(290,16): error TS7005: Variable 'warned' implicitly has an 'any[]' type.
test/b-window.test.ts(292,124): error TS18046: 'error' is of type 'unknown'.
test/background-evidence.test.ts(4,42): error TS7016: Could not find a declaration file for module '../scripts/lib/background-evidence.mjs'. '<checkout>/packages/rotom-computer-use/scripts/lib/background-evidence.mjs' implicitly has an 'any' type.
test/broker-approval.test.ts(70,84): error TS2353: Object literal may only specify known properties, and 'requestId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-approval.test.ts(102,63): error TS2353: Object literal may only specify known properties, and 'requestId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-approval.test.ts(129,63): error TS2353: Object literal may only specify known properties, and 'requestId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-approval.test.ts(142,63): error TS2353: Object literal may only specify known properties, and 'requestId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-approval.test.ts(147,69): error TS2353: Object literal may only specify known properties, and 'op' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-approval.test.ts(161,4): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-core.test.ts(118,48): error TS2353: Object literal may only specify known properties, and 'leaseId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-core.test.ts(125,50): error TS2353: Object literal may only specify known properties, and 'leaseId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-core.test.ts(179,63): error TS2353: Object literal may only specify known properties, and 'leaseId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-core.test.ts(201,69): error TS2353: Object literal may only specify known properties, and 'leaseId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-core.test.ts(209,66): error TS2353: Object literal may only specify known properties, and 'leaseId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-core.test.ts(227,49): error TS2353: Object literal may only specify known properties, and 'leaseId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-core.test.ts(245,60): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-pause.test.ts(61,62): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-pause.test.ts(64,71): error TS2353: Object literal may only specify known properties, and 'evidence' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-pause.test.ts(69,65): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-pause.test.ts(75,61): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-pause.test.ts(89,62): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-pause.test.ts(100,67): error TS2353: Object literal may only specify known properties, and 'targetAgentId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-pause.test.ts(103,70): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-pause.test.ts(106,65): error TS2353: Object literal may only specify known properties, and 'targetAgentId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-pause.test.ts(110,65): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-pause.test.ts(119,64): error TS2353: Object literal may only specify known properties, and 'targetAgentId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-transfer.test.ts(83,73): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-transfer.test.ts(88,77): error TS2353: Object literal may only specify known properties, and 'leaseId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-transfer.test.ts(97,76): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-transfer.test.ts(105,3): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-transfer.test.ts(113,3): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-transfer.test.ts(114,66): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-transfer.test.ts(125,56): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-transfer.test.ts(128,73): error TS2353: Object literal may only specify known properties, and 'leaseId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-transfer.test.ts(132,74): error TS2353: Object literal may only specify known properties, and 'leaseId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-transfer.test.ts(140,56): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-transfer.test.ts(142,57): error TS2353: Object literal may only specify known properties, and 'leaseId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-transfer.test.ts(155,70): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-transfer.test.ts(163,56): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/broker-transfer.test.ts(165,57): error TS2353: Object literal may only specify known properties, and 'leaseId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/build-fixture.test.ts(12,81): error TS7016: Could not find a declaration file for module '../scripts/lib/fixture.mjs'. '<checkout>/packages/rotom-computer-use/scripts/lib/fixture.mjs' implicitly has an 'any' type.
test/cu-v2-tools.test.ts(61,30): error TS2339: Property 'checked' does not exist on type 'Record<string, unknown> | Record<string, never> | { button?: MouseButtonName | undefined; clickCount?: number | undefined; } | { text: string; } | { text: string; } | ... 4 more ... | { ...; }'.
  Property 'checked' does not exist on type '{ button?: MouseButtonName | undefined; clickCount?: number | undefined; }'.
test/event-sources.test.ts(20,8): error TS7016: Could not find a declaration file for module '../scripts/lib/event-sources.mjs'. '<checkout>/packages/rotom-computer-use/scripts/lib/event-sources.mjs' implicitly has an 'any' type.
test/event-sources.test.ts(32,59): error TS7006: Parameter 'pid' implicitly has an 'any' type.
test/event-sources.test.ts(36,30): error TS7006: Parameter 'group' implicitly has an 'any' type.
test/event-sources.test.ts(66,41): error TS7006: Parameter 'row' implicitly has an 'any' type.
test/event-sources.test.ts(101,21): error TS7031: Binding element 'records' implicitly has an 'any' type.
test/event-sources.test.ts(101,30): error TS7031: Binding element 'counted' implicitly has an 'any' type.
test/global-input-gate.test.ts(4,64): error TS7016: Could not find a declaration file for module '../scripts/lib/global-input-gate.mjs'. '<checkout>/packages/rotom-computer-use/scripts/lib/global-input-gate.mjs' implicitly has an 'any' type.
test/global-input-gate.test.ts(5,29): error TS7016: Could not find a declaration file for module '../scripts/lib/hid-click.mjs'. '<checkout>/packages/rotom-computer-use/scripts/lib/hid-click.mjs' implicitly has an 'any' type.
test/l2-env.test.ts(15,124): error TS7016: Could not find a declaration file for module '../scripts/lib/l2-env.mjs'. '<checkout>/packages/rotom-computer-use/scripts/lib/l2-env.mjs' implicitly has an 'any' type.
test/l2-env.test.ts(16,38): error TS7016: Could not find a declaration file for module '../scripts/lib/fixture.mjs'. '<checkout>/packages/rotom-computer-use/scripts/lib/fixture.mjs' implicitly has an 'any' type.
test/l2-modes.test.ts(12,93): error TS7016: Could not find a declaration file for module '../scripts/lib/l2-modes.mjs'. '<checkout>/packages/rotom-computer-use/scripts/lib/l2-modes.mjs' implicitly has an 'any' type.
test/l2-probe.test.ts(12,42): error TS7016: Could not find a declaration file for module '../scripts/lib/l2-probe.mjs'. '<checkout>/packages/rotom-computer-use/scripts/lib/l2-probe.mjs' implicitly has an 'any' type.
test/lease-token.test.ts(65,72): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/lease-token.test.ts(85,70): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/lease-token.test.ts(113,73): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/lease-token.test.ts(116,77): error TS2353: Object literal may only specify known properties, and 'leaseId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/lease-token.test.ts(172,72): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/lease-token.test.ts(198,72): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/live-helpers.test.ts(10,110): error TS7016: Could not find a declaration file for module '../scripts/lib/live-helpers.mjs'. '<checkout>/packages/rotom-computer-use/scripts/lib/live-helpers.mjs' implicitly has an 'any' type.
test/live-helpers.test.ts(13,8): error TS7034: Variable 'rows' implicitly has type 'any[]' in some locations where its type cannot be determined.
test/live-helpers.test.ts(14,11): error TS7005: Variable 'rows' implicitly has an 'any[]' type.
test/live-helpers.test.ts(14,26): error TS7006: Parameter 'area' implicitly has an 'any' type.
test/live-helpers.test.ts(14,32): error TS7006: Parameter 'action' implicitly has an 'any' type.
test/live-helpers.test.ts(14,40): error TS7006: Parameter 'result' implicitly has an 'any' type.
test/live-helpers.test.ts(14,48): error TS7006: Parameter 'note' implicitly has an 'any' type.
test/live-helpers.test.ts(36,97): error TS7006: Parameter 'key' implicitly has an 'any' type.
test/live-helpers.test.ts(58,8): error TS7034: Variable 'calls' implicitly has type 'any[]' in some locations where its type cannot be determined.
test/live-helpers.test.ts(60,23): error TS7031: Binding element 'pid' implicitly has an 'any' type.
test/live-helpers.test.ts(61,23): error TS7006: Parameter 'target' implicitly has an 'any' type.
test/live-helpers.test.ts(61,31): error TS7006: Parameter '_signal' implicitly has an 'any' type.
test/live-helpers.test.ts(61,40): error TS7006: Parameter 'lease' implicitly has an 'any' type.
test/live-helpers.test.ts(71,15): error TS7005: Variable 'calls' implicitly has an 'any[]' type.
test/live-helpers.test.ts(72,15): error TS7005: Variable 'calls' implicitly has an 'any[]' type.
test/recovery.test.ts(154,77): error TS2339: Property 'text' does not exist on type 'never'.
test/recovery.test.ts(156,69): error TS2339: Property 'text' does not exist on type 'never'.
test/run-owned-apps.test.ts(7,52): error TS7016: Could not find a declaration file for module '../scripts/lib/fixture.mjs'. '<checkout>/packages/rotom-computer-use/scripts/lib/fixture.mjs' implicitly has an 'any' type.
test/run-owned-apps.test.ts(8,75): error TS7016: Could not find a declaration file for module '../scripts/lib/run-owned-apps.mjs'. '<checkout>/packages/rotom-computer-use/scripts/lib/run-owned-apps.mjs' implicitly has an 'any' type.
test/takeover.test.ts(68,51): error TS2353: Object literal may only specify known properties, and 'lastUserInputAt' does not exist in type 'Omit<BrokerRequest, "id">'.
test/takeover.test.ts(72,54): error TS2353: Object literal may only specify known properties, and 'resourceKey' does not exist in type 'Omit<BrokerRequest, "id">'.
test/takeover.test.ts(85,69): error TS2353: Object literal may only specify known properties, and 'lastUserInputAt' does not exist in type 'Omit<BrokerRequest, "id">'.
test/takeover.test.ts(89,74): error TS2353: Object literal may only specify known properties, and 'lastUserInputAt' does not exist in type 'Omit<BrokerRequest, "id">'.
test/takeover.test.ts(133,55): error TS2353: Object literal may only specify known properties, and 'leaseId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/takeover.test.ts(149,52): error TS2353: Object literal may only specify known properties, and 'lastUserInputAt' does not exist in type 'Omit<BrokerRequest, "id">'.
test/takeover.test.ts(174,92): error TS2353: Object literal may only specify known properties, and 'takeoverId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/takeover.test.ts(179,67): error TS2353: Object literal may only specify known properties, and 'leaseId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/takeover.test.ts(182,69): error TS2353: Object literal may only specify known properties, and 'leaseId' does not exist in type 'Omit<BrokerRequest, "id">'.
test/takeover.test.ts(191,77): error TS2353: Object literal may only specify known properties, and 'phase' does not exist in type 'Omit<BrokerRequest, "id">'.
npm notice run @injaneity/pi-computer-use@0.5.1-rotom.2 typecheck
npm notice run tsc -p tsconfig.json --pretty false
```
