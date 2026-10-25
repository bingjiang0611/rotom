#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, unlink, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { evaluateSession, RULE_IDS } from "./trace-assertions.mjs";

const MAX_FILE = 256 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
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
		let firstLine = true;
		let firstLineParsed = false;
		let firstRecord;
		let segments = [];
		let lineBytes = 0;
		function finishLine() {
			if (lineBytes > MAX_LINE) lineTooLong++;
			else {
				const line = Buffer.concat(segments, lineBytes).toString("utf8").trim();
				if (line) {
					try {
						const record = JSON.parse(line);
						if (firstLine) { firstRecord = record; firstLineParsed = true; }
						if (!record || typeof record !== "object" || Array.isArray(record)) badJson++;
						else records.push(record);
					} catch { badJson++; }
				}
			}
			firstLine = false;
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
					lineBytes += end - start;
					if (lineBytes <= MAX_LINE) segments.push(chunk.subarray(start, end));
					else segments = [];
					if (newline >= 0) finishLine();
					start = end + 1;
				}
			}
			if (lineBytes > 0) finishLine();
		}
		return { oversized: false, records, errors: badJson + lineTooLong, badJson, lineTooLong, firstRecord, firstLineParsed };
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
	if (!info) return { status: "missing", tools: new Map() };
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
	return { status: partial ? "partial" : "ok", tools };
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

async function readCard(path) {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try { return await handle.readFile("utf8"); }
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

/** Build private cards without changing session or trace inputs. */
export async function buildCards({ root = join(homedir(), ".pi/agent/sessions"), out = DEFAULT_OUT, since, limit = 50 } = {}) {
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Limit must be between 1 and 500");
	if (since !== undefined && !/^\d+[dh]$/.test(since)) throw new Error("Since must be Nd or Nh");
	const cutoff = since === undefined ? -Infinity : Date.now() - Number(since.slice(0, -1)) * (since.endsWith("d") ? 86400000 : 3600000);
	const info = await lstat(resolve(root));
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid session root");
	root = await realpath(root);
	out = await outputDirectory(out);
	const rel = relative(root, out);
	if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) throw new Error("Output must not be inside session root");
	await mkdir(out, { recursive: true, mode: 0o700 });
	await chmod(out, 0o700);
	const summary = {
		generated: 0, skipped: 0, skippedOversized: 0, skippedInvalidHeader: 0, skippedEmpty: 0, skippedDuplicate: 0,
		traceMissing: 0, tracePartial: 0, parseErrors: 0, sessionParseErrors: 0, traceParseErrors: 0, unknownEntries: 0,
		invalidHeaderKinds: Object.create(null), sessionVersions: { "1": 0, "2": 0, "3": 0, missing: 0 },
		badJson: 0, lineTooLong: 0, entryMissingId: 0, danglingParent: 0, cycle: 0, messageMissing: 0,
		findings: Object.fromEntries(RULE_IDS.map((rule) => [rule, { hit: 0, clear: 0, unknown: 0 }])),
	};
	const written = new Set();
	for (const { path } of await discover(root, cutoff, limit)) {
		const loaded = await readBounded(path);
		summary.badJson += loaded.badJson;
		summary.lineTooLong += loaded.lineTooLong;
		if (loaded.oversized) { summary.skippedOversized++; continue; }
		const header = loaded.firstRecord;
		if (header?.type !== "session" || typeof header.id !== "string" || !/^[\w-]+$/.test(header.id)) {
			const kind = !loaded.firstLineParsed ? "unparseable" : header?.type === "session" ? "session-bad-id"
				: typeof header?.type === "string" && /^[a-z_]{1,32}$/.test(header.type) ? header.type : "other";
			increment(summary.invalidHeaderKinds, kind);
			summary.skippedInvalidHeader++; continue;
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
		if (!branch.length) { summary.skippedEmpty++; continue; }
		if (written.has(header.id)) { summary.skippedDuplicate++; continue; }
		const trace = await readTrace(path, summary);
		if (trace.status === "missing") summary.traceMissing++;
		if (trace.status === "partial") summary.tracePartial++;
		const cardPath = join(out, `${header.id}.md`);
		let label = EMPTY_LABEL;
		if (await statIfPresent(cardPath)) {
			const existing = parseLabel(await readCard(cardPath));
			if (existing.verdict) label = existing.block;
		}
		const findings = evaluateSession({ branch, traceTools: trace.tools, traceStatus: trace.status });
		await privateWrite(cardPath, renderCard(header, path, branch, trace, summary, findings) + label);
		for (const { rule, status } of findings) summary.findings[rule][status]++;
		written.add(header.id);
		summary.generated++;
		if (header.version === undefined || [1, 2, 3].includes(header.version)) increment(summary.sessionVersions, header.version ?? "missing");
	}
	summary.skipped = summary.skippedOversized + summary.skippedInvalidHeader + summary.skippedEmpty + summary.skippedDuplicate;
	summary.sessionParseErrors = summary.badJson + summary.lineTooLong + summary.entryMissingId + summary.danglingParent + summary.cycle + summary.messageMissing;
	summary.parseErrors = summary.sessionParseErrors + summary.traceParseErrors;
	return summary;
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const { values, positionals } = parseArgs({ options: { root: { type: "string" }, out: { type: "string" }, since: { type: "string" }, limit: { type: "string" } }, allowPositionals: true });
		const [command] = positionals;
		if (positionals.length !== 1 || !["build", "labels"].includes(command) || (command === "labels" && (values.root || values.since || values.limit))) throw new Error("Invalid CLI arguments");
		const result = command === "build" ? await buildCards({ ...values, limit: values.limit === undefined ? 50 : Number(values.limit) }) : await collectLabels(values);
		console.log(JSON.stringify(result));
	} catch {
		// Filesystem/JSON errors can contain private paths or source text; never echo them.
		console.error("session-cards: invalid arguments, input, output path, permissions, or label format");
		process.exitCode = 1;
	}
}
