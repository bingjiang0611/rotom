/**
 * Deterministic clock for broker tests.
 *
 * `schedule` records timers instead of using the event loop, and `advance`
 * fires them in order while the simulated `now()` moves with them. That is what
 * lets TTL expiry, queue deadlines and heartbeat timeouts be tested without
 * sleeping.
 */
export interface FakeClock {
	now(): number;
	schedule(callback: () => void, ms: number): () => void;
	advance(ms: number): void;
	pendingTimers(): number;
}

export function createFakeClock(start = 1_000_000): FakeClock {
	let current = start;
	let sequence = 0;
	const timers: Array<{ at: number; id: number; callback: () => void; cancelled: boolean }> = [];

	return {
		now: () => current,
		schedule(callback, ms) {
			sequence += 1;
			const entry = { at: current + Math.max(0, ms), id: sequence, callback, cancelled: false };
			timers.push(entry);
			return () => {
				entry.cancelled = true;
			};
		},
		advance(ms) {
			const target = current + Math.max(0, ms);
			for (;;) {
				const due = timers
					.filter((timer) => !timer.cancelled && timer.at <= target)
					.sort((left, right) => left.at - right.at || left.id - right.id)[0];
				if (!due) break;
				timers.splice(timers.indexOf(due), 1);
				current = Math.max(current, due.at);
				due.callback();
			}
			current = target;
		},
		pendingTimers() {
			return timers.filter((timer) => !timer.cancelled).length;
		},
	};
}
