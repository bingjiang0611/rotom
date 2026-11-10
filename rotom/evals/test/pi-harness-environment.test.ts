import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { baselineArmOverrides, withExclusiveEnvironment } from "../src/pi-harness-environment.ts";
import { selectProductResources } from "../src/product-runtime.ts";

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

async function products() {
	root = await mkdtemp(join(tmpdir(), "rotom-arms-"));
	const baseline = join(root, "baseline", "rotom");
	const candidate = join(root, "candidate", "rotom");
	await mkdir(baseline, { recursive: true });
	await mkdir(candidate, { recursive: true });
	return { baseline, candidate };
}

describe("baseline arm overrides", () => {
	it("apply only to the arm whose product is the baseline", async () => {
		const { baseline, candidate } = await products();
		const env = {
			ROTOM_EVAL_BASELINE_PRODUCT: baseline,
			ROTOM_EVAL_CANDIDATE_PRODUCT: candidate,
			ROTOM_EVAL_BASELINE_EXCLUDE_RESOURCES: "extension:coding-policy, ",
			ROTOM_EVAL_BASELINE_ENV: JSON.stringify({ ROTOM_EVIDENCE_REDUCER: "0" }),
		};
		expect(baselineArmOverrides(baseline, env)).toEqual({ excludedResourceKeys: ["extension:coding-policy"], environment: { ROTOM_EVIDENCE_REDUCER: "0" } });
		expect(baselineArmOverrides(`${baseline}/`, env).excludedResourceKeys).toEqual(["extension:coding-policy"]);
		expect(baselineArmOverrides(candidate, env)).toEqual({ excludedResourceKeys: [], environment: {} });
	});

	it("are inert when unset", async () => {
		const { baseline } = await products();
		expect(baselineArmOverrides(baseline, { ROTOM_EVAL_BASELINE_PRODUCT: baseline })).toEqual({ excludedResourceKeys: [], environment: {} });
	});

	it("refuse a configuration that would hit both arms or no arm", async () => {
		const { baseline } = await products();
		const keys = { ROTOM_EVAL_BASELINE_EXCLUDE_RESOURCES: "extension:coding-policy" };
		expect(() => baselineArmOverrides(baseline, keys)).toThrow(/require ROTOM_EVAL_BASELINE_PRODUCT/u);
		expect(() => baselineArmOverrides(baseline, { ...keys, ROTOM_EVAL_BASELINE_PRODUCT: baseline, ROTOM_EVAL_CANDIDATE_PRODUCT: baseline })).toThrow(/distinct from the candidate/u);
		// Without an explicit candidate, suites use this checkout's product.
		expect(() => baselineArmOverrides(baseline, { ...keys, ROTOM_EVAL_BASELINE_PRODUCT: baseline, ROTOM_PRODUCT_AGENT_DIR: baseline })).toThrow(/distinct from the candidate/u);
	});

	it("accept only ROTOM_* string variables that do not steer the harness or Pi identity", async () => {
		const { baseline, candidate } = await products();
		const base = { ROTOM_EVAL_BASELINE_PRODUCT: baseline, ROTOM_EVAL_CANDIDATE_PRODUCT: candidate };
		for (const value of ["[]", "not json", JSON.stringify({ PATH: "/x" }), JSON.stringify({ ROTOM_PI: "/x" }), JSON.stringify({ ROTOM_EVAL_MODEL: "x" }), JSON.stringify({ ROTOM_QODER: 0 })]) {
			expect(() => baselineArmOverrides(baseline, { ...base, ROTOM_EVAL_BASELINE_ENV: value }), value).toThrow();
		}
	});
});

describe("product resource selection", () => {
	const resources = [{ kind: "extension", id: "coding-policy", path: "extensions/coding-policy", requiredFiles: [] }, { kind: "skill", id: "pi-subagents", path: "skills/pi-subagents", requiredFiles: [] }] as const;
	it("rejects an unknown key instead of leaving the arm unchanged", () => {
		expect(selectProductResources(resources as never, ["extension:coding-policy"]).map((resource) => resource.id)).toEqual(["pi-subagents"]);
		expect(() => selectProductResources(resources as never, ["extension:coding-polcy"])).toThrow(/Unknown product resource key/u);
	});
});

describe("environment scoping", () => {
	it("restores the caller's values after each run", async () => {
		const before = process.env.ROTOM_ARM_SCOPE_PROBE;
		await withExclusiveEnvironment({ ROTOM_ARM_SCOPE_PROBE: "inside" }, async () => expect(process.env.ROTOM_ARM_SCOPE_PROBE).toBe("inside"));
		expect(process.env.ROTOM_ARM_SCOPE_PROBE).toBe(before);
	});
});

describe("baseline arm exclusion in a real request", () => {
	it("drops the coding-policy section only from the baseline arm's provider request", async () => {
		const { resolve: resolvePath } = await import("node:path");
		const { pathToFileURL } = await import("node:url");
		const { createPiCodingAgentHarness } = await import("../src/pi-harness.ts");
		const { defaultProductAgentDir } = await import("../src/product-runtime.ts");
		const { readHygienePolicy } = await import("../src/coding-hygiene-cases.ts");
		const productDir = defaultProductAgentDir();
		const policy = readHygienePolicy(productDir);
		const otherArm = await mkdtemp(join(tmpdir(), "rotom-other-arm-"));
		const systemFor = async (environment: Record<string, string>) => {
			let system = "";
			const saved = { ...process.env };
			Object.assign(process.env, environment);
			try {
				const harness = createPiCodingAgentHarness({
					name: "arm-exclusion", productAgentDir: productDir,
					model: { provider: "arm-faux", id: "fixture" }, tools: ["read", "bash", "edit"],
					async modelRuntimeFactory({ product, configDir }) {
						const { fauxAssistantMessage, fauxProvider, getCurrentSystemPrompt } = await import(pathToFileURL(resolvePath(product.verified.packageRoot, "../pi-ai/dist/index.js")).href);
						const faux = fauxProvider({ provider: "arm-faux", models: [{ id: "fixture", contextWindow: 32000, maxTokens: 1024 }] });
						faux.setResponses([(context: { messages: unknown[] }) => { system = getCurrentSystemPrompt(context.messages); return fauxAssistantMessage("ok"); }]);
						const runtime = await product.runtime.ModelRuntime.create({ authPath: resolvePath(configDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
						runtime.registerNativeProvider(faux.provider);
						return runtime;
					},
				});
				await harness.run("Reply briefly; do not call tools.", { artifacts: {}, setArtifact() {} });
			} finally {
				for (const key of Object.keys(environment)) {
					if (saved[key] === undefined) delete process.env[key];
					else process.env[key] = saved[key];
				}
			}
			return system;
		};
		try {
			const exclusion = { ROTOM_EVAL_BASELINE_EXCLUDE_RESOURCES: "extension:coding-policy" };
			const asBaseline = await systemFor({ ...exclusion, ROTOM_EVAL_BASELINE_PRODUCT: productDir, ROTOM_EVAL_CANDIDATE_PRODUCT: otherArm });
			const asCandidate = await systemFor({ ...exclusion, ROTOM_EVAL_BASELINE_PRODUCT: otherArm, ROTOM_EVAL_CANDIDATE_PRODUCT: productDir });
			expect(asBaseline.length).toBeGreaterThan(0);
			expect(asBaseline).not.toContain(policy.followThrough);
			expect(asCandidate).toContain(policy.followThrough);
		} finally {
			await rm(otherArm, { recursive: true, force: true });
		}
	}, 120_000);
});
