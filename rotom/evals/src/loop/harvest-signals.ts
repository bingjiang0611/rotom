import { bigrams, humanText, isCorrection, isRecord, normalized, similarity, textOf } from "./harvest-text.ts";
import { messageOf, type Entry, type Message } from "./harvest-tree.ts";

export type StartSource = "header" | "first-entry" | "file-mtime" | "unknown";

// Signal classification for one incident: which error class a failed tool result belongs to,
// and what the session was doing when the user's abort landed.

/** Error classes for tool failures. Only the class is stored; the text stays local. */
export const TOOL_ERROR_CATEGORIES = ["timeout", "stale", "not-found", "permission", "syntax", "ambiguous-match", "command-failed", "invalid-arguments", "network", "other"] as const;
export type ToolErrorCategory = (typeof TOOL_ERROR_CATEGORIES)[number];

const TOOL_ERROR_MATCHERS: readonly [ToolErrorCategory, RegExp][] = [
	["timeout", /timed?\s?out|timeout|deadline exceeded/iu],
	["stale", /stale|epoch|outside the target root/iu],
	["ambiguous-match", /found \d+ occurrences|must match|no exact match/iu],
	["not-found", /no such file|not found|不存在|ENOENT|cannot find module/iu],
	["permission", /permission denied|EACCES|EPERM|not permitted/iu],
	["syntax", /syntaxerror|unexpected token|parse error|unterminated/iu],
	["invalid-arguments", /invalid (?:argument|tool)|互斥|arguments? (?:rejected|invalid)|schema/iu],
	["network", /ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|network/iu],
	["command-failed", /command failed|exited with|exit code|non-zero|command aborted/iu],
];

/** Deterministic bucket for a failed tool result; the ordered matchers decide first match wins. */
export function toolErrorCategory(text: string): ToolErrorCategory {
	for (const [category, pattern] of TOOL_ERROR_MATCHERS) if (pattern.test(text)) return category;
	return "other";
}

/** What the run was doing when the user's abort landed. */
export type InterruptActivity = "waiting-first-byte" | "streaming-text" | "streaming-thinking" | "streaming-tool-call" | "tool-executing";
/** First non-control entry after the abort: who or what moved the session on. */
export type InterruptCause = "human" | "injected" | "compaction" | "system" | "no-following-turn" | "unknown";
export type InterruptFollowUp = "none" | "injected" | "correction" | "repeat" | "new-topic" | "new-info";

export function interruptActivity(message: Message, parent: Entry | undefined): { activity: InterruptActivity; tool?: string } {
	const blocks = Array.isArray(message.content) ? (message.content as unknown[]).filter(isRecord) : [];
	const parentMessage = parent ? messageOf(parent) : undefined;
	if (parentMessage?.role === "toolResult" && parentMessage.isError === true) {
		const text = textOf(parentMessage.content);
		// The tool itself reported the interruption, so it was the running step.
		if (/^command aborted/iu.test(text.trim())) return { activity: "tool-executing", tool: typeof parentMessage.toolName === "string" ? parentMessage.toolName : "unknown" };
	}
	if (blocks.some((block) => block.type === "text")) return { activity: "streaming-text" };
	if (blocks.some((block) => block.type === "thinking")) return { activity: "streaming-thinking" };
	if (blocks.some((block) => block.type === "toolCall")) return { activity: "streaming-tool-call" };
	return { activity: "waiting-first-byte" };
}

/**
 * Why an interrupt counts against quality, which is the second north star.
 *
 * `self-retract` is the person giving up before anything happened: still waiting for the first
 * byte and under two seconds. `quality` is a run that was already doing something (tool,
 * text, tool call) or a wait long enough that giving up is a judgement about the run.
 * Everything else is `other` and stays out of v2.
 */
export type InterruptTriage = "self-retract" | "quality" | "other";

/** Under two seconds of silence is the person retracting, not a verdict on the run. */
export const SELF_RETRACT_MAX_MS = 2_000;
/** Ten seconds of waiting is long enough that the user is judging the run, not the click. */
export const QUALITY_WAIT_MS = 10_000;

export function interruptTriage(activity: InterruptActivity | string | undefined, elapsedMs: number | undefined): InterruptTriage {
	if (activity === "tool-executing" || activity === "streaming-text" || activity === "streaming-tool-call") return "quality";
	const elapsed = typeof elapsedMs === "number" && Number.isFinite(elapsedMs) ? elapsedMs : undefined;
	if (elapsed !== undefined && elapsed >= QUALITY_WAIT_MS) return "quality";
	if (activity === "waiting-first-byte" && elapsed !== undefined && elapsed < SELF_RETRACT_MAX_MS) return "self-retract";
	return "other";
}

/**
 * Product runtime that served a session, from the trace's `pi.session.runtime` span. Only
 * sessions with observability enabled carry it, so the runtime split has partial coverage and
 * the report says how many sessions it covers instead of treating silence as a version.
 */
export function runtimeVersionOf(traceLines: readonly string[] | undefined): string | undefined {
	return runtimeAttribute(traceLines, "pi.runtime.version");
}

/**
 * Installed rotom product version, from the same `pi.session.runtime` span. Kept apart from the
 * Pi fork version because a product release and the runtime it loads move independently: the
 * per-version table is only readable when the two are not folded into one label.
 */
export function productVersionOf(traceLines: readonly string[] | undefined): string | undefined {
	return runtimeAttribute(traceLines, "rotom.product.version");
}

function runtimeAttribute(traceLines: readonly string[] | undefined, name: string): string | undefined {
	for (const line of traceLines ?? []) {
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(record) || record.name !== "pi.session.runtime" || record.kind !== "span_start") continue;
		const attributes = isRecord(record.attributes) ? record.attributes : {};
		const version = attributes[name];
		if (typeof version === "string" && version) return version;
	}
	return undefined;
}

/**
 * SoL-Pi version a session actually ran, read only from an artifact path the session recorded
 * (the vendored `sol-pi-<version>.tgz`). Nothing writes this per session today, so the value is
 * usually absent and the report counts it as `unknown` instead of inferring it from a product
 * version that merely could have been installed.
 */
export function solPiVersionOf(lines: readonly string[], traceLines: readonly string[] | undefined): string | undefined {
	const pattern = /sol-pi-(\d[0-9A-Za-z.-]*)\.tgz/gu;
	const counts = new Map<string, number>();
	for (const line of [...lines, ...(traceLines ?? [])]) for (const match of line.matchAll(pattern)) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
	let best: string | undefined;
	for (const [version, count] of counts) if (!best || count > (counts.get(best) ?? 0)) best = version;
	return best;
}

export function interruptFollowUp(requestText: string, text: string): InterruptFollowUp {
	if (!text) return "injected";
	if (isCorrection(text)) return "correction";
	if (requestText && similarity(requestText, text) >= 0.8) return "repeat";
	const requested = bigrams(normalized(requestText));
	const overlap = [...bigrams(normalized(text))].some((gram) => requested.has(gram));
	return overlap ? "new-info" : "new-topic";
}

/**
 * Control entries carry no human or system action; they are skipped when reading what follows.
 * An empty system message is written on a model switch or restart, so it is not an event either.
 */
export function isControlEntry(entry: Entry): boolean {
	if (entry.type === "model_change" || entry.type === "thinking_level_change" || entry.type === "session" || entry.type === "custom") return true;
	const message = messageOf(entry);
	return message?.role === "system" && textOf(message.content).trim() === "";
}

/** A timestamp is usable only if it parses and is not the 1970 epoch a broken clock writes. */
export function usableTimestamp(value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	const time = Date.parse(value);
	if (Number.isNaN(time)) return undefined;
	return new Date(time).getUTCFullYear() < 2000 ? undefined : value;
}

/** Session start and where it came from; the file mtime is the last resort before `unknown`. */
export function resolveStartedAt(headerTimestamp: unknown, firstEntryTimestamp: unknown, fileMtimeMs?: number): { startedAt: string; startedAtSource: StartSource } {
	const header = usableTimestamp(headerTimestamp);
	if (header) return { startedAt: header, startedAtSource: "header" };
	const first = usableTimestamp(firstEntryTimestamp);
	if (first) return { startedAt: first, startedAtSource: "first-entry" };
	const mtime = fileMtimeMs !== undefined && Number.isFinite(fileMtimeMs) ? new Date(fileMtimeMs).toISOString() : undefined;
	if (mtime && usableTimestamp(mtime)) return { startedAt: mtime, startedAtSource: "file-mtime" };
	return { startedAt: "", startedAtSource: "unknown" };
}

/** The product release a session ran on, read from the module paths in its own lines. */
export function releaseOf(lines: readonly string[]): string | undefined {
	const pattern = /releases\/([0-9A-Za-z.-]+)\/node_modules/gu;
	const counts = new Map<string, number>();
	for (const line of lines) for (const match of line.matchAll(pattern)) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
	let best: string | undefined;
	for (const [release, count] of counts) if (!best || count > (counts.get(best) ?? 0)) best = release;
	return best;
}

/** One aborted request, positioned in the session path so what followed can be read. */
export type AbortPoint = { index: number; requestText: string; detail: Record<string, unknown> };

/**
 * Resolve each abort against what the session did next: that is the only deterministic evidence
 * of whether a human stopped it, whether context compression moved it on, or whether it simply
 * ran out. A `model_change` before the next user message is recorded too: the person changed
 * model at the interrupt rather than later, which points at the model rather than the task.
 */
export function resolveInterruptCauses(path: readonly Entry[], aborts: readonly AbortPoint[]): void {
	for (const abort of aborts) {
		if (abort.detail.cause !== "unknown") continue;
		let cause: InterruptCause = "no-following-turn";
		let followUp: InterruptFollowUp = "none";
		for (let index = abort.index + 1; index < path.length; index++) {
			const next = path[index];
			if (isControlEntry(next)) continue;
			if (next.type === "compaction") { cause = "compaction"; break; }
			if (next.type === "custom_message") { cause = "injected"; followUp = "injected"; break; }
			const nextMessage = messageOf(next);
			if (nextMessage?.role === "user") {
				const text = humanText(textOf(nextMessage.content));
				if (text) { cause = "human"; followUp = interruptFollowUp(abort.requestText, text); } else { cause = "injected"; followUp = "injected"; }
				break;
			}
			cause = nextMessage?.role === "system" ? "system" : "unknown";
			break;
		}
		abort.detail.cause = cause;
		abort.detail.nextUser = followUp;
		for (let index = abort.index + 1; index < path.length; index++) {
			const next = path[index];
			if (next.type === "model_change") {
				// Pi writes a model_change entry after an abort even when the model stayed the same
				// (241 of 258 in the 2026-11 window), so only a different model is a switch.
				const after = typeof next.provider === "string" && typeof next.modelId === "string" ? `${next.provider}/${next.modelId}` : undefined;
				const before = typeof abort.detail.model === "string" ? abort.detail.model : undefined;
				if (after && before && after !== before) abort.detail.modelSwitchAfter = after;
				else if (after && !before) abort.detail.modelSwitchUnattributed = after;
				break;
			}
			if (messageOf(next)?.role === "user") break;
		}
	}
}
