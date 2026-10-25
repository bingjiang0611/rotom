import { describe, it } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createReplayHarness, REPLAY_TASKS, LIVE_AUTHORIZATION } from "../src/compaction-offload-cases.ts";
import { FAUX_MODEL, replayFaux, type FauxObservation } from "../src/compaction-offload-faux.ts";
import type { ReplayMetrics } from "../src/compaction-offload-metrics.ts";
import type { PiCodingAgentInput } from "../src/pi-harness.ts";
import { evalHarnessTable } from "../src/vitest-evals/harness-table.ts";
import { validateLiveReplay } from "../src/compaction-offload-budget.ts";
import { createLiveReplayCampaign } from "../src/compaction-offload-live.ts";
import type { LiveReplayRow } from "../src/compaction-offload-store.ts";

// Authorization constants alone never enable live execution.
const live = process.env.ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE === "1";
if (process.env.ROTOM_EVAL_COMPACTION_OFFLOAD !== "1" && !live) {
	describe.skip("compaction offload replay requires explicit enablement", () => {
		it("does not construct a runtime or dispatch a request", () => {});
	});
} else if (live) {
	const plan = validateLiveReplay(process.env, LIVE_AUTHORIZATION);
	const campaign = createLiveReplayCampaign(plan.authorization, { repetitions: plan.repetitions });
	for (const task of REPLAY_TASKS) for (let repetition = 1; repetition <= plan.repetitions; repetition++) {
		for (const candidate of repetition % 2 ? [false, true] : [true, false]) {
			const arm = candidate ? "candidate" : "baseline";
			describeEval(`${task.id}: ${arm} repetition ${repetition}`, {
				harness: campaign.harness(task, candidate, repetition),
				judges: [createJudge<PiCodingAgentInput, LiveReplayRow>(task.id, ({ output }) => ({
					score: output.status === "completed" && output.metrics?.correct ? 1 : 0, metadata: { output },
				}))], judgeThreshold: 1,
			}, (test) => { test(task.id, async ({ run }) => { await run(task.scenario); }); });
		}
	}
} else {
	if ((process.env.ROTOM_EVAL_PROVIDER && process.env.ROTOM_EVAL_PROVIDER !== FAUX_MODEL.provider)
		|| (process.env.ROTOM_EVAL_MODEL && process.env.ROTOM_EVAL_MODEL !== FAUX_MODEL.id)) {
		throw new Error("04a is faux-only. Live replay also requires ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE=1 and an exact authorized selection.");
	}
	const repetitions = Number(process.env.ROTOM_EVAL_REPETITIONS ?? "3");
	if (![3, 5].includes(repetitions)) throw new Error("Replay repetitions must be 3 or 5");
	for (const task of REPLAY_TASKS) {
		const arm = (candidate: boolean) => {
			const observed: FauxObservation = { requests: [], config: null, agentDirMatches: false, summaryCalls: 0 };
			return createReplayHarness(task, candidate, { model: FAUX_MODEL, modelRuntimeFactory: replayFaux(task, observed) });
		};
		const rows = evalHarnessTable(`Compaction offload: ${task.id}`, { baseline: arm(false), candidate: arm(true), repetitions });
		const ordered = Array.from({ length: repetitions }, (_, i) => {
			const pair = rows.filter((row) => row.repetition === i + 1);
			return i % 2 ? pair.reverse() : pair;
		}).flat();
		for (const row of ordered) describeEval(`${task.id}: ${row.name} repetition ${row.repetition}`, {
			harness: row.harness,
			judges: [createJudge<PiCodingAgentInput, ReplayMetrics>(task.id, ({ output }) => ({ score: output.correct ? 1 : 0, metadata: { output } }))],
			judgeThreshold: 1,
		}, (test) => { test(task.id, async ({ run }) => { await run(task.scenario); }); });
	}
}
