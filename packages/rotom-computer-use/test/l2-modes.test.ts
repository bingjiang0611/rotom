/**
 * B1's directed-click judgement, second form (review 7, R1).
 *
 * The first form compared two booleans, and the 23:36 run showed why that cannot work: the
 * script clicks the fixture button through the AX path first, so the directed click ran on
 * an app that already said `clicked` and had nothing left to prove. The fixture now
 * publishes `clicks: N` and the judgement is "the count went up by exactly one".
 */
import assert from "node:assert/strict";
import test from "node:test";

import { fixtureClickCount, judgeDirectedClick, parseClickCount } from "../scripts/lib/l2-modes.mjs";

const base = { survived: true, delivery: "l2", outcome: "unknown" };

test("count plus one passes on the readback", () => {
	assert.deepEqual(judgeDirectedClick({ ...base, before: 0, after: 1 }), { result: "pass", reason: "readback 0->1" });
	assert.deepEqual(judgeDirectedClick({ ...base, outcome: "worked", before: 4, after: 5 }), { result: "pass", reason: "readback 4->5" });
});

test("an unchanged count is a failure even when the helper claims it worked", () => {
	// The helper's self-report is not evidence: a setter can report success without the
	// click landing, which is exactly what the boolean readback could not tell apart.
	assert.equal(judgeDirectedClick({ ...base, before: 1, after: 1 }).result, "fail");
	assert.equal(judgeDirectedClick({ ...base, outcome: "worked", before: 1, after: 1 }).result, "fail");
});

test("a jump of two is unknown, not a pass", () => {
	// Something else clicked while we were watching; the run cannot claim the effect.
	const judged = judgeDirectedClick({ ...base, before: 0, after: 2 });
	assert.equal(judged.result, "unknown");
	assert.match(judged.reason, /not exactly one click/);
});

test("a wrong transport or a dead helper is a failure, never a pass", () => {
	assert.equal(judgeDirectedClick({ ...base, delivery: "pid", before: 0, after: 1 }).result, "fail");
	assert.equal(judgeDirectedClick({ ...base, survived: false, before: 0, after: 1 }).result, "fail");
	// The AX path is judged by the same readback, with its own expected delivery.
	assert.equal(judgeDirectedClick({ ...base, delivery: "ax", expectedDelivery: "ax", before: 0, after: 1 }).result, "pass");
});

test("an unreadable counter is inconclusive, never a pass", () => {
	assert.equal(judgeDirectedClick({ ...base, before: undefined, after: 1 }).result, "inconclusive");
	assert.equal(judgeDirectedClick({ ...base, outcome: "worked" }).result, "inconclusive");
});

test("the counter is parsed from whatever field carries the text", async () => {
	assert.equal(parseClickCount("clicks: 7"), 7);
	assert.equal(parseClickCount("Fixture action clicks: 12"), 12);
	assert.equal(parseClickCount("clicked"), undefined);
	assert.equal(parseClickCount(undefined), undefined);

	const look = (nodes: unknown[]) => ({ parsedOutline: { nodes } });
	const withValue = { observe: async () => look([{ identifier: "cu-fixture-button-result", value: "clicks: 3" }]) };
	const withLabel = { observe: async () => look([{ identifier: "cu-fixture-button-result", label: "clicks: 0" }]) };
	const missing = { observe: async () => look([{ identifier: "cu-fixture-button" }]) };
	assert.equal(await fixtureClickCount(withValue, { windowId: 1 }), 3);
	assert.equal(await fixtureClickCount(withLabel, { windowId: 1 }), 0);
	assert.equal(await fixtureClickCount(missing, { windowId: 1 }), undefined);
});

test("R9: an unchanged counter is ambiguous only when the click activated the window", () => {
	const base = { survived: true, delivery: "l2", outcome: "unknown", before: 1, after: 1 };
	// The second B0 window could not tell these apart, which is why the activation readback exists.
	const activated = judgeDirectedClick({ ...base, activated: true });
	assert.equal(activated.result, "inconclusive");
	assert.match(activated.reason, /activated the fixture window/);
	const nothing = judgeDirectedClick({ ...base, activated: false });
	assert.equal(nothing.result, "fail");
	assert.match(nothing.reason, /readback unchanged at 1/);
	// A click that was counted is a pass whether or not the window had to be activated first.
	assert.equal(judgeDirectedClick({ ...base, after: 2, activated: true }).result, "pass");
	assert.equal(judgeDirectedClick({ ...base, after: 3, activated: false }).result, "unknown");
});
