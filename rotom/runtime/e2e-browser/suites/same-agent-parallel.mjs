// Same-agent parallelism (T3): one agent, two tabs.
//
// A tab-scoped operation on one tab must not wait for another tab's in-flight
// operation, while a structural operation (tabs/open/close) must still wait, so
// no tab can be closed underneath a running read.

import assert from "node:assert/strict";
import { relayRequestFor } from "../harness.mjs";

export const description = "同一 agent 的两个 tab 并发，结构性操作仍独占";

const SLOW_MS = 2_500;

export async function run({ harness, fixtures, recorder }) {
	const client = await harness.connect("parallel-main");
	const request = relayRequestFor(client, "parallel");
	const slowUrl = fixtures.url(`/slow?ms=${SLOW_MS}`);

	await recorder.check("打开一个慢加载 tab 和一个正常 tab", async () => {
		await request("close", { all: true }, 5_000);
		await Promise.all([
			request("open", { tabName: "par-slow", url: slowUrl }, 10_000),
			request("open", { tabName: "par-fast", url: fixtures.url("/baseline") }, 10_000),
		]);
		await request("wait", { tabName: "par-fast", status: "complete", timeoutMs: 10_000 }, 11_000);
	});

	await recorder.check("另一个 tab 的 snapshot 不被慢操作阻塞", async () => {
		const startedAt = Date.now();
		// This `wait` stays in flight until the slow page commits (~2.5s).
		const slowWait = request("wait", { tabName: "par-slow", status: "complete", timeoutMs: 15_000 }, 16_000);
		await new Promise((resolve) => setTimeout(resolve, 300));
		const snapshotAt = Date.now();
		const snapshot = await request("snapshot", { tabName: "par-fast" }, 10_000);
		const snapshotMs = Date.now() - snapshotAt;
		assert.equal(snapshot.nodes.some((node) => node.role === "heading"), true, "并发 snapshot 仍返回真实内容");
		assert.equal(snapshotMs < SLOW_MS - 500, true, `snapshot 被同 session 的慢操作阻塞了：${snapshotMs}ms`);

		const slow = await slowWait;
		const waitedMs = Date.now() - startedAt;
		assert.equal(slow.status, "complete");
		// `open` already spent part of the page load, so the wait is shorter than
		// SLOW_MS; what matters is that it really was in flight while the other tab
		// was read.
		assert.equal(waitedMs > 600, true, `等待本身应当是长操作：${waitedMs}ms`);
		assert.equal(waitedMs - snapshotMs > 300, true, `另一个 tab 的 snapshot (${snapshotMs}ms) 必须在 wait (${waitedMs}ms) 结束前完成`);
	});

	await recorder.check("一个 tab 的操作超时不打断另一个 tab 的读取，也不关闭连接", async () => {
		// `par-slow` is already complete, so a wait for "loading" can never be satisfied: the
		// relay answers with its own operation timeout while the sibling read is running.
		const doomed = request("wait", { tabName: "par-slow", status: "loading", timeoutMs: 1_500 }, 8_000);
		await new Promise((resolve) => setTimeout(resolve, 200));
		const snapshot = await request("snapshot", { tabName: "par-fast" }, 10_000);
		assert.equal(snapshot.nodes.some((node) => node.role === "heading"), true, "超时进行中，另一个 tab 的读取仍然成功");
		await assert.rejects(doomed, /timeout/u);
		assert.equal(client.closed, false, "单个操作超时不得关闭共享的 relay client");
		const after = await request("tabs", {}, 10_000);
		assert.ok(after.tabs.some((tab) => tab.name === "par-fast"), "超时之后连接仍然可用");
	});

	await recorder.check("结构性操作必须等只读操作结束，tab 不会被中途关掉", async () => {
		await request("open", { tabName: "par-slow2", url: slowUrl }, 10_000);
		const slowWait = request("wait", { tabName: "par-slow2", status: "complete", timeoutMs: 15_000 }, 16_000);
		await new Promise((resolve) => setTimeout(resolve, 300));
		const tabsAt = Date.now();
		const tabs = await request("tabs", {}, 20_000);
		const tabsMs = Date.now() - tabsAt;
		await slowWait;
		assert.deepEqual(tabs.tabs.map((tab) => tab.name).sort(), ["par-fast", "par-slow", "par-slow2"]);
		assert.equal(tabsMs >= SLOW_MS - 900, true, `tabs 必须排在在飞的只读操作之后，实际 ${tabsMs}ms`);
	});

	await recorder.check("同一个 tab 的并发读取不产生错乱状态", async () => {
		const [a, b] = await Promise.all([
			request("snapshot", { tabName: "par-fast" }, 10_000),
			request("snapshot", { tabName: "par-fast" }, 10_000),
		]);
		assert.equal(a.documentGeneration, b.documentGeneration, "同一 document 的两次读取都成功");
		assert.equal(a.nodes.length, b.nodes.length);
	});

	await recorder.check("慢加载页面最终完成且可读", async () => {
		const waited = await request("wait", { tabName: "par-slow", status: "complete", timeoutMs: 15_000 }, 16_000);
		assert.equal(waited.status, "complete");
		const snapshot = await request("snapshot", { tabName: "par-slow" }, 10_000);
		assert.equal(snapshot.nodes.some((node) => node.name === "Slow page ready"), true);
	});

	client.close();
}
