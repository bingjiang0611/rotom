import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error - the gate is a script-library module outside the TS program
import { GateHold, evaluateGate, requireGate } from "../scripts/lib/gate.mjs";

const at = (minutesFromWindowStart: number) => Date.parse("2026-11-06T05:00:00-08:00") + minutesFromWindowStart * 60_000;
const windowStartMs = Date.parse("2026-11-06T05:00:00-08:00");

function gate(overrides: Record<string, unknown> = {}) {
	return evaluateGate({
		windowStart: "2026-11-06T05:00:00-08:00",
		windowStartMs,
		windowMinutes: 60,
		requireIdleMinutes: 10,
		nowMs: at(20),
		hidIdle: 700,
		helper: { listening: true, lastUserInputAt: at(20) - 700_000, userEventCount: 42 },
		...overrides,
	});
}

test("inside the window with a long real-input gap passes", () => {
	const report = gate();
	assert.equal(report.verdict, "pass");
	assert.deepEqual(report.gates, { inside_window: true, no_recent_user_input: true });
});

test("recent real input holds the gate", () => {
	const report = gate({ helper: { listening: true, lastUserInputAt: at(20) - 100_000, userEventCount: 9000 } });
	assert.equal(report.verdict, "hold");
	assert.equal(report.gates.no_recent_user_input, false);
});

test("outside the window holds even when the machine is idle", () => {
	const report = gate({ nowMs: at(61) });
	assert.equal(report.verdict, "hold");
	assert.equal(report.gates.inside_window, false);
});

test("a helper that has never seen input needs a full listening window to count", () => {
	// Zero events two seconds after the tap came up proves nothing.
	const early = gate({ helper: { listening: true, lastUserInputAt: 0, userEventCount: 0 }, listeningSinceMs: at(20) - 30_000 });
	assert.equal(early.gates.no_recent_user_input, false);
	const long = gate({ helper: { listening: true, lastUserInputAt: 0, userEventCount: 0 }, listeningSinceMs: at(20) - 700_000 });
	assert.equal(long.gates.no_recent_user_input, true);
});

test("no helper reading never passes, however idle the kernel looks", () => {
	const report = gate({ helper: null, helperError: "socket missing", hidIdle: 3600 });
	assert.equal(report.verdict, "hold");
	assert.equal(report.gates.no_recent_user_input, false);
	assert.equal(report.helper_error, "socket missing");
});

test("the readings are kept in the report for the archive", () => {
	const report = gate();
	assert.equal(report.window_start, "2026-11-06T05:00:00-08:00");
	assert.equal(report.hid_idle_seconds, 700);
	assert.equal(report.helper_idle_seconds, 700);
	assert.equal(report.helper.userEventCount, 42);
	assert.equal(report.minutes_left, 40);
});

test("requireGate refuses without a declared window instead of running anyway", async () => {
	await assert.rejects(requireGate({}), /--window-start and --window-minutes are required/);
	assert.equal(GateHold.name, "GateHold");
});
