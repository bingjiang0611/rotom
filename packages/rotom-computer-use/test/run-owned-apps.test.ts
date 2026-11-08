import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { launchFixture, selectFixtureForRun } from "../scripts/lib/fixture.mjs";
import { createRunAppOwnership, quitRunOwnedApp, rememberRunLaunch } from "../scripts/lib/run-owned-apps.mjs";

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");

test("only a new launch records cleanup authority", () => {
	const owned = createRunAppOwnership();
	assert.equal(rememberRunLaunch(owned, { launched: true, alreadyRunning: false, pid: 41 }), 41);
	assert.deepEqual([...owned], [41]);
	assert.equal(rememberRunLaunch(owned, { launched: true, alreadyRunning: true, pid: 42 }), undefined);
	assert.equal(rememberRunLaunch(owned, { launched: false, alreadyRunning: false, pid: 43 }), undefined);
	assert.equal(rememberRunLaunch(owned, { launched: true, alreadyRunning: false, pid: 0 }), undefined);
	assert.deepEqual([...owned], [41]);
});

test("a pending copied fixture records the one new pid with its unique bundle id", async () => {
	const bundleId = "com.example.cu-fixture.pending";
	const owned = createRunAppOwnership();
	let launched = false;
	const backend = {
		listApps: async () => launched
			? [{ pid: 51, bundleId: "com.example.operator" }, { pid: 52, bundleId }]
			: [{ pid: 51, bundleId: "com.example.operator" }],
		manageApps: async () => {
			launched = true;
			return { launched: false, pending: true, alreadyRunning: false };
		},
	};
	const result = await launchFixture(backend, { bundlePath: "/tmp/Fixture.app", bundleId, startedPids: owned }, { pendingTimeoutMs: 10, pendingIntervalMs: 0 });
	assert.equal(result.pid, 52);
	assert.deepEqual([...owned], [52]);
});

test("a pending copied fixture never claims a same-bundle pid that predates the launch", async () => {
	const bundleId = "com.example.cu-fixture.preexisting";
	const owned = createRunAppOwnership();
	const backend = {
		listApps: async () => [{ pid: 52, bundleId }],
		manageApps: async () => ({ launched: false, pending: true, alreadyRunning: true }),
	};
	const result = await launchFixture(backend, { bundlePath: "/tmp/Fixture.app", bundleId, startedPids: owned }, { pendingTimeoutMs: 0, pendingIntervalMs: 0 });
	assert.equal(result.pid, undefined);
	assert.deepEqual([...owned], []);
});

test("a copied run selects only its exact bundle id and recorded pid", () => {
	const run = { bundleId: "com.example.cu-fixture.owned", startedPids: new Set([52]) };
	const apps = [
		{ pid: 51, bundleId: "com.example.cu-fixture.other", appName: "Fixture" },
		{ pid: 52, bundleId: run.bundleId, appName: "Fixture" },
	];
	assert.deepEqual(selectFixtureForRun(apps, { run, startedByThisRun: () => true }), apps[1]);
});

test("a copied run never falls back to an unowned exact or other fixture process", () => {
	const run = { bundleId: "com.example.cu-fixture.owned", startedPids: new Set<number>() };
	const apps = [
		{ pid: 51, bundleId: "com.example.cu-fixture.other", appName: "Fixture" },
		{ pid: 52, bundleId: run.bundleId, appName: "Fixture" },
	];
	assert.equal(selectFixtureForRun(apps, { run, startedByThisRun: () => true }), undefined);
});

test("cleanup refuses an already-running or otherwise foreign pid", async () => {
	const owned = createRunAppOwnership();
	rememberRunLaunch(owned, { launched: true, alreadyRunning: true, pid: 42 });
	const calls: unknown[] = [];
	const rows: unknown[] = [];
	const result = await quitRunOwnedApp({
		backend: { manageApps: async (request: unknown) => { calls.push(request); } },
		ownedPids: owned,
		pid: 42,
		record: (...row: unknown[]) => rows.push(row),
	});
	assert.equal(result.refused, true);
	assert.equal(calls.length, 0);
	assert.deepEqual(rows, [["cleanup", "owned app", "fail", "refused to quit pid=42: it was not recorded from a new launch by this run"]]);
});

test("B-stage scripts contain no force App quit path", () => {
	for (const name of ["cu-v2-l2-check.mjs", "cu-v2-compat-matrix.mjs", "cu-v2-acceptance.mjs", "check-cu-v2-live.mjs"]) {
		const source = readFileSync(path.join(scripts, name), "utf8");
		assert.doesNotMatch(source, /(?:mode|action):\s*"quit"[^}]*force:\s*true/s, `${name} force-quits an App`);
	}
	const acceptance = readFileSync(path.join(scripts, "cu-v2-acceptance.mjs"), "utf8");
	assert.match(acceptance, /mode: "launch", bundleId: "com\.apple\.TextEdit"/, "TextEdit launch must let the helper detect an already-running foreign process");
	assert.doesNotMatch(acceptance, /mode: "launch", path: [^\n]*TextEdit/, "path launch cannot prove TextEdit ownership");
});

test("an unconfirmed polite quit retains ownership and records failure", async () => {
	const owned = createRunAppOwnership();
	rememberRunLaunch(owned, { launched: true, alreadyRunning: false, pid: 41 });
	const rows: unknown[] = [];
	const result = await quitRunOwnedApp({
		backend: { manageApps: async () => ({ quitRequested: true, terminated: false }) },
		ownedPids: owned,
		pid: 41,
		record: (...row: unknown[]) => rows.push(row),
	});
	assert.equal(result.stopped, false);
	assert.equal(owned.has(41), true);
	assert.deepEqual(rows, [["cleanup", "owned app", "fail", "quit pid=41 did not terminate the app; ownership retained"]]);
});

test("cleanup uses a non-force quit for a pid this run launched", async () => {
	const owned = createRunAppOwnership();
	rememberRunLaunch(owned, { launched: true, alreadyRunning: false, pid: 41 });
	const calls: unknown[] = [];
	const result = await quitRunOwnedApp({
		backend: { manageApps: async (request: unknown) => { calls.push(request); return { terminated: true }; } },
		ownedPids: owned,
		pid: 41,
	});
	assert.equal(result.refused, false);
	assert.equal(result.stopped, true);
	assert.deepEqual(calls, [{ mode: "quit", pid: 41, force: false }]);
	assert.equal(owned.has(41), false);
});
