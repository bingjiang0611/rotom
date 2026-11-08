import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findPiDependency, findPiDist } from "./browser-test-helpers.ts";

test("Relay-first launch gate: local evidence, one attempt, no replay or stale permission", async (t) => {
	const piDist = findPiDist();
	const loaderUrl = pathToFileURL(join(piDist, "core/extensions/loader.js")).href;
	const { createJiti } = await import(pathToFileURL(findPiDependency(piDist, "jiti/lib/jiti.mjs")).href);
	const jiti = createJiti(loaderUrl, { alias: {
		"@earendil-works/pi-ai": findPiDependency(piDist, "@earendil-works/pi-ai/dist/index.js"),
		"@earendil-works/pi-coding-agent": join(piDist, "index.js"),
	} });
	const { createBrowserRelayExtensionV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/index.ts")) as any;
	const { BrowserRelayUnavailableErrorV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/browser-relay.ts")) as any;
	const unavailable = () => new BrowserRelayUnavailableErrorV1(new Error("fixture missing socket"));
	async function fixture() {
		const tools = new Map<string, any>(), handlers = new Map<string, any>();
		const notices: string[] = [];
		let connectError: Error | undefined, requestError: Error | undefined;
		let delay: Promise<any> | undefined;
		const connectEntered = Promise.withResolvers<void>();
		let active = ["browser_inspect", "browser_interact", "launch_browser"];
		let requests = 0, connections = 0;
		const relay = { closed: false, close() { this.closed = true; }, async request() {
			requests += 1;
			if (requestError) throw requestError;
			return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [] };
		} };
		createBrowserRelayExtensionV1({
			async connectRelay() { connections += 1; if (delay) { connectEntered.resolve(); return delay; } if (connectError) throw connectError; relay.closed = false; return relay; },
			async openArtifactStore() { throw new Error("unexpected artifact store"); },
		})({ registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, on(name: string, handler: any) { handlers.set(name, handler); }, appendEntry() {}, getActiveTools() { return active; } });
		// `select` answers "允许一次": these tests are about fallback routing, and the policy
		// gate must not turn their request errors into local refusals.
		const ctx: any = { sessionManager: { getSessionId: () => "fixture-session", getBranch: () => [] }, hasUI: true, ui: { notify(message: string) { notices.push(message); }, async select() { return "允许一次"; } } };
		await handlers.get("session_start")({}, ctx);
		return {
			ctx, notices, relay, connectEntered: connectEntered.promise, get requests() { return requests; }, get connections() { return connections; },
			failConnect(error?: Error) { connectError = error; relay.closed = true; },
			failRequest(error: Error) { requestError = error; },
			delayConnect(value: Promise<any>) { delay = value; },
			select(value: string[]) { active = value; },
			emit: (name: string) => handlers.get(name)({}, ctx),
			launch: () => handlers.get("tool_call")({ toolName: "launch_browser", input: {} }, ctx),
			inspect: (params = { operation: "tabs" }, signal?: AbortSignal) => tools.get("browser_inspect").execute("fixture", params, signal, undefined, ctx),
			interact: (params: any) => tools.get("browser_interact").execute("fixture", params, undefined, undefined, ctx),
		};
	}
	await t.test("blocks launch first, healthy Relay and empty tabs", async () => {
		const f = await fixture();
		assert.equal((await f.launch()).block, true);
		await f.inspect();
		assert.equal((await f.launch()).block, true);
		assert.equal(f.notices.length, 0);
	});
	await t.test("typed unavailable permits one launch, never an implicit spawn or second attempt", async () => {
		const f = await fixture(); f.failConnect(unavailable());
		await assert.rejects(f.inspect(), /未派发.*launch_browser.*不继承 Chrome 登录态/u);
		assert.equal(f.requests, 0);
		assert.equal(f.notices.length, 0);
		assert.equal(await f.launch(), undefined);
		assert.match(f.notices[0], /不继承 Chrome 登录态/u);
		assert.match((await f.launch()).reason, /launch_browser 已尝试.*不可重试/u);
		await assert.rejects(f.inspect(), /launch_browser 已尝试.*不可重试/u);
		assert.equal((await f.launch()).block, true, "another failed probe cannot authorize a retry of an unknown launch");
	});
	for (const message of ["browser relay 不可用", "browser relay hello timeout", "debugger is not attached", "stale ref", "permission denied", "browser relay 版本过旧", "response binding 无效", "Sign in to continue"]) {
		await t.test(`untyped error is not authority: ${message}`, async () => {
			const f = await fixture(); f.failConnect(new Error(message));
			await assert.rejects(f.inspect()); assert.equal((await f.launch()).block, true);
		});
	}
	await t.test("request failure followed by unavailable reconnect cannot unlock fallback", async () => {
		const f = await fixture(); f.failRequest(new Error("browser relay open timeout; unknown"));
		await assert.rejects(f.inspect({ operation: "open", tabName: "docs", url: "https://example.test" } as any));
		f.failConnect(unavailable());
		await assert.rejects(f.inspect(), /本次运行已派发 Relay 请求.*禁止.*回退/u);
		assert.match((await f.launch()).reason, /本次运行已派发 Relay 请求.*禁止.*回退/u);
	});
	await t.test("invalid open input is rejected before connecting and cannot authorize fallback", async () => {
		for (const [params, expected] of [
			[{ operation: "open", tabName: "local", url: "file:///tmp/mockup.html" }, /http\/https.*本地 HTTP/u],
			[{ operation: "open", url: "https://example.test" }, /open 需要 tabName/u],
		] as const) {
			const f = await fixture(); f.failConnect(unavailable());
			await assert.rejects(f.inspect(params as any), expected);
			assert.equal(f.connections, 0);
			assert.equal(f.requests, 0);
			assert.equal((await f.launch()).block, true);
		}
	});
	await t.test("invalid claim and interaction parameters never connect or consume fallback evidence", async () => {
		for (const params of [
			{ operation: "claim", tabId: 41 },
			{ operation: "claim", tabName: "docs" },
			{ operation: "execute", action: "click", targetRef: "ax_1", expect: "visible" },
			{ operation: "execute", action: "click" },
			{ operation: "execute", action: "type", targetRef: "ax_1" },
			{ operation: "execute", action: "keypress", targetRef: "ax_1", key: "Space" },
			{ operation: "execute", action: "scroll", direction: "sideways" },
			{ operation: "execute", action: "click", targetRef: "ax_1", x: 1, y: 2, observationEpoch: 1 },
			{ operation: "execute" },
		]) {
			const f = await fixture(); f.failConnect(unavailable());
			await assert.rejects(params.operation === "claim" ? f.inspect(params as any) : f.interact(params));
			assert.equal(f.connections, 0, JSON.stringify(params));
			assert.equal(f.requests, 0);
			assert.equal((await f.launch()).block, true);
		}
		const f = await fixture(); f.failConnect(unavailable());
		await assert.rejects(f.inspect()); // Legitimate pre-dispatch unavailability.
		const connections = f.connections;
		await assert.rejects(f.interact({ operation: "execute", action: "click", expect: "navigation" }));
		assert.equal(f.connections, connections);
		assert.equal(await f.launch(), undefined, "local mistakes neither grant nor revoke an existing permit");
	});
	await t.test("successful probe revokes a previous permit", async () => {
		const f = await fixture(); f.failConnect(unavailable()); await assert.rejects(f.inspect());
		f.failConnect(); await f.inspect(); assert.equal((await f.launch()).block, true);
	});
	for (const event of ["before_agent_start", "session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"]) {
		await t.test(`${event} retires permission and late failures`, async () => {
			const f = await fixture(); f.failConnect(unavailable()); await assert.rejects(f.inspect());
			const delayed = Promise.withResolvers<any>(); f.delayConnect(delayed.promise);
			const pending = f.inspect(); const rejected = assert.rejects(pending);
			await f.connectEntered; await f.emit(event); delayed.reject(unavailable()); await rejected;
			assert.equal((await f.launch()).block, true);
		});
	}
	await t.test("cancelled connect and cancelled launch cannot grant permission", async () => {
		const f = await fixture(); const delayed = Promise.withResolvers<any>(); f.delayConnect(delayed.promise);
		const controller = new AbortController(); const pending = f.inspect(undefined, controller.signal); const rejected = assert.rejects(pending);
		await f.connectEntered; controller.abort(); delayed.reject(unavailable()); await rejected;
		assert.equal((await f.launch()).block, true);
		const g = await fixture(); g.failConnect(unavailable()); await assert.rejects(g.inspect());
		g.ctx.signal = AbortSignal.abort(); assert.equal((await g.launch()).block, true);
	});
	await t.test("explicit tool selection is preserved", async () => {
		const f = await fixture(); f.select(["launch_browser"]);
		assert.equal(await f.launch(), undefined);
	});
});
