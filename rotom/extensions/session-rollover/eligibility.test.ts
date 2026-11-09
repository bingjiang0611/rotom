import assert from "node:assert/strict";
import test from "node:test";
import { decideRollover, rolloverWatermark, type RolloverState } from "./eligibility.ts";
import { CONTEXT_WINDOW, RESERVE_TOKENS, THRESHOLD, WATERMARK } from "./test-helpers.ts";

const userEntry = (id: string, text = "question") =>
	({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: text, timestamp: 0 } }) as any;
const assistantEntry = (id: string, stopReason = "stop", content: any[] = [{ type: "text", text: "answer" }]) =>
	({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content, stopReason, timestamp: 0 } }) as any;
const toolResultEntry = (id: string, toolCallId: string) =>
	({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId, toolName: "read", content: [], isError: false, timestamp: 0 } }) as any;
const goalEntry = (status: string) =>
	({ type: "custom", id: "goal", parentId: null, timestamp: new Date().toISOString(), customType: "goal-state", data: { goal: { status } } }) as any;

function state(overrides: Partial<RolloverState> = {}): RolloverState {
	return {
		trigger: "input",
		model: { api: "faux" },
		estimate: { tokens: WATERMARK + 1, contextWindow: CONTEXT_WINDOW, reserveTokens: RESERVE_TOKENS, enabled: true, stale: false },
		sessionFile: "/tmp/session.jsonl",
		activeTools: ["context_recall"],
		branch: [userEntry("u1"), assistantEntry("a1")],
		idle: true,
		pendingMessages: false,
		input: { text: "continue", source: "interactive" },
		...overrides,
	};
}

test("water mark derives from reserveTokens and stays below the compaction threshold", () => {
	assert.equal(rolloverWatermark(CONTEXT_WINDOW, RESERVE_TOKENS), WATERMARK);
	assert.ok(WATERMARK < THRESHOLD);
	assert.deepEqual(decideRollover(state()), { allowed: true, tokens: WATERMARK + 1, reserveTokens: RESERVE_TOKENS });
});

test("exactly at the water mark does not roll over; one token above does", () => {
	const atMark = decideRollover(state({ estimate: { tokens: WATERMARK, contextWindow: CONTEXT_WINDOW, reserveTokens: RESERVE_TOKENS, enabled: true, stale: false } }));
	assert.deepEqual(atMark, { allowed: false, reason: "below-watermark" });
	assert.equal(decideRollover(state()).allowed, true);
});

test("every eligibility rule blocks rollover on its own", () => {
	const cases: Array<[string, Partial<RolloverState>, string]> = [
		["busy", { idle: false }, "not-idle"],
		["queued work", { pendingMessages: true }, "pending-messages"],
		["unfinished assistant turn", { branch: [assistantEntry("a1", "toolUse")] }, "unfinished-turn"],
		[
			"unpaired tool call",
			{ branch: [assistantEntry("a1", "stop", [{ type: "toolCall", id: "c1", name: "read", arguments: {} }])] },
			"unpaired-tool-call",
		],
		["no model or window", { estimate: undefined }, "no-model"],
		["virtual model", { model: { api: "pi-virtual" } }, "virtual-model"],
		["compaction disabled", { estimate: { tokens: WATERMARK + 1, contextWindow: CONTEXT_WINDOW, reserveTokens: RESERVE_TOKENS, enabled: false, stale: false } }, "compaction-disabled"],
		["in-memory session", { sessionFile: undefined }, "no-session"],
		["no recall tool", { activeTools: ["read"] }, "no-recall-tool"],
		["extension input", { input: { text: "continue", source: "extension" } }, "extension-input"],
		["streaming input", { input: { text: "continue", source: "interactive", streamingBehavior: "steer" } }, "streaming-input"],
		["active Goal", { branch: [userEntry("u1"), assistantEntry("a1"), goalEntry("active")] }, "goal-active"],
	];
	for (const [name, overrides, reason] of cases) {
		assert.deepEqual(decideRollover(state(overrides)), { allowed: false, reason }, name);
	}
});

test("an estimate that predates the newest compaction blocks both triggers", () => {
	const stale = { tokens: WATERMARK + 1, contextWindow: CONTEXT_WINDOW, reserveTokens: RESERVE_TOKENS, enabled: true, stale: true };
	assert.deepEqual(decideRollover(state({ estimate: stale })), { allowed: false, reason: "stale-estimate" });
	assert.deepEqual(decideRollover(state({ trigger: "after-run", estimate: stale })), { allowed: false, reason: "stale-estimate" });
});

test("slash inputs are rollover points because Pi expands them into model requests", () => {
	// Extension commands run before the `input` event, so anything that still reaches it dispatches.
	assert.equal(decideRollover(state({ input: { text: "/skill:review the diff", source: "interactive" } })).allowed, true);
	assert.equal(decideRollover(state({ input: { text: "/template-name argument", source: "interactive" } })).allowed, true);
	assert.equal(decideRollover(state({ input: { text: "/model sonnet", source: "rpc" } })).allowed, true);
});

test("a paired tool call and a non-active Goal do not block", () => {
	const paired = [
		assistantEntry("a1", "stop", [{ type: "toolCall", id: "c1", name: "read", arguments: {} }]),
		toolResultEntry("r1", "c1"),
	];
	assert.equal(decideRollover(state({ branch: paired })).allowed, true);
	assert.equal(decideRollover(state({ branch: [assistantEntry("a1"), goalEntry("complete")] })).allowed, true);
	assert.equal(decideRollover(state({ branch: [assistantEntry("a1"), goalEntry("paused")] })).allowed, true);
});

test("after-run deferral ignores the input-only rules but keeps idle-independent ones", () => {
	const afterRun = { trigger: "after-run" as const, idle: false, input: undefined };
	assert.equal(decideRollover(state(afterRun)).allowed, true);
	assert.deepEqual(decideRollover(state({ ...afterRun, pendingMessages: true })), { allowed: false, reason: "pending-messages" });
	assert.deepEqual(decideRollover(state({ ...afterRun, activeTools: [] })), { allowed: false, reason: "no-recall-tool" });
});
