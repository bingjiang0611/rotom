import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { analyzeFiles, analyzeSession } from "./analyze-session-trajectories.mjs";

const header = { type: "session", version: 3, id: "synthetic", cwd: "/synthetic", timestamp: "2026-01-01T00:00:00Z" };
const entry = (id, parentId, message) => ({ type: "message", id, parentId, message });
const call = (id, path = "private-canary.txt") => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path } }], stopReason: "toolUse" });
const result = (id, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "private-canary-content" }], isError });
const jsonl = (records) => [header, ...records].map((record) => JSON.stringify(record)).join("\n") + "\n";

function fixture() {
	return jsonl([
		entry("u", null, { role: "user", content: "private-canary-goal" }),
		entry("a", "u", call("a")),
		entry("r", "a", result("a", true)),
		entry("abandoned", "u", call("abandoned", "not-counted")),
		{ type: "compaction", id: "c", parentId: "r", summary: "private-canary-summary", firstKeptEntryId: "r", tokensBefore: 1234 },
		entry("b", "c", call("b")),
		entry("s", "b", result("b")),
		entry("pending", "s", call("pending", "different-path")),
	]);
}

test("native branch traversal excludes abandoned records; repeat crosses compaction", () => {
	const report = analyzeSession(fixture());
	assert.equal(report.counts.excludedBranchEntries, 1);
	assert.equal(report.counts.topLevelCalls, 3);
	assert.equal(report.counts.toolErrorResults, 1);
	assert.equal(report.counts.toolNonErrorResults, 1);
	assert.equal(report.counts.callsWithoutResult, 1);
	assert.equal(report.counts.repeatedCalls, 1);
	assert.equal(report.counts.repeatsAcrossCompaction, 1);
	assert.deepEqual(report.repeatedCallCandidates, [{ tool: "read", previous: { line: 3, block: 0 }, current: { line: 7, block: 0 }, acrossCompaction: true }]);
	assert.equal(report.assessment.taskSuccess, "unknown");
	assert.equal(JSON.stringify(report).includes("private-canary"), false);
});

test("nested calls with omitted arguments remain unassessed; canonical key ordering matches", () => {
	const a = call("a");
	a.content[0].arguments = { path: "x", offset: 1 };
	const b = result("a");
	b.nestedCalls = { complete: false, calls: [
		{ id: "n1", name: "read", arguments: { offset: 1, path: "x" }, status: "ok" },
		{ id: "n2", name: "private-canary-tool", argumentsBytes: 40000, status: "unfinished" },
	] };
	const report = analyzeSession(jsonl([entry("a", null, a), entry("b", "a", b)]));
	assert.equal(report.counts.nestedCalls, 2);
	assert.equal(report.counts.nestedCallsWithoutArguments, 1);
	assert.equal(report.counts.incompleteNestedRecords, 1);
	assert.equal(report.counts.repeatedCalls, 1);
	assert.deepEqual(report.byTool, { read: 2, other: 1 });
	assert.equal(JSON.stringify(report).includes("private-canary"), false);
});

test("context edits do not erase historical calls; counts stay execution-only", () => {
	const report = analyzeSession(jsonl([
		entry("a", null, call("a")),
		{ type: "context_edit", id: "hide", parentId: "a", targetId: "a", replacement: null },
		entry("b", "hide", call("b")),
	]));
	assert.equal(report.counts.contextEdits, 1);
	assert.equal(report.counts.repeatedCalls, 1);
	assert.equal(report.counts.callsWithoutResult, 2);
});

test("rejects malformed, unsupported and cyclic snapshots instead of partial success", () => {
	assert.throws(() => analyzeSession(fixture() + '{"private-canary"'), /Malformed JSONL/);
	assert.throws(() => analyzeSession(JSON.stringify({ ...header, version: 2 })), /v3/);
	assert.throws(() => analyzeSession(jsonl([entry("a", "a", call("a"))])), /Invalid session tree/);
	assert.throws(() => analyzeSession(jsonl([entry("a", "missing", call("a"))])), /Invalid session tree/);
	assert.throws(() => analyzeSession(jsonl([entry("a", null, call("a")), entry("a", null, call("b"))])), /Invalid session tree/);
});

test("bounded examples do not truncate aggregate counts", () => {
	const records = Array.from({ length: 30 }, (_, i) => entry(`e${i}`, i ? `e${i - 1}` : null, call(`c${i}`)));
	const report = analyzeSession(jsonl(records));
	assert.equal(report.counts.repeatedCalls, 29);
	assert.equal(report.repeatedCallCandidates.length, 20);
	assert.equal(report.omittedCandidateExamples, 9);
});

test("CLI is explicit, read-only, content-free and rejects duplicate/symlink/oversize inputs", async () => {
	const directory = await mkdtemp(join(tmpdir(), "rotom-trajectories-"));
	try {
		const path = join(directory, "private-canary.jsonl");
		await writeFile(path, fixture());
		const report = await analyzeFiles([path]);
		assert.equal(report.totals.topLevelCalls, 3);
		assert.equal(JSON.stringify(report).includes("private-canary"), false);
		assert.equal(await readFile(path, "utf8"), fixture());
		await assert.rejects(analyzeFiles([path, path]), /Input 2 rejected/);
		await symlink(path, join(directory, "link"));
		await assert.rejects(analyzeFiles([join(directory, "link")]), /Input 1 rejected/);
		await assert.rejects(analyzeFiles([directory]), /Input 1 rejected/);
		await assert.rejects(analyzeFiles([]), /explicit session files/);
		const script = resolve(import.meta.dirname, "analyze-session-trajectories.mjs");
		const cli = spawnSync(process.execPath, [script, path], { encoding: "utf8", timeout: 15000 });
		assert.equal(cli.status, 0, cli.stderr);
		assert.equal(JSON.parse(cli.stdout).totals.repeatedCalls, 1);
		await writeFile(path, '{"private-canary-invalid');
		const bad = spawnSync(process.execPath, [script, path], { encoding: "utf8", timeout: 15000 });
		assert.equal(bad.status, 1);
		assert.equal(bad.stdout, "");
		assert.equal(bad.stderr.includes("private-canary"), false);
		await writeFile(path, " ".repeat(16 * 1024 * 1024 + 1));
		await assert.rejects(analyzeFiles([path]), /Input 1 rejected/);
	} finally { await rm(directory, { recursive: true, force: true }); }
});
