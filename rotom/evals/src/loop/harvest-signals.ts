import { bigrams, isCorrection, isRecord, normalized, similarity, textOf } from "./harvest-text.ts";
import { messageOf, type Entry, type Message } from "./harvest-tree.ts";

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
