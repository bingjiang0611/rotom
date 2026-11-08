import test from "node:test";
import assert from "node:assert/strict";
import { agentOwnedTabIdsInWindow, placeAgentTabsInSharedGroup, agentGroupColor, agentGroupTitle, AGENT_GROUP_COLORS } from "./chrome-extension/shared-tab-group.js";
import { listedOwnedTabStatus, relayUrl, applyOwnedTabUpdate, collectListedOwnedTabs, ownedTabNotFoundError, retireOwnedTabName, isMissingChromeTabError } from "./chrome-extension/tab-list-status.js";
test("每个 agent 一个 tab 分组，不移动 claimed、固定或其他窗口标签", async () => {
	const items = [
		{ tabId: 11, ownership: "agent", agentId: "main" },
		{ tabId: 12, ownership: "agent", agentId: "main" },
		{ tabId: 13, ownership: "agent", agentId: "main" },
		{ tabId: 14, ownership: "claimed", agentId: "main" },
		{ tabId: 15, ownership: "agent", agentId: "main" },
		{ tabId: 21, ownership: "agent", agentId: "run_abcdefghijklmnop" },
	];
	const tabs = [
		{ id: 14, windowId: 7 },
		{ id: 12, windowId: 7 },
		{ id: 13, windowId: 8 },
		{ id: 15, windowId: 7, pinned: true },
		{ id: 11, windowId: 7 },
		{ id: 21, windowId: 7 },
	];
	assert.deepEqual(agentOwnedTabIdsInWindow(items, tabs, 7, "main"), [11, 12]);
	assert.deepEqual(agentOwnedTabIdsInWindow(items, tabs, 7, "run_abcdefghijklmnop"), [21]);
	const calls = [];
	const result = await placeAgentTabsInSharedGroup({
		createdTab: { id: 12, windowId: 7 },
		items,
		queryTabs: async (query) => { calls.push(["query", query]); return tabs; },
		groupTabs: async (options) => { calls.push(["group", options]); return options.tabIds.includes(21) ? 92 : 91; },
		updateGroup: async (groupId, options) => { calls.push(["update", groupId, options]); },
	});
	assert.deepEqual(result.groups.map((group) => [group.agentId, group.groupId, group.tabIds]), [["main", 91, [11, 12]], ["run_abcdefghijklmnop", 92, [21]]]);
	assert.deepEqual(calls, [
		["query", { windowId: 7 }],
		["group", { tabIds: [11, 12] }],
		["update", 91, { title: "rotom", color: agentGroupColor("main"), collapsed: false }],
		["group", { tabIds: [21] }],
		["update", 92, { title: "rotom · run_abcdefgh", color: agentGroupColor("run_abcdefghijklmnop"), collapsed: false }],
	]);
	await assert.rejects(() => placeAgentTabsInSharedGroup({
		createdTab: { id: 99, windowId: 7 },
		items,
		queryTabs: async () => tabs,
		groupTabs: async () => 92,
		updateGroup: async () => undefined,
	}), /created tab unavailable for grouping/u);
});
test("分组标题有界、颜色按 agentId 稳定哈希", () => {
	assert.equal(agentGroupTitle(undefined), "rotom");
	assert.equal(agentGroupTitle("main"), "rotom");
	assert.equal(agentGroupTitle("run_abcdefghijklmnop"), "rotom · run_abcdefgh");
	assert.equal(agentGroupTitle("短"), "rotom · 短");
	for (const agentId of ["main", "run_1", "run_2", "run_abcdefghijklmnop"]) {
		assert.equal(AGENT_GROUP_COLORS.includes(agentGroupColor(agentId)), true);
		assert.equal(agentGroupColor(agentId), agentGroupColor(agentId), "同一 agentId 必须稳定");
	}
	assert.notEqual(agentGroupColor("run_1"), agentGroupColor("run_2"), "不同 agent 至少示例上分到不同颜色");
});
test("tabs target 暂缺时保留标签 identity 并返回 detached 状态", () => {
	const item = { tabId: 41, documentGeneration: 3, url: "https://example.test/before", status: "complete", ownership: "agent", attached: true, detached: false };
	const missing = listedOwnedTabStatus({ name: "docs", item, tab: { id: 41, status: "complete", active: false }, targetUrl: undefined, targetAttached: false, currentTabName: "docs" });
	assert.deepEqual(missing.state, { url: "https://example.test/before", status: "complete", attached: false, detached: true });
	assert.deepEqual(missing.value, { name: "docs", tabId: 41, documentGeneration: 3, url: "https://example.test/before", title: "", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: false });
	const recovered = listedOwnedTabStatus({ name: "docs", item: { ...item, ...missing.state }, tab: { id: 41, status: "complete", active: true }, targetUrl: "https://example.test/after", targetAttached: true, currentTabName: "docs" });
	assert.equal(recovered.value.relayAttached, false, "target 回来后仍需显式 recover/attach，不能伪造 relayAttached");
	assert.deepEqual(recovered.state, { url: "https://example.test/after", status: "complete", attached: false, detached: true });
	const healthy = listedOwnedTabStatus({ name: "docs", item, tab: { id: 41, status: "complete", active: false }, targetUrl: "https://example.test/healthy", targetAttached: true, currentTabName: "docs" });
	assert.equal(healthy.value.relayAttached, true);
	assert.deepEqual(healthy.state, { url: "https://example.test/healthy", status: "complete", attached: true, detached: false });
});
test("超长或不支持的导航 URL 只让该标签 detached，不进入标签列表", async () => {
	const longUrl = `https://www.google.com/url?q=${"a".repeat(4100)}`;
	// 2,000 raw characters become 12,000 after percent-encoding.
	const growsWhenEncoded = `https://example.test/${"é".repeat(2000)}`;
	assert.throws(() => relayUrl(longUrl), /url exceeds 4096 characters/u);
	assert.throws(() => relayUrl(growsWhenEncoded), /url exceeds 4096 characters/u);
	assert.throws(() => relayUrl("chrome://newtab/"), /url scheme denied/u);
	assert.equal(relayUrl("https://example.test/a b"), "https://example.test/a%20b");
	const item = { tabId: 44, targetId: "target-44", documentGeneration: 1, url: "https://example.test/start", status: "complete", ownership: "agent", attached: true, detached: false };
	assert.equal(applyOwnedTabUpdate(item, { status: "loading", url: longUrl }), true);
	assert.equal(item.url, "https://example.test/start", "不可报告的 URL 不得写入 owned 状态");
	assert.equal(item.documentGeneration, 2, "导航仍需使旧 ref 失效");
	assert.equal(item.status, "loading");
	const healthy = { tabId: 45, targetId: "target-45", documentGeneration: 1, url: "https://example.test/ok", status: "complete", ownership: "agent", attached: true, detached: false };
	const tabs = await collectListedOwnedTabs({
		entries: new Map([["long", item], ["ok", healthy]]),
		currentTabName: "ok",
		getTargets: async () => [
			{ tabId: 44, id: "target-44", type: "page", url: longUrl, attached: true },
			{ tabId: 45, id: "target-45", type: "page", url: "https://example.test/ok", attached: true },
		],
		getTab: async (tabId) => ({ id: tabId, status: "complete", active: false }),
		normalizeUrl: relayUrl,
	});
	assert.deepEqual(tabs.map((tab) => [tab.name, tab.url, tab.relayAttached]), [
		["long", "https://example.test/start", false],
		["ok", "https://example.test/ok", true],
	]);
	assert.ok(tabs.every((tab) => tab.url.length <= 4096));
	assert.equal(applyOwnedTabUpdate(item, { url: "https://example.test/next" }), true);
	assert.equal(item.url, "https://example.test/next");
	assert.equal(applyOwnedTabUpdate(item, { status: "complete" }), false);
});
test("owned tab not found 说明该名称最近一次被移除的路径，且记录有界", () => {
	const retired = new Map();
	assert.equal(ownedTabNotFoundError(retired, "never-opened").message, "owned tab not found");
	retireOwnedTabName(retired, "docs", "Chrome closed the tab (user, page script or browser)");
	assert.equal(ownedTabNotFoundError(retired, "docs").message, "owned tab not found: Chrome closed the tab (user, page script or browser)");
	retireOwnedTabName(retired, "docs", "closed by the relay (close request or failed open/claim cleanup)");
	assert.match(ownedTabNotFoundError(retired, "docs").message, /closed by the relay/u, "最近一次移除覆盖旧原因");
	for (let index = 0; index < 40; index += 1)
		retireOwnedTabName(retired, `tab-${index}`, "Chrome closed the tab (user, page script or browser)");
	assert.equal(retired.size, 32);
	assert.equal(retired.has("docs"), false, "最旧的记录先被淘汰");
	assert.equal(retired.has("tab-39"), true);
});
test("tabs Chrome API 失败时仍返回缓存 identity 并保留 ownership", async () => {
	const item = { tabId: 42, targetId: "target-42", documentGeneration: 2, url: "https://example.test/cached", status: "complete", ownership: "claimed", attached: true, detached: false };
	const entries = new Map([["cached", item]]);
	let detached = 0;
	const tabs = await collectListedOwnedTabs({
		entries,
		currentTabName: "cached",
		getTargets: async () => { throw new Error("temporary debugger failure"); },
		getTab: async () => { throw new Error("Tabs cannot be queried right now"); },
		normalizeUrl: (url) => url,
		onDetached: () => { detached += 1; },
	});
	assert.equal(entries.get("cached"), item, "health check 不得删除 ownership");
	assert.deepEqual(item, { tabId: 42, targetId: "target-42", documentGeneration: 2, url: "https://example.test/cached", status: "complete", ownership: "claimed", attached: false, detached: true });
	assert.deepEqual(tabs, [{ name: "cached", tabId: 42, documentGeneration: 2, url: "https://example.test/cached", title: "", status: "complete", current: true, browserActive: false, ownership: "claimed", relayAttached: false }]);
	assert.equal(detached, 1);
	const tabFailureOnlyItem = { tabId: 43, targetId: "target-43", documentGeneration: 1, url: "https://example.test/tab-failure", status: "complete", ownership: "agent", attached: true, detached: false };
	const tabFailureOnly = await collectListedOwnedTabs({
		entries: new Map([["tab-failure", tabFailureOnlyItem]]),
		currentTabName: "tab-failure",
		getTargets: async () => [{ tabId: 43, id: "target-43", type: "page", url: "https://example.test/tab-failure", attached: true }],
		getTab: async () => { throw new Error("temporary tabs.get failure"); },
		normalizeUrl: (url) => url,
	});
	assert.equal(tabFailureOnly[0].relayAttached, false, "tabs.get 失败不得被健康 target 覆盖为 attached");
	assert.equal(tabFailureOnlyItem.attached, false);
	assert.equal(tabFailureOnlyItem.detached, true);
	assert.equal(isMissingChromeTabError(new Error("No tab with id: 42.")), true);
	assert.equal(isMissingChromeTabError(new Error("Tabs cannot be queried right now")), false);
});
