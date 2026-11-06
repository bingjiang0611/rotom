import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_KEYS_V1, BROWSER_KEY_MODIFIERS_V1, isBrowserKeyV1, keyEventV1, modifierBitmaskV1, normalizeModifiersV1 } from "./chrome-extension/key-table.js";

test("key-table：白名单固定且不含重复或非预期键", () => {
	assert.equal(new Set(BROWSER_KEYS_V1).size, BROWSER_KEYS_V1.length);
	for (const key of ["Enter", "Tab", "Escape", "ArrowUp", "Backspace", "F12", " ", "a", "0"]) assert.equal(isBrowserKeyV1(key), true, key);
	for (const key of ["F13", "A", "Shift", "Meta", "", "ArrowLeftRight", "q1", "\\n"]) assert.equal(isBrowserKeyV1(key), false, key);
	assert.deepEqual(BROWSER_KEY_MODIFIERS_V1, ["Shift", "Control", "Alt", "Meta"]);
});

test("key-table：字母、数字、空格带字符，功能键不带", () => {
	assert.deepEqual(keyEventV1("a"), { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 0, text: "a", unmodifiedText: "a" });
	assert.deepEqual(keyEventV1("7"), { key: "7", code: "Digit7", windowsVirtualKeyCode: 55, modifiers: 0, text: "7", unmodifiedText: "7" });
	assert.deepEqual(keyEventV1(" "), { key: " ", code: "Space", windowsVirtualKeyCode: 32, modifiers: 0, text: " ", unmodifiedText: " " });
	assert.deepEqual(keyEventV1("Enter"), { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r", unmodifiedText: "\r" });
	const arrow = keyEventV1("ArrowDown");
	assert.deepEqual(arrow, { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, modifiers: 0 });
	assert.equal("text" in arrow, false, "方向键不得带字符");
	assert.deepEqual(keyEventV1("F12"), { key: "F12", code: "F12", windowsVirtualKeyCode: 123, modifiers: 0 });
	assert.equal(keyEventV1("Unknown"), undefined);
});

test("key-table：修饰键换算成 CDP bitmask，顺序不影响结果", () => {
	assert.equal(modifierBitmaskV1([]), 0);
	assert.equal(modifierBitmaskV1(["Shift"]), 8);
	assert.equal(modifierBitmaskV1(["Control"]), 2);
	assert.equal(modifierBitmaskV1(["Alt"]), 1);
	assert.equal(modifierBitmaskV1(["Meta"]), 4);
	assert.equal(modifierBitmaskV1(["Shift", "Control"]), 10);
	assert.equal(modifierBitmaskV1(["Meta", "Shift", "Alt", "Control"]), 15);
	assert.deepEqual(normalizeModifiersV1(undefined), []);
	assert.deepEqual(normalizeModifiersV1(["Meta", "Shift"]), ["Shift", "Meta"]);
	assert.equal(normalizeModifiersV1(["Hyper"]), undefined);
	assert.equal(normalizeModifiersV1(["Shift", "Shift"]), undefined);
	assert.equal(normalizeModifiersV1(["Shift", "Control", "Alt", "Meta", "Shift"]), undefined);
	assert.equal(normalizeModifiersV1("Shift"), undefined);
});

test("key-table：组合键不带字符，Shift 只改字母大小写", () => {
	const selectAll = keyEventV1("a", ["Meta"]);
	assert.equal(selectAll.modifiers, 4);
	assert.equal("text" in selectAll, false, "Meta+A 不得插入字符");
	const ctrlA = keyEventV1("a", ["Control"]);
	assert.equal(ctrlA.modifiers, 2);
	assert.equal("text" in ctrlA, false);
	assert.deepEqual(keyEventV1("a", ["Shift"]), { key: "A", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 8, text: "A", unmodifiedText: "A" });
	// Shift+digit would need a layout-specific symbol; it presses the key without text
	// instead of guessing.
	const shiftedDigit = keyEventV1("1", ["Shift"]);
	assert.equal(shiftedDigit.modifiers, 8);
	assert.equal("text" in shiftedDigit, false);
	assert.equal("text" in keyEventV1("ArrowDown", ["Shift"]), false);
});
