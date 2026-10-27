import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { aggregateMetrics, focusCandidate, sessionMetrics } from "../scripts/session-metrics.mjs";
import { TOOL_RESULT_BYTE_THRESHOLD } from "../scripts/trace-assertions.mjs";

const digest = (id: string) => createHash("sha256").update(id).digest("hex");
const text = (value: string) => ({ type: "text", text: value });
const call = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: { command: "synthetic" } });
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 20, 10, minutes)).toISOString();
const entry = (id: string, parentId: string | null, message: Record<string, unknown>, minutes = 0) => ({
	type: "message", id, parentId, timestamp: at(minutes), message,
});
const user = (minutes = 0) => entry("u", null, { role: "user", content: "SYNTHETIC_REQUEST" }, minutes);
const answer = (minutes: number, content: unknown[], extra: Record<string, unknown> = {}) => entry("a", "u", {
	role: "assistant", provider: "synthetic", model: "fixture", stopReason: "stop", content,
	usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: { total: 0.5 } }, ...extra,
}, minutes);
const metricsOf = (branch: unknown[], traceTools = new Map(), traceStatus: "ok" | "partial" | "missing" = "ok", findings: unknown[] = []) =>
	sessionMetrics({ header: { timestamp: at(0) }, branch: branch as never, traceTools: traceTools as never, traceStatus, findings: findings as never });

describe("session metrics", () => {
	it("derives every metric from the branch, trace association and rule results", () => {
		const branch = [user(0), answer(2, [text("SYNTHETIC_REPLY"), call("c1"), call("c2")])];
		const traceTools = new Map([
			[digest("c1"), { "pi.tool.outcome": "error" }],
			[digest("c2"), { "pi.tool.outcome": "ok" }],
		]);
		expect(metricsOf(branch, traceTools, "ok", [
			{ rule: "ended-on-provider-error", status: "clear" }, { rule: "schema-errors", status: "hit" },
		])).toEqual({
			startedAt: at(0), week: "2026-W43", durationMs: 120_000, models: ["synthetic/fixture"],
			assistantTurns: 1, toolCalls: 2, toolErrors: 1, endedToolSpans: 2, toolErrorRate: 0.5,
			tokens: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2 },
			costUsd: 0.5, costPartial: false, oversizedResults: 0,
			endedWithoutFinalText: false, endedOnProviderError: false, ruleHits: ["schema-errors"],
		});
	});

	it("keeps trace and usage metrics null when the data is absent", () => {
		const branch = [user(0), answer(1, [text("SYNTHETIC_REPLY")], { usage: undefined })];
		const metrics = metricsOf(branch, new Map(), "missing");
		expect(metrics).toMatchObject({
			toolErrors: null, endedToolSpans: null, toolErrorRate: null, oversizedResults: null,
			tokens: null, costUsd: null, costPartial: true,
		});
		expect(metrics.assistantTurns).toBe(1);
	});

	it("marks a partially reported cost instead of summing a subset", () => {
		const branch = [
			user(0),
			answer(1, [text("SYNTHETIC_REPLY")]),
			{ ...entry("b", "a", { role: "assistant", content: [text("SYNTHETIC_SECOND")], stopReason: "stop", usage: { input: 1, output: 1 } }, 2) },
		];
		expect(metricsOf(branch)).toMatchObject({ costUsd: null, costPartial: true, assistantTurns: 2 });
	});

	it("counts tool results above the shared byte threshold only", () => {
		const traceTools = new Map([
			[digest("c1"), { "pi.tool.outcome": "ok", "pi.tool.result_text_bytes": TOOL_RESULT_BYTE_THRESHOLD }],
			[digest("c2"), { "pi.tool.outcome": "ok", "pi.tool.result_text_bytes": TOOL_RESULT_BYTE_THRESHOLD + 1 }],
		]);
		expect(metricsOf([user(0), answer(1, [text("x"), call("c1"), call("c2")])], traceTools).oversizedResults).toBe(1);
	});

	it("treats a textless final assistant as ended without final text", () => {
		expect(metricsOf([user(0), answer(1, [])]).endedWithoutFinalText).toBe(true);
		expect(metricsOf([user(0), answer(1, [{ type: "thinking", thinking: "only" } as never])]).endedWithoutFinalText).toBe(true);
		expect(metricsOf([user(0), answer(1, [text("")])]).endedWithoutFinalText).toBe(true);
	});

	it("reports unknown for rule-based fields that the evaluator could not decide", () => {
		const metrics = metricsOf([user(0), answer(1, [text("x")])], new Map(), "missing", [{ rule: "ended-on-provider-error", status: "unknown" }]);
		expect(metrics.endedOnProviderError).toBeNull();
		expect(metrics.ruleHits).toEqual([]);
	});

	it.each([
		["2026-12-31T23:00:00.000Z", "2026-W53"],
		["2027-01-01T01:00:00.000Z", "2026-W53"],
		["2026-01-01T00:00:00.000Z", "2026-W01"],
		["2026-01-05T00:00:00.000Z", "2026-W02"],
	])("maps %s to ISO week %s across the year boundary", (timestamp, week) => {
		const metrics = sessionMetrics({
			header: { timestamp }, branch: [entry("a", null, { role: "assistant", content: [text("x")], stopReason: "stop" })] as never,
			traceTools: new Map(), traceStatus: "ok", findings: [],
		});
		expect(metrics.week).toBe(week);
	});
});

describe("metric aggregation", () => {
	const row = (overrides: Record<string, unknown>) => ({
		sessionId: "synthetic", startedAt: "2026-10-20T10:00:00.000Z", week: "2026-W43", durationMs: 1000, models: ["p/m"],
		assistantTurns: 1, toolCalls: 1, toolErrors: 0, endedToolSpans: 1, toolErrorRate: 0, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		costUsd: 0, costPartial: false, oversizedResults: 0, endedWithoutFinalText: false, endedOnProviderError: false, ruleHits: [], ...overrides,
	});

	it("sums errors and spans instead of averaging per-session rates", () => {
		const result = aggregateMetrics([
			row({ sessionId: "a", toolErrors: 1, endedToolSpans: 2, toolErrorRate: 0.5 }),
			row({ sessionId: "b", toolErrors: 3, endedToolSpans: 4, toolErrorRate: 0.75 }),
		]);
		expect(result.weeks[0].toolErrorRate).toEqual({ n: 2, errors: 4, endedSpans: 6, rate: 4 / 6 });
	});

	it("excludes unknown sessions from the four-cell statistics but keeps them counted", () => {
		const result = aggregateMetrics([
			row({ sessionId: "a", toolErrors: null, endedToolSpans: null, toolErrorRate: null }),
			row({ sessionId: "b", endedWithoutFinalText: null, endedOnProviderError: null }),
			row({ sessionId: "c", endedWithoutFinalText: true, endedOnProviderError: true }),
		]);
		const week = result.weeks[0];
		expect(week.sessions).toBe(3);
		expect(week.toolErrorRate).toEqual({ n: 2, errors: 0, endedSpans: 2, rate: 0 });
		expect(week.endedWithoutFinalText).toEqual({ n: 2, count: 1, share: 0.5 });
		expect(week.endedOnProviderError).toEqual({ n: 2, count: 1, share: 0.5 });
	});

	it.each([
		["no samples", [], { n: 0, median: null, p90: null }],
		["a single sample", [7], { n: 1, median: 7, p90: 7 }],
		["an even count", [1, 2, 3, 8], { n: 4, median: 2.5, p90: 8 }],
		["ten samples", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { n: 10, median: 5.5, p90: 9 }],
	])("summarizes tool calls with %s", (_label, values, expected) => {
		const rows = values.map((value, index) => row({ sessionId: `synthetic-${index}`, toolCalls: value }));
		expect(aggregateMetrics(rows).weeks[0]?.toolCalls ?? { n: 0, median: null, p90: null }).toEqual(expected);
	});

	it("groups by week and by every model a session used, and counts rows without that data", () => {
		const result = aggregateMetrics([
			row({ sessionId: "a", week: "2026-W43", models: ["p/m", "p/n"] }),
			row({ sessionId: "b", week: "2026-W44", models: [] }),
			row({ sessionId: "c", week: null, models: ["p/m"] }),
		]);
		expect(result.unknownWeek).toBe(1);
		expect(result.unknownModel).toBe(1);
		expect(result.weeks.map((group) => [group.week, group.sessions])).toEqual([["2026-W43", 1], ["2026-W44", 1]]);
		expect(result.models.map((group) => [group.model, group.sessions])).toEqual([["p/m", 2], ["p/n", 1]]);
	});

	it("reports a partial cost total without hiding it", () => {
		const result = aggregateMetrics([row({ costUsd: null, costPartial: true }), row({ costUsd: 0.5 })]);
		expect(result.weeks[0].costUsd).toEqual({ n: 1, total: 0.5, partial: true, partialSessions: 1 });
	});
});

describe("focus selection", () => {
	const metrics = {
		toolErrors: 0, toolErrorRate: 0, ruleHits: [] as string[],
		endedWithoutFinalText: false, endedOnProviderError: false,
	};
	const focus = (overrides: Record<string, unknown> = {}) => focusCandidate({ ...metrics, ...overrides } as never);

	it("matches each condition on its own", () => {
		expect(focus({ toolErrors: 5, toolErrorRate: 0.1 }).conditions).toMatchObject({ toolErrors: true });
		expect(focus({ ruleHits: ["schema-errors"] }).conditions).toMatchObject({ ruleHit: true });
		expect(focus({ endedWithoutFinalText: true }).conditions).toMatchObject({ endedWithoutFinalText: true });
		expect(focus({ endedOnProviderError: true }).conditions).toMatchObject({ endedOnProviderError: true });
	});

	it("requires both the error count and the error rate", () => {
		expect(focus({ toolErrors: 5, toolErrorRate: 0.05 }).matched).toBe(false);
		expect(focus({ toolErrors: 4, toolErrorRate: 0.5 }).matched).toBe(false);
	});

	it("does not match unknown values and reports nothing for a clean session", () => {
		expect(focus().matched).toBe(false);
		expect(focus().conditions).toEqual({ toolErrors: false, ruleHit: false, endedWithoutFinalText: false, endedOnProviderError: false });
		expect(focus({ toolErrors: null, toolErrorRate: null, endedWithoutFinalText: null, endedOnProviderError: null }).matched).toBe(false);
	});
});
