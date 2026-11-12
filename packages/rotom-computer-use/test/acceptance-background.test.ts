import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../scripts/lib/acceptance-agents.mjs", import.meta.url), "utf8");
const script = readFileSync(new URL("../scripts/cu-v2-acceptance.mjs", import.meta.url), "utf8");

test("B3 acceptance does not count foreground_required as background success", () => {
	assert.match(source, /const judged = outcome === "worked" \? "pass"/);
	assert.doesNotMatch(source, /outcome === "foreground_required" \? "pass"/);
});

test("failed or exited acceptance fixtures still remove their copied bundle", () => {
	assert.match(source, /pendingTimeoutMs: 60_000/);
	assert.match(script, /if \(!app\) \{[\s\S]*?rmSync\(instance\.directory/);
});

test("the agent click is verified from the fixture's selected-tab state", () => {
	const start = source.indexOf("\tasync function selectedTabState(");
	const end = source.indexOf("\n\t/** The five fixed subtasks", start);
	const tabState = source.slice(start, end);
	assert.match(tabState, /cu-fixture-selected-tab/);
	assert.doesNotMatch(tabState, /wireRef/);
	assert.match(source, /const changed = before !== undefined && after !== undefined && after !== before/);
	assert.match(source, /verified by selected-tab readback/);
});
