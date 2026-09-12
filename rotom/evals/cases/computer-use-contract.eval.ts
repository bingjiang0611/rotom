import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import type { JsonValue } from "vitest-evals/harness";
import { createPiCodingAgentHarness, type PiCodingAgentInput, type PiCodingAgentScenario } from "../src/pi-harness.ts";
import { evalHarnessTable } from "../src/vitest-evals/harness-table.ts";

/**
 * Paired A/B for the product's Computer Use contract guidelines.
 *
 * The guideline projection is extracted from each product's own
 * `extensions/third-party/computer-use/recovery.ts`, so the compared text is
 * exactly what that product would attach to act_ui/wait_for/search_ui — not a
 * hand-written variant. Tools stay disabled: this measures the decision the
 * text produces, and it does not replace real desktop Computer Use L2/L3 or
 * the deterministic recovery guards.
 */

const enabled = process.env.ROTOM_EVAL_COMPUTER_USE_CONTRACT === "1";
const provider = process.env.ROTOM_EVAL_PROVIDER?.trim();
const model = process.env.ROTOM_EVAL_MODEL?.trim();
const baselineProduct = process.env.ROTOM_EVAL_BASELINE_PRODUCT?.trim();
const candidateProduct = process.env.ROTOM_EVAL_CANDIDATE_PRODUCT?.trim() || resolve(import.meta.dirname, "../..");
const repetitions = Number(process.env.ROTOM_EVAL_COMPUTER_USE_CONTRACT_REPEATS ?? "2");
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("ROTOM_EVAL_COMPUTER_USE_CONTRACT_REPEATS must be an integer from 1 to 5.");

const GUIDELINE_CONSTANT = /export const (COMPUTER_USE_[A-Z_]*GUIDELINE)\s*=\s*\n?\s*"((?:[^"\\]|\\.)*)"\s*;/gu;

function guidelineProjection(productAgentDir: string): string {
	const source = readFileSync(join(productAgentDir, "extensions/third-party/computer-use/recovery.ts"), "utf8");
	const lines: string[] = [];
	for (const match of source.matchAll(GUIDELINE_CONSTANT)) {
		lines.push(`- ${JSON.parse(`"${match[2]}"`) as string}`);
	}
	if (lines.length === 0) throw new Error(`No Computer Use guidelines found in ${productAgentDir}`);
	return `Active act_ui / wait_for / search_ui guidelines for this product:\n${lines.join("\n")}`;
}

type PlanOutput = { response: string; guidelineCount: number };
type RecordValue = Record<string, JsonValue>;

function parseObject(response: string): RecordValue | undefined {
	const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1] ?? response;
	const start = fenced.indexOf("{");
	const end = fenced.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		const parsed = JSON.parse(fenced.slice(start, end + 1));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as RecordValue : undefined;
	} catch { return undefined; }
}

function text(value: JsonValue | undefined): string {
	return typeof value === "string" ? value.toLowerCase() : "";
}

function stringList(value: JsonValue | undefined): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase()) : [];
}

const focusJudge = createJudge<PiCodingAgentInput, PlanOutput>("ComputerUseFocusScopeJudge", ({ output }) => {
	const plan = parseObject(output.response);
	const target = text(plan?.typeTextTarget);
	const checks = {
		json: plan !== undefined,
		focusNotCarried: plan?.focusCarriesToNextActCall === false,
		needsExplicitTarget: plan?.mayOmitRefInNewCall === false,
		targetIsRefOrCoordinates: /\bref\b|x and y|coordinates/u.test(target) && !/focus/u.test(target),
		batchAlternative: /same|one|single/u.test(text(plan?.howToReuseFocus)) && /act_ui|actions/u.test(text(plan?.howToReuseFocus)),
	};
	return { score: Object.values(checks).filter(Boolean).length / Object.keys(checks).length, metadata: { rationale: JSON.stringify(checks), output: { checks, guidelineCount: output.guidelineCount, plan: plan ?? null } } };
});

const conditionJudge = createJudge<PiCodingAgentInput, PlanOutput>("ComputerUseConditionJudge", ({ output }) => {
	const plan = parseObject(output.response);
	const missing = stringList(plan?.missingFields);
	const checks = {
		json: plan !== undefined,
		rejectsRoleOnly: plan?.conditionIsValid === false,
		namesRequiredAddition: missing.some((field) => /text|value|scoperef|ref/u.test(field)),
		repairedConditionScoped: /text|scoperef|\bref\b/u.test(text(plan?.repairedCondition)),
		noBlindRetry: plan?.retrySameConditionUnchanged === false,
	};
	return { score: Object.values(checks).filter(Boolean).length / Object.keys(checks).length, metadata: { rationale: JSON.stringify(checks), output: { checks, guidelineCount: output.guidelineCount, plan: plan ?? null } } };
});

const focusScenario: PiCodingAgentScenario = {
	id: "computer-use-focus-scope",
	steps: [{ type: "prompt", content: `One act_ui call already clicked the editable search field of the controlled window and it succeeded. You now issue a SEPARATE, later act_ui call whose only action is typeText for that field. Plan it without executing tools. Return only one JSON object with exactly these fields: focusCarriesToNextActCall (boolean), mayOmitRefInNewCall (boolean), typeTextTarget (string), howToReuseFocus (string). Do not call tools.` }],
};

const conditionScenario: PiCodingAgentScenario = {
	id: "computer-use-condition",
	steps: [{ type: "prompt", content: `You called wait_for with only stateId, role "button" and timeoutMs 5000, and it failed with: "A role-only UI condition requires ref or scopeRef." Plan the repair without executing tools. Return only one JSON object with exactly these fields: conditionIsValid (boolean, whether the original role-only condition was a valid condition), missingFields (array of strings), repairedCondition (string), retrySameConditionUnchanged (boolean). Do not call tools.` }],
};

if (!enabled || !provider || !model || !baselineProduct) {
	describe.skip("Computer Use contract A/B requires ROTOM_EVAL_COMPUTER_USE_CONTRACT=1, provider, model, and ROTOM_EVAL_BASELINE_PRODUCT", () => {});
} else {
	const selectedModel = { provider, id: model };
	const baselineProductPath = baselineProduct;
	function createHarness(name: string, productAgentDir: string) {
		const projection = guidelineProjection(productAgentDir);
		const guidelineCount = projection.split("\n").length - 1;
		return createPiCodingAgentHarness<PlanOutput>({
			name,
			model: selectedModel,
			thinkingLevel: "low",
			noTools: "all",
			productAgentDir,
			transformSystemPrompt: (defaultPrompt) => `${defaultPrompt}\n\n${projection}`,
			output: ({ response }) => ({ response, guidelineCount }),
		});
	}
	function rowsFor(label: string) {
		const planned = evalHarnessTable(label, {
			baseline: createHarness("baseline", baselineProductPath),
			candidate: createHarness("candidate", candidateProduct),
			repetitions,
		});
		return Array.from({ length: repetitions }, (_, index) => {
			const repeated = planned.filter(({ repetition }) => repetition === index + 1);
			return index % 2 === 0 ? repeated : [...repeated].reverse();
		}).flat();
	}
	for (const row of rowsFor("focus scope")) {
		describeEval(`focus scope: ${row.name} repetition ${String(row.repetition)}`, {
			harness: row.harness,
			judges: [focusJudge],
			judgeThreshold: null,
		}, (it) => { it("plans an explicitly targeted typeText", async ({ run }) => { await run(focusScenario); }); });
	}
	for (const row of rowsFor("condition repair")) {
		describeEval(`condition repair: ${row.name} repetition ${String(row.repetition)}`, {
			harness: row.harness,
			judges: [conditionJudge],
			judgeThreshold: null,
		}, (it) => { it("repairs a role-only condition", async ({ run }) => { await run(conditionScenario); }); });
	}
}
