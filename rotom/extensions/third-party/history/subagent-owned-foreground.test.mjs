import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, after } from "node:test";
import { prepareOwnedForegroundCandidate, verifyOwnedForegroundPreimages } from "./fixtures/prepare-owned-foreground.mjs";
import { prepareOwnedStoreTestRuntime } from "./fixtures/owned-store-test-runtime.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rotom-foreground-proof-test-"));
const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(root, "runtime");
let storeFixture;
after(() => { storeFixture?.restore(); if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT; else process.env.PI_SUBAGENTS_TEMP_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
const source = process.env.SUBAGENT_OWNED_FOREGROUND_SOURCE || prepareOwnedForegroundCandidate(root);
storeFixture = await prepareOwnedStoreTestRuntime(source, process.env.PI_SUBAGENTS_TEMP_ROOT);
const load = file => import(pathToFileURL(path.join(source, "src", file)));
const fg = await load("runs/background/owned-foreground.ts");
const wf = await load("runs/background/owned-workflow.ts");
const { acquireActiveAsyncCapacity: acquire, transferActiveAsyncCapacity: transfer } = await load("runs/background/active-async-capacity.ts");
const { acquireSessionLease } = await load("runs/shared/session-lease.ts");
const { cleanupAsyncRetention } = await load("runs/background/async-retention.ts");
const json = p => JSON.parse(fs.readFileSync(p, "utf8"));
const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v));
const scope = "owned-process-groups-v2";
// Synthetic process proof only; real writer/group/lease evidence is a separate SDK suite.
const tree = { state: "observed", mechanism: "posix-process-group", processGroupId: 1234, verifiedAt: 10 };
let serial = 0;
function fixture() {
	const dir = fs.mkdtempSync(path.join(root, "case-")), runs = path.join(dir, "runs"), results = path.join(dir, "results");
	const runId = `workflow-${++serial}`, asyncDir = path.join(runs, runId), options = { rootDir: path.join(dir, "capacity") };
	fs.mkdirSync(asyncDir, { recursive: true }); fs.mkdirSync(results);
	const slot = acquire({ sessionId: "owner", limit: 1, runId, asyncDir, kind: "workflow", scope }, options);
	const workflow = wf.beginOwnedWorkflow(asyncDir, runId, "owner", { ownerSessionId: "owner", reservationToken: slot.owner.reservationToken, generation: slot.owner.generation });
	slot.markWorkflowStarted(workflow.controllerInstanceId);
	write(path.join(asyncDir, "status.json"), { runId, sessionId: "owner", mode: "workflow", state: "complete", steps: [], startedAt: 1, endedAt: 30, ownedExecutionScope: scope });
	const admission = wf.registerWorkflowAdmission(asyncDir, workflow, "pi"), childRunId = `${runId}-pi`, childDir = path.join(runs, childRunId);
	const parent = wf.bindWorkflowAdmission(asyncDir, workflow, admission, childRunId, "foreground");
	const handle = fg.beginOwnedForeground(childDir, parent), candidate = path.join(childDir, "process-terminal-candidate.json");
	let attempt = 0;
	function writer() {
		const sessionFile = path.join(dir, `session-${attempt++}.jsonl`); fs.writeFileSync(sessionFile, "", { flag: "wx", mode: 0o600 });
		const lease = acquireSessionLease({ sessionFile, runId: childRunId, sourceRunId: runId });
		const id = fg.registerForegroundWriter(handle, lease);
		return { id, lease, sessionFile, close(group = tree) { const released = lease.release(); fg.closeForegroundWriter(handle, id, group, 20, released); } };
	}
	return { dir, runs, results, options, runId, childRunId, asyncDir, childDir, candidate, parent, handle, writer,
		seal() { wf.closeOwnedWorkflow(asyncDir, workflow); }, host() { fg.returnForegroundHost(handle); }, pipeline() { fg.finishForegroundPipeline(handle); }, used() { return slot.reconcile(new Set()).used; } };
}
test("fourth layer refuses preimage drift and an already patched source", () => assert.throws(() => verifyOwnedForegroundPreimages(source), /Foreground scope preimage drift/));
test("unsupported platform refuses foreground ownership before creating a directory", () => {
	const f = fixture(), dir = path.join(f.dir, "unsupported", f.childRunId), descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	try { Object.defineProperty(process, "platform", { value: "win32" }); assert.throws(() => fg.beginOwnedForeground(dir, f.parent), /requires POSIX/); }
	finally { Object.defineProperty(process, "platform", descriptor); }
	assert.equal(fs.existsSync(dir), false);
});
test("foreground refuses a linked child directory before writing outside its namespace", () => {
	const f = fixture(), outside = path.join(f.dir, "outside"), base = path.join(f.dir, "linked-root"), linked = path.join(base, f.childRunId);
	fs.mkdirSync(outside); fs.mkdirSync(base); fs.symlinkSync(outside, linked);
	assert.throws(() => fg.beginOwnedForeground(linked, f.parent), /Invalid foreground closure directory/);
	assert.equal(fs.existsSync(path.join(outside, "process-terminal-candidate.json")), false);
});
test("copied foreground proof cannot be imported under a different canonical directory", () => {
	const f = fixture(), w = f.writer(); w.close(); f.pipeline(); f.host(); f.seal();
	const imported = path.join(f.dir, "imported", f.childRunId); fs.cpSync(f.childDir, imported, { recursive: true });
	assert.throws(() => fg.foregroundClosureObserved(imported, f.parent), /closure identity unavailable/);
	assert.equal(f.used(), 0);
});
test("foreground admission refuses another run's session lease", () => {
	const f = fixture(), sessionFile = path.join(f.dir, "foreign-session.jsonl"); fs.writeFileSync(sessionFile, "");
	const lease = acquireSessionLease({ sessionFile, runId: "foreign", sourceRunId: "foreign" });
	assert.throws(() => fg.registerForegroundWriter(f.handle, lease), /lease owner mismatch/);
	assert.equal(json(f.candidate).ownedForeground.writers.length, 0); assert.equal(lease.release(), true);
});
test("foreground requires separate host and authoritative pipeline barriers, all attempts and lease release", () => {
	const f = fixture(), a = f.writer(), b = f.writer(); f.seal(); a.close(); b.close();
	f.host(); assert.equal(f.used(), 1); f.pipeline(); assert.equal(f.used(), 0); assert.equal(f.used(), 0);
	assert.equal(json(f.candidate).ownedForeground.writers.length, 2);
	assert.throws(() => fg.registerForegroundWriter(f.handle, a.lease), /admission is closed/);
	assert.throws(() => fg.closeForegroundWriter(f.handle, a.id, tree, 40, true), /close identity unavailable/);
});
test("detached host may return early, but existing pipeline may admit more attempts until genuine completion", () => {
	const f = fixture(), a = f.writer(); f.host(); f.seal(); a.close(); assert.equal(f.used(), 1);
	const b = f.writer(); f.pipeline(); assert.equal(f.used(), 1); b.close(); assert.equal(f.used(), 0);
});
test("task error before any process admission still needs both controller barriers", () => {
	const f = fixture(); f.seal(); f.pipeline(); assert.equal(f.used(), 1); f.host(); assert.equal(f.used(), 0);
});
for (const [name, mutate] of [
	["missing actual close", s => { delete s.writers[0].close; }],
	["unverified group", s => { s.writers[0].close.processTree = { state: "unknown", reason: "verification-failed" }; }],
	["wrong parent controller", s => { s.workflowParent.controllerInstanceId = "wrong"; }],
	["wrong foreground controller", s => { s.controllerInstanceId = "wrong"; }],
	["wrong child lineage", s => { s.workflowParent.childRunId = "wrong"; }],
	["wrong owner kind", s => { s.workflowParent.kind = "async"; }],
	["wrong writer kind", s => { s.writers[0].kind = "external-cli"; }],
	["missing pipeline barrier", s => { delete s.pipelineClosedAt; }],
	["missing host barrier", s => { delete s.hostReturnedAt; }],
	["future barrier", s => { s.pipelineClosedAt = Date.now() + 60000; }],
	["future group observation", s => { s.writers[0].close.processTree.verifiedAt = Date.now() + 60000; }],
	["missing lease release acknowledgement", s => { delete s.writers[0].leaseReleased; }],
	["canonical lease drift", s => { s.writers[0].canonicalSessionId = "wrong"; }],
	["duplicate attempt", s => { s.writers.push({ ...s.writers[0], processInstanceId: "duplicate" }); }],
	["lost coverage", s => { s.coverageComplete = false; }],
	["inflated descendant proof", s => { s.descendantCoverage = "observed"; }],
]) test(`foreground retains on ${name}`, () => {
	const f = fixture(), w = f.writer(); w.close(); f.pipeline(); f.host(); f.seal();
	const raw = json(f.candidate); mutate(raw.ownedForeground); write(f.candidate, raw); assert.equal(f.used(), 1);
});
test("active canonical lease retains despite previous release acknowledgement", () => {
	const f = fixture(), w = f.writer(); w.close(); f.pipeline(); f.host(); f.seal();
	const held = acquireSessionLease({ sessionFile: w.sessionFile, runId: "independent", sourceRunId: "independent" });
	assert.equal(f.used(), 1); assert.equal(held.release(), true); assert.equal(f.used(), 0);
});
test("lost or symlinked candidate never invents an empty roster", () => {
	const f = fixture(), w = f.writer(); w.close(); f.pipeline(); f.host(); f.seal();
	const saved = `${f.candidate}.saved`; fs.renameSync(f.candidate, saved); assert.equal(f.used(), 1);
	fs.symlinkSync(saved, f.candidate); assert.equal(f.used(), 1);
});
test("nested marker write failure poisons the live invocation before I/O, even if storage later recovers", () => {
	const f = fixture(), w = f.writer(); w.close(); f.host(); f.seal();
	const saved = fs.readFileSync(f.candidate); fs.unlinkSync(f.candidate);
	assert.throws(() => fg.markForegroundCoverageUnavailable(f.handle), /ownership unavailable/);
	fs.writeFileSync(f.candidate, saved); f.pipeline(); assert.equal(json(f.candidate).ownedForeground.coverageComplete, false); assert.equal(f.used(), 1);
});
test("foreground ID, prefix and directory remain recovery-fenced after capacity release and child proof loss", () => {
	const f = fixture(), w = f.writer(); w.close(); f.pipeline(); f.host(); f.seal(); assert.equal(f.used(), 0);
	for (const target of [{ id: f.childRunId }, { id: f.childRunId.slice(0, -2) }, { dir: f.childDir }, { dir: w.sessionFile }]) {
		assert.throws(() => fg.assertForegroundRecoveryAllowed(f.runs, target), /Owned foreground workflow child recovery/);
	}
	assert.throws(() => transfer({ sessionId: "owner", limit: 1, sourceRunId: f.childRunId, runId: "replacement", asyncDir: path.join(f.runs, "replacement") }, f.options), /Owned foreground workflow child recovery/);
	fs.unlinkSync(f.candidate);
	assert.throws(() => fg.assertForegroundRecoveryAllowed(f.runs, { id: f.childRunId }), /Owned foreground workflow child recovery/);
});
test("result-only workflow lineage fences foreground aliases even if the entire run directory is absent", () => {
	const f = fixture(), w = f.writer(); w.close(); f.pipeline(); f.host(); f.seal(); assert.equal(f.used(), 0);
	write(path.join(f.results, `${f.runId}.json`), { mode: "workflow", runId: f.runId, ownedExecutionScope: scope, results: [{ runId: f.childRunId }] });
	fs.rmSync(f.runs, { recursive: true });
	for (const target of [{ id: f.childRunId }, { dir: f.childDir }]) assert.throws(() => fg.assertForegroundRecoveryAllowed(f.runs, target, f.results), /Owned workflow child recovery/);
});
test("candidate-only foreground evidence survives retention TTL", async () => {
	const f = fixture(), w = f.writer(); w.close(); f.pipeline(); f.host(); f.seal();
	const before = fs.readFileSync(f.candidate); const old = new Date(1); fs.utimesSync(f.candidate, old, old); fs.utimesSync(f.childDir, old, old);
	const result = await cleanupAsyncRetention({ asyncDirRoot: f.runs, resultsDir: f.results, maintenanceRoot: f.dir, now: () => Date.now() + 30 * 86400000 });
	assert.deepEqual(result.errors, []); assert.ok(result.skipped["owned-execution-evidence"] >= 1);
	assert.deepEqual(fs.readFileSync(f.candidate), before);
});
