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

import { B_STEPS, STEP_SCRIPTS, finishStep, readStopMarker, requirePreviousStepsPassed } from "./lib/b-window.mjs";
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
		assert.match(source, /finishStep\(|step: frozen\?\.step/, `${name} must record a verdict and stop on failure`);
		assert.match(source, /Step: \$\{|step: frozen\?\.step/, `${name} must write the Step line the order check reads`);
		// An ad-hoc activation or restore command is exactly what a window may not use.
		assert.doesNotMatch(source, /System Events/, `${name} must not raise apps through System Events`);
	}
	return scripts.length + " scripts";
});

await check("the order is B1 to B6 and a missing step blocks the rest", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cu-v2-order-"));
	try {
		// Nothing has run: only B1 may start.
		requirePreviousStepsPassed({ step: "B1", commit: "a".repeat(40), dir });
		for (const step of B_STEPS.slice(1)) {
			assert.throws(() => requirePreviousStepsPassed({ step, commit: "a".repeat(40), dir }), undefined, `${step} must wait`);
		}
		// A pass from an older commit does not authorize the next step under a new one.
		writeFileSync(path.join(dir, "run-1.md"), "Step: B1\nCommit: " + "b".repeat(40) + "\nVerdict: pass\n");
		assert.throws(() => requirePreviousStepsPassed({ step: "B2", commit: "a".repeat(40), dir }), /B1 passed/);
		writeFileSync(path.join(dir, "run-2.md"), "Step: B1\nCommit: " + "a".repeat(40) + "\nVerdict: pass\n");
		requirePreviousStepsPassed({ step: "B2", commit: "a".repeat(40), dir });
		assert.throws(() => requirePreviousStepsPassed({ step: "B6", commit: "a".repeat(40), dir }), /B2 passed/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	return STEP_SCRIPTS.B4 === null ? "B1..B6, B4/B5 have no script yet" : "B1..B6";
});

await check("a failing run leaves the B-STOPPED marker behind", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cu-v2-stop-"));
	try {
		assert.equal(finishStep({ step: "B2", commit: "a".repeat(40), dir, failures: 0, run: "r.md" }), "pass");
		assert.equal(readStopMarker(dir), null);
		assert.equal(finishStep({ step: "B2", commit: "a".repeat(40), dir, failures: 2, run: "r.md" }), "fail");
		assert.equal(readStopMarker(dir)?.step, "B2");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	return "written on fail, absent on pass";
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
