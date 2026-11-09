import { ReplayBudget, type ReplayAuthorization } from "./compaction-offload-budget.ts";

/**
 * Guard caps, not cost caps. One replay run issues at most about twenty requests (two prompts, one
 * read per listed file, a few `context_recall` calls, one write, up to three summary calls), and no
 * single request carries more than the threshold plus one tool result, so a run costs well under
 * 800k input tokens. The values below are twice that scale; they stop a loop or a retry storm.
 *
 * The 40-request variant stopped one candidate run on 2026-11-08 after it re-read and re-searched 20
 * times without answering. Per the worklist that cap was doubled once and the campaign rerun, so a
 * new finding is recorded instead of a truncated run; the report states the doubling.
 */
export const ROLLOVER_RUN_LIMITS = Object.freeze({ maxRequests: 80, maxInputTokens: 3_200_000 });

/**
 * Written authorization. Each record names its model, thinking level, repetition bound and the caps
 * that apply to ONE run; the user authorized this comparison with no budget ceiling on 2026-11-08.
 * Listing a model here never starts a request: the live path also requires two environment flags and
 * an exact Provider/model/thinking match.
 */
export type RolloverAuthorization = ReplayAuthorization;
export const ROLLOVER_LIVE_AUTHORIZATIONS: readonly RolloverAuthorization[] = Object.freeze([
	Object.freeze({
		id: "2026-11-08 openai-codex/gpt-5.6-luna thinking=low — 用户授权，预算不设上限",
		provider: "openai-codex",
		model: "gpt-5.6-luna",
		thinking: "low" as const,
		maxRepetitions: 5,
		...ROLLOVER_RUN_LIMITS,
	}),
	Object.freeze({
		id: "2026-11-08 qoder/ultimate thinking=high — 用户授权，预算不设上限",
		provider: "qoder",
		model: "ultimate",
		thinking: "high" as const,
		maxRepetitions: 5,
		...ROLLOVER_RUN_LIMITS,
	}),
]);

/** Both flags plus an exact Provider/model/thinking match. Nothing here enables a live run. */
export function validateRolloverReplay(env: NodeJS.ProcessEnv, authorizations: readonly RolloverAuthorization[] = ROLLOVER_LIVE_AUTHORIZATIONS) {
	if (env.ROTOM_EVAL_SESSION_ROLLOVER !== "1" || env.ROTOM_EVAL_SESSION_ROLLOVER_LIVE !== "1") {
		throw new Error("Live rollover replay requires both explicit enablement flags");
	}
	const provider = env.ROTOM_EVAL_PROVIDER;
	const model = env.ROTOM_EVAL_MODEL;
	const thinking = env.ROTOM_EVAL_THINKING;
	const authorization = authorizations.find((entry) => entry.provider === provider && entry.model === model && entry.thinking === thinking);
	if (!authorization) throw new Error("Live rollover replay selection does not exactly match an authorization");
	const repetitions = env.ROTOM_EVAL_REPETITIONS ?? String(authorization.maxRepetitions);
	if (!/^[1-9]\d*$/u.test(repetitions) || Number(repetitions) > authorization.maxRepetitions) {
		throw new Error("Rollover replay repetitions exceed authorization or are invalid");
	}
	return { authorization, repetitions: Number(repetitions) };
}

/** One fresh budget per run: a runaway loop inside one run stops, the campaign keeps going. */
export function rolloverRunBudget(authorization: RolloverAuthorization) {
	return new ReplayBudget({ maxRequests: authorization.maxRequests, maxInputTokens: authorization.maxInputTokens });
}
