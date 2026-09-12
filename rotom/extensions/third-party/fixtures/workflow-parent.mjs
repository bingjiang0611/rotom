// Actual public SDK + complete upstream extension. The child is the verified real Pi CLI.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const config = JSON.parse(
	fs.readFileSync(process.env.OWNER_WORKFLOW_CONFIG, "utf8"),
);
const phase = process.argv[2] ?? "start";
const save = (name, data) =>
	fs.writeFileSync(path.join(config.cwd, name), JSON.stringify(data), {
		mode: 0o600,
	});
const pi = await import(pathToFileURL(config.piEntry).href);
const { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } =
	await import(pathToFileURL(config.fauxEntry).href);
const runtime = await pi.ModelRuntime.create({
	authPath: path.join(config.agentDir, "auth.json"),
	modelsPath: null,
	allowModelNetwork: false,
});
const faux = fauxProvider({
	provider: "owner-workflow-fixture",
	models: [
		{ id: "parent", contextWindow: 100000 },
		{ id: "child", contextWindow: 100000 },
	],
});
const task = {
	agent: "fixture-writer",
	task: "Execute the fixed local fixture.",
	context: "fresh",
	worktree: false,
	model: "owner-workflow-fixture/child",
	thinking: "off",
	acceptance: false,
	skill: false,
	output: false,
};
let launched = false;
faux.setResponses(
	Array.from({ length: 12 }, () => () => {
		if (!launched && phase === "start") {
			launched = true;
			return fauxAssistantMessage(
				[
					fauxToolCall(
						"subagent",
						{
							workflowScript: `return await runs.run("writer", ${JSON.stringify(task)});`,
							async: true,
							mission: false,
							agentScope: "project",
							acceptance: false,
							model: "owner-workflow-fixture/child",
							thinking: "off",
							context: "fresh",
							timeoutMs: 90000,
							output: false,
							artifacts: true,
							skill: false,
						},
						{ id: "launch-workflow" },
					),
				],
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage([fauxText("ACK")], { stopReason: "stop" });
	}),
);
runtime.registerProvider(faux.provider.id, {
	name: faux.provider.name,
	api: faux.api,
	apiKey: "fixture-not-a-credential",
	streamSimple: faux.provider.streamSimple,
	models: [...faux.models],
});
const settings = pi.SettingsManager.inMemory({
	retry: { enabled: false },
	compaction: { enabled: false },
});
const loader = new pi.DefaultResourceLoader({
	cwd: config.cwd,
	agentDir: config.agentDir,
	settingsManager: settings,
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
	additionalExtensionPaths: [
		path.join(config.source, "src/extension/index.ts"),
	],
	systemPromptOverride: () =>
		"Execute the fixed workflow once. Reply ACK to subsequent notifications.",
});
await loader.reload();
if (loader.getExtensions().errors.length)
	throw Error("Package extension loading failed");
const prior =
	phase === "inspect"
		? JSON.parse(fs.readFileSync(path.join(config.cwd, "handoff.json"), "utf8"))
		: undefined;
if (prior) {
	const relative = path.relative(
		fs.realpathSync(config.cwd),
		fs.realpathSync(prior.sessionFile),
	);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
		throw Error("Session escaped its private fixture");
	if (!/^[a-f0-9-]{36}$/i.test(prior.runId))
		throw Error("Invalid fixture run identity");
}
const sm = prior
	? pi.SessionManager.open(prior.sessionFile)
	: pi.SessionManager.create(config.cwd, path.join(config.cwd, "sessions"));
const { session } = await pi.createAgentSession({
	cwd: config.cwd,
	agentDir: config.agentDir,
	modelRuntime: runtime,
	model: runtime.getModel(faux.provider.id, "parent"),
	thinkingLevel: "off",
	tools: ["subagent", "subagent_wait"],
	resourceLoader: loader,
	settingsManager: settings,
	sessionManager: sm,
});
let extensionErrors = 0;
await session.bindExtensions({
	mode: "print",
	onError: () => extensionErrors++,
});
const text = (r) =>
	r?.content
		?.filter((p) => p.type === "text")
		.map((p) => p.text)
		.join("\n") ?? "";
const categories = (r) => ({
	isError: r?.isError === true,
	ownerUnknown: /owner cannot be verified|Descendant execution.*unknown/i.test(
		text(r),
	),
	unknownAgent: /unknown agent|not found/i.test(text(r)),
	modelError: /model|provider/i.test(text(r)) && r?.isError === true,
});
const call = async (args) => {
	const tool = session.agent.state.tools.find((t) => t.name === "subagent");
	if (!tool) throw Error("Subagent tool inactive");
	return await tool.execute(
		"inspect",
		args,
		new AbortController().signal,
		() => {},
	);
};
let handoff;
session.subscribe((event) => {
	if (event.type === "tool_execution_end" && event.toolName === "subagent") {
		const r = event.result;
		const runId = r?.details?.asyncId ?? r?.details?.runId;
		save("launch.json", {
			...categories(r),
			hasRunId: Boolean(runId),
			validationError:
				r?.isError === true &&
				/invalid|cannot combine|unsupported|must|requires/i.test(text(r)),
		});
		if (runId) {
			handoff = {
				runId,
				parentPid: process.pid,
				sessionFile: sm.getSessionFile(),
				sessionId: sm.getSessionId(),
			};
			save("handoff.json", handoff);
		}
	}
});
// Optional fixture barrier separates SDK/module cold start from the child
// startup deadline. It never admits a task until the driver releases it.
if (config.parentBarrier && phase === "start") {
	save("parent-ready.json", { pid: process.pid, at: Date.now() });
	const release = path.join(config.cwd, "parent-release");
	await new Promise((resolve, reject) => {
		const watcher = fs.watch(config.cwd, () => { if (fs.existsSync(release)) done(); });
		const timer = setTimeout(() => { watcher.close(); reject(Error("Parent fixture release unavailable")); }, 30000);
		function done() { clearTimeout(timer); watcher.close(); resolve(); }
		if (fs.existsSync(release)) done();
	});
}
const timer = setTimeout(() => void session.abort(), 100000);
try {
	if (phase === "start") await session.prompt("Run the fixture workflow once.");
	else {
		const status = await call({ action: "status", id: prior.runId });
		const resume = config.tryResume
			? await call({
					action: "resume",
					id: prior.runId,
					message: "Continue the same fixed fixture.",
				})
			: undefined;
		save("inspection.json", {
			sameSession: sm.getSessionId() === prior.sessionId,
			status: categories(status),
			resume: resume ? categories(resume) : undefined,
			extensionErrors,
		});
	}
} finally {
	clearTimeout(timer);
	save(`${phase}-settled.json`, {
		extensionErrors,
		sessionId: sm.getSessionId(),
		parentPid: process.pid,
	});
	await session.abort();
	await session.extensionRunner.emit({
		type: "session_shutdown",
		reason: "quit",
	});
	session.dispose();
}
