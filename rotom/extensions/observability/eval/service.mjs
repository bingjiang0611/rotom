import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { contentText, loadSession, metricsOf, newSummary, readBounded, sessionSummary, statIfPresent } from "./session-data.mjs";
import { annotationInput, DEFAULT_EVAL_DIRECTORY, mergedLabels, validSessionId, writeAnnotation } from "./annotations.mjs";

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

export function evalError(status, code) { return Object.assign(new Error(code), { status, code }); }
export function sessionState(sessionMtime, traceMtime, now = Date.now()) {
	const times = [sessionMtime, traceMtime].filter(Number.isFinite);
	if (!times.length) return "unknown";
	return now - Math.max(...times) <= ACTIVE_WINDOW_MS ? "active" : "idle";
}
export function preview(value, maximum = MAX_PREVIEW_CHARS) {
	const chars = Array.from(String(value ?? ""));
	return { text: chars.slice(0, maximum).join(""), truncated: chars.length > maximum };
}
const hash = (value) => createHash("sha256").update(value).digest("hex");
function encodeCursor(offset, version) { return Buffer.from(JSON.stringify({ offset, version })).toString("base64url"); }
export function decodeCursor(cursor, version, total) {
	if (!cursor) return 0;
	let value;
	try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw evalError(400, "invalid_cursor"); }
	if (!Number.isSafeInteger(value?.offset) || value.offset < 0 || value.offset >= total) throw evalError(400, "invalid_cursor");
	if (value.version !== version) throw evalError(409, "session_changed");
	return value.offset;
}
export function timelinePage(branch, traceTools, cursor, version) {
	const results = new Map(branch.filter((entry) => entry.message?.role === "toolResult").map((entry) => [entry.message.toolCallId, entry.message]));
	const events = [];
	let firstError = null;
	for (const entry of branch) {
		const message = entry.type === "message" ? entry.message : undefined;
		if (!message) continue;
		if (message.role === "user" || message.role === "assistant") {
			const failed = message.role === "assistant" && message.stopReason === "error";
			const body = contentText(message.content) || (failed ? message.errorMessage ?? "" : "");
			if (body || failed) {
				if (failed && firstError === null) firstError = events.length;
				events.push({ kind: message.role, content: body, failed });
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
	const offset = decodeCursor(cursor, version, events.length);
	const items = [];
	let bytes = 0;
	for (let index = offset; index < events.length && items.length < TIMELINE_PAGE_SIZE; index++) {
		const event = events[index];
		const item = event.kind === "tool"
			? { index, kind: "tool", name: preview(event.name, 128).text, outcome: preview(event.outcome, 64).text, failed: event.failed, firstError: index === firstError, args: preview(JSON.stringify(event.args)), result: preview(contentText(event.result)) }
			: { index, kind: event.kind, content: preview(event.content), failed: event.failed, firstError: index === firstError };
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
async function headerOf(root, path) {
	await safePath(root, path);
	const loaded = await readBounded(path, MAX_SESSION_BYTES, true);
	const header = loaded.firstRecord;
	return !loaded.firstNonemptyTooLong && header?.type === "session" && validSessionId(header.id) ? header : undefined;
}
async function catalog(root) {
	if (!(await statIfPresent(root))) return { sessions: [], limited: false };
	const paths = [], stack = [root];
	let visited = 0;
	while (stack.length && visited < MAX_SCAN_ENTRIES) {
		const directory = stack.pop();
		await safePath(root, directory);
		for await (const entry of await opendir(directory)) {
			if (++visited > MAX_SCAN_ENTRIES) break;
			const path = join(directory, entry.name);
			if (entry.isDirectory() && entry.name !== "observability") stack.push(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push({ path, info: await lstat(path) });
		}
	}
	paths.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
	const sessions = new Map(), duplicate = new Set();
	for (const { path, info } of paths.slice(0, MAX_SESSIONS)) {
		const header = await headerOf(root, path);
		if (!header) continue;
		if (sessions.has(header.id) || duplicate.has(header.id)) { sessions.delete(header.id); duplicate.add(header.id); continue; }
		const tracePath = join(dirname(path), "observability", `${basename(path, ".jsonl")}.trace.jsonl`);
		await safePath(root, tracePath);
		const trace = await statIfPresent(tracePath);
		sessions.set(header.id, { id: header.id, header, path, info, tracePath, trace, state: sessionState(info.mtimeMs, trace?.mtimeMs) });
	}
	return { sessions: [...sessions.values()], limited: paths.length > MAX_SESSIONS || visited >= MAX_SCAN_ENTRIES };
}
function versionOf(session) { return hash(JSON.stringify([session.id, session.info.ino, session.info.size, session.info.mtimeMs, session.trace?.size, session.trace?.mtimeMs])); }
async function load(root, session) {
	await safePath(root, session.path); await safePath(root, session.tracePath);
	const loaded = await loadSession(session.path, newSummary(), new Set(), MAX_SESSION_BYTES);
	if (loaded.reason) throw evalError(413, "session_unavailable_or_too_large");
	if (loaded.header.id !== session.id) throw evalError(409, "session_changed");
	const current = await lstat(session.path);
	const trace = await statIfPresent(session.tracePath);
	if (current.ino !== session.info.ino || current.mtimeMs !== session.info.mtimeMs || current.size !== session.info.size || trace?.size !== session.trace?.size || trace?.mtimeMs !== session.trace?.mtimeMs) throw evalError(409, "session_changed");
	return loaded;
}
function rowOf(session, loaded, labels) {
	const metrics = loaded ? metricsOf(loaded) : null;
	return {
		id: session.id, started: preview(session.header.timestamp, 64).text, state: session.state,
		request: loaded ? preview(sessionSummary(loaded.branch).request, 80).text : "",
		metrics: metrics ? { durationMs: metrics.durationMs, toolCalls: metrics.toolCalls, toolErrors: metrics.toolErrors, costUsd: metrics.costUsd, costPartial: metrics.costPartial, tokens: metrics.tokens } : null,
		findings: loaded ? loaded.findings.map(({ rule, status, count }) => ({ rule, status, count })) : [],
		annotation: labels.get(session.id) ? { verdict: labels.get(session.id).verdict, note: preview(labels.get(session.id).note, 500).text, failSet: labels.get(session.id).failSet === true } : null,
	};
}
export function createEvalService(root, directory = DEFAULT_EVAL_DIRECTORY) {
	return {
		async sessions(cursor, filter = "all") {
			if (!["all", "unlabeled", "fail", "failSet", "hits"].includes(filter)) throw evalError(400, "invalid_filter");
			const scanned = await catalog(root);
			const merged = await mergedLabels({ out: join(directory, "cards") });
			const labels = new Map(merged.rows.map((row) => [row.sessionId, row]));
			const version = hash(JSON.stringify(scanned.sessions.map((session) => session.id)));
			const offset = decodeCursor(cursor, version, scanned.sessions.length);
			const items = [];
			for (const session of scanned.sessions.slice(offset, offset + LIST_PAGE_SIZE)) {
				const annotation = labels.get(session.id);
				if ((filter === "unlabeled" && annotation) || (filter === "fail" && annotation?.verdict !== "fail") || (filter === "failSet" && !annotation?.failSet)) continue;
				try {
					const row = rowOf(session, await load(root, session), labels);
					if (filter !== "hits" || row.findings.some((finding) => finding.status === "hit")) items.push(row);
				}
				catch (error) {
					if (![409, 413].includes(error.status)) throw error;
					items.push({ ...rowOf(session, null, labels), unavailable: error.code });
				}
			}
			const next = Math.min(scanned.sessions.length, offset + LIST_PAGE_SIZE);
			const states = { active: 0, idle: 0, unknown: 0 };
			for (const session of scanned.sessions) states[session.state]++;
			return { items, total: scanned.sessions.length, states, limited: scanned.limited, nextCursor: next < scanned.sessions.length ? encodeCursor(next, version) : null };
		},
		async session(id, cursor) {
			if (!validSessionId(id)) throw evalError(400, "invalid_session_id");
			const session = (await catalog(root)).sessions.find((row) => row.id === id);
			if (!session) throw evalError(404, "session_not_found");
			const loaded = await load(root, session);
			const labels = new Map((await mergedLabels({ out: join(directory, "cards") })).rows.map((row) => [row.sessionId, row]));
			const summary = sessionSummary(loaded.branch);
			return { ...rowOf(session, loaded, labels), summary: { request: preview(summary.request), final: preview(summary.final) }, timeline: timelinePage(loaded.branch, loaded.trace.tools, cursor, versionOf(session)) };
		},
		async annotate(input) {
			let value; try { value = annotationInput(input); } catch { throw evalError(400, "invalid_annotation"); }
			const session = (await catalog(root)).sessions.find((row) => row.id === value.sessionId);
			if (!session) throw evalError(404, "session_not_found");
			if (session.state !== "idle") throw evalError(409, "session_not_idle");
			await safePath(root, session.path); await safePath(root, session.tracePath);
			const current = await lstat(session.path), trace = await statIfPresent(session.tracePath);
			if (sessionState(current.mtimeMs, trace?.mtimeMs) !== "idle") throw evalError(409, "session_not_idle");
			return writeAnnotation(directory, value);
		},
	};
}
