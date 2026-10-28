import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readTraceTail, scanTraceFiles, startTraceDashboard, summarizeFleet } from "./dashboard.mjs";
import { span, fixture } from "./dashboard-test-fixtures.mjs";

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
	assert.equal(trace.summary.sessionSizeBytes, Buffer.byteLength('{"type":"session"}\n'));
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
	assert.equal(scanned.traces[0].summary.sessionSizeBytes, null);
	const fleet = summarizeFleet(scanned.traces.map(({ summary }) => summary));
	assert.equal(fleet.orphanCount, 1);
	assert.equal(fleet.sessionTraceCount, 0);
	assert.equal(fleet.unresolvedErrorCount, 0);
	assert.equal(fleet.healthHeadline, "NOMINAL");
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
