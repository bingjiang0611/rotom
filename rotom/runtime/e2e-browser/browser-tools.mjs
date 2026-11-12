// Load the real browser tools over a real relay socket.
//
// The product gate for a child lease lives in the tool layer, not in the extension
// or the native host, so a suite that only drives BrowserRelayClientV1 can never
// observe it. This helper boots the extension the same way index.test.ts does,
// but connects to the harness's Chrome instead of a fake relay.

import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const here = dirname(new URL(import.meta.url).pathname);

function findPiDist() {
	const product = resolve(here, "../pi/node_modules/@earendil-works/pi-coding-agent/dist");
	if (existsSync(join(product, "index.js"))) return product;
	for (const directory of (process.env.PATH ?? "").split(":")) {
		const candidate = join(directory, "pi");
		if (existsSync(candidate)) return dirname(realpathSync(candidate));
	}
	throw new Error("无法解析已安装的 Pi dist；lease 套件需要 rotom/runtime/pi 或 PATH 中的 pi");
}

function findPiDependency(piDist, relativePath) {
	let directory = piDist;
	for (;;) {
		const candidate = join(directory, "node_modules", relativePath);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(directory);
		if (parent === directory) throw new Error(`无法从 Pi dist 解析依赖：${relativePath}`);
		directory = parent;
	}
}

/**
 * @param {object} input
 * @param {string} input.socketPath   the harness relay socket
 * @param {string} [input.workspace]  temp workspace for the artifact store
 * @returns {Promise<{ inspect: any, interact: any, calls: string[], shutdown: () => Promise<void> }>}
 */
export async function loadBrowserTools({ socketPath, workspace }) {
	const root = workspace ?? await mkdtemp(join(tmpdir(), "rotom-e2e-tools-"));
	await mkdir(root, { recursive: true });
	const piDist = findPiDist();
	const [{ loadExtensions, loadExtensionFromFactory }, { SessionManager }] = await Promise.all([
		import(pathToFileURL(join(piDist, "core/extensions/loader.js")).href),
		import(pathToFileURL(join(piDist, "core/session-manager.js")).href),
	]);
	const { createJiti } = await import(pathToFileURL(findPiDependency(piDist, "jiti/lib/jiti.mjs")).href);
	const jiti = createJiti(pathToFileURL(join(piDist, "core/extensions/loader.js")).href, { moduleCache: false, alias: {
		// Same view Pi's extension loader gives extensions: pi-ai plus the TypeBox builders (Pi 1.5+).
		"@earendil-works/pi-ai": join(piDist, "core/extensions/pi-ai-extension-view.js"),
		"@earendil-works/pi-coding-agent": join(piDist, "index.js"),
	} });
	const extensionDir = resolve(here, "../../extensions/browser");
	const [{ createBrowserRelayExtensionV1 }, { BrowserRelayClientV1, BrowserArtifactStoreV1 }] = await Promise.all([
		jiti.import(join(extensionDir, "index.ts")),
		jiti.import(join(extensionDir, "browser-relay.ts")),
	]);
	const loaded = await loadExtensions([], root);
	if (loaded.errors.length > 0) throw new Error(`加载 Pi 扩展失败：${loaded.errors.map((error) => error.message ?? error).join("; ")}`);
	const calls = [];
	const clients = new Set();
	const extension = await loadExtensionFromFactory(createBrowserRelayExtensionV1({
		async connectRelay({ sessionId }) {
			const client = await BrowserRelayClientV1.connect({ sessionId, socketPath, timeoutMs: 10_000 });
			clients.add(client);
			return client;
		},
		openArtifactStore: async () => BrowserArtifactStoreV1.open(),
	}), root, undefined, loaded.runtime, extensionDir);
	loaded.runtime.appendEntry = () => {};
	loaded.runtime.getAllTools = () => [];
	loaded.runtime.getCommands = () => [];
	loaded.runtime.refreshTools = () => {};
	const session = SessionManager.inMemory(root);
	session.appendMessage({ role: "user", content: [{ type: "text", text: "lease" }], timestamp: Date.now() });
	const ctx = { cwd: root, sessionManager: session, mode: "print", hasUI: false, ui: { notify() {}, setStatus() {}, async confirm() { return true; }, theme: { fg: (_color, value) => value } } };
	for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
	const wrap = (tool) => async (params, signal) => {
		calls.push(String(params.operation));
		return tool.execute(`e2e-${params.operation}`, params, signal, undefined, ctx);
	};
	return {
		inspect: wrap(extension.tools.get("browser_inspect").definition),
		interact: wrap(extension.tools.get("browser_interact").definition),
		calls,
		async shutdown() {
			for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, ctx);
			for (const client of clients) { try { client.close(); } catch { /* already closed */ } }
			if (!workspace) await rm(root, { recursive: true, force: true });
		},
	};
}
