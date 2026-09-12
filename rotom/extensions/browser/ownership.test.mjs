import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createOperationGuard } from "./chrome-extension/operation-guard.js";
import { collectListedOwnedTabs } from "./chrome-extension/tab-list-status.js";

const deferred = () => Promise.withResolvers();
const event = () => ({ addListener() {}, removeListener() {} });
async function worker(t, pendingMethod) {
	const calls = [];
	const entered = deferred(); const release = deferred();
	const api = {
		debugger: { onEvent: event(), onDetach: event(), async getTargets() { return [{ tabId: 1, id: "target", type: "page", attached: false, url: "https://example.test" }]; }, async attach() {}, async detach() { calls.push("detach"); }, async sendCommand(_target, method) { calls.push(method); if (method === pendingMethod) { entered.resolve(); return release.promise; } return {}; } },
		tabs: { onRemoved: event(), onUpdated: event(), onCreated: event(), async get() { return { id: 1, status: "complete" }; }, async remove() { calls.push("remove"); } },
		windows: {}, tabGroups: {}, storage: { session: { async set() {} } },
		alarms: { onAlarm: event() }, runtime: { onStartup: event(), onInstalled: event() }, action: { onClicked: event() },
	};
	globalThis.chrome = api;
	t.after(() => { delete globalThis.chrome; });
	let source = await readFile(new URL("./chrome-extension/service-worker.js", import.meta.url), "utf8");
	source = source.replace(/from "(\.\/[^"]+)"/gu, (_, path) => `from ${JSON.stringify(new URL(path, new URL("./chrome-extension/", import.meta.url)).href)}`);
	assert.equal(source.split("void startRelay();").length, 2);
	source = source.replace("void startRelay();", "");
	const mod = await import(`data:text/javascript;base64,${Buffer.from(source + `\nexport { attach, fullRenderedTextSource, closeOwnedIdentity, closeOwned, handleOperation, performInteraction, observation, sessionStates, childSessionsByTabId };\n// ${Math.random()}`).toString("base64")}`);
	return { mod, api, calls, entered, release };
}

// Execute the real worker against a deterministic CDP fixture. This proves command
// ordering and evidence plumbing, not Chrome's native default keyboard behavior.
async function keyboardFixture(t, { scope = "r", focus = true, onKey, onFocus } = {}) {
	const { mod, api } = await worker(t);
	const commands = [], chips = [];
	const document = { activeElement: null };
	const input = { value: "http://127.0.0.1:17472/oauth/callback", isConnected: true, disabled: false, ownerDocument: document, getRootNode: () => document };
	const ref = scope === "r" ? "ax_1_1" : `ax_1_${scope}_1`;
	const item = { tabId: 1, targetId: "target", documentGeneration: 1, lastObservationNodes: [{ ref, role: "textbox", name: "Redirect (Callback) URLs", states: [] }] };
	if (scope !== "r") mod.childSessionsByTabId.set(1, new Map([["child", { scopeId: scope, sessionId: "child", ready: Promise.resolve() }]]));
	api.tabs.get = async () => ({ id: 1, windowId: 2, status: "complete", url: "https://example.test" });
	api.tabs.query = async () => [{ id: 1, windowId: 2, active: false }, { id: 3, windowId: 2, active: true }];
	api.tabs.update = async (id, properties) => { commands.push({ method: "tabs.update", id, properties }); };
	api.windows.get = async () => ({ focused: false });
	api.debugger.sendCommand = async (debuggee, method, params) => {
		commands.push({ debuggee, method, params });
		if (method === "DOM.resolveNode") return { object: { objectId: "input" } };
		if (method === "DOM.focus") { document.activeElement = focus ? input : null; onFocus?.({ input, item, mod }); }
		if (method === "Runtime.callFunctionOn" && params.objectId === "input") return { result: { value: Function(`return (${params.functionDeclaration})`)().call(input) } };
		if (method === "Input.dispatchKeyEvent") {
			if (params.type === "keyDown" && params.key === "Enter") { chips.push(input.value); input.value = ""; }
			await onKey?.({ params, input, item, mod });
		}
		return {};
	};
	const press = (payload = {}, guard = () => {}) => mod.performInteraction("docs", item, { actionId: "key-test", action: "keypress", targetRef: ref, key: "Enter", expect: "value=empty", ...payload }, guard);
	return { mod, item, input, commands, chips, press };
}

for (const scope of ["r", "f1"]) test(`Chrome keypress commits one callback tag with scoped focus/readback: ${scope}`, async (t) => {
	const { press, chips, commands } = await keyboardFixture(t, { scope });
	const result = await press();
	assert.deepEqual(chips, ["http://127.0.0.1:17472/oauth/callback"]);
	assert.equal(result.acknowledged, true);
	assert.equal(result.effect.focusVerified, true);
	assert.equal(result.effect.backgroundPreserved, true);
	assert.equal(result.effect.target.changed, true);
	assert.deepEqual(result.effect.expectation, { requested: "value=empty", outcome: "met" });
	const events = commands.filter((call) => call.method === "Input.dispatchKeyEvent");
	assert.deepEqual(events.map((call) => call.params), [
		{ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, type: "keyDown", text: "\r", unmodifiedText: "\r" },
		{ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, type: "keyUp" },
	]);
	assert.ok(events.every((call) => JSON.stringify(call.debuggee) === JSON.stringify(scope === "r" ? { tabId: 1 } : { tabId: 1, sessionId: "child" })));
	assert.deepEqual(commands.filter((call) => call.method === "Emulation.setFocusEmulationEnabled").map((call) => call.params.enabled), [true, false]);
	assert.deepEqual(commands.filter((call) => call.method === "tabs.update").map((call) => call.id), [3]);
	assert.equal(commands.some((call) => ["Input.insertText", "Page.bringToFront"].includes(call.method)), false);
});

for (const key of ["Tab", "Escape"]) test(`Chrome keypress ${key} has no text insertion`, async (t) => {
	const { press, chips, commands } = await keyboardFixture(t);
	await press({ key });
	assert.deepEqual(chips, []);
	const events = commands.filter((call) => call.method === "Input.dispatchKeyEvent");
	assert.deepEqual(events.map((call) => call.params.type), ["rawKeyDown", "keyUp"]);
	assert.ok(events.every((call) => call.params.key === key && call.params.text === undefined));
});

test("Chrome keypress fails closed for invalid keys, stale/read-only refs and stolen focus", async (t) => {
	const { press, commands, item } = await keyboardFixture(t, { focus: false });
	for (const payload of [{ key: "Meta+Enter" }, { key: undefined }, { targetRef: undefined }, { targetRef: "ax_0_1" }, { targetRef: "ax_1_2" }, { text: "\n" }, { x: 10 }, {}]) await assert.rejects(press(payload), /interaction|targetRef/u);
	item.lastObservationNodes[0].role = "document-text";
	await assert.rejects(press(), /read-only/u);
	assert.equal(commands.some((call) => call.method === "Input.dispatchKeyEvent"), false);
});

for (const change of ["removed", "navigation", "frame"]) test(`Chrome keypress rejects target changed by focus handler: ${change}`, async (t) => {
	const { press, commands } = await keyboardFixture(t, { scope: "f1", onFocus({ input, item, mod }) {
		if (change === "removed") input.isConnected = false;
		if (change === "navigation") item.documentGeneration++;
		if (change === "frame") mod.childSessionsByTabId.clear();
	} });
	await assert.rejects(press(), /focus|stale/u);
	assert.equal(commands.some((call) => call.method === "Input.dispatchKeyEvent"), false);
});

test("Chrome keypress never replays keyDown or dispatches keyUp after owner loss", { timeout: 5000 }, async (t) => {
	const entered = deferred(), release = deferred();
	const { press, commands, chips } = await keyboardFixture(t, { onKey: async () => { entered.resolve(); await release.promise; } });
	const state = { epoch: 0, operationRevision: 0, generation: "old" }; const guard = createOperationGuard(state, 0);
	const pending = press({}, guard.assert); const rejected = assert.rejects(pending, /invalidated/u);
	await entered.promise; guard.invalidate(); release.resolve(); await rejected;
	assert.equal(chips.length, 1, "the unknown keyDown may already have committed the tag");
	assert.deepEqual(commands.filter((call) => call.method === "Input.dispatchKeyEvent").map((call) => call.params.type), ["keyDown"]);
});

test("Chrome attach: retire between commands; late catch cannot detach a replacement", { timeout: 5000 }, async (t) => {
	const { mod, calls, entered, release } = await worker(t, "Page.enable");
	const state = { epoch: 0, operationRevision: 0, generation: "old" };
	const old = createOperationGuard(state, 0);
	const item = { tabId: 1, attached: false };
	const pending = mod.attach(item, old.assert);
	const rejected = assert.rejects(pending, /invalidated/u);
	await entered.promise;
	old.invalidate();
	item.attached = true; item.targetId = "replacement";
	release.resolve({});
	await rejected;
	assert.deepEqual(calls, ["Page.enable"]);
	assert.equal(item.targetId, "replacement");
});

test("Chrome full-read: retire during read; neither restoration nor object cleanup dispatches late", { timeout: 5000 }, async (t) => {
	const { mod, calls, entered, release } = await worker(t, "Runtime.evaluate");
	const state = { epoch: 0, operationRevision: 0, generation: "old" };
	const old = createOperationGuard(state, 0);
	const pending = mod.fullRenderedTextSource({ tabId: 1 }, "r", 60, old.assert);
	const rejected = assert.rejects(pending, /invalidated/u);
	await entered.promise;
	old.invalidate();
	release.resolve({ result: { objectId: "late-object" } });
	await rejected;
	assert.deepEqual(calls, ["Runtime.evaluate"]);
});

test("Chrome rollback checks the exact resource, not reused name or numeric tab ID", async (t) => {
	const { mod, calls } = await worker(t);
	const old = { tabId: 1, ownership: "agent" };
	const replacement = { tabId: 1, ownership: "claimed" };
	const state = { tabsByName: new Map([["docs", replacement]]) };
	await mod.closeOwnedIdentity(state, "docs", 1, old, () => {});
	assert.equal(state.tabsByName.get("docs"), replacement);
	assert.deepEqual(calls, []);
});

test("Chrome tabs: swallowed query errors must not publish stale detached state", { timeout: 5000 }, async () => {
	const entered = deferred(); const release = deferred();
	const state = { epoch: 0, operationRevision: 0, generation: "old" };
	const guard = createOperationGuard(state, 0);
	const item = { tabId: 1, targetId: "old", attached: true };
	const pending = collectListedOwnedTabs({ entries: [["docs", item]], assertOperation: guard.assert, getTargets: async () => [], getTab: async () => { entered.resolve(); return release.promise; }, normalizeUrl: (value) => value });
	const rejected = assert.rejects(pending, /invalidated/u);
	await entered.promise; guard.invalidate(); release.reject(new Error("query unavailable"));
	await rejected;
	assert.equal(item.attached, true);
});

test("Chrome mouse sequence stops before the next dispatch after retirement", { timeout: 5000 }, async (t) => {
	const { mod, api, calls, entered, release } = await worker(t, "Input.dispatchMouseEvent");
	const send = api.debugger.sendCommand;
	api.debugger.sendCommand = (target, method, parameters) => {
		if (method === "Page.getLayoutMetrics") return Promise.resolve({ cssVisualViewport: { clientWidth: 800, clientHeight: 600 } });
		if (method === "DOM.getBoxModel") return Promise.resolve({ model: { border: [10, 10, 40, 10, 40, 40, 10, 40] } });
		return send(target, method, parameters);
	};
	const state = { epoch: 0, operationRevision: 0, generation: "old" }; const guard = createOperationGuard(state, 0);
	const item = { tabId: 1, targetId: "target", documentGeneration: 1, lastObservationNodes: [{ ref: "ax_1_1", role: "button", name: "fixture", states: [] }] };
	const pending = mod.performInteraction("docs", item, { actionId: "x", action: "click", targetRef: "ax_1_1" }, guard.assert);
	const rejected = assert.rejects(pending, /invalidated/u);
	await entered.promise; guard.invalidate(); release.resolve({}); await rejected;
	assert.equal(calls.filter((method) => method === "Input.dispatchMouseEvent").length, 1, "no press/release after the old move completes");
});

test("retiring tab reservation prevents another session claiming it during cleanup", { timeout: 5000 }, async (t) => {
	const { mod, api } = await worker(t); const entered = deferred(), release = deferred();
	api.debugger.detach = async () => { entered.resolve(); await release.promise; };
	const state = { tabsByName: new Map([["docs", { tabId: 1, ownership: "agent" }]]) };
	const closing = mod.closeOwned(state, "docs", () => {}); await entered.promise;
	// Probe dispatch rather than the private Set: any equivalent exclusion design can pass.
	api.tabs.get = async () => { throw new Error("claim reached Chrome"); };
	const claim = () => mod.handleOperation({ tabsByName: new Map() }, "claim", { tabName: "new", tabId: 1 }, 0, () => {});
	try { await assert.rejects(claim(), /already owned/u); }
	finally { release.resolve(); await closing; }
	await assert.rejects(claim(), /claim reached Chrome/u);
});

test("full-read never restores old scroll position after the in-flight scroll loses ownership", { timeout: 5000 }, async (t) => {
	const { mod, api } = await worker(t); const entered = deferred(), release = deferred(); const scrolls = [], cleanup = [];
	api.debugger.sendCommand = async (_debuggee, method, params) => {
		if (method === "Runtime.evaluate") return { result: { objectId: "targets" } };
		if (method === "Runtime.releaseObjectGroup") { cleanup.push(method); return {}; }
		if (params.functionDeclaration.includes("return this.length")) return { result: { value: 1 } };
		if (params.objectId === "targets") return { result: { objectId: "scroll-target" } };
		if (params.arguments) { scrolls.push(params.arguments[0].value); entered.resolve(); return release.promise; }
		return { result: { value: { top: 120, clientHeight: 100, scrollHeight: 500, text: "fixture" } } };
	};
	const state = { epoch: 0, operationRevision: 0, generation: "old" }; const guard = createOperationGuard(state, 0);
	const pending = mod.fullRenderedTextSource({ tabId: 1 }, "r", 60, guard.assert); const rejected = assert.rejects(pending, /invalidated/u);
	await entered.promise; guard.invalidate(); release.resolve({}); await rejected;
	assert.deepEqual(scrolls, [0], "no second scroll or restore to original top=120"); assert.deepEqual(cleanup, []);
});

test("late open cleanup reserves the unpublished tab until removal settles", { timeout: 5000 }, async (t) => {
	const { mod, api } = await worker(t); const created = deferred(), releaseCreate = deferred(), removing = deferred(), releaseRemove = deferred();
	api.tabs.create = async () => { created.resolve(); return releaseCreate.promise; };
	api.tabs.remove = async () => { removing.resolve(); await releaseRemove.promise; };
	const state = { epoch: 0, operationRevision: 0, generation: "old", tabsByName: new Map() }; const guard = createOperationGuard(state, 0);
	const pending = mod.handleOperation(state, "open", { tabName: "old", url: "https://example.test/" }, 0, guard.assert); const rejected = assert.rejects(pending, /invalidated/u);
	await created.promise; guard.invalidate(); releaseCreate.resolve({ id: 1 }); await removing.promise;
	api.tabs.get = async () => { throw new Error("claim reached Chrome"); };
	const claim = () => mod.handleOperation({ tabsByName: new Map() }, "claim", { tabName: "new", tabId: 1 }, 0, () => {});
	try { await assert.rejects(claim(), /already owned/u); }
	finally { releaseRemove.resolve(); await rejected; }
	await assert.rejects(claim(), /claim reached Chrome/u); assert.equal(state.tabsByName.size, 0);
});
