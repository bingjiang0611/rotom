import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_NETWORK_ENTRIES_V1,
	NETWORK_RESOURCE_TYPES_V1,
	createNetworkCaptureV1,
	networkEntryFailedV1,
	parseNetworkCursorV1,
	sanitizeNetworkLimitV1,
	sanitizeNetworkPatternV1,
	sanitizeNetworkResourceTypeV1,
} from "./chrome-extension/network-buffer.js";

const started = (requestId, overrides = {}) => ({ requestId, url: `https://example.test/${requestId}`, method: "GET", resourceType: "XHR", at: 1_700_000_000_000, ...overrides });

test("network：没有 header/body 字段，只有 metadata", () => {
	const capture = createNetworkCaptureV1();
	const entry = capture.started(1, { ...started("r1"), headers: { Authorization: "Bearer secret" }, postData: "password=secret" });
	assert.equal(Object.hasOwn(entry, "headers"), false, "header 不进入缓冲");
	assert.equal(Object.hasOwn(entry, "postData"), false, "body 不进入缓冲");
	assert.equal(JSON.stringify(entry).includes("secret"), false);
	assert.deepEqual(Object.keys(entry).sort(), ["at", "method", "requestId", "resourceType", "seq", "url"]);
});

test("network：请求开始即可见，完成后补 status/mimeType/时长", () => {
	const capture = createNetworkCaptureV1();
	capture.started(1, started("r1", { url: "https://example.test/api/items", resourceType: "Fetch" }));
	assert.deepEqual(capture.read(1, {}).entries.map((entry) => entry.resourceType), ["Fetch"]);
	capture.responded(1, { requestId: "r1", status: 200, mimeType: "application/json", fromDiskCache: false, fromServiceWorker: false });
	const finished = capture.finished(1, { requestId: "r1", durationMs: 143, at: 1_700_000_000_143 });
	assert.equal(finished.status, 200);
	assert.equal(finished.mimeType, "application/json");
	assert.equal(finished.durationMs, 143);
	assert.equal(finished.fromCache, false);
	const page = capture.read(1, {});
	assert.equal(page.entries.length, 1, "同一 requestId 原地更新，不会重复计数");
});

test("network：失败原因是 4xx/5xx 或 loadingFailed，failedOnly 只留这两类", () => {
	const capture = createNetworkCaptureV1();
	capture.started(1, started("ok"));
	capture.responded(1, { requestId: "ok", status: 200 });
	capture.finished(1, { requestId: "ok", durationMs: 5 });
	capture.started(1, started("boom", { url: "https://example.test/status-500" }));
	capture.responded(1, { requestId: "boom", status: 500 });
	capture.finished(1, { requestId: "boom", durationMs: 9 });
	capture.started(1, started("net", { url: "https://example.test/refused" }));
	capture.finished(1, { requestId: "net", durationMs: 3, failure: "net::ERR_CONNECTION_REFUSED" });
	const failed = capture.read(1, { failedOnly: true });
	assert.deepEqual(failed.entries.map((entry) => entry.requestId), ["boom", "net"]);
	assert.equal(failed.entries[1].failure, "net::ERR_CONNECTION_REFUSED");
	assert.equal(networkEntryFailedV1({ status: 200 }), false);
	assert.equal(networkEntryFailedV1({ status: 404 }), true);
	assert.equal(networkEntryFailedV1({ failure: "net::ERR_ABORTED" }), true);
});

test("network：1000 条环形，超限丢最旧并计数", () => {
	const capture = createNetworkCaptureV1();
	for (let index = 1; index <= 1_010; index += 1) capture.started(1, started(`r${index}`));
	const page = capture.read(1, { limit: 200 });
	assert.equal(page.retained, MAX_NETWORK_ENTRIES_V1);
	assert.equal(page.dropped, 10);
	assert.equal(page.entries[0].requestId, "r11");
	assert.equal(page.nextCursor, `n${page.entries.at(-1).seq}`);
});

test("network：resourceType 与大小写不敏感的 URL 子串过滤，cursor 续读", () => {
	const capture = createNetworkCaptureV1();
	capture.started(1, started("a", { url: "https://example.test/api/USERS", resourceType: "Fetch" }));
	capture.started(1, started("b", { url: "https://cdn.example.test/app.js", resourceType: "Script" }));
	assert.deepEqual(capture.read(1, { resourceType: "Script" }).entries.map((entry) => entry.requestId), ["b"]);
	assert.deepEqual(capture.read(1, { pattern: "api/users" }).entries.map((entry) => entry.requestId), ["a"]);
	assert.deepEqual(capture.read(1, { pattern: ".*" }).entries, [], "pattern 是子串，不是正则");
	const first = capture.read(1, { limit: 1 });
	assert.equal(first.nextCursor !== undefined, true);
	assert.deepEqual(capture.read(1, { sinceCursor: parseNetworkCursorV1(first.nextCursor), limit: 5 }).entries.map((entry) => entry.requestId), ["b"]);
});

test("network：参数与游标校验", () => {
	assert.equal(sanitizeNetworkResourceTypeV1("Fetch"), "Fetch");
	assert.equal(sanitizeNetworkResourceTypeV1("fetch"), undefined);
	assert.equal(sanitizeNetworkResourceTypeV1("NotAType"), undefined);
	assert.equal(NETWORK_RESOURCE_TYPES_V1.includes("Document"), true);
	assert.equal(sanitizeNetworkPatternV1("api"), "api");
	assert.equal(sanitizeNetworkPatternV1(""), undefined);
	assert.equal(sanitizeNetworkPatternV1("x".repeat(257)), undefined);
	assert.equal(sanitizeNetworkLimitV1(undefined), 50);
	assert.equal(sanitizeNetworkLimitV1(200), 200);
	assert.equal(sanitizeNetworkLimitV1(0), undefined);
	assert.equal(sanitizeNetworkLimitV1(201), undefined);
	assert.equal(parseNetworkCursorV1(undefined), 0);
	assert.equal(parseNetworkCursorV1("n7"), 7);
	for (const invalid of ["7", "c7", "n", "n-1", 7]) assert.equal(parseNetworkCursorV1(invalid), undefined, String(invalid));
});

test("network：每个 tab 独立，reset 只清一个 tab", () => {
	const capture = createNetworkCaptureV1();
	capture.started(1, started("one"));
	capture.started(2, started("two"));
	capture.reset(1);
	assert.equal(capture.stats().tabs, 1, "reset 立即释放该 tab 的缓冲");
	assert.deepEqual(capture.read(2, {}).entries.map((entry) => entry.requestId), ["two"]);
	assert.deepEqual(capture.read(1, {}).entries, [], "reset 后从头开始");
});

test("network：单个 URL 过长时按码点截断，不丢弃记录", () => {
	const capture = createNetworkCaptureV1({ maxEntryBytes: 512 });
	capture.started(1, started("long", { url: `https://example.test/${"段".repeat(1_000)}` }));
	const entry = capture.read(1, {}).entries[0];
	assert.ok(Buffer.byteLength(JSON.stringify(entry), "utf8") <= 512);
	assert.equal(entry.url.startsWith("https://example.test/"), true);
	assert.equal([...entry.url].some((character) => character === "\uFFFD"), false);
});
