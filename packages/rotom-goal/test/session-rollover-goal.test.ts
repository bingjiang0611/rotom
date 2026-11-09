import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import goal from "../src/goal.js";
import sessionRollover from "../../../rotom/extensions/session-rollover/index.ts";

const CONTEXT_WINDOW = 12_000;
const RESERVE_TOKENS = 1_000;

/** A recorded assistant message whose usage sits just above the compaction threshold. */
function usageHeavy(timestamp: number): any {
	return {
		...fauxAssistantMessage("Recorded earlier answer."),
		timestamp,
		usage: { input: CONTEXT_WINDOW - RESERVE_TOKENS + 500, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: CONTEXT_WINDOW - RESERVE_TOKENS + 500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

async function goalFixture(t: any) {
	const cwd = mkdtempSync(join(tmpdir(), "goal-rollover-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
		compaction: { enabled: true, reserveTokens: RESERVE_TOKENS, keepRecentTokens: 1 },
	});
	const previous = process.env.ROTOM_SESSION_ROLLOVER;
	process.env.ROTOM_SESSION_ROLLOVER = "1";
	t.after(() => {
		if (previous === undefined) delete process.env.ROTOM_SESSION_ROLLOVER;
		else process.env.ROTOM_SESSION_ROLLOVER = previous;
	});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			(pi: any) => {
				goal(pi, { settingsPath: join(cwd, "missing.json") });
				sessionRollover(pi);
				// The takeover only runs when the retrieval tool is active; the retrieval behaviour itself
				// is covered by the session-rollover extension tests.
				pi.registerTool({
					name: "context_recall",
					label: "Retrieve cleared context",
					description: "Retrieve cleared entries from the current branch",
					parameters: Type.Object({ query: Type.Optional(Type.String()), ref: Type.Optional(Type.String()) }),
					async execute() {
						return { content: [{ type: "text", text: "nothing to recall in this fixture" }], details: {} };
					},
				});
			},
		],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const provider = fauxProvider({
		provider: "goal-rollover",
		models: [{ id: "test", contextWindow: CONTEXT_WINDOW, maxTokens: 4_096 }],
		tokensPerSecond: 0,
	});
	const registry = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
	registry.registerNativeProvider(provider.provider);
	const manager = SessionManager.inMemory(cwd);
	// Seeded history above the threshold: the compaction fires before the first goal request, so the
	// fixture needs no multi-thousand-token reply.
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "Keep the recorded requirement exact." }], timestamp: Date.now() - 3_000 });
	manager.appendMessage(usageHeavy(Date.now() - 2_500));
	const current = () =>
		(manager.getBranch().filter((entry: any) => entry.customType === "goal-state").at(-1) as any)?.data?.goal;
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		resourceLoader: loader,
		modelRuntime: registry,
		model: provider.getModel(),
		thinkingLevel: "off",
		sessionManager: manager,
		settingsManager,
	});
	t.after(() => session.dispose());
	const errors: unknown[] = [];
	await session.bindExtensions({ mode: "print", onError: (error: any) => errors.push(error) });
	const compactions = () => manager.getBranch().filter((entry: any) => entry.type === "compaction");
	return { session, provider, manager, current, errors, compactions };
}

function settledWhen(session: any, predicate: () => boolean) {
	return new Promise<void>((resolve) => {
		const unsubscribe = session.subscribe((event: any) => {
			if (event.type === "agent_settled" && predicate()) {
				unsubscribe();
				resolve();
			}
		});
	});
}

test("an active goal keeps running after the rollover takes over the compaction", { timeout: 30_000 }, async (t) => {
	const h = await goalFixture(t);
	h.provider.setResponses([fauxAssistantMessage("First segment."), fauxAssistantMessage("Continuation segment after the rollover."), fauxAssistantMessage("More.")]);
	const continued = settledWhen(h.session, () => h.provider.state.callCount >= 2);

	await h.session.prompt("/goal Finish the fixture task, then continue once after the rollover.");
	await continued;

	assert.deepEqual(h.errors, []);
	const entries = h.compactions();
	assert.equal(entries.length, 1, "the threshold compaction is taken over");
	assert.deepEqual((entries[0] as any).details, { kind: "rotom-rollover", version: 2 });
	assert.ok(h.provider.state.callCount >= 2, "the goal continued after the rollover");
	assert.ok((h.current()?.automaticModelTurns ?? 0) >= 1, "goal recorded an automatic continuation turn");
	assert.notEqual(h.current()?.stopReason, "provider_retry_exhausted", "the rollover did not exhaust provider recovery");
});
