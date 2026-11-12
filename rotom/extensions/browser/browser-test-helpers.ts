import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

export function findPiDist(): string {
	for (const directory of (process.env.PATH ?? "").split(":")) {
		const candidate = join(directory, "pi");
		if (existsSync(candidate)) return dirname(realpathSync(candidate));
	}
	throw new Error("测试环境 PATH 中找不到 pi");
}

export function findPiDependency(piDist: string, relativePath: string): string {
	let directory = piDist;
	for (;;) {
		const candidate = join(directory, "node_modules", relativePath);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(directory);
		if (parent === directory) throw new Error(`无法从 Pi dist 解析依赖：${relativePath}`);
		directory = parent;
	}
}

export async function allowPolicyFor(workspace: string, origins: string[] = ["https://example.test"]) {
	const { writeBrowserPolicyV1, BROWSER_POLICY_PATH_ENV_V1 } = await import("./browser-policy.ts");
	const path = join(workspace, "rotom", "browser-policy.json");
	await writeBrowserPolicyV1({ blocklist: [], allowlist: origins.map((origin) => ({ origin, capabilities: ["read", "interact", "upload", "devtools"] })) }, path);
	process.env[BROWSER_POLICY_PATH_ENV_V1] = path;
	return path;
}

export async function createBrowserIntegrationFixture() {
	const workspace = await mkdtemp(join(tmpdir(), "pi-browser-extension-"));
	const piDist = findPiDist();
	const loaderUrl = pathToFileURL(join(piDist, "core/extensions/loader.js")).href;
	const sessionUrl = pathToFileURL(join(piDist, "core/session-manager.js")).href;
	const [{ loadExtensions, loadExtensionFromFactory }, { SessionManager }] = await Promise.all([import(loaderUrl), import(sessionUrl)]);
	const { createJiti } = await import(pathToFileURL(findPiDependency(piDist, "jiti/lib/jiti.mjs")).href);
	const jiti = createJiti(loaderUrl, { moduleCache: false, alias: {
		// Same view Pi's extension loader gives extensions: pi-ai plus the TypeBox builders (Pi 1.5+).
		"@earendil-works/pi-ai": join(piDist, "core/extensions/pi-ai-extension-view.js"),
		"@earendil-works/pi-coding-agent": join(piDist, "index.js"),
	} });
	const { createBrowserRelayExtensionV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/index.ts")) as any;
	await allowPolicyFor(workspace, ["https://example.test", "https://signed-in.example.test"]);
	const loaded = await loadExtensions([], workspace);
	assert.deepEqual(loaded.errors, []);
	const calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
	const tabs = new Map<string, { tabId: number; url: string; documentGeneration: number; current: boolean; browserActive: boolean; ownership: "agent" | "claimed"; relayAttached: boolean }>();
	let closed = false;
	const state: { interactFailure?: string; readbackEpoch: number; body: string; textChunks: number; visibleTruncated: boolean; queryReceipt: string } = {
		readbackEpoch: 8,
		body: "Unchanged body. ".repeat(55),
		textChunks: 12,
		visibleTruncated: false,
		queryReceipt: "valid",
	};
	const originalBody = state.body;
	const relay = {
		get closed() { return closed; },
		close() { closed = true; },
		async request(operation: string, payload: Record<string, unknown>) {
			calls.push({ operation, payload });
			if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [...tabs.entries()].map(([name, tab]) => ({ name, ...tab, title: "password=must-not-reach-model", status: "complete" })) };
			if (operation === "recover") {
				const name = String(payload.tabName); const tab = tabs.get(name); assert.ok(tab);
				return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name, ...tab, title: "", status: "complete" }] };
			}
			if (operation === "open") {
				for (const tab of tabs.values()) tab.current = false;
				const tab = { tabId: 41, url: String(payload.url), documentGeneration: 1, current: true, browserActive: false, ownership: "agent" as const, relayAttached: true };
				tabs.set(String(payload.tabName), tab);
				return { schemaVersion: 1, kind: "rotom-browser-observation", tabName: payload.tabName, ...tab, observationEpoch: 1, title: "safe title", status: "complete", nodes: [{ ref: "ax_1_1", role: "textbox", name: "Authorization: Bearer secret-token", states: [] }, { ref: "ax_1_2", role: "button", name: "Save draft", states: [] }], truncated: false, contentCoverage: "rendered-dom", contentComplete: false };
			}
			if (operation === "discover") return { schemaVersion: 1, kind: "rotom-browser-discovered-tabs", tabs: [{ tabId: 77, url: "https://signed-in.example.test/account?token=secret", title: `password=fixture-${"x".repeat(1_200)}`, status: "complete", browserActive: true }] };
			if (operation === "claim") {
				for (const tab of tabs.values()) tab.current = false;
				const tab = { tabId: Number(payload.tabId), url: "https://signed-in.example.test/account?token=secret", documentGeneration: 1, current: true, browserActive: true, ownership: "claimed" as const, relayAttached: true };
				tabs.set(String(payload.tabName), tab);
				return { schemaVersion: 1, kind: "rotom-browser-observation", tabName: payload.tabName, ...tab, observationEpoch: 1, title: "Signed in", status: "complete", nodes: [], truncated: false, contentCoverage: "rendered-dom", contentComplete: false };
			}
			if (operation === "handoff") { const name = String(payload.tabName); const tab = tabs.get(name); tabs.delete(name); return { schemaVersion: 1, kind: "rotom-browser-handoff", tabName: name, tabId: tab?.tabId, preserved: tab?.ownership === "claimed" }; }
			if (operation === "snapshot" || operation === "switch" || operation === "wait" || operation === "read_full") {
				const name = String(payload.tabName ?? [...tabs.keys()][0]); const tab = tabs.get(name); assert.ok(tab);
				const nodes = operation === "read_full"
					? Array.from({ length: 269 }, (_, index) => ({ ref: `txt_1_full_${index + 1}`, role: "document-text", name: `Document body ${index + 1} ${"x".repeat(80)}`, states: ["read-only=true"] }))
					: operation === "snapshot"
						? Array.from({ length: 40 }, (_, index) => ({ ref: index < 30 ? `ax_1_${index + 1}` : `txt_1_${index + 1}`, role: index < 30 ? "row" : "document-text", name: `${index < 30 ? "Wiki navigation" : "Visible body"} ${index + 1}`, states: [] }))
						: [{ ref: "ax_1_1", role: "heading", name: "visible", states: [] }];
				const filtered = operation === "snapshot" && (payload.text !== undefined || payload.role !== undefined);
				const selected = filtered ? nodes.filter((node) => (payload.role === undefined || node.role === payload.role) && (payload.text === undefined || node.name.toLowerCase().includes(String(payload.text).toLowerCase()))) : nodes;
				const selection = filtered && state.queryReceipt !== "missing" ? { ...(payload.text === undefined ? {} : { text: state.queryReceipt === "mismatch" ? "wrong query" : payload.text }), ...(payload.role === undefined ? {} : { role: payload.role }), sourceNodes: nodes.length, scannedAxNodes: 30, scanTruncated: state.visibleTruncated, matchesTruncated: false } : undefined;
				return { schemaVersion: 1, kind: "rotom-browser-observation", tabName: name, ...tab, observationEpoch: 2, title: "safe", status: "complete", nodes: selected, ...(selection ? { selection } : {}), truncated: operation === "snapshot" && state.visibleTruncated, contentCoverage: operation === "read_full" ? "scroll-end" : "rendered-dom", contentComplete: operation === "read_full", ...(operation === "read_full" ? { scanSteps: 7, scannedContainers: 1, scrolledContainers: 1 } : {}) };
			}
			if (operation === "screenshot") return { schemaVersion: 1, kind: "rotom-browser-screenshot", tabName: payload.tabName, tabId: 41, documentGeneration: 1, observationEpoch: 7, viewport: { width: 1280, height: 800, pageX: 0, pageY: 0, scale: 1 }, mimeType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64") };
			if (operation === "interact") {
				const name = String(payload.tabName); const tab = tabs.get(name); assert.ok(tab);
				if (state.interactFailure) { const failure = state.interactFailure; state.interactFailure = undefined; throw new Error(failure); }
				const targetEffect = payload.action === "scroll" || payload.x !== undefined ? {} : { target: { observed: true, changed: true, transitions: ["valueLength=0→43"] }, ...(payload.expect ? { expectation: { requested: payload.expect, outcome: payload.expect === "value=nonempty" ? "met" : "unmet" } } : {}) };
				return { schemaVersion: 1, kind: "rotom-browser-interaction-result", actionId: payload.actionId, action: payload.action, acknowledged: true, effect: { ...(payload.action === "scroll" ? { dispatch: "mouseWheel", moved: true, scrollScope: payload.targetRef ? "nearest" : "document" } : payload.x !== undefined ? { dispatch: "mouse", coordinate: true, observationEpoch: payload.observationEpoch, hitTested: true } : payload.action === "keypress" ? { dispatch: "keyboard", key: payload.key, ...(Array.isArray(payload.modifiers) && payload.modifiers.length > 0 ? { modifiers: payload.modifiers } : {}) } : { dispatch: "mouse" }), ...targetEffect }, readback: { schemaVersion: 1, kind: "rotom-browser-observation", tabName: name, ...tab, observationEpoch: state.readbackEpoch++, title: "password: fixture-readback", status: "complete", nodes: [{ ref: "alert_1_r_1", role: "page-alert", name: "手机号格式不正确，请填写 11 位数字", states: ["read-only=true"] }, { ref: "ax_1_2", role: "status", name: "Draft saved", states: [] }, ...Array.from({ length: state.textChunks }, (_, i) => ({ ref: `txt_1_r_${i + 1}`, role: "document-text", name: `${i}: ${state.body}`, states: ["read-only=true"] }))], truncated: false, contentCoverage: "rendered-dom", contentComplete: false } };
			}
			if (operation === "close") { tabs.clear(); return { schemaVersion: 1, kind: "rotom-browser-close", closed: 1 }; }
			throw new Error(`unexpected operation ${operation}`);
		},
	};
	const browser = await loadExtensionFromFactory(createBrowserRelayExtensionV1({
		async connectRelay() { closed = false; return relay; },
		openArtifactStore: async () => (await import("./browser-relay.ts")).BrowserArtifactStoreV1.open(),
	}), workspace, undefined, loaded.runtime, join(process.cwd(), "rotom/extensions/browser"));
	const session = SessionManager.inMemory(workspace);
	session.appendMessage({ role: "user", content: [{ type: "text", text: "inspect" }], timestamp: Date.now() });
	loaded.runtime.appendEntry = (customType: string, data: unknown) => session.appendCustomEntry(customType, data);
	let activeTools = ["browser_inspect", "browser_interact"];
	loaded.runtime.getActiveTools = () => [...activeTools];
	loaded.runtime.setActiveTools = (value: string[]) => { activeTools = [...value]; };
	loaded.runtime.getAllTools = () => [];
	loaded.runtime.getCommands = () => [];
	loaded.runtime.refreshTools = () => {};
	let confirms = 0;
	const ctx: any = { cwd: workspace, sessionManager: session, mode: "print", hasUI: false, ui: { notify() {}, setStatus() {}, async confirm() { confirms += 1; return true; }, theme: { fg: (_color: string, value: string) => value } } };
	for (const handler of browser.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
	const tool = browser.tools.get("browser_inspect")?.definition;
	assert.ok(tool);
	const interact = browser.tools.get("browser_interact")?.definition;
	assert.ok(interact);
	const bashRouteGuard = browser.handlers.get("tool_call")?.[0];
	assert.ok(bashRouteGuard);
	return { workspace, browser, session, ctx, tool, interact, bashRouteGuard, calls, tabs, get confirms() { return confirms; }, state, originalBody, cleanup: async () => {
		for (const handler of browser.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, ctx);
		await rm(workspace, { recursive: true, force: true });
	} };
}
