import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";

async function setup(t: any, dependencies: any) {
	let packageDir = dirname(realpathSync(process.env.ROTOM_PI!)); let pkg: any;
	for (;;) {
		const path = join(packageDir, "package.json");
		if (existsSync(path)) { pkg = JSON.parse(readFileSync(path, "utf8")); if (pkg.name === "@earendil-works/pi-coding-agent") break; }
		const parent = dirname(packageDir); assert.notEqual(parent, packageDir); packageDir = parent;
	}
	const pi = await import(pathToFileURL(join(packageDir, pkg.exports["."].import)).href);
	const root = await mkdtemp(join(tmpdir(), "browser-runtime-ownership-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "workspace"), agentDir = join(root, "agent");
	await mkdir(cwd); await mkdir(agentDir);
	const key = `browser-test-${root}`; const tools = new Map<string, any>(); const contexts: any[] = [];
	(globalThis as any)[key] = { dependencies, tools, contexts };
	t.after(() => { delete (globalThis as any)[key]; });
	const entry = join(root, "fixture.ts");
	await writeFile(entry, `import { createBrowserRelayExtensionV1 } from ${JSON.stringify(resolve(import.meta.dirname, "index.ts"))};\nexport default function(pi) { const fixture = globalThis[${JSON.stringify(key)}]; pi.on("session_start", (_e,ctx)=>fixture.contexts.push(ctx)); createBrowserRelayExtensionV1(fixture.dependencies)(new Proxy(pi,{get(target,key){ if(key === "registerTool") return tool=>{fixture.tools.set(tool.name,tool); target.registerTool(tool);}; const value=target[key]; return typeof value === "function" ? value.bind(target) : value; }})); }`);
	const services = await pi.createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [entry] } });
	const created = await pi.createAgentSessionFromServices({ services, sessionManager: pi.SessionManager.create(cwd, join(root, "sessions")), noTools: "all", sessionStartEvent: { type: "session_start", reason: "startup" } });
	assert.deepEqual(created.extensionsResult.errors, []);
	await created.session.bindExtensions({ mode: "print", onError: (error: unknown) => { throw error; } });
	t.after(async () => { await created.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); created.session.dispose(); });
	return { session: created.session, tools, execute: (name: string, params: any, signal?: AbortSignal) => tools.get(name).execute("fixture", params, signal, undefined, contexts.at(-1)) };
}

const tabs = { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name: "docs", tabId: 1, documentGeneration: 1, url: "https://example.test/", title: "", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: true }] };
const screenshot = { schemaVersion: 1, kind: "rotom-browser-screenshot", mimeType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"), tabName: "docs", tabId: 1, documentGeneration: 1, observationEpoch: 1, viewport: { width: 800, height: 600, pageX: 0, pageY: 0, scale: 1 } };

for (const stage of ["connect", "store-open", "store-write", "interaction"]) test(`Browser public reload fences delayed ${stage}`, { timeout: 30000 }, async (t) => {
	const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<any>();
	let first = true; let closedConnections = 0; let closedStores = 0; let staleRequests = 0;
	const store = () => ({ async close() { closedStores += 1; }, async storeScreenshot() { if (stage === "store-write" && first) { first = false; entered.resolve(); return release.promise; } return {}; } });
	const connection = (stale = false) => ({ closed: false, close() { this.closed = true; closedConnections += 1; }, async request(operation: string) {
		if (stale) staleRequests += 1;
		if (operation === "screenshot") return screenshot;
		if (operation === "interact" && first) { first = false; entered.resolve(); return release.promise; }
		return tabs;
	} });
	const fixture = await setup(t, {
		async connectRelay() { if (stage === "connect" && first) { first = false; entered.resolve(); return release.promise; } return connection(); },
		async openArtifactStore() { if (stage === "store-open" && first) { first = false; entered.resolve(); return release.promise; } return store(); },
	});
	const params = stage === "connect" ? { operation: "tabs" } : stage === "interaction" ? { operation: "execute", action: "click", targetRef: "ax_1_1" } : { operation: "screenshot" };
	const tool = stage === "interaction" ? "browser_interact" : "browser_inspect";
	const pending = fixture.execute(tool, params);
	const rejected = assert.rejects(pending, /owner retired|ctx is stale/u);
	await entered.promise;
	await fixture.session.reload();
	await fixture.execute("browser_inspect", { operation: "tabs" });
	const branchBefore = fixture.session.sessionManager.getBranch().length;
	release.resolve(stage === "connect" ? connection(true) : stage === "store-open" ? store() : {});
	await rejected;
	assert.equal(fixture.session.sessionManager.getBranch().length, branchBefore, "late result cannot append terminal into replacement runtime");
	assert.equal(staleRequests, 0);
	if (stage === "connect") assert.equal(closedConnections, 1);
	if (stage === "store-open" || stage === "store-write") assert.equal(closedStores, 1);
	await fixture.execute("browser_inspect", { operation: "tabs" });
});

test("Browser retiring cleanup captures its store before await (adversarial overlapping tree event)", { timeout: 30000 }, async (t) => {
	const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	const stores: Array<{ closed: boolean; close(): Promise<void>; storeScreenshot(): Promise<object> }> = []; let connections = 0;
	const fixture = await setup(t, {
		async connectRelay() { const index = connections++; return { closed: false, close() { this.closed = true; }, async request(operation: string) { if (operation === "close" && index === 0) { entered.resolve(); await release.promise; } return operation === "screenshot" ? screenshot : tabs; } }; },
		async openArtifactStore() { const store = { closed: false, async close() { this.closed = true; }, async storeScreenshot() { return {}; } }; stores.push(store); return store; },
	});
	await fixture.execute("browser_inspect", { operation: "screenshot" });
	const retiring = fixture.session.extensionRunner.emit({ type: "session_before_tree" }); await entered.promise;
	await fixture.execute("browser_inspect", { operation: "screenshot" });
	assert.equal(stores.length, 2); release.resolve(); await retiring;
	assert.equal(stores[0].closed, true); assert.equal(stores[1].closed, false);
});

test("late snapshot cannot mint a cursor or invalidate a replacement cursor", { timeout: 30000 }, async (t) => {
	const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<any>(); let first = true;
	const observation = { ...tabs.tabs[0], schemaVersion: 1, kind: "rotom-browser-observation", tabName: "docs", observationEpoch: 1, nodes: [{ ref: "ax_1_1", role: "heading", name: "one", states: [] }, { ref: "ax_1_2", role: "heading", name: "two", states: [] }], truncated: false, contentCoverage: "rendered-dom", contentComplete: false };
	const fixture = await setup(t, {
		async connectRelay() { return { closed: false, close() { this.closed = true; }, async request(operation: string) { if (operation === "snapshot") { if (first) { first = false; entered.resolve(); return release.promise; } return observation; } return tabs; } }; },
		async openArtifactStore() { throw new Error("not used"); },
	});
	const old = fixture.execute("browser_inspect", { operation: "snapshot_visible", limit: 1 }); const rejected = assert.rejects(old, /owner retired/u);
	await entered.promise; await fixture.session.reload();
	const current = await fixture.execute("browser_inspect", { operation: "snapshot_visible", limit: 1 }); assert.ok(current.details.nextCursor);
	release.resolve(observation); await rejected;
	const next = await fixture.execute("browser_inspect", { operation: "snapshot_visible", cursor: current.details.nextCursor, limit: 1 });
	assert.equal(next.details.offset, 1); assert.equal(next.details.observation.nodes[0].name, "two");
});

test("abort of an old connect cannot publish or close a newer connection in the same runtime", { timeout: 30000 }, async (t) => {
	const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<any>(); let first = true; let oldClosed = false, newClosed = false;
	const fixture = await setup(t, {
		async connectRelay() { if (first) { first = false; entered.resolve(); return release.promise; } return { closed: false, close() { this.closed = true; newClosed = true; }, async request() { return tabs; } }; },
		async openArtifactStore() { throw new Error("not used"); },
	});
	const controller = new AbortController(); const old = fixture.execute("browser_inspect", { operation: "tabs" }, controller.signal); const rejected = assert.rejects(old, /owner retired/u);
	await entered.promise; controller.abort(); await fixture.execute("browser_inspect", { operation: "tabs" });
	release.resolve({ closed: false, close() { this.closed = true; oldClosed = true; }, async request() { throw new Error("old connect must not dispatch"); } });
	await rejected; assert.equal(oldClosed, true); assert.equal(newClosed, false);
	await fixture.execute("browser_inspect", { operation: "tabs" });
});
