/**
 * The one clock contract for user activity (review E1).
 *
 * The helper's event tap reports when the user last touched the machine, and the
 * broker subtracts that value from `Date.now()` to decide whether a foreground
 * takeover is allowed. The two sides used to disagree about the unit, which made
 * "the user just typed" read as idle for fifty thousand years, so the wire format
 * is milliseconds and anything else is refused instead of stored.
 */
const MAX_AGE_MS = 86_400_000;
const MAX_SKEW_MS = 60_000;

export type ActivityReport = { ok: true; value: number } | { ok: false };

/** Accept only a plausible millisecond timestamp; `undefined` means "not reported". */
export function parseUserActivityReport(reported: unknown, now: number): ActivityReport {
	if (reported === undefined) return { ok: false };
	if (typeof reported !== "number" || !Number.isFinite(reported)) return { ok: false };
	if (reported < now - MAX_AGE_MS || reported > now + MAX_SKEW_MS) return { ok: false };
	return { ok: true, value: reported };
}
