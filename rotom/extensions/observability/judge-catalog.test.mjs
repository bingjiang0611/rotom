// Model discovery through the launcher: catalog parsing and failure handling.
// Separate from judge.test.mjs so each file stays reviewable; synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixtureSession } from "./eval-fixtures.mjs";
import { fakeJudgeLauncher } from "./judge-fixtures.mjs";
import { createEvalService } from "./eval/service.mjs";
import { createJudgeService, JUDGE_BASE_ARGS, parseModelCatalog } from "./eval/judge.mjs";
import { startTraceDashboard } from "./dashboard.mjs";
import { COPY } from "./eval/copy.mjs";

async function fixture(t) {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "rotom-judge-catalog-test-")));
	const root = join(dir, "sessions"), directory = join(dir, "evals");
	await fixtureSession(root, "synthetic-active", { active: true, large: true });
	const fake = await fakeJudgeLauncher(dir);
	const evalService = createEvalService(root, directory);
	const judge = createJudgeService({ evalService, directory, launcher: fake.launcher, timeoutMs: 5000 });
	t.after(async () => { try { await judge.close(); } finally { await rm(dir, { recursive: true, force: true }); } });
	return { dir, root, directory, fake, evalService, judge };
}

async function calls(fake) { return (await readFile(fake.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line)); }

test("model catalog diagnostics distinguish protocol and process failures without exposing stderr", () => {
	const valid = { models: [{ id: "fake/model" }], defaultModel: "fake/model" };
	const output = { code: 0, terminal: { outcome: "exited", confirmed: true }, stdout: JSON.stringify(valid), stderr: "" };
	assert.deepEqual(parseModelCatalog(output), valid);
	assert.deepEqual(parseModelCatalog({ ...output, stdout: '{"models":[],"defaultModel":null}' }), { models: [], defaultModel: null });
	const cases = [
		[{ terminal: { outcome: "timeout", confirmed: true } }, "models_timeout"],
		[{ terminal: { outcome: "spawn-error", confirmed: true } }, "launcher_unavailable"],
		[{ terminal: { outcome: "unavailable", confirmed: false } }, "termination_unknown"],
		[{ code: 1, stderr: "rotom: [runtime_validation_failed] synthetic private path" }, "models_identity_failed"],
		[{ code: 7 }, "models_exit_failed"],
		[{ stdout: "", stderr: JSON.stringify(valid) }, "models_stdout_empty"],
		[{ stdout: "not json" }, "models_invalid_json"],
		[{ stdout: '{"models":[null],"defaultModel":null}' }, "models_invalid_catalog"],
		[{ stdout: JSON.stringify({ ...valid, models: [...valid.models, ...valid.models] }) }, "models_duplicate_ids"],
		[{ stdout: JSON.stringify({ ...valid, defaultModel: "missing/model" }) }, "models_default_missing"],
	];
	for (const [change, code] of cases) {
		assert.throws(() => parseModelCatalog({ ...output, ...change }), (error) => error.status === 503 && error.code === code && error.message === code);
		assert.ok(COPY.errors[code]);
	}
	assert.equal(COPY.modelCheckCommand, "rotom/bin/rotom-launcher " + [...JUDGE_BASE_ARGS, "--list-models"].join(" "));
});

test("stderr-only catalog is logged locally, never merged into stdout or returned by the API", async (t) => {
	const { root, directory, fake } = await fixture(t);
	const diagnostics = [];
	t.mock.method(console, "error", (text) => diagnostics.push(text));
	await writeFile(fake.control, JSON.stringify({ modelsStderr: true }));
	const dashboard = await startTraceDashboard({ root, evalDirectory: directory, judge: { launcher: fake.launcher } });
	t.after(() => dashboard.close());
	const response = await fetch(dashboard.baseUrl + "/api/eval/models", { headers: { Authorization: "Bearer " + dashboard.token } });
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: "models_stdout_empty" });
	assert.equal(diagnostics.length, 1);
	assert.ok(diagnostics[0].includes('"models"'));
	assert.equal((await calls(fake)).length, 1);
});

test("missing launcher has an explicit actionable failure", async (t) => {
	const { dir, evalService, directory } = await fixture(t);
	const judge = createJudgeService({ evalService, directory, launcher: join(dir, "missing-launcher") });
	await assert.rejects(judge.models(), { code: "launcher_unavailable" });
	await judge.close();
});

test("failed model discovery is not cached or automatically retried; a successful retry is shared", async (t) => {
	const { judge, fake } = await fixture(t);
	await writeFile(fake.control, JSON.stringify({ modelsFail: true }));
	const failures = await Promise.allSettled([judge.models(), judge.models()]);
	assert.ok(failures.every((result) => result.status === "rejected"));
	assert.equal((await calls(fake)).length, 1);
	await writeFile(fake.control, JSON.stringify({ mode: "ok" }));
	assert.deepEqual(await Promise.all([judge.models(), judge.models()]), [
		{ models: [{ id: "fake/model" }], defaultModel: "fake/model" }, { models: [{ id: "fake/model" }], defaultModel: "fake/model" },
	]);
	await judge.models();
	const logs = await calls(fake);
	assert.equal(logs.length, 2);
	assert.ok(logs.every((row) => row.args.includes("--list-models")), "retry never starts inference");
});
