import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { allowPolicyFor, findPiDependency, findPiDist } from "./browser-test-helpers.ts";

const TRACE_FIXTURE = Buffer.from(JSON.stringify({ traceEvents: [
	{ name: "RunTask", dur: 120_000, args: { data: { url: "https://example.test/app.js" } } },
	{ name: "LayoutShift", args: { data: { score: 0.07 } } },
	{ name: "EvaluateScript", dur: 30_000, args: { data: { url: "https://example.test/app.js", lineNumber: 4 } } },
] }));

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("browser_devtools：默认隔离世界、主 agent 的 main world 无需确认、非法参数本地拒绝", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-browser-devtools-"));
	const piDist = findPiDist();
	const loaderUrl = pathToFileURL(join(piDist, "core/extensions/loader.js")).href;
	const [{ loadExtensions, loadExtensionFromFactory }, { SessionManager }] = await Promise.all([
		import(loaderUrl),
		import(pathToFileURL(join(piDist, "core/session-manager.js")).href),
	]);
	const { createJiti } = await import(pathToFileURL(findPiDependency(piDist, "jiti/lib/jiti.mjs")).href);
	const jiti = createJiti(loaderUrl, { moduleCache: false, alias: {
		"@earendil-works/pi-ai": findPiDependency(piDist, "@earendil-works/pi-ai/dist/index.js"),
		"@earendil-works/pi-coding-agent": join(piDist, "index.js"),
	} });
	const { createBrowserRelayExtensionV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/index.ts")) as any;
	await allowPolicyFor(workspace);
	let dispatched: any[] = [];
	let confirmCalls = 0;
	let confirmAnswer = true;
	let childLeaseToken: string | undefined;
	const relay = {
		get closed() { return false; },
		close() {},
		get leaseToken() { return childLeaseToken; },
		get keepTabs() { return false; },
		rootSessionId: "root-session",
		get socketPath() { return join(workspace, "relay.sock"); },
		async request(operation: string, payload: any) {
			if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name: "code", tabId: 31, documentGeneration: 1, url: "https://example.test/globals", title: "code", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: true }] };
			if (operation === "devtools") {
				dispatched.push(payload);
				if (payload.devtools === "record_stop") return { schemaVersion: 1, kind: "rotom-browser-devtools", devtools: "record_stop", tabName: "code", tabId: 31, documentGeneration: 1, durationMs: 1_000, fps: 2, truncated: true, frames: [{ data: ONE_PIXEL_PNG.toString("base64"), atMs: 0 }, { data: ONE_PIXEL_PNG.toString("base64"), atMs: 500 }] };
				if (payload.devtools === "trace_start") return { schemaVersion: 1, kind: "rotom-browser-devtools", devtools: "trace_start", tabName: "code", tabId: 31, startedAt: new Date(0).toISOString(), categories: ["devtools.timeline"] };
				if (payload.devtools === "trace_stop") return { schemaVersion: 1, kind: "rotom-browser-devtools", devtools: "trace_stop", tabName: "code", tabId: 31, documentGeneration: 1, bytes: TRACE_FIXTURE.length, dataLossOccurred: false, traceBase64: TRACE_FIXTURE.toString("base64") };
				if (payload.devtools === "network_body") return { schemaVersion: 1, kind: "rotom-browser-devtools", devtools: "network_body", tabName: "code", tabId: 31, documentGeneration: 1, requestId: payload.requestId, url: "https://example.test/json", status: 200, mimeType: "application/json", resourceType: "Fetch", bodyText: "{\"message\":\"rotom-json-fixture\"}", truncated: false, bytes: 30, captureSince: new Date(0).toISOString(), note: "only requests issued after network_body was first enabled can be read" };
				if (payload.devtools === "screenshot_export") return { schemaVersion: 1, kind: "rotom-browser-devtools", devtools: "screenshot_export", tabName: "code", tabId: 31, documentGeneration: 1, format: payload.format, fullPage: payload.fullPage === true, bytes: ONE_PIXEL_PNG.length, data: ONE_PIXEL_PNG.toString("base64") };
				return payload.devtools === "viewport"
					? { schemaVersion: 1, kind: "rotom-browser-devtools", devtools: "viewport", tabName: "code", tabId: 31, documentGeneration: 1, observationEpoch: 2, reset: false, viewport: { width: 900, height: 700, deviceScaleFactor: 1, mobile: false, touch: false } }
					: { schemaVersion: 1, kind: "rotom-browser-devtools", devtools: "evaluate", tabName: "code", tabId: 31, documentGeneration: 1, world: payload.world ?? "isolated", threw: false, type: "string", valueText: "\"ok\"", truncated: false, bytes: 4 };
			}
			throw new Error(`unexpected operation ${operation}`);
		},
	};
	const loaded = await loadExtensions([], workspace);
	const browser = await loadExtensionFromFactory(createBrowserRelayExtensionV1({
		async connectRelay() { return relay; },
		openArtifactStore: async () => (await import("./browser-relay.ts")).BrowserArtifactStoreV1.open(),
	}), workspace, undefined, loaded.runtime, join(process.cwd(), "rotom/extensions/browser"));
	const session = SessionManager.inMemory(workspace);
	loaded.runtime.appendEntry = () => {};
	loaded.runtime.getAllTools = () => [];
	loaded.runtime.getCommands = () => [];
	loaded.runtime.refreshTools = () => {};
	const ctx: any = { cwd: workspace, sessionManager: session, mode: "print", hasUI: true, ui: { notify() {}, setStatus() {}, async confirm() { confirmCalls += 1; return confirmAnswer; }, async select() { return "允许一次"; }, theme: { fg: (_color: string, value: string) => value } } };
	try {
		for (const handler of browser.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
		const tool = browser.tools.get("browser_devtools")?.definition;
		assert.ok(tool, "browser_devtools 必须注册");
		// 隔离世界是默认，不能顺手问用户，也不能悄悄进主世界。
		const isolated = await tool.execute("devtools-isolated", { operation: "evaluate", expression: "1 + 1" }, undefined, undefined, ctx);
		assert.equal(dispatched.at(-1).world, "isolated");
		assert.equal(dispatched.at(-1).expression, "1 + 1");
		assert.equal(confirmCalls, 0, "隔离世界不需要确认");
		assert.equal(isolated.details.valueText, "\"ok\"");

		const main = await tool.execute("devtools-main", { operation: "evaluate", expression: "window.rotomPageSecret", world: "main" }, undefined, undefined, ctx);
		assert.equal(confirmCalls, 0, "主 agent 的主世界不需要确认");
		assert.equal(dispatched.at(-1).world, "main");
		assert.equal(main.details.world, "main");

		confirmAnswer = false;
		const noPrompt = await tool.execute("devtools-no-prompt", { operation: "evaluate", expression: "document.cookie", world: "main" }, undefined, undefined, ctx);
		assert.equal(noPrompt.details.world, "main");
		assert.equal(confirmCalls, 0, "不能调用确认 UI");

		const noUi = await tool.execute("devtools-noui", { operation: "evaluate", expression: "1", world: "main" }, undefined, undefined, { ...ctx, hasUI: false, ui: { notify() {}, setStatus() {} } });
		assert.equal(noUi.details.world, "main");
		assert.equal(dispatched.at(-1).world, "main");

		await mkdir(join(workspace, "leases"), { mode: 0o700 });
		await writeFile(join(workspace, "leases", "devtools-child.json"), JSON.stringify({ schemaVersion: 1, kind: "rotom-browser-lease", token: "devtools-child", agentId: "child", rootSessionId: "root-session", origins: [{ origin: "https://example.test", capabilities: ["devtools"] }], allow: { devtools: true, upload: false, download: false }, maxTabs: 2, keepTabs: false, expiresAt: Date.now() + 60_000 }), { mode: 0o600 });
		childLeaseToken = "devtools-child";
		const beforeChild = dispatched.length;
		const childMain = await tool.execute("devtools-child-main", { operation: "evaluate", expression: "1", world: "main" }, undefined, undefined, ctx);
		assert.equal(childMain.details.reason, "main-world");
		assert.equal(dispatched.length, beforeChild, "完全访问不允许子 agent 进入主世界");
		const childIsolated = await tool.execute("devtools-child-isolated", { operation: "evaluate", expression: "1" }, undefined, undefined, ctx);
		assert.equal(childIsolated.details.world, "isolated");
		childLeaseToken = undefined;

		const viewport = await tool.execute("devtools-viewport", { operation: "viewport", viewport: "desktop-1440" }, undefined, undefined, ctx);
		assert.equal(dispatched.at(-1).devtools, "viewport");
		assert.deepEqual(dispatched.at(-1).viewport, { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, touch: false });
		assert.equal(viewport.details.devtools, "viewport");

		// 截图导出：字节真的落盘，模型只拿相对路径。
		await mkdir(join(workspace, "shots"), { recursive: true });
		const exported = await tool.execute("devtools-export", { operation: "screenshot_export", path: "shots/shot.png", fullPage: true }, undefined, undefined, ctx);
		assert.equal(exported.details.kind, "browser-export");
		assert.equal(exported.details.relativePath, join("shots", "shot.png"));
		assert.equal(exported.details.bytes, ONE_PIXEL_PNG.length);
		assert.equal(exported.details.format, "png");
		assert.equal(exported.details.fullPage, true);
		assert.equal(exported.details.overwrote, false);
		assert.equal(JSON.stringify(exported.details).includes(workspace), false, "模型可见结果里不得出现绝对路径");
		assert.deepEqual(await readFile(join(workspace, "shots", "shot.png")), ONE_PIXEL_PNG, "落盘内容必须与 relay 字节一致");
		assert.equal(dispatched.at(-1).format, "png");
		assert.equal(dispatched.at(-1).fullPage, true);

		// 覆盖已有普通文件要如实标记。
		const overwritten = await tool.execute("devtools-export-again", { operation: "screenshot_export", path: "shots/shot.png" }, undefined, undefined, ctx);
		assert.equal(overwritten.details.overwrote, true);
		await assert.rejects(tool.execute("devtools-export-outside", { operation: "screenshot_export", path: "../escape.png" }, undefined, undefined, ctx), /项目目录/u);
		await assert.rejects(tool.execute("devtools-export-mismatch", { operation: "screenshot_export", path: "shots/shot.png", format: "jpeg" }, undefined, undefined, ctx), /format/u);
		await assert.rejects(tool.execute("devtools-export-format", { operation: "screenshot_export", path: "shots/shot.png", format: "webp" }, undefined, undefined, ctx), /format/u);
		await symlink(join(workspace, "shots", "shot.png"), join(workspace, "shots", "link.png"));
		await assert.rejects(tool.execute("devtools-export-link", { operation: "screenshot_export", path: "shots/link.png" }, undefined, undefined, ctx), /符号链接/u);

		// 响应体读取按 requestId 走，别的操作不接受这个字段。
		const body = await tool.execute("devtools-body", { operation: "network_body", requestId: "1000.2" }, undefined, undefined, ctx);
		assert.equal(body.details.devtools, "network_body");
		assert.equal(dispatched.at(-1).requestId, "1000.2");
		assert.match(body.details.bodyText, /rotom-json-fixture/u);
		await assert.rejects(tool.execute("devtools-body-missing", { operation: "network_body" }, undefined, undefined, ctx), /requestId/u);
		await assert.rejects(tool.execute("devtools-body-mixed", { operation: "evaluate", expression: "1", requestId: "1000.2" }, undefined, undefined, ctx), /只用于 network_body/u);

		// trace：完整文件落盘，模型拿摘要。
		const traceStarted = await tool.execute("devtools-trace-start", { operation: "trace_start" }, undefined, undefined, ctx);
		assert.equal(traceStarted.details.devtools, "trace_start");
		const traceStopped = await tool.execute("devtools-trace-stop", { operation: "trace_stop" }, undefined, undefined, ctx);
		assert.equal(traceStopped.details.kind, "browser-trace");
		assert.equal(traceStopped.details.bytes, TRACE_FIXTURE.length);
		assert.equal(traceStopped.details.longTasks, 1);
		assert.equal(traceStopped.details.cls, 0.07);
		assert.equal(traceStopped.details.slowestScripts[0].line, 5);
		assert.ok(traceStopped.details.path.startsWith(join(tmpdir(), "rotom-traces")), traceStopped.details.path);
		assert.deepEqual(await readFile(traceStopped.details.path), TRACE_FIXTURE, "trace 文件必须与 relay 字节一致");
		await assert.rejects(tool.execute("devtools-trace-mixed", { operation: "trace_start", expression: "1" }, undefined, undefined, ctx), /expression\/world/u);

		// 录制：帧与合成 GIF 都落在私有临时目录。
		const recording = await tool.execute("devtools-record", { operation: "record_stop" }, undefined, undefined, ctx);
		assert.equal(recording.details.kind, "browser-recording");
		assert.equal(recording.details.frames, 2);
		assert.equal(recording.details.width, 1, "1x1 的帧不会被放大");
		assert.equal(recording.details.height, 1);
		assert.equal(recording.details.truncated, true, "relay 标了 truncated 就要如实透传");
		const gifBytes = await readFile(recording.details.gifPath);
		assert.equal(gifBytes.subarray(0, 6).toString("ascii"), "GIF89a");
		assert.equal(gifBytes.length, recording.details.gifBytes);
		assert.equal(recording.details.gifPath.startsWith(join(tmpdir(), "rotom-recordings")), true);
		assert.deepEqual(await readFile(join(recording.details.directory, "frame-000.png")), ONE_PIXEL_PNG);
		await assert.rejects(tool.execute("devtools-record-mixed", { operation: "record_start", requestId: "x" }, undefined, undefined, ctx), /只用于 network_body/u);

		// 参数在本地就被拒，不产生任何请求。
		const count = dispatched.length;
		await assert.rejects(tool.execute("devtools-empty", { operation: "evaluate", expression: "   " }, undefined, undefined, ctx), /expression/u);
		await assert.rejects(tool.execute("devtools-world", { operation: "evaluate", expression: "1", world: "page" }, undefined, undefined, ctx), /world/u);
		await assert.rejects(tool.execute("devtools-op", { operation: "snapshot" }, undefined, undefined, ctx), /operation/u);
		await assert.rejects(tool.execute("devtools-preset", { operation: "viewport", viewport: "iphone-99" }, undefined, undefined, ctx), /viewport/u);
		await assert.rejects(tool.execute("devtools-mixed", { operation: "viewport", viewport: "reset", expression: "1" }, undefined, undefined, ctx), /evaluate 参数/u);
		assert.equal(dispatched.length, count, "非法参数不得派发");
	} finally {
		for (const handler of browser.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, {});
		await rm(workspace, { recursive: true, force: true });
	}
});
