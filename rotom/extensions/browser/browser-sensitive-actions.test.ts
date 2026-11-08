import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { allowPolicyFor, findPiDependency, findPiDist } from "./browser-test-helpers.ts";

test("browser 敏感动作：主 agent 无需确认、只派发一次、unknown 不重放，子 agent 仍受限", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-browser-confirm-"));
	const piDist = findPiDist();
	const loaderUrl = pathToFileURL(join(piDist, "core/extensions/loader.js")).href;
	const [{ loadExtensions, loadExtensionFromFactory }, { SessionManager }] = await Promise.all([
		import(loaderUrl),
		import(pathToFileURL(join(piDist, "core/session-manager.js")).href),
	]);
	const { createJiti } = await import(pathToFileURL(findPiDependency(piDist, "jiti/lib/jiti.mjs")).href);
	const jiti = createJiti(loaderUrl, { moduleCache: false, alias: {
		"@earendil-works/pi-ai": findPiDependency(piDist, "@earendil-works/pi-ai/dist/index.js"),
		"@earendil-works/pii-coding-agent": join(piDist, "index.js"),
		"@earendil-works/pi-coding-agent": join(piDist, "index.js"),
	} });
	const { createBrowserRelayExtensionV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/index.ts")) as any;
	const policyPath = await allowPolicyFor(workspace);
	const origin = "https://example.test";
	const dispatchLedger: Array<Record<string, unknown>> = [];
	const relays: Array<Record<string, unknown>> = [];
	const makeRelay = (leaseToken: string | undefined) => {
		let closed = false;
		return {
			get closed() { return closed; },
			close() { closed = true; },
			get leaseToken() { return leaseToken; },
			get keepTabs() { return false; },
			rootSessionId: "root-session",
			get socketPath() { return join(workspace, "relay.sock"); },
			async request(operation: string, payload: Record<string, unknown>) {
				if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name: "shop", tabId: 61, documentGeneration: 1, url: `${origin}/checkout`, title: "checkout", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: true }] };
				if (operation === "interact") {
					relays.push({ ...payload });
					// The relay refuses a sensitive target until the caller confirms it.
					if (payload.confirmed !== true) return { schemaVersion: 1, kind: "needs-confirmation", tabName: "shop", origin, capability: "interact", reason: "sensitive-name", matchedWord: "submit" };
					dispatchLedger.push({ ...payload });
					return { schemaVersion: 1, kind: "rotom-browser-interaction-result", actionId: payload.actionId, action: payload.action, acknowledged: true, effect: { dispatch: "mouse" }, readback: { schemaVersion: 1, kind: "rotom-browser-observation", tabName: "shop", tabId: 61, documentGeneration: 1, observationEpoch: 3, url: `${origin}/checkout`, title: "checkout", status: "complete", nodes: [], truncated: false, contentCoverage: "rendered-dom", contentComplete: false, digest: "confirm-digest" } };
				}
				throw new Error(`unexpected operation ${operation}`);
			},
		};
	};
	let activeRelay = makeRelay(undefined);
	// Switching relays must close the live one: the extension caches a connection and only
	// reconnects after it is closed.
	const switchRelay = (next: Record<string, unknown>) => { (activeRelay as any).close(); activeRelay = next; };
	const loaded = await loadExtensions([], workspace);
	const browser = await loadExtensionFromFactory(createBrowserRelayExtensionV1({
		async connectRelay() { return activeRelay; },
		openArtifactStore: async () => (await import("./browser-relay.ts")).BrowserArtifactStoreV1.open(),
	}), workspace, undefined, loaded.runtime, join(process.cwd(), "rotom/extensions/browser"));
	const session = SessionManager.inMemory(workspace);
	const entries: Array<{ customType: string; data: any }> = [];
	loaded.runtime.appendEntry = (customType: string, data: unknown) => { entries.push({ customType, data }); session.appendCustomEntry(customType, data); };
	loaded.runtime.getAllTools = () => [];
	loaded.runtime.getCommands = () => [];
	loaded.runtime.refreshTools = () => {};
	const confirmations: Array<{ title: string; message?: string }> = [];
	const ui = (hasUI: boolean, answer: boolean) => ({ cwd: workspace, sessionManager: session, mode: "print", hasUI, ui: { notify() {}, setStatus() {}, async confirm(title: string, message?: string) { confirmations.push({ title, message }); return answer; }, async select() { return "允许一次"; }, theme: { fg: (_color: string, value: string) => value } } });
	const savedConfirm = process.env.ROTOM_BROWSER_CONFIRM;
	try {
		for (const handler of browser.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ui(false, true));
		const interact = browser.tools.get("browser_interact")?.definition;
		assert.ok(interact);
		delete process.env.ROTOM_BROWSER_CONFIRM;

		// Relay 先拒绝且未派发，再自动批准同一动作；不调用用户确认。
		const approved = await interact.execute("confirm-full-access", { operation: "execute", tabName: "shop", action: "click", targetRef: "ax_1_1" }, undefined, undefined, ui(true, false));
		assert.equal(approved.details.kind, "browser-interaction-result", JSON.stringify(approved.details));
		assert.equal(relays.length, 2);
		assert.equal(relays[0].confirmed, undefined);
		assert.equal(relays[1].confirmed, true);
		assert.equal(relays[0].actionId, relays[1].actionId, "批准的是同一个未派发动作");
		assert.equal(dispatchLedger.length, 1);
		assert.equal(confirmations.length, 0);
		const terminal = entries.filter((entry) => entry.data?.kind === "rotom-browser-interaction-terminal").at(-1);
		assert.equal(terminal?.data.confirmation, "auto-full-access", "不能伪称用户确认");

		const noUi = await interact.execute("confirm-no-ui", { operation: "execute", tabName: "shop", action: "click", targetRef: "ax_1_1" }, undefined, undefined, ui(false, false));
		assert.equal(noUi.details.kind, "browser-interaction-result");
		assert.equal(dispatchLedger.length, 2);
		assert.equal(confirmations.length, 0, "无 UI 同样可执行");

		// 子 agent 上报给父 agent，不能自行确认敏感动作。
		switchRelay(makeRelay("child-lease"));
		const child = await interact.execute("confirm-child", { operation: "execute", tabName: "shop", action: "click", targetRef: "ax_1_1" }, undefined, undefined, ui(true, true));
		assert.equal(child.details.kind, "needs-approval");
		assert.equal(child.details.reason, "sensitive-action");
		assert.equal(confirmations.length, 0);
		assert.equal(dispatchLedger.length, 2);

		// 旧 localhost 开关不再限制主 agent 对远程网站的完全访问。
		switchRelay(makeRelay(undefined));
		process.env.ROTOM_BROWSER_CONFIRM = "auto-approve-localhost";
		const remote = await interact.execute("confirm-remote", { operation: "execute", tabName: "shop", action: "click", targetRef: "ax_1_1" }, undefined, undefined, ui(false, false));
		assert.equal(remote.details.kind, "browser-interaction-result");
		assert.equal(dispatchLedger.length, 3);

		// 上传和 beforeunload 在本地预检时自动批准，第一次就带 confirmed:true。
		delete process.env.ROTOM_BROWSER_CONFIRM;
		const uploadPath = join(workspace, "confirm.txt");
		await writeFile(uploadPath, "confirm payload\n");
		const preflightRequests: Array<Record<string, unknown>> = [];
		const preflightRelay = makeRelay(undefined);
		preflightRelay.request = async (operation: string, payload: Record<string, unknown>) => {
			if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name: "shop", tabId: 61, documentGeneration: 1, url: `${origin}/upload`, title: "upload", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: true, dialog: { tabId: 61, type: "beforeunload", message: "Unsaved", sensitive: true, openedAt: 1_700_000_000_000 } }] };
			if (operation === "interact") {
				preflightRequests.push({ ...payload });
				assert.equal(payload.confirmed, true);
				return { schemaVersion: 1, kind: "rotom-browser-interaction-result", actionId: payload.actionId, action: payload.action, acknowledged: true, readback: { schemaVersion: 1, kind: "rotom-browser-observation", tabName: "shop", tabId: 61, documentGeneration: 1, observationEpoch: 4, url: `${origin}/upload`, title: "upload", status: "complete", nodes: [], truncated: false, contentCoverage: "rendered-dom", contentComplete: false, digest: "preflight-digest" } };
			}
			throw new Error(`unexpected operation ${operation}`);
		};
		switchRelay(preflightRelay);
		for (const params of [
			{ action: "upload", targetRef: "ax_1_1", paths: [uploadPath] },
			{ action: "dialog", accept: true },
		]) {
			const result = await interact.execute("confirm-preflight", { operation: "execute", tabName: "shop", ...params }, undefined, undefined, ui(false, false));
			assert.equal(result.details.kind, "browser-interaction-result", JSON.stringify(result.details));
		}
		assert.equal(preflightRequests.length, 2, "每个预检动作只派发一次");
		assert.deepEqual(preflightRequests[0].paths, [uploadPath]);
		assert.equal(confirmations.length, 0);

		// 超时可能已执行：完全访问不能授权自动重放 unknown 写入。
		const unknownRelay = makeRelay(undefined);
		let unknownRequests = 0;
		unknownRelay.request = async (operation: string) => {
			if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name: "shop", tabId: 61, documentGeneration: 1, url: origin, title: "unknown", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: true }] };
			if (operation === "interact") { unknownRequests += 1; throw new Error("timeout after dispatch"); }
			throw new Error(`unexpected operation ${operation}`);
		};
		switchRelay(unknownRelay);
		await assert.rejects(interact.execute("confirm-unknown", { operation: "execute", tabName: "shop", action: "click", targetRef: "ax_1_1" }, undefined, undefined, ui(false, false)), /unknown.*禁止重发/u);
		assert.equal(unknownRequests, 1);
		const unknownTerminal = entries.filter((entry) => entry.data?.kind === "rotom-browser-interaction-terminal").at(-1);
		assert.equal(unknownTerminal?.data.status, "unknown");
	} finally {
		if (savedConfirm === undefined) delete process.env.ROTOM_BROWSER_CONFIRM;
		else process.env.ROTOM_BROWSER_CONFIRM = savedConfirm;
		for (const handler of browser.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, {});
		await rm(workspace, { recursive: true, force: true });
	}
});
