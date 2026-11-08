// Visibility suite (T6): a tab the user is not looking at still runs.
//
// The observation must say whether the page is visible, and an operation on a
// hidden tab must still produce fresh content — the relay wakes the tab's
// lifecycle before every operation instead of trusting that Chrome kept it alive.

import assert from "node:assert/strict";
import { relayRequestFor } from "../harness.mjs";

export const description = "后台 tab 仍可执行操作，observation 报告 visibilityState";

export async function run({ harness, fixtures, recorder }) {
	const client = await harness.connect("visibility-main");
	const request = relayRequestFor(client, "visibility");

	await recorder.check("后台 tab 的 observation 报告 visibilityState", async () => {
		await request("close", { all: true }, 5_000);
		const opened = await request("open", { tabName: "vis-a", url: fixtures.url("/baseline") }, 10_000);
		assert.equal(opened.visibilityState, "hidden", "后台 tab 对用户不可见");
		const snapshot = await request("snapshot", { tabName: "vis-a" }, 10_000);
		assert.equal(snapshot.visibilityState, "hidden");
		assert.equal(snapshot.nodes.some((node) => node.role === "heading"), true);
	});

	await recorder.check("后台 tab 连续交互仍有新鲜回读", async () => {
		for (const index of [1, 2, 3]) {
			const snapshot = await request("snapshot", { tabName: "vis-a" }, 10_000);
			const input = snapshot.nodes.find((node) => node.role === "textbox");
			assert.ok(input, `第 ${index} 次 snapshot 必须仍能看到文本框`);
			const typed = await request("interact", { actionId: `vis-type-${index}`, tabName: "vis-a", action: "type", targetRef: input.ref, text: `round-${index}`, replace: true, expect: "value=nonempty" }, 10_000);
			assert.equal(typed.acknowledged, true);
			assert.deepEqual(typed.effect.expectation, { requested: "value=nonempty", outcome: "met" }, "后台 tab 的输入必须真实落在页面上");
		}
	});

	await recorder.check("隐藏 tab 的 ref 与 epoch 仍一致", async () => {
		const first = await request("snapshot", { tabName: "vis-a" }, 10_000);
		const second = await request("snapshot", { tabName: "vis-a" }, 10_000);
		assert.equal(first.documentGeneration, second.documentGeneration);
		assert.ok(second.observationEpoch > first.observationEpoch, "同一文档的连续观察仍递增 epoch");
		assert.equal(second.visibilityState, "hidden");
	});

	await recorder.check("后台 tab 的 read_full 不依赖环境提供的动画帧", async () => {
		// `read_full` enables focus emulation for the whole scroll loop (`full-read.js`'s
		// `scrollTargetTo` waits two animation frames per step). Measure what the tab would
		// provide on its own first, so a platform where a hidden tab fires no rAF at all
		// (seen on Linux) cannot make this read look complete by accident.
		const opened = await request("open", { tabName: "vis-read", url: fixtures.url("/read-medium") }, 10_000);
		assert.equal(opened.visibilityState, "hidden");
		await request("wait", { tabName: "vis-read", status: "complete", timeoutMs: 15_000 }, 16_000);
		const probe = await request("devtools", {
			tabName: "vis-read",
			devtools: "evaluate",
			awaitPromise: true,
			expression: "new Promise((resolve) => { let frames = 0; const startedAt = performance.now(); const finish = () => resolve(JSON.stringify({ frames, ms: Math.round(performance.now() - startedAt), visibilityState: document.visibilityState })); const tick = () => { frames += 1; if (performance.now() - startedAt < 500) requestAnimationFrame(tick); else finish(); }; requestAnimationFrame(tick); setTimeout(finish, 1_500); })",
		}, 20_000);
		assert.equal(probe.threw, false, `rAF 探针抛错：${probe.valueText}`);
		// The relay reports the page value as JSON text; the page itself returns a JSON string,
		// so this is a second decode, not a mistake.
		const ambient = JSON.parse(JSON.parse(probe.valueText));
		const readAt = Date.now();
		const read = await request("read_full", { tabName: "vis-read" }, 60_000);
		const readMs = Date.now() - readAt;
		assert.equal(read.contentCoverage, "scroll-end", `后台 tab 上必须真的滚动过（环境 rAF：${JSON.stringify(ambient)}）`);
		assert.equal(read.contentComplete, true, `后台 tab 的 read_full 必须读完：${JSON.stringify({ ambient, steps: read.scanSteps, truncated: read.truncated })}`);
		const text = (read.nodes ?? []).filter((node) => node.role === "document-text").map((node) => node.name).join("");
		assert.match(text, /Medium document tail sentinel/u, "没读到结尾就不是完整读");
		process.stdout.write(`# 环境测量（后台 tab）：${JSON.stringify({ ambient, readMs, readSteps: read.scanSteps, scrolledContainers: read.scrolledContainers })}\n`);
	});

	await request("close", { all: true }, 5_000).catch(() => undefined);
	client.close();
}
