import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import goal from "../src/goal.js";

for (const outcome of ["recovered", "exhausted", "cancelled", "unknown-tool", "compacted"] as const) {
	test(`real Pi recovery: ${outcome}; completed/unknown tool dispatch is never replayed`, { timeout: 20_000 }, async (t) => {
		const cwd = mkdtempSync(join(tmpdir(), "rotom-goal-recovery-"));
		t.after(() => rmSync(cwd, { recursive: true, force: true }));
		const settingsManager = SettingsManager.inMemory({
			retry: { enabled: true, maxRetries: 1, baseDelayMs: outcome === "cancelled" ? 60_000 : 1 },
			compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1000 },
		});
		let writes = 0;
		const loader = new DefaultResourceLoader({
			cwd, agentDir: cwd, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi: any) => {
				goal(pi, { settingsPath: join(cwd, "goal-settings.json") });
				pi.registerTool({
					name: "record_effect", label: "Record effect", description: "Fixture effect, dispatch only once",
					parameters: Type.Object({}),
					async execute() {
						writes++;
						return { content: [{ type: "text", text: outcome === "unknown-tool" ? "Outcome unknown; read back before any further write." : outcome === "compacted" ? "Effect recorded.\n".repeat(2000) : "Effect recorded." }], details: { outcome: outcome === "unknown-tool" ? "unknown" : "success" } };
					},
				});
			}],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const provider = fauxProvider({ provider: `goal-recovery-${outcome}`, tokensPerSecond: 0, models: [{ id: "fixture", contextWindow: 8000, maxTokens: 1000 }] });
		const registry = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
		registry.registerNativeProvider(provider.provider);
		const manager = SessionManager.inMemory(cwd);
		const currentGoal = () => (manager.getBranch().filter((e: any) => e.customType === "goal-state").at(-1) as any)?.data?.goal;
		const error = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "fetch failed" });
		const summary = () => fauxAssistantMessage("## Goal\nRecord effect once.\n## Progress\nEffect dispatched; never replay it.\n## Next Steps\nProvider connection needs user attention.");
		provider.setResponses([
			() => fauxAssistantMessage(fauxToolCall("record_effect", {}), { stopReason: "toolUse" }),
			error,
			outcome === "exhausted" || outcome === "compacted" ? error : () => fauxAssistantMessage("The prior effect must not be repeated. I need user input to proceed."),
			summary, summary, // History and retained split-turn prefix are summarized separately.
		]);
		const { session } = await createAgentSession({ cwd, agentDir: cwd, resourceLoader: loader, modelRuntime: registry, model: provider.getModel(), thinkingLevel: "off", sessionManager: manager, settingsManager });
		t.after(() => session.dispose());
		const extensionErrors: unknown[] = [];
		await session.bindExtensions({ mode: "print", onError: (e) => extensionErrors.push(e) });
		const retryEvents: any[] = [];
		const compactions: any[] = [];
		const settled = Promise.withResolvers<void>();
		let cancellation: Promise<void> | undefined;
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_settled" && provider.state.callCount > 0) settled.resolve();
			if (event.type === "compaction_end") compactions.push(event);
			if (event.type === "auto_retry_end" && !event.success && outcome === "compacted") {
				// Exercise post-exhaustion threshold compaction, not compaction at
				// the earlier successful tool boundary. No retry request is replayed.
				settingsManager.setCompactionEnabled(true);
			}
			if (event.type === "auto_retry_start" || event.type === "auto_retry_end") retryEvents.push(event);
			if (event.type === "auto_retry_start" && outcome === "cancelled") {
				// The host installs its abort controller after notifying subscribers.
				queueMicrotask(() => { cancellation = session.abort(); });
			}
		});
		t.after(unsubscribe);
		await session.prompt("/goal Record the fixture effect once; never repeat an unknown outcome.");
		await settled.promise;
		await session.waitForIdle();
		await cancellation;
		assert.deepEqual(extensionErrors, []);
		assert.equal(writes, 1);
		assert.equal(provider.state.callCount, outcome === "cancelled" ? 2 : outcome === "compacted" ? 5 : 3);
		if (outcome === "compacted") {
			assert.equal(compactions.length, 1);
			assert.equal(compactions[0].reason, "threshold");
			assert.ok(compactions[0].result, JSON.stringify(compactions[0]));
			assert.equal(compactions[0].willRetry, false);
		}
		assert.equal(retryEvents.filter((e) => e.type === "auto_retry_start").length, 1);
		assert.equal(retryEvents.at(-1)?.success, outcome === "recovered" || outcome === "unknown-tool");
		assert.equal(currentGoal()?.status, "paused");
		assert.equal(currentGoal()?.recovery, undefined);
		assert.equal(currentGoal()?.waiting, undefined);
		assert.equal(currentGoal()?.stopReason, outcome === "exhausted" || outcome === "compacted" ? "provider_retry_exhausted" : outcome === "cancelled" ? "agent_interruption" : "missing_decision");
		// Cancellation can reach the host before Goal receives agent_end; in that
		// ordering the authoritative final message is already aborted, not retrying.
		if (outcome !== "cancelled") {
			assert.ok(manager.getBranch().some((e: any) => e.customType === "goal-state" && e.data.goal?.recovery === "provider_retry"));
		}
	});
}
