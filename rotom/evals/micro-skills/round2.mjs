import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureAction, runCheck } from "./fixture-tool.ts";
import { materialize, schedule, snapshot, tasks } from "./round2-tasks.mjs";

assert(Number(process.versions.node.split(".")[0]) >= 24, "Round two requires Node 24+ to run the installed rotom CLI");
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const binary = realpathSync(process.env.ROTOM_EVAL_BIN ?? findExecutable("rotom"));
const python = realpathSync(findExecutable("python3"));
const provider = "openai-codex";
const model = "gpt-6.2-sol";
const [mode, output, previous] = process.argv.slice(2);
assert((mode === "--self-test" && !output) || (mode === "--live" && output),
	"Usage: round2.mjs --self-test | --live NEW_OUTPUT_JSON [PREVIOUS_RESULT_JSON] (live requires explicit approval)");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "micro-skills-round2-")));
const checkout = join(scratch, "snapshot");
const fixtureRoot = join(scratch, "workspace");
const home = join(scratch, "home");
const agent = join(home, ".pi/agent");
const env = { HOME: home, TMPDIR: scratch, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, NO_COLOR: "1" };
const cliEnv = { ...env, PATH: `${dirname(binary)}:${env.PATH}`, PI_CODING_AGENT_DIR: agent, ROTOM_OBSERVABILITY: "0",
	ROTOM_MICRO_SKILLS_FIXTURE: join(scratch, "spec.json") };
// Preserve the operator's existing network route only for the authenticated CLI.
// The fixture subprocesses and loopback-only prompt probe retain the minimal env.
const networkKeys = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy",
	"all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY"];
const liveEnv = { ...cliEnv, ...Object.fromEntries(networkKeys.filter(key => process.env[key] !== undefined)
	.map(key => [key, process.env[key]])) };

function findExecutable(name) {
	const result = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8", timeout: 3000 });
	assert.equal(result.status, 0, `Missing executable: ${name}`);
	return result.stdout.trim();
}

function local(bin, args, cwd, settings = {}) {
	const result = spawnSync(bin, args, { cwd, env, encoding: "utf8", timeout: 300_000, ...settings });
	assert.equal(result.status, 0, `${bin} ${args[0]} failed: ${(result.stderr || result.stdout || result.error?.code || "").slice(-1800)}`);
	return result.stdout.trim();
}

function prepare() {
	mkdirSync(checkout);
	mkdirSync(fixtureRoot);
	mkdirSync(agent, { recursive: true, mode: 0o700 });
	const tar = join(scratch, "snapshot.tar");
	local("git", ["archive", "--format=tar", "--output", tar, snapshot], repo);
	local("tar", ["-xf", tar, "-C", checkout], scratch);
	rmSync(tar);
	// The cache is read from its standard operator location, but npm is offline and scripts are disabled.
	local(realpathSync(findExecutable("npm")), ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
		"--cache", process.env.npm_config_cache ?? join(homedir(), ".npm")], join(checkout, "rotom/evals"));
}

function attempt(fixture, arm, dryPrompt) {
	const contextFile = join(fixtureRoot, "AGENTS.md");
	const traceFile = join(fixtureRoot, "trace.json");
	rmSync(contextFile, { force: true });
	rmSync(traceFile, { force: true });
	if (arm === "B") writeFileSync(contextFile, fixture.note + "\n", { mode: 0o600 });
	writeFileSync(cliEnv.ROTOM_MICRO_SKILLS_FIXTURE, JSON.stringify({ ...fixture, dryPrompt,
		promptCheck: { arm, note: fixture.note } }), { mode: 0o600 });
	const args = ["--provider", dryPrompt ? "micro-offline" : provider, "--model", dryPrompt ? "probe" : model,
		"--thinking", "off", "--mode", "json", "-p", "--no-session", "--no-extensions", "--no-skills", "--no-mcp",
		"--no-builtin-tools", "--tools", "workspace", "--extension", join(here, "fixture-tool.ts")];
	if (arm === "C") args.push("--append-system-prompt", fixture.note);
	const start = performance.now();
	const result = spawnSync(binary, [...args, fixture.prompt], {
		cwd: fixtureRoot, env: dryPrompt ? cliEnv : liveEnv, encoding: "utf8", timeout: 360_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
	});
	const ms = Math.round(performance.now() - start);
	const trace = existsSync(traceFile) ? JSON.parse(readFileSync(traceFile, "utf8")) : { calls: [], messages: [] };
	if (dryPrompt && !trace.scopeOk) console.error((result.stderr || result.error?.message || "").slice(-1000));
	const errors = trace.messages.some(m => m.stopReason === "error" || m.stopReason === "aborted");
	const infrastructure = !trace.scopeOk ? "prompt-or-tool-scope" : result.error?.code ??
		(trace.calls.some(c => c.infrastructure) ? "fixture-infrastructure" :
		!trace.limitHit && (result.status !== 0 || errors || !trace.messages.length) ? "cli-or-provider" : null);
	return { arm, ms, ...trace, infrastructure,
		verified: trace.calls.some(c => c.verified),
		failedCommands: trace.calls.filter(c => c.action === "run" && !c.ok && !c.infrastructure).length,
		redundant: trace.calls.length - Number(trace.calls.some(c => c.verified)),
		pass: infrastructure ? null : trace.answerOk && trace.calls.some(c => c.verified) };
}

function selfTest(fixtures) {
	const child = { bin: "/bin/sh", args: ["-c", "exit 1"], cwd: scratch, env, timeout: 15_000 };
	assert.deepEqual(runCheck(child), { ok: false, infrastructure: false, text: "Check exited with status 1." });
	assert.equal(runCheck({ ...child, bin: join(scratch, "missing-command") }).infrastructure, true);
	assert.equal(runCheck({ ...child, bin: "/bin/sleep", args: ["10"], timeout: 100 }).infrastructure, true);
	assert.equal(runCheck({ ...child, args: ["-c", 'kill -TERM "$$"'] }).infrastructure, true);
	for (const position of [0, 1, 2]) assert.equal(new Set(schedule.map(s => s[position])).size, 3);
	for (const [task, fixture] of fixtures) {
		const run = name => fixtureAction(fixture, { action: "run", name });
		assert.equal(run(`${task.target}; echo not-allowlisted`).check, "unavailable");
		assert.equal(fixtureAction(fixture, { action: "read", name: "../spec.json" }).ok, false);
		const target = run(task.target);
		assert.equal(target.verified, true, `${task.id}: ${target.text}`);
		if (task.wrong) {
			const wrong = run(task.wrong);
			assert.equal(wrong.ok, false, `${task.id}: wrong command passed`);
			assert.equal(wrong.infrastructure, false, `${task.id}: wrong command did not exit normally`);
		}
		console.log(`${task.id}: target passed${task.wrong ? "; wrong command rejected" : ""}`);
	}
	for (const arm of schedule[0]) {
		const run = attempt(fixtures.at(-1)[1], arm, true);
		assert(run.scopeOk && !run.calls.length && !run.providerRequest && run.messages.every(m =>
			m.stopReason === "aborted" && m.usage?.totalTokens === 0),
			`${arm}: offline default-prompt probe failed (${JSON.stringify(run.promptCheck)})`);
		console.log(`${arm}: default prompt ${run.promptCheck.bytes} bytes, note hits ${run.promptCheck.hits}, via context file ${run.promptCheck.context}`);
	}
}

try {
	prepare();
	const fixtures = tasks.map(task => [task, materialize(task, checkout, fixtureRoot, env, python)]);
	if (mode === "--self-test") {
		selfTest(fixtures);
	} else {
		const auth = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"), "auth.json");
		assert(existsSync(auth), "Existing rotom auth store required; refusing to switch providers or request credentials");
		symlinkSync(realpathSync(auth), join(agent, "auth.json"));
		const version = local(binary, ["--version"], fixtureRoot, { env: cliEnv });
		const dest = resolve(output);
		const metadata = { schema: "rotom-micro-skills-round2/v1", snapshot, version, provider, model, thinking: "off", schedule };
		const plan = fixtures.flatMap(([task, fixture]) => schedule.flatMap((order, round) =>
			[...order].map(arm => ({ task: task.id, fixture, repeat: round + 1, arm }))));
		const rows = previous ? resumeRows(previous, metadata, plan) : [];
		const save = flag => writeFileSync(dest, JSON.stringify({ ...metadata, rows }) + "\n", { mode: 0o600, flag });
		save("wx");
		for (const { task, fixture, repeat, arm } of plan.slice(rows.length)) {
			const run = attempt(fixture, arm, false);
			rows.push({ task, repeat, ...run });
			save("w");
			console.log(task, repeat, arm, run.infrastructure ?? (run.pass ? "PASS" : "FAIL"));
			if (run.infrastructure) throw new Error(`Stopped at ${task}/${repeat}/${arm}: ${run.infrastructure}`);
		}
	}
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

function resumeRows(path, metadata, plan) {
	const { rows, ...recorded } = JSON.parse(readFileSync(path, "utf8"));
	assert.deepEqual(recorded, metadata, "Cannot resume with different run configuration");
	assert(rows.length > 0 && rows.length < plan.length && rows.at(-1).infrastructure,
		"Resume requires an incomplete run that stopped on infrastructure");
	for (const [i, row] of rows.entries()) {
		assert.deepEqual([row.task, row.repeat, row.arm], [plan[i].task, plan[i].repeat, plan[i].arm], "Not a prefix of the fixed plan");
	}
	return rows;
}
