import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { probePiVersion } from "../../../runtime/verify-pi-runtime.mjs";
function fauxEntry(root) {
	for (let dir = root;; dir = path.dirname(dir)) {
		const file = path.join(dir, "node_modules/@earendil-works/pi-ai/package.json");
		if (fs.existsSync(file)) {
			const pkg = JSON.parse(fs.readFileSync(file)); assert.equal(pkg.name, "@earendil-works/pi-ai");
			const entry = path.resolve(path.dirname(file), pkg.exports["./providers/*"].import.replaceAll("*", "faux")); assert.ok(fs.existsSync(entry)); return entry;
		}
		if (path.dirname(dir) === dir) throw Error("Public faux provider unavailable");
	}
}
export async function runOwnedExecutionSdk(t, { prepareCandidate, expectWorkflowClosure = false, expectForegroundClosure = false, expectStoreIsolation = false, expectStoreMismatch = false, expectSessionIsolation = false, expectFlatAdmission = false, usePublicEntry = false, controllerCrash = false }) {
	assert.ok(process.env.ROTOM_PI, "ROTOM_PI must select a verified public runtime");
	const pi = await probePiVersion({ executable: process.env.ROTOM_PI });
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "rotom-owned-sdk-"));
	const source = prepareCandidate(root), home = path.join(root, "home"); fs.mkdirSync(home);
	const scope = "owned-process-groups-v2", runtimeBase = path.join(root, "runtime"), runtimeRoot = expectStoreIsolation ? path.join(runtimeBase, scope) : runtimeBase;
	if (expectStoreIsolation) (await import(pathToFileURL(path.join(source, "src/shared/execution-store.ts")))).initializeExecutionStore(runtimeBase);
	const config = path.join(root, "config.json"), preload = path.join(root, "no-network.mjs");
	const typeboxEntry = expectForegroundClosure ? createRequire(path.join(pi.packageRoot, "package.json")).resolve("typebox") : undefined;
	fs.writeFileSync(config, JSON.stringify({ root, source, typeboxEntry, piEntry: pi.publicEntry, fauxEntry: fauxEntry(pi.packageRoot), expectWorkflowClosure, expectForegroundClosure, expectStoreIsolation, expectStoreMismatch, expectSessionIsolation, expectFlatAdmission, usePublicEntry, controllerCrash }), { mode: 0o600 });
	fs.writeFileSync(preload, "globalThis.fetch=()=>{throw Error('Network forbidden in owned fixture')};");
	const log = fs.openSync(path.join(root, "driver.log"), "wx", 0o600); let result;
	try {
		result = spawnSync(process.execPath, [path.join(import.meta.dirname, "owned-execution-sdk.mjs")], { cwd: root, timeout: 110000, stdio: ["ignore", log, log],
			env: { PATH: process.env.PATH, HOME: home, TMPDIR: root, PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"), PI_SUBAGENTS_TEMP_ROOT: runtimeBase, ...(expectStoreIsolation ? { PI_SUBAGENTS_EXECUTION_SCOPE: scope } : {}),
				PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: pi.packageRoot, PI_SUBAGENT_PI_BINARY: process.env.ROTOM_PI, ROTOM_OWNED_FIXTURE: config, NODE_OPTIONS: `--import=${preload}`, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
	} finally { fs.closeSync(log); }
	if (controllerCrash) {
		assert.ifError(result.error); assert.equal(result.signal, "SIGKILL", `Crash fixture unverified; retained: ${root}`);
		const id = JSON.parse(fs.readFileSync(path.join(root, "crash.json"))).runId;
		const dir = path.join(runtimeRoot, "async-subagent-runs", id);
		const raw = JSON.parse(fs.readFileSync(path.join(dir, "process-terminal-candidate.json")));
		assert.equal(raw.ownedWorkflow.sealed, false); assert.equal(raw.ownedWorkflow.controllerClosedAt, undefined);
		const oldRoot = process.env.PI_SUBAGENTS_TEMP_ROOT, oldScope = process.env.PI_SUBAGENTS_EXECUTION_SCOPE;
		try {
			process.env.PI_SUBAGENTS_TEMP_ROOT = runtimeBase;
			if (expectStoreIsolation) process.env.PI_SUBAGENTS_EXECUTION_SCOPE = scope;
			const { getActiveAsyncCapacitySnapshot } = await import(pathToFileURL(path.join(source, "src/runs/background/active-async-capacity.ts")));
			const snapshot = getActiveAsyncCapacitySnapshot("owned-fixture", 1, { rootDir: path.join(runtimeRoot, "session-active-async-capacity"), liveWorkflowRunIds: new Set() });
			assert.equal(snapshot.used, 1, "a newly loaded reader cannot infer closure from controller Map absence");
			if (usePublicEntry) {
				const terminal = path.join(dir, "process-terminal-candidate.json"), bytes = fs.readFileSync(terminal);
				const acknowledged = spawnSync(process.execPath, [path.join(source, "owned-store.mjs"), "init", "--base", runtimeBase, "--accept-unverified-descendants"], { cwd: root, env: { PATH: process.env.PATH, HOME: home, TMPDIR: root }, encoding: "utf8", timeout: 10000 });
				assert.ifError(acknowledged.error); assert.equal(acknowledged.status, 0, acknowledged.stderr); assert.equal(JSON.parse(acknowledged.stdout).recoveryAuthorized, false);
				assert.deepEqual(fs.readFileSync(terminal), bytes); assert.equal(getActiveAsyncCapacitySnapshot("owned-fixture", 1, { rootDir: path.join(runtimeRoot, "session-active-async-capacity"), liveWorkflowRunIds: new Set() }).used, 1, "operator acknowledgment cannot erase lost-controller occupancy");
			}
		} finally {
			if (oldRoot === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT; else process.env.PI_SUBAGENTS_TEMP_ROOT = oldRoot;
			if (oldScope === undefined) delete process.env.PI_SUBAGENTS_EXECUTION_SCOPE; else process.env.PI_SUBAGENTS_EXECUTION_SCOPE = oldScope;
		}
		t.diagnostic(JSON.stringify({ mode: "real-controller-owner-crash", scopedCapacityRetained: true, sealed: false, ...(usePublicEntry ? { acknowledgmentDidNotUnlock: true } : {}), remoteModelCalls: 0 }));
	} else {
		if (result.error || result.status !== 0 || !fs.existsSync(path.join(root, "result.json"))) assert.fail(`Owned fixture unverified; artifacts retained: ${root}; exit=${result.status}; error=${result.error?.code ?? "none"}`);
		const evidence = JSON.parse(fs.readFileSync(path.join(root, "result.json")));
		assert.equal(evidence.remoteModelCalls, 0);
		if (expectStoreMismatch) {
			assert.equal(evidence.scopeMismatchRejected, true); assert.equal(evidence.writerStarts, 0);
			t.diagnostic(JSON.stringify(evidence)); fs.rmSync(root, { recursive: true, force: true }); return;
		}
		if (expectFlatAdmission) {
			assert.equal(evidence.writerStartsBeforePositiveControl, 0); assert.equal(evidence.capacityAfterRejections, 0);
			assert.equal(evidence.directRejected, 30); assert.equal(evidence.workflowRejected, 24); assert.equal(evidence.positiveControlClosed, true); assert.equal(evidence.publicSingleClosed, true);
			t.diagnostic(JSON.stringify(evidence)); fs.rmSync(root, { recursive: true, force: true }); return;
		}
		if (usePublicEntry) assert.equal(evidence.ambientExtensionsExcluded, true);
		assert.equal(evidence.evidence.length, expectSessionIsolation ? 15 : expectStoreIsolation ? 13 : expectForegroundClosure ? 12 : expectWorkflowClosure ? 9 : 8);
		assert.ok(evidence.evidence.filter(r => !["owner-loss", "mixed-workflow", "foreground-workflow", "foreground-pipe-escape", "async-pipe-escape", "revival-pipe-escape"].includes(r.mode)).every(r => r.capacityAfter === 0));
		assert.equal(evidence.evidence.find(r => r.mode === "mixed-workflow").capacityAfter, expectWorkflowClosure ? 0 : 1);
		assert.equal(evidence.evidence.find(r => r.mode === "owner-loss").capacityAfter, 1);
		if (expectWorkflowClosure) assert.equal(evidence.evidence.find(r => r.mode === "foreground-workflow").capacityAfter, expectForegroundClosure ? 0 : 1);
		if (expectForegroundClosure) assert.equal(evidence.evidence.find(r => r.mode === "foreground-pipe-escape").capacityAfter, 1);
		t.diagnostic(JSON.stringify(evidence));
	}
	// Reached only after the controlled processes exited; unknown failures retain artifacts.
	fs.rmSync(root, { recursive: true, force: true });
}
