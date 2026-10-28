import assert from "node:assert/strict";
import test from "node:test";
import { formatDashboardCompact, formatDashboardDuration, formatDashboardMoney, STALE_OPEN_SPAN_MS, summarizeFleet, summarizeTrace, toolEvidenceLabels } from "./dashboard.mjs";
import { COPY } from "./dashboard-copy.mjs";
import { span } from "./dashboard-test-fixtures.mjs";

test("tool detail separates receipts, file mutations, checks and business evidence without changing status", () => {
	const receipt = { name: "pi.tool.execute", status: "ok", attributes: { "pi.tool.subagent_phase": "launch" } };
	assert.deepEqual(toolEvidenceLabels(receipt), [[COPY.phase, COPY.launchReceipt]]);
	assert.equal(receipt.status, "ok");
	assert.deepEqual(toolEvidenceLabels({ ...receipt, attributes: {} }), [], "historical spans are not retroactively inferred");
	const mutation = { name: "pi.tool.execute", status: "error", attributes: { "pi.tool.coding_evidence_source": "tool-reported", "pi.tool.mutation_status": "applied", "pi.tool.followup_status": "failed" } };
	assert.deepEqual(toolEvidenceLabels(mutation), [[COPY.fileMutation, COPY.appliedToolReported], [COPY.followUpCommand, `failed ${COPY.toolReportedNotVerification}`]]);
	assert.equal(mutation.status, "error");
	const skipped = { ...mutation, attributes: { ...mutation.attributes, "pi.tool.followup_status": "skipped" } };
	assert.deepEqual(toolEvidenceLabels(skipped), [[COPY.fileMutation, COPY.appliedToolReported], [COPY.followUpCommand, `skipped ${COPY.toolReportedNotVerification}`]]);
	assert.equal(skipped.status, "error");
	assert.deepEqual(toolEvidenceLabels({ ...mutation, attributes: { ...mutation.attributes, "pi.tool.coding_evidence_source": undefined } }), []);
	assert.deepEqual(toolEvidenceLabels({ ...receipt, attributes: { "pi.tool.subagent_phase": "stop-request", "pi.tool.process_terminal_state": "pending" } }), [[COPY.phase, COPY.stopRequested], [COPY.processTerminal, "pending"]]);
	assert.deepEqual(toolEvidenceLabels({ ...receipt, attributes: { "pi.tool.dispatch_acknowledged": true, "pi.tool.verification_status": "preexisting", "pi.tool.business_outcome": "unverified" } }), [[COPY.dispatch, COPY.acknowledgedNotCompletion], [COPY.targetCheck, "preexisting"], [COPY.businessEffect, "unverified"]]);
	assert.deepEqual(toolEvidenceLabels({ ...receipt, attributes: { "pi.tool.subagent_phase": "<secret>", "pi.tool.business_outcome": "<secret>" } }), []);
	assert.deepEqual(toolEvidenceLabels({ ...receipt, name: "pi.agent.operation" }), []);
});


test("summary separates root, propagated, recovered, unresolved, and actionable stale outcomes", () => {
	const now = Date.parse("2026-08-28T12:10:00.000Z");
	const providerErrorAt = new Date(now - 9 * 60_000).toISOString();
	const providerRecoveredAt = new Date(now - 8 * 60_000).toISOString();
	const unresolvedAt = new Date(now - 7 * 60_000).toISOString();
	const staleAt = new Date(now - STALE_OPEN_SPAN_MS).toISOString();
	const records = [
		span("span_start", { spanId: "1".repeat(16), name: "pi.agent.turn", timestamp: providerErrorAt }),
		span("span_start", { spanId: "2".repeat(16), parentSpanId: "1".repeat(16), timestamp: providerErrorAt }),
		span("span_end", { spanId: "2".repeat(16), parentSpanId: "1".repeat(16), status: "error", timestamp: providerErrorAt }),
		span("span_end", { spanId: "1".repeat(16), name: "pi.agent.turn", status: "error", timestamp: providerErrorAt }),
		span("span_start", { spanId: "3".repeat(16), timestamp: providerRecoveredAt }),
		span("span_end", { spanId: "3".repeat(16), status: "ok", timestamp: providerRecoveredAt }),
		span("span_start", { spanId: "4".repeat(16), name: "pi.tool.execute", timestamp: unresolvedAt }),
		span("span_end", { spanId: "4".repeat(16), name: "pi.tool.execute", status: "error", timestamp: unresolvedAt }),
		span("span_start", { spanId: "5".repeat(16) }),
		span("span_end", { spanId: "5".repeat(16), status: "aborted" }),
		span("span_start", { spanId: "6".repeat(16) }),
		span("span_end", { spanId: "6".repeat(16), status: "unknown" }),
		span("span_start", { spanId: "7".repeat(16), name: "pi.session.runtime", timestamp: new Date(now - 60 * 60_000).toISOString() }),
		span("span_start", { spanId: "8".repeat(16), name: "pi.agent.operation", timestamp: staleAt }),
		span("span_start", { spanId: "9".repeat(16), parentSpanId: "8".repeat(16), timestamp: staleAt }),
	];
	const summary = summarizeTrace("/trace-root", "/trace-root/session.trace.jsonl", {
		records,
		parseErrors: 0,
		partial: true,
		sizeBytes: 123,
		modifiedAt: new Date(now).toISOString(),
	}, now);
	assert.equal(summary.spanCount, 9);
	assert.equal(summary.errorCount, 3);
	assert.equal(summary.rootErrorCount, 2);
	assert.equal(summary.recoveredErrorCount, 1);
	assert.equal(summary.unresolvedErrorCount, 1);
	assert.equal(summary.propagatedErrorCount, 1);
	assert.equal(summary.propagatedErrorSpanCount, 1);
	assert.equal(summary.abortedCount, 1);
	assert.equal(summary.abortedSpanCount, 1);
	assert.equal(summary.unknownCount, 1);
	assert.equal(summary.runtimeOpenCount, 1, "an idle session runtime stays visible without becoming an active or stale issue");
	assert.equal(summary.openCount, 2);
	assert.equal(summary.staleOpenCount, 1, "a stale parent/child chain must count only its deepest actionable span");
	assert.equal(summary.propagatedStaleOpenCount, 1);
	assert.equal(summary.anomalyCount, 3);
	assert.equal(summary.operationDurationMs, null, "missing operation ends must not render as zero wall time");
	assert.equal(summary.partial, true, "bounded-tail coverage must remain separate from execution health");
});

test("aborted and propagated parent chains count root-cause incidents instead of raw spans", () => {
	const operationId = "a".repeat(16);
	const runId = "b".repeat(16);
	const turnId = "c".repeat(16);
	const requestId = "d".repeat(16);
	const records = [
		span("span_start", { spanId: operationId, name: "pi.agent.operation" }),
		span("span_start", { spanId: runId, parentSpanId: operationId, name: "pi.agent.run" }),
		span("span_start", { spanId: turnId, parentSpanId: runId, name: "pi.agent.turn" }),
		span("span_start", { spanId: requestId, parentSpanId: turnId, name: "pi.ai.request" }),
		span("span_end", { spanId: requestId, parentSpanId: turnId, name: "pi.ai.request", status: "aborted" }),
		span("span_end", { spanId: turnId, parentSpanId: runId, name: "pi.agent.turn", status: "aborted" }),
		span("span_end", { spanId: runId, parentSpanId: operationId, name: "pi.agent.run", status: "aborted" }),
		span("span_end", { spanId: operationId, name: "pi.agent.operation", status: "aborted" }),
	];
	const summary = summarizeTrace("/trace-root", "/trace-root/aborted.trace.jsonl", {
		records,
		parseErrors: 0,
		partial: false,
		sizeBytes: 123,
		modifiedAt: "2026-08-28T12:00:00.000Z",
	});
	assert.equal(summary.abortedCount, 1, "one four-span abort chain is one root-cause incident");
	assert.equal(summary.abortedSpanCount, 4, "raw span pressure remains available for detail and tooltips");
	assert.equal(summary.propagatedAbortedSpanCount, 3);

	const errorRecords = records.map((record) => record.kind === "span_end" ? { ...record, status: "error" } : record);
	const errorSummary = summarizeTrace("/trace-root", "/trace-root/error.trace.jsonl", {
		records: errorRecords,
		parseErrors: 0,
		partial: false,
		sizeBytes: 123,
		modifiedAt: "2026-08-28T12:00:00.000Z",
	});
	assert.equal(errorSummary.propagatedErrorCount, 1, "one error hierarchy is one propagated incident");
	assert.equal(errorSummary.propagatedErrorSpanCount, 3);
	assert.equal(errorSummary.rootErrorCount, 1);
});

test("recent descendant activity keeps a long-running parent span active instead of stale", () => {
	const now = Date.parse("2026-08-28T12:10:00.000Z");
	const operationId = "a".repeat(16);
	const records = [
		span("span_start", { spanId: operationId, name: "pi.agent.operation", timestamp: new Date(now - 10 * 60_000).toISOString() }),
		span("span_start", { spanId: "b".repeat(16), parentSpanId: operationId, timestamp: new Date(now - 60_000).toISOString() }),
		span("span_end", { spanId: "b".repeat(16), parentSpanId: operationId, timestamp: new Date(now - 30_000).toISOString() }),
	];
	const summary = summarizeTrace("/trace-root", "/trace-root/active.trace.jsonl", {
		records,
		parseErrors: 0,
		partial: false,
		sizeBytes: 123,
		modifiedAt: new Date(now).toISOString(),
	}, now);
	assert.equal(summary.openCount, 1);
	assert.equal(summary.staleOpenCount, 0);
});

test("mixed completed and open operations use the observed window instead of underreporting completed duration", () => {
	const start = Date.parse("2026-08-28T12:00:00.000Z");
	const records = [
		span("span_start", { spanId: "6".repeat(16), name: "pi.agent.operation", timestamp: new Date(start).toISOString() }),
		span("span_end", { spanId: "6".repeat(16), name: "pi.agent.operation", timestamp: new Date(start + 60_000).toISOString(), durationMs: 60_000 }),
		span("span_start", { spanId: "7".repeat(16), name: "pi.agent.operation", timestamp: new Date(start + 120_000).toISOString() }),
		span("span_end", { spanId: "8".repeat(16), name: "pi.ai.request", timestamp: new Date(start + 300_000).toISOString(), durationMs: 1_000 }),
	];
	const summary = summarizeTrace("/trace-root", "/trace-root/mixed.trace.jsonl", {
		records,
		parseErrors: 0,
		partial: true,
		sizeBytes: 123,
		modifiedAt: new Date(start + 300_000).toISOString(),
	}, start + 600_000);
	assert.equal(summary.operationCount, 1);
	assert.equal(summary.openOperationCount, 1);
	assert.equal(summary.operationDurationMs, 60_000);
	assert.equal(summary.observedWindowDurationMs, 300_000);
	assert.equal(summary.wallTimeMode, "observed-window");
	assert.equal(summary.wallTimeMs, 300_000);
});

test("dashboard value formatters stay compact at unit boundaries", () => {
	assert.equal(formatDashboardMoney(118.3121), "$118.31");
	assert.equal(formatDashboardMoney(0.1234), "$0.1234");
	assert.equal(formatDashboardCompact(999_499), "999.5K");
	assert.equal(formatDashboardCompact(999_500), "1M");
	assert.equal(formatDashboardCompact(999_499_999), "999.5M");
	assert.equal(formatDashboardCompact(999_500_000), "1B");
	assert.equal(formatDashboardDuration(6_169_635), "1h 42m");
});

test("fleet separates execution health, recovered failures, bounded coverage, and orphan traces", () => {
	const trace = {
		errorCount: 8,
		rootErrorCount: 2,
		recoveredErrorCount: 2,
		unresolvedErrorCount: 0,
		propagatedErrorCount: 2,
		propagatedErrorSpanCount: 6,
		unknownCount: 0,
		staleOpenCount: 0,
		abortedCount: 0,
		abortedSpanCount: 0,
		partial: true,
		parseErrors: 0,
		providerCount: 9,
		inputTokens: 100,
		outputTokens: 34,
		reasoningTokens: 12,
		toolResultEstimatedTokens: 56,
		cacheReadTokens: 1_100,
		cacheWriteTokens: 0,
		totalTokens: 1_234,
		estimatedCostUsd: 2.5,
	};
	const orphan = { ...trace, orphan: true, unresolvedErrorCount: 9, recoveredErrorCount: 0, providerCount: 99, totalTokens: 99_999 };
	const fleet = summarizeFleet([trace, orphan], true);
	assert.equal(fleet.aggregateLimited, true);
	assert.equal(fleet.scanLimited, true);
	assert.equal(fleet.healthLevel, "warn");
	assert.equal(fleet.healthHeadline, "2 RECOVERED");
	assert.equal(fleet.coverageLevel, "warn");
	assert.equal(fleet.coverageHeadline, "SCAN LIMITED");
	assert.equal(fleet.traceCount, 2);
	assert.equal(fleet.sessionTraceCount, 1);
	assert.equal(fleet.orphanCount, 1);
	assert.equal(fleet.propagatedErrorCount, 2);
	assert.equal(fleet.propagatedErrorSpanCount, 6);
	assert.equal(fleet.abortedSpanCount, 0);
	assert.equal(fleet.providerCount, 9, "orphan traces must not distort session health or usage totals");
	assert.equal(fleet.inputTokens, 100);
	assert.equal(fleet.outputTokens, 34);
	assert.equal(fleet.reasoningTokens, 12);
	assert.equal(fleet.toolResultEstimatedTokens, 56);
	assert.equal(fleet.cacheReadTokens, 1_100);
	assert.equal(fleet.cacheWriteTokens, 0);
	assert.equal(fleet.totalTokens, 1_234);

	const unresolved = summarizeFleet([{ unresolvedErrorCount: 2 }]);
	assert.equal(unresolved.healthLevel, "bad");
	assert.equal(unresolved.healthHeadline, "2 UNRESOLVED");
	const unknown = summarizeFleet([{ unknownCount: 2 }]);
	assert.equal(unknown.healthLevel, "warn", "unknown outcomes are uncertainty, not confirmed execution failures");
	assert.equal(unknown.healthHeadline, "2 UNKNOWN");
	const aborted = summarizeFleet([{ abortedCount: 4 }]);
	assert.equal(aborted.healthLevel, "warn");
	assert.equal(aborted.healthHeadline, "4 ABORTED");
	const partial = summarizeFleet([{ partial: true }]);
	assert.equal(partial.healthHeadline, "NOMINAL", "bounded history is coverage information, not an execution failure");
	assert.equal(partial.coverageHeadline, "1 BOUNDED");
	const limited = summarizeFleet([], true);
	assert.equal(limited.healthHeadline, "NOMINAL");
	assert.equal(limited.coverageHeadline, "SCAN LIMITED");
	assert.equal(summarizeFleet([]).coverageHeadline, "COMPLETE");
});
