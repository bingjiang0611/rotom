// What a replay will cost, computed before it starts.
//
// A replay spends model calls on the truncated prefix of a session, so the
// person confirming it needs two numbers: how much context each point sends
// (characters, after redaction, across arms and repeats) and — for points that
// also ask a model to judge — how many credentials the judge input hides. The
// numbers are measured from the same redacted text the runner would send, never
// from the raw session, so nothing here reads or exposes a secret.
import { redactSecrets, redactionTotal } from "./redaction.mjs";
import { replayJudgeContext } from "./replay-judge.mjs";

/** Matches the runner and the service: one to three repetitions. */
export const MAX_REPLAY_REPEATS = 3;

export function clampRepeats(value) {
	const number = Number(value);
	if (!Number.isSafeInteger(number)) return 1;
	return Math.min(Math.max(number, 1), MAX_REPLAY_REPEATS);
}

// The control sends the judge context, never the prefix or the raw session text.

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
			// The product generates from the prefix, so its redacted size is what the
			// generation costs; it is not judge input.
			chars += redactSecrets(JSON.stringify(entry?.message ?? entry)).text.length;
		}
		// The original arm sends the judge input, not the session: the same rendered
		// context the judge really receives, plus the expected behaviour. Rule points
		// send nothing.
		let judgeChars = 0;
		if (original && item.check?.mode === "model") {
			const context = replayJudgeContext(item.entries ?? []);
			judgeChars = context.chars + (item.expected?.length ?? 0);
			originalChars += judgeChars;
			// Report what the judge input really hid, not what the raw prefix held.
			for (const { type, count: hits } of context.redactions) masked.set(type, (masked.get(type) ?? 0) + hits);
		}
		cases.push({ key: item.key, chars, originalChars: judgeChars, runs: count * armCount + (original ? 1 : 0) });
	}
	const perCaseChars = cases.reduce((total, item) => total + item.chars, 0);
	// Rows are not inference calls: a model point also spends one judge call per row,
	// and a rule point spends none. Report the two separately so a confirmation
	// cannot promise a cheaper run than the one it starts.
	const modelCases = items.filter((item) => item.check?.mode === "model");
	const rowsPerPoint = count * armCount + (original ? 1 : 0);
	const generations = items.length * count * armCount;
	const judgments = modelCases.length * rowsPerPoint;
	const localChecks = (items.length - modelCases.length) * rowsPerPoint;
	// Every row of a model point sends the same judge context, the control included.
	const judgeChars = originalChars * rowsPerPoint;
	const totalChars = perCaseChars * count * armCount + originalChars;
	const redactions = [...masked].sort(([left], [right]) => left.localeCompare(right)).map(([type, count]) => ({ type, count }));
	return {
		cases, runs: cases.length * (count * armCount + (original ? 1 : 0)), repeats: count, arms: armCount,
		generations, judgments, localChecks, judgeChars,
		perCaseChars, maxChars: cases.reduce((max, item) => Math.max(max, item.chars), 0), totalChars,
		originalChars, originalRuns: original ? cases.length : 0,
		redactions, redactionTotal: redactionTotal(redactions), modelCases: items.filter((item) => item.check?.mode === "model").length,
	};
}
