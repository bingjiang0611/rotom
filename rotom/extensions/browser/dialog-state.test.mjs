import assert from "node:assert/strict";
import test from "node:test";
import {
	DIALOG_CURRENT_TAB_OPERATIONS_V1,
	DIALOG_EXEMPT_OPERATIONS_V1,
	MAX_DIALOG_MESSAGE_CHARS_V1,
	createDialogStateV1,
	truncateDialogTextV1,
} from "./chrome-extension/dialog-state.js";

test("dialog：记录类型、截断消息与 defaultPrompt", () => {
	const state = createDialogStateV1({ now: () => 1_700_000_000_000 });
	const opened = state.opened(7, { type: "prompt", message: "Name?", defaultPrompt: "Ada" });
	assert.equal(opened.type, "prompt");
	assert.equal(opened.message, "Name?");
	assert.equal(opened.defaultPrompt, "Ada");
	assert.equal(opened.sensitive, false);
	assert.equal(opened.openedAt, 1_700_000_000_000);
	const long = state.opened(8, { type: "alert", message: "x".repeat(MAX_DIALOG_MESSAGE_CHARS_V1 + 50) });
	assert.equal([...long.message].length, MAX_DIALOG_MESSAGE_CHARS_V1);
	assert.equal(long.messageTruncated, true);
	// Only prompt dialogs carry a default prompt; a stray value must not be recorded.
	assert.equal(state.opened(9, { type: "alert", defaultPrompt: "ignored" }).defaultPrompt, undefined);
});

test("dialog：未知类型归为 alert，非法 tabId 不记录", () => {
	const state = createDialogStateV1();
	assert.equal(state.opened(1, { type: "made-up" }).type, "alert");
	assert.equal(state.opened(1, { type: "alert", message: undefined }).message, "");
	assert.equal(state.opened(-1, { type: "alert" }), undefined);
	assert.equal(state.opened("3", { type: "alert" }), undefined);
	assert.equal(state.size, 1);
});

test("dialog：打开期间除 dialog/tabs/close/recover 外全部返回 dialog-blocking", () => {
	const state = createDialogStateV1();
	assert.equal(state.blocking("snapshot", 5), undefined, "没有弹窗时不拦截");
	state.opened(5, { type: "confirm", message: "Delete?" });
	for (const operation of DIALOG_EXEMPT_OPERATIONS_V1) assert.equal(state.blocking(operation, 5), undefined, operation);
	for (const operation of ["snapshot", "snapshot_visible", "read_full", "screenshot", "console", "network", "wait", "switch", "interact", "navigate", "open", "claim", "handoff", "transfer", "discover"]) {
		const blocked = state.blocking(operation, 5);
		assert.ok(blocked, operation);
		assert.equal(blocked.kind, "dialog-blocking");
		assert.equal(blocked.dialog.type, "confirm");
		assert.equal(blocked.dialog.message, "Delete?");
	}
	// Another tab is unaffected, and an unknown tab is never blocked.
	assert.equal(state.blocking("snapshot", 6), undefined);
	assert.equal(state.blocking("snapshot", undefined), undefined);
});

test("dialog：只有寻址当前 tab 的操作会在省略 tabName 时落到当前 tab", () => {
	// `open`/`discover`/`hello` must not be blocked by another tab's dialog.
	for (const operation of ["open", "discover", "hello", "transfer", "claim"]) assert.equal(DIALOG_CURRENT_TAB_OPERATIONS_V1.includes(operation), false, operation);
	for (const operation of ["interact", "snapshot", "read_full", "screenshot", "console", "network", "wait"]) assert.equal(DIALOG_CURRENT_TAB_OPERATIONS_V1.includes(operation), true, operation);
});

test("dialog：beforeunload 标为敏感，关闭后状态清空", () => {
	const state = createDialogStateV1();
	const opened = state.opened(2, { type: "beforeunload" });
	assert.equal(opened.sensitive, true);
	assert.equal(opened.type, "beforeunload");
	const closed = state.closed(2);
	assert.equal(closed.type, "beforeunload");
	assert.equal(state.blocking("snapshot", 2), undefined, "关闭后必须恢复");
	assert.equal(state.closed(2), undefined, "重复关闭是空操作");
	state.opened(3, { type: "alert" });
	state.reset(3);
	assert.equal(state.size, 0);
});

test("dialog：文本按码点截断，代理对不会被劈开", () => {
	assert.deepEqual(truncateDialogTextV1("ab", 4), { text: "ab", truncated: false });
	assert.deepEqual(truncateDialogTextV1("😀😀😀", 2), { text: "😀😀", truncated: true });
	assert.equal([...truncateDialogTextV1("😀😀😀", 2).text].length, 2);
	assert.deepEqual(truncateDialogTextV1(undefined, 4), { text: "", truncated: false });
});
