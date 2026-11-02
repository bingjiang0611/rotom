import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import goal from "../src/goal.js";

function messageText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	return (message?.content ?? []).map((part: any) => part.text ?? "").join("");
}

async function sdkFixture(t: any, providerName: string) {
	const cwd = mkdtempSync(join(tmpdir(), `${providerName}-`));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
		compaction: { enabled: false },
	});
	let observed = 0;
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
				pi.registerTool({
					name: "observe_fixture",
					label: "Observe fixture",
					description: "Record one read-only fixture observation",
					parameters: Type.Object({}),
					async execute() {
						observed++;
						return { content: [{ type: "text", text: "fixture observed" }], details: {} };
					},
				});
			},
		],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const provider = fauxProvider({ provider: providerName, tokensPerSecond: 0 });
	const registry = await ModelRuntime.create({
		authPath: join(cwd, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	registry.registerNativeProvider(provider.provider);
	const manager = SessionManager.inMemory(cwd);
	const current = () =>
		(manager.getBranch().filter((entry: any) => entry.customType === "goal-state").at(-1) as any)
			?.data?.goal;
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
	await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
	return { session, provider, manager, current, errors, observed: () => observed };
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

test("real Pi automatically continues after a normal run without goal_continue", { timeout: 20_000 }, async (t) => {
	const h = await sdkFixture(t, "goal-auto-continue");
	h.provider.setResponses([
		() => fauxAssistantMessage("Initial work segment finished."),
		() =>
			fauxAssistantMessage(
				fauxToolCall("goal_wait", {
					goal_id: h.current().id,
					reason: "Fixture wake event is registered",
				}),
				{ stopReason: "toolUse" },
			),
	]);
	const done = settledWhen(h.session, () => h.current()?.waiting !== undefined);
	await h.session.prompt("/goal Inspect the fixture, then wait for the registered event.");
	await done;
	assert.deepEqual(h.errors, []);
	assert.equal(h.provider.state.callCount, 2);
	assert.equal(h.current()?.status, "active");
	assert.equal(h.current()?.waiting?.reason, "Fixture wake event is registered");
});

test("real Pi pauses after three empty automatic runs and a non-control tool resets the count", { timeout: 20_000 }, async (t) => {
	const h = await sdkFixture(t, "goal-empty-responses");
	let sawReset = false;
	h.provider.setResponses([
		() => fauxAssistantMessage("Initial segment complete."),
		() => fauxAssistantMessage("Automatic segment with no operation."),
		() => fauxAssistantMessage(fauxToolCall("observe_fixture", {}), { stopReason: "toolUse" }),
		() => fauxAssistantMessage("Observation segment complete."),
		() => {
			sawReset = h.current()?.emptyResponseCount === 0;
			return fauxAssistantMessage("First empty run after the observation.");
		},
		() => fauxAssistantMessage("Second empty run after the observation."),
		() => fauxAssistantMessage("Third empty run after the observation."),
	]);
	const done = settledWhen(h.session, () => h.current()?.stopReason === "empty_responses");
	await h.session.prompt("/goal Exercise the empty-response guard with one fixture observation.");
	await done;
	assert.deepEqual(h.errors, []);
	assert.equal(h.observed(), 1);
	assert.equal(sawReset, true);
	assert.equal(h.current()?.status, "paused");
	assert.equal(h.current()?.stopReason, "empty_responses");
	assert.equal(h.current()?.emptyResponseCount, 3);
});

test("real Pi executes read plus goal_continue in one batch and carries next_action into continuation", { timeout: 20_000 }, async (t) => {
	const h = await sdkFixture(t, "goal-mixed-continue");
	const nextAction = "Inspect the recorded fixture observation";
	let continuationPrompt = "";
	h.provider.setResponses([
		() =>
			fauxAssistantMessage(
				[
					fauxToolCall("observe_fixture", {}),
					fauxToolCall("goal_continue", {
						goal_id: h.current().id,
						next_action: nextAction,
					}),
				],
				{ stopReason: "toolUse" },
			),
		() => fauxAssistantMessage("Mixed batch completed."),
		(context: any) => {
			continuationPrompt = messageText(context.messages.at(-1));
			return fauxAssistantMessage(
				fauxToolCall("goal_wait", {
					goal_id: h.current().id,
					reason: "Mixed batch verified",
				}),
				{ stopReason: "toolUse" },
			);
		},
	]);
	const done = settledWhen(h.session, () => h.current()?.waiting?.reason === "Mixed batch verified");
	await h.session.prompt("/goal Observe the fixture and record the next action in the same batch.");
	await done;
	assert.deepEqual(h.errors, []);
	assert.equal(h.observed(), 1);
	assert.equal(h.provider.state.callCount, 3);
	assert.match(continuationPrompt, /Inspect the recorded fixture observation/);
	assert.equal(h.current()?.lastContinuationAction, nextAction);
});
