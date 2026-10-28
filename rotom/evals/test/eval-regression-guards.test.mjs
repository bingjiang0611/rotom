// Guards that stand between a plan and a paid run, tested where they are easy to miss:
// relative private paths, an inherited Pi runtime, and a set frozen from a truncated
// scan. Synthetic sessions only; the runner is injected, so nothing is spawned.
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { writeRegressionSet, regressionSetDigest } from "../scripts/regression-set.mjs";
import { main } from "../scripts/eval-regression.mjs";
import { frozenSet, point, workspace } from "./regression-helpers.mjs";

const quiet = { stdout: () => {}, stderr: () => {} };

async function ready() {
	const space = await workspace();
	await point(space);
	const { set } = await frozenSet(space);
	await writeRegressionSet(space.directory, set);
	// A product is identified by its runtime marker; the run never loads it here.
	const product = join(space.root, "product");
	await (await import("node:fs/promises")).mkdir(join(product, "runtime"), { recursive: true });
	await (await import("node:fs/promises")).writeFile(join(product, "runtime", "product-config.mjs"), "export default {};\n");
	return { ...space, set, product };
}

test("a relative private directory is still refused inside a Git worktree", async (t) => {
	// The guard must resolve first. From a subdirectory of the checkout, "private-evals"
	// would otherwise walk "./" and stop before seeing the repository root above it.
	const before = process.cwd();
	const nested = join(before, "rotom", "evals");
	t.after(() => process.chdir(before));
	process.chdir(nested);
	const result = await main(["prepare", "--name=failures", "--directory=private-evals", "--sessions=private-evals"], quiet);
	assert.equal(result.exitCode, 2);
	await assert.rejects(() => readdir(join(nested, "private-evals")), /ENOENT/u);
});

test("an inherited Pi runtime override blocks the run before any request", async () => {
	const space = await ready();
	const calls = [];
	const spawnRunner = async (input) => { calls.push(input); return { code: 0, result: { runs: [], arms: {} } }; };
	const previous = process.env.ROTOM_PI;
	process.env.ROTOM_PI = "/somewhere/else/pi";
	try {
		const result = await main(["run", "--set=failures", `--baseline=${space.product}`, `--candidate=${space.product}`, "--model=faux/faux-2", `--directory=${space.directory}`, `--sessions=${space.sessions}`, "--yes"], { ...quiet, spawnRunner });
		// The digest does not bind the Pi runtime, so a different one must not run.
		assert.equal(result.exitCode, 2);
		assert.equal(calls.length, 0);
	} finally {
		if (previous === undefined) delete process.env.ROTOM_PI;
		else process.env.ROTOM_PI = previous;
	}
});

test("a set frozen from a truncated scan never starts a paid run", async () => {
	const space = await ready();
	const calls = [];
	const spawnRunner = async (input) => { calls.push(input); return { code: 0, result: { runs: [], arms: {} } }; };
	// Today's index is fine; the frozen scan is what says coverage cannot be proven.
	const truncated = { ...space.set, scan: { ...space.set.scan, indexComplete: false } };
	await writeRegressionSet(space.directory, { ...truncated, digest: regressionSetDigest(truncated) }, { overwrite: true });
	const result = await main(["run", "--set=failures", `--baseline=${space.product}`, `--candidate=${space.product}`, "--model=faux/faux-2", `--directory=${space.directory}`, `--sessions=${space.sessions}`, "--yes"], { ...quiet, spawnRunner });
	assert.equal(result.exitCode, 2);
	assert.equal(calls.length, 0);
});
