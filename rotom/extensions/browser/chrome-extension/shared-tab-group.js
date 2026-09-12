export function agentOwnedTabIdsInWindow(items, tabs, windowId) {
	if (!Number.isInteger(windowId)) throw new Error("tab window identity unavailable");
	const ownedIds = new Set(items.filter((item) => item?.ownership === "agent" && Number.isInteger(item.tabId)).map((item) => item.tabId));
	return [...new Set(tabs
		.filter((tab) => Number.isInteger(tab?.id) && tab.windowId === windowId && tab.pinned !== true && ownedIds.has(tab.id))
		.map((tab) => tab.id))].sort((left, right) => left - right);
}

export async function placeAgentTabsInSharedGroup({ createdTab, items, queryTabs, groupTabs, updateGroup }) {
	if (!Number.isInteger(createdTab?.id) || !Number.isInteger(createdTab?.windowId)) throw new Error("created tab identity unavailable");
	const tabs = await queryTabs({ windowId: createdTab.windowId });
	const tabIds = agentOwnedTabIdsInWindow(items, Array.isArray(tabs) ? tabs : [], createdTab.windowId);
	if (!tabIds.includes(createdTab.id)) throw new Error("created tab unavailable for grouping");
	const groupId = await groupTabs({ tabIds });
	if (!Number.isInteger(groupId) || groupId < 0) throw new Error("tab group creation failed");
	await updateGroup(groupId, { title: "Pi", color: "blue", collapsed: false });
	return { groupId, tabIds };
}
