// Pure planning/rendering for model-driven context folding. No Pi imports, no I/O:
// index.ts feeds Pi's branch and projection in and commits the returned drafts.
//
// Contract (see docs/agent/context-fold.md):
// - A fold covers whole tool steps inside one user segment. User/custom/bash/
//   compaction messages are never edited and a range may not cross them.
// - The first step's assistant message stays verbatim (thinking signatures and
//   tool-call ids remain valid); its first tool result holds the summary and every
//   later message in the range is omitted. The result is always a subsequence of
//   complete assistant→toolResult pairs, so no provider sees new role adjacency.
// - Originals stay in the session file; recall reads them back at the tail.

export const FOLD_RECORD_TYPE = "rotom-context-fold";
export const RECALL_PAGE_CHARS = 12_000;
const SEARCH_MATCH_LIMIT = 20;
const SEARCH_SNIPPET_CHARS = 120;
const PREVIEW_CHARS = 72;
// Images are counted as a fixed size; this is an estimate label, not a token count.
const IMAGE_CHARS_ESTIMATE = 6_000;

export type Entry = { id: string; type: string; message?: any; customType?: string; data?: any; content?: unknown };
export type ProjectedEntry = { sourceEntry: Entry; messages: any[] };
export type FoldRecord = { v: 1; block: string; from: string; to: string; holderId: string; targetIds: string[] };
export type Draft =
	| { type: "context_edit"; targetId: string; replacement: { content: { type: "text"; text: string }[] } | null }
	| { type: "custom"; customType: string; data: FoldRecord };

type Row = {
	id: string;
	kind: "assistant" | "toolResult" | "boundary";
	role: string;
	message: any;
	chars: number;
};

export function readFoldRecords(branch: readonly Entry[]): FoldRecord[] {
	return branch
		.filter((entry) => entry.type === "custom" && entry.customType === FOLD_RECORD_TYPE && entry.data?.v === 1)
		.map((entry) => entry.data as FoldRecord);
}

function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const part of content) {
		if (part?.type === "text") chars += part.text.length;
		else if (part?.type === "thinking") chars += part.thinking.length;
		else if (part?.type === "toolCall") chars += part.name.length + JSON.stringify(part.arguments ?? {}).length;
		else if (part?.type === "image") chars += IMAGE_CHARS_ESTIMATE;
	}
	return chars;
}

const estimateTokens = (chars: number) => Math.ceil(chars / 4);
const formatTokens = (chars: number) => {
	const tokens = estimateTokens(chars);
	return tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k` : `~${tokens}`;
};

function toolCallIds(message: any): string[] {
	return Array.isArray(message?.content) ? message.content.filter((part: any) => part?.type === "toolCall").map((part: any) => part.id) : [];
}

/** Model-visible rows before the current (still running) assistant step. */
function visibleRows(projection: readonly ProjectedEntry[], currentEntryId: string | undefined): Row[] {
	const rows: Row[] = [];
	for (const projected of projection) {
		if (projected.messages.length === 0) continue;
		const entry = projected.sourceEntry;
		if (entry.id === currentEntryId) break;
		const message = projected.messages[0];
		const role = String(message?.role);
		const kind = entry.type === "message" && (role === "assistant" || role === "toolResult") ? role : "boundary";
		rows.push({ id: entry.id, kind, role, message, chars: projected.messages.reduce((sum, item) => sum + contentChars(item?.content), 0) });
	}
	return rows;
}

function holderBlocks(records: readonly FoldRecord[]): Map<string, FoldRecord> {
	// A later fold that contains an older holder replaces it, so the newest record wins.
	const byHolder = new Map<string, FoldRecord>();
	for (const record of records) byHolder.set(record.holderId, record);
	return byHolder;
}

const MANIFEST_CHARS = 600;

/**
 * A fold block must show that the folded steps are the model's own completed calls,
 * otherwise the model sees summaries with no trace of its own actions and starts
 * distrusting them as claims it cannot verify (observed: a 700-file run abandoned
 * the task for exactly this reason). Listing the folded calls keeps that evidence
 * without restoring the results.
 */
function manifest(labels: readonly string[]): string {
	const kept: string[] = [];
	let used = 0;
	for (const label of labels) {
		if (used + label.length > MANIFEST_CHARS) break;
		kept.push(label);
		used += label.length + 2;
	}
	const more = labels.length - kept.length;
	return `${kept.join(", ")}${more > 0 ? `, +${more} more` : ""}`;
}

function holderText(block: string, steps: number, summary: string, labels: readonly string[]): string {
	const head = `[context fold ${block} · you completed these ${steps} step(s) earlier; their results are folded out of view, not lost. Re-read any original with context recall block=${block}]`;
	const calls = labels.length > 0 ? `folded calls: ${manifest(labels)}\n` : "";
	return `${head}\n${calls}${summary}`;
}

export type FoldRequest = { from: string; to: string; summary: string; currentEntryId: string | undefined };
export type FoldPlan =
	| { ok: true; block: string; drafts: Draft[]; steps: number; foldedChars: number }
	| { ok: false; error: string };

export function planFold(projection: readonly ProjectedEntry[], branch: readonly Entry[], request: FoldRequest): FoldPlan {
	const summary = request.summary.trim();
	if (!summary) return { ok: false, error: "summary must not be empty." };
	const rows = visibleRows(projection, request.currentEntryId);
	const start = rows.findIndex((row) => row.id === request.from);
	if (start < 0 || rows[start].kind !== "assistant") {
		return { ok: false, error: `from=${request.from} is not a visible completed step. Use a step id from context outline.` };
	}
	const last = rows.findIndex((row) => row.id === request.to);
	if (last < start || rows[last].kind !== "assistant") {
		return { ok: false, error: `to=${request.to} is not a visible completed step at or after from. Use a step id from context outline.` };
	}
	let end = last;
	while (end + 1 < rows.length && rows[end + 1].kind === "toolResult") end += 1;
	const range = rows.slice(start, end + 1);
	const boundary = range.find((row) => row.kind === "boundary");
	if (boundary) {
		return { ok: false, error: `The range crosses a ${boundary.role} message (${boundary.id}); user and system messages are never folded. Fold each segment separately.` };
	}
	const first = range[0];
	const firstCalls = new Set(toolCallIds(first.message));
	const firstResults = range.filter((row, index) => index > 0 && row.kind === "toolResult" && firstCalls.has(row.message.toolCallId));
	if (firstResults.length === 0 || range[1] !== firstResults[0]) {
		return { ok: false, error: `from=${request.from} must be a tool step whose result follows it; text-only replies cannot start a fold.` };
	}

	const records = readFoldRecords(branch);
	const byHolder = holderBlocks(records);
	const block = `b${records.length + 1}`;
	const holder = firstResults[0];
	const steps = range.filter((row) => row.kind === "assistant").length;
	const foldedChars = range.slice(1).reduce((sum, row) => sum + row.chars, 0);
	if (summary.length * 2 > foldedChars) {
		return { ok: false, error: `The summary (${summary.length} chars) must be at most half of the folded content (${foldedChars} chars, ${formatTokens(foldedChars)} tokens). Choose a larger range or a shorter summary.` };
	}

	const drafts: Draft[] = [];
	const labels: string[] = [];
	for (const row of range) {
		if (row.kind === "assistant") {
			const calls = Array.isArray(row.message?.content) ? row.message.content.filter((part: any) => part?.type === "toolCall") : [];
			for (const part of calls) labels.push(toolCallLabel(part));
		}
	}
	const targetIds = new Set<string>();
	for (const row of range) {
		targetIds.add(row.id);
		// Nested folds: an older holder inside the range carries its own hidden targets.
		for (const id of byHolder.get(row.id)?.targetIds ?? []) targetIds.add(id);
		if (row === first) continue;
		if (row === holder) drafts.push({ type: "context_edit", targetId: row.id, replacement: { content: [{ type: "text", text: holderText(block, steps, summary, labels) }] } });
		else if (firstResults.includes(row)) drafts.push({ type: "context_edit", targetId: row.id, replacement: { content: [{ type: "text", text: `[folded into ${block}]` }] } });
		else drafts.push({ type: "context_edit", targetId: row.id, replacement: null });
	}
	const order = new Map(branch.map((entry, index) => [entry.id, index] as const));
	const sortedTargets = [...targetIds].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
	drafts.push({ type: "custom", customType: FOLD_RECORD_TYPE, data: { v: 1, block, from: first.id, to: range[range.length - 1].id, holderId: holder.id, targetIds: sortedTargets } });
	return { ok: true, block, drafts, steps, foldedChars };
}

function preview(text: string): string {
	const flat = text.replace(/\s+/gu, " ").trim();
	return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

function toolCallLabel(part: any): string {
	const args = part.arguments ?? {};
	const hint = [args.path, args.file_path, args.command, args.pattern, args.query, args.action].find((value) => typeof value === "string");
	return hint ? `${part.name}(${preview(hint).slice(0, 40)})` : part.name;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n");
}

export type OutlinePage = { text: string; total: number; nextOffset?: number };

type Range = { from: string; to: string; steps: number; messages: number; chars: number };
type Step = { id: string; chars: number; results: number; folded: boolean };

// A suggestion must be worth the round trip and the cache re-prefill it causes.
const MIN_FOLD_CHARS = 20_000;
const MAX_SUGGESTIONS = 3;

/**
 * Concrete fold ranges the model can pass to `fold` without deriving ids itself.
 * A range is a maximal run of consecutive steps that each end in tool results, so it
 * never starts at a text-only reply and never crosses a boundary message. `to` is the
 * last step with results: a trailing narrative reply stays verbatim. Already-folded
 * steps are skipped, because folding them again would only absorb their own holder.
 */
function foldableRanges(rows: readonly Row[], byHolder: Map<string, FoldRecord>): Range[] {
	const ranges: Range[] = [];
	let steps: Step[] = [];
	const flush = () => {
		let cursor = 0;
		while (cursor < steps.length) {
			if (steps[cursor].results === 0 || steps[cursor].folded) { cursor += 1; continue; }
			let end = cursor;
			let chars = 0;
			let messages = 0;
			while (end < steps.length && steps[end].results > 0 && !steps[end].folded) {
				chars += steps[end].chars;
				messages += 1 + steps[end].results;
				end += 1;
			}
			if (chars >= MIN_FOLD_CHARS) {
				ranges.push({ from: steps[cursor].id, to: steps[end - 1].id, steps: end - cursor, messages, chars });
			}
			cursor = end;
		}
		steps = [];
	};
	for (const row of rows) {
		if (row.kind === "boundary") { flush(); continue; }
		if (row.kind === "assistant") steps.push({ id: row.id, chars: row.chars, results: 0, folded: false });
		else {
			const step = steps[steps.length - 1];
			if (!step) continue;
			step.chars += row.chars;
			step.results += 1;
			if (byHolder.has(row.id)) step.folded = true;
		}
	}
	flush();
	return ranges.slice(0, MAX_SUGGESTIONS);
}

export function renderOutline(projection: readonly ProjectedEntry[], branch: readonly Entry[], options: { currentEntryId: string | undefined; offset: number; limit: number; usage?: { tokens: number | null; percent: number | null; contextWindow: number } }): OutlinePage {
	const rows = visibleRows(projection, options.currentEntryId);
	const byHolder = holderBlocks(readFoldRecords(branch));
	const lines: string[] = [];
	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index];
		if (row.kind === "toolResult") continue;
		if (row.kind === "boundary") {
			lines.push(`${row.id}  ${row.role}  "${preview(textOf(row.message?.content))}"  (boundary, never folded)`);
			continue;
		}
		let chars = row.chars;
		let holder: FoldRecord | undefined;
		for (let next = index + 1; next < rows.length && rows[next].kind === "toolResult"; next += 1) {
			chars += rows[next].chars;
			holder ??= byHolder.get(rows[next].id);
		}
		const calls = Array.isArray(row.message?.content) ? row.message.content.filter((part: any) => part?.type === "toolCall") : [];
		const what = calls.length > 0 ? calls.map(toolCallLabel).join(", ") : `text "${preview(textOf(row.message?.content))}"`;
		const fold = holder ? `  [fold ${holder.block}: ${holder.targetIds.length} messages hidden]` : "";
		lines.push(`${row.id}  step  ${what}  ${formatTokens(chars)} tok${fold}`);
	}
	const page = lines.slice(options.offset, options.offset + options.limit);
	const usage = options.usage?.tokens != null && options.usage.percent != null
		? `context ~${options.usage.tokens} tokens (${Math.round(options.usage.percent)}% of ${options.usage.contextWindow})`
		: "context usage unknown until the next model response";
	const nextOffset = options.offset + page.length < lines.length ? options.offset + page.length : undefined;
	const ranges = foldableRanges(rows, byHolder);
	const suggestions = ranges.length === 0
		? "Foldable ranges: none yet. Nothing old enough is large enough to be worth folding."
		: ["Foldable ranges, oldest first (pass from/to to action=fold):",
			...ranges.map((range) => `  from=${range.from} to=${range.to}  ${range.steps} step(s), ${range.messages} messages, ${formatTokens(range.chars)} tokens`),
			`Example: context fold from=${ranges[0].from} to=${ranges[0].to} summary="..."`].join("\n");
	const header = `Context outline, oldest first: rows ${options.offset}-${options.offset + page.length} of ${lines.length}; ${usage}. Token figures are chars/4 estimates. The current step is excluded.`;
	const footer = nextOffset === undefined ? "" : `\n[more rows: context outline offset=${nextOffset}]`;
	return { text: `${header}\n${page.join("\n")}${footer}\n\n${suggestions}`, total: lines.length, nextOffset };
}

function renderEntry(entry: Entry): string {
	if (entry.type === "custom_message") return `[${entry.id} · custom]\n${textOf(entry.content)}`;
	const message = entry.message;
	if (!message) return `[${entry.id} · ${entry.type}]`;
	if (message.role === "assistant") {
		const parts = (message.content ?? []).flatMap((part: any) => {
			if (part?.type === "text") return [part.text];
			if (part?.type === "toolCall") return [`→ ${part.name} ${JSON.stringify(part.arguments ?? {})}`];
			return [];
		});
		return `[${entry.id} · assistant]\n${parts.join("\n")}`;
	}
	if (message.role === "toolResult") {
		const parts = (message.content ?? []).map((part: any) => part?.type === "image" ? "[image omitted]" : part?.text ?? "");
		return `[${entry.id} · result of ${message.toolName}${message.isError ? " · error" : ""}]\n${parts.join("\n")}`;
	}
	return `[${entry.id} · ${message.role}]\n${textOf(message.content)}`;
}

const PATH_KEYS = ["path", "file_path"];
const MUTATING_TOOLS = new Set(["edit", "write"]);

function pathsIn(entry: Entry): string[] {
	const content = entry.message?.role === "assistant" ? entry.message.content ?? [] : [];
	return content.flatMap((part: any) => part?.type === "toolCall" ? PATH_KEYS.map((key) => part.arguments?.[key]).filter((value: unknown) => typeof value === "string") : []);
}

/** Exact-path notes for files that edit/write touched after the recalled originals. */
function laterChanges(branch: readonly Entry[], recalled: readonly Entry[]): string[] {
	const paths = new Set(recalled.flatMap(pathsIn));
	if (paths.size === 0) return [];
	const lastIndex = Math.max(...recalled.map((entry) => branch.indexOf(entry)));
	const notes = new Map<string, string>();
	for (const entry of branch.slice(lastIndex + 1)) {
		if (entry.message?.role !== "assistant") continue;
		for (const part of entry.message.content ?? []) {
			if (part?.type !== "toolCall" || !MUTATING_TOOLS.has(part.name)) continue;
			for (const key of PATH_KEYS) {
				const path = part.arguments?.[key];
				if (typeof path === "string" && paths.has(path) && !notes.has(path)) notes.set(path, entry.id);
			}
		}
	}
	return [...notes].map(([path, id]) => `${path} was modified later by step ${id}; read it again for its current content.`);
}

export type RecallResult = { ok: true; text: string; nextOffset?: number } | { ok: false; error: string };

export function recallBlock(branch: readonly Entry[], block: string, offset: number): RecallResult {
	const record = readFoldRecords(branch).find((candidate) => candidate.block === block);
	if (!record) return { ok: false, error: `Unknown fold block ${block} on this branch.` };
	const byId = new Map(branch.map((entry) => [entry.id, entry] as const));
	const entries = record.targetIds.map((id) => byId.get(id)).filter((entry): entry is Entry => entry !== undefined);
	const full = entries.map(renderEntry).join("\n\n");
	const page = full.slice(offset, offset + RECALL_PAGE_CHARS);
	const nextOffset = offset + page.length < full.length ? offset + page.length : undefined;
	const pageEntries = entries.filter((entry) => page.includes(`[${entry.id} · `));
	const notes = laterChanges(branch, pageEntries);
	const header = `[recall ${block} · chars ${offset}-${offset + page.length} of ${full.length} · historical originals, not current state]`;
	const footer = [
		...notes.map((note) => `Note: ${note}`),
		...(nextOffset === undefined ? [] : [`[more: context recall block=${block} offset=${nextOffset}]`]),
	];
	return { ok: true, text: [header, page, ...footer].join("\n"), nextOffset };
}

/** Search originals that are not currently visible: folded targets and compacted history. */
export function searchHidden(projection: readonly ProjectedEntry[], branch: readonly Entry[], query: string): RecallResult {
	const needle = query.trim().toLowerCase();
	if (!needle) return { ok: false, error: "query must not be empty." };
	const records = readFoldRecords(branch);
	const blockOf = new Map<string, string>();
	for (const record of records) for (const id of record.targetIds) blockOf.set(id, record.block);
	const visible = new Set(projection.filter((entry) => entry.messages.length > 0).map((entry) => entry.sourceEntry.id));
	const matches: string[] = [];
	let total = 0;
	for (const entry of branch) {
		const hidden = blockOf.has(entry.id) || (!visible.has(entry.id) && (entry.type === "message" || entry.type === "custom_message"));
		if (!hidden || (entry.type === "message" && entry.message?.role === "system")) continue;
		const text = renderEntry(entry);
		const lower = text.toLowerCase();
		for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
			total += 1;
			if (matches.length >= SEARCH_MATCH_LIMIT) continue;
			const where = blockOf.get(entry.id) ?? "compacted";
			const snippet = text.slice(Math.max(0, at - SEARCH_SNIPPET_CHARS), at + needle.length + SEARCH_SNIPPET_CHARS).replace(/\s+/gu, " ");
			matches.push(`${where} · ${entry.id}: …${snippet}…`);
		}
	}
	const header = `[recall search "${query}" · ${total} match(es) in hidden history${total > matches.length ? `, first ${matches.length} shown` : ""} · historical originals, not current state]`;
	return { ok: true, text: matches.length > 0 ? `${header}\n${matches.join("\n")}` : `${header}\nNo matches.` };
}
