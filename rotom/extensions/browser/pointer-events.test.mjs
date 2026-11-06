import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_DRAG_MIN_MOVES_V1, BROWSER_POINTER_ACTIONS_V1, dragSequenceV1, pointerSequenceV1 } from "./chrome-extension/pointer-events.js";

const point = { x: 10, y: 20 };

test("pointer：hover 只移动，click 是一次按下抬起", () => {
	assert.deepEqual(pointerSequenceV1("hover", point), [{ type: "mouseMoved", x: 10, y: 20, button: "none", buttons: 0, pointerType: "mouse" }]);
	const click = pointerSequenceV1("click", point);
	assert.deepEqual(click.map((event) => event.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
	assert.deepEqual(click.filter((event) => event.type !== "mouseMoved").map((event) => [event.button, event.clickCount]), [["left", 1], ["left", 1]]);
	assert.equal(pointerSequenceV1("scroll", point), undefined, "非指针动作没有鼠标序列");
});

test("pointer：dblclick 用 clickCount 2 的第二次按下抬起", () => {
	const events = pointerSequenceV1("dblclick", point);
	assert.deepEqual(events.map((event) => `${event.type}:${event.clickCount ?? "-"}`), ["mouseMoved:-", "mousePressed:1", "mouseReleased:1", "mousePressed:2", "mouseReleased:2"]);
});

test("pointer：right_click 用右键且不按左键", () => {
	const events = pointerSequenceV1("right_click", point);
	assert.deepEqual(events.map((event) => [event.type, event.button]), [["mouseMoved", "none"], ["mousePressed", "right"], ["mouseReleased", "right"]]);
	assert.equal(events[1].buttons, 2);
	assert.equal(events[2].buttons, 0);
});

test("pointer：drag 先按下、至少 5 次按住移动、最后在终点抬起", () => {
	const drag = dragSequenceV1(point, { x: 110, y: 20 });
	assert.deepEqual(drag.before.map((event) => event.type), ["mouseMoved", "mousePressed"]);
	assert.equal(drag.moves.length >= BROWSER_DRAG_MIN_MOVES_V1, true);
	assert.ok(drag.moves.every((event) => event.buttons === 1 && event.button === "none"));
	assert.deepEqual(drag.moves.at(-1), { type: "mouseMoved", x: 110, y: 20, button: "none", buttons: 1, pointerType: "mouse" });
	assert.deepEqual(drag.after, [{ type: "mouseReleased", x: 110, y: 20, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" }]);
	// Intermediate points are monotonic and never exceed the requested step count.
	const steps = dragSequenceV1({ x: 0, y: 0 }, { x: 100, y: 100 }, 8).moves.map((event) => event.x);
	assert.deepEqual(steps, [12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100]);
	assert.equal(dragSequenceV1({ x: 0, y: 0 }, { x: 10, y: 10 }, 1).moves.length, BROWSER_DRAG_MIN_MOVES_V1, "少于下限时补齐");
	assert.deepEqual(BROWSER_POINTER_ACTIONS_V1, ["click", "hover", "dblclick", "right_click", "drag"]);
});
