import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalRuntime, createGoal, nextGoalInstance } from "../src/runtime.js";
import { registerGoalTools } from "../src/tools.js";
import { registerGoalLifecycle } from "../src/lifecycle.js";
import { GoalCommandController } from "../src/commands.js";
import { GoalRunController } from "../src/run-protocol.js";
import { GOAL_TOOL_NAMES } from "../src/tool-policy.js";
import { normalizeLoadedGoal } from "../src/persistence.js";
import { normalizeGoalSettings } from "../src/settings.js";
import { nextToolFreeRepeatState } from "../src/safety.js";
import { digest, REVIEW_LIMITS, type ReviewResult } from "../src/reviewer.js";

export function fixture(t: any, review?: any) {
	const cwd = mkdtempSync(join(tmpdir(), "rotom-goal-test-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const events = new EventEmitter(),
		tools = new Map<string, any>(),
		handlers = new Map<string, any>();
	const entries: any[] = [],
		sent: string[] = [],
		notices: string[] = [];
	const sessionManager = {
		getBranch: () => entries,
		getEntries: () => entries,
		getSessionId: () => "fixture",
	};
	const pi: any = {
		events,
		registerTool: (d: any) => tools.set(d.name, d),
		on: (e: string, h: any) => handlers.set(e, h),
		registerCommand() {},
		getActiveTools: () => [...GOAL_TOOL_NAMES],
		appendEntry: (customType: string, data: any) =>
			entries.push({ type: "custom", customType, data: structuredClone(data) }),
		sendMessage() {},
		sendUserMessage: (s: string) => sent.push(s),
	};
	const ctx: any = {
		cwd,
		mode: "print",
		sessionManager,
		hasUI: false,
		model: { provider: "fixture", id: "model" },
		ui: { notify: (s: string) => notices.push(s), setStatus() {}, confirm: async () => true },
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort() {},
	};
	const runtime = new GoalRuntime(pi);
	runtime.bindWorkflowSession(sessionManager);
	assert.equal(runtime.acquireWorkflow(), true);
	runtime.activeGoal = createGoal("Write and inspect result.txt", undefined, 0);
	runtime.beginAgentRun(runtime.activeGoal.id, "automatic");
	registerGoalTools(pi, runtime, review);
	const controller = new GoalRunController(runtime, new GoalCommandController(runtime));
	registerGoalLifecycle(pi, runtime, controller);
	t.after(() => {
		runtime.clearGoalWaitTimer();
		runtime.clearCompletionStatusTimer();
		runtime.cancelContinuationWork();
	});
	const call = (name: string, args: any, signal?: AbortSignal) =>
		tools.get(name).execute("call", args, signal, undefined, ctx);
	return { cwd, runtime, ctx, pi, tools, entries, sent, notices, handlers, call };
}
const decision = (status: ReviewResult["status"]): ReviewResult => ({
	status,
	report: status,
	reportedTokens: 10,
	calls: 1,
	files: [],
});
const finish = (h: ReturnType<typeof fixture>) =>
	h.handlers.get("agent_end")(
		{
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "work" }], stopReason: "stop" },
			],
		},
		h.ctx,
	);

test("four stable tools; defaults enable completion review; excluded continue is not reactivated", (t) => {
	const h = fixture(t);
	assert.equal(h.tools.size, 4);
	assert.equal(normalizeGoalSettings({})?.completionReview, true);
	assert.equal(normalizeGoalSettings({ completionReview: false })?.completionReview, false);
	assert.equal(normalizeGoalSettings({ completionReview: "false" }), undefined);
	h.pi.getActiveTools = () => ["goal_complete", "goal_blocked"];
	assert.equal(h.runtime.goalToolsAvailable(), false);
});

test("accepted decision permits exactly one settled continuation; missing decision pauses", async (t) => {
	const h = fixture(t);
	const id = h.runtime.activeGoal!.id;
	assert.equal(
		(await h.call("goal_continue", { goal_id: "old", next_action: "test" })).terminate,
		false,
	);
	assert.equal(
		(await h.call("goal_continue", { goal_id: id, next_action: "Inspect result.txt" })).terminate,
		true,
	);
	assert.equal(
		(await h.call("goal_continue", { goal_id: id, next_action: "duplicate" })).terminate,
		false,
	);
	finish(h);
	h.handlers.get("agent_settled")({}, h.ctx);
	h.handlers.get("agent_settled")({}, h.ctx);
	assert.equal(h.sent.length, 1);
	assert.match(h.sent[0], /Inspect result.txt/);
	h.runtime.cancelContinuationWork();
	h.runtime.beginAgentRun(id, "automatic");
	finish(h);
	assert.equal(h.runtime.activeGoal?.status, "paused");
	assert.equal(h.sent.length, 1);
});

test("an unanswered authorization question pauses on the first run without a blocker or wake", (t) => {
	const h = fixture(t);
	const original = h.runtime.activeGoal!;
	assert.equal(original.iteration, 0);
	h.handlers.get("agent_end")(
		{ messages: [{ role: "assistant", content: [{ type: "text", text: "May I publish this version?" }], stopReason: "stop" }] },
		h.ctx,
	);
	h.handlers.get("agent_settled")({}, h.ctx);
	assert.equal(h.runtime.activeGoal?.status, "paused");
	assert.equal(h.runtime.activeGoal?.id, original.id);
	assert.equal(h.runtime.activeGoal?.text, original.text);
	assert.equal(h.runtime.activeGoal?.iteration, 1);
	assert.equal(h.runtime.activeGoal?.waiting, undefined);
	assert.equal(h.runtime.continueAction, undefined);
	assert.deepEqual(h.sent, []);
});

test("non-goal input and sibling tools invalidate a decision instead of dispatching it", async (t) => {
	const h = fixture(t);
	const id = h.runtime.activeGoal!.id;
	await h.call("goal_continue", { goal_id: id, next_action: "test" });
	h.handlers.get("input")({ source: "interactive", text: "changed requirement" }, h.ctx);
	assert.equal(h.runtime.continueAction, undefined);
	await h.call("goal_continue", { goal_id: id, next_action: "test" });
	assert.equal(h.handlers.get("tool_call")({ toolName: "bash" }, h.ctx).block, true);
	assert.equal(h.runtime.continueAction, undefined);
});

test("wait is an independent disposition; no missing-decision pause or premature wake", async (t) => {
	const h = fixture(t);
	const result = await h.call("goal_wait", {
		goal_id: h.runtime.activeGoal!.id,
		reason: "External event registered",
	});
	assert.equal(result.terminate, true);
	finish(h);
	h.handlers.get("agent_settled")({}, h.ctx);
	assert.equal(h.runtime.activeGoal?.status, "active");
	assert.ok(h.runtime.activeGoal?.waiting);
	assert.equal(h.sent.length, 0);
});

test("control-only text and next_action cannot disguise repeated failing work", () => {
	let state: any = { toolFreeRepeatCount: 0 };
	for (let i = 0; i < 3; i++) {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", name: "bash", arguments: { command: "false" } }],
			},
			{
				role: "assistant",
				content: [
					{ type: "text", text: `new narration ${i}` },
					{ type: "toolCall", name: "goal_continue", arguments: { next_action: `try ${i}` } },
				],
			},
		];
		state = nextToolFreeRepeatState(state, messages, true);
	}
	assert.equal(state.toolFreeRepeatCount, 3);
});

test("approval completes only after reviewer; opt-out does not invoke reviewer", async (t) => {
	let calls = 0;
	const h = fixture(t, async () => {
		calls++;
		assert.equal(h.runtime.activeGoal?.review?.status, "running");
		return decision("approved");
	});
	const result = await h.call("goal_complete", {
		goal_id: h.runtime.activeGoal!.id,
		summary: "result.txt inspected",
	});
	assert.equal(result.terminate, true);
	assert.equal(calls, 1);
	assert.equal(h.runtime.activeGoal, undefined);
	assert.ok(
		h.entries.some((e) => e.customType === "goal-review-result" && e.data.status === "approved"),
	);
	const other = fixture(t, async () => {
		throw new Error("disabled review must not run");
	});
	other.runtime.settings = { ...other.runtime.settings, completionReview: false };
	assert.equal(
		(
			await other.call("goal_complete", {
				goal_id: other.runtime.activeGoal!.id,
				summary: "Done and verified",
			})
		).terminate,
		true,
	);
});

test("rejection requires new evidence; summary edits and resume do not replenish attempts", async (t) => {
	let calls = 0;
	const h = fixture(t, async () => {
		calls++;
		return decision("rejected");
	});
	const id = h.runtime.activeGoal!.id;
	assert.equal((await h.call("goal_complete", { goal_id: id, summary: "done" })).terminate, false);
	assert.equal(h.runtime.activeGoal?.status, "active");
	h.entries.push(
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "control",
						name: "goal_continue",
						arguments: { goal_id: id, next_action: "try again" },
					},
				],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "control",
				toolName: "goal_continue",
				content: [{ type: "text", text: "One continuation decision accepted." }],
				isError: false,
			},
		},
	);
	assert.equal(
		(await h.call("goal_complete", { goal_id: id, summary: "now really done" })).terminate,
		true,
	);
	assert.equal(calls, 1);
	assert.equal(h.runtime.activeGoal?.status, "paused");
	const next = nextGoalInstance(h.runtime.activeGoal!);
	assert.equal(next.review?.attempts, 1);
});

test("unknown review pauses and survives restore without replay", async (t) => {
	let calls = 0;
	const h = fixture(t, async () => {
		calls++;
		return decision("unknown");
	});
	const id = h.runtime.activeGoal!.id;
	await h.call("goal_complete", { goal_id: id, summary: "done" });
	assert.equal(h.runtime.activeGoal?.status, "paused");
	assert.equal(h.runtime.activeGoal?.review?.status, "unknown");
	h.runtime.activeGoal = { ...h.runtime.activeGoal!, status: "active" };
	h.runtime.acquireWorkflow();
	h.runtime.beginAgentRun(id, "manual");
	await h.call("goal_complete", { goal_id: id, summary: "retry" });
	assert.equal(calls, 1);
	const restored = normalizeLoadedGoal({
		...h.runtime.activeGoal!,
		status: "active",
		review: { attempts: 1, candidate: digest("x"), status: "running", reportedTokens: 0 },
	});
	assert.equal(restored.status, "paused");
});

test("late approval after cancellation or file change cannot complete the goal", async (t) => {
	for (const change of ["owner", "file"]) {
		const h = fixture(t, async () => {
			if (change === "owner") h.runtime.invalidateExecution();
			else writeFileSync(join(h.cwd, "result.txt"), "changed");
			return {
				...decision("approved"),
				files: [{ path: "result.txt", digest: digest("original") }],
			};
		});
		writeFileSync(join(h.cwd, "result.txt"), "original");
		await h.call("goal_complete", { goal_id: h.runtime.activeGoal!.id, summary: "done" });
		assert.ok(h.runtime.activeGoal);
		assert.notEqual(h.runtime.activeGoal.status, "complete");
		assert.equal(h.runtime.activeGoal.review?.status, "unknown");
		assert.equal(h.runtime.activeGoal.review?.reportedTokens, 10);
	}
});

test("late review cannot overwrite a replacement Goal or its allowance", async (t) => {
	const h = fixture(t, async () => {
		h.runtime.activeGoal = nextGoalInstance(h.runtime.activeGoal!);
		h.runtime.invalidateExecution();
		return decision("approved");
	});
	const id = h.runtime.activeGoal!.id;
	await h.call("goal_complete", { goal_id: id, summary: "done" });
	assert.notEqual(h.runtime.activeGoal?.id, id);
	assert.notEqual(h.runtime.activeGoal?.status, "complete");
	assert.equal(h.runtime.activeGoal?.review?.status, "running");
	assert.equal(h.runtime.activeGoal?.review?.attempts, 1);
	assert.equal(h.runtime.activeGoal?.review?.reportedTokens, 0);
});

test("review admission refreshes current executor usage; Goal budget includes reported review tokens", async (t) => {
	const h = fixture(t, async () => {
		throw new Error("no review budget");
	});
	h.runtime.activeGoal!.tokenBudget = 100;
	h.entries.push({
		type: "message",
		message: { role: "assistant", usage: { totalTokens: 100 }, content: [] },
	});
	await h.call("goal_complete", { goal_id: h.runtime.activeGoal!.id, summary: "done" });
	assert.equal(h.runtime.activeGoal?.review, undefined);
	assert.equal(h.runtime.activeGoal?.status, "paused");
	const other = fixture(t);
	other.runtime.activeGoal!.tokenBudget = 100;
	other.runtime.activeGoal!.tokensUsed = 60;
	other.runtime.activeGoal!.review = {
		attempts: 1,
		candidate: digest("x"),
		status: "rejected",
		reportedTokens: 40,
	};
	assert.equal(other.runtime.limitActiveGoalForBudget(other.ctx, false), true);
	assert.equal(other.runtime.activeGoal?.status, "budget_limited");
});

test("review allowance is persisted, finite and fail-closed on corrupt restore", async (t) => {
	const h = fixture(t, async () => {
		throw new Error("allowance exhausted");
	});
	h.runtime.activeGoal!.review = {
		attempts: REVIEW_LIMITS.attempts,
		candidate: digest("old"),
		status: "rejected",
		reportedTokens: 20,
	};
	await h.call("goal_complete", { goal_id: h.runtime.activeGoal!.id, summary: "done" });
	assert.equal(h.runtime.activeGoal?.status, "paused");
	const normalized = normalizeLoadedGoal({ ...h.runtime.activeGoal!, review: {} as any });
	assert.equal(normalized.review?.attempts, REVIEW_LIMITS.attempts);
	assert.equal(normalized.review?.status, "unknown");
});
