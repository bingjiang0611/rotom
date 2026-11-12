import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ApprovalRequestEvent } from "../../../../packages/rotom-computer-use/src/broker/protocol.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(join(root, "rotom/runtime/pi/package.json"));
const { createJiti } = require("jiti");
const alias = {
	"@earendil-works/pi-tui": join(root, "rotom/runtime/pi/node_modules/@earendil-works/pi-tui/dist/index.js"),
	"@earendil-works/pi-coding-agent": join(root, "rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
	typebox: require.resolve("typebox"),
	"typebox/value": require.resolve("typebox/value"),
	"typebox/compile": require.resolve("typebox/compile"),
};
const jiti = createJiti(import.meta.url, { moduleCache: false, alias });
const { selectComputerUseApproval, computerUseApprovalApi } = await jiti.import(join(root, "rotom/extensions/third-party/computer-use/approval.ts"));
const { createBrokerApprovalHandler } = await jiti.import(join(root, "packages/rotom-computer-use/src/broker/approval-ui.ts"));
const { getKeybindings } = await import(alias["@earendil-works/pi-tui"]);
const themes = await import(join(root, "rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"));
themes.initTheme("dark", false);
const theme = themes.theme;
const { InteractiveMode } = await import(join(root, "rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js"));

const choices = ["Allow for this session", "Always allow this app", "Deny"];
function fixture(mode = "tui") {
	const state: any = { rawCalls: 0, customCalls: 0, closed: 0, component: undefined, options: undefined };
	let mounted!: () => void;
	state.mounted = new Promise<void>((resolve) => { mounted = resolve; });
	state.ctx = {
		mode, hasUI: true,
		ui: {
			async select(_title: string, _options: string[], opts: unknown) { state.rawCalls++; state.rpcOpts = opts; return choices[0]; },
			custom(factory: any, options: unknown) {
				state.customCalls++;
				state.options = options;
				return new Promise((resolve, reject) => {
					try {
						state.component = factory({ terminal: { columns: 100, rows: 40 }, requestRender() {} }, theme, getKeybindings(), (value: unknown) => {
							state.closed++;
							resolve(value);
						});
						mounted();
					} catch (error) { reject(error); }
				});
			},
		},
	};
	return state;
}

test("TUI approval renders the real Ask questionnaire in the same overlay and maps each option", async () => {
	for (let index = 0; index < choices.length; index++) {
		const f = fixture();
		const pending = selectComputerUseApproval(f.ctx, "Permission fixture", choices);
		await f.mounted;
		const lines = f.component.render(100);
		assert.ok(lines.length <= 40, "the native overlay respects the host terminal row budget");
		const text = lines.join("\n");
		assert.match(text, /Permission fixture/);
		for (const label of choices) assert.ok(text.includes(label));
		assert.doesNotMatch(text, /Type something\./);
		assert.deepEqual(f.options, { overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: { left: 0, right: 0, bottom: 0 } } });
		for (let i = 0; i < index; i++) f.component.handleInput("\x1b[B");
		f.component.handleInput("\r");
		assert.equal(await pending, choices[index]);
		assert.equal(f.rawCalls, 0);
		assert.equal(f.closed, 1);
	}
});

test("Escape and connection cancellation close only the owned approval and do not grant", async () => {
	for (const cancel of ["escape", "abort"]) {
		const f = fixture();
		const controller = new AbortController();
		const pending = selectComputerUseApproval(f.ctx, "Permission fixture", choices, { signal: controller.signal });
		await f.mounted;
		if (cancel === "escape") f.component.handleInput("\x1b"); else controller.abort();
		assert.equal(await pending, undefined);
		f.component.handleInput("\r");
		assert.equal(f.closed, 1, "late input must not settle the approval twice");
		assert.equal(f.rawCalls, 0);
	}
});

test("actual Pi custom UI removes only the approval overlay on deadline", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const f = fixture();
	const host = Object.create(InteractiveMode.prototype);
	// Constructor-initialized fields showExtensionCustom reads since Pi 1.5 (overlay registry, blocked status).
	host.extensionOverlays = new Map();
	host.nextBlockingOverlayId = 0;
	host.programStatus = { setBlocked() {} };
	const background = { name: "existing-overlay" };
	const overlays: any[] = [background];
	let mounted!: () => void;
	const shown = new Promise<void>((resolve) => { mounted = resolve; });
	host.editor = { getText: () => "user draft", setText() { assert.fail("overlay must not rewrite the editor"); } };
	host.ui = {
		terminal: { columns: 206, rows: 50 },
		requestRender() {},
		showOverlay(component: any, options: any) {
			const own = { component, options }; overlays.push(own); mounted();
			return { hide() { overlays.splice(overlays.indexOf(own), 1); } };
		},
	};
	host.keybindings = getKeybindings();
	f.ctx.ui.custom = host.showExtensionCustom.bind(host);
	const pending = selectComputerUseApproval(f.ctx, "Permission fixture", choices, { timeout: 100 });
	await shown;
	assert.equal(overlays.length, 2);
	const component = overlays[1].component;
	assert.ok(component.render(206).join("\n").includes(choices[0]));
	t.mock.timers.tick(100);
	assert.equal(await pending, undefined);
	assert.deepEqual(overlays, [background]);
	component.handleInput("\r");
	assert.deepEqual(overlays, [background], "late input must not close another overlay");
});

test("an expired or already cancelled prompt never creates an overlay", async () => {
	const controller = new AbortController(); controller.abort();
	for (const opts of [{ timeout: 0 }, { signal: controller.signal }]) {
		const f = fixture();
		assert.equal(await selectComputerUseApproval(f.ctx, "Permission fixture", choices, opts), undefined);
		assert.equal(f.customCalls, 0);
		assert.equal(f.rawCalls, 0);
	}
});

test("cancellation during the shared renderer import never opens a late overlay", async () => {
	const f = fixture();
	const controller = new AbortController();
	const pending = selectComputerUseApproval(f.ctx, "Permission fixture", choices, { signal: controller.signal });
	controller.abort();
	assert.equal(await pending, undefined);
	assert.equal(f.customCalls, 0);
});

test("deadline closes the overlay, and delayed timer execution cannot admit a late choice", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	for (const timerFires of [true, false]) {
		const f = fixture();
		const pending = selectComputerUseApproval(f.ctx, "Permission fixture", choices, { timeout: 100 });
		await f.mounted;
		if (timerFires) t.mock.timers.tick(100);
		else { t.mock.timers.setTime(Date.now() + 101); f.component.handleInput("\r"); }
		assert.equal(await pending, undefined);
		assert.equal(f.closed, 1);
	}
});

test("a finished approval removes its timer and abort listener", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const cleared = t.mock.method(globalThis, "clearTimeout");
	const f = fixture();
	const controller = new AbortController();
	const pending = selectComputerUseApproval(f.ctx, "Permission fixture", choices, { timeout: 100, signal: controller.signal });
	await f.mounted;
	assert.equal(getEventListeners(controller.signal, "abort").length, 1);
	f.component.handleInput("\r");
	assert.equal(await pending, choices[0]);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	assert.equal(cleared.mock.calls.length, 1);
	controller.abort(); t.mock.timers.tick(1000);
	assert.equal(f.closed, 1);
});

test("RPC preserves its native dialog protocol; a failed TUI never falls back to select", async () => {
	const rpc = fixture("rpc"); const opts = { timeout: 100 };
	assert.equal(await selectComputerUseApproval(rpc.ctx, "Permission fixture", choices, opts), choices[0]);
	assert.equal(rpc.rawCalls, 1); assert.equal(rpc.customCalls, 0); assert.equal(rpc.rpcOpts, opts);
	const tui = fixture();
	tui.ctx.ui.custom = async () => { throw new Error("fixture UI failure"); };
	await assert.rejects(() => selectComputerUseApproval(tui.ctx, "Permission fixture", choices), /fixture UI failure/);
	assert.equal(tui.rawCalls, 0);
});

test("product adapter covers session-start and lazy tool contexts without mutating shared UI", async () => {
	const handlers = new Map<string, any>(); let tool: any;
	const api = computerUseApprovalApi({ on(name: string, handler: any) { handlers.set(name, handler); }, registerTool(definition: any) { tool = definition; } });
	let sessionContext: any;
	api.on("session_start", (_event: unknown, ctx: unknown) => { sessionContext = ctx; });
	api.registerTool({ name: "fixture", execute(_id: string, _params: unknown, _signal: unknown, _update: unknown, ctx: any) { return ctx.ui.select("Permission fixture", choices); } });
	const f = fixture();
	handlers.get("session_start")({}, f.ctx);
	const sessionPrompt = sessionContext.ui.select("Permission fixture", choices);
	await f.mounted; f.component.handleInput("\r");
	assert.equal(await sessionPrompt, choices[0]);
	assert.equal(f.rawCalls, 0);
	const lazy = fixture();
	const toolPrompt = tool.execute("fixture", {}, undefined, undefined, lazy.ctx);
	await lazy.mounted; lazy.component.handleInput("\x1b");
	assert.equal(await toolPrompt, undefined); assert.equal(lazy.rawCalls, 0);
	assert.equal(await f.ctx.ui.select("unrelated", choices), choices[0]);
	assert.equal(f.rawCalls, 1, "other extensions retain their own UI");
});

test("context UI lifetime checks and replacement remain authoritative", () => {
	const f = fixture();
	let active = true;
	let currentUI = { ...f.ctx.ui, notify: () => "before" };
	Object.defineProperty(f.ctx, "ui", { get() { if (!active) throw new Error("inactive context"); return currentUI; } });
	let wrapped: any;
	const api = computerUseApprovalApi({ on(_event: string, handler: any) { handler({}, f.ctx); } });
	api.on("session_start", (_event: unknown, ctx: unknown) => { wrapped = ctx; });
	assert.equal(wrapped.ui.notify(), "before");
	currentUI = { ...currentUI, notify: () => "after" };
	assert.equal(wrapped.ui.notify(), "after");
	active = false;
	assert.throws(() => wrapped.ui, /inactive context/);
});

test("the broker handler preserves ordinary approvals and makes external opens one-shot in the shared dialog", async () => {
	for (const [openTarget, index, expected] of [
		["directory", 0, "allow_session"], ["directory", 1, "always"], ["directory", 2, "deny"],
		["file", 0, "allow_once"], ["file", 1, "deny"], ["package", 0, "allow_once"], ["package", 1, "deny"],
		["unknown", 0, "allow_once"], ["unknown", 1, "deny"], [undefined, 0, "allow_once"], [undefined, 1, "deny"],
	] as const) {
		const f = fixture(); let context: any;
		const api = computerUseApprovalApi({ on(_name: string, handler: any) { handler({}, f.ctx); } });
		api.on("session_start", (_event: unknown, ctx: unknown) => { context = ctx; });
		const phases: any[] = [];
		const handler = createBrokerApprovalHandler(context, (entry: unknown) => phases.push(entry));
		const request = {
			event: "approval", requestId: "fixture-approval", agentId: "fixture-agent", resourceKey: "desktop-pid:1",
			deadline: Date.now() + 10000, app: { appName: "fixture-app" }, action: { name: "open", openTarget }, tier: "click",
		} satisfies ApprovalRequestEvent;
		const pending = handler(request, new AbortController().signal);
		await f.mounted;
		if (openTarget !== "directory") {
			const text = f.component.render(100).join("\n");
			assert.ok(text.includes("会用其他程序打开，可能切到前台。"));
			assert.ok(text.includes("Allow this action"));
			assert.doesNotMatch(text, /Allow for this session|Always allow this app/);
		}
		for (let i = 0; i < index; i++) f.component.handleInput("\x1b[B");
		f.component.handleInput("\r");
		assert.equal(await pending, expected);
		assert.deepEqual(phases.map((entry) => entry.phase), ["received", "prompt_requested", "decision"]);
		assert.equal(phases.at(-1).decision, expected);
		assert.equal(f.rawCalls, 0);
	}
});
