import { describe, expect, it } from "vitest";
import { aggregateBreakdown, MISSING, providerErrorRows, toolErrorRows } from "../scripts/error-breakdown.mjs";

type Attributes = Record<string, string | number | boolean>;
const start = (spanId: string, name: string, attributes: Attributes, parentSpanId?: string) => ({
	schema: "rotom-local-trace/v1", kind: "span_start", timestamp: "2026-10-20T10:00:00.000Z",
	traceId: "trace", spanId, ...(parentSpanId ? { parentSpanId } : {}), name, attributes,
});
const end = (spanId: string, name: string, status: string, attributes: Attributes = {}, parentSpanId?: string) => ({
	schema: "rotom-local-trace/v1", kind: "span_end", timestamp: "2026-10-20T10:00:01.000Z",
	traceId: "trace", spanId, ...(parentSpanId ? { parentSpanId } : {}), name, status, durationMs: 1, attributes,
});
const toolCall = (id: string, tool: string, outcome?: string, extra: Attributes = {}) => [
	start(id, "pi.tool.execute", { "pi.tool.name": tool }),
	...(outcome === undefined ? [] : [end(id, "pi.tool.execute", outcome === "ok" ? "ok" : "error", { "pi.tool.outcome": outcome, ...extra })]),
];
const request = (id: string, status: string, attributes: Attributes = {}, parentSpanId?: string) => [
	start(id, "pi.ai.request", { "pi.ai.provider": "synthetic", "pi.ai.model": "fixture", ...attributes }, parentSpanId),
	end(id, "pi.ai.request", status, attributes, parentSpanId),
];
// request -> turn -> run, the ancestry the product writes for one agent run.
const retryChain = (ids: string[]) => [
	start("run", "pi.agent.run", {}),
	start("turn", "pi.agent.turn", {}, "run"),
	...ids.flatMap((id) => request(id, "error", { "pi.ai.error.category": "timeout" }, "turn")),
];

describe("tool error rows", () => {
	it("groups ended spans by tool, counts non-ok outcomes and sorts by errors", () => {
		const rows = toolErrorRows([
			...toolCall("a", "bash", "tool_error", { "pi.tool.fault_side": "unknown", "pi.tool.error_code": "nonzero_exit" }),
			...toolCall("b", "bash", "tool_error", { "pi.tool.fault_side": "unknown", "pi.tool.error_code": "nonzero_exit" }),
			...toolCall("c", "bash", "ok"),
			...toolCall("d", "read", "schema", { "pi.tool.fault_side": "model" }),
			...toolCall("e", "write", undefined),
		]);
		expect(rows.map((row) => [row.tool, row.endedSpans, row.errors, row.aborted])).toEqual([
			["bash", 3, 2, 0],
			["read", 1, 1, 0],
		]);
		expect(rows[0].combinations).toEqual([
			{ outcome: "tool_error", faultSide: "unknown", errorCode: "nonzero_exit", count: 2 },
			{ outcome: "ok", faultSide: MISSING, errorCode: MISSING, count: 1 },
		]);
		expect(rows[1].combinations).toEqual([{ outcome: "schema", faultSide: "model", errorCode: MISSING, count: 1 }]);
	});

	it("counts aborted calls as errors but keeps them in their own column", () => {
		const rows = toolErrorRows([...toolCall("a", "bash", "aborted"), ...toolCall("b", "bash", "ok")]);
		expect(rows[0]).toMatchObject({ errors: 1, aborted: 1, endedSpans: 2 });
		expect(rows[0].combinations[0]).toEqual({ outcome: "aborted", faultSide: MISSING, errorCode: MISSING, count: 1 });
	});

	it("uses (none) for every missing attribute instead of guessing", () => {
		const rows = toolErrorRows([start("a", "pi.tool.execute", {}), end("a", "pi.tool.execute", "unknown", {})]);
		expect(rows).toEqual([{
			tool: MISSING, endedSpans: 1, errors: 1, aborted: 0,
			combinations: [{ outcome: MISSING, faultSide: MISSING, errorCode: MISSING, count: 1 }],
		}]);
	});

	it("ignores unfinished spans and non-tool spans", () => {
		const rows = toolErrorRows([...toolCall("a", "bash"), start("b", "pi.ai.request", {}), { kind: "span_start" }]);
		expect(rows).toEqual([]);
	});
});

describe("provider error rows", () => {
	it("groups failed requests by provider/model/category with attribute tails", () => {
		const result = providerErrorRows([
			...request("a", "error", { "pi.ai.error.category": "http", "pi.ai.error.http_status": 429 }),
			...request("b", "error", { "pi.ai.error.category": "http", "pi.ai.error.http_status": 429 }),
			...request("c", "error", { "pi.ai.error.category": "timeout", "pi.ai.qoder.error_code": "transport_failure", "pi.ai.qoder.transport_phase": "request" }),
			...request("d", "ok", { "pi.ai.response.stop_reason": "stop" }),
			...request("e", "aborted"),
		]);
		expect(result).toMatchObject({ requests: 5, errors: 3, abortedRequests: 1 });
		expect(result.rows.map((row) => [row.provider, row.model, row.category, row.count])).toEqual([
			["synthetic", "fixture", "http", 2],
			["synthetic", "fixture", "timeout", 1],
		]);
		expect(result.rows[0].httpStatus).toEqual({ 429: 2 });
		expect(result.rows[1]).toMatchObject({ qoderErrorCode: { transport_failure: 1 }, transportPhase: { request: 1 } });
	});

	it("treats a missing category as (none) and never counts ok/unknown requests", () => {
		const result = providerErrorRows([...request("a", "error"), ...request("b", "unknown")]);
		expect(result.errors).toBe(1);
		expect(result.rows[0].category).toBe(MISSING);
		expect(result.rows[0].httpStatus).toEqual({ [MISSING]: 1 });
	});

	it("counts repeated failures inside one run as retry evidence for the last request", () => {
		expect(providerErrorRows(retryChain(["a", "b"])).lastFailedRequest).toEqual({ status: "error", runErrorRequests: 2 });
		expect(providerErrorRows(retryChain(["a"])).lastFailedRequest).toEqual({ status: "error", runErrorRequests: 1 });
	});

	it("does not merge failures from different runs", () => {
		const records = [
			start("run-1", "pi.agent.run", {}), start("turn-1", "pi.agent.turn", {}, "run-1"),
			start("run-2", "pi.agent.run", {}), start("turn-2", "pi.agent.turn", {}, "run-2"),
			...request("a", "error", { "pi.ai.error.category": "timeout" }, "turn-1"),
			...request("b", "error", { "pi.ai.error.category": "timeout" }, "turn-2"),
		];
		expect(providerErrorRows(records).lastFailedRequest).toEqual({ status: "error", runErrorRequests: 1 });
	});
});

describe("aggregate breakdown", () => {
	const session = (toolRows: unknown[], provider: unknown, endedOnProviderError = false) => ({
		toolRows: toolRows as never, provider: provider as never, endedOnProviderError,
	});

	it("merges sessions, recomputes rates and shares, and keeps a null share when nothing failed", () => {
		const failed = toolErrorRows([...toolCall("a", "bash", "tool_error"), ...toolCall("b", "read", "ok")]);
		const clean = toolErrorRows([...toolCall("c", "bash", "ok")]);
		const aggregate = aggregateBreakdown([
			session(failed, providerErrorRows(retryChain(["a", "b"])), true),
			session(clean, providerErrorRows([...request("c", "ok")]), false),
		]);
		expect(aggregate.toolTotals).toEqual({ endedSpans: 3, errors: 1, aborted: 0 });
		expect(aggregate.tools.map((row) => [row.tool, row.endedSpans, row.errors, row.rate, row.share])).toEqual([
			["bash", 2, 1, 0.5, 1],
			["read", 1, 0, 0, 0],
		]);
		expect(aggregate.providerTotals).toEqual({ requests: 3, errors: 2, abortedRequests: 0 });
		expect(aggregate.providerEnd).toEqual({ sessions: 1, runRetried: 1, sessionRetried: 1, single: 0 });
		expect(aggregateBreakdown([session(clean, providerErrorRows([]), false)]).tools[0].share).toBeNull();
		expect(aggregateBreakdown([])).toMatchObject({
			sessions: 0,
			toolTotals: { endedSpans: 0, errors: 0, aborted: 0 },
			concentration: { sessionsWithErrors: 0, topSessions: 0, topErrors: 0, errors: 0, share: null },
			providerEnd: { sessions: 0, runRetried: 0, sessionRetried: 0, single: 0 },
		});
	});

	it("measures concentration on the top decile of sessions that had errors", () => {
		const heavy = toolErrorRows(Array.from({ length: 7 }, (_, index) => toolCall(`h${index}`, "bash", "tool_error")).flat());
		const light = toolErrorRows(Array.from({ length: 3 }, (_, index) => toolCall(`l${index}`, "bash", "tool_error")).flat());
		const spread = aggregateBreakdown([session(heavy, providerErrorRows([])), session(light, providerErrorRows([])), session([], providerErrorRows([]))]);
		// 2 sessions had errors; the top decile is 1 session with 7 of 10 errors.
		expect(spread.concentration).toEqual({ sessionsWithErrors: 2, topSessions: 1, topErrors: 7, errors: 10, share: 0.7 });
		const equal = aggregateBreakdown([session(light, providerErrorRows([])), session(light, providerErrorRows([]))]);
		expect(equal.concentration).toMatchObject({ sessionsWithErrors: 2, topSessions: 1, share: 0.5 });
		const single = aggregateBreakdown([session(light, providerErrorRows([]))]);
		expect(single.concentration).toMatchObject({ sessionsWithErrors: 1, topSessions: 1, share: 1 });
	});

	it("counts a single-failure provider ending without retry evidence", () => {
		const provider = providerErrorRows(retryChain(["a"]));
		expect(aggregateBreakdown([session([], provider, true)]).providerEnd).toEqual({ sessions: 1, runRetried: 0, sessionRetried: 0, single: 1 });
	});
});
