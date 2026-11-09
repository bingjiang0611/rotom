import { isRecord } from "./harvest-text.ts";

// Session-entry shapes and tree traversal: what a session file contains and how to walk it.
// Reading only; no signal classification lives here.

export type Entry = { type: string; id: string; parentId: string | null; timestamp: string; [key: string]: unknown };
export type Message = { role: string; [key: string]: unknown };
export type Block = { type?: string; text?: string; name?: string; id?: string; arguments?: Record<string, unknown> };
const MAX_LEAVES = 200;

export function parseLines(lines: readonly string[]): { header?: Record<string, unknown>; entries: Entry[] } {
	let header: Record<string, unknown> | undefined;
	const entries: Entry[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue; // A torn final line from a live session is expected; skip, never guess.
		}
		if (!isRecord(value) || typeof value.type !== "string") continue;
		if (value.type === "session") {
			header ??= value;
			continue;
		}
		if (typeof value.id !== "string" || typeof value.timestamp !== "string") continue;
		entries.push({ ...value, parentId: typeof value.parentId === "string" ? value.parentId : null } as Entry);
	}
	return { header, entries };
}

/**
 * Every root→leaf path through the session tree, capped; incidents dedupe by anchor.
 * Yields one path at a time: a session with a million entries would otherwise hold
 * 200 copies of it, which is what made a 320 MB session exhaust the default heap.
 */
export function* paths(entries: readonly Entry[]): Generator<Entry[]> {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const hasChild = new Set(entries.map((entry) => entry.parentId).filter((id): id is string => id !== null));
	const leaves = entries.filter((entry) => !hasChild.has(entry.id)).slice(-MAX_LEAVES);
	for (const leaf of leaves) {
		const path: Entry[] = [];
		const seen = new Set<string>();
		for (let cursor: Entry | undefined = leaf; cursor && !seen.has(cursor.id); cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined) {
			seen.add(cursor.id);
			path.push(cursor);
		}
		yield path.reverse();
	}
}

export function messageOf(entry: Entry): Message | undefined {
	return entry.type === "message" && isRecord(entry.message) && typeof entry.message.role === "string"
		? (entry.message as Message)
		: undefined;
}
