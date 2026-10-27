// The original-reply control arm: what a point proves, and that grading the stored
// reply costs no generation. Synthetic sessions only, no product, no model.
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { fixtureSession } from "./eval-fixtures.mjs";
import { loadSession } from "./eval/session-data.mjs";
import { measureReplayPlan } from "./eval/replay-plan.mjs";
import { readReplayCases, replayConclusion, replayConclusions, REPLAY_JUDGE_PROMPT_VERSION, replaySource, runReplayPlan, sessionSha256, writeReplayCase } from "./eval/replay.mjs";

const scratch = [];
after(async () => { for (const path of scratch) await import("node:fs/promises").then(({ rm }) => rm(path, { recursive: true, force: true })); });

async function workspace() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "rotom-replay-arm-test-")));
	scratch.push(root);
	const sessions = join(root, "sessions"), directory = join(root, "evals");
	await import("node:fs/promises").then(({ mkdir }) => mkdir(sessions, { recursive: true, mode: 0o700 }));
	await import("node:fs/promises").then(({ mkdir }) => mkdir(directory, { recursive: true, mode: 0o700 }));
	return { root, sessions, directory };
}

async function synthetic(space, id = "replay-arm-synthetic") {
	await fixtureSession(space.sessions, id);
	const content = await readFile(join(space.sessions, `${id}.jsonl`), "utf8");
	const loaded = await loadSession(join(space.sessions, `${id}.jsonl`), { badJson: 0, lineTooLong: 0 }, new Set());
	return { id, content, branch: loaded.branch, sha: sessionSha256(content) };
}

const assistantIds = (branch) => branch.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").map((entry) => entry.id);

test("the point label names what the control proves", () => {
	const fail = { verdict: "fail", reason: "rule" }, pass = { verdict: "pass", reason: "rule" }, unknown = { verdict: "unknown", reason: "no verdict" };
	assert.equal(replayConclusion({ original: fail, candidate: pass }), "caught");
	assert.equal(replayConclusion({ original: fail, candidate: fail }), "still-failing");
	// The pinned reply did not fail the check, so the point cannot show anything.
	assert.equal(replayConclusion({ original: pass, candidate: pass }), "judge-blind");
	assert.equal(replayConclusion({ original: pass, candidate: fail }), "judge-blind");
	assert.equal(replayConclusion({ original: unknown, candidate: pass }), "unknown");
	assert.equal(replayConclusion({ original: fail, candidate: unknown }), "unknown");
	assert.equal(replayConclusion({ original: fail }), "unknown");
	assert.equal(replayConclusion({}), "unknown");
});

test("the original arm grades the pinned reply without generating anything", async () => {
	const space = await workspace();
	const session = await synthetic(space);
	// A model point: only this mode may reach the judge.
	const [first] = assistantIds(session.branch);
	await writeReplayCase(space.directory, { sessionId: session.id, cutEntryId: first, expected: "应该先查状态", check: { mode: "model" } }, session.sha);
	const cases = await readReplayCases(space.directory);
	const source = replaySource({ branch: session.branch, sessionContent: session.content, expectedSha256: session.sha, cutEntryId: first });
	const seen = [];
	const results = await runReplayPlan({
		directory: space.directory, day: "2026-10-29", cases, arms: ["candidate"],
		sessionOf: async () => source,
		// Any generation call would be a bug: the control must reuse the stored reply.
		generate: async () => { seen.push("generate"); throw new Error("must not generate for the original arm"); },
		judgeModel: async ({ reply }) => { seen.push("judge:" + reply.text.slice(0, 8)); return { verdict: reply.text ? "pass" : "fail", reason: "judged", elapsedMs: 5, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: null, costSource: "unknown", billing: "unknown" } }; },
	});
	const original = results.find((row) => row.arm === "original");
	assert.ok(original, "the control always has a row");
	// The only generation attempt is the candidate's, which fails by design here.
	assert.deepEqual(seen.filter((item) => item === "generate").length, 1);
	assert.equal(original.verdict, original.reply.text ? "pass" : "fail");
	// Usage travels from the judge, in the judge's own shape.
	assert.deepEqual(original.usage, { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: null, costSource: "unknown", billing: "unknown" });
	assert.equal(original.productDigest, null);
	assert.equal(original.judgePromptVersion, REPLAY_JUDGE_PROMPT_VERSION);
	const candidate = results.find((row) => row.arm === "candidate");
	assert.equal(candidate.verdict, "unknown");
	assert.match(candidate.reason, /generation_failed/u);
});

test("the control and the candidate go through the same judge call", async () => {
	const space = await workspace();
	const session = await synthetic(space);
	const [first] = assistantIds(session.branch);
	await writeReplayCase(space.directory, { sessionId: session.id, cutEntryId: first, expected: "先查状态", check: { mode: "model" } }, session.sha);
	const cases = await readReplayCases(space.directory);
	const calls = [];
	const results = await runReplayPlan({
		directory: space.directory, day: "2026-10-30", cases, arms: ["candidate"],
		sessionOf: async () => replaySource({ branch: session.branch, sessionContent: session.content, expectedSha256: session.sha, cutEntryId: first }),
		generate: async () => ({ message: { role: "assistant", content: [{ type: "text", text: "先查一下状态。" }] }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: null, costSource: "unknown", billing: "unknown" } }),
		judgeModel: async (input) => { calls.push(input); return { verdict: "pass", reason: "ok" }; },
	});
	assert.equal(calls.length, 2, "one judge call for the control and one for the candidate");
	assert.equal(calls[0].reply.text, results.find((row) => row.arm === "original").reply.text);
	assert.equal(calls[1].reply.text, "先查一下状态。");
	// Same point, same judge: identical expected behaviour and context on both sides.
	for (const call of calls) { assert.equal(call.item.key, cases[0].key); assert.equal(call.item.expected, "先查状态"); }
	// The same judge passes both sides, so the point itself cannot prove anything.
	assert.deepEqual(replayConclusions(results), [{ key: cases[0].key, conclusion: "judge-blind" }]);
});

test("a huge session field neither overflows the redactor nor hides a key", () => {
	// Replay measures the same text the judge sends, so it hits the same matcher.
	const big = "eyJ" + "A".repeat(9 * 1024 * 1024);
	const plan = measureReplayPlan({
		items: [{ key: "a", check: { mode: "model" }, expected: "先查状态", entries: [{ type: "message", message: { role: "user", content: big } }, { type: "message", message: { role: "user", content: "apiKey = sk-ant-" + "k".repeat(30) } }] }],
		repeats: 1, arms: 1,
	});
	assert.ok(plan.maxChars > 9 * 1024 * 1024);
	assert.equal(plan.redactionTotal, 1);
	assert.deepEqual(plan.redactions.map((row) => row.type), ["anthropic-key"]);
});
