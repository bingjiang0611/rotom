import test from "node:test";
import assert from "node:assert/strict";
import { isCleared, isWaiting } from "./state.mjs";

test("completion accepts persisted null and absent Goal, not an active/paused object", () => {
	assert.equal(isCleared(null), true);
	assert.equal(isCleared(undefined), true);
	for (const status of ["active", "paused", "blocked"]) assert.equal(isCleared({ status }), false);
});
test("wake uses the actual waiting field, only on active Goals", () => {
	assert.equal(isWaiting({ status: "active", waiting: { reason: "host event" } }), true);
	assert.equal(isWaiting({ status: "active", wait: { reason: "wrong field" } }), false);
	assert.equal(isWaiting({ status: "paused", waiting: { reason: "host event" } }), false);
	assert.equal(isWaiting(null), false);
});
