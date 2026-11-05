/**
 * Per-agent cursor colours (F4).
 *
 * The colour is a pure function of the agent id, so the same agent keeps the same
 * colour and the mapping is testable without a display. The overlay that paints it
 * is helper-owned, click-through, and excluded from capture (see `captureWindow`).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { cursorColorFor } from "../src/cursor-colors.ts";

test("the same agent always gets the same colour", () => {
	const first = cursorColorFor("session:0f3d");
	assert.equal(cursorColorFor("session:0f3d"), first);
	assert.equal(cursorColorFor("session:0f3d"), first, "no hidden state between calls");
	assert.match(first, /^#[0-9a-f]{6}$/);
});

test("different agents spread across the palette", () => {
	const ids = Array.from({ length: 24 }, (_, index) => `session:${index.toString(16)}`);
	const colors = new Set(ids.map(cursorColorFor));
	assert.ok(colors.size >= 20, `24 agents should almost never collide, got ${colors.size} colours`);
});

test("two agents driving at once are told apart", () => {
	// The parent and its subagent are the pair that most often drive together.
	const parent = cursorColorFor("session:parent-7");
	const child = cursorColorFor("session:child-7");
	assert.notEqual(parent, child, "a subagent must not paint over its parent's cursor");
	assert.notEqual(cursorColorFor("helper:1"), parent);
});

test("colours are opaque and readable on a light or dark background", () => {
	for (const agentId of ["session:a", "session:b", "helper:1", ""]) {
		const color = cursorColorFor(agentId);
		assert.match(color, /^#[0-9a-f]{6}$/);
		const red = Number.parseInt(color.slice(1, 3), 16);
		const green = Number.parseInt(color.slice(3, 5), 16);
		const blue = Number.parseInt(color.slice(5, 7), 16);
		// Mid lightness: never near-white, never near-black.
		const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
		assert.ok(luminance > 0.2 && luminance < 0.9, `${color} is neither too dark nor too light`);
	}
});
