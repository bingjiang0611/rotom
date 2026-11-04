// Cleanup suite (T5): what a subagent leaves behind when it disconnects.
//
// A subagent opens two tabs and claims a popup it spawned. On disconnect its own
// tabs must close, while the claimed tab must survive and become the main agent's.

import assert from "node:assert/strict";
import { relayRequestFor } from "../harness.mjs";

export const description = "子 agent 断开后：自己开的关掉，claim 的交还主 agent";

export async function run({ harness, fixtures, recorder }) {
	const main = await harness.connect("cleanup-main");
	const request = relayRequestFor(main, "cleanup-main");
	const url = fixtures.url("/baseline");
	let sub;

	await recorder.check("子 agent 开两个 tab 并 claim 一个弹窗", async () => {
		await request("close", { all: true }, 5_000);
		await request("open", { tabName: "main-tab", url: fixtures.url("/popup") }, 10_000);
		sub = await harness.connect("cleanup-sub", { principal: { agentId: "run_cleanup", rootSessionId: main.rootSessionId } });
		const subRequest = relayRequestFor(sub, "cleanup-sub");
		await subRequest("open", { tabName: "sub-a", url }, 10_000);
		await subRequest("open", { tabName: "sub-b", url: fixtures.url("/popup") }, 10_000);

		const snapshot = await subRequest("snapshot", { tabName: "sub-a" }, 10_000);
		const popupButton = snapshot.nodes.find((node) => node.role === "button" && node.name === "Script popup");
		assert.ok(popupButton);
		const clicked = await subRequest("interact", { actionId: "cleanup-popup", tabName: "sub-a", action: "click", targetRef: popupButton.ref }, 10_000);
		assert.equal(clicked.acknowledged, true);
		await new Promise((resolve) => setTimeout(resolve, 600));
		const discovered = await subRequest("discover", {}, 5_000);
		const popup = discovered.tabs.find((tab) => new URL(tab.url).pathname === "/popup");
		assert.ok(popup, "子 agent 必须能发现自己弹出的 tab");
		assert.equal(popup.openerOwnedByYou, true);
		const claimed = await subRequest("claim", { tabName: "sub-claimed", tabId: popup.tabId }, 5_000);
		assert.equal(claimed.tabName, "sub-claimed");
		const tabs = await subRequest("tabs", {}, 5_000);
		assert.deepEqual(tabs.tabs.map((tab) => tab.name).sort(), ["sub-a", "sub-b", "sub-claimed"]);
	});

	await recorder.check("子 agent 断开：自己开的关掉，claim 的交还主 agent", async () => {
		sub.close();
		// Client-disconnected travels through the native host; give it a moment.
		const deadline = Date.now() + 15_000;
		let mainTabs;
		for (;;) {
			mainTabs = await request("tabs", {}, 5_000);
			if (mainTabs.tabs.some((tab) => tab.name === "sub-claimed@run_cleanup") || Date.now() > deadline) break;
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
		const names = mainTabs.tabs.map((tab) => tab.name).sort();
		assert.deepEqual(names, ["main-tab", "sub-claimed@run_cleanup"], "自己开的 tab 必须关闭，claim 的必须交还主 agent");
		const handedBack = mainTabs.tabs.find((tab) => tab.name === "sub-claimed@run_cleanup");
		assert.equal(handedBack.documentGeneration >= 2, true, "交还后 ref 必须换新 generation");
		assert.equal(handedBack.ownership, "claimed", "用户标签仍是 claimed，不能被当成 agent 标签关掉");
	});

	await recorder.check("交还后的 tab 由主 agent 正常使用", async () => {
		const snapshot = await request("snapshot", { tabName: "sub-claimed@run_cleanup" }, 10_000);
		assert.equal(snapshot.tabName, "sub-claimed@run_cleanup");
		assert.equal(snapshot.nodes.length > 0, true);
		const closed = await request("close", { tabName: "sub-claimed@run_cleanup" }, 5_000);
		assert.equal(closed.closed, 1);
	});

	await recorder.check("keepTabs 的子 agent 断开后 tab 仍在且可被重新 claim", async () => {
		const keeper = await harness.connect("cleanup-keeper", { principal: { agentId: "run_keeper", rootSessionId: main.rootSessionId, keepTabs: true } });
		const keeperRequest = relayRequestFor(keeper, "cleanup-keeper");
		await keeperRequest("open", { tabName: "keeper-tab", url: fixtures.url("/popup") }, 10_000);
		const keeperTabs = await keeperRequest("tabs", {}, 5_000);
		const keeperTabId = keeperTabs.tabs[0].tabId;
		keeper.close();
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		const discovered = await request("discover", {}, 5_000);
		assert.equal(discovered.tabs.some((tab) => tab.tabId === keeperTabId), true, "keepTabs 的 tab 必须保留并回到可发现状态");
		const reclaimed = await request("claim", { tabName: "reclaimed", tabId: keeperTabId }, 5_000);
		assert.equal(reclaimed.tabName, "reclaimed");
		await request("close", { tabName: "reclaimed" }, 5_000);
	});

	main.close();
}
