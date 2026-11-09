import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { validateRolloverReplay } from "../src/session-rollover-budget.ts";
import { createLiveRolloverCampaign, liveRuntimeFactory, readStoredContextWindow, summarizeRolloverLive, type RolloverLiveRow } from "../src/session-rollover-live.ts";
import { homedir } from "node:os";
import { createRolloverHarness, ROLLOVER_FAUX_MODEL, rolloverFaux } from "../src/session-rollover-cases.ts";
import { rolloverMetrics, type RolloverMetrics } from "../src/session-rollover-metrics.ts";
import {
	gradeRollover,
	LOCKED_CONFIG_PATH,
	NO_HINT_MARKER,
	NO_HINT_SUMMARY_PATH,
	ROLLOVER_PRODUCT,
	ROLLOVER_TASKS,
	taskById,
	writeRolloverFixture,
} from "../src/session-rollover-tasks.ts";
import type { PiCodingAgentInput } from "../src/pi-harness.ts";
import { evalHarnessTable } from "../src/vitest-evals/harness-table.ts";

// Faux is the only mode by default. Live execution also needs
// `ROTOM_EVAL_SESSION_ROLLOVER_LIVE=1`, both eval flags and an exact authorized selection.
const live = process.env.ROTOM_EVAL_SESSION_ROLLOVER_LIVE === "1";
const enabled = process.env.ROTOM_EVAL_SESSION_ROLLOVER === "1";

function judgeFor(task: string) {
	return createJudge<PiCodingAgentInput, RolloverMetrics>(task, ({ output }) => ({ score: output.correct ? 1 : 0, metadata: { output } }));
}

/** Live rows wrap the same metrics; the score follows the recorded correctness, never the status. */
function judgeForRow(task: string) {
	return createJudge<PiCodingAgentInput, RolloverLiveRow>(task, ({ output }) => ({ score: output.metrics?.correct ? 1 : 0, metadata: { row: output } }));
}

if (live) {
	const plan = validateRolloverReplay(process.env);
	const authorization = plan.authorization;
	// Credentials are read in place from the user's agent directory: no copy, no login attempt.
	// Same resolution as Pi's own `getAgentDir()`, without importing the package at runtime.
	const agentDir = process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR.replace(/^~(?=\/|$)/u, homedir())) : join(homedir(), ".pi", "agent");
	const directory = resolve(process.env.ROTOM_EVAL_SESSION_ROLLOVER_DIR ?? join(ROLLOVER_PRODUCT, ".eval/session-rollover-live"));
	const git = (args: string[]) => {
		const result = spawnSync("git", ["-C", ROLLOVER_PRODUCT, ...args], { encoding: "utf8" });
		if (result.status !== 0) throw new Error("Cannot identify replay source revision");
		return result.stdout.trim();
	};
	const contextWindow = await readStoredContextWindow(agentDir, authorization.provider, authorization.model);
	if (!contextWindow) throw new Error(`Model store has no context window for ${authorization.provider}/${authorization.model}`);
	const campaign = createLiveRolloverCampaign(authorization, {
		contextWindow,
		directory,
		repetitions: plan.repetitions,
		runtimeFactory: liveRuntimeFactory(agentDir),
		sourceCommit: git(["rev-parse", "HEAD"]),
		sourceDirty: git(["status", "--porcelain"]) !== "",
	});
	afterAll(() => {
		console.log(JSON.stringify({ sessionRolloverLive: summarizeRolloverLive(campaign.rows), directory }, null, 2));
	});
	for (const task of ROLLOVER_TASKS) {
		for (let repetition = 1; repetition <= plan.repetitions; repetition++) {
			// Alternate which arm runs first, so a warm provider cache cannot favour one of them.
			for (const candidate of repetition % 2 ? [false, true] : [true, false]) {
				const arm = candidate ? "rollover" : "native-summary";
				describeEval(`${task.id}: ${arm} repetition ${repetition}`, {
					harness: campaign.harness(task, candidate, repetition),
					judges: [judgeForRow(task.id)],
					judgeThreshold: null,
				}, (test) => {
					test(task.id, { timeout: 30 * 60_000 }, async ({ run }) => {
						const { output } = await run(task.scenario);
						// A failed run is recorded as data; only a run that never dispatched is fatal here.
						expect((output as RolloverLiveRow).status).not.toBe("not-run");
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

	// Negative controls: the check has to be able to fail, in both directions.
	// 1. Without the retrieval tool the recorded detail is unreachable, so the answer is graded wrong.
	const earlyDetail = taskById("early-detail");
	describeEval(`${earlyDetail.id}: rollover without context_recall is graded wrong`, {
		harness: createRolloverHarness(earlyDetail, true, { model: ROLLOVER_FAUX_MODEL, modelRuntimeFactory: rolloverFaux(earlyDetail), disableContextLayers: true }),
		judges: [judgeFor(`${earlyDetail.id}-no-recall`)],
		judgeThreshold: null,
	}, (test) => {
		test(earlyDetail.id, async ({ run }) => {
			const { output } = await run(earlyDetail.scenario);
			const metrics = output as RolloverMetrics;
			expect(metrics.correct).toBe(false);
			// Without the retrieval tool the extension declines the takeover, so the native summary
			// runs and still cannot carry the recorded code: the answer stays wrong.
			expect(metrics.rolloverEntries).toBe(0);
			expect(metrics.nativeSummaries).toBeGreaterThanOrEqual(1);
		});
	});

	// 2. A model that never considers the earlier rule writes the summary without it: graded wrong.
	const noHint = taskById("no-hint");
	describeEval(`${noHint.id}: ignoring the one-time rule is graded wrong`, {
		harness: createRolloverHarness(noHint, true, { model: ROLLOVER_FAUX_MODEL, modelRuntimeFactory: rolloverFaux(noHint, { behavior: "ignore" }) }),
		judges: [judgeFor(`${noHint.id}-ignored-rule`)],
		judgeThreshold: null,
	}, (test) => {
		test(noHint.id, async ({ run }) => {
			const { output } = await run(noHint.scenario);
			const metrics = output as RolloverMetrics;
			expect(metrics.correct).toBe(false);
			expect(metrics.rolloverEntries).toBeGreaterThanOrEqual(1);
		});
	});
}

describe("session rollover replay grading", () => {
	it("grades a wrong answer and a changed fixture as incorrect", async () => {
		const task = ROLLOVER_TASKS[0]!;
		const workspace = await mkdtemp(join(tmpdir(), "rollover-eval-grade-"));
		try {
			await writeRolloverFixture(workspace, task);
			expect(await gradeRollover(task, workspace, task.answer ?? "")).toBe(true);
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
