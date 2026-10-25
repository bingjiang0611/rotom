import { createHash } from "node:crypto";
import { RULE_IDS, TOOL_RESULT_BYTE_THRESHOLD } from "./trace-assertions.mjs";

export const FOCUS_TOOL_ERRORS_MIN = 5;
export const FOCUS_TOOL_ERROR_RATE_MIN = 0.1;

function isoWeek(timestamp) {
	const time = Date.parse(timestamp);
	if (!Number.isFinite(time)) return null;
	const date = new Date(time);
	const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	const weekday = day.getUTCDay() || 7;
	day.setUTCDate(day.getUTCDate() + 4 - weekday);
	const year = day.getUTCFullYear();
	const week = Math.ceil(((day - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
	return `${year}-W${String(week).padStart(2, "0")}`;
}

// Mirrors the card's final-reply rendering: text parts count as text, images as "(image)".
function hasFinalText(content) {
	if (typeof content === "string") return content.length > 0;
	if (!Array.isArray(content)) return false;
	return content.some((part) => (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) || part?.type === "image");
}

function findingStatus(findings, rule) {
	const status = findings?.find((finding) => finding.rule === rule)?.status;
	return status === "hit" || status === "clear" || status === "unknown" ? status : null;
}

/** Pure per-session metrics. Inputs come from build's reader, branch reconstruction
 * and trace association; nothing here touches the filesystem. Unavailable values
 * stay null so an absent trace or usage is never reported as zero. */
export function sessionMetrics({ header, branch, traceTools, traceStatus, findings }) {
	const messages = branch.filter((entry) => entry.type === "message" && entry.message).map((entry) => entry.message);
	const assistants = messages.filter((message) => message.role === "assistant");
	const models = new Set();
	const calls = [];
	let tokens = null;
	let costSum = 0;
	let costPartial = false;
	for (const entry of branch) {
		if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
			models.add(`${entry.provider}/${entry.modelId}`);
		}
	}
	for (const message of assistants) {
		if (message.provider && message.model) models.add(`${message.provider}/${message.model}`);
		if (message.usage && typeof message.usage === "object") {
			tokens ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
			for (const key of Object.keys(tokens)) if (Number.isFinite(message.usage[key])) tokens[key] += message.usage[key];
		}
		const total = message.usage?.cost?.total;
		if (Number.isFinite(total)) costSum += total;
		else costPartial = true;
		for (const part of Array.isArray(message.content) ? message.content : []) if (part?.type === "toolCall") calls.push(part);
	}
	// Unfinished spans are exposed as empty attribute maps, so only non-empty ones
	// count as ended. A missing trace makes both the count and the rate unknown.
	const spans = traceStatus === "missing" ? null : [...traceTools.values()].filter((attributes) => attributes && typeof attributes === "object" && Object.keys(attributes).length > 0);
	const endedToolSpans = spans ? spans.length : null;
	const toolErrors = spans ? spans.filter((attributes) => typeof attributes["pi.tool.outcome"] === "string" && attributes["pi.tool.outcome"] !== "ok").length : null;
	let oversizedResults = null;
	if (traceStatus !== "missing") {
		oversizedResults = 0;
		for (const call of calls) {
			if (typeof call.id !== "string") continue;
			const bytes = traceTools.get(createHash("sha256").update(call.id).digest("hex"))?.["pi.tool.result_text_bytes"];
			if (Number.isFinite(bytes) && bytes > TOOL_RESULT_BYTE_THRESHOLD) oversizedResults++;
		}
	}
	const first = Date.parse(branch[0]?.timestamp);
	const last = Date.parse(branch.at(-1)?.timestamp);
	const lastAssistant = assistants.at(-1);
	const providerError = findingStatus(findings, "ended-on-provider-error");
	const startedAt = typeof header?.timestamp === "string" ? header.timestamp : null;
	return {
		startedAt,
		week: startedAt === null ? null : isoWeek(startedAt),
		durationMs: Number.isFinite(first) && Number.isFinite(last) ? last - first : null,
		models: [...models].sort(),
		assistantTurns: assistants.length,
		toolCalls: calls.length,
		toolErrors,
		endedToolSpans,
		toolErrorRate: endedToolSpans ? toolErrors / endedToolSpans : null,
		tokens,
		costUsd: assistants.length > 0 && !costPartial ? costSum : null,
		costPartial,
		oversizedResults,
		endedWithoutFinalText: lastAssistant ? !hasFinalText(lastAssistant.content) : null,
		endedOnProviderError: providerError === "hit" ? true : providerError === "clear" ? false : null,
		ruleHits: (findings ?? []).filter((finding) => finding.status === "hit").map((finding) => finding.rule),
	};
}

/** Named focus thresholds for cards that deserve a closer human look. */
export function focusCandidate(metrics) {
	const conditions = {
		toolErrors:
			Number.isFinite(metrics.toolErrors) && metrics.toolErrors >= FOCUS_TOOL_ERRORS_MIN &&
			Number.isFinite(metrics.toolErrorRate) && metrics.toolErrorRate >= FOCUS_TOOL_ERROR_RATE_MIN,
		ruleHit: metrics.ruleHits.length > 0,
		endedWithoutFinalText: metrics.endedWithoutFinalText === true,
		endedOnProviderError: metrics.endedOnProviderError === true,
	};
	return { matched: Object.values(conditions).some(Boolean), conditions };
}

/** Nearest-rank p90 and the usual median over finite samples only. */
function summarize(values) {
	const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
	if (finite.length === 0) return { n: 0, median: null, p90: null };
	const middle = finite.length % 2 === 1
		? finite[(finite.length - 1) / 2]
		: (finite[finite.length / 2 - 1] + finite[finite.length / 2]) / 2;
	return { n: finite.length, median: middle, p90: finite[Math.ceil(0.9 * finite.length) - 1] };
}

function share(rows, value) {
	const known = rows.filter((row) => value(row) !== null);
	const count = known.filter((row) => value(row) === true).length;
	return { n: known.length, count, share: known.length === 0 ? null : count / known.length };
}

function groupSummary(rows) {
	const spans = rows.filter((row) => Number.isFinite(row.toolErrors) && Number.isFinite(row.endedToolSpans) && row.endedToolSpans > 0);
	const errors = spans.reduce((sum, row) => sum + row.toolErrors, 0);
	const ended = spans.reduce((sum, row) => sum + row.endedToolSpans, 0);
	const costed = rows.filter((row) => Number.isFinite(row.costUsd));
	const costTotal = costed.reduce((sum, row) => sum + row.costUsd, 0);
	return {
		sessions: rows.length,
		toolCalls: summarize(rows.map((row) => row.toolCalls)),
		durationMs: summarize(rows.map((row) => row.durationMs)),
		tokens: summarize(rows.map((row) => (row.tokens ? row.tokens.input + row.tokens.output : null))),
		// Total errors over total ended spans: not an average of per-session rates.
		toolErrorRate: { n: spans.length, errors, endedSpans: ended, rate: ended === 0 ? null : errors / ended },
		endedWithoutFinalText: share(rows, (row) => row.endedWithoutFinalText),
		endedOnProviderError: share(rows, (row) => row.endedOnProviderError),
		ruleHits: Object.fromEntries(RULE_IDS.map((rule) => [rule, share(rows, (row) => row.ruleHits.includes(rule))])),
		costUsd: {
			n: costed.length, total: costed.length === 0 ? null : costTotal,
			partial: rows.some((row) => row.costPartial), partialSessions: rows.filter((row) => row.costPartial).length,
		},
	};
}

/** Aggregate by ISO week and by provider/model. A session counts once per model it used. */
export function aggregateMetrics(rows) {
	const weeks = new Map();
	const models = new Map();
	let unknownWeek = 0;
	let unknownModel = 0;
	for (const row of rows) {
		if (row.week === null) unknownWeek++;
		else {
			if (!weeks.has(row.week)) weeks.set(row.week, []);
			weeks.get(row.week).push(row);
		}
		if (row.models.length === 0) unknownModel++;
		for (const model of row.models) {
			if (!models.has(model)) models.set(model, []);
			models.get(model).push(row);
		}
	}
	return {
		unknownWeek,
		unknownModel,
		weeks: [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, group]) => ({ week, ...groupSummary(group) })),
		models: [...models.entries()]
			.sort(([nameA, a], [nameB, b]) => b.length - a.length || nameA.localeCompare(nameB))
			.map(([model, group]) => ({ model, ...groupSummary(group) })),
	};
}
