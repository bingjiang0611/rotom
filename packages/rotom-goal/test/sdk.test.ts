import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import goal from "../src/goal.js";

test(
	"real Pi: continue terminates one run, reviewer uses the same provider with file-only tools, completion clears Goal",
	{ timeout: 20_000 },
	async (t) => {
		const cwd = mkdtempSync(join(tmpdir(), "rotom-goal-sdk-"));
		t.after(() => rmSync(cwd, { recursive: true, force: true }));
		writeFileSync(join(cwd, "result.txt"), "verified");
		const settingsManager = SettingsManager.inMemory({
			retry: { enabled: false },
			compaction: { enabled: false },
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
				(pi: any) => goal(pi, { settingsPath: join(cwd, "goal-settings.json") }),
			],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const provider = fauxProvider({ provider: "goal-sdk-fixture", tokensPerSecond: 0 });
		const registry = await ModelRuntime.create({
			authPath: join(cwd, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		registry.registerNativeProvider(provider.provider);
		const manager = SessionManager.inMemory(cwd);
		const currentId = () =>
			(
				manager
					.getBranch()
					.filter((e: any) => e.type === "custom" && e.customType === "goal-state")
					.at(-1) as any
			)?.data?.goal?.id;
		let reviewRequests = 0;
		provider.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("read", { path: "result.txt" }), {
					stopReason: "toolUse",
				}),
			() =>
				fauxAssistantMessage(
					fauxToolCall("goal_continue", {
						goal_id: currentId(),
						next_action: "Submit verified result for completion review",
					}),
					{ stopReason: "toolUse" },
				),
			() =>
				fauxAssistantMessage(
					fauxToolCall("goal_complete", {
						goal_id: currentId(),
						summary: "result.txt contains verified; read output checked",
					}),
					{ stopReason: "toolUse" },
				),
			(context: any) => {
				reviewRequests++;
				assert.deepEqual(
					context.tools.map((x: any) => x.name),
					["review_read", "review_list"],
				);
				return fauxAssistantMessage(fauxToolCall("review_read", { path: "result.txt" }), {
					stopReason: "toolUse",
				});
			},
			() => {
				reviewRequests++;
				return fauxAssistantMessage(
					"The current result.txt contains verified. Requirement satisfied.\n<approved/>",
				);
			},
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
		const errors: any[] = [];
		await session.bindExtensions({ mode: "print", onError: (e) => errors.push(e) });
		let resolveDone: () => void;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const unsubscribe = session.subscribe((event) => {
			if (
				event.type === "agent_settled" &&
				manager.getBranch().some((e: any) => e.customType === "goal-review-result")
			)
				resolveDone();
		});
		t.after(unsubscribe);
		await session.prompt("/goal Inspect result.txt and verify that its entire text is verified.");
		await done;
		assert.deepEqual(errors, []);
		assert.equal(reviewRequests, 2);
		assert.equal(provider.state.callCount, 5);
		assert.equal(currentId(), undefined);
		const outcome = manager
			.getBranch()
			.find((e: any) => e.customType === "goal-review-result") as any;
		assert.equal(outcome.data.status, "approved");
		assert.equal(outcome.data.usd, null);
	},
);

for (const controlFirst of [true, false])
	test(
		`real Pi rejects mixed completion/write batch before any dispatch (control first=${controlFirst})`,
		{ timeout: 20_000 },
		async (t) => {
			const cwd = mkdtempSync(join(tmpdir(), "rotom-goal-mixed-"));
			t.after(() => rmSync(cwd, { recursive: true, force: true }));
			writeFileSync(join(cwd, "result.txt"), "verified");
			const settingsManager = SettingsManager.inMemory({
				retry: { enabled: false },
				compaction: { enabled: false },
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
				extensionFactories: [(pi: any) => goal(pi, { settingsPath: join(cwd, "missing.json") })],
			});
			await loader.reload();
			const provider = fauxProvider({ provider: "goal-mixed-fixture", tokensPerSecond: 0 });
			const registry = await ModelRuntime.create({
				authPath: join(cwd, "auth.json"),
				modelsPath: null,
				refreshOnCreate: false,
			});
			registry.registerNativeProvider(provider.provider);
			const manager = SessionManager.inMemory(cwd);
			const current = () =>
				(
					manager
						.getBranch()
						.filter((e: any) => e.customType === "goal-state")
						.at(-1) as any
				)?.data?.goal;
			provider.setResponses([
				() => {
					const calls = [
						fauxToolCall("goal_complete", { goal_id: current().id, summary: "verified" }),
						fauxToolCall("write", { path: "result.txt", content: "mutated" }),
					];
					return fauxAssistantMessage(controlFirst ? calls : calls.reverse(), {
						stopReason: "toolUse",
					});
				},
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
			await session.bindExtensions({ mode: "print" });
			let finished: () => void;
			const done = new Promise<void>((resolve) => {
				finished = resolve;
			});
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "agent_settled") finished();
			});
			t.after(unsubscribe);
			await session.prompt("/goal Inspect result.txt");
			await done;
			assert.equal(current().status, "paused");
			assert.equal(provider.state.callCount, 1);
			assert.equal(readFileSync(join(cwd, "result.txt"), "utf8"), "verified");
			assert.equal(
				manager.getBranch().some((e: any) => e.customType === "goal-review-result"),
				false,
			);
		},
	);
