/**
 * Rule-level ablation of the product coding-execution-hygiene policy.
 *
 * The existing `coding-execution-hygiene` eval set is a product A/B: baseline
 * build vs candidate build. It measures whether a build complies, not whether
 * any individual rule changed behaviour. A rule the model would follow anyway
 * scores identically with and without the policy, so aggregate compliance
 * overstates what the policy contributes.
 *
 * This eval set withholds one rule at a time and reports the paired difference:
 *
 *   baseline   `rule-withheld`  policy minus the rule this scenario targets
 *   candidate  `policy-full`    policy reconstructed in full
 *   candidate  `product`        unmodified product path (extension injects)
 *
 * `meanDelta` / `lift` against the `rule-withheld` baseline is therefore the
 * measured contribution of that one rule on that scenario. Each scenario is
 * bound to exactly one rule via `ruleAnchor` (see `src/coding-hygiene-cases.ts`).
 *
 * Reconstruction mechanics: the product injects the policy from
 * `extensions/coding-policy` on `before_agent_start`, which fires per turn after
 * prompt submission, so an eval-side prompt transform cannot subtract it. The
 * two reconstructed arms therefore exclude the `coding-policy` resource and
 * re-inject the wanted subset through an inline extension using that same hook,
 * so the policy lands in the same position with no other prompt difference.
 * Known second-order difference: excluding the product extension also drops
 * `repair-hints` and the Pi-runtime-drift re-attribution.
 * Those fire only on tool errors and assistant error stop reasons; these
 * scenarios plan without executing tools. The `product` vs `policy-full`
 * comparison is what surfaces it if a run does hit that path.
 *
 * Scope: this measures planning behaviour on frozen synthetic scenarios under
 * one model. It does not establish that a low-delta rule is safe to delete from
 * real coding sessions.
 */
import { resolve } from "node:path";
import { describe } from "vitest";
import { describeEval } from "vitest-evals";
import {
	codingHygieneCases,
	hygienePolicyInlineExtension,
	type HygieneOutput,
	readHygienePolicy,
	resolveHygieneRule,
} from "../src/coding-hygiene-cases.ts";
import { createPiCodingAgentHarness } from "../src/pi-harness.ts";
import { evalHarnessTable } from "../src/vitest-evals/harness-table.ts";

export const CODING_POLICY_RESOURCE_KEY = "extension:coding-policy";

const enabled = process.env.ROTOM_EVAL_HYGIENE_RULE_ABLATION === "1";
const provider = process.env.ROTOM_EVAL_PROVIDER?.trim();
const model = process.env.ROTOM_EVAL_MODEL?.trim();
const candidateProduct = process.env.ROTOM_EVAL_CANDIDATE_PRODUCT?.trim() || resolve(import.meta.dirname, "../..");
const repetitions = Number(process.env.ROTOM_EVAL_HYGIENE_RULE_ABLATION_REPEATS ?? "2");
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("ROTOM_EVAL_HYGIENE_RULE_ABLATION_REPEATS must be an integer from 1 to 5.");

if (!enabled || !provider || !model) {
	describe.skip("coding hygiene rule ablation requires ROTOM_EVAL_HYGIENE_RULE_ABLATION=1, provider, and model", () => {});
} else {
	const selectedModel = { provider, id: model };
	const policy = readHygienePolicy(candidateProduct);

	// Every arm keeps the identical tool selection. The product policy only
	// injects when a coding tool is active, so switching this to `noTools`
	// would silently collapse `product` onto `rule-withheld`.
	function harness(name: string, options: { withheldRule?: string; reconstruct: boolean }) {
		return createPiCodingAgentHarness<HygieneOutput>({
			name,
			model: selectedModel,
			thinkingLevel: "low",
			tools: ["bash", "edit"],
			productAgentDir: candidateProduct,
			...(options.reconstruct
				? {
					excludedResourceKeys: [CODING_POLICY_RESOURCE_KEY],
					inlineExtensions: [hygienePolicyInlineExtension(policy, options.withheldRule ? [options.withheldRule] : [])],
				}
				: {}),
			output: ({ response }) => ({ response }),
		});
	}

	function rows(label: string, withheldRule: string) {
		const planned = evalHarnessTable(label, {
			baseline: harness("rule-withheld", { withheldRule, reconstruct: true }),
			candidates: [
				harness("policy-full", { reconstruct: true }),
				harness("product", { reconstruct: false }),
			],
			repetitions,
		});
		return Array.from({ length: repetitions }, (_, index) => {
			const repeated = planned.filter(({ repetition }) => repetition === index + 1);
			return index % 2 === 0 ? repeated : [...repeated].reverse();
		}).flat();
	}

	for (const item of codingHygieneCases) {
		const withheldRule = resolveHygieneRule(policy, item.ruleAnchor);
		for (const row of rows(item.label, withheldRule)) {
			describeEval(
				`${item.label}: ${row.name} repetition ${String(row.repetition)}`,
				{
					harness: row.harness,
					judges: [item.judge],
					// Only the unmodified product path is gated. A withheld arm is
					// expected to score lower, and reconstruction equivalence is
					// proven deterministically in
					// `test/coding-hygiene-rule-ablation.test.ts` rather than by
					// gating a sampled score.
					judgeThreshold: row.name === "product" ? 1 : null,
				},
				(it) => {
					it(item.label, async ({ run }) => {
						await run(item.scenario);
					});
				},
			);
		}
	}
}
