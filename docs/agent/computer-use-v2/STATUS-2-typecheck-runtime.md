# 阶段 2 类型诊断附录：实现

这是 [原始阶段 2 报告](STATUS-2-typecheck.md) 的历史诊断，不代表当前版本。只按路径分组，诊断正文不变。

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
```
