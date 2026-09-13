#!/usr/bin/env node

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, opendir, open, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { LEGACY_MODEL_IDS } from "../qoder/legacy.mjs";

const TRACE_SCHEMA = "rotom-local-trace/v1";

// Qoder picks its wire route purely from the catalog model id, so the route is a
// function of an attribute the trace already carries. The id list is imported
// rather than copied: a catalog change must not leave this dimension quietly
// mislabelling COSY single-inference traffic as direct.
const QODER_COSY_MODEL_IDS = new Set(LEGACY_MODEL_IDS);
const MAX_EFFICIENCY_BUCKETS = 64;

/**
 * Wire route for a recorded (provider, model) pair.
 *
 * `n/a` means the provider has no such split, not that the route is unknown.
 */
export function dashboardRoute(provider, model) {
	if (typeof provider !== "string" || !provider) return "unknown";
	if (!/qoder/iu.test(provider)) return "n/a";
	if (typeof model !== "string" || !model) return "unknown";
	return QODER_COSY_MODEL_IDS.has(model) ? "qoder-cosy" : "qoder-direct";
}
const MAX_SCAN_ENTRIES = 50_000;
const MAX_TRACE_FILES = 500;
const MAX_TRACE_BYTES = 8 * 1024 * 1024;
const MAX_SUMMARY_TRACE_BYTES = 512 * 1024;
const MAX_TOTAL_SUMMARY_BYTES = 64 * 1024 * 1024;
const MAX_TRACE_RECORDS = 5_000;
const MAX_API_RECORDS = 2_000;
const MAX_JSON_LINE_BYTES = 64 * 1024;
const MAX_API_CONCURRENCY = 4;
const MAX_SUMMARY_SNAPSHOTS = 8;
const SUMMARY_CACHE_TTL_MS = 2_000;
const SHUTDOWN_TIMEOUT_MS = 1_000;

function jsonResponse(response, status, value) {
	const body = `${JSON.stringify(value)}\n`;
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
	});
	response.end(body);
}

function textResponse(response, status, body, headers = {}) {
	response.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
		...headers,
	});
	response.end(body);
}

function safeAttributeValue(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return value.slice(0, 512);
	if (Array.isArray(value) && value.length <= 100) {
		const items = value.map(safeAttributeValue);
		if (items.every((item) => item !== undefined && !Array.isArray(item))) return items;
	}
	return undefined;
}

function sanitizeTraceRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== TRACE_SCHEMA) return undefined;
	if (value.kind !== "span_start" && value.kind !== "span_end") return undefined;
	if (typeof value.traceId !== "string" || !/^[0-9a-f]{32}$/u.test(value.traceId)) return undefined;
	if (typeof value.spanId !== "string" || !/^[0-9a-f]{16}$/u.test(value.spanId)) return undefined;
	if (typeof value.name !== "string" || value.name.length < 1 || value.name.length > 128) return undefined;
	const timestamp = typeof value.timestamp === "string" && Number.isFinite(Date.parse(value.timestamp))
		? value.timestamp
		: undefined;
	if (!timestamp) return undefined;
	const attributes = {};
	if (value.attributes && typeof value.attributes === "object" && !Array.isArray(value.attributes)) {
		for (const [key, item] of Object.entries(value.attributes).slice(0, 100)) {
			if (key.length < 1 || key.length > 128) continue;
			const sanitized = safeAttributeValue(item);
			if (sanitized !== undefined) attributes[key] = sanitized;
		}
	}
	return {
		schema: TRACE_SCHEMA,
		kind: value.kind,
		timestamp,
		traceId: value.traceId,
		spanId: value.spanId,
		...(typeof value.parentSpanId === "string" && /^[0-9a-f]{16}$/u.test(value.parentSpanId) ? { parentSpanId: value.parentSpanId } : {}),
		name: value.name,
		...(value.kind === "span_end" && ["ok", "error", "aborted", "unknown"].includes(value.status) ? { status: value.status } : {}),
		...(value.kind === "span_end" && typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0 ? { durationMs: value.durationMs } : {}),
		...(Object.keys(attributes).length ? { attributes } : {}),
	};
}

function containedBy(root, candidate) {
	const fromRoot = relative(root, candidate);
	return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

async function canonicalTraceRoot(root) {
	const absolute = resolve(root);
	let metadata;
	try { metadata = await lstat(absolute); }
	catch (error) {
		if (error?.code === "ENOENT") return { root: absolute, missing: true };
		throw error;
	}
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("trace root must be a real directory");
	return { root: await realpath(absolute), missing: false };
}

async function collectTracePaths(root) {
	const paths = [];
	const stack = [root];
	const visitedDirectories = new Set();
	let visited = 0;
	while (stack.length && paths.length < MAX_TRACE_FILES && visited < MAX_SCAN_ENTRIES) {
		const directory = stack.pop();
		if (visitedDirectories.has(directory)) continue;
		visitedDirectories.add(directory);
		let handle;
		try { handle = await opendir(directory); }
		catch { continue; }
		for await (const entry of handle) {
			visited += 1;
			if (visited > MAX_SCAN_ENTRIES) break;
			const lexicalPath = resolve(directory, entry.name);
			let metadata;
			try { metadata = await lstat(lexicalPath); }
			catch { continue; }
			if (metadata.isSymbolicLink()) continue;
			let canonicalPath;
			try { canonicalPath = await realpath(lexicalPath); }
			catch { continue; }
			if (!containedBy(root, canonicalPath)) continue;
			if (metadata.isDirectory()) stack.push(canonicalPath);
			else if (metadata.isFile() && entry.name.endsWith(".trace.jsonl") && basename(dirname(canonicalPath)) === "observability") paths.push(canonicalPath);
			if (paths.length >= MAX_TRACE_FILES) break;
		}
	}
	return { paths, scanLimited: stack.length > 0 || visited >= MAX_SCAN_ENTRIES || paths.length >= MAX_TRACE_FILES };
}

async function assertNoSymlinkComponents(root, path) {
	const fromRoot = relative(root, path);
	if (!containedBy(root, path) || !fromRoot) throw new Error("trace path is outside the trace root");
	let current = root;
	for (const component of fromRoot.split(sep)) {
		current = resolve(current, component);
		const metadata = await lstat(current);
		if (metadata.isSymbolicLink()) throw new Error("trace path contains a symlink");
	}
}

async function readExactly(handle, length, position) {
	const buffer = Buffer.alloc(length);
	let offset = 0;
	while (offset < length) {
		const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	return buffer.subarray(0, offset);
}

export async function readTraceTail(root, path, maximumBytes = MAX_TRACE_BYTES, maximumRecords = MAX_TRACE_RECORDS, maximumFileSize, endingOffset) {
	await assertNoSymlinkComponents(root, path);
	const canonicalPath = await realpath(path);
	if (!containedBy(root, canonicalPath)) throw new Error("trace path escaped the trace root");
	const expected = await stat(canonicalPath);
	if (!expected.isFile()) throw new Error("trace is not a regular file");
	const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
	const handle = await open(path, flags);
	let metadata;
	let buffer;
	let requestedBytes;
	let bytesRead;
	let offset;
	let pageEndOffset;
	let visibleSize;
	let startsAtRecordBoundary = true;
	try {
		metadata = await handle.stat();
		if (!metadata.isFile() || metadata.dev !== expected.dev || metadata.ino !== expected.ino) throw new Error("trace changed during safe open");
		visibleSize = Number.isSafeInteger(maximumFileSize) && maximumFileSize >= 0
			? Math.min(metadata.size, maximumFileSize)
			: metadata.size;
		pageEndOffset = endingOffset === undefined ? visibleSize : endingOffset;
		if (!Number.isSafeInteger(pageEndOffset) || pageEndOffset < 0 || pageEndOffset > visibleSize) throw new Error("trace page cursor is outside the snapshot");
		requestedBytes = Math.min(pageEndOffset, maximumBytes);
		offset = Math.max(0, pageEndOffset - requestedBytes);
		buffer = await readExactly(handle, requestedBytes, offset);
		bytesRead = buffer.byteLength;
		if (offset > 0) {
			const previous = await readExactly(handle, 1, offset - 1);
			startsAtRecordBoundary = previous[0] === 0x0a;
		}
	} finally { await handle.close(); }
	let contentOffset = offset;
	if (offset > 0 && !startsAtRecordBoundary) {
		const newline = buffer.indexOf(0x0a);
		if (newline >= 0) {
			contentOffset += newline + 1;
			buffer = buffer.subarray(newline + 1);
		} else {
			contentOffset = pageEndOffset;
			buffer = Buffer.alloc(0);
		}
	}
	const allLines = [];
	let lineStart = 0;
	for (let index = 0; index <= buffer.length; index += 1) {
		if (index !== buffer.length && buffer[index] !== 0x0a) continue;
		if (index > lineStart) allLines.push({ startOffset: contentOffset + lineStart, bytes: buffer.subarray(lineStart, index) });
		lineStart = index + 1;
	}
	const recordsLimited = allLines.length > maximumRecords;
	const lines = allLines.slice(-maximumRecords);
	const startOffset = lines[0]?.startOffset ?? offset;
	const records = [];
	let parseErrors = 0;
	for (const line of lines) {
		if (line.bytes.byteLength > MAX_JSON_LINE_BYTES) { parseErrors += 1; continue; }
		try {
			const record = sanitizeTraceRecord(JSON.parse(line.bytes.toString("utf8")));
			if (record) records.push(record);
			else parseErrors += 1;
		} catch { parseErrors += 1; }
	}
	return {
		records,
		parseErrors,
		partial: startOffset > 0 || recordsLimited || bytesRead < requestedBytes,
		sizeBytes: visibleSize,
		modifiedAt: metadata.mtime.toISOString(),
		bytesRead,
		startOffset,
		endOffset: pageEndOffset,
	};
}

function traceIdForPath(root, path) {
	return createHash("sha256").update(relative(root, path)).digest("hex").slice(0, 24);
}

function encodeTraceCursor(offset) {
	return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeTraceCursor(value, maximum) {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,32}$/u.test(value)) return undefined;
	let decoded;
	try { decoded = Buffer.from(value, "base64url").toString("utf8"); }
	catch { return undefined; }
	if (!/^(?:0|[1-9][0-9]*)$/u.test(decoded)) return undefined;
	const offset = Number(decoded);
	return Number.isSafeInteger(offset) && offset > 0 && offset <= maximum ? offset : undefined;
}

function tracePageMetadata(loaded, snapshotSize) {
	const hasEarlier = loaded.startOffset > 0;
	const hasNewer = loaded.endOffset < snapshotSize;
	return {
		startOffset: loaded.startOffset,
		endOffset: loaded.endOffset,
		hasEarlier,
		hasNewer,
		lifecycleComplete: !hasEarlier && !hasNewer,
		...(hasEarlier ? { nextCursor: encodeTraceCursor(loaded.startOffset) } : {}),
	};
}

function sessionPathForTrace(path) {
	return resolve(dirname(dirname(path)), basename(path).replace(/\.trace\.jsonl$/u, ".jsonl"));
}

async function traceHasSessionFile(root, path) {
	const sessionPath = sessionPathForTrace(path);
	if (!containedBy(root, sessionPath)) return false;
	try {
		const metadata = await lstat(sessionPath);
		return metadata.isFile() && !metadata.isSymbolicLink();
	} catch { return false; }
}

function outcomeChains(candidates, spanById) {
	const candidateIds = new Set(candidates.map((record) => record.spanId));
	const propagatedSpanIds = new Set();
	const incidentIds = new Set();
	for (const candidate of candidates) {
		let incidentId = candidate.spanId;
		let parentSpanId = candidate.parentSpanId;
		let guard = 0;
		while (parentSpanId && guard < 64) {
			if (candidateIds.has(parentSpanId)) {
				propagatedSpanIds.add(parentSpanId);
				incidentId = parentSpanId;
			}
			parentSpanId = spanById.get(parentSpanId)?.parentSpanId;
			guard += 1;
		}
		incidentIds.add(incidentId);
	}
	return {
		propagatedSpanIds,
		rootSpans: candidates.filter((record) => !propagatedSpanIds.has(record.spanId)),
		incidentCount: incidentIds.size,
		propagatedIncidentCount: [...incidentIds].filter((spanId) => propagatedSpanIds.has(spanId)).length,
	};
}

export const STALE_OPEN_SPAN_MS = 5 * 60 * 1000;

export function formatDashboardMoney(input) {
	const value = Number.isFinite(Number(input)) ? Number(input) : 0;
	const digits = value !== 0 && Math.abs(value) < 1 ? 4 : 2;
	return `$${new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)}`;
}

export function formatDashboardCompact(input) {
	const value = Number.isFinite(Number(input)) ? Number(input) : 0;
	const absolute = Math.abs(value);
	const format = (scaled) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(scaled);
	if (absolute >= 999_500_000_000) return `${format(value / 1_000_000_000_000)}T`;
	if (absolute >= 999_500_000) return `${format(value / 1_000_000_000)}B`;
	if (absolute >= 999_500) return `${format(value / 1_000_000)}M`;
	if (absolute >= 999.5) return `${format(value / 1_000)}K`;
	return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
}

export function formatDashboardDuration(input) {
	const value = Math.max(0, Number.isFinite(Number(input)) ? Number(input) : 0);
	const format = (number) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(number);
	if (value < 1_000) return `${format(value)} ms`;
	const seconds = Math.round(value / 1_000);
	if (seconds < 60) return `${format(seconds)} s`;
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	const remainder = seconds % 60;
	const parts = [];
	if (days) parts.push(`${days}d`);
	if (hours) parts.push(`${hours}h`);
	if (minutes) parts.push(`${minutes}m`);
	if (remainder && !days) parts.push(`${remainder}s`);
	return parts.slice(0, 2).join(" ");
}

/**
 * Cost and tokens per *successful* operation, split by the dimensions that
 * actually change the bill.
 *
 * One `pi.agent.operation` span is one unit of work the user asked for. The
 * numerator deliberately includes spend from failed and unknown operations:
 * retries and dead ends are part of what a success costs. The denominator counts
 * only operations that ended `ok`.
 *
 * Honesty rules baked in here:
 * - A bucket whose operations did not all report a positive provider cost gets
 *   `costPerSuccessUsd: null`. Pi reports a $0 placeholder for some routes, and
 *   dividing by that would invent a number. Tokens per success stays available
 *   because token counts are reported even when pricing is not.
 * - When an operation mixed several providers, models, thinking levels or
 *   capability surfaces, the dimension becomes `mixed` rather than being
 *   attributed to whichever span happened to be last.
 * - `successCount === 0` yields `null`, never 0 or Infinity.
 */
export function summarizeEfficiency(records) {
	const spanById = new Map();
	for (const record of records) spanById.set(record.spanId, { ...spanById.get(record.spanId), ...record });
	const enclosingOperationId = (spanId) => {
		let current = spanId;
		for (let guard = 0; current && guard < 64; guard += 1) {
			const span = spanById.get(current);
			if (!span) return undefined;
			if (span.name === "pi.agent.operation") return current;
			current = span.parentSpanId;
		}
		return undefined;
	};
	const ends = records.filter((record) => record.kind === "span_end");
	const operations = ends.filter((record) => record.name === "pi.agent.operation");
	const byOperation = new Map(operations.map((record) => [record.spanId, { providers: [], tools: [] }]));
	for (const record of ends) {
		if (record.name !== "pi.ai.request" && record.name !== "pi.tool.execute") continue;
		const group = byOperation.get(enclosingOperationId(record.spanId));
		if (!group) continue;
		(record.name === "pi.ai.request" ? group.providers : group.tools).push(record);
	}
	const attribute = (record, name) => record.attributes?.[name];
	const numeric = (record, name) => typeof attribute(record, name) === "number" ? attribute(record, name) : 0;
	const single = (values) => {
		const distinct = [...new Set(values.filter((value) => typeof value === "string" && value))];
		return distinct.length === 1 ? distinct[0] : distinct.length === 0 ? "unknown" : "mixed";
	};
	const buckets = new Map();
	let truncated = false;
	for (const operation of operations) {
		const { providers, tools } = byOperation.get(operation.spanId) ?? { providers: [], tools: [] };
		const provider = single(providers.map((record) => attribute(record, "pi.ai.provider")));
		const model = single(providers.map((record) => attribute(record, "pi.ai.model")));
		const thinkingLevel = single(providers.map((record) => attribute(record, "pi.ai.thinking_level")));
		const route = provider === "mixed" || model === "mixed" ? "mixed" : dashboardRoute(provider, model);
		const capabilityGroups = single(providers.map((record) => {
			const groups = attribute(record, "pi.tools.deferred_groups");
			return Array.isArray(groups) ? (groups.length ? [...groups].sort().join("+") : "none") : undefined;
		}));
		const subagentUsed = tools.some((record) => attribute(record, "pi.tool.capability_group") === "subagent");
		const key = JSON.stringify([provider, model, route, thinkingLevel, capabilityGroups, subagentUsed]);
		let bucket = buckets.get(key);
		if (!bucket) {
			if (buckets.size >= MAX_EFFICIENCY_BUCKETS) { truncated = true; continue; }
			bucket = {
				key, provider, model, route, thinkingLevel, capabilityGroups, subagentUsed,
				operationCount: 0, successCount: 0, errorCount: 0, abortedCount: 0, unknownCount: 0,
				totalTokens: 0, costUsd: 0, costReportedOperationCount: 0,
				faultHarness: 0, faultModel: 0, faultEnvironment: 0, faultUnknown: 0,
				toolIncomplete: 0, toolUnverified: 0,
			};
			buckets.set(key, bucket);
		}
		bucket.operationCount += 1;
		if (operation.status === "ok") bucket.successCount += 1;
		else if (operation.status === "error") bucket.errorCount += 1;
		else if (operation.status === "aborted") bucket.abortedCount += 1;
		else bucket.unknownCount += 1;
		const costUsd = providers.reduce((sum, record) => sum + numeric(record, "pi.usage.cost"), 0);
		bucket.totalTokens += providers.reduce((sum, record) => sum + numeric(record, "pi.usage.total_tokens"), 0);
		bucket.costUsd += costUsd;
		if (costUsd > 0) bucket.costReportedOperationCount += 1;
		for (const tool of tools) {
			const side = attribute(tool, "pi.tool.fault_side");
			if (side === "harness") bucket.faultHarness += 1;
			else if (side === "model") bucket.faultModel += 1;
			else if (side === "environment") bucket.faultEnvironment += 1;
			else if (side === "unknown") bucket.faultUnknown += 1;
			// The two flavours of tool-level unknown point at opposite fixes:
			// `incomplete` never finished recording (lifecycle / infrastructure);
			// `unknown_outcome` ran but its effect is unverified (model / prompt).
			const outcome = attribute(tool, "pi.tool.outcome");
			if (outcome === "incomplete") bucket.toolIncomplete += 1;
			else if (outcome === "unknown_outcome") bucket.toolUnverified += 1;
		}
	}
	return { buckets: [...buckets.values()], truncated };
}

/** Derived rates for one merged bucket. `null` means not provable, never 0. */
export function efficiencyRates(bucket) {
	const successCount = Number(bucket?.successCount) || 0;
	const operationCount = Number(bucket?.operationCount) || 0;
	const costReported = Number(bucket?.costReportedOperationCount) || 0;
	// Requiring every operation to have reported a cost keeps a partially priced
	// bucket from looking cheap.
	const pricingComplete = operationCount > 0 && costReported === operationCount;
	return {
		tokensPerSuccess: successCount > 0 ? (Number(bucket?.totalTokens) || 0) / successCount : null,
		costPerSuccessUsd: successCount > 0 && pricingComplete ? (Number(bucket?.costUsd) || 0) / successCount : null,
		successRate: operationCount > 0 ? successCount / operationCount : null,
		pricingComplete,
		pricingReason: pricingComplete ? "reported" : costReported === 0 ? "not-reported" : "partially-reported",
	};
}

export function mergeEfficiencyBuckets(groups) {
	const merged = new Map();
	let truncated = false;
	for (const group of groups ?? []) {
		if (group?.truncated) truncated = true;
		for (const bucket of group?.buckets ?? []) {
			const existing = merged.get(bucket.key);
			if (!existing) {
				if (merged.size >= MAX_EFFICIENCY_BUCKETS) { truncated = true; continue; }
				merged.set(bucket.key, { ...bucket });
				continue;
			}
			for (const field of ["operationCount", "successCount", "errorCount", "abortedCount", "unknownCount",
				"totalTokens", "costUsd", "costReportedOperationCount", "faultHarness", "faultModel",
				"faultEnvironment", "faultUnknown", "toolIncomplete", "toolUnverified"]) {
				existing[field] = (Number(existing[field]) || 0) + (Number(bucket[field]) || 0);
			}
		}
	}
	const buckets = [...merged.values()]
		.map((bucket) => ({ ...bucket, ...efficiencyRates(bucket) }))
		.sort((left, right) => right.operationCount - left.operationCount || (left.key < right.key ? -1 : 1));
	return { buckets, truncated };
}

export function summarizeTrace(root, path, loaded, now = Date.now()) {
	const starts = loaded.records.filter((record) => record.kind === "span_start");
	const ends = loaded.records.filter((record) => record.kind === "span_end");
	const spanById = new Map();
	for (const record of loaded.records) spanById.set(record.spanId, { ...spanById.get(record.spanId), ...record });
	const latestActivityBySpanId = new Map();
	for (const record of loaded.records) {
		const activityAt = Date.parse(record.timestamp);
		if (!Number.isFinite(activityAt)) continue;
		let spanId = record.spanId;
		let guard = 0;
		while (spanId && guard < 64) {
			latestActivityBySpanId.set(spanId, Math.max(latestActivityBySpanId.get(spanId) ?? -Infinity, activityAt));
			spanId = spanById.get(spanId)?.parentSpanId;
			guard += 1;
		}
	}
	const endedSpanIds = new Set(ends.map((record) => record.spanId));
	const openSpans = starts.filter((record) => !endedSpanIds.has(record.spanId));
	const runtimeOpenSpans = openSpans.filter((record) => record.name === "pi.session.runtime");
	const activeOpenSpans = openSpans.filter((record) => record.name !== "pi.session.runtime");
	const staleCandidates = activeOpenSpans.filter((record) => {
		const latestActivityAt = latestActivityBySpanId.get(record.spanId) ?? Date.parse(record.timestamp);
		return Number.isFinite(latestActivityAt) && now - latestActivityAt >= STALE_OPEN_SPAN_MS;
	});
	const staleOutcome = outcomeChains(staleCandidates, spanById);
	const propagatedStaleSpanIds = staleOutcome.propagatedSpanIds;
	const staleOpenSpans = staleOutcome.rootSpans;
	const providers = ends.filter((record) => record.name === "pi.ai.request");
	const operations = ends.filter((record) => record.name === "pi.agent.operation");
	const openOperationCount = activeOpenSpans.filter((record) => record.name === "pi.agent.operation").length;
	const tools = ends.filter((record) => record.name === "pi.tool.execute");
	const compactions = ends.filter((record) => record.name === "pi.session.compaction");
	const startupSpans = ends.filter((record) => record.name === "pi.ai.startup");
	const prefillSpans = ends.filter((record) => record.name === "pi.ai.prefill");
	const reasoningSpans = ends.filter((record) => record.name === "pi.ai.reasoning");
	const generationSpans = ends.filter((record) => record.name === "pi.ai.generation");
	const errorSpans = ends.filter((record) => record.status === "error");
	const errorOutcome = outcomeChains(errorSpans, spanById);
	const propagatedErrorSpanIds = errorOutcome.propagatedSpanIds;
	const rootErrorSpans = errorOutcome.rootSpans;
	const latestProviderSuccessAt = Math.max(-Infinity, ...providers
		.filter((record) => record.status === "ok")
		.map((record) => Date.parse(record.timestamp))
		.filter(Number.isFinite));
	const recoveredErrorSpans = rootErrorSpans.filter((record) => latestProviderSuccessAt > Date.parse(record.timestamp));
	const unresolvedErrorCount = rootErrorSpans.length - recoveredErrorSpans.length;
	const abortedSpans = ends.filter((record) => record.status === "aborted");
	const abortedOutcome = outcomeChains(abortedSpans, spanById);
	const abortedCount = abortedOutcome.incidentCount;
	const unknownCount = ends.filter((record) => record.status === "unknown").length;
	const timestamps = loaded.records.map((record) => Date.parse(record.timestamp)).filter(Number.isFinite);
	const observedWindowDurationMs = timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
	const operationDurationMs = operations.length > 0 ? operations.reduce((sum, record) => sum + (record.durationMs ?? 0), 0) : null;
	const wallTimeMode = openOperationCount > 0 || operations.length === 0 ? (observedWindowDurationMs > 0 ? "observed-window" : "unavailable") : "operation-sum";
	const wallTimeMs = wallTimeMode === "observed-window" ? observedWindowDurationMs : wallTimeMode === "operation-sum" ? operationDurationMs : null;
	const numberAttribute = (record, name) => typeof record.attributes?.[name] === "number" ? record.attributes[name] : 0;
	const optionalNumberAttribute = (record, name) => typeof record?.attributes?.[name] === "number" ? record.attributes[name] : null;
	const usageTotal = (name) => providers.reduce((sum, record) => sum + numberAttribute(record, name), 0);
	const durationTotal = (records) => records.reduce((sum, record) => sum + (record.durationMs ?? 0), 0);
	const optionalDurationTotal = (records) => records.length > 0 ? durationTotal(records) : null;
	const inputTokens = usageTotal("pi.usage.input_tokens");
	const outputTokens = usageTotal("pi.usage.output_tokens");
	const reasoningTokens = providers.some((record) => optionalNumberAttribute(record, "pi.usage.reasoning_tokens") !== null)
		? usageTotal("pi.usage.reasoning_tokens")
		: null;
	const startupDurationMs = optionalDurationTotal(startupSpans);
	const prefillDurationMs = optionalDurationTotal(prefillSpans);
	const reasoningDurationMs = optionalDurationTotal(reasoningSpans);
	const generationDurationMs = optionalDurationTotal(generationSpans);
	const firstContentProviders = providers.filter((record) => optionalNumberAttribute(record, "pi.ai.stream.time_to_first_content_ms") !== null);
	const firstContentDurationMs = firstContentProviders.length > 0
		? firstContentProviders.reduce((sum, record) => sum + numberAttribute(record, "pi.ai.stream.time_to_first_content_ms"), 0)
		: null;
	const generatedDurationMs = (reasoningDurationMs ?? 0) + (generationDurationMs ?? 0);
	const latestContextProvider = [...providers].reverse().find((record) => optionalNumberAttribute(record, "pi.context.window_tokens") !== null);
	const contextTokens = optionalNumberAttribute(latestContextProvider, "pi.context.tokens");
	const contextWindowTokens = optionalNumberAttribute(latestContextProvider, "pi.context.window_tokens");
	const contextPercent = optionalNumberAttribute(latestContextProvider, "pi.context.percent");
	return {
		id: traceIdForPath(root, path),
		path: relative(root, path),
		modifiedAt: loaded.modifiedAt,
		sizeBytes: loaded.sizeBytes,
		partial: loaded.partial,
		orphan: loaded.orphan === true,
		parseErrors: loaded.parseErrors,
		recordsLoaded: loaded.records.length,
		windowBytes: loaded.bytesRead,
		spanCount: new Set([...starts, ...ends].map((record) => record.spanId)).size,
		errorCount: errorSpans.length,
		rootErrorCount: rootErrorSpans.length,
		recoveredErrorCount: recoveredErrorSpans.length,
		unresolvedErrorCount,
		propagatedErrorCount: errorOutcome.propagatedIncidentCount,
		propagatedErrorSpanCount: propagatedErrorSpanIds.size,
		abortedCount,
		abortedSpanCount: abortedSpans.length,
		propagatedAbortedSpanCount: abortedOutcome.propagatedSpanIds.size,
		unknownCount,
		openCount: activeOpenSpans.length,
		runtimeOpenCount: runtimeOpenSpans.length,
		staleOpenCount: staleOpenSpans.length,
		propagatedStaleOpenCount: propagatedStaleSpanIds.size,
		anomalyCount: unresolvedErrorCount + unknownCount + staleOpenSpans.length,
		providerCount: providers.length,
		toolCount: tools.length,
		toolDurationMs: durationTotal(tools),
		toolResultEstimatedTokens: tools.some((record) => optionalNumberAttribute(record, "pi.tool.result_estimated_tokens") !== null)
			? tools.reduce((sum, record) => sum + numberAttribute(record, "pi.tool.result_estimated_tokens"), 0)
			: null,
		operationCount: operations.length,
		averageOperationDurationMs: operations.length > 0 ? operationDurationMs / operations.length : null,
		compactionCount: compactions.length,
		compactionDurationMs: durationTotal(compactions),
		openOperationCount,
		observedWindowDurationMs,
		wallTimeMode,
		wallTimeMs,
		inputTokens,
		outputTokens,
		reasoningTokens,
		cacheReadTokens: usageTotal("pi.usage.cache_read_tokens"),
		cacheWriteTokens: usageTotal("pi.usage.cache_write_tokens"),
		totalTokens: usageTotal("pi.usage.total_tokens"),
		estimatedCostUsd: usageTotal("pi.usage.cost"),
		contextTokens,
		contextWindowTokens,
		contextPercent,
		startupDurationMs,
		prefillDurationMs,
		reasoningDurationMs,
		generationDurationMs,
		firstContentDurationMs,
		promptTokensPerSecond: firstContentDurationMs !== null && firstContentDurationMs > 0 ? inputTokens * 1_000 / firstContentDurationMs : null,
		generationTokensPerSecond: generatedDurationMs > 0 ? outputTokens * 1_000 / generatedDurationMs : null,
		operationDurationMs,
		efficiency: summarizeEfficiency(loaded.records),
	};
}

export function summarizeFleet(traces, scanLimited = false) {
	const list = Array.isArray(traces) ? traces : [];
	const sessionTraces = list.filter((trace) => trace?.orphan !== true);
	const total = (name) => sessionTraces.reduce((sum, trace) => sum + (Number(trace?.[name]) || 0), 0);
	const errorCount = total("errorCount");
	const rootErrorCount = total("rootErrorCount");
	const recoveredErrorCount = total("recoveredErrorCount");
	const unresolvedErrorCount = total("unresolvedErrorCount");
	const propagatedErrorCount = total("propagatedErrorCount");
	const propagatedErrorSpanCount = total("propagatedErrorSpanCount");
	const unknownCount = total("unknownCount");
	const staleCount = total("staleOpenCount");
	const abortedCount = total("abortedCount");
	const abortedSpanCount = total("abortedSpanCount");
	const partialCount = sessionTraces.reduce((sum, trace) => sum + (trace?.partial ? 1 : 0), 0);
	const rejectedCount = total("parseErrors");
	const orphanCount = list.length - sessionTraces.length;
	const aggregateLimited = Boolean(scanLimited || partialCount || rejectedCount);
	let healthLevel = "nominal";
	let healthHeadline = "NOMINAL";
	if (unresolvedErrorCount) { healthLevel = "bad"; healthHeadline = `${unresolvedErrorCount} UNRESOLVED`; }
	else if (unknownCount) { healthLevel = "warn"; healthHeadline = `${unknownCount} UNKNOWN`; }
	else if (staleCount) { healthLevel = "warn"; healthHeadline = `${staleCount} STALE`; }
	else if (abortedCount) { healthLevel = "warn"; healthHeadline = `${abortedCount} ABORTED`; }
	else if (recoveredErrorCount) { healthLevel = "warn"; healthHeadline = `${recoveredErrorCount} RECOVERED`; }
	let coverageLevel = "nominal";
	let coverageHeadline = "COMPLETE";
	if (rejectedCount) { coverageLevel = "warn"; coverageHeadline = `${rejectedCount} REJECTED`; }
	else if (scanLimited) { coverageLevel = "warn"; coverageHeadline = "SCAN LIMITED"; }
	else if (partialCount) { coverageLevel = "warn"; coverageHeadline = `${partialCount} BOUNDED`; }
	return {
		scanLimited: Boolean(scanLimited),
		aggregateLimited,
		healthLevel,
		healthHeadline,
		coverageLevel,
		coverageHeadline,
		traceCount: list.length,
		sessionTraceCount: sessionTraces.length,
		orphanCount,
		errorCount,
		rootErrorCount,
		recoveredErrorCount,
		unresolvedErrorCount,
		propagatedErrorCount,
		propagatedErrorSpanCount,
		unknownCount,
		staleCount,
		abortedCount,
		abortedSpanCount,
		partialCount,
		rejectedCount,
		providerCount: total("providerCount"),
		inputTokens: total("inputTokens"),
		outputTokens: total("outputTokens"),
		reasoningTokens: total("reasoningTokens"),
		toolResultEstimatedTokens: total("toolResultEstimatedTokens"),
		cacheReadTokens: total("cacheReadTokens"),
		cacheWriteTokens: total("cacheWriteTokens"),
		totalTokens: total("totalTokens"),
		estimatedCostUsd: total("estimatedCostUsd"),
		// Per-dimension cost of a success. Bounded by page/scan limits like every
		// other aggregate here, so `truncated` must stay visible to the reader.
		efficiency: mergeEfficiencyBuckets(sessionTraces.map((trace) => trace?.efficiency)),
	};
}

export async function scanTraceFiles(root) {
	const canonical = await canonicalTraceRoot(root);
	if (canonical.missing) return { root: canonical.root, traces: [], scanLimited: false, bytesRead: 0 };
	const absoluteRoot = canonical.root;
	const collected = await collectTracePaths(absoluteRoot);
	const traces = [];
	let bytesRead = 0;
	let budgetLimited = false;
	for (const path of collected.paths) {
		const remaining = MAX_TOTAL_SUMMARY_BYTES - bytesRead;
		if (remaining <= 0) { budgetLimited = true; break; }
		try {
			const loaded = await readTraceTail(absoluteRoot, path, Math.min(MAX_SUMMARY_TRACE_BYTES, remaining), MAX_API_RECORDS);
			loaded.orphan = !(await traceHasSessionFile(absoluteRoot, path));
			bytesRead += loaded.bytesRead;
			traces.push({ summary: summarizeTrace(absoluteRoot, path, loaded), path });
		} catch { /* changing or unreadable trace: omit this refresh */ }
	}
	traces.sort((left, right) => right.summary.modifiedAt.localeCompare(left.summary.modifiedAt));
	return { root: absoluteRoot, traces, scanLimited: collected.scanLimited || budgetLimited, bytesRead };
}

function authorized(request, token) {
	const value = request.headers.authorization;
	if (typeof value !== "string" || !value.startsWith("Bearer ")) return false;
	const provided = Buffer.from(value.slice("Bearer ".length));
	const expected = Buffer.from(token);
	return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function dashboardHtml(nonce) {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rotom Trace Dashboard</title>
<style nonce="${nonce}">
:root{color-scheme:dark;--ink:#090c0d;--surface:#0e1213;--raised:#14191a;--hover:#192021;--line:#273031;--line-soft:#1b2223;--text:#e7edeb;--muted:#85918e;--faint:#56615e;--signal:#c8f06a;--cyan:#65d9ed;--amber:#f4b95f;--red:#f06a72;--purple:#aa91f7;--mono:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;--sans:-apple-system,"SF Pro Text","PingFang SC","Noto Sans SC",sans-serif;--display:-apple-system,"SF Pro Display","PingFang SC",sans-serif}*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--ink);color:var(--text);font:13px/1.55 var(--sans);letter-spacing:.005em;overflow:hidden}body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.16;background-image:linear-gradient(var(--line-soft) 1px,transparent 1px),linear-gradient(90deg,var(--line-soft) 1px,transparent 1px);background-size:48px 48px;mask-image:linear-gradient(to bottom,black,transparent 70%)}button,input,select{font:inherit;color:inherit}button{cursor:pointer}.app-shell{height:100%;display:grid;grid-template-rows:64px auto minmax(0,1fr) 30px;position:relative}.topbar{display:flex;align-items:center;gap:18px;padding:0 22px;border-bottom:1px solid var(--line);background:rgba(9,12,13,.94);backdrop-filter:blur(18px);z-index:4}.brand{display:flex;align-items:center;gap:11px;min-width:260px}.brand-mark{width:28px;height:28px;display:grid;place-items:center;border:1px solid var(--signal);color:var(--signal);font:700 11px var(--mono);box-shadow:inset 0 0 0 3px var(--ink)}.brand-copy{display:grid;line-height:1.05}.brand-copy strong{font:650 14px var(--display);letter-spacing:.08em}.brand-copy span{color:var(--muted);font:10px var(--mono);letter-spacing:.16em;margin-top:5px}.top-context{display:flex;align-items:center;gap:8px;color:var(--muted);font:11px var(--mono);min-width:0}.local-dot{width:6px;height:6px;background:var(--signal);box-shadow:0 0 12px rgba(200,240,106,.7)}.top-actions{margin-left:auto;display:flex;align-items:center;gap:8px}.key-hint{color:var(--faint);font:10px var(--mono);border:1px solid var(--line);padding:2px 5px}.refresh-button{display:flex;align-items:center;gap:8px;border:1px solid var(--line);background:var(--raised);padding:8px 12px;border-radius:3px}.refresh-button:hover,.refresh-button:focus-visible{border-color:var(--signal);outline:none}.refresh-icon{font:16px var(--mono);transition:transform .3s}.is-loading .refresh-icon{animation:spin .8s linear infinite}.signal-strip{display:grid;grid-template-columns:minmax(300px,1.35fr) repeat(4,minmax(150px,1fr));padding:0 22px;background:var(--surface);border-bottom:1px solid var(--line);overflow-x:auto}.signal-cell{display:flex;align-items:center;gap:12px;padding:9px 18px;border-left:1px solid var(--line-soft);min-width:0}.signal-cell:first-child{border-left:0;padding-left:0}.signal-cell .value{min-width:0;font:600 22px/1 var(--mono);letter-spacing:-.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.signal-cell .copy{display:grid;gap:3px;min-width:0}.signal-cell .label{color:var(--muted);font:10px/1.2 var(--mono);letter-spacing:.13em;text-transform:uppercase}.signal-cell .sub{color:var(--faint);font:11px/1.25 var(--sans)}.signal-cell.health .value{font:650 13px/1 var(--display);letter-spacing:.04em}.health-state{display:flex;align-items:center;gap:10px;min-height:18px;min-width:0}.health-state.bad .value{color:var(--red)}.health-state.warn .value{color:var(--amber)}.health-orb{width:10px;height:10px;flex:0 0 auto;border:2px solid var(--signal);box-shadow:0 0 16px rgba(200,240,106,.35)}.health-orb.warn{border-color:var(--amber);box-shadow:0 0 16px rgba(244,185,95,.32)}.health-orb.bad{border-color:var(--red);box-shadow:0 0 16px rgba(240,106,114,.35)}.health-breakdown{display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden}.health-chip{padding:1px 5px;border:1px solid var(--line-soft);font:9px/1.35 var(--mono);white-space:nowrap}.health-chip.bad{color:var(--red);border-color:rgba(240,106,114,.28)}.health-chip.warn{color:var(--amber);border-color:rgba(244,185,95,.25)}.health-chip.info{color:var(--cyan);border-color:rgba(101,217,237,.25)}.workspace{display:grid;grid-template-columns:clamp(320px,22vw,420px) minmax(0,1fr);min-height:0}.session-panel{display:grid;grid-template-rows:auto auto minmax(0,1fr);border-right:1px solid var(--line);background:rgba(14,18,19,.96);min-width:0;min-height:0;overflow:hidden}.panel-heading{display:flex;align-items:flex-end;justify-content:space-between;padding:18px 16px 12px}.panel-heading h2{margin:0;font:620 12px var(--display);letter-spacing:.11em;text-transform:uppercase}.panel-controls{display:flex;align-items:center;gap:8px}.panel-heading span{color:var(--faint);font:10px var(--mono)}.orphan-toggle{border:1px solid var(--line-soft);background:var(--ink);padding:3px 6px;border-radius:2px;color:var(--muted);font:9px var(--mono)}.orphan-toggle[aria-pressed="true"]{color:var(--cyan);border-color:rgba(101,217,237,.35)}.orphan-toggle:disabled{cursor:default;opacity:.45}.orphan-toggle:focus-visible{outline:1px solid var(--cyan);outline-offset:-1px}.search-wrap{position:relative;margin:0 12px 10px}.search-wrap:before{content:"/";position:absolute;left:10px;top:8px;color:var(--faint);font:12px var(--mono)}.search-input,.span-search,.family-select{width:100%;border:1px solid var(--line-soft);background:var(--ink);border-radius:2px;padding:8px 10px;color:var(--text);outline:none}.search-input{padding-left:25px}.search-input:focus,.span-search:focus,.family-select:focus{border-color:var(--cyan)}.trace-list{min-height:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:0 8px 14px;scrollbar-width:thin;scrollbar-color:var(--line) transparent}.trace-list::-webkit-scrollbar{width:8px}.trace-list::-webkit-scrollbar-track{background:transparent}.trace-list::-webkit-scrollbar-thumb{background:var(--line);border:2px solid var(--surface);border-radius:8px}.trace-list::-webkit-scrollbar-thumb:hover{background:var(--muted)}.trace-item{position:relative;width:100%;display:grid;grid-template-columns:3px minmax(0,1fr);gap:10px;text-align:left;border:0;background:transparent;padding:9px 7px;border-radius:2px}.trace-item:before{content:"";background:var(--line);width:3px}.trace-item:hover{background:var(--hover)}.trace-item:focus-visible{outline:1px solid var(--cyan);outline-offset:-1px}.trace-item.active{background:#172022}.trace-item.active:before{background:var(--signal);box-shadow:0 0 10px rgba(200,240,106,.3)}.trace-main{min-width:0}.trace-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:550 12px var(--mono)}.trace-meta{display:flex;align-items:center;gap:4px 9px;flex-wrap:wrap;margin-top:6px;color:var(--faint);font:10px var(--mono)}.trace-meta span{white-space:nowrap}.trace-meta .anomaly{color:var(--red)}.trace-meta .recovered{color:var(--amber)}.trace-meta .coverage{color:var(--cyan)}.trace-meta .orphan{color:var(--muted);border:1px solid var(--line-soft);padding:0 3px}.trace-stage{min-width:0;min-height:0;overflow:auto;background:rgba(9,12,13,.84)}.empty-state{height:100%;display:grid;place-items:center;color:var(--muted);text-align:center}.empty-state strong{display:block;color:var(--text);font:600 15px var(--display);margin-bottom:5px}.empty-glyph{width:46px;height:46px;margin:0 auto 14px;border:1px solid var(--line);display:grid;place-items:center;color:var(--signal);font:15px var(--mono)}.trace-view{min-height:100%;display:grid;grid-template-rows:auto auto minmax(360px,1fr)}.trace-hero{padding:20px 24px 16px;border-bottom:1px solid var(--line-soft);background:linear-gradient(110deg,rgba(20,25,26,.95),rgba(9,12,13,.78))}.trace-kicker{color:var(--signal);font:10px var(--mono);letter-spacing:.16em;text-transform:uppercase}.trace-title{display:flex;align-items:flex-start;gap:14px;margin-top:8px;min-width:0}.trace-title h1{min-width:0;margin:0;font:620 clamp(16px,1.6vw,23px)/1.25 var(--display);letter-spacing:-.018em;overflow-wrap:anywhere}.trace-status{flex:0 0 auto;margin-top:3px;padding:4px 7px;border:1px solid var(--line);color:var(--muted);font:10px var(--mono);text-transform:uppercase}.trace-status.bad{border-color:rgba(240,106,114,.5);color:var(--red)}.trace-status.warn{border-color:rgba(244,185,95,.45);color:var(--amber)}.trace-caption{display:grid;grid-template-columns:minmax(160px,1fr) auto auto auto auto;align-items:center;gap:8px 18px;margin-top:11px;color:var(--muted);font:11px var(--mono)}.trace-caption span{display:flex;gap:6px;white-space:nowrap}.trace-caption .trace-path{min-width:0;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.trace-metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:1px;background:var(--line-soft);border-bottom:1px solid var(--line)}.trace-metric{min-width:0;padding:12px 16px;background:rgba(9,12,13,.96)}.trace-metric .m-label{display:block;color:var(--faint);font:9px var(--mono);text-transform:uppercase;letter-spacing:.12em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.trace-metric .m-value{display:block;margin-top:5px;font:560 clamp(14px,1.2vw,17px)/1.2 var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.trace-metric.active .m-value{color:var(--cyan)}.trace-metric.warning .m-value{color:var(--amber)}.trace-metric.danger .m-value{color:var(--red)}.trace-body{display:grid;grid-template-columns:minmax(560px,1fr) clamp(300px,22vw,380px);min-height:0}.timeline-pane{min-width:0;border-right:1px solid var(--line);display:grid;grid-template-rows:auto auto minmax(0,1fr)}.toolbar{display:grid;grid-template-columns:minmax(180px,1fr) 128px auto auto;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line-soft);background:var(--surface)}.family-select{appearance:none}.status-tabs,.page-nav{display:flex;gap:2px}.status-tab,.page-button{border:1px solid var(--line-soft);background:var(--ink);padding:7px 9px;color:var(--muted);border-radius:2px}.status-tab.active{color:var(--signal);border-color:rgba(200,240,106,.45);background:rgba(200,240,106,.06)}.page-button:disabled{cursor:not-allowed;color:var(--faint);opacity:.45}.page-index{display:grid;place-items:center;min-width:58px;padding:0 7px;color:var(--cyan);font:10px var(--mono);white-space:nowrap}.status-tab:focus-visible,.page-button:focus-visible,.span-row:focus-visible{outline:1px solid var(--cyan);outline-offset:-1px}.timeline-scale{display:grid;grid-template-columns:minmax(220px,300px) minmax(220px,1fr) 82px;padding:7px 14px;border-bottom:1px solid var(--line-soft);color:var(--faint);font:9px var(--mono);letter-spacing:.08em;text-transform:uppercase}.scale-track{display:flex;justify-content:space-between;padding:0 5px}.span-list{overflow:auto}.span-row{width:100%;display:grid;grid-template-columns:minmax(220px,300px) minmax(220px,1fr) 82px;align-items:center;min-height:38px;padding:0 14px;border:0;border-bottom:1px solid var(--line-soft);background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer;transition:background .14s}.span-row:hover{background:var(--hover)}.span-row.selected{background:#172022;box-shadow:inset 2px 0 var(--signal)}.span-identity{display:flex;align-items:center;gap:8px;min-width:0;padding-left:calc(var(--depth,0)*12px)}.span-dot{width:6px;height:6px;background:var(--cyan);flex:0 0 auto}.span-dot.tool{background:var(--purple)}.span-dot.agent{background:var(--signal)}.span-dot.session{background:var(--amber)}.span-dot.startup{background:var(--muted)}.span-dot.prefill{background:#32a9e8}.span-dot.reasoning{background:#2fcf9f}.span-dot.generation{background:#66df83}.span-dot.bad{background:var(--red);box-shadow:0 0 8px rgba(240,106,114,.35)}.span-dot.recovered,.span-dot.warn{background:var(--amber);box-shadow:0 0 8px rgba(244,185,95,.28)}.span-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px var(--mono)}.span-track{position:relative;height:18px;background-image:linear-gradient(90deg,var(--line-soft) 1px,transparent 1px);background-size:25% 100%;border-left:1px solid var(--line-soft);border-right:1px solid var(--line-soft)}.span-bar{position:absolute;top:6px;height:6px;min-width:2px;background:var(--cyan);left:var(--start);width:var(--width)}.span-bar.tool{background:var(--purple)}.span-bar.agent{background:var(--signal)}.span-bar.session{background:var(--amber)}.span-bar.startup{background:var(--muted)}.span-bar.prefill{background:#32a9e8}.span-bar.reasoning{background:#2fcf9f}.span-bar.generation{background:#66df83}.span-bar.bad{background:var(--red)}.span-bar.recovered,.span-bar.warn{background:var(--amber)}.span-duration{text-align:right;color:var(--muted);font:10px var(--mono)}.inspector{overflow:auto;background:var(--surface)}.inspector-head{padding:17px;border-bottom:1px solid var(--line)}.inspector-label{color:var(--faint);font:9px var(--mono);letter-spacing:.14em;text-transform:uppercase}.inspector-name{margin-top:7px;font:600 13px var(--mono);overflow-wrap:anywhere}.inspector-grid{display:grid;grid-template-columns:82px 1fr;gap:8px 10px;padding:14px 17px;border-bottom:1px solid var(--line-soft);font:11px var(--mono)}.inspector-grid dt{color:var(--faint)}.inspector-grid dd{margin:0;color:var(--text);overflow-wrap:anywhere}.inspector-grid .bad{color:var(--red)}.inspector-grid .warn{color:var(--amber)}.attribute-list{padding:13px 17px}.attribute-row{display:grid;grid-template-columns:minmax(90px,.8fr) minmax(0,1.2fr);gap:10px;padding:8px 0;border-bottom:1px solid var(--line-soft);font:10px var(--mono)}.attribute-key{color:var(--muted);overflow-wrap:anywhere}.attribute-value{color:var(--text);text-align:right;overflow-wrap:anywhere}.app-footer{display:flex;align-items:center;gap:14px;padding:0 22px;border-top:1px solid var(--line);background:var(--surface);color:var(--faint);font:9px var(--mono);letter-spacing:.04em}.app-footer .root-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.app-footer .security{margin-left:auto;color:var(--muted)}.signal-region{min-width:0}.efficiency-strip{background:var(--surface);border-bottom:1px solid var(--line);padding:11px 22px 13px;overflow-x:auto}.eff-head{display:flex;align-items:baseline;gap:10px;margin-bottom:7px}.eff-head h2{margin:0;font:620 11px var(--display);letter-spacing:.11em;text-transform:uppercase}.eff-head .eff-note{color:var(--faint);font:10px var(--mono)}.eff-head .eff-note.warn{color:var(--amber)}.eff-table{width:100%;border-collapse:collapse;font:11px var(--mono)}.eff-table th{text-align:left;color:var(--faint);font:9px var(--mono);letter-spacing:.09em;text-transform:uppercase;padding:3px 10px 6px;border-bottom:1px solid var(--line-soft);white-space:nowrap}.eff-table td{padding:5px 10px;border-bottom:1px solid var(--line-soft);white-space:nowrap;color:var(--text)}.eff-table tr:last-child td{border-bottom:0}.eff-table td.num{text-align:right}.eff-na{color:var(--faint)}.eff-yes{color:var(--cyan)}.eff-empty{color:var(--muted);font:11px var(--mono);padding:6px 0}.skeleton{background:linear-gradient(90deg,var(--raised),var(--hover),var(--raised));background-size:200% 100%;animation:shimmer 1.3s infinite}.fade-in{animation:reveal .24s ease-out both}@keyframes spin{to{transform:rotate(360deg)}}@keyframes shimmer{to{background-position:-200% 0}}@keyframes reveal{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}@media(max-width:1120px){.trace-body{grid-template-columns:1fr}.inspector{border-top:1px solid var(--line);max-height:300px}.timeline-pane{border-right:0}.trace-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:960px) and (min-width:761px){.app-shell{grid-template-rows:64px auto minmax(0,1fr) 30px}.signal-strip{grid-template-columns:minmax(260px,1.25fr) repeat(2,minmax(150px,1fr));overflow:visible}.signal-cell{border-bottom:1px solid var(--line-soft)}.signal-cell.health{grid-row:span 2}}@media(max-width:760px){body{overflow:auto}.app-shell{height:auto;min-height:100%;grid-template-rows:60px auto auto 30px}.top-context,.key-hint{display:none}.signal-strip{grid-template-columns:repeat(2,minmax(0,1fr));padding:0 14px;overflow:visible}.signal-cell{border-bottom:1px solid var(--line-soft)}.signal-cell:nth-child(even){border-left:0}.signal-cell:first-child{padding-left:18px}.signal-cell.health{grid-column:1/-1;grid-row:auto}.workspace{grid-template-columns:1fr}.session-panel{border-right:0;border-bottom:1px solid var(--line);max-height:330px}.trace-stage{min-width:0;overflow:hidden}.trace-view,.trace-body{min-width:0}.trace-body{grid-template-columns:minmax(0,1fr)}.timeline-pane{min-width:0;overflow-x:auto}.toolbar{grid-template-columns:1fr;position:sticky;left:0}.timeline-scale,.span-row{min-width:640px}.trace-hero{padding:18px 16px}.trace-caption{grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 12px}.trace-caption .trace-path{grid-column:1/-1}.trace-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.app-footer{padding:0 14px}.security{display:none}}
/* V3 session telemetry shell — keeps the detailed span inspector as a switchable view. */
body{background:#090a0a;font-family:var(--mono);letter-spacing:0}body:before{display:none}.app-shell{grid-template-rows:58px 78px minmax(0,1fr) 28px;background:#101112}.topbar{padding:0 20px;background:#101112;border-color:#424744}.brand{min-width:auto}.brand-mark{border-color:#f1f2ef;color:#f1f2ef;box-shadow:none}.brand-copy strong{font-family:var(--mono);font-size:13px}.brand-copy span{font-family:var(--mono);font-size:9px}.top-context{margin-left:12px}.local-dot{border:2px solid #2fd39d;background:transparent;border-radius:50%;box-shadow:0 0 12px rgba(47,211,157,.35)}.top-actions{gap:12px}.view-switch{display:flex;padding:3px;border:1px solid #424744;background:#0d0e0f}.view-button{border:0;background:transparent;color:#a1a6a4;padding:7px 13px;font:10px var(--mono);letter-spacing:.05em}.view-button.active{background:#ecefed;color:#111;font-weight:700}.view-button:focus-visible{outline:1px solid #2eb4ed;outline-offset:-1px}.refresh-button{border-color:#424744;background:transparent;border-radius:0;font:10px var(--mono)}.key-hint{display:none}.signal-strip{grid-template-columns:1.25fr repeat(4,1fr);padding:0 20px;background:#0c0e0e;border-color:#424744;overflow:hidden}.signal-cell{padding:11px 18px;border-color:#2a2e2c}.signal-cell .label{font:9px var(--mono)}.signal-cell .value{font:550 20px/1 var(--mono)}.signal-cell .sub{font:9px var(--mono)}.signal-cell.health .value{font:600 12px var(--mono)}.health-orb{border-radius:50%}.workspace{grid-template-columns:292px minmax(0,1fr)}.session-panel{background:#0e1010;border-color:#424744}.panel-heading{padding:20px 15px 12px}.panel-heading h2{font:600 11px var(--mono)}.search-input{border-radius:0;background:#0a0b0b}.trace-item{border-radius:0;padding:10px 8px}.trace-item.active{background:#191c1b}.trace-item.active:before{background:#55d97b;box-shadow:0 0 9px rgba(85,217,123,.28)}.trace-stage{background:#101112}.trace-view{display:block;min-height:100%}.trace-hero{min-height:103px;display:block;position:relative;padding:18px 128px 18px 27px;background:#101112;border-color:#424744}.trace-title{margin-top:7px}.trace-title h1{font:550 23px/1.15 var(--mono)}.trace-kicker{color:#a1a6a4}.trace-caption{font:10px var(--mono)}.trace-status{border-radius:0}.context-gauge{position:absolute;right:27px;top:50%;transform:translateY(-50%);display:flex;align-items:center;gap:10px}.context-ring{--context:0;width:43px;height:43px;position:relative;display:grid;place-items:center;border-radius:50%;background:conic-gradient(#2eb4ed calc(var(--context)*1%),#263034 0)}.context-ring:after{content:"";position:absolute;inset:5px;border-radius:50%;background:#101112}.context-ring span{position:relative;z-index:1;font:9px var(--mono)}.context-gauge-copy{display:grid}.context-gauge-copy strong{font:16px var(--mono)}.context-gauge-copy span{color:#646a68;font:9px var(--mono);letter-spacing:.08em}.session-stats{border-bottom:1px solid #424744}.stats-section{border-bottom:1px solid #424744}.stats-heading{height:52px;display:flex;align-items:center;gap:10px;padding:0 27px}.stats-heading h2{margin:0;font:500 13px var(--mono)}.stats-heading .count{margin-left:auto;color:#a1a6a4}.stats-page-nav{display:flex;align-items:center;gap:4px;margin-left:8px}.stats-page-nav button{border:1px solid #2a2e2c;background:#0d0e0f;padding:4px 7px;color:#a1a6a4;font:9px var(--mono)}.stats-page-nav button:disabled{opacity:.35}.stats-page-nav span{color:#2eb4ed;font:9px var(--mono)}.stats-chevron{color:#a1a6a4;font-size:16px}.stats-content{padding:0 27px 22px}.stats-speed{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:26px;padding:3px 0 18px}.stats-speed-item{display:flex;align-items:baseline;justify-content:space-between;padding-bottom:7px;border-bottom:1px solid #2a2e2c}.stats-speed-item span{color:#a1a6a4}.stats-speed-item strong{font:500 16px var(--mono)}.stats-columns,.token-columns{display:grid;grid-template-columns:1fr 1fr;gap:42px}.token-columns{margin-top:20px}.stat-group h3{margin:0 0 8px;color:#a1a6a4;font:500 10px var(--mono);letter-spacing:.09em}.stat-grid{display:grid;grid-template-columns:1fr auto;gap:7px 18px}.stat-label{display:flex;align-items:center;gap:9px;color:#a1a6a4}.stat-dot{width:8px;height:8px;flex:none;border:2px solid currentColor;border-radius:50%}.stat-dot.fill{border:0;background:currentColor}.stat-value{text-align:right}.tone-gray{color:#aeb8c5}.tone-cyan{color:#2eb4ed}.tone-reasoning{color:#2fd39d}.tone-generation{color:#55d97b}.tone-tool{color:#ff9f1c}.tone-compaction{color:#8c4ee8}.activity-content{padding:2px 27px 28px}.activity-caption{display:flex;gap:12px;margin-bottom:18px;color:#a1a6a4}.activity-caption .primary{margin-right:auto;color:#f1f2ef}.activity-grid{display:grid;grid-template-columns:190px minmax(360px,1fr) 72px;align-items:center;row-gap:7px}.activity-label{text-align:right;padding-right:14px;color:#a1a6a4;white-space:nowrap}.activity-label.major{color:#f1f2ef}.activity-track{height:18px;position:relative;border-bottom:1px solid #202322;background-image:linear-gradient(90deg,#2a2e2c 1px,transparent 1px);background-size:25% 100%;overflow:hidden}.activity-track.all{height:31px;border:0;border-radius:15px;background:#18211f}.activity-segment{position:absolute;top:5px;bottom:4px;left:var(--start);width:var(--width);min-width:2px;background:var(--segment)}.activity-track.all .activity-segment{top:0;bottom:0}.activity-value{text-align:right;color:#a1a6a4}.activity-axis{grid-column:2;display:flex;justify-content:space-between;padding-top:4px;color:#646a68;font:9px var(--mono)}.trace-detail{display:block}.trace-metrics{grid-template-columns:repeat(6,minmax(0,1fr))}.trace-metric{background:#0d0f0f}.toolbar{background:#131516}.status-tab,.page-button,.span-search,.family-select{border-radius:0}.app-footer{background:#0e1010;border-color:#424744}.span-dot.tool,.span-bar.tool{background:#ff9f1c}.span-dot.agent,.span-bar.agent{background:#55d97b}.span-dot.session,.span-bar.session{background:#8c4ee8}
@media(max-width:1120px){.app-shell{grid-template-rows:58px 112px minmax(0,1fr) 28px}.signal-strip{grid-template-columns:1.2fr repeat(2,1fr);overflow:hidden}.stats-speed{grid-template-columns:repeat(2,1fr)}.activity-grid{grid-template-columns:150px minmax(300px,1fr) 60px}}
@media(max-width:760px){body{overflow:auto}.app-shell{display:block;min-height:100%}.topbar{height:60px;padding-inline:12px}.top-context{display:none}.view-button{padding:7px 8px}.signal-strip{grid-template-columns:repeat(2,1fr);padding:0 12px}.signal-cell.health{grid-column:1/-1}.workspace{grid-template-columns:1fr}.trace-hero{padding:18px 16px}.stats-columns,.token-columns{grid-template-columns:1fr}.activity-content{overflow:auto}.activity-grid{min-width:540px;grid-template-columns:120px minmax(300px,1fr) 56px}}
</style>
</head>
<body>
<div class="app-shell">
<header class="topbar"><div class="brand"><div class="brand-mark">R</div><div class="brand-copy"><strong>ROTOM TRACE</strong><span>LONG-HORIZON OBSERVABILITY</span></div></div><div class="top-context"><i class="local-dot"></i><span id="state">正在连接本地记录…</span></div><div class="top-actions"><nav class="view-switch" aria-label="会话视图"><button class="view-button active" id="view-stats" type="button" aria-pressed="true">SESSION STATS</button><button class="view-button" id="view-trace" type="button" aria-pressed="false">EXECUTION TRACE</button></nav><span class="key-hint">R</span><button class="refresh-button" id="refresh" type="button"><span class="refresh-icon">↻</span><span>刷新数据</span></button></div></header>
<div class="signal-region"><section class="signal-strip" id="signals"></section><section class="efficiency-strip" id="efficiency"></section></div>
<section class="workspace"><aside class="session-panel"><div class="panel-heading"><h2>Session archive</h2><div class="panel-controls"><span id="trace-count">0 SESSIONS</span><button class="orphan-toggle" id="orphan-toggle" type="button" aria-pressed="false">EMPTY 0</button></div></div><div class="search-wrap"><input class="search-input" id="filter" type="search" aria-label="过滤会话路径" placeholder="过滤会话路径" autocomplete="off"></div><div class="trace-list" id="traces" tabindex="0" aria-label="Session archive list"></div></aside><main class="trace-stage" id="detail"><div class="empty-state"><div><div class="empty-glyph">//</div><strong>等待 trace 数据</strong><span>选择左侧会话以检查执行链路</span></div></div></main></section>
<footer class="app-footer"><span>ROTOM / OBSERVABILITY</span><span class="root-path" id="root-path">DATA ROOT —</span><span class="security">LOOPBACK · READ ONLY · TOKEN AUTH</span></footer>
</div>
<script nonce="${nonce}">
(function(){
'use strict';
var token=new URLSearchParams(location.hash.slice(1)).get('token')||'';
var traces=[],fleet=null,traceSnapshot='',selectedTrace='',currentDetail=null,selectedSpan='',spanQuery='',statusFilter='all',familyFilter='all',showOrphans=false,sessionView='stats';
function e(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n}
function fmt(n,digits){return new Intl.NumberFormat('zh-CN',{maximumFractionDigits:digits===undefined?1:digits}).format(n||0)}
var money=${formatDashboardMoney.toString()};
function size(n){if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KiB';return (n/1048576).toFixed(1)+' MiB'}
var compact=${formatDashboardCompact.toString()};
var duration=${formatDashboardDuration.toString()};
function compactMoney(n){var value=Number(n||0);return Math.abs(value)>=1000?'$'+compact(value):money(value)}
function percent(n,total){return total>0?fmt(n/total*100,1)+'%':'0%'}
function optionalPercent(n){return Number.isFinite(n)?fmt(n,1)+'%':'N/A'}
function rate(n){return Number.isFinite(n)?fmt(n,1)+'/s':'N/A'}
function optionalDuration(n){return Number.isFinite(n)?duration(n):'N/A'}
function optionalCompact(n){return Number.isFinite(n)?compact(n):'N/A'}
function usageParts(value){var parts=['uncached '+compact(value.inputTokens),'cache '+compact(value.cacheReadTokens),'output '+compact(value.outputTokens)];if(value.cacheWriteTokens)parts.push('cache write '+compact(value.cacheWriteTokens));return parts.join(' · ')}
function elapsed(iso){var seconds=Math.max(0,(Date.now()-Date.parse(iso))/1000);if(seconds<60)return Math.floor(seconds)+'s ago';if(seconds<3600)return Math.floor(seconds/60)+'m ago';if(seconds<86400)return Math.floor(seconds/3600)+'h ago';return Math.floor(seconds/86400)+'d ago'}
function basename(path){var bits=path.split('/');return bits[bits.length-1]||path}
function traceDisplayName(path){var name=basename(path),parts=name.split('_'),stamp=parts[0]||'',id=(parts[1]||'').replace('.trace.jsonl',''),match=stamp.match(/^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2})-([0-9]{2})-([0-9]{2})/);if(!match||!id)return name;return match[1]+' '+match[2]+':'+match[3]+':'+match[4]+' · '+id.slice(0,8)+'…'+id.slice(-4)}
function wallTimeLabel(summary){return summary.wallTimeMode==='operation-sum'?'Operation time':summary.wallTimeMode==='observed-window'?'Observed window':'Wall time'}
function wallTimeValue(summary){if(summary.wallTimeMode==='operation-sum')return(summary.partial?'≈ ':'')+duration(summary.wallTimeMs);if(summary.wallTimeMode==='observed-window')return'≈ '+duration(summary.wallTimeMs);return'N/A'}
function family(name){if(name.indexOf('pi.ai.')===0)return'model';if(name.indexOf('pi.tool.')===0)return'tool';if(name.indexOf('pi.agent.')===0)return'agent';return'session'}
function familyLabel(value){return{model:'MODEL',tool:'TOOL',agent:'AGENT',session:'SESSION'}[value]||'SPAN'}
function displaySpanName(span){var toolName=span.attributes&&span.attributes['pi.tool.name'];return span.name==='pi.tool.execute'&&typeof toolName==='string'?span.name+' · '+toolName:span.name}
function statusName(value){return{ok:'OK',error:'ERROR',aborted:'ABORTED',unknown:'UNKNOWN',running:'RUNNING',stale:'STALE',incomplete:'PAGE BOUNDARY'}[value]||String(value).toUpperCase()}
function traceStatus(summary){if(summary.orphan)return'ORPHAN';if(summary.unresolvedErrorCount)return summary.unresolvedErrorCount+' UNRESOLVED';if(summary.unknownCount)return summary.unknownCount+' UNKNOWN';if(summary.staleOpenCount)return summary.staleOpenCount+' STALE';if(summary.abortedCount)return summary.abortedCount+' ABORTED';if(summary.recoveredErrorCount)return summary.recoveredErrorCount+' RECOVERED';if(summary.openCount)return summary.openCount+' ACTIVE';if(summary.runtimeOpenCount)return'IDLE';return'NOMINAL'}
async function api(path){var response=await fetch(path,{headers:{authorization:'Bearer '+token},cache:'no-store'});if(!response.ok)throw new Error('HTTP '+response.status);return response.json()}
function renderSignals(){var root=document.getElementById('signals'),f=fleet;if(!f){root.replaceChildren();return}var statusParts=[{text:fmt(f.unresolvedErrorCount,0)+' unresolved',show:f.unresolvedErrorCount,tone:'bad'},{text:fmt(f.unknownCount,0)+' unknown',show:f.unknownCount,tone:'warn'},{text:fmt(f.staleCount,0)+' stale',show:f.staleCount,tone:'warn'},{text:fmt(f.abortedCount,0)+' aborted',show:f.abortedCount,tone:'warn'},{text:fmt(f.recoveredErrorCount,0)+' recovered',show:f.recoveredErrorCount,tone:'warn'},{text:fmt(f.propagatedErrorCount,0)+' propagated incidents',show:f.propagatedErrorCount,tone:'info'},{text:f.coverageHeadline.toLowerCase(),show:f.coverageHeadline!=='COMPLETE',tone:f.coverageLevel==='warn'?'warn':'info'},{text:fmt(f.orphanCount,0)+' empty filtered',show:f.orphanCount,tone:'info'}],fileParts=[fmt(f.sessionTraceCount,0)+' sessions'];if(f.orphanCount)fileParts.push(fmt(f.orphanCount,0)+' empty filtered');if(f.coverageHeadline!=='COMPLETE')fileParts.push(f.coverageHeadline.toLowerCase());var values=[{health:true,label:'Fleet health',value:f.healthHeadline},{label:'Trace files',value:fmt(f.traceCount,0),sub:fileParts.join(' · ')},{label:'Model calls',value:fmt(f.providerCount,0),sub:f.aggregateLimited?'bounded · loaded trace windows':'complete trace requests'},{label:'Observed tokens',value:compact(f.totalTokens),sub:(f.aggregateLimited?'bounded · ':'')+usageParts(f),title:fmt(f.totalTokens,0)+' tokens observed in loaded trace windows'},{label:'Estimated cost',value:compactMoney(f.estimatedCostUsd),sub:f.aggregateLimited?'bounded · loaded trace windows':'complete trace total',title:Number(f.estimatedCostUsd||0).toFixed(4)+' USD observed'}];root.replaceChildren();values.forEach(function(item){var cell=e('div','signal-cell'+(item.health?' health':'')),copy=e('div','copy');if(item.title)cell.title=item.title;copy.append(e('span','label',item.label));if(item.health){var state=e('span','health-state '+f.healthLevel),breakdown=e('span','sub health-breakdown'),visible=statusParts.filter(function(part){return part.show});state.append(e('i','health-orb'+(f.healthLevel==='nominal'?'':' '+f.healthLevel)),e('strong','value',item.value));if(visible.length)visible.forEach(function(part){breakdown.append(e('span','health-chip '+part.tone,part.text))});else breakdown.textContent='no unresolved execution issues';copy.append(state,breakdown)}else copy.append(e('strong','value',item.value),e('span','sub',item.sub));cell.append(copy);root.append(cell)})}
function traceListOutcome(trace){if(trace.unresolvedErrorCount||trace.unknownCount||trace.staleOpenCount)return{tone:trace.unresolvedErrorCount?'anomaly':'recovered',text:trace.unresolvedErrorCount+' unresolved · '+trace.unknownCount+' unknown · '+trace.staleOpenCount+' stale'};if(trace.abortedCount)return{tone:'recovered',text:trace.abortedCount+' aborted'+(trace.openCount?' · '+trace.openCount+' active':'')};if(trace.recoveredErrorCount)return{tone:'recovered',text:trace.recoveredErrorCount+' recovered'+(trace.openCount?' · '+trace.openCount+' active':'')};if(trace.openCount)return{tone:'',text:trace.openCount+' active'};return null}
function traceMatchesArchiveFilter(trace,query,includeOrphans){return(includeOrphans||!trace.orphan)&&trace.path.toLowerCase().includes(query)}
function renderTraceList(){var query=document.getElementById('filter').value.toLowerCase(),root=document.getElementById('traces'),toggle=document.getElementById('orphan-toggle'),visible=traces.filter(function(x){return traceMatchesArchiveFilter(x,query,showOrphans)});document.getElementById('trace-count').textContent=visible.length+' SESSIONS';toggle.textContent='EMPTY '+fmt(fleet&&fleet.orphanCount,0);toggle.disabled=!(fleet&&fleet.orphanCount);toggle.setAttribute('aria-pressed',showOrphans?'true':'false');root.replaceChildren();if(!visible.length){root.append(e('div','empty-state',showOrphans?'没有匹配的 trace':'没有匹配的会话'));return}visible.forEach(function(trace){var button=e('button','trace-item'+(trace.id===selectedTrace?' active':'')),main=e('span','trace-main'),name=e('span','trace-name',traceDisplayName(trace.path)),meta=e('span','trace-meta');button.type='button';button.title=trace.path+'\\n'+fmt(trace.totalTokens,0)+' observed tokens · '+usageParts(trace);button.setAttribute('aria-current',trace.id===selectedTrace?'true':'false');meta.append(e('span','',elapsed(trace.modifiedAt)),e('span','',compact(trace.totalTokens)+' tok'),e('span','',compact(trace.cacheReadTokens)+' cache'),e('span','',compactMoney(trace.estimatedCostUsd)));if(trace.orphan)meta.append(e('span','orphan','orphan'));var outcome=traceListOutcome(trace);if(outcome)meta.append(e('span',outcome.tone,outcome.text));else meta.append(e('span','',size(trace.sizeBytes)));if(trace.propagatedErrorCount)meta.append(e('span','coverage',trace.propagatedErrorCount+' propagated incident'+(trace.propagatedErrorCount===1?'':'s')));if(trace.partial)meta.append(e('span','coverage','bounded recent tail'));if(trace.parseErrors)meta.append(e('span','coverage',trace.parseErrors+' rejected'));main.append(name,meta);button.append(main);button.onclick=function(){selectedTrace=trace.id;selectedSpan='';renderTraceList();loadDetail(trace.id)};root.append(button)})}
function renderEfficiency(){var root=document.getElementById('efficiency');if(!root)return;var eff=fleet&&fleet.efficiency,buckets=eff&&eff.buckets||[];root.replaceChildren();var head=e('div','eff-head');head.append(e('h2','','Cost per successful operation'));head.append(e('span','eff-note','total spend ÷ successes · failed and unknown operations still count toward spend'));if(eff&&eff.truncated)head.append(e('span','eff-note warn','· bounded: dimension groups capped'));root.append(head);if(!buckets.length){root.append(e('div','eff-empty','No completed operations in the loaded trace windows.'));return}var table=e('table','eff-table'),thead=e('tr','');['Provider','Model','Route','Thinking','Subagent','Groups','Ops','Success','Cost / success','Tokens / success','Faults (h·m·e·u)','Unknown tools (unfin·unver)'].forEach(function(label,index){var th=e('th',index>=6?'num':'',label);if(index>=6)th.style.textAlign='right';thead.append(th)});table.append(thead);buckets.forEach(function(b){var row=e('tr','');var costCell;if(b.costPerSuccessUsd===null){var reason=b.pricingReason==='partially-reported'?'partially priced':b.pricingReason==='not-reported'?'no price reported':'no success';costCell=e('td','num eff-na',b.successCount?'N/A':'—');costCell.title=reason+' · provider cost not usable for a per-success figure'}else{costCell=e('td','num',money(b.costPerSuccessUsd))}var faults=[b.faultHarness||0,b.faultModel||0,b.faultEnvironment||0,b.faultUnknown||0],faultText=faults.some(function(x){return x})?faults.join('·'):'—';var unknowns=[b.toolIncomplete||0,b.toolUnverified||0],unknownCell=e('td','num',unknowns.some(function(x){return x})?unknowns.join('·'):'—');unknownCell.title='unfinished (superseded / torn down before its end event) · unverified (ran, effect not confirmed)';[e('td','',b.provider),e('td','',b.model),e('td','',b.route),e('td','',b.thinkingLevel),(function(){var td=e('td',b.subagentUsed?'eff-yes':'eff-na',b.subagentUsed?'yes':'no');return td})(),e('td','',b.capabilityGroups),e('td','num',fmt(b.operationCount,0)),e('td','num',b.successRate===null?'N/A':percent(b.successCount,b.operationCount)),costCell,e('td','num',b.tokensPerSuccess===null?'N/A':compact(b.tokensPerSuccess)),e('td','num',faultText),unknownCell].forEach(function(cell){row.append(cell)});table.append(row)});root.append(table)}
function pairSpans(records,lifecycleComplete){lifecycleComplete=lifecycleComplete!==false;var byId=new Map();records.forEach(function(record){var item=byId.get(record.spanId)||{spanId:record.spanId,traceId:record.traceId,parentSpanId:record.parentSpanId,name:record.name,attributes:{}};if(record.kind==='span_start'){item.start=Date.parse(record.timestamp);item.startedAt=record.timestamp;item.name=record.name;item.parentSpanId=record.parentSpanId;Object.assign(item.attributes,record.attributes||{})}else{item.end=Date.parse(record.timestamp);item.endedAt=record.timestamp;item.durationMs=record.durationMs;item.status=record.status||'unknown';Object.assign(item.attributes,record.attributes||{})}byId.set(record.spanId,item)});var now=Date.now(),pageTimes=records.map(function(record){return Date.parse(record.timestamp)}).filter(Number.isFinite),pageBoundaryEnd=pageTimes.length?Math.max.apply(null,pageTimes):now,items=Array.from(byId.values());items.forEach(function(item){if(!item.start&&item.end&&item.durationMs!==undefined)item.start=item.end-item.durationMs;if(!item.end&&item.start){item.open=true;item.end=lifecycleComplete?now:pageBoundaryEnd;item.durationMs=Math.max(0,item.end-item.start)}if(!item.status&&!item.open)item.status='unknown';item.family=family(item.name)});var lookup=new Map(items.map(function(item){return[item.spanId,item]})),latestActivity=new Map();items.forEach(function(item){var activity=item.open?item.start:Math.max(item.start||-Infinity,item.end||-Infinity),spanId=item.spanId,guard=0;while(spanId&&guard<64){latestActivity.set(spanId,Math.max(latestActivity.get(spanId)||-Infinity,activity));spanId=lookup.get(spanId)&&lookup.get(spanId).parentSpanId;guard+=1}});items.forEach(function(item){if(item.open)item.status=lifecycleComplete?(item.name==='pi.session.runtime'?'running':now-(latestActivity.get(item.spanId)||item.start)>=${STALE_OPEN_SPAN_MS}?'stale':'running'):'incomplete'});var errors=items.filter(function(item){return item.status==='error'}),errorIds=new Set(errors.map(function(item){return item.spanId})),stale=items.filter(function(item){return item.status==='stale'}),staleIds=new Set(stale.map(function(item){return item.spanId}));if(lifecycleComplete){errors.forEach(function(item){var parent=item.parentSpanId,guard=0;while(parent&&guard<64){if(errorIds.has(parent))lookup.get(parent).propagatedError=true;parent=lookup.get(parent)&&lookup.get(parent).parentSpanId;guard+=1}});stale.forEach(function(item){var parent=item.parentSpanId,guard=0;while(parent&&guard<64){if(staleIds.has(parent))lookup.get(parent).propagatedStale=true;parent=lookup.get(parent)&&lookup.get(parent).parentSpanId;guard+=1}})}var latestProviderSuccess=lifecycleComplete?Math.max.apply(null,items.filter(function(item){return item.name==='pi.ai.request'&&item.status==='ok'}).map(function(item){return item.end}).concat([-Infinity])):-Infinity;items.forEach(function(item){var depth=0,parent=item.parentSpanId,guard=0;while(parent&&lookup.has(parent)&&guard<8){depth+=1;parent=lookup.get(parent).parentSpanId;guard+=1}item.depth=depth;if(lifecycleComplete)item.recovered=item.status==='error'&&!item.propagatedError&&latestProviderSuccess>item.end});return items.filter(function(item){return Number.isFinite(item.start)&&Number.isFinite(item.end)}).sort(function(a,b){return a.start-b.start})}
function metric(label,value,tone,title){var node=e('div','trace-metric'+(tone?' '+tone:''));if(title)node.title=title;node.append(e('span','m-label',label),e('strong','m-value',value));return node}
function renderInspector(span,lifecycleComplete){var root=e('aside','inspector');if(!span){root.append(e('div','empty-state','选择一个 span 查看属性'));return root}var head=e('div','inspector-head');head.append(e('span','inspector-label',familyLabel(span.family)+' / SPAN DETAIL'),e('div','inspector-name',displaySpanName(span)));root.append(head);var visibleStatus=span.recovered?'RECOVERED':statusName(span.status),classification=!lifecycleComplete&&span.status==='error'?'PAGE-LOCAL ERROR':span.propagatedError?'PROPAGATED ERROR':span.status==='error'?'ROOT ERROR':span.propagatedStale?'PROPAGATED STALE':span.status==='incomplete'?'CROSSES PAGE BOUNDARY':'DIRECT',grid=e('dl','inspector-grid'),pairs=[['Status',visibleStatus],['Class',classification],['Duration',fmt(span.durationMs)+' ms'],['Started',new Date(span.start).toLocaleTimeString()],['Span ID',span.spanId],['Parent',span.parentSpanId||'root']];pairs.forEach(function(pair){var tone=pair[0]==='Status'?(span.recovered?'warn':span.status==='error'?'bad':(span.status==='unknown'||span.status==='stale')?'warn':''):'';grid.append(e('dt','',pair[0]),e('dd',tone,pair[1]))});root.append(grid);var attrs=e('div','attribute-list'),entries=Object.entries(span.attributes||{});attrs.append(e('div','inspector-label',entries.length+' ATTRIBUTES'));if(!entries.length)attrs.append(e('div','attribute-row','No attributes'));entries.forEach(function(pair){var value=typeof pair[1]==='string'?pair[1]:JSON.stringify(pair[1]);var row=e('div','attribute-row');row.append(e('span','attribute-key',pair[0]),e('span','attribute-value',value));attrs.append(row)});root.append(attrs);return root}
function spanTone(span){if(span.recovered)return' recovered';if(span.status==='error')return' bad';if(span.status==='unknown'||span.status==='stale')return' warn';return{'pi.ai.startup':' startup','pi.ai.prefill':' prefill','pi.ai.reasoning':' reasoning','pi.ai.generation':' generation'}[span.name]||''}
function statsHeading(title,count){var head=e('div','stats-heading');head.append(e('span','stats-chevron','⌄'),e('h2','',title),e('span','count',count));return head}
function statsPager(page,pageNumber){var nav=e('div','stats-page-nav'),newer=e('button','','NEWER'),label=e('span','','PAGE '+pageNumber),older=e('button','','OLDER');newer.type='button';older.type='button';newer.disabled=currentDetail.historyIndex===0;older.disabled=!page.hasEarlier;newer.onclick=function(){loadHistoryPage(-1)};older.onclick=function(){loadHistoryPage(1)};nav.append(newer,label,older);return nav}
function statsGrid(title,items){var group=e('section','stat-group'),grid=e('div','stat-grid');group.append(e('h3','',title));items.forEach(function(item){var label=e('div','stat-label'),dot=e('i','stat-dot '+item.tone+(item.fill?' fill':''));label.append(dot,e('span','',item.label));grid.append(label,e('div','stat-value',item.value))});group.append(grid);return group}
function activityColor(span){return{'pi.ai.startup':'#aeb8c5','pi.ai.prefill':'#2eb4ed','pi.ai.reasoning':'#2fd39d','pi.ai.generation':'#55d97b','pi.session.compaction':'#8c4ee8','pi.tool.execute':'#ff9f1c'}[span.name]||'#65d9ed'}
function activityLane(grid,label,items,value,major,min,range){var name=e('div','activity-label'+(major?' major':''),label),track=e('div','activity-track'+(major?' all':'')),shown=items.slice(-600);shown.forEach(function(span){var segment=e('i','activity-segment'),start=Math.max(0,(span.start-min)/range*100),width=Math.max(.25,(span.end-span.start)/range*100);segment.style.setProperty('--start',start+'%');segment.style.setProperty('--width',Math.min(width,100-start)+'%');segment.style.setProperty('--segment',activityColor(span));track.append(segment)});grid.append(name,track,e('div','activity-value',value))}
function renderSessionStats(summary,spans,page,pageBounded,pageNumber){var root=e('div','session-stats'),stats=e('section','stats-section'),content=e('div','stats-content'),speed=e('div','stats-speed'),scope=pageBounded?'PAGED HISTORY':'COMPLETE',heading=statsHeading('Stats',scope);heading.append(statsPager(page,pageNumber));stats.append(heading);[['tg/s',rate(summary.generationTokensPerSecond)],['pp/s',rate(summary.promptTokensPerSecond)],['laps',fmt(summary.operationCount,0)],['avg/lap',summary.averageOperationDurationMs===null?'N/A':duration(summary.averageOperationDurationMs)]].forEach(function(pair){var item=e('div','stats-speed-item');item.append(e('span','',pair[0]),e('strong','',pair[1]));speed.append(item)});content.append(speed);var times=e('div','stats-columns');times.append(statsGrid('TIME / PRIMARY',[{label:'wall clock',value:wallTimeValue(summary),tone:'tone-gray',fill:true},{label:'prefill · observed',value:optionalDuration(summary.prefillDurationMs),tone:'tone-cyan',fill:true},{label:'generation stream',value:optionalDuration(summary.generationDurationMs),tone:'tone-generation',fill:true},{label:'tools',value:duration(summary.toolDurationMs),tone:'tone-tool',fill:true}]),statsGrid('TIME / DETAIL',[{label:'startup · observed',value:optionalDuration(summary.startupDurationMs),tone:'tone-gray',fill:true},{label:'first content',value:optionalDuration(summary.firstContentDurationMs),tone:'tone-cyan'},{label:'reasoning stream',value:optionalDuration(summary.reasoningDurationMs),tone:'tone-reasoning'},{label:'compaction',value:duration(summary.compactionDurationMs),tone:'tone-compaction',fill:true}]));content.append(times);var tokens=e('div','token-columns');tokens.append(statsGrid('TOKENS / TOTAL',[{label:'total',value:compact(summary.totalTokens),tone:'tone-gray',fill:true},{label:'prompt, computed',value:compact(summary.inputTokens),tone:'tone-cyan',fill:true},{label:'completion',value:compact(summary.outputTokens),tone:'tone-generation',fill:true}]),statsGrid('TOKENS / BREAKDOWN',[{label:'prompt, cached',value:compact(summary.cacheReadTokens),tone:'tone-gray',fill:true},{label:'tool results',value:summary.toolResultEstimatedTokens===null?'N/A':compact(summary.toolResultEstimatedTokens)+' est.',tone:'tone-tool',fill:true},{label:'reasoning',value:optionalCompact(summary.reasoningTokens),tone:'tone-reasoning'}]));content.append(tokens);stats.append(content);root.append(stats);var activity=e('section','stats-section'),activityContent=e('div','activity-content'),caption=e('div','activity-caption'),grid=e('div','activity-grid'),timesSeen=spans.flatMap(function(span){return[span.start,span.end]}).filter(Number.isFinite),min=timesSeen.length?Math.min.apply(null,timesSeen):Date.now(),max=timesSeen.length?Math.max.apply(null,timesSeen):min+1,range=Math.max(1,max-min),phaseNames=new Set(['pi.ai.startup','pi.ai.prefill','pi.ai.reasoning','pi.ai.generation']),leafActivity=spans.filter(function(span){return phaseNames.has(span.name)||span.name==='pi.tool.execute'||span.name==='pi.session.compaction'}),providers=spans.filter(function(span){return span.name==='pi.ai.request'}),startup=spans.filter(function(span){return span.name==='pi.ai.startup'}),prefill=spans.filter(function(span){return span.name==='pi.ai.prefill'}),reasoning=spans.filter(function(span){return span.name==='pi.ai.reasoning'}),generation=spans.filter(function(span){return span.name==='pi.ai.generation'}),tools=spans.filter(function(span){return span.name==='pi.tool.execute'}),compactions=spans.filter(function(span){return span.name==='pi.session.compaction'});activity.append(statsHeading('Activity',fmt(leafActivity.length,0)));caption.append(e('span','primary','activity'),e('span','',new Date(min).toLocaleTimeString()+' → '+new Date(max).toLocaleTimeString()),e('span','','·'),e('span','',duration(max-min)),e('span','','·'),e('span','',fmt(leafActivity.length,0)+' observed'));activityContent.append(caption);activityLane(grid,'All activity',leafActivity,fmt(leafActivity.length,0),true,min,range);activityLane(grid,'assistant',[],fmt(providers.length,0),false,min,range);activityLane(grid,'startup',startup,optionalDuration(summary.startupDurationMs),false,min,range);activityLane(grid,'prefill',prefill,optionalDuration(summary.prefillDurationMs),false,min,range);activityLane(grid,'reasoning',reasoning,optionalDuration(summary.reasoningDurationMs),false,min,range);activityLane(grid,'generation',generation,optionalDuration(summary.generationDurationMs),false,min,range);activityLane(grid,'tooling',[],fmt(tools.length,0),false,min,range);var byTool=new Map();tools.forEach(function(span){var name=typeof span.attributes['pi.tool.name']==='string'?span.attributes['pi.tool.name']:'unknown',list=byTool.get(name)||[];list.push(span);byTool.set(name,list)});[...byTool.entries()].sort(function(a,b){return b[1].length-a[1].length||a[0].localeCompare(b[0])}).slice(0,5).forEach(function(entry){activityLane(grid,entry[0],entry[1],fmt(entry[1].length,0),false,min,range)});activityLane(grid,'compaction',compactions,fmt(compactions.length,0),false,min,range);var axis=e('div','activity-axis');axis.append(e('span','','0'),e('span','','25%'),e('span','','50%'),e('span','','75%'),e('span','',duration(max-min)));grid.append(e('div','',''),axis,e('div','',''));activityContent.append(grid);activity.append(activityContent);root.append(activity);return root}
function renderDetail(focusControl){var stage=document.getElementById('detail');if(!currentDetail){stage.replaceChildren(e('div','empty-state','未加载 trace'));return}var summary=currentDetail.summary,page=currentDetail.page,pageNumber=currentDetail.historyIndex+1,pageBounded=!page.lifecycleComplete,spans=pairSpans(currentDetail.records,!pageBounded),view=e('div','trace-view fade-in'),hero=e('section','trace-hero'),kicker=e('span','trace-kicker','Session telemetry / '+(pageBounded?'PAGED HISTORY · PAGE '+pageNumber:'COMPLETE HISTORY')),title=e('div','trace-title'),heading=e('h1','','Session overview'),badgeTone=pageBounded?'':summary.unresolvedErrorCount?' bad':summary.unknownCount||summary.staleOpenCount||summary.abortedCount||summary.recoveredErrorCount?' warn':'',badge=e('span','trace-status'+badgeTone,pageBounded?'PAGE '+pageNumber:traceStatus(summary)),caption=e('div','trace-caption'),pathNode=e('span','trace-path',summary.path);heading.title=basename(summary.path);pathNode.title=summary.path;title.append(heading,badge);caption.append(pathNode,e('span','',elapsed(summary.modifiedAt)),e('span','',size(summary.windowBytes)+' loaded / '+size(summary.sizeBytes)),e('span','',summary.parseErrors?summary.parseErrors+' rejected records':'clean parse'),e('span','',pageBounded?'metrics cover this page only':'complete trace usage')); var gauge=e('div','context-gauge'),ring=e('div','context-ring'),ringValue=e('span','',optionalPercent(summary.contextPercent)),gaugeCopy=e('div','context-gauge-copy');ring.style.setProperty('--context',Number.isFinite(summary.contextPercent)?Math.max(0,Math.min(100,summary.contextPercent)):0);ring.append(ringValue);gaugeCopy.append(e('strong','',optionalPercent(summary.contextPercent)),e('span','','CONTEXT USED'));gauge.append(ring,gaugeCopy);hero.append(kicker,title,caption,gauge);view.append(hero);if(sessionView==='stats'){view.append(renderSessionStats(summary,spans,page,pageBounded,pageNumber));stage.replaceChildren(view);return}var metrics=e('section','trace-metrics'),usageTitle=pageBounded?'observed on history page '+pageNumber:'observed in complete trace',lifecycleTitle='lifecycle classification is unavailable across page boundaries';metrics.append(metric('Spans',fmt(summary.spanCount,0),'',fmt(summary.spanCount,0)+' unique spans'),metric('Active',pageBounded?'N/A':fmt(summary.openCount,0),pageBounded?'':summary.openCount?'active':'',pageBounded?lifecycleTitle:summary.runtimeOpenCount?'session runtime remains open but is excluded':'no active work spans'),metric('Stale',pageBounded?'N/A':fmt(summary.staleOpenCount,0),pageBounded?'':summary.staleOpenCount?'warning':'',pageBounded?lifecycleTitle:fmt(summary.propagatedStaleOpenCount,0)+' propagated stale parents excluded'),metric('Unresolved',pageBounded?'N/A':fmt(summary.unresolvedErrorCount,0),pageBounded?'':summary.unresolvedErrorCount?'danger':'',pageBounded?lifecycleTitle:''),metric('Recovered',pageBounded?'N/A':fmt(summary.recoveredErrorCount,0),pageBounded?'':summary.recoveredErrorCount?'warning':'',pageBounded?lifecycleTitle:''),metric(pageBounded?'Raw errors':'Propagated incidents',pageBounded?fmt(summary.errorCount,0):fmt(summary.propagatedErrorCount,0),pageBounded&&summary.errorCount?'danger':'',pageBounded?'error span ends observed on this page':fmt(summary.propagatedErrorSpanCount,0)+' propagated parent spans grouped into '+fmt(summary.propagatedErrorCount,0)+' root-cause incidents'),metric(pageBounded?'Raw aborted':'Aborted incidents',pageBounded?fmt(summary.abortedSpanCount,0):fmt(summary.abortedCount,0),(pageBounded?summary.abortedSpanCount:summary.abortedCount)?'warning':'',pageBounded?'aborted span ends observed on this page':fmt(summary.abortedSpanCount,0)+' aborted spans grouped into '+fmt(summary.abortedCount,0)+' root-cause incidents'),metric('Unknown',fmt(summary.unknownCount,0),summary.unknownCount?'warning':''),metric('Operations',fmt(summary.operationCount,0)),metric('Avg operation',summary.averageOperationDurationMs===null?'N/A':duration(summary.averageOperationDurationMs),'',summary.averageOperationDurationMs===null?'unavailable':'mean completed operation duration'),metric(pageBounded?'Page model calls':'Model calls',fmt(summary.providerCount,0),'',usageTitle),metric('Tools',fmt(summary.toolCount,0)),metric('Compactions',fmt(summary.compactionCount,0),'',duration(summary.compactionDurationMs)+' client-observed time'),metric(pageBounded?'Page tokens':'Observed tokens',compact(summary.totalTokens),'',fmt(summary.totalTokens,0)+' tokens '+usageTitle),metric('Uncached input',compact(summary.inputTokens),'',fmt(summary.inputTokens,0)+' tokens '+usageTitle),metric('Cache read',compact(summary.cacheReadTokens),'',fmt(summary.cacheReadTokens,0)+' tokens '+usageTitle),metric('Output',compact(summary.outputTokens),'',fmt(summary.outputTokens,0)+' tokens '+usageTitle),metric('Reasoning tokens',optionalCompact(summary.reasoningTokens),'',summary.reasoningTokens===null?'provider did not report a reasoning breakdown':fmt(summary.reasoningTokens,0)+' provider-reported subset of output'),metric('Tool result est.',optionalCompact(summary.toolResultEstimatedTokens),'',summary.toolResultEstimatedTokens===null?'unavailable in legacy trace':fmt(summary.toolResultEstimatedTokens,0)+' estimated tokens; content is not retained'),metric('Cache share',percent(summary.cacheReadTokens,summary.totalTokens),'',usageTitle),metric(pageBounded?'Page context':'Latest context',optionalPercent(summary.contextPercent),'',summary.contextTokens===null?'unavailable':fmt(summary.contextTokens,0)+' / '+fmt(summary.contextWindowTokens,0)+' estimated context tokens'),metric('Observed startup',optionalDuration(summary.startupDurationMs),'','request dispatch to response headers; client-observed'),metric('Observed prefill',optionalDuration(summary.prefillDurationMs),'','response headers to first generated content; not provider compute time'),metric('Reasoning stream',optionalDuration(summary.reasoningDurationMs),'','client-observed reasoning stream spans'),metric('Generation stream',optionalDuration(summary.generationDurationMs),'','client-observed text and tool-call stream spans'),metric('PP/s observed',rate(summary.promptTokensPerSecond),'','reported uncached input divided by end-to-end first-content latency'),metric('TG/s observed',rate(summary.generationTokensPerSecond),'','reported output divided by observed reasoning plus generation stream time'),metric(pageBounded?'Page cost':'Cost',compactMoney(summary.estimatedCostUsd),'',Number(summary.estimatedCostUsd||0).toFixed(4)+' USD '+usageTitle),metric(wallTimeLabel(summary),wallTimeValue(summary),'',summary.wallTimeMs===null?'unavailable':fmt(summary.wallTimeMs,0)+' ms · '+summary.wallTimeMode));view.append(metrics);var body=e('section','trace-body'),timeline=e('div','timeline-pane'),toolbar=e('div','toolbar'),search=e('input','span-search'),select=e('select','family-select'),tabs=e('div','status-tabs'),pageNav=e('div','page-nav');search.type='search';search.placeholder='Filter span name';search.setAttribute('aria-label','Filter span name');search.value=spanQuery;search.oninput=function(){spanQuery=search.value.toLowerCase();renderDetail('span-search')};[['all','All spans'],['model','Model'],['tool','Tools'],['agent','Agent'],['session','Session']].forEach(function(option){var node=e('option','',option[1]);node.value=option[0];if(option[0]===familyFilter)node.selected=true;select.append(node)});select.setAttribute('aria-label','Span family');select.onchange=function(){familyFilter=select.value;renderDetail()};[['all','ALL'],['anomaly','ANOMALY']].forEach(function(option){var button=e('button','status-tab'+(statusFilter===option[0]?' active':''),option[1]);button.type='button';button.setAttribute('aria-pressed',statusFilter===option[0]?'true':'false');button.onclick=function(){statusFilter=option[0];renderDetail()};tabs.append(button)});var newer=e('button','page-button','NEWER'),pageLabel=e('span','page-index','PAGE '+pageNumber),older=e('button','page-button','OLDER');newer.type='button';older.type='button';newer.disabled=currentDetail.historyIndex===0;older.disabled=!page.hasEarlier;newer.onclick=function(){loadHistoryPage(-1)};older.onclick=function(){loadHistoryPage(1)};pageNav.append(newer,pageLabel,older);toolbar.append(search,select,tabs,pageNav);timeline.append(toolbar);var scale=e('div','timeline-scale'),track=e('div','scale-track');track.append(e('span','','0%'),e('span','','25'),e('span','','50'),e('span','','75'),e('span','','100%'));scale.append(e('span','','Span / hierarchy'),track,e('span','','Duration'));timeline.append(scale);var list=e('div','span-list'),filtered=spans.filter(function(span){return(!spanQuery||displaySpanName(span).toLowerCase().includes(spanQuery))&&(familyFilter==='all'||span.family===familyFilter)&&(statusFilter==='all'||span.status==='error'||span.status==='unknown'||span.status==='stale')});var nextSelected=filtered.find(function(span){return span.spanId===selectedSpan})||filtered[0]||spans[0];if(nextSelected)selectedSpan=nextSelected.spanId;var min=Math.min.apply(null,spans.map(function(x){return x.start}).concat([Date.now()])),max=Math.max.apply(null,spans.map(function(x){return x.end}).concat([min+1])),range=Math.max(1,max-min);if(!filtered.length)list.append(e('div','empty-state','没有匹配的 span'));filtered.forEach(function(span){var row=e('button','span-row'+(selectedSpan===span.spanId?' selected':'')),identity=e('div','span-identity'),dot=e('i','span-dot '+span.family+spanTone(span)),name=e('span','span-name',displaySpanName(span)),track=e('div','span-track'),bar=e('i','span-bar '+span.family+spanTone(span)),duration=e('span','span-duration',fmt(span.durationMs)+' ms');row.type='button';row.setAttribute('aria-pressed',selectedSpan===span.spanId?'true':'false');row.style.setProperty('--depth',Math.min(span.depth,5));bar.style.setProperty('--start',Math.max(0,(span.start-min)/range*100)+'%');bar.style.setProperty('--width',Math.max(.35,(span.end-span.start)/range*100)+'%');track.append(bar);identity.append(dot,name);row.append(identity,track,duration);row.onclick=function(){selectedSpan=span.spanId;renderDetail()};list.append(row)});timeline.append(list);var inspectorSpan=nextSelected;body.append(timeline,renderInspector(inspectorSpan,!pageBounded));view.append(body);stage.replaceChildren(view);if(focusControl){var control=stage.querySelector('.'+focusControl);if(control){control.focus();if(control.setSelectionRange)control.setSelectionRange(control.value.length,control.value.length)}}}
async function loadDetail(id){var stage=document.getElementById('detail');stage.replaceChildren(e('div','empty-state','读取 span records…'));try{var data=await api('/api/trace?id='+encodeURIComponent(id)+'&snapshot='+encodeURIComponent(traceSnapshot));currentDetail={id:id,summary:data.summary,records:data.records,page:data.page,history:[null],historyIndex:0};renderDetail()}catch(error){stage.replaceChildren(e('div','empty-state','读取失败 / '+error.message))}}
async function loadHistoryPage(direction){if(!currentDetail)return;var previous=currentDetail,targetIndex=currentDetail.historyIndex+direction,history=currentDetail.history.slice();if(direction>0){var cursor=currentDetail.page.nextCursor;if(!cursor)return;history=history.slice(0,currentDetail.historyIndex+1);history.push(cursor);targetIndex=history.length-1}if(targetIndex<0||targetIndex>=history.length)return;var requestedCursor=history[targetIndex],stage=document.getElementById('detail');stage.replaceChildren(e('div','empty-state','读取历史分页…'));try{var endpoint=requestedCursor?'/api/trace-page?id='+encodeURIComponent(currentDetail.id)+'&snapshot='+encodeURIComponent(traceSnapshot)+'&cursor='+encodeURIComponent(requestedCursor):'/api/trace?id='+encodeURIComponent(currentDetail.id)+'&snapshot='+encodeURIComponent(traceSnapshot),data=await api(endpoint);selectedSpan='';currentDetail={id:currentDetail.id,summary:data.summary,records:data.records,page:data.page,history:history,historyIndex:targetIndex};renderDetail()}catch(error){currentDetail=previous;renderDetail();stage.title='读取分页失败 / '+error.message}}
async function load(){var state=document.getElementById('state'),button=document.getElementById('refresh');if(!token){state.textContent='URL 缺少访问 token';return}button.classList.add('is-loading');state.textContent='SCANNING LOCAL TRACES';try{var data=await api('/api/traces');traces=data.traces;fleet=data.fleet;traceSnapshot=data.snapshotId;document.getElementById('root-path').textContent='DATA ROOT  '+data.root;state.textContent=(data.scanLimited?'SCAN LIMITED':'LOCAL ONLINE')+' · '+traces.length+' TRACES';renderSignals();renderEfficiency();if(selectedTrace&&!traces.some(function(x){return x.id===selectedTrace&&(!x.orphan||showOrphans)}))selectedTrace='';if(!selectedTrace&&traces[0])selectedTrace=(traces.find(function(trace){return !trace.orphan})||(showOrphans?traces[0]:null)||{}).id||'';renderTraceList();if(selectedTrace)await loadDetail(selectedTrace);else{currentDetail=null;renderDetail()}}catch(error){state.textContent='CONNECTION ERROR · '+error.message}finally{button.classList.remove('is-loading')}}
function selectSessionView(next){sessionView=next==='trace'?'trace':'stats';var statsButton=document.getElementById('view-stats'),traceButton=document.getElementById('view-trace');statsButton.classList.toggle('active',sessionView==='stats');traceButton.classList.toggle('active',sessionView==='trace');statsButton.setAttribute('aria-pressed',sessionView==='stats'?'true':'false');traceButton.setAttribute('aria-pressed',sessionView==='trace'?'true':'false');renderDetail()}
document.getElementById('view-stats').onclick=function(){selectSessionView('stats')};document.getElementById('view-trace').onclick=function(){selectSessionView('trace')};document.getElementById('refresh').onclick=load;document.getElementById('filter').oninput=renderTraceList;document.getElementById('orphan-toggle').onclick=function(){showOrphans=!showOrphans;if(!showOrphans&&traces.some(function(trace){return trace.id===selectedTrace&&trace.orphan})){selectedTrace=(traces.find(function(trace){return !trace.orphan})||{}).id||'';selectedSpan='';if(selectedTrace)loadDetail(selectedTrace);else{currentDetail=null;renderDetail()}}renderTraceList()};document.addEventListener('keydown',function(event){if(event.key==='r'&&!event.metaKey&&!event.ctrlKey&&document.activeElement.tagName!=='INPUT'){event.preventDefault();load()}if(event.key==='/'&&document.activeElement.tagName!=='INPUT'){event.preventDefault();document.getElementById('filter').focus()}});load();
})();
</script>
</body>
</html>`;
}

export async function startTraceDashboard(options = {}) {
	const rootState = await canonicalTraceRoot(options.root ?? resolve(homedir(), ".pi/agent/sessions"));
	const root = rootState.root;
	const token = options.token ?? randomBytes(24).toString("base64url");
	const nonce = randomBytes(18).toString("base64url");
	let expectedHosts = new Set();
	let activeApiRequests = 0;
	let inFlightSummaryScan;
	let cachedSummaryScan;
	let summaryCacheExpiresAt = 0;
	const summarySnapshots = new Map();
	const sharedSummaryScan = (force = false) => {
		if (inFlightSummaryScan) return inFlightSummaryScan;
		if (!force && cachedSummaryScan && Date.now() < summaryCacheExpiresAt) return Promise.resolve(cachedSummaryScan);
		inFlightSummaryScan = scanTraceFiles(root).then((result) => {
			const snapshot = { ...result, snapshotId: randomBytes(12).toString("base64url") };
			summarySnapshots.set(snapshot.snapshotId, snapshot);
			while (summarySnapshots.size > MAX_SUMMARY_SNAPSHOTS) summarySnapshots.delete(summarySnapshots.keys().next().value);
			cachedSummaryScan = snapshot;
			summaryCacheExpiresAt = Date.now() + SUMMARY_CACHE_TTL_MS;
			return snapshot;
		}).finally(() => { inFlightSummaryScan = undefined; });
		return inFlightSummaryScan;
	};
	const server = createServer(async (request, response) => {
		try {
			if (!expectedHosts.has(request.headers.host ?? "")) { textResponse(response, 421, "Invalid Host\n"); return; }
			if (request.method !== "GET") { textResponse(response, 405, "Method Not Allowed\n", { allow: "GET" }); return; }
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (url.pathname === "/") {
				const body = dashboardHtml(nonce);
				response.writeHead(200, {
					"content-type": "text/html; charset=utf-8",
					"content-length": Buffer.byteLength(body),
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
					"referrer-policy": "no-referrer",
					"content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
				});
				response.end(body);
				return;
			}
			if (url.pathname !== "/api/traces" && url.pathname !== "/api/trace" && url.pathname !== "/api/trace-page") { jsonResponse(response, 404, { error: "not_found" }); return; }
			if (!authorized(request, token)) { jsonResponse(response, 401, { error: "unauthorized" }); return; }
			if (activeApiRequests >= MAX_API_CONCURRENCY) { jsonResponse(response, 429, { error: "too_many_requests" }); return; }
			activeApiRequests += 1;
			try {
				if (url.pathname === "/api/traces") {
					const scanned = await sharedSummaryScan(true);
					const summaries = scanned.traces.map(({ summary }) => summary);
					jsonResponse(response, 200, { root: scanned.root, snapshotId: scanned.snapshotId, scanLimited: scanned.scanLimited, fleet: summarizeFleet(summaries, scanned.scanLimited), traces: summaries });
					return;
				}
				const scanned = summarySnapshots.get(url.searchParams.get("snapshot") ?? "");
				if (!scanned) { jsonResponse(response, 409, { error: "snapshot_expired" }); return; }
				const trace = scanned.traces.find(({ summary }) => summary.id === url.searchParams.get("id"));
				if (!trace) { jsonResponse(response, 404, { error: "trace_not_found" }); return; }
				let endingOffset;
				let maximumBytes = trace.summary.windowBytes ?? MAX_SUMMARY_TRACE_BYTES;
				if (url.pathname === "/api/trace-page") {
					endingOffset = decodeTraceCursor(url.searchParams.get("cursor"), trace.summary.sizeBytes);
					if (endingOffset === undefined) { jsonResponse(response, 400, { error: "invalid_cursor" }); return; }
					maximumBytes = MAX_SUMMARY_TRACE_BYTES;
				}
				const loaded = await readTraceTail(scanned.root, trace.path, maximumBytes, MAX_API_RECORDS, trace.summary.sizeBytes, endingOffset);
				const page = tracePageMetadata(loaded, trace.summary.sizeBytes);
				const detail = {
					...loaded,
					partial: page.hasEarlier || page.hasNewer,
					modifiedAt: trace.summary.modifiedAt,
					orphan: trace.summary.orphan,
				};
				jsonResponse(response, 200, { summary: summarizeTrace(scanned.root, trace.path, detail), records: detail.records, page });
			} finally { activeApiRequests -= 1; }
		} catch { jsonResponse(response, 500, { error: "internal_error" }); }
	});
	server.on("clientError", (_error, socket) => socket.destroy());
	await new Promise((accept, reject) => {
		const onError = (error) => reject(error);
		const onListening = () => { server.off("error", onError); accept(); };
		server.once("error", onError);
		server.listen({ host: "127.0.0.1", port: options.port ?? 0 }, onListening);
	});
	if (typeof options.onError === "function") server.on("error", options.onError);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("trace dashboard did not bind a TCP port");
	expectedHosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);
	const baseUrl = `http://127.0.0.1:${address.port}`;
	return {
		root,
		token,
		baseUrl,
		url: `${baseUrl}/#token=${encodeURIComponent(token)}`,
		async close() {
			if (!server.listening) return;
			await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
		},
	};
}

async function main() {
	let stopping = false;
	let dashboard;
	async function stop(exitCode = 0) {
		if (stopping) { process.exit(130); return; }
		stopping = true;
		const forced = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
		forced.unref?.();
		await dashboard?.close().catch(() => {});
		clearTimeout(forced);
		process.exit(exitCode);
	}
	dashboard = await startTraceDashboard({
		onError(error) {
			process.stderr.write(`rotom: trace dashboard server error: ${error instanceof Error ? error.message : String(error)}\n`);
			void stop(1);
		},
	});
	process.stdout.write(`Rotom trace dashboard: ${dashboard.url}\n`);
	process.stdout.write(`Data: ${dashboard.root}\n`);
	if (process.env.ROTOM_TRACE_DASHBOARD_TEST_ONCE === "1") { await dashboard.close(); return; }
	process.stdout.write("Press Ctrl+C to stop.\n");
	process.on("SIGINT", () => { void stop(0); });
	process.on("SIGTERM", () => { void stop(0); });
	await new Promise(() => {});
}

const directEntry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (directEntry === import.meta.url) main().catch((error) => {
	process.stderr.write(`rotom: trace dashboard failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
