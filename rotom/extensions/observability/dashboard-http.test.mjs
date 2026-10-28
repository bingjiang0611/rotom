import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";
import { formatDashboardDuration, startTraceDashboard, toolEvidenceLabels } from "./dashboard.mjs";
import { COPY } from "./dashboard-copy.mjs";
import { span, fixture } from "./dashboard-test-fixtures.mjs";

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
	assert.match(pageBody, /Rotom 执行链路面板/u);
	assert.match(pageBody, /ROTOM 观测/u);
	assert.match(pageBody, /ROTOM \/ 可观测性/u);
	assert.doesNotMatch(pageBody, />PI<|PI TRACE|PI-AGENT/u);
	assert.match(pageBody, /id="view-stats"[^>]+aria-pressed="true"[^>]*>会话统计/u);
	assert.match(pageBody, /id="view-trace"[^>]+aria-pressed="false"[^>]*>执行链路/u);
	assert.match(pageBody, /会话概览/u, "the session title must stay generic");
	assert.match(pageBody, /renderSessionStats/u, "every selected session must expose the long-horizon stats view");
	assert.match(pageBody, /activity-grid/u, "session stats must include the aggregated activity lanes");
	assert.match(pageBody, /statsPager.*COPY\.newer.*COPY\.page.*COPY\.older/u, "bounded session stats must retain cursor pagination");
	assert.match(pageBody, /span-list/u);
	assert.match(pageBody, /span-dot\.startup.*span-dot\.prefill.*span-dot\.reasoning.*span-dot\.generation/u, "observed model phases must remain visually distinct in the activity timeline");
	assert.match(pageBody, /异常/u);
	assert.match(pageBody, /displaySpanName/u, "approved direction A must expose tool identity in the timeline and inspector");
	assert.match(pageBody, /traceDisplayName/u, "long trace filenames must render as compact timestamp/session labels");
	assert.match(pageBody, /wallTimeLabel/u, "mixed or incomplete operation windows must label their time basis");
	assert.match(pageBody, /wallTimeValue/u, "bounded windows without operation ends must show an observed window or N\/A instead of 0 ms");
	assert.match(pageBody, /分页历史/u, "incomplete trace history must be presented as explicit cursor pages rather than partial failure");
	assert.match(pageBody, /已恢复/u, "recovered root failures must be distinguishable from unresolved failures");
	assert.doesNotMatch(pageBody, /return'PARTIAL'/u, "bounded coverage must not become the selected trace health badge");
	assert.match(pageBody, /formatDashboardDuration/u, "long summary durations must be human-readable instead of raw millisecond walls");
	assert.match(pageBody, /pageBounded\?COPY\.pageTokens:COPY\.observedTokens/u, "paged token metrics must be labeled as page-local rather than full-session lower bounds");
	assert.match(pageBody, /metric\(COPY\.uncachedInput.*metric\(COPY\.cacheRead.*metric\(COPY\.output.*metric\(COPY\.reasoningTokens.*metric\(COPY\.toolResultEstimate.*metric\(COPY\.cacheShare/u, "per-trace usage must separate uncached input, cache reads, output, reasoning, estimated tool-result tokens, and cache share");
	assert.match(pageBody, /COPY\.latestContext.*metric\(COPY\.observedStartup.*metric\(COPY\.observedPrefill.*metric\(COPY\.reasoningStream.*metric\(COPY\.generationStream.*metric\(COPY\.ppObserved.*metric\(COPY\.tgObserved/u, "per-trace performance metrics must label client-observed and estimated values honestly");
	assert.match(pageBody, /function compactMoney/u, "large costs must use bounded display values while retaining exact titles");
	assert.match(pageBody, /grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/u, "desktop trace metrics must retain a stable six-column grid");
	assert.match(pageBody, /health-breakdown/u, "fleet health must use a scannable outcome breakdown");
	assert.doesNotMatch(pageBody, /≥/u, "bounded totals must use an explicit label instead of a greater-than-or-equal prefix");
	assert.match(pageBody, /COPY\.boundedWindows/u, "global totals must retain bounded-coverage disclosure without the prefix symbol");
	assert.match(pageBody, /usageParts\(f\)/u, "fleet usage must explain the observed token mix");
	assert.match(pageBody, /COPY\.metricsThisPage/u, "selected history pages must explicitly reject full-session interpretation");
	assert.match(pageBody, /COPY\.boundedRecentTail/u, "session rows must label bounded usage as a recent tail");
	assert.match(pageBody, /扫描受限/u, "scan truncation must remain visible inside the fleet strip when mobile hides top context");
	assert.match(pageBody, /coverageHeadline/u, "fleet execution health and trace coverage must remain separate");
	assert.match(pageBody, /orphanCount/u, "orphan traces must remain counted without contaminating fleet health");
	assert.match(pageBody, /showOrphans=false/u, "empty-launch orphan traces must be filtered from the archive by default");
	assert.match(pageBody, /id="orphan-toggle"[^>]+aria-pressed="false"/u, "users must be able to reveal filtered empty launches explicitly");
	assert.match(pageBody, /traceMatchesArchiveFilter\(x,query,showOrphans\)/u, "the archive must apply the explicit empty-launch filter");
	assert.match(pageBody, /max-width:960px/u, "medium widths must reflow the fleet strip instead of clipping a fixed-height horizontal scroller");
	assert.match(pageBody, /aria-current/u);
	assert.match(pageBody, /aria-pressed/u);
	assert.match(pageBody, /select\.setAttribute\('aria-label',COPY\.spanFamily\)/u, "the detailed trace view must retain its family filter");
	assert.match(pageBody, /过滤跨度名称/u, "the detailed trace view must retain span-name filtering");
	assert.match(pageBody, /异常/u, "the detailed trace view must retain anomaly filtering");
	assert.match(pageBody, /traceStatus\(summary\)/u, "the selected trace badge must identify its concrete dominant outcome");
	assert.match(pageBody, /className='trace-path'|e\('span','trace-path'/u, "long trace paths must have a dedicated ellipsized region");
	assert.match(pageBody, /button\.append\(main\)/u, "session cards must not insert an extra unnamed grid child");
	assert.match(pageBody, /session-panel\{[^}]*min-height:0;overflow:hidden/u, "the sidebar grid must be allowed to shrink inside the fixed workspace");
	assert.match(pageBody, /trace-list\{min-height:0;overflow-x:hidden;overflow-y:auto/u, "the session archive must own vertical scrolling instead of overflowing the footer");
	assert.match(pageBody, /id="traces" tabindex="0" aria-label="会话归档列表"/u, "the scrollable archive must be keyboard focusable and named");
	assert.match(pageBody, /row=e\('button','span-row'/u, "clickable timeline rows must use native keyboard-accessible buttons");
	assert.match(pageBody, /timeline-pane\{min-width:0;overflow-x:auto\}/u, "mobile overflow must stay inside the timeline pane");
	assert.doesNotMatch(pageBody, /trace-body\{min-width:760px\}/u);
	assert.doesNotMatch(pageBody, /button\.append\(e\('i',''\),main\)/u);
	assert.match(pageBody, /trace\.totalTokens.*estimatedCostUsd/u, "session rows must expose token and cost totals");
	assert.match(pageBody, /metric\(COPY\.active.*metric\(COPY\.stale.*metric\(COPY\.unresolved.*metric\(COPY\.recovered.*COPY\.rawErrors.*COPY\.propagatedIncidentsMetric/u, "complete traces must separate root-cause lifecycle outcomes while paged traces fall back to raw errors");
	assert.match(pageBody, /abortedSpanCount.*COPY\.rootCauseIncidents/u, "aborted incident metrics must retain raw span pressure only as supporting detail");
	assert.match(pageBody, /COPY\.pageTokens.*COPY\.pageCost/u, "selected trace metrics must expose explicitly page-local token and cost values");
	assert.match(pageBody, /id="efficiency"/u, "dashboard must host the cost-per-success view");
	assert.match(pageBody, /renderSignals\(\);renderEfficiency\(\)/u, "efficiency view must refresh with each fleet load");
	assert.match(pageBody, /每次成功操作的费用/u);
	assert.match(pageBody, /总支出 ÷ 成功次数/u, "the view must state that failed spend is included in the numerator");
	assert.match(pageBody, /未知工具（未完成·未验证）/u, "the view must separate unfinished tools from unverified ones");
	assert.match(pageBody, /toolIncomplete/u);
	assert.match(pageBody, /toolUnverified/u);
	assert.match(pageBody, /loadHistoryPage/u);
	assert.match(pageBody, /api\/trace-page/u);
	assert.match(pageBody, /COPY\.newer.*COPY\.older/u, "history navigation must support bounded cursor paging in both directions");
	assert.match(pageBody, /lifecycleUnavailable/u);
	assert.match(pageBody, /pageLocalError/u);
	assert.match(pageBody, /concat\(toolEvidenceLabels\(span\)\)/u, "inspector renders the shared evidence projection");
	assert.match(pageBody, /launchReceipt/u);
	assert.match(pageBody, /appliedToolReported/u);
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
	listOutcomeContext.COPY = COPY;
	new Script(`${listOutcomeSource}\nresult=traceListOutcome({unresolvedErrorCount:0,unknownCount:0,staleOpenCount:0,abortedCount:2,recoveredErrorCount:3,openCount:1});`).runInNewContext(listOutcomeContext);
	assert.equal(listOutcomeContext.result.text, "2 已中止 · 1 进行中", "list outcome precedence must match fleet and detail");
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
	const child = spawn(process.execPath, [fileURLToPath(new URL("./dashboard.mjs", import.meta.url))], {
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
