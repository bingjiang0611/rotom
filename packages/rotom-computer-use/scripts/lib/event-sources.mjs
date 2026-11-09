/**
 * Where the events the helper counted as real user input came from (review 7, R2).
 *
 * Two runs reported 0 -> 72 and 0 -> 103 unmarked events in the eleven seconds a B1 run
 * took, with the operator away and the frontmost app unchanged. The events are therefore
 * almost certainly ours - the fixture launch activates an app, and the directed post is a
 * second candidate - but "almost certainly" is not a finding. The helper now keeps a
 * bounded ring of source records (event type, source pid, source state, agent marker) and
 * this module groups them for the archive.
 *
 * The ring carries no key code, no character and no coordinate: the question is who posted
 * an event, not what it said (root `CLAUDE.md` §5).
 */
import { execFileSync } from "node:child_process";

/** `CGEventType` raw values the helper's tap subscribes to, plus the ones it may see. */
const TYPE_NAMES = new Map([
	[0, "null"],
	[1, "leftMouseDown"],
	[2, "leftMouseUp"],
	[3, "rightMouseDown"],
	[4, "rightMouseUp"],
	[5, "mouseMoved"],
	[6, "leftMouseDragged"],
	[7, "rightMouseDragged"],
	[10, "keyDown"],
	[11, "keyUp"],
	[12, "flagsChanged"],
	[22, "scrollWheel"],
	[23, "tabletPointer"],
	[24, "tabletProximity"],
	[25, "otherMouseDown"],
	[26, "otherMouseUp"],
	[27, "otherMouseDragged"],
]);

/** The only fields a record is allowed to carry; a test asserts the helper agrees. */
export const EVENT_SOURCE_FIELDS = Object.freeze(["at", "type", "pid", "stateId", "agent"]);

export function eventTypeName(raw) {
	return TYPE_NAMES.get(Number(raw)) ?? `type${raw}`;
}

/**
 * Group records by (event type, source pid, source state, agent marker).
 *
 * `processName` is injected so the grouping is testable without spawning `ps`; the live
 * scripts pass `resolveProcessNames`.
 */
export function groupEventSources(events = [], { processName = () => undefined } = {}) {
	const groups = new Map();
	for (const event of events) {
		const pid = Number(event?.pid);
		const type = Number(event?.type);
		if (!Number.isFinite(pid) || !Number.isFinite(type)) continue;
		const stateId = Number(event?.stateId) || 0;
		const agent = event?.agent === true;
		const at = Number(event?.at) || 0;
		const key = `${type}|${pid}|${stateId}|${agent}`;
		const group = groups.get(key) ?? { type, pid, stateId, agent, count: 0, firstAt: at, lastAt: at };
		group.count += 1;
		if (at > 0) {
			group.firstAt = group.firstAt > 0 ? Math.min(group.firstAt, at) : at;
			group.lastAt = Math.max(group.lastAt, at);
		}
		groups.set(key, group);
	}
	return [...groups.values()]
		.map((group) => ({ ...group, typeName: eventTypeName(group.type), process: processName(group.pid) ?? null }))
		.sort((left, right) => right.count - left.count || left.type - right.type || left.pid - right.pid);
}

/** Best-effort pid -> process name. Unknown pids stay unknown rather than guessed. */
export function resolveProcessNames(pids, { exec = execFileSync } = {}) {
	const unique = [...new Set(pids.filter((pid) => Number.isFinite(pid) && pid > 0))];
	const names = new Map();
	if (unique.length === 0) return names;
	let output = "";
	try {
		output = String(exec("ps", ["-p", unique.join(","), "-o", "pid=,comm="], { encoding: "utf8" }));
	} catch {
		// `ps` exits non-zero when any pid is gone; the lines it did print are still true.
		output = "";
	}
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(.+)$/.exec(line);
		if (match) names.set(Number(match[1]), match[2].trim());
	}
	return names;
}

/**
 * Split the window's records into "processes this run started" and everything else.
 *
 * This is a report, not a gate. Operator activity remains visible, but B0-B4 judge only
 * agent-marked HID, run-owned/helper focus, and cursor-warp behavior. The helper's own pid
 * counts as ours for attribution because it posts directed L2 events.
 */
export function summarizeAttribution(groups = [], { runPids = [], helperPid } = {}) {
	const ours = new Set([...runPids, helperPid].filter((pid) => Number.isFinite(pid)));
	let fromThisRun = 0;
	let fromElsewhere = 0;
	for (const group of groups) {
		if (group.agent) continue;
		if (ours.has(group.pid)) fromThisRun += group.count;
		else fromElsewhere += group.count;
	}
	return { fromThisRun, fromElsewhere, total: fromThisRun + fromElsewhere };
}

/** Archive rows for one run's source records: one row per source, plus a summary. */
export function attributionRows(events = [], { processName = () => undefined, runPids = [], helperPid } = {}) {
	const groups = groupEventSources(events, { processName });
	const rows = groups
		.filter((group) => !group.agent)
		.map((group) => ({
			area: "attribution",
			action: `${group.typeName} / ${group.process ?? `pid ${group.pid}`} / state ${group.stateId}`,
			result: "recorded",
			note: `count=${group.count} pid=${group.pid} first=${new Date(group.firstAt).toISOString()} last=${new Date(group.lastAt).toISOString()}`,
		}));
	const summary = summarizeAttribution(groups, { runPids, helperPid });
	rows.push({
		area: "attribution",
		action: "summary",
		// Inert by design: activity is recorded but does not change the B0-B4 verdict.
		result: "recorded",
		note: `unmarked=${summary.total} fromThisRun=${summary.fromThisRun} fromElsewhere=${summary.fromElsewhere} agentMarked=${groups.filter((group) => group.agent).reduce((sum, group) => sum + group.count, 0)} does not affect B0-B4 verdict`,
	});
	return rows;
}

/**
 * The ring has to explain the counters, not merely be empty (review 8, T2).
 *
 * An older helper answers `userActivity` without `recentEvents`, and summarising that as
 * `unmarked=0` looked exactly like "nothing happened" - which is the one thing a B0 run must
 * never confuse. A missing ring is a failure, and so is a ring whose in-window record count
 * disagrees with what the counters say happened (overflow or loss).
 */
export function recordAttribution({ activityBefore, activityAfter, runStartedAt, runPids = [], helperPid, processName, record }) {
	const after = activityAfter ?? {};
	const records = Array.isArray(after.recentEvents) ? after.recentEvents : undefined;
	if (!records) {
		record("attribution", "ring", "fail", "helper did not return recentEvents; nothing here can be attributed");
		return { ok: false, rows: 0, expected: undefined };
	}
	const counted = (value) => Number(value ?? 0);
	const expected = counted(after.userEventCount) + counted(after.agentEventCount) - counted(activityBefore?.userEventCount) - counted(activityBefore?.agentEventCount);
	const inWindow = records.filter((event) => Number(event?.at) >= runStartedAt);
	const rows = attributionRows(inWindow, { processName, runPids, helperPid });
	for (const row of rows) record(row.area, row.action, row.result, row.note);
	if (inWindow.length !== expected) {
		record("attribution", "ring complete", "fail", `ring holds ${inWindow.length} records for this run, the counters moved by ${expected}`);
		return { ok: false, rows: inWindow.length, expected };
	}
	record("attribution", "ring complete", "pass", `${inWindow.length} records match the counters`);
	return { ok: true, rows: inWindow.length, expected };
}
