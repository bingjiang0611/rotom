/**
 * Per-resource global epoch.
 *
 * A resource is a physical input target (`desktop-pid:<pid>` or `cdp:<targetId>`).
 * The epoch is broker-owned, so two processes writing the same target cannot
 * both hold a "current" observation: the second write using an older epoch is
 * rejected as `stale`. Epochs live only in the broker process, so a broker
 * restart invalidates every observation taken before it, which is exactly the
 * recovery contract the bridge already implements for stale states.
 */
export class EpochRegistry {
	private readonly epochs = new Map<string, number>();

	current(resourceKey: string): number {
		return this.epochs.get(resourceKey) ?? 0;
	}

	/** Reserve the next epoch for an accepted write. */
	bump(resourceKey: string): number {
		const next = this.current(resourceKey) + 1;
		this.epochs.set(resourceKey, next);
		return next;
	}

	/**
	 * Check a caller's observation epoch.
	 *
	 * An omitted epoch means "first write from a fresh observation": it is
	 * accepted only while nobody else has written the resource yet, because any
	 * existing epoch means the caller's state may predate that write.
	 */
	validate(resourceKey: string, baseEpoch: number | undefined): { ok: true } | { ok: false; currentEpoch: number } {
		const currentEpoch = this.current(resourceKey);
		const expected = baseEpoch ?? 0;
		if (expected === currentEpoch) return { ok: true };
		return { ok: false, currentEpoch };
	}

	entries(): Array<{ resourceKey: string; epoch: number }> {
		return [...this.epochs].map(([resourceKey, epoch]) => ({ resourceKey, epoch }));
	}

	clear(): void {
		this.epochs.clear();
	}
}
