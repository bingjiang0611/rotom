/**
 * Event-source grouping for the attribution report (review 7, R2).
 *
 * Two windows recorded 0 -> 72 and 0 -> 103 unmarked events during a twelve-second B1 run
 * with the operator away. The report has to say which process posted them; the rule that
 * decides `run | real user input` was explicitly left alone until the data is reviewed, so
 * these tests also pin that the summary stays a report and nothing else.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
	EVENT_SOURCE_FIELDS,
	attributionRows,
	eventTypeName,
	groupEventSources,
	recordAttribution,
	resolveProcessNames,
	summarizeAttribution,
} from "../scripts/lib/event-sources.mjs";

const HELPER = 100;
const FIXTURE = 200;

test("records are grouped by type, source pid and state, and marked ones are kept apart", () => {
	const events = [
		{ at: 1, type: 5, pid: HELPER, stateId: 1, agent: false },
		{ at: 2, type: 5, pid: HELPER, stateId: 1, agent: false },
		{ at: 3, type: 1, pid: FIXTURE, stateId: 1, agent: false },
		{ at: 4, type: 1, pid: HELPER, stateId: 1, agent: true },
	];
	const groups = groupEventSources(events, { processName: (pid) => (pid === HELPER ? "bridge" : "Fixture") });
	assert.equal(groups.length, 3);
	const [first] = groups;
	assert.deepEqual({ type: first.type, pid: first.pid, count: first.count, process: first.process }, { type: 5, pid: HELPER, count: 2, process: "bridge" });
	assert.equal(groups.filter((group) => group.agent).length, 1);
});

test("a record with no pid or type is dropped instead of guessed", () => {
	const groups = groupEventSources([
		{ at: 1, type: 5, pid: Number.NaN, stateId: 1, agent: false },
		{ at: 2, type: Number.NaN, pid: 3, stateId: 1, agent: false },
		{ at: 3, type: 5, pid: 0, stateId: 0, agent: false },
	]);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].pid, 0);
});

test("the split is a report: only the helper and the run's own pids count as ours", () => {
	const groups = groupEventSources([
		{ at: 1, type: 5, pid: HELPER, stateId: 1, agent: false },
		{ at: 2, type: 1, pid: FIXTURE, stateId: 1, agent: false },
		{ at: 3, type: 10, pid: 4242, stateId: 1, agent: false },
		{ at: 4, type: 10, pid: 4242, stateId: 1, agent: true },
	]);
	const summary = summarizeAttribution(groups, { runPids: [FIXTURE], helperPid: HELPER });
	assert.deepEqual(summary, { fromThisRun: 2, fromElsewhere: 1, total: 3 });
});

test("the rows are inert: they record, they never pass or fail a step", () => {
	const rows = attributionRows(
		[{ at: 1, type: 10, pid: 4242, stateId: 1, agent: false }],
		{ processName: () => "Google Chrome", runPids: [], helperPid: HELPER },
	);
	assert.ok(rows.length >= 2);
	assert.deepEqual([...new Set(rows.map((row) => row.result))], ["recorded"]);
	const [source, summary] = rows;
	assert.match(source.action, /keyDown \/ Google Chrome \/ state 1/);
	assert.match(summary.note, /K2 unchanged/);
});

test("event types are named, unknown raw values stay visible", () => {
	assert.equal(eventTypeName(10), "keyDown");
	assert.equal(eventTypeName(22), "scrollWheel");
	assert.equal(eventTypeName(99), "type99");
});

test("process names are resolved only for pids that exist", () => {
	const calls: string[][] = [];
	const fake = (_command: string, args: string[]) => {
		calls.push(args);
		return "  100 /usr/libexec/thing\n";
	};
	const names = resolveProcessNames([100, 0, -1], { exec: fake as never });
	assert.deepEqual([...names.entries()], [[100, "/usr/libexec/thing"]]);
	assert.deepEqual(calls, [["-p", "100", "-o", "pid=,comm="]]);
	// No pids means no subprocess at all.
	const empty = resolveProcessNames([], { exec: fake as never });
	assert.equal(empty.size, 0);
	assert.equal(calls.length, 1);
});

test("the record schema is metadata only", () => {
	assert.deepEqual([...EVENT_SOURCE_FIELDS], ["at", "type", "pid", "stateId", "agent"]);
	for (const forbidden of ["keyCode", "characters", "x", "y"]) {
		assert.ok(!EVENT_SOURCE_FIELDS.includes(forbidden));
	}
});

/** A run whose counters say `counted` events happened but whose ring holds `records`. */
function ringCase({ records, counted, limit = 512 }) {
	const collected: { area: string; action: string; result: string; note: string }[] = [];
	const activity = {
		userEventCount: counted,
		agentEventCount: 0,
		...(limit === undefined ? {} : { recentEventLimit: limit }),
		...(records === undefined ? {} : { recentEvents: records }),
	};
	const result = recordAttribution({
		activityBefore: { userEventCount: 0, agentEventCount: 0 },
		activityAfter: activity,
		runStartedAt: 1_000,
		processName: () => "bridge",
		helperPid: 4242,
		record: (area: string, action: string, result: string, note: string) => collected.push({ area, action, result, note }),
	});
	return { collected, result };
}

test("T2: a helper that returns no ring is a failure, not zero events", () => {
	const { collected, result } = ringCase({ records: undefined, counted: 0 });
	assert.equal(result.ok, false);
	const ring = collected.find((row) => row.action === "ring");
	assert.equal(ring?.result, "fail");
	assert.match(ring?.note ?? "", /did not return recentEvents/);
	// The dangerous shape: a summary that reads "nothing happened" when nothing was seen.
	assert.equal(collected.some((row) => row.action === "summary"), false);
});

test("T2: a ring that disagrees with the counters is a failure", () => {
	const records = [{ at: 1_001, type: 1, pid: 0, stateId: 1, agent: false }];
	const { collected, result } = ringCase({ records, counted: 3 });
	assert.equal(result.ok, false);
	assert.equal(result.expected, 3);
	assert.equal(result.rows, 1);
	const reconciliation = collected.find((row) => row.action === "ring complete");
	assert.equal(reconciliation?.result, "fail");
	assert.match(reconciliation?.note ?? "", /ring holds 1 records for this run, the counters moved by 3/);
});

test("T2: matching records reconcile and the summary is only a report", () => {
	const records = [
		{ at: 1_001, type: 1, pid: 0, stateId: 1, agent: false },
		{ at: 1_002, type: 1, pid: 5150, stateId: 1, agent: true },
	];
	const { collected, result } = ringCase({ records, counted: 2 });
	assert.equal(result.ok, true);
	assert.equal(collected.find((row) => row.action === "ring complete")?.result, "pass");
	const summary = collected.find((row) => row.action === "summary");
	assert.equal(summary?.result, "recorded");
	assert.match(summary?.note ?? "", /K2 unchanged/);
});

test("T2: events from before the run started do not count towards the reconciliation", () => {
	const records = [
		{ at: 999, type: 1, pid: 0, stateId: 1, agent: false },
		{ at: 1_001, type: 1, pid: 0, stateId: 1, agent: false },
	];
	const { result } = ringCase({ records, counted: 1 });
	assert.equal(result.ok, true, "an older record must not be read as this run's event");
});
