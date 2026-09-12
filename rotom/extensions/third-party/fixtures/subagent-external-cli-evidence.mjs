// No model or network. Runs one external Node child behind an explicit release gate.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { VERIFIED_THIRD_PARTY_PACKAGES } from "../../../runtime/product-config.mjs";
const config = JSON.parse(fs.readFileSync(process.env.ROTOM_EXTERNAL_FIXTURE, "utf8"));
globalThis.fetch = () => { throw Error("Network forbidden in external-CLI fixture"); };
const pi = await import(pathToFileURL(config.piEntry).href);
const root = config.root;
const scenario = config.scenario ?? "complete";
// Group ownership is now the declared default product, not only a candidate.
const groupCandidate = config.externalGroupCandidate === true || config.declaredProduct === true;
assert.ok(["complete", "stop-direct", "stop-residual"].includes(scenario));
if (config.maintainedVersion !== undefined) {
	assert.match(config.maintainedVersion, /^0\.52\.1-rotom\.\d+$/);
	assert.notEqual(config.baselineObservation, true);
	assert.ok(!fs.realpathSync(config.source).split(path.sep).includes("node_modules"));
}
if (config.declaredProduct === true) {
	assert.notEqual(config.baselineObservation, true);
	assert.equal(config.maintainedVersion, undefined);
	assert.equal(fs.realpathSync(config.source), fs.realpathSync(path.resolve(import.meta.dirname, "../node_modules/pi-subagents")));
}
assert.equal(JSON.parse(fs.readFileSync(path.join(config.source, "package.json"))).version,
	config.declaredProduct === true ? VERIFIED_THIRD_PARTY_PACKAGES["pi-subagents"].version
		: config.maintainedVersion ?? (config.baselineObservation === true ? "0.52.1" : "0.52.1-dev-agent-followthrough.2"));
const entry = path.join(root, "fixture-extension.ts");
fs.writeFileSync(entry, `import { createSubagentExecutor } from ${JSON.stringify(path.join(config.source, "src/runs/foreground/subagent-executor.ts"))};
import { DIRS } from ${JSON.stringify(path.join(config.source, "src/shared/types.ts"))};
import { subagentEvidenceResult } from ${JSON.stringify(path.resolve(import.meta.dirname, "../subagent/policy.ts"))};
import { resolveAsyncResumeTarget } from ${JSON.stringify(path.join(config.source, "src/runs/background/async-resume.ts"))};
export default (api) => api.events.emit('fixture:modules', { createSubagentExecutor, DIRS, subagentEvidenceResult, resolveAsyncResumeTarget });`);
const eventBus = pi.createEventBus(); let modules;
eventBus.on("fixture:modules", (value) => { modules = value; });
const loader = new pi.DefaultResourceLoader({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
	settingsManager: pi.SettingsManager.inMemory(), eventBus, noExtensions: true, noSkills: true,
	noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [entry] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
assert.ok(modules);
const { createSubagentExecutor, DIRS, subagentEvidenceResult } = modules;
const ready = path.join(root, "ready"), release = path.join(root, "release"), marker = path.join(root, "marker");
const child = path.join(root, "external.cjs");
const writer = scenario === "stop-residual" ? path.join(root, "residual.cjs") : child;
fs.writeFileSync(writer, `const fs=require('node:fs');
const release=${JSON.stringify(release)}, marker=${JSON.stringify(marker)};
const timer=setTimeout(()=>{watcher.close();process.exitCode=2;},15000);
const finish=()=>{if(!fs.existsSync(release))return;fs.writeFileSync(marker,'completed');clearTimeout(timer);watcher.close();};
const watcher=fs.watch(${JSON.stringify(root)},finish);
fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,at:Date.now()}));finish();\n`);
if (scenario === "stop-residual") fs.writeFileSync(child, `const {spawn}=require('node:child_process');
spawn(process.execPath,[${JSON.stringify(writer)}],{stdio:'ignore'});
setTimeout(()=>process.exit(2),20000);`);
const agent = { name: "external", description: "fixture", systemPrompt: "", systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false,
	runner: { type: "external-cli", command: process.execPath, args: [child] }, model: "fixture/default",
	modelSource: { type: "subagents.defaultModel", scope: "user", path: "/fixture/settings.json", model: "fixture/default" } };
const executor = createSubagentExecutor({
	pi: { events: { on() { return () => {}; }, emit() {} }, getSessionName: () => undefined },
	state: { baseCwd: root, currentSessionId: "external-fixture", asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
	config: {}, asyncByDefault: false, tempArtifactsDir: root,
	getSubagentSessionRoot: () => path.join(root, "sessions"), expandTilde: (v) => v,
	discoverAgents: () => ({ agents: [agent] }), allowMutatingManagementActions: true,
});
const ctx = { cwd: root, hasUI: false, ui: {}, model: { provider: "fixture", id: "parent" },
	sessionManager: { getSessionId: () => "external-fixture", getSessionFile: () => null },
	modelRegistry: { getAvailable: () => [] } };
async function until(read, description) {
	const deadline = Date.now() + 20000;
	for (;;) {
		const value = read(); if (value) return value;
		if (Date.now() >= deadline) throw Error(`Fixture deadline: ${description}; artifacts retained`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
function json(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return; throw e; } }
const started = await executor.execute("external-evidence", {
	mission: false, timeoutMs: 25000,
	workflowScript: 'return await runs.run("external", { agent: "external", task: "Fixture", async: true });',
}, new AbortController().signal, undefined, ctx);
assert.notEqual(started.isError, true);
const parentId = started.details.asyncId; assert.ok(parentId);
const parent = await until(() => { const r = json(path.join(DIRS.results, `${parentId}.json`)); return r?.state === "complete" && r; }, "parent task result");
const parentObservedAt = Date.now();
await until(() => fs.existsSync(ready), "external child ready");
const childId = parent.results?.[0]?.runId; assert.ok(childId); assert.notEqual(childId, parentId);
const childDir = path.join(DIRS.async, childId);
const before = json(path.join(childDir, "status.json"));
assert.equal(before.state, "running");
assert.equal(fs.existsSync(marker), false, "parent completion must not be used as child completion");
function active(pid) {
	assert.ok(Number.isSafeInteger(pid) && pid > 0);
	const r = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", timeout: 1000 });
	assert.ifError(r.error);
	if (r.status === 1 && !r.stdout.trim() && !r.stderr.trim()) return false;
	assert.equal(r.status, 0, "process observation unavailable; retain fixture");
	assert.ok(r.stdout.trim());
	return !r.stdout.trim().startsWith("Z");
}
const readyEvidence = json(ready);
fs.writeFileSync(path.join(root, "timing.json"), JSON.stringify({ parentObservedAt, writerReadyAt: readyEvidence.at,
	readyAfterParentMs: readyEvidence.at - parentObservedAt, scope: "wall-clock fixture observations, not upstream marker-gate timing" }));
if (scenario === "complete") fs.writeFileSync(release, "release");
else {
	const params = { action: "stop", id: childId };
	const raw = await executor.execute("stop-evidence", params, new AbortController().signal, undefined, ctx);
	assert.notEqual(raw.isError, true);
	const projected = subagentEvidenceResult("subagent", params, raw);
	assert.match(projected.content[0].text, /stop response is not proof/u);
	assert.equal(projected.details, raw.details);
	assert.deepEqual(projected.content.slice(1), raw.content);
}
const terminalState = scenario === "complete" ? "complete" : "stopped";
const after = await until(() => { const r = json(path.join(childDir, "status.json")); return r?.state === terminalState && r; }, "child task result");
let proof;
if (config.baselineObservation === true) {
	assert.equal(scenario, "complete");
	await until(() => !active(before.pid), "baseline fixture runner exit");
} else {
	proof = await until(() => json(path.join(childDir, "process-terminal.json")), "direct runner close evidence");
	assert.equal(proof.state, groupCandidate ? "unknown" : "observed"); assert.equal(proof.runId, childId);
	if (groupCandidate) {
		assert.equal(proof.reason, "external-descendants-unverified");
		assert.equal(json(path.join(childDir, "process-terminal-candidate.json")).externalWritersUnverified, true);
		assert.equal(after.steps[0].externalProcess.processGroup.state, "observed");
		assert.equal(after.steps[0].externalProcess.directCloseObserved, true);
		await until(() => !active(before.pid), "candidate fixture runner exit");
		const beforeResume = fs.readFileSync(path.join(childDir, "status.json"), "utf8");
		assert.throws(() => modules.resolveAsyncResumeTarget({ dir: childDir }, {}, { requireSessionFile: false }), /External execution unknown.*do not retry/);
		assert.equal(fs.readFileSync(path.join(childDir, "status.json"), "utf8"), beforeResume);
		// A durable unknown proof must still fence recovery when the status file
		// is missing; do not reconstruct a writer from the result-only fallback.
		const statusPath = path.join(childDir, "status.json"), backup = `${statusPath}.fixture-backup`;
		fs.renameSync(statusPath, backup);
		try { assert.throws(() => modules.resolveAsyncResumeTarget({ dir: childDir }, {}, { requireSessionFile: false }), /External execution unknown.*do not retry/); }
		finally { fs.renameSync(backup, statusPath); }
	}
}
if (scenario !== "complete") {
	assert.equal(fs.existsSync(marker), false);
	assert.equal(after.steps[0].externalProcess.processSignal, "SIGTERM");
	assert.equal(active(readyEvidence.pid), scenario === "stop-residual" && !groupCandidate);
	fs.writeFileSync(release, "release");
	if (scenario === "stop-residual" && !groupCandidate) {
		await until(() => fs.existsSync(marker), "residual write after stopped result AND runner close");
		await until(() => !active(readyEvidence.pid), "residual fixture exit");
	}
}
const markerExpected = scenario === "complete" || scenario === "stop-residual" && !groupCandidate;
assert.equal(fs.existsSync(marker), markerExpected);
if (markerExpected) assert.equal(fs.readFileSync(marker, "utf8"), "completed");
assert.equal(after.steps[0].externalProcess.exitCode, scenario === "complete" ? 0 : null);
assert.ok(after.steps[0].externalProcess.endedAt);
fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({
	parentStateBeforeRelease: parent.state, childStateBeforeRelease: before.state, markerBeforeRelease: false,
	childStateAfterRelease: after.state, externalExitCode: after.steps[0].externalProcess.exitCode,
	directRunnerClose: proof?.state ?? "fixture-process-exit-only", scopedFixtureClosed: true, modelCalls: 0,
	...(groupCandidate ? { ownedGroupClosure: after.steps[0].externalProcess.processGroup.state, externalDirectClose: after.steps[0].externalProcess.directCloseObserved } : {}),
	...(scenario === "complete" ? {} : { scenario, residualWriteAfterRunnerClose: scenario === "stop-residual" && !groupCandidate }),
}));
