import { contextTokens } from "./rollover-stats.mjs";

/**
 * The design gate: at least half of the sessions that hit native threshold compaction could have
 * been taken over at an inter-turn point *before their first native compaction*, so the session
 * share reads `firstCrossingTakeover` (segment share still counts every crossing segment). Among
 * the qualifying candidates the latest one wins, i.e. the smallest reserve multiplier: its water
 * mark sits closest to the compaction threshold, so it changes existing behavior the least.
 */
export function judge(report, { threshold = 0.5 } = {}) {
	const qualifies = (candidate) => (candidate.takeoverSessionShare ?? 0) >= threshold;
	const passing = report.candidates.filter(qualifies);
	const selected = passing[0] ?? null;
	return {
		threshold,
		passed: Boolean(selected),
		selectedReserveMultiples: selected?.reserveMultiples ?? null,
		selectedWaterMark: selected?.waterMark ?? null,
		considered: report.candidates.map((candidate) => ({ reserveMultiples: candidate.reserveMultiples, takeoverSessionShare: candidate.takeoverSessionShare, takeoverSegmentShare: candidate.takeoverSegmentShare })),
	};
}

export function formatReport(report, verdict) {
	const share = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
	const lines = [
		"stage-0 rollover statistics (aggregate only)",
		`sessions=${report.totals.sessions} sessionsWithCrossing=${report.totals.sessionsWithCrossing} segments=${report.totals.segments} unknownWindowSegments=${report.totals.unknownWindowSegments}`,
		`requests=${report.totals.requests} crossingSegments=${report.totals.crossingSegments} midTurn=${report.totals.midTurnCrossings} turnEnd=${report.totals.turnEndCrossings}`,
		`goalActiveCrossings=${report.totals.goalActiveCrossings} goalUnknownCrossings=${report.totals.goalUnknownCrossings}`,
		`turnGrowth samples=${report.turnGrowth.samples} p50=${report.turnGrowth.p50 ?? "n/a"} p90=${report.turnGrowth.p90 ?? "n/a"} max=${report.turnGrowth.max ?? "n/a"}`,
	];
	for (const candidate of report.candidates) {
		lines.push(`candidate ${candidate.waterMark}: segments=${candidate.takeoverSegments} share=${share(candidate.takeoverSegmentShare)} sessions=${candidate.takeoverSessions} share=${share(candidate.takeoverSessionShare)}`);
	}
	const usage = report.compactions.usage;
	const assistantUsage = report.compactions.assistantUsage;
	lines.push(`compactions entries=${report.compactions.entries} native=${report.compactions.native} extension=${report.compactions.extension} rollover=${report.compactions.rollover} otherExtension=${report.compactions.otherExtension}`);
	lines.push(`summaryUsage input=${usage.input} output=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} total=${contextTokens(usage)} nativeWithUsage=${report.compactions.nativeWithUsage} nativeWithoutUsage=${report.compactions.nativeWithoutUsage}`);
	lines.push(`assistantUsage input=${assistantUsage.input} output=${assistantUsage.output} cacheRead=${assistantUsage.cacheRead} cacheWrite=${assistantUsage.cacheWrite} total=${contextTokens(assistantUsage)} summaryShare=${share(report.compactions.usageShare)}`);
	lines.push(`summaryShares uncachedInput=${share(report.compactions.inputShare)} output=${share(report.compactions.outputShare)}`);
	lines.push(`nativeCompactionsDuringGoal active=${report.compactions.nativeDuringActiveGoal} unknown=${report.compactions.nativeDuringUnknownGoal}`);
	lines.push(`gate>=${share(verdict.threshold)} passed=${verdict.passed} selected=${verdict.selectedWaterMark ?? "none"}`);
	return `${lines.join("\n")}\n`;
}
