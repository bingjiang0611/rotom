/**
 * The secure-text-field marker (review Q3).
 *
 * The helper looks at the real AX attribute and marks the node; the TypeScript side
 * only carries the flag. Before this, the trace decided by role name, which both
 * missed real secure fields in some payloads and let any app suppress a screenshot by
 * naming a node `AXSecureTextField`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseLookResponse } from "../src/outline.ts";
import { outlineHasSecureField } from "../src/outline/lookup.ts";
import { graftScopedOutline, restoreOutline, serializeOutline } from "../src/outline.ts";

function node(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ref: "wire:1",
		role: "AXTextField",
		actions: [],
		...overrides,
	};
}

function look(outline: Record<string, unknown>) {
	return parseLookResponse({
		lookId: "look-1",
		capturedAt: 1,
		window: { windowId: 7, framePoints: { x: 0, y: 0, w: 10, h: 10 }, scaleFactor: 1, isModal: false, role: "AXWindow", subrole: "" },
		outline,
	});
}

test("the native marker is carried as a field and defaults to false", () => {
	const parsed = look(node({ children: [node({ ref: "wire:2", secure: true })] }));
	assert.equal(parsed.parsedOutline!.root.secure, false);
	assert.equal(parsed.parsedOutline!.root.children[0].secure, true);
	assert.equal(outlineHasSecureField(parsed.parsedOutline), true);
});

test("a role name alone no longer counts as a secure field", () => {
	const parsed = look(node({ role: "AXSecureTextField" }));
	assert.equal(parsed.parsedOutline!.root.secure, false);
	assert.equal(outlineHasSecureField(parsed.parsedOutline), false, "the role is data an app controls, not the marker");
});

test("the marker survives serialization, restore and grafting", () => {
	const parsed = look(node({ children: [node({ ref: "wire:2", secure: true })] }));
	const outline = parsed.parsedOutline!;
	assert.equal(outlineHasSecureField(serializeOutline(outline)), true, "the stored form keeps the flag");
	assert.equal(outlineHasSecureField(restoreOutline(serializeOutline(outline))), true, "and it comes back on restore");

	const scoped = look(node({ ref: "wire:1", children: [node({ ref: "wire:3", secure: true })] })).parsedOutline!;
	const target = outline.root.children[0].ref;
	graftScopedOutline(outline, target, scoped);
	assert.equal(outlineHasSecureField(outline), true, "a scoped look cannot launder a secure field away");
});
