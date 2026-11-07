#!/usr/bin/env node
// 第二轮：只读统计“agent 在哪种状态下把控制权交还给用户”，以及用户随后怎么回应。
// 针对维护者口述的头号问题“停得不对”：停太早（用户只回“继续”）与停太晚（用户中断）。
//
// 隐私边界同 extract-session-metrics.mjs：只输出计数与分桶；助手/用户文本只在本地做正则特征判断，不输出文本。
// 用法: node stop-context.mjs [--root DIR] [--days 7] [--now ISO] [--out FILE] [--samples FILE]
// --samples 写一份“本地专用”的样本索引（会话路径 + 条目 id），供人工复查；不得提交。

import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) if (process.argv[i].startsWith("--")) args[process.argv[i].slice(2)] = process.argv[i + 1];
const root = args.root ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions");
const now = args.now ? Date.parse(args.now) : Date.now();
const since = now - Number(args.days ?? 7) * 86_400_000;

const CONTINUE = /^(请?继续|接着|继续吧|继续做|继续执行|接着做|go on|continue|keep going|下一步|然后呢|好的?[,，]?继续)[\s。.!！,，]*$/iu;
const APPROVE = /^(ok|okay|yes|y|go ahead|可以|好|好的|行|嗯|是|是的|同意|确认|没问题|做吧|去做|做|full ?send)[\s。.!！,，]*$/iu;
const CORRECTION = [
	/不对|错了|不是这|不是我|你没有|没有按|别再|不要再|又(错|没)|还是不行|还是没|为什么(又|没|要)|停下|停止|搞错|理解错|我说的是|回滚|撤销|范围/u,
	/\b(wrong|incorrect|not what i|that's not|stop|revert|undo|you didn'?t|why did you|still (not|broken|fail))/iu,
];
const FEATURES = {
	asksPermission: /要不要|是否需要|需要我|要我|可以吗|是否继续|是否要|请确认|确认后|你希望|你想|如果你同意|shall i|should i|do you want|want me to|would you like|let me know if|confirm/iu,
	listsRemaining: /剩余|剩下|下一步|后续|待办|未完成|尚未|还没|还需要|TODO|remaining|next steps?|not yet|still need|follow-?up|pending/iu,
	claimsDone: /已完成|全部完成|完成了|已经完成|已修复|已推送|已提交|done\b|completed|all set|finished|fixed|pushed/iu,
	reportsBlocked: /阻塞|无法|不能|失败|受限|没有权限|blocked|cannot|can't|unable|failed|permission/iu,
	mentionsUnverified: /未验证|没有验证|未经验证|无法验证|unverified|not verified|untested/iu,
};

const sha = (v) => createHash("sha256").update(String(v)).digest("hex").slice(0, 10);
const tag = (v) => (typeof v === "string" && v ? v.replace(/[^\w.:@/+-]/gu, "_").slice(0, 64) : "unknown");
const inc = (m, k, by = 1) => { m[k] = (m[k] ?? 0) + by; };
const textOf = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n") : "";
const ts = (e) => (typeof e?.timestamp === "number" ? e.timestamp : Date.parse(e?.timestamp ?? "")) || e?.message?.timestamp || 0;
const bucket = (n, edges) => { for (const e of edges) if (n <= e) return `<=${e}`; return `>${edges[edges.length - 1]}`; };

function walk(dir, out = []) {
	let names; try { names = readdirSync(dir); } catch { return out; }
	for (const name of names) {
		const p = join(dir, name); let s; try { s = lstatSync(p); } catch { continue; }
		if (s.isSymbolicLink()) continue;
		if (s.isDirectory()) walk(p, out);
		else if (name.endsWith(".jsonl") && !name.endsWith(".trace.jsonl") && s.mtimeMs >= since) out.push(p);
	}
	return out;
}

const handoffs = []; // 每次“agent 交还控制权 → 用户下一条消息”
const aborts = [];
const seen = new Set();
const samples = [];

for (const file of walk(root)) {
	let records = [];
	for (const line of readFileSync(file, "utf8").split("\n")) { if (!line.trim()) continue; try { records.push(JSON.parse(line)); } catch {} }
	const header = records.find((r) => r?.type === "session");
	if (!header || header.parentSession) continue; // 子 agent 没有真人回复，跳过
	let run = { toolCalls: 0, toolErrors: 0, lastToolError: false, errorTail: 0, assistantErrors: 0, startedAt: 0 };
	let lastAssistant = null;
	for (const e of records) {
		if (e?.type !== "message" || !e.message) continue;
		if (e.id && seen.has(e.id)) { // fork 复制的条目：只更新位置状态，不重复计数
			if (e.message.role === "assistant") lastAssistant = { entry: e, m: e.message };
			if (e.message.role === "user") run = { toolCalls: 0, toolErrors: 0, lastToolError: false, errorTail: 0, assistantErrors: 0, startedAt: ts(e) };
			continue;
		}
		if (e.id) seen.add(e.id);
		const m = e.message;
		if (m.role === "assistant") {
			lastAssistant = { entry: e, m };
			if (m.stopReason === "error") run.assistantErrors++;
			for (const p of Array.isArray(m.content) ? m.content : []) if (p?.type === "toolCall") run.toolCalls++;
			continue;
		}
		if (m.role === "toolResult") {
			if (m.isError) { run.toolErrors++; run.errorTail++; run.lastToolError = true; } else { run.errorTail = 0; run.lastToolError = false; }
			continue;
		}
		if (m.role !== "user") continue;
		const userTs = ts(e);
		if (userTs >= since && userTs <= now && lastAssistant) {
			const prev = lastAssistant.m;
			const prevText = textOf(prev.content);
			const userText = textOf(m.content).trim();
			const kind = CONTINUE.test(userText) ? "bare_continue" : APPROVE.test(userText) ? "bare_approve" : CORRECTION.some((r) => r.test(userText)) ? "correction_keyword" : "other";
			const h = {
				kind,
				prevStop: tag(prev.stopReason),
				model: `${tag(prev.provider)}/${tag(prev.model)}`,
				endsWithQuestion: /[?？]\s*$/u.test(prevText.trim()),
				prevTextBytes: bucket(Buffer.byteLength(prevText), [200, 1000, 3000, 8000]),
				runToolCalls: bucket(run.toolCalls, [0, 3, 10, 30, 100]),
				runMinutes: bucket(run.startedAt ? (ts(lastAssistant.entry) - run.startedAt) / 60_000 : 0, [1, 5, 15, 60]),
				runToolErrors: bucket(run.toolErrors, [0, 2, 5]),
				lastToolError: run.lastToolError,
				runAssistantErrors: run.assistantErrors > 0,
				userGap: bucket((userTs - ts(lastAssistant.entry)) / 1000, [10, 60, 300, 1800]),
			};
			for (const [k, r] of Object.entries(FEATURES)) h[k] = r.test(prevText);
			handoffs.push(h);
			if (prev.stopReason === "aborted") aborts.push({ runToolCalls: h.runToolCalls, runMinutes: h.runMinutes, errorTail: bucket(run.errorTail, [0, 1, 2, 4]), runToolErrors: h.runToolErrors, nextUser: kind });
			if (samples.length < 400 && (kind === "bare_continue" || kind === "bare_approve" || prev.stopReason === "aborted")) samples.push({ session: sha(file), path: file, assistantEntryId: lastAssistant.entry.id, userEntryId: e.id, kind, prevStop: h.prevStop });
		}
		run = { toolCalls: 0, toolErrors: 0, lastToolError: false, errorTail: 0, assistantErrors: 0, startedAt: userTs };
	}
}

function crosstab(rows, keys) {
	const out = {};
	for (const k of keys) { out[k] = {}; for (const r of rows) inc(out[k], String(r[k])); }
	return out;
}
const featureKeys = ["prevStop", "model", "endsWithQuestion", "prevTextBytes", "runToolCalls", "runMinutes", "runToolErrors", "lastToolError", "runAssistantErrors", "userGap", ...Object.keys(FEATURES)];
const byKind = {};
for (const kind of ["bare_continue", "bare_approve", "correction_keyword", "other"]) {
	const rows = handoffs.filter((h) => h.kind === kind);
	byKind[kind] = { n: rows.length, ...crosstab(rows, featureKeys) };
}
const continueAfterStop = handoffs.filter((h) => h.kind === "bare_continue" && h.prevStop === "stop");
const pattern = {};
for (const h of continueAfterStop) inc(pattern, [h.asksPermission && "asks", h.listsRemaining && "remaining", h.claimsDone && "done", h.reportsBlocked && "blocked", h.endsWithQuestion && "question"].filter(Boolean).join("+") || "none");

const out = {
	schema: "rotom-session-review-stop-context/v1",
	generatedAt: new Date(now).toISOString(),
	privacy: "counts and buckets only; assistant/user text matched locally, never emitted",
	handoffs: handoffs.length,
	byKind,
	bareContinueAfterNormalStop: { n: continueAfterStop.length, featureCombos: Object.fromEntries(Object.entries(pattern).sort((a, b) => b[1] - a[1])) },
	aborts: { n: aborts.length, ...crosstab(aborts, ["runToolCalls", "runMinutes", "errorTail", "runToolErrors", "nextUser"]) },
};
const json = `${JSON.stringify(out, null, 2)}\n`;
if (args.out) writeFileSync(args.out, json); else process.stdout.write(json);
if (args.samples) writeFileSync(args.samples, `${JSON.stringify(samples, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`${handoffs.length} handoffs, ${aborts.length} aborts, ${samples.length} local samples\n`);
