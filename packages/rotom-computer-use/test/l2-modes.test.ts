/**
 * B1's directed-click judgement (2026-11-06 window).
 *
 * The first real run reported `delivery=l2` with `outcome=unknown`: the targeted post
 * reached the app, but nothing confirmed the effect, so the step could not pass. These
 * tests pin the three ways that can resolve, without a machine.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { fixtureResultSignature, judgeDirectedClick } from "../scripts/lib/l2-modes.mjs";

const base = { survived: true, delivery: "l2", outcome: "unknown" };

test("a confirmed outcome passes on the transport alone", () => {
	assert.deepEqual(judgeDirectedClick({ ...base, outcome: "worked", before: "a", after: "a" }), { result: "pass", reason: "outcome" });
});

test("an unconfirmed outcome passes when the app's own result line changed", () => {
	// This is the case the first run needed: the helper says `unknown`, the fixture says
	// it was clicked.
	assert.deepEqual(judgeDirectedClick({ ...base, before: '{"value":"idle"}', after: '{"value":"clicked"}' }), { result: "pass", reason: "readback" });
});

test("an unconfirmed outcome with no readback change stays inconclusive", () => {
	assert.deepEqual(judgeDirectedClick({ ...base, before: "idle", after: "idle" }), { result: "inconclusive", reason: "unknown and no readback change" });
	// A target that was never readable is not the same as one that did not change.
	assert.equal(judgeDirectedClick({ ...base, before: undefined, after: undefined }).result, "inconclusive");
	assert.match(judgeDirectedClick({ ...base, outcome: "didnt", before: "x", after: "x" }).reason, /didnt/);
});

test("a wrong transport or a dead helper is a failure, never a pass", () => {
	assert.equal(judgeDirectedClick({ ...base, delivery: "ax", outcome: "worked" }).result, "fail");
	assert.equal(judgeDirectedClick({ ...base, survived: false, outcome: "worked" }).result, "fail");
	// A changed readback must not rescue a pid post: the point of B1 is `delivery=l2`.
	assert.equal(judgeDirectedClick({ ...base, delivery: "pid", before: "idle", after: "clicked" }).result, "fail");
});

test("the signature keeps whatever field carries the text", async () => {
	const look = (nodes: unknown[]) => ({ parsedOutline: { nodes } });
	const withValue = { observe: async () => look([{ identifier: "cu-fixture-button-result", value: "clicked" }]) };
	const withLabel = { observe: async () => look([{ identifier: "cu-fixture-button-result", label: "idle" }]) };
	const missing = { observe: async () => look([{ identifier: "cu-fixture-button" }]) };
	assert.match(await fixtureResultSignature(withValue, { windowId: 1 }), /clicked/);
	assert.match(await fixtureResultSignature(withLabel, { windowId: 1 }), /idle/);
	assert.equal(await fixtureResultSignature(missing, { windowId: 1 }), undefined);
});
