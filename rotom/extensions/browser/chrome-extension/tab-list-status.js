export const MAX_RELAY_URL_CHARS = 4096;

/**
 * Canonical http(s) URL the relay may report. Both the raw value and the canonical href must fit:
 * canonicalization percent-encodes non-ASCII text, so a short raw URL can grow several times.
 * The href is ASCII, so this character bound is also the client's UTF-8 byte bound.
 */
export function relayUrl(value) {
	if (typeof value !== "string" || value.length < 1 || value.includes("\0")) throw new Error("url invalid");
	if (value.length > MAX_RELAY_URL_CHARS) throw new Error(`url exceeds ${MAX_RELAY_URL_CHARS} characters`);
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("url scheme denied");
	if (url.username || url.password) throw new Error("url userinfo denied");
	if (url.href.length > MAX_RELAY_URL_CHARS) throw new Error(`url exceeds ${MAX_RELAY_URL_CHARS} characters`);
	return url.href;
}

export function reportableRelayUrl(value) {
	try { return relayUrl(value); } catch { return undefined; }
}

/**
 * Apply a `chrome.tabs.onUpdated` change to an owned tab. Returns whether a new document started.
 * Only a reportable URL is stored: one over-long or non-http(s) URL would otherwise reach every tab
 * list and make the client reject all of them. The tab keeps its last reportable URL, and listing
 * reports it detached because its debugger target URL is not reportable.
 */
export function applyOwnedTabUpdate(item, changeInfo) {
	const nextUrl = typeof changeInfo.url === "string" ? changeInfo.url : undefined;
	const startsNavigation = changeInfo.status === "loading" && item.status !== "loading";
	const navigated = (nextUrl !== undefined && nextUrl !== item.url) || startsNavigation;
	if (navigated) item.documentGeneration += 1;
	const reportable = nextUrl === undefined ? undefined : reportableRelayUrl(nextUrl);
	if (reportable) item.url = reportable;
	if (changeInfo.status === "complete" || changeInfo.status === "loading") item.status = changeInfo.status;
	return navigated;
}

export function listedOwnedTabStatus({ name, item, tab, targetUrl, targetAttached, currentTabName }) {
	const targetAvailable = typeof targetUrl === "string";
	const relayAttached = targetAvailable && targetAttached === true && item.attached === true && item.detached !== true;
	const status = tab?.status === "complete" ? "complete" : tab?.status === "loading" ? "loading" : item.status === "complete" ? "complete" : "loading";
	const state = {
		url: targetAvailable ? targetUrl : item.url,
		status,
		attached: relayAttached,
		detached: !relayAttached,
	};
	return {
		state,
		value: {
			name,
			tabId: item.tabId,
			documentGeneration: item.documentGeneration,
			url: state.url,
			title: "",
			status,
			current: name === currentTabName,
			browserActive: tab?.active === true,
			ownership: item.ownership,
			relayAttached,
		},
	};
}

export function isMissingChromeTabError(error) {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return /^(?:No tab with id|Invalid tab ID):?\s*\d+\.?$/u.test(message.trim());
}

export async function collectListedOwnedTabs({ entries, currentTabName, getTargets, getTab, normalizeUrl, onDetached, assertOperation = () => undefined }) {
	assertOperation();
	let targets = [];
	try {
		const resolved = await getTargets();
		if (Array.isArray(resolved)) targets = resolved;
	} catch { /* an indeterminate target query must not remove ownership */ }
	assertOperation();
	const tabs = [];
	for (const [name, item] of entries) {
		assertOperation();
		let tab; let tabResolved = false;
		try { tab = await getTab(item.tabId); tabResolved = Boolean(tab); } catch { /* preserve cached identity and status */ }
		assertOperation();
		const target = tabResolved ? targets.find((candidate) => candidate?.tabId === item.tabId && candidate?.id === item.targetId && candidate?.type === "page") : undefined;
		let targetUrl;
		if (target && typeof target.url === "string") {
			try { targetUrl = normalizeUrl(target.url); } catch { /* unsupported navigation remains detached */ }
		}
		const listed = listedOwnedTabStatus({ name, item, tab, targetUrl, targetAttached: target?.attached, currentTabName });
		Object.assign(item, listed.state);
		if (!listed.value.relayAttached) onDetached?.(item);
		tabs.push(listed.value);
	}
	return tabs;
}
