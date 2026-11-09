import { ReplayBudget, type ReplayAuthorization } from "./compaction-offload-budget.ts";

/**
 * Live budget for the rollover replay. Three repetitions x two arms x at most 40 requests is 240,
 * and every request stays below 100k input tokens, so 24M is a hard ceiling that still fails closed.
 */
export const ROLLOVER_SOFT_LIMITS = Object.freeze({ maxRequests: 240, maxInputTokens: 24_000_000 });

/** Placeholder shape for a written authorization. `null` means live replay is not authorized. */
export type RolloverAuthorization = ReplayAuthorization;
export const ROLLOVER_LIVE_AUTHORIZATION: Readonly<RolloverAuthorization> | null = null;

/** Both flags plus an exact Provider/model/thinking/task match. Nothing here enables a live run. */
export function validateRolloverReplay(env: NodeJS.ProcessEnv, authorization: RolloverAuthorization | null) {
	if (env.ROTOM_EVAL_SESSION_ROLLOVER !== "1" || env.ROTOM_EVAL_SESSION_ROLLOVER_LIVE !== "1") {
		throw new Error("Live rollover replay requires both explicit enablement flags");
	}
	if (!authorization) throw new Error("Live rollover replay has no authorization");
	if (env.ROTOM_EVAL_PROVIDER !== authorization.provider || env.ROTOM_EVAL_MODEL !== authorization.model || env.ROTOM_EVAL_THINKING !== authorization.thinking) {
		throw new Error("Live rollover replay selection does not exactly match authorization");
	}
	const repetitions = env.ROTOM_EVAL_REPETITIONS ?? String(authorization.maxRepetitions);
	if (!/^[1-9]\d*$/u.test(repetitions) || Number(repetitions) > authorization.maxRepetitions) {
		throw new Error("Rollover replay repetitions exceed authorization or are invalid");
	}
	const requests = Math.min(authorization.maxRequests, ROLLOVER_SOFT_LIMITS.maxRequests);
	const inputTokens = Math.min(authorization.maxInputTokens, ROLLOVER_SOFT_LIMITS.maxInputTokens);
	return { authorization, repetitions: Number(repetitions), budget: new ReplayBudget({ maxRequests: requests, maxInputTokens: inputTokens }) };
}
