import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry, SessionProjection } from "@earendil-works/pi-coding-agent";
import { COPY } from "./copy.ts";

/** The only Context Layers tool: read-only retrieval of branch-local history. */
export const RECALL_TOOL = "context_recall";
/** Legacy summary blocks written before Context Layers became retrieval-only. */
export const BLOCK_ENTRY = "rotom-context-layers/block-v1";
export interface Block {
	version: 1;
	id: string;
	tier: number;
	carrier: string;
	direct: string[];
	covered: string[];
	children: string[];
	replaces?: string;
	summary: string;
	before: number;
	after: number;
}
export interface View {
	branch: SessionEntry[];
	projection: SessionProjection;
	blocks: Map<string, Block>;
	states: Map<string, "active" | "superseded" | "archived" | "partial">;
}

const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((v) => typeof v === "string");

export function rendered(block: Block): string {
	return COPY.summary(block.id, block.tier, block.summary);
}

function text(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((p) => p.type === "text")
		.map((p) => p.text)
		.join("\n");
}

/**
 * Searchable text of one entry: message text, tool names and tool arguments.
 * Provider-private reasoning is never indexed, so it cannot leak through an excerpt.
 */
function searchable(message: AgentMessage): string {
	const chunks = [text(message)];
	if ("content" in message && Array.isArray(message.content)) {
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			chunks.push(part.name, JSON.stringify(part.arguments));
		}
	}
	return chunks.join("\n");
}

/** Read legacy block records read-only. Corrupt or unknown versions are never inferred. */
export function readBlocks(branch: SessionEntry[]): Map<string, Block> {
	const blocks = new Map<string, Block>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== BLOCK_ENTRY) continue;
		const b = entry.data as Block;
		if (
			!b ||
			b.version !== 1 ||
			typeof b.id !== "string" ||
			typeof b.carrier !== "string" ||
			![1, 2, 3].includes(b.tier) ||
			typeof b.summary !== "string" ||
			!strings(b.direct) ||
			!strings(b.covered) ||
			!strings(b.children) ||
			b.covered.length === 0 ||
			!b.covered.includes(b.carrier) ||
			blocks.has(b.id) ||
			b.children.some((id) => !blocks.has(id)) ||
			(b.replaces !== undefined && !blocks.has(b.replaces))
		)
			throw new Error(COPY.corrupt);
		blocks.set(b.id, b);
	}
	return blocks;
}

export function buildView(branch: SessionEntry[], projection: SessionProjection): View {
	const blocks = readBlocks(branch);
	const visible = new Map(projection.entries.map((e) => [e.sourceEntry.id, e.messages]));
	const states: View["states"] = new Map();
	const superseded = new Set(
		[...blocks.values()].flatMap((b) => [...b.children, ...(b.replaces ? [b.replaces] : [])]),
	);
	for (const b of blocks.values()) {
		const carrier = visible.get(b.carrier) ?? [];
		const state = superseded.has(b.id)
			? "superseded"
			: carrier.length === 0
				? "archived"
				: carrier.length === 1 &&
					text(carrier[0]) === rendered(b) &&
					b.covered.every((id) => id === b.carrier || !visible.get(id)?.length)
					? "active"
					: "partial";
		states.set(b.id, state);
	}
	return { branch, projection, blocks, states };
}

/**
 * Case-insensitive substring search over the current branch: original text, tool
 * names, tool arguments and legacy summary text. No index, no regex, no siblings.
 */
export function search(view: View, query: string, offset: number) {
	const needle = query.toLocaleLowerCase();
	const hits: { ref: string; role: string; excerpt: string }[] = [];
	const add = (ref: string, role: string, body: string) => {
		const at = body.toLocaleLowerCase().indexOf(needle);
		if (at >= 0) hits.push({ ref, role, excerpt: body.slice(Math.max(0, at - 80), at + 240) });
	};
	for (const b of view.blocks.values()) add(b.id, "summary", b.summary);
	for (const e of view.branch) if (e.type === "message") add(`@${e.id}`, e.message.role === "toolResult" ? `toolResult:${e.message.toolName}` : e.message.role, searchable(e.message));
	if (offset > hits.length) throw new Error(COPY.offset);
	return {
		matches: hits.slice(offset, offset + 24),
		nextOffset: offset + 24 < hits.length ? offset + 24 : null,
		complete: offset + 24 >= hits.length,
		coverage: "matching-parts" as const,
	};
}
