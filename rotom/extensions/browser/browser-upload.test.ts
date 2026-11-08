import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { allowPolicyFor, findPiDependency, findPiDist } from "./browser-test-helpers.ts";

test("browser_interact upload：路径先本地校验，拒绝的路径不派发，放行时只传绝对路径", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-browser-upload-"));
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
	const payloads: Array<Record<string, unknown>> = [];
	const relay = {
		get closed() { return false; },
		close() {},
		get leaseToken() { return undefined; },
		get keepTabs() { return false; },
		get socketPath() { return join(workspace, "relay.sock"); },
		async request(operation: string, payload: Record<string, unknown>) {
			if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name: "form", tabId: 21, documentGeneration: 1, url: "https://example.test/form", title: "form", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: true }] };
			if (operation === "interact") {
				payloads.push(payload);
				const readback = { schemaVersion: 1, kind: "rotom-browser-observation", tabName: "form", tabId: 21, documentGeneration: 1, observationEpoch: 1, url: "https://example.test/form", status: "complete", contentCoverage: "rendered-dom", contentComplete: false, nodes: [], digest: "form-digest" };
				return { schemaVersion: 1, kind: "rotom-browser-interaction-result", tabName: "form", actionId: payload.actionId, action: payload.action, acknowledged: true, readback, effect: { dispatch: "files", files: (payload.paths as string[]).length, focusVerified: false } };
			}
			throw new Error(`unexpected operation ${operation}`);
		},
	};
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
		await new Promise((resolve) => setImmediate(resolve));
		for (const handler of browser.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
		const interact = browser.tools.get("browser_interact")?.definition;
		assert.ok(interact);
		const allowed = join(workspace, "payload.txt");
		await writeFile(allowed, "payload\n");
		const secret = join(workspace, ".env");
		await writeFile(secret, "SECRET=1\n");
		// Parameter combinations and path rules are decided before the relay is asked.
		for (const params of [
			{ operation: "execute", tabName: "form", action: "click", targetRef: "ax_1_1", paths: [allowed] },
			{ operation: "execute", tabName: "form", action: "upload", paths: [allowed] },
			{ operation: "execute", tabName: "form", action: "upload", targetRef: "ax_1_1", paths: [] },
			{ operation: "execute", tabName: "form", action: "upload", targetRef: "ax_1_1", paths: [secret] },
			{ operation: "execute", tabName: "form", action: "upload", targetRef: "ax_1_1", paths: ["relative.txt"] },
			{ operation: "execute", tabName: "form", action: "upload", targetRef: "ax_1_1", paths: [allowed], text: "nope" },
		]) await assert.rejects(interact.execute("upload-invalid", params, undefined, undefined, ctx));
		assert.equal(payloads.length, 0, "被拒绝的 upload 不得派发");
		const uploaded = await interact.execute("upload-ok", { operation: "execute", tabName: "form", action: "upload", targetRef: "ax_1_1", paths: [allowed] }, undefined, undefined, ctx);
		assert.equal(uploaded.details.effect.dispatch, "files");
		assert.deepEqual(payloads.at(-1)?.paths, [allowed]);
		assert.equal(JSON.stringify(uploaded.details).includes(workspace), false, "结果不得回显本地目录");
	} finally {
		for (const handler of browser.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, ctx);
		await rm(workspace, { recursive: true, force: true });
	}
});
