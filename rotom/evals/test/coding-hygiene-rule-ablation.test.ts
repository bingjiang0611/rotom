/**
 * Deterministic construction proof for the hygiene rule ablation.
 *
 * The ablation's validity rests on three claims that must not be assumed:
 *   1. the policy parses into discrete rules and rebuilds byte for byte;
 *   2. each scenario's `ruleAnchor` names exactly one distinct rule;
 *   3. the arms really do send the intended rule set to the provider.
 *
 * Claim 3 is the one an eval-side reconstruction can silently get wrong, because
 * the product injects the policy on `before_agent_start` rather than into the
 * stored session prompt. A faux provider captures the system prompt actually
 * streamed, so this runs with no model spend.
 */
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import type { HarnessContext } from "vitest-evals/harness";
import { CODING_POLICY_RESOURCE_KEY } from "../cases/coding-hygiene-rule-ablation.eval.ts";
import {
	codingHygieneCases,
	hygienePolicyInlineExtension,
	hygienePolicyText,
	readHygienePolicy,
	resolveHygieneRule,
} from "../src/coding-hygiene-cases.ts";
import { createPiCodingAgentHarness } from "../src/pi-harness.ts";

const productAgentDir = resolve(import.meta.dirname, "../..");
const policy = readHygienePolicy(productAgentDir);

async function findPiAiEntry(packageRoot: string): Promise<string> {
	let directory = packageRoot;
	for (;;) {
		const candidate = resolve(directory, "node_modules/@earendil-works/pi-ai/dist/index.js");
		if (await access(candidate).then(() => true, () => false)) return candidate;
		const parent = dirname(directory);
		if (parent === directory) throw new Error(`Cannot resolve pi-ai from ${packageRoot}`);
		directory = parent;
	}
}

type PromptCapture = { systemPrompts: string[] };

/** Mirrors the arm construction in `cases/coding-hygiene-rule-ablation.eval.ts`. */
function createArmHarness(name: string, options: { withheldRule?: string; reconstruct: boolean }, capture: PromptCapture) {
	return createPiCodingAgentHarness({
		name,
		model: { provider: "dev-agent-hygiene-ablation-faux", id: "fixture" },
		piExecutable: process.env.ROTOM_TEST_PI,
		allowHostSideEffects: true,
		thinkingLevel: "low",
		tools: ["bash", "edit"],
		productAgentDir,
		noContextFiles: true,
		...(options.reconstruct
			? {
				excludedResourceKeys: [CODING_POLICY_RESOURCE_KEY],
				inlineExtensions: [hygienePolicyInlineExtension(policy, options.withheldRule ? [options.withheldRule] : [])],
			}
			: {}),
		async modelRuntimeFactory({ product, configDir }) {
			const piAiEntry = await findPiAiEntry(product.verified.packageRoot);
			const { fauxAssistantMessage, fauxProvider } = await import(pathToFileURL(piAiEntry).href);
			const faux = fauxProvider({
				provider: "dev-agent-hygiene-ablation-faux",
				models: [{ id: "fixture", contextWindow: 64_000, maxTokens: 1_024 }],
			});
			faux.setResponses([(context: { systemPrompt?: string }) => {
				capture.systemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("{}");
			}]);
			const modelRuntime = await product.runtime.ModelRuntime.create({
				authPath: resolve(configDir, "auth.json"),
				modelsPath: null,
				refreshOnCreate: false,
			});
			modelRuntime.registerNativeProvider(faux.provider);
			return modelRuntime;
		},
		output: ({ response }) => ({ response }),
	});
}

async function sentSystemPrompt(options: { withheldRule?: string; reconstruct: boolean }): Promise<string> {
	const capture: PromptCapture = { systemPrompts: [] };
	const harness = createArmHarness("arm", options, capture);
	const artifacts: HarnessContext["artifacts"] = {};
	await harness.run(codingHygieneCases[0].scenario, {
		artifacts,
		setArtifact(name, value) { artifacts[name] = value; },
	});
	expect(capture.systemPrompts).toHaveLength(1);
	return capture.systemPrompts[0] as string;
}

it("parses the product policy into rules that rebuild byte for byte", () => {
	expect(policy.rules.length).toBeGreaterThanOrEqual(2);
	expect(new Set(policy.rules).size).toBe(policy.rules.length);
	expect(hygienePolicyText(policy)).toBe(policy.body);
});

it("binds every scenario to exactly one distinct rule", () => {
	const resolved = codingHygieneCases.map((item) => resolveHygieneRule(policy, item.ruleAnchor));
	expect(new Set(resolved).size).toBe(codingHygieneCases.length);
	for (const rule of resolved) expect(policy.rules).toContain(rule);
});

it("rejects a rule anchor that stops matching exactly one rule", () => {
	expect(() => resolveHygieneRule(policy, "definitely-not-in-any-rule")).toThrow(/matched 0 rules/u);
	expect(() => resolveHygieneRule(policy, "")).toThrow(/expected exactly 1/u);
});

it("sends every rule on the unmodified product path", async () => {
	const prompt = await sentSystemPrompt({ reconstruct: false });
	expect(prompt).toContain(policy.header);
	for (const rule of policy.rules) expect(prompt).toContain(rule);
});

// Each run gets a fresh temp workspace, so the cwd footer is the one legitimate
// difference between two otherwise identical prompts.
function normalizeWorkspacePaths(prompt: string): string {
	return prompt.replaceAll(/dev-agent-eval-[A-Za-z0-9]+/gu, "dev-agent-eval-WORKSPACE");
}

it("reconstructs a prompt byte-identical to the product path", async () => {
	const [product, reconstructed] = await Promise.all([
		sentSystemPrompt({ reconstruct: false }),
		sentSystemPrompt({ reconstruct: true }),
	]);
	expect(reconstructed).toContain(policy.body);
	expect(product).toContain(policy.body);
	// Equality is the real validity gate for the ablation: any extra or missing
	// content in a reconstructed arm (for example Pi's skill catalogue emitted
	// twice) would show up as a prompt-size confound in every reported delta.
	expect(normalizeWorkspacePaths(reconstructed)).toBe(normalizeWorkspacePaths(product));
});

it("withholds exactly the targeted rule and keeps the rest", async () => {
	const target = resolveHygieneRule(policy, codingHygieneCases[0].ruleAnchor);
	const prompt = await sentSystemPrompt({ withheldRule: target, reconstruct: true });
	expect(prompt).not.toContain(target);
	expect(prompt).toContain(policy.header);
	for (const rule of policy.rules) {
		if (rule === target) continue;
		expect(prompt).toContain(rule);
	}
});
