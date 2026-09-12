import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createPiCodingAgentHarness, type PiCodingAgentInput } from "../src/pi-harness.ts";
import { ownershipHandoffCases, ownershipOutputInstruction, scoreOwnershipHandoff } from "../src/ownership-handoff-cases.ts";
import { evalHarnessTable } from "../src/vitest-evals/harness-table.ts";

const enabled = process.env.ROTOM_EVAL_OWNERSHIP_HANDOFF === "1";
const baseline = process.env.ROTOM_EVAL_BASELINE_PRODUCT;
const candidate = process.env.ROTOM_EVAL_CANDIDATE_PRODUCT;
const selected = process.env.ROTOM_EVAL_OWNERSHIP_CASE;
const provider = process.env.ROTOM_EVAL_PROVIDER;
const model = process.env.ROTOM_EVAL_MODEL;
if (selected && !ownershipHandoffCases.some((item) => item.id === selected)) throw new Error("Unknown fixed ownership case");

function policy(product: string) {
	const source = readFileSync(join(product, "extensions/third-party/subagent/policy.ts"), "utf8");
	const lines = [...source.matchAll(/export const (?:PRODUCT_SUBAGENT_POLICY_GUIDELINE|PRODUCT_HANDOFF_GUIDELINE)\s*=\s*"((?:[^"\\]|\\.)*)";/gu)].map((match) => JSON.parse(`"${match[1]}"`) as string);
	if (!lines.length) throw new Error("Product policy projection missing");
	return lines.join("\n");
}

if (!enabled || !baseline || !candidate || !provider || !model) {
	describe.skip("ownership handoff A/B requires explicit enable, two frozen products and model", () => {});
} else {
	for (const [index, item] of ownershipHandoffCases.entries()) {
		if (selected && item.id !== selected) continue;
		const judge = createJudge<PiCodingAgentInput, { response: string }>(`Ownership-${item.id}`, ({ output }) => {
			const result = scoreOwnershipHandoff(item.id, output.response);
			return { score: result.score, metadata: { rationale: JSON.stringify(result.checks), output: result.checks } };
		});
		function harness(name: string, product: string) {
			const projection = policy(product);
			return createPiCodingAgentHarness({
				name, model: { provider: provider!, id: model! }, thinkingLevel: "medium", noTools: "all", productAgentDir: product,
				transformSystemPrompt: (prompt) => `${prompt}\n\nActive product Subagent/handoff policy projection (tools disabled for this decision-only experiment):\n${projection}`,
				output: ({ response }) => ({ response }),
			});
		}
		const rows = evalHarnessTable("ownership-handoff", { baseline: harness("baseline", baseline), candidate: harness("candidate", candidate), repetitions: 1 });
		if (index % 2 === 1) rows.reverse();
		for (const row of rows) {
			describeEval(`${item.id}: ${row.name}`, { harness: row.harness, judges: [judge], judgeThreshold: null }, (it) => {
				it("fixed ownership and evidence decision", async ({ run }) => { await run({ id: item.id, steps: [{ type: "prompt", content: `${item.task}\n\n${ownershipOutputInstruction}` }] }); });
			});
		}
	}
}
