# 阶段 2 类型诊断附录：测试

这是 [原始阶段 2 报告](STATUS-2-typecheck.md) 的历史诊断，不代表当前版本。只按路径分组，诊断正文不变。

```text
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
