// One Chrome tab group per agent, so a user can see which tabs belong to the main
// agent and which belong to a subagent, and collapse them independently.
//
// Titles are bounded: the main agent keeps the plain product name, a subagent gets
// `rotom · <first 12 characters of its agentId>`. Colors come from a stable hash of
// the agentId, so the same agent keeps its color across restarts.

export const AGENT_GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan"];
export const MAIN_AGENT_GROUP_TITLE = "rotom";
const MAX_AGENT_SUFFIX_CHARS = 12;

export function agentGroupTitle(agentId) {
	if (agentId === undefined || agentId === "main") return MAIN_AGENT_GROUP_TITLE;
	return `${MAIN_AGENT_GROUP_TITLE} · ${[...String(agentId)].slice(0, MAX_AGENT_SUFFIX_CHARS).join("")}`;
}

export function agentGroupColor(agentId) {
	let hash = 0;
	for (const character of String(agentId ?? "main")) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
	return AGENT_GROUP_COLORS[hash % AGENT_GROUP_COLORS.length];
}

/** Agent-owned tab ids of one agent in one window (claimed, pinned and foreign tabs excluded). */
export function agentOwnedTabIdsInWindow(items, tabs, windowId, agentId) {
	if (!Number.isInteger(windowId)) throw new Error("tab window identity unavailable");
	const ownedIds = new Set(items
		.filter((item) => item?.ownership === "agent" && Number.isInteger(item.tabId) && (agentId === undefined || item.agentId === agentId))
		.map((item) => item.tabId));
	return [...new Set(tabs
		.filter((tab) => Number.isInteger(tab?.id) && tab.windowId === windowId && tab.pinned !== true && ownedIds.has(tab.id))
		.map((tab) => tab.id))].sort((left, right) => left - right);
}

function agentIdsOf(items) {
	const agentIds = [];
	for (const item of items) {
		const agentId = item?.agentId ?? "main";
		if (!agentIds.includes(agentId)) agentIds.push(agentId);
	}
	return agentIds;
}

export async function placeAgentTabsInSharedGroup({ createdTab, items, queryTabs, groupTabs, updateGroup }) {
	if (!Number.isInteger(createdTab?.id) || !Number.isInteger(createdTab?.windowId)) throw new Error("created tab identity unavailable");
	const tabs = await queryTabs({ windowId: createdTab.windowId });
	const windowTabs = Array.isArray(tabs) ? tabs : [];
	const groups = [];
	for (const agentId of agentIdsOf(items)) {
		const tabIds = agentOwnedTabIdsInWindow(items, windowTabs, createdTab.windowId, agentId);
		if (tabIds.length === 0) continue;
		const groupId = await groupTabs({ tabIds });
		if (!Number.isInteger(groupId) || groupId < 0) throw new Error("tab group creation failed");
		await updateGroup(groupId, { title: agentGroupTitle(agentId), color: agentGroupColor(agentId), collapsed: false });
		groups.push({ agentId, groupId, tabIds });
	}
	const own = groups.find((group) => group.tabIds.includes(createdTab.id));
	if (!own) throw new Error("created tab unavailable for grouping");
	return { agentId: own.agentId, groupId: own.groupId, tabIds: own.tabIds, groups };
}
