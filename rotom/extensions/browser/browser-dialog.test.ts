import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { allowPolicyFor, findPiDependency, findPiDist } from "./browser-test-helpers.ts";

test("browser dialog：弹窗期间的拒绝原样返回，dialog 动作只下发 accept/promptText", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-browser-dialog-"));
	const piDist = findPiDist();
	const loaderUrl = pathToFileURL(join(piDist, "core/extensions/loader.js")).href;
	const [{ loadExtensions, loadExtensionFromFactory }, { SessionManager }] = await Promise.all([
		import(loaderUrl),
		import(pathToFileURL(join(piDist, "core/session-manager.js")).href),
	]);
	const { createJiti } = await import(pathToFileURL(findPiDependency(piDist, "jiti/lib/jiti.mjs")).href);
	const jiti = createJiti(loaderUrl, { moduleCache: false, alias: {
		// Same view Pi's extension loader gives extensions: pi-ai plus the TypeBox builders (Pi 1.5+).
		"@earendil-works/pi-ai": join(piDist, "core/extensions/pi-ai-extension-view.js"),
		"@earendil-works/pi-coding-agent": join(piDist, "index.js"),
	} });
	const { createBrowserRelayExtensionV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/index.ts")) as any;
	await allowPolicyFor(workspace);
	const loaded = await loadExtensions([], workspace);
	const interactPayloads: Array<Record<string, unknown>> = [];
	const observation = { schemaVersion: 1, kind: "rotom-browser-observation", tabName: "dialog", tabId: 31, documentGeneration: 1, observationEpoch: 2, url: "https://example.test/dialog", status: "complete", contentCoverage: "rendered-dom", contentComplete: false, nodes: [], digest: "dialog-digest" };
	const blocked = { schemaVersion: 1, kind: "dialog-blocking", tabName: "dialog", dialog: { tabId: 31, type: "beforeunload", message: "unsaved changes", sensitive: true, openedAt: 1_700_000_000_000 } };
	const relay = {
		get closed() { return false; },
		close() {},
		get leaseToken() { return undefined; },
		get keepTabs() { return false; },
		get socketPath() { return join(workspace, "relay.sock"); },
		async request(operation: string, payload: Record<string, unknown>) {
			if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name: "dialog", tabId: 31, documentGeneration: 1, url: "https://example.test/dialog", title: "dialog", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: true, dialog: blocked.dialog }] };
			// Every read of a suspended tab answers with the refusal, like the relay does.
			if (operation === "snapshot" || operation === "read_full" || operation === "navigate") return blocked;
			if (operation === "interact") {
				interactPayloads.push(payload);
				if (payload.action !== "dialog") return blocked;
				return { schemaVersion: 1, kind: "rotom-browser-interaction-result", tabName: "dialog", actionId: payload.actionId, action: "dialog", acknowledged: true, readback: observation, effect: { dispatch: "handleJavaScriptDialog", accept: payload.accept === true, sensitive: true } };
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
		const inspect = browser.tools.get("browser_inspect")?.definition;
		const interact = browser.tools.get("browser_interact")?.definition;
		assert.ok(inspect && interact);
		// Reads of a suspended tab return the refusal instead of a schema error.
		for (const params of [{ operation: "snapshot_visible", tabName: "dialog" }, { operation: "read_full", tabName: "dialog" }]) {
			const result = await inspect.execute("dialog-read", params, undefined, undefined, ctx);
			assert.equal(result.details.kind, "dialog-blocking", JSON.stringify(result.details).slice(0, 200));
			assert.equal(result.details.dialog.type, "beforeunload");
			assert.equal(result.details.dialog.sensitive, true);
			assert.match(result.content[0].text, /beforeunload/u);
		}
		const moved = await inspect.execute("dialog-navigate", { operation: "navigate", tabName: "dialog", url: "https://example.test/next" }, undefined, undefined, ctx);
		assert.equal(moved.details.kind, "dialog-blocking");
		// Writes are refused before anything is dispatched, and the refusal is structured.
		const clicked = await interact.execute("dialog-click", { operation: "execute", tabName: "dialog", action: "click", targetRef: "ax_1_1" }, undefined, undefined, ctx);
		assert.equal(clicked.details.kind, "dialog-blocking");
		assert.equal(clicked.details.dialog.message, "unsaved changes");
		// The dialog action itself is allowed through, and carries only its own parameters.
		for (const params of [
			{ operation: "execute", tabName: "dialog", action: "dialog" },
			{ operation: "execute", tabName: "dialog", action: "dialog", accept: false, promptText: "x" },
			{ operation: "execute", tabName: "dialog", action: "dialog", accept: true, targetRef: "ax_1_1" },
			{ operation: "execute", tabName: "dialog", action: "click", targetRef: "ax_1_1", accept: true },
			{ operation: "execute", tabName: "dialog", action: "dialog", accept: true, promptText: "x".repeat(501) },
		]) await assert.rejects(interact.execute("dialog-invalid", params, undefined, undefined, ctx));
		const accepted = await interact.execute("dialog-accept", { operation: "execute", tabName: "dialog", action: "dialog", accept: true, promptText: "answer" }, undefined, undefined, ctx);
		assert.equal(accepted.details.effect.accept, true);
		assert.equal(accepted.details.effect.dispatch, "handleJavaScriptDialog");
		const last = interactPayloads.at(-1)!;
		assert.equal(last.accept, true);
		assert.equal(last.promptText, "answer");
		assert.equal(last.targetRef, undefined, "dialog 不带 ref");
		assert.equal(last.paths, undefined);
	} finally {
		for (const handler of browser.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, ctx);
		await rm(workspace, { recursive: true, force: true });
	}
});
