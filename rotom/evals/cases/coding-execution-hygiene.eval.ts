import { resolve } from "node:path";
import { describe } from "vitest";
import { describeEval } from "vitest-evals";
import { codingHygieneCases, type HygieneOutput } from "../src/coding-hygiene-cases.ts";
import { createPiCodingAgentHarness } from "../src/pi-harness.ts";
import { evalHarnessTable } from "../src/vitest-evals/harness-table.ts";

const provider = process.env.ROTOM_EVAL_PROVIDER?.trim();
const model = process.env.ROTOM_EVAL_MODEL?.trim();
const baselineProduct = process.env.ROTOM_EVAL_BASELINE_PRODUCT?.trim();
const candidateProduct = process.env.ROTOM_EVAL_CANDIDATE_PRODUCT?.trim() || resolve(import.meta.dirname, "../..");
const repetitions = Number(process.env.ROTOM_EVAL_REPEATS ?? "2");
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("ROTOM_EVAL_REPEATS must be an integer from 1 to 5.");


if (!provider || !model || !baselineProduct) {
	describe.skip("coding execution hygiene A/B requires provider, model, and ROTOM_EVAL_BASELINE_PRODUCT", () => {});
} else {
	const selectedModel = { provider, id: model };
	const baselineProductPath = baselineProduct;
	function harness(name: string, productAgentDir: string) {
		return createPiCodingAgentHarness<HygieneOutput>({ name, model: selectedModel, thinkingLevel: "low", tools: ["bash", "edit"], productAgentDir, output: ({ response }) => ({ response }) });
	}
	function rows(label: string) {
		const planned = evalHarnessTable(label, { baseline: harness("baseline", baselineProductPath), candidate: harness("candidate", candidateProduct), repetitions });
		return Array.from({ length: repetitions }, (_, index) => { const repeated = planned.filter(({ repetition }) => repetition === index + 1); return index % 2 === 0 ? repeated : [...repeated].reverse(); }).flat();
	}
	for (const item of codingHygieneCases) for (const row of rows(item.label)) describeEval(`${item.label}: ${row.name} repetition ${String(row.repetition)}`, { harness: row.harness, judges: [item.judge], judgeThreshold: row.name === "candidate" ? 1 : null }, (it) => { it(item.label, async ({ run }) => { await run(item.scenario); }); });
}
