// A child agent launched for browser tools really gets those tools registered.
//
// The Subagent component decides which extension a child loads; this check feeds
// that exact launch plan into the installed Pi and asserts the child's tool list.
// It is not a spawned subagent process: it proves the wiring, not a remote model
// call or a live browser session.

import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createJiti } from "../../packages/rotom-subagents/node_modules/jiti/lib/jiti.mjs";

const agentDir = resolve(import.meta.dirname, "..");
const browserExtension = resolve(agentDir, "extensions/browser/index.ts");

async function findPiAiEntry(packageRoot) {
	let directory = packageRoot;
	for (;;) {
		const candidate = resolve(directory, "node_modules/@earendil-works/pi-ai/dist/index.js");
		if (await access(candidate).then(() => true, () => false)) return candidate;
		const parent = dirname(directory);
		if (parent === directory) throw new Error(`无法从 Pi package 解析 @earendil-works/pi-ai：${packageRoot}`);
		directory = parent;
	}
}

test("子 agent 的 launch plan 让真实 Pi 注册 browser_inspect / browser_interact", { timeout: 120_000 }, async (t) => {
	const saved = { extension: process.env.ROTOM_SUBAGENT_BROWSER_EXTENSION, home: process.env.HOME };
	process.env.ROTOM_SUBAGENT_BROWSER_EXTENSION = browserExtension;
	t.after(() => {
		for (const [key, value] of [["ROTOM_SUBAGENT_BROWSER_EXTENSION", saved.extension], ["HOME", saved.home]]) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	});
	const businessCwd = await mkdtemp(resolve(tmpdir(), "rotom-child-browser-cwd-"));
	const isolatedAgentDir = await mkdtemp(resolve(tmpdir(), "rotom-child-browser-config-"));
	t.after(async () => {
		await rm(businessCwd, { recursive: true, force: true });
		await rm(isolatedAgentDir, { recursive: true, force: true });
	});

	const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
	const { buildPiArgs } = await jiti.import("../../packages/rotom-subagents/src/runs/shared/pi-args.ts");
	const plan = buildPiArgs({
		baseArgs: [], task: "fill the form", sessionEnabled: false,
		tools: ["browser_inspect", "browser_interact"], extensions: [], cwd: businessCwd,
		runId: "run_browser_registration", parentSessionId: "session-main",
	});
	const args = plan.args;
	const extensionPaths = [];
	let tools;
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === "--extension") extensionPaths.push(args[index + 1]);
		if (args[index] === "--tools") tools = args[index + 1].split(",");
	}
	assert.ok(extensionPaths.includes(browserExtension), "launch plan 必须带上 browser 扩展");
	assert.deepEqual(tools, ["browser_inspect", "browser_interact"]);
	assert.equal(plan.env.ROTOM_BROWSER_AGENT_ID, "run_browser_registration");

	const { verifyPiRuntime } = await import("./verify-pi-runtime.mjs");
	const { RESOURCE_DESCRIPTORS_V1 } = await import("./product-config.mjs");
	const { resolveInstalledPi } = await import("./resolve-installed-pi.mjs");
	const verified = await verifyPiRuntime({
		executable: process.env.ROTOM_PI ?? (await resolveInstalledPi(agentDir)),
		agentDir,
		resourceDeclarations: RESOURCE_DESCRIPTORS_V1.map((resource) => `${resource.kind}:${resolve(agentDir, resource.path)}`),
	});
	const pi = await import(pathToFileURL(verified.publicEntry).href);
	const piAiEntry = await findPiAiEntry(verified.packageRoot);
	const { fauxProvider } = await import(pathToFileURL(piAiEntry).href);
	const faux = fauxProvider({ provider: "child-browser-faux", models: [{ id: "child-browser", contextWindow: 12_000, maxTokens: 1_024 }] });
	const modelRuntime = await pi.ModelRuntime.create({ authPath: resolve(isolatedAgentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);

	const registerWith = async (paths) => {
		const loader = new pi.DefaultResourceLoader({
			cwd: businessCwd, agentDir: isolatedAgentDir, settingsManager: pi.SettingsManager.inMemory(),
			additionalExtensionPaths: paths, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const created = await pi.createAgentSession({
			cwd: businessCwd, agentDir: isolatedAgentDir, modelRuntime, model: faux.getModel(), thinkingLevel: "off",
			tools, resourceLoader: loader, sessionManager: pi.SessionManager.inMemory(businessCwd),
			settingsManager: pi.SettingsManager.inMemory(), sessionStartEvent: { type: "session_start", reason: "startup" },
		});
		await created.session.bindExtensions({ mode: "print", onError: () => undefined });
		return { session: created.session, names: created.session.getAllTools().map((tool) => tool.name) };
	};

	const withBrowser = await registerWith(extensionPaths);
	t.after(() => withBrowser.session.dispose?.());
	for (const name of ["browser_inspect", "browser_interact"]) assert.ok(withBrowser.names.includes(name), `子进程必须注册 ${name}`);

	// Negative control: without the extension argument the same --tools list
	// cannot produce the tools, so the assertion above discriminates.
	const withoutBrowser = await registerWith(extensionPaths.filter((path) => path !== browserExtension));
	t.after(() => withoutBrowser.session.dispose?.());
	for (const name of ["browser_inspect", "browser_interact"]) assert.equal(withoutBrowser.names.includes(name), false, `没有扩展时不应注册 ${name}`);
});
