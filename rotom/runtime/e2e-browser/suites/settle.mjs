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

// Known limit (usage / CLAUDE.md §6): a Linux background tab is not guaranteed to composite
// frames, so a read that depends on painted frames can stay incomplete or hit the operation
// deadline. What must never change is the honesty of the answer: incomplete reads must not be
// reported as complete, and lost rows must not coexist with `contentComplete: true`.
const linux = process.platform === "linux";
const MEDIUM_SECTIONS = 26;
const missingMediumSections = (text) => Array.from({ length: MEDIUM_SECTIONS }, (_, index) => index + 1)
	.filter((index) => !text.includes(`Medium section ${index} of ${MEDIUM_SECTIONS}`));
const TAIL_SENTINEL = /Medium document tail sentinel/u;

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
		let read;
		try {
			read = await request("read_full", { tabName: "medium" }, 60_000);
		} catch (error) {
			assert.equal(linux, true, `read_full 不该在 ${process.platform} 上失败：${error?.message ?? error}`);
			assert.match(String(error?.message ?? error), /timeout/iu, `Linux 上的失败必须是如实报出的 timeout：${error?.message ?? error}`);
			return;
		}
		const text = textOf(read);
		const restoredToOrigin = async () => {
			const restored = await evaluate("medium", "Math.round(document.scrollingElement.scrollTop)");
			assert.equal(restored, 400, `滚动位置必须恢复到读之前，实际 ${restored}`);
		};
		if (linux && read.contentComplete !== true) {
			// Incomplete is the accepted Linux outcome. It stays honest only if it also does not
			// pretend to be truncated for a size reason; and the scroll position must come back
			// either way, because reading and writing `scrollTop` does not need painted frames
			// (measured on a hidden tab in round 2). A read that *does* report complete falls
			// through to the strict assertions below, so both branches are covered.
			assert.equal(read.truncated, false, "未完成不能同时报告为按字数截断");
			assert.equal(["scroll-end", "rendered-dom"].includes(read.contentCoverage), true, `contentCoverage 必须是合同里的取值：${read.contentCoverage}`);
			await restoredToOrigin();
			return;
		}
		assert.equal(read.contentCoverage, "scroll-end", "必须真的滚动过，不能只读渲染 DOM");
		assert.ok(read.scrolledContainers > 0, "至少一个容器被滚动");
		assert.equal(read.truncated, false, "这份文档不该触发截断");
		assert.equal(read.contentComplete, true, `读完的页面必须标记完成：${JSON.stringify({ complete: read.contentComplete, steps: read.scanSteps, truncated: read.truncated })}`);
		assert.match(text, /Medium section 1 of 26/u, "开头必须在");
		const missingSections = missingMediumSections(text);
		assert.equal(missingSections.length, 0, `缺段：${missingSections.slice(0, 5).join(", ")}`);
		assert.match(text, TAIL_SENTINEL, "尾部必须在");
		await restoredToOrigin();
	});

	await recorder.check("渲染晚于稳定窗口的列表不会静默丢行", async () => {
		await request("open", { tabName: "late", url: fixtures.url("/virtual-late") }, 10_000);
		await request("wait", { tabName: "late", status: "complete", timeoutMs: 15_000 }, 16_000);
		let read;
		try {
			read = await request("read_full", { tabName: "late" }, 60_000);
		} catch (error) {
			assert.equal(linux, true, `read_full 不该在 ${process.platform} 上失败：${error?.message ?? error}`);
			assert.match(String(error?.message ?? error), /timeout/iu, `Linux 上的失败必须是如实报出的 timeout：${error?.message ?? error}`);
			return;
		}
		const text = textOf(read);
		const seen = new Set([...text.matchAll(/Virtual row (\d+) of 200/gu)].map((match) => Number(match[1])));
		const missing = Array.from({ length: 200 }, (_, index) => index + 1).filter((row) => !seen.has(row));
		if (linux && missing.length > 0) {
			assert.equal(read.contentComplete, false, `漏了 ${missing.length} 行却报告完成（前几个：${missing.slice(0, 5)}）`);
			return;
		}
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
