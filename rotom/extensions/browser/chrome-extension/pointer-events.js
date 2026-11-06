// Pointer event sequences for `browser_interact`.
//
// One place decides which CDP mouse events an action sends, so a click, a double click, a
// right click and a drag cannot drift apart. Points are filled in by the relay; this module
// only owns the shape of the sequence.

export const BROWSER_POINTER_ACTIONS_V1 = ["click", "hover", "dblclick", "right_click", "drag"];

/** Minimum number of intermediate moves a drag sends before releasing. */
export const BROWSER_DRAG_MIN_MOVES_V1 = 5;

const move = (point, buttons = 0) => ({ type: "mouseMoved", ...point, button: "none", buttons, pointerType: "mouse" });
const press = (point, button, buttons, clickCount) => ({ type: "mousePressed", ...point, button, buttons, clickCount, pointerType: "mouse" });
const release = (point, button, clickCount) => ({ type: "mouseReleased", ...point, button, buttons: 0, clickCount, pointerType: "mouse" });

/**
 * Events for a single-point action. `hover` only moves the pointer, `dblclick` uses
 * clickCount 2 for the second press/release pair (that is what Chromium turns into a
 * `dblclick` event), `right_click` uses the right button.
 */
export function pointerSequenceV1(action, point) {
	if (action === "hover") return [move(point)];
	if (action === "click") return [move(point), press(point, "left", 1, 1), release(point, "left", 1)];
	if (action === "dblclick") return [move(point), press(point, "left", 1, 1), release(point, "left", 1), press(point, "left", 1, 2), release(point, "left", 2)];
	if (action === "right_click") return [move(point), press(point, "right", 2, 1), release(point, "right", 1)];
	return undefined;
}

/**
 * Events for a drag: press at the start, a bounded number of interpolated moves while the
 * button is held, then release at the end. Intermediate moves are what pointer-based drag
 * libraries listen for.
 */
export function dragSequenceV1(start, end, steps = BROWSER_DRAG_MIN_MOVES_V1) {
	const count = Math.max(BROWSER_DRAG_MIN_MOVES_V1, steps);
	const points = [];
	for (let index = 1; index <= count; index += 1) {
		points.push({ x: start.x + ((end.x - start.x) * index) / count, y: start.y + ((end.y - start.y) * index) / count });
	}
	return {
		before: [move(start), press(start, "left", 1, 1)],
		moves: points.map((point) => move(point, 1)),
		after: [release(end, "left", 1)],
	};
}
