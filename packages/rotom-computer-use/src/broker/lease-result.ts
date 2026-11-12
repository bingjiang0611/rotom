import { brokerCopy } from "../constants/copy.ts";
import type { LeaseUnavailableError } from "../runtime.ts";

/** Structured refusal before the write callback (and any native input) starts. */
export function leaseConflictResult(tool: string, error: LeaseUnavailableError) {
	return {
		content: [{ type: "text" as const, text: brokerCopy.blocked(tool, error.message, error.code, error.holder) }],
		details: {
			tool,
			status: "lease_conflict" as const,
			dispatch: "not_started" as const,
			code: error.code,
			message: error.message,
			leaseHolder: error.holder ? { agentId: error.holder.agentId, remainingMs: error.holder.remainingMs } : undefined,
			retry: error.code === "resource_busy" ? "safe" as const : "never" as const,
		},
	};
}
