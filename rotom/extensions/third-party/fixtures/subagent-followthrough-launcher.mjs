// Real launcher through public models.json, not an injected extension (which
// the product correctly rejects). Local deterministic HTTP responses only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
const [productInput, piInput] = process.argv.slice(2);
assert.ok(
	productInput && piInput,
	"usage: fixture <isolated rotom dir> <verified Pi executable>",
);
const product = fs.realpathSync(productInput),
	pi = fs.realpathSync(piInput);
fs.accessSync(path.join(product, "bin/rotom-launcher"), fs.constants.X_OK);
fs.accessSync(pi, fs.constants.X_OK);
const root = fs.mkdtempSync(
	path.join(os.tmpdir(), "dev-agent-launcher-loopback-"),
);
fs.chmodSync(root, 0o700);
const agentDir = path.join(root, "home/.pi/agent");
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(root, "tmp"));
const summary = {
	requests: 0,
	cwdMatches: false,
	initialDeferred: false,
	terminalPolicyVisible: false,
	exit: null,
	directCloseObserved: false,
};
const server = http.createServer(async (req, res) => {
	try {
		assert.equal(req.method, "POST");
		assert.equal(req.url, "/v1/chat/completions");
		const chunks = [];
		let bytes = 0;
		for await (const chunk of req) {
			bytes += chunk.length;
			if (bytes > 1024 * 1024) throw Error("request budget");
			chunks.push(chunk);
		}
		const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		const n = ++summary.requests;
		assert.ok(n <= 3, "no model-request replay");
		const tools = (data.tools ?? []).map((t) => t.function);
		if (n === 1)
			summary.initialDeferred =
				tools.some((t) => t.name === "search_tools") &&
				!tools.some((t) => t.name === "subagent");
		if (n === 2)
			summary.cwdMatches = data.messages.some(
				(m) =>
					m.role === "tool" &&
					m.tool_call_id === "fixture-pwd" &&
					typeof m.content === "string" &&
					m.content.trim() === fs.realpathSync(root),
			);
		if (n === 3)
			summary.terminalPolicyVisible = Boolean(
				tools.find((t) => t.name === "subagent_wait")?.parameters?.properties
					?.until,
			);
		const delta =
			n === 3
				? { role: "assistant", content: "FIXTURE_DONE" }
				: {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: n === 1 ? "fixture-pwd" : "fixture-discover",
								type: "function",
								function: {
									name: n === 1 ? "bash" : "search_tools",
									arguments: JSON.stringify(
										n === 1
											? { command: "pwd" }
											: { query: "Subagent", limit: 1 },
									),
								},
							},
						],
					};
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
		});
		const frame = (d, reason) => ({
			id: "fixture-" + n,
			object: "chat.completion.chunk",
			created: 0,
			model: "fixed",
			choices: [{ index: 0, delta: d, finish_reason: reason }],
		});
		res.write("data: " + JSON.stringify(frame(delta, null)) + "\n\n");
		res.write(
			"data: " +
				JSON.stringify(frame({}, n === 3 ? "stop" : "tool_calls")) +
				"\n\n",
		);
		res.end("data: [DONE]\n\n");
	} catch {
		res.writeHead(400);
		res.end("fixture protocol rejected");
	}
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = "http://127.0.0.1:" + server.address().port;
const save = (name, value) =>
	fs.writeFileSync(path.join(agentDir, name), JSON.stringify(value), {
		mode: 0o600,
	});
save("models.json", {
	providers: {
		"followthrough-loopback": {
			baseUrl: origin + "/v1",
			api: "openai-completions",
			apiKey: "fixture-not-a-credential",
			models: [
				{
					id: "fixed",
					reasoning: false,
					contextWindow: 128000,
					maxTokens: 1024,
				},
			],
		},
	},
});
save("settings.json", {
	retry: { enabled: false },
	compaction: { enabled: false },
});
const preload = path.join(root, "network.mjs");
fs.writeFileSync(
	preload,
	`const native=globalThis.fetch;globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'?input:input.url??String(input));if(u.origin!==${JSON.stringify(origin)}||u.pathname!=='/v1/chat/completions')throw Error('Non-fixture fetch forbidden');return native(input,init);};`,
	{ mode: 0o600 },
);
const env = {
	PATH: process.env.PATH,
	HOME: path.join(root, "home"),
	TMPDIR: path.join(root, "tmp"),
	LANG: "en_US.UTF-8",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	ROTOM_NODE: process.execPath,
	ROTOM_PI: pi,
	ROTOM_OBSERVABILITY: "0",
	NODE_OPTIONS: "--import " + preload,
};
assert.equal(
	spawnSync("git", ["init", "-q"], { cwd: root, env, timeout: 5000 }).status,
	0,
);
const fd = fs.openSync(path.join(root, "cli.log"), "wx", 0o600);
const child = spawn(
	path.join(product, "bin/rotom-launcher"),
	[
		"--mode",
		"json",
		"--no-session",
		"--model",
		"followthrough-loopback/fixed",
		"--thinking",
		"off",
		"-p",
		"Run the fixed local verification sequence.",
	],
	{ cwd: root, env, stdio: ["ignore", fd, fd], detached: true },
);
let expired = false;
const timer = setTimeout(() => {
	expired = true;
	if (child.exitCode === null && child.signalCode === null) {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch (error) {
			if (error.code !== "ESRCH") throw error;
		}
	}
}, 45000);
const killTimer = setTimeout(() => {
	if (child.exitCode === null && child.signalCode === null) {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch (error) {
			if (error.code !== "ESRCH") throw error;
		}
	}
}, 48000);
try {
	const [code] = await once(child, "close");
	summary.exit = code;
	summary.directCloseObserved = true;
} finally {
	clearTimeout(timer);
	clearTimeout(killTimer);
	fs.closeSync(fd);
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
}
fs.writeFileSync(
	path.join(root, "result.json"),
	JSON.stringify({ ...summary, expired }),
	{ mode: 0o600 },
);
console.log(JSON.stringify({ ...summary, expired, privateRoot: root }));
assert.equal(expired, false);
assert.equal(summary.exit, 0);
assert.equal(summary.requests, 3);
assert.equal(summary.cwdMatches, true);
assert.equal(summary.initialDeferred, true);
assert.equal(summary.terminalPolicyVisible, true);
