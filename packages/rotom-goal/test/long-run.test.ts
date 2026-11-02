import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("real Pi honors an explicit 25-response limit and resumes without replaying a write", { timeout: 30_000 }, async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "goal-long-run-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const settingsPath = join(cwd, "goal-settings.json");
	writeFileSync(
		settingsPath,
		`${JSON.stringify({ continuationLimits: { automaticTurns: 25 } }, null, 2)}\n`,
	);
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
		compaction: { enabled: false },
	});
	let writes = 0;
	let checkpoints = 0;
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
				goal(pi, { settingsPath });
				pi.registerTool({
					name: "record_receipt",
					label: "Record receipt",
					description: "Record the fixture receipt once",
					parameters: Type.Object({}),
					async execute() {
						writes++;
						writeFileSync(join(cwd, "receipt.txt"), "once");
						return {
							content: [{ type: "text", text: "receipt recorded" }],
							details: {},
							terminate: true,
						};
					},
				});
				pi.registerTool({
					name: "checkpoint",
					label: "Checkpoint",
					description: "Record one read-only automatic-work checkpoint",
					parameters: Type.Object({ index: Type.Integer({ minimum: 1 }) }),
					async execute() {
						checkpoints++;
						return {
							content: [{ type: "text", text: "checkpoint observed" }],
							details: {},
							terminate: true,
						};
					},
				});
			},
		],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const provider = fauxProvider({ provider: "goal-long-run", tokensPerSecond: 0 });
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
	const call = (name: string, args: any) =>
		fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
	provider.setResponses([
		() => call("record_receipt", {}),
		...Array.from({ length: 25 }, (_, index) => () => call("checkpoint", { index: index + 1 })),
		() =>
			call("goal_wait", {
				goal_id: current().id,
				reason: "Explicit-limit resume verified",
			}),
	]);
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
	const settled = (predicate: () => boolean) =>
		new Promise<void>((resolve) => {
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "agent_settled" && predicate()) {
					unsubscribe();
					resolve();
				}
			});
		});
	const paused = settled(() => current()?.safetyPauseCause === "continuation_limit");
	await session.prompt("/goal Record receipt.txt once, then continue through the fixture checkpoints.");
	await paused;
	assert.deepEqual(errors, []);
	assert.equal(current().automaticModelTurns, 25);
	assert.equal(current().safetyPauseCause, "continuation_limit");
	assert.equal(provider.state.callCount, 26, "the initial user-owned response is outside the automatic epoch");
	assert.equal(writes, 1);
	assert.equal(checkpoints, 25);
	const beforeTokens = current().tokensUsed;
	const beforeTime = current().timeUsedSeconds;
	const resumed = settled(() => current()?.waiting?.reason === "Explicit-limit resume verified");
	await session.prompt("/goal resume");
	await resumed;
	assert.equal(provider.state.callCount, 27);
	assert.equal(writes, 1);
	assert.equal(readFileSync(join(cwd, "receipt.txt"), "utf8"), "once");
	assert(current().tokensUsed >= beforeTokens);
	assert(current().timeUsedSeconds >= beforeTime);
	assert.equal(current().automaticModelTurns, 0, "explicit resume starts a user-owned response and resets the automatic epoch");
});
