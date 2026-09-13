#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { measureContextFootprint } from "./context-footprint.mjs";
import { DEFERRED_CAPABILITY_GROUPS, DEFERRED_DEFAULT_SURFACE_ENV, DEFERRED_INITIAL_TOOL_NAMES, DEFERRED_TOOL_SEARCH_NAME, RESIDENT_BROWSER_TOOL_NAMES, deferredToolsEnabled } from "../extensions/third-party/deferred-tools/register.ts";
import { PRODUCT_SUBAGENT_ALLOWED_ACTIONS, PRODUCT_SUBAGENT_ALLOWED_COMMANDS, PRODUCT_SUBAGENT_BLOCKED_FIELDS } from "../extensions/third-party/subagent/policy.ts";
import { RESOURCE_DESCRIPTORS_V1 } from "./product-config.mjs";
import { verifyPiRuntime } from "./verify-pi-runtime.mjs";

const [piExecutable, agentDirInput] = process.argv.slice(2);
if (!piExecutable || !agentDirInput) {
	throw new Error("用法：smoke-runtime.mjs <pi-executable> <agent-dir>");
}

const agentDir = resolve(agentDirInput);
const goalToolNames = ["goal_complete", "goal_blocked", "goal_wait"];
const deferredToolsActive = deferredToolsEnabled(process.env);
process.env[DEFERRED_DEFAULT_SURFACE_ENV] = "1";
const declarations = RESOURCE_DESCRIPTORS_V1.map((resource) => `${resource.kind}:${resolve(agentDir, resource.path)}`);
const verified = await verifyPiRuntime({ executable: piExecutable, agentDir, resourceDeclarations: declarations });
const pi = await import(pathToFileURL(verified.publicEntry).href);

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

const businessCwd = await mkdtemp(resolve(tmpdir(), "rotom-l2-business-"));
const isolatedAgentDir = await mkdtemp(resolve(tmpdir(), "rotom-l2-config-"));
const sessionsDir = await mkdtemp(resolve(tmpdir(), "rotom-l2-sessions-"));

try {
	const nativeSkillDir = resolve(isolatedAgentDir, "skills", "native-discovery-smoke");
	await mkdir(nativeSkillDir, { recursive: true });
	await writeFile(resolve(nativeSkillDir, "SKILL.md"), "---\nname: native-discovery-smoke\ndescription: Proves Pi native skill directory discovery.\n---\n\nNative skill discovery smoke.\n", { mode: 0o600 });
	const nativeExtension = resolve(isolatedAgentDir, "extensions", "native-discovery-smoke.js");
	await mkdir(dirname(nativeExtension), { recursive: true });
	await writeFile(nativeExtension, `export default function (pi) {\n\tpi.registerCommand("native-extension-smoke", { description: "Proves Pi native extension discovery", handler: async () => {} });\n}\n`, { mode: 0o600 });
	const settingsManager = pi.SettingsManager.create(businessCwd, isolatedAgentDir, { projectTrusted: false });
	const extensions = RESOURCE_DESCRIPTORS_V1
		.filter((resource) => resource.kind === "extension")
		.map((resource) => resolve(agentDir, resource.loadPath ?? resource.path));
	const skills = RESOURCE_DESCRIPTORS_V1.filter((resource) => resource.kind === "skill").map((resource) => resolve(agentDir, resource.path));
	const prompts = RESOURCE_DESCRIPTORS_V1.filter((resource) => resource.kind === "prompt").map((resource) => resolve(agentDir, resource.path));
	const loader = new pi.DefaultResourceLoader({
		cwd: businessCwd,
		agentDir: isolatedAgentDir,
		settingsManager,
		additionalExtensionPaths: extensions,
		additionalSkillPaths: skills,
		additionalPromptTemplatePaths: prompts,
		noExtensions: false,
		noSkills: false,
		noPromptTemplates: false,
		noThemes: true,
		noContextFiles: true,
	});
	assert.notEqual(resolve(process.cwd()), resolve(businessCwd), "smoke 必须保持 ambient cwd 与 authoritative business cwd 不同");
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	assert.deepEqual(loaded.extensions.map((extension) => resolve(extension.path)), [...extensions, nativeExtension]);
	assert.equal(loaded.extensions.length, 6);
	assert.equal(loaded.extensions.find((extension) => resolve(extension.path) === nativeExtension)?.commands.has("native-extension-smoke"), true, "Pi agentDir extensions 必须无需产品声明即可发现");
	assert.deepEqual(skills, [resolve(agentDir, "skills/pi-subagents")], "产品只加载自有精简版 Subagent skill");
	assert.equal(loader.getSkills().skills.filter((skill) => skill.name === "pi-subagents").length, 1, "不得同时加载上游完整指南");
	assert.equal(loader.getSkills().diagnostics.filter((diagnostic) => diagnostic.level === "error").length, 0);
	const loadedSkillPaths = loader.getSkills().skills.map((skill) => resolve(skill.filePath ?? skill.path));
	for (const bundledSkill of skills.map((path) => resolve(path, "SKILL.md"))) assert.equal(loadedSkillPaths.includes(bundledSkill), true);
	assert.equal(loadedSkillPaths.includes(resolve(nativeSkillDir, "SKILL.md")), true, "native agentDir skill 必须无需注册即可发现");
	assert.equal(prompts.length, 0, "产品不再声明 bundled prompt templates");
	assert.deepEqual(loader.getPrompts().prompts, [], "加载第三方扩展不得隐式恢复已移除的模板命令");
	for (const extension of loaded.extensions.filter((candidate) => !candidate.path.endsWith("/third-party"))) {
		for (const { definition } of extension.tools.values()) {
			assert.equal(definition.executionMode, "sequential", `${definition.name} 必须 sequential`);
		}
	}
	const piAiEntry = await findPiAiEntry(verified.packageRoot);
	const { fauxProvider } = await import(pathToFileURL(piAiEntry).href);
	const faux = fauxProvider({ provider: "runtime-smoke-faux", models: [{ id: "runtime-smoke", contextWindow: 12_000, maxTokens: 1_024 }] });
	const modelRuntime = await pi.ModelRuntime.create({ authPath: resolve(isolatedAgentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const session = pi.SessionManager.create(businessCwd, sessionsDir);
	const extensionToolNames = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
	const created = await pi.createAgentSession({
		cwd: businessCwd,
		agentDir: isolatedAgentDir,
		modelRuntime,
		model: faux.getModel(),
		thinkingLevel: "off",
		tools: ["read", "bash", "edit", "write", ...extensionToolNames],
		resourceLoader: loader,
		sessionManager: session,
		settingsManager,
		sessionStartEvent: { type: "session_start", reason: "startup" },
	});
	const lifecycleErrors = [];
	await created.session.bindExtensions({ mode: "print", onError: (error) => lifecycleErrors.push(error) });
	assert.deepEqual(lifecycleErrors, []);
	assert.deepEqual(created.extensionsResult.errors, []);
	const realToolInfos = created.session.getAllTools();
	for (const tool of realToolInfos) assert.equal(Object.hasOwn(tool, "executionMode"), false, `public ToolInfo 不得伪造 executionMode：${tool.name}`);
	const observability = created.extensionsResult.extensions.find((extension) => extension.path.endsWith("/observability"));
	const browser = created.extensionsResult.extensions.find((extension) => extension.path === resolve(agentDir, "extensions/browser/index.ts"));
	const codingPolicy = created.extensionsResult.extensions.find((extension) => extension.path === resolve(agentDir, "extensions/coding-policy/index.ts"));
	const thirdParty = created.extensionsResult.extensions.find((extension) => extension.path.endsWith("/third-party"));
	const qoder = created.extensionsResult.extensions.find((extension) => extension.path === resolve(agentDir, "extensions/qoder/index.ts"));
	assert.equal(qoder?.tools.size, 0, "Qoder provider must not change the tool surface");
	const qoderEnabled = process.env.ROTOM_QODER !== "0";
	assert.equal(Boolean(modelRuntime.getModel("qoder-experimental", "lite")), qoderEnabled, "Qoder registration must default on with an explicit opt-out");
	if (qoderEnabled) {
		const auth = modelRuntime.getProvider("qoder-experimental").auth;
		const browserAuth = (process.env.ROTOM_QODER_AUTH ?? "browser") === "browser";
		assert.equal(Boolean(auth.oauth), browserAuth);
		assert.equal(Boolean(auth.apiKey), !browserAuth);
		assert.equal(modelRuntime.getModel("qoder-experimental", "gmodel")?.reasoning, true, "validated IDs must resolve before account discovery for explicit selection/resume");
		assert.equal(qoder.commands.has("qoder-models"), true);
		assert.equal(qoder.commands.has("qoder-credits"), true);
	} else {
		assert.equal(qoder.commands.has("qoder-models"), false);
		assert.equal(qoder.commands.has("qoder-credits"), false);
	}
	assert.equal(created.session.model.provider, "runtime-smoke-faux", "Qoder must not change the selected model");
	assert.equal(observability?.commands.has("trace"), true, "observability 必须提供不进入模型上下文的 /trace 命令");
	assert.equal(observability?.tools.size, 0, "observability 不得增加模型 tool schema");
	for (const tool of ["find_roots", "observe_ui", "act_ui", "subagent", "goal_complete", "goal_blocked", "goal_wait"]) assert.equal(thirdParty?.tools.has(tool), true);
	assert.deepEqual(new Set(extensionToolNames), new Set([
		...RESIDENT_BROWSER_TOOL_NAMES, "ask_user_question", ...DEFERRED_CAPABILITY_GROUPS.flatMap((group) => [...group.toolNames]),
		...goalToolNames, ...(deferredToolsActive ? [DEFERRED_TOOL_SEARCH_NAME] : []),
	]), "公开工具面必须精确匹配保留的能力，不得加载未声明的业务平台工具");
	assert.equal(thirdParty?.tools.has(DEFERRED_TOOL_SEARCH_NAME), deferredToolsActive, "deferred loader 默认注册且必须可显式关闭");
	for (const command of ["computer-use", "goal", ...PRODUCT_SUBAGENT_ALLOWED_COMMANDS]) assert.equal(thirdParty?.commands.has(command), true);
	for (const command of ["mcp", "bg", "lsp"]) assert.equal(loaded.extensions.some((extension) => extension.commands.has(command)), false, `removed command /${command} must not be registered by any product extension`);
	for (const command of ["subagents", "run", "subagents-fleet", "subagents-refine", "subagents-watchdog", "prompt-workflow"]) assert.equal(thirdParty?.commands.has(command), false);
	assert.equal(thirdParty?.shortcuts.has("ctrl+alt+f"), false);
	assert.equal(browser?.commands.has("browser"), true, "内置 browser 扩展必须提供用户显式触发的 /browser 命令");
	assert.equal(browser?.tools.get("browser_inspect")?.definition.executionMode, "sequential");
	assert.equal(browser?.tools.get("browser_interact")?.definition.executionMode, "sequential");
	assert.ok(browser?.tools.get("browser_interact")?.definition.parameters.properties.action.enum.includes("keypress"));
	assert.deepEqual(browser?.tools.get("browser_interact")?.definition.parameters.properties.key.enum, ["Enter", "Tab", "Escape"]);
	assert.equal(codingPolicy?.handlers.get("before_agent_start")?.length, 1, "coding policy 必须通过真实 loader 按编码工具激活");
	for (const event of ["session_start", "session_tree", "session_before_tree", "session_before_switch", "session_before_fork", "session_shutdown"]) assert.equal(browser?.handlers.get(event)?.length, 1);
	assert.equal(thirdParty?.tools.get("ask_user_question")?.definition.executionMode, "sequential");
	const subagentDefinition = thirdParty?.tools.get("subagent")?.definition;
	assert.deepEqual(subagentDefinition?.parameters?.properties?.action?.enum, [...PRODUCT_SUBAGENT_ALLOWED_ACTIONS]);
	for (const field of PRODUCT_SUBAGENT_BLOCKED_FIELDS) assert.equal(subagentDefinition?.parameters?.properties?.[field], undefined);
	const activeTools = created.session.getActiveToolNames();
	const contextFootprint = measureContextFootprint({
		systemPrompt: created.session.systemPrompt,
		allTools: realToolInfos,
		activeToolNames: activeTools,
		contextFiles: loader.getAgentsFiles().agentsFiles,
		skills: loader.getSkills().skills,
	});
	// pi-goal 0.54.4 keeps all three schemas stable from startup. Visibility is
	// not Goal activation: the inactive-call rejection is checked below.
	if (deferredToolsActive) {
		assert.deepEqual(new Set(activeTools), new Set([...DEFERRED_INITIAL_TOOL_NAMES, ...goalToolNames, DEFERRED_TOOL_SEARCH_NAME]), "默认初始工具面必须保留 core + Ask + Browser/Computer Use + Goal + loader");
		for (const tool of RESIDENT_BROWSER_TOOL_NAMES) assert.equal(activeTools.includes(tool), true, `默认必须预加载 ${tool}`);
		for (const tool of DEFERRED_CAPABILITY_GROUPS.flatMap((group) => [...group.toolNames])) assert.equal(activeTools.includes(tool), false, `默认不得预加载 ${tool}`);
	} else {
		assert.deepEqual(new Set(activeTools), new Set([
			...DEFERRED_INITIAL_TOOL_NAMES, ...goalToolNames,
			...DEFERRED_CAPABILITY_GROUPS.flatMap((group) => [...group.toolNames]),
		]), "full opt-out 必须保留 Goal 与 Subagent，且不注册 loader");
	}
	const shutdownContext = {
		cwd: businessCwd,
		sessionManager: session,
		hasUI: false,
		mode: "print",
		signal: undefined,
		isProjectTrusted: () => false,
		ui: { notify() {}, setStatus() {}, theme: { fg: (_color, value) => value } },
	};
	for (const name of goalToolNames) {
		assert.ok(activeTools.includes(name), `${name} schema must remain active without a Goal`);
		const definition = thirdParty.tools.get(name).definition;
		assert.match(definition.description, /Tool visibility alone does not activate Goal mode/u);
		const branchBefore = JSON.stringify(session.getBranch());
		const params = {
			goal_complete: { goal_id: "inactive-smoke-goal", summary: "Fixture completion evidence" },
			goal_blocked: { goal_id: "inactive-smoke-goal", reason: "Fixture blocker", evidence: "Fixture evidence", repeated_turns: 3 },
			goal_wait: { goal_id: "inactive-smoke-goal", reason: "Fixture external wait" },
		}[name];
		const rejected = await definition.execute(`inactive-${name}`, params, undefined, undefined, shutdownContext);
		assert.match(rejected.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"), /rejected: no active goal/u);
		assert.notEqual(rejected.terminate, true, "inactive Goal tools must not terminate ordinary work");
		assert.equal(JSON.stringify(session.getBranch()), branchBefore, "inactive calls must not persist Goal transitions");
		assert.deepEqual(created.session.getActiveToolNames(), activeTools, "inactive calls must not change the tool policy");
	}
	for (const handler of observability?.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, shutdownContext);
	await browser.handlers.get("session_shutdown")[0]({ type: "session_shutdown", reason: "quit" }, shutdownContext);
	for (const handler of thirdParty.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, shutdownContext);
	created.session.dispose();
	process.stdout.write(JSON.stringify({
		package: "@earendil-works/pi-coding-agent",
		version: verified.version,
		cwd: businessCwd,
		extensions: loaded.extensions.length,
		skills: loader.getSkills().skills.length,
		bundledSkills: skills.length,
		promptTemplates: loader.getPrompts().prompts.length,
		nativeDiscoveredSkills: loader.getSkills().skills.length - skills.length,
		skillsCommandRegistered: false,
		registeredTools: loaded.extensions.flatMap((extension) => [...extension.tools.keys()]),
		activeTools,
		contextFootprint,
		publicToolInfoOmitsExecutionMode: true,
		realCreateAgentSessionBound: true,
		lifecycleErrors: lifecycleErrors.length,
		execution: "native-host",
		thirdPartyRuntimeHandlersLoaded: true,
		deferredToolsEnabled: deferredToolsActive,
		browserHandlersLoaded: true,
		observabilityHandlersLoaded: true,
	}) + "\n");
} finally {
	await Promise.all([
		rm(businessCwd, { recursive: true, force: true }),
		rm(isolatedAgentDir, { recursive: true, force: true }),
		rm(sessionsDir, { recursive: true, force: true }),
	]);
}
