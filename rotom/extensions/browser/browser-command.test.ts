import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findPiDependency, findPiDist } from "./browser-test-helpers.ts";

test("/browser: explicit commands, local-only diagnostics, cancellation and ownership", async (t) => {
	const piDist = findPiDist();
	const loaderUrl = pathToFileURL(join(piDist, "core/extensions/loader.js")).href;
	const { createJiti } = await import(pathToFileURL(findPiDependency(piDist, "jiti/lib/jiti.mjs")).href);
	const jiti = createJiti(loaderUrl, { alias: {
		// Same view Pi's extension loader gives extensions: pi-ai plus the TypeBox builders (Pi 1.5+).
		"@earendil-works/pi-ai": join(piDist, "core/extensions/pi-ai-extension-view.js"),
		"@earendil-works/pi-coding-agent": join(piDist, "index.js"),
	} });
	const { createBrowserRelayExtensionV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/index.ts")) as any;
	const { BrowserRelayUnavailableErrorV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/browser-relay.ts")) as any;
	async function fixture(overrides: Record<string, unknown> = {}, realIO = false) {
		const commands = new Map<string, any>(), handlers = new Map<string, any>();
		const notices: string[] = [], messages: Array<{ text: string; options: unknown }> = [], calls: string[] = [];
		let confirmed = false, input: string | undefined;
		let active = ["browser_inspect", "browser_interact"], idle = true, sessionId = "command-session";
		let resolveConfirm: (() => Promise<boolean>) | undefined;
		let resolveInput: (() => Promise<string | undefined>) | undefined;
		const ctx: any = { hasUI: true, mode: "tui", isIdle: () => idle,
			sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
			ui: {
				notify(message: string) { notices.push(message); },
				async select() { throw new Error("/browser must not open an action menu"); },
				async confirm() { calls.push("confirm"); return resolveConfirm ? resolveConfirm() : confirmed; },
				async input() { return resolveInput ? resolveInput() : input; },
			},
		};
		createBrowserRelayExtensionV1({
			async connectRelay() { throw new Error("command must not use live session relay"); },
			async openArtifactStore() { throw new Error("command must not create artifacts"); },
			commands: {
				platform: "darwin",
				...(!realIO ? {
					async runInstaller(operation: string) { calls.push(operation); return operation === "status" ? { installed: true } : { status: "installed" }; },
					async probeRelay() { calls.push("probe"); },
				} : {}),
				...overrides,
			},
		})({
			registerTool() {}, registerCommand(name: string, command: unknown) { commands.set(name, command); },
			on(name: string, handler: unknown) { handlers.set(name, handler); },
			appendEntry() { throw new Error("command must not persist metadata to session"); },
			sendMessage() { throw new Error("diagnostics must not enter model context"); },
			sendUserMessage(text: string, options: unknown) { messages.push({ text, options }); },
			getActiveTools() { return active; }, setActiveTools() { throw new Error("must not override tool selection"); },
		});
		await handlers.get("session_start")({}, ctx);
		const command = commands.get("browser"); assert.ok(command);
		return { command, ctx, calls, notices, messages,
			run: (args = "") => command.handler(args, ctx),
			emit: (event: string, payload: unknown = {}) => handlers.get(event)(payload, ctx),
			confirm(value = true) { confirmed = value; },
			input(value: string) { input = value; }, selectTools(value: string[]) { active = value; },
			busy() { idle = false; }, switchId() { sessionId = "replacement-session"; },
			waitConfirm(fn: () => Promise<boolean>) { resolveConfirm = fn; },
			waitInput(fn: () => Promise<string | undefined>) { resolveInput = fn; },
		};
	}
	await t.test("startup, cancelled default task and invalid arguments have no IO/model effects", async () => {
		const f = await fixture(); assert.deepEqual(f.calls, []);
		await f.run(); assert.deepEqual(f.calls, []); assert.deepEqual(f.notices, []);
		assert.deepEqual(f.command.getArgumentCompletions("").map((item: any) => item.value), ["install", "status"]);
		assert.equal(f.command.getArgumentCompletions("help"), null);
		for (const bad of ["x".repeat(4097), "a\0b"]) await f.run(bad);
		assert.deepEqual(f.calls, []); assert.deepEqual(f.messages, []);
		assert.deepEqual(f.command.getArgumentCompletions("st").map((item: any) => item.value), ["status"]);
		assert.equal(f.command.getArgumentCompletions("use private task"), null);
	});
	await t.test("install needs explicit confirmation and reads back once; never probes or calls a model", async () => {
		const f = await fixture(); await f.run("install"); assert.deepEqual(f.calls, ["confirm"]);
		f.calls.length = 0; f.confirm(); await f.run("install");
		assert.deepEqual(f.calls, ["confirm", "install", "status"]);
		assert.match(f.notices.at(-1)!, /注册已回读确认[\s\S]*无变化/u);
		assert.ok(f.notices.at(-1)!.includes("/current/chrome-extension"));
		assert.deepEqual(f.messages, []);
	});
	for (const failure of ["timeout after write", "permission denied", "cancelled", "secret child stderr"]) {
		await t.test(`installer error stays unknown without retry: ${failure}`, async () => {
			let writes = 0;
			const f = await fixture({ async runInstaller() { writes += 1; throw new Error(failure); } });
			f.confirm(); await f.run("install"); assert.equal(writes, 1);
			assert.match(f.notices.at(-1)!, /unknown.*未自动重试或回滚/u);
			assert.ok(!f.notices.join("\n").includes(failure));
		});
	}
	for (const value of [{}, { installed: false }, { installed: "true" }]) {
		await t.test(`bad installation readback ${JSON.stringify(value)} cannot become success`, async () => {
			const f = await fixture({ async runInstaller(operation: string) { return operation === "install" ? { status: "installed" } : value; } });
			f.confirm(); await f.run("install"); assert.match(f.notices.at(-1)!, /unknown/u);
		});
	}
	await t.test("status distinguishes registration and connection, never shares diagnostics with model or fallback gate", async () => {
		const f = await fixture({ async runInstaller() { return { installed: false, title: "page-controlled injection", extensionDir: "untrusted path" }; } });
		await f.run("status"); assert.deepEqual(f.calls, ["probe"]);
		assert.match(f.notices.at(-1)!, /未确认匹配.*已连接.*未访问页面/su);
		assert.ok(!f.notices.join("\n").includes("page-controlled")); assert.ok(!f.notices.join("\n").includes("untrusted path"));
		assert.deepEqual(f.messages, []);
	});
	await t.test("extension directory display is a fixed HOME-derived path, never a child-supplied path", async () => {
		for (const injected of ["../../outside", "/tmp/attacker"]) {
			const f = await fixture({ async runInstaller() { return { installed: true, componentDigest: "a".repeat(64), extensionDir: injected }; } });
			await f.run("status");
			assert.ok(!f.notices.join("\n").includes(injected));
			assert.ok(f.notices.at(-1)!.includes("/browser-relay/current/chrome-extension"));
		}
	});
	await t.test("typed missing socket is unavailable; generic timeout/old protocol is unknown", async () => {
		for (const [error, expected] of [[new BrowserRelayUnavailableErrorV1(new Error("missing")), /不可用/u], [new Error("protocol failure secret"), /unknown/u]]) {
			const f = await fixture({ async probeRelay() { throw error; } }); await f.run("status");
			assert.match(f.notices.at(-1)!, expected as RegExp); assert.ok(!f.notices.join("\n").includes("secret"));
			f.selectTools(["browser_inspect", "browser_interact", "launch_browser"]);
			assert.equal((await f.emit("tool_call", { toolName: "launch_browser", input: {} })).block, true);
		}
		const f = await fixture({ async runInstaller() { throw new Error("bad status"); } }); await f.run("status");
		assert.match(f.notices.at(-1)!, /Native host：unknown.*Chrome Relay：已连接/su);
	});
	await t.test("use submits exactly one bounded user task, with no template expansion or direct browser action", async () => {
		const f = await fixture(); await f.run("打开 example.com，读标题");
		assert.equal(f.messages.length, 1); assert.match(f.messages[0].text, /用户任务：\n打开 example.com，读标题/u);
		assert.deepEqual(f.messages[0].options, { expandPromptTemplates: false }); assert.deepEqual(f.calls, []);
		const menu = await fixture(); menu.input("/browser install"); await menu.run();
		assert.equal(menu.messages.length, 1); assert.deepEqual(menu.calls, []);
		assert.match(menu.messages[0].text, /用户任务：\n\/browser install/u);
	});
	await t.test("arbitrary task text is preserved; only exact install/status are reserved", async () => {
		for (const task of ["看下这个网站是什么https://pokemondb.net/sprites/rotom", "install this extension", "status of this website", "help", "use this website"]) {
			const f = await fixture(); await f.run(task);
			assert.equal(f.messages.length, 1);
			assert.ok(f.messages[0].text.endsWith(`用户任务：\n${task}`));
			assert.deepEqual(f.calls, []);
		}
	});
	await t.test("cancelled/oversized use, busy agent and excluded tools do not submit or enable anything", async () => {
		const f = await fixture(); await f.run(); assert.deepEqual(f.messages, []);
		f.input("文".repeat(2000)); await f.run(); assert.deepEqual(f.messages, []);
		f.selectTools(["launch_browser"]); await f.run("use read a page"); assert.deepEqual(f.messages, []);
		f.busy(); await f.run("use read a page"); await f.run("install"); assert.deepEqual(f.calls, []);
		f.ctx.hasUI = false; await assert.rejects(f.run("install"), /需要交互界面/u); assert.deepEqual(f.calls, []);
	});
	await t.test("unsupported installer platform has no subprocess or probe", async () => {
		// Linux and Windows are supported platforms now; an unknown one still refuses
		// before any subprocess, probe or file write.
		const f = await fixture({ platform: "freebsd" }); await f.run("install"); await f.run("status");
		assert.deepEqual(f.calls, []); assert.match(f.notices.at(-1)!, /没有已验证的 Chrome Relay 安装路径/u);
	});
	await t.test("linux install reaches the installer instead of a platform refusal", async () => {
		const f = await fixture({ platform: "linux" }); await f.run("status");
		assert.deepEqual(f.calls[0], "status");
	});
	await t.test("--browser names the Chromium family, and an unknown one never dispatches", async () => {
		const f = await fixture(); f.confirm(); await f.run("install --browser edge");
		assert.deepEqual(f.calls.slice(0, 2), ["confirm", "install"]);
		f.ctx.hasUI = true; f.calls.length = 0; await f.run("install --browser netscape");
		assert.deepEqual(f.calls, []); assert.match(f.notices.at(-1)!, /不支持的浏览器：netscape/u);
	});
	for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"]) {
		await t.test(`${event} cancels old confirmations before any write`, async () => {
			const f = await fixture(), entered = Promise.withResolvers<void>(), response = Promise.withResolvers<boolean>();
			f.waitConfirm(() => { entered.resolve(); return response.promise; });
			const pending = f.run("install"); await entered.promise; await f.emit(event); response.resolve(true); await pending;
			assert.deepEqual(f.calls, ["confirm"]); assert.deepEqual(f.messages, []); assert.deepEqual(f.notices, []);
		});
	}
	await t.test("late input cannot submit into a changed session or newly busy agent", async () => {
		for (const change of ["session", "busy"]) {
			const f = await fixture(), entered = Promise.withResolvers<void>(), response = Promise.withResolvers<string>();
			f.waitInput(() => { entered.resolve(); return response.promise; });
			const pending = f.run(); await entered.promise;
			if (change === "session") f.switchId(); else f.busy();
			response.resolve("read a page"); await pending; assert.deepEqual(f.messages, []);
		}
	});
	await t.test("real installer/diagnostic use frozen isolated HOME, not later environment changes", { skip: process.platform !== "darwin" }, async () => {
		// macOS sockaddr_un cannot fit the long default per-user TMPDIR plus the relay suffix.
		const home = await mkdtemp("/tmp/browser-command-home-");
		await mkdir(join(home, "Library", "Application Support"), { recursive: true });
		const previousHome = process.env.HOME;
		let f: Awaited<ReturnType<typeof fixture>>;
		try { process.env.HOME = home; f = await fixture({}, true); }
		finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; }
		try {
			await f.run("status"); assert.match(f.notices.at(-1)!, /未确认匹配.*不可用/su);
			f.confirm(); await f.run("install"); assert.match(f.notices.at(-1)!, /注册已回读确认/u);
			const manifestPath = join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.rotom.browser_relay.json");
			const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
			assert.equal(manifest.path, join(realpathSync(home), "Library/Application Support/rotom/browser-relay/native-host-launcher.sh"));
			assert.deepEqual(manifest.allowed_origins, ["chrome-extension://kgadcllokaodnoknakblocmhidemimdi/"]);
			await f.run("status"); assert.match(f.notices.at(-1)!, /与当前 rotom 匹配.*不可用/su);
			assert.deepEqual(f.messages, []);
		} finally { await rm(home, { recursive: true, force: true }); }
	});
	await t.test("one command in flight; shutdown aborts IO and suppresses late publication/readback", async () => {
		const entered = Promise.withResolvers<void>(), completed = Promise.withResolvers<unknown>();
		let calls = 0, signal: AbortSignal | undefined;
		const f = await fixture({ async runInstaller(_op: string, input: AbortSignal) { calls += 1; signal = input; entered.resolve(); return completed.promise; } });
		f.confirm(); const pending = f.run("install"); await entered.promise; await f.run("install");
		assert.equal(calls, 1); assert.match(f.notices.at(-1)!, /尚未结束/u); f.notices.length = 0;
		await f.emit("session_shutdown"); assert.equal(signal?.aborted, true);
		completed.resolve({ status: "installed" }); await pending;
		assert.equal(calls, 1); assert.deepEqual(f.notices, []);
	});
});
