import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
