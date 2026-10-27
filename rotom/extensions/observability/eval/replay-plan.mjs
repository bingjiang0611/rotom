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

/**
 * Measures selected replay points.
 *
 * @param items one row per point: `{ key, check, entries }` where `entries` is
 *   the truncated prefix the runner generates from.
 * @param repeats repetitions per point, `arms` number of products compared.
 */
export function measureReplayPlan({ items, repeats = 1, arms = 1 }) {
	const count = clampRepeats(repeats), armCount = Number(arms) === 2 ? 2 : 1;
	const cases = [];
	const masked = new Map();
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
		cases.push({ key: item.key, chars, runs: count * armCount });
	}
	const totalChars = cases.reduce((total, item) => total + item.chars, 0) * count * armCount;
	const redactions = [...masked].sort(([left], [right]) => left.localeCompare(right)).map(([type, count]) => ({ type, count }));
	return { cases, runs: cases.length * count * armCount, repeats: count, arms: armCount, totalChars, redactions, redactionTotal: redactionTotal(redactions), modelCases: items.filter((item) => item.check?.mode === "model").length };
}
