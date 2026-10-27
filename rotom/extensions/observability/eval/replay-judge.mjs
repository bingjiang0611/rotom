// What the replay model judge is allowed to read.
//
// The judge sees a short window before the cut, and that window is rendered, not
// serialized: an assistant message that carries a screenshot has thousands of
// characters of base64 and almost no text, so JSON.stringify + "last N chars"
// handed the judge noise and its verdict flipped between runs. Everything text
// based goes in; images and long binary runs become placeholders; the budget is
// filled backwards from the cut so the newest readable context survives.
//
// One function serves the runner (what is actually sent), the confirmation
// dialog (how many characters that is) and the original-reply control, so the
// number in the dialog is the number of characters the judge receives.
import { redactSecrets } from "./redaction.mjs";

export const REPLAY_JUDGE_PROMPT_VERSION = "rotom-replay-judge/v2";
/** Filled from the cut backwards, so the newest context is kept. */
export const REPLAY_JUDGE_BUDGET_CHARS = 12_000;
export const REPLAY_JUDGE_TOOL_ARGS_CHARS = 200;
export const REPLAY_JUDGE_TOOL_RESULT_CHARS = 600;
/** Longer runs of base64 alphabet are data, not prose. */
export const REPLAY_JUDGE_BINARY_RUN_CHARS = 256;

export const IMAGE_PLACEHOLDER = "[图片已省略]";
export const binaryPlaceholder = (length) => `[二进制数据已省略 ${length} 字符]`;
export const REPLAY_JUDGE_TRUNCATED = "[已截断]";

const BASE64_CHARS = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=");
const DATA_URI_TAIL = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,$/iu;

/**
 * Replace image payloads and long binary runs; the length is kept for context.
 *
 * Scanned by hand, not by regex: a `{256,}` quantifier over a multi-megabyte run
 * overflows the engine's stack and throws, which is the same class of failure
 * that took the judge down before. Wrapped base64 counts by its payload, so a
 * blob broken into 76-character lines is still recognised.
 */
export function readableText(value) {
	if (typeof value !== "string" || value.length === 0) return "";
	let out = "";
	let index = 0;
	while (index < value.length) {
		if (!BASE64_CHARS.has(value[index])) { out += value[index++]; continue; }
		let end = index, payload = 0;
		while (end < value.length) {
			const char = value[end];
			if (BASE64_CHARS.has(char)) { payload += 1; end += 1; continue; }
			if (char === "\n" || char === "\r") { end += 1; continue; }
			break;
		}
		if (payload < REPLAY_JUDGE_BINARY_RUN_CHARS) { out += value.slice(index, end); index = end; continue; }
		// A data URI's header belongs to the payload it introduces.
		const uri = DATA_URI_TAIL.exec(out);
		if (uri) out = out.slice(0, uri.index);
		out += binaryPlaceholder(end - index + (uri ? uri[0].length : 0));
		index = end;
	}
	return out;
}

/** Cut to `limit` characters in total, marker included, so budgets stay honest. */
function truncate(text, limit) {
	if (!Number.isFinite(limit) || limit <= 0) return "";
	if (text.length <= limit) return text;
	const keep = Math.max(0, limit - REPLAY_JUDGE_TRUNCATED.length);
	return text.slice(0, keep) + REPLAY_JUDGE_TRUNCATED;
}

function contentParts(content) {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? content : [];
}

/** Text of a message, with images and binary runs already replaced. */
function textOf(content) {
	const parts = [];
	for (const part of contentParts(content)) {
		if (part?.type === "text" && typeof part.text === "string") { const text = readableText(part.text).trim(); if (text) parts.push(text); continue; }
		if (part?.type === "image") parts.push(IMAGE_PLACEHOLDER);
	}
	return parts.join("\n");
}

function callLine(call) {
	let args;
	try { args = JSON.stringify(call.arguments ?? {}); } catch { args = "{}"; }
	return `工具调用 ${call.name} ${truncate(readableText(args), REPLAY_JUDGE_TOOL_ARGS_CHARS)}`;
}

/**
 * Render one entry as readable lines. Returns "" for entries that carry nothing
 * a judge can use (compaction markers, model changes, empty messages).
 */
export function replayJudgeBlock(entry) {
	const message = entry?.message ?? entry;
	const role = message?.role;
	if (role === "user") { const text = textOf(message.content); return text ? `用户：${text}` : ""; }
	if (role === "assistant") {
		const parts = [];
		const text = textOf(message.content);
		if (text) parts.push(text);
		for (const part of contentParts(message.content)) if (part?.type === "toolCall") parts.push(callLine(part));
		return parts.length ? `助手：${parts.join("\n")}` : "";
	}
	if (role === "toolResult") {
		const text = truncate(textOf(message.content), REPLAY_JUDGE_TOOL_RESULT_CHARS);
		return `工具结果（${message.isError === true ? "失败" : "成功"}）：${text || "（无文本）"}`;
	}
	return "";
}

/**
 * Judge context for a cut: readable blocks, redacted, then cut to the budget
 * from the newest block backwards.
 *
 * Redaction runs before truncation per block, so a secret inside a long field is
 * replaced even when the field is later shortened, and the reported character
 * count is the text itself (the prompt wraps it with labels the judge adds).
 */
export function replayJudgeContext(entries, budgetChars = REPLAY_JUDGE_BUDGET_CHARS) {
	const budget = Number.isFinite(budgetChars) ? Math.max(0, Math.floor(budgetChars)) : REPLAY_JUDGE_BUDGET_CHARS;
	const blocks = (Array.isArray(entries) ? entries : []).map(replayJudgeBlock).filter(Boolean);
	const kept = [];
	const redactions = new Map();
	let left = budget;
	for (let index = blocks.length - 1; index >= 0 && left > 0; index -= 1) {
		const redacted = redactSecrets(blocks[index]);
		const text = redacted.text;
		const room = left - 1; // the joining newline
		if (room <= 0) break;
		const shown = text.length <= room ? text : truncate(text, room);
		// Count only the markers that survived truncation, as the judge reports them.
		for (const { type } of redacted.redactions) {
			const present = shown.split(`[已脱敏:${type}]`).length - 1;
			if (present) redactions.set(type, (redactions.get(type) ?? 0) + present);
		}
		kept.unshift(shown);
		left -= shown.length + 1;
		if (shown.length < text.length) break;
	}
	const text = kept.join("\n");
	const list = [...redactions].sort(([a], [b]) => a.localeCompare(b)).map(([type, count]) => ({ type, count }));
	return { text, chars: text.length, redactions: list, redactionTotal: list.reduce((total, row) => total + row.count, 0) };
}
