import { resolve } from "node:path";
import { describe } from "vitest";
import { describeEval } from "vitest-evals";
import { subagentAbCases } from "../src/subagent-ab-cases.ts";
import { subagentAbHarness, subagentAbJudge, subagentAbStoreRoot } from "../src/subagent-ab-harness.ts";
import { evalHarnessTable } from "../src/vitest-evals/harness-table.ts";

/**
 * Subagent on/off pairing (optimization plan P1-4): one product, the same read-only
 * tools, and the candidate arm also has subagent/subagent_wait. Scores are answer
 * correctness against a generated fixture; parent usage and tool counts ride along.
 * Child-run usage lives in the private Subagent store of this run, not in the score.
 *
 * Gated: ROTOM_EVAL_SUBAGENT_AB=1 plus ROTOM_EVAL_PROVIDER and ROTOM_EVAL_MODEL.
 * Real model calls in both arms and in every child; needs explicit authorization.
 */
const enabled = process.env.ROTOM_EVAL_SUBAGENT_AB === "1";
const provider = process.env.ROTOM_EVAL_PROVIDER?.trim();
const model = process.env.ROTOM_EVAL_MODEL?.trim();
const product = process.env.ROTOM_EVAL_CANDIDATE_PRODUCT?.trim() || resolve(import.meta.dirname, "../..");
const repetitions = Number(process.env.ROTOM_EVAL_SUBAGENT_AB_REPEATS ?? "1");
const selected = process.env.ROTOM_EVAL_SUBAGENT_AB_CASE?.trim();
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("ROTOM_EVAL_SUBAGENT_AB_REPEATS must be an integer from 1 to 5.");
if (selected && !subagentAbCases.some((item) => item.id === selected)) throw new Error("Unknown ROTOM_EVAL_SUBAGENT_AB_CASE.");

if (!enabled || !provider || !model) {
	describe.skip("Subagent A/B requires ROTOM_EVAL_SUBAGENT_AB=1, provider and model", () => {});
} else {
	const storeRoot = await subagentAbStoreRoot();
	for (const item of subagentAbCases.filter((candidate) => !selected || candidate.id === selected)) {
		const planned = evalHarnessTable(`Subagent A/B: ${item.label}`, {
			baseline: subagentAbHarness({ arm: "baseline", productAgentDir: product, storeRoot, model: { provider, id: model } }),
			candidate: subagentAbHarness({ arm: "candidate", productAgentDir: product, storeRoot, model: { provider, id: model } }),
			repetitions,
		});
		// Alternate arm order per repetition, as the other paired suites do.
		const rows = Array.from({ length: repetitions }, (_, index) => {
			const repeated = planned.filter(({ repetition }) => repetition === index + 1);
			return index % 2 === 0 ? repeated : [...repeated].reverse();
		}).flat();
		for (const row of rows) {
			describeEval(`${item.label}: ${row.name} repetition ${String(row.repetition)}`, {
				harness: row.harness,
				judges: [subagentAbJudge(item.id)],
				judgeThreshold: null,
			}, (it) => {
				it(item.label, async ({ run }) => { await run({ id: item.id, steps: [{ type: "prompt", content: item.prompt }] }); });
			});
		}
	}
}
