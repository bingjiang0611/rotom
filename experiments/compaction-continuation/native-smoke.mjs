// Zero-network rehearsal against an explicitly installed product; fake model, real native APIs.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadProductRuntime } from "../../rotom/evals/src/product-runtime.ts";
import { CASES, SYSTEM, historyFor, createFixture } from "./cases.mjs";

const product = process.argv[2];
assert(product, "Usage: native-smoke.mjs <installed-product>");
const { runtime: sdk } = await loadProductRuntime({ agentDir: product, piExecutable: join(product, "runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js") });
const { Type, fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(join(product, "runtime/pi/node_modules/@earendil-works/pi-ai/dist/index.js")));
const directory = await mkdtemp(join(tmpdir(), "rotom-compact-faux-"));
let session;
try {
	const faux = fauxProvider({ provider: "compaction-smoke", models: [{ id: "faux", contextWindow: 16000, maxTokens: 2048 }] });
	faux.setResponses([
		fauxAssistantMessage("## Goal\nConfirm exactly one receipt exists.\n## Constraints\nDo not commit or duplicate the receipt.\n## Progress\nOne request was dispatched; its outcome is unknown.\n## Next Steps\nRead receipt status, then finish."),
		fauxAssistantMessage([fauxToolCall("workspace", { action: "receipt_status" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("workspace", { action: "finish" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Done."),
	]);
	const runtime = await sdk.ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	const testCase = CASES.find((c) => c.id === "unknown-write");
	const manager = sdk.SessionManager.create(directory, join(directory, "sessions"));
	const history = historyFor(testCase);
	for (const message of history) manager.appendMessage(message);
	const generated = await sdk.generateSummaryWithUsage(history, faux.getModel(), 3000, undefined, undefined, undefined,
		undefined, undefined, "off", runtime.streamSimple.bind(runtime));
	manager.appendCompaction(generated.text, null, history.reduce((n, m) => n + sdk.estimateTokens(m), 0), undefined, false, generated.usage);
	const restored = sdk.SessionManager.open(manager.getSessionFile(), join(directory, "sessions"), directory);
	assert(restored.buildSessionContext().messages.some((m) => m.role === "compactionSummary"));
	const fixture = createFixture(testCase, Type);
	const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
	const loader = new sdk.DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
		noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
		systemPrompt: SYSTEM, extensionFactories: [(pi) => pi.registerTool(fixture.tool)] });
	await loader.reload(); assert.equal(loader.getExtensions().errors.length, 0);
	({ session } = await sdk.createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off",
		settingsManager: settings, sessionManager: restored, resourceLoader: loader, tools: ["workspace"] }));
	const errors = [];
	await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
	assert.equal(errors.length, 0);
	assert.deepEqual(session.getActiveToolNames(), ["workspace"]);
	await session.prompt("Continue the task from the checkpoint.");
	assert.equal(fixture.grade().pass, true);
	assert.equal(faux.state.callCount, 4);
	console.log(JSON.stringify({ status: "PASS", networkModelRequests: 0, fakeResponses: 4, nativeReload: true, grade: fixture.grade() }));
} finally { await session?.dispose(); await rm(directory, { recursive: true, force: true }); }
