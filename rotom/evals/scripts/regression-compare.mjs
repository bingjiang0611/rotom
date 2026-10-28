// Comparing the arms of one frozen point, and the batch report built from them.
//
// Kept apart from set storage because the decision rules are what a person reads:
// coverage first (did the run do what was confirmed?), then the baseline/candidate
// comparison, then the exit code. Pure functions, no storage, no model.
import { basename } from "node:path";
import { clampRepeats } from "../../extensions/observability/eval/replay-plan.mjs";
import { REGRESSION_REPORT_SCHEMA } from "./regression-set.mjs";

/**
 * Compare the arms of one point from the rows of a single run.
 *
 * The original control is unchanged: it says whether the point can show anything.
 * The new part is baseline vs candidate, which is what separates "still broken" from
 * "this build broke it". Coverage is checked here, not assumed: a run that produced
 * one row per arm is not the same run as the one that was confirmed.
 */
export function compareArms(rows, { repeats = 1, judgePromptVersion } = {}) {
	const expected = clampRepeats(repeats);
	const incomplete = [], reasons = [];
	const arm = (name) => {
		const mine = rows.filter((row) => row.arm === name);
		const verdicts = mine.map((row) => row.verdict);
		const want = name === "original" ? 1 : expected;
		if (!verdicts.length) { incomplete.push(`missing_${name}_arm`); return null; }
		if (verdicts.length !== want) incomplete.push(`${name}_repetitions_${verdicts.length < want ? "short" : "extra"}`);
		if (verdicts.some((verdict) => !["pass", "fail", "unknown"].includes(verdict))) { incomplete.push(`${name}_verdict_invalid`); return null; }
		if (new Set(verdicts).size > 1) { reasons.push(`${name}_repetitions_disagree`); return "flaky"; }
		return verdicts[0];
	};
	const original = arm("original"), baseline = arm("baseline"), candidate = arm("candidate");
	// A model point scored by a different judge prompt — or by one the set was not
	// frozen with — is not the comparison that was confirmed.
	const versions = new Set(rows.filter((row) => row.checkMode === "model").map((row) => row.judgePromptVersion ?? null));
	if (rows.some((row) => row.checkMode === "model" && !row.judgePromptVersion)) reasons.push("judge_prompt_version_missing");
	if (versions.size > 1) reasons.push("judge_prompt_mismatch");
	if (judgePromptVersion && [...versions].some((version) => version !== judgePromptVersion)) reasons.push("judge_prompt_version_drift");
	const verdict = (() => {
		if (incomplete.length) return "incomplete";
		if (reasons.length) return "inconclusive";
		if ([original, baseline, candidate].includes("unknown")) return "inconclusive";
		if (original === "pass") return "judge-blind";
		if (baseline === "pass" && candidate === "fail") return "regression";
		if (baseline === "fail" && candidate === "pass") return "improved";
		return baseline === "fail" && candidate === "fail" ? "still-failing" : "stable-pass";
	})();
	return { comparison: verdict, original, baseline, candidate, reasons: [...incomplete, ...reasons] };
}

const countKey = { regression: "regression", improved: "improved", "still-failing": "stillFailing", "stable-pass": "stablePass", "judge-blind": "judgeBlind", inconclusive: "inconclusive", incomplete: "incomplete" };

/** 0: every point held or improved. 1: a real failure remains. 2: cannot conclude. */
export function regressionExitCode({ total, complete, counts }) {
	if (!total || !complete) return 2;
	if (counts.regression || counts.stillFailing) return 1;
	return counts.judgeBlind || counts.inconclusive || counts.incomplete ? 2 : 0;
}

/** Sum the one usage shape the judge and the replay both persist. */
function usageTotals(rows) {
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, known: 0, unknown: 0, costKnown: 0 };
	for (const row of rows) {
		const usage = row.usage;
		if (!usage || typeof usage !== "object") { totals.unknown++; continue; }
		totals.known++;
		for (const field of ["input", "output", "cacheRead", "cacheWrite"]) if (Number.isFinite(usage[field])) totals[field] += usage[field];
		// A zero placeholder cannot prove a free request, so only a positive value counts.
		if (Number.isFinite(usage.costUsd) && usage.costUsd > 0) { totals.costUsd += usage.costUsd; totals.costKnown++; }
	}
	if (!totals.costKnown) totals.costUsd = null;
	// Anything missing or unpriced keeps the total partial rather than zero.
	totals.partial = totals.unknown > 0 || totals.costKnown < totals.known;
	return totals;
}

/**
 * Build the report from the rows a run just produced; never re-reads old runs.
 *
 * `failure` carries the runner's own end state so a crash still leaves a report that
 * says "incomplete" instead of no report at all.
 */
export function summarizeRegression({ set, rows, model, arms, repeats = set?.repeats, startedAt, finishedAt, failure }) {
	const expected = clampRepeats(repeats);
	const byKey = new Map();
	for (const row of rows ?? []) {
		const list = byKey.get(row.key) ?? [];
		list.push(row);
		byKey.set(row.key, list);
	}
	const points = set.cases.map((item) => {
		const pointRows = byKey.get(item.key) ?? [];
		// A point with no rows at all is incomplete, never a silent pass.
		const compared = pointRows.length
			? compareArms(pointRows, { repeats: expected, judgePromptVersion: set.judgePromptVersion })
			: { comparison: "incomplete", original: null, baseline: null, candidate: null, reasons: ["no_rows"] };
		const verdicts = (arm) => pointRows.filter((row) => row.arm === arm).map((row) => row.verdict);
		return {
			key: item.key, sessionId: item.sessionId, cutEntryId: item.cutEntryId, check: item.check.mode, ...compared,
			// Bounded evidence for a later "why was this inconclusive?" question.
			verdicts: { original: verdicts("original"), baseline: verdicts("baseline"), candidate: verdicts("candidate") },
			judgePromptVersions: [...new Set(pointRows.map((row) => row.judgePromptVersion).filter(Boolean))],
			records: pointRows.map((row) => basename(row.path ?? "")).filter(Boolean).slice(0, 8),
			runs: pointRows.length, usage: usageTotals(pointRows),
		};
	});
	const counts = { total: points.length, regression: 0, improved: 0, stillFailing: 0, stablePass: 0, judgeBlind: 0, inconclusive: 0, incomplete: 0 };
	for (const point of points) counts[countKey[point.comparison]]++;
	const prepared = set.scan?.included === set.cases.length && set.scan?.excluded === 0 && set.scan?.indexComplete === true;
	const ran = !failure && counts.incomplete === 0;
	const complete = prepared && ran;
	const exitCode = regressionExitCode({ total: counts.total, complete, counts });
	const warnings = [];
	if (!prepared) warnings.push("set_incomplete");
	if (failure) warnings.push(...(failure.code ? [`runner_${failure.code}`] : ["runner_failed"]));
	return {
		schema: REGRESSION_REPORT_SCHEMA, setName: set.name, setDigest: set.digest, startedAt, finishedAt, model, arms, repeats: expected,
		judgePromptVersion: set.judgePromptVersion ?? null, points, counts, complete, exitCode,
		usage: usageTotals(rows ?? []), failure: failure ?? null, warnings,
	};
}
