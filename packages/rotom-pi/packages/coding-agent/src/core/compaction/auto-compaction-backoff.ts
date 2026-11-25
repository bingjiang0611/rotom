/**
 * Backoff for automatic threshold compaction after a failure.
 *
 * A failed compaction leaves the history unchanged, so the next assistant message still crosses
 * the threshold and used to start another summary request a few seconds later. With a summary
 * model whose gateway dropped long uncached requests after about 48 seconds, one session retried
 * 33 times in 47.6 minutes and kept the user waiting for each attempt. After a failure, threshold
 * compaction now waits 1, 2, 4, 8 and then at most 15 minutes before trying again; a success of
 * any kind clears the wait. Overflow recovery never consults it: without compaction that turn
 * cannot continue, so it must still try.
 */
export const AUTO_COMPACTION_BACKOFF_BASE_MS = 60_000;
export const AUTO_COMPACTION_BACKOFF_MAX_MS = 15 * 60_000;

export class AutoCompactionBackoff {
	private failures = 0;
	private retryAt = 0;

	private readonly now: () => number;

	/** `now` is read on every call so fake timers in tests move it. */
	constructor(now: () => number = () => Date.now()) {
		this.now = now;
	}

	/** Whether a threshold compaction may start now. */
	allowsThreshold(): boolean {
		return this.failures === 0 || this.now() >= this.retryAt;
	}

	/** Records a failed compaction and returns how long threshold compaction now waits. */
	recordFailure(): number {
		this.failures++;
		const delay = Math.min(
			AUTO_COMPACTION_BACKOFF_BASE_MS * 2 ** (this.failures - 1),
			AUTO_COMPACTION_BACKOFF_MAX_MS,
		);
		this.retryAt = this.now() + delay;
		return delay;
	}

	/** Any successful compaction ends the backoff. */
	recordSuccess(): void {
		this.failures = 0;
		this.retryAt = 0;
	}
}
