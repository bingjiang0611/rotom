// Maintenance-only actual Pi SDK / local faux-provider fixture. No credentials or network.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
// Fixture watchdog covers SDK loading too; do not rely on tool cancellation.
const hardDeadline = setTimeout(() => process.exit(3), 55000);
const stage = (value) =>
	fs.writeFileSync(
		path.join(config.cwd, "stage.json"),
		JSON.stringify({ stage: value }),
		{ mode: 0o600 },
	);
stage("import");
globalThis.fetch = () => {
	throw new Error("Network forbidden in lifeline fixture");
};
const pi = await import(pathToFileURL(config.piEntry).href);
const { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } =
	await import(pathToFileURL(config.fauxEntry).href);
stage("model-runtime");
const home = path.join(config.cwd, "config");
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const runtime = await pi.ModelRuntime.create({
	authPath: path.join(home, "auth.json"),
	modelsPath: null,
	allowModelNetwork: false,
});
const faux = fauxProvider({
	provider: "lifeline-fixture",
	models: [{ id: "child", contextWindow: 10000 }],
});
runtime.registerProvider(faux.provider.id, {
	name: faux.provider.name,
	api: faux.api,
	apiKey: "fixture-not-a-credential",
	streamSimple: faux.provider.streamSimple,
	models: [...faux.models],
});
let calls = 0;
faux.setResponses([
	() => {
		calls++;
		return fauxAssistantMessage(
			[
				fauxToolCall(
					config.noncooperative ? "stubborn" : "bash",
					{
						command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(config.cwd, "tool.mjs"))}`,
						timeout: 30,
					},
					{ id: "fixture-tool" },
				),
			],
			{ stopReason: "toolUse" },
		);
	},
	() => {
		calls++;
		return fauxAssistantMessage([fauxText("DONE")], { stopReason: "stop" });
	},
]);
const settings = pi.SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: false },
});
const loader = new pi.DefaultResourceLoader({
	cwd: config.cwd,
	agentDir: home,
	settingsManager: settings,
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
	additionalExtensionPaths: config.guardExtension
		? [config.guardExtension]
		: [],
	systemPromptOverride: () => "Execute the local fixture.",
});
stage("loader");
await loader.reload();
if (loader.getExtensions().errors.length)
	throw new Error("Fixture extension loading failed");
const bash = pi.createBashTool(config.cwd);
if (config.noncooperative)
	bash.execute = async (_id, _args, signal) =>
		await new Promise((resolve) => {
			// Acknowledge, but deliberately do not honor cancellation. The release
			// handshake proves a write after abort, without guessing from a sleep.
			const aborted = () => fs.writeFileSync(path.join(config.cwd, "abort-seen"), "seen");
			if (signal?.aborted) aborted();
			else signal?.addEventListener("abort", aborted, { once: true });
			const watcher = fs.watch(config.cwd, () => {
				if (fs.existsSync(path.join(config.cwd, "release"))) {
					fs.writeFileSync(path.join(config.cwd, "late-write"), "written");
					watcher.close();
					resolve({
						content: [{ type: "text", text: "fixture complete" }],
						details: {},
					});
				}
			});
			fs.writeFileSync(
				path.join(config.cwd, "tool-ready"),
				JSON.stringify({ pid: process.pid, leaf: process.pid }),
			);
			fs.writeFileSync(
				path.join(config.cwd, "leaf-ready"),
				String(process.pid),
			);
		});
stage("create-session");
const { session } = await pi.createAgentSession({
	cwd: config.cwd,
	agentDir: home,
	modelRuntime: runtime,
	model: runtime.getModel(faux.provider.id, "child"),
	thinkingLevel: "off",
	tools: [config.noncooperative ? "stubborn" : "bash"],
	customTools: config.noncooperative
		? [{ ...bash, name: "stubborn", label: "Fixture stubborn tool" }]
		: [],
	resourceLoader: loader,
	settingsManager: settings,
	sessionManager: pi.SessionManager.inMemory(),
});
if (
	!session.agent.state.tools.some(
		(tool) => tool.name === (config.noncooperative ? "stubborn" : "bash"),
	)
)
	throw new Error("Fixture tool is not active");
const errors = [];
await session.bindExtensions({
	mode: "print",
	onError: () => errors.push("extension-error"),
});
stage("prompt");
const cancellation = fs.watch(config.cwd, () => {
	if (!fs.existsSync(path.join(config.cwd, "cancel"))) return;
	cancellation.close();
	fs.writeFileSync(path.join(config.cwd, "abort-requested"), "requested");
	void session.abort();
});
const timer = setTimeout(() => void session.abort(), 45000);
let promptError = false;
try {
	await session.prompt("Run the fixture.");
} catch {
	promptError = true;
} finally {
	clearTimeout(timer);
	cancellation.close();
	const toolResults = session.messages.filter((m) => m.role === "toolResult");
	const metadata = {
		piVersion: pi.VERSION,
		modelCalls: calls,
		promptError,
		toolResults: toolResults.length,
		toolErrors: toolResults.filter((m) => m.isError).length,
		extensionErrors: errors.length,
	};
	await session.abort();
	await session.extensionRunner.emit({
		type: "session_shutdown",
		reason: "quit",
	});
	session.dispose();
	// File existence is the parent's readiness signal. Publish a complete JSON
	// record atomically; creating the final file before writing exposes emptiness.
	const resultTemporary = path.join(config.cwd, ".sdk-result.json.tmp");
	fs.writeFileSync(resultTemporary, JSON.stringify(metadata), { mode: 0o600, flag: "wx" });
	fs.renameSync(resultTemporary, path.join(config.cwd, "sdk-result.json"));
	clearTimeout(hardDeadline);
}
