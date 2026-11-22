import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureAction } from "./fixture-tool.ts";

// Fixed before the live run. Each pair gets a fresh workspace; the order alternates.
const tasks = [
	{ id: "quartz", docs: false, current: "python -m unittest discover -s quality", old: "python -m unittest discover -s tests", order: ["baseline", "hint"], numbers: [17, 29, 41] },
	{ id: "cedar", docs: false, current: "python -m unittest discover -s checks", old: "python -m unittest discover -s tests", order: ["hint", "baseline"], numbers: [13, 33, 51] },
	{ id: "willow", docs: true, current: "python -m unittest discover -s checks", old: "python -m unittest discover -s tests", order: ["baseline", "hint"], numbers: [19, 27, 62] },
	{ id: "slate", docs: false, drift: true, current: "python -m unittest discover -s quality", old: "python -m unittest discover -s tests", order: ["hint", "baseline"], numbers: [31, 42, 72] },
];
const fixtureTool = fileURLToPath(new URL("./fixture-tool.ts", import.meta.url));
const system = "You are working in a synthetic Python repository. Use only the workspace tool. A run takes an exact command. Do not guess the verification code; run the actual check. The final response must be exactly the verification code printed by the check, with no markup.";
const prompt = "Verify the repository by running its test suite. Return the verification code printed by the successful run.";
const python = process.env.ROTOM_EVAL_PYTHON ?? "/usr/bin/python3";
assert(isAbsolute(python), "ROTOM_EVAL_PYTHON must be absolute");

function createFixture(root, task, command, live) {
	mkdirSync(root);
	const argv = command.split(" ");
	const dir = argv.at(-1);
	const numbers = live ? task.numbers : [9, 11, 81];
	const code = `CHECK-${numbers.reduce((a, n) => a + n, 0) * 7}`;
	const setup = { root, argv, python, code, files: {
		"README.md": `# ${task.id}\nA tiny validation project. ${task.docs ? `Run tests: \`${command}\`.` : "Tests use the standard library. See pyproject.toml for project layout."}\n`,
		"pyproject.toml": `[project]\nname = "${task.id}"\n[tool.validation]\ntest-dir = "${dir}"\n`,
		[`${dir}/test_validation.py`]: "# Validates the synthetic fixture and prints a check code.\n",
	} };
	mkdirSync(join(root, dir));
	writeFileSync(join(root, dir, "test_validation.py"), `import unittest\n\nclass Verify(unittest.TestCase):\n    def test_checks(self):\n        readings = ${JSON.stringify(numbers)}\n        self.assertTrue(all(x > 0 for x in readings))\n        print(f'CHECK-{sum(readings) * 7}')\n`);
	writeFileSync(join(root, "spec.json"), JSON.stringify(setup), { mode: 0o600 });
	return setup;
}

// Structured observations only. Unknown text is never interpolated into the hint.
function learn(rows, allowed) {
	const observed = rows.filter(({ command }) => allowed.includes(command));
	const confirmed = allowed.filter(command => {
		const evidence = observed.filter(row => row.command === command);
		return !evidence.some(row => !row.ok) && new Set(evidence.map(row => row.session)).size >= 3;
	});
	return confirmed.length === 1 ? confirmed[0] : null;
}

function replayHistory(root, task) {
	const rows = [];
	for (let session = 1; session <= (task.drift ? 4 : 3); session++) {
		const actual = task.drift && session < 4 ? task.old : task.current;
		const fixture = createFixture(join(root, `${task.id}-${session}`), task, actual, false);
		for (const command of [task.old, task.current]) {
			const { ok, infrastructure, text } = fixtureAction(fixture, { action: "run", name: command });
			assert(!infrastructure && (!ok || text.trim() === fixture.code), "history fixture preflight failed");
			rows.push({ session, command, ok });
		}
	}
	return { rows, command: learn(rows, [task.old, task.current]) };
}

function attempt(root, task, arm, history, binary, provider, model) {
	const fixture = createFixture(root, task, task.current, true);
	const test = fixtureAction(fixture, { action: "run", name: task.current });
	assert(test.ok && test.text.trim() === fixture.code, "live fixture preflight failed");
	const hint = arm === "hint" && history.command !== null;
	const args = ["--provider", provider, "--model", model, "--thinking", "off", "--mode", "json", "-p",
		"--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-mcp",
		"--no-builtin-tools", "--tools", "workspace", "--extension", fixtureTool, "--system-prompt", system];
	if (hint) args.push("--append-system-prompt", `Repository note (verified in prior sessions): run the test suite with ${history.command}.`);
	const started = performance.now();
	const run = spawnSync(binary, [...args, prompt], {
		cwd: root, timeout: 100_000, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
		env: { ...process.env, ROTOM_OBSERVABILITY: "0", ROTOM_MICRO_SKILLS_FIXTURE: join(root, "spec.json") },
	});
	let trace = { calls: [], messages: [] };
	try { trace = JSON.parse(readFileSync(join(root, "trace.json"), "utf8")); }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	const calls = trace.calls;
	const interrupted = trace.messages.some(m => ["error", "aborted"].includes(m.stopReason));
	const infrastructure = run.error?.code ?? (run.status !== 0 ? `exit:${run.status}` :
		!trace.scopeOk ? "tool-scope" : calls.some(c => c.infrastructure) ? "fixture-command" :
		interrupted && !trace.limitHit ? "assistant-error" : !trace.messages.length ? "missing-usage-events" : null);
	return { task: task.id, arm, hint, elapsedMs: Math.round(performance.now() - started), infrastructure,
		pass: infrastructure ? null : !!trace.answerOk && calls.some(c => c.action === "run" && c.ok),
		limitHit: !!trace.limitHit, calls, messages: trace.messages,
	};
}

const [mode, provider, model, output] = process.argv.slice(2);
assert(mode === "--self-test" || (mode === "--live" && provider && model && output),
	"Use --self-test or --live PROVIDER MODEL NEW_OUTPUT_JSON (optional ROTOM_EVAL_BIN)");
const root = mkdtempSync(join(tmpdir(), "micro-skills-pilot-"));
try {
	const histories = Object.fromEntries(tasks.map(t => [t.id, replayHistory(root, t)]));
	if (mode === "--self-test") {
		for (const task of tasks) {
			const h = histories[task.id];
			assert.equal(h.command, task.drift ? null : task.current);
			assert.equal(learn(h.rows.filter(r => r.session < 3), [task.old, task.current]), null);
			assert.equal(learn([...h.rows, ...h.rows].filter(r => r.session === 1), [task.old, task.current]), null);
		}
		const fixture = createFixture(join(root, "allowlist"), tasks[0], tasks[0].current, true);
		assert.equal(fixtureAction(fixture, { action: "read", name: "spec.json" }).ok, false);
		assert.equal(fixtureAction(fixture, { action: "run", name: `${tasks[0].current}; echo bypass` }).ok, false);
		assert.equal(fixtureAction(fixture, { action: "run", name: tasks[0].current }).text.trim(), fixture.code);
		console.log("PASS: 4 histories, threshold, dedup, contradiction and fixture allowlist");
	} else {
		const binary = process.env.ROTOM_EVAL_BIN || "rotom";
		const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
		assert.equal(version.status, 0, "rotom --version failed");
		const dest = resolve(output);
		const results = { schema: "rotom-micro-skills-pilot/v1", date: new Date().toISOString().slice(0, 10),
			version: version.stdout.trim(), provider, model, thinking: "off", histories, runs: [] };
		writeFileSync(dest, JSON.stringify(results, null, 2) + "\n", { flag: "wx", mode: 0o600 });
		for (const task of tasks) for (const arm of task.order) {
			const run = attempt(join(root, `${task.id}-${arm}`), task, arm, histories[task.id], binary, provider, model);
			results.runs.push(run);
			writeFileSync(dest, JSON.stringify(results, null, 2) + "\n");
			console.log(task.id, arm, run.infrastructure ?? (run.pass ? "PASS" : "FAIL"), `${run.elapsedMs}ms`);
			// Stop spending on a broken evaluation configuration; preserve attempted rows.
			if (run.infrastructure) throw new Error(`Attempt blocked: ${run.infrastructure}`);
		}
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
