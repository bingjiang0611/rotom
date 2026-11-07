#!/usr/bin/env node
/**
 * Layout dry run for the real-machine scripts (A8).
 *
 * `PI_CU_LIVE=1` scripts need macOS, a helper and real windows. This one needs none
 * of them: it builds a synthetic fixture bundle, runs the copy/re-identify/cleanup
 * bookkeeping and the direct-L2 request builder, and prints one row per property.
 * It is the "run on the fake backend first" step for the parts that can be checked
 * without a desktop; the parts that cannot (actual delivery, snapshot side effects)
 * are listed as skipped instead of being claimed.
 *
 *   node scripts/cu-v2-script-dry-run.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { B_STEPS, REPORT_ONLY_STEPS, STEP_CONTRACT, STEP_SCRIPTS, evaluateStep, finishStep, readStopMarker, requirePreviousStepsPassed } from "./lib/b-window.mjs";
import { attributionRows } from "./lib/event-sources.mjs";
import { FIXTURE_BUNDLE_PREFIX, disposeFixtureRun, ensureFixtureWindow, isFixtureBundleId, prepareFixtureRun } from "./lib/fixture.mjs";
import { buildDirectL2Request, isDirectL2 } from "./lib/l2-direct.mjs";
import { classifyActFailure } from "./lib/live-helpers.mjs";

const rows = [];
async function check(name, run) {
	try {
		const note = (await run()) ?? "";
		rows.push({ name, result: "pass", note });
	} catch (error) {
		rows.push({ name, result: "fail", note: error instanceof Error ? error.message : String(error) });
	}
}

const root = mkdtempSync(path.join(tmpdir(), "cu-v2-fixture-"));
const sourceApp = path.join(root, "Fixture.app");
mkdirSync(path.join(sourceApp, "Contents", "MacOS"), { recursive: true });
writeFileSync(
	path.join(sourceApp, "Contents", "Info.plist"),
	'<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.cu-fixture</string></dict></plist>\n',
);

let first;
let second;
await check("fixture copy has its own bundle id", () => {
	first = prepareFixtureRun({ sourceApp, runRoot: root, stamp: "1", sign: false });
	assert.ok(first.bundleId.startsWith(FIXTURE_BUNDLE_PREFIX));
	const plist = readFileSync(path.join(first.bundlePath, "Contents", "Info.plist"), "utf8");
	assert.match(plist, new RegExp(first.bundleId.replace(/\./g, "\\.")));
	return first.bundleId;
});
await check("a second run never reuses the first copy", () => {
	second = prepareFixtureRun({ sourceApp, runRoot: root, stamp: "2", sign: false });
	assert.notEqual(second.bundlePath, first.bundlePath);
	assert.notEqual(second.bundleId, first.bundleId);
	return `${first.bundleId} vs ${second.bundleId}`;
});
await check("fixtures are recognised by bundle id prefix", () => {
	assert.equal(isFixtureBundleId(first.bundleId), true);
	assert.equal(isFixtureBundleId("com.example.other"), false);
	assert.equal(isFixtureBundleId(undefined), false);
});

await check("direct L2 request pins delivery without the whitelist", () => {
	const request = buildDirectL2Request({ lookId: "look-1", pid: 812, ref: "wire-3", action: "click" });
	assert.equal(isDirectL2(request), true);
	assert.equal(request.policy, "background");
	assert.equal(request.params.delivery, "l2");
	assert.equal(buildDirectL2Request({ lookId: "l", pid: 1, ref: "r", action: "typeText", params: { text: "x" } }).params.text, "x");
	return "click + typeText";
});
await check("direct L2 refuses anything it cannot verify", () => {
	assert.throws(() => buildDirectL2Request({ lookId: "l", pid: 0, ref: "r", action: "click" }));
	assert.throws(() => buildDirectL2Request({ lookId: "l", pid: 1, ref: "r", action: "drag" }));
	return "pid and action are validated";
});

await check("cleanup quits only this run's bundle and deletes the copy", async () => {
	const quit = [];
	const backend = {
		async listApps() {
			return [
				{ appName: "Fixture", bundleId: first.bundleId, pid: 700 },
				{ appName: "Operator App", bundleId: "com.example.operator", pid: 42 },
			];
		},
		async manageApps(request) {
			quit.push(request.pid);
		},
	};
	return await disposeFixtureRun(first, backend).then((result) => {
		assert.deepEqual(result.quit, [700]);
		assert.deepEqual(quit, [700], "the operator's app is never touched");
		assert.equal(existsSync(first.dir), false, "the copy is gone");
		return "one pid quit, directory removed";
	});
});

await check("every live script asks the gate before it touches the desktop", () => {
	// Review G6: a gate kept in an operator-side loop let a run start while the user was
	// typing. Any script that types, clicks or raises windows must call requireGate itself.
	const scripts = ["check-cu-v2-live.mjs", "cu-v2-acceptance.mjs", "cu-v2-compat-matrix.mjs", "cu-v2-l2-check.mjs"];
	for (const name of scripts) {
		const source = readFileSync(path.join(import.meta.dirname, name), "utf8");
		assert.match(source, /requireGate\(/, `${name} must call requireGate`);
		assert.match(source, /--window-start/, `${name} must read the authorized window`);
		// `process.argv[process.argv.indexOf("--flag") + 1]` silently becomes `argv[0]` when
		// the flag is absent, which is how the matrix ran a policy named after the node binary.
		assert.doesNotMatch(source, /process\.argv\[process\.argv\.indexOf\(/, `${name} must use argument(name, fallback)`);
	}
	return scripts.join(", ");
});

await check("every live script is frozen, stops on one failure and keeps the order", () => {
	// Review 6 P1. The three checks have to be wired into each script, not only into the
	// library: the first window ran four B2 attempts because nothing in the script said
	// "stopped" or "wrong commit".
	const scripts = ["check-cu-v2-live.mjs", "cu-v2-acceptance.mjs", "cu-v2-compat-matrix.mjs", "cu-v2-l2-check.mjs"];
	for (const name of scripts) {
		const source = readFileSync(path.join(import.meta.dirname, name), "utf8");
		assert.match(source, /beginStep\(/, `${name} must call beginStep`);
		assert.match(source, /--expect-commit/, `${name} must require the frozen commit`);
		// Either the script calls `finishStep` itself (matrix, l2 check, live check) or it
		// hands the step to the shared recorder, which finishes it (acceptance).
		assert.match(source, /finishStep\(|writeRunArchive\(|step: frozen\?\.step/, `${name} must record a verdict and stop on failure`);
		// The `Step:`/`Commit:`/`Verdict:` lines are rendered in one place now, so a script
		// either writes the archive through `writeRunArchive` or hands its step to the
		// shared recorder.
		assert.match(source, /writeRunArchive\(|writeEvidence\(\{|step: frozen\?\.step/, `${name} must write the Step line the order check reads`);
		// An ad-hoc activation or restore command is exactly what a window may not use.
		assert.doesNotMatch(source, /System Events/, `${name} must not raise apps through System Events`);
	}
	return scripts.length + " scripts";
});

await check("the order is B1 to B6 and a missing step blocks the rest", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cu-v2-order-"));
	try {
		// Nothing has run: only B1 may start.
		requirePreviousStepsPassed({ step: "B1", commit: "a".repeat(40), runsDir: dir });
		for (const step of B_STEPS.slice(1)) {
			assert.throws(() => requirePreviousStepsPassed({ step, commit: "a".repeat(40), runsDir: dir }), undefined, `${step} must wait`);
		}
		// A pass from an older commit does not authorize the next step under a new one.
		writeFileSync(path.join(dir, "run-1.md"), "Step: B1\nCommit: " + "b".repeat(40) + "\nVerdict: pass\n");
		assert.throws(() => requirePreviousStepsPassed({ step: "B2", commit: "a".repeat(40), runsDir: dir }), /B1 passed/);
		writeFileSync(path.join(dir, "run-2.md"), "Step: B1\nCommit: " + "a".repeat(40) + "\nVerdict: pass\n");
		requirePreviousStepsPassed({ step: "B2", commit: "a".repeat(40), runsDir: dir });
		assert.throws(() => requirePreviousStepsPassed({ step: "B6", commit: "a".repeat(40), runsDir: dir }), /B2 passed/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	return STEP_SCRIPTS.B4 === null ? "B1..B6, B4/B5 have no script yet" : "B1..B6";
});

await check("a failing run leaves the B-STOPPED marker behind", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cu-v2-stop-"));
	const base = [
		{ area: "gate", action: "verdict", result: "pass", note: "" },
		{ area: "run", action: "real user input", result: "pass", note: "" },
		{ area: "Fixture", action: "observe", result: "pass", note: "" },
		{ area: "restore", action: "operator app", result: "pass", note: "" },
	];
	try {
		assert.equal(finishStep({ step: "B2", commit: "a".repeat(40), runsDir: dir, rows: base, run: "r.md" }).verdict, "pass");
		assert.equal(readStopMarker(dir), null);
		const failing = [...base, { area: "Fixture", action: "press", result: "fail", note: "" }];
		assert.equal(finishStep({ step: "B2", commit: "a".repeat(40), runsDir: dir, rows: failing, run: "r.md" }).verdict, "fail");
		assert.equal(readStopMarker(dir)?.step, "B2");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	return "written on fail, absent on pass";
});

await check("K1: no live script writes into the worktree", () => {
	// The first window could pass B1 and then never start B2: its archive landed in
	// `docs/.../evidence/`, so the tree was dirty and committing it moved HEAD off the
	// frozen commit. Every output now goes to the required `--runs-dir`.
	const scripts = ["check-cu-v2-live.mjs", "cu-v2-acceptance.mjs", "cu-v2-compat-matrix.mjs", "cu-v2-l2-check.mjs"];
	for (const name of scripts) {
		const source = readFileSync(path.join(import.meta.dirname, name), "utf8");
		assert.match(source, /argument\("--runs-dir"\)/, `${name} must require --runs-dir`);
		assert.doesNotMatch(source, /EVIDENCE_DIR|RUNS_DIR/, `${name} must not write into the repository`);
		assert.doesNotMatch(source, /evidence\//, `${name} must not name a path inside the repository`);
	}
	return scripts.length + " scripts";
});

await check("K2: every step names the rows it cannot pass without", () => {
	// A `pass` verdict used to mean "no fail rows", so a B1 whose directed click came back
	// `inconclusive` still opened B2.
	const withHid = [{ area: "gate", action: "verdict", result: "pass", note: "" }, { area: "run", action: "real user input", result: "pass", note: "" }];
	for (const step of B_STEPS) {
		const contract = STEP_CONTRACT[step];
		assert.ok(contract?.length, `${step} must have a contract`);
		assert.ok(contract.some((row) => row.action === "real user input"), `${step} must judge real user input`);
	}
	// B4 and B5 have no script yet, so their only row is "no real user input"; every
	// step that can run today must reject two passing rows as insufficient.
	for (const step of ["B1", "B2", "B3-live", "B3-acceptance", "B6"]) {
		assert.equal(evaluateStep({ step, rows: withHid }).verdict, "fail", `${step} must not pass on two rows`);
	}
	const b1 = [
		{ area: "gate", action: "verdict", result: "pass", note: "" },
		{ area: "direct L2", action: "click", result: "pass", note: "delivery=l2" },
		{ area: "helper", action: "still alive", result: "pass", note: "" },
		{ area: "restore", action: "operator app", result: "pass", note: "" },
		{ area: "run", action: "real user input", result: "pass", note: "userEvents 10 → 10" },
	];
	assert.equal(evaluateStep({ step: "B1", rows: b1 }).verdict, "pass");
	assert.equal(evaluateStep({ step: "B1", rows: b1.map((row) => (row.action === "click" ? { ...row, result: "inconclusive" } : row)) }).verdict, "fail");
	assert.equal(evaluateStep({ step: "B1", rows: b1.map((row) => (row.action === "real user input" ? { ...row, result: "fail" } : row)) }).verdict, "fail");
	return B_STEPS.length + " steps";
});

await check("K3: the acceptance run finishes its own step", () => {
	// It used to call `beginStep` and never `finishStep`, and it shared the `B3` id with
	// the live check, so a live pass alone opened B4.
	const source = readFileSync(path.join(import.meta.dirname, "cu-v2-acceptance.mjs"), "utf8");
	assert.match(source, /step = "B3-acceptance"/);
	assert.match(source, /writeEvidence\(\{/);
	assert.match(source, /runsDir: frozen\?\.runsDir/);
	const live = readFileSync(path.join(import.meta.dirname, "check-cu-v2-live.mjs"), "utf8");
	assert.match(live, /\? "B6" : "B3-live"/);
	return "B3-live + B3-acceptance";
});

await check("R1: the click is judged by the fixture's own counter", () => {
	// The boolean readback could not work: the script clicks the same button through the AX
	// path first, so the directed click always found it already `clicked` (review 7, R1).
	const modes = readFileSync(path.join(import.meta.dirname, "lib", "l2-modes.mjs"), "utf8");
	assert.match(modes, /cu-fixture-button-result/, "the effect must come from the fixture's own result line");
	assert.match(modes, /parseClickCount/, "the count is parsed, not string-compared");
	assert.match(modes, /after === before \+ 1/, "one click must mean exactly one");
	assert.match(modes, /"click effect"/, "the effect gets its own row");
	const fixture = readFileSync(path.join(import.meta.dirname, "..", "native", "macos-fixture", "FixtureApp.swift"), "utf8");
	assert.match(fixture, /model\.clicks \+= 1/, "every click increments the counter");
	assert.match(fixture, /clicks: /, "the count is published as text");
	return "counter +1, separate row";
});

await check("R2: the helper keeps a bounded, metadata-only source ring", () => {
	const helper = readFileSync(path.join(import.meta.dirname, "..", "native", "macos", "bridge.swift"), "utf8");
	assert.match(helper, /recentEventLimit = 512/, "the ring has a fixed bound");
	assert.match(helper, /eventSourceUnixProcessID/, "the source pid is what makes attribution possible");
	assert.match(helper, /eventSourceStateID/, "the source state is recorded too");
	assert.match(helper, /--activity-self-test/, "the ring has a self-test");
	const record = helper.slice(helper.indexOf("struct EventSourceRecord"), helper.indexOf("final class UserActivityMonitor"));
	for (const forbidden of ["keyCode", "characters", "unicode", "clickState"]) {
		assert.ok(!record.includes(forbidden), `a source record may not carry ${forbidden}`);
	}
	return "512 records, metadata only";
});

await check("R2: the attribution rows report and never judge", () => {
	const rows = attributionRows(
		[{ at: 1, type: 10, pid: 4242, stateId: 1, agent: false }, { at: 2, type: 5, pid: 4242, stateId: 1, agent: false }],
		{ processName: () => "bridge", runPids: [], helperPid: 4242 },
	);
	assert.ok(rows.length >= 2, "one row per source plus a summary");
	assert.deepEqual([...new Set(rows.map((row) => row.result))], ["recorded"], "a report row is neither pass nor fail");
	assert.match(rows.at(-1).note, /K2 unchanged/, "the K2 rule was not widened");
	const script = readFileSync(path.join(import.meta.dirname, "cu-v2-l2-check.mjs"), "utf8");
	assert.match(script, /attributionRows\(/, "the live script writes the report into its archive");
	return "grouped rows + summary";
});

await check("R2: B0 reports without authorizing anything", () => {
	assert.ok(REPORT_ONLY_STEPS.includes("B0"), "B0 is a report-only step");
	assert.ok(!B_STEPS.includes("B0"), "B0 is not part of the ladder, so B1 cannot depend on it");
	const script = readFileSync(path.join(import.meta.dirname, "cu-v2-l2-check.mjs"), "utf8");
	assert.match(script, /--b0-attribution/, "the L2 check owns the B0 mode");
	assert.match(script, /reportOnly: frozen\.reportOnly === true/, "the archive is written report-only");
	const window = readFileSync(path.join(import.meta.dirname, "lib", "b-window.mjs"), "utf8");
	assert.match(window, /reportOnly\s*\n?\s*\? \{ verdict: "report"/, "a report writes no verdict");
	return "no Verdict, no marker, no permission";
});

await check("K4: one owner per step, and the HID click is two rows", () => {
	const owners = Object.entries(STEP_SCRIPTS).filter(([, script]) => script);
	assert.equal(new Set(owners.map(([, script]) => script)).size, owners.length, "a script may not own two steps");
	const l2 = readFileSync(path.join(import.meta.dirname, "cu-v2-l2-check.mjs"), "utf8");
	// The L2 check may mention `--with-hid` only in a comment naming the real owner.
	assert.doesNotMatch(l2, /includes\("--with-hid"\)|withHid/, "the L2 check no longer claims B6");
	const live = readFileSync(path.join(import.meta.dirname, "check-cu-v2-live.mjs"), "utf8");
	assert.match(live, /runHidClick\(/, "the live check must be the one that runs the HID step");
	const hid = readFileSync(path.join(import.meta.dirname, "lib", "hid-click.mjs"), "utf8");
	assert.match(hid, /click went through HID/);
	assert.match(hid, /click took effect/);
	assert.match(hid, /cu-fixture-button/, "the effect is read back from the fixture button");
	return "B6 = live check --with-hid";
});

await check("waiting for a fixture window has no hidden activation", async () => {
	// Review 6 P3: the old first step called `manageApps ... activates: true`, which does
	// nothing for a running app, and the `osascript` fallback swallowed its own failure.
	let activations = 0;
	const backend = {
		listRoots: async () => [],
		manageApps: async () => { activations += 1; },
	};
	const rootWithoutWindow = await ensureFixtureWindow(backend, { pid: 1 }, { timeoutMs: 60, intervalMs: 20 });
	assert.equal(rootWithoutWindow, undefined);
	assert.equal(activations, 0, "the wait must not try to raise the app");
	const found = await ensureFixtureWindow({ listRoots: async () => [{ kind: "window", windowId: 7 }] }, { pid: 1 }, { timeoutMs: 60 });
	assert.equal(found.windowId, 7);
	return "polls only";
});

await check("a helper refusal is a refused cell, not a failed one", () => {
	// Review 6 P4: `ax_only` refusing `typeText` carries `foreground_required`.
	assert.equal(classifyActFailure(Object.assign(new Error("ax_only cannot deliver typeText"), { code: "foreground_required" })).result, "refused");
	assert.equal(classifyActFailure(new Error("boom")).result, "fail");
	return "classified by code";
});

await check("the fixture button exposes the result on itself", () => {
	// Review 6 P4: `press` reads the pressed control, so a result only in a sibling Text
	// left every press `unknown`.
	const source = readFileSync(path.join(import.meta.dirname, "..", "native", "macos-fixture", "FixtureApp.swift"), "utf8");
	assert.match(source, /accessibilityIdentifier\("cu-fixture-button"\)[\s\S]{0,800}accessibilityValue\(/);
	return "AXValue on cu-fixture-button";
});

const skipped = [
	["real L2 delivery", "needs macOS, an isolated helper and a real fixture window"],
	["helper crash isolation", "needs the real helper binary on a dedicated socket"],
	["--with-hid frontmost restore", "needs a real foreground app to restore"],
];

rmSync(root, { recursive: true, force: true });
rmSync(second.dir, { recursive: true, force: true });

for (const row of rows) console.log(`${row.result === "pass" ? "pass" : "FAIL"} ${row.name}${row.note ? ` — ${row.note}` : ""}`);
for (const [name, why] of skipped) console.log(`skipped ${name} — ${why}`);
const failures = rows.filter((row) => row.result === "fail").length;
console.log(`${rows.length} checks, ${failures} failing, ${skipped.length} skipped`);
if (failures > 0) process.exitCode = 1;
