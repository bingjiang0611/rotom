// Maintenance only: apply candidates to a private source copy, never installed code.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-agent-startup-unit-"));
const installed = fileURLToPath(
	new URL("./node_modules/pi-subagents/", import.meta.url),
);
assert.equal(
	JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"))
		.version,
	"0.52.1",
);
fs.cpSync(path.join(installed, "src"), path.join(root, "src"), {
	recursive: true,
});
fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
const env = { ...process.env };
delete env.GIT_DIR;
delete env.GIT_WORK_TREE;
for (const name of ["lifeline", "startup"]) {
	const p = spawnSync(
		"git",
		[
			"apply",
			"--unidiff-zero",
			fileURLToPath(
				new URL(`./subagent-${name}-candidate.patch`, import.meta.url),
			),
		],
		{ cwd: root, env, encoding: "utf8", timeout: 10000 },
	);
	assert.ifError(p.error);
	assert.equal(p.status, 0, p.stderr);
}
const {
	createStartupTransport,
	STARTUP_STATUS_PREFIX,
	STARTUP_READY,
	STARTUP_TOKEN_ENV,
} = await import(
	pathToFileURL(path.join(root, "src/runs/shared/startup-transport.ts")).href
);
const { registerOwnerLifeline } = await import(
	pathToFileURL(path.join(root, "src/runs/shared/owner-lifeline.ts")).href
);
const { buildPiArgs } = await import(
	pathToFileURL(path.join(root, "src/runs/shared/pi-args.ts")).href
);
after(async () => {
	await fs.promises.rm(root, { recursive: true, force: true });
});
test("readiness requires an opened reader and is invalidated by loss or shutdown", () => {
	for (const loss of ["end", "shutdown"]) {
		const handlers = new Map(),
			channel = new EventEmitter();
		let resumed = false;
		channel.resume = () => {
			resumed = true;
		};
		channel.unref = () => {};
		channel.destroy = () => channel.emit("close");
		const guard = registerOwnerLifeline(
			{ on: (name, fn) => handlers.set(name, fn) },
			{ fd: "3", open: () => channel },
		);
		assert.equal(guard.isReady(), false);
		handlers.get("session_start")({}, { abort() {}, shutdown() {} });
		assert.equal(resumed, true);
		assert.equal(guard.isReady(), true);
		if (loss === "shutdown") handlers.get("session_shutdown")();
		else channel.emit("end");
		assert.equal(guard.isReady(), false);
		channel.destroy();
	}
});
const token = "11111111-1111-4111-8111-111111111111";
function harness(t, mode) {
	const writes = [],
		errors = [];
	const stdin = new EventEmitter();
	stdin.write = (text, cb) => {
		writes.push(JSON.parse(text));
		if (mode === "throw") throw Error("private fixture body");
		if (mode === "write-error" && writes.length === 2)
			cb(Error("private fixture body"));
		else cb();
		return mode !== "backpressure";
	};
	const gate = createStartupTransport({
		stdin,
		token,
		task: "fixture\ntext\u2028not a frame",
		fail: (m) => errors.push(m),
	});
	t.after(() => gate.dispose());
	const ready = () =>
		gate.record({
			type: "extension_ui_request",
			method: "setStatus",
			statusKey: STARTUP_STATUS_PREFIX + token,
			statusText: STARTUP_READY,
		});
	const idle = () =>
		gate.record({
			type: "response",
			command: "get_state",
			id: token + "/state",
			success: true,
			data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
		});
	return { gate, writes, errors, stdin, ready, idle };
}
test("no RPC probe or task before exact ready; one dispatch after idle confirmation", (t) => {
	const h = harness(t);
	h.gate.start();
	h.gate.start();
	assert.equal(h.writes.length, 0);
	h.ready();
	assert.deepEqual(
		h.writes.map((x) => x.type),
		["get_state"],
	);
	h.idle();
	h.ready();
	h.idle();
	assert.deepEqual(
		h.writes.map((x) => x.type),
		["get_state", "prompt"],
	);
	assert.equal(h.writes[1].message, "Task: fixture\ntext\u2028not a frame");
	assert.equal(h.errors.length, 0);
});
test("foreign ready never unlocks even a probe", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness(t);
	h.gate.start();
	h.gate.record({
		type: "extension_ui_request",
		method: "setStatus",
		statusKey: STARTUP_STATUS_PREFIX + "foreign",
		statusText: STARTUP_READY,
	});
	t.mock.timers.tick(10000);
	assert.equal(h.writes.length, 0);
	assert.equal(h.errors.length, 1);
	assert.match(h.errors[0], /not dispatched/);
});
test("an unsolicited idle reply cannot replace readiness", (t) => {
	const h = harness(t);
	h.gate.start();
	h.idle();
	h.ready();
	assert.equal(h.writes.length, 0);
	assert.equal(h.errors.length, 1);
});
for (const data of [
	{ isStreaming: true, isCompacting: false, pendingMessageCount: 0 },
	{ isStreaming: false, isCompacting: true, pendingMessageCount: 0 },
	{ isStreaming: false, isCompacting: false, pendingMessageCount: 1 },
	{},
])
	test(
		"non-idle or incomplete state fails closed " + JSON.stringify(data),
		(t) => {
			const h = harness(t);
			h.gate.start();
			h.ready();
			h.gate.record({
				type: "response",
				command: "get_state",
				id: token + "/state",
				success: true,
				data,
			});
			h.idle();
			assert.equal(h.writes.length, 1);
			assert.equal(h.errors.length, 1);
		},
	);
test("wrong version and unsupported dialogs do not dispatch", (t) => {
	for (const record of [
		{
			type: "extension_ui_request",
			method: "setStatus",
			statusKey: STARTUP_STATUS_PREFIX + token,
			statusText: "ready:v0",
		},
		{ type: "extension_ui_request", method: "confirm", id: "dialog" },
	]) {
		const h = harness(t);
		h.gate.start();
		h.gate.record(record);
		h.ready();
		h.idle();
		assert.equal(h.writes.length, 0);
		assert.equal(h.errors.length, 1);
	}
});
for (const type of ["agent_start", "tool_execution_start", "extension_error"])
	test("unexpected pre-admission event " + type, (t) => {
		const h = harness(t);
		h.gate.start();
		h.gate.record({ type });
		h.ready();
		assert.equal(h.writes.length, 0);
		assert.equal(h.errors.length, 1);
	});
test("write failure is unknown, sanitized and never replayed", (t) => {
	const h = harness(t, "write-error");
	h.gate.start();
	h.ready();
	h.idle();
	h.ready();
	h.idle();
	h.stdin.emit("error", Error("private fixture body"));
	assert.equal(h.writes.length, 2);
	assert.equal(h.errors.length, 1);
	assert.match(h.errors[0], /after task dispatch/);
	assert.ok(!h.errors[0].includes("private fixture body"));
});
test("synchronous probe write failure never dispatches a task", (t) => {
	const h = harness(t, "throw");
	h.gate.start();
	h.ready();
	h.idle();
	assert.equal(h.writes.length, 1);
	assert.equal(h.errors.length, 1);
	assert.match(h.errors[0], /not dispatched/);
});
test("backpressure is not rejection and cannot cause resend", (t) => {
	const h = harness(t, "backpressure");
	h.gate.start();
	h.ready();
	h.idle();
	h.idle();
	assert.equal(h.writes.length, 2);
	assert.equal(h.errors.length, 0);
});
test("failed correlated prompt acceptance is unknown and not retried", (t) => {
	const h = harness(t);
	h.gate.start();
	h.ready();
	h.idle();
	h.gate.record({
		type: "response",
		command: "prompt",
		id: token + "/prompt",
		success: false,
	});
	h.ready();
	assert.equal(h.writes.length, 2);
	assert.equal(h.errors.length, 1);
});
test("agent_end is not agent_settled; close before settle is unknown", (t) => {
	const h = harness(t);
	h.gate.start();
	h.ready();
	h.idle();
	h.gate.record({ type: "agent_end", willRetry: true });
	h.gate.closed();
	assert.equal(h.errors.length, 1);
});
test("settled allows close, but later activity requires another settled event", (t) => {
	const h = harness(t);
	h.gate.start();
	h.ready();
	h.idle();
	h.gate.record({ type: "agent_settled" });
	h.gate.closed();
	assert.equal(h.errors.length, 0);
	const h2 = harness(t);
	h2.gate.start();
	h2.ready();
	h2.idle();
	h2.gate.record({ type: "agent_settled" });
	h2.gate.record({ type: "agent_start" });
	h2.gate.closed();
	assert.equal(h2.errors.length, 1);
});
test("disposal blocks late readiness and tolerates late EPIPE", (t) => {
	const h = harness(t);
	h.gate.start();
	h.gate.dispose();
	h.ready();
	h.idle();
	h.stdin.emit("error", Error("late fixture error"));
	assert.equal(h.writes.length, 0);
	assert.equal(h.errors.length, 0);
});
test("bad token and oversized task are rejected before probe", (t) => {
	for (const cfg of [
		{ token: "bad", task: "small" },
		{ token, task: "x".repeat(1024 * 1024 + 1) },
		{ token, task: "\u0000".repeat(200000) },
	]) {
		const stdin = new EventEmitter();
		let writes = 0,
			errors = 0;
		stdin.write = () => {
			writes++;
		};
		const gate = createStartupTransport({
			...cfg,
			stdin,
			fail() {
				errors++;
			},
		});
		t.after(() => gate.dispose());
		gate.start();
		assert.equal(writes, 0);
		assert.equal(errors, 1);
	}
});
test("RPC argument builder omits task from argv AND task file and clears inherited nonce", async () => {
	const old = process.env[STARTUP_TOKEN_ENV];
	process.env[STARTUP_TOKEN_ENV] = "ancestor";
	let result;
	try {
		result = buildPiArgs({
			baseArgs: ["--mode", "rpc"],
			task: "private fixture task",
			deferTask: true,
			taskDelivery: "file",
			sessionEnabled: false,
			cwd: root,
			tools: ["bash"],
			systemPrompt: "fixed role",
		});
		assert.ok(
			!result.args.some((a) => a.startsWith("Task: ") || a.startsWith("@")),
		);
		assert.ok(!fs.existsSync(path.join(result.tempDir, "task.md")));
		assert.equal(result.env[STARTUP_TOKEN_ENV], undefined);
	} finally {
		if (old === undefined) delete process.env[STARTUP_TOKEN_ENV];
		else process.env[STARTUP_TOKEN_ENV] = old;
		if (result?.tempDir)
			await fs.promises.rm(result.tempDir, { recursive: true, force: true });
	}
});
