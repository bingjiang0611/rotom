/**
 * Provider-error detail for the harvest: which provider/model failed, what kind of
 * failure it was, and whether the retry run ended with a usable answer or with the
 * user still facing an error.
 *
 * Category comes from the local trace (`pi.ai.error.category`) when a matching request
 * span exists, otherwise from the session's own error message. Only the category is
 * stored: never the message text, headers or bodies.
 */

/** Trace categories written by Pi (`pi.ai.error.category`) plus the message-derived buckets. */
export const TRACE_CATEGORIES = ["timeout", "network", "http", "websocket", "provider_error", "overloaded", "unknown"] as const;
export type ProviderCategory = string;

/**
 * `category` is the bucket the report groups by. `code` is the provider's own error code, kept
 * even when a trace span supplied the bucket: filtering on the bucket would silently miss every
 * failure whose code is more specific than the bucket name.
 */
export type ProviderDetail = { provider: string; model: string; category: ProviderCategory; categorySource: "trace" | "message"; code?: string };

/** One failed `pi.ai.request` span from the local trace. */
export type TraceErrorSpan = { timestamp: number; category: string };

const QODER_CODE = /\bqoder:\s*([a-z][a-z0-9_]*)/iu;
const STATUS_429 = /\b(?:429|rate[ _-]?limit|too many requests)\b/iu;
const STATUS_5XX = /\b(?:50[0234]|5xx|service unavailable|bad gateway|gateway time-?out|internal server error|overloaded|server_error)\b/iu;
const TIMEOUT = /\b(?:timeout|timed out|etimedout|deadline exceeded)\b/iu;
/**
 * A connect-phase failure is one where the request provably never left: the socket was refused,
 * the name did not resolve, or the transport says the connection was never established. `fetch
 * failed` alone, a reset or a socket hang up can equally mean a request that was sent and possibly
 * billed, so those stay in `network` — the runtime keeps its bounded budget for them.
 */
const CONNECT = /\b(?:econnrefused|enotfound|eai_again|ehostunreach|enetunreach|eaddrnotavail|und_err_connect_timeout|tls|certificate|proxy|connect(?:ion)?[_ ]?(?:failed|timeout|error|refused))\b|before secure tls connection was established|when http tunneling/iu;
const NETWORK = /\b(?:fetch failed|econnreset|socket hang up|network error|other side closed|terminated)\b/iu;

/**
 * Bucket an error message. Ordered as documented: provable connect failures first (a refused
 * socket is not the server rejecting us), then opaque network failures, then explicit HTTP status,
 * then timeouts, then a provider code such as `Qoder: stream_failed`, then `other`.
 */
export function classifyProviderMessage(message: string): ProviderCategory {
	const text = message.trim();
	if (!text) return "other";
	const qoder = QODER_CODE.exec(text);
	const code = qoder?.[1]?.toLowerCase() ?? "";
	// `Qoder: http_503` carries the upstream status in the code, not as bare digits.
	const status = /^http_([45]\d\d)$/u.exec(code)?.[1];
	if (status === "429") return "429";
	if (status && /^5/u.test(status)) return "5xx";
	// `Qoder: connection_failed` / `Qoder: request_timeout` are transport facts, not server replies.
	if (/connect|tls|dns|proxy/iu.test(code) || CONNECT.test(text)) return "connect";
	if (/socket/iu.test(code) || NETWORK.test(text)) return "network";
	if (STATUS_429.test(text)) return "429";
	if (STATUS_5XX.test(text)) return "5xx";
	if (/timeout|timed_out|deadline/iu.test(code) || TIMEOUT.test(text)) return "timeout";
	if (code) return `qoder:${code}`;
	return "other";
}

/** The provider's own code from its message, e.g. `Qoder: catalog_refresh_failed`. */
export function providerCode(message: string): string | undefined {
	const match = QODER_CODE.exec(message.trim());
	return match?.[1] ? `qoder:${match[1].toLowerCase()}` : undefined;
}

export function traceErrorSpans(traceLines: readonly string[] | undefined): TraceErrorSpan[] {
	const spans: TraceErrorSpan[] = [];
	for (const line of traceLines ?? []) {
		if (!line.trim()) continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (!record || typeof record !== "object") continue;
		const value = record as { kind?: unknown; name?: unknown; status?: unknown; timestamp?: unknown; attributes?: unknown };
		if (value.kind !== "span_end" || value.name !== "pi.ai.request" || value.status !== "error") continue;
		const attributes = value.attributes && typeof value.attributes === "object" ? (value.attributes as Record<string, unknown>) : {};
		const category = typeof attributes["pi.ai.error.category"] === "string" ? attributes["pi.ai.error.category"] : undefined;
		const timestamp = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
		if (!category || Number.isNaN(timestamp)) continue;
		spans.push({ timestamp, category });
	}
	return spans.sort((left, right) => left.timestamp - right.timestamp);
}

/**
 * Pair a failed request span with a provider-error incident. The span ends within the retry
 * window of the failed attempt, so the nearest unused span inside `toleranceMs` wins; a
 * provider-error burst retried once per attempt pairs in order.
 */
export function spanCategoryFor(spans: TraceErrorSpan[], timestamp: string, toleranceMs = 120_000): string | undefined {
	const at = Date.parse(timestamp);
	if (Number.isNaN(at)) return undefined;
	let best: TraceErrorSpan | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const span of spans) {
		const distance = Math.abs(span.timestamp - at);
		if (distance <= toleranceMs && distance < bestDistance) {
			best = span;
			bestDistance = distance;
		}
	}
	if (!best) return undefined;
	spans.splice(spans.indexOf(best), 1);
	return best.category;
}

export function providerDetail(input: {
	provider: string;
	model: string;
	errorMessage: string;
	/** Same list instance is consumed: each trace span describes one attempt. */
	spans: TraceErrorSpan[];
	timestamp: string;
}): ProviderDetail {
	// A category this build does not write (older releases wrote e.g. `connect`) is a historical
	// label, not a bucket: trusting it would report 24 opaque `fetch failed` failures as provable
	// connect-phase failures, which the runtime never claimed.
	const raw = spanCategoryFor(input.spans, input.timestamp);
	const traced = raw && TRACE_CATEGORIES.includes(raw as (typeof TRACE_CATEGORIES)[number]) ? raw : undefined;
	const code = providerCode(input.errorMessage);
	return {
		provider: input.provider,
		model: input.model,
		category: traced ?? classifyProviderMessage(input.errorMessage),
		categorySource: traced ? "trace" : "message",
		...(code ? { code } : {}),
	};
}

/**
 * One attempt's outcome, so the report can separate "hit an error" from "never recovered".
 * `recovered` is the harvested flag: true means a later usable answer ended that retry run, so the
 * failure did not reach the user. A failure without it reached the user.
 */
export type ProviderErrorRow = { provider: string; model: string; category: string; code?: string; recovered: boolean; count: number; attempts: number };

export function providerUserVisible(rows: readonly ProviderErrorRow[]): number {
	return rows.filter((row) => !row.recovered).reduce((sum, row) => sum + row.count, 0);
}

export function summarizeProviderErrors(incidents: readonly { detail: Record<string, string | number | boolean> }[]): {
	total: number;
	recovered: number;
	userVisible: number;
	rows: ProviderErrorRow[];
} {
	const byKey = new Map<string, ProviderErrorRow>();
	for (const incident of incidents) {
		const provider = String(incident.detail.provider ?? "unknown");
		const model = String(incident.detail.model ?? "unknown");
		const category = String(incident.detail.category ?? "other");
		const code = typeof incident.detail.code === "string" ? incident.detail.code : undefined;
		const recovered = incident.detail.recovered === true;
		const key = `${provider}\u0000${model}\u0000${category}\u0000${code ?? ""}\u0000${recovered}`;
		const row = byKey.get(key) ?? { provider, model, category, ...(code ? { code } : {}), recovered, count: 0, attempts: 0 };
		row.count++;
		row.attempts += typeof incident.detail.attempts === "number" ? incident.detail.attempts : 1;
		byKey.set(key, row);
	}
	const rows = [...byKey.values()].sort((left, right) => right.count - left.count || left.category.localeCompare(right.category));
	const total = rows.reduce((sum, row) => sum + row.count, 0);
	const userVisible = providerUserVisible(rows);
	return { total, recovered: total - userVisible, userVisible, rows };
}
