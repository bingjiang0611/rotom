const SHORT_OPERATION_DEADLINE_MS = 4_000;
const DEFAULT_OPERATION_DEADLINE_MS = 20_000;
const INTERACTION_OPERATION_DEADLINE_MS = 6_000;
const RECOVER_OPERATION_DEADLINE_MS = 8_000;
const FULL_READ_OPERATION_DEADLINE_MS = 25_000;

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
