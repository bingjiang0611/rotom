import { record, safeDisplayUrl } from "./tool-results.ts";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { BROWSER_NETWORK_MAX_LIMIT_V1, BROWSER_NETWORK_RESOURCE_TYPES_V1, BROWSER_CONSOLE_MAX_LIMIT_V1, BROWSER_CONSOLE_LEVELS_V1 } from "./browser-relay.ts";
import { MAX_RESULT_BYTES } from "./tool-contract.ts";
// Downloads are listed from Chrome itself: bounded, model-safe fields only, and (for
// completed files) a locally computed digest. The absolute path never leaves this file.
export const BROWSER_DOWNLOAD_MAX_RECORDS_V1 = 20 as const;
export const BROWSER_DOWNLOAD_HASH_MAX_BYTES_V1 = 64 * 1024 * 1024;
/**
 * Validate one `console` page and bound it for the model. The extension already caps
 * entries at 2 KB, but 200 of them exceed the 128 KiB result budget, so the page is
 * trimmed here and a cursor is synthesized for the rest.
 */
/**
 * Network metadata only: a header/body field is rejected instead of forwarded, so an
 * upstream change cannot widen the contract by accident.
 */
/**
 * Validate the download listing and attach a digest for completed files.
 *
 * Chrome reports an absolute path; that path is used here to hash the bytes and is then
 * dropped, so the model only ever sees the path relative to the download directory.
 */
export async function validateBrowserDownloadsV1(value: unknown) {
	if (!record(value) || value.schemaVersion !== 1 || value.kind !== "rotom-browser-downloads")
		throw new Error("browser downloads response 无效");
	if (!Array.isArray(value.downloads) || value.downloads.length > BROWSER_DOWNLOAD_MAX_RECORDS_V1)
		throw new Error("browser downloads 无效");
	const downloads = [];
	for (const candidate of value.downloads) {
		if (!record(candidate))
			throw new Error("browser download record 无效");
		const relativePath = typeof candidate.relativePath === "string" ? candidate.relativePath.slice(0, 512) : "";
		if (relativePath === "" || !/^rotom\/[A-Za-z0-9_-]+\//u.test(relativePath))
			throw new Error("browser download relativePath 无效");
		const state = candidate.state === "in_progress" || candidate.state === "interrupted" || candidate.state === "complete" ? candidate.state : "unknown";
		const bytes = Number.isSafeInteger(candidate.bytes) && (candidate.bytes as number) >= 0 ? Math.min(candidate.bytes as number, Number.MAX_SAFE_INTEGER) : 0;
		const mimeType = typeof candidate.mimeType === "string" && candidate.mimeType.length > 0 ? candidate.mimeType.slice(0, 128) : "application/octet-stream";
		let sha256 = null;
		if (state === "complete" && typeof candidate.path === "string" && candidate.path !== "" && bytes <= BROWSER_DOWNLOAD_HASH_MAX_BYTES_V1) {
			sha256 = await new Promise<string | null>((resolve) => {
				const hash = createHash("sha256");
				const stream = createReadStream(candidate.path!);
				stream.on("data", (chunk) => hash.update(chunk));
				stream.on("error", () => resolve(null));
				stream.on("end", () => resolve(hash.digest("hex")));
			});
		}
		downloads.push({ relativePath, state, bytes, mimeType, sha256, ...(sha256 === null && state === "complete" ? { sha256Skipped: bytes > BROWSER_DOWNLOAD_HASH_MAX_BYTES_V1 ? "too-large" : "unreadable" } : {}), ...(typeof candidate.error === "string" ? { error: candidate.error.slice(0, 64) } : {}) });
	}
	const blocked = Array.isArray(value.blocked) ? value.blocked.filter((entry) => record(entry) && typeof entry.reason === "string").slice(0, BROWSER_DOWNLOAD_MAX_RECORDS_V1).map((entry) => ({ reason: String((entry as Record<string, unknown>).reason).slice(0, 32) })) : [];
	return { schemaVersion: 1, kind: "rotom-browser-downloads", downloads, blocked };
}
export function validateBrowserNetworkV1(value: unknown, requestedLimit: number) {
	if (!record(value) || value.schemaVersion !== 1 || value.kind !== "rotom-browser-network")
		throw new Error("browser network response 无效");
	if (typeof value.captureSince !== "string" || Number.isNaN(Date.parse(value.captureSince)))
		throw new Error("browser network captureSince 无效");
	if (!Number.isSafeInteger(value.dropped) || (value.dropped as number) < 0)
		throw new Error("browser network dropped 无效");
	if (!Array.isArray(value.entries) || value.entries.length > BROWSER_NETWORK_MAX_LIMIT_V1)
		throw new Error("browser network entries 无效");
	for (const forbidden of ["headers", "requestHeaders", "responseHeaders", "postData", "body", "cookie", "cookies"]) {
		if (value[forbidden] !== undefined)
			throw new Error(`browser network response 不得包含 ${forbidden}`);
	}
	const entries = value.entries.map((candidate, index) => {
		if (!record(candidate) || !Number.isSafeInteger(candidate.seq) || (candidate.seq as number) < 1)
			throw new Error(`browser network entry ${index} 无效`);
		if (typeof candidate.method !== "string" || typeof candidate.url !== "string")
			throw new Error(`browser network entry ${index} fields 无效`);
		if (!Number.isFinite(candidate.at))
			throw new Error(`browser network entry ${index} time 无效`);
		const entry: Record<string, unknown> = {
			seq: candidate.seq as number,
			method: candidate.method.slice(0, 16),
			url: safeDisplayUrl(candidate.url),
			resourceType: BROWSER_NETWORK_RESOURCE_TYPES_V1.includes(candidate.resourceType as never) ? candidate.resourceType : "Other",
			at: new Date(candidate.at as number).toISOString(),
		};
		if (Number.isSafeInteger(candidate.status) && (candidate.status as number) >= 0)
			entry.status = candidate.status;
		if (typeof candidate.mimeType === "string" && candidate.mimeType.length > 0)
			entry.mimeType = candidate.mimeType.slice(0, 128);
		if (Number.isFinite(candidate.durationMs))
			entry.durationMs = Math.round(candidate.durationMs as number);
		if (typeof candidate.failure === "string" && candidate.failure.length > 0)
			entry.failure = candidate.failure.slice(0, 256);
		if (typeof candidate.fromCache === "boolean")
			entry.fromCache = candidate.fromCache;
		return entry;
	});
	const base: Record<string, unknown> = {
		kind: "browser-network",
		captureSince: value.captureSince,
		dropped: value.dropped as number,
		requestedLimit,
		...(Number.isSafeInteger(value.retained) ? { retained: value.retained as number } : {}),
	};
	// Same rule as console: trim whole entries and name where the next call resumes.
	let kept = entries;
	for (let count = entries.length; count >= 1; count -= 1) {
		const candidate = { ...base, entries: entries.slice(0, count) };
		if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_RESULT_BYTES - 1024)
			continue;
		kept = candidate.entries as typeof entries;
		base.nextCursor = `n${entries[count - 1].seq}`;
		break;
	}
	return { ...base, entries: kept };
}
export function validateBrowserConsoleV1(value: unknown, requestedLimit: number) {
	if (!record(value) || value.schemaVersion !== 1 || value.kind !== "rotom-browser-console")
		throw new Error("browser console response 无效");
	if (typeof value.captureSince !== "string" || Number.isNaN(Date.parse(value.captureSince)))
		throw new Error("browser console captureSince 无效");
	if (!Number.isSafeInteger(value.dropped) || (value.dropped as number) < 0)
		throw new Error("browser console dropped 无效");
	if (!Array.isArray(value.entries) || value.entries.length > BROWSER_CONSOLE_MAX_LIMIT_V1)
		throw new Error("browser console entries 无效");
	const entries = value.entries.map((candidate, index) => {
		if (!record(candidate) || !Number.isSafeInteger(candidate.seq) || (candidate.seq as number) < 1)
			throw new Error(`browser console entry ${index} 无效`);
		if (!BROWSER_CONSOLE_LEVELS_V1.includes(candidate.level as never) || typeof candidate.text !== "string")
			throw new Error(`browser console entry ${index} fields 无效`);
		if (!Number.isFinite(candidate.at))
			throw new Error(`browser console entry ${index} time 无效`);
		const stack = Array.isArray(candidate.stack) ? candidate.stack.filter((frame): frame is string => typeof frame === "string").slice(0, 10) : undefined;
		return {
			seq: candidate.seq as number,
			level: candidate.level as (typeof BROWSER_CONSOLE_LEVELS_V1)[number],
			text: candidate.text.slice(0, 2048),
			...(typeof candidate.url === "string" ? { url: safeDisplayUrl(candidate.url) } : {}),
			...(Number.isSafeInteger(candidate.line) ? { line: candidate.line as number } : {}),
			at: new Date(candidate.at as number).toISOString(),
			...(typeof candidate.source === "string" ? { source: candidate.source.slice(0, 32) } : {}),
			...(stack && stack.length > 0 ? { stack } : {}),
		};
	});
	const base = {
		kind: "browser-console",
		captureSince: value.captureSince,
		dropped: value.dropped as number,
		requestedLimit,
		...(Number.isSafeInteger(value.retained) ? { retained: value.retained as number } : {}),
	};
	// Trim by bytes, never by silent truncation of an entry: the cursor names where the
	// next call continues, so nothing is lost without a way to fetch it.
	let kept = entries;
	if (entries.length > 0) {
		for (let count = entries.length; count >= 1; count -= 1) {
			const candidate = { ...base, entries: entries.slice(0, count) };
			// Leave room for the synthesized nextCursor and for the tool-result envelope.
			if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_RESULT_BYTES - 1024)
				continue;
			kept = candidate.entries;
			break;
		}
		if (kept.length === 0)
			throw new Error("browser console 单条结果超过 128 KiB；请用 level/pattern 缩小范围");
	}
	const nextCursor = kept.length < entries.length ? `c${kept[kept.length - 1].seq}` : typeof value.nextCursor === "string" && /^c\d{1,12}$/u.test(value.nextCursor) ? value.nextCursor : undefined;
	return { ...base, entries: kept, ...(nextCursor === undefined ? {} : { nextCursor }) };
}
