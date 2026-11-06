// Which owned tab opened which new tab.
//
// Chrome's `Tab.openerTabId` is not reliable for popups opened from a background
// tab: for a `window.open()` from an inactive agent tab, Chrome reported the
// window's active (still-blank) tab as the opener. The relay already correlates
// spawned tabs by watching new tab ids while an interaction is dispatching, so
// remember those links and prefer them over the browser-provided field.
//
// The map is advisory and in-memory: after a service-worker restart it is empty
// and callers fall back to `openerTabId`. A missing link therefore never blocks a
// claim by the real opener; it only stops us from proving the opener rule.
export const MAX_SPAWNED_TAB_LINKS = 64;

export function rememberSpawnedTab(links, spawnedTabId, openerTabId) {
	if (!Number.isInteger(spawnedTabId) || !Number.isInteger(openerTabId)) return;
	links.delete(spawnedTabId);
	links.set(spawnedTabId, openerTabId);
	while (links.size > MAX_SPAWNED_TAB_LINKS) links.delete(links.keys().next().value);
}

export function forgetSpawnedTab(links, tabId) {
	links.delete(tabId);
}

/** Recorded opener first, then Chrome's field; `undefined` means "not from a tab". */
export function recordedOpenerTabId(links, tab) {
	const recorded = Number.isInteger(tab?.id) ? links.get(tab.id) : undefined;
	if (Number.isInteger(recorded)) return recorded;
	return Number.isInteger(tab?.openerTabId) ? tab.openerTabId : undefined;
}
