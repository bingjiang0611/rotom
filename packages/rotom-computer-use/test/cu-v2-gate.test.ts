import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error - the gate is a script-library module outside the TS program
import { GateHold, evaluateGate, holdReason, readGate, requireGate } from "../scripts/lib/gate.mjs";

const at = (minutesFromWindowStart: number) => Date.parse("2026-11-06T05:00:00-08:00") + minutesFromWindowStart * 60_000;
const windowStartMs = Date.parse("2026-11-06T05:00:00-08:00");

function gate(overrides: Record<string, unknown> = {}) {
	return evaluateGate({
		windowStart: "2026-11-06T05:00:00-08:00",
		windowStartMs,
		windowMinutes: 60,
		nowMs: at(20),
		...overrides,
	});
}

test("inside the authorized window passes regardless of operator activity", () => {
	const report = gate({ helper: null, hidIdle: 0, requireIdleMinutes: 10 });
	assert.equal(report.verdict, "pass");
	assert.deepEqual(report.gates, { inside_window: true });
});

test("outside the window holds", () => {
	const report = gate({ nowMs: at(61) });
	assert.equal(report.verdict, "hold");
	assert.equal(report.gates.inside_window, false);
	assert.match(holdReason(report), /inside_window=false/);
});

test("the report keeps only authorization-window evidence", () => {
	const report = gate();
	assert.equal(report.window_start, "2026-11-06T05:00:00-08:00");
	assert.equal(report.minutes_left, 40);
	assert.equal("helper" in report, false);
	assert.equal("hid_idle_seconds" in report, false);
	assert.equal("helper_idle_seconds" in report, false);
});

test("requireGate refuses without a declared window", async () => {
	await assert.rejects(requireGate({}), /--window-start and --window-minutes are required/);
	assert.equal(GateHold.name, "GateHold");
});

test("readGate turns the window string into a passing verdict without a helper", async () => {
	const start = new Date(Date.now() - 5 * 60_000).toISOString();
	const report = await readGate({ windowStart: start, windowMinutes: 60 });
	assert.equal(report.gates.inside_window, true);
	assert.ok(report.minutes_left > 50, `minutes_left=${report.minutes_left}`);
	assert.equal(report.verdict, "pass");
});
