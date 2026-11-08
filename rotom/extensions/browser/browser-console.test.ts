import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { allowPolicyFor, findPiDependency, findPiDist } from "./browser-test-helpers.ts";

test("browser_inspect console：本地拒绝非法过滤，结果按 128 KiB 截断并用 cursor 续读", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-browser-console-"));
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
	const loaded = await loadExtensions([], workspace);
	const calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
	const entries = Array.from({ length: 200 }, (_, index) => ({ seq: index + 1, level: "error", text: `entry ${index + 1} ${"x".repeat(1_500)}`, at: 1_700_000_000_000 + index, source: "console" }));
	let closed = false;
	const relay = {
		get closed() { return closed; },
		close() { closed = true; },
		get leaseToken() { return undefined; },
		get keepTabs() { return false; },
		get socketPath() { return join(workspace, "relay.sock"); },
		async request(operation: string, payload: Record<string, unknown>) {
			calls.push({ operation, payload });
			if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name: "log", tabId: 12, documentGeneration: 1, url: "https://example.test/a?token=secret", title: "log", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: true }] };
			if (operation === "network") {
				if (payload.tabName !== "log") throw new Error("network 需要属于当前 agent 的 tab");
				const leak = String(payload.pattern ?? "") === "leak";
				// Entry-level plumbing is rebuilt from a fixed field list; a top-level leak is
				// rejected. Both are exercised here.
				const entries = [
					{ seq: 1, requestId: "r1", method: "GET", url: "https://example.test/ok", resourceType: "Fetch", status: 200, mimeType: "application/json", fromCache: false, durationMs: 12, at: 1_700_000_000_000, headers: { authorization: "Bearer entry-secret" }, postData: "password=entry-secret" },
					{ seq: 2, requestId: "r2", method: "POST", url: "https://example.test/status-500?token=secret", resourceType: "Fetch", status: 500, durationMs: 31, at: 1_700_000_001_000 },
				];
				return { schemaVersion: 1, kind: "rotom-browser-network", tabName: "log", tabId: 12, captureSince: new Date(1_700_000_000_000).toISOString(), dropped: 2, retained: 2, entries, ...(leak ? { headers: { authorization: "Bearer top-secret" } } : {}) };
			}
			if (operation === "console") {
				const since = Number(String(payload.sinceCursor ?? "c0").slice(1));
				const rest = entries.filter((entry) => entry.seq > since).slice(0, Number(payload.limit ?? 50));
				return { schemaVersion: 1, kind: "rotom-browser-console", tabName: "log", tabId: 12, documentGeneration: 1, captureSince: new Date(1_700_000_000_000).toISOString(), dropped: 7, retained: 200, entries: rest, ...(rest.length === Number(payload.limit ?? 50) ? { nextCursor: `c${rest[rest.length - 1].seq}` } : {}) };
			}
			throw new Error(`unexpected operation ${operation}`);
		},
	};
	const browser = await loadExtensionFromFactory(createBrowserRelayExtensionV1({
		async connectRelay() { closed = false; return relay; },
		openArtifactStore: async () => (await import("./browser-relay.ts")).BrowserArtifactStoreV1.open(),
	}), workspace, undefined, loaded.runtime, join(process.cwd(), "rotom/extensions/browser"));
	const session = SessionManager.inMemory(workspace);
	loaded.runtime.appendEntry = () => {};
	loaded.runtime.getAllTools = () => [];
	loaded.runtime.getCommands = () => [];
	loaded.runtime.refreshTools = () => {};
	const ctx: any = { cwd: workspace, sessionManager: session, mode: "print", hasUI: true, ui: { notify() {}, setStatus() {}, async confirm() { return true; }, async select() { return "允许一次"; }, theme: { fg: (_color: string, value: string) => value } } };
	try {
		await new Promise((resolve) => setImmediate(resolve));
		for (const handler of browser.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
		const tool = browser.tools.get("browser_inspect")?.definition;
		assert.ok(tool);
		// Invalid filters never reach the relay.
		const before = calls.filter((call) => call.operation === "console").length;
		for (const params of [{ operation: "console", level: "debug" }, { operation: "console", pattern: "x".repeat(129) }, { operation: "console", limit: 201 }, { operation: "console", sinceCursor: "42" }, { operation: "tabs", level: "error" }]) {
			await assert.rejects(tool.execute("console-invalid", params, undefined, undefined, ctx));
		}
		assert.equal(calls.filter((call) => call.operation === "console").length, before, "非法参数不得发请求");

		// 200 entries of 1.5 KB cannot fit one 128 KiB result: page it instead.
		const page = await tool.execute("console-page", { operation: "console", tabName: "log", limit: 200 }, undefined, undefined, ctx);
		assert.equal(page.details.kind, "browser-console");
		assert.equal(page.details.dropped, 7);
		assert.ok(page.details.entries.length > 0 && page.details.entries.length < 200, `必须被截断：${page.details.entries.length}`);
		assert.ok(Buffer.byteLength(page.content[0].text, "utf8") <= 128 * 1024);
		assert.equal(typeof page.details.nextCursor, "string");
		assert.equal(JSON.stringify(page.details).includes("token=secret"), false, "console 结果不出带 query 的 URL");

		const next = await tool.execute("console-next", { operation: "console", tabName: "log", sinceCursor: page.details.nextCursor }, undefined, undefined, ctx);
		assert.ok(next.details.entries[0].seq > page.details.entries.at(-1).seq, "cursor 继续而不是重放");

		// network: local filters, metadata mapping, and a hard rejection of leaked headers.
		const networkCalls = () => calls.filter((call) => call.operation === "network").length;
		const networkStart = networkCalls();
		for (const params of [{ operation: "network", resourceType: "fetch" }, { operation: "network", sinceCursor: "c1" }, { operation: "network", level: "error" }, { operation: "network", failedOnly: "yes" }, { operation: "tabs", failedOnly: true }]) {
			await assert.rejects(tool.execute("network-invalid", params, undefined, undefined, ctx));
		}
		assert.equal(networkCalls(), networkStart, "非法参数不得发请求");
		const network = await tool.execute("network-page", { operation: "network", tabName: "log", failedOnly: true }, undefined, undefined, ctx);
		assert.equal(network.details.kind, "browser-network");
		assert.equal(network.details.entries.length, 2);
		assert.equal(network.details.entries[1].status, 500);
		assert.equal(network.details.entries[1].durationMs, 31);
		assert.equal(JSON.stringify(network.details).includes("token=secret"), false, "network 结果不出带 query 的 URL");
		assert.equal(JSON.stringify(network.details).includes("headers"), false, "entry 级 header 必须被丢弃");
		assert.equal(JSON.stringify(network.details).includes("entry-secret"), false);
		await assert.rejects(tool.execute("network-leak", { operation: "network", tabName: "log", pattern: "leak" }, undefined, undefined, ctx), /不得包含 headers/u);
		assert.ok(next.details.entries[0].seq > page.details.entries.at(-1).seq, "cursor 继续而不是重放");
	} finally {
		for (const handler of browser.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, ctx);
		await rm(workspace, { recursive: true, force: true });
	}
});
