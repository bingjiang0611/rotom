// Per-tab network activity, metadata only.
//
// There is deliberately no header, body or cookie field: `Network.enable` is called with
// zero-size resource buffers, so a body never enters the relay, and this module cannot
// store a header even if a caller wanted it.

export const MAX_NETWORK_ENTRIES_V1 = 1_000;
export const MAX_NETWORK_ENTRY_BYTES_V1 = 4 * 1024;
export const DEFAULT_NETWORK_LIMIT_V1 = 50;
export const MAX_NETWORK_LIMIT_V1 = 200;
export const MAX_NETWORK_PATTERN_CHARS_V1 = 256;

/** Resource types a caller may filter on; CDP's own spelling. */
export const NETWORK_RESOURCE_TYPES_V1 = ["Document", "Stylesheet", "Image", "Media", "Font", "Script", "TextTrack", "XHR", "Fetch", "Prefetch", "EventSource", "WebSocket", "Manifest", "SignedExchange", "Ping", "CSPViolationReport", "Other"];

const encoder = new TextEncoder();
const utf8Bytes = (value) => encoder.encode(value).length;

function truncateUtf8(value, maxBytes) {
	if (utf8Bytes(value) <= maxBytes) return value;
	let limited = "";
	for (const character of value) {
		if (utf8Bytes(limited + character) + 3 > maxBytes) break;
		limited += character;
	}
	return `${limited}…`;
}

export function sanitizeNetworkResourceTypeV1(value) {
	if (value === undefined) return undefined;
	return NETWORK_RESOURCE_TYPES_V1.includes(value) ? value : undefined;
}

export function sanitizeNetworkPatternV1(value) {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_NETWORK_PATTERN_CHARS_V1) return undefined;
	return value;
}

export function sanitizeNetworkLimitV1(value) {
	if (value === undefined) return DEFAULT_NETWORK_LIMIT_V1;
	if (!Number.isInteger(value) || value < 1 || value > MAX_NETWORK_LIMIT_V1) return undefined;
	return value;
}

/** `n<seq>` cursors, distinct from console's `c<seq>`. */
export function parseNetworkCursorV1(value) {
	if (value === undefined) return 0;
	if (typeof value !== "string") return undefined;
	const match = /^n(\d{1,12})$/u.exec(value);
	return match ? Number(match[1]) : undefined;
}

/** A request counts as failed when it has a failure reason or a >= 400 status. */
export function networkEntryFailedV1(entry) {
	return entry.failure !== undefined || (typeof entry.status === "number" && entry.status >= 400);
}

function boundedEntryV1(entry, maxEntryBytes) {
	const next = { ...entry };
	if (typeof next.url === "string") next.url = truncateUtf8(next.url, 2_048);
	// Only the URL can grow past the budget; drop it before dropping the record.
	if (utf8Bytes(JSON.stringify(next)) > maxEntryBytes) next.url = truncateUtf8(next.url ?? "", 128);
	return next;
}

/**
 * Network store keyed by tab. Entries appear when a request starts and are updated in
 * place, so a pending request is visible instead of being invisible until it finishes.
 */
export function createNetworkCaptureV1(limits = {}) {
	const maxEntries = limits.maxEntries ?? MAX_NETWORK_ENTRIES_V1;
	const maxEntryBytes = limits.maxEntryBytes ?? MAX_NETWORK_ENTRY_BYTES_V1;
	/** @type {Map<number, {captureSince:number, seq:number, dropped:number, entries:Array<Record<string, unknown>>, byRequestId:Map<string, Record<string, unknown>>}>} */
	const buffers = new Map();

	const bufferFor = (tabId) => {
		let buffer = buffers.get(tabId);
		if (!buffer) {
			buffer = { captureSince: Date.now(), seq: 0, dropped: 0, entries: [], byRequestId: new Map() };
			buffers.set(tabId, buffer);
		}
		return buffer;
	};
	const evictOldest = (buffer) => {
		const entry = buffer.entries.shift();
		if (!entry) return false;
		buffer.byRequestId.delete(String(entry.requestId));
		buffer.dropped += 1;
		return true;
	};

	return {
		/** Record that a request started. Headers and bodies are not even passed in. */
		started(tabId, input) {
			if (typeof input?.requestId !== "string" || typeof input?.url !== "string") return undefined;
			const buffer = bufferFor(tabId);
			buffer.seq += 1;
			const entry = boundedEntryV1({
				seq: buffer.seq,
				requestId: input.requestId,
				method: typeof input.method === "string" && input.method.length > 0 ? input.method.slice(0, 16) : "GET",
				url: input.url,
				resourceType: NETWORK_RESOURCE_TYPES_V1.includes(input.resourceType) ? input.resourceType : "Other",
				at: Number.isFinite(input.at) ? input.at : Date.now(),
			}, maxEntryBytes);
			buffer.entries.push(entry);
			buffer.byRequestId.set(entry.requestId, entry);
			while (buffer.entries.length > maxEntries) evictOldest(buffer);
			return entry;
		},
		/** Update an existing request with response metadata (status/mime/cache). */
		responded(tabId, input) {
			const entry = buffers.get(tabId)?.byRequestId.get(String(input?.requestId));
			if (!entry) return undefined;
			if (Number.isInteger(input.status) && input.status >= 0) entry.status = input.status;
			if (typeof input.mimeType === "string" && input.mimeType.length > 0) entry.mimeType = truncateUtf8(input.mimeType, 128);
			if (typeof input.resourceType === "string" && NETWORK_RESOURCE_TYPES_V1.includes(input.resourceType)) entry.resourceType = input.resourceType;
			if (typeof input.fromDiskCache === "boolean" || typeof input.fromServiceWorker === "boolean") entry.fromCache = input.fromDiskCache === true || input.fromServiceWorker === true;
			return entry;
		},
		/** Finish (or fail) a request; `durationMs` is measured from the recorded start. */
		finished(tabId, input) {
			const entry = buffers.get(tabId)?.byRequestId.get(String(input?.requestId));
			if (!entry) return undefined;
			const at = Number.isFinite(input.at) ? input.at : Date.now();
			if (Number.isFinite(input.durationMs)) entry.durationMs = Math.max(0, Math.round(input.durationMs));
			else if (Number.isFinite(entry.at)) entry.durationMs = Math.max(0, Math.round(at - entry.at));
			if (typeof input.failure === "string" && input.failure.length > 0) entry.failure = truncateUtf8(input.failure, 256);
			if (typeof input.fromCache === "boolean") entry.fromCache = input.fromCache;
			return entry;
		},
		read(tabId, query = {}) {
			const buffer = bufferFor(tabId);
			const since = query.sinceCursor ?? 0;
			const limit = query.limit ?? DEFAULT_NETWORK_LIMIT_V1;
			const pattern = query.pattern === undefined ? undefined : query.pattern.toLowerCase();
			const matched = buffer.entries.filter((entry) => entry.seq > since
				&& (query.failedOnly !== true || networkEntryFailedV1(entry))
				&& (query.resourceType === undefined || entry.resourceType === query.resourceType)
				&& (pattern === undefined || String(entry.url).toLowerCase().includes(pattern)));
			const entries = matched.slice(0, limit).map((entry) => ({ ...entry }));
			const last = entries.length > 0 ? entries[entries.length - 1].seq : since;
			return {
				captureSince: buffer.captureSince,
				dropped: buffer.dropped,
				entries,
				nextCursor: matched.length > entries.length ? `n${last}` : undefined,
				retained: buffer.entries.length,
			};
		},
		reset(tabId) { buffers.delete(tabId); },
		stats() { return { tabs: buffers.size }; },
	};
}
