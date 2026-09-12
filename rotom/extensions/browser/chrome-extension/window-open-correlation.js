export function consumeMatchingWindowOpenSignal(signals, tab, now = Date.now(), maxAgeMs = 2_000) {
	if (!Array.isArray(signals) || !tab || typeof tab !== "object") return false;
	const urls = new Set([tab.pendingUrl, tab.url].map(normalizeUrl).filter(Boolean));
	if (urls.size === 0) return false;
	const signal = signals.find((candidate) => candidate?.used !== true && Number.isFinite(candidate?.timestamp) && now - candidate.timestamp >= 0 && now - candidate.timestamp <= maxAgeMs && urls.has(normalizeUrl(candidate.url)));
	if (!signal) return false;
	signal.used = true;
	return true;
}

function normalizeUrl(value) {
	if (typeof value !== "string" || value.length === 0) return "";
	try { return new URL(value).href; }
	catch { return ""; }
}
