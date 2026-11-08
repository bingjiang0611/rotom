import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { allowPolicyFor, findPiDependency, findPiDist } from "./browser-test-helpers.ts";

test("browser batch：逐步派发、单步 audit、原地停下且不重放", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-browser-batch-"));
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
	const interactPayloads: Array<Record<string, unknown>> = [];
	const observation = (generation: number) => ({ schemaVersion: 1, kind: "rotom-browser-observation", tabName: "form", tabId: 41, documentGeneration: generation, observationEpoch: 3, url: "https://example.test/form", status: "complete", contentCoverage: "rendered-dom", contentComplete: false, nodes: [], digest: `form-${generation}` });
	const relay = {
		get closed() { return false; },
		close() {},
		get leaseToken() { return undefined; },
		get keepTabs() { return false; },
		get socketPath() { return join(workspace, "relay.sock"); },
		async request(operation: string, payload: Record<string, unknown>) {
			if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name: "form", tabId: 41, documentGeneration: 1, url: "https://example.test/form", title: "form", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: true }] };
			if (operation !== "interact") throw new Error(`unexpected operation ${operation}`);
			interactPayloads.push(payload);
			// The third step navigates: that must stop the batch.
			const navigated = interactPayloads.length === 3;
			const expectation = payload.expect === undefined ? undefined : { outcome: payload.expect === "checked=true" ? "unmet" : "met" };
			return {
				schemaVersion: 1,
				kind: "rotom-browser-interaction-result",
				tabName: "form",
				actionId: payload.actionId,
				action: payload.action,
				acknowledged: true,
				effect: { dispatch: "mouse", target: { changed: true }, ...(expectation ? { expectation } : {}) },
				readback: observation(navigated ? 2 : 1),
			};
		},
	};
	const browser = await loadExtensionFromFactory(createBrowserRelayExtensionV1({
		async connectRelay() { return relay; },
		openArtifactStore: async () => (await import("./browser-relay.ts")).BrowserArtifactStoreV1.open(),
	}), workspace, undefined, loaded.runtime, join(process.cwd(), "rotom/extensions/browser"));
	const session = SessionManager.inMemory(workspace);
	const audits: any[] = [];
	loaded.runtime.appendEntry = (type: string, data: any) => { if (type === "rotom-browser-interaction-audit/v1") audits.push(data); };
	loaded.runtime.getAllTools = () => [];
	loaded.runtime.getCommands = () => [];
	loaded.runtime.refreshTools = () => {};
	const ctx: any = { cwd: workspace, sessionManager: session, mode: "print", hasUI: true, ui: { notify() {}, setStatus() {}, async confirm() { return true; }, async select() { return "允许一次"; }, theme: { fg: (_color: string, value: string) => value } } };
	try {
		await new Promise((resolve) => setImmediate(resolve));
		for (const handler of browser.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
		const interact = browser.tools.get("browser_interact")?.definition;
		assert.ok(interact);
		// Each step gets its own intent+terminal audit; the batch itself does not add one.
		const done = await interact.execute("batch-1", { operation: "execute", tabName: "form", actions: [{ action: "click", targetRef: "ax_1_1" }, { action: "type", targetRef: "ax_1_2", text: "hi" }] }, undefined, undefined, ctx);
		assert.equal(done.details.kind, "browser-batch-result");
		assert.equal(done.details.completed, true);
		assert.equal(interactPayloads.length, 2);
		assert.equal(audits.filter((entry) => entry.kind === "rotom-browser-interaction-intent").length, 2);
		assert.equal(audits.filter((entry) => entry.kind === "rotom-browser-interaction-terminal" && entry.status === "ok").length, 2);
		assert.notEqual(interactPayloads[0].actionId, interactPayloads[1].actionId, "每一步是独立的动作");
		// An unmet expect stops before the next step is dispatched.
		interactPayloads.length = 0;
		const unmet = await interact.execute("batch-2", { operation: "execute", tabName: "form", actions: [{ action: "click", targetRef: "ax_1_1", expect: "checked=true" }, { action: "click", targetRef: "ax_1_2" }] }, undefined, undefined, ctx);
		assert.equal(unmet.details.stopReason, "expect-unmet");
		assert.equal(unmet.details.stoppedAt, 0);
		assert.equal(interactPayloads.length, 1, "第一步之后不再派发");
		// A navigation between steps stops the batch as well.
		interactPayloads.length = 0;
		const navigated = await interact.execute("batch-3", { operation: "execute", tabName: "form", actions: [{ action: "click", targetRef: "ax_1_1" }, { action: "click", targetRef: "ax_1_2" }, { action: "click", targetRef: "ax_1_3" }, { action: "click", targetRef: "ax_1_4" }] }, undefined, undefined, ctx);
		assert.equal(navigated.details.stopReason, "navigation");
		assert.equal(navigated.details.stoppedAt, 2);
		assert.equal(interactPayloads.length, 3, "导航之后的那一步不再派发");
	} finally {
		for (const handler of browser.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, ctx);
		await rm(workspace, { recursive: true, force: true });
	}
});
