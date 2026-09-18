import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import goal from "../src/goal.js";

test("real Pi runs beyond 25 responses, stops at 100 and resumes without replaying a write", { timeout: 30_000 }, async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "goal-long-run-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeFileSync(join(cwd, "input.txt"), "input");
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi: any) => goal(pi, { settingsPath: join(cwd, "missing.json") })],
	});
	await loader.reload();
	const provider = fauxProvider({ provider: "goal-long-run", tokensPerSecond: 0 });
	const registry = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
	registry.registerNativeProvider(provider.provider);
	const manager = SessionManager.inMemory(cwd);
	const current = () => (manager.getBranch().filter((e: any) => e.customType === "goal-state").at(-1) as any)?.data.goal;
	const call = (name: string, args: any) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
	provider.setResponses([
		() => call("goal_continue", { goal_id: current().id, next_action: "Read input and save the receipt once" }),
		() => call("write", { path: "receipt.txt", content: "once" }),
		...Array.from({ length: 99 }, () => () => call("read", { path: "input.txt" })),
		() => fauxAssistantMessage("A user decision is needed; pause here."),
	]);
	const { session } = await createAgentSession({ cwd, agentDir: cwd, resourceLoader: loader, modelRuntime: registry, model: provider.getModel(), thinkingLevel: "off", sessionManager: manager, settingsManager });
	t.after(() => session.dispose());
	const errors: any[] = [], writes: string[] = [];
	await session.bindExtensions({ mode: "print", onError: (e) => errors.push(e) });
	const settled = () => new Promise<void>((resolve) => {
		const off = session.subscribe((e) => { if (e.type === "agent_settled" && current()?.status === "paused") { off(); resolve(); } });
	});
	session.subscribe((e) => { if (e.type === "tool_execution_start" && e.toolName === "write") writes.push(e.toolCallId); });
	const paused = settled();
	await session.prompt("/goal Read input and save receipt.txt once, then wait for a user decision.");
	await paused;
	assert.deepEqual(errors, []);
	assert.equal(current().automaticModelTurns, 100);
	assert.equal(current().safetyPauseCause, "continuation_limit");
	assert.equal(current().lastContinuationAction, "Read input and save the receipt once");
	assert.equal(provider.state.callCount, 101, "initial user-owned response is outside the automatic epoch");
	assert.equal(writes.length, 1);
	const beforeTokens = current().tokensUsed;
	const beforeTime = current().timeUsedSeconds;
	const resumed = settled();
	await session.prompt("/goal resume");
	await resumed;
	assert.equal(provider.state.callCount, 102);
	assert.equal(writes.length, 1);
	assert.equal(readFileSync(join(cwd, "receipt.txt"), "utf8"), "once");
	assert(current().tokensUsed >= beforeTokens);
	assert(current().timeUsedSeconds >= beforeTime);
	assert.equal(current().automaticModelTurns, 0, "explicit resume starts a user-owned response and resets the automatic epoch");
});
