import assert from "node:assert/strict";
import test from "node:test";
import { prepareAction, type ActionEnvironment } from "../src/actions.ts";
import type { PlatformClipboardSnapshot } from "../src/platform/types.ts";
import { scheduleClipboardRestore } from "../src/bridge.ts";
import { SEMANTIC_ACTION_NAMES, type UiAction } from "../src/contract.ts";

const env: ActionEnvironment = {
	headless: true,
	node: (ref: string) => ({
		ref,
		wireRef: `wire:${ref}`,
		pictureOnly: false,
		role: "button",
		label: "Save",
		canPress: true,
		canFocus: true,
		canSetValue: false,
		isTextInput: false,
		actions: ["AXPress"],
		children: [],
	}) as any,
	center: () => ({ x: 10, y: 10 }),
	validatePoint: () => undefined,
};

const pictureOnlyEnv: ActionEnvironment = {
	...env,
	node: (ref: string) => ({ ...(env.node(ref) as any), wireRef: undefined, pictureOnly: true }),
};

test("every semantic action needs a wire ref, not a point", () => {
	for (const name of SEMANTIC_ACTION_NAMES) {
		const action = { action: name, ref: "@e1" } as UiAction;
		if (name === "setChecked") action.checked = true;
		if (name === "setValue") action.value = 5;
		const prepared = prepareAction(action, { currentFocus: false }, env);
		assert.equal(prepared.action, name);
		assert.deepEqual(prepared.target, { ref: "wire:@e1" });
		assert.equal(prepared.needsForeground, false);

		assert.throws(
			() => prepareAction({ action: name, x: 5, y: 5 } as UiAction, { currentFocus: false }, env),
			/requires an element ref/,
			`${name} must not accept coordinates`,
		);
		assert.throws(
			() => prepareAction(action, { currentFocus: false }, pictureOnlyEnv),
			/picture-only or unmapped/,
			`${name} must not act on a picture-only node`,
		);
	}
});

test("semantic action parameters are validated, not silently defaulted", () => {
	assert.throws(() => prepareAction({ action: "setChecked", ref: "@e1" }, { currentFocus: false }, env), /requires checked/);
	assert.throws(() => prepareAction({ action: "setValue", ref: "@e1" }, { currentFocus: false }, env), /numeric value/);
	const select = prepareAction({ action: "select", ref: "@e1", option: " Fast " }, { currentFocus: false }, env);
	assert.deepEqual(select.params, { option: "Fast" });
	const checked = prepareAction({ action: "setChecked", ref: "@e1", checked: false }, { currentFocus: false }, env);
	assert.equal(checked.params.checked, false);
});

function snapshotOf(changeCount: number, text = ""): PlatformClipboardSnapshot {
	return {
		changeCount,
		totalBytes: text.length,
		items: text ? [{ types: [{ type: "public.utf8-plain-text", dataBase64: Buffer.from(text, "utf8").toString("base64") }] }] : [],
	};
}

function manualTimer(): { setTimer: (callback: () => void) => ReturnType<typeof setTimeout>; run: () => void } {
	let pending: (() => void) | undefined;
	return {
		setTimer: ((callback: () => void) => {
			pending = callback;
			return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout,
		run: () => {
			const callback = pending;
			pending = undefined;
			callback?.();
		},
	};
}

test("a clipboard write restores every item while the clipboard still holds the agent's data", async () => {
	const restored: PlatformClipboardSnapshot[] = [];
	const timer = manualTimer();
	const snapshot = snapshotOf(41, "user text");
	const scheduled = scheduleClipboardRestore({
		snapshot,
		writtenChangeCount: 42,
		restore: true,
		snapshotNow: async () => snapshotOf(42, "agent text"),
		write: async (value) => {
			restored.push(value);
		},
		setTimer: timer.setTimer,
	});
	assert.equal(scheduled, true);
	timer.run();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(restored, [snapshot]);
});

test("a clipboard restore is skipped when the user copied something else", async () => {
	const restored: PlatformClipboardSnapshot[] = [];
	const skips: string[] = [];
	const timer = manualTimer();
	scheduleClipboardRestore({
		snapshot: snapshotOf(41, "user text"),
		writtenChangeCount: 42,
		restore: true,
		// The user copied something new in the 30 second window.
		snapshotNow: async () => snapshotOf(43, "user copied this"),
		write: async (value) => {
			restored.push(value);
		},
		onSkip: (reason) => skips.push(reason),
		setTimer: timer.setTimer,
	});
	timer.run();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(restored, []);
	assert.deepEqual(skips, ["user_changed_clipboard"]);
});

test("a non-text clipboard is snapshotted and restored byte for byte", async () => {
	const restored: PlatformClipboardSnapshot[] = [];
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
	const snapshot: PlatformClipboardSnapshot = {
		changeCount: 7,
		totalBytes: png.byteLength,
		items: [{ types: [{ type: "public.png", dataBase64: png.toString("base64") }] }],
	};
	const timer = manualTimer();
	scheduleClipboardRestore({
		snapshot,
		writtenChangeCount: 8,
		restore: true,
		snapshotNow: async () => snapshotOf(8, "agent text"),
		write: async (value) => {
			restored.push(value);
		},
		setTimer: timer.setTimer,
	});
	timer.run();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(restored.length, 1);
	assert.deepEqual(restored[0].items[0].types[0], { type: "public.png", dataBase64: png.toString("base64") });
});

test("restoration is skipped when it is off or nothing could be captured", () => {
	const setTimer = (() => {
		throw new Error("must not schedule");
	}) as any;
	assert.equal(scheduleClipboardRestore({ snapshot: snapshotOf(1, "x"), writtenChangeCount: 2, restore: false, write: async () => undefined, setTimer }), false);
	assert.equal(scheduleClipboardRestore({ snapshot: undefined, writtenChangeCount: 2, restore: true, write: async () => undefined, setTimer }), false);
});

test("the administration tools are declared deferred, never resident", async () => {
	const { readFileSync } = await import("node:fs");
	const { fileURLToPath } = await import("node:url");
	const registerPath = fileURLToPath(new URL("../../../rotom/extensions/third-party/deferred-tools/register.ts", import.meta.url));
	const source = readFileSync(registerPath, "utf-8");
	const adminStart = source.indexOf('id: "computer_use_admin"');
	assert.ok(adminStart > 0, "the admin group must exist");
	const adminGroup = source.slice(adminStart, source.indexOf("id: \"subagent\""));
	const names = ["manage_app", "manage_window", "clipboard", "system_surface", "cu_session"];
	for (const name of names) assert.ok(adminGroup.includes(`"${name}"`), `${name} must be in the deferred admin group`);

	const residentBlock = source.slice(source.indexOf("RESIDENT_BROWSER_TOOL_NAMES"), source.indexOf("DEFERRED_INITIAL_TOOL_NAMES"));
	for (const name of names) {
		assert.equal(residentBlock.includes(`"${name}"`), false, `${name} must not be resident`);
	}
});

test("every mutating administration tool goes through the broker scheduler", async () => {
	// Review B2: these executors originally called the platform backend directly, so
	// an agent could quit a view-tier app or resize a peer's app without any lease.
	// The broker is the only place that holds the tier decision and the lease, so the
	// wiring is asserted here; the arbitration itself is covered by the scheduler and
	// broker tests.
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("../src/bridge.ts", import.meta.url), "utf8");
	for (const [tool, needle] of [
		["clipboard", "clipboardLease"],
		["manage_app quit", "const quitKey ="],
		["manage_app launch", "const launchKey ="],
		["manage_window", "const windowKey ="],
	] as const) {
		assert.ok(source.includes(needle), `${tool} must route through resourceScheduler (missing ${needle})`);
	}
	assert.equal((source.match(/resourceScheduler\.write\(/g) ?? []).length >= 4, true);
});
