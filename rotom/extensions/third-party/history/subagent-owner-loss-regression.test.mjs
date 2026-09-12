// Maintenance-only: copies the locked dependency; never loads a model or touches live sessions.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

const preparedSource = process.env.SUBAGENT_OWNER_LOSS_SOURCE;
const installed = preparedSource ? fs.realpathSync(preparedSource) : fileURLToPath(
	new URL("./node_modules/pi-subagents/", import.meta.url),
);
assert.equal(
	JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"))
		.version,
	"0.52.1",
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-agent-owner-loss-"));
const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(root, "runtime");
after(() => {
	if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
	else process.env.PI_SUBAGENTS_TEMP_ROOT = previous;
	fs.rmSync(root, { recursive: true, force: true });
});
const source = path.join(root, "source");
fs.mkdirSync(source);
fs.cpSync(path.join(installed, "src"), path.join(source, "src"), {
	recursive: true,
});
fs.writeFileSync(
	path.join(source, "package.json"),
	JSON.stringify({ type: "module" }),
);
const candidate = process.env.SUBAGENT_OWNER_LOSS_CANDIDATE === "1";
if (candidate && !preparedSource) {
	const env = { ...process.env };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	const result = spawnSync(
		"git",
		[
			"apply",
			"--unidiff-zero",
			fileURLToPath(
				new URL("./subagent-owner-loss-candidate.patch", import.meta.url),
			),
		],
		{ cwd: source, env, encoding: "utf8", timeout: 10000 },
	);
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
}
const { reconcileAsyncRun } = await import(
	pathToFileURL(
		path.join(source, "src/runs/background/stale-run-reconciler.ts"),
	).href
);
const { listAsyncRuns, formatAsyncRunList } = await import(
	pathToFileURL(path.join(source, "src/runs/background/async-status.ts")).href
);
const { resolveAsyncResumeTarget } = await import(
	pathToFileURL(path.join(source, "src/runs/background/async-resume.ts")).href
);
const { stopAsyncRun } = await import(
	pathToFileURL(path.join(source, "src/runs/foreground/async-stop-action.ts"))
		.href
);
const gap = {
	todo:
		!candidate && process.env.SUBAGENT_OWNER_LOSS_STRICT !== "1"
			? "owner loss is incorrectly converted to failed in baseline"
			: false,
};
function fixture(t, overrides = {}) {
	const dir = fs.mkdtempSync(path.join(root, "case-"));
	const run = path.join(dir, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
	const results = path.join(dir, "results");
	fs.mkdirSync(run);
	fs.mkdirSync(results);
	const status = {
		runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		sessionId: "fixture-session",
		mode: "workflow",
		state: "running",
		pid: 12345,
		startedAt: 100,
		lastUpdate: 100,
		steps: [{ agent: "fixture", status: "running", startedAt: 100 }],
		...overrides,
	};
	const statusPath = path.join(run, "status.json");
	fs.writeFileSync(statusPath, JSON.stringify(status));
	const original = fs.readFileSync(statusPath, "utf8");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return {
		dir,
		run,
		results,
		status,
		statusPath,
		original,
		reconcile(
			kill = () => {
				throw Object.assign(new Error("fixture gone"), { code: "ESRCH" });
			},
		) {
			return reconcileAsyncRun(run, {
				resultsDir: results,
				now: () => 10000,
				staleAlivePidMs: 50,
				kill,
			});
		},
	};
}
function assertUnknown(f, kill) {
	assert.throws(
		() => f.reconcile(kill),
		(e) =>
			e.name === "StaleWorkflowExecutionUnknownError" &&
			/Do not resume or retry/.test(e.message),
	);
	assert.equal(
		fs.readFileSync(f.statusPath, "utf8"),
		f.original,
		"Unknown execution must not rewrite status/steps as terminal",
	);
	assert.equal(
		fs.readdirSync(f.results).length,
		0,
		"Unknown execution must not create a terminal result",
	);
}
test(
	"dead in-process workflow owner preserves unknown execution, not a fabricated failure",
	gap,
	(t) => assertUnknown(fixture(t)),
);
test("stale live workflow PID is not proof of writer termination", gap, (t) =>
	assertUnknown(fixture(t), () => true),
);
test(
	"permission-denied liveness cannot justify a failed workflow result",
	gap,
	(t) =>
		assertUnknown(fixture(t), () => {
			throw Object.assign(new Error("fixture denied"), { code: "EPERM" });
		}),
);
test("fresh live workflow remains running", (t) => {
	const f = fixture(t, { lastUpdate: 9999 });
	assert.equal(f.reconcile(() => true).status.state, "running");
	assert.equal(fs.readFileSync(f.statusPath, "utf8"), f.original);
});
test("an existing authoritative result still repairs workflow status", (t) => {
	const f = fixture(t);
	fs.writeFileSync(
		path.join(f.results, f.status.runId + ".json"),
		JSON.stringify({ success: true, state: "complete" }),
	);
	assert.equal(f.reconcile().status.state, "complete");
});
test("legacy single-run reconciliation is unchanged by the workflow-only candidate", (t) => {
	const f = fixture(t, { mode: "single" });
	assert.equal(f.reconcile().status.state, "failed");
});
test(
	"unknown owner does not hide healthy runs or mutate stored status",
	gap,
	(t) => {
		const f = fixture(t);
		const healthy = path.join(f.dir, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
		fs.mkdirSync(healthy);
		fs.writeFileSync(
			path.join(healthy, "status.json"),
			JSON.stringify({
				...f.status,
				runId: path.basename(healthy),
				pid: 56789,
				lastUpdate: 9999,
			}),
		);
		const rows = listAsyncRuns(f.dir, {
			resultsDir: f.results,
			repairScan: true,
			includeNested: false,
			now: () => 10000,
			kill: (pid) => {
				if (pid === 12345)
					throw Object.assign(new Error("gone"), { code: "ESRCH" });
				return true;
			},
		});
		assert.equal(rows.length, 2);
		const lost = rows.find((r) => r.id === f.status.runId);
		assert.equal(lost.activityState, "needs_attention");
		assert.equal(lost.state, "running");
		assert.match(
			formatAsyncRunList(rows),
			/execution and side effects remain unknown/,
		);
		assert.equal(fs.readFileSync(f.statusPath, "utf8"), f.original);
	},
);
test(
	"direct resume of an owner-lost workflow fails before selecting a new writer",
	gap,
	(t) => {
		const f = fixture(t);
		assert.throws(
			() =>
				resolveAsyncResumeTarget(
					{ dir: f.run },
					{
						asyncDirRoot: f.dir,
						resultsDir: f.results,
						kill: () => {
							throw Object.assign(new Error("gone"), { code: "ESRCH" });
						},
					},
				),
			(e) => e.name === "StaleWorkflowExecutionUnknownError",
		);
		assert.equal(fs.readdirSync(f.results).length, 0);
	},
);
test("stop must not signal an unverified workflow PID", gap, (t) => {
	const f = fixture(t);
	const signals = [];
	assert.throws(
		() =>
			stopAsyncRun(
				{ currentSessionId: f.status.sessionId, asyncJobs: new Map() },
				f.status.runId,
				(pid, signal) => {
					signals.push(signal);
					throw Object.assign(new Error("gone"), { code: "ESRCH" });
				},
				{ asyncDir: f.run, resolvedId: f.status.runId },
			),
		(e) => e.name === "StaleWorkflowExecutionUnknownError",
	);
	assert.deepEqual(signals, [0]);
	assert.equal(fs.readdirSync(f.results).length, 0);
});
async function waitFile(file, timeout = 5000) {
	if (fs.existsSync(file)) return;
	await new Promise((resolve, reject) => {
		const watcher = fs.watch(path.dirname(file), () => {
			if (fs.existsSync(file)) {
				clearTimeout(timer);
				watcher.close();
				resolve();
			}
		});
		const timer = setTimeout(() => {
			watcher.close();
			reject(new Error("fixture file deadline"));
		}, timeout);
		if (fs.existsSync(file)) {
			clearTimeout(timer);
			watcher.close();
			resolve();
		}
	});
}
test(
	"real SIGKILL: writer can act after owner death, so reconciliation must refuse terminal repair",
	{ ...gap, skip: process.platform === "win32" },
	async (t) => {
		const f = fixture(t);
		const writer = path.join(f.dir, "writer.mjs");
		const owner = path.join(f.dir, "owner.mjs");
		fs.writeFileSync(
			writer,
			`import fs from 'node:fs';import path from 'node:path';const d=process.argv[2];const timer=setTimeout(()=>process.exit(0),7000);const watcher=fs.watch(d,()=>{if(fs.existsSync(path.join(d,'release'))){fs.writeFileSync(path.join(d,'late-write'),'written');watcher.close();clearTimeout(timer);process.exit(0);}});fs.writeFileSync(path.join(d,'ready'),String(process.pid));`,
		);
		fs.writeFileSync(
			owner,
			`import {spawn} from 'node:child_process';const child=spawn(process.execPath,[process.argv[2],process.argv[3]],{detached:true,stdio:'ignore'});child.unref();process.send({writerPid:child.pid});setInterval(()=>{},1000);`,
		);
		const proc = spawn(process.execPath, [owner, writer, f.dir], {
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		let writerPid;
		t.after(() => {
			proc.kill("SIGKILL");
			if (writerPid) {
				const observed = spawnSync(
					"ps",
					["-p", String(writerPid), "-o", "command="],
					{ encoding: "utf8", timeout: 1000 },
				);
				if (observed.status === 0 && observed.stdout.includes(writer)) {
					try {
						process.kill(writerPid, "SIGKILL");
					} catch {}
				}
			}
		});
		const message = await once(proc, "message", {
			signal: AbortSignal.timeout(5000),
		});
		writerPid = message[0].writerPid;
		await waitFile(path.join(f.dir, "ready"));
		assert.equal(
			Number(fs.readFileSync(path.join(f.dir, "ready"), "utf8")),
			writerPid,
		);
		f.status.pid = proc.pid;
		fs.writeFileSync(f.statusPath, JSON.stringify(f.status));
		f.original = fs.readFileSync(f.statusPath, "utf8");
		const closed = once(proc, "exit");
		proc.kill("SIGKILL");
		await closed;
		let result, error;
		try {
			result = reconcileAsyncRun(f.run, { resultsDir: f.results });
		} catch (e) {
			error = e;
		}
		fs.writeFileSync(path.join(f.dir, "release"), "go");
		await waitFile(path.join(f.dir, "late-write"));
		assert.equal(
			fs.readFileSync(path.join(f.dir, "late-write"), "utf8"),
			"written",
			"This test must demonstrate the real remaining side-effect window",
		);
		assert.equal(
			error?.name,
			"StaleWorkflowExecutionUnknownError",
			`Writer acted after reconciliation returned ${result?.status?.state}`,
		);
		assert.equal(fs.readFileSync(f.statusPath, "utf8"), f.original);
		assert.equal(fs.readdirSync(f.results).length, 0);
	},
);
