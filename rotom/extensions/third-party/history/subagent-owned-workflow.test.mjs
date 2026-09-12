import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, after } from "node:test";
import { prepareOwnedWorkflowCandidate, verifyOwnedWorkflowPreimages } from "./fixtures/prepare-owned-workflow.mjs";
import { prepareOwnedStoreTestRuntime } from "./fixtures/owned-store-test-runtime.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rotom-workflow-proof-test-"));
const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(root, "runtime");
let storeFixture;
after(() => { storeFixture?.restore(); if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT; else process.env.PI_SUBAGENTS_TEMP_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
const source = process.env.SUBAGENT_OWNED_WORKFLOW_SOURCE ? path.resolve(process.env.SUBAGENT_OWNED_WORKFLOW_SOURCE) : prepareOwnedWorkflowCandidate(root);
storeFixture = await prepareOwnedStoreTestRuntime(source, process.env.PI_SUBAGENTS_TEMP_ROOT);
const load = (file) => import(pathToFileURL(path.join(source, "src", file)));
const { OWNED_EXECUTION_SCOPE: scope, beginOwnedExecution: begin, registerOwnedWriter: register, closeOwnedWriter: close, sealOwnedExecution: seal, bindOwnedWriterLease } = await load("runs/background/owned-execution.ts");
const { beginOwnedWorkflow, registerWorkflowAdmission, bindWorkflowAdmission, closeOwnedWorkflow, readOwnedWorkflow } = await load("runs/background/owned-workflow.ts");
const { acquireActiveAsyncCapacity: acquire, transferActiveAsyncCapacity: transfer } = await load("runs/background/active-async-capacity.ts");
const { finalizeProcessTerminal: finalize } = await load("runs/background/process-terminal.ts");
const { resolveAsyncResumeTarget: resume } = await load("runs/background/async-resume.ts");
const { cleanupAsyncRetention } = await load("runs/background/async-retention.ts");
const { runWorkflowScript } = await load("workflows/scripted-workflow.ts");
const json = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const write = (p, value) => fs.writeFileSync(p, JSON.stringify(value));
const tree = { state: "observed", mechanism: "posix-process-group", processGroupId: 1234, verifiedAt: 10 };
let sequence = 0;
function fixture() {
	const dir = fs.mkdtempSync(path.join(root, "case-")), runs = path.join(dir, "runs"), results = path.join(dir, "results");
	const runId = `workflow-${++sequence}`, asyncDir = path.join(runs, runId);
	fs.mkdirSync(asyncDir, { recursive: true }); fs.mkdirSync(results);
	const statusPath = path.join(asyncDir, "status.json"), candidatePath = path.join(asyncDir, "process-terminal-candidate.json");
	const options = { rootDir: path.join(dir, "capacity") };
	const slot = acquire({ sessionId: "owner", limit: 1, runId, asyncDir, kind: "workflow", scope }, options);
	const capacity = { ownerSessionId: "owner", reservationToken: slot.owner.reservationToken, generation: slot.owner.generation };
	const workflow = beginOwnedWorkflow(asyncDir, runId, "owner", capacity);
	slot.markWorkflowStarted(workflow.controllerInstanceId);
	const status = { runId, sessionId: "owner", mode: "workflow", state: "complete", startedAt: 1, endedAt: 30, steps: [], ownedExecutionScope: scope };
	write(statusPath, status);
	function child(key = "child", kind = "external-cli") {
		const admission = registerWorkflowAdmission(asyncDir, workflow, key), childRunId = `${runId}-${key}`, childDir = path.join(runs, childRunId), runner = `${childRunId}-runner`;
		const workflowParent = bindWorkflowAdmission(asyncDir, workflow, admission, childRunId);
		fs.mkdirSync(childDir);
		write(path.join(childDir, "status.json"), { runId: childRunId, sessionId: "owner", parentWorkflowRunId: runId, mode: "single", state: "complete", steps: [{ agent: key, status: "completed", ...(kind === "external-cli" ? { runner: { type: kind } } : {}) }] });
		begin(childDir, childRunId, runner, { scope, ...storeFixture.requestFields, workflowParent });
		const id = register(childDir, kind, 0);
		// This synthetic Pi resource has no real session; new layers require an explicit declaration.
		if (kind === 'pi-writer' && bindOwnedWriterLease) bindOwnedWriterLease(childDir, id, { state:'not-held', reason:'session-disabled' });
		return { dir: childDir, proofPath: path.join(childDir, "process-terminal.json"),
			finish() { close(childDir, id, tree, 20); seal(childDir, childRunId, runner, true); return finalize(childDir, childRunId, { processInstanceId: runner, closeObservedAt: 30, exitCode: 0, signal: null }); } };
	}
	return { dir, runs, results, runId, asyncDir, status, statusPath, candidatePath, workflow, slot, options, child, seal() { closeOwnedWorkflow(asyncDir, workflow); }, used() { return slot.reconcile(new Set()).used; } };
}
test("third layer refuses drift and already patched source", () => assert.throws(() => verifyOwnedWorkflowPreimages(source), /Workflow scope preimage drift/));
test("sealed controller plus bound children releases once, never authorizes workflow recovery", () => {
	const f = fixture(), a = f.child("external"), b = f.child("pi", "pi-writer");
	a.finish(); b.finish(); assert.equal(f.used(), 1, "Map absence and child results cannot seal admission");
	f.seal(); assert.equal(f.used(), 0); assert.equal(f.used(), 0);
	const bytes = fs.readFileSync(f.candidatePath);
	assert.throws(() => resume({ id: f.runId }, { asyncDirRoot: f.runs, resultsDir: f.results }), /Owned workflow recovery/);
	assert.throws(() => transfer({ sessionId: "owner", limit: 1, sourceRunId: f.runId, runId: "replacement", asyncDir: path.join(f.runs, "replacement") }, f.options), /Owned workflow recovery/);
	assert.deepEqual(fs.readFileSync(f.candidatePath), bytes);
	const piChildId = path.basename(b.dir);
	assert.throws(() => resume({ id: piChildId }, { asyncDirRoot: f.runs, resultsDir: f.results }, { requireSessionFile: false }), /Owned workflow child recovery/);
	assert.throws(() => transfer({ sessionId: "owner", limit: 1, sourceRunId: piChildId, runId: "replacement", asyncDir: path.join(f.runs, "replacement") }, f.options), /Owned workflow child recovery/);
});
test("controller can close before child, but slot waits for actual child proof", () => {
	const f = fixture(), child = f.child(); f.seal(); assert.equal(f.used(), 1); child.finish(); assert.equal(f.used(), 0);
});
test("empty roster needs genuine controller close; progress steps cannot invent or remove admissions", () => {
	const f = fixture(); assert.equal(f.used(), 1); f.seal(); assert.equal(f.used(), 0);
	const g = fixture(); registerWorkflowAdmission(g.asyncDir, g.workflow, "unsupported-foreground"); g.seal();
	write(g.statusPath, { ...g.status, steps: [] }); assert.equal(g.used(), 1);
});
for (const mode of ["unsealed", "missing", "corrupt", "version", "scope", "controller", "token", "generation", "session", "child-parent", "child-admission", "child-controller", "child-session", "child-runner", "child-missing", "child-unknown", "duplicate", "path-drift"]) test(`workflow closure retains on ${mode}`, () => {
	const f = fixture(), child = f.child(); child.finish(); if (mode !== "unsealed") f.seal();
	const raw = json(f.candidatePath), wf = raw.ownedWorkflow;
	if (mode === "version") wf.version = 1;
	if (mode === "scope") wf.scope = "all-writers";
	if (mode === "controller") wf.controllerInstanceId = "different";
	if (mode === "token") wf.capacity.reservationToken = "different";
	if (mode === "generation") wf.capacity.generation++;
	if (mode === "session") wf.ownerSessionId = "different";
	if (mode === "duplicate") wf.admissions.push(wf.admissions[0]);
	write(f.candidatePath, raw);
	if (mode === "missing") fs.unlinkSync(f.candidatePath);
	if (mode === "corrupt") fs.writeFileSync(f.candidatePath, "broken");
	if (mode.startsWith("child-")) {
		const p = json(child.proofPath);
		if (mode === "child-parent") p.ownedClosure.workflowParent.workflowRunId = "different";
		if (mode === "child-admission") p.ownedClosure.workflowParent.admissionId = "different";
		if (mode === "child-controller") p.ownedClosure.workflowParent.controllerInstanceId = "different";
		if (mode === "child-runner") p.ownedClosure.runnerProcessInstanceId = "different";
		if (mode === "child-unknown") p.ownedClosure.state = "unknown";
		write(child.proofPath, p);
		if (mode === "child-missing") fs.unlinkSync(child.proofPath);
		if (mode === "child-session") { const s = path.join(child.dir, "status.json"); write(s, { ...json(s), sessionId: "different" }); }
	}
	if (mode === "path-drift") { const moved = path.join(f.dir, "elsewhere"); fs.renameSync(child.dir, moved); fs.symlinkSync(moved, child.dir); }
	assert.equal(f.used(), 1);
});
test("admission is durable, one-shot and cannot be reconstructed after seal or identity loss", () => {
	const f = fixture(), admission = registerWorkflowAdmission(f.asyncDir, f.workflow, "child");
	assert.equal(readOwnedWorkflow(f.asyncDir).admissions[0].admissionId, admission);
	assert.throws(() => registerWorkflowAdmission(f.asyncDir, f.workflow, "child"), /Invalid owned workflow transition/);
	bindWorkflowAdmission(f.asyncDir, f.workflow, admission, "child");
	assert.throws(() => bindWorkflowAdmission(f.asyncDir, f.workflow, admission, "replacement"), /binding unavailable/);
	f.seal(); assert.throws(() => registerWorkflowAdmission(f.asyncDir, f.workflow, "late"), /admission is closed/);
	assert.throws(() => closeOwnedWorkflow(f.asyncDir, f.workflow), /admission is closed/);
	const g = fixture(); fs.unlinkSync(g.candidatePath); assert.throws(() => registerWorkflowAdmission(g.asyncDir, g.workflow, "lost"), /unavailable/);
});
test("candidate-only workflow evidence is retained past TTL without scope status/index", async () => {
	const f = fixture(); f.child().finish(); f.seal(); assert.equal(f.used(), 0);
	write(f.statusPath, { ...f.status, ownedExecutionScope: undefined, endedAt: 2 });
	const old = Date.now() / 1000 - 40 * 86400; fs.utimesSync(f.asyncDir, old, old); fs.utimesSync(f.statusPath, old, old);
	const result = await cleanupAsyncRetention({ asyncDirRoot: f.runs, resultsDir: f.results, maintenanceRoot: f.dir });
	assert.deepEqual(result.errors, []); assert.ok(result.skipped["owned-execution-evidence"] >= 1); assert.ok(fs.existsSync(f.candidatePath));
});
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function bounded(promise) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("fixture deadline")), 5000); })]); } finally { clearTimeout(timer); } }
for (const operation of ["run", "status", "state"]) test(`real worker close waits for pending host ${operation}, not merely task result`, async () => {
	const started = deferred(), release = deferred(), closed = deferred(); let closureCalls = 0;
	const wait = async () => { started.resolve(); await release.promise; return { key: "child", ok: true, output: "done", artifactPaths: [] }; };
	const script = operation === "run" ? 'runs.run("child",{agent:"fake"});return 7;' : operation === "status" ? 'runs.status("child");return 7;' : 'state.set("key",7);return 7;';
	const task = runWorkflowScript({ script, timeoutMs: 4000, launch: wait, status: wait, state: { get: () => undefined, set: wait }, onControllerClosed() { closureCalls++; closed.resolve(); } });
	const settled = task.then(value => ({ value }), error => ({ error }));
	try {
		await bounded(started.promise); await bounded(settled);
		assert.equal(closureCalls, 0); release.resolve(); await bounded(closed.promise); assert.equal(closureCalls, 1);
	} finally { release.resolve(); await settled; }
});
test("worker timeout emits closure only through actual exit, not cancellation dispatch", async () => {
	const closed = deferred(); let calls = 0;
	await assert.rejects(runWorkflowScript({ script: 'while(true){}', timeoutMs: 50, launch: async () => { throw Error("must not launch"); }, status: async () => { throw Error("must not read"); }, onControllerClosed() { calls++; closed.resolve(); } }), /timed out/);
	await bounded(closed.promise); assert.equal(calls, 1);
});
test("closure callback failure leaves capacity held even when task result succeeds", async () => {
	const f = fixture(), attempted = deferred();
	const result = await runWorkflowScript({ script: 'return 1;', launch: async () => { throw Error("unexpected"); }, status: async () => { throw Error("unexpected"); },
		onControllerClosed() { attempted.resolve(); throw Error("fixture evidence unavailable"); } });
	assert.equal(result.value, 1); await bounded(attempted.promise); assert.equal(f.used(), 1); assert.equal(readOwnedWorkflow(f.asyncDir).sealed, false);
});
