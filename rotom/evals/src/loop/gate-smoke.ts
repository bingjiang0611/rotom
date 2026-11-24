/**
 * Smoke audit for a gate run: reads the judge verdicts one pair recorded and says whether they
 * can be trusted before a full run is paid for. Kept apart from `gate.ts`, which runs the cases.
 */

/** One scored run as the artifact side records it. */
export type SmokeScore = { checks?: Record<string, unknown>; missingObservation?: unknown };

/**
 * A smoke run proves the recorded output can be scored before spending a full run on it:
 * every arm produced a score, every check resolved to a boolean, and no check read a file
 * the fixture never observed. The last one is the failure this audit exists for: a judge
 * reading an unobserved path silently scored `false` and voided a whole batch.
 */
export function auditSmokeScores(scores: readonly SmokeScore[]): { ok: boolean; problems: string[] } {
	const problems: string[] = [];
	if (scores.length === 0) problems.push("no score was recorded for this case");
	for (const [index, score] of scores.entries()) {
		const checks = score.checks;
		if (!checks || typeof checks !== "object") {
			problems.push(`score ${index + 1} has no checks`);
			continue;
		}
		for (const [name, value] of Object.entries(checks)) if (typeof value !== "boolean") problems.push(`check ${name} is ${value === undefined ? "missing" : typeof value}, not a boolean`);
		const missing = score.missingObservation;
		if (Array.isArray(missing) && missing.length > 0) problems.push(`checks read unobserved path(s): ${missing.map(String).join(", ")}`);
		if (missing !== undefined && !Array.isArray(missing)) problems.push("missingObservation is not a list");
	}
	return { ok: problems.length === 0, problems };
}

/** Reads the judge verdicts the eval artifacts recorded for one case. */
export function smokeScoresFromResults(report: unknown): SmokeScore[] {
	const results = (report as { testResults?: { assertionResults?: unknown[] }[] } | undefined)?.testResults ?? [];
	const scores: SmokeScore[] = [];
	for (const file of results) {
		for (const assertion of file.assertionResults ?? []) {
			const item = assertion as { meta?: { eval?: { scores?: { metadata?: { output?: unknown } }[] } } };
			for (const score of item.meta?.eval?.scores ?? []) {
				const output = score.metadata?.output as { checks?: Record<string, unknown>; missingObservation?: unknown } | undefined;
				if (output) scores.push({ checks: output.checks, missingObservation: output.missingObservation });
			}
		}
	}
	return scores;
}
