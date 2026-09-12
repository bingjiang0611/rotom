import assert from "node:assert/strict";
import { test } from "node:test";
import { canRetryInForeground, type PreparedAction } from "../src/actions.ts";

const typeText = { action: "typeText" } as unknown as PreparedAction;
const keypress = { action: "keypress" } as unknown as PreparedAction;
const click = { action: "click" } as unknown as PreparedAction;

test("speculative foreground retry is OFF by default (no auto-replay of delivered input)", () => {
	assert.equal(canRetryInForeground(typeText, "didnt", false, {}), false);
	assert.equal(canRetryInForeground(keypress, "didnt", false, {}), false);
});

test("opt-in env restores upstream behaviour for typeText/keypress didnt", () => {
	const env = { ROTOM_CU_SPECULATIVE_FOREGROUND_RETRY: "1" };
	assert.equal(canRetryInForeground(typeText, "didnt", false, env), true);
	assert.equal(canRetryInForeground(keypress, "didnt", false, env), true);
});

test("opt-in still respects headless and outcome and action-type gates", () => {
	const env = { ROTOM_CU_SPECULATIVE_FOREGROUND_RETRY: "true" };
	assert.equal(canRetryInForeground(typeText, "didnt", true, env), false, "headless never escalates");
	assert.equal(canRetryInForeground(typeText, "worked", false, env), false, "only didnt escalates");
	assert.equal(canRetryInForeground(click, "didnt", false, env), false, "only typeText/keypress escalate");
});

test("opt-in accepts 1/true/yes case-insensitively and rejects other values", () => {
	for (const v of ["1", "true", "TRUE", "Yes"]) {
		assert.equal(
			canRetryInForeground(typeText, "didnt", false, { ROTOM_CU_SPECULATIVE_FOREGROUND_RETRY: v }),
			true,
			`should opt in for ${v}`,
		);
	}
	for (const v of ["0", "false", "", "off", "2"]) {
		assert.equal(
			canRetryInForeground(typeText, "didnt", false, { ROTOM_CU_SPECULATIVE_FOREGROUND_RETRY: v }),
			false,
			`should stay off for ${v}`,
		);
	}
});
