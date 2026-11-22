import { readFileSync } from "node:fs";
import { join } from "node:path";

export const snapshot = "01b087c75bc99366135880a9c933842085a3b4c1";
export const schedule = ["ABC", "BCA", "CAB"];
export const audit = "python3 -m unittest discover -s scripts -p 'test_audit*.py'";
const vitest = (file) => `npm --prefix rotom/evals test -- test/${file}.test.ts`;
const direct = (file) => `cd rotom/evals && npx vitest run test/${file}.test.ts`;
const focus = ' -t "separates mixed ownership"';

export const tasks = [
	{
		id: "benchmark-runner", kind: "incident", target: vitest("benchmark-runner"),
		wrong: direct("benchmark-runner"),
		prompt: "Verify the rotom benchmark runner by running its focused unit test suite.",
		files: ["rotom/evals/test/benchmark-runner.test.ts"],
	},
	{
		id: "loop-gate-ledger", kind: "incident", target: vitest("loop-gate-ledger"),
		wrong: direct("loop-gate-ledger"),
		prompt: "Verify the rotom optimization loop's gate and ledger using its focused unit test suite.",
		files: ["rotom/evals/test/loop-gate-ledger.test.ts"],
	},
	{
		id: "public-audit", kind: "documented", target: audit,
		prompt: "Verify the repository's public privacy-audit scripts by running their documented unit test suite.",
		files: ["docs/agent/verification.md"],
	},
	{
		id: "continuation-drift", kind: "drift", target: vitest("continuation-regression") + focus,
		wrong: "cd rotom/evals && npx vitest run --config vitest.test.config.ts test/behavioral-regression.test.ts",
		prompt: "Verify the continuation regression check that separates mixed ownership mechanisms from direct conformance prompts. Run the single focused test, not the full suite.",
		files: ["rotom/evals/test/continuation-regression.test.ts"],
	},
];

const packageFiles = ["rotom/evals/package.json", "rotom/evals/bin/test", "rotom/evals/vitest.config.ts", "rotom/evals/vitest.test.config.ts"];
const vitestPass = "^\\s*Tests\\s+.*\\b[1-9][0-9]* passed\\b";
const unittestPass = "^Ran [1-9][0-9]* tests? in ";

export function materialize(task, checkout, root, env, python) {
	const cwd = join(checkout, "rotom/evals");
	const build = (bin, args, where, expect, id) => ({ bin, args, cwd: where, env, timeout: 240_000, expect, id });
	const buildVitest = (config, file, id, extra = []) => build(process.execPath,
		[join(cwd, "node_modules/vitest/vitest.mjs"), "run", ...(config ? ["--config", config] : []), file, ...extra], cwd, vitestPass, id);
	const commands = {};
	if (task.kind === "documented") {
		commands[task.target] = build(python, ["-m", "unittest", "discover", "-s", "scripts", "-p", "test_audit*.py"], checkout, unittestPass, "target");
	} else {
		const file = (name) => `test/${name}.test.ts`;
		const selected = task.kind === "drift" ? "continuation-regression" : task.id;
		const extra = task.kind === "drift" ? ["-t", "separates mixed ownership"] : [];
		const config = "vitest.test.config.ts";
		const target = buildVitest(config, file(selected), "target", extra);
		commands[task.target] = target;
		// Public, reproducible spellings that invoke the same argv. Never pass model text to a shell.
		commands[`cd rotom/evals && npm test -- ${file(selected)}${task.kind === "drift" ? focus : ""}`] = target;
		commands[`cd rotom/evals && npx vitest run --config ${config} ${file(selected)}${task.kind === "drift" ? focus : ""}`] = target;
		if (task.kind === "drift") {
			const stale = buildVitest(config, file("behavioral-regression"), "stale");
			commands[task.wrong] = stale;
			commands[`cd rotom/evals && npm test -- ${file("behavioral-regression")}`] = stale;
			commands[vitest("behavioral-regression")] = stale;
		} else {
			const wrong = buildVitest(null, file(selected), "wrong-config");
			commands[task.wrong] = wrong;
			commands[`cd rotom/evals && ./node_modules/.bin/vitest run ${file(selected)}`] = wrong;
		}
	}
	const files = Object.fromEntries([...task.files, ...(task.kind === "documented" ? [] : packageFiles)]
		.map(path => [path, readFileSync(join(checkout, path), "utf8")]));
	const note = `Run this check with \`${task.kind === "drift" ? task.wrong : task.target}\`.`;
	return { root, files, commands, note, prompt: `${task.prompt}\nUse the workspace tool. Respond with exactly PASS only after the requested tests have passed; otherwise return FAIL.` };
}
