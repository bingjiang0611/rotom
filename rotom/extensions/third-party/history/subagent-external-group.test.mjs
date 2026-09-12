import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test, after } from "node:test";
import { prepareExternalGroupCandidate, verifyExternalGroupPreimages, extractExternalGroupBaseline } from "./fixtures/prepare-external-group.mjs";
import { probePiVersion } from "../../runtime/verify-pi-runtime.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rotom-external-group-test-"));
const source = process.env.SUBAGENT_EXTERNAL_GROUP_SOURCE || prepareExternalGroupCandidate(root);
let retain = false;
after(() => { if (retain) console.error(`Unverified fixtures retained: ${root}`); else fs.rmSync(root, { recursive: true, force: true }); });
const { createOwnedProcessTreeController: controller, parseOwnedProcessGroupSnapshot: parse, inspectOwnedProcessGroup: inspectGroup } = await import(pathToFileURL(path.join(source, "src/runs/background/owned-process-tree.ts")));
const { runExternalCli } = await import(pathToFileURL(path.join(source, "src/runs/shared/external-cli-runner.ts")));

test("preimage gate accepts the fixed base, not a version-matching patched copy", () => {
	const baseline = path.join(root, "historical-baseline"); fs.mkdirSync(baseline, { mode: 0o700 });
	extractExternalGroupBaseline(baseline);
	verifyExternalGroupPreimages(baseline);
	assert.throws(() => extractExternalGroupBaseline(baseline), /Assertion/);
	assert.throws(() => verifyExternalGroupPreimages(source), /Candidate preimage drift/);
});
test("snapshot absence must be proven; malformed, empty and truncated records fail closed", () => {
	for (const s of ["", "broken", "10 50 S\ntruncated", "9007199254740992 50 S"]) assert.ok(!Array.isArray(parse(s, 50)));
	assert.deepEqual(parse("10 50 S\n11 50 Z\n12 60 R", 50), [10]);
	assert.deepEqual(parse("10 60 S", 50), []);
	for (const id of [0, 1, -12, NaN]) assert.throws(() => controller(id), /Invalid/);
});
test("kernel probe failure is not absence; only independent complete evidence may resolve it", () => {
	const denied = () => { throw Object.assign(Error("fixture"), { code: "EPERM" }); };
	const snapshot = (stdout) => () => ({ stdout, stderr: "", status: 0 });
	assert.deepEqual(inspectGroup(50, { probe: denied, snapshot: snapshot("10 50 S") }), [10]);
	assert.deepEqual(inspectGroup(50, { probe: denied, snapshot: snapshot("10 50 Z\n11 60 S") }), []);
	assert.ok(!Array.isArray(inspectGroup(50, { probe: denied, snapshot: snapshot("") })));
	const missing = () => { throw Object.assign(Error("fixture"), { code: "ESRCH" }); };
	assert.deepEqual(inspectGroup(50, { probe: missing, snapshot() { assert.fail("absence must not be reprobed"); } }), []);
	for (const failure of [{ error: { code: "ETIMEDOUT" } }, { error: { code: "ENOBUFS" } }, { status: 1 }, { stderr: "unavailable" }]) {
		const value = inspectGroup(50, { probe: denied, snapshot: () => ({ stdout: "10 50 S", stderr: "", status: 0, ...failure }) });
		assert.ok(!Array.isArray(value));
	}
});
for (const mode of ["absent", "term", "esrch", "kill", "eperm", "enumeration", "late-enumeration", "alive", "unsupported"]) test(`owned cleanup latches outcome without replay: ${mode}`, async () => {
	let observations = 0; const signals = [];
	const tree = controller(1234, { platform: mode === "unsupported" ? "win32" : "darwin", termGraceMs: 0, killVerifyMs: 0,
		inspect() {
			observations++;
			if (mode === "enumeration" || mode === "late-enumeration" && observations > 1) return { diagnostic: "unavailable" };
			if (mode === "absent" || mode === "term" && observations > 1 || mode === "kill" && observations > 2) return [];
			return [1234];
		},
		signal(id, signal) { signals.push([id, signal]); return mode === "eperm" ? { diagnostic: "EPERM" } : mode === "esrch" ? "absent" : "sent"; },
	});
	const pending = tree.terminate(); assert.equal(tree.terminate(), pending);
	const proof = await pending;
	const count = signals.length;
	assert.equal(await tree.finishAfterWriterClose(), proof); assert.equal(signals.length, count);
	assert.equal(proof.state, ["absent", "term", "esrch", "kill"].includes(mode) ? "observed" : "unknown");
	assert.equal(signals.length, mode === "absent" ? 0 : ["kill", "alive", "enumeration", "late-enumeration"].includes(mode) ? 2 : 1);
	assert.ok(signals.every(([id]) => id === (mode === "unsupported" ? 1234 : -1234)));
});
test("transient process snapshot failure cannot disable owned writer cancellation", async () => {
	let reads = 0; const signals = [];
	const tree = controller(1234, { termGraceMs: 0, killVerifyMs: 0,
		inspect: () => ++reads === 1 ? { diagnostic: "unavailable" } : signals.length < 2 ? [1234] : [],
		signal: (pid, signal) => { signals.push([pid, signal]); return "sent"; },
	});
	assert.equal((await tree.terminate()).state, "observed");
	assert.deepEqual(signals, [[-1234, "SIGTERM"], [-1234, "SIGKILL"]]);
});
async function until(read, label) {
	const end = Date.now() + 12000;
	for (;;) { const value = read(); if (value) return value; if (Date.now() >= end) throw Error(`Fixture deadline: ${label}`); await new Promise((r) => setTimeout(r, 20)); }
}
function active(pid) {
	const r = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", timeout: 1000 });
	assert.ifError(r.error);
	if (r.status === 1 && !r.stdout.trim() && !r.stderr.trim()) return false;
	assert.equal(r.status, 0); assert.ok(r.stdout.trim()); return !r.stdout.trim().startsWith("Z");
}
for (const mode of ["normal", "stop", "timeout", "parent-first", "escape-pipes", "escape-ignore", "spawn-error"]) test(`real external CLI candidate: ${mode}`, { timeout: 25000 }, async (t) => {
	assert.notEqual(process.platform, "win32", "POSIX process-group fixture required");
	const dir = fs.mkdtempSync(path.join(root, "case-"));
	const program = path.join(dir, "program.mjs"), ready = path.join(dir, "ready"), release = path.join(dir, "release"), marker = path.join(dir, "marker");
	fs.writeFileSync(program, `import fs from 'node:fs';import {spawn} from 'node:child_process';
const dir=${JSON.stringify(dir)},mode=${JSON.stringify(mode)};
const deadline=setTimeout(()=>process.exit(3),18000);
if(process.argv[2]==='worker'){
 process.on('SIGTERM',()=>{});
 const w=fs.watch(dir,()=>{if(fs.existsSync(dir+'/release')){fs.writeFileSync(dir+'/marker','late');clearTimeout(deadline);w.close();}});
 fs.writeFileSync(dir+'/ready',String(process.pid));
}else{
 fs.appendFileSync(dir+'/starts','1');
 if(mode==='normal'){let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>{process.stdout.write(text);clearTimeout(deadline);});}
 else {spawn(process.execPath,[${JSON.stringify(program)},'worker'],{detached:mode.startsWith('escape'),stdio:mode==='escape-ignore'?'ignore':['ignore','inherit','inherit']});
 if(mode==='parent-first'||mode==='escape-pipes'){const w=fs.watch(dir,()=>{if(fs.existsSync(dir+'/ready'))process.exit(0);});if(fs.existsSync(dir+'/ready'))process.exit(0);}}
}`);
	let stop, timeout, pid, verified = false;
	t.after(async () => {
		if (!verified) { retain = true; t.diagnostic(`Failure retained: ${dir}`); }
		// Independent test cleanup, not a retry by the implementation. Only PIDs
		// whose current executable + unique fixture script match may be signalled.
		const pids = [pid, fs.existsSync(ready) ? Number(fs.readFileSync(ready)) : undefined].filter(Boolean);
		for (const p of new Set(pids)) {
			if (!active(p)) continue;
			const r = spawnSync("ps", ["-p", String(p), "-o", "command="], { encoding: "utf8", timeout: 1000 });
			if (r.status !== 0 || r.error || !r.stdout.trim().startsWith(`${process.execPath} ${program}`)) { retain = true; throw Error("Fixture identity unavailable"); }
			process.kill(p, "SIGKILL"); await until(() => !active(p), "fixture cleanup");
		}
	});
	const pending = runExternalCli({ command: mode === "spawn-error" ? path.join(dir, "missing") : process.execPath, args: [program], cwd: dir,
		prompt: "fixture stdin", asyncDir: dir, stepIndex: 0,
		registerStop: (fn) => { stop = fn; }, registerTimeout: (fn) => { timeout = fn; }, onProcess: (p) => { pid ??= p.pid; } });
	if (!["normal", "spawn-error"].includes(mode)) {
		await until(() => fs.existsSync(ready), "writer ready");
		if (mode === "stop" || mode === "escape-ignore") { stop(); stop(); }
		if (mode === "timeout") timeout();
	}
	const result = await pending;
	fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify({ processGroup: result.externalProcess.processGroup, directCloseObserved: result.externalProcess.directCloseObserved, exitCode: result.exitCode }), { mode: 0o600 });
	assert.equal(stop, undefined); assert.equal(timeout, undefined);
	assert.equal(result.externalProcess.descendantScope, "unverified", "group observation must not claim arbitrary descendant closure");
	if (mode === "spawn-error") { assert.equal(result.exitCode, 1); assert.ok(result.error); verified = true; return; }
	assert.equal(fs.readFileSync(path.join(dir, "starts"), "utf8"), "1", "no replacement or retry");
	assert.equal(result.externalProcess.processGroup.state, "observed", JSON.stringify(result.externalProcess.processGroup));
	if (mode === "normal") { assert.equal(result.output, "fixture stdin"); assert.equal(result.exitCode, 0); }
	else {
		const writer = Number(fs.readFileSync(ready));
		assert.equal(active(writer), mode.startsWith("escape"));
		if (mode === "escape-pipes") {
			assert.equal(result.externalProcess.directCloseObserved, false); assert.equal(result.externalProcess.endedAt, undefined);
			assert.equal(result.exitCode, 1); assert.match(result.error, /unknown.*do not retry/);
		}
		fs.writeFileSync(release, "go");
		if (mode.startsWith("escape")) { await until(() => fs.existsSync(marker), "escapee late write"); await until(() => !active(writer), "escapee exit"); }
		else assert.equal(fs.existsSync(marker), false);
		if (mode === "stop" || mode === "escape-ignore") assert.equal(result.stopped, true);
		if (mode === "timeout") assert.equal(result.timedOut, true);
		if (mode === "parent-first") assert.equal(result.exitCode, 0);
	}
	verified = true;
});

for (const scenario of ["complete", "stop-direct", "stop-residual"]) test(`public loader / async runner candidate: ${scenario}`, { timeout: 45000 }, async (t) => {
	assert.ok(process.env.ROTOM_PI, "ROTOM_PI must select a verified real public Pi runtime");
	const pi = await probePiVersion({ executable: process.env.ROTOM_PI });
	const dir = fs.mkdtempSync(path.join(root, "sdk-")), home = path.join(dir, "home"); fs.mkdirSync(home);
	let verified = false;
	t.after(() => { if (!verified) { retain = true; t.diagnostic(`Unverified fixture retained: ${dir}`); } });
	const config = path.join(dir, "config.json");
	fs.writeFileSync(config, JSON.stringify({ root: dir, source, piEntry: pi.publicEntry, scenario, externalGroupCandidate: true,
		maintainedVersion: process.env.ROTOM_SUBAGENT_TEST_VERSION }), { mode: 0o600 });
	const fd = fs.openSync(path.join(dir, "driver.log"), "wx", 0o600);
	let result;
	try {
		result = spawnSync(process.execPath, [path.join(import.meta.dirname, "fixtures/subagent-external-cli-evidence.mjs")], {
			cwd: dir, timeout: 35000, stdio: ["ignore", fd, fd],
			env: { PATH: process.env.PATH, HOME: home, TMPDIR: dir, PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"),
				PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: pi.packageRoot, PI_SUBAGENTS_TEMP_ROOT: path.join(dir, "runtime"),
				GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ROTOM_EXTERNAL_FIXTURE: config },
		});
	} finally { fs.closeSync(fd); }
	if (result.error || result.status !== 0 || !fs.existsSync(path.join(dir, "result.json"))) {
		assert.fail(`candidate driver exit=${result.status}, error=${result.error?.code ?? "none"}`);
	}
	const evidence = JSON.parse(fs.readFileSync(path.join(dir, "result.json")));
	assert.equal(evidence.directRunnerClose, "unknown");
	assert.equal(evidence.scopedFixtureClosed, true);
	assert.equal(evidence.modelCalls, 0);
	assert.equal(evidence.ownedGroupClosure, "observed");
	assert.equal(evidence.externalDirectClose, true);
	if (scenario !== "complete") assert.equal(evidence.residualWriteAfterRunnerClose, false);
	t.diagnostic(JSON.stringify(evidence));
	verified = true;
});
