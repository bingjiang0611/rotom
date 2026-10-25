import { createHash } from "node:crypto";

export const SCHEMA_ERROR_THRESHOLD = 2;
export const TOOL_RESULT_BYTE_THRESHOLD = 50_000;
export const RULE_IDS = Object.freeze([
	"repeat-after-error", "ended-after-tool-error", "ended-on-provider-error",
	"schema-errors", "oversized-tool-result", "harness-fault",
]);

function result(rule, evidence, incomplete = false, threshold = 1) {
	return { rule, status: evidence.length >= threshold ? "hit" : incomplete ? "unknown" : "clear", count: evidence.length, evidence };
}

function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function repeatAfterError(calls, results, incomplete) {
	if (incomplete) return result("repeat-after-error", [], true);
	const evidence = [];
	for (let index = 0; index + 1 < calls.length; index++) {
		const previous = calls[index];
		const next = calls[index + 1];
		if (typeof previous.call.name !== "string" || typeof next.call.name !== "string") { incomplete = true; continue; }
		if (previous.call.name !== next.call.name) continue;
		if (previous.call.arguments === undefined || next.call.arguments === undefined) { incomplete = true; continue; }
		if (canonicalJson(previous.call.arguments) !== canonicalJson(next.call.arguments)) continue;
		const outcome = results.get(previous.call.id);
		if (!outcome || typeof outcome.message.isError !== "boolean") { incomplete = true; continue; }
		if (outcome.message.isError) {
			evidence.push({ entryId: previous.entryId, nextEntryId: next.entryId, resultEntryId: outcome.entryId, tool: previous.call.name });
		}
	}
	return result("repeat-after-error", evidence, incomplete);
}

function endedOnProviderError(messages, incomplete) {
	const last = messages.findLast(({ message }) => message.role === "assistant");
	if (incomplete || !last || typeof last.message.stopReason !== "string") return result("ended-on-provider-error", [], true);
	const stopReason = last.message.stopReason;
	const laterUser = messages.some(({ message, index }) => message.role === "user" && index > last.index);
	const hit = stopReason === "error" || (stopReason === "aborted" && !laterUser);
	return result("ended-on-provider-error", hit ? [{ entryId: last.entryId, stopReason }] : [], incomplete);
}

function endedAfterToolError(calls, messages, traceTools, traceStatus, incomplete) {
	if (incomplete || traceStatus === "missing") return result("ended-after-tool-error", [], true);
	const lastCall = calls.at(-1);
	if (!lastCall) return result("ended-after-tool-error", [], incomplete || traceStatus !== "ok");
	const attributes = toolAttributes(lastCall, traceTools);
	const outcome = attributes?.["pi.tool.outcome"];
	const last = messages.findLast(({ message }) => message.role === "assistant");
	if (typeof outcome !== "string" || !last || last.index <= lastCall.index || typeof last.message.stopReason !== "string") {
		return result("ended-after-tool-error", [], true);
	}
	const hit = outcome !== "ok" && last.message.stopReason === "stop";
	return result("ended-after-tool-error", hit ? [{ entryId: lastCall.entryId, tool: lastCall.call.name, outcome, finalEntryId: last.entryId }] : [], incomplete);
}

function toolAttributes(item, traceTools) {
	if (typeof item.call.id !== "string") return undefined;
	return traceTools.get(createHash("sha256").update(item.call.id).digest("hex"));
}

function traceRule(rule, calls, traceTools, traceStatus, attribute, matches, threshold, incomplete) {
	const evidence = [];
	if (traceStatus === "missing") return result(rule, evidence, true, threshold);
	incomplete ||= traceStatus !== "ok";
	for (const item of calls) {
		const attributes = toolAttributes(item, traceTools);
		const value = attributes?.[attribute];
		// classifyFaultSide deliberately omits fault_side for completed ok/aborted
		// outcomes: that is evidence of no harness fault, not a missing attribute.
		// unknown_outcome and incomplete spans do not carry the same guarantee.
		if (attribute === "pi.tool.fault_side" && value === undefined && ["ok", "aborted"].includes(attributes?.["pi.tool.outcome"])) continue;
		const valid = attribute === "pi.tool.result_text_bytes" ? Number.isFinite(value) && value >= 0 : typeof value === "string";
		if (!valid) { incomplete = true; continue; }
		if (matches(value)) {
			evidence.push({ entryId: item.entryId, tool: item.call.name, [attribute]: value });
		}
	}
	return result(rule, evidence, incomplete, threshold);
}

/** Evaluate only the supplied branch. traceTools maps SHA-256(call id) to merged
 * completed-span attributes; missing/unfinished spans have no usable attributes.
 * Evidence contains metadata only. Trace hits can survive unrelated gaps;
 * sequence/end-of-branch rules require complete ordering information. */
export function evaluateSession({ branch, traceTools, traceStatus }) {
	const messages = [];
	const calls = [];
	const results = new Map();
	let incomplete = branch.length === 0 || typeof branch[0]?.parentId === "string";
	for (const [index, entry] of branch.entries()) {
		if (entry.type !== "message") continue;
		if (!entry.message) { incomplete = true; continue; }
		const item = { entryId: entry.id, index, message: entry.message };
		messages.push(item);
		if (item.message.role === "toolResult") results.set(item.message.toolCallId, item);
		if (item.message.role !== "assistant") continue;
		if (!Array.isArray(item.message.content)) { incomplete = true; continue; }
		for (const call of item.message.content) {
			if (call.type === "toolCall") calls.push({ call, entryId: entry.id, index });
		}
	}
	return [
		repeatAfterError(calls, results, incomplete),
		endedAfterToolError(calls, messages, traceTools, traceStatus, incomplete),
		endedOnProviderError(messages, incomplete),
		traceRule("schema-errors", calls, traceTools, traceStatus, "pi.tool.outcome", (value) => value === "schema", SCHEMA_ERROR_THRESHOLD, incomplete),
		traceRule("oversized-tool-result", calls, traceTools, traceStatus, "pi.tool.result_text_bytes", (value) => value > TOOL_RESULT_BYTE_THRESHOLD, 1, incomplete),
		traceRule("harness-fault", calls, traceTools, traceStatus, "pi.tool.fault_side", (value) => value === "harness", 1, incomplete),
	];
}
