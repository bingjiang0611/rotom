import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createPiCodingAgentHarness } from "../src/pi-harness.ts";
import { defaultProductAgentDir } from "../src/product-runtime.ts";
import { createStoppingShadow } from "../src/end-review-shadow.ts";

afterEach(() => vi.unstubAllGlobals());

it.each(["approved", "rejected", "unknown"] as const)("native shadow %s is recorded without another executor turn", async status => {
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is forbidden in this regression"); }));
	const product = defaultProductAgentDir();
	const body = JSON.stringify({ done: status === "approved" });
	const shadow = createStoppingShadow({
		product, tasks: ["Finish local work."], files: ["evidence.json"],
		fixturesIntact: async workspace => await readFile(join(workspace, "evidence.json"), "utf8") === body,
		latestVerification: () => body,
	});
	const harness = createPiCodingAgentHarness({
		name: "shadow-native-control", productAgentDir: product,
		model: { provider: "shadow-faux", id: "fixture" }, tools: [],
		environment: { ROTOM_QODER: "0", ROTOM_OBSERVABILITY: "0" },
		inlineExtensions: [shadow.extension], continuePrompt: shadow.continuePrompt,
		async setupWorkspace({ workspace, configDir }) {
			await writeFile(join(workspace, "evidence.json"), body);
			await writeFile(join(configDir, "sol-pi.json"), JSON.stringify({ evidencePreservingReducer: false }));
		},
		async modelRuntimeFactory({ product, configDir }) {
			const { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt } = await import(pathToFileURL(join(product.verified.packageRoot, "../pi-ai/dist/index.js")).href);
			const faux = fauxProvider({ provider: "shadow-faux", models: [{ id: "fixture", contextWindow: 100_000, maxTokens: 2048 }] });
			faux.setResponses([
				fauxAssistantMessage("Executor's proposed stop."),
				(context: { messages: unknown[] }) => {
					expect(getCurrentSystemPrompt(context.messages)).toContain("read-only stopping reviewer");
					expect(JSON.stringify(context.messages)).not.toContain("bounded completion reviewer");
					return fauxAssistantMessage(fauxToolCall("review_read", { path: "evidence.json" }), { stopReason: "toolUse" });
				},
				fauxAssistantMessage(JSON.stringify({ localWorkRemaining: status === "rejected", requirements: [{ requirement: "Local work", status: status === "approved" ? "satisfied" : status === "rejected" ? "unsatisfied" : "unknown", evidence: "evidence.json" }] })),
			]);
			const runtime = await product.runtime.ModelRuntime.create({ authPath: join(configDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
			runtime.registerNativeProvider(faux.provider);
			return runtime;
		},
		output({ session, response }) {
			const records = session.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "eval-end-review-shadow-v1");
			return { response, executorMessages: session.messages.filter(message => message.role === "assistant").length, records: JSON.stringify(records) };
		},
	});
	const result = await harness.run("Finish local work.", { artifacts: {}, setArtifact() {} });
	expect(result.output.response).toBe("Executor's proposed stop.");
	expect(result.output.executorMessages).toBe(1);
	const records = JSON.parse(result.output.records);
	expect(records).toHaveLength(1);
	expect(records[0].data).toMatchObject({ status, unchanged: true, automaticContinuation: false, calls: 2 });
});
