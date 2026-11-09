/**
 * Measurement completions for the harvest: where a session's date comes from, what the run
 * was doing when the user aborted, which error class a tool streak belongs to, and the
 * aggregation tables built on top.
 */
import { describe, expect, it } from "vitest";
import { analyzeSession, resolveStartedAt, toolErrorCategory, type Incident, type SessionSummary } from "../src/loop/harvest.ts";
import { dayBreakdown, interruptTables, modelShareWeeks, poissonRateInterval, toolErrorTables } from "../src/loop/harvest-breakdown.ts";
import { isoWeek, weeklyMetrics } from "../src/loop/harvest-run.ts";

let counter = 0;
type Line = Record<string, unknown>;
type Step = { type: string; fields?: Record<string, unknown>; message?: Record<string, unknown>; timestamp: string };

/** Linear chain: each entry's parent is the previous one, so tests never hard-code ids. */
function chain(steps: Step[]): Line[] {
	let parentId: string | null = null;
	return steps.map((step) => {
		const id = `e${++counter}`;
		const entry: Line = { type: step.type, id, parentId, timestamp: step.timestamp, ...(step.message ? { message: step.message } : {}), ...(step.fields ?? {}) };
		parentId = id;
		return entry;
	});
}

const message = (body: Record<string, unknown>, timestamp: string): Step => ({ type: "message", message: body, timestamp });
const sessionHeader = { type: "session", version: 3, id: "s-1", timestamp: "2026-11-03T10:00:00.000Z", cwd: "/w" };

function analyze(header: Record<string, unknown> | undefined, lines: Line[], fileMtimeMs?: number) {
	const head = header === undefined ? [] : [JSON.stringify(header)];
	const analyzed = analyzeSession([...head, ...lines.map((line) => JSON.stringify(line))], { sessionFile: "/s.jsonl", excerpts: false, fileMtimeMs });
	if (!analyzed) throw new Error("not a session");
	return analyzed;
}

describe("harvest start time", () => {
	it("falls back to the first entry, then the file mtime, and never reports 1970", () => {
		expect(resolveStartedAt("2026-11-03T10:00:00.000Z", "2026-11-04T10:00:00.000Z", 0)).toEqual({ startedAt: "2026-11-03T10:00:00.000Z", startedAtSource: "header" });
		expect(resolveStartedAt(undefined, "2026-11-04T10:00:00.000Z")).toEqual({ startedAt: "2026-11-04T10:00:00.000Z", startedAtSource: "first-entry" });
		expect(resolveStartedAt("not-a-date", "2026-11-04T10:00:00.000Z")).toEqual({ startedAt: "2026-11-04T10:00:00.000Z", startedAtSource: "first-entry" });
		const mtime = Date.parse("2026-10-31T15:38:00.000Z");
		expect(resolveStartedAt("1970-01-01T06:34:58.986Z", "1970-01-01T06:35:05.013Z", mtime)).toEqual({ startedAt: "2026-10-31T15:38:00.000Z", startedAtSource: "file-mtime" });
		expect(resolveStartedAt(undefined, undefined)).toEqual({ startedAt: "", startedAtSource: "unknown" });
	});

	it("dates a session whose clock wrote 1970 from the file mtime instead of week 1970-W01", () => {
		const { session } = analyze(
			{ type: "session", version: 3, id: "s-1", timestamp: "1970-01-01T06:34:58.986Z", cwd: "/work/app" },
			chain([
				message({ role: "user", content: "帮我看看构建", timestamp: 0 }, "1970-01-01T06:35:05.013Z"),
				message({ role: "assistant", content: [{ type: "text", text: "好" }], stopReason: "stop", provider: "qoder", model: "dfmodel", timestamp: 0 }, "1970-01-01T06:35:10.013Z"),
			]),
			Date.parse("2026-10-31T15:38:00.000Z"),
		);
		expect(session.startedAtSource).toBe("file-mtime");
		expect(isoWeek(session.startedAt)).toBe("2026-W44");
		expect(weeklyMetrics([session]).map((week) => week.week)).toEqual(["2026-W44"]);
	});

	it("attributes each user turn to the model that answered it", () => {
		const { session } = analyze(sessionHeader, chain([
			message({ role: "user", content: "第一个问题", timestamp: 0 }, "2026-11-03T10:00:00.000Z"),
			message({ role: "assistant", content: [{ type: "text", text: "a" }], stopReason: "stop", provider: "qoder", model: "dfmodel", timestamp: 0 }, "2026-11-03T10:00:05.000Z"),
			message({ role: "user", content: "换个模型再问一个完全不同的问题", timestamp: 0 }, "2026-11-03T10:01:00.000Z"),
			message({ role: "assistant", content: [{ type: "text", text: "b" }], stopReason: "stop", provider: "openai-codex", model: "gpt-6-astra", timestamp: 0 }, "2026-11-03T10:01:05.000Z"),
		]));
		expect(session.modelTurns).toEqual({ "qoder/dfmodel": 1, "openai-codex/gpt-6-astra": 1 });
	});
});

describe("harvest interrupt context", () => {
	it("classifies what was running, how long it ran, and who moved the session on", () => {
		const { incidents } = analyze(sessionHeader, chain([
			message({ role: "user", content: "把 parser 的 bug 修了", timestamp: 0 }, "2026-11-03T10:00:00.000Z"),
			message({ role: "assistant", content: [], stopReason: "aborted", provider: "qoder", model: "dfmodel", errorMessage: "Request was aborted", durationMs: 4200, timestamp: 0 }, "2026-11-03T10:00:04.200Z"),
			message({ role: "user", content: "不对，你没跑测试", timestamp: 0 }, "2026-11-03T10:00:30.000Z"),
		]));
		const interrupt = incidents.find((incident) => incident.kind === "user_interrupt");
		expect(interrupt?.detail).toMatchObject({ activity: "waiting-first-byte", elapsedMs: 4200, cause: "human", nextUser: "correction" });
	});

	it("reads a tool that reported its own abort, and a session that just ends", () => {
		const { incidents } = analyze(sessionHeader, chain([
			message({ role: "user", content: "跑一下整个测试套件", timestamp: 0 }, "2026-11-03T10:00:00.000Z"),
			message({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } }], stopReason: "toolUse", provider: "qoder", model: "dfmodel", timestamp: 0 }, "2026-11-03T10:00:01.000Z"),
			message({ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "Command aborted" }], isError: true, timestamp: 0 }, "2026-11-03T10:00:09.000Z"),
			message({ role: "assistant", content: [], stopReason: "aborted", provider: "qoder", model: "dfmodel", errorMessage: "Request was aborted", timestamp: 0 }, "2026-11-03T10:00:09.100Z"),
		]));
		const interrupt = incidents.find((incident) => incident.kind === "user_interrupt");
		expect(interrupt?.detail).toMatchObject({ activity: "tool-executing", tool: "bash", elapsedMs: 100, cause: "no-following-turn", nextUser: "none" });
	});

	it("looks past the empty system message a restart writes and still finds the user", () => {
		const { incidents } = analyze(sessionHeader, chain([
			message({ role: "user", content: "跑一下整个测试套件", timestamp: 0 }, "2026-11-03T10:00:00.000Z"),
			message({ role: "assistant", content: [], stopReason: "aborted", provider: "qoder", model: "dfmodel", errorMessage: "Request was aborted", durationMs: 1200, timestamp: 0 }, "2026-11-03T10:00:01.200Z"),
			{ type: "model_change", timestamp: "2026-11-03T10:00:05.000Z" },
			message({ role: "system", content: "", timestamp: 0 }, "2026-11-03T10:00:05.100Z"),
			message({ role: "user", content: "继续", timestamp: 0 }, "2026-11-03T10:00:20.000Z"),
		]));
		const interrupt = incidents.find((incident) => incident.kind === "user_interrupt");
		expect(interrupt?.detail).toMatchObject({ cause: "human", nextUser: "new-topic" });
	});

	it("does not call an injected goal contract a human interruption", () => {
		const { incidents } = analyze(sessionHeader, chain([
			message({ role: "user", content: "继续优化", timestamp: 0 }, "2026-11-03T10:00:00.000Z"),
			message({ role: "assistant", content: [{ type: "text", text: "先看" }], stopReason: "aborted", provider: "qoder", model: "dfmodel", errorMessage: "Qoder: aborted", durationMs: 900, timestamp: 0 }, "2026-11-03T10:00:02.000Z"),
			message({ role: "user", content: "The user explicitly resumed the paused /goal.\n\nObjective: keep going", timestamp: 0 }, "2026-11-03T10:00:20.000Z"),
		]));
		const interrupt = incidents.find((incident) => incident.kind === "user_interrupt");
		expect(interrupt?.detail).toMatchObject({ activity: "streaming-text", cause: "injected", nextUser: "injected" });
		const tables = interruptTables(incidents);
		expect(tables.humanShare).toBe(0);
		expect(tables.byCause).toEqual([{ key: "injected", count: 1 }]);
	});

	it("summarises cause, activity, duration and follow-up with the human share", () => {
		const incidents = [
			{ kind: "user_interrupt", detail: { cause: "human", activity: "waiting-first-byte", elapsedMs: 900, nextUser: "correction" } },
			{ kind: "user_interrupt", detail: { cause: "human", activity: "streaming-text", elapsedMs: 15_000, nextUser: "none" } },
			{ kind: "user_interrupt", detail: { cause: "compaction", activity: "streaming-thinking", elapsedMs: 61_000, nextUser: "none" } },
			{ kind: "user_interrupt", detail: { cause: "no-following-turn", activity: "tool-executing", nextUser: "none" } },
		] as unknown as Incident[];
		const tables = interruptTables(incidents);
		expect(tables.humanShare).toBe(50);
		expect(tables.byDuration).toEqual([
			{ key: "<2s", count: 1 },
			{ key: "10-30s", count: 1 },
			{ key: ">=60s", count: 1 },
			{ key: "unknown", count: 1 },
		]);
		expect(tables.causeActivity).toContainEqual({ cause: "human", activity: "waiting-first-byte", count: 1 });
	});
});

describe("harvest tool errors", () => {
	it("buckets a failed tool result into one class", () => {
		expect(toolErrorCategory("browser relay tabs timeout")).toBe("timeout");
		expect(toolErrorCategory("interaction target ref is stale or unavailable")).toBe("stale");
		expect(toolErrorCategory("ENOENT: no such file or directory")).toBe("not-found");
		expect(toolErrorCategory("Script error: SyntaxError: Unexpected token")).toBe("syntax");
		expect(toolErrorCategory("Found 2 occurrences of edits[2]")).toBe("ambiguous-match");
		expect(toolErrorCategory("process exited with code 1")).toBe("command-failed");
		expect(toolErrorCategory("something else entirely")).toBe("other");
	});

	it("splits streaks by tool and class", () => {
		const incidents = [
			{ kind: "tool_error_streak", detail: { tool: "browser_inspect", category: "timeout" } },
			{ kind: "tool_error_streak", detail: { tool: "browser_inspect", category: "timeout" } },
			{ kind: "tool_error_streak", detail: { tool: "edit", category: "ambiguous-match" } },
		] as unknown as Incident[];
		const tables = toolErrorTables(incidents);
		expect(tables.byTool).toEqual([
			{ key: "browser_inspect", count: 2 },
			{ key: "edit", count: 1 },
		]);
		expect(tables.toolCategory).toContainEqual({ tool: "browser_inspect", category: "timeout", count: 2 });
	});
});

describe("harvest aggregation", () => {
	const session = (overrides: Partial<SessionSummary>): SessionSummary => ({
		sessionId: "s",
		sessionFile: "",
		cwd: "",
		startedAt: "2026-11-03T10:00:00.000Z",
		startedAtSource: "header",
		modelTurns: {},
		models: [],
		userTurns: 1,
		assistantMessages: 0,
		toolCalls: 0,
		toolErrors: 0,
		interventions: 0,
		interruptExcluded: 0,
		failures: 0,
		incidentCounts: {},
		...overrides,
	});

	it("puts a Poisson band around the weekly rate", () => {
		expect(poissonRateInterval(4, 40)).toEqual({ low: 0.2, high: 19.8 });
		expect(poissonRateInterval(0, 40)).toEqual({ low: 0, high: 0 });
		expect(poissonRateInterval(3, 0)).toBeUndefined();
	});

	it("shares user turns per week by the answering model", () => {
		const rows = modelShareWeeks([
			session({ modelTurns: { "qoder/dfmodel": 3, "openai-codex/gpt-6-astra": 1 } }),
			session({ sessionId: "t", modelTurns: { "qoder/dfmodel": 4 } }),
		], (item) => isoWeek(item.startedAt));
		expect(rows).toEqual([
			{ week: "2026-W45", model: "qoder/dfmodel", turns: 7, share: 87.5 },
			{ week: "2026-W45", model: "openai-codex/gpt-6-astra", turns: 1, share: 12.5 },
		]);
	});

	it("breaks one week down by day and dominant provider", () => {
		const rows = dayBreakdown([
			session({ startedAt: "2026-11-03T10:00:00.000Z", modelTurns: { "qoder/dfmodel": 2 }, userTurns: 2, interventions: 1 }),
			session({ sessionId: "u", startedAt: "2026-11-03T18:00:00.000Z", modelTurns: { "cc-switch/claude-opus-5-5": 4 }, userTurns: 4, interventions: 1, failures: 3 }),
			session({ sessionId: "v", startedAt: "2026-11-09T10:00:00.000Z", modelTurns: { "qoder/dfmodel": 5 } }),
		], "2026-W45", (item) => isoWeek(item.startedAt));
		expect(rows).toEqual([
			{ day: "2026-11-03", provider: "qoder", sessions: 1, turns: 2, interventions: 1, per100: 50, failures: 0 },
			{ day: "2026-11-03", provider: "cc-switch", sessions: 1, turns: 4, interventions: 1, per100: 25, failures: 3 },
		]);
	});

	it("records the release only when a stack trace embedded one", () => {
		const { session: summary } = analyze(sessionHeader, chain([
			message({
				role: "assistant",
				content: [{ type: "text", text: "Error: boom\n    at x (file:///Users/user/.local/share/rotom/releases/0.1.27-main.802706be/node_modules/@bingjiang0611/rotom/a.js:1:1)" }],
				stopReason: "stop",
				provider: "qoder",
				model: "dfmodel",
				timestamp: 0,
			}, "2026-11-03T10:00:01.000Z"),
		]));
		expect(summary.release).toBe("0.1.27-main.802706be");
	});
});
