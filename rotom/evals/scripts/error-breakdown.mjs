// Pure breakdown of tool and provider errors from local trace metadata.
// Callers pass already-parsed trace records; only the allowlisted attribute keys
// below are read, so session text, tool arguments and error bodies are never
// touched. A missing attribute stays "(none)" and is never inferred.
export const TOOL_SPAN = "pi.tool.execute";
export const PROVIDER_SPAN = "pi.ai.request";
export const RUN_SPAN = "pi.agent.run";
export const MISSING = "(none)";
export const TOP_COMBINATIONS = 5;
export const TOP_VALUES = 5;
// "Top decile" of sessions by error count, so a single runaway session cannot
// hide behind a fleet of healthy ones.
const CONCENTRATION_SHARE = 0.1;

// Trace attributes may be strings, numbers or booleans; any other shape is missing.
const none = (value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean"
	? (String(value) === "" ? MISSING : String(value))
	: MISSING;
const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const bump = (tally, key) => { tally[key] = (tally[key] ?? 0) + 1; };

/** Merge span_start/span_end records by trace+span id; unfinished spans keep no end. */
function mergeSpans(records) {
	const spans = new Map();
	for (const record of records) {
		if (typeof record?.traceId !== "string" || typeof record?.spanId !== "string") continue;
		if (record.kind !== "span_start" && record.kind !== "span_end") continue;
		const key = `${record.traceId}/${record.spanId}`;
		const span = spans.get(key) ?? { key, traceId: record.traceId, spanId: record.spanId, name: record.name, parentSpanId: undefined, ended: false, status: undefined, attributes: {} };
		if (typeof record.name === "string") span.name = record.name;
		if (typeof record.parentSpanId === "string") span.parentSpanId = record.parentSpanId;
		if (record.attributes && typeof record.attributes === "object") Object.assign(span.attributes, record.attributes);
		if (record.kind === "span_end") { span.ended = true; span.status = record.status; }
		spans.set(key, span);
	}
	return spans;
}

function sortedValues(tally) {
	return Object.entries(tally).map(([value, hits]) => ({ value, count: hits }))
		.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function mergeValues(target, source) {
	for (const [value, hits] of Object.entries(source ?? {})) target[value] = (target[value] ?? 0) + hits;
	return target;
}

/** Rows per tool name: ended spans, errors (outcome !== "ok"), aborted separately
 * because classifyFaultSide never blames aborted calls, and the outcome ×
 * fault_side × error_code combinations behind the count. */
export function toolErrorRows(traceRecords) {
	const rows = new Map();
	for (const span of mergeSpans(traceRecords).values()) {
		if (span.name !== TOOL_SPAN || !span.ended) continue;
		const tool = none(span.attributes["pi.tool.name"]);
		const row = rows.get(tool) ?? { tool, endedSpans: 0, errors: 0, aborted: 0, combinations: new Map() };
		row.endedSpans++;
		const outcome = none(span.attributes["pi.tool.outcome"]);
		if (outcome !== "ok") row.errors++;
		if (outcome === "aborted") row.aborted++;
		count(row.combinations, JSON.stringify([outcome, none(span.attributes["pi.tool.fault_side"]), none(span.attributes["pi.tool.error_code"])]));
		rows.set(tool, row);
	}
	return [...rows.values()].map((row) => ({
		tool: row.tool, endedSpans: row.endedSpans, errors: row.errors, aborted: row.aborted,
		combinations: [...row.combinations.entries()]
			.map(([key, hits]) => { const [outcome, faultSide, errorCode] = JSON.parse(key); return { outcome, faultSide, errorCode, count: hits }; })
			.sort((a, b) => b.count - a.count || a.outcome.localeCompare(b.outcome) || a.faultSide.localeCompare(b.faultSide) || a.errorCode.localeCompare(b.errorCode)),
	})).sort((a, b) => b.errors - a.errors || b.endedSpans - a.endedSpans || a.tool.localeCompare(b.tool));
}

function runOf(span, spans) {
	const seen = new Set();
	let current = span;
	while (current && !seen.has(current.key)) {
		if (current.name === RUN_SPAN) return current.key;
		seen.add(current.key);
		current = current.parentSpanId === undefined ? undefined : spans.get(`${current.traceId}/${current.parentSpanId}`);
	}
	return MISSING;
}

/** Per-call metadata for one tool, keyed by `pi.tool.call_id_digest` (sha256 of
 * the tool call id). Used to join session-side failures to trace evidence. */
export function toolCallInfo(traceRecords, toolName) {
	const info = new Map();
	for (const span of mergeSpans(traceRecords).values()) {
		if (span.name !== TOOL_SPAN || !span.ended) continue;
		if (none(span.attributes["pi.tool.name"]) !== toolName) continue;
		const digest = span.attributes["pi.tool.call_id_digest"];
		if (typeof digest !== "string") continue;
		info.set(digest, {
			code: span.attributes["pi.tool.error_code"] === undefined ? undefined : none(span.attributes["pi.tool.error_code"]),
			followup: span.attributes["pi.tool.followup_status"] === undefined ? undefined : none(span.attributes["pi.tool.followup_status"]),
		});
	}
	return info;
}

/** Most-attributed codes first; the code name breaks ties so output is stable. */
const byAttribution = (a, b) => (b.trace + b.derived) - (a.trace + a.derived) || a.code.localeCompare(b.code);

/** Edit failures split by evidence source: a trace code recorded by the product,
 * a code reconstructed from the local tool result, or a failed `then_run` that
 * left the edit itself applied. Counts only; the texts never leave the caller. */
export function editFailureRows(entries) {
	const rows = new Map();
	let thenRun = 0;
	let uncoded = 0;
	for (const entry of entries) {
		const traceCode = entry.traceCode;
		const derivedCode = entry.derivedCode;
		if (typeof traceCode === "string" && traceCode) {
			const row = rows.get(traceCode) ?? { code: traceCode, trace: 0, derived: 0 };
			row.trace++;
			rows.set(traceCode, row);
			continue;
		}
		if (entry.thenRunFailed === true) { thenRun++; continue; }
		if (typeof derivedCode === "string" && derivedCode) {
			const row = rows.get(derivedCode) ?? { code: derivedCode, trace: 0, derived: 0 };
			row.derived++;
			rows.set(derivedCode, row);
			continue;
		}
		uncoded++;
	}
	return {
		total: entries.length,
		thenRunFailed: thenRun,
		uncoded,
		rows: [...rows.values()].sort(byAttribution),
	};
}

/** Rows per provider/model × error category for failed request spans, plus how
 * many failed requests shared one run (retry evidence) and how many failures
 * preceded the trace's last failed request inside that same run. The last failed
 * request is the anchor, not the last request span: a session that ends on a
 * provider error can still emit later compaction/unknown-request spans. */
export function providerErrorRows(traceRecords) {
	const spans = mergeSpans(traceRecords);
	const rows = new Map();
	const runErrors = new Map();
	let requests = 0;
	let errors = 0;
	let abortedRequests = 0;
	let lastFailed;
	for (const span of spans.values()) {
		if (span.name !== PROVIDER_SPAN || !span.ended) continue;
		requests++;
		if (span.status === "aborted") abortedRequests++;
		if (span.status !== "error") continue;
		lastFailed = span;
		errors++;
		const provider = none(span.attributes["pi.ai.provider"]);
		const model = none(span.attributes["pi.ai.model"]);
		const category = none(span.attributes["pi.ai.error.category"]);
		const key = `${provider}\u0000${model}\u0000${category}`;
		const row = rows.get(key) ?? {
			provider, model, category, count: 0,
			httpStatus: {}, qoderErrorCode: {}, transportPhase: {}, endReason: {}, stopReason: {},
		};
		row.count++;
		bump(row.httpStatus, none(span.attributes["pi.ai.error.http_status"]));
		bump(row.qoderErrorCode, none(span.attributes["pi.ai.qoder.error_code"]));
		bump(row.transportPhase, none(span.attributes["pi.ai.qoder.transport_phase"]));
		bump(row.endReason, none(span.attributes["pi.ai.request.end_reason"]));
		bump(row.stopReason, none(span.attributes["pi.ai.response.stop_reason"]));
		rows.set(key, row);
		count(runErrors, runOf(span, spans));
	}
	return {
		requests, errors, abortedRequests,
		rows: [...rows.values()].sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || a.category.localeCompare(b.category)),
		lastFailedRequest: lastFailed === undefined
			? { status: MISSING, runErrorRequests: 0 }
			: { status: none(lastFailed.status), runErrorRequests: runErrors.get(runOf(lastFailed, spans)) ?? 0 },
	};
}

/** Merge per-session rows into the report aggregate. `sessions` entries are
 * `{ toolRows, provider, endedOnProviderError }` as returned by the functions
 * above; nothing here looks at session ids. */
export function aggregateBreakdown(sessions) {
	const tools = new Map();
	const providers = new Map();
	const perSessionErrors = [];
	let endedSpans = 0;
	let toolErrors = 0;
	let aborted = 0;
	let requests = 0;
	let providerErrors = 0;
	let abortedRequests = 0;
	let endedOnProviderError = 0;
	let runRetried = 0;
	let sessionRetried = 0;
	const editFailures = new Map();
	let editFailureTotal = 0;
	let thenRunFailed = 0;
	let editUncoded = 0;
	for (const session of sessions) {
		let sessionErrors = 0;
		for (const row of session.toolRows ?? []) {
			const merged = tools.get(row.tool) ?? { tool: row.tool, endedSpans: 0, errors: 0, aborted: 0, combinations: new Map() };
			merged.endedSpans += row.endedSpans;
			merged.errors += row.errors;
			merged.aborted += row.aborted;
			for (const combination of row.combinations) {
				const key = JSON.stringify([combination.outcome, combination.faultSide, combination.errorCode]);
				merged.combinations.set(key, (merged.combinations.get(key) ?? 0) + combination.count);
			}
			tools.set(row.tool, merged);
			endedSpans += row.endedSpans;
			sessionErrors += row.errors;
			toolErrors += row.errors;
			aborted += row.aborted;
		}
		perSessionErrors.push(sessionErrors);
		const provider = session.provider;
		requests += provider?.requests ?? 0;
		providerErrors += provider?.errors ?? 0;
		abortedRequests += provider?.abortedRequests ?? 0;
		for (const row of provider?.rows ?? []) {
			const key = `${row.provider}\u0000${row.model}\u0000${row.category}`;
			const merged = providers.get(key) ?? { provider: row.provider, model: row.model, category: row.category, count: 0, httpStatus: {}, qoderErrorCode: {}, transportPhase: {}, endReason: {}, stopReason: {} };
			merged.count += row.count;
			mergeValues(merged.httpStatus, row.httpStatus);
			mergeValues(merged.qoderErrorCode, row.qoderErrorCode);
			mergeValues(merged.transportPhase, row.transportPhase);
			mergeValues(merged.endReason, row.endReason);
			mergeValues(merged.stopReason, row.stopReason);
			providers.set(key, merged);
		}
		for (const row of session.editFailures?.rows ?? []) {
			const merged = editFailures.get(row.code) ?? { code: row.code, trace: 0, derived: 0 };
			merged.trace += row.trace;
			merged.derived += row.derived;
			editFailures.set(row.code, merged);
		}
		editFailureTotal += session.editFailures?.total ?? 0;
		thenRunFailed += session.editFailures?.thenRunFailed ?? 0;
		editUncoded += session.editFailures?.uncoded ?? 0;
		if (session.endedOnProviderError === true) {
			endedOnProviderError++;
			if ((provider?.lastFailedRequest?.runErrorRequests ?? 0) >= 2) runRetried++;
			if ((provider?.errors ?? 0) >= 2) sessionRetried++;
		}
	}
	const withErrors = perSessionErrors.filter((hits) => hits > 0).sort((a, b) => b - a);
	const topSessions = withErrors.length ? Math.max(1, Math.ceil(withErrors.length * CONCENTRATION_SHARE)) : 0;
	const topErrors = withErrors.slice(0, topSessions).reduce((sum, hits) => sum + hits, 0);
	return {
		sessions: sessions.length,
		toolTotals: { endedSpans, errors: toolErrors, aborted },
		tools: [...tools.values()].map((row) => ({
			tool: row.tool, endedSpans: row.endedSpans, errors: row.errors, aborted: row.aborted,
			rate: row.endedSpans ? row.errors / row.endedSpans : null,
			share: toolErrors ? row.errors / toolErrors : null,
			combinations: [...row.combinations.entries()]
				.map(([key, hits]) => { const [outcome, faultSide, errorCode] = JSON.parse(key); return { outcome, faultSide, errorCode, count: hits }; })
				.sort((a, b) => b.count - a.count || a.outcome.localeCompare(b.outcome) || a.faultSide.localeCompare(b.faultSide) || a.errorCode.localeCompare(b.errorCode)),
		})).sort((a, b) => b.errors - a.errors || b.endedSpans - a.endedSpans || a.tool.localeCompare(b.tool)),
		concentration: { sessionsWithErrors: withErrors.length, topSessions, topErrors, errors: withErrors.reduce((sum, hits) => sum + hits, 0), share: topErrors > 0 && withErrors.length ? topErrors / withErrors.reduce((sum, hits) => sum + hits, 0) : null },
		providerTotals: { requests, errors: providerErrors, abortedRequests },
		providers: [...providers.values()].map((row) => ({
			provider: row.provider, model: row.model, category: row.category, count: row.count,
			share: providerErrors ? row.count / providerErrors : null,
			httpStatus: sortedValues(row.httpStatus),
			qoderErrorCode: sortedValues(row.qoderErrorCode),
			transportPhase: sortedValues(row.transportPhase),
			endReason: sortedValues(row.endReason),
			stopReason: sortedValues(row.stopReason),
		})).sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || a.category.localeCompare(b.category)),
		// Pi opens a fresh run span per attempt, so a run can hold one failure only;
		// the session-level count keeps repeat failures visible without guessing.
		providerEnd: { sessions: endedOnProviderError, runRetried, sessionRetried, single: endedOnProviderError - sessionRetried },
		editFailures: {
			total: editFailureTotal, thenRunFailed, uncoded: editUncoded,
			rows: [...editFailures.values()].sort(byAttribution),
		},
	};
}
