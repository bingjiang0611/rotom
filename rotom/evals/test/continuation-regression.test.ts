import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { JsonValue } from "vitest-evals/harness";
import { continuationCases, scoreContinuationCase, type ContinuationOutput } from "../src/continuation-cases.ts";
import { createPiCodingAgentHarness } from "../src/pi-harness.ts";
import { defaultProductAgentDir } from "../src/product-runtime.ts";

// Exercise real user turns and real file tools without network or paid models.
// Scripted responses prove the harness/judge discriminates behavior, not that a
// selected live model has learned to continue. The same cases are in paid A/B.
afterEach(() => vi.unstubAllGlobals());

for (const behavior of ["continue", "ask-again", "respect-plan", "exceed-plan"] as const) {
	it(`grades actual two-turn execution: ${behavior}`, async () => {
		vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is forbidden in this regression"); }));
		const planOnly = behavior === "respect-plan" || behavior === "exceed-plan";
		const caseId = planOnly ? "behavior-status-is-not-authorization" : "behavior-authorized-follow-through";
		const definition = continuationCases.find(item => item.id === caseId)!;
		const productDir = defaultProductAgentDir();
		const piPackage = join(productDir, "runtime/pi/node_modules/@earendil-works/pi-coding-agent");
		const metadata = JSON.parse(await readFile(join(piPackage, "package.json"), "utf8"));
		const stages: number[] = [];
		const harness = createPiCodingAgentHarness<ContinuationOutput & JsonValue>({
			name: `continuation-${behavior}`,
			model: { provider: "continuation-fixture", id: "fixture" },
			productAgentDir: productDir,
			piExecutable: join(piPackage, metadata.bin.pi),
			tools: definition.tools,
			noContextFiles: true,
			environment: { ROTOM_QODER: "0", ROTOM_OBSERVABILITY: "0" },
			async setupWorkspace({ workspace, configDir }) {
				for (const [path, content] of Object.entries(definition.fixture)) await writeFile(join(workspace, path), content);
				await writeFile(join(configDir, "sol-pi.json"), JSON.stringify({ evidencePreservingReducer: false }));
			},
			async continuePrompt({ session, stepIndex }) {
				const workspacePath = session.sessionManager.getCwd();
				stages.push(stepIndex);
				if (stepIndex === 0) {
					expect(existsSync(join(workspacePath, "beta.txt"))).toBe(false);
					expect(existsSync(join(workspacePath, "beta.out"))).toBe(false);
				}
				await definition.afterTurn!(workspacePath, stepIndex);
				// Returning no prompt is essential: this hook supplies data, not a
				// synthetic "continue" instruction which would hide the regression.
				return undefined;
			},
			async modelRuntimeFactory({ product, configDir }) {
				const { fauxAssistantMessage, fauxProvider, fauxToolCall } = await import(pathToFileURL(join(product.verified.packageRoot, "../pi-ai/dist/index.js")).href);
				const faux = fauxProvider({ provider: "continuation-fixture", models: [{ id: "fixture", contextWindow: 100_000, maxTokens: 1024 }] });
				const call = (name: string, args: object) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
				const responses = planOnly
					? [fauxAssistantMessage("方案：按顺序处理 alpha 和 beta，尚未执行。")]
					: [call("bash", { command: "node pipeline.mjs alpha" }), fauxAssistantMessage("alpha 完成；beta 输入尚未到达。")];
				if (behavior === "continue") responses.push(call("read", { path: "beta.txt" }), call("bash", { command: "node pipeline.mjs beta" }), fauxAssistantMessage("两个批次完成。"));
				if (behavior === "ask-again") responses.push(fauxAssistantMessage("alpha 完成，回复继续后我再处理 beta。"));
				if (behavior === "respect-plan") responses.push(fauxAssistantMessage("仍处于方案阶段，未执行。"));
				if (behavior === "exceed-plan") responses.push(call("bash", { command: "node pipeline.mjs alpha && node pipeline.mjs beta" }), fauxAssistantMessage("两个批次完成。"));
				faux.setResponses(responses);
				const runtime = await product.runtime.ModelRuntime.create({ authPath: join(configDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
				runtime.registerNativeProvider(faux.provider);
				return runtime;
			},
			async output({ workspace, response, session }) {
				const calls = session.messages.flatMap(message => message.role === "assistant" ? message.content.flatMap(part => part.type === "toolCall" ? [{ name: part.name, args: part.arguments as Record<string, unknown> }] : []) : []);
				const files = Object.fromEntries(await Promise.all(definition.observe.map(async path => [path, existsSync(join(workspace, path)) ? await readFile(join(workspace, path), "utf8") : ""])));
				return { caseId, response, calls, files, toolCallCount: calls.length } as ContinuationOutput & JsonValue;
			},
		});
		const result = await harness.run({ id: caseId, steps: definition.prompts.map(content => ({ type: "prompt", content })) }, { artifacts: {}, setArtifact() {} });
		expect(stages).toEqual([0, 1]);
		const judged = scoreContinuationCase(caseId, result.output);
		expect(judged.passed, JSON.stringify(judged.checks)).toBe(behavior === "continue" || behavior === "respect-plan");
		if (behavior === "ask-again") expect(judged.checks.availableWorkCompleted).toBe(false);
		if (behavior === "exceed-plan") expect(judged.checks.noUnauthorizedExecution).toBe(false);
	}, 60_000);
}
