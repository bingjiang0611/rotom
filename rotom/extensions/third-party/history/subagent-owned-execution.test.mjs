// Scoped adoption contract: synthetic artifacts and exact identity, no live PIDs/models.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, after } from "node:test";
import { prepareOwnedExecutionCandidate, verifyOwnedExecutionPreimages } from "./fixtures/prepare-owned-execution.mjs";
import { prepareExternalGroupCandidate } from "./fixtures/prepare-external-group.mjs";
import { prepareOwnedStoreTestRuntime, loadLegacyModeCapacity } from "./fixtures/owned-store-test-runtime.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rotom-owned-contract-"));
const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(root, "runtime");
let storeFixture;
after(() => { storeFixture?.restore(); if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT; else process.env.PI_SUBAGENTS_TEMP_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
const source = process.env.SUBAGENT_OWNED_EXECUTION_SOURCE || prepareOwnedExecutionCandidate(root);
storeFixture = await prepareOwnedStoreTestRuntime(source, process.env.PI_SUBAGENTS_TEMP_ROOT);
const load = (f) => import(pathToFileURL(path.join(source, "src/runs/background", f)));
const { OWNED_EXECUTION_SCOPE: scope, beginOwnedExecution: begin, registerOwnedWriter: register, closeOwnedWriter: close, sealOwnedExecution: seal, ownedClosureObserved } = await load("owned-execution.ts");
const { finalizeProcessTerminal: finalize, writeProcessTerminalCandidate: writeCandidate } = await load("process-terminal.ts");
const { acquireActiveAsyncCapacity: acquire, transferActiveAsyncCapacity: transfer } = await load("active-async-capacity.ts");
const legacyAcquire = storeFixture.requestFields.storeId ? (await loadLegacyModeCapacity(source, root)).acquireActiveAsyncCapacity : acquire;
const { resolveAsyncResumeTarget: resume } = await load("async-resume.ts");
const { cleanupAsyncRetention } = await load("async-retention.ts");
const { runExternalCli } = await load("../shared/external-cli-runner.ts");
test("second-layer preimages reject an already patched candidate", () => {
	assert.throws(() => verifyOwnedExecutionPreimages(source), /Owned scope preimage drift/);
});
const tree = { state: "observed", mechanism: "posix-process-group", processGroupId: 1234, verifiedAt: 11 };
let sequence = 0;
function fixture({ legacy = false, kind = "runner", options: extra = {} } = {}) {
	const dir = fs.mkdtempSync(path.join(root, "case-")), runs = path.join(dir, "runs"), results = path.join(dir, "results");
	const runId = `scope-run-${++sequence}`, asyncDir = path.join(runs, runId), runner = `runner-${sequence}`;
	fs.mkdirSync(asyncDir, { recursive: true }); fs.mkdirSync(results);
	const statusPath = path.join(asyncDir, "status.json"), proofPath = path.join(asyncDir, "process-terminal.json"), candidatePath = path.join(asyncDir, "process-terminal-candidate.json");
	const status = { runId, sessionId: "owner", state: "complete", mode: "single", startedAt: 1, endedAt: 20,
		steps: [{ agent: "external", status: "completed", runner: { type: "external-cli" } }] };
	fs.writeFileSync(statusPath, JSON.stringify(status));
	const options = { rootDir: path.join(dir, "capacity"), ...extra };
	const slot = (legacy ? legacyAcquire : acquire)({ sessionId: "owner", limit: 1, runId, kind, asyncDir, ...(legacy ? {} : { scope }) }, options);
	if (kind === "workflow") slot.markWorkflowStarted(); else slot.markStarted(runner);
	const binding = { ownerSessionId: "owner", reservationToken: slot.owner.reservationToken, generation: slot.owner.generation };
	begin(asyncDir, runId, runner, { scope, ...storeFixture.requestFields, capacity: binding });
	return { dir, runs, results, runId, asyncDir, runner, statusPath, proofPath, candidatePath, status, slot, options, binding,
		register: () => register(asyncDir, "external-cli", 0),
		seal: (covered = true) => seal(asyncDir, runId, runner, covered),
		finalize: () => finalize(asyncDir, runId, { processInstanceId: runner, closeObservedAt: 30, exitCode: 0, signal: null }),
	};
}
function complete(f) { const id = f.register(); close(f.asyncDir, id, tree, 20); f.seal(); return f.finalize(); }
test("scoped scheduling release never upgrades graph unknown or authorizes recovery", () => {
	const f = fixture();
	assert.equal(f.slot.reconcile().used, 1);
	const proof = complete(f);
	assert.equal(proof.state, "unknown"); assert.equal(proof.reason, "external-descendants-unverified");
	assert.equal(proof.ownedClosure.state, "observed");
	assert.equal(proof.ownedClosure.effectVerification, "unverified");
	assert.equal(f.slot.reconcile().used, 0); assert.equal(f.slot.reconcile().used, 0);
	const bytes = fs.readFileSync(f.proofPath, "utf8");
	assert.throws(() => resume({ id: f.runId }, { asyncDirRoot: f.runs, resultsDir: f.results }, { requireSessionFile: false }), /External execution unknown/);
	assert.throws(() => transfer({ sessionId: "owner", limit: 1, sourceRunId: f.runId, runId: "replacement", asyncDir: path.join(f.runs, "replacement") }, f.options), /External execution unknown/);
	assert.equal(fs.readFileSync(f.proofPath, "utf8"), bytes);
	assert.equal(f.slot.reconcile().used, 0);
});
test("legacy capacity owner is not migrated by a v2 sidecar", () => {
	const f = fixture({ legacy: true }); const proof = complete(f);
	assert.equal(proof.ownedClosure.state, "observed"); assert.equal(f.slot.reconcile().used, 1);
});
for (const mode of ["unsealed", "missing-close", "unknown-group", "incomplete-topology", "wrong-runner", "write-failure"]) test(`retain scoped capacity: ${mode}`, () => {
	const f = fixture(), id = f.register();
	if (mode !== "missing-close") close(f.asyncDir, id, mode === "unknown-group" ? { state: "unknown", reason: "verification-failed" } : tree, 20);
	if (mode !== "unsealed") f.seal(mode !== "incomplete-topology");
	if (mode === "write-failure") fs.mkdirSync(f.proofPath);
	const proof = mode === "wrong-runner" ? finalize(f.asyncDir, f.runId, { processInstanceId: "wrong", closeObservedAt: 30, exitCode: 0, signal: null }) : f.finalize();
	assert.notEqual(proof.ownedClosure?.state, "observed");
	assert.equal(f.slot.reconcile().used, 1);
});
for (const mode of ["token", "generation", "session", "run", "runner", "version", "scope", "missing-roster", "duplicate", "future-close", "future-group-proof", "v1-only"]) test(`persisted scoped proof rejects ${mode} drift`, () => {
	const f = fixture(); const proof = complete(f), owned = proof.ownedClosure;
	if (mode === "token") owned.capacity.reservationToken = "different";
	if (mode === "generation") owned.capacity.generation++;
	if (mode === "session") owned.capacity.ownerSessionId = "different";
	if (mode === "run") owned.runId = "different";
	if (mode === "runner") owned.runnerProcessInstanceId = "different";
	if (mode === "version") owned.version = 1;
	if (mode === "scope") owned.scope = "all-processes";
	if (mode === "missing-roster") delete owned.writers;
	if (mode === "duplicate") owned.writers.push(owned.writers[0]);
	if (mode === "future-close") owned.writers[0].close.closeObservedAt = 100;
	if (mode === "future-group-proof") owned.writers[0].close.processTree.verifiedAt = 100;
	if (mode === "v1-only") { delete proof.ownedClosure; proof.state = "observed"; proof.observedAt = 30; proof.instances = [{ kind: "runner", processInstanceId: f.runner, closeObservedAt: 30, exitCode: 0, signal: null }]; }
	fs.writeFileSync(f.proofPath, JSON.stringify(proof));
	assert.equal(f.slot.reconcile().used, 1);
});
test("durable registration precedes spawn and cannot be resurrected after seal", async () => {
	const f = fixture(); const id = f.register();
	let stored = JSON.parse(fs.readFileSync(f.candidatePath));
	assert.equal(stored.externalWritersUnverified, true);
	assert.equal(stored.ownedExecution.writers[0].processInstanceId, id);
	assert.equal(stored.ownedExecution.writers[0].close, undefined);
	assert.throws(() => begin(f.asyncDir, f.runId, f.runner, { scope, ...storeFixture.requestFields }), /reuse/);
	close(f.asyncDir, id, tree, 20); f.seal();
	assert.throws(() => f.register(), /admission/);
	assert.throws(() => close(f.asyncDir, id, tree, 21), /identity/);
	const f2 = fixture(); fs.writeFileSync(f2.candidatePath, "broken");
	assert.throws(() => f2.register());
	for (const missing of ["file", "scope-field"]) {
		const lost = fixture(), marker = path.join(lost.dir, "must-not-start");
		if (missing === "file") fs.unlinkSync(lost.candidatePath);
		else { const raw = JSON.parse(fs.readFileSync(lost.candidatePath)); delete raw.ownedExecution; fs.writeFileSync(lost.candidatePath, JSON.stringify(raw)); }
		assert.throws(() => register(lost.asyncDir, "pi-writer", 0, undefined, true), /Required owned execution roster/);
		await assert.rejects(runExternalCli({ command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`], cwd: lost.dir, prompt: "fixture", asyncDir: lost.asyncDir, stepIndex: 0, ownedExecutionRequired: true }), /Required owned execution roster/);
		assert.equal(fs.existsSync(marker), false);
	}
});
test("a stale released handle cannot release a new owner's slot", () => {
	const f = fixture(); complete(f); assert.equal(f.slot.reconcile().used, 0);
	const next = acquire({ sessionId: "owner", limit: 1, runId: "unrelated", kind: "runner", asyncDir: path.join(f.runs, "unrelated"), scope }, f.options);
	next.markStarted("new-runner");
	assert.equal(f.slot.reconcile().used, 1);
	assert.equal(f.slot.rollback(), false);
	assert.equal(next.reconcile().used, 1);
});
test("held Pi lease prevents scoped closure even with closed writer records", () => {
	const f = fixture(); const id = f.register(); close(f.asyncDir, id, tree, 20); f.seal();
	const stored = JSON.parse(fs.readFileSync(f.candidatePath));
	stored.revivalLeaseToken = "lease"; stored.revivalLeaseReleaseAcknowledged = false;
	writeCandidate(f.asyncDir, stored);
	const proof = f.finalize(); assert.equal(proof.ownedClosure.state, "unknown"); assert.equal(f.slot.reconcile().used, 1);
});
test("legacy capacity readers retain version-two owners without applying old release shortcuts", async () => {
	const legacySource = prepareExternalGroupCandidate(fs.mkdtempSync(path.join(root, "legacy-")));
	const legacy = await import(pathToFileURL(path.join(legacySource, "src/runs/background/active-async-capacity.ts")));
	const f = fixture(); complete(f); assert.equal(f.slot.owner.version, 2);
	fs.writeFileSync(f.statusPath, JSON.stringify({ ...f.status, error: "startup failed", processTerminal: { version: 1, state: "not-started", runId: f.runId, runnerProcessInstanceId: f.runner } }));
	assert.equal(legacy.getActiveAsyncCapacitySnapshot("owner", 1, f.options).used, 1);
	assert.equal(f.slot.reconcile().used, 0, "only the new reader accepts the actual scoped proof");
});
test("a legacy not-started status never bypasses scoped closure proof", () => {
	const f = fixture();
	fs.writeFileSync(f.statusPath, JSON.stringify({ ...f.status, error: "startup failed", processTerminal: { version: 1, state: "not-started", runId: f.runId, runnerProcessInstanceId: f.runner } }));
	assert.equal(f.slot.reconcile().used, 1);
});
for (const steps of [[], [{ agent: "pi", status: "completed", async: false }]]) test(`workflow status is not a sealed controller roster (${steps.length} children)`, () => {
	const f = fixture({ kind: "workflow" });
	fs.writeFileSync(f.statusPath, JSON.stringify({ ...f.status, mode: "workflow", steps }));
	assert.equal(f.slot.reconcile(new Set()).used, 1);
});
test("a process proof is not inferred from a bare empty object", () => {
	assert.equal(ownedClosureObserved({}, { runId: "run", runnerProcessInstanceId: "runner" }), false);
});
for (const layout of ["unsealed", "result-only", "invalid-scope"]) test(`scoped Pi recovery cannot downgrade to legacy: ${layout}`, () => {
	const f = fixture();
	f.status.steps = [{ agent: "pi", status: "completed" }];
	f.status.ownedExecutionScope = scope;
	fs.writeFileSync(f.statusPath, JSON.stringify(f.status));
	if (layout !== "unsealed") {
		fs.rmSync(f.asyncDir, { recursive: true });
		fs.writeFileSync(path.join(f.results, `${f.runId}.json`), JSON.stringify({ runId: f.runId, agent: "pi", state: "complete", success: true, ownedExecutionScope: layout === "invalid-scope" ? "unrecognized" : scope }));
	}
	const before = fs.existsSync(f.statusPath) ? fs.readFileSync(f.statusPath, "utf8") : undefined;
	assert.throws(() => resume({ id: f.runId }, { asyncDirRoot: f.runs, resultsDir: f.results }, { requireSessionFile: false }), /Owned execution closure unavailable/);
	if (before) {
		assert.equal(fs.readFileSync(f.statusPath, "utf8"), before);
		assert.throws(() => transfer({ sessionId: "owner", limit: 1, sourceRunId: f.runId, runId: "new", asyncDir: path.join(f.runs, "new") }, f.options), /Owned execution closure unavailable/);
	}
	assert.equal(f.slot.reconcile().used, 1);
});
for (const layout of ["status", "result-only"]) test(`scoped evidence survives TTL after scheduling release: ${layout}`, async () => {
	const f = fixture(); complete(f); assert.equal(f.slot.reconcile().used, 0);
	const old = Date.now() - 40 * 86400000;
	let kept = f.statusPath;
	if (layout === "status") {
		fs.writeFileSync(kept, JSON.stringify({ ...f.status, ownedExecutionScope: scope, startedAt: old - 1, endedAt: old }));
		fs.utimesSync(f.asyncDir, old / 1000, old / 1000);
	} else {
		fs.rmSync(f.asyncDir, { recursive: true }); kept = path.join(f.results, `${f.runId}.json`);
		fs.writeFileSync(kept, JSON.stringify({ runId: f.runId, agent: "pi", state: "complete", success: true, endedAt: old, ownedExecutionScope: scope }));
	}
	fs.utimesSync(kept, old / 1000, old / 1000);
	const result = await cleanupAsyncRetention({ asyncDirRoot: f.runs, resultsDir: f.results, maintenanceRoot: f.dir });
	assert.deepEqual(result.errors, []); assert.equal(result.workerFailed, false);
	assert.equal(result.skipped["owned-execution-evidence"], 1);
	assert.equal(result.deletedRuns + result.deletedResults, 0); assert.ok(fs.existsSync(kept));
});
