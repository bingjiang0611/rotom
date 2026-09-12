import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import {
	dashboardRoute,
	efficiencyRates,
	formatDashboardCompact,
	formatDashboardDuration,
	formatDashboardMoney,
	mergeEfficiencyBuckets,
	readTraceTail,
	scanTraceFiles,
	STALE_OPEN_SPAN_MS,
	startTraceDashboard,
	summarizeEfficiency,
	summarizeFleet,
	summarizeTrace,
} from "./dashboard.mjs";

const SCHEMA = "rotom-local-trace/v1";

function span(kind, overrides = {}) {
	return {
		schema: SCHEMA,
		kind,
		timestamp: "2026-08-28T12:00:00.000Z",
		traceId: "a".repeat(32),
		spanId: (overrides.spanId ?? "b".repeat(16)),
		name: "pi.ai.request",
		...(kind === "span_end" ? { status: "ok", durationMs: 125 } : {}),
		...overrides,
	};
}

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "pi-trace-dashboard-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sessionDirectory = join(root, "project/session");
	const traceDirectory = join(sessionDirectory, "observability");
	await mkdir(traceDirectory, { recursive: true, mode: 0o700 });
	await writeFile(join(sessionDirectory, "session.jsonl"), "{\"type\":\"session\"}\n", { mode: 0o600 });
	const tracePath = join(traceDirectory, "session.trace.jsonl");
	const records = [
		span("span_start"),
		span("span_end", { attributes: {
			"pi.usage.input_tokens": 20,
			"pi.usage.output_tokens": 10,
			"pi.usage.reasoning_tokens": 4,
			"pi.usage.cache_read_tokens": 291,
			"pi.usage.cache_write_tokens": 0,
			"pi.usage.total_tokens": 321,
			"pi.usage.cost": 0.012,
			"pi.ai.stream.time_to_first_content_ms": 100,
			"pi.context.tokens": 96_000,
			"pi.context.window_tokens": 128_000,
			"pi.context.percent": 75,
			"unsafe.object": { secret: "must-drop" },
		} }),
		span("span_start", { spanId: "c".repeat(16), name: "pi.tool.execute", attributes: { "pi.tool.name": "bash" } }),
		span("span_end", { spanId: "c".repeat(16), name: "pi.tool.execute", status: "error", durationMs: 50, attributes: { "pi.tool.name": "bash", "pi.tool.result_estimated_tokens": 25 } }),
		span("span_start", { spanId: "d".repeat(16), name: "pi.ai.startup" }),
		span("span_end", { spanId: "d".repeat(16), name: "pi.ai.startup", durationMs: 40 }),
		span("span_start", { spanId: "e".repeat(16), name: "pi.ai.prefill" }),
		span("span_end", { spanId: "e".repeat(16), name: "pi.ai.prefill", durationMs: 60 }),
		span("span_start", { spanId: "f".repeat(16), name: "pi.ai.reasoning" }),
		span("span_end", { spanId: "f".repeat(16), name: "pi.ai.reasoning", durationMs: 100 }),
		span("span_start", { spanId: "0".repeat(16), name: "pi.ai.generation" }),
		span("span_end", { spanId: "0".repeat(16), name: "pi.ai.generation", durationMs: 100 }),
	];
	await writeFile(tracePath, `${records.map(JSON.stringify).join("\n")}\nnot-json\n${"x".repeat(70 * 1024)}\n`, { mode: 0o600 });
	return { root, tracePath };
}

test("scanner aggregates bounded trace metadata and skips symlinks", async (t) => {
	const { root, tracePath } = await fixture(t);
	if (process.platform !== "win32") {
		const outside = join(root, "outside.trace.jsonl");
		const outsideDirectory = join(root, "outside-directory");
		await writeFile(outside, `${JSON.stringify(span("span_end"))}\n`, { mode: 0o600 });
		await mkdir(outsideDirectory, { mode: 0o700 });
		await writeFile(join(outsideDirectory, "outside.trace.jsonl"), `${JSON.stringify(span("span_end"))}\n`, { mode: 0o600 });
		await symlink(outside, join(root, "project/session/observability/symlink.trace.jsonl"));
		await symlink(outsideDirectory, join(root, "project/directory-symlink"));
	}
	const result = await scanTraceFiles(root);
	assert.equal(result.traces.length, 1);
	const trace = result.traces[0];
	assert.equal(trace.path, await realpath(tracePath));
	assert.equal(trace.summary.spanCount, 6);
	assert.equal(trace.summary.errorCount, 1);
	assert.equal(trace.summary.rootErrorCount, 1);
	assert.equal(trace.summary.recoveredErrorCount, 0);
	assert.equal(trace.summary.unresolvedErrorCount, 1);
	assert.equal(trace.summary.propagatedErrorCount, 0);
	assert.equal(trace.summary.propagatedErrorSpanCount, 0);
	assert.equal(trace.summary.abortedCount, 0);
	assert.equal(trace.summary.abortedSpanCount, 0);
	assert.equal(trace.summary.unknownCount, 0);
	assert.equal(trace.summary.openCount, 0);
	assert.equal(trace.summary.runtimeOpenCount, 0);
	assert.equal(trace.summary.staleOpenCount, 0);
	assert.equal(trace.summary.anomalyCount, 1);
	assert.equal(trace.summary.orphan, false);
	assert.equal(trace.summary.providerCount, 1);
	assert.equal(trace.summary.toolCount, 1);
	assert.equal(trace.summary.toolDurationMs, 50);
	assert.equal(trace.summary.inputTokens, 20);
	assert.equal(trace.summary.outputTokens, 10);
	assert.equal(trace.summary.reasoningTokens, 4);
	assert.equal(trace.summary.cacheReadTokens, 291);
	assert.equal(trace.summary.cacheWriteTokens, 0);
	assert.equal(trace.summary.totalTokens, 321);
	assert.equal(trace.summary.estimatedCostUsd, 0.012);
	assert.equal(trace.summary.toolResultEstimatedTokens, 25);
	assert.equal(trace.summary.contextTokens, 96_000);
	assert.equal(trace.summary.contextWindowTokens, 128_000);
	assert.equal(trace.summary.contextPercent, 75);
	assert.equal(trace.summary.startupDurationMs, 40);
	assert.equal(trace.summary.prefillDurationMs, 60);
	assert.equal(trace.summary.reasoningDurationMs, 100);
	assert.equal(trace.summary.generationDurationMs, 100);
	assert.equal(trace.summary.promptTokensPerSecond, 200);
	assert.equal(trace.summary.generationTokensPerSecond, 50);
	assert.equal(trace.summary.parseErrors, 2, "malformed and oversized JSONL records must be rejected");
});

test("scanner marks traces without a sibling session as orphan and excludes them from fleet health", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-trace-orphan-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "deleted-session/observability");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await writeFile(join(directory, "deleted.trace.jsonl"), `${JSON.stringify(span("span_end", { status: "error" }))}\n`, { mode: 0o600 });
	const scanned = await scanTraceFiles(root);
	assert.equal(scanned.traces.length, 1);
	assert.equal(scanned.traces[0].summary.orphan, true);
	const fleet = summarizeFleet(scanned.traces.map(({ summary }) => summary));
	assert.equal(fleet.orphanCount, 1);
	assert.equal(fleet.sessionTraceCount, 0);
	assert.equal(fleet.unresolvedErrorCount, 0);
	assert.equal(fleet.healthHeadline, "NOMINAL");
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

test("bounded tail retains a complete record when the byte window begins on its newline boundary", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-trace-boundary-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "session/observability");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, "boundary.trace.jsonl");
	const first = `${JSON.stringify(span("span_end", { spanId: "1".repeat(16) }))}\n`;
	const terminal = `${JSON.stringify(span("span_end", { spanId: "2".repeat(16), status: "unknown" }))}\n`;
	await writeFile(path, first + terminal, { mode: 0o600 });
	const loaded = await readTraceTail(await realpath(root), await realpath(path), Buffer.byteLength(terminal), 10);
	assert.equal(loaded.records.length, 1);
	assert.equal(loaded.records[0].spanId, "2".repeat(16));
	assert.equal(loaded.partial, true);
	assert.equal(loaded.bytesRead, Buffer.byteLength(terminal));
});

test("cursor pagination advances across an oversized record without a newline", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-trace-oversized-page-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "session/observability");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, "oversized.trace.jsonl");
	await writeFile(path, "x".repeat(600 * 1024), { mode: 0o600 });
	const canonicalRoot = await realpath(root);
	const canonicalPath = await realpath(path);
	const latest = await readTraceTail(canonicalRoot, canonicalPath, 512 * 1024, 2_000);
	assert.equal(latest.records.length, 0);
	assert.ok(latest.startOffset < latest.endOffset, "an empty parsed page must still move its cursor toward the file start");
	const oldest = await readTraceTail(canonicalRoot, canonicalPath, 512 * 1024, 2_000, latest.sizeBytes, latest.startOffset);
	assert.equal(oldest.startOffset, 0);
	assert.equal(oldest.endOffset, latest.startOffset);
});

test("scanner rejects a symlink root and caps records loaded per summary", async (t) => {
	if (process.platform === "win32") { t.skip("symlink creation is privilege-dependent on Windows"); return; }
	const { root } = await fixture(t);
	const linkedRoot = `${root}-link`;
	t.after(() => rm(linkedRoot, { force: true }));
	await symlink(root, linkedRoot);
	await assert.rejects(() => scanTraceFiles(linkedRoot), /trace root must be a real directory/u);

	const cappedSessionDirectory = join(root, "capped");
	const cappedDirectory = join(cappedSessionDirectory, "observability");
	await mkdir(cappedDirectory, { recursive: true, mode: 0o700 });
	await writeFile(join(cappedSessionDirectory, "capped.jsonl"), "{\"type\":\"session\"}\n", { mode: 0o600 });
	const records = Array.from({ length: 2_101 }, (_, index) => JSON.stringify(span("span_end", { spanId: index.toString(16).padStart(16, "0") })));
	const cappedPath = join(cappedDirectory, "capped.trace.jsonl");
	await writeFile(cappedPath, `${records.join("\n")}\n`, { mode: 0o600 });
	const exactSessionDirectory = join(root, "exact");
	const exactDirectory = join(exactSessionDirectory, "observability");
	await mkdir(exactDirectory, { recursive: true, mode: 0o700 });
	await writeFile(join(exactSessionDirectory, "exact.jsonl"), "{\"type\":\"session\"}\n", { mode: 0o600 });
	await writeFile(join(exactDirectory, "exact.trace.jsonl"), `${records.slice(0, 2_000).join("\n")}\n`, { mode: 0o600 });
	const scanned = await scanTraceFiles(root);
	const capped = scanned.traces.find(({ summary }) => summary.path.endsWith("capped.trace.jsonl"));
	assert.equal(capped.summary.recordsLoaded, 2_000);
	assert.equal(capped.summary.partial, true);
	const exact = scanned.traces.find(({ summary }) => summary.path.endsWith("exact.trace.jsonl"));
	assert.equal(exact.summary.recordsLoaded, 2_000);
	assert.equal(exact.summary.partial, false, "exactly reaching the record limit is complete when no byte window was truncated");

	const token = "capped-detail-token";
	const dashboard = await startTraceDashboard({ root, token });
	t.after(() => dashboard.close());
	const headers = { authorization: `Bearer ${token}` };
	const listed = await fetch(`${dashboard.baseUrl}/api/traces`, { headers }).then((response) => response.json());
	assert.match(listed.snapshotId, /^[A-Za-z0-9_-]+$/u);
	const cappedSummary = listed.traces.find((summary) => summary.path.endsWith("capped.trace.jsonl"));
	await appendFile(cappedPath, `${JSON.stringify(span("span_end", { spanId: "f".repeat(16), status: "error" }))}\n`);
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_050));
	const refreshed = await fetch(`${dashboard.baseUrl}/api/traces`, { headers }).then((response) => response.json());
	assert.notEqual(refreshed.snapshotId, listed.snapshotId);
	assert.equal(refreshed.traces.find((summary) => summary.id === cappedSummary.id).errorCount, 1, "a newer list snapshot must see appended records");
	const detail = await fetch(`${dashboard.baseUrl}/api/trace?id=${cappedSummary.id}&snapshot=${listed.snapshotId}`, { headers }).then((response) => response.json());
	assert.equal(detail.records.length, 2_000);
	assert.equal(detail.summary.recordsLoaded, detail.records.length, "detail summary must describe exactly the returned record window");
	assert.equal(detail.summary.partial, true);
	assert.equal(detail.summary.sizeBytes, cappedSummary.sizeBytes, "detail must use the same stable file boundary as its list summary");
	assert.equal(detail.summary.windowBytes, cappedSummary.windowBytes, "detail must reuse the exact summary byte window");
	assert.equal(detail.summary.errorCount, cappedSummary.errorCount, "list and detail status counts must describe the same bounded window");
	assert.equal(detail.page.endOffset, cappedSummary.sizeBytes);
	assert.equal(detail.page.hasEarlier, true);
	assert.equal(detail.page.lifecycleComplete, false);
	assert.match(detail.page.nextCursor, /^[A-Za-z0-9_-]+$/u);
	const pagedSpanIds = new Set(detail.records.map((record) => record.spanId));
	let page = detail.page;
	while (page.hasEarlier) {
		const older = await fetch(`${dashboard.baseUrl}/api/trace-page?id=${cappedSummary.id}&snapshot=${listed.snapshotId}&cursor=${page.nextCursor}`, { headers }).then((response) => response.json());
		assert.equal(older.page.endOffset, page.startOffset, "cursor pages must be adjacent without byte gaps");
		for (const record of older.records) {
			assert.equal(pagedSpanIds.has(record.spanId), false, "cursor pages must not overlap records");
			pagedSpanIds.add(record.spanId);
		}
		page = older.page;
	}
	assert.equal(page.startOffset, 0);
	assert.equal(pagedSpanIds.size, 2_101, "walking older cursors must expose the complete snapshot");
	assert.equal(pagedSpanIds.has("f".repeat(16)), false, "snapshot pagination must exclude records appended after the list snapshot");
	const invalidCursor = await fetch(`${dashboard.baseUrl}/api/trace-page?id=${cappedSummary.id}&snapshot=${listed.snapshotId}&cursor=not-a-valid-offset`, { headers });
	assert.equal(invalidCursor.status, 400);
});

async function within(promise, timeoutMs, message) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, rejectTimeout) => { timer = setTimeout(() => rejectTimeout(new Error(message)), timeoutMs); }),
		]);
	} finally { if (timer) clearTimeout(timer); }
}

function rawRequest(url, options = {}) {
	return new Promise((resolveRequest, rejectRequest) => {
		const request = httpRequest(url, options, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => { body += chunk; });
			response.on("end", () => resolveRequest({ status: response.statusCode, headers: response.headers, body }));
		});
		request.on("error", rejectRequest);
		request.end();
	});
}

test("dashboard binds loopback, requires bearer auth, and serves trace details", async (t) => {
	const { root } = await fixture(t);
	const token = "test-dashboard-token";
	const dashboard = await startTraceDashboard({ root, token });
	t.after(() => dashboard.close());
	assert.match(dashboard.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=/u);

	const page = await fetch(`${dashboard.baseUrl}/`);
	assert.equal(page.status, 200);
	assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/u);
	const pageBody = await page.text();
	assert.match(pageBody, /Rotom Trace Dashboard/u);
	assert.match(pageBody, /PI TRACE/u);
	assert.match(pageBody, /id="view-stats"[^>]+aria-pressed="true"[^>]*>SESSION STATS/u);
	assert.match(pageBody, /id="view-trace"[^>]+aria-pressed="false"[^>]*>EXECUTION TRACE/u);
	assert.match(pageBody, /Session overview/u, "the session title must stay generic");
	assert.match(pageBody, /renderSessionStats/u, "every selected session must expose the long-horizon stats view");
	assert.match(pageBody, /activity-grid/u, "session stats must include the aggregated activity lanes");
	assert.match(pageBody, /statsPager.*NEWER.*PAGE .*OLDER/u, "bounded session stats must retain cursor pagination");
	assert.match(pageBody, /span-list/u);
	assert.match(pageBody, /span-dot\.startup.*span-dot\.prefill.*span-dot\.reasoning.*span-dot\.generation/u, "observed model phases must remain visually distinct in the activity timeline");
	assert.match(pageBody, /ANOMALY/u);
	assert.match(pageBody, /displaySpanName/u, "approved direction A must expose tool identity in the timeline and inspector");
	assert.match(pageBody, /traceDisplayName/u, "long trace filenames must render as compact timestamp/session labels");
	assert.match(pageBody, /wallTimeLabel/u, "mixed or incomplete operation windows must label their time basis");
	assert.match(pageBody, /wallTimeValue/u, "bounded windows without operation ends must show an observed window or N\/A instead of 0 ms");
	assert.match(pageBody, /PAGED HISTORY/u, "incomplete trace history must be presented as explicit cursor pages rather than partial failure");
	assert.match(pageBody, /RECOVERED/u, "recovered root failures must be distinguishable from unresolved failures");
	assert.doesNotMatch(pageBody, /return'PARTIAL'/u, "bounded coverage must not become the selected trace health badge");
	assert.match(pageBody, /formatDashboardDuration/u, "long summary durations must be human-readable instead of raw millisecond walls");
	assert.match(pageBody, /pageBounded\?'Page tokens':'Observed tokens'/u, "paged token metrics must be labeled as page-local rather than full-session lower bounds");
	assert.match(pageBody, /metric\('Uncached input'.*metric\('Cache read'.*metric\('Output'.*metric\('Reasoning tokens'.*metric\('Tool result est\.'.*metric\('Cache share'/u, "per-trace usage must separate uncached input, cache reads, output, reasoning, estimated tool-result tokens, and cache share");
	assert.match(pageBody, /'Latest context'.*metric\('Observed startup'.*metric\('Observed prefill'.*metric\('Reasoning stream'.*metric\('Generation stream'.*metric\('PP\/s observed'.*metric\('TG\/s observed'/u, "per-trace performance metrics must label client-observed and estimated values honestly");
	assert.match(pageBody, /function compactMoney/u, "large costs must use bounded display values while retaining exact titles");
	assert.match(pageBody, /grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/u, "desktop trace metrics must retain a stable six-column grid");
	assert.match(pageBody, /health-breakdown/u, "fleet health must use a scannable outcome breakdown");
	assert.doesNotMatch(pageBody, /≥/u, "bounded totals must use an explicit label instead of a greater-than-or-equal prefix");
	assert.match(pageBody, /bounded · loaded trace windows/u, "global totals must retain bounded-coverage disclosure without the prefix symbol");
	assert.match(pageBody, /usageParts\(f\)/u, "fleet usage must explain the observed token mix");
	assert.match(pageBody, /metrics cover this page only/u, "selected history pages must explicitly reject full-session interpretation");
	assert.match(pageBody, /bounded recent tail/u, "session rows must label bounded usage as a recent tail");
	assert.match(pageBody, /SCAN LIMITED/u, "scan truncation must remain visible inside the fleet strip when mobile hides top context");
	assert.match(pageBody, /coverageHeadline/u, "fleet execution health and trace coverage must remain separate");
	assert.match(pageBody, /orphanCount/u, "orphan traces must remain counted without contaminating fleet health");
	assert.match(pageBody, /showOrphans=false/u, "empty-launch orphan traces must be filtered from the archive by default");
	assert.match(pageBody, /id="orphan-toggle"[^>]+aria-pressed="false"/u, "users must be able to reveal filtered empty launches explicitly");
	assert.match(pageBody, /traceMatchesArchiveFilter\(x,query,showOrphans\)/u, "the archive must apply the explicit empty-launch filter");
	assert.match(pageBody, /max-width:960px/u, "medium widths must reflow the fleet strip instead of clipping a fixed-height horizontal scroller");
	assert.match(pageBody, /aria-current/u);
	assert.match(pageBody, /aria-pressed/u);
	assert.match(pageBody, /aria-label','Span family/u, "the detailed trace view must retain its family filter");
	assert.match(pageBody, /Filter span name/u, "the detailed trace view must retain span-name filtering");
	assert.match(pageBody, /ANOMALY/u, "the detailed trace view must retain anomaly filtering");
	assert.match(pageBody, /traceStatus\(summary\)/u, "the selected trace badge must identify its concrete dominant outcome");
	assert.match(pageBody, /className='trace-path'|e\('span','trace-path'/u, "long trace paths must have a dedicated ellipsized region");
	assert.match(pageBody, /button\.append\(main\)/u, "session cards must not insert an extra unnamed grid child");
	assert.match(pageBody, /session-panel\{[^}]*min-height:0;overflow:hidden/u, "the sidebar grid must be allowed to shrink inside the fixed workspace");
	assert.match(pageBody, /trace-list\{min-height:0;overflow-x:hidden;overflow-y:auto/u, "the session archive must own vertical scrolling instead of overflowing the footer");
	assert.match(pageBody, /id="traces" tabindex="0" aria-label="Session archive list"/u, "the scrollable archive must be keyboard focusable and named");
	assert.match(pageBody, /row=e\('button','span-row'/u, "clickable timeline rows must use native keyboard-accessible buttons");
	assert.match(pageBody, /timeline-pane\{min-width:0;overflow-x:auto\}/u, "mobile overflow must stay inside the timeline pane");
	assert.doesNotMatch(pageBody, /trace-body\{min-width:760px\}/u);
	assert.doesNotMatch(pageBody, /button\.append\(e\('i',''\),main\)/u);
	assert.match(pageBody, /trace\.totalTokens.*estimatedCostUsd/u, "session rows must expose token and cost totals");
	assert.match(pageBody, /metric\('Active'.*metric\('Stale'.*metric\('Unresolved'.*metric\('Recovered'.*Raw errors.*Propagated incidents/u, "complete traces must separate root-cause lifecycle outcomes while paged traces fall back to raw errors");
	assert.match(pageBody, /abortedSpanCount.*root-cause incidents/u, "aborted incident metrics must retain raw span pressure only as supporting detail");
	assert.match(pageBody, /Page tokens.*Page cost/u, "selected trace metrics must expose explicitly page-local token and cost values");
	assert.match(pageBody, /id="efficiency"/u, "dashboard must host the cost-per-success view");
	assert.match(pageBody, /renderSignals\(\);renderEfficiency\(\)/u, "efficiency view must refresh with each fleet load");
	assert.match(pageBody, /Cost per successful operation/u);
	assert.match(pageBody, /total spend \u00f7 successes/u, "the view must state that failed spend is included in the numerator");
	assert.match(pageBody, /Unknown tools \(unfin\u00b7unver\)/u, "the view must separate unfinished tools from unverified ones");
	assert.match(pageBody, /toolIncomplete/u);
	assert.match(pageBody, /toolUnverified/u);
	assert.match(pageBody, /loadHistoryPage/u);
	assert.match(pageBody, /api\/trace-page/u);
	assert.match(pageBody, /NEWER.*OLDER/u, "history navigation must support bounded cursor paging in both directions");
	assert.match(pageBody, /lifecycle classification is unavailable across page boundaries/u);
	assert.match(pageBody, /PAGE-LOCAL ERROR/u);
	assert.doesNotMatch(pageBody, /innerHTML|<script[^>]+src=/u, "trace-driven UI must remain self-contained and textContent-only");
	const inlineScript = pageBody.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u);
	assert.ok(inlineScript, "dashboard must include its authenticated self-contained client");
	assert.doesNotThrow(() => new Script(inlineScript[1]), "dashboard client must remain syntactically valid JavaScript");
	const familySource = inlineScript[1].match(/(function family\(name\)\{.*?\})\nfunction familyLabel/u)?.[1];
	const listOutcomeSource = inlineScript[1].match(/(function traceListOutcome\(trace\)\{.*?\})\nfunction traceMatchesArchiveFilter/u)?.[1];
	const archiveFilterSource = inlineScript[1].match(/(function traceMatchesArchiveFilter\(trace,query,includeOrphans\)\{.*?\})\nfunction renderTraceList/u)?.[1];
	const pairSource = inlineScript[1].match(/(function pairSpans\(records,lifecycleComplete\)\{.*?\})\nfunction metric/u)?.[1];
	assert.ok(familySource && listOutcomeSource && archiveFilterSource && pairSource, "client outcome and archive classifiers must remain testable functions");
	const listOutcomeContext = {};
	new Script(`${listOutcomeSource}\nresult=traceListOutcome({unresolvedErrorCount:0,unknownCount:0,staleOpenCount:0,abortedCount:2,recoveredErrorCount:3,openCount:1});`).runInNewContext(listOutcomeContext);
	assert.equal(listOutcomeContext.result.text, "2 aborted · 1 active", "list outcome precedence must match fleet and detail");
	const archiveFilterContext = {};
	new Script(`${archiveFilterSource}\nhidden=traceMatchesArchiveFilter({path:'empty.trace.jsonl',orphan:true},'',false);shown=traceMatchesArchiveFilter({path:'empty.trace.jsonl',orphan:true},'',true);matched=traceMatchesArchiveFilter({path:'session.trace.jsonl',orphan:false},'session',false);`).runInNewContext(archiveFilterContext);
	assert.equal(archiveFilterContext.hidden, false, "orphan empty launches are hidden by default");
	assert.equal(archiveFilterContext.shown, true, "the explicit toggle reveals orphan traces");
	assert.equal(archiveFilterContext.matched, true, "normal session path filtering remains intact");
	const providerErrorAt = "2026-08-28T12:00:00.000Z";
	const providerSuccessAt = "2026-08-28T12:01:00.000Z";
	const parentId = "1".repeat(16);
	const childId = "2".repeat(16);
	const successId = "3".repeat(16);
	const clientRecords = [
		span("span_start", { spanId: parentId, name: "pi.agent.turn", timestamp: providerErrorAt }),
		span("span_start", { spanId: childId, parentSpanId: parentId, timestamp: providerErrorAt }),
		span("span_end", { spanId: childId, parentSpanId: parentId, status: "error", timestamp: providerErrorAt }),
		span("span_end", { spanId: parentId, name: "pi.agent.turn", status: "error", timestamp: providerErrorAt }),
		span("span_start", { spanId: successId, timestamp: providerSuccessAt }),
		span("span_end", { spanId: successId, status: "ok", timestamp: providerSuccessAt }),
	];
	const clientContext = { records: clientRecords };
	new Script(`${familySource}\n${pairSource}\nresult=pairSpans(records);`).runInNewContext(clientContext);
	const clientChild = clientContext.result.find((item) => item.spanId === childId);
	const clientParent = clientContext.result.find((item) => item.spanId === parentId);
	assert.equal(clientChild.recovered, true, "a root error followed by provider success is recovered");
	assert.equal(clientParent.propagatedError, true);
	assert.notEqual(clientParent.recovered, true, "a propagated parent must never be relabeled as a recovered root");
	const boundaryContext = { records: [span("span_start", { spanId: "4".repeat(16), name: "pi.agent.operation", timestamp: providerErrorAt })] };
	new Script(`${familySource}\n${pairSource}\nresult=pairSpans(records,false);`).runInNewContext(boundaryContext);
	assert.equal(boundaryContext.result[0].status, "incomplete", "a start split from its end by pagination must not be reported as active or stale");
	assert.equal(boundaryContext.result[0].durationMs, 0, "a split span must stop at the page boundary instead of extending to the current clock");

	const badHost = await rawRequest(`${dashboard.baseUrl}/api/traces`, { headers: { host: "evil.example", authorization: `Bearer ${token}` } });
	assert.equal(badHost.status, 421);
	const options = await fetch(`${dashboard.baseUrl}/api/traces`, { method: "OPTIONS" });
	assert.equal(options.status, 405);
	assert.equal(options.headers.get("access-control-allow-origin"), null);
	const rejected = await fetch(`${dashboard.baseUrl}/api/traces`);
	assert.equal(rejected.status, 401);
	assert.equal(rejected.headers.get("access-control-allow-origin"), null);

	const headers = { authorization: `Bearer ${token}` };
	const listed = await fetch(`${dashboard.baseUrl}/api/traces`, { headers });
	assert.equal(listed.status, 200);
	assert.equal(listed.headers.get("access-control-allow-origin"), null);
	const listBody = await listed.json();
	assert.equal(listBody.traces.length, 1);
	assert.equal(listBody.fleet.traceCount, 1);
	assert.equal(listBody.fleet.healthHeadline, "1 UNRESOLVED");
	assert.equal(listBody.fleet.aggregateLimited, true, "rejected summary records must qualify fleet aggregates");
	assert.match(listBody.snapshotId, /^[A-Za-z0-9_-]+$/u);
	const withoutSnapshot = await fetch(`${dashboard.baseUrl}/api/trace?id=${listBody.traces[0].id}`, { headers });
	assert.equal(withoutSnapshot.status, 409);
	const detail = await fetch(`${dashboard.baseUrl}/api/trace?id=${listBody.traces[0].id}&snapshot=${listBody.snapshotId}`, { headers });
	assert.equal(detail.status, 200);
	const detailBody = await detail.json();
	assert.equal(detailBody.records.filter((record) => record.kind === "span_end").length, 6);
	assert.equal(detailBody.page.hasEarlier, false);
	assert.equal(detailBody.page.hasNewer, false);
	assert.equal(detailBody.page.lifecycleComplete, true);
	assert.equal(JSON.stringify(detailBody).includes("must-drop"), false);

	const missing = await fetch(`${dashboard.baseUrl}/api/trace?id=../../etc/passwd&snapshot=${listBody.snapshotId}`, { headers });
	assert.equal(missing.status, 404);
});

test("CLI prints a local URL and exits cleanly on SIGINT", async (t) => {
	if (process.platform === "win32") { t.skip("SIGINT child delivery differs on Windows"); return; }
	const home = await mkdtemp(join(tmpdir(), "pi-trace-dashboard-cli-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	await mkdir(join(home, ".pi/agent/sessions"), { recursive: true, mode: 0o700 });
	const child = spawn(process.execPath, [new URL("./dashboard.mjs", import.meta.url).pathname], {
		env: { ...process.env, HOME: home },
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
	let stdout = "";
	await within(new Promise((resolveReady, rejectReady) => {
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (/Rotom trace dashboard: http:\/\/127\.0\.0\.1:\d+\/#token=/u.test(stdout)) resolveReady();
		});
		child.once("error", rejectReady);
	}), 5_000, "dashboard CLI did not become ready");
	child.kill("SIGINT");
	const [code, signal] = await within(once(child, "exit"), 5_000, "dashboard CLI did not stop");
	assert.equal(code, 0);
	assert.equal(signal, null);
});

// --- cost/tokens per successful operation ---------------------------------

const OP = "op".padEnd(16, "0");
const OP2 = "op2".padEnd(16, "0");

function opRecords(spanId, { status = "ok", provider = "qoder-experimental", model = "ultimate", thinking = "low", cost = 0.02, totalTokens = 1000, tools = [], groups } = {}) {
	const requestId = `req${spanId}`.slice(0, 16).padEnd(16, "r");
	const providerAttrs = {
		"pi.ai.provider": provider, "pi.ai.model": model, "pi.ai.thinking_level": thinking,
		"pi.usage.total_tokens": totalTokens, ...(cost !== null ? { "pi.usage.cost": cost } : {}),
		...(groups ? { "pi.tools.deferred_groups": groups } : {}),
	};
	const out = [
		span("span_start", { spanId, name: "pi.agent.operation" }),
		span("span_start", { spanId: requestId, parentSpanId: spanId, name: "pi.ai.request" }),
		span("span_end", { spanId: requestId, parentSpanId: spanId, name: "pi.ai.request", status: "ok", attributes: providerAttrs }),
	];
	tools.forEach((tool, index) => {
		const toolId = `tool${spanId}${index}`.slice(0, 16).padEnd(16, "t");
		out.push(span("span_end", { spanId: toolId, parentSpanId: spanId, name: "pi.tool.execute", status: tool.status ?? "ok", attributes: { "pi.tool.name": tool.name ?? "bash", ...(tool.group ? { "pi.tool.capability_group": tool.group } : {}), ...(tool.faultSide ? { "pi.tool.fault_side": tool.faultSide } : {}), ...(tool.outcome ? { "pi.tool.outcome": tool.outcome } : {}) } }));
	});
	out.push(span("span_end", { spanId, name: "pi.agent.operation", status }));
	return out;
}

test("route derives from qoder catalog model id, not a copied list", () => {
	assert.equal(dashboardRoute("qoder-experimental", "ultimate"), "qoder-cosy");
	assert.equal(dashboardRoute("qoder-experimental", "smodel"), "qoder-cosy");
	assert.equal(dashboardRoute("qoder-experimental", "claude-sonnet"), "qoder-direct");
	assert.equal(dashboardRoute("cc-switch", "claude-opus-5"), "n/a");
	assert.equal(dashboardRoute("", "x"), "unknown");
	assert.equal(dashboardRoute("qoder-experimental", ""), "unknown");
});

test("efficiency splits successes by provider/model/route/thinking and attributes subagent use", () => {
	const { buckets } = summarizeEfficiency([
		...opRecords(OP, { model: "ultimate", tools: [{ name: "subagent", group: "subagent" }, { name: "bash" }] }),
		...opRecords(OP2, { model: "claude-sonnet" }),
	]);
	const cosy = buckets.find((bucket) => bucket.route === "qoder-cosy");
	const direct = buckets.find((bucket) => bucket.route === "qoder-direct");
	assert.equal(cosy.subagentUsed, true);
	assert.equal(cosy.thinkingLevel, "low");
	assert.equal(direct.subagentUsed, false);
	assert.equal(cosy.successCount, 1);
	assert.equal(direct.successCount, 1);
});

test("cost per success stays null when any operation in the bucket reported no price", () => {
	const priced = mergeEfficiencyBuckets([summarizeEfficiency(opRecords(OP, { cost: 0.02, totalTokens: 1000 }))]).buckets[0];
	assert.equal(priced.costPerSuccessUsd, 0.02);
	assert.equal(priced.tokensPerSuccess, 1000);
	assert.equal(priced.pricingReason, "reported");

	// Qoder's $0 placeholder must not read as "free": no positive cost anywhere.
	const placeholder = mergeEfficiencyBuckets([summarizeEfficiency(opRecords(OP, { cost: 0, totalTokens: 1000 }))]).buckets[0];
	assert.equal(placeholder.costPerSuccessUsd, null);
	assert.equal(placeholder.tokensPerSuccess, 1000);
	assert.equal(placeholder.pricingReason, "not-reported");
});

test("failed and unknown operations count spend but not success, and never divide by zero", () => {
	const { buckets } = summarizeEfficiency([
		...opRecords(OP, { status: "ok", cost: 0.01, totalTokens: 500 }),
		...opRecords(OP2, { status: "error", cost: 0.03, totalTokens: 700 }),
	]);
	const [merged] = mergeEfficiencyBuckets([{ buckets, truncated: false }]).buckets;
	assert.equal(merged.operationCount, 2);
	assert.equal(merged.successCount, 1);
	assert.equal(merged.errorCount, 1);
	// Numerator is total spend (0.04) over one success: a dead end is part of the bill.
	assert.equal(Math.round(merged.costPerSuccessUsd * 1000) / 1000, 0.04);
	assert.equal(merged.tokensPerSuccess, 1200);

	const zero = efficiencyRates({ successCount: 0, operationCount: 3, totalTokens: 900, costUsd: 0.09, costReportedOperationCount: 3 });
	assert.equal(zero.costPerSuccessUsd, null);
	assert.equal(zero.tokensPerSuccess, null);
});

test("mixed provider/model within one operation is labelled mixed, not last-writer", () => {
	const mixedRequestId = "reqMIXED00000000";
	const { buckets } = summarizeEfficiency([
		span("span_start", { spanId: OP, name: "pi.agent.operation" }),
		span("span_end", { spanId: "reqA0000000000000", parentSpanId: OP, name: "pi.ai.request", status: "ok", attributes: { "pi.ai.provider": "qoder-experimental", "pi.ai.model": "ultimate" } }),
		span("span_end", { spanId: mixedRequestId, parentSpanId: OP, name: "pi.ai.request", status: "ok", attributes: { "pi.ai.provider": "cc-switch", "pi.ai.model": "claude-opus-5" } }),
		span("span_end", { spanId: OP, name: "pi.agent.operation", status: "ok" }),
	]);
	assert.equal(buckets.length, 1);
	assert.equal(buckets[0].provider, "mixed");
	assert.equal(buckets[0].route, "mixed");
});

test("fault-side tallies roll up per bucket from evidence-gated tool spans", () => {
	const { buckets } = summarizeEfficiency(opRecords(OP, { tools: [
		{ name: "edit", faultSide: "model" },
		{ name: "bash", faultSide: "environment" },
		{ name: "bash", faultSide: "unknown" },
	] }));
	const [merged] = mergeEfficiencyBuckets([{ buckets, truncated: false }]).buckets;
	assert.equal(merged.faultModel, 1);
	assert.equal(merged.faultEnvironment, 1);
	assert.equal(merged.faultUnknown, 1);
	assert.equal(merged.faultHarness, 0);
});

test("tool-level unknown split separates lifecycle-incomplete from ran-but-unverified", () => {
	const { buckets } = summarizeEfficiency(opRecords(OP, { tools: [
		{ name: "bash", status: "unknown", outcome: "incomplete" },
		{ name: "edit", status: "unknown", outcome: "incomplete" },
		{ name: "write", status: "unknown", outcome: "unknown_outcome" },
		{ name: "bash", status: "ok" },
	] }));
	const [merged] = mergeEfficiencyBuckets([{ buckets, truncated: false }]).buckets;
	assert.equal(merged.toolIncomplete, 2, "superseded / torn-down tools are lifecycle-incomplete, not model failures");
	assert.equal(merged.toolUnverified, 1, "a returned-but-unverified result is the derailment signal");
	// The split is a distinct axis from fault side: incomplete tools carry no side.
	assert.equal(merged.faultModel + merged.faultEnvironment + merged.faultHarness + merged.faultUnknown, 0);
});
