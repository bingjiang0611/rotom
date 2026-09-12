// Opt-in, no paid model: complete upstream workflow + real Pi CLI child.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { probePiVersion } from "../../runtime/verify-pi-runtime.mjs";
const enabled =
	Boolean(process.env.OWNER_WORKFLOW_PI) && process.platform !== "win32";
const source = path.resolve(
	process.env.OWNER_WORKFLOW_SOURCE ??
		fileURLToPath(new URL("./node_modules/pi-subagents", import.meta.url)),
);
const startupGate = process.env.OWNER_WORKFLOW_STARTUP === "1";
const candidate = fs.existsSync(
	path.join(source, "src/runs/shared/owner-lifeline.ts"),
);
const fixture = (name) =>
	fileURLToPath(new URL("./fixtures/" + name, import.meta.url));
// A failed node:test preflight would not stop later tests: validate before any launch.
validateSource();
let verified, fauxEntry;
if (enabled) {
	verified = await probePiVersion({
		executable: process.env.OWNER_WORKFLOW_PI,
	});
	let dir = verified.packageRoot;
	while (true) {
		const f = path.join(dir, "node_modules/@earendil-works/pi-ai/package.json");
		if (fs.existsSync(f)) {
			const p = JSON.parse(fs.readFileSync(f, "utf8"));
			assert.equal(p.name, "@earendil-works/pi-ai");
			fauxEntry = path.resolve(
				path.dirname(f),
				p.exports["./providers/*"].import.replaceAll("*", "faux"),
			);
			break;
		}
		const parent = path.dirname(dir);
		assert.notEqual(parent, dir, "public faux export unavailable");
		dir = parent;
	}
}
const roots = [];
after(async () => {
	for (const { dir, retain } of roots) {
		if (retain)
			console.warn("Retained unconfirmed fixture: " + path.basename(dir));
		else await fs.promises.rm(dir, { recursive: true, force: true });
	}
});
const save = (f, v) => fs.writeFileSync(f, JSON.stringify(v), { mode: 0o600 });
async function waitFile(file, ms = 25000) {
	if (fs.existsSync(file)) return true;
	return await new Promise((resolve) => {
		const w = fs.watch(path.dirname(file), () => {
			if (fs.existsSync(file)) {
				clearTimeout(timer);
				w.close();
				resolve(true);
			}
		});
		const timer = setTimeout(() => {
			w.close();
			resolve(false);
		}, ms);
		if (fs.existsSync(file)) {
			clearTimeout(timer);
			w.close();
			resolve(true);
		}
	});
}
function processField(pid, field, run = spawnSync) {
	assert.ok(Number.isSafeInteger(pid) && pid > 0);
	const r = run("ps", ["-p", String(pid), "-o", field + "="], {
		encoding: "utf8",
		timeout: 2000,
	});
	assert.ifError(r.error);
	if (r.status === 1 && !r.stdout.trim() && !r.stderr.trim()) return null;
	assert.equal(r.status, 0, "Process status unknown");
	assert.equal(r.stderr.trim(), "", "Process observation inconclusive");
	assert.ok(r.stdout.trim());
	return r.stdout.trim();
}
function active(pid) {
	const state = processField(pid, "stat");
	return state !== null && !state.startsWith("Z");
}
async function gone(pids) {
	const end = Date.now() + 8000;
	while (pids.some(active) && Date.now() < end)
		await new Promise((r) => setTimeout(r, 30));
	return pids.every((p) => !active(p));
}
function records(dir, suffix) {
	return fs
		.readdirSync(dir)
		.filter((n) => n.endsWith(suffix))
		.map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")));
}
function validateSource() {
	const p = JSON.parse(
		fs.readFileSync(path.join(source, "package.json"), "utf8"),
	);
	assert.equal(p.name, "pi-subagents");
	assert.equal(p.version, "0.52.1");
	assert.ok(!fs.lstatSync(source).isSymbolicLink());
	for (const relative of [
		"src/extension/index.ts",
		"src/runs/shared/subagent-prompt-runtime.ts",
		...(candidate ? ["src/runs/shared/owner-lifeline.ts"] : []),
		...(startupGate ? ["src/runs/shared/startup-transport.ts"] : []),
	]) {
		const f = path.join(source, relative);
		assert.equal(fs.realpathSync(f), f);
		assert.ok(fs.statSync(f).isFile());
	}
}
test(
	"fixture input is an explicit package source, not an installed-source mutation",
	validateSource,
);
test("process observation errors cannot authorize fixture deletion", () => {
	const absent = { status: 1, stdout: "", stderr: "" };
	assert.equal(
		processField(12345, "stat", () => absent),
		null,
	);
	for (const r of [
		{ ...absent, stderr: "unavailable" },
		{ status: 0, stdout: "", stderr: "" },
		{ status: 0, stdout: "S", stderr: "warning" },
		{ status: null, stdout: "", stderr: "" },
		{
			...absent,
			error: Object.assign(Error("fixture timeout"), { code: "ETIMEDOUT" }),
		},
	])
		assert.throws(() => processField(12345, "stat", () => r));
});
test("preload faults affect only the designated CLI, not its Node tool descendants", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-agent-workflow-"));
	roots.push({ dir, retain: false });
	const cli = path.join(dir, "cli.mjs"),
		leaf = path.join(dir, "leaf.mjs"),
		configPath = path.join(dir, "config.json");
	const body = `import fs from 'node:fs';const c=JSON.parse(fs.readFileSync(process.env.OWNER_WORKFLOW_CONFIG,'utf8'));console.log(JSON.stringify({fd:process.env.PI_SUBAGENT_OWNER_LIFELINE_FD??null,runtime:process.argv.includes(c.childRuntime)}));`;
	fs.writeFileSync(cli, body);
	fs.writeFileSync(leaf, body);
	for (const fault of ["missing-lifeline", "omit-runtime"]) {
		save(configPath, {
			piExecutable: cli,
			childRuntime: "fixture-runtime",
			fault,
		});
		for (const executable of [cli, leaf]) {
			const r = spawnSync(
				process.execPath,
				[
					"--import",
					fixture("workflow-no-network.mjs"),
					executable,
					"--extension",
					"fixture-runtime",
				],
				{
					encoding: "utf8",
					timeout: 5000,
					env: {
						HOME: dir,
						OWNER_WORKFLOW_CONFIG: configPath,
						PI_SUBAGENT_CHILD: "1",
						PI_SUBAGENT_OWNER_LIFELINE_FD: "3",
					},
				},
			);
			assert.ifError(r.error);
			assert.equal(r.status, 0);
			assert.equal(r.stderr, "");
			assert.deepEqual(JSON.parse(r.stdout), {
				fd: executable === cli && fault === "missing-lifeline" ? null : "3",
				runtime: !(executable === cli && fault === "omit-runtime"),
			});
		}
	}
});
for (const scenario of [
	"healthy",
	"crash-restart",
	"missing-lifeline",
	"omit-runtime",
	...(startupGate ? ["wrong-token", "early-owner-loss"] : []),
])
	test(
		`package workflow: ${scenario}`,
		{
			skip: !enabled
				? "set OWNER_WORKFLOW_PI for actual no-paid-model workflow smoke"
				: false,
		},
		async (t) => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-agent-workflow-"));
			const owned = { dir, retain: false };
			roots.push(owned);
			const home = path.join(dir, "home");
			const agentDir = path.join(home, ".pi/agent");
			fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
			fs.mkdirSync(path.join(dir, ".pi/agents"), { recursive: true });
			const config = {
				cwd: dir,
				agentDir,
				source,
				piEntry: verified.publicEntry,
				piExecutable: verified.executable,
				fauxEntry,
				childRuntime: path.join(
					source,
					"src/runs/shared/subagent-prompt-runtime.ts",
				),
				fault: [
					"missing-lifeline",
					"omit-runtime",
					"wrong-token",
					"early-owner-loss",
				].includes(scenario)
					? scenario
					: undefined,
				tryResume: candidate,
				parentBarrier: process.env.OWNER_WORKFLOW_PARENT_BARRIER === "1",
			};
			const configPath = path.join(dir, "config.json");
			save(configPath, config);
			fs.writeFileSync(
				path.join(dir, ".pi/agents/fixture-writer.md"),
				`---\nname: fixture-writer\ndescription: Fixed local writer fixture\ntools: bash\nmodel: owner-workflow-fixture/child\nsubagentOnlyExtensions: ${fixture("workflow-child-provider.mjs")}\ncompletionGuard: false\n---\nExecute the fixed fixture with bash.\n`,
			);
			fs.writeFileSync(
				path.join(dir, "writer.mjs"),
				`import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';const d=path.dirname(fileURLToPath(import.meta.url));const w=fs.watch(d,()=>{if(fs.existsSync(path.join(d,'release'))){fs.appendFileSync(path.join(d,'written'),'x');w.close();clearTimeout(timer);}});const timer=setTimeout(()=>{w.close();},60000);fs.writeFileSync(path.join(d,process.pid+'.writer.json'),JSON.stringify({pid:process.pid,ppid:process.ppid}));fs.writeFileSync(path.join(d,'ready'),'ready');`,
			);
			const env = {
				PATH: [
					path.dirname(process.execPath),
					"/usr/bin",
					"/bin",
					"/opt/homebrew/bin",
				].join(path.delimiter),
				HOME: home,
				TMPDIR: os.tmpdir(),
				LANG: "en_US.UTF-8",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				PI_CODING_AGENT_DIR: agentDir,
				PI_SUBAGENTS_TEMP_ROOT: path.join(dir, "runtime"),
				PI_SUBAGENT_PI_BINARY: config.piExecutable,
				PI_SUBAGENT_STARTUP_GATE: startupGate ? "1" : "0",
				PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: verified.packageRoot,
				ROTOM_OBSERVABILITY: "0",
				OWNER_WORKFLOW_CONFIG: configPath,
				NODE_OPTIONS: `--import ${JSON.stringify(fixture("workflow-no-network.mjs"))}`,
			};
			const git = spawnSync("git", ["init", "-q"], {
				cwd: dir,
				env,
				encoding: "utf8",
				timeout: 5000,
			});
			assert.ifError(git.error);
			assert.equal(git.status, 0);
			const children = [];
			let stderrBytes = 0;
			const launch = (phase) => {
				const p = spawn(
					process.execPath,
					["--experimental-strip-types", fixture("workflow-parent.mjs"), phase],
					{ cwd: dir, env, stdio: ["ignore", "ignore", "pipe"] },
				);
				children.push(p);
				p.stderr.on("data", (b) => {
					stderrBytes += b.length;
				});
				return p;
			};
			t.after(async () => {
				try {
					for (const p of children) {
						if (p.exitCode === null && p.signalCode === null) {
							const exit = once(p, "exit", {
								signal: AbortSignal.timeout(8000),
							});
							p.kill("SIGKILL");
							await exit;
						}
					}
					const launchPath = path.join(dir, "launch.json");
					if (
						fs.existsSync(launchPath) &&
						JSON.parse(fs.readFileSync(launchPath, "utf8")).hasRunId &&
						records(dir, ".child-start.json").length === 0 &&
						records(dir, ".bootstrap.json").length === 0
					)
						throw Error(
							"Accepted workflow without observed child; startup graph termination remains unconfirmed",
						);
					const pids = [
						...records(dir, ".writer.json"),
						...records(dir, ".child-start.json"),
						...records(dir, ".bootstrap.json"),
					].map((x) => x.pid);
					for (const pid of new Set(pids)) {
						const command = processField(pid, "command");
						if (command?.includes(dir)) {
							try {
								process.kill(pid, "SIGKILL");
							} catch (e) {
								if (e.code !== "ESRCH") throw e;
							}
							assert.ok(await gone([pid]));
						} else if (command !== null) {
							assert.ok(
								await gone([pid]),
								"Unconfirmed process identity; refusing to signal",
							);
						}
					}
				} catch (e) {
					owned.retain = true;
					throw e;
				}
			});
			let launchedAt = Date.now();
			const parent = launch("start");
			if (config.parentBarrier) {
				assert.ok(await waitFile(path.join(dir, "parent-ready.json"), 45000), "SDK initialization did not reach the no-task barrier");
				const ready = JSON.parse(fs.readFileSync(path.join(dir, "parent-ready.json"), "utf8"));
				assert.equal(ready.pid, parent.pid);
				t.diagnostic(JSON.stringify({ parentInitializationMs: Date.now() - launchedAt }));
				launchedAt = Date.now();
				fs.writeFileSync(path.join(dir, "parent-release"), "go");
			}
			if (scenario === "early-owner-loss") {
				assert.ok(await waitFile(path.join(dir, "bootstrap")));
				const bootstrap = records(dir, ".bootstrap.json");
				assert.equal(bootstrap.length, 1);
				assert.equal(bootstrap[0].ppid, parent.pid);
				assert.ok(active(bootstrap[0].pid));
				assert.ok(
					Date.now() - launchedAt < 5000 &&
						Date.now() - bootstrap[0].startedAt < 5000,
					"Kill must precede the 10s startup deadline",
				);
				assert.equal(records(dir, ".child-start.json").length, 0);
				assert.equal(parent.exitCode, null);
				const exited = once(parent, "exit", {
					signal: AbortSignal.timeout(8000),
				});
				parent.kill("SIGKILL");
				assert.equal((await exited)[1], "SIGKILL");
				fs.writeFileSync(path.join(dir, "startup-release"), "go");
				assert.ok(await gone([bootstrap[0].pid]));
				assert.equal(records(dir, ".writer.json").length, 0);
				assert.equal(records(dir, ".input.json").length, 0);
				assert.equal(records(dir, ".model-call.json").length, 0);
				t.diagnostic(
					JSON.stringify({
						scenario,
						ownerKilledBeforeRuntime: true,
						writerStarted: false,
					}),
				);
				return;
			}
			const expectStartupBlock =
				candidate &&
				(scenario === "missing-lifeline" ||
					(startupGate && ["omit-runtime", "wrong-token"].includes(scenario)));
			const ready = await waitFile(
				path.join(dir, expectStartupBlock ? "start-settled.json" : "ready"),
			);
			if (!ready) {
				for (const f of ["launch.json", "start-settled.json"])
					if (fs.existsSync(path.join(dir, f)))
						t.diagnostic(fs.readFileSync(path.join(dir, f), "utf8"));
			}
			assert.ok(ready, `Writer not ready; stderr bytes=${stderrBytes}`);
			assert.ok(await waitFile(path.join(dir, "handoff.json")));
			const handoff = JSON.parse(
				fs.readFileSync(path.join(dir, "handoff.json"), "utf8"),
			);
			assert.match(
				handoff.runId,
				/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
			);
			assert.equal(handoff.parentPid, parent.pid);
			const starts = records(dir, ".child-start.json");
			assert.equal(starts.length, 1);
			assert.equal(starts[0].runtimeRequested, scenario !== "omit-runtime");
			assert.ok(starts[0].cliRequested);
			assert.ok(starts[0].cwdMatches);
			assert.equal(starts[0].ppid, parent.pid);
			if (startupGate) {
				assert.equal(starts[0].mode, "rpc");
				assert.equal(starts[0].taskArgument, false);
			}
			if (expectStartupBlock) {
				if (scenario === "missing-lifeline")
					assert.equal(starts[0].lifeline, null);
				if (startupGate) {
					assert.equal(records(dir, ".input.json").length, 0);
					assert.equal(records(dir, ".model-call.json").length, 0);
				}
				assert.equal(records(dir, ".writer.json").length, 0);
				assert.ok(!fs.existsSync(path.join(dir, "ready")));
				assert.ok(await gone([parent.pid, starts[0].pid]));
				const rootStatus = JSON.parse(
					fs.readFileSync(
						path.join(
							dir,
							"runtime/async-subagent-runs",
							handoff.runId,
							"status.json",
						),
						"utf8",
					),
				);
				assert.equal(rootStatus.state, "failed");
				t.diagnostic(
					JSON.stringify({
						scenario,
						candidate,
						rootState: rootStatus.state,
						writerStarted: false,
						taskInputs: records(dir, ".input.json").reduce(
							(n, r) => n + r.count,
							0,
						),
						modelCalls: records(dir, ".model-call.json").reduce(
							(n, r) => n + r.count,
							0,
						),
					}),
				);
				return;
			}
			if (startupGate) {
				const inputs = records(dir, ".input.json");
				assert.equal(inputs.length, 1);
				assert.equal(inputs[0].count, 1);
				assert.equal(inputs[0].source, "rpc");
			}
			const writer = records(dir, ".writer.json");
			assert.equal(writer.length, 1);
			assert.equal(writer[0].ppid, starts[0].pid);
			assert.ok(active(writer[0].pid));
			const statusFile = path.join(
				dir,
				"runtime/async-subagent-runs",
				handoff.runId,
				"status.json",
			);
			if (scenario === "healthy") {
				fs.writeFileSync(path.join(dir, "release"), "go");
				assert.ok(await waitFile(path.join(dir, "start-settled.json"), 45000));
				assert.equal(fs.readFileSync(path.join(dir, "written"), "utf8"), "x");
				assert.ok(await gone([parent.pid, starts[0].pid, writer[0].pid]));
				const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
				assert.equal(status.state, "complete");
				t.diagnostic(
					JSON.stringify({
						scenario,
						candidate,
						rootState: status.state,
						childCli: true,
					}),
				);
				return;
			}
			assert.equal(parent.exitCode, null, "Owner exited before the kill point");
			assert.equal(parent.signalCode, null);
			const exited = once(parent, "exit", {
				signal: AbortSignal.timeout(8000),
			});
			parent.kill("SIGKILL");
			const [, exitSignal] = await exited;
			assert.equal(exitSignal, "SIGKILL");
			const stopped = await gone([writer[0].pid, starts[0].pid]);
			const runDirs = () =>
				fs
					.readdirSync(path.join(dir, "runtime/async-subagent-runs"))
					.filter((n) => /^[a-f0-9-]{36}$/.test(n))
					.sort();
			const beforeRuns = runDirs();
			const inspector = launch("inspect");
			assert.ok(await waitFile(path.join(dir, "inspection.json")));
			assert.ok(await waitFile(path.join(dir, "inspect-settled.json")));
			const inspection = JSON.parse(
				fs.readFileSync(path.join(dir, "inspection.json"), "utf8"),
			);
			assert.ok(inspection.sameSession);
			const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
			fs.writeFileSync(path.join(dir, "release"), "go");
			if (!stopped) assert.ok(await waitFile(path.join(dir, "written")));
			t.diagnostic(
				JSON.stringify({
					scenario,
					candidate,
					stopped,
					rootState: status.state,
					inspection,
					written: fs.existsSync(path.join(dir, "written")),
				}),
			);
			if (scenario === "omit-runtime") {
				assert.equal(
					stopped,
					false,
					"Negative control should expose the missing runtime guard",
				);
				assert.ok(fs.existsSync(path.join(dir, "written")));
			} else if (scenario === "missing-lifeline") {
				assert.fail(
					"Missing lifeline configuration did not prevent writer startup",
				);
			} else {
				assert.equal(stopped, true);
				assert.ok(!fs.existsSync(path.join(dir, "written")));
			}
			if (candidate) {
				assert.deepEqual(runDirs(), beforeRuns);
				assert.equal(records(dir, ".child-start.json").length, 1);
				assert.equal(status.state, "running");
				assert.equal(inspection.resume.isError, true);
				assert.equal(inspection.resume.ownerUnknown, true);
			}
			assert.ok(await gone([inspector.pid]));
		},
	);
