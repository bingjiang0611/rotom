import assert from "node:assert/strict";
import test from "node:test";

import { judgeGlobalInputQuiet, requireQuietGlobalInput } from "../scripts/lib/global-input-gate.mjs";
import { runHidClick } from "../scripts/lib/hid-click.mjs";

const quiet = {
	listening: true,
	listeningSeconds: 30,
	lastUserInputAt: 0,
	idleSeconds: -1,
	userEventCount: 0,
};

test("global input is allowed only after the helper observed a quiet 30-second window", () => {
	assert.equal(judgeGlobalInputQuiet(quiet).allowed, true);
	assert.equal(judgeGlobalInputQuiet({ ...quiet, listeningSeconds: 29.999 }).allowed, false);
	assert.equal(judgeGlobalInputQuiet({ ...quiet, listening: false, listeningSeconds: 90 }).allowed, false);
	assert.equal(judgeGlobalInputQuiet({ ...quiet, listeningSeconds: 90, lastUserInputAt: Date.now(), idleSeconds: 29.999, userEventCount: 1 }).allowed, false);
	assert.equal(judgeGlobalInputQuiet({ ...quiet, listeningSeconds: 90, lastUserInputAt: Date.now() - 31_000, idleSeconds: 31, userEventCount: 1 }).allowed, true);
});

test("a recent unmarked input records skipped and fails closed", async () => {
	const rows: Array<{ area: string; action: string; result: string; note: string }> = [];
	const result = await requireQuietGlobalInput({
		helper: { command: async () => ({ ...quiet, listeningSeconds: 90, lastUserInputAt: Date.now(), idleSeconds: 2, userEventCount: 7 }) },
		record: (area: string, action: string, result: string, note: string) => rows.push({ area, action, result, note }),
	});
	assert.equal(result.allowed, false);
	assert.deepEqual(rows.map(({ area, action, result }) => ({ area, action, result })), [
		{ area: "gate", action: "global input quiet", result: "skipped" },
	]);
});

test("B6 sends no global action when the quiet-input gate does not pass", async () => {
	const rows: Array<{ area: string; action: string; result: string; note: string }> = [];
	let actCalls = 0;
	const result = await runHidClick({
		backend: {
			act: async () => { actCalls += 1; return { outcome: "worked", performed: { delivery: "hid" } }; },
			observe: async () => ({ parsedOutline: { nodes: [] } }),
			userActivity: async () => ({ agentEventCount: 0, userEventCount: 0 }),
		},
		helper: { command: async () => ({ ...quiet, listeningSeconds: 90, lastUserInputAt: Date.now(), idleSeconds: 1, userEventCount: 1 }) },
		look: { lookId: "look-1", parsedOutline: { nodes: [{ identifier: "cu-fixture-button", wireRef: "@e1" }] } },
		root: { windowId: 7, rootRef: "@r7" },
		fixture: { pid: 51 },
		record: (area: string, action: string, status: string, note: string) => rows.push({ area, action, result: status, note }),
	});
	assert.equal(actCalls, 0);
	assert.equal(result.stopped, true);
	assert.equal(rows.find((row) => row.action === "global input quiet")?.result, "skipped");
	assert.equal(rows.find((row) => row.action === "click went through HID")?.result, "skipped");
	assert.equal(rows.find((row) => row.action === "click took effect")?.result, "skipped");
});

test("a helper read failure also skips the global action", async () => {
	const rows: Array<{ result: string }> = [];
	const result = await requireQuietGlobalInput({
		helper: { command: async () => { throw new Error("tap unavailable"); } },
		record: (_area: string, _action: string, status: string) => rows.push({ result: status }),
	});
	assert.equal(result.allowed, false);
	assert.deepEqual(rows, [{ result: "skipped" }]);
});
