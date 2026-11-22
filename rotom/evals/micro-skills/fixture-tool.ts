import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Eval only. The model cannot supply a path to open or a process/argv to run.
export function fixtureAction(fixture, input) {
	if (input.action === "list") return { ok: true, text: Object.keys(fixture.files).join("\n") };
	if (input.action === "read" && Object.hasOwn(fixture.files, input.name)) {
		return { ok: true, text: fixture.files[input.name] };
	}
	if (input.action === "run" && input.name === fixture.argv.join(" ")) {
		const result = spawnSync(fixture.python, fixture.argv.slice(1), {
			cwd: fixture.root, encoding: "utf8", timeout: 3_000, env: {},
		});
		return {
			ok: result.status === 0, infrastructure: result.status !== 0,
			text: result.stdout || "Fixture check failed to execute.",
		};
	}
	return { ok: false, text: input.action === "run" ? "Command unavailable in this fixture." : "No such action or file." };
}

export default function (pi) {
	const specPath = process.env.ROTOM_MICRO_SKILLS_FIXTURE;
	if (!specPath) throw new Error("Missing fixture path");
	const fixture = JSON.parse(readFileSync(specPath, "utf8"));
	const trace = { scopeOk: false, limitHit: false, answerOk: false, calls: [], messages: [] };
	const save = () => writeFileSync(resolve(fixture.root, "trace.json"), JSON.stringify(trace), { mode: 0o600 });
	pi.registerTool({
		name: "workspace", label: "Fixture workspace",
		description: "Inspect the synthetic workspace or run a documented verification command by exact spelling.",
		parameters: {
			type: "object", properties: {
				action: { type: "string", enum: ["list", "read", "run"] },
				name: { type: "string", description: "Exact file name or command; omit for list." },
			}, required: ["action"], additionalProperties: false,
		},
		async execute(_id, input) {
			const result = fixtureAction(fixture, input);
			trace.calls.push({ action: input.action, ok: result.ok, infrastructure: !!result.infrastructure });
			save();
			return { content: [{ type: "text", text: result.text }], details: {}, isError: !result.ok };
		},
	});
	pi.on("before_agent_start", () => {
		const names = pi.getActiveTools();
		trace.scopeOk = names.length === 1 && names[0] === "workspace";
		save();
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
				.map(block => block.text).join("").trim() === fixture.code;
			save();
		}
	});
}
