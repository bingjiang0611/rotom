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
	assistantMessageOf, cutEntries, deleteReplayCase, lastFailedCall, readReplayCases, readReplayRuns, replayConclusions, replayConclusion, REPLAY_JUDGE_PROMPT_VERSION,
	replayCaseInput, replayCaseKey, replayCasesDir, replaySource, REPLAY_TOOL_BLOCK_REASON, ruleVerdict, runReplayPlan, sessionSha256, writeReplayCase,
} from "./eval/replay.mjs";
import { blockerExtension } from "../../evals/scripts/session-replay.mjs";
import { measureReplayPlan } from "./eval/replay-plan.mjs";
import { createReplayService } from "./eval/replay-service.mjs";
import { startTraceDashboard } from "./dashboard.mjs";
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
	// One row per product arm and repetition, plus the original control.
	assert.equal(results.length, 5);
	assert.equal(results.filter((row) => row.arm !== "original").every((row) => row.verdict === "pass"), true);
	const original = results.find((row) => row.arm === "original");
	// The pinned reply in this fixture is the failure the point was made from, so
	// the control fails and the point proves improvement: "caught".
	assert.equal(original.verdict, "fail");
	assert.deepEqual(replayConclusions(results), [{ key: cases[0].key, conclusion: "caught" }]);
	assert.equal(original.repetition, 1, "the control runs once, not once per repetition");
	assert.equal(original.productDigest, null, "no product was loaded for the control");
	assert.equal(original.usage, null, "a rule point sends nothing, so it has no usage");
	const file = join(space.directory, "replay", "runs", "2026-10-27", `${cases[0].key}-candidate-1.json`);
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	assert.equal((await stat(join(space.directory, "replay", "runs", "2026-10-27"))).mode & 0o777, 0o700);
	const stored = JSON.parse(await readFile(file, "utf8"));
	assert.equal(stored.reply.text, "第 1 次：已读日志，下一步查配置。");
	assert.equal(stored.rule, "nonempty-handoff");
	const latest = await readReplayRuns(space.directory);
	assert.equal(latest.size, 1);
	// Kept per arm: dropping the control would hide the comparison in the list.
	assert.deepEqual(Object.keys(latest.get(cases[0].key)).sort(), ["baseline", "candidate", "original"]);
	// The panel reads the same rows through the service, control included.
	const service = createReplayService({ directory: space.directory, sessionsRoot: space.sessions, product: space.root });
	const listed = await service.cases();
	assert.deepEqual(listed.cases[0].arms.original.verdict, "fail");
	assert.deepEqual(Object.keys(listed.cases[0].arms).sort(), ["baseline", "candidate", "original"]);
	assert.equal(listed.cases[0].conclusion, "caught");
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
	assert.equal(changed.every((row) => row.verdict === "unknown" && row.reason === "source_changed"), true);
	assert.equal(changed.length, 2, "the control is unknown too, so the point cannot be labelled");
	const broken = await runReplayPlan({
		directory: space.directory, day: "2026-10-28", cases, arms: ["candidate"],
		sessionOf: async () => replaySource({ branch: session.branch, sessionContent: session.content, expectedSha256: session.sha, cutEntryId: first }),
		generate: async () => { throw new Error("no model"); },
	});
	const brokenCandidate = broken.find((row) => row.arm === "candidate");
	assert.equal(brokenCandidate.verdict, "unknown");
	assert.match(brokenCandidate.reason, /generation_failed: no model/u);
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

test("cancelling a running replay stops the runner", async () => {
	const space = await workspace();
	const session = await synthetic(space);
	const [first] = assistantIds(session.branch);
	await writeFixture(join(space.sessions, `${session.id}.jsonl`), session.content, { mode: 0o600 });
	const service = createReplayService({ directory: space.directory, sessionsRoot: space.sessions, product: space.root, spawnProcess: (node) => spawn(node, ["-e", "setTimeout(()=>{},30000)"]) });
	const point = await service.add({ sessionId: session.id, cutEntryId: first, expected: "先查状态", check: { mode: "rule", rule: "nonempty-handoff" } });
	const started = await service.start({ cases: [point.key], model: "faux/faux-1" });
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
	assert.equal(service.status(started.runId).status, "running");
	assert.deepEqual(service.cancel(started.runId), { cancelled: true, status: "cancelled" });
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
	assert.equal(service.status(started.runId).status, "cancelled");
	assert.deepEqual(service.cancel("missing-run"), { cancelled: false, status: "unknown" });
	service.close();
});

test("a release build without the replay runner refuses instead of spawning a dead child", async () => {
	// The npm package excludes evals/, so an installed product has no runner. The
	// panel must say so; spawning would surface a module error long after the click.
	const space = await workspace();
	const session = await synthetic(space);
	const [first] = assistantIds(session.branch);
	let spawned = 0;
	const service = createReplayService({ directory: space.directory, sessionsRoot: space.sessions, product: space.root, runner: join(space.root, "missing", "session-replay.mjs"), spawnProcess: () => { spawned++; return spawn(process.execPath, ["-e", ""]); } });
	const point = await service.add({ sessionId: session.id, cutEntryId: first, expected: "先查状态", check: { mode: "rule", rule: "nonempty-handoff" } });
	await assert.rejects(() => service.start({ cases: [point.key], model: "faux/faux-1" }), (error) => error.status === 503 && error.code === "replay_runner_unavailable");
	assert.equal(spawned, 0);
	service.close();
});

test("a long real session is still readable", async (t) => {
	// Real sessions run to tens of MB; a cap sized for small project files would
	// make every long session unreadable instead of merely slow.
	const space = await workspace();
	const session = await synthetic(space);
	// Real sessions reach tens of MB through many ordinary entries, not one giant
	// string, so pad the way a long session grows: a chain of 64 KB messages before
	// the cut. A per-project 8 MB cap would refuse the file outright.
	const lines = session.content.trimEnd().split("\n").map((line) => JSON.parse(line));
	const cut = lines.findIndex((entry) => entry.message?.role === "assistant");
	const timestamp = lines[0].timestamp;
	let parentId = lines[cut - 1].id;
	const padded = [];
	for (let index = 0; index < 150; index += 1) {
		const id = `pad-${index}`;
		padded.push({ type: "message", id, parentId, timestamp, message: { role: "user", content: "y".repeat(64 * 1024) } });
		parentId = id;
	}
	lines[cut].parentId = parentId;
	lines.splice(cut, 0, ...padded);
	await writeFixture(join(space.sessions, `${session.id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, { mode: 0o600 });
	const service = createReplayService({ directory: space.directory, sessionsRoot: space.sessions, product: space.root, spawnProcess: () => spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"]) });
	t.after(() => service.close());
	const [first] = assistantIds(session.branch);
	const point = await service.add({ sessionId: session.id, cutEntryId: first, expected: "先查状态", check: { mode: "rule", rule: "checks-before-claiming" } });
	assert.equal(point.key, replayCaseKey(session.id, first));
	assert.ok((await service.prepare({ cases: [point.key], repeats: 1 })).totalChars > 9 * 1024 * 1024);
});

