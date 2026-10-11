const SHORT_OPERATION_DEADLINE_MS = 4_000;
const DEFAULT_OPERATION_DEADLINE_MS = 20_000;
const INTERACTION_OPERATION_DEADLINE_MS = 6_000;
const RECOVER_OPERATION_DEADLINE_MS = 8_000;
const FULL_READ_OPERATION_DEADLINE_MS = 25_000;
/** Bound for one cleanup step after a timeout (a debugger detach or a state write). */
export const RELAY_SETTLE_MS = 1_000;
// A timed-out operation answers only after its cleanup: detaches run in parallel, then
// state is persisted, so the cleanup takes at most two settle steps.
const TIMEOUT_CLEANUP_MS = 2 * RELAY_SETTLE_MS;
// Native messaging and socket hops between the extension and the Pi client.
const CLIENT_TRANSPORT_MARGIN_MS = 1_000;

export function relayOperationDeadlineMs(operation, payload) {
	if (operation === "hello") return 2_000;
	if (["discover", "tabs", "close", "handoff"].includes(operation)) return SHORT_OPERATION_DEADLINE_MS;
	if (operation === "interact") return INTERACTION_OPERATION_DEADLINE_MS;
	if (operation === "recover") return RECOVER_OPERATION_DEADLINE_MS;
	if (operation === "read_full") return FULL_READ_OPERATION_DEADLINE_MS;
	if (operation === "wait") {
		const requested = Number.isInteger(payload?.timeoutMs) && payload.timeoutMs >= 0 && payload.timeoutMs <= 300_000 ? payload.timeoutMs : 30_000;
		return requested + 500;
	}
	return DEFAULT_OPERATION_DEADLINE_MS;
}

/**
 * Client-side timeout for an operation. It must outlast the extension deadline plus the
 * timeout cleanup: otherwise the client gives up first, drops the connection, and the
 * extension's own bounded "operation timeout" error never arrives. The dropped connection
 * also queues a cleanup of every owned tab, which slows the calls that follow.
 */
export function relayClientTimeoutMs(operation, payload) {
	return relayOperationDeadlineMs(operation, payload) + TIMEOUT_CLEANUP_MS + CLIENT_TRANSPORT_MARGIN_MS;
}

export async function runWithRelayDeadline(operation, promise, onTimeout, deadlineMs) {
	let timer;
	let timedOut = false;
	promise.catch(() => undefined);
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => {
					timedOut = true;
					reject(new Error(`browser relay ${operation} operation timeout`));
				}, deadlineMs);
			}),
		]);
	} catch (error) {
		if (timedOut) await onTimeout();
		throw error;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export async function valueWithinRelayDeadline(promise, deadlineMs) {
	const timedOut = Symbol("relay-timeout");
	const failed = Symbol("relay-failed");
	let timer;
	try {
		const result = await Promise.race([
			promise.catch(() => failed),
			new Promise((resolve) => { timer = setTimeout(() => resolve(timedOut), deadlineMs); }),
		]);
		return result === timedOut || result === failed ? { ok: false } : { ok: true, value: result };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
