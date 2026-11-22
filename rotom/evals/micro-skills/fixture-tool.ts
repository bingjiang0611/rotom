import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// A launched test may fail normally. A spawn error, timeout or signal is infrastructure.
// Some test runners exit zero without executing anything, so round two checks the output too.
export function runCheck({ bin, args, cwd, env, timeout, expect }) {
	const result = spawnSync(bin, args, { cwd, env, encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
	if (result.error || result.signal || result.status === null) {
		return { ok: false, infrastructure: true, text: "Check could not execute to completion." };
	}
	const text = `${result.stdout}\n${result.stderr}`.trim();
	return {
		ok: result.status === 0 && (!expect || new RegExp(expect, "m").test(text)),
		infrastructure: false, text: text.slice(-2500) || `Check exited with status ${result.status}.`,
	};
}

// Eval only. The model cannot supply a path to open or a process/argv to run.
export function fixtureAction(fixture, input) {
	if (input.action === "list") return { ok: true, text: Object.keys(fixture.files).join("\n") };
	if (input.action === "read" && Object.hasOwn(fixture.files, input.name)) {
		return { ok: true, text: fixture.files[input.name] };
	}
	if (input.action === "run") {
		if (fixture.commands && Object.hasOwn(fixture.commands, input.name)) {
			const check = fixture.commands[input.name];
			const { ok, infrastructure, text } = runCheck(check);
			const summary = text.split("\n").find(line => /No test files|No tests|Tests\s+[1-9][0-9]* passed|Ran [1-9][0-9]* tests?/.test(line));
			return { ok, infrastructure, check: check.id, verified: ok && check.id === "target",
				text: infrastructure ? text : `${ok ? "Check passed." : "Check did not pass."}${summary ? ` ${summary.trim()}` : ""}` };
		}
		if (fixture.argv && input.name === fixture.argv.join(" ")) {
			const result = runCheck({ bin: fixture.python, args: fixture.argv.slice(1), cwd: fixture.root, timeout: 12_000, env: {} });
			// Round one expects just the code on stdout; Python's unittest summary goes to stderr.
			return { ...result, text: result.text.match(/^CHECK-\d+$/m)?.[0] ?? result.text };
		}
		return { ok: false, check: "unavailable", text: "Command unavailable in this fixture." };
	}
	return { ok: false, text: "No such action or file." };
}

export default function (pi) {
	const specPath = process.env.ROTOM_MICRO_SKILLS_FIXTURE;
	if (!specPath) throw new Error("Missing fixture path");
	const fixture = JSON.parse(readFileSync(specPath, "utf8"));
	if (fixture.dryPrompt) {
		// The offline prompt probe aborts before the agent loop. Even if abort regresses,
		// its only possible provider address is loopback, with no live credentials.
		pi.registerProvider("micro-offline", {
			baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "offline-probe",
			models: [{ id: "probe", name: "Offline probe", reasoning: false, input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000, maxTokens: 100 }],
		});
	}
	const trace = { scopeOk: false, limitHit: false, answerOk: false, calls: [], messages: [] };
	if (fixture.dryPrompt) pi.on("before_provider_request", () => { trace.providerRequest = true; save(); });
	const save = () => writeFileSync(resolve(fixture.root, "trace.json"), JSON.stringify(trace), { mode: 0o600 });
	pi.registerTool({
		name: "workspace", label: "Fixture workspace",
		description: "List or read files in the task workspace, or run a verification command by exact spelling. Paths are relative to the repository root.",
		parameters: {
			type: "object", properties: {
				action: { type: "string", enum: ["list", "read", "run"] },
				name: { type: "string", description: "Exact file name or command; omit for list." },
			}, required: ["action"], additionalProperties: false,
		},
		async execute(_id, input) {
			const result = fixtureAction(fixture, input);
			trace.calls.push({ action: input.action, ok: result.ok, infrastructure: !!result.infrastructure,
				...(result.check ? { check: result.check, verified: !!result.verified } : {}) });
			save();
			return { content: [{ type: "text", text: result.text }], details: {}, isError: !result.ok };
		},
	});
	pi.on("before_agent_start", (event, ctx) => {
		const names = pi.getActiveTools();
		trace.scopeOk = names.length === 1 && names[0] === "workspace";
		if (fixture.promptCheck) {
			const { note, arm } = fixture.promptCheck;
			const hits = event.systemPrompt.split(note).length - 1;
			const options = event.systemPromptOptions;
			const context = options.contextFiles.some(file => file.content.includes(note));
			trace.promptCheck = { bytes: Buffer.byteLength(event.systemPrompt), hits, context };
			trace.scopeOk &&= !options.customPrompt && options.contextFiles.length === (arm === "B" ? 1 : 0) &&
				hits === (arm === "A" ? 0 : 1) && context === (arm === "B");
		}
		save();
		if (!trace.scopeOk || fixture.dryPrompt) ctx.abort();
	});
	pi.on("tool_call", (event, ctx) => {
		if (!trace.scopeOk || event.toolName !== "workspace") {
			trace.scopeOk = false;
			save();
			ctx.abort();
			return { block: true, reason: "Outside fixture tool scope" };
		}
		if (trace.calls.length >= 10) {
			trace.limitHit = true;
			save();
			ctx.abort();
			return { block: true, reason: "Fixture tool-call limit" };
		}
	});
	pi.on("message_end", ({ message }) => {
		if (message.role === "assistant") {
			trace.messages.push({ usage: message.usage, stopReason: message.stopReason, model: message.model, provider: message.provider });
			trace.answerOk = message.stopReason === "stop" && message.content.filter(block => block.type === "text")
				.map(block => block.text).join("").trim() === (fixture.code ?? "PASS");
			save();
		}
	});
}
