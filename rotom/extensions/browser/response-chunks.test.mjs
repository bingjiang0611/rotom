import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { RESPONSE_CHUNK_CODE_UNITS, RESPONSE_CHUNK_THRESHOLD_BYTES, responseChunksV1, responseFramesV1, sha256HexV1 } from "./chrome-extension/response-chunks.js";

const header = { schemaVersion: 1, kind: "response", id: "request-1", sessionId: "session-1", generation: "generation-1", ok: true };

test("小响应仍是单帧；大响应切成带摘要的分块帧", async () => {
	const small = { ...header, result: { ok: true } };
	assert.deepEqual(await responseFramesV1(small), [small], "小于阈值不改变线上形状");

	const text = "x".repeat(RESPONSE_CHUNK_CODE_UNITS * 6);
	const large = { ...header, result: { documentText: text } };
	const frames = await responseFramesV1(large);
	assert.equal(frames.length, 7, "6*48k 字符按块切开，信封计入最后一块");
	assert.ok(JSON.stringify(large).length > RESPONSE_CHUNK_THRESHOLD_BYTES);
	const digest = createHash("sha256").update(JSON.stringify(large), "utf8").digest("hex");
	for (const [index, frame] of frames.entries()) {
		assert.equal(frame.kind, "response-chunk");
		assert.equal(frame.id, header.id);
		assert.equal(frame.chunk.index, index);
		assert.equal(frame.chunk.count, frames.length);
		assert.equal(frame.chunk.sha256, digest, "每块都带整条响应的摘要");
		assert.ok(Buffer.byteLength(JSON.stringify(frame), "utf8") < 256 * 1024, "单帧仍在原生消息上限内");
	}
	// 重组就是简单拼接：客户端只做这步再校验摘要。
	assert.equal(frames.map((frame) => frame.chunk.data).join(""), JSON.stringify(large));
});

test("分块按 UTF-16 code unit 切，代理对不被破坏", async () => {
	// Emoji 占两个 code unit；切点落在一对中间时，JSON 转义后仍能原样拼回。
	// 前缀一个 ASCII 字符，让 48 000 的切点落在代理对中间。
	const payload = { ...header, result: { text: `a${"😀".repeat(100_000)}` } };
	const frames = await responseFramesV1(payload);
	assert.ok(frames.length > 1);
	const rejoined = frames.map((frame) => frame.chunk.data).join("");
	assert.equal(rejoined, JSON.stringify(payload));
	assert.equal(JSON.parse(rejoined).result.text, payload.result.text, "拼回的代理对必须是原来的字符");
	assert.equal(await sha256HexV1(rejoined), frames[0].chunk.sha256);
});

test("超过传输上限的响应在发送前就失败", async () => {
	// 12 MiB 传输上限：不切片到无限块，也不静默截断。
	const huge = { ...header, result: { text: "z".repeat(13 * 1024 * 1024) } };
	await assert.rejects(responseChunksV1(JSON.stringify(huge)), /too large/u);
});

test("service worker 对 ok 响应走分块发送，不直接 post", async () => {
	const source = await readFile(join(import.meta.dirname, "chrome-extension/service-worker.js"), "utf8");
	assert.match(source, /await postResponse\(\{ schemaVersion: 1, kind: "response", [^)]*ok: true, result \}\)/u);
	assert.equal(source.includes("native message too large"), true, "单帧上限仍是最后一道检查");
	assert.match(source, /Math\.ceil\(captured\.data\.length \* 3 \/ 4\) > MAX_SCREENSHOT_BYTES/u, "截图传输上限按解码后字节算");
	assert.match(source, /const MAX_SCREENSHOT_BYTES = 8 \* 1024 \* 1024;/u);
});
