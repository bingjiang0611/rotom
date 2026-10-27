// What a replay will cost, computed before it starts.
//
// A replay spends model calls on the truncated prefix of a session, so the
// person confirming it needs two numbers: how much context each point sends
// (characters, after redaction, across arms and repeats) and — for points that
// also ask a model to judge — how many credentials the judge input hides. The
// numbers are measured from the same redacted text the runner would send, never
// from the raw session, so nothing here reads or exposes a secret.
import { redactSecrets, redactionTotal } from "./redaction.mjs";

/** Matches the runner and the service: one to three repetitions. */
export const MAX_REPLAY_REPEATS = 3;

export function clampRepeats(value) {
	const number = Number(value);
	if (!Number.isSafeInteger(number)) return 1;
	return Math.min(Math.max(number, 1), MAX_REPLAY_REPEATS);
}

/** The judge sees the last few entries plus the expected behaviour, never the prefix. */
export const ORIGINAL_JUDGE_TAIL_ENTRIES = 6;
export const ORIGINAL_JUDGE_TAIL_CHARS = 6000;

/**
 * Measures selected replay points.
 *
 * @param items one row per point: `{ key, check, entries, expected }` where
 *   `entries` is the truncated prefix the runner generates from.
 * @param repeats repetitions per point, `arms` number of products compared.
 * @param original whether the original-reply control runs (it always does).
 */
export function measureReplayPlan({ items, repeats = 1, arms = 1, original = true }) {
	const count = clampRepeats(repeats), armCount = Number(arms) === 2 ? 2 : 1;
	const cases = [];
	const masked = new Map();
	let originalChars = 0;
	for (const item of items) {
		let chars = 0;
		for (const entry of item.entries ?? []) {
			const { text, redactions } = redactSecrets(JSON.stringify(entry?.message ?? entry));
			chars += text.length;
			// Redaction counts only matter where a model reads the text; the rule
			// check never leaves the machine.
			if (item.check?.mode !== "model") continue;
			for (const { type, count: hits } of redactions) masked.set(type, (masked.get(type) ?? 0) + hits);
		}
		// The original arm sends the judge input, not the session: a short tail of
		// entries plus the expected behaviour. Rule points send nothing.
		let judgeChars = 0;
		if (original && item.check?.mode === "model") {
			const tail = (item.entries ?? []).slice(-ORIGINAL_JUDGE_TAIL_ENTRIES).map((entry) => redactSecrets(JSON.stringify(entry?.message ?? entry)).text).join("\n");
			judgeChars = Math.min(tail.length, ORIGINAL_JUDGE_TAIL_CHARS) + (item.expected?.length ?? 0);
			originalChars += judgeChars;
		}
		cases.push({ key: item.key, chars, originalChars: judgeChars, runs: count * armCount + (original ? 1 : 0) });
	}
	const perCaseChars = cases.reduce((total, item) => total + item.chars, 0);
	const totalChars = perCaseChars * count * armCount + originalChars;
	const redactions = [...masked].sort(([left], [right]) => left.localeCompare(right)).map(([type, count]) => ({ type, count }));
	return {
		cases, runs: cases.length * (count * armCount + (original ? 1 : 0)), repeats: count, arms: armCount,
		perCaseChars, maxChars: cases.reduce((max, item) => Math.max(max, item.chars), 0), totalChars,
		originalChars, originalRuns: original ? cases.length : 0,
		redactions, redactionTotal: redactionTotal(redactions), modelCases: items.filter((item) => item.check?.mode === "model").length,
	};
}
