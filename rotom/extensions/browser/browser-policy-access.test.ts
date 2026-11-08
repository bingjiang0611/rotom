import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { allowPolicyFor, findPiDependency, findPiDist } from "./browser-test-helpers.ts";

test("browser policy：默认完全访问、不询问也不写授权，保留 blocklist 与子 lease 范围", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-browser-policy-"));
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
	const { writeBrowserPolicyV1, readBrowserPolicyV1, BROWSER_POLICY_PATH_ENV_V1 } = await import("./browser-policy.ts");
	const policyPath = await allowPolicyFor(workspace, []);
	// The lease scope is process-wide, so start from no scope at all: this test is about
	// what the parent publishes, not what an earlier test left behind.
	const inheritedScope = process.env.ROTOM_BROWSER_LEASE_SCOPE;
	delete process.env.ROTOM_BROWSER_LEASE_SCOPE;
	const opened: string[] = [];
	// The same extension serves the parent and its children, so the lease token is what
	// decides which side of the policy gate runs.
	let childLeaseToken: string | undefined;
	const relay = {
		get closed() { return false; },
		close() {},
		get leaseToken() { return childLeaseToken; },
		get keepTabs() { return false; },
		rootSessionId: "root-session",
		get socketPath() { return join(workspace, "relay.sock"); },
		async request(operation: string, payload: Record<string, unknown>) {
			if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name: "site", tabId: 51, documentGeneration: 1, url: "https://allowed.test/page", title: "site", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: true }] };
			if (operation === "open") { opened.push(String(payload.url)); return { schemaVersion: 1, kind: "rotom-browser-observation", tabName: "site", tabId: 51, documentGeneration: 1, observationEpoch: 1, url: String(payload.url), status: "complete", contentCoverage: "rendered-dom", contentComplete: false, nodes: [], digest: "open-digest" }; }
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
	const choices: string[] = [];
	const selecting = (hasUI = true, answer = "允许一次") => ({ cwd: workspace, sessionManager: session, mode: "print", hasUI, ui: { notify() {}, setStatus() {}, async confirm() { return true; }, async select() { choices.push(answer); return answer; }, theme: { fg: (_color: string, value: string) => value } } });
	try {
		await new Promise((resolve) => setImmediate(resolve));
		for (const handler of browser.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx0());
		function ctx0() { return { cwd: workspace, sessionManager: session, mode: "print", hasUI: false, ui: { notify() {}, setStatus() {}, async confirm() { return true; }, theme: { fg: (_color: string, value: string) => value } } }; }
		const tool = browser.tools.get("browser_inspect")?.definition;
		assert.ok(tool);

		// blocklist 先于一切：即使有 UI 也不询问，直接拒绝且不派发。
		await writeBrowserPolicyV1({ blocklist: ["https://blocked.test"], allowlist: [] }, policyPath);
		const blocked = await tool.execute("policy-blocked", { operation: "open", tabName: "site", url: "https://blocked.test/x" }, undefined, undefined, selecting(true));
		assert.equal(blocked.details.kind, "needs-approval");
		assert.equal(blocked.details.reason, "blocklist");
		assert.equal(blocked.details.capability, "interact");
		assert.equal(opened.length, 0, "被 blocklist 拒绝的 open 不得派发");
		assert.equal(choices.length, 0, "blocklist 不需要询问");

		// 新网站无需 UI 或预先保存授权，也不修改策略文件。
		const noUi = await tool.execute("policy-no-ui", { operation: "open", tabName: "site", url: "https://unknown.test/x" }, undefined, undefined, ctx0());
		assert.equal(noUi.details.kind, "observation");
		assert.equal(opened.length, 1);
		const again = await tool.execute("policy-again", { operation: "open", tabName: "site", url: "https://unknown.test/y" }, undefined, undefined, selecting(true, "拒绝"));
		assert.equal(again.details.kind, "observation");
		assert.equal(choices.length, 0, "完全访问不调用授权 UI");
		assert.deepEqual((await readBrowserPolicyV1(policyPath)).allowlist, [], "不需要持久化逐站授权");

		// 只发布实际操作过的 origin+capability，不把所有网站交给子 agent。
		await tool.execute("policy-tabs", { operation: "tabs" }, undefined, undefined, ctx0());
		const published = JSON.parse(process.env.ROTOM_BROWSER_LEASE_SCOPE ?? "{}");
		assert.equal(published.rootSessionId, "root-session");
		assert.deepEqual(published.origins, [{ origin: "https://unknown.test", capabilities: ["interact"] }]);
		assert.equal(published.origins.some((entry: { origin: string }) => entry.origin === "https://allowed.test"), false, "仅列出的 tab 不进入子 lease");

		// 父 agent 访问新站点不能自动扩大已运行子 agent 的 lease。
		const leases = join(workspace, "leases");
		await mkdir(leases, { recursive: true, mode: 0o700 });
		const childFile = join(leases, "child.json");
		const childLease = { schemaVersion: 1, kind: "rotom-browser-lease", token: "child", agentId: "child", rootSessionId: "root-session", origins: [{ origin: "https://allowed.test", capabilities: ["interact"] }], allow: { devtools: false, upload: false, download: false }, maxTabs: 2, keepTabs: false, expiresAt: Date.now() + 60_000 };
		await writeFile(childFile, JSON.stringify(childLease), { mode: 0o600 });
		await tool.execute("policy-second", { operation: "open", tabName: "site", url: "https://second.test/x" }, undefined, undefined, ctx0());
		assert.deepEqual(JSON.parse(await readFile(childFile, "utf8")), childLease, "已有子 lease 保持不变");

		// 并发调用也无需弹窗，不等待用户回答。
		const settled = await Promise.all([
			tool.execute("policy-race-1", { operation: "open", tabName: "site", url: "https://race.test/a" }, undefined, undefined, selecting(true)),
			tool.execute("policy-race-2", { operation: "open", tabName: "site", url: "https://race.test/b" }, undefined, undefined, selecting(true)),
		]);
		assert.deepEqual(settled.map((result) => result.details.kind), ["observation", "observation"]);
		assert.equal(choices.length, 0);

		// A child's authorization is its lease, but the user's blocklist still applies: a
		// lease that names an origin cannot overrule a refused site.
		const blockedPolicy = { blocklist: ["https://allowed.test"], allowlist: [{ origin: "https://allowed.test", capabilities: ["interact", "read"] }] };
		await writeBrowserPolicyV1(blockedPolicy, policyPath);
		childLeaseToken = "child";
		const openedBefore = opened.length;
		const choicesBeforeChild = choices.length;
		const childBlocked = await tool.execute("policy-child-blocklist", { operation: "open", tabName: "site", url: "https://allowed.test/x" }, undefined, undefined, selecting(true, "本会话允许"));
		assert.equal(childBlocked.details.kind, "needs-approval");
		assert.equal(childBlocked.details.reason, "blocklist", "子 agent 也不得绕过用户 blocklist");
		assert.equal(opened.length, openedBefore, "blocklist 拒绝的子 agent 请求不得派发");
		assert.equal(choices.length, choicesBeforeChild, "子 agent 不产生询问");
		const childOutside = await tool.execute("policy-child-outside", { operation: "open", tabName: "site", url: "https://outside.test/x" }, undefined, undefined, ctx0());
		assert.equal(childOutside.details.kind, "needs-approval");
		assert.equal(childOutside.details.reason, "origin");
		assert.equal(opened.length, openedBefore, "完全访问不绕过子 lease");

		childLeaseToken = undefined;
		await writeFile(policyPath, "{invalid json", { mode: 0o600 });
		const invalid = await tool.execute("policy-invalid", { operation: "open", tabName: "site", url: "https://unknown.test/x" }, undefined, undefined, ctx0());
		assert.equal(invalid.details.reason, "invalid-policy");
		assert.equal(opened.length, openedBefore, "损坏策略不能静默忽略 blocklist");
	} finally {
		if (inheritedScope === undefined) delete process.env.ROTOM_BROWSER_LEASE_SCOPE; else process.env.ROTOM_BROWSER_LEASE_SCOPE = inheritedScope;
		for (const handler of browser.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, {});
		await rm(workspace, { recursive: true, force: true });
	}
});
