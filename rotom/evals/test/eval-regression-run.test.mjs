// Running a frozen set: comparison matrix, exit codes, report, and the gate that
// stands between a plan and a real inference call.
//
// The runner is injected here so nothing is spawned and no model is called. The real
// spawn is covered by eval-regression-e2e.test.mjs.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { readReplayCases } from "../../extensions/observability/eval/replay.mjs";
import { loadSession } from "../../extensions/observability/eval/session-data.mjs";
import { usageOf } from "../../extensions/observability/eval/judge.mjs";
import { regressionSetDigest, writeRegressionSet } from "../scripts/regression-set.mjs";
import { compareArms, regressionExitCode, summarizeRegression } from "../scripts/regression-compare.mjs";
import { main } from "../scripts/eval-regression.mjs";
import { frozenSet, point, row, workspace } from "./regression-helpers.mjs";

async function fakeProduct(root, name, body = "export default {};\n") {
	const dir = join(root, name);
	await mkdir(join(dir, "runtime"), { recursive: true });
	await writeFile(join(dir, "runtime", "product-config.mjs"), body);
	return dir;
}

/** A frozen one-point set plus a stub product dir, ready for `run`. */
async function runnableSet() {
	const space = await workspace();
	await point(space);
	const { set } = await frozenSet(space);
	await writeRegressionSet(space.directory, set);
	return { ...space, set, product: await fakeProduct(space.root, "product") };
}

test("baseline vs candidate separates a regression from a still-broken point", () => {
	const pair = (baseline, candidate, original = "fail", extra = {}) => [row("original", original), row("baseline", baseline), row("candidate", candidate, extra)];
	assert.equal(compareArms(pair("pass", "fail")).comparison, "regression");
	assert.equal(compareArms(pair("fail", "pass")).comparison, "improved");
	assert.equal(compareArms(pair("fail", "fail")).comparison, "still-failing");
	assert.equal(compareArms(pair("pass", "pass")).comparison, "stable-pass");
	// The control decides whether the point can show anything at all.
	assert.equal(compareArms(pair("fail", "pass", "pass")).comparison, "judge-blind");
	// Unknown and disagreement between repetitions cannot be concluded.
	assert.equal(compareArms(pair("unknown", "pass")).comparison, "inconclusive");
	const flaky = compareArms([row("original", "fail"), row("baseline", "pass"), row("baseline", "fail"), row("candidate", "pass"), row("candidate", "pass")], { repeats: 2 });
	assert.equal(flaky.comparison, "inconclusive");
	assert.deepEqual(flaky.reasons, ["baseline_repetitions_disagree"]);
	// Missing and short coverage is incomplete, not inconclusive: the run did not do
	// what the plan promised.
	const missing = compareArms([row("original", "fail"), row("baseline", "pass")]);
	assert.equal(missing.comparison, "incomplete");
	assert.deepEqual(missing.reasons, ["missing_candidate_arm"]);
	assert.equal(compareArms([row("original", "fail"), row("baseline", "pass"), row("candidate", "pass")], { repeats: 2 }).comparison, "incomplete");
	assert.deepEqual(compareArms([row("original", "fail"), row("baseline", "pass"), row("candidate", "pass")], { repeats: 2 }).reasons, ["baseline_repetitions_short", "candidate_repetitions_short"]);
	// Two judge prompt versions, or one the set was not frozen with, would score the
	// same reply differently.
	assert.equal(compareArms([row("original", "fail", { judgePromptVersion: "v1" }), row("baseline", "pass"), row("candidate", "pass")]).comparison, "inconclusive");
	assert.equal(compareArms([row("original", "fail"), row("baseline", "pass"), row("candidate", "pass")], { judgePromptVersion: "v1" }).comparison, "inconclusive");
	assert.equal(compareArms([row("original", "fail", { judgePromptVersion: null }), row("baseline", "pass", { judgePromptVersion: null }), row("candidate", "pass", { judgePromptVersion: null })]).comparison, "inconclusive");
});

test("exit codes: real failure, cannot conclude, and clean are distinct", () => {
	const counts = (over) => ({ total: 2, regression: 0, improved: 0, stillFailing: 0, stablePass: 0, judgeBlind: 0, inconclusive: 0, incomplete: 0, ...over });
	assert.equal(regressionExitCode({ total: 2, complete: true, counts: counts({ stablePass: 1, improved: 1 }) }), 0);
	assert.equal(regressionExitCode({ total: 2, complete: true, counts: counts({ regression: 1, stablePass: 1 }) }), 1);
	assert.equal(regressionExitCode({ total: 2, complete: true, counts: counts({ stillFailing: 1, stablePass: 1 }) }), 1);
	assert.equal(regressionExitCode({ total: 2, complete: true, counts: counts({ stablePass: 1, inconclusive: 1 }) }), 2);
	assert.equal(regressionExitCode({ total: 2, complete: true, counts: counts({ stablePass: 1, judgeBlind: 1 }) }), 2);
	// An empty or partial set can never report success.
	assert.equal(regressionExitCode({ total: 0, complete: true, counts: counts({}) }), 2);
	assert.equal(regressionExitCode({ total: 2, complete: false, counts: counts({ stablePass: 2 }) }), 2);
});

test("report counts every point once and keeps unknown usage unknown", async () => {
	const { sessions, directory } = await workspace();
	await point({ sessions, directory });
	const { set } = await frozenSet({ sessions, directory });
	const rows = [
		row("original", "fail", { key: set.cases[0].key, usage: usageOf({ usage: { input: 10, output: 5, cost: { total: 0.25 } } }) }),
		row("baseline", "pass", { key: set.cases[0].key, usage: usageOf({ usage: { input: 20, output: 8, cost: { total: 0.5 } } }) }),
		row("candidate", "fail", { key: set.cases[0].key, usage: null }),
	];
	const report = summarizeRegression({ set, rows, model: "faux/faux-2", arms: { candidate: { digest: "b" }, baseline: { digest: "a" } }, startedAt: "2026-10-28T00:00:00.000Z", finishedAt: "2026-10-28T00:01:00.000Z" });
	assert.equal(report.schema, "rotom-replay-report/v1");
	assert.equal(report.points.length, 1);
	assert.equal(report.points[0].comparison, "regression");
	assert.equal(report.counts.regression, 1);
	assert.equal(report.exitCode, 1);
	assert.equal(report.complete, true);
	assert.equal(report.usage.known, 2);
	assert.equal(report.usage.unknown, 1);
	assert.equal(report.usage.input, 30);
	assert.equal(report.usage.output, 13);
	assert.equal(report.usage.costUsd, 0.75);
	assert.equal(report.usage.partial, true);
	// A point the runner never reported is incomplete, never an implicit pass.
	const missing = summarizeRegression({ set, rows: [], model: "faux/faux-2", arms: {}, startedAt: "2026-10-28T00:00:00.000Z", finishedAt: "2026-10-28T00:01:00.000Z" });
	assert.equal(missing.points[0].comparison, "incomplete");
	assert.equal(missing.exitCode, 2);
	// A crashed runner still leaves a report that says so.
	const crashed = summarizeRegression({ set, rows: [], model: "faux/faux-2", arms: {}, startedAt: "2026-10-28T00:00:00.000Z", finishedAt: "2026-10-28T00:01:00.000Z", failure: { code: 1, message: "boom" } });
	assert.equal(crashed.complete, false);
	assert.equal(crashed.exitCode, 2);
	assert.deepEqual(crashed.warnings, ["runner_1"]);
	assert.equal(crashed.failure.message, "boom");
});

test("run refuses to send before --yes and when the plan digest moved", async () => {
	const space = await runnableSet();
	const calls = [];
	const spawnRunner = async (input) => { calls.push(input); return { code: 0, result: { runs: [], arms: {} } }; };
	const base = ["run", "--set=failures", `--baseline=${space.product}`, `--candidate=${space.product}`, "--model=faux/faux-2", `--directory=${space.directory}`, `--sessions=${space.sessions}`];
	const out = [], err = [];
	const withoutYes = await main(base, { spawnRunner, stdout: (line) => out.push(line), stderr: (line) => err.push(line) });
	assert.equal(withoutYes.exitCode, 2);
	assert.equal(calls.length, 0, "a plan without confirmation must not spawn the runner");
	assert.match(withoutYes.planDigest, /^[0-9a-f]{64}$/u);
	assert(out.some((line) => line.includes("2 个产品") || line.includes("× 1 次")));
	assert(out.some((line) => line.includes(withoutYes.planDigest)), "the confirmation must name the exact plan");
	// The printed plan carries character counts and the arm identities, not session text.
	assert(out.some((line) => line.includes(space.product)));
	assert(out.some((line) => line.includes("字符")));

	const moved = await main([...base, "--yes", `--plan-digest=${"0".repeat(64)}`], { spawnRunner, stdout: () => {}, stderr: (line) => err.push(line) });
	assert.equal(moved.exitCode, 2);
	assert.equal(calls.length, 0);

	// The printed plan promises the calls it will make, not just the row count.
	assert(out.some((line) => /生成 2 次/.test(line)), out.join("\n"));
	assert(out.some((line) => /模型判定 3 次/.test(line)), out.join("\n"));

	// A path is not a build: editing the candidate after confirmation invalidates it.
	const edited = await fakeProduct(space.root, "product-edited");
	const confirmArgs = (product) => ["run", "--set=failures", `--baseline=${space.product}`, `--candidate=${product}`, "--model=faux/faux-2", `--directory=${space.directory}`, `--sessions=${space.sessions}`];
	const planned = await main(confirmArgs(edited), { spawnRunner, stdout: () => {}, stderr: () => {} });
	await writeFile(join(edited, "runtime", "product-config.mjs"), "export default { changed: true };\n");
	const stale = await main([...confirmArgs(edited), "--yes", `--plan-digest=${planned.planDigest}`], { spawnRunner, stdout: () => {}, stderr: () => {} });
	assert.equal(stale.exitCode, 2);
	assert.equal(calls.length, 0);

	for (const [name, patch] of [["no model", { model: "" }], ["no baseline", { baseline: "" }]]) {
		const args = base.map((item) => (item.startsWith(`--${Object.keys(patch)[0]}=`) ? `--${Object.keys(patch)[0]}=${Object.values(patch)[0]}` : item));
		const result = await main(args, { spawnRunner, stdout: () => {}, stderr: () => {} });
		assert.equal(result.exitCode, 2, name);
		assert.equal(calls.length, 0, name);
	}
});

test("run turns a completed runner result into a report and its exit code", async () => {
	const space = await runnableSet();
	const { set } = space;
	const key = set.cases[0].key;
	const runs = [row("original", "fail", { key }), row("baseline", "pass", { key }), row("candidate", "fail", { key })];
	let seen;
	const spawnRunner = async (input) => { seen = input; return { code: 0, result: { runs, arms: { candidate: { digest: "c" }, baseline: { digest: "b" } }, warnings: [] } }; };
	const out = [];
	const result = await main(["run", "--set=failures", `--baseline=${space.product}`, `--candidate=${space.product}`, "--model=faux/faux-2", `--directory=${space.directory}`, `--sessions=${space.sessions}`, "--yes", "--json"], { spawnRunner, stdout: (line) => out.push(line), stderr: () => {} });
	assert.equal(result.exitCode, 1);
	assert.equal(result.report.counts.regression, 1);
	// The two arms are always passed explicitly: a single-arm run could not tell a
	// regression from a point that was already failing.
	assert(seen.args.includes(`--arm-baseline=${space.product}`));
	assert(seen.args.includes(`--product=${space.product}`));
	const written = JSON.parse(await readFile(result.report.reportPath, "utf8"));
	assert.equal(written.setDigest, set.digest);
	assert.equal(written.exitCode, 1);

	// The human output is what a person actually reads, so it must name the report
	// file and the per-point verdict rather than only the counts.
	const lines = [];
	const human = await main(["run", "--set=failures", `--baseline=${space.product}`, `--candidate=${space.product}`, "--model=faux/faux-2", `--directory=${space.directory}`, `--sessions=${space.sessions}`, "--yes"], { spawnRunner, stdout: (line) => lines.push(line), stderr: () => {} });
	assert.equal(human.exitCode, 1);
	assert(lines.some((line) => line.includes(human.report.reportPath)), lines.join("\n"));
	assert(lines.some((line) => /regression\s+synthetic-one/u.test(line)), lines.join("\n"));
});

test("suggestions name the assistant step before a correction and never write a point", async () => {
	const { sessions, directory } = await workspace();
	await point({ sessions, directory, id: "synthetic-unsure" });
	const out = [];
	await main(["suggest", `--directory=${directory}`, `--sessions=${sessions}`, "--json"], { stdout: (line) => out.push(line), stderr: () => {} });
	const summary = JSON.parse(out.at(-1));
	// This session already has a point, so it is reported as covered instead of
	// consuming the suggestion limit.
	assert.equal(summary.items.length, 0);
	assert.equal(summary.stale.length, 1);
	assert.equal(summary.stale[0].sessionId, "synthetic-unsure");
	assert.equal((await readReplayCases(directory)).length, 1, "suggest must not create a point");
	const draft = JSON.parse(await readFile(summary.path, "utf8"));
	assert.equal(draft.schema, "rotom-replay-suggestions/v1");
	assert.deepEqual(draft.items, []);
	assert.equal((await readdir(join(directory, "replay", "suggestions"))).length, 1);
});

test("add writes a point only after explicit confirmation", async () => {
	const { sessions, directory } = await workspace();
	const created = await point({ sessions, directory, id: "synthetic-add" });
	const before = (await readReplayCases(directory)).length;
	const run = (args) => main(["add", `--session=synthetic-add`, ...args, `--directory=${directory}`, `--sessions=${sessions}`], { stdout: () => {}, stderr: () => {} });
	assert.equal((await run([`--entry=${created.pinnedId}`, "--expected=先查询再下结论", "--check=rule:checks-before-claiming"])).exitCode, 2);
	assert.equal((await readReplayCases(directory)).length, before, "without --yes nothing is stored");
	// The anchor must be an assistant message: cutting at a user turn would re-run the
	// wrong decision.
	const loaded = await loadSession(created.path, { badJson: 0, lineTooLong: 0 }, new Set());
	const userEntryId = loaded.branch.find((entry) => entry.type === "message" && entry.message.role === "user").id;
	const wrongAnchor = await run([`--entry=${userEntryId}`, "--expected=先查询再下结论", "--check=rule:checks-before-claiming", "--yes"]);
	assert.equal(wrongAnchor.exitCode, 2);
	assert.equal((await readReplayCases(directory)).length, before);
	// An existing reviewed point is never overwritten by a later suggestion.
	const duplicate = await run([`--entry=${created.pinnedId}`, "--expected=另一条期望", "--check=rule:no-identical-retry", "--yes"]);
	assert.equal(duplicate.exitCode, 2);
	const unchanged = await readReplayCases(directory);
	assert.equal(unchanged.length, before);
	assert.equal(unchanged[0].check.mode, "model", "the reviewed point keeps its own check");
	assert.equal(unchanged[0].expected, "先查询再下结论，并说明尚未验证的部分。");
	// A session without a point is what this command is for.
	const fresh = await point({ sessions, directory, id: "synthetic-fresh" });
	await (await import("node:fs/promises")).rm(join(directory, "replay", "cases", `${fresh.key}.json`));
	const added = await run(["--session=synthetic-fresh", `--entry=${fresh.pinnedId}`, "--expected=先查询再下结论", "--check=rule:checks-before-claiming", "--yes"]);
	assert.equal(added.exitCode, 0);
	const after = await readReplayCases(directory);
	assert.equal(after.length, before + 1);
	assert(after.some((item) => item.sessionId === "synthetic-fresh" && item.check.rule === "checks-before-claiming"));
});

test("a set that cannot be complete never starts a paid run", async () => {
	const space = await runnableSet();
	const calls = [];
	const spawnRunner = async (input) => { calls.push(input); return { code: 0, result: { runs: [], arms: {} } }; };
	const base = ["run", "--set=failures", `--baseline=${space.product}`, `--candidate=${space.product}`, "--model=faux/faux-2", `--directory=${space.directory}`, `--sessions=${space.sessions}`, "--yes"];
	const run = (args) => main(args, { spawnRunner, stdout: () => {}, stderr: () => {} });

	// Points dropped while freezing make the set partial: refuse instead of warning.
	const excluded = { ...space.set, excluded: [{ key: "x", reason: "source_changed" }] };
	await writeRegressionSet(space.directory, { ...excluded, digest: regressionSetDigest(excluded) }, { overwrite: true });
	assert.equal((await run(base)).exitCode, 2);
	assert.equal(calls.length, 0);

	// A set frozen with another judge prompt cannot be compared by this runner.
	const drifted = { ...space.set, judgePromptVersion: "rotom-replay-judge/v1" };
	await writeRegressionSet(space.directory, { ...drifted, digest: regressionSetDigest(drifted) }, { overwrite: true });
	assert.equal((await run(base)).exitCode, 2);
	assert.equal(calls.length, 0);
});

test("private storage inside a Git worktree is refused", async () => {
	// A checkout would let a commit publish private expectations.
	const inside = join(process.cwd(), ".eval-regression-should-not-exist");
	const result = await main(["prepare", "--name=failures", `--directory=${inside}`, `--sessions=${inside}`, "--json"], { stdout: () => {}, stderr: () => {} });
	assert.equal(result.exitCode, 2);
	await assert.rejects(() => readdir(inside), /ENOENT/u);
});
