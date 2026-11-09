/**
 * Product timeout policy for the `subagent_wait` tool.
 *
 * A blocking wait holds the parent turn. Sessions showed a 20% wait error rate, p90 at the
 * old 30-minute default and identical re-waits after a timeout, while completions already
 * wake the session on their own. The tool therefore makes blocking waits short by default
 * and bounded. A non-blocking subscription does not hold the turn: its timeout is a wake
 * deadline, so it keeps the caller's value and the core default.
 */
export const DEFAULT_BLOCKING_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_BLOCKING_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

export const WAIT_TIMEOUT_DESCRIPTION =
	"Give up waiting after this many milliseconds (the runs keep going regardless). Blocking waits default to 600000 (10 minutes) and are capped at 900000 (15 minutes); completions wake the session without a wait. nonBlocking subscriptions default to 1800000.";

export function applyWaitTimeoutPolicy<T extends { nonBlocking?: boolean; timeoutMs?: number }>(params: T): T {
	if (params.nonBlocking) return params;
	const requested = typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_BLOCKING_WAIT_TIMEOUT_MS;
	return { ...params, timeoutMs: Math.min(requested, MAX_BLOCKING_WAIT_TIMEOUT_MS) };
}

/** Replace only the timeout description; validation stays the component schema's. */
export function withWaitTimeoutDescription<T>(parameters: T): T {
	const schema = parameters as { properties?: Record<string, unknown> };
	const timeout = schema.properties?.timeoutMs;
	if (!timeout || typeof timeout !== "object") return parameters;
	return { ...schema, properties: { ...schema.properties, timeoutMs: { ...timeout, description: WAIT_TIMEOUT_DESCRIPTION } } } as T;
}
