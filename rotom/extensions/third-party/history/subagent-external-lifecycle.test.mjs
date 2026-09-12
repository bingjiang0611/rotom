// Adoption gate: synthetic lifecycle artifacts only; no models or live PIDs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, after } from "node:test";
import { prepareExternalGroupCandidate } from "./fixtures/prepare-external-group.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rotom-external-lifecycle-"));
const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(root, "runtime");
after(() => {
	if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
	else process.env.PI_SUBAGENTS_TEMP_ROOT = previous;
	fs.rmSync(root, { recursive: true, force: true });
});
const source = process.env.SUBAGENT_EXTERNAL_GROUP_SOURCE || prepareExternalGroupCandidate(root);
const load = (file) => import(pathToFileURL(path.join(source, "src/runs/background", file)));
const { resolveAsyncResumeTarget } = await load("async-resume.ts");
const { finalizeProcessTerminal, writeProcessTerminalCandidate } = await load("process-terminal.ts");
const { acquireActiveAsyncCapacity } = await load("active-async-capacity.ts");
const { cleanupAsyncRetention } = await load("async-retention.ts");
const { updateActiveRunIndex, ACTIVE_RUN_INDEX_DIR } = await load("active-run-index.ts");
function fixture() {
	const dir = fs.mkdtempSync(path.join(root, "case-")), runs = path.join(dir, "runs"), results = path.join(dir, "results");
	const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", asyncDir = path.join(runs, runId);
	fs.mkdirSync(asyncDir, { recursive: true }); fs.mkdirSync(results);
	const status = { runId, sessionId: "owner", mode: "single", state: "complete", steps: [{ agent: "external", status: "completed", runner: { type: "external-cli" } }] };
	const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
	const statusPath = path.join(asyncDir, "status.json"), resultPath = path.join(results, `${runId}.json`);
	write(statusPath, status);
	return { dir, runs, results, runId, asyncDir, status, statusPath, resultPath, write,
		resume: (options = {}, params = { id: runId }) => resolveAsyncResumeTarget(params, { asyncDirRoot: runs, resultsDir: results, kill: () => assert.fail("resume guard must be read-only") }, { requireSessionFile: false, ...options }),
	};
}
for (const layout of ["result-only", "status-missing", "candidate-only"]) test(`external recovery fence survives ${layout}`, () => {
	const f = fixture();
	fs.unlinkSync(f.statusPath);
	if (layout === "candidate-only") writeProcessTerminalCandidate(f.asyncDir, { version: 1, runId: f.runId, runnerProcessInstanceId: "runner", writers: {}, expectedWriters: { "0": 0 }, externalWritersUnverified: true });
	else f.write(f.resultPath, { runId: f.runId, mode: "single", state: "complete", success: true, results: [{ agent: "external", runner: { type: "external-cli" }, externalProcess: { descendantScope: "unverified" } }] });
	if (layout === "result-only") fs.rmdirSync(f.asyncDir);
	const before = fs.existsSync(f.resultPath) ? fs.readFileSync(f.resultPath, "utf8") : undefined;
	assert.throws(() => f.resume(), /External execution unknown.*do not retry/);
	if (before) assert.equal(fs.readFileSync(f.resultPath, "utf8"), before);
	assert.equal(fs.existsSync(f.statusPath), false);
});
test("mixed result-only recovery cannot bypass an external sibling via Pi index", () => {
	const f = fixture(); fs.unlinkSync(f.statusPath); fs.rmdirSync(f.asyncDir);
	f.write(f.resultPath, { runId: f.runId, mode: "parallel", state: "complete", results: [{ agent: "pi", success: true }, { agent: "external", runner: { type: "external-cli" } }] });
	assert.throws(() => f.resume({}, { id: f.runId, index: 0 }), /External execution unknown/);
});
test("Pi-only result recovery retains its existing no-session internal contract", () => {
	const f = fixture(); fs.unlinkSync(f.statusPath); fs.rmdirSync(f.asyncDir);
	f.write(f.resultPath, { runId: f.runId, mode: "single", state: "complete", agent: "pi", success: true });
	assert.equal(f.resume().kind, "revive");
});
for (const layout of ["run", "result-only"]) test(`retention preserves external unknown evidence without an active marker: ${layout}`, async () => {
	const f = fixture();
	const old = Date.now() - 40 * 86400000;
	if (layout === "run") f.write(f.statusPath, { ...f.status, startedAt: old - 1000, endedAt: old });
	else {
		fs.unlinkSync(f.statusPath); fs.rmdirSync(f.asyncDir);
		f.write(f.resultPath, { runId: f.runId, state: "complete", success: true, endedAt: old, results: [{ agent: "external", runner: { type: "external-cli" } }] });
	}
	const kept = layout === "run" ? f.statusPath : f.resultPath;
	fs.utimesSync(kept, old / 1000, old / 1000);
	if (layout === "run") fs.utimesSync(f.asyncDir, old / 1000, old / 1000);
	const before = fs.readFileSync(kept, "utf8");
	const result = await cleanupAsyncRetention({ asyncDirRoot: f.runs, resultsDir: f.results, maintenanceRoot: f.dir });
	assert.deepEqual(result.errors, []); assert.equal(result.workerFailed, false);
	assert.equal(result.deletedRuns + result.deletedResults, 0);
	assert.equal(result.skipped["external-descendants-unverified"], 1, "retained for writer evidence, not malformed or recent fixtures");
	assert.equal(fs.readFileSync(kept, "utf8"), before);
});
for (const mixed of [false, true]) test(`external terminal projection and capacity remain unknown${mixed ? " with a Pi sibling" : ""}`, () => {
	const f = fixture();
	const writer = { processInstanceId: "pi-writer", kind: "pi-writer", attempt: 0, closeObservedAt: 10, exitCode: 0, signal: null, processTree: { state: "observed", mechanism: "posix-process-group", processGroupId: 1234, verifiedAt: 11 } };
	if (mixed) f.status.steps.push({ agent: "pi", status: "completed" });
	f.write(f.statusPath, f.status);
	const slot = acquireActiveAsyncCapacity({ sessionId: "owner", limit: 1, runId: f.runId, kind: "runner", asyncDir: f.asyncDir }, { rootDir: path.join(f.dir, "capacity") });
	slot.markStarted("runner"); updateActiveRunIndex(f.asyncDir, "running");
	writeProcessTerminalCandidate(f.asyncDir, { version: 1, runId: f.runId, runnerProcessInstanceId: "runner", externalWritersUnverified: true,
		writers: mixed ? { "0": [], "1": [writer] } : { "0": [] }, expectedWriters: mixed ? { "0": 0, "1": 1 } : { "0": 0 } });
	const proof = finalizeProcessTerminal(f.asyncDir, f.runId, { processInstanceId: "runner", closeObservedAt: 20, exitCode: 0, signal: null });
	assert.equal(proof.state, "unknown"); assert.equal(proof.reason, "external-descendants-unverified");
	const status = JSON.parse(fs.readFileSync(f.statusPath));
	assert.equal(status.steps[0].processTerminal.state, "unknown", "a started external writer must never project as not-started");
	assert.equal(status.steps[0].processTerminal.resumeDisposition, "unavailable");
	assert.equal(slot.reconcile().used, 1, "unknown writer must retain admission capacity");
	assert.equal(fs.existsSync(path.join(f.runs, ACTIVE_RUN_INDEX_DIR, f.runId)), true);
});
