// Replay prep: how the confirmation numbers are measured, and how the comparison
// arm is resolved. Synthetic data only; no product runtime and no model.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { clampRepeats, measureReplayPlan } from "./eval/replay-plan.mjs";
import { resolveReplayBaseline } from "./eval/replay-service.mjs";
import { runReplayPlan } from "./eval/replay.mjs";

const scratch = [];
after(async () => { for (const path of scratch) await import("node:fs/promises").then(({ rm }) => rm(path, { recursive: true, force: true })); });

async function space(prefix = "rotom-replay-plan-") {
	const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	scratch.push(root);
	return root;
}

const entry = (text) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });

test("repeats are clamped to the runner's range", () => {
	assert.equal(clampRepeats(undefined), 1);
	assert.equal(clampRepeats(0), 1);
	assert.equal(clampRepeats(2.5), 1);
	assert.equal(clampRepeats(3), 3);
	assert.equal(clampRepeats(9), 3);
});

test("the plan counts characters from the redacted prefix only", () => {
	const items = [
		{ key: "a", check: { mode: "rule", rule: "checks-before-claiming" }, entries: [entry("hello"), entry("apiKey = sk-abcdefghijklmnopqrstuvwx")] },
		{ key: "b", check: { mode: "model" }, entries: [entry("token: abcdefghijklmnopqrstuvwxyz012345")] },
	];
	const plan = measureReplayPlan({ items, repeats: 2, arms: 1 });
	// 2 points × 2 repetitions for the product, plus one control run per point.
	assert.equal(plan.runs, 6);
	assert.equal(plan.originalRuns, 2);
	assert.equal(plan.repeats, 2);
	assert.equal(plan.arms, 1);
	assert.deepEqual(plan.cases.map((item) => item.key), ["a", "b"]);
	// The marker is shorter than the secret, so counting the raw text would lie.
	for (const item of plan.cases) assert.match(String(item.chars), /^\d+$/u);
	assert.ok(plan.cases[0].chars < JSON.stringify(items[0].entries).length);
	assert.equal(plan.perCaseChars, plan.cases.reduce((total, item) => total + item.chars, 0));
	// The control sends the judge input only, and only for the model-mode point.
	assert.equal(plan.cases[0].originalChars, 0);
	assert.ok(plan.cases[1].originalChars > 0);
	assert.equal(plan.originalChars, plan.cases[1].originalChars);
	assert.equal(plan.totalChars, plan.perCaseChars * 2 + plan.originalChars);
	// The largest single point is what can blow a context window.
	assert.equal(plan.maxChars, Math.max(...plan.cases.map((item) => item.chars)));
	// Only the model-mode point reports masked credentials.
	assert.equal(plan.modelCases, 1);
	assert.equal(plan.redactionTotal, 1);
	assert.deepEqual(plan.redactions.map((row) => row.type), ["assigned-secret"]);
});

test("two arms double the run count and the total characters", () => {
	const items = [{ key: "a", check: { mode: "rule", rule: "nonempty-handoff" }, entries: [entry("x")] }];
	const plan = measureReplayPlan({ items, repeats: 1, arms: 2 });
	// Two products plus the control.
	assert.equal(plan.runs, 3);
	assert.equal(plan.arms, 2);
	assert.equal(plan.originalChars, 0, "a rule point sends nothing for the control");
	assert.equal(plan.totalChars, plan.cases[0].chars * 2);
});

test("the comparison arm needs an explicit, valid product directory", async () => {
	const root = await space();
	assert.deepEqual(await resolveReplayBaseline(undefined), { enabled: false, reason: "not_configured" });
	assert.deepEqual(await resolveReplayBaseline(""), { enabled: false, reason: "not_configured" });
	assert.deepEqual(await resolveReplayBaseline("rotom"), { enabled: false, reason: "not_absolute" });
	assert.deepEqual(await resolveReplayBaseline(join(root, "missing")), { enabled: false, reason: "not_a_directory" });
	await mkdir(join(root, "plain"), { recursive: true });
	assert.deepEqual(await resolveReplayBaseline(join(root, "plain")), { enabled: false, reason: "not_a_product" });
	await mkdir(join(root, "product", "runtime"), { recursive: true });
	await writeFile(join(root, "product", "runtime", "product-config.mjs"), "export default {};\n");
	assert.deepEqual(await resolveReplayBaseline(join(root, "product")), { enabled: true, path: join(root, "product") });
	// A symlink would make the comparison product depend on wherever it points.
	await symlink(join(root, "product"), join(root, "linked"));
	assert.deepEqual(await resolveReplayBaseline(join(root, "linked")), { enabled: false, reason: "symlink" });
});

test("identical product digests are stamped on every run row", async () => {
	const root = await space();
	const day = "2026-01-01";
	const plan = { sessionId: "s", cutEntryId: "entry-1", sessionSha256: "x", expected: "先查状态", check: { mode: "rule", rule: "nonempty-handoff" } };
	const base = { directory: root, day, cases: [{ ...plan, key: "s-entry-1" }], repeats: 1, now: () => new Date("2026-01-01T00:00:00.000Z"),
		sessionOf: async () => ({ status: "ready", entries: [{ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } }], lastFailed: undefined }),
		generate: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "先查状态" }] } }) };
	const same = await runReplayPlan({ ...base, arms: ["candidate", "baseline"], productDigests: { candidate: "d1", baseline: "d1" } });
	// The control row is first and carries no product at all.
	assert.deepEqual(same.map((row) => row.sameProduct), [null, true, true]);
	assert.deepEqual(same.map((row) => row.arm), ["original", "candidate", "baseline"]);
	const different = await runReplayPlan({ ...base, arms: ["candidate", "baseline"], productDigests: { candidate: "d1", baseline: "d2" } });
	assert.deepEqual(different.map((row) => row.sameProduct), [null, false, false]);
	const single = await runReplayPlan({ ...base, arms: ["candidate"], productDigests: { candidate: "d1" } });
	assert.deepEqual(single.map((row) => row.sameProduct), [null, null]);
});
