// Two-level request locking inside one relay session.
//
// Structural operations (open/claim/close/tabs/switch/transfer/handoff/recover/
// hello) change what a session owns, so they take the session lock exclusively.
// Every other operation is scoped to one tab: it takes the session lock for
// reading — which keeps its tab alive for the whole operation, because a
// structural request cannot start until readers finish — and then the lock of
// that single tab, so two different tabs really do run at the same time while
// two requests on one tab stay ordered.
//
// The reader/writer queue is FIFO: a queued structural request blocks later
// readers instead of waiting for an unbounded stream of them.

export const SESSION_SCOPED_OPERATIONS_V1 = Object.freeze([
	"hello",
	"open",
	"claim",
	"close",
	"tabs",
	"switch",
	"transfer",
	"handoff",
	"recover",
]);

export function isSessionScopedOperationV1(operation) {
	return SESSION_SCOPED_OPERATIONS_V1.includes(operation);
}

/** Lock key for a tab-scoped operation: the named tab, else the current one. */
export function tabLockKeyV1(payload, currentTabName) {
	const named = payload?.tabName;
	if (typeof named === "string" && named.length > 0) return named;
	return typeof currentTabName === "string" ? currentTabName : "";
}

export function createSessionLockV1() {
	let readers = 0;
	let writing = false;
	const queue = [];
	const grantNext = () => {
		while (queue.length > 0) {
			if (queue[0].kind === "write") {
				if (readers > 0 || writing) return;
				writing = true;
				queue.shift().grant();
				return;
			}
			if (writing) return;
			// Grant the whole leading run of readers at once so they overlap.
			while (queue.length > 0 && queue[0].kind === "read") {
				readers += 1;
				queue.shift().grant();
			}
			return;
		}
	};
	const acquire = (kind) => new Promise((grant) => { queue.push({ kind, grant }); grantNext(); });
	return {
		async read(task) {
			await acquire("read");
			try { return await task(); }
			finally { readers -= 1; grantNext(); }
		},
		async write(task) {
			await acquire("write");
			try { return await task(); }
			finally { writing = false; grantNext(); }
		},
		// Observability for tests; not a capability.
		counts: () => ({ readers, writing, waiting: queue.length }),
	};
}

export function createTabLocksV1() {
	const chains = new Map();
	return {
		run(key, task) {
			const previous = chains.get(key) ?? Promise.resolve();
			const result = previous.then(() => task());
			const settled = result.then(() => undefined, () => undefined);
			chains.set(key, settled);
			settled.then(() => { if (chains.get(key) === settled) chains.delete(key); });
			return result;
		},
		size: () => chains.size,
	};
}
