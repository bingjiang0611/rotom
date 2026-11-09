import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { ROLLOVER_LIVE_AUTHORIZATION, validateRolloverReplay } from "../src/session-rollover-budget.ts";
import {
	createRolloverHarness,
	gradeRollover,
	ROLLOVER_FAUX_MODEL,
	ROLLOVER_TASKS,
	rolloverFaux,
	rolloverMetrics,
	writeRolloverFixture,
	type RolloverMetrics,
} from "../src/session-rollover-cases.ts";
import type { PiCodingAgentInput } from "../src/pi-harness.ts";
import { evalHarnessTable } from "../src/vitest-evals/harness-table.ts";

// Faux is the only mode this branch runs. Authorization constants alone never enable live
// execution: `validateRolloverReplay` also demands both environment flags.
const live = process.env.ROTOM_EVAL_SESSION_ROLLOVER_LIVE === "1" && ROLLOVER_LIVE_AUTHORIZATION !== null;
const enabled = process.env.ROTOM_EVAL_SESSION_ROLLOVER === "1";

function judgeFor(task: string) {
	return createJudge<PiCodingAgentInput, RolloverMetrics>(task, ({ output }) => ({ score: output.correct ? 1 : 0, metadata: { output } }));
}

if (live) {
	const plan = validateRolloverReplay(process.env, ROLLOVER_LIVE_AUTHORIZATION);
	afterAll(() => {
		console.log(JSON.stringify({ sessionRolloverLiveBudget: plan.budget.snapshot(), providerFailures: plan.budget.providerFailures }));
	});
	for (const task of ROLLOVER_TASKS) {
		for (let repetition = 1; repetition <= plan.repetitions; repetition++) {
			for (const candidate of repetition % 2 ? [false, true] : [true, false]) {
				const arm = candidate ? "rollover" : "native-summary";
				describeEval(`${task.id}: ${arm} repetition ${repetition}`, {
					harness: createRolloverHarness(task, candidate, {
						model: ROLLOVER_LIVE_AUTHORIZATION
							? { provider: ROLLOVER_LIVE_AUTHORIZATION.provider, id: ROLLOVER_LIVE_AUTHORIZATION.model }
							: ROLLOVER_FAUX_MODEL,
						thinkingLevel: ROLLOVER_LIVE_AUTHORIZATION?.thinking,
						modelRuntimeFactory: rolloverFaux(task),
						piExecutable: process.env.ROTOM_TEST_PI,
					}),
					judges: [judgeFor(task.id)],
					judgeThreshold: null,
				}, (test) => {
					test(task.id, { timeout: 30 * 60_000 }, async ({ run }) => {
						const { output } = await run(task.scenario);
						expect((output as RolloverMetrics).requests).toBeGreaterThan(0);
					});
				});
			}
		}
	}
} else if (!enabled) {
	describe.skip("session rollover replay requires ROTOM_EVAL_SESSION_ROLLOVER=1", () => {
		it("does not construct a runtime or dispatch a request", () => {});
	});
} else {
	if (process.env.ROTOM_EVAL_PROVIDER && process.env.ROTOM_EVAL_PROVIDER !== ROLLOVER_FAUX_MODEL.provider) throw new Error("Session rollover replay is faux-only here");
	if (process.env.ROTOM_EVAL_MODEL && process.env.ROTOM_EVAL_MODEL !== ROLLOVER_FAUX_MODEL.id) throw new Error("Session rollover replay is faux-only here");
	const repetitions = Number(process.env.ROTOM_EVAL_REPETITIONS ?? "3");
	if (![3, 5].includes(repetitions)) throw new Error("Replay repetitions must be 3 or 5");

	for (const task of ROLLOVER_TASKS) {
		const arm = (candidate: boolean) => createRolloverHarness(task, candidate, { model: ROLLOVER_FAUX_MODEL, modelRuntimeFactory: rolloverFaux(task) });
		const rows = evalHarnessTable<PiCodingAgentInput, RolloverMetrics>(`Session rollover: ${task.id}`, { baseline: arm(false), candidate: arm(true), repetitions });
		// Alternate which arm runs first, so a warm provider cache cannot favour one of them.
		const ordered = Array.from({ length: repetitions }, (_, index) => {
			const pair = rows.filter((row) => row.repetition === index + 1);
			return index % 2 ? pair.reverse() : pair;
		}).flat();
		for (const row of ordered) {
			describeEval(`${task.id}: ${row.name} repetition ${row.repetition}`, {
				harness: row.harness,
				judges: [judgeFor(task.id)],
				judgeThreshold: 1,
			}, (test) => {
				test(task.id, async ({ run }) => {
					const { output } = await run(task.scenario);
					const metrics = output as RolloverMetrics;
					expect(metrics.correct).toBe(true);
					// Only the candidate arm replaces every summary with a rollover entry; a long run can
					// cross the threshold more than once.
					if (row.name === "rollover") {
						expect(metrics.rolloverEntries).toBeGreaterThanOrEqual(1);
						expect(metrics.nativeSummaries).toBe(0);
					} else {
						expect(metrics.rolloverEntries).toBe(0);
						expect(metrics.nativeSummaries).toBeGreaterThanOrEqual(1);
					}
				});
			});
		}
	}

	// Negative control: without the retrieval tool the recorded detail is unreachable, so the answer
	// must be graded wrong instead of guessed. This is the sample that proves the check can fail.
	const task = ROLLOVER_TASKS[0]!;
	describeEval(`${task.id}: rollover without context_recall is graded wrong`, {
		harness: createRolloverHarness(task, true, { model: ROLLOVER_FAUX_MODEL, modelRuntimeFactory: rolloverFaux(task), disableContextLayers: true }),
		judges: [judgeFor(`${task.id}-no-recall`)],
		judgeThreshold: null,
	}, (test) => {
		test(task.id, async ({ run }) => {
			const { output } = await run(task.scenario);
			const metrics = output as RolloverMetrics;
			expect(metrics.correct).toBe(false);
			// Without the retrieval tool the extension declines the takeover, so the native summary
			// runs and still cannot carry the recorded code: the answer stays wrong.
			expect(metrics.rolloverEntries).toBe(0);
			expect(metrics.nativeSummaries).toBeGreaterThanOrEqual(1);
		});
	});
}

describe("session rollover replay grading", () => {
	it("grades a wrong answer and a changed fixture as incorrect", async () => {
		const task = ROLLOVER_TASKS[0]!;
		const workspace = await mkdtemp(join(tmpdir(), "rollover-eval-grade-"));
		try {
			await writeRolloverFixture(workspace, task);
			expect(await gradeRollover(task, workspace, task.answer)).toBe(true);
			expect(await gradeRollover(task, workspace, "unknown")).toBe(false);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("counts native summaries and rollover entries apart and keeps an unpriced run cost-unknown", () => {
		const branch = [
			{ type: "message", message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } } } },
			{ type: "compaction", summary: "native", usage: { input: 1 } },
			{ type: "compaction", summary: "rollover", fromHook: true, details: { kind: "rotom-rollover", version: 2 } },
			{ type: "message", message: { role: "assistant", usage: { input: 20, output: 5, cacheRead: 3, cacheWrite: 1 } } },
		] as any;
		const metrics = rolloverMetrics(branch, true, false);
		expect(metrics).toMatchObject({
			correct: true,
			requests: 2,
			inputTokens: 30,
			outputTokens: 10,
			compactions: 2,
			nativeSummaries: 1,
			rolloverEntries: 1,
			costUnknownReason: "provider-report-unknown",
		});
		expect(metrics.costUsd).toBeCloseTo(0.25, 6);
		expect(rolloverMetrics(branch, true, true).costUnknownReason).toBeNull();
	});
});
