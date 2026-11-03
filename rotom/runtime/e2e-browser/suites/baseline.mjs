// Baseline suite: the pre-existing relay capabilities must still work on the
// isolated harness. Ported from rotom/runtime/smoke-browser-relay.mjs.

import assert from "node:assert/strict";
import { relayRequestFor } from "../harness.mjs";

export const description = "既有 open/snapshot/interact/screenshot/close 行为在隔离架子上复现";

export async function run({ harness, fixtures, recorder }) {
	const primary = await harness.connect("baseline-main");
	const peer = await harness.connect("baseline-peer");
	const request = relayRequestFor(primary, "baseline");
	const peerRequest = relayRequestFor(peer, "baseline-peer");
	const url = fixtures.url("/baseline?secret=must-not-log#fragment");

	await recorder.check("两个客户端都拿到独立 tab", async () => {
		await Promise.all([request("close", { all: true }, 5_000), peerRequest("close", { all: true }, 5_000)]);
		const [opened, peerOpened] = await Promise.all([
			request("open", { tabName: "baseline", url }, 10_000),
			peerRequest("open", { tabName: "peer", url: fixtures.url("/popup") }, 10_000),
		]);
		assert.equal(opened.kind, "rotom-browser-observation");
		assert.equal(opened.tabName, "baseline");
		assert.equal(peerOpened.tabName, "peer");
		const [waited, peerWaited] = await Promise.all([
			request("wait", { tabName: "baseline", status: "complete", timeoutMs: 10_000 }, 11_000),
			peerRequest("wait", { tabName: "peer", status: "complete", timeoutMs: 10_000 }, 11_000),
		]);
		assert.equal(waited.status, "complete");
		assert.equal(peerWaited.status, "complete");
		const [tabs, peerTabs] = await Promise.all([request("tabs", {}, 5_000), peerRequest("tabs", {}, 5_000)]);
		assert.deepEqual(tabs.tabs.map((tab) => tab.name), ["baseline"]);
		assert.deepEqual(peerTabs.tabs.map((tab) => tab.name), ["peer"]);
	});

	const snapshot = await request("snapshot", { tabName: "baseline" }, 10_000);
	await recorder.check("snapshot 含标题、正文与跨域 frame", async () => {
		assert.equal(snapshot.nodes.some((node) => node.role === "heading" && node.name === "Background relay ready"), true);
		assert.equal(snapshot.nodes.some((node) => node.role === "document-text" && node.name.includes("Background relay ready")), true);
		assert.equal(snapshot.nodes.some((node) => node.name === "Cross-origin frame ready"), true);
	});

	const nodes = snapshot.nodes;
	const textbox = nodes.find((node) => node.role === "textbox" && node.name === "Draft title");
	const button = nodes.find((node) => node.role === "button" && node.name === "Save draft");
	const select = nodes.find((node) => node.role === "combobox" && node.name === "Mode");
	const covered = nodes.find((node) => node.role === "button" && node.name === "Covered action");
	const offscreen = nodes.find((node) => node.role === "button" && node.name === "Offscreen action");
	const popup = nodes.find((node) => node.role === "button" && node.name === "Script popup");
	const anotherContext = nodes.find((node) => node.role === "link" && node.name === "Open another context");

	await recorder.check("type/select/click 回读一致", async () => {
		assert.ok(textbox); assert.ok(button); assert.ok(select);
		await request("interact", { actionId: "baseline-type", tabName: "baseline", action: "type", targetRef: textbox.ref, text: "e2e value", replace: true }, 10_000);
		await request("interact", { actionId: "baseline-select", tabName: "baseline", action: "select", targetRef: select.ref, option: "Published" }, 10_000);
		const afterSelect = await request("snapshot", { tabName: "baseline" }, 5_000);
		assert.equal(afterSelect.nodes.some((node) => node.name === "Mode: Published"), true);
		const currentButton = afterSelect.nodes.find((node) => node.role === "button" && node.name === "Save draft");
		assert.ok(currentButton);
		await request("interact", { actionId: "baseline-click", tabName: "baseline", action: "click", targetRef: currentButton.ref }, 10_000);
		const afterClick = await request("snapshot", { tabName: "baseline" }, 5_000);
		assert.equal(afterClick.nodes.some((node) => node.name === "Saved: e2e value"), true);
	});

	await recorder.check("视口外目标与遮挡层按真实鼠标命中处理", async () => {
		assert.ok(offscreen); assert.ok(covered);
		const offscreenClick = await request("interact", { actionId: "baseline-offscreen", tabName: "baseline", action: "click", targetRef: offscreen.ref }, 10_000);
		assert.equal(offscreenClick.readback.nodes.some((node) => node.name.includes("Offscreen clicked")), true);
		const coveredClick = await request("interact", { actionId: "baseline-covered", tabName: "baseline", action: "click", targetRef: covered.ref }, 10_000);
		assert.equal(coveredClick.acknowledged, true);
	});

	await recorder.check("脚本弹窗保持后台且可发现", async () => {
		assert.ok(popup); assert.ok(anotherContext);
		const popupClick = await request("interact", { actionId: "baseline-popup", tabName: "baseline", action: "click", targetRef: popup.ref }, 10_000);
		assert.equal(popupClick.effect.backgroundPreserved, true);
		assert.ok(popupClick.effect.spawnedTabs >= 1);
		const discovered = await request("discover", {}, 5_000);
		const spawned = discovered.tabs.filter((tab) => new URL(tab.url).pathname === "/popup");
		assert.ok(spawned.length >= 1);
		assert.equal(spawned.every((tab) => tab.browserActive === false), true);
	});

	await recorder.check("screenshot 返回有界的 JPEG", async () => {
		const screenshot = await request("screenshot", { tabName: "baseline" }, 10_000);
		const image = Buffer.from(screenshot.data, "base64");
		assert.equal(screenshot.mimeType, "image/jpeg");
		assert.equal(image[0], 0xff);
		assert.equal(image[1], 0xd8);
	});

	await recorder.check("close 只关闭自己的 tab", async () => {
		const [closed, peerClosed] = await Promise.all([request("close", { all: true }, 5_000), peerRequest("close", { all: true }, 5_000)]);
		assert.equal(closed.closed, 1);
		assert.equal(peerClosed.closed, 1);
	});

	primary.close();
	peer.close();
}
