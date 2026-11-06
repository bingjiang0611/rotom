// Chunked responses (T7): a large readback crosses the real stack.
//
// The service worker splits any response above 256 KiB into numbered chunks, the
// native host forwards them as-is, and the client reassembles and verifies the
// digest. This suite reads a document large enough to need that path and checks
// the content arrived intact.

import assert from "node:assert/strict";
import { relayRequestFor } from "../harness.mjs";

export const description = "大响应经分块传输后内容完整，后续请求不受影响";

const CHUNK_THRESHOLD_BYTES = 256 * 1024;

export async function run({ harness, fixtures, recorder }) {
	const client = await harness.connect("chunked-main");
	const request = relayRequestFor(client, "chunked");

	await recorder.check("大文档的 full read 完整到达（走分块路径）", async () => {
		await request("close", { all: true }, 5_000);
		await request("open", { tabName: "chunk-big", url: fixtures.url("/large") }, 10_000);
		await request("wait", { tabName: "chunk-big", status: "complete", timeoutMs: 15_000 }, 16_000);
		const read = await request("read_full", { tabName: "chunk-big" }, 30_000);
		// Node boundaries fall on character boundaries, so a separator would split words and
		// make a complete document look like it lost paragraphs.
		const text = (read.nodes ?? []).filter((node) => node.role === "document-text").map((node) => node.name).join("");
		assert.ok(Buffer.byteLength(text, "utf8") > CHUNK_THRESHOLD_BYTES, `正文必须是分块量级：${Buffer.byteLength(text, "utf8")} 字节`);
		assert.match(text, /Large document tail sentinel/u, "文档尾部必须完整，不能只剩前面的块");
		assert.match(text, /Paragraph 1:/u, "文档开头也必须在");
		// Every paragraph, in order: a traversal step that skips content must fail here
		// even though the response still arrives in one piece.
		const paragraphs = [...text.matchAll(/Paragraph (\d+):/gu)].map((match) => Number(match[1]));
		const expected = Array.from({ length: 340 }, (_, index) => index + 1);
		assert.deepEqual(paragraphs, expected, `340 段必须按顺序完整出现，实际 ${paragraphs.length} 段`);
		assert.equal(read.truncated, false, "这份文档不该触发截断");
	});

	await recorder.check("分块响应之后同一连接仍能继续请求", async () => {
		const tabs = await request("tabs", {}, 5_000);
		assert.equal(tabs.tabs.some((tab) => tab.name === "chunk-big"), true, "分块传输不能破坏连接绑定");
		const snapshot = await request("snapshot", { tabName: "chunk-big" }, 10_000);
		assert.equal(snapshot.nodes.some((node) => node.role === "heading" && node.name === "Large document"), true);
	});

	await recorder.check("另一个 tab 的读在分块响应进行中完成", async () => {
		// 结构操作（tabs/close）按 T3 的合同排队；这里验证的是分块大响应不会
		// 阻塞同一 session 里另一个 tab 的读。
		await request("open", { tabName: "chunk-small", url: fixtures.url("/baseline") }, 10_000);
		const [read, snapshot] = await Promise.all([
			request("read_full", { tabName: "chunk-big" }, 30_000),
			request("snapshot", { tabName: "chunk-small" }, 15_000),
		]);
		assert.ok((read.nodes ?? []).length > 0);
		assert.equal(snapshot.nodes.some((node) => node.role === "heading"), true, "小响应必须独立完成");
	});

	await request("close", { all: true }, 5_000).catch(() => undefined);
	client.close();
}
