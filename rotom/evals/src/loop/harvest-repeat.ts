/**
 * Routine repeats: the same standing instruction sent again and again, answered correctly each
 * time, is not a person having to step in. The count needs every session in the window, so the
 * rule runs after the walk and reports what each session should subtract.
 */
import type { HarvestShared, SessionSummary } from "./harvest.ts";

/**
 * A repeat is routine rather than an intervention when the same instruction keeps coming back
 * across the window and the answer before it completed normally: a periodic re-send satisfies both
 * and a failed answer does not. Sampling thirteen user_repeat events, the four this excludes were
 * all answered correctly the first time. It stays conservative (three occurrences, a completed
 * answer) so a genuine repeat is not silently dropped from the intervention count.
 */
export const ROUTINE_REPEAT_OCCURRENCES = 3;

/** Counts the repeats the rule excludes, per session, so the session totals can drop them. */
export function markRoutineRepeats(shared: HarvestShared): Map<string, number> {
	const perSession = new Map<string, number>();
	for (const candidate of shared.repeatCandidates) {
		if (!candidate.priorAnswerCompleted) continue;
		if ((shared.userTextCounts.get(candidate.key) ?? 0) < ROUTINE_REPEAT_OCCURRENCES) continue;
		candidate.incident.detail.routine = true;
		const sessionId = candidate.incident.sessionId;
		perSession.set(sessionId, (perSession.get(sessionId) ?? 0) + 1);
	}
	return perSession;
}

/**
 * A routine repeat looked like an intervention when its session was summarized, because periodicity
 * is only visible once the whole window is walked. Each one adds exactly one to both totals, so
 * subtracting the count restores the summary without re-analyzing the session.
 */
export function applyRoutineRepeats(sessions: SessionSummary[], routineRepeats: Map<string, number>): void {
	for (const summary of sessions) {
		const excluded = routineRepeats.get(summary.sessionId) ?? 0;
		if (!excluded) continue;
		summary.interventions -= excluded;
		summary.northStarV2 -= excluded;
	}
}
