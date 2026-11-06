// Focus suite (T6): who owns the user's foreground.
//
// Two agents dispatch at once; neither agent tab may end up as the user's active
// tab afterwards. "Where the user was" is one record for the whole browser, so
// concurrent agents converge on the same place instead of each restoring its own
// stale pre-action tab.

import assert from "node:assert/strict";
import { relayRequestFor } from "../harness.mjs";

export const description = "并发 agent 都不把用户焦点留在自己的 tab 上";

export async function run({ harness, fixtures, recorder }) {
	const main = await harness.connect("focus-main");
	const request = relayRequestFor(main, "focus-main");
	const sub = await harness.connect("focus-sub", { principal: { agentId: "run_focus", rootSessionId: main.rootSessionId } });
	const subRequest = relayRequestFor(sub, "focus-sub");
	// Each agent only lists its own tabs, so a browser-wide view is the union.
	const allTabs = async () => [...(await request("tabs", {}, 5_000)).tabs, ...(await subRequest("tabs", {}, 5_000)).tabs];

	await recorder.check("两个 agent 各开一个后台 tab", async () => {
		await request("close", { all: true }, 5_000);
		await request("open", { tabName: "focus-a", url: fixtures.url("/baseline") }, 10_000);
		await subRequest("open", { tabName: "focus-b", url: fixtures.url("/baseline") }, 10_000);
		const tabs = await allTabs();
		assert.deepEqual(tabs.map((tab) => tab.browserActive), [false, false], "后台 tab 不得抢用户焦点");
		assert.deepEqual(tabs.map((tab) => tab.name).sort(), ["focus-a", "focus-b"]);
	});

	await recorder.check("一个 agent 点击弹出新窗口后，用户焦点不留在 agent 侧", async () => {
		const snapshot = await request("snapshot", { tabName: "focus-a" }, 10_000);
		const link = snapshot.nodes.find((node) => node.role === "link" && /Open another context/u.test(node.name));
		assert.ok(link, "fixture 必须提供新窗口链接");
		const clicked = await request("interact", { actionId: "focus-click-a", tabName: "focus-a", action: "click", targetRef: link.ref }, 15_000);
		assert.equal(clicked.acknowledged, true);
		assert.equal(clicked.effect.backgroundPreserved, true, "点击弹出的新标签不能把用户焦点留在 agent 侧");
		const tabs = await allTabs();
		assert.deepEqual(tabs.map((tab) => tab.browserActive), [false, false], "agent tab 全部不得成为用户的活动 tab");
	});

	await recorder.check("并发操作后，共享焦点记录不被对方的 tab 顶替", async () => {
		// A second agent driving its own tab must not adopt focus it never took.
		const subSnapshot = await subRequest("snapshot", { tabName: "focus-b" }, 10_000);
		const link = subSnapshot.nodes.find((node) => node.role === "link" && /Open another context/u.test(node.name));
		assert.ok(link);
		const [subClick, mainSnapshot] = await Promise.allSettled([
			subRequest("interact", { actionId: "focus-click-b", tabName: "focus-b", action: "click", targetRef: link.ref }, 15_000),
			request("snapshot", { tabName: "focus-a" }, 15_000),
		]);
		assert.equal(subClick.status, "fulfilled", subClick.status === "rejected" ? String(subClick.reason?.message) : "");
		assert.equal(subClick.value.effect.backgroundPreserved, true);
		assert.equal(mainSnapshot.status, "fulfilled");
		const tabs = await allTabs();
		assert.deepEqual(tabs.map((tab) => tab.browserActive), [false, false], "并发后仍不得有 agent tab 成为活动 tab");
	});

	await recorder.check("agent-window 放置打开可用的独立标签", async () => {
		const opened = await request("open", { tabName: "focus-window", url: fixtures.url("/popup"), placement: "agent-window" }, 10_000);
		assert.equal(opened.tabName, "focus-window");
		const heading = opened.nodes.find((node) => node.role === "heading");
		assert.match(heading?.name ?? "", /Spawned context/u, "agent 窗口里的页面必须真实渲染");
		const second = await request("open", { tabName: "focus-window-2", url: fixtures.url("/baseline"), placement: "agent-window" }, 10_000);
		assert.equal(second.tabName, "focus-window-2");
		const tabs = await allTabs();
		assert.equal(tabs.find((tab) => tab.name === "focus-a")?.browserActive, false, "给 agent 开窗不得激活既有 agent tab");
		assert.equal(tabs.filter((tab) => tab.name.startsWith("focus-window")).length, 2);
	});

	await recorder.check("不合法 placement 被拒绝，不打开任何 tab", async () => {
		await assert.rejects(request("open", { tabName: "focus-bad", url: fixtures.url("/popup"), placement: "foreground" }, 5_000));
		const tabs = await allTabs();
		assert.equal(tabs.some((tab) => tab.name === "focus-bad"), false);
	});

	await request("close", { all: true }, 5_000).catch(() => undefined);
	sub.close();
}
