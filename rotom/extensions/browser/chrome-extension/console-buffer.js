// Per-tab console capture.
//
// The relay keeps a bounded ring buffer per tab: 500 entries, 2 KB each, 8 MB across
// all tabs, oldest dropped first. Nothing here survives a service-worker restart, so
// every buffer reports when its capture started and how much it already dropped.

export const MAX_CONSOLE_ENTRIES_V1 = 500;
export const MAX_CONSOLE_ENTRY_BYTES_V1 = 2 * 1024;
export const MAX_CONSOLE_TOTAL_BYTES_V1 = 8 * 1024 * 1024;
export const MAX_CONSOLE_STACK_FRAMES_V1 = 10;
export const DEFAULT_CONSOLE_LIMIT_V1 = 50;
export const MAX_CONSOLE_LIMIT_V1 = 200;
export const MAX_CONSOLE_PATTERN_CHARS_V1 = 128;

/** Levels a caller may filter on; CDP console types map into these. */
export const CONSOLE_LEVELS_V1 = ["verbose", "info", "warning", "error"];

const CONSOLE_TYPE_LEVELS = {
	debug: "verbose",
	verbose: "verbose",
	log: "info",
	info: "info",
	dir: "info",
	dirxml: "info",
	table: "info",
	count: "info",
	timeEnd: "info",
	warning: "warning",
	error: "error",
	assert: "error",
	trace: "info",
};

// Service workers have no Buffer; TextEncoder is the portable way to count UTF-8 bytes.
const encoder = new TextEncoder();
const utf8Bytes = (value) => encoder.encode(value).length;

/** Truncate on a code-point boundary so the text never ends in half a character. */
function truncateUtf8(value, maxBytes) {
	if (utf8Bytes(value) <= maxBytes) return value;
	const suffix = "…";
	let limited = "";
	for (const character of value) {
		if (utf8Bytes(limited + character) + utf8Bytes(suffix) > maxBytes) break;
		limited += character;
	}
	return limited + suffix;
}

export function consoleLevelFromTypeV1(type) {
	return CONSOLE_TYPE_LEVELS[typeof type === "string" ? type : ""] ?? "info";
}

/** Accept only `verbose|info|warning|error` as a filter. */
export function sanitizeConsoleLevelV1(value) {
	if (value === undefined) return undefined;
	return CONSOLE_LEVELS_V1.includes(value) ? value : undefined;
}

/** Substring only: a pattern is never compiled into a regular expression. */
export function sanitizeConsolePatternV1(value) {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_CONSOLE_PATTERN_CHARS_V1) return undefined;
	return value;
}

export function sanitizeConsoleLimitV1(value) {
	if (value === undefined) return DEFAULT_CONSOLE_LIMIT_V1;
	if (!Number.isInteger(value) || value < 1 || value > MAX_CONSOLE_LIMIT_V1) return undefined;
	return value;
}

/** `c<seq>` cursors; anything else is rejected instead of silently starting over. */
export function parseConsoleCursorV1(value) {
	if (value === undefined) return 0;
	if (typeof value !== "string") return undefined;
	const match = /^c(\d{1,12})$/u.exec(value);
	return match ? Number(match[1]) : undefined;
}

/**
 * Build one entry from already-extracted fields. Text, URL and stack are bounded here
 * so a hostile page cannot grow the buffer beyond its budgets.
 */
export function consoleEntryV1(input, maxEntryBytes = MAX_CONSOLE_ENTRY_BYTES_V1) {
	if (typeof input?.text !== "string") return undefined;
	const text = truncateUtf8(input.text, maxEntryBytes);
	const stack = Array.isArray(input.stack)
		? input.stack.filter((frame) => typeof frame === "string" && frame.length > 0).slice(0, MAX_CONSOLE_STACK_FRAMES_V1).map((frame) => truncateUtf8(frame, 512))
		: undefined;
	const entry = {
		level: CONSOLE_LEVELS_V1.includes(input.level) ? input.level : "info",
		text,
		...(typeof input.url === "string" && input.url.length > 0 ? { url: truncateUtf8(input.url, 512) } : {}),
		...(Number.isInteger(input.lineNumber) && input.lineNumber >= 0 ? { line: input.lineNumber } : {}),
		at: Number.isFinite(input.at) ? input.at : Date.now(),
		...(typeof input.source === "string" && input.source.length > 0 ? { source: truncateUtf8(input.source, 32) } : {}),
		...(stack && stack.length > 0 ? { stack } : {}),
	};
	// Shrink the least useful part first: extra frames, then the text, then the stack.
	// An exception keeps its top frames; a long message keeps its beginning.
	for (let step = 0; utf8Bytes(JSON.stringify(entry)) > maxEntryBytes && step < 64; step += 1) {
		if (entry.stack && entry.stack.length > 3) entry.stack.pop();
		else if (entry.text.length > 64) entry.text = truncateUtf8(entry.text, Math.floor(utf8Bytes(entry.text) * 0.75));
		else if (entry.stack) delete entry.stack;
		else entry.text = truncateUtf8(entry.text, 64);
	}
	if (entry.stack && entry.stack.length === 0) delete entry.stack;
	return entry;
}

/**
 * Console store: one buffer per tab, one global byte budget.
 * @param {object} [limits]
 */
export function createConsoleCaptureV1(limits = {}) {
	const maxEntries = limits.maxEntries ?? MAX_CONSOLE_ENTRIES_V1;
	const maxEntryBytes = limits.maxEntryBytes ?? MAX_CONSOLE_ENTRY_BYTES_V1;
	const maxTotalBytes = limits.maxTotalBytes ?? MAX_CONSOLE_TOTAL_BYTES_V1;
	/** @type {Map<number, {captureSince: number, entries: Array<{seq:number} & object>, dropped: number, bytes: number, seq: number}>} */
	const buffers = new Map();
	let totalBytes = 0;

	const bufferFor = (tabId) => {
		let buffer = buffers.get(tabId);
		if (!buffer) {
			buffer = { captureSince: Date.now(), entries: [], dropped: 0, bytes: 0, seq: 0 };
			buffers.set(tabId, buffer);
		}
		return buffer;
	};
	const evictOldest = (buffer) => {
		const entry = buffer.entries.shift();
		if (!entry) return false;
		const size = utf8Bytes(JSON.stringify(entry));
		buffer.bytes -= size;
		totalBytes -= size;
		buffer.dropped += 1;
		return true;
	};

	return {
		/** Append one entry; returns the stored copy (or undefined when it was unusable). */
		append(tabId, input) {
			const entry = consoleEntryV1(input, maxEntryBytes);
			if (!entry) return undefined;
			const buffer = bufferFor(tabId);
			buffer.seq += 1;
			const stored = { seq: buffer.seq, ...entry };
			const size = utf8Bytes(JSON.stringify(stored));
			buffer.entries.push(stored);
			buffer.bytes += size;
			totalBytes += size;
			while (buffer.entries.length > maxEntries) evictOldest(buffer);
			// The global budget evicts the oldest entry of whichever tab holds the most.
			while (totalBytes > maxTotalBytes) {
				let victim;
				for (const [id, candidate] of buffers) {
					if (candidate.entries.length === 0) continue;
					if (victim === undefined || candidate.bytes > victim.buffer.bytes) victim = { id, buffer: candidate };
				}
				if (!victim || !evictOldest(victim.buffer)) break;
			}
			return stored;
		},
		/**
		 * Read a page of entries. Entries are ordered by seq, and a cursor that no longer
		 * exists (dropped) simply continues from the oldest retained entry.
		 */
		read(tabId, query = {}) {
			const buffer = bufferFor(tabId);
			const since = query.sinceCursor ?? 0;
			const limit = query.limit ?? DEFAULT_CONSOLE_LIMIT_V1;
			const pattern = query.pattern === undefined ? undefined : query.pattern.toLowerCase();
			const matched = buffer.entries.filter((entry) => entry.seq > since
				&& (query.level === undefined || entry.level === query.level)
				&& (pattern === undefined || entry.text.toLowerCase().includes(pattern)));
			const entries = matched.slice(0, limit).map((entry) => ({ ...entry }));
			const last = entries.length > 0 ? entries[entries.length - 1].seq : since;
			return {
				captureSince: buffer.captureSince,
				dropped: buffer.dropped,
				entries,
				nextCursor: matched.length > entries.length ? `c${last}` : undefined,
				retained: buffer.entries.length,
			};
		},
		/** Drop everything for one tab (tab closed or re-navigated into a new document). */
		reset(tabId) {
			const buffer = buffers.get(tabId);
			if (!buffer) return;
			totalBytes -= buffer.bytes;
			buffers.delete(tabId);
		},
		stats() {
			return { tabs: buffers.size, totalBytes };
		},
	};
}
