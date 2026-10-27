import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { contentText, loadSession, metricsOf, newSummary, readBounded, sessionSummary, statIfPresent } from "./session-data.mjs";
import { annotationInput, DEFAULT_EVAL_DIRECTORY, mergedLabels, validSessionId, writeAnnotation } from "./annotations.mjs";

import { latestJudgments } from "./judge-store.mjs";

export const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
export const MAX_PREVIEW_CHARS = 2000;
export const MAX_RESPONSE_BYTES = 256 * 1024;
// Match the shared card reader's existing per-file cap; browser responses are
// independently paged, so large valid sessions remain reviewable.
export const MAX_SESSION_BYTES = 256 * 1024 * 1024;
const MAX_SCAN_ENTRIES = 50_000;
const MAX_SESSIONS = 500;
const LIST_PAGE_SIZE = 10;
const TIMELINE_PAGE_SIZE = 20;
// Directory fan-out and file reads are I/O bound. Bounded parallelism keeps
// startup interactive without exhausting file descriptors.
const SCAN_CONCURRENCY = 64;
const HEADER_CONCURRENCY = 16;
const ROW_CONCURRENCY = 4;
// Peak parsed-session memory is bounded by bytes, not only by worker count:
// one 192 MB session is already heavy after JSON parsing.
const ROW_BYTES_IN_FLIGHT = 192 * 1024 * 1024;
const HEADER_CACHE_LIMIT = 2_000;
const CATALOG_CACHE_MS = 1_500;

async function mapLimit(items, limit, run) {
	const results = new Array(items.length);
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await run(items[index], index);
		}
	}));
	return results;
}

function byteBudget(maximum) {
	let used = 0;
	const waiting = [];
	const settle = () => { while (waiting.length && used + waiting[0].bytes <= maximum) waiting.shift().resolve(); };
	return async (bytes, run) => {
		if (used + bytes > maximum) await new Promise((resolve) => { waiting.push({ bytes, resolve }); waiting.sort((a, b) => a.bytes - b.bytes); });
		used += bytes;
		try { return await run(); }
		finally { used -= bytes; settle(); }
	};
}

export function evalError(status, code) { return Object.assign(new Error(code), { status, code }); }
export function sessionState(sessionMtime, traceMtime, now = Date.now()) {
	const times = [sessionMtime, traceMtime].filter(Number.isFinite);
	if (!times.length) return "unknown";
	return now - Math.max(...times) <= ACTIVE_WINDOW_MS ? "active" : "idle";
}
export function preview(value, maximum = MAX_PREVIEW_CHARS) {
	let text = "", length = 0;
	for (const character of String(value ?? "")) {
		if (length === maximum) return { text, truncated: true };
		text += character; length++;
	}
	return { text, truncated: false };
}
const hash = (value) => createHash("sha256").update(value).digest("hex");
function encodeCursor(offset, version) { return Buffer.from(JSON.stringify({ offset, version })).toString("base64url"); }
export function decodeCursor(cursor, version, total) {
	if (!cursor) return 0;
	let value;
	try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw evalError(400, "invalid_cursor"); }
	if (!Number.isSafeInteger(value?.offset) || value.offset < 0) throw evalError(400, "invalid_cursor");
	if (value.version !== version) throw evalError(409, "session_changed");
	if (value.offset >= total) throw evalError(400, "invalid_cursor");
	return value.offset;
}
export function timelineEvents(branch, traceTools) {
	const results = new Map(branch.filter((entry) => entry.message?.role === "toolResult").map((entry) => [entry.message.toolCallId, entry.message]));
	const events = [];
	let firstError = null;
	for (const entry of branch) {
		const message = entry.type === "message" ? entry.message : undefined;
		if (!message) continue;
		if (message.role === "user" || message.role === "assistant") {
			const failed = message.role === "assistant" && message.stopReason === "error";
			const body = contentText(message.content) || (failed ? message.errorMessage ?? "" : "");
			if (body || failed || message.role === "user") {
				if (failed && firstError === null) firstError = events.length;
				// The entry id lets the UI pin this exact step as a replay point.
				events.push({ kind: message.role, content: body, failed, entryId: entry.id });
			}
		}
		if (message.role === "assistant") for (const call of Array.isArray(message.content) ? message.content : []) {
			if (call?.type !== "toolCall") continue;
			const result = results.get(call.id);
			const attrs = typeof call.id === "string" ? traceTools.get(hash(call.id)) : undefined;
			const outcome = attrs?.["pi.tool.outcome"] ?? (result ? result.isError ? "tool_error" : "ok" : "unknown");
			const failed = outcome !== "ok" && outcome !== "unknown";
			if (failed && firstError === null) firstError = events.length;
			events.push({ kind: "tool", name: call.name, outcome, failed, args: call.arguments, result: result?.content });
		}
	}
	return { events, firstError };
}
export function timelinePage(branch, traceTools, cursor, version, eventIndex) {
	const { events, firstError } = timelineEvents(branch, traceTools);
	if (eventIndex !== undefined && (!Number.isSafeInteger(eventIndex) || eventIndex < 0 || eventIndex >= events.length)) throw evalError(400, "invalid_event");
	const offset = eventIndex ?? decodeCursor(cursor, version, events.length);
	const items = [];
	let bytes = 0;
	for (let index = offset; index < events.length && items.length < TIMELINE_PAGE_SIZE; index++) {
		const event = events[index];
		const item = event.kind === "tool"
			? { index, kind: "tool", name: preview(event.name, 128).text, outcome: preview(event.outcome, 64).text, failed: event.failed, firstError: index === firstError, args: preview(JSON.stringify(event.args)), result: preview(contentText(event.result)) }
			: { index, kind: event.kind, content: preview(event.content), failed: event.failed, firstError: index === firstError, entryId: event.entryId };
		const size = Buffer.byteLength(JSON.stringify(item));
		if (items.length && bytes + size > MAX_RESPONSE_BYTES / 2) break;
		items.push(item); bytes += size;
	}
	const next = offset + items.length;
	return { items, total: events.length, firstError, nextCursor: next < events.length ? encodeCursor(next, version) : null };
}

async function safePath(root, path) {
	const parts = relative(root, path).split(sep);
	if (parts.some((part) => part === "..")) throw evalError(400, "invalid_path");
	let current = root;
	for (const part of ["", ...parts]) {
		current = join(current, part);
		const info = await statIfPresent(current);
		if (!info) return;
		if (info.isSymbolicLink()) throw evalError(400, "symlink_rejected");
	}
}
function headerCache() {
	// Header reads are the only reason a list call touches every file. Key on the
	// stat identity so an appended session is re-read, never served stale.
	const entries = new Map();
	return async (path, info) => {
		const key = `${info.ino}:${info.size}:${info.mtimeMs}`;
		const cached = entries.get(path);
		if (cached?.key === key) return cached.header;
		const header = await readHeader(path);
		entries.delete(path);
		entries.set(path, { key, header });
		if (entries.size > HEADER_CACHE_LIMIT) entries.delete(entries.keys().next().value);
		return header;
	};
}
async function readHeader(path) {
	const loaded = await readBounded(path, MAX_SESSION_BYTES, true);
	const header = loaded.firstRecord;
	return !loaded.firstNonemptyTooLong && header?.type === "session" && validSessionId(header.id) ? header : undefined;
}
async function walk(root) {
	const paths = [], limits = { visited: 0, truncated: false };
	let level = [root];
	while (level.length && !limits.truncated) {
		const children = [];
		const listings = await mapLimit(level, SCAN_CONCURRENCY, async (directory) => {
			const entries = [];
			try {
				for await (const entry of await opendir(directory)) {
					if (++limits.visited > MAX_SCAN_ENTRIES) { limits.truncated = true; break; }
					// Never follow links out of the canonical root; entries are already
					// relative to it, so per-child path revalidation is redundant.
					if (!entry.isSymbolicLink()) entries.push(entry);
				}
			} catch { limits.errors++; }
			return entries;
		});
		const files = [];
		for (const [index, entries] of listings.entries()) for (const entry of entries) {
			const path = join(level[index], entry.name);
			if (entry.isDirectory() && entry.name !== "observability") children.push(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
		}
		const infos = await mapLimit(files, SCAN_CONCURRENCY, (path) => lstat(path).catch(() => undefined));
		files.forEach((path, index) => { if (infos[index]?.isFile() && !infos[index].isSymbolicLink()) paths.push({ path, info: infos[index] }); });
		level = children;
	}
	return { paths, truncated: limits.truncated };
}
async function catalog(root, headerOf) {
	if (!(await statIfPresent(root))) return { sessions: [], limited: false };
	// Validate the canonical root once; walk() then only ever reads its children.
	await safePath(root, root);
	const scanned = await walk(root);
	scanned.paths.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
	const candidates = scanned.paths.slice(0, MAX_SESSIONS);
	const resolved = await mapLimit(candidates, HEADER_CONCURRENCY, async ({ path, info }) => {
		const header = await headerOf(path, info);
		if (!header) return undefined;
		const tracePath = join(dirname(path), "observability", `${basename(path, ".jsonl")}.trace.jsonl`);
		const trace = await statIfPresent(tracePath).catch(() => undefined);
		return { id: header.id, header, path, info, tracePath, trace: trace?.isFile() ? trace : undefined, state: sessionState(info.mtimeMs, trace?.mtimeMs) };
	});
	const sessions = new Map(), duplicate = new Set();
	for (const session of resolved) {
		if (!session) continue;
		if (sessions.has(session.id) || duplicate.has(session.id)) { sessions.delete(session.id); duplicate.add(session.id); continue; }
		sessions.set(session.id, session);
	}
	return { sessions: [...sessions.values()].sort((a, b) => String(b.header.timestamp ?? "").localeCompare(String(a.header.timestamp ?? "")) || a.id.localeCompare(b.id)), limited: scanned.paths.length > MAX_SESSIONS || scanned.truncated };
}
function versionOf(session) { return hash(JSON.stringify([session.id, session.info.ino, session.info.size, session.info.mtimeMs, session.trace?.size, session.trace?.mtimeMs])); }
async function freshVersion(session) {
	// Detail cursors must invalidate on append even when the listing is cached.
	const info = await lstat(session.path).catch(() => session.info);
	const trace = await statIfPresent(session.tracePath).catch(() => session.trace);
	return hash(JSON.stringify([session.id, info.ino, info.size, info.mtimeMs, trace?.size, trace?.mtimeMs]));
}
async function load(root, session) {
	await safePath(root, session.path); await safePath(root, session.tracePath);
	const loaded = await loadSession(session.path, newSummary(), new Set(), MAX_SESSION_BYTES, true);
	if (loaded.reason) throw evalError(413, "session_unavailable_or_too_large");
	if (loaded.header.id !== session.id) throw evalError(409, "session_changed");
	const current = await lstat(session.path);
	// The shared reader pins its byte boundary. Appends do not invalidate this
	// first-page snapshot; subsequent timeline cursors still compare versions.
	if (current.ino !== session.info.ino) throw evalError(409, "session_changed");
	return loaded;
}
function rowOf(session, loaded, labels) {
	const metrics = loaded ? metricsOf(loaded) : null;
	return {
		id: session.id, started: preview(session.header.timestamp, 64).text, state: session.state,
		request: loaded ? preview(sessionSummary(loaded.branch).request, 80).text : "",
		metrics: metrics ? { durationMs: metrics.durationMs, toolCalls: metrics.toolCalls, toolErrors: metrics.toolErrors, costUsd: metrics.costUsd, costPartial: metrics.costPartial, tokens: metrics.tokens } : null,
		findings: loaded ? loaded.findings.map(({ rule, status, count }) => ({ rule, status, count })) : [],
		atEntryId: loaded?.branch.at(-1)?.id ?? null,
		atEntryCount: loaded?.branch.length ?? null,
		annotation: labelOf(labels.get(session.id), loaded?.branch.at(-1)?.id),
	};
}
async function loadLabels(directory) {
	const merged = await mergedLabels({ out: join(directory, "cards") });
	return new Map(merged.rows.filter((row) => ["pass", "fail"].includes(row.verdict)).map((row) => [row.sessionId, row]));
}
function labelOf(label, lastEntryId) {
	if (!label) return null;
	return { verdict: label.verdict, note: preview(label.note, 500).text, failSet: label.failSet === true,
		source: label.source === "dashboard" ? "dashboard" : "review",
		atEntryId: label.atEntryId ?? null, atEntryCount: label.atEntryCount ?? null,
		progressed: label.atEntryId !== undefined && lastEntryId !== undefined && label.atEntryId !== lastEntryId };
}
export function matchesSessionFilter(row, filter) {
	return filter === "all" || (filter === "unlabeled" && !row.annotation) ||
		(filter === "fail" && row.annotation?.verdict === "fail") || (filter === "failSet" && row.annotation?.failSet) ||
		(filter === "hits" && row.findings.some((finding) => finding.status === "hit"));
}
export function createEvalService(root, directory = DEFAULT_EVAL_DIRECTORY) {
	// Cache only bounded list metadata, never raw messages or tool arguments.
	const summaries = new Map();
	const headerOf = headerCache();
	// One listing serves the burst a page open produces (list, detail, refresh).
	// A newly appended session therefore appears within this window, and state
	// changes stay far inside the five-minute activity boundary.
	let catalogCache, catalogInFlight, catalogCachedAt = 0;
	const scan = (force = false) => {
		if (!force && catalogCache && Date.now() - catalogCachedAt < CATALOG_CACHE_MS) return Promise.resolve(catalogCache);
		if (!catalogInFlight) catalogInFlight = catalog(root, headerOf).then((value) => {
			catalogCache = value; catalogCachedAt = Date.now(); return value;
		}).finally(() => { catalogInFlight = undefined; });
		return catalogInFlight;
	};
	const budget = byteBudget(ROW_BYTES_IN_FLIGHT);
	async function lookup(id, force = false) {
		if (!validSessionId(id)) throw evalError(400, "invalid_session_id");
		const session = (await scan(force)).sessions.find((row) => row.id === id);
		if (!session) throw evalError(404, "session_not_found");
		return session;
	}
	return {
		/** Resolved session file; replay must not guess a flat `<id>.jsonl` path. */
		async pathOf(id) { return (await lookup(id)).path; },
		async snapshot(id) {
			const session = await lookup(id);
			return { session, loaded: await load(root, session) };
		},
		async sessions(cursor, filter = "all", force = false) {
			if (!["all", "unlabeled", "fail", "failSet", "hits"].includes(filter)) throw evalError(400, "invalid_filter");
			const startedAt = Date.now();
			const scanned = await scan(force);
			const labels = await loadLabels(directory);
			const version = hash(JSON.stringify(scanned.sessions.map((session) => session.id)));
			const ids = new Set(scanned.sessions.map((session) => session.id));
			for (const id of summaries.keys()) if (!ids.has(id)) summaries.delete(id);
			const build = (session) => budget(Math.max(1, Math.min(session.info.size, ROW_BYTES_IN_FLIGHT)), async () => {
				const key = versionOf(session);
				const cached = summaries.get(session.id);
				if (cached?.key === key) return cached.row;
				let row;
				try { row = rowOf(session, await load(root, session), new Map()); }
				catch (error) {
					if (![409, 413].includes(error.status)) throw error;
					row = { ...rowOf(session, null, new Map()), unavailable: error.code };
				}
				summaries.set(session.id, { key, row });
				return row;
			});
			// Label-only counts and filters need no session body. Rule hits are the
			// exception: they require the full branch, so they are computed only when
			// asked for or already known from cached rows.
			const labelOfSession = (session) => labels.get(session.id);
			const cheapMatch = (session) => filter === "all" || (filter === "unlabeled" && !labelOfSession(session)) ||
				(filter === "fail" && labelOfSession(session)?.verdict === "fail") || (filter === "failSet" && labelOfSession(session)?.failSet === true);
			let matched = scanned.sessions;
			if (filter !== "hits") {
				matched = scanned.sessions.filter(cheapMatch);
			} else {
				const all = await mapLimit(scanned.sessions, ROW_CONCURRENCY, build);
				matched = scanned.sessions.filter((session, index) => all[index].findings.some((finding) => finding.status === "hit"));
			}
			// Cursors reference the filtered sequence so paging cannot skip matches.
			const offset = decodeCursor(cursor, version, matched.length);
			const page = matched.slice(offset, offset + LIST_PAGE_SIZE);
			const judgments = await latestJudgments(directory, new Set(page.map((session) => session.id)));
			const pageRows = await mapLimit(page, ROW_CONCURRENCY, build);
			const items = page.map((session, index) => {
				const row = pageRows[index], judgment = judgments.get(session.id);
				return { ...row, state: session.state, annotation: labelOf(labels.get(session.id), row.atEntryId),
					judgment: judgment ? { status: judgment.latest.status, verdict: judgment.latest.result?.suggestedVerdict ?? null } : null };
			});
			const counts = { all: scanned.sessions.length, unlabeled: 0, fail: 0, failSet: 0, hits: null };
			const states = { active: 0, idle: 0, unknown: 0 };
			for (const session of scanned.sessions) {
				states[session.state]++;
				const label = labelOfSession(session);
				if (!label) counts.unlabeled++;
				if (label?.verdict === "fail") counts.fail++;
				if (label?.failSet) counts.failSet++;
			}
			if (filter === "hits" || summaries.size === scanned.sessions.length) {
				counts.hits = scanned.sessions.filter((session) => summaries.get(session.id)?.row.findings.some((finding) => finding.status === "hit")).length;
			}
			const next = Math.min(matched.length, offset + LIST_PAGE_SIZE);
			return { items, total: scanned.sessions.length, matched: matched.length, counts, labeled: scanned.sessions.length - counts.unlabeled,
				unavailable: items.filter((row) => row.unavailable).length, states, limited: scanned.limited,
				elapsedMs: Date.now() - startedAt,
				nextCursor: next < matched.length ? encodeCursor(next, version) : null };
		},
		async session(id, cursor, eventIndex) {
			const session = await lookup(id);
			const loaded = await load(root, session);
			const labels = await loadLabels(directory);
			const summary = sessionSummary(loaded.branch);
			const judgment = (await latestJudgments(directory, [id])).get(id) ?? null;
			if (judgment) judgment.anchorAvailable = loaded.branch.some((entry) => entry.id === judgment.latest.atEntryId);
			return { judgment, ...rowOf(session, loaded, labels), summary: { request: preview(summary.request), final: preview(summary.final) },
				timeline: timelinePage(loaded.branch, loaded.trace.tools, cursor, await freshVersion(session), eventIndex) };
		},
		async annotate(input) {
			let value; try { value = annotationInput(input); } catch { throw evalError(400, "invalid_annotation"); }
			// A write revalidates against a fresh listing: the cached state may be stale.
			const session = await lookup(value.sessionId, true);
			if (session.state === "unknown") throw evalError(409, "session_state_unknown");
			const loaded = await load(root, session);
			return writeAnnotation(directory, value, { atEntryId: loaded.branch.at(-1)?.id ?? null, atEntryCount: loaded.branch.length });
		},
	};
}
