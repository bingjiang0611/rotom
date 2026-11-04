// Isolation suite (T2): two agents in one root session, plus one unrelated root.
// Proves that tabs stay owned by exactly one session, that a transfer hands over
// a clean slate, and that a claimed popup belongs to its opener.

import assert from "node:assert/strict";
import { relayRequestFor } from "../harness.mjs";

export const description = "跨 agent 的 tab 隔离、transfer 与 opener 归属";

export async function run({ harness, fixtures, recorder }) {
	const main = await harness.connect("isolation-main");
	const request = relayRequestFor(main, "isolation-main");
	const peer = await harness.connect("isolation-peer", { principal: { agentId: "run_peer", rootSessionId: main.rootSessionId } });
	const peerRequest = relayRequestFor(peer, "isolation-peer");
	const stranger = await harness.connect("isolation-stranger", { principal: { agentId: "run_stranger", rootSessionId: "isolation-other-root" } });
	const strangerRequest = relayRequestFor(stranger, "isolation-stranger");
	const url = fixtures.url("/baseline");

	let mainTabId;
	let mainSnapshot;

	await recorder.check("同一 root 下的两个 agent 各自只看见自己的 tab", async () => {
		await request("open", { tabName: "iso-a", url }, 10_000);
		await peerRequest("open", { tabName: "iso-b", url: fixtures.url("/popup") }, 10_000);
		const [tabs, peerTabs] = await Promise.all([request("tabs", {}, 5_000), peerRequest("tabs", {}, 5_000)]);
		assert.deepEqual(tabs.tabs.map((tab) => tab.name), ["iso-a"]);
		assert.deepEqual(peerTabs.tabs.map((tab) => tab.name), ["iso-b"]);
		assert.equal(tabs.agentId, "main");
		assert.equal(peerTabs.agentId, "run_peer", "peer 上报自己的 agentId");
		assert.equal(peerTabs.rootSessionId, main.rootSessionId, "两个 agent 共享一个 root session");
		mainTabId = tabs.tabs[0].tabId;

		const discovered = await peerRequest("discover", {}, 5_000);
		assert.equal(discovered.tabs.some((tab) => tab.tabId === mainTabId), false, "discover 不得返回另一个 agent 拥有的 tab");
	});

	await recorder.check("claim 另一个 agent 的 tab 被拒，且不泄露对方 tabName", async () => {
		const refusal = await peerRequest("claim", { tabName: "stolen", tabId: mainTabId }, 5_000).then(() => undefined, (error) => error);
		assert.ok(refusal, "claim 必须失败");
		assert.match(refusal.message, /already owned by another relay session/u);
		assert.equal(refusal.message.includes("iso-a"), false, "拒绝信息不得带出对方 tabName");
	});

	await recorder.check("由本人 tab 打开的弹窗只有 opener 拥有者能 claim", async () => {
		mainSnapshot = await request("snapshot", { tabName: "iso-a" }, 10_000);
		const popup = mainSnapshot.nodes.find((node) => node.role === "button" && node.name === "Script popup");
		assert.ok(popup);
		const clicked = await request("interact", { actionId: "iso-popup", tabName: "iso-a", action: "click", targetRef: popup.ref }, 10_000);
		assert.equal(clicked.acknowledged, true, "点击弹窗按钮必须被确认");
		await new Promise((resolve) => setTimeout(resolve, 500));
		const [ownDiscover, peerDiscover] = await Promise.all([request("discover", {}, 5_000), peerRequest("discover", {}, 5_000)]);
		const own = ownDiscover.tabs.find((tab) => new URL(tab.url).pathname === "/popup");
		const other = peerDiscover.tabs.find((tab) => tab.tabId === own?.tabId);
		assert.ok(own, "opener 的拥有者能在 discover 里看到新弹窗");
		assert.equal(own.openerOwnedByYou, true, `opener 拥有者应看到 openerOwnedByYou=true，实际 tab=${JSON.stringify(own)}`);
		assert.ok(other, "弹窗对其他 agent 也可发现");
		assert.equal(other.openerOwnedByYou, false, `其他 agent 应看到 openerOwnedByYou=false，实际 ${JSON.stringify(other)}`);
		await assert.rejects(peerRequest("claim", { tabName: "iso-popup-steal", tabId: own.tabId }, 5_000), /opened from another relay session/u);
		const claimed = await request("claim", { tabName: "iso-popup", tabId: own.tabId }, 5_000);
		assert.equal(claimed.tabName, "iso-popup");
		await request("close", { tabName: "iso-popup" }, 5_000);
	});

	await recorder.check("transfer 换新名字、generation 与 epoch，旧 ref 失效", async () => {
		const before = mainSnapshot;
		const node = before.nodes.find((item) => item.role === "button" && item.name === "Save draft");
		assert.ok(node, "移交前需要一个可点击的 ref");
		const oldGeneration = before.documentGeneration;
		const transferred = await request("transfer", { tabName: "iso-a", toAgentId: "run_peer" }, 5_000);
		assert.equal(transferred.kind, "rotom-browser-transfer");
		assert.equal(transferred.tabName, "iso-a@main", "接收方名字是 <原名>@<来源 agent>");
		assert.equal(transferred.to, "run_peer");
		assert.equal(transferred.documentGeneration, oldGeneration + 1, "documentGeneration 必须换新");
		assert.notEqual(transferred.observationEpoch, before.observationEpoch ?? 0);

		const peerTabs = await peerRequest("tabs", {}, 5_000);
		assert.deepEqual(peerTabs.tabs.map((tab) => tab.name).sort(), ["iso-a@main", "iso-b"]);
		const mainTabs = await request("tabs", {}, 5_000);
		assert.deepEqual(mainTabs.tabs, [], "移交是一次移动，原 agent 不再拥有");
		await assert.rejects(request("snapshot", { tabName: "iso-a" }, 5_000), /owned tab not found|iso-a/u, "原 agent 用旧名字访问必须失败");

		const received = await peerRequest("snapshot", { tabName: "iso-a@main" }, 10_000);
		assert.equal(received.documentGeneration, oldGeneration + 1);
		const staleRef = node.ref;
		const stale = await peerRequest("interact", { actionId: "iso-stale", tabName: "iso-a@main", action: "click", targetRef: staleRef }, 5_000).then(() => undefined, (error) => error);
		assert.ok(stale, "旧 ref 必须被拒绝");
		assert.match(stale.message, /stale|generation|ref/u);
	});

	await recorder.check("不同 root 之间的 transfer 被拒", async () => {
		await request("open", { tabName: "iso-c", url }, 10_000);
		await assert.rejects(request("transfer", { tabName: "iso-c", toAgentId: "run_stranger" }, 5_000), /no relay session for agent run_stranger/u);
		const strangerTabs = await strangerRequest("tabs", {}, 5_000);
		assert.deepEqual(strangerTabs.tabs, [], "另一个 root 的 agent 不会收到 tab");
		const mainTabs = await request("tabs", {}, 5_000);
		assert.deepEqual(mainTabs.tabs.map((tab) => tab.name), ["iso-c"], "被拒的移交不能改变所有权");
	});

	await recorder.check("未知目标 agent 的 transfer 也拒绝", async () => {
		await assert.rejects(request("transfer", { tabName: "iso-c", toAgentId: "run_missing" }, 5_000), /no relay session for agent run_missing/u);
		await assert.rejects(request("transfer", { tabName: "iso-c", toAgentId: "bad agent" }, 5_000), /toAgentId/u);
	});

	main.close();
	peer.close();
	stranger.close();
}
