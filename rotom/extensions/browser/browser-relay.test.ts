import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { test } from "node:test";
import {
	BrowserArtifactStoreV1,
	BrowserRelayClientV1,
	BrowserRelayUnavailableErrorV1,
	canonicalBrowserUrlV1,
	browserInteractionExpectationOutcomeV1,
	sanitizeBrowserInteractionEffectV1,
	sanitizeBrowserObservationV1,
	validateBrowserScreenshotV1,
} from "./browser-relay.ts";

test("missing local Relay socket is typed pre-dispatch unavailability", async () => {
	await assert.rejects(BrowserRelayClientV1.connect({ sessionId: "missing", socketPath: `/tmp/pi-relay-missing-${process.pid}-${Date.now()}.sock` }), (error: Error) => {
		assert.ok(error instanceof BrowserRelayUnavailableErrorV1);
		assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOENT");
		return true;
	});
});

test("browser URL 拒绝 file/javascript/userinfo", () => {
	assert.equal(canonicalBrowserUrlV1("https://example.com/a?b=1"), "https://example.com/a?b=1");
	for (const value of ["file:///etc/passwd", "javascript:alert(1)", "https://user:secret@example.com/"]) assert.throws(() => canonicalBrowserUrlV1(value));
});

test("browser observation 保留凭据形状文本，仍隐藏 URL query/hash 并限制输出", () => {
	const value = sanitizeBrowserObservationV1({
		schemaVersion: 1, kind: "rotom-browser-observation", tabName: "main", tabId: 7, documentGeneration: 2, observationEpoch: 3,
		url: "https://example.com/path?token=secret#private", title: "Authorization: Bearer abcdefghijklmnop",
		status: "complete", truncated: false, contentCoverage: "rendered-dom", contentComplete: false,
		nodes: [
			{ ref: "ax_2_1", role: "heading", name: "Public title", states: [] },
			{ ref: "ax_2_2", role: "textbox", name: "password: hunter2", states: ["token=fixture-value"] },
		],
	});
	assert.equal(value.url, "https://example.com/path?%3Credacted%3E#%3Credacted%3E");
	assert.equal(value.title, "Authorization: Bearer abcdefghijklmnop");
	assert.equal(value.nodes[1].name, "password: hunter2");
	assert.deepEqual(value.nodes[1].states, ["token=fixture-value"]);
	for (const text of ['{"password":"hunter2"}', "Cookie: sid=fixture", "ghp_abcdefghijklmnopqrstuvwxyz", "sk-proj-abcdefghijklmnop", "-----BEGIN PRIVATE KEY-----"]) {
		assert.equal(sanitizeBrowserObservationV1({ ...value, title: text }).title, text);
	}
	const bounded = sanitizeBrowserObservationV1({ ...value, title: "x".repeat(2_000), nodes: [
		{ ref: "ax_2_3", role: "text\u0000box", name: "password: fixture\u0001\nvalue", states: ["token=fixture\u0007"] },
		{ ref: "ax_2_4", role: "textbox", name: "x".repeat(2_000), states: ["x".repeat(200)] },
	] });
	assert.equal(bounded.title.length, 1_024);
	assert.equal(bounded.nodes[0].role, "textbox");
	assert.equal(bounded.nodes[0].name, "password: fixture\nvalue");
	assert.deepEqual(bounded.nodes[0].states, ["token=fixture"]);
	assert.equal(bounded.nodes[1].name.length, 1_024);
	assert.equal(bounded.nodes[1].states![0].length, 128);
	assert.equal(value.contentComplete, false);
	assert.throws(() => sanitizeBrowserObservationV1({ ...value, digest: undefined, observationEpoch: undefined }), /observationEpoch/u);
});

test("browser observation 只有 scroll-end 且未截断时允许全文完成", () => {
	const complete = sanitizeBrowserObservationV1({
		schemaVersion: 1, kind: "rotom-browser-observation", tabName: "main", tabId: 7, documentGeneration: 2, observationEpoch: 4,
		url: "https://example.com/doc", title: "Doc", status: "complete", nodes: [], truncated: false,
		contentCoverage: "scroll-end", contentComplete: true, scanSteps: 9, scannedContainers: 1, scrolledContainers: 1,
	});
	assert.equal(complete.contentComplete, true);
	assert.equal(complete.scrolledContainers, 1);
	assert.throws(() => sanitizeBrowserObservationV1({ ...complete, digest: undefined, contentCoverage: "rendered-dom", contentComplete: true }), /scroll-end/u);
});

test("screenshot artifact 使用 AES-GCM 私有落盘且关闭后删除", async () => {
	const store = await BrowserArtifactStoreV1.open();
	const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("SECRET-SCREENSHOT")]);
	const screenshot = validateBrowserScreenshotV1({ schemaVersion: 1, kind: "rotom-browser-screenshot", tabName: "main", tabId: 7, documentGeneration: 2, observationEpoch: 5, viewport: { width: 1280, height: 800, pageX: 0, pageY: 0, scale: 1 }, mimeType: "image/jpeg", data: jpeg.toString("base64") });
	assert.throws(() => validateBrowserScreenshotV1({ ...screenshot, observationEpoch: 0 }), /identity/u);
	const artifact = await store.storeScreenshot(screenshot);
	const path = join(store.rootDir, `${artifact.artifactId}.bin`);
	const stored = await readFile(path);
	assert.equal(stored.subarray(0, 8).toString("ascii"), "PIBRART1");
	assert.equal(stored.includes(Buffer.from("SECRET-SCREENSHOT")), false);
	await store.close();
	await assert.rejects(readFile(path), /ENOENT/);
});

test("relay client 绑定 session/generation 并拒绝错误 response", async (t) => {
	const socketPath = `/tmp/rotom-browser-relay-test-${process.pid}-${Date.now()}.sock`;
	let requestCount = 0;
	const server = createServer((socket) => {
		socket.setEncoding("utf8"); let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n"); if (newline < 0) break;
				const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line) continue;
				const request = JSON.parse(line); requestCount++;
				if (request.operation === "fixture-error") {
					socket.write(`${JSON.stringify({ schemaVersion: 1, kind: "response", id: request.id, sessionId: request.sessionId, generation: request.generation, ok: false, error: `password=fixture\u0000${"x".repeat(2_000)}` })}\n`);
					continue;
				}
					const result = request.operation === "hello" ? { schemaVersion: 1, kind: "rotom-browser-relay-ready", protocolRevision: 17, nonce: request.payload.nonce, capabilities: ["virtualized-frame-scroll", "multi-client-multiplex", "coordinate-click", "interaction-target-state", "page-alert-readback", "targeted-keypress"] } : { operation: request.operation };
				socket.write(`${JSON.stringify({ schemaVersion: 1, kind: "response", id: request.id, sessionId: request.sessionId, generation: request.generation, ok: true, result })}\n`);
			}
		});
	});
	try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("sandbox 禁止 Unix socket listen"); return; } throw error; }
	try {
		const client = await BrowserRelayClientV1.connect({ sessionId: "session-1", generation: "generation-1", socketPath });
		assert.deepEqual(await client.request("tabs", {}), { operation: "tabs" });
		assert.equal(requestCount, 2);
		await assert.rejects(client.request("fixture-error", {}), (error: Error) => {
			assert.equal(error.message, (`password=fixture\u0000${"x".repeat(2_000)}`).slice(0, 1_024).replace("\u0000", ""));
			return true;
		});
		assert.equal(requestCount, 3);
		client.close();
	} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("relay client 遇到 protocol 14 busy 时明确要求重载而不等待接管", async (t) => {
	const socketPath = `/tmp/rotom-browser-relay-busy-${process.pid}-${Date.now()}.sock`;
	let connections = 0;
	const server = createServer((socket) => {
		connections += 1;
		const connection = connections;
		socket.setEncoding("utf8"); let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n"); if (newline < 0) break;
				const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line) continue;
				const request = JSON.parse(line);
				if (connection === 1) {
					socket.end(`${JSON.stringify({ schemaVersion: 1, kind: "response", id: request.id, sessionId: request.sessionId, generation: request.generation, ok: false, error: "browser relay busy; another operation is active" })}\n`);
					continue;
				}
				const result = { schemaVersion: 1, kind: "rotom-browser-relay-ready", protocolRevision: 17, nonce: request.payload.nonce, capabilities: ["virtualized-frame-scroll", "multi-client-multiplex", "coordinate-click", "interaction-target-state", "page-alert-readback", "targeted-keypress"] };
				socket.write(`${JSON.stringify({ schemaVersion: 1, kind: "response", id: request.id, sessionId: request.sessionId, generation: request.generation, ok: true, result })}\n`);
			}
		});
	});
	try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("sandbox 禁止 Unix socket listen"); return; } throw error; }
	try {
		await assert.rejects(BrowserRelayClientV1.connect({ sessionId: "session-busy", generation: "generation-busy", socketPath, timeoutMs: 1_000 }), (error: Error) => {
			assert.match(error.message, /协议过旧.*重载/u);
			assert.equal(error instanceof BrowserRelayUnavailableErrorV1, false);
			return true;
		});
		assert.equal(connections, 1);
	} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("interaction effect 保留凭据形状文本，仍限制证据形状与长度", () => {
	const effect = sanitizeBrowserInteractionEffectV1({
		dispatch: "mouse", coordinate: true, hitNodeName: "canvas",
		target: { observed: true, changed: null, transitions: ["checked=false→true", "password: hunter2"] },
		expectation: { requested: "checked=true", outcome: "met" },
	});
	assert.deepEqual(effect.target, { observed: true, changed: null, transitions: ["checked=false→true", "password: hunter2"] });
	assert.equal(browserInteractionExpectationOutcomeV1(effect), "met");
	assert.equal(browserInteractionExpectationOutcomeV1(sanitizeBrowserInteractionEffectV1({ expectation: { requested: "checked=true", outcome: "weird" } })), "unknown");
	assert.equal(browserInteractionExpectationOutcomeV1(sanitizeBrowserInteractionEffectV1({ dispatch: "mouse" })), undefined);
	assert.equal(browserInteractionExpectationOutcomeV1(undefined), undefined);
	assert.equal((sanitizeBrowserInteractionEffectV1({ hitNodeName: "x".repeat(400) }).hitNodeName as string).length, 256);
	for (const invalid of [undefined, "effect", { target: { nested: { deeper: 1 } } }, { "bad-key": 1 }, { transitions: Array.from({ length: 17 }, () => "a") }, { moved: Number.NaN }, { at: new Date() }]) {
		assert.throws(() => sanitizeBrowserInteractionEffectV1(invalid), /browser interaction effect/u);
	}
});

for (const [protocolRevision, capabilities] of [
	[16, ["virtualized-frame-scroll", "multi-client-multiplex", "coordinate-click", "interaction-target-state", "page-alert-readback", "targeted-keypress"]],
	[17, ["virtualized-frame-scroll", "multi-client-multiplex", "coordinate-click", "interaction-target-state", "page-alert-readback"]],
	[17, ["virtualized-frame-scroll", "multi-client-multiplex", "targeted-keypress"]],
] as const) test(`relay client 拒绝旧协议或缺少必需 capability: ${protocolRevision}/${capabilities.length}`, async (t) => {
	const socketPath = `/tmp/rotom-browser-relay-old-ready-${process.pid}-${Date.now()}.sock`;
	const server = createServer((socket) => {
		socket.setEncoding("utf8"); let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n"); if (newline < 0) break;
				const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line) continue;
				const request = JSON.parse(line);
				const result = { schemaVersion: 1, kind: "rotom-browser-relay-ready", protocolRevision, nonce: request.payload.nonce, capabilities };
				socket.write(`${JSON.stringify({ schemaVersion: 1, kind: "response", id: request.id, sessionId: request.sessionId, generation: request.generation, ok: true, result })}\n`);
			}
		});
	});
	try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("sandbox 禁止 Unix socket listen"); return; } throw error; }
	try {
		await assert.rejects(BrowserRelayClientV1.connect({ sessionId: "session-old-ready", generation: "generation-old-ready", socketPath, timeoutMs: 1_000 }), /版本过旧.*重载/u);
	} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("relay client 请求超时后销毁连接，避免复用卡死队列", async (t) => {
	const socketPath = `/tmp/rotom-browser-relay-timeout-${process.pid}-${Date.now()}.sock`;
	let socketClosed!: () => void;
	const closed = new Promise<void>((resolve) => { socketClosed = resolve; });
	const server = createServer((socket) => {
		socket.setEncoding("utf8"); let buffer = "";
		socket.on("close", () => socketClosed());
		socket.on("data", (chunk) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n"); if (newline < 0) break;
				const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line) continue;
				const request = JSON.parse(line);
				if (request.operation !== "hello") continue;
				const result = { schemaVersion: 1, kind: "rotom-browser-relay-ready", protocolRevision: 17, nonce: request.payload.nonce, capabilities: ["virtualized-frame-scroll", "multi-client-multiplex", "coordinate-click", "interaction-target-state", "page-alert-readback", "targeted-keypress"] };
				socket.write(`${JSON.stringify({ schemaVersion: 1, kind: "response", id: request.id, sessionId: request.sessionId, generation: request.generation, ok: true, result })}\n`);
			}
		});
	});
	try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("sandbox 禁止 Unix socket listen"); return; } throw error; }
	try {
		const client = await BrowserRelayClientV1.connect({ sessionId: "session-timeout", generation: "generation-timeout", socketPath });
		await assert.rejects(client.request("snapshot", {}, { timeoutMs: 30 }), /browser relay snapshot timeout/u);
		assert.equal(client.closed, true);
		await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("relay timeout socket close timeout")), 1_000))]);
		await assert.rejects(client.request("tabs", {}), /browser relay client 已关闭/u);
	} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
