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
