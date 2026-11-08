import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { allowPolicyFor, findPiDependency, findPiDist } from "./browser-test-helpers.ts";

test("browser downloads：列表只回模型安全字段、完成态带 sha256、子 agent 未授权时是 needs-approval", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-browser-downloads-"));
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
	const body = "downloaded fixture body\n";
	const filePath = join(workspace, "Downloads", "rotom", "run_a", "fixture.txt");
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, body);
	const expectedSha = createHash("sha256").update(body).digest("hex");
	let blocked: unknown[] = [];
	let listing: (url: string) => { id: number; state: string; relativePath: string; bytes: number; mimeType: string; path: string }[] = () => [];
	const relay = {
		get closed() { return false; },
		close() {},
		get leaseToken() { return undefined; },
		get keepTabs() { return false; },
		rootSessionId: "root-session",
		get socketPath() { return join(workspace, "relay.sock"); },
		async request(operation: string) {
			if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [] };
			if (operation === "downloads") return { schemaVersion: 1, kind: "rotom-browser-downloads", agentId: "run_a", downloads: listing("run_a"), blocked };
			throw new Error(`unexpected operation ${operation}`);
		},
	};
	listing = () => [
		{ id: 5, state: "complete", relativePath: "rotom/run_a/fixture.txt", bytes: Buffer.byteLength(body), mimeType: "text/plain", path: filePath },
		{ id: 4, state: "complete", relativePath: "rotom/run_a/big.bin", bytes: 70 * 1024 * 1024, mimeType: "application/octet-stream", path: join(workspace, "missing.bin") },
		{ id: 3, state: "in_progress", relativePath: "rotom/run_a/partial.bin", bytes: 12, mimeType: "application/octet-stream", path: join(workspace, "partial.bin") },
	];
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
	const ctx: any = { cwd: workspace, sessionManager: session, mode: "print", hasUI: true, ui: { notify() {}, setStatus() {}, async confirm() { return true; }, async select() { return "允许一次"; }, theme: { fg: (_color: string, value: string) => value } } };
	try {
		for (const handler of browser.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
		const tool = browser.tools.get("browser_inspect")?.definition;
		assert.ok(tool);
		const listed = await tool.execute("downloads-ok", { operation: "downloads" }, undefined, undefined, ctx);
		assert.equal(listed.details.kind, "rotom-browser-downloads");
		const complete = listed.details.downloads.find((entry: any) => entry.relativePath.endsWith("fixture.txt"));
		assert.equal(complete.sha256, expectedSha, "完成态必须给出真实摘要");
		assert.equal(complete.bytes, Buffer.byteLength(body));
		const big = listed.details.downloads.find((entry: any) => entry.relativePath.endsWith("big.bin"));
		assert.equal(big.sha256, null, "超过上限不读文件");
		assert.equal(big.sha256Skipped, "too-large");
		const partial = listed.details.downloads.find((entry: any) => entry.relativePath.endsWith("partial.bin"));
		assert.equal(partial.sha256, null);
		assert.equal(partial.sha256Skipped, undefined, "未完成的下载不标 skipped");
		assert.equal(JSON.stringify(listed.details).includes(workspace), false, "模型可见结果里不得出现绝对路径");
		await assert.rejects(tool.execute("downloads-tab", { operation: "downloads", tabName: "docs" }, undefined, undefined, ctx), /不接受 tabName/u);
		await assert.rejects(tool.execute("downloads-cursor", { operation: "downloads", cursor: "abc" }, undefined, undefined, ctx), /cursor 仅允许/u);
		blocked = [{ reason: "download" }];
		const refused = await tool.execute("downloads-blocked", { operation: "downloads" }, undefined, undefined, ctx);
		assert.equal(refused.details.kind, "needs-approval");
		assert.equal(refused.details.capability, "download");
		assert.match(refused.content.map((part: any) => part.text ?? "").join(" "), /allow\.download/u);
	} finally {
		for (const handler of browser.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, {});
		await rm(workspace, { recursive: true, force: true });
	}
});

// A tiny but real trace: one 120 ms main-thread task and one layout shift.
const TRACE_FIXTURE = Buffer.from(JSON.stringify({ traceEvents: [
	{ name: "RunTask", dur: 120_000, args: { data: { url: "https://example.test/app.js" } } },
	{ name: "LayoutShift", args: { data: { score: 0.07 } } },
	{ name: "EvaluateScript", dur: 30_000, args: { data: { url: "https://example.test/app.js", lineNumber: 4 } } },
] }));

// 1x1 PNG: real image bytes, so the export path is proven with a decodable file.
const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
