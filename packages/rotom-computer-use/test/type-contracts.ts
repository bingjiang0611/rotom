// Compile-only contract checks: included by pretest's tsconfig, never dispatched.
import { SEMANTIC_ACTION_NAMES, type SemanticActionName, type UiActionName } from "../src/contract.ts";
import type { BrokerRequestInput } from "../src/broker/protocol.ts";
import type { PlatformActRequest } from "../src/platform/types.ts";

const renew: BrokerRequestInput = { type: "renew", leaseId: "fixture" };
// @ts-expect-error A distributed request still requires the fields of its own variant.
const missingLease: BrokerRequestInput = { type: "renew" };
// @ts-expect-error The input is not a loose record accepting fields from any variant.
const wrongVariant: BrokerRequestInput = { type: "ping", leaseId: "fixture" };
// @ts-expect-error Approval must be a boolean, not a truthy string.
const openParams: Extract<PlatformActRequest, { action: "open" }>["params"] = { openApproved: "true" };

function semanticPartition(action: UiActionName): SemanticActionName | Exclude<UiActionName, SemanticActionName> {
	if (SEMANTIC_ACTION_NAMES.has(action)) {
		const semantic: SemanticActionName = action;
		return semantic;
	}
	const nonSemantic: Exclude<UiActionName, SemanticActionName> = action;
	return nonSemantic;
}

void [renew, missingLease, wrongVariant, openParams, semanticPartition];
