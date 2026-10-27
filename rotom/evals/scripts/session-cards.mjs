#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mergedLabels, readAnnotations } from "../../extensions/observability/eval/annotations.mjs";
import { mkdir, opendir, realpath, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { statIfPresent, discover, contentText, renderCard, parseLabel, readCard, privateWrite, newSummary, finishSummary, countSkip, loadSession, metricsOf, increment, openSessionRoot } from "../../extensions/observability/eval/session-data.mjs";
import { RULE_IDS } from "./trace-assertions.mjs";
import { computeAgreement, renderAgreementMarkdown } from "./agreement.mjs";
import { runReview } from "./review.mjs";
import { aggregateMetrics, focusCandidate } from "./session-metrics.mjs";
import { latestJudgments, judgeAgreement } from "../../extensions/observability/eval/judge-store.mjs";
import { aggregateBreakdown, editFailureRows, PROVIDER_SPAN, providerErrorRows, TOOL_SPAN, toolCallInfo, toolErrorRows, TOP_COMBINATIONS, TOP_VALUES } from "./error-breakdown.mjs";
import { classifyEditError } from "../../extensions/coding-policy/edit-error-code.mjs";
import { aggregateCommandFailures, COMMAND_CATEGORIES, FAILURE_STREAK_THRESHOLD, RETRY_FAILURE_THRESHOLD, sessionCommandFailures } from "./command-failures.mjs";

const DEFAULT_OUT = join(homedir(), ".rotom/evals/cards");
const EMPTY_LABEL = "<!-- label:begin -->\nverdict:\ncategories:\nnote:\n<!-- label:end -->\n";

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

function renderCommandFailures(result, sessions) {
	const cell = (count) => `${count.calls} / ${count.failures} / ${count.unknown} / ${formatPercent(count.rate)} / ${formatPercent(count.share)} / ${count.searchExit1}`;
	return [
		"## 命令失败类别", "",
		"每格：调用 / 失败 / 未知或未执行 / 已知结果失败率 / 占全部已知命令失败 / 搜索 exit 1。then_run 只统计 edit；没有阶段证据不推断命令已执行。", "",
		"| 类别 | bash | then_run |", "| --- | --- | --- |",
		...COMMAND_CATEGORIES.map((category) => `| ${category} | ${cell(result.categories[category].bash)} | ${cell(result.categories[category].then_run)} |`), "",
		"## 重复失败信号", "",
		`范围：当前分支的全部工具调用。trace outcome 非 ok 记失败；缺 outcome 时回退 toolResult.isError。来源 trace ${result.sources.trace} / toolResult ${result.sources.toolResult} / 未知 ${result.sources.unknown}。未知中断连续失败，也中断同参数重试链。`,
		`原样重试仍失败 ${result.loops.retries} 次；最长连续失败 median ${result.loops.longest.median ?? "n/a"} / p90 ${result.loops.longest.p90 ?? "n/a"}；连续失败 ≥ ${FAILURE_STREAK_THRESHOLD} 的会话 ${result.loops.longStreakSessions}。`,
		`打转阈值：原样重试仍失败 ≥ ${RETRY_FAILURE_THRESHOLD} 或连续失败 ≥ ${FAILURE_STREAK_THRESHOLD}。${result.loops.loopingSessions}/${result.loops.sessions} 个会话命中，贡献工具失败 ${result.loops.loopingFailures}/${result.loops.failures}（${formatPercent(result.loops.failureShare)}），命令失败 ${result.loops.loopingCommandFailures}/${result.commandFailures}（${formatPercent(result.loops.commandFailureShare)}）。这些是过程信号，不是失败原因或用户不满意的证明。`, "",
		"## 与人工标注对照", "",
		"| 会话 | pass | fail |", "| --- | --- | --- |",
		`| 打转 | ${result.labels.looping.pass} | ${result.labels.looping.fail} |`,
		`| 非打转 | ${result.labels.nonLooping.pass} | ${result.labels.nonLooping.fail} |`,
		`n=${result.labels.n}；labels.jsonl ${result.labels.available ? "存在" : "不存在，未做标注对照"}。只计扫描范围内匹配的 pass/fail。`, "",
		"## 打转会话（仅私有文件）", "",
		...sessions.filter((row) => row.commandFailures.loops.looping).map((row) => `- ${markdownCell(row.sessionId)}`), "",
	].join("\n");
}

/** Command/legacy edit classification reads local text in memory only. Outputs
 * retain enum counts; session ids stay in the private Markdown. */
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
	const merged = await mergedLabels({ out });
	const labelsAvailable = merged.rows.length > 0;
	const labels = new Map(merged.rows.map((row) => [row.sessionId, row.verdict]));
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
			commandFailures: { ...sessionCommandFailures(loaded.branch, loaded.trace.tools), verdict: labels.get(loaded.header.id) },
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
	const commandFailures = aggregateCommandFailures(sessions.map((row) => row.commandFailures));
	commandFailures.labels.available = labelsAvailable;
	await privateWrite(join(dirname(out), "breakdown.md"), renderBreakdownMarkdown(aggregate, top, summary) + "\n" + renderCommandFailures(commandFailures, sessions));
	return {
		sessions: aggregate.sessions, toolTotals: aggregate.toolTotals, tools: aggregate.tools,
		concentration: aggregate.concentration, providerTotals: aggregate.providerTotals,
		providers: aggregate.providers, providerEnd: aggregate.providerEnd, editFailures: aggregate.editFailures, commandFailures,
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
	const { rows: labels, conflicts } = await mergedLabels({ out });
	const summary = { labeled: labels.length, pass: 0, fail: 0, failSet: 0, conflicts, categories: Object.create(null) };
	for (const label of labels) {
		if (label.verdict === "pass" || label.verdict === "fail") summary[label.verdict]++;
		if (label.failSet) summary.failSet++;
		for (const category of label.categories ?? []) increment(summary.categories, category);
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
	const annotations = await readAnnotations(dirname(out));
	let damaged = 0;
	for await (const entry of await opendir(out)) {
		if (!entry.name.endsWith(".md") || annotations.has(basename(entry.name, ".md"))) continue;
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
	const loaded = await mergedLabels({ out });
	const result = computeAgreement(loaded.rows.map((row) => ({
		sessionId: row.sessionId, verdict: row.verdict, categories: row.categories ?? [], signals: row.findings ?? {},
	})));
	const judge = judgeAgreement(loaded.rows, await latestJudgments(dirname(out), new Set(loaded.rows.map((row) => row.sessionId))));
	const judgeTable = `\n## 模型分析与人工标注\n\n仅统计成功、非 unsure 的最新分析；以不满意为阳性。\n\n| n | TP | FP | FN | TN |\n|---:|---:|---:|---:|---:|\n| ${judge.n}${judge.n < 10 ? "*" : ""} | ${judge.tp} | ${judge.fp} | ${judge.fn} | ${judge.tn} |\n\n* n < 10，样本少，不代表分析可靠性。\n`;
	await privateWrite(join(dirname(out), "agreement.md"), renderAgreementMarkdown(result) + judgeTable);
	// Review IDs belong only in the private Markdown, never stdout.
	return {
		totalRows: result.totalRows, evaluatedRows: result.evaluatedRows, ignoredVerdicts: result.ignoredVerdicts,
		signals: result.signals, categories: result.categories, uncoveredCategories: result.uncoveredCategories.length, judge,
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
