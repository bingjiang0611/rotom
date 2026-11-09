import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { COPY } from "./copy.ts";

/**
 * Token estimate of the rendered summary. Pi's `estimateTokens()` counts text as `chars / 4`, the
 * same rule compaction uses; it cannot be imported here because an extension source file has no
 * module resolution for the Pi package outside Pi's own loader.
 */
function estimate(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Visible text without images, thinking, tool calls or tool results; callers pass message content. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part: { type?: string; text?: string }) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
}

/**
 * Cut a request out of the middle until the rendered form fits `budgetTokens`. The head stays a
 * verbatim prefix and the tail a verbatim suffix; the marker names the entry that still holds the
 * whole text, so nothing is lost silently.
 */
function truncateMiddle(text: string, budgetTokens: number, entryId: string): string {
	if (estimate(text) <= budgetTokens) return text;
	let headLength = Math.ceil(text.length * 0.6);
	let tailLength = Math.ceil(text.length * 0.2);
	for (;;) {
		const head = text.slice(0, headLength);
		const tail = tailLength > 0 ? text.slice(text.length - tailLength) : "";
		const omitted = text.length - head.length - tail.length;
		if (omitted <= 0) return text;
		const rendered = [head, COPY.requestOmitted(omitted, entryId), tail].filter((line) => line !== "").join("\n");
		if (estimate(rendered) <= budgetTokens) return rendered;
		if (headLength === 0 && tailLength === 0) return COPY.requestOmitted(text.length, entryId);
		headLength = Math.floor(headLength * 0.75);
		tailLength = Math.floor(tailLength * 0.75);
	}
}

/**
 * Deterministic takeover summary: how to retrieve the cleared entries, then the latest user request
 * verbatim when the cut removed it. No model call, no task summary, no constraint extraction, and
 * no nesting: a second takeover in the same session reads the same branch, so it never repeats an
 * earlier summary.
 */
export function buildTakeoverSummary(input: {
	branch: readonly SessionEntry[];
	firstKeptEntryId: string;
	reserveTokens: number;
}): string {
	const intro = COPY.intro(input.firstKeptEntryId);
	const user = input.branch.findLast((entry) => entry.type === "message" && entry.message.role === "user");
	if (user?.type !== "message" || user.message.role !== "user") return intro;
	const keptIndex = input.branch.findIndex((entry) => entry.id === input.firstKeptEntryId);
	const userIndex = input.branch.indexOf(user);
	// The kept range is still visible after the compaction entry, so a request inside it is not
	// repeated; only a request the cut removed is quoted back.
	if (keptIndex >= 0 && userIndex >= keptIndex) return intro;
	const text = textOf(user.message.content);
	if (text.trim() === "") return intro;
	const budget = Math.floor(input.reserveTokens / 4);
	const request = truncateMiddle(text, budget, user.id);
	return [intro, COPY.currentRequestOpen, COPY.currentRequest(user.id, request), COPY.currentRequestClose].join("\n");
}
