import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { allowPolicyFor, findPiDependency, findPiDist } from "./browser-test-helpers.ts";

test("browser lease：子 agent 只继承 capability，父 agent 的 read 不会变成 interact", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-browser-lease-capability-"));
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
	// No allowlist: every site here needs the user's answer, exactly like a claimed user tab.
	await allowPolicyFor(workspace, []);
	const origin = "https://bank.test";
	let childLeaseToken: string | undefined;
	const interacts: Array<Record<string, unknown>> = [];
	const observation = (generation: number) => ({ schemaVersion: 1, kind: "rotom-browser-observation", tabName: "account", tabId: 71, documentGeneration: generation, observationEpoch: 1, url: `${origin}/account`, title: "account", status: "complete", contentCoverage: "rendered-dom", contentComplete: false, nodes: [{ ref: "ax_1_1", role: "button", name: "Transfer", states: [] }], digest: `bank-${generation}` });
	const relay = {
		get closed() { return false; },
		close() {},
		get leaseToken() { return childLeaseToken; },
		get keepTabs() { return false; },
		rootSessionId: "root-session",
		get socketPath() { return join(workspace, "relay.sock"); },
		async request(operation: string, payload: Record<string, unknown>) {
			if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name: "account", tabId: 71, documentGeneration: 1, url: `${origin}/account`, title: "account", status: "complete", current: true, browserActive: false, ownership: "claimed", relayAttached: true }] };
			if (operation === "snapshot") return observation(1);
			if (operation === "interact") {
				interacts.push({ ...payload });
				return { schemaVersion: 1, kind: "rotom-browser-interaction-result", tabName: "account", actionId: payload.actionId, action: payload.action, acknowledged: true, effect: { dispatch: "mouse" }, readback: observation(2) };
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
	const answering = (answer: string) => ({ cwd: workspace, sessionManager: session, mode: "print", hasUI: true, ui: { notify() {}, setStatus() {}, async confirm() { return true; }, async select() { return answer; }, theme: { fg: (_color: string, value: string) => value } } }) as any;
	try {
		await new Promise((resolve) => setImmediate(resolve));
		for (const handler of browser.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, answering("拒绝"));
		const inspect = browser.tools.get("browser_inspect")?.definition;
		const interact = browser.tools.get("browser_interact")?.definition;
		assert.ok(inspect && interact);

		// 1. The parent has only read the claimed user tab, so that is all it publishes.
		const read = await inspect.execute("lease-read", { operation: "snapshot_visible", tabName: "account" }, undefined, undefined, answering("本会话允许"));
		assert.equal(read.details.kind, "observation");
		// The scope is published on the next call, which is when a child would inherit it.
		await inspect.execute("lease-tabs", { operation: "tabs" }, undefined, undefined, answering("本会话允许"));
		const published = JSON.parse(process.env.ROTOM_BROWSER_LEASE_SCOPE ?? "{}");
		assert.deepEqual(published.origins, [{ origin, capabilities: ["read"] }], `父的 read 授权只发布 read：${JSON.stringify(published.origins)}`);

		// 2. A child inherits that file, so its click is refused locally and never dispatched.
		childLeaseToken = "lease-child";
		const denied = await interact.execute("lease-child-click", { operation: "execute", tabName: "account", action: "click", targetRef: "ax_1_1" }, undefined, undefined, answering("本会话允许"));
		assert.equal(denied.details.kind, "needs-approval");
		assert.equal(denied.details.capability, "interact", "拒绝必须报这次操作需要的 capability");
		assert.equal(denied.details.reason, "capability", "origin 在 lease 里，但 capability 不在");
		assert.equal(interacts.length, 0, "被拒绝的写操作不得发到 relay");

		// 3. Full access for the parent does not widen an already issued child lease.
		childLeaseToken = undefined;
		const clicked = await interact.execute("lease-parent-click", { operation: "execute", tabName: "account", action: "click", targetRef: "ax_1_1" }, undefined, undefined, answering("总是允许"));
		assert.equal(clicked.details.kind, "browser-interaction-result");
		assert.equal(interacts.length, 1);
		const childFile = JSON.parse(await readFile(join(workspace, "leases", "lease-child.json"), "utf8"));
		assert.deepEqual(childFile.origins, [{ origin, capabilities: ["read"] }]);
		childLeaseToken = "lease-child";
		const stillDenied = await interact.execute("lease-child-click-2", { operation: "execute", tabName: "account", action: "click", targetRef: "ax_1_1" }, undefined, undefined, answering("本会话允许"));
		assert.equal(stillDenied.details.reason, "capability");
		assert.equal(interacts.length, 1);
		// Only an explicit lease update authorizes the child; it is re-read on each call.
		await writeFile(join(workspace, "leases", "lease-child.json"), JSON.stringify({ ...childFile, origins: [{ origin, capabilities: ["read", "interact"] }] }), { mode: 0o600 });
		const allowed = await interact.execute("lease-child-click-3", { operation: "execute", tabName: "account", action: "click", targetRef: "ax_1_1" }, undefined, undefined, answering("拒绝"));
		assert.equal(allowed.details.kind, "browser-interaction-result");
		assert.equal(interacts.length, 2);
	} finally {
		for (const handler of browser.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, {});
		await rm(workspace, { recursive: true, force: true });
	}
});
