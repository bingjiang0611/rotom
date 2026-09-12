import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { subagentPolicyApi, prepareProductSubagentArguments } from "./policy.ts";
import { VERIFIED_THIRD_PARTY_PACKAGES } from "../../../runtime/product-config.mjs";

function publicPi() {
	const executable = process.env.ROTOM_PI;
	assert.ok(executable, "ROTOM_PI must pin the tested executable");
	let root = dirname(realpathSync(executable));
	for (;;) {
		const path = join(root, "package.json");
		if (existsSync(path)) {
			const pkg = JSON.parse(readFileSync(path, "utf8"));
			if (pkg.name === "@earendil-works/pi-coding-agent") return { pkg, entry: join(root, pkg.exports["."].import) };
		}
		const parent = dirname(root); assert.notEqual(parent, root); root = parent;
	}
}

test("public Pi runtime new/resume/fork/reload uses fresh leases on the exact product", { timeout: 60000 }, async (t) => {
	const selected = publicPi(); const pi = await import(pathToFileURL(selected.entry).href);
	t.diagnostic(`Pi ${selected.pkg.version}; public export ${selected.entry}`);
	const installed = JSON.parse(readFileSync(new URL("../node_modules/pi-subagents/package.json", import.meta.url), "utf8"));
	assert.equal(installed.version, VERIFIED_THIRD_PARTY_PACKAGES["pi-subagents"].version);
	const root = await mkdtemp(join(tmpdir(), "pi-public-ownership-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "workspace"), agentDir = join(root, "agent");
	await mkdir(cwd); await mkdir(agentDir);
	const leases: any[] = []; const rawApis: any[] = []; const errors: unknown[] = [];
	const shutdownEntered = Promise.withResolvers<void>(), releaseShutdown = Promise.withResolvers<void>();
	let pauseShutdown = true;
	const factory = async (options: any) => {
		const services = await pi.createAgentSessionServices({
			cwd: options.cwd, agentDir,
			resourceLoaderOptions: {
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				additionalExtensionPaths: [resolve(import.meta.dirname, "../index.ts")],
				extensionFactories: [(api: any) => {
					const lease = subagentPolicyApi(api); leases.push(lease); rawApis.push(api);
					api.on("session_shutdown", async () => {
						if (!pauseShutdown) return;
						pauseShutdown = false; shutdownEntered.resolve(); await releaseShutdown.promise;
					});
				}],
			},
		});
		const created = await pi.createAgentSessionFromServices({ services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent, noTools: "all" });
		assert.deepEqual(created.extensionsResult.errors, []);
		await created.session.bindExtensions({ mode: "print", onError: (error: unknown) => errors.push(error) });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const manager = pi.SessionManager.create(cwd, join(root, "sessions"));
	manager.appendMessage({ role: "user", content: "fixture; no provider call", timestamp: Date.now() });
	manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "deterministic fixture" }], api: "openai-responses", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
	const initialPath = manager.getSessionFile(); assert.ok(initialPath); assert.ok(existsSync(initialPath));
	const runtime = await pi.createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: manager });
	t.after(() => runtime.dispose());
	const original = leases.at(-1);
	const switching = runtime.newSession(); await shutdownEntered.promise;
	try {
		// Pi's API is still active during awaited shutdown; this is the lease's distinct boundary.
		assert.doesNotThrow(() => rawApis[0].appendEntry("ownership-test", "outgoing fixture"));
		assert.throws(() => original.appendEntry("ownership-test", "late during shutdown"), /retired/u);
	} finally { releaseShutdown.resolve(); assert.equal((await switching).cancelled, false); }
	assert.throws(() => original.appendEntry("ownership-test", "late A"), /retired|ctx is stale/u);
	const second = leases.at(-1);
	assert.equal((await runtime.switchSession(initialPath)).cancelled, false);
	assert.equal(runtime.session.sessionManager.getSessionId(), manager.getSessionId());
	assert.throws(() => original.appendEntry("ownership-test", "A revived?"), /retired/u);
	assert.throws(() => second.appendEntry("ownership-test", "late B"), /retired/u);
	const resumed = leases.at(-1);
	resumed.appendEntry("ownership-test", "current A");
	const entry = runtime.session.sessionManager.appendMessage({ role: "user", content: "fork target", timestamp: Date.now() });
	assert.equal((await runtime.fork(entry)).cancelled, false);
	assert.throws(() => resumed.appendEntry("ownership-test", "late resumed A"), /retired/u);
	const forked = leases.at(-1);
	await runtime.session.reload();
	assert.throws(() => forked.appendEntry("ownership-test", "late fork"), /retired/u);
	assert.equal(leases.length, 5);
	leases.at(-1).appendEntry("ownership-test", "after reload");
	assert.deepEqual(errors, []);
});

test("public runtime deferred state follows the branch on replacement, but tree navigation stays additive", { timeout: 60000 }, async (t) => {
	const selected = publicPi(); const pi = await import(pathToFileURL(selected.entry).href);
	const root = await mkdtemp(join(tmpdir(), "pi-deferred-lifecycle-"));
	const cwd = join(root, "workspace"), agentDir = join(root, "agent"); await mkdir(cwd); await mkdir(agentDir);
	const previous = process.env.ROTOM_DEFERRED_DEFAULT_SURFACE;
	process.env.ROTOM_DEFERRED_DEFAULT_SURFACE = "1";
	t.after(async () => { if (previous === undefined) delete process.env.ROTOM_DEFERRED_DEFAULT_SURFACE; else process.env.ROTOM_DEFERRED_DEFAULT_SURFACE = previous; await rm(root, { recursive: true, force: true }); });
	const factory = async (options: any) => {
		const services = await pi.createAgentSessionServices({ cwd: options.cwd, agentDir, resourceLoaderOptions: {
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			additionalExtensionPaths: [resolve(import.meta.dirname, "../../browser/index.ts"), resolve(import.meta.dirname, "../index.ts")],
		} });
		const created = await pi.createAgentSessionFromServices({ services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent });
		assert.deepEqual(created.extensionsResult.errors, []);
		await created.session.bindExtensions({ mode: "print", onError: (error: unknown) => { throw error; } });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const manager = pi.SessionManager.create(cwd, join(root, "sessions"));
	manager.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() });
	const before = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "fixture" }], api: "openai-responses", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
	const runtime = await pi.createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: manager });
	try {
		const loaded = () => runtime.session.getActiveToolNames().includes("subagent");
		assert.equal(loaded(), false);
		const search = runtime.session.agent.state.tools.find((tool: any) => tool.name === "search_tools"); assert.ok(search);
		await search.execute("discover", { query: "subagent" });
		assert.equal(loaded(), true);
		const originalFile = runtime.session.sessionManager.getSessionFile(); assert.ok(originalFile);
		const target = runtime.session.sessionManager.appendMessage({ role: "user", content: "fork", timestamp: Date.now() });
		assert.equal((await runtime.fork(target)).cancelled, false); assert.equal(loaded(), true);
		await runtime.session.reload(); assert.equal(loaded(), true);
		assert.equal((await runtime.session.navigateTree(before, { summarize: false })).cancelled, false);
		assert.equal(loaded(), true, "tree does not revoke loaded tools");
		runtime.session.sessionManager.appendCustomEntry("fixture-branch", {});
		await runtime.session.reload(); assert.equal(loaded(), false, "reload must not restore the abandoned discovery");
		await runtime.newSession(); assert.equal(loaded(), false);
		await runtime.switchSession(originalFile); assert.equal(loaded(), true, "resume restores the recorded discovery");
	} finally { await runtime.dispose(); }
});

for (const delayMs of [150, 1000]) test(`exact .2 notifier ${delayMs}ms batch refuses stale delivery and does not mark it accepted`, async () => {
	const selected = publicPi();
	const require = createRequire(selected.entry);
	const { createJiti } = await import(pathToFileURL(require.resolve("jiti")).href);
	const jiti = createJiti(selected.entry, { moduleCache: false });
	const { default: registerNotify } = await jiti.import(resolve(import.meta.dirname, "../node_modules/pi-subagents/src/runs/background/notify.ts")) as any;
	const hooks: Function[] = []; const timers: Array<{ callback: Function; delay: number }> = []; const delivered: unknown[] = [];
	const api = subagentPolicyApi({ on(_name: string, callback: Function) { hooks.push(callback); }, events: { on() { return () => {}; } }, sendMessage(value: unknown) { delivered.push(value); } } as any);
	const notifier = registerNotify(api, { currentSessionId: "A", completionOwnerId: "owner-A" }, { timers: { setTimeout(callback: Function, delay: number) { const timer = { callback, delay }; timers.push(timer); return timer; }, clearTimeout() {} } });
	const result = { id: "old-run", source: "async", success: true, sessionId: "A", completionOwnerId: "owner-A", summary: "old evidence remains on its run" };
	const accepted = notifier.deliver(result);
	hooks.forEach((callback) => callback());
	timers.find((timer) => timer.delay === delayMs)!.callback();
	assert.equal(await accepted, false);
	assert.deepEqual(delivered, []);
	// Package disposal settles undelivered items without falsely acknowledging them.
	const retry = notifier.deliver(result); notifier.dispose(); assert.equal(await retry, false);
});

test("exact .2 steering acknowledgement deadline leaves the writer pending without recovery", { timeout: 10000 }, async (t) => {
	const selected = publicPi(); const require = createRequire(selected.entry);
	const { createJiti } = await import(pathToFileURL(require.resolve("jiti")).href);
	const jiti = createJiti(selected.entry, { moduleCache: false });
	const { steerAsyncRun } = await jiti.import(resolve(import.meta.dirname, "../node_modules/pi-subagents/src/runs/foreground/async-steering-action.ts")) as any;
	const dir = await mkdtemp(join(tmpdir(), "steer-no-replacement-")); t.after(() => rm(dir, { recursive: true, force: true }));
	const runId = `fixture-${Date.now()}`;
	await writeFile(join(dir, "status.json"), JSON.stringify({ runId, sessionId: "fixture", state: "running", mode: "single", startedAt: Date.now(), lastUpdate: Date.now(), pid: process.pid, steps: [{ agent: "fixture", status: "running" }] }));
	const args = prepareProductSubagentArguments({ action: "steer", id: runId, steeringRecovery: true });
	let recoveries = 0, queued = false;
	const result = await steerAsyncRun({ state: { currentSessionId: "fixture", asyncJobs: new Map() }, runId, message: "bounded fixture", location: { asyncDir: dir }, ackTimeoutMs: 1, onRequestQueued() { queued = true; }, ...(args.steeringRecovery === false ? {} : { recover() { recoveries += 1; throw new Error("must not recover"); } }) });
	assert.equal(queued, true); assert.equal(recoveries, 0);
	assert.equal(result.details.steering.deliveryStatus, "queued");
	assert.equal(result.details.steering.replacementRunId, undefined);
	assert.equal(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).state, "running");
	assert.equal(existsSync(join(dir, "control/steer-recovery")), false);
	const executor = readFileSync(resolve(import.meta.dirname, "../node_modules/pi-subagents/src/runs/foreground/subagent-executor.ts"), "utf8");
	assert.equal([...executor.matchAll(/paramsWithResolvedCwd\.steeringRecovery === false\s*\? \{\}/gu)].length, 2, "both exact-package ID and directory routes omit the recovery callback");
});
