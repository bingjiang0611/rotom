// Read coverage and settle behaviour.
//
// The performance work replaced fixed sleeps with "stop as soon as it looks settled".
// These checks pin what that must not break: a page that can be read still finishes and
// says so, a list that renders late does not silently lose rows, and a field that reverts
// itself is not reported as final.

import assert from "node:assert/strict";
import { relayRequestFor } from "../harness.mjs";

export const description = "读完标记、慢渲染列表、延迟回滚都不会被 settle 提前判定骗过";

// Nodes split the text at character boundaries, not at line boundaries, so they are
// concatenated without a separator to rebuild what the page actually said.
const textOf = (read) => (read.nodes ?? []).filter((node) => node.role === "document-text").map((node) => node.name).join("");

export async function run({ harness, fixtures, recorder }) {
	const client = await harness.connect("settle-main");
	const request = relayRequestFor(client, "settle");
	const evaluate = async (tabName, expression) => {
		const record = await request("devtools", { tabName, devtools: "evaluate", expression, awaitPromise: true }, 20_000);
		assert.equal(record.threw, false, `页面脚本抛错：${record.valueText}`);
		// The relay reports the value as JSON text, not as a structured field.
		return JSON.parse(record.valueText);
	};

	await recorder.check("能读完的页面标记完成、内容顺序完整、滚动位置被恢复", async () => {
		await request("close", { all: true }, 5_000);
		await request("open", { tabName: "medium", url: fixtures.url("/read-medium") }, 10_000);
		await request("wait", { tabName: "medium", status: "complete", timeoutMs: 15_000 }, 16_000);
		await evaluate("medium", "document.scrollingElement.scrollTop = 400; Math.round(document.scrollingElement.scrollTop)");
		const read = await request("read_full", { tabName: "medium" }, 60_000);
		const text = textOf(read);
		assert.equal(read.contentCoverage, "scroll-end", "必须真的滚动过，不能只读渲染 DOM");
		assert.ok(read.scrolledContainers > 0, "至少一个容器被滚动");
		assert.equal(read.truncated, false, "这份文档不该触发截断");
		assert.equal(read.contentComplete, true, `读完的页面必须标记完成：${JSON.stringify({ complete: read.contentComplete, steps: read.scanSteps, truncated: read.truncated })}`);
		assert.match(text, /Medium section 1 of 26/u, "开头必须在");
		for (let index = 1; index <= 26; index += 1) assert.match(text, new RegExp(`Medium section ${index} of 26`, "u"), `第 ${index} 段缺失`);
		assert.match(text, /Medium document tail sentinel/u, "尾部必须在");
		const restored = await evaluate("medium", "Math.round(document.scrollingElement.scrollTop)");
		assert.equal(restored, 400, `滚动位置必须恢复到读之前，实际 ${restored}`);
	});

	await recorder.check("渲染晚于稳定窗口的列表不会静默丢行", async () => {
		await request("open", { tabName: "late", url: fixtures.url("/virtual-late") }, 10_000);
		await request("wait", { tabName: "late", status: "complete", timeoutMs: 15_000 }, 16_000);
		const read = await request("read_full", { tabName: "late" }, 60_000);
		const text = textOf(read);
		const seen = new Set([...text.matchAll(/Virtual row (\d+) of 200/gu)].map((match) => Number(match[1])));
		const missing = Array.from({ length: 200 }, (_, index) => index + 1).filter((row) => !seen.has(row));
		assert.equal(missing.length, 0, `列表漏了 ${missing.length} 行（前几个：${missing.slice(0, 5)}）；contentComplete=${read.contentComplete}`);
	});

	await recorder.check("会回滚的输入不被报告为最终生效", async () => {
		await request("open", { tabName: "revert", url: fixtures.url("/revert-input") }, 10_000);
		await request("wait", { tabName: "revert", status: "complete", timeoutMs: 15_000 }, 16_000);
		const observation = await request("snapshot", { tabName: "revert", limit: 200 }, 10_000);
		const ref = observation.nodes.find((node) => node.role === "textbox")?.ref;
		assert.ok(ref, "必须找到输入框");
		const result = await request("interact", {
			actionId: `revert-${Date.now()}`,
			tabName: "revert",
			action: "type",
			targetRef: ref,
			text: "typed",
			replace: true,
			expect: "value=nonempty",
		}, 10_000);
		const outcome = result.effect?.expectation?.outcome;
		assert.equal(outcome, "unmet", `页面 80 ms 后清空，不能报告 met（实际 ${outcome}）`);
	});
}
