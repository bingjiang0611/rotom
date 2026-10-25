#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, unlink, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { evaluateSession, RULE_IDS } from "./trace-assertions.mjs";
import { computeAgreement, renderAgreementMarkdown } from "./agreement.mjs";
import { runReview } from "./review.mjs";
import { aggregateMetrics, focusCandidate, sessionMetrics } from "./session-metrics.mjs";
import { aggregateBreakdown, editFailureRows, PROVIDER_SPAN, providerErrorRows, TOOL_SPAN, toolCallInfo, toolErrorRows, TOP_COMBINATIONS, TOP_VALUES } from "./error-breakdown.mjs";
import { classifyEditError } from "../../extensions/coding-policy/edit-error-code.mjs";

const MAX_FILE = 256 * 1024 * 1024;
const MAX_LINE = 64 * 1024 * 1024;
const DEFAULT_OUT = join(homedir(), ".rotom/evals/cards");
const SILENT_ENTRY_TYPES = new Set(["custom", "context_edit", "label", "session_info", "thinking_level_change", "usage"]);
const EMPTY_LABEL = "<!-- label:begin -->\nverdict:\ncategories:\nnote:\n<!-- label:end -->\n";

async function statIfPresent(path) {
	try { return await lstat(path); }
	catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

async function rejectGit(path) {
	for (let current = path; ; current = dirname(current)) {
		if (await statIfPresent(join(current, ".git"))) throw new Error("Output must be outside Git worktrees");
		if (dirname(current) === current) return;
	}
}

async function outputDirectory(path) {
	const absolute = resolve(path);
	const info = await statIfPresent(absolute);
	if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("Invalid output directory");
	// Check both lexical and canonical ancestry, including when the leaf does not exist yet.
	await rejectGit(absolute);
	let ancestor = absolute;
	while (!(await statIfPresent(ancestor))) ancestor = dirname(ancestor);
	const canonical = resolve(await realpath(ancestor), relative(ancestor, absolute));
	await rejectGit(canonical);
	return canonical;
}

async function readBounded(path) {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("Input must be a regular file");
		if (info.size > MAX_FILE) return { oversized: true, records: [], errors: 0, badJson: 0, lineTooLong: 0 };
		const records = [];
		let badJson = 0;
		let lineTooLong = 0;
		let firstRecordParsed = false;
		let firstRecord;
		let sawNonemptyLine = false;
		let firstNonemptyTooLong = false;
		let lineHasContent = false;
		let lineDecoder = new StringDecoder("utf8");
		let segments = [];
		let lineBytes = 0;
		function finishLine() {
			if (!lineHasContent) lineHasContent = lineDecoder.end().trim().length > 0;
			if (lineHasContent && !sawNonemptyLine) {
				sawNonemptyLine = true;
				firstNonemptyTooLong = lineBytes > MAX_LINE;
			}
			if (lineBytes > MAX_LINE) lineTooLong++;
			else {
				const line = Buffer.concat(segments, lineBytes).toString("utf8").trim();
				if (line) {
					try {
						const record = JSON.parse(line);
						// Pi skips blank/malformed lines and falsy parsed values while locating a header.
						if (record && !firstRecordParsed) { firstRecord = record; firstRecordParsed = true; }
						if (!record || typeof record !== "object" || Array.isArray(record)) badJson++;
						else records.push(record);
					} catch { badJson++; }
				}
			}
			lineHasContent = false;
			lineDecoder = new StringDecoder("utf8");
			segments = [];
			lineBytes = 0;
		}
		// Snapshot the byte boundary, not the whole file. Discard oversized lines until
		// their newline; readline would buffer them before we could enforce MAX_LINE.
		if (info.size > 0) {
			const stream = handle.createReadStream({ autoClose: false, start: 0, end: info.size - 1, highWaterMark: 64 * 1024 });
			for await (const chunk of stream) {
				for (let start = 0; start < chunk.length;) {
					const newline = chunk.indexOf(10, start);
					const end = newline < 0 ? chunk.length : newline;
					const segment = chunk.subarray(start, end);
					lineBytes += segment.length;
					if (!lineHasContent) lineHasContent = lineDecoder.write(segment).trim().length > 0;
					if (lineBytes <= MAX_LINE) segments.push(segment);
					else segments = [];
					if (newline >= 0) finishLine();
					start = end + 1;
				}
			}
			if (lineBytes > 0) finishLine();
		}
		return { oversized: false, records, errors: badJson + lineTooLong, badJson, lineTooLong, firstRecord, firstRecordParsed, firstNonemptyTooLong };
	} finally { await handle.close(); }
}

async function discover(root, since, limit) {
	const files = [];
	async function walk(directory) {
		for await (const entry of await opendir(directory)) {
			const path = join(directory, entry.name);
			if (entry.isDirectory() && entry.name !== "observability") await walk(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				const info = await lstat(path);
				if (info.mtimeMs < since) continue;
				files.push({ path, mtime: info.mtimeMs });
				files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
				if (files.length > limit) files.pop();
			}
		}
	}
	await walk(root);
	return files;
}

function currentBranch(records, summary) {
	const entries = [];
	for (const entry of records) {
		if (typeof entry.type !== "string") { summary.badJson++; continue; }
		if (typeof entry.id !== "string" || (entry.parentId !== null && typeof entry.parentId !== "string")) { summary.entryMissingId++; continue; }
		entries.push(entry);
	}
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const seen = new Set();
	const branch = [];
	let entry = entries.at(-1);
	while (entry) {
		if (seen.has(entry.id)) { summary.cycle++; break; }
		seen.add(entry.id);
		branch.push(entry);
		if (entry.parentId === null) break;
		entry = byId.get(entry.parentId);
		if (!entry) summary.danglingParent++;
	}
	return branch.reverse();
}

async function readTrace(sessionPath, summary) {
	const path = join(dirname(sessionPath), "observability", `${basename(sessionPath, ".jsonl")}.trace.jsonl`);
	const info = await statIfPresent(path);
	if (!info) return { status: "missing", tools: new Map(), records: [] };
	const loaded = await readBounded(path);
	summary.traceParseErrors += loaded.errors;
	let partial = loaded.oversized || loaded.errors > 0;
	const spans = new Map();
	for (const record of loaded.records) {
		if (record.schema !== "rotom-local-trace/v1" || typeof record.traceId !== "string" ||
			typeof record.spanId !== "string" || !["span_start", "span_end"].includes(record.kind)) {
			summary.traceParseErrors++; partial = true; continue;
		}
		if (record.name !== "pi.tool.execute") continue;
		const key = JSON.stringify([record.traceId, record.spanId]);
		const span = spans.get(key) ?? { start: {}, end: {}, ended: false };
		if (record.kind === "span_start") span.start = record.attributes ?? {};
		else { span.end = record.attributes ?? {}; span.ended = true; }
		spans.set(key, span);
	}
	const tools = new Map();
	for (const span of spans.values()) {
		const attributes = { ...span.start, ...span.end };
		if (!span.ended) partial = true;
		const digest = attributes["pi.tool.call_id_digest"];
		if (typeof digest === "string") tools.set(digest, span.ended ? attributes : {});
	}
	// Raw records are returned for metadata-only breakdowns; callers that only
	// need tool attributes ignore them.
	return { status: partial ? "partial" : "ok", tools, records: loaded.records };
}

function truncate(value, maximum) {
	const text = String(value);
	const characters = Array.from(text);
	return characters.length > maximum ? `${characters.slice(0, maximum).join("")}…[截断 ${characters.length - maximum} 字符]` : text;
}

function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => part.type === "text" ? part.text : part.type === "image" ? "(image)" : "").filter(Boolean).join("\n");
}

// Quoted source text cannot create a real label delimiter or raw HTML in the card.
function quote(text) {
	return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").split("\n").map((line) => `> ${line}`).join("\n");
}

function increment(counts, key) { counts[key] = (counts[key] ?? 0) + 1; }

function renderCard(header, path, branch, trace, summary, findings) {
	const messages = branch.filter((entry) => entry.type === "message").map((entry) => entry.message);
	const assistants = messages.filter((message) => message?.role === "assistant");
	const results = new Map(messages.filter((message) => message?.role === "toolResult").map((message) => [message.toolCallId, message]));
	const tokens = { input: 0, output: 0, cacheRead: 0 };
	const stopReasons = Object.create(null);
	const toolErrors = Object.create(null);
	const models = new Set();
	let toolCalls = 0;
	for (const message of assistants) {
		if (message.provider && message.model) models.add(`${message.provider}/${message.model}`);
		increment(stopReasons, message.stopReason ?? "unknown");
		for (const key of Object.keys(tokens)) if (Number.isFinite(message.usage?.[key])) tokens[key] += message.usage[key];
	}
	const process = [];
	let turn = 0;
	for (const entry of branch) {
		if (entry.type === "compaction") { process.push(`- 此处压缩，tokensBefore=${entry.tokensBefore}`); continue; }
		if (entry.type === "model_change") {
			models.add(`${entry.provider}/${entry.modelId}`);
			process.push(quote(`model_change: ${entry.provider}/${entry.modelId}`)); continue;
		}
		if (entry.type === "custom_message") {
			process.push(quote(`custom_message[${entry.customType}]：${truncate(contentText(entry.content), 300).replace(/\r?\n/g, " ")}`)); continue;
		}
		if (entry.type === "branch_summary") {
			process.push(quote(`branch_summary：${truncate(entry.summary, 300).replace(/\r?\n/g, " ")}`)); continue;
		}
		if (SILENT_ENTRY_TYPES.has(entry.type)) continue;
		if (entry.type !== "message") { summary.unknownEntries++; continue; }
		const message = entry.message;
		if (!message) { summary.messageMissing++; continue; }
		if (message.role === "system") continue;
		if (message.role === "bashExecution") {
			process.push(quote(`$ ${truncate(message.command, 200)} → exit=${message.exitCode ?? "unknown"}${message.cancelled ? " cancelled" : ""} · 输出：${truncate(message.output, 300)}`.replace(/\r?\n/g, " "))); continue;
		}
		if (message.role === "custom") {
			process.push(quote(`custom_message[${message.customType}]：${truncate(contentText(message.content), 300).replace(/\r?\n/g, " ")}`)); continue;
		}
		if (!["user", "assistant", "toolResult"].includes(message.role)) { summary.unknownEntries++; continue; }
		if (message.role === "user") {
			process.push(`### 第 ${++turn} 轮 · user`);
			if (turn > 1) process.push(quote(truncate(contentText(message.content), 1000)));
		} else if (message.role === "assistant") {
			const response = contentText(message.content);
			if (response) process.push(quote(`assistant：${truncate(response, 400)}`));
			const parts = Array.isArray(message.content) ? message.content : [];
			const thinking = parts.filter((part) => part.type === "thinking").reduce((sum, part) => sum + Array.from(part.thinking ?? "").length, 0);
			if (thinking) process.push(`- (thinking ${thinking} 字符)`);
			for (const call of parts.filter((part) => part.type === "toolCall")) {
				toolCalls++;
				const digest = typeof call.id === "string" ? createHash("sha256").update(call.id).digest("hex") : "";
				const attributes = trace.tools.get(digest) ?? {};
				const outcome = attributes["pi.tool.outcome"] ?? "unknown";
				if (attributes["pi.tool.outcome"] && outcome !== "ok") increment(toolErrors, outcome);
				const result = results.get(call.id);
				process.push(quote(`🔧 ${call.name} ${truncate(JSON.stringify(call.arguments), 200)} → outcome=${outcome} fault=${attributes["pi.tool.fault_side"] ?? "unknown"} · 结果：${result ? truncate(contentText(result.content), 300) : "(missing)"}`));
			}
		}
	}
	const elapsed = Date.parse(branch.at(-1)?.timestamp) - Date.parse(branch[0]?.timestamp);
	const fields = {
		session: header.id, file: path, cwd: header.cwd ?? null, started: header.timestamp ?? null,
		duration: Number.isFinite(elapsed) ? `${elapsed}ms` : "unknown", models: [...models], turns: assistants.length,
		tool_calls: toolCalls, tool_errors: toolErrors, tokens, stop_reasons: stopReasons, trace: trace.status,
		findings: Object.fromEntries(findings.map(({ rule, status }) => [rule, status])),
	};
	const metadata = Object.entries(fields).map(([key, value]) => `${key}: ${key === "trace" ? value : JSON.stringify(value)}`).join("\n");
	const request = contentText(messages.find((message) => message?.role === "user")?.content);
	const lastAssistant = assistants.at(-1);
	const final = contentText(lastAssistant?.content) || `(最后一条 assistant 无文本，stopReason=${lastAssistant?.stopReason ?? "unknown"})`;
	const hits = findings.filter(({ status }) => status === "hit").map(({ rule, count, evidence }) => `- ${rule}（count=${count}）：${truncate(JSON.stringify(evidence), 600)}`);
	return `---\n${metadata}\n---\n\n## 用户请求\n${quote(truncate(request, 2000))}\n\n## 过程\n${process.join("\n\n")}\n\n## 规则命中\n${hits.join("\n") || "(无)"}\n\n## 最终回复\n${quote(truncate(final, 4000))}\n\n`;
}

function parseLabel(card) {
	const start = card.lastIndexOf("\n<!-- label:begin -->");
	const block = start < 0 ? "" : card.slice(start + 1);
	const match = /^<!-- label:begin -->\r?\nverdict:([^\r\n]*)\r?\ncategories:([^\r\n]*)\r?\nnote:([\s\S]*?)\r?\n<!-- label:end -->\s*$/.exec(block);
	// Fail closed rather than silently discarding annotations after an accidental format edit.
	if (!match) throw new Error("Invalid label block");
	return { block, verdict: match[1].trim(), categories: [...new Set(match[2].split(/[,，]/).map((value) => value.trim()).filter(Boolean))], note: match[3].trim() };
}

async function readCard(path, encoding = "utf8") {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try { return await handle.readFile(encoding); }
	finally { await handle.close(); }
}

async function privateWrite(path, content) {
	const info = await statIfPresent(path);
	if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("Invalid output file");
	const temporary = join(dirname(path), `.session-cards-${randomUUID()}.tmp`);
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(content);
		await handle.close();
		await rename(temporary, path);
	} finally {
		await handle.close();
		await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
	}
}

function newSummary() {
	return {
		generated: 0, skipped: 0, skippedOversized: 0, skippedInvalidHeader: 0, skippedEmpty: 0, skippedDuplicate: 0,
		traceMissing: 0, tracePartial: 0, parseErrors: 0, sessionParseErrors: 0, traceParseErrors: 0, unknownEntries: 0,
		invalidHeaderKinds: Object.create(null), invalidHeaderKeySets: Object.create(null), sessionVersions: { "1": 0, "2": 0, "3": 0, missing: 0 },
		badJson: 0, lineTooLong: 0, entryMissingId: 0, danglingParent: 0, cycle: 0, messageMissing: 0,
		findings: Object.fromEntries(RULE_IDS.map((rule) => [rule, { hit: 0, clear: 0, unknown: 0 }])),
	};
}

function finishSummary(summary) {
	summary.skipped = summary.skippedOversized + summary.skippedInvalidHeader + summary.skippedEmpty + summary.skippedDuplicate;
	summary.sessionParseErrors = summary.badJson + summary.lineTooLong + summary.entryMissingId + summary.danglingParent + summary.cycle + summary.messageMissing;
	summary.parseErrors = summary.sessionParseErrors + summary.traceParseErrors;
	return summary;
}

function countSkip(summary, reason) {
	if (reason === "oversized") summary.skippedOversized++;
	else if (reason === "invalidHeader") summary.skippedInvalidHeader++;
	else if (reason === "empty") summary.skippedEmpty++;
	else summary.skippedDuplicate++;
}

/** Shared by build and stats: bounded read, header validation, branch reconstruction,
 * trace association and rule evaluation. Never writes the session or trace input. */
async function loadSession(path, summary, seen) {
	const loaded = await readBounded(path);
	summary.badJson += loaded.badJson;
	summary.lineTooLong += loaded.lineTooLong;
	if (loaded.oversized) return { reason: "oversized" };
	const header = loaded.firstRecord;
	// A Pi-valid header ID must also stay within one output filename.
	const safeId = typeof header?.id === "string" && !/[/\\\u0000-\u001f\u007f]/.test(header.id) && !header.id.includes("..");
	if (loaded.firstNonemptyTooLong || header?.type !== "session" || !safeId) {
		let kind = "other";
		if (loaded.firstNonemptyTooLong) kind = "line-too-long";
		else if (!loaded.firstRecordParsed) kind = "unparseable";
		else if (header?.type === undefined) kind = "missing-type";
		else if (header.type === "session") kind = "session-bad-id";
		else if (typeof header.type === "string" && /^[a-z_]{1,32}$/.test(header.type)) kind = header.type;
		increment(summary.invalidHeaderKinds, kind);
		const keys = header && typeof header === "object" && !Array.isArray(header) ? Object.keys(header).sort() : undefined;
		const keySet = keys?.every((key) => /^[A-Za-z_]{1,32}$/.test(key)) ? keys.join(",") : "other";
		increment(summary.invalidHeaderKeySets, keySet);
		return { reason: "invalidHeader" };
	}
	const entries = loaded.records.slice(1);
	if ((header.version ?? 1) < 2) {
		// v1 is a linear log. Only migrate this in-memory copy, never the source file.
		for (const [index, entry] of entries.entries()) {
			entry.id = `v1-${index}`;
			entry.parentId = index === 0 ? null : `v1-${index - 1}`;
		}
	}
	const branch = currentBranch(entries, summary);
	if (!branch.length) return { reason: "empty" };
	if (seen.has(header.id)) return { reason: "duplicate" };
	const trace = await readTrace(path, summary);
	if (trace.status === "missing") summary.traceMissing++;
	if (trace.status === "partial") summary.tracePartial++;
	return { header, branch, trace, findings: evaluateSession({ branch, traceTools: trace.tools, traceStatus: trace.status }) };
}

function metricsOf(loaded) {
	return sessionMetrics({ header: loaded.header, branch: loaded.branch, traceTools: loaded.trace.tools, traceStatus: loaded.trace.status, findings: loaded.findings });
}

async function openSessionRoot(root) {
	const info = await lstat(resolve(root));
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid session root");
	return realpath(root);
}

/** Build private cards without changing session or trace inputs. */
export async function buildCards({ root = join(homedir(), ".pi/agent/sessions"), out = DEFAULT_OUT, since, limit = 50, focus = false } = {}) {
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Limit must be between 1 and 500");
	if (since !== undefined && !/^\d+[dh]$/.test(since)) throw new Error("Since must be Nd or Nh");
	const cutoff = since === undefined ? -Infinity : Date.now() - Number(since.slice(0, -1)) * (since.endsWith("d") ? 86400000 : 3600000);
	root = await openSessionRoot(root);
	out = await outputDirectory(out);
	const rel = relative(root, out);
	if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) throw new Error("Output must not be inside session root");
	await mkdir(out, { recursive: true, mode: 0o700 });
	await chmod(out, 0o700);
	const summary = newSummary();
	// Focus counters only appear when --focus is used, so plain builds keep the old shape.
	const focusSummary = { focusScanned: 0, focusMatched: 0, focusConditions: { toolErrors: 0, ruleHit: 0, endedWithoutFinalText: 0, endedOnProviderError: 0 } };
	const seen = new Set();
	// In focus mode --limit caps generated cards, so scan the whole 500-session budget.
	for (const { path } of await discover(root, cutoff, focus ? 500 : limit)) {
		const loaded = await loadSession(path, summary, seen);
		if (loaded.reason) { countSkip(summary, loaded.reason); continue; }
		const { header, branch, trace, findings } = loaded;
		seen.add(header.id);
		if (focus) {
			focusSummary.focusScanned++;
			const candidate = focusCandidate(metricsOf(loaded));
			for (const [condition, hit] of Object.entries(candidate.conditions)) if (hit) focusSummary.focusConditions[condition]++;
			if (!candidate.matched) continue;
			if (summary.generated >= limit) break;
			focusSummary.focusMatched++;
		}
		const cardPath = join(out, `${header.id}.md`);
		let label = EMPTY_LABEL;
		if (await statIfPresent(cardPath)) {
			const existing = parseLabel(await readCard(cardPath));
			if (existing.verdict) label = existing.block;
		}
		await privateWrite(cardPath, renderCard(header, path, branch, trace, summary, findings) + label);
		for (const { rule, status } of findings) summary.findings[rule][status]++;
		summary.generated++;
		if (header.version === undefined || [1, 2, 3].includes(header.version)) increment(summary.sessionVersions, header.version ?? "missing");
	}
	return finishSummary(focus ? Object.assign(summary, focusSummary) : summary);
}

function markdownCell(value) {
	return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatStat(stat, digits) {
	if (stat.n === 0) return "n/a (n=0)";
	const round = (value) => digits === 0 ? Math.round(value) : Number(value.toFixed(digits));
	return `${round(stat.median)} / ${round(stat.p90)} (n=${stat.n})`;
}

function formatShare(stat) {
	return stat.n === 0 ? "n/a (n=0)" : `${stat.count}/${stat.n} (${(stat.share * 100).toFixed(1)}%)`;
}

function formatRate(rate) {
	if (rate.n === 0 || rate.rate === null) return "n/a (n=0)";
	return `${(rate.rate * 100).toFixed(1)}% (${rate.errors}/${rate.endedSpans} span, n=${rate.n})`;
}

function renderStatsMarkdown(aggregate, top, sessions) {
	const header = ["周", "会话", "toolCalls 中位 / p90", "时长 ms 中位 / p90", "tokens(in+out) 中位 / p90", "总出错率", "无最终文本", "provider 错误", ...RULE_IDS, "costUsd"];
	const row = (group) => [
		group.week ?? group.model, group.sessions, formatStat(group.toolCalls, 0), formatStat(group.durationMs, 0),
		formatStat(group.tokens, 0), formatRate(group.toolErrorRate), formatShare(group.endedWithoutFinalText),
		formatShare(group.endedOnProviderError), ...RULE_IDS.map((rule) => formatShare(group.ruleHits[rule])),
		group.costUsd.total === null ? "n/a" : `${group.costUsd.total.toFixed(4)}${group.costUsd.partial ? " (partial)" : ""}`,
	];
	const table = (title, groups, first) => [
		`## ${title}`, "",
		`| ${header.map(markdownCell).join(" | ")} |`,
		`| ${header.map(() => "---").join(" | ")} |`,
		...groups.map((group) => `| ${row({ ...group, [first]: group[first] }).map(markdownCell).join(" | ")} |`),
	].join("\n");
	return [
		"# 会话效率统计", "",
		`会话数 ${sessions}；无 ISO 周的会话 ${aggregate.unknownWeek}；无模型信息的会话 ${aggregate.unknownModel}。`,
		"null 不参与计算，每列括号里的 n 是该列样本数。总出错率 = 各会话 toolErrors 之和 / 已结束 span 之和。", "",
		table("按 ISO 周", aggregate.weeks, "week"), "",
		table("按 provider/model（同一会话使用多个模型时各计一次）", aggregate.models, "model"), "",
		"## 工具出错最多的 10 个会话", "",
		"| session | 开始时间 | toolCalls | toolErrors | toolErrorRate |",
		"| --- | --- | --- | --- | --- |",
		...top.map((item) => `| ${markdownCell(item.sessionId)} | ${markdownCell(item.startedAt ?? "unknown")} | ${item.toolCalls} | ${item.toolErrors} | ${item.toolErrorRate === null ? "n/a" : (item.toolErrorRate * 100).toFixed(1) + "%"} |`),
		"", "",
	].join("\n");
}

/** Aggregate efficiency metrics by week and model; the per-session rows and the
 * session-id list stay in private files, never on stdout. */
export async function sessionStats({ root = join(homedir(), ".pi/agent/sessions"), since = "28d", out = DEFAULT_OUT } = {}) {
	if (!/^\d+[dh]$/.test(since)) throw new Error("Since must be Nd or Nh");
	const cutoff = Date.now() - Number(since.slice(0, -1)) * (since.endsWith("d") ? 86400000 : 3600000);
	root = await openSessionRoot(root);
	out = await outputDirectory(out);
	const rel = relative(root, out);
	if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) throw new Error("Output must not be inside session root");
	await mkdir(out, { recursive: true, mode: 0o700 });
	await chmod(out, 0o700);
	await rejectGit(dirname(out));
	const summary = newSummary();
	const seen = new Set();
	const rows = [];
	for (const { path } of await discover(root, cutoff, 500)) {
		const loaded = await loadSession(path, summary, seen);
		if (loaded.reason) { countSkip(summary, loaded.reason); continue; }
		seen.add(loaded.header.id);
		rows.push({ sessionId: loaded.header.id, ...metricsOf(loaded) });
	}
	finishSummary(summary);
	const aggregate = aggregateMetrics(rows);
	const top = rows
		.filter((row) => Number.isFinite(row.toolErrors) && row.toolErrors > 0)
		.sort((a, b) => b.toolErrors - a.toolErrors || a.sessionId.localeCompare(b.sessionId))
		.slice(0, 10)
		.map(({ sessionId, startedAt, toolCalls, toolErrors, toolErrorRate }) => ({ sessionId, startedAt, toolCalls, toolErrors, toolErrorRate }));
	await privateWrite(join(dirname(out), "stats.jsonl"), rows.map((row) => JSON.stringify(row) + "\n").join(""));
	await privateWrite(join(dirname(out), "stats.md"), renderStatsMarkdown(aggregate, top, rows.length));
	return {
		sessions: rows.length, unknownWeek: aggregate.unknownWeek, unknownModel: aggregate.unknownModel,
		weeks: aggregate.weeks, models: aggregate.models,
		skipped: summary.skipped, skippedOversized: summary.skippedOversized, skippedInvalidHeader: summary.skippedInvalidHeader,
		skippedEmpty: summary.skippedEmpty, skippedDuplicate: summary.skippedDuplicate,
		traceMissing: summary.traceMissing, tracePartial: summary.tracePartial, parseErrors: summary.parseErrors,
	};
}

function formatCount(values) {
	if (!values?.length) return "n/a";
	return values.slice(0, TOP_VALUES).map((item) => `${item.value} (${item.count})`).join(", ");
}

function formatCombinations(combinations) {
	if (!combinations.length) return "n/a";
	return combinations.slice(0, TOP_COMBINATIONS).map((item) => `${item.outcome} / ${item.faultSide} / ${item.errorCode} (${item.count})`).join("; ");
}

function formatPercent(value) {
	return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

// n < 10 samples stay visible but flagged, so small buckets cannot be read as trends.
const sampleMark = (n) => n < 10 ? "*" : "";

function renderBreakdownMarkdown(aggregate, sessions, summary) {
	const toolRow = (row) => `| ${markdownCell(row.tool)} | ${row.endedSpans}${sampleMark(row.endedSpans)} | ${row.errors} | ${formatPercent(row.rate)} | ${formatPercent(row.share)} | ${row.aborted} | ${markdownCell(formatCombinations(row.combinations))} |`;
	const providerRow = (row) => `| ${markdownCell(`${row.provider}/${row.model}`)} | ${markdownCell(row.category)} | ${row.count}${sampleMark(row.count)} | ${formatPercent(row.share)} | ${markdownCell(formatCount(row.httpStatus))} | ${markdownCell(formatCount(row.qoderErrorCode))} | ${markdownCell(formatCount(row.transportPhase))} |`;
	const sessionRow = (row, extra) => `| ${markdownCell(row.sessionId)} | ${row.toolErrors} | ${row.providerErrors} | ${extra} |`;
	return [
		"# 工具与 provider 出错拆解", "",
		`会话数 ${aggregate.sessions}；已结束工具 span ${aggregate.toolTotals.endedSpans}，出错 ${aggregate.toolTotals.errors}（其中 aborted ${aggregate.toolTotals.aborted}）。`,
		`provider 请求 span ${aggregate.providerTotals.requests}，出错 ${aggregate.providerTotals.errors}；aborted 请求 ${aggregate.providerTotals.abortedRequests}（不计入出错）。`,
		`属性缺失记为 \`(none)\`；n < 10 的行标 \`*\`。工具 span \`${TOOL_SPAN}\`，provider 请求 span \`${PROVIDER_SPAN}\`。`,
		`sessions skipped ${summary.skipped}，trace missing ${summary.traceMissing}，trace partial ${summary.tracePartial}，parse errors ${summary.parseErrors}。`, "",
		"## 工具出错（outcome 不是 ok，aborted 单列）", "",
		"| 工具 | 已结束 span | 出错 | 出错率 | 占全部出错 | aborted | 前 5 组合 outcome / fault_side / error_code (count) |",
		"| --- | --- | --- | --- | --- | --- | --- |",
		...aggregate.tools.map(toolRow), "",
		"## 工具出错集中度", "",
		aggregate.concentration.share === null
			? "没有工具出错，无法计算集中度。"
			: `出错会话 ${aggregate.concentration.sessionsWithErrors} 个；出错最多的前 ${aggregate.concentration.topSessions} 个会话（前 10%）贡献 ${aggregate.concentration.topErrors}/${aggregate.concentration.errors}（${formatPercent(aggregate.concentration.share)}）。`, "",
		"## provider 请求出错（status=error）", "",
		"| provider/model | category | 计数 | 占比 | http_status 前 5 | qoder.error_code 前 5 | transport_phase 前 5 |",
		"| --- | --- | --- | --- | --- | --- | --- |",
		...aggregate.providers.map(providerRow), "",
		"## edit 失败原因（只列枚举码）", "",
		aggregate.editFailures.total === 0
			? "没有失败的 edit 调用。"
			: `edit 失败 ${aggregate.editFailures.total} 次；其中 Action Fusion 的 edit 本身已写盘、then_run 命令失败 ${aggregate.editFailures.thenRunFailed} 次（不算 edit 失败），无法分类 ${aggregate.editFailures.uncoded} 次（记 \`(none)\`）。`,
		"",
		"| 原因码 | trace 码 | 从会话回推 |",
		"| --- | --- | --- |",
		...aggregate.editFailures.rows.map((row) => `| ${markdownCell(row.code)} | ${row.trace} | ${row.derived} |`),
		...(aggregate.editFailures.uncoded ? [`| ${markdownCell("(none)")} | 0 | 0 |`] : []), "",
		"## 会话以 provider 错误结束", "",
		`${aggregate.providerEnd.sessions} 个会话；最后出错请求所在 run 有 ≥2 次出错（run 内重试）${aggregate.providerEnd.runRetried} 个；整个会话 ≥2 次出错请求 ${aggregate.providerEnd.sessionRetried} 个，只有 1 次 ${aggregate.providerEnd.single} 个。`, "",
		"## 私有 session 列表（仅本文件，不进 stdout）", "",
		"| session | 工具出错 | provider 请求出错 | 最后 run 出错请求数 |",
		"| --- | --- | --- | --- |",
		...sessions.tools.map((row) => sessionRow(row, row.lastRunErrors)),
		...sessions.providers.map((row) => sessionRow(row, row.lastRunErrors)), "",
	].join("\n");
}

/** Join current-branch edit results to trace evidence. A failed edit explains
 * itself only in text, so it is classified in memory; only enum codes leave
 * this function and nothing is written back to the session. */
function editFailuresOf(branch, traceRecords) {
	const results = new Map();
	const calls = [];
	for (const entry of branch) {
		const message = entry.type === "message" ? entry.message : undefined;
		if (!message) continue;
		if (message.role === "toolResult") results.set(message.toolCallId, message);
		else if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) if (part?.type === "toolCall") calls.push(part);
		}
	}
	const info = toolCallInfo(traceRecords, "edit");
	const entries = [];
	for (const call of calls) {
		if (call.name !== "edit") continue;
		const result = results.get(call.id);
		if (result?.isError !== true) continue;
		const evidence = info.get(createHash("sha256").update(String(call.id)).digest("hex"));
		entries.push({
			traceCode: evidence?.code,
			// Action Fusion keeps the edit applied and fails on the follow-up command.
			thenRunFailed: evidence?.followup === "failed",
			derivedCode: classifyEditError(contentText(result.content)),
		});
	}
	return editFailureRows(entries);
}

/** Tool and provider error breakdown from trace metadata only: no session text,
 * no tool arguments, no error bodies. Session ids stay in the private Markdown. */
export async function errorBreakdown({ root = join(homedir(), ".pi/agent/sessions"), since = "28d", out = DEFAULT_OUT } = {}) {
	if (!/^\d+[dh]$/.test(since)) throw new Error("Since must be Nd or Nh");
	const cutoff = Date.now() - Number(since.slice(0, -1)) * (since.endsWith("d") ? 86400000 : 3600000);
	root = await openSessionRoot(root);
	out = await outputDirectory(out);
	const rel = relative(root, out);
	if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) throw new Error("Output must not be inside session root");
	await mkdir(out, { recursive: true, mode: 0o700 });
	await chmod(out, 0o700);
	await rejectGit(dirname(out));
	const summary = newSummary();
	const seen = new Set();
	const sessions = [];
	for (const { path } of await discover(root, cutoff, 500)) {
		const loaded = await loadSession(path, summary, seen);
		if (loaded.reason) { countSkip(summary, loaded.reason); continue; }
		seen.add(loaded.header.id);
		const provider = providerErrorRows(loaded.trace.records);
		const toolRows = toolErrorRows(loaded.trace.records);
		sessions.push({
			sessionId: loaded.header.id,
			toolErrors: toolRows.reduce((sum, row) => sum + row.errors, 0),
			providerErrors: provider.errors,
			lastRunErrors: provider.lastFailedRequest.runErrorRequests,
			toolRows,
			provider,
			editFailures: editFailuresOf(loaded.branch, loaded.trace.records),
			endedOnProviderError: loaded.findings.some((finding) => finding.rule === "ended-on-provider-error" && finding.status === "hit"),
		});
	}
	finishSummary(summary);
	const aggregate = aggregateBreakdown(sessions);
	const bySession = (key) => (a, b) => b[key] - a[key] || a.sessionId.localeCompare(b.sessionId);
	const top = {
		tools: sessions.filter((row) => row.toolErrors > 0).sort(bySession("toolErrors")).slice(0, 10),
		providers: sessions.filter((row) => row.providerErrors > 0).sort(bySession("providerErrors")).slice(0, 10),
	};
	await privateWrite(join(dirname(out), "breakdown.md"), renderBreakdownMarkdown(aggregate, top, summary));
	return {
		sessions: aggregate.sessions, toolTotals: aggregate.toolTotals, tools: aggregate.tools,
		concentration: aggregate.concentration, providerTotals: aggregate.providerTotals,
		providers: aggregate.providers, providerEnd: aggregate.providerEnd, editFailures: aggregate.editFailures,
		skipped: summary.skipped, skippedOversized: summary.skippedOversized, skippedInvalidHeader: summary.skippedInvalidHeader,
		skippedEmpty: summary.skippedEmpty, skippedDuplicate: summary.skippedDuplicate,
		traceMissing: summary.traceMissing, tracePartial: summary.tracePartial, parseErrors: summary.parseErrors,
	};
}

/** Export filled labels; no model calls or automatic classification. */
export async function collectLabels({ out = DEFAULT_OUT } = {}) {
	out = await outputDirectory(out);
	await rejectGit(dirname(out));
	await mkdir(out, { recursive: true, mode: 0o700 });
	await chmod(out, 0o700);
	const labels = [];
	const summary = { labeled: 0, pass: 0, fail: 0, categories: Object.create(null) };
	const cards = [];
	for await (const entry of await opendir(out)) if (entry.name.endsWith(".md")) cards.push(entry.name);
	for (const name of cards.sort()) {
		const cardPath = join(out, name);
		const card = await readCard(cardPath);
		const label = parseLabel(card);
		if (!label.verdict) continue;
		const session = /^---\r?\nsession: (.+)\r?\n/.exec(card);
		if (!session) throw new Error("Invalid card metadata");
		const sessionId = JSON.parse(session[1]);
		if (sessionId !== basename(name, ".md")) throw new Error("Card identity mismatch");
		const { verdict, categories, note } = label;
		const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(card)?.[1];
		const field = /^findings: (.+)$/m.exec(frontmatter ?? "");
		const stored = field ? JSON.parse(field[1]) : undefined;
		const findings = Object.fromEntries(RULE_IDS.map((rule) => {
			const status = field ? stored?.[rule] : "unknown";
			if (!["hit", "clear", "unknown"].includes(status)) throw new Error("Invalid findings metadata");
			return [rule, status];
		}));
		labels.push({ sessionId, verdict, categories, note, cardPath, labeledAt: new Date().toISOString(), findings });
		summary.labeled++;
		if (verdict === "pass" || verdict === "fail") summary[verdict]++;
		for (const category of categories) increment(summary.categories, category);
	}
	await privateWrite(join(dirname(out), "labels.jsonl"), labels.map((label) => JSON.stringify(label) + "\n").join(""));
	return summary;
}

/** Review only existing cards. Streams are injectable; CLI enforces the TTY gate. */
export async function reviewCards({ out = DEFAULT_OUT, limit = 50, input = process.stdin, output = process.stdout } = {}) {
	if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid review limit");
	out = await outputDirectory(out);
	await mkdir(out, { recursive: true, mode: 0o700 });
	await chmod(out, 0o700);
	const cards = [];
	let damaged = 0;
	for await (const entry of await opendir(out)) {
		if (!entry.name.endsWith(".md")) continue;
		const path = join(out, entry.name);
		const content = await readCard(path, null);
		let label;
		try { label = parseLabel(content.toString("utf8")); }
		catch { damaged++; continue; }
		if (label.verdict) continue;
		cards.push({ path, content, labelStart: content.lastIndexOf("\n<!-- label:begin -->") + 1 });
	}
	return runReview(cards, { limit, input, output, writeCard: privateWrite, damaged });
}

async function writeAgreement({ out = DEFAULT_OUT } = {}) {
	out = await outputDirectory(out);
	const loaded = await readBounded(join(dirname(out), "labels.jsonl"));
	// A partial label set would bias the report. Unlike session rendering, do not
	// skip malformed/oversized input and silently report statistics for a subset.
	if (loaded.oversized || loaded.errors) throw new Error("Invalid labels input");
	const result = computeAgreement(loaded.records.map((row) => ({
		sessionId: row.sessionId, verdict: row.verdict, categories: row.categories ?? [], signals: row.findings ?? {},
	})));
	await privateWrite(join(dirname(out), "agreement.md"), renderAgreementMarkdown(result));
	// Review IDs belong only in the private Markdown, never stdout.
	return {
		totalRows: result.totalRows, evaluatedRows: result.evaluatedRows, ignoredVerdicts: result.ignoredVerdicts,
		signals: result.signals, categories: result.categories, uncoveredCategories: result.uncoveredCategories.length,
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const { values, positionals } = parseArgs({ options: { root: { type: "string" }, out: { type: "string" }, since: { type: "string" }, limit: { type: "string" }, focus: { type: "boolean" } }, allowPositionals: true });
		const [command] = positionals;
		if (positionals.length !== 1 || !["build", "labels", "agreement", "review", "stats", "breakdown"].includes(command) ||
			(!["build", "stats", "breakdown"].includes(command) && (values.root !== undefined || values.since !== undefined)) ||
			(!["build", "review"].includes(command) && values.limit !== undefined) ||
			(command !== "build" && values.focus === true)) throw new Error("Invalid CLI arguments");
		if (command === "review") {
			if (!process.stdin.isTTY) throw new Error("Review requires a TTY");
			await reviewCards({ ...values, limit: values.limit === undefined ? 50 : Number(values.limit) });
		} else {
			let result;
			if (command === "build") result = await buildCards({ ...values, limit: values.limit === undefined ? 50 : Number(values.limit) });
			else if (command === "stats") result = await sessionStats(values);
			else if (command === "breakdown") result = await errorBreakdown(values);
			else if (command === "labels") result = await collectLabels(values);
			else result = await writeAgreement(values);
			console.log(JSON.stringify(result));
		}
	} catch {
		// Filesystem/JSON errors can contain private paths or source text; never echo them.
		console.error("session-cards: invalid arguments, input, output path, permissions, or label format");
		process.exitCode = 1;
	}
}
