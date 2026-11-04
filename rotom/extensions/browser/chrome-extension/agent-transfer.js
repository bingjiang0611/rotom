// Cross-agent tab transfer inside one relay root session.
//
// A subagent may hand a tab it owns to another agent of the same root session.
// The receiver gets a fresh tab name, a new documentGeneration and a new
// observationEpoch, so every ref and screenshot coordinate minted by the
// previous owner stops working instead of silently addressing the same node.
import { invalidateCoordinateObservation } from "./coordinate-click.js";

export const MAX_TAB_NAME_CHARS = 64;
const TAB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/u;
const AGENT_ID_PATTERN = /^[\x21-\x7e]{1,128}$/u;

function printable(value) {
	return typeof value === "string" && AGENT_ID_PATTERN.test(value);
}

/**
 * Pick the single relay session that `toAgentId` names inside one root session.
 * Ambiguity is rejected: guessing which connection should receive the tab would
 * let the wrong process act on it.
 */
export function transferTargetSessionV1(sessions, { rootSessionId, toAgentId }) {
	if (!printable(toAgentId)) throw new Error("toAgentId invalid");
	const candidates = [...sessions].filter((state) => state.rootSessionId === rootSessionId && state.agentId === toAgentId);
	if (candidates.length === 0) throw new Error(`no relay session for agent ${toAgentId} in this root session`);
	if (candidates.length > 1) throw new Error(`multiple relay sessions report agent ${toAgentId}; keep one connection per agent`);
	return candidates[0];
}

/** Receiver-side name for a transferred tab: `<original>@<source agent id>`. */
export function transferredTabNameV1(name, fromAgentId) {
	if (typeof name !== "string" || !TAB_NAME_PATTERN.test(name)) throw new Error("tabName format invalid");
	if (!printable(fromAgentId)) throw new Error("source agent invalid");
	const next = `${name}@${fromAgentId}`;
	if (next.length > MAX_TAB_NAME_CHARS) throw new Error(`transferred tab name is ${next.length} chars; keep the source tabName under ${MAX_TAB_NAME_CHARS - fromAgentId.length - 1} chars`);
	return next;
}

/** `<name>@<agentId>`, with a numeric suffix when the receiver already uses it. */
export function uniqueTransferredNameV1(taken, name, fromAgentId) {
	const base = transferredTabNameV1(name, fromAgentId);
	if (typeof taken?.has !== "function" || !taken.has(base)) return base;
	for (let attempt = 2; attempt <= 9; attempt += 1) {
		const candidate = `${base}-${attempt}`;
		if (candidate.length > MAX_TAB_NAME_CHARS) break;
		if (!taken.has(candidate)) return candidate;
	}
	throw new Error("no free transferred tab name");
}

/** Invalidate everything the previous owner minted against this tab. */
export function resetTransferredItemV1(item) {
	item.documentGeneration = Number.isSafeInteger(item.documentGeneration) && item.documentGeneration > 0 ? item.documentGeneration + 1 : 2;
	invalidateCoordinateObservation(item);
	return item;
}
