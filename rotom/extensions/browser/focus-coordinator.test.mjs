import assert from "node:assert/strict";
import test from "node:test";
import { createFocusCoordinator, NO_FOCUS_WINDOW_ID } from "./chrome-extension/focus-coordinator.js";
import { withTabWake } from "./chrome-extension/lifecycle-wake.js";

function coordinator() {
	const calls = [];
	let clock = 1_000;
	const focus = createFocusCoordinator({
		now: () => clock,
		updateTab: async (tabId) => { calls.push(["tab", tabId]); },
		updateWindow: async (windowId) => { calls.push(["window", windowId]); },
		windowIdOf: async (windowId) => ({ tabId: windowId === 2 ? 20 : 10, windowId: windowId ?? 1, focused: true }),
	});
	return { focus, calls, advance: (ms) => { clock += ms; } };
}

test("user focus only follows activations outside an agent window", () => {
	const { focus, advance } = coordinator();
	focus.recordActivation({ tabId: 5, windowId: 1 });
	assert.deepEqual(focus.userFocus(), { tabId: 5, windowId: 1, focused: true });
	// A dispatch that steals focus must not become the remembered user focus.
	focus.markAgentActivity(2_000);
	assert.equal(focus.recordActivation({ tabId: 9, windowId: 1 }), false);
	assert.equal(focus.userFocus().tabId, 5);
	advance(2_000);
	assert.equal(focus.recordActivation({ tabId: 7, windowId: 1 }), true);
	assert.equal(focus.userFocus().tabId, 7);
});

test("window focus changes keep the last window when the user leaves Chrome", () => {
	const { focus } = coordinator();
	focus.recordActivation({ tabId: 5, windowId: 3 });
	focus.recordWindowFocus(4);
	assert.deepEqual(focus.userFocus(), { tabId: 5, windowId: 4, focused: true });
	focus.recordWindowFocus(NO_FOCUS_WINDOW_ID);
	assert.deepEqual(focus.userFocus(), { tabId: 5, windowId: 4, focused: false });
});

test("restore returns to the user's tab and window, and tolerates lost targets", async () => {
	const { focus, calls } = coordinator();
	focus.recordActivation({ tabId: 5, windowId: 3 });
	assert.deepEqual(await focus.restore(), { restored: true, tabId: 5, windowId: 3 });
	assert.deepEqual(calls, [["tab", 5], ["window", 3]]);
	// Unfocused user window: the tab moves back but no window is raised.
	const second = createFocusCoordinator({ updateTab: async () => undefined, updateWindow: async () => { throw new Error("gone"); } });
	second.recordActivation({ tabId: 1, windowId: 1 });
	assert.deepEqual(await second.restore(), { restored: true, tabId: 1, windowId: 1 });
	// Nothing recorded yet: restore is a no-op, not an error.
	assert.deepEqual(await createFocusCoordinator().restore(), { restored: false });
});

test("observeActiveTab seeds the record for the requested window", async () => {
	const { focus } = coordinator();
	assert.deepEqual(await focus.observeActiveTab(2), { tabId: 20, windowId: 2, focused: true });
	const failing = createFocusCoordinator({ windowIdOf: async () => { throw new Error("no window"); } });
	assert.equal(await failing.observeActiveTab(), undefined);
	assert.deepEqual(await failing.restore(), { restored: false });
});

test("lifecycle wake is best effort and never fails the operation", async () => {
	const sent = [];
	const diagnostics = [];
	const woken = await withTabWake({ item: { tabId: 4 }, sendCommand: async (debuggee, method, params) => { sent.push({ debuggee, method, params }); }, diagnose: (message) => diagnostics.push(message) });
	assert.deepEqual(woken, { woken: true });
	assert.deepEqual(sent, [{ debuggee: { tabId: 4 }, method: "Page.setWebLifecycleState", params: { state: "active" } }]);
	const failed = await withTabWake({ item: { tabId: 4 }, sendCommand: async () => { throw new Error("Target closed"); }, diagnose: (message) => diagnostics.push(message) });
	assert.deepEqual(failed, { woken: false });
	assert.deepEqual(diagnostics, ["Target closed"]);
	// A missing debugger target identity is not a wake target at all.
	assert.deepEqual(await withTabWake({ item: {}, sendCommand: async () => { throw new Error("must not run"); } }), { woken: false });
});
