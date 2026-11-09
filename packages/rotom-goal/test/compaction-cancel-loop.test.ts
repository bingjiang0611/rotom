import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import goal from "../src/goal.js";

/**
 * W16 reproduction only. It records what Pi 1.4.0 does today when an extension cancels the
 * pre-request threshold compaction; it does not change Pi's cancellation semantics, because that
 * needs a user decision (see docs/agent/session-rollover-report-v3.md).
 *
 * The fixture is over the compaction threshold before the first request and the Provider answers
 * with a context-overflow error, so every request in the run is the same over-limit request:
 *
 * 1. `_prepareRun` → `_checkCompaction` → threshold compaction → cancelled → the request is sent.
 * 2. The response is an overflow error → `_checkCompaction` → overflow recovery → cancelled.
 * 3. `_overflowRecoveryAttempted` is already set, so the next response is terminal for this run.
 *
 * The question the test answers is what a caller that keeps continuing (an active Goal) does with
 * that terminal error.
 */
const CONTEXT_WINDOW = 12_000;
const RESERVE_TOKENS = 1_000;
const OVERFLOW = "This model's maximum context length is 12000 tokens, however you requested 50000 tokens";

/**
 * `error`: the Provider rejects the over-limit request (the common case).
 * `silent`: the Provider accepts it and answers with usage above the window while reporting a
 * normal stop, which is the shape that keeps a run "successful" and therefore keeps a Goal going.
 */
function overflowResponse(variant: "error" | "silent") {
	return {
		...fauxAssistantMessage(variant === "silent" ? "Truncated answer." : ""),
		stopReason: variant === "silent" ? ("stop" as const) : ("error" as const),
		...(variant === "silent" ? {} : { errorMessage: OVERFLOW }),
		usage: { input: CONTEXT_WINDOW + 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: CONTEXT_WINDOW + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function usageHeavy(timestamp: number) {
	return {
		...fauxAssistantMessage("Recorded earlier answer."),
		timestamp,
		usage: {
			input: CONTEXT_WINDOW - RESERVE_TOKENS + 500,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: CONTEXT_WINDOW - RESERVE_TOKENS + 500,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

async function fixture(t: any, options: { goal: boolean; variant: "error" | "silent" }) {
	const cwd = mkdtempSync(join(tmpdir(), "cancel-loop-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
		compaction: { enabled: true, reserveTokens: RESERVE_TOKENS, keepRecentTokens: 1 },
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
				if (options.goal) goal(pi, { settingsPath: join(cwd, "missing.json") });
				// The cancellation under test: no compaction may succeed in this fixture.
				pi.on("session_before_compact", () => ({ cancel: true }));
			},
		],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const provider = fauxProvider({ provider: "cancel-loop", models: [{ id: "test", contextWindow: CONTEXT_WINDOW, maxTokens: 4_096 }], tokensPerSecond: 0 });
	provider.setResponses(Array.from({ length: 200 }, () => overflowResponse(options.variant)));
	const registry = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
	registry.registerNativeProvider(provider.provider);
	const manager = SessionManager.inMemory(cwd);
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "Keep the recorded requirement exact." }], timestamp: Date.now() - 3_000 });
	manager.appendMessage(usageHeavy(Date.now() - 2_500));
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
	const settled = () =>
		new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				unsubscribe();
				resolve(false);
			}, 15_000);
			const unsubscribe = session.subscribe((event: any) => {
				if (event.type !== "agent_settled") return;
				clearTimeout(timer);
				unsubscribe();
				resolve(true);
			});
		});
	const current = () =>
		(manager.getBranch().filter((entry: any) => entry.customType === "goal-state").at(-1) as any)?.data?.goal;
	const compactions = () => manager.getBranch().filter((entry: any) => entry.type === "compaction");
	return { session, provider, manager, errors, settled, current, compactions };
}

test("records what Pi does when the pre-request threshold compaction is cancelled", { timeout: 60_000 }, async (t) => {
	const h = await fixture(t, { goal: false, variant: "error" });
	const done = h.settled();
	await h.session.prompt("Carry on with the task.");
	const settled = await done;

	// Recorded, not asserted as desired behavior.
	const observed = {
		settled,
		requests: h.provider.state.callCount,
		compactionEntries: h.compactions().length,
		extensionErrors: h.errors.length,
	};
	t.diagnostic(`no-goal: ${JSON.stringify(observed)}`);
	assert.equal(settled, true, "a single prompt still terminates without an active goal");
	// The cancelled threshold compaction does not block the request, and the cancelled overflow
	// recovery does not repeat it: the run ends with the overflow error after a bounded number.
	assert.ok(observed.requests >= 1 && observed.requests <= 4, `unexpected request count ${observed.requests}`);
	assert.equal(observed.compactionEntries, 0, "no compaction can commit while the hook cancels");
});

test("records how far an active goal continues when the pre-request threshold compaction is cancelled", { timeout: 90_000 }, async (t) => {
	const h = await fixture(t, { goal: true, variant: "error" });
	const done = h.settled();
	await h.session.prompt("/goal Finish the fixture task; keep going until there is nothing left to do.");
	const settled = await done;
	// Give an unbounded continuation a moment to show itself: if the run is still looping, more
	// requests appear after the first settle.
	const requestsAtSettle = h.provider.state.callCount;
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	const observed = {
		settled,
		requestsAtSettle,
		requestsAfter: h.provider.state.callCount,
		compactionEntries: h.compactions().length,
		extensionErrors: h.errors.length,
		goalStopReason: h.current()?.stopReason ?? null,
		automaticModelTurns: h.current()?.automaticModelTurns ?? 0,
	};
	t.diagnostic(`goal: ${JSON.stringify({ ...observed, goalStates: h.manager.getBranch().filter((entry: any) => entry.customType === "goal-state").map((entry: any) => ({ status: entry.data?.goal?.status ?? null, stopReason: entry.data?.goal?.stopReason ?? null, turns: entry.data?.goal?.automaticModelTurns ?? null })).slice(-3) })}`);
	assert.equal(settled, true, "the run has to reach agent_settled for this record to be meaningful");
	// Every request in this fixture is the same over-limit request, so any continuation beyond the
	// empty-response guard is repeated work on an unmovable context.
	assert.ok(observed.requestsAtSettle >= 1);
	assert.equal(observed.compactionEntries, 0);
});

test("records the silent-overflow variant: a successful over-limit answer with no Goal", { timeout: 60_000 }, async (t) => {
	const h = await fixture(t, { goal: false, variant: "silent" });
	const done = h.settled();
	await h.session.prompt("Carry on with the task.");
	const settled = await done;
	const requestsAtSettle = h.provider.state.callCount;
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	t.diagnostic(`no-goal/silent: ${JSON.stringify({ settled, requestsAtSettle, requestsAfter: h.provider.state.callCount, compactionEntries: h.compactions().length })}`);
	assert.equal(settled, true);
	assert.ok(requestsAtSettle <= 4, `unexpected request count ${requestsAtSettle}`);
});

test("records the silent-overflow variant with an active goal: repeated retries of the same request", { timeout: 90_000 }, async (t) => {
	const h = await fixture(t, { goal: true, variant: "silent" });
	const done = h.settled();
	await h.session.prompt("/goal Finish the fixture task; keep going until there is nothing left to do.");
	const settled = await done;
	const requestsAtSettle = h.provider.state.callCount;
	await new Promise((resolve) => setTimeout(resolve, 3_000));
	const observed = {
		settled,
		requestsAtSettle,
		requestsAfter: h.provider.state.callCount,
		compactionEntries: h.compactions().length,
		goalStopReason: h.current()?.stopReason ?? null,
		automaticModelTurns: h.current()?.automaticModelTurns ?? 0,
	};
	t.diagnostic(`goal/silent: ${JSON.stringify({ ...observed, goalStates: h.manager.getBranch().filter((entry: any) => entry.customType === "goal-state").map((entry: any) => ({ status: entry.data?.goal?.status ?? null, stopReason: entry.data?.goal?.stopReason ?? null, turns: entry.data?.goal?.automaticModelTurns ?? null })).slice(-3) })}`);
	assert.equal(settled, true, "the run has to reach agent_settled for this record to be meaningful");
});
