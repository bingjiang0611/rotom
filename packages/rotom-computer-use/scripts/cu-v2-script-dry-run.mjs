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

import { FIXTURE_BUNDLE_PREFIX, disposeFixtureRun, isFixtureBundleId, prepareFixtureRun } from "./lib/fixture.mjs";
import { buildDirectL2Request, isDirectL2 } from "./lib/l2-direct.mjs";

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
	}
	return scripts.join(", ");
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
