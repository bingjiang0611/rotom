// Session replay domain tests: synthetic sessions only, no model, no real workspace.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { after, test } from "node:test";
import { fixtureSession } from "./eval-fixtures.mjs";
import { loadSession } from "./eval/session-data.mjs";
import {
	assistantMessageOf, combineVerdicts, cutEntries, deleteReplayCase, lastFailedCall, readReplayCases, readReplayRuns,
	replayCaseInput, replayCaseKey, replayCasesDir, replaySource, REPLAY_TOOL_BLOCK_REASON, ruleVerdict, runReplayPlan, sessionSha256, writeReplayCase,
} from "./eval/replay.mjs";
import { blockerExtension } from "../../evals/scripts/session-replay.mjs";
import { createReplayService } from "./eval/replay-service.mjs";
import { writeFile as writeFixture } from "node:fs/promises";

const scratch = [];
after(async () => { for (const path of scratch) await import("node:fs/promises").then(({ rm }) => rm(path, { recursive: true, force: true })); });

async function workspace() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "rotom-replay-test-")));
	scratch.push(root);
	const sessions = join(root, "sessions"), directory = join(root, "evals");
	await mkdir(sessions, { recursive: true, mode: 0o700 });
	await mkdir(directory, { recursive: true, mode: 0o700 });
	return { root, sessions, directory };
}

async function synthetic(workspace, id = "replay-synthetic") {
	await fixtureSession(workspace.sessions, id);
	const content = await readFile(join(workspace.sessions, `${id}.jsonl`), "utf8");
	const loaded = await loadSession(join(workspace.sessions, `${id}.jsonl`), { badJson: 0, lineTooLong: 0 }, new Set());
	return { id, content, branch: loaded.branch, sha: sessionSha256(content) };
}

const assistantIds = (branch) => branch.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").map((entry) => entry.id);

test("the cut keeps every entry before the pinned assistant message", async () => {
	const space = await workspace();
	const session = await synthetic(space);
	const [first, second] = assistantIds(session.branch);
	const firstCut = cutEntries(session.branch, first), secondCut = cutEntries(session.branch, second);
	assert.equal(secondCut.entries.length - firstCut.entries.length, 2);
	assert.equal(secondCut.entries.some((entry) => entry.id === second), false);
	assert.equal(secondCut.pinned.id, second);
	// Compaction and other non-message entries stay inside the kept prefix.
	assert.equal(secondCut.entries.every((entry) => typeof entry.type === "string"), true);
	assert.equal(cutEntries(session.branch, "missing-entry"), undefined);
	assert.equal(cutEntries(session.branch, session.branch[0].id), undefined, "a non-assistant entry is not a replay point");
});

test("a replay point records the session digest and replays only its prefix", async () => {
	const space = await workspace();
	const session = await synthetic(space);
	const point = await writeReplayCase(space.directory, { sessionId: session.id, cutEntryId: assistantIds(session.branch)[1], expected: "先查状态再回答", check: { mode: "rule", rule: "checks-before-claiming" } }, session.sha);
	assert.equal(point.key, replayCaseKey(session.id, assistantIds(session.branch)[1]));
	const ready = replaySource({ branch: session.branch, sessionContent: session.content, expectedSha256: session.sha, cutEntryId: point.cutEntryId });
	assert.equal(ready.status, "ready");
	assert.equal(ready.entries.length, cutEntries(session.branch, point.cutEntryId).entries.length);
	assert.deepEqual(replaySource({ branch: session.branch, sessionContent: session.content + "\n", expectedSha256: session.sha, cutEntryId: point.cutEntryId }), { status: "unknown", reason: "source_changed" });
	assert.deepEqual(replaySource({ branch: session.branch, sessionContent: session.content, expectedSha256: session.sha, cutEntryId: "gone" }), { status: "unknown", reason: "cut_not_found" });
	// The fixture's failed tool result is visible before the cut, for no-identical-retry.
	assert.ok(ready.entries.some((entry) => entry.message?.role === "toolResult" && entry.message.isError === true));
});

test("the three rules each accept a good step and reject the reviewed failure", () => {
	const failed = { name: "bash", args: { command: "npm test" } };
	const good = assistantMessageOf({ content: [{ type: "text", text: "先看一下现在的状态。" }, { type: "toolCall", name: "bash", arguments: { command: "git status --short" } }] });
	const lazy = assistantMessageOf({ content: [{ type: "text", text: "已经全部修好了，可以合并。" }] });
	const writes = assistantMessageOf({ content: [{ type: "toolCall", name: "edit", arguments: { path: "a.ts" } }] });
	const repeat = assistantMessageOf({ content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }] });
	const changed = assistantMessageOf({ content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test -- --run" } }] });
	assert.equal(ruleVerdict("checks-before-claiming", { reply: good }).verdict, "pass");
	assert.equal(ruleVerdict("checks-before-claiming", { reply: lazy }).verdict, "fail");
	assert.equal(ruleVerdict("checks-before-claiming", { reply: writes }).reason, "acted with edit before querying");
	assert.equal(ruleVerdict("no-identical-retry", { reply: repeat, lastFailed: failed }).verdict, "fail");
	assert.equal(ruleVerdict("no-identical-retry", { reply: changed, lastFailed: failed }).verdict, "pass");
	assert.equal(ruleVerdict("no-identical-retry", { reply: good }).verdict, "unknown");
	assert.equal(ruleVerdict("nonempty-handoff", { reply: good }).verdict, "pass");
	assert.equal(ruleVerdict("nonempty-handoff", { reply: assistantMessageOf({ content: [] }) }).verdict, "fail");
	assert.equal(ruleVerdict("nonempty-handoff", { reply: assistantMessageOf({ content: [{ type: "text", text: "嗯。" }] }) }).reason, "reply says nothing about progress or next step");
});

test("the last failed call before the cut is recovered for the retry rule", async () => {
	const space = await workspace();
	const session = await synthetic(space);
	const cut = cutEntries(session.branch, assistantIds(session.branch)[1]);
	const failed = lastFailedCall(cut.entries);
	assert.ok(failed, "the fixture contains one failed tool result");
	assert.equal(typeof failed.name, "string");
	assert.ok(failed.args && typeof failed.args === "object");
	assert.equal(lastFailedCall(cut.entries.slice(0, 1)), undefined);
});

test("unknown never becomes a pass", () => {
	assert.equal(combineVerdicts({ verdict: "unknown", reason: "no context" }).verdict, "unknown");
	assert.equal(combineVerdicts({ verdict: "fail", reason: "rule" }, { verdict: "pass", reason: "model" }).verdict, "fail");
	assert.equal(combineVerdicts({ verdict: "unknown", reason: "rule" }, { verdict: "fail", reason: "model" }).verdict, "fail");
	assert.equal(combineVerdicts({ verdict: "pass", reason: "rule" }, { verdict: "unknown", reason: "model" }).verdict, "pass");
	assert.equal(combineVerdicts(undefined, undefined).verdict, "unknown");
});

test("a run writes one private record per arm and repetition", async () => {
	const space = await workspace();
	const session = await synthetic(space);
	const [first] = assistantIds(session.branch);
	await writeReplayCase(space.directory, { sessionId: session.id, cutEntryId: first, expected: "先查状态", check: { mode: "rule", rule: "nonempty-handoff" } }, session.sha);
	const cases = await readReplayCases(space.directory);
	const seen = [];
	const results = await runReplayPlan({
		directory: space.directory, day: "2026-10-27", cases, arms: ["candidate", "baseline"], repeats: 2,
		sessionOf: async () => replaySource({ branch: session.branch, sessionContent: session.content, expectedSha256: session.sha, cutEntryId: first }),
		generate: async ({ arm, repetition }) => { seen.push(`${arm}:${repetition}`); return { message: { role: "assistant", content: [{ type: "text", text: `第 ${repetition} 次：已读日志，下一步查配置。` }] } }; },
	});
	assert.deepEqual(seen.sort(), ["baseline:1", "baseline:2", "candidate:1", "candidate:2"]);
	assert.equal(results.length, 4);
	assert.equal(results.every((row) => row.verdict === "pass"), true);
	const file = join(space.directory, "replay", "runs", "2026-10-27", `${cases[0].key}-candidate-1.json`);
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	assert.equal((await stat(join(space.directory, "replay", "runs", "2026-10-27"))).mode & 0o777, 0o700);
	const stored = JSON.parse(await readFile(file, "utf8"));
	assert.equal(stored.reply.text, "第 1 次：已读日志，下一步查配置。");
	assert.equal(stored.rule, "nonempty-handoff");
	const latest = await readReplayRuns(space.directory);
	assert.equal(latest.size, 1);
});

test("a changed session and a failed generation are recorded as unknown", async () => {
	const space = await workspace();
	const session = await synthetic(space);
	const [first] = assistantIds(session.branch);
	await writeReplayCase(space.directory, { sessionId: session.id, cutEntryId: first, expected: "先查状态", check: { mode: "rule", rule: "nonempty-handoff" } }, session.sha);
	const cases = await readReplayCases(space.directory);
	const changed = await runReplayPlan({
		directory: space.directory, day: "2026-10-27", cases, arms: ["candidate"],
		sessionOf: async () => replaySource({ branch: session.branch, sessionContent: session.content + "\n", expectedSha256: session.sha, cutEntryId: first }),
		generate: async () => { throw new Error("must not be called"); },
	});
	assert.equal(changed[0].verdict, "unknown");
	assert.equal(changed[0].reason, "source_changed");
	const broken = await runReplayPlan({
		directory: space.directory, day: "2026-10-28", cases, arms: ["candidate"],
		sessionOf: async () => replaySource({ branch: session.branch, sessionContent: session.content, expectedSha256: session.sha, cutEntryId: first }),
		generate: async () => { throw new Error("no model"); },
	});
	assert.equal(broken[0].verdict, "unknown");
	assert.match(broken[0].reason, /generation_failed: no model/u);
});

test("every tool call is blocked with the documented reason", () => {
	const source = blockerExtension();
	assert.match(source, /tool_call/u);
	assert.match(source, /block: true/u);
	assert.ok(source.includes(JSON.stringify(REPLAY_TOOL_BLOCK_REASON)));
	assert.equal(REPLAY_TOOL_BLOCK_REASON, "replay: tools are not executed");
	// The blocker never allows execution and never rewrites arguments.
	assert.equal(/allow|continue: true/u.test(source), false);
});

test("replay point storage stays private and refuses escapes", async () => {
	const space = await workspace();
	const session = await synthetic(space);
	const input = { sessionId: session.id, cutEntryId: assistantIds(session.branch)[0], expected: "先查状态", check: { mode: "rule", rule: "nonempty-handoff" } };
	await writeReplayCase(space.directory, input, session.sha);
	assert.equal((await stat(replayCasesDir(space.directory))).mode & 0o777, 0o700);
	assert.equal((await stat(join(replayCasesDir(space.directory), `${replayCaseKey(input.sessionId, input.cutEntryId)}.json`))).mode & 0o777, 0o600);
	assert.deepEqual((await readReplayCases(space.directory)).map((row) => row.expected), ["先查状态"]);
	// Path injection and unknown fields are rejected before touching the disk.
	for (const bad of ["../../etc/passwd", "a/b", "..", "", "x".repeat(300)]) {
		assert.throws(() => replayCaseInput({ ...input, cutEntryId: bad }));
		assert.throws(() => replayCaseInput({ ...input, sessionId: bad }));
	}
	assert.throws(() => replayCaseInput({ ...input, extra: 1 }));
	assert.throws(() => replayCaseInput({ ...input, expected: "  " }));
	assert.throws(() => replayCaseInput({ ...input, check: { mode: "rule", rule: "made-up" } }));
	assert.throws(() => replayCaseInput({ ...input, check: { mode: "model", rule: "nonempty-handoff" } }));
	// A symlinked case directory is refused rather than followed.
	const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "rotom-replay-outside-")));
	scratch.push(elsewhere);
	const trap = join(space.directory, "replay");
	await mkdir(trap, { recursive: true, mode: 0o700 });
	await import("node:fs/promises").then(({ rm }) => rm(join(trap, "cases"), { recursive: true, force: true }));
	await symlink(elsewhere, join(trap, "cases"));
	await assert.rejects(() => writeReplayCase(space.directory, input, session.sha));
	assert.equal((await import("node:fs/promises").then(({ readdir }) => readdir(elsewhere))).length, 0);
	await deleteReplayCase(space.directory, input.sessionId, input.cutEntryId).catch(() => {});
});

test("the dashboard service creates points from the session digest and runs the runner", async () => {
	const space = await workspace();
	const session = await synthetic(space);
	const [first] = assistantIds(session.branch);
	// A fake runner: proves the dashboard parses progress, keeps results, and that
	// cancellation is a kill, without loading a product runtime or a model.
	const runner = join(space.root, "fake-runner.mjs");
	await writeFixture(runner, `process.stdout.write(JSON.stringify({progress:{done:1,total:2}})+"\\n");
process.stdout.write(JSON.stringify({runs:[{key:"${session.id}-${first}",arm:"candidate",repetition:1,verdict:"pass",reason:"fake",checkMode:"rule"}]})+"\\n");
`, { mode: 0o600 });
	await writeFixture(join(space.sessions, `${session.id}.jsonl`), session.content, { mode: 0o600 });
	const service = createReplayService({ directory: space.directory, sessionsRoot: space.sessions, product: space.root, spawnProcess: (node, args) => {
		// The recorded argv is what the dashboard would really run.
		serviceArgs.push(args.slice(1));
		return spawn(node, [runner]);
	} });
	const serviceArgs = [];
	const point = await service.add({ sessionId: session.id, cutEntryId: first, expected: "先查状态", check: { mode: "rule", rule: "checks-before-claiming" } });
	assert.equal(point.key, replayCaseKey(session.id, first));
	const listed = await service.cases();
	assert.equal(listed.cases.length, 1);
	assert.equal(listed.cases[0].latest, null);
	const started = service.start({ cases: [point.key], model: "faux/faux-1", repeats: 2 });
	assert.equal(started.total, 2);
	assert.match(serviceArgs[0].join(" "), /--model=faux\/faux-1/u);
	assert.match(serviceArgs[0].join(" "), /--repeats=2/u);
	const waitFor = async (runId, want) => { for (let tick = 0; tick < 60; tick += 1) { const now = service.status(runId).status; if (now === want) return now; await new Promise((resolveDelay) => setTimeout(resolveDelay, 100)); } return service.status(runId).status; };
	assert.equal(await waitFor(started.runId, "done"), "done");
	const status = service.status(started.runId);
	assert.equal(status.status, "done");
	assert.equal(status.results[0].verdict, "pass");
	assert.throws(() => service.start({ cases: [], model: "faux/faux-1" }));
	assert.throws(() => service.start({ cases: [point.key], model: "not a model" }));
	await service.remove({ sessionId: session.id, cutEntryId: first });
	assert.deepEqual((await service.cases()).cases, []);
	service.close();
});

test("cancelling a running replay stops the runner", async () => {
	const space = await workspace();
	const session = await synthetic(space);
	const [first] = assistantIds(session.branch);
	await writeFixture(join(space.sessions, `${session.id}.jsonl`), session.content, { mode: 0o600 });
	const service = createReplayService({ directory: space.directory, sessionsRoot: space.sessions, product: space.root, spawnProcess: (node) => spawn(node, ["-e", "setTimeout(()=>{},30000)"]) });
	const point = await service.add({ sessionId: session.id, cutEntryId: first, expected: "先查状态", check: { mode: "rule", rule: "nonempty-handoff" } });
	const started = service.start({ cases: [point.key], model: "faux/faux-1" });
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
	assert.equal(service.status(started.runId).status, "running");
	assert.deepEqual(service.cancel(started.runId), { cancelled: true, status: "cancelled" });
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
	assert.equal(service.status(started.runId).status, "cancelled");
	assert.deepEqual(service.cancel("missing-run"), { cancelled: false, status: "unknown" });
	service.close();
});
