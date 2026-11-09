import { describe, expect, it } from "vitest";
import { ROLLOVER_LIVE_AUTHORIZATION, ROLLOVER_SOFT_LIMITS, validateRolloverReplay } from "../src/session-rollover-budget.ts";
import { ROLLOVER_TASKS, rolloverMetrics } from "../src/session-rollover-cases.ts";

const authorization = {
	id: "unit-test-only",
	provider: "openai-codex",
	model: "gpt-5.6-luna",
	thinking: "low" as const,
	maxRepetitions: 3,
	maxRequests: 10_000,
	maxInputTokens: 10_000_000_000,
};
const enabled = { ROTOM_EVAL_SESSION_ROLLOVER: "1", ROTOM_EVAL_SESSION_ROLLOVER_LIVE: "1", ROTOM_EVAL_PROVIDER: authorization.provider, ROTOM_EVAL_MODEL: authorization.model, ROTOM_EVAL_THINKING: authorization.thinking };

describe("session rollover live replay gate", () => {
	it("is not authorized by default", () => {
		expect(ROLLOVER_LIVE_AUTHORIZATION).toBeNull();
	});

	it("requires both enablement flags, an authorization and an exact provider/model/thinking match", () => {
		expect(() => validateRolloverReplay({}, authorization)).toThrow(/both explicit enablement flags/u);
		expect(() => validateRolloverReplay({ ROTOM_EVAL_SESSION_ROLLOVER: "1" }, authorization)).toThrow(/both explicit enablement flags/u);
		expect(() => validateRolloverReplay(enabled, null)).toThrow(/no authorization/u);
		expect(() => validateRolloverReplay({ ...enabled, ROTOM_EVAL_MODEL: "other" }, authorization)).toThrow(/does not exactly match/u);
		expect(() => validateRolloverReplay({ ...enabled, ROTOM_EVAL_THINKING: "high" }, authorization)).toThrow(/does not exactly match/u);
	});

	it("caps repetitions and the budget at the soft limits instead of trusting the authorization", () => {
		expect(() => validateRolloverReplay({ ...enabled, ROTOM_EVAL_REPETITIONS: "5" }, authorization)).toThrow(/exceed authorization/u);
		expect(() => validateRolloverReplay({ ...enabled, ROTOM_EVAL_REPETITIONS: "0" }, authorization)).toThrow(/exceed authorization/u);
		const plan = validateRolloverReplay({ ...enabled, ROTOM_EVAL_REPETITIONS: "3" }, authorization);
		expect(plan.repetitions).toBe(3);
		expect(plan.budget.snapshot()).toMatchObject({ requests: 0, stopReason: null });
		expect(plan.budget.limits).toEqual({ maxRequests: ROLLOVER_SOFT_LIMITS.maxRequests, maxInputTokens: ROLLOVER_SOFT_LIMITS.maxInputTokens });
	});
});

describe("session rollover replay metrics", () => {
	it("keeps usage unknown when a request has no usage block", () => {
		const branch = [
			{ type: "message", message: { role: "assistant", usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } } },
			{ type: "message", message: { role: "assistant" } },
		] as any;
		const metrics = rolloverMetrics(branch, false, true);
		expect(metrics.usageKnown).toBe(false);
		expect(metrics.requests).toBe(1);
		expect(metrics.costUsd).toBeNull();
		expect(metrics.costUnknownReason).toBeNull();
	});

	it("ships one task whose answer only exists in the recorded fixture", () => {
		const task = ROLLOVER_TASKS[0];
		expect(task).toBeDefined();
		expect(task!.reading[0]).toBe("logs/exact.txt");
		expect(JSON.stringify(task!.files)).toContain(task!.answer);
		expect(task!.scenario.steps.length).toBe(2);
	});
});
