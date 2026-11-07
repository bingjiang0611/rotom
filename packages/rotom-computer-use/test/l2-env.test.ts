/**
 * The two refusals that keep a window from being spent on the wrong binaries (review 8, T3).
 *
 * A frozen commit only constrains the repository: the helper and the fixture in `~/cu-v2-test`
 * are whatever was built last. An old helper cannot report event sources and an old fixture
 * still publishes `clicked`, and either one turns a whole authorized window into nothing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { checkFixtureDigest, checkHelperSupport, expectedFixtureSourceDigest, fixtureSourceDigest, sha256Hex } from "../scripts/lib/l2-env.mjs";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(PACKAGE_ROOT, "native", "macos-fixture", "FixtureApp.swift");

function bundle(digest?: string) {
	const app = path.join(mkdtempSync(path.join(tmpdir(), "cu-v2-env-")), "Fixture.app");
	mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
	if (digest !== undefined) writeFileSync(path.join(app, "Contents", "Resources", "source.sha256"), `${digest}\n`);
	return app;
}

test("the expected digest is the source in this checkout", () => {
	const expected = expectedFixtureSourceDigest(PACKAGE_ROOT);
	assert.match(expected, /^[0-9a-f]{64}$/);
	assert.equal(expected, execFileSync("shasum", ["-a", "256", SOURCE], { encoding: "utf8" }).split(" ")[0]);
	assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("a fixture built from this source is accepted", () => {
	const app = bundle(expectedFixtureSourceDigest(PACKAGE_ROOT));
	try {
		assert.equal(fixtureSourceDigest(app), expectedFixtureSourceDigest(PACKAGE_ROOT));
		assert.deepEqual(checkFixtureDigest({ appPath: app, rootDir: PACKAGE_ROOT }).ok, true);
	} finally {
		rmSync(path.dirname(app), { recursive: true, force: true });
	}
});

test("a fixture from other source, or with no record at all, is refused", () => {
	const stale = bundle("f".repeat(64));
	const bare = bundle();
	try {
		const other = checkFixtureDigest({ appPath: stale, rootDir: PACKAGE_ROOT });
		assert.equal(other.ok, false);
		assert.match(other.reason ?? "", /built from other source/);
		const none = checkFixtureDigest({ appPath: bare, rootDir: PACKAGE_ROOT });
		assert.equal(none.ok, false);
		assert.match(none.reason ?? "", /carries no/);
	} finally {
		for (const app of [stale, bare]) rmSync(path.dirname(app), { recursive: true, force: true });
	}
});

test("a helper that cannot attribute is refused before anything is launched", () => {
	const diagnostics = { protocolVersion: 9, accessibility: true };
	const full = { userEventCount: 0, agentEventCount: 0, recentEvents: [], recentEventLimit: 512 };
	assert.deepEqual(checkHelperSupport({ activity: full, diagnostics, expectedProtocol: 9 }).ok, true);

	const older = checkHelperSupport({ activity: { userEventCount: 0, agentEventCount: 0 }, diagnostics, expectedProtocol: 9 });
	assert.equal(older.ok, false, "no ring and no limit is an old helper");
	assert.match(older.reason ?? "", /recentEventLimit/);

	const noRing = checkHelperSupport({ activity: { recentEventLimit: 512 }, diagnostics, expectedProtocol: 9 });
	assert.equal(noRing.ok, false);

	const wrongProtocol = checkHelperSupport({ activity: full, diagnostics: { protocolVersion: 8 }, expectedProtocol: 9 });
	assert.equal(wrongProtocol.ok, false);
	assert.match(wrongProtocol.reason ?? "", /protocol 8 != 9/);

	const silent = checkHelperSupport({ activity: undefined, diagnostics, expectedProtocol: 9 });
	assert.equal(silent.ok, false, "a helper that did not answer is not a helper that supports attribution");
});
