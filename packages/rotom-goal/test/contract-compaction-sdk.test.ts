import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import goal from "../src/goal.js";

const INACTIVE = "Goal mode is inactive.";

function messageText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	return (message?.content ?? []).map((part: any) => part.text ?? "").join("");
}

// Regression: threshold compaction summarizes the persisted inactive contract
// away. Re-appending it as the newest message made models answer "Goal mode is
// off, waiting for instructions" and end an unrelated in-progress task.
test("real Pi: compaction after a stopped Goal does not append a trailing inactive contract", { timeout: 20_000 }, async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "rotom-goal-contract-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
		compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1000 },
	});
	const loader = new DefaultResourceLoader({
		cwd, agentDir: cwd, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi: any) => {
			goal(pi, { settingsPath: join(cwd, "goal-settings.json") });
			pi.registerTool({
				name: "large_read", label: "Large read", description: "Fixture output that fills the context",
				parameters: Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: "Fixture line.\n".repeat(2000) }], details: {} };
				},
			});
		}],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const provider = fauxProvider({ provider: "goal-contract-compaction", tokensPerSecond: 0, models: [{ id: "fixture", contextWindow: 8000, maxTokens: 1000 }] });
	const registry = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
	registry.registerNativeProvider(provider.provider);
	const manager = SessionManager.inMemory(cwd);
	const summary = () => fauxAssistantMessage("## Goal\nContinue the user's normal task.\n## Next Steps\nKeep working.");
	let postCompactionContext: any[] | undefined;
	let readDispatched = false;
	const respond = (context: any) => {
		// Summarization requests carry the serialized conversation as their only user message.
		const request = messageText(context.messages.at(-1));
		if (request.startsWith("<conversation>") || request.startsWith("# Conversation")) return summary();
		if (!readDispatched) {
			readDispatched = true;
			return fauxAssistantMessage(fauxToolCall("large_read", {}), { stopReason: "toolUse" });
		}
		postCompactionContext = context.messages;
		return fauxAssistantMessage("Normal task finished.");
	};
	provider.setResponses([
		// Goal run: no continuation decision, so the Goal pauses and the inactive contract is persisted.
		() => fauxAssistantMessage("I need a user decision before continuing."),
		// Ordinary task after the Goal stopped; compaction requests are recognized by their prompt.
		...Array.from({ length: 8 }, () => respond),
	]);
	const { session } = await createAgentSession({ cwd, agentDir: cwd, resourceLoader: loader, modelRuntime: registry, model: provider.getModel(), thinkingLevel: "off", sessionManager: manager, settingsManager });
	t.after(() => session.dispose());
	const extensionErrors: unknown[] = [];
	await session.bindExtensions({ mode: "print", onError: (e) => extensionErrors.push(e) });
	const compactions: any[] = [];
	let settled = Promise.withResolvers<void>();
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "compaction_end") compactions.push(event);
		if (event.type === "agent_settled") settled.resolve();
	});
	t.after(unsubscribe);

	await session.prompt("/goal Finish the fixture objective.");
	await settled.promise;
	await session.waitForIdle();
	const goalState = (manager.getBranch().filter((e: any) => e.customType === "goal-state").at(-1) as any)?.data?.goal;
	assert.equal(goalState?.status, "paused");
	const contracts = () => manager.getBranch().filter((e: any) => e.type === "custom_message" && e.customType === "goal-contract");
	assert.ok(messageText(contracts().at(-1)).startsWith(INACTIVE), "the stopped Goal persists one inactive contract");
	const persistedBefore = contracts().length;

	settingsManager.setCompactionEnabled(true);
	settled = Promise.withResolvers<void>();
	await session.prompt("Read the large fixture, then finish.");
	await settled.promise;
	await session.waitForIdle();

	assert.deepEqual(extensionErrors, []);
	assert.ok(compactions.length >= 1);
	assert.ok(compactions.every((event) => event.result), JSON.stringify(compactions));
	const branch = manager.getBranch();
	const compactionIndex = branch.findIndex((e: any) => e.type === "compaction");
	assert.ok(compactionIndex >= 0);
	assert.equal(contracts().length, persistedBefore, "compaction must not persist another inactive contract");
	assert.equal(
		branch.slice(compactionIndex).some((e: any) => e.customType === "goal-contract"),
		false,
		"no goal-contract entry may follow the compaction",
	);

	// The model still sees the inactive state, placed right after the summary
	// instead of as the newest instruction.
	assert.ok(postCompactionContext, "the post-compaction request reached the provider");
	const inactiveIndexes = postCompactionContext!.flatMap((m: any, i: number) => (messageText(m).includes(INACTIVE) ? [i] : []));
	assert.equal(inactiveIndexes.length, 1, JSON.stringify(postCompactionContext!.map(messageText).map((s: string) => s.slice(0, 60))));
	const summaryIndex = postCompactionContext!.findIndex((m: any) => messageText(m).includes("Continue the user's normal task."));
	assert.ok(summaryIndex >= 0, "the request carries the compaction summary");
	assert.equal(inactiveIndexes[0], summaryIndex + 1, "inactive contract directly follows the compaction summary");
	assert.equal(messageText(postCompactionContext!.at(-1)).includes(INACTIVE), false);
});
