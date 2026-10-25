export type RuleId = "repeat-after-error" | "ended-after-tool-error" | "ended-on-provider-error" | "schema-errors" | "oversized-tool-result" | "harness-fault";
export type FindingStatus = "hit" | "clear" | "unknown";
export type FindingStatuses = Record<RuleId, FindingStatus>;
export interface Finding {
	rule: RuleId;
	status: FindingStatus;
	count: number;
	evidence: Array<Record<string, string | number | undefined>>;
}
export interface SessionEntry {
	id: string;
	type: string;
	message?: {
		role: string;
		content?: string | ReadonlyArray<{ type: string; [key: string]: unknown }>;
		stopReason?: string;
		toolCallId?: string;
		isError?: boolean;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}
export const RULE_IDS: readonly RuleId[];
export const SCHEMA_ERROR_THRESHOLD: number;
export const TOOL_RESULT_BYTE_THRESHOLD: number;
/** Keys are SHA-256 tool-call IDs; values contain completed-span attributes. */
export function evaluateSession(input: {
	branch: readonly SessionEntry[];
	traceTools: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
	traceStatus: "ok" | "partial" | "missing";
}): Finding[];
