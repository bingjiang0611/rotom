// Loaded by the actual Pi CLI via the agent's subagentOnlyExtensions setting.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
export default async function (pi) {
	const config = JSON.parse(
		fs.readFileSync(process.env.OWNER_WORKFLOW_CONFIG, "utf8"),
	);
	const { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } =
		await import(pathToFileURL(config.fauxEntry).href);
	const faux = fauxProvider({
		provider: "owner-workflow-fixture",
		models: [{ id: "child", contextWindow: 100000 }],
	});
	const quote = (s) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
	faux.setResponses([
		() =>
			fauxAssistantMessage(
				[
					fauxToolCall(
						"bash",
						{
							command: `exec ${quote(process.execPath)} ${quote(path.join(config.cwd, "writer.mjs"))}`,
							timeout: 40,
						},
						{ id: "writer" },
					),
				],
				{ stopReason: "toolUse" },
			),
		() =>
			fauxAssistantMessage([fauxText("FIXTURE_DONE")], { stopReason: "stop" }),
	]);
	pi.registerProvider(faux.provider.id, {
		name: faux.provider.name,
		api: faux.api,
		apiKey: "fixture-not-a-credential",
		streamSimple: faux.provider.streamSimple,
		models: [...faux.models],
	});
	const save = (suffix, data) =>
		fs.writeFileSync(
			path.join(config.cwd, `${process.pid}.${suffix}.json`),
			JSON.stringify(data),
			{ mode: 0o600 },
		);
	let modelCalls = 0,
		inputCount = 0;
	pi.on("before_provider_request", () => {
		save("model-call", { count: ++modelCalls });
	});
	pi.on("input", (event) => {
		save("input", { count: ++inputCount, source: event.source });
	});
	pi.on("session_start", (_event, ctx) =>
		save("child-start", {
			pid: process.pid,
			mode: ctx.mode,
			taskArgument: process.argv.some(
				(arg) => arg.startsWith("Task: ") || arg.startsWith("@"),
			),
			ppid: process.ppid,
			lifeline: process.env.PI_SUBAGENT_OWNER_LIFELINE_FD ?? null,
			runtimeRequested: process.argv.includes(config.childRuntime),
			cliRequested: process.argv[1] === config.piExecutable,
			cwdMatches:
				fs.realpathSync(process.cwd()) === fs.realpathSync(config.cwd),
		}),
	);
	pi.on("agent_end", () => save("child-end", { agentEnded: true }));
	pi.on("session_shutdown", () => save("child-shutdown", { shutdown: true }));
}
