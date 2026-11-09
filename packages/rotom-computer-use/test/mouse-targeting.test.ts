import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "native", "macos", "bridge.swift"), "utf8");

function between(start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from);
	assert.ok(from >= 0 && to > from, `missing Swift section: ${start}`);
	return source.slice(from, to);
}

test("l2 and pid pointer events carry both target-window fields while hid stays untouched", () => {
	const targeting = between("fileprivate func targetMouseEvent", "private func postMouseMove");
	assert.match(targeting, /delivery == "l2" \|\| delivery == "pid"/);
	assert.match(targeting, /mouseEventWindowUnderMousePointer/);
	assert.match(targeting, /mouseEventWindowUnderMousePointerThatCanHandleThisEvent/);
	assert.doesNotMatch(targeting, /delivery == "hid"/);

	const posting = between("private func postMouseMove", "private func modifierFlag");
	for (const method of ["postMouseMove", "postMouseClick", "postMouseDrag", "postScrollWheel"]) {
		assert.match(posting, new RegExp(`private func ${method}[^\\n]*windowId: UInt32`));
	}
	assert.ok((posting.match(/targetMouseEvent\(/g) ?? []).length >= 7, "move, click down/up, drag down/move/up and scroll must all be targeted");
	assert.match(source, /--mouse-target-self-test/);
});

test("diagnostic calibration posts one marked zero-displacement HID mouseMoved and returns ring metadata", () => {
	const calibration = between("func calibrateHidEventSource", "private func takeoverBegin");
	assert.match(calibration, /mouseCursorPosition: source\.location/);
	assert.match(calibration, /eventSourceUserData, value: agentEventMarker/);
	assert.match(calibration, /event\.post\(tap: \.cghidEventTap\)/);
	for (const field of ["found", "pid", "stateId", "type", "agentDelta"]) assert.match(calibration, new RegExp(`"${field}"`));
	assert.doesNotMatch(calibration, /"x"|"y"|location:/, "calibration response must not disclose the cursor coordinate");
});
