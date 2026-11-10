import assert from "node:assert/strict";
import test from "node:test";
import { foldToBudget, outlineNodePath, parseLookResponse } from "../src/outline.ts";

function outlineFixture() {
	return parseLookResponse({
		lookId: "look-render",
		outline: {
			ref: "window",
			role: "AXWindow",
			title: "Files",
			children: [{
				ref: "toolbar",
				role: "AXGroup",
				description: "Toolbar",
				children: [{
					ref: "close",
					role: "AXButton",
					subrole: "AXCloseButton",
					title: 'Close "Files"',
					actions: ["press"],
				}],
			}],
		},
	}).parsedOutline!;
}

test("renders a parsed observation with the same labels as node paths", () => {
	const outline = outlineFixture();
	const rendered = foldToBudget(outline);
	assert.equal(rendered.text, [
		'@e1 AXWindow "Files"',
		'  @e2 AXGroup "Toolbar"',
		'    @e3 AXButton/AXCloseButton "Close \\"Files\\"" {press}',
	].join("\n"));
	assert.equal(outlineNodePath(outline.nodes[2]),
		'AXWindow "Files" ▸ AXGroup "Toolbar" ▸ AXButton/AXCloseButton "Close \\"Files\\""');
	assert.deepEqual(rendered.renderedRefs, ["@e1", "@e2", "@e3"]);
	assert.equal(rendered.nodeCount, 3);
	assert.equal(rendered.truncated, false);
});

test("folding and explicit expansion preserve the node labels and tree", () => {
	const outline = outlineFixture();
	const folded = foldToBudget(outline, { maxDepth: 1 });
	assert.equal(folded.text, '@e1 AXWindow "Files"\n  @e2 AXGroup "Toolbar" ▸ (1: 1 button)');
	assert.deepEqual(folded.renderedRefs, ["@e1", "@e2"]);
	assert.equal(outline.nodes.length, 3);
	assert.equal(outline.root.children[0].children[0], outline.nodes[2]);

	const expanded = foldToBudget(outline, { maxDepth: 1 }, ["@e2"]);
	assert.equal(expanded.text, foldToBudget(outline).text);
	assert.deepEqual(expanded.renderedRefs, ["@e1", "@e2", "@e3"]);
});
