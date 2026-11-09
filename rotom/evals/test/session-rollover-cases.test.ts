import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROLLOVER_LIVE_AUTHORIZATIONS, ROLLOVER_RUN_LIMITS, rolloverRunBudget, validateRolloverReplay } from "../src/session-rollover-budget.ts";
import { gradeRollover, rolloverGradeReason, LOCKED_CONFIG_PATH, NO_HINT_MARKER, NO_HINT_SUMMARY_PATH, taskById, writeRolloverFixture } from "../src/session-rollover-tasks.ts";
import { rolloverMetrics } from "../src/session-rollover-metrics.ts";
import { summarizeRolloverLive, type RolloverLiveRow } from "../src/session-rollover-live.ts";

const authorization = {
	id: "unit-test-only",
	provider: "openai-codex",
	model: "gpt-5.6-luna",
	thinking: "low" as const,
	maxRepetitions: 3,
	maxRequests: 80,
	maxInputTokens: 3_200_000,
};
const enabled = {
	ROTOM_EVAL_SESSION_ROLLOVER: "1",
	ROTOM_EVAL_SESSION_ROLLOVER_LIVE: "1",
	ROTOM_EVAL_PROVIDER: authorization.provider,
	ROTOM_EVAL_MODEL: authorization.model,
	ROTOM_EVAL_THINKING: authorization.thinking,
};

describe("session rollover live replay gate", () => {
	it("lists the two authorized models with their own caps and the five-repetition bound", () => {
		expect(ROLLOVER_LIVE_AUTHORIZATIONS.map((entry) => `${entry.provider}/${entry.model}/${entry.thinking}`)).toEqual([
			"openai-codex/gpt-5.6-luna/low",
			"qoder/ultimate/high",
		]);
		for (const entry of ROLLOVER_LIVE_AUTHORIZATIONS) {
			expect(entry.id).toContain("用户授权，预算不设上限");
			expect(entry.maxRepetitions).toBe(5);
			// The guard caps are the run-scale limits, not a cost ceiling.
			expect({ maxRequests: entry.maxRequests, maxInputTokens: entry.maxInputTokens }).toEqual({ ...ROLLOVER_RUN_LIMITS });
		}
	});

	it("requires both enablement flags and an exact provider/model/thinking match", () => {
		expect(() => validateRolloverReplay({}, [authorization])).toThrow(/both explicit enablement flags/u);
		expect(() => validateRolloverReplay({ ROTOM_EVAL_SESSION_ROLLOVER: "1" }, [authorization])).toThrow(/both explicit enablement flags/u);
		expect(() => validateRolloverReplay({ ...enabled }, [])).toThrow(/does not exactly match an authorization/u);
		expect(() => validateRolloverReplay({ ...enabled, ROTOM_EVAL_MODEL: "other" }, [authorization])).toThrow(/does not exactly match an authorization/u);
		expect(() => validateRolloverReplay({ ...enabled, ROTOM_EVAL_THINKING: "high" }, [authorization])).toThrow(/does not exactly match an authorization/u);
	});

	it("caps repetitions at the authorization and gives every run a fresh budget", () => {
		expect(() => validateRolloverReplay({ ...enabled, ROTOM_EVAL_REPETITIONS: "4" }, [authorization])).toThrow(/exceed authorization/u);
		expect(() => validateRolloverReplay({ ...enabled, ROTOM_EVAL_REPETITIONS: "0" }, [authorization])).toThrow(/exceed authorization/u);
		const plan = validateRolloverReplay({ ...enabled, ROTOM_EVAL_REPETITIONS: "3" }, [authorization]);
		expect(plan.repetitions).toBe(3);
		const first = rolloverRunBudget(plan.authorization);
		const second = rolloverRunBudget(plan.authorization);
		expect(first).not.toBe(second);
		expect(first.limits).toEqual({ maxRequests: 80, maxInputTokens: 3_200_000 });
		expect(first.snapshot()).toMatchObject({ requests: 0, stopReason: null });
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

	it("counts recall queries by length and hit only, never by text", () => {
		const branch = [
			{ type: "message", message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, content: [{ type: "toolCall", id: "call-1", name: "context_recall", arguments: { query: "first line" } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "the first line must be abc" }] } },
			{ type: "message", message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, content: [{ type: "toolCall", id: "call-2", name: "context_recall", arguments: { query: "absent" } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "call-2", content: [{ type: "text", text: "no match" }] } },
		] as any;
		const metrics = rolloverMetrics(branch, true, false);
		expect(metrics.recallCalls).toBe(2);
		expect(metrics.recallQueries).toEqual([{ length: 10, hit: true }, { length: 6, hit: false }]);
	});

	it("sums Qoder-recorded credits and keeps them null when the model reports none", () => {
		const qoder = [
			{ type: "custom", customType: "qoder-credit-observation-v1", data: { credits: 1.25 } },
			{ type: "custom", customType: "qoder-credit-observation-v1", data: { credits: 0.5 } },
			{ type: "custom", customType: "qoder-credit-observation-v1", data: { credits: null } },
		] as any;
		expect(rolloverMetrics(qoder, true, false).credits).toBeCloseTo(1.75, 6);
		expect(rolloverMetrics(qoder, true, false).creditEntries).toBe(2);
		expect(rolloverMetrics([], true, false).credits).toBeNull();
	});
});

describe("session rollover replay tasks", () => {
	it("ships the early-detail task whose answer only exists in the recorded fixture", () => {
		const task = taskById("early-detail");
		expect(task.reading[0]).toBe("logs/exact.txt");
		expect(JSON.stringify(task.files)).toContain(task.answer);
		expect(task.scenario.steps.length).toBe(2);
	});

	it("ships a no-hint task whose rule is stated in one turn and never repeated", () => {
		const task = taskById("no-hint");
		const [first, second] = task.scenario.steps as { content: string }[];
		// The rule lives in the first turn only; the second turn must not hint at it.
		expect(first.content).toContain(NO_HINT_MARKER);
		expect(first.content).toMatch(/first line of every new file/u);
		expect(second.content).not.toMatch(/first line|marker|rule|locked/u);
		expect(task.answer).toBe("DONE");
	});

	it("names the reason a no-hint run is graded wrong", async () => {
		const task = taskById("no-hint");
		const workspace = await mkdtemp(join(tmpdir(), "rollover-reason-"));
		await writeRolloverFixture(workspace, task);
		expect(await rolloverGradeReason(task, workspace, "DONE")).toBe("summary-missing");
		await writeFile(join(workspace, NO_HINT_SUMMARY_PATH), `wrong\n${task.reading.map((path) => `- ${path}`).join("\n")}\n`);
		expect(await rolloverGradeReason(task, workspace, "DONE")).toBe("first-line-mismatch");
		await writeFile(join(workspace, NO_HINT_SUMMARY_PATH), `${NO_HINT_MARKER}\n- logs/bulk.txt\n`);
		expect(await rolloverGradeReason(task, workspace, "DONE")).toBe("summary-incomplete");
		await writeFile(join(workspace, NO_HINT_SUMMARY_PATH), `${NO_HINT_MARKER}\n${task.reading.map((path) => `- ${path}`).join("\n")}\n`);
		expect(await gradeRollover(task, workspace, "DONE")).toBe(true);
		expect(await rolloverGradeReason(task, workspace, "OK")).toBe("reply-mismatch");
		await writeFile(join(workspace, LOCKED_CONFIG_PATH), "{}");
		expect(await rolloverGradeReason(task, workspace, "DONE")).toBe("fixture-changed");
	});

	it("grades the no-hint file on its first line and on untouched fixtures", async () => {
		const task = taskById("no-hint");
		const workspace = await mkdtemp(join(tmpdir(), "rollover-grade-"));
		await writeRolloverFixture(workspace, task);
		// No file at all, then a file with the wrong first line: both are wrong.
		expect(await gradeRollover(task, workspace, "DONE")).toBe(false);
		await writeFile(join(workspace, NO_HINT_SUMMARY_PATH), `not-the-marker\n- ${LOCKED_CONFIG_PATH}\n`);
		expect(await gradeRollover(task, workspace, "DONE")).toBe(false);
		// Every listed file has to appear; one missing line is enough to fail the run.
		await writeFile(join(workspace, NO_HINT_SUMMARY_PATH), `${NO_HINT_MARKER}\n- logs/bulk.txt\n- ${LOCKED_CONFIG_PATH}\n`);
		expect(await gradeRollover(task, workspace, "DONE")).toBe(false);
		await writeFile(join(workspace, NO_HINT_SUMMARY_PATH), `${NO_HINT_MARKER}\n${task.reading.map((path) => `- ${path}`).join("\n")}\n`);
		expect(await gradeRollover(task, workspace, "DONE")).toBe(true);
		// A changed fixture invalidates the run even when the created file is right.
		await writeFile(join(workspace, LOCKED_CONFIG_PATH), "{}");
		expect(await gradeRollover(task, workspace, "DONE")).toBe(false);
		// The reply still has to match the task's own answer.
		await writeFile(join(workspace, LOCKED_CONFIG_PATH), task.files[LOCKED_CONFIG_PATH]!);
		expect(await gradeRollover(task, workspace, "OK")).toBe(false);
	});
});

describe("session rollover live summary", () => {
	it("separates arms and keeps unpriced spend unknown", () => {
		const row = (arm: "candidate" | "baseline", correct: boolean, credits: number | null): RolloverLiveRow => ({
			version: 1,
			authorizationId: "test",
			timestamp: "2026-11-08T00:00:00.000Z",
			task: "no-hint",
			arm,
			repetition: 1,
			repetitions: 5,
			attempt: 1,
			status: "completed",
			reason: null,
			provider: "qoder",
			model: "ultimate",
			thinking: "high",
			contextWindow: 200_000,
			thresholdTokens: 16_000,
			keepRecentTokens: 2_000,
			tookOver: arm === "candidate",
			metrics: {
				correct,
				requests: 9,
				inputTokens: 1_000,
				outputTokens: 100,
				cacheReadTokens: 500,
				cacheWriteTokens: 0,
				usageKnown: true,
				compactions: 1,
				nativeSummaries: arm === "baseline" ? 1 : 0,
				rolloverEntries: arm === "candidate" ? 1 : 0,
				costUsd: null,
				costUnknownReason: "provider-report-unknown",
				credits,
				creditEntries: credits === null ? 0 : 1,
				gradeReason: null,
				ruleObeyed: null,
				recallCalls: 2,
				recallQueries: [{ length: 8, hit: true }],
				wallMs: 1_000,
			},
			budget: { requests: 9, input: 1_000, output: 100, cacheRead: 500, cacheWrite: 0, usageKnown: true, pessimisticRequests: 0, stopReason: null },
			sourceCommit: "deadbeef",
			sourceDirty: false,
		});
		const summary = summarizeRolloverLive([row("baseline", true, null), row("candidate", false, 2.5)]);
		const baseline = summary["qoder / ultimate / high / no-hint / baseline"]!;
		const candidate = summary["qoder / ultimate / high / no-hint / candidate"]!;
		expect(baseline).toMatchObject({ runs: 1, completed: 1, correct: 1, costUsd: null, credits: null, nativeSummaries: 1, takeovers: 0 });
		expect(candidate).toMatchObject({ runs: 1, completed: 1, correct: 0, costUsd: null, credits: 2.5, rolloverEntries: 1, takeovers: 1 });
	});
});
