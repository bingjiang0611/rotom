// Public SDK + real CLI, faux-only. Hold exactly the runner's native close
// callback until its originating extension API is retired. No task replay.
import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
const c = JSON.parse(fs.readFileSync(process.env.FOLLOWTHROUGH_CONFIG, "utf8"));
let releaseClose;
let resolveClose;
const closed = new Promise((r) => (resolveClose = r));
let launches = 0;
let childRunId, childRunDir;
const original = cp.spawn;
cp.spawn = function (command, args, options) {
	const proc = original.call(this, command, args, options);
	if (
		args?.includes(
			path.join(c.source, "src/runs/background/subagent-runner.ts"),
		)
	) {
		launches++;
		const launch = JSON.parse(fs.readFileSync(args.at(-1), "utf8"));
		childRunId = launch.id;
		childRunDir = launch.asyncDir;
		const once = proc.once;
		proc.once = function (event, listener) {
			if (event !== "close") return once.call(this, event, listener);
			this.once = once;
			return once.call(this, event, (...values) => {
				releaseClose = () => listener.apply(proc, values);
				resolveClose();
			});
		};
	}
	return proc;
};
syncBuiltinESMExports();
const pi = await import(pathToFileURL(c.piEntry).href);
const { fauxProvider, fauxAssistantMessage, fauxText } = await import(
	pathToFileURL(c.fauxEntry).href
);
const fx = fauxProvider({
	provider: "followthrough-fixture",
	models: [
		{ id: "parent", contextWindow: 100000 },
		{ id: "child", contextWindow: 100000 },
	],
});
fx.setResponses([
	() =>
		fauxAssistantMessage([fauxText("FIXTURE_DONE")], { stopReason: "stop" }),
]);
const runtime = await pi.ModelRuntime.create({
	authPath: path.join(c.agentDir, "auth.json"),
	modelsPath: null,
	allowModelNetwork: false,
});
runtime.registerProvider(fx.provider.id, {
	name: fx.provider.name,
	api: fx.api,
	apiKey: "fixture-not-a-credential",
	streamSimple: fx.provider.streamSimple,
	models: [...fx.models],
});
const settings = pi.SettingsManager.inMemory({
	retry: { enabled: false },
	compaction: { enabled: false },
});
const loader = new pi.DefaultResourceLoader({
	cwd: c.cwd,
	agentDir: c.agentDir,
	settingsManager: settings,
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
	additionalExtensionPaths: [path.join(c.source, "src/extension/index.ts")],
	systemPromptOverride: () => "Fixed local fixture only.",
});
await loader.reload();
if (loader.getExtensions().errors.length) throw Error("fixture loader failed");
const { session } = await pi.createAgentSession({
	cwd: c.cwd,
	agentDir: c.agentDir,
	modelRuntime: runtime,
	model: runtime.getModel(fx.provider.id, "parent"),
	thinkingLevel: "off",
	tools: ["subagent", "subagent_wait"],
	resourceLoader: loader,
	settingsManager: settings,
	sessionManager: pi.SessionManager.create(c.cwd, path.join(c.cwd, "sessions")),
});
let extensionErrors = 0;
await session.bindExtensions({
	mode: "print",
	onError: () => extensionErrors++,
});
const tool = session.agent.state.tools.find((t) => t.name === "subagent");
if (!tool) throw Error("fixture subagent inactive");
const result = await tool.execute(
	"fixed-launch",
	{
		workflowScript:
			'return await runs.run("main", {agent:"fixture",task:"Return FIXTURE_DONE only.",async:true,thinking:"off",acceptance:false,output:false,skill:false});',
		async: true,
		mission: false,
		agentScope: "project",
		model: "followthrough-fixture/child",
		thinking: "off",
		context: "fresh",
		acceptance: false,
		artifacts: false,
		output: false,
		skill: false,
		timeoutMs: 30000,
	},
	undefined,
	() => {},
);
const runId = result?.details?.asyncId ?? result?.details?.runId;
if (result.isError || !runId) throw Error("fixture launch failed");
let timer;
await Promise.race([
	closed,
	new Promise((_, reject) => {
		timer = setTimeout(
			() => reject(Error("direct runner close unconfirmed")),
			45000,
		);
	}),
]);
clearTimeout(timer);
if (launches !== 1 || !releaseClose)
	throw Error("exact close callback was not intercepted");
const beforeStatus = JSON.parse(
	fs.readFileSync(path.join(childRunDir, "status.json"), "utf8"),
).state;
if (c.retirement === "reload") await session.reload();
else {
	await session.extensionRunner.emit({
		type: "session_shutdown",
		reason: "quit",
	});
	session.dispose();
}
let staleError = false;
let unexpectedError = false;
try {
	releaseClose();
} catch (error) {
	staleError =
		/extension ctx is stale|stale after session replacement or reload/i.test(
			error?.message ?? "",
		);
	unexpectedError = !staleError;
}
const runDir = childRunDir;
if (
	!childRunId ||
	!runDir?.startsWith(process.env.PI_SUBAGENTS_TEMP_ROOT + path.sep)
)
	throw Error("child identity escaped fixture");
const { readProcessTerminal } = await import(
	pathToFileURL(path.join(c.source, "src/runs/background/process-terminal.ts"))
		.href
);
const proof = readProcessTerminal(runDir);
const status = JSON.parse(
	fs.readFileSync(path.join(runDir, "status.json"), "utf8"),
);
if (c.retirement === "reload") {
	await session.extensionRunner.emit({
		type: "session_shutdown",
		reason: "quit",
	});
	session.dispose();
}
cp.spawn = original;
syncBuiltinESMExports();
fs.writeFileSync(
	path.join(c.cwd, "result.json"),
	JSON.stringify({
		retirement: c.retirement,
		directCloseObserved: true,
		launches,
		staleError,
		unexpectedError,
		extensionErrors,
		beforeStatus,
		status: status.state,
		proofState: proof?.state,
		proofRunMatches: proof?.runId === childRunId,
	}),
	{ mode: 0o600 },
);
