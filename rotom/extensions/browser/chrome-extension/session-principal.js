export const DEFAULT_AGENT_ID = "main";
const MAX_AGENT_ID_CHARS = 128;
const MAX_SESSION_ID_CHARS = 512;
const MAX_LEASE_TOKEN_CHARS = 512;

// Printable non-space ASCII only: these values end up in tab-group titles, transfer
// names and logs, so control characters and whitespace are rejected instead of escaped.
function principalToken(value, name, max) {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length < 1 || value.length > max || !/^[\x21-\x7e]+$/u.test(value)) throw new Error(`${name} invalid`);
	return value;
}

/**
 * Effective browser principal for a hello payload. A client that predates principals
 * sends none of these fields and is treated as the main agent of its own root session.
 */
export function sessionPrincipalFromHello(payload, sessionId) {
	const agentId = principalToken(payload?.agentId, "agentId", MAX_AGENT_ID_CHARS) ?? DEFAULT_AGENT_ID;
	const rootSessionId = principalToken(payload?.rootSessionId, "rootSessionId", MAX_SESSION_ID_CHARS) ?? sessionId;
	const leaseToken = principalToken(payload?.leaseToken, "leaseToken", MAX_LEASE_TOKEN_CHARS);
	return { agentId, rootSessionId, ...(leaseToken === undefined ? {} : { leaseToken }) };
}

/**
 * Principal of a session restored from `chrome.storage.session`. Unreadable fields fall
 * back to the main-agent default instead of dropping the session's ownership.
 */
export function restoredSessionPrincipal(stored, sessionId) {
	try {
		return sessionPrincipalFromHello(stored, sessionId);
	} catch {
		return sessionPrincipalFromHello({}, sessionId);
	}
}

/** Reads-only identity report; `agentId` is what a `tabs` result exposes. */
export function sessionPrincipalValue(state) {
	return {
		agentId: typeof state?.agentId === "string" ? state.agentId : DEFAULT_AGENT_ID,
		rootSessionId: typeof state?.rootSessionId === "string" ? state.rootSessionId : state?.sessionId,
	};
}

export function isMainAgentPrincipal(state) {
	return sessionPrincipalValue(state).agentId === DEFAULT_AGENT_ID;
}
