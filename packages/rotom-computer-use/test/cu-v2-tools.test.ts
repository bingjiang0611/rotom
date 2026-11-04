import assert from "node:assert/strict";
import test from "node:test";
import { prepareAction, type ActionEnvironment } from "../src/actions.ts";
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

test("a clipboard write can restore the user's text on a timer", () => {
	const restored: string[] = [];
	const timers: Array<() => void> = [];
	const scheduled = scheduleClipboardRestore({
		previous: "user text",
		restore: true,
		write: async (text) => { restored.push(text); },
		setTimer: ((callback: () => void) => {
			timers.push(callback);
			return { unref: () => undefined } as any;
		}) as any,
	});
	assert.equal(scheduled, true);
	assert.equal(timers.length, 1);
	timers[0]();
	return new Promise<void>((resolve) => setTimeout(() => {
		assert.deepEqual(restored, ["user text"]);
		resolve();
	}, 0));
});

test("restoration is skipped when it is off or there was nothing to keep", () => {
	const writes: string[] = [];
	const setTimer = (() => { throw new Error("must not schedule"); }) as any;
	assert.equal(scheduleClipboardRestore({ previous: "x", restore: false, write: async () => undefined, setTimer }), false);
	assert.equal(scheduleClipboardRestore({ previous: "", restore: true, write: async () => undefined, setTimer }), false);
	assert.deepEqual(writes, []);
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
