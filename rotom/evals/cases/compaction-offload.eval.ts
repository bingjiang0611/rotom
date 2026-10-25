import { describe, it } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createReplayHarness, REPLAY_TASKS } from "../src/compaction-offload-cases.ts";
import { FAUX_MODEL, replayFaux, type FauxObservation } from "../src/compaction-offload-faux.ts";
import type { ReplayMetrics } from "../src/compaction-offload-metrics.ts";
import type { PiCodingAgentInput } from "../src/pi-harness.ts";
import { evalHarnessTable } from "../src/vitest-evals/harness-table.ts";

// 04a is deliberately faux-only. Filling the authorization record does not
// silently enable paid requests: 04b must add the authorized runtime + budget gate.
if (process.env.ROTOM_EVAL_COMPACTION_OFFLOAD !== "1") {
	describe.skip("compaction offload replay requires explicit enablement", () => {
		it("does not construct a runtime or dispatch a request", () => {});
	});
} else {
	if ((process.env.ROTOM_EVAL_PROVIDER && process.env.ROTOM_EVAL_PROVIDER !== FAUX_MODEL.provider)
		|| (process.env.ROTOM_EVAL_MODEL && process.env.ROTOM_EVAL_MODEL !== FAUX_MODEL.id)) {
		throw new Error("04a is faux-only. Paid 04b needs the completed authorization record and a budget-enforcing runner.");
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
