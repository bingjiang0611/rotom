import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { evaluateSession, RULE_IDS } from "./trace-assertions.mjs";
import { COPY } from "./copy.mjs";
import { sessionMetrics } from "./session-metrics.mjs";
const MAX_FILE = 256 * 1024 * 1024;
const MAX_LINE = 64 * 1024 * 1024;
const SILENT_ENTRY_TYPES = new Set(["custom", "context_edit", "label", "session_info", "thinking_level_change", "usage"]);
export async function statIfPresent(path) {
	try { return await lstat(path); }
	catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}


export async function readBounded(path, maximumBytes = MAX_FILE, headerOnly = false) {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("Input must be a regular file");
		if (info.size > maximumBytes) return { oversized: true, records: [], errors: 0, badJson: 0, lineTooLong: 0 };
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
					if (headerOnly && (firstRecordParsed || firstNonemptyTooLong)) break;
					start = end + 1;
				}
				if (headerOnly && (firstRecordParsed || firstNonemptyTooLong)) break;
			}
			if (lineBytes > 0) finishLine();
		}
		return { oversized: false, records, errors: badJson + lineTooLong, badJson, lineTooLong, firstRecord, firstRecordParsed, firstNonemptyTooLong };
	} finally { await handle.close(); }
}

export async function discover(root, since, limit) {
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

export function currentBranch(records, summary) {
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

export async function readTrace(sessionPath, summary, maximumBytes = MAX_FILE) {
	const path = join(dirname(sessionPath), "observability", `${basename(sessionPath, ".jsonl")}.trace.jsonl`);
	const info = await statIfPresent(path);
	if (!info) return { status: "missing", tools: new Map(), records: [] };
	const loaded = await readBounded(path, maximumBytes);
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

export function truncate(value, maximum) {
	const text = String(value);
	const characters = Array.from(text);
	return characters.length > maximum ? `${characters.slice(0, maximum).join("")}…[截断 ${characters.length - maximum} 字符]` : text;
}

export function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => part.type === "text" ? part.text : part.type === "image" ? "(image)" : "").filter(Boolean).join("\n");
}

// Quoted source text cannot create a real label delimiter or raw HTML in the card.
function quote(text) {
	return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").split("\n").map((line) => `> ${line}`).join("\n");
}

export function increment(counts, key) { counts[key] = (counts[key] ?? 0) + 1; }

export function sessionSummary(branch) {
	const messages = branch.filter((entry) => entry.type === "message").map((entry) => entry.message);
	const last = messages.filter((message) => message?.role === "assistant").at(-1);
	return {
		request: contentText(messages.find((message) => message?.role === "user")?.content),
		final: contentText(last?.content) || COPY.noFinal.replace("{reason}", last?.stopReason ?? "unknown"),
	};
}

export function renderCard(header, path, branch, trace, summary, findings) {
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
	const { request, final } = sessionSummary(branch);
	const hits = findings.filter(({ status }) => status === "hit").map(({ rule, count, evidence }) => `- ${rule}（count=${count}）：${truncate(JSON.stringify(evidence), 600)}`);
	return `---\n${metadata}\n---\n\n## 用户请求\n${quote(truncate(request, 2000))}\n\n## 过程\n${process.join("\n\n")}\n\n## 规则命中\n${hits.join("\n") || "(无)"}\n\n## 最终回复\n${quote(truncate(final, 4000))}\n\n`;
}

export function parseLabel(card) {
	const start = card.lastIndexOf("\n<!-- label:begin -->");
	const block = start < 0 ? "" : card.slice(start + 1);
	const match = /^<!-- label:begin -->\r?\nverdict:([^\r\n]*)\r?\ncategories:([^\r\n]*)\r?\nnote:([\s\S]*?)\r?\n<!-- label:end -->\s*$/.exec(block);
	// Fail closed rather than silently discarding annotations after an accidental format edit.
	if (!match) throw new Error("Invalid label block");
	return { block, verdict: match[1].trim(), categories: [...new Set(match[2].split(/[,，]/).map((value) => value.trim()).filter(Boolean))], note: match[3].trim() };
}

export async function readCard(path, encoding = "utf8") {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try { return await handle.readFile(encoding); }
	finally { await handle.close(); }
}

export async function privateWrite(path, content) {
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

export function newSummary() {
	return {
		generated: 0, skipped: 0, skippedOversized: 0, skippedInvalidHeader: 0, skippedEmpty: 0, skippedDuplicate: 0,
		traceMissing: 0, tracePartial: 0, parseErrors: 0, sessionParseErrors: 0, traceParseErrors: 0, unknownEntries: 0,
		invalidHeaderKinds: Object.create(null), invalidHeaderKeySets: Object.create(null), sessionVersions: { "1": 0, "2": 0, "3": 0, missing: 0 },
		badJson: 0, lineTooLong: 0, entryMissingId: 0, danglingParent: 0, cycle: 0, messageMissing: 0,
		findings: Object.fromEntries(RULE_IDS.map((rule) => [rule, { hit: 0, clear: 0, unknown: 0 }])),
	};
}

export function finishSummary(summary) {
	summary.skipped = summary.skippedOversized + summary.skippedInvalidHeader + summary.skippedEmpty + summary.skippedDuplicate;
	summary.sessionParseErrors = summary.badJson + summary.lineTooLong + summary.entryMissingId + summary.danglingParent + summary.cycle + summary.messageMissing;
	summary.parseErrors = summary.sessionParseErrors + summary.traceParseErrors;
	return summary;
}

export function countSkip(summary, reason) {
	if (reason === "oversized") summary.skippedOversized++;
	else if (reason === "invalidHeader") summary.skippedInvalidHeader++;
	else if (reason === "empty") summary.skippedEmpty++;
	else summary.skippedDuplicate++;
}

/** Shared by build and stats: bounded read, header validation, branch reconstruction,
 * trace association and rule evaluation. Never writes the session or trace input. */
export async function loadSession(path, summary, seen, maximumBytes = MAX_FILE, allowEmpty = false) {
	const loaded = await readBounded(path, maximumBytes);
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
	// CLI cards still skip empty logs. The dashboard must show a newly started
	// session before its first message, and can anchor a progress label at null/0.
	if (!branch.length && !allowEmpty) return { reason: "empty" };
	if (seen.has(header.id)) return { reason: "duplicate" };
	const trace = await readTrace(path, summary, maximumBytes);
	if (trace.status === "missing") summary.traceMissing++;
	if (trace.status === "partial") summary.tracePartial++;
	return { header, branch, trace, findings: evaluateSession({ branch, traceTools: trace.tools, traceStatus: trace.status }) };
}

export function metricsOf(loaded) {
	return sessionMetrics({ header: loaded.header, branch: loaded.branch, traceTools: loaded.trace.tools, traceStatus: loaded.trace.status, findings: loaded.findings });
}

export async function openSessionRoot(root) {
	const info = await lstat(resolve(root));
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid session root");
	return realpath(root);
}
