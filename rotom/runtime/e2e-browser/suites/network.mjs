// network (T14): request metadata, never content.
//
// Capture starts when the relay attaches to a tab, so the fixture issues its requests
// after the document is ready rather than relying on the initial document load.
//
// The fixture page sends a secret cookie and Authorization header on a request that
// fails with 500. The suite asserts both values reached the fixture server (so the
// check is not vacuous) and that neither appears anywhere in the relay result.

import assert from "node:assert/strict";
import { NETWORK_FIXTURE_SECRETS } from "../fixtures/server.mjs";
import { relayRequestFor } from "../harness.mjs";

export const description = "network：failedOnly/pattern/resourceType 过滤，结果不含 header 与 body";

const FORBIDDEN_KEYS = ["headers", "requestHeaders", "responseHeaders", "postData", "body", "cookie", "cookies"];

export async function run({ harness, fixtures, recorder }) {
	const client = await harness.connect("network-main");
	const request = relayRequestFor(client, "network");
	const readNetwork = async (payload = {}) => request("network", { tabName: "log", ...payload }, 10_000);
	// The three fixture requests need a moment to finish and be finalized.
	const settled = async () => {
		for (let attempt = 0; attempt < 40; attempt += 1) {
			const page = await readNetwork({ limit: 200 });
			// Wait for every fixture fetch to finish loading: status alone can precede
			// loadingFinished, and a slow one still in flight made the "two successful
			// fetches" assertion depend on the harness being slow rather than on the relay.
			const fetches = page.entries.filter((entry) => entry.resourceType === "Fetch");
			const settledFetches = fetches.length >= 3 && fetches.every((entry) => typeof entry.status === "number");
			if (settledFetches && page.entries.some((entry) => entry.status === 500 && typeof entry.durationMs === "number")) return page;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error(`请求没有在预期时间内完成：${JSON.stringify((await readNetwork({ limit: 200 })).entries)}`);
	};

	await recorder.check("open 后请求元数据可见：方法、URL、状态、类型、耗时", async () => {
		await request("close", { all: true }, 5_000);
		await request("open", { tabName: "log", url: fixtures.url("/network") }, 10_000);
		await request("wait", { tabName: "log", status: "complete", timeoutMs: 10_000 }, 11_000);
		const page = await settled();
		assert.equal(page.kind, "rotom-browser-network");
		assert.ok(Date.parse(page.captureSince) > 0, "captureSince 必须是真实时间");
		const failed = page.entries.find((entry) => entry.status === 500);
		assert.ok(failed, `500 请求必须被记录：${JSON.stringify(page.entries)}`);
		assert.equal(failed.method, "GET");
		assert.match(failed.url, /\/status-500$/u);
		assert.equal(failed.url.includes("?"), false, "URL 必须脱敏");
		assert.equal(failed.resourceType, "Fetch");
		assert.equal(typeof failed.durationMs, "number", `必须记录耗时：${JSON.stringify(failed)}`);
		assert.ok(failed.durationMs >= 0);
		// Capture starts when the relay attaches, so the initial document request is not
		// guaranteed; the fixture issues these three fetches after load instead.
		assert.equal(page.entries.filter((entry) => entry.resourceType === "Fetch" && entry.status === 200).length >= 2, true, `至少两条成功的 fetch：${JSON.stringify(page.entries)}`);
	});

	await recorder.check("failedOnly 只留失败请求（4xx/5xx 与 loadingFailed）", async () => {
		const page = await readNetwork({ failedOnly: true, limit: 200 });
		assert.ok(page.entries.length > 0, "至少要有一条失败请求");
		for (const entry of page.entries) {
			assert.ok(typeof entry.failure === "string" || entry.status >= 400, `failedOnly 混入了成功请求：${JSON.stringify(entry)}`);
		}
		assert.deepEqual(page.entries.filter((entry) => entry.url.endsWith("/status-500")).map((entry) => entry.status), [500]);
		const all = await readNetwork({ limit: 200 });
		assert.ok(all.entries.length > page.entries.length, "failedOnly 必须是过滤而不是重放");
	});

	await recorder.check("pattern 与 resourceType 过滤", async () => {
		const byPattern = await readNetwork({ pattern: "STATUS-500" });
		assert.deepEqual(byPattern.entries.map((entry) => entry.url.split("/").at(-1)), ["status-500"]);
		const byType = await readNetwork({ resourceType: "Fetch", limit: 200 });
		assert.equal(byType.entries.length >= 3, true);
		for (const entry of byType.entries) assert.equal(entry.resourceType, "Fetch");
		const none = await readNetwork({ pattern: ".*" });
		assert.deepEqual(none.entries, [], "pattern 是子串，不是正则");
	});

	await recorder.check("结果里没有 header、body 或 cookie，也没有它们的值", async () => {
		const sent = fixtures.requests.filter((entry) => entry.headers?.authorization === `Bearer ${NETWORK_FIXTURE_SECRETS.authorization}`);
		assert.equal(sent.length > 0, true, "fixture 必须真的把 Authorization 发出去了，否则断言是空的");
		assert.match(String(sent[0].headers?.cookie ?? ""), new RegExp(`session=${NETWORK_FIXTURE_SECRETS.cookie}`, "u"));
		const page = await readNetwork({ limit: 200 });
		String(page);
		const serialized = JSON.stringify(page);
		assert.equal(serialized.includes(NETWORK_FIXTURE_SECRETS.authorization), false, "结果里不得出现 Authorization 的值");
		assert.equal(serialized.includes(NETWORK_FIXTURE_SECRETS.cookie), false, "结果里不得出现 cookie 的值");
		for (const entry of page.entries) for (const key of FORBIDDEN_KEYS) assert.equal(Object.hasOwn(entry, key), false, `entry 不得含 ${key}`);
	});

	await recorder.check("cursor 续读不重放，非法参数被拒绝", async () => {
		const first = await readNetwork({ limit: 1 });
		assert.equal(first.entries.length, 1);
		assert.equal(typeof first.nextCursor, "string");
		const second = await readNetwork({ sinceCursor: first.nextCursor, limit: 200 });
		assert.ok(second.entries.length > 0, "必须还有后续条目");
		assert.ok(second.entries[0].seq > first.entries[0].seq, "cursor 必须前进而不是重放");
		await assert.rejects(readNetwork({ limit: 201 }), /network limit/u);
		await assert.rejects(readNetwork({ sinceCursor: "c1" }), /network sinceCursor/u);
		await assert.rejects(readNetwork({ resourceType: "fetch" }), /network resourceType/u);
	});
}
