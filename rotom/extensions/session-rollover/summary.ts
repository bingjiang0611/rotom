import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { COPY } from "./copy.ts";

interface ExcerptPart {
	entryId: string;
	role: "user" | "assistant";
	text: string;
}

/**
 * Token estimate of the rendered excerpt. Pi's `estimateTokens()` counts text as `chars / 4`, the
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
 * The verbatim tail of the cleared context: the last user input and the last finished assistant
 * text. Tool calls, tool results, thinking and attachments are excluded by construction.
 */
function excerptParts(branch: readonly SessionEntry[]): ExcerptPart[] {
	const parts: ExcerptPart[] = [];
	const user = branch.findLast(
		(entry) => entry.type === "message" && entry.message.role === "user",
	);
	if (user?.type === "message" && user.message.role === "user") {
		const text = textOf(user.message.content);
		if (text.trim() !== "") parts.push({ entryId: user.id, role: "user", text });
	}
	const assistant = branch.findLast(
		(entry) => entry.type === "message" && entry.message.role === "assistant",
	);
	if (assistant?.type === "message" && assistant.message.role === "assistant") {
		const text = textOf(assistant.message.content);
		if (text.trim() !== "") parts.push({ entryId: assistant.id, role: "assistant", text });
	}
	return parts;
}

function render(parts: readonly ExcerptPart[], headText: string, tailText: string, cut: readonly string[]): string {
	const lines = [COPY.excerptOpen];
	const head = parts[0] as ExcerptPart;
	if (headText !== "") lines.push(COPY.excerptPart(head.role, head.entryId, headText));
	if (cut.length > 0) lines.push(COPY.omitted(cut));
	const tail = parts[1];
	if (tail !== undefined && tailText !== "") lines.push(COPY.excerptPart(tail.role, tail.entryId, tailText));
	lines.push(COPY.excerptClose);
	return lines.join("\n");
}

/**
 * Tail excerpt bounded by `budgetTokens`. Over budget, text is cut out of the middle: the head stays
 * a verbatim prefix of the first part and the tail a verbatim suffix of the last part, with a marker
 * naming the entries whose text was cut. Returns undefined when even the labels do not fit.
 */
export function tailExcerpt(branch: readonly SessionEntry[], budgetTokens: number): string | undefined {
	const parts = excerptParts(branch);
	if (parts.length === 0) return undefined;
	const headPart = parts[0] as ExcerptPart;
	const tailPart = parts[1];
	let headText = headPart.text;
	let tailText = tailPart?.text ?? "";
	const full = render(parts, headText, tailText, []);
	if (estimate(full) <= budgetTokens) return full;

	const cut = new Set<string>();
	for (;;) {
		const cutIds = parts.length > 1 ? [headPart.entryId, tailPart?.entryId].filter((id): id is string => id !== undefined && cut.has(id)) : [];
		const rendered = render(parts, headText, tailText, cutIds);
		if (estimate(rendered) <= budgetTokens) return rendered;
		if (headText.length === 0 && tailText.length === 0) return undefined;
		if (headText.length >= tailText.length) {
			headText = headText.slice(0, headText.length - Math.max(1, Math.ceil(headText.length / 8)));
			if (headText.length > 0) cut.add(headPart.entryId);
		} else {
			tailText = tailText.slice(Math.min(tailText.length, Math.max(1, Math.ceil(tailText.length / 8))));
			if (tailText.length > 0 && tailPart) cut.add(tailPart.entryId);
		}
	}
}

/**
 * Deterministic rollover summary: how to retrieve the cleared entries, then a bounded verbatim tail.
 * No model call, no task summary, no constraint extraction.
 */
export function buildRolloverSummary(branch: readonly SessionEntry[], reserveTokens: number): string {
	const excerpt = tailExcerpt(branch, Math.floor(reserveTokens / 4));
	return excerpt === undefined ? COPY.intro : `${COPY.intro}\n\n${excerpt}`;
}
