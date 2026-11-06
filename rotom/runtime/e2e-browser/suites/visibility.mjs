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

	await request("close", { all: true }, 5_000).catch(() => undefined);
	client.close();
}
