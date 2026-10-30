import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { createPiCodingAgentHarness } from "../src/pi-harness.ts";
import { defaultProductAgentDir } from "../src/product-runtime.ts";
import { readHygienePolicy } from "../src/coding-hygiene-cases.ts";
import { fixtureExecutionPolicy } from "../src/fixture-tools.ts";

it.each([false, true])("preserves product policy and the caller fixture contract in the provider request (contract=%s)", async (includeFixtureContract) => {
	const productDir = defaultProductAgentDir();
	const expected = readHygienePolicy(productDir);
	let system = "";
	const harness = createPiCodingAgentHarness({
		name: "coding-policy-request", productAgentDir: productDir,
		model: { provider: "coding-policy-faux", id: "fixture" }, tools: ["read", "bash", "edit"],
		inlineExtensions: includeFixtureContract ? [(pi) => { pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${fixtureExecutionPolicy}` })); }] : [],
		async modelRuntimeFactory({ product, configDir }) {
			const entry = resolve(product.verified.packageRoot, "../pi-ai/dist/index.js");
			const { fauxAssistantMessage, fauxProvider, getCurrentSystemPrompt } = await import(pathToFileURL(entry).href);
			const faux = fauxProvider({ provider: "coding-policy-faux", models: [{ id: "fixture", contextWindow: 32000, maxTokens: 1024 }] });
			faux.setResponses([(context: { messages: unknown[] }) => {
				system = getCurrentSystemPrompt(context.messages);
				return fauxAssistantMessage("policy-request-ready");
			}]);
			const runtime = await product.runtime.ModelRuntime.create({ authPath: resolve(configDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
			runtime.registerNativeProvider(faux.provider);
			return runtime;
		},
	});
	await harness.run("Reply briefly; do not call tools.", { artifacts: {}, setArtifact() {} });
	expect(system).toContain(expected.body);
	expect(system).toContain(expected.followThrough);
	expect(system).toContain(expected.finalReport);
	expect(system.endsWith(fixtureExecutionPolicy)).toBe(includeFixtureContract);
	expect(system.split(expected.followThrough)).toHaveLength(2);
});
