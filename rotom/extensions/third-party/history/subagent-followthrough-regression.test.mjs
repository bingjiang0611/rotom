// Explicit source-only L1 counterfactuals. No models, real PIDs, or installed edits.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const source = process.env.SUBAGENT_FOLLOWTHROUGH_SOURCE;
if (!source)
	test(
		"followthrough source gate",
		{ skip: "set SUBAGENT_FOLLOWTHROUGH_SOURCE to an isolated pinned source" },
		() => {},
	);
else {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "dev-agent-followthrough-"),
	);
	const old = process.env.PI_SUBAGENTS_TEMP_ROOT;
	process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(dir, "runtime");
	after(() => {
		if (old === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
		else process.env.PI_SUBAGENTS_TEMP_ROOT = old;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const base = fs.realpathSync(source);
	assert.equal(
		JSON.parse(fs.readFileSync(path.join(base, "package.json"))).name,
		"pi-subagents",
	);
	const load = (file) =>
		import(pathToFileURL(path.join(base, "src", file)).href);
	const { waitForSubagents } = await load("runs/background/subagent-wait.ts");
	const { updateActiveRunIndex } = await load(
		"runs/background/active-run-index.ts",
	);
	const { registerWaitTool } = await load("runs/background/wait-tool.ts");
	const { SubagentWaitParams } = await load("extension/schemas.ts");
	const { DIRS } = await load("shared/types.ts");
	function fixture(t) {
		const root = fs.mkdtempSync(path.join(dir, "case-"));
		let now = Date.now();
		let polls = 0;
		const state = {
			currentSessionId: "owner",
			baseCwd: root,
			asyncJobs: new Map(),
			foregroundRuns: new Map(),
			foregroundControls: new Map(),
			cleanupTimers: new Map(),
			completionSeen: new Map(),
			lastUiContext: null,
			resultFileCoalescer: { schedule: () => false, clear() {} },
		};
		const run = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const runs = path.join(root, "runs");
		const runDir = path.join(runs, run);
		const file = path.join(runDir, "status.json");
		const status = (status = "running", extra = {}) => {
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(
				file,
				JSON.stringify({
					runId: run,
					mode: "single",
					sessionId: "owner",
					state: status,
					pid: 999999,
					startedAt: now,
					lastUpdate: now,
					steps: [{ agent: "fixture", status }],
					...extra,
				}),
			);
			updateActiveRunIndex(runDir, status);
		};
		const deps = {
			state,
			asyncDirRoot: runs,
			resultsDir: path.join(root, "results"),
			kill: () => true,
			now: () => now,
			pollIntervalMs: 250,
		};
		status("running", {
			activityState: "needs_attention",
			currentTool: "bash",
		});
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		return {
			state,
			run,
			file,
			status,
			deps,
			get polls() {
				return polls;
			},
			sleep(fn) {
				return async () => {
					polls++;
					now += 250;
					assert.ok(polls <= 4, "bounded synthetic wait");
					await fn(polls);
				};
			},
		};
	}
	const text = (r) => r.content.map((c) => c.text ?? "").join("");
	test("change mode preserves the existing immediate attention result", async (t) => {
		const f = fixture(t);
		const r = await waitForSubagents({ id: f.run }, undefined, {
			...f.deps,
			sleep: f.sleep(() => assert.fail("must not sleep")),
		});
		assert.match(text(r), /attention required/);
		assert.equal(f.polls, 0);
	});
	test("terminal mode waits through advisory attention without replay or polling turns", async (t) => {
		const f = fixture(t);
		const r = await waitForSubagents(
			{ id: f.run, until: "terminal" },
			undefined,
			{
				...f.deps,
				sleep: f.sleep((n) => {
					if (n === 2) f.status("complete");
				}),
			},
		);
		assert.equal(f.polls, 2);
		assert.match(text(r), /1 complete/);
		assert.doesNotMatch(text(r), /attention required/);
		assert.notEqual(r.isError, true);
	});
	test("terminal mode still returns for contact_supervisor", async (t) => {
		const f = fixture(t);
		f.status("running", {
			activityState: "needs_attention",
			currentTool: "contact_supervisor",
		});
		const r = await waitForSubagents(
			{ id: f.run, until: "terminal" },
			undefined,
			{
				...f.deps,
				sleep: f.sleep(() => assert.fail("reply cannot be hidden")),
			},
		);
		assert.match(text(r), /attention required/);
		assert.match(text(r), /Reply/);
	});
	test("owner-scoped pending reply interrupts even without an activity flag", async (t) => {
		const f = fixture(t);
		f.status();
		const r = await waitForSubagents(
			{ id: f.run, until: "terminal" },
			undefined,
			{
				...f.deps,
				blockingRunIds: () => [f.run],
				sleep: f.sleep(() => assert.fail("pending reply must interrupt")),
			},
		);
		assert.match(text(r), /attention required/);
		assert.equal(f.polls, 0);
	});
	test("pending request on another run cannot break an exact wait", async (t) => {
		const f = fixture(t);
		const r = await waitForSubagents(
			{ id: f.run, until: "terminal" },
			undefined,
			{
				...f.deps,
				blockingRunIds: () => ["another-run"],
				sleep: f.sleep(() => f.status("complete")),
			},
		);
		assert.equal(f.polls, 1);
		assert.match(text(r), /1 complete/);
	});
	test("terminal mode retains deadline and never changes a running record", async (t) => {
		const f = fixture(t);
		const r = await waitForSubagents(
			{ id: f.run, until: "terminal", timeoutMs: 500 },
			undefined,
			{ ...f.deps, sleep: f.sleep(() => {}) },
		);
		assert.equal(r.isError, true);
		assert.match(text(r), /timed out/);
		assert.equal(f.polls, 2);
		assert.equal(JSON.parse(fs.readFileSync(f.file)).state, "running");
	});
	test("terminal mode retains abort without implying writer termination", async (t) => {
		const f = fixture(t);
		const controller = new AbortController();
		const r = await waitForSubagents(
			{ id: f.run, until: "terminal" },
			controller.signal,
			{ ...f.deps, sleep: f.sleep(() => controller.abort()) },
		);
		assert.equal(r.isError, true);
		assert.match(text(r), /aborted/);
		assert.equal(JSON.parse(fs.readFileSync(f.file)).state, "running");
	});
	test("session replacement cannot turn an old running task into done", async (t) => {
		const f = fixture(t);
		f.status();
		const r = await waitForSubagents({ id: f.run }, undefined, {
			...f.deps,
			sleep: f.sleep(() => (f.state.currentSessionId = "new-owner")),
		});
		assert.equal(r.isError, true);
		assert.match(text(r), /session changed/);
		assert.equal(JSON.parse(fs.readFileSync(f.file)).state, "running");
	});
	test("missing terminal record is unconfirmed, not done", async (t) => {
		const f = fixture(t);
		f.status();
		const r = await waitForSubagents({ id: f.run }, undefined, {
			...f.deps,
			sleep: f.sleep(() => fs.unlinkSync(f.file)),
		});
		assert.equal(r.isError, true);
		assert.match(text(r), /disappeared.*unconfirmed/);
	});
	test("terminal and nonBlocking are mutually exclusive before dispatch", async (t) => {
		const f = fixture(t);
		const r = await waitForSubagents(
			{ id: f.run, until: "terminal", nonBlocking: true },
			undefined,
			{
				...f.deps,
				subscribe: () => assert.fail("no subscription may be armed"),
			},
		);
		assert.equal(r.isError, true);
		assert.match(text(r), /cannot be combined/);
	});
	test("unavailable supervisor evidence fails without leaking its body", async (t) => {
		const f = fixture(t);
		const r = await waitForSubagents(
			{ id: f.run, until: "terminal" },
			undefined,
			{
				...f.deps,
				blockingRunIds: () => {
					throw Error("private fixture body");
				},
			},
		);
		assert.equal(r.isError, true);
		assert.match(text(r), /unavailable/);
		assert.doesNotMatch(text(r), /private fixture body/);
	});
	test("completed supervisor step cannot keep a later step waiting for a reply", async (t) => {
		const f = fixture(t);
		f.status("running", {
			activityState: "needs_attention",
			currentTool: "bash",
			steps: [
				{
					agent: "first",
					status: "completed",
					currentTool: "contact_supervisor",
				},
				{ agent: "second", status: "running", currentTool: "bash" },
			],
		});
		const r = await waitForSubagents(
			{ id: f.run, until: "terminal" },
			undefined,
			{ ...f.deps, sleep: f.sleep(() => f.status("complete")) },
		);
		assert.equal(f.polls, 1);
		assert.match(text(r), /1 complete/);
	});
	test("terminal mode cannot hide unresolved ownership/error state", async (t) => {
		const f = fixture(t);
		f.status("running", {
			activityState: "needs_attention",
			error: "owner cannot be verified",
		});
		const r = await waitForSubagents(
			{ id: f.run, until: "terminal" },
			undefined,
			{
				...f.deps,
				sleep: f.sleep(() => assert.fail("owner uncertainty must interrupt")),
			},
		);
		assert.equal(r.isError, true);
		assert.match(text(r), /unconfirmed/);
		assert.equal(f.polls, 0);
		assert.equal(JSON.parse(fs.readFileSync(f.file)).state, "running");
	});
	test("terminal mode reports pause as unconfirmed rather than done", async (t) => {
		const f = fixture(t);
		const r = await waitForSubagents(
			{ id: f.run, until: "terminal" },
			undefined,
			{ ...f.deps, sleep: f.sleep(() => f.status("paused")) },
		);
		assert.equal(r.isError, true);
		assert.match(text(r), /paused.*unconfirmed/);
	});
	test("public tool schema and execution forward the same terminal/pending contract", async (t) => {
		const f = fixture(t);
		assert.equal(SubagentWaitParams.properties.until.type, "string");
		assert.deepEqual(SubagentWaitParams.properties.until.enum, ["change", "terminal"]);
		assert.equal(SubagentWaitParams.properties.until.anyOf, undefined);
		let tool;
		const pi = {
			registerTool: (t) => (tool = t),
			events: {
				on() {
					return () => {};
				},
			},
		};
		let read = 0;
		registerWaitTool(pi, f.state, true, undefined, () => {
			read++;
			return [f.run];
		});
		assert.match(tool.description, /until: "terminal"/);
		const target = path.join(DIRS.async, f.run);
		fs.mkdirSync(target, { recursive: true });
		const record = JSON.parse(fs.readFileSync(f.file));
		delete record.pid;
		delete record.activityState;
		delete record.currentTool;
		fs.writeFileSync(path.join(target, "status.json"), JSON.stringify(record));
		updateActiveRunIndex(target, "running");
		t.after(() => fs.rmSync(target, { recursive: true, force: true }));
		const result = await tool.execute(
			"fixture",
			{ id: f.run, until: "terminal", timeoutMs: 20 },
			undefined,
			undefined,
			{ hasUI: false },
		);
		assert.ok(read > 0);
		assert.match(text(result), /attention required/);
	});
}
