#!/usr/bin/env node
// 只读统计本机 rotom/Pi 会话（含 observability trace）的聚合 metadata，用于找优化点。
//
// 隐私边界（仓库是公开的，输出会被推送）：
// - 不输出 prompt、助手文本、thinking、工具参数、工具结果正文、错误正文、cwd、文件路径、URL。
// - 工具名、customType、provider/model、stopReason、trace attribute 名是代码标识符，原样输出（截断 64 字符）。
// - 会话只用 sha256(文件名) 前 10 位作 label；cwd 只用 sha256 前 10 位区分“项目”。
// - 错误正文只做本地正则归类，输出类别名，不输出文本。
// - 用户消息只做本地关键词命中计数（纠正/打断信号），不输出文本。
//
// 用法:
//   node extract-session-metrics.mjs [--root DIR] [--days 7] [--now ISO] [--out FILE] [--cases FILE]
// 默认 root = $PI_CODING_AGENT_DIR/sessions 或 ~/.pi/agent/sessions。
// --cases 额外写一份“本地专用”的会话 label -> 真实文件路径映射，供人工复查；该文件不得提交。

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const root = args.root ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions");
const days = Number(args.days ?? 7);
const now = args.now ? Date.parse(args.now) : Date.now();
const since = now - days * 86_400_000;

const CORRECTION_PATTERNS = [
	/不对|错了|不是这|不是我|重新|你没有|没有按|别再|不要再|又(错|没)|还是不行|还是没|为什么(又|没|要)|停下|停止|搞错|理解错|我说的是|回滚|撤销/u,
	/\b(wrong|incorrect|not what i|that's not|stop|revert|undo|you didn'?t|why did you|again\?|still (not|broken|fail))/iu,
];
const CONTINUE_PATTERNS = /^(继续|接着|go on|continue|keep going|下一步|然后呢)[\s。.!！]*$/iu;

const ERROR_CATEGORIES = [
	["rate_limit", /\b429\b|rate.?limit|too many requests|quota|限流|额度/iu],
	["overloaded", /\b(503|529)\b|overload|unavailable|capacity/iu],
	["context_overflow", /context.{0,20}(length|window|limit)|maximum context|too long|prompt is too long|token.{0,10}limit/iu],
	["auth", /\b(401|403)\b|unauthori[sz]ed|forbidden|auth|login|credential|token expired/iu],
	["connection", /connection_failed|caused by:|ECONN|ENOTFOUND|EAI_AGAIN|socket|TLS|tunnel|network/iu],
	["fetch_failed", /fetch failed/iu],
	["stream_terminated", /terminated|websocket|stream.{0,20}(closed|ended|interrupt)|premature/iu],
	["timeout", /timed? ?out|timeout|ETIMEDOUT/iu],
	["server_5xx", /\b5\d\d\b|internal server error|bad gateway/iu],
	["bad_request", /\b400\b|invalid|bad request|schema/iu],
	["aborted", /abort|cancel/iu],
];

const TOOL_ERROR_CATEGORIES = [
	["not_found", /ENOENT|no such file|not found|does not exist|不存在/iu],
	["edit_mismatch", /old_?str|oldText|could not find|not unique|occurs \d+ times|no match|did not match|未找到/iu],
	["permission", /EACCES|EPERM|permission denied|denied|not allowed|needs-approval|blocked/iu],
	["timeout", /timed? ?out|timeout/iu],
	["exit_code", /exit(ed)? (code|status)|code \d+|command failed/iu],
	["stale_or_observe", /stale|observe again|observationEpoch|ref (evicted|not found)|documentGeneration/iu],
	["validation", /validation|invalid|required|must be|expected .* (got|received)|argument/iu],
	["unknown_outcome", /\bunknown\b/iu],
	["aborted", /abort|cancel|interrupted/iu],
];

function parseArgs(list) {
	const out = {};
	for (let i = 0; i < list.length; i++) {
		const key = list[i];
		if (!key.startsWith("--")) continue;
		out[key.slice(2)] = list[i + 1];
		i++;
	}
	return out;
}

const sha = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 10);
const tag = (value) => (typeof value === "string" && value ? value.replace(/[^\w.:@/+-]/gu, "_").slice(0, 64) : "unknown");
const bytes = (value) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value ?? ""), "utf8");
const inc = (map, key, by = 1) => { map[key] = (map[key] ?? 0) + by; };
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const timestampMs = (entry) => {
	const entryTimestamp = entry?.timestamp;
	if (typeof entryTimestamp === "number" && Number.isFinite(entryTimestamp)) return entryTimestamp;
	const parsedEntryTimestamp = Date.parse(entryTimestamp ?? "");
	if (parsedEntryTimestamp) return parsedEntryTimestamp;
	const messageTimestamp = entry?.message?.timestamp;
	if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) return messageTimestamp;
	return Date.parse(messageTimestamp ?? "") || 0;
};

function classify(text, table) {
	if (typeof text !== "string" || !text) return "empty";
	for (const [name, pattern] of table) if (pattern.test(text)) return name;
	return "other";
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n");
}

function quantiles(values) {
	if (!values.length) return { n: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
	return { n: sorted.length, p50: at(0.5), p90: at(0.9), p95: at(0.95), max: sorted[sorted.length - 1], sum: Math.round(sorted.reduce((a, b) => a + b, 0)) };
}

function walk(dir, found = { sessions: [], traces: [] }) {
	let names;
	try { names = readdirSync(dir); } catch { return found; }
	for (const name of names) {
		const path = join(dir, name);
		let stat;
		try { stat = lstatSync(path); } catch { continue; }
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) walk(path, found);
		else if (name.endsWith(".trace.jsonl")) found.traces.push({ path, mtime: stat.mtimeMs });
		else if (name.endsWith(".jsonl")) found.sessions.push({ path, mtime: stat.mtimeMs });
	}
	return found;
}

function readLines(path) {
	const records = [];
	let bad = 0;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try { records.push(JSON.parse(line)); } catch { bad++; }
	}
	return { records, bad };
}

// ---------- 全局聚合 ----------
const fleet = {
	sessions: 0, subagentSessions: 0, projects: new Set(), badLines: 0,
	entryTypes: {}, customTypes: {}, customMessageTypes: {}, messageRoles: {},
	models: {}, stopReasons: {}, assistantErrorCategories: {}, assistantErrorOutcomes: { absorbedByRetry: {}, endedRun: {} }, thinkingLevels: {},
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
	usageByModel: {},
	tools: {}, toolErrorCategories: {}, argumentsErrors: 0,
	compactions: { count: 0, fromHook: 0, tokensBefore: [] , summaryBytes: [] }, branchSummaries: 0, contextEdits: 0,
	user: { messages: 0, bytes: [], corrections: 0, bareContinue: 0, afterAbort: 0, images: 0 },
	loops: { repeatedIdenticalCalls: 0, sessionsWithRepeats: 0, maxSameCallInSession: 0, errorStreaksGe3: 0, maxErrorStreak: 0 },
	responseGapMs: [], sessionDurationMin: [], assistantTurnsPerUserMsg: [],
	goal: { goals: 0, stops: {} },
	modelChanges: 0, thinkingChanges: 0,
	searchTools: { calls: 0, sessionsUsing: 0 },
};
const perSession = [];
const caseMap = [];

const { sessions, traces } = walk(root);
const sessionCandidates = [];
for (const file of sessions) {
	if (file.mtime < since) continue;
	const { records, bad } = readLines(file.path);
	fleet.badLines += bad;
	const header = records.find((r) => r?.type === "session");
	if (!header) continue;
	const lastTs = records.reduce((latest, record) => Math.max(latest, timestampMs(record)), 0);
	if (lastTs < since) continue;
	sessionCandidates.push({ file, records, header, headerTs: timestampMs(header) });
}
sessionCandidates.sort((a, b) => a.headerTs - b.headerTs);

const seenEntryIds = new Set();
for (const { file, records, header } of sessionCandidates) {
	const windowRecords = [];
	for (const record of records) {
		if (timestampMs(record) < since) continue;
		if (record?.id && seenEntryIds.has(record.id)) continue;
		if (record?.id) seenEntryIds.add(record.id);
		windowRecords.push(record);
	}
	if (!windowRecords.length) continue;
	const includedRecords = new Set(windowRecords);
	const firstTs = windowRecords.reduce((earliest, record) => Math.min(earliest, timestampMs(record)), Infinity);
	const lastTs = windowRecords.reduce((latest, record) => Math.max(latest, timestampMs(record)), 0);

	const label = sha(basename(file.path));
	caseMap.push({ label, path: file.path });
	fleet.sessions++;
	if (header.parentSession) fleet.subagentSessions++;
	if (header.cwd) fleet.projects.add(sha(header.cwd));

	const s = {
		label, project: header.cwd ? sha(header.cwd) : "none", subagent: Boolean(header.parentSession),
		startedAt: new Date(firstTs).toISOString().slice(0, 13), durationMin: Math.round((lastTs - firstTs) / 60_000),
		entries: windowRecords.length, userMessages: 0, corrections: 0, bareContinue: 0, assistantMessages: 0,
		toolCalls: 0, toolErrors: 0, toolResultBytes: 0, maxToolResultBytes: 0, aborted: 0, assistantErrors: 0,
		compactions: 0, maxSameCall: 0, maxErrorStreak: 0, tokens: 0, cacheRead: 0, input: 0, costUsd: 0,
		models: {}, topTools: {}, errorTools: {}, goalStops: {},
	};
	const callSignatures = {};
	const pendingCalls = new Map();
	const goalPrev = new Map();
	let errorStreak = 0;
	let pendingError;
	let lastStop = "";
	let assistantSinceUser = 0;
	let usedSearchTools = false;

	for (const entry of records) {
		if (!entry || typeof entry !== "object") continue;
		const included = includedRecords.has(entry);
		if (entry.type === "custom" && entry.customType === "goal-state" && entry.data?.goal) {
			const g = entry.data.goal;
			if (included) {
				inc(fleet.entryTypes, tag(entry.type));
				inc(fleet.customTypes, tag(entry.customType));
				if (!goalPrev.has(g.id)) fleet.goal.goals++;
				if (goalPrev.get(g.id) === "active" && g.status !== "active") {
					const key = `${tag(g.status)}/${tag(g.stopReason ?? "-")}/${tag(g.safetyPauseCause ?? "-")}`;
					inc(fleet.goal.stops, key);
					inc(s.goalStops, key);
				}
			}
			goalPrev.set(g.id, g.status);
			continue;
		}
		if (!included) continue;
		inc(fleet.entryTypes, tag(entry.type));
		if (entry.type === "custom") {
			inc(fleet.customTypes, tag(entry.customType));
			continue;
		}
		if (entry.type === "custom_message") { inc(fleet.customMessageTypes, tag(entry.customType)); continue; }
		if (entry.type === "model_change") { fleet.modelChanges++; continue; }
		if (entry.type === "thinking_level_change") { fleet.thinkingChanges++; continue; }
		if (entry.type === "branch_summary") { fleet.branchSummaries++; continue; }
		if (entry.type === "context_edit") { fleet.contextEdits++; continue; }
		if (entry.type === "compaction") {
			fleet.compactions.count++; s.compactions++;
			if (entry.fromHook) fleet.compactions.fromHook++;
			fleet.compactions.tokensBefore.push(num(entry.tokensBefore));
			fleet.compactions.summaryBytes.push(bytes(entry.summary));
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const m = entry.message;
		inc(fleet.messageRoles, tag(m.role));

		if (m.role === "user") {
			// An error still pending here was the run's last response: Pi did not recover it.
			if (pendingError) { inc(fleet.assistantErrorOutcomes.endedRun, pendingError); pendingError = undefined; }
			const text = textOf(m.content);
			fleet.user.messages++; s.userMessages++;
			fleet.user.bytes.push(bytes(text));
			if (Array.isArray(m.content)) fleet.user.images += m.content.filter((p) => p?.type === "image").length;
			if (CORRECTION_PATTERNS.some((p) => p.test(text))) { fleet.user.corrections++; s.corrections++; }
			if (CONTINUE_PATTERNS.test(text.trim())) { fleet.user.bareContinue++; s.bareContinue++; }
			if (lastStop === "aborted") fleet.user.afterAbort++;
			if (assistantSinceUser) fleet.assistantTurnsPerUserMsg.push(assistantSinceUser);
			assistantSinceUser = 0;
			continue;
		}

		if (m.role === "assistant") {
			// Pi keeps a retried attempt in raw history; a later response means the retry absorbed it.
			if (pendingError) { inc(fleet.assistantErrorOutcomes.absorbedByRetry, pendingError); pendingError = undefined; }
			s.assistantMessages++; assistantSinceUser++;
			const model = `${tag(m.provider)}/${tag(m.model)}`;
			inc(fleet.models, model); inc(s.models, model);
			inc(fleet.stopReasons, tag(m.stopReason));
			if (m.thinkingLevel) inc(fleet.thinkingLevels, tag(m.thinkingLevel));
			lastStop = m.stopReason;
			if (m.stopReason === "aborted") s.aborted++;
			if (m.stopReason === "error") {
				s.assistantErrors++;
				pendingError = classify(m.errorMessage, ERROR_CATEGORIES);
				inc(fleet.assistantErrorCategories, pendingError);
			}
			const u = m.usage ?? {};
			const cost = num(u.cost?.total);
			fleet.usage.input += num(u.input); fleet.usage.output += num(u.output);
			fleet.usage.cacheRead += num(u.cacheRead); fleet.usage.cacheWrite += num(u.cacheWrite);
			fleet.usage.reasoning += num(u.reasoning); fleet.usage.costUsd += cost;
			const bm = (fleet.usageByModel[model] ??= { responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
			bm.responses++; bm.input += num(u.input); bm.output += num(u.output); bm.cacheRead += num(u.cacheRead); bm.cacheWrite += num(u.cacheWrite); bm.costUsd += cost;
			s.tokens += num(u.totalTokens); s.cacheRead += num(u.cacheRead); s.input += num(u.input); s.costUsd += cost;
			for (const part of Array.isArray(m.content) ? m.content : []) {
				if (part?.type !== "toolCall") continue;
				const name = tag(part.name);
				fleet.tools[name] ??= { calls: 0, errors: 0, resultBytes: [], durationMs: [], sessions: new Set() };
				fleet.tools[name].calls++; fleet.tools[name].sessions.add(label);
				s.toolCalls++; inc(s.topTools, name);
				if (name === "search_tools") { fleet.searchTools.calls++; usedSearchTools = true; }
				if (part.argumentsError) fleet.argumentsErrors++;
				const sig = `${name}:${sha(JSON.stringify(part.arguments ?? {}))}`;
				callSignatures[sig] = (callSignatures[sig] ?? 0) + 1;
				pendingCalls.set(part.id, name);
			}
			continue;
		}

		if (m.role === "toolResult") {
			const name = tag(m.toolName ?? pendingCalls.get(m.toolCallId));
			const t = (fleet.tools[name] ??= { calls: 0, errors: 0, resultBytes: [], durationMs: [], sessions: new Set() });
			const size = bytes(textOf(m.content));
			t.resultBytes.push(size);
			if (typeof m.durationMs === "number") t.durationMs.push(m.durationMs);
			s.toolResultBytes += size; s.maxToolResultBytes = Math.max(s.maxToolResultBytes, size);
			if (m.isError) {
				t.errors++; s.toolErrors++; inc(s.errorTools, name);
				inc(fleet.toolErrorCategories, `${name}:${classify(textOf(m.content), TOOL_ERROR_CATEGORIES)}`);
				errorStreak++;
				s.maxErrorStreak = Math.max(s.maxErrorStreak, errorStreak);
			} else {
				if (errorStreak >= 3) fleet.loops.errorStreaksGe3++;
				errorStreak = 0;
			}
			continue;
		}
	}
	if (errorStreak >= 3) fleet.loops.errorStreaksGe3++;
	// Errors at the end of the window or file also ended their run.
	if (pendingError) inc(fleet.assistantErrorOutcomes.endedRun, pendingError);
	fleet.loops.maxErrorStreak = Math.max(fleet.loops.maxErrorStreak, s.maxErrorStreak);

	// 用户回复间隔：助手最后一次响应到下一条用户消息（粗略反映用户等待/介入节奏）
	let prevAssistant = 0;
	for (const entry of windowRecords) {
		const m = entry?.message;
		if (entry?.type !== "message" || !m) continue;
		const ts = num(m.timestamp) || Date.parse(entry.timestamp) || 0;
		if (m.role === "assistant") prevAssistant = ts;
		else if (m.role === "user" && prevAssistant && ts > prevAssistant) fleet.responseGapMs.push(ts - prevAssistant);
	}

	const repeats = Object.values(callSignatures).filter((n) => n >= 3);
	s.maxSameCall = Math.max(0, ...Object.values(callSignatures));
	if (repeats.length) fleet.loops.sessionsWithRepeats++;
	fleet.loops.repeatedIdenticalCalls += repeats.reduce((a, n) => a + n - 1, 0);
	fleet.loops.maxSameCallInSession = Math.max(fleet.loops.maxSameCallInSession, s.maxSameCall);
	if (usedSearchTools) fleet.searchTools.sessionsUsing++;
	fleet.sessionDurationMin.push(s.durationMin);
	s.costUsd = Number(s.costUsd.toFixed(4));
	s.cacheHitRatio = s.input + s.cacheRead ? Number((s.cacheRead / (s.input + s.cacheRead)).toFixed(3)) : null;
	s.topTools = top(s.topTools, 8);
	s.errorTools = top(s.errorTools, 8);
	perSession.push(s);
}

// ---------- trace ----------
const trace = { files: 0, spans: {}, statuses: {}, providerErrors: {}, providerHttp: {}, endReasons: {}, ttfcMs: [], providerMs: [], toolMs: {}, toolOutcomes: {}, toolFault: {}, compactionReasons: {}, shutdownReasons: {}, runtimeVersions: {}, schemaChanged: 0, truncatedResults: 0 };
for (const file of traces) {
	if (file.mtime < since) continue;
	trace.files++;
	const { records } = readLines(file.path);
	const spanStarts = new Map();
	for (const r of records) {
		if (r?.kind !== "span_end" && r?.kind !== "span_start") continue;
		const ownAttributes = r.attributes ?? {};
		if (r.kind === "span_start" && r.spanId) spanStarts.set(r.spanId, ownAttributes);
		const a = { ...(spanStarts.get(r.spanId) ?? {}), ...ownAttributes };
		const ts = Date.parse(r.timestamp ?? "") || 0;
		if (ts && ts < since) continue;
		if (ownAttributes["pi.runtime.version"]) inc(trace.runtimeVersions, tag(ownAttributes["rotom.product.version"] ?? ownAttributes["pi.runtime.version"]));
		if (r.kind !== "span_end") continue;
		inc(trace.spans, tag(r.name));
		inc(trace.statuses, `${tag(r.name)}:${tag(r.status)}`);
		if (r.name === "pi.ai.request") {
			if (typeof r.durationMs === "number") trace.providerMs.push(r.durationMs);
			if (a["pi.ai.stream.time_to_first_content_ms"] !== undefined) trace.ttfcMs.push(num(a["pi.ai.stream.time_to_first_content_ms"]));
			if (a["pi.ai.error.category"]) inc(trace.providerErrors, tag(a["pi.ai.error.category"]));
			if (a["pi.ai.http.status_code"] || a["pi.ai.error.http_status"]) inc(trace.providerHttp, String(a["pi.ai.error.http_status"] ?? a["pi.ai.http.status_code"]));
			if (a["pi.ai.request.end_reason"]) inc(trace.endReasons, tag(a["pi.ai.request.end_reason"]));
			if (a["pi.tools.schema_changed"] === true) trace.schemaChanged++;
		}
		if (r.name === "pi.tool.execute") {
			const name = tag(a["pi.tool.name"]);
			(trace.toolMs[name] ??= []).push(num(r.durationMs));
			inc(trace.toolOutcomes, `${name}:${tag(a["pi.tool.outcome"] ?? a["pi.tool.execution_outcome"] ?? r.status)}`);
			if (a["pi.tool.fault_side"]) inc(trace.toolFault, `${name}:${tag(a["pi.tool.fault_side"])}`);
			if (a["pi.tool.result_truncated"] === true) trace.truncatedResults++;
		}
		if (r.name === "pi.session.compaction" && a["pi.compaction.reason"]) inc(trace.compactionReasons, tag(a["pi.compaction.reason"]));
		if (r.name === "pi.session.runtime" && a["pi.session.shutdown_reason"]) inc(trace.shutdownReasons, tag(a["pi.session.shutdown_reason"]));
	}
}

function top(map, n) {
	return Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n));
}

// ---------- 输出 ----------
const toolTable = Object.fromEntries(Object.entries(fleet.tools).sort((a, b) => b[1].calls - a[1].calls).map(([name, t]) => [name, {
	calls: t.calls, errors: t.errors, errorRate: t.calls ? Number((t.errors / t.calls).toFixed(3)) : null,
	sessions: t.sessions.size, resultBytes: quantiles(t.resultBytes), durationMs: quantiles(t.durationMs),
}]));

const score = (s) => s.toolErrors * 2 + s.corrections * 5 + s.aborted * 4 + s.assistantErrors * 3 + Math.max(0, s.maxSameCall - 2) * 3 + Math.max(0, s.maxErrorStreak - 2) * 3 + s.bareContinue;
const ranked = [...perSession].sort((a, b) => score(b) - score(a));

const output = {
	schema: "rotom-session-review-metrics/v1",
	generatedAt: new Date(now).toISOString(),
	windowDays: days,
	privacy: "aggregate metadata only; no prompt/assistant/tool text, arguments, paths, cwd or error bodies",
	fleet: {
		sessions: fleet.sessions, subagentSessions: fleet.subagentSessions, projects: fleet.projects.size, unparsableLines: fleet.badLines,
		entryTypes: fleet.entryTypes, customTypes: top(fleet.customTypes, 40), customMessageTypes: top(fleet.customMessageTypes, 40), messageRoles: fleet.messageRoles,
		models: fleet.models, thinkingLevels: fleet.thinkingLevels, modelChanges: fleet.modelChanges, thinkingChanges: fleet.thinkingChanges,
		stopReasons: fleet.stopReasons, assistantErrorCategories: fleet.assistantErrorCategories, assistantErrorOutcomes: fleet.assistantErrorOutcomes,
		usage: { ...fleet.usage, costUsd: Number(fleet.usage.costUsd.toFixed(4)), cacheHitRatio: fleet.usage.input + fleet.usage.cacheRead ? Number((fleet.usage.cacheRead / (fleet.usage.input + fleet.usage.cacheRead)).toFixed(3)) : null },
		usageByModel: Object.fromEntries(Object.entries(fleet.usageByModel).map(([k, v]) => [k, { ...v, costUsd: Number(v.costUsd.toFixed(4)) }])),
		compactions: { count: fleet.compactions.count, fromHook: fleet.compactions.fromHook, tokensBefore: quantiles(fleet.compactions.tokensBefore), summaryBytes: quantiles(fleet.compactions.summaryBytes) },
		branchSummaries: fleet.branchSummaries, contextEdits: fleet.contextEdits,
		user: { messages: fleet.user.messages, bytes: quantiles(fleet.user.bytes), images: fleet.user.images, correctionKeywordHits: fleet.user.corrections, bareContinue: fleet.user.bareContinue, afterAbort: fleet.user.afterAbort },
		assistantResponsesPerUserMessage: quantiles(fleet.assistantTurnsPerUserMsg),
		userReplyGapMs: quantiles(fleet.responseGapMs), sessionDurationMin: quantiles(fleet.sessionDurationMin),
		loops: fleet.loops, argumentsErrors: fleet.argumentsErrors, searchTools: fleet.searchTools,
		goal: { goals: fleet.goal.goals, stopsFromActive: top(fleet.goal.stops, 30) },
		tools: toolTable, toolErrorCategories: top(fleet.toolErrorCategories, 60),
	},
	trace: {
		files: trace.files, runtimeVersions: trace.runtimeVersions, spans: trace.spans, statuses: trace.statuses,
		providerRequestMs: quantiles(trace.providerMs), timeToFirstContentMs: quantiles(trace.ttfcMs),
		providerErrorCategories: trace.providerErrors, providerHttpStatus: trace.providerHttp, providerEndReasons: trace.endReasons,
		toolSchemaChangedRequests: trace.schemaChanged, truncatedToolResults: trace.truncatedResults,
		toolDurationMs: Object.fromEntries(Object.entries(trace.toolMs).map(([k, v]) => [k, quantiles(v)])),
		toolOutcomes: top(trace.toolOutcomes, 80), toolFaultSide: top(trace.toolFault, 40),
		compactionReasons: trace.compactionReasons, shutdownReasons: trace.shutdownReasons,
	},
	sessions: ranked.map((s) => ({ ...s, frictionScore: score(s) })),
};

const json = `${JSON.stringify(output, null, 2)}\n`;
if (args.out) writeFileSync(args.out, json); else process.stdout.write(json);
if (args.cases) writeFileSync(args.cases, `${JSON.stringify(ranked.map((s) => ({ label: s.label, path: caseMap.find((c) => c.label === s.label)?.path, frictionScore: score(s) })), null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`scanned ${sessions.length} session files / ${traces.length} trace files under root; ${fleet.sessions} sessions in last ${days} days\n`);
