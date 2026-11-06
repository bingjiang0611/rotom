// navigate (T12): URL navigation plus history back/forward/reload in one owned tab.
//
// The point is not that a page loads; it is that the tab's document identity changes,
// so everything minted against the previous document must be refused as stale.

import assert from "node:assert/strict";
import { relayRequestFor } from "../harness.mjs";

export const description = "navigate：前进/后退/刷新后旧 ref 报 stale，lease 限制历史导航";

export async function run({ harness, fixtures, recorder }) {
	const client = await harness.connect("navigate-main");
	const request = relayRequestFor(client, "navigate");
	const refOf = (observation, role, name) => observation.nodes.find((node) => node.role === role && (name === undefined || node.name.includes(name)))?.ref;

	await recorder.check("open 一个拥有历史的 tab", async () => {
		await request("close", { all: true }, 5_000);
		await request("open", { tabName: "nav", url: fixtures.url("/baseline") }, 10_000);
		// A second page gives the tab back/forward history.
		const second = await request("navigate", { tabName: "nav", url: fixtures.url("/popup") }, 15_000);
		assert.equal(second.url.endsWith("/popup"), true);
		assert.equal(second.tabName, "nav");
	});

	await recorder.check("URL 导航换 document generation 并让旧 ref 失效", async () => {
		const before = await request("snapshot", { tabName: "nav" }, 10_000);
		const staleRef = refOf(before, "heading") ?? refOf(before, "textbox");
		if (staleRef === undefined) throw new Error("没有可用于 stale 断言的 ref");
		const after = await request("navigate", { tabName: "nav", url: fixtures.url("/baseline") }, 20_000);
		assert.equal(after.documentGeneration, before.documentGeneration + 1, "navigate 必须换 document generation");
		await assert.rejects(request("interact", { tabName: "nav", action: "click", targetRef: staleRef, actionId: `navigate-stale-${Date.now()}` }, 10_000), /stale|已失效|generation/u);
	});

	await recorder.check("后退回到上一页，generation 继续递增", async () => {
		const before = await request("snapshot", { tabName: "nav" }, 10_000);
		const back = await request("navigate", { tabName: "nav", history: "back" }, 20_000);
		assert.equal(back.url.endsWith("/popup"), true, `back 必须回到 /popup，实际 ${back.url}`);
		assert.equal(back.documentGeneration, before.documentGeneration + 1);
	});

	await recorder.check("前进回到下一页", async () => {
		const forward = await request("navigate", { tabName: "nav", history: "forward" }, 20_000);
		assert.equal(forward.url.endsWith("/baseline"), true, `forward 必须回到 /baseline，实际 ${forward.url}`);
	});

	await recorder.check("刷新保持 URL 但换 generation，旧 ref 仍失效", async () => {
		const before = await request("snapshot", { tabName: "nav" }, 10_000);
		const staleRef = refOf(before, "heading") ?? refOf(before, "button");
		const reloaded = await request("navigate", { tabName: "nav", history: "reload" }, 25_000);
		assert.equal(reloaded.url.endsWith("/baseline"), true, "reload 不换 URL");
		assert.equal(reloaded.documentGeneration, before.documentGeneration + 1, "reload 也要换 generation");
		if (staleRef !== undefined) await assert.rejects(request("interact", { tabName: "nav", action: "click", targetRef: staleRef, actionId: `navigate-reload-${Date.now()}` }, 10_000), /stale|已失效|generation/u);
	});

	await recorder.check("非法导航目标在本地被拒绝", async () => {
		await assert.rejects(request("navigate", { tabName: "nav", url: "file:///etc/passwd" }, 5_000), /URL|url/u);
		await assert.rejects(request("navigate", { tabName: "nav" }, 5_000), /url|history/u);
		await assert.rejects(request("navigate", { tabName: "nav", url: fixtures.url("/baseline"), history: "back" }, 5_000), /url|history/u);
	});

	await recorder.check("子 agent 的 history 导航按 lease 判定，未授权的落点不发命令", async () => {
		// A lease that lists only the popup page's origin, on a tab whose history still
		// reaches the baseline page on the same origin: the check is origin-based, so
		// prove the refusal path with a lease that lists a foreign origin instead.
		const before = await request("snapshot", { tabName: "nav" }, 10_000);
		const refused = await request("navigate", { tabName: "nav", history: "back", allowedOrigins: ["https://other.example.test"] }, 10_000);
		assert.equal(refused.kind, "needs-approval");
		assert.equal(refused.capability, "open");
		const after = await request("snapshot", { tabName: "nav" }, 10_000);
		assert.equal(after.documentGeneration, before.documentGeneration, "被拒绝的历史导航不得改动 document");
		// Same tab, same request, lease now covers the fixture origin: it goes through.
		const allowed = await request("navigate", { tabName: "nav", history: "back", allowedOrigins: [new URL(fixtures.url("/popup")).origin] }, 20_000);
		assert.equal(allowed.url.endsWith("/popup"), true);
		await request("close", { all: true }, 5_000);
	});
}
