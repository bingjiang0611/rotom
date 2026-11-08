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

import { checkFixture, checkHelperSupport, expectedFixtureSourceDigest, fixtureSourceDigest, sha256Hex, signatureOf } from "../scripts/lib/l2-env.mjs";

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
		assert.deepEqual(checkFixture({ appPath: app, rootDir: PACKAGE_ROOT }).ok, true);
	} finally {
		rmSync(path.dirname(app), { recursive: true, force: true });
	}
});

test("a fixture from other source, or with no record at all, is refused", () => {
	const stale = bundle("f".repeat(64));
	const bare = bundle();
	try {
		const other = checkFixture({ appPath: stale, rootDir: PACKAGE_ROOT });
		assert.equal(other.ok, false);
		assert.match(other.reason ?? "", /built from other source/);
		const none = checkFixture({ appPath: bare, rootDir: PACKAGE_ROOT });
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

/** `codesign -dv` output shapes that matter: a real identity, ad hoc, and nothing at all. */
const SIGNED = "Identifier=com.example.cu-fixture\nCodeDirectory v=20400 size=552 flags=0x0(none)\nSignature size=4790\nAuthority=Apple Development: someone@example.com (ABCDEFG123)\nAuthority=Apple Root CA\n";
const ADHOC = "Identifier=com.example.cu-fixture.1\nCodeDirectory v=20400 size=541 flags=0x2(adhoc)\nSignature=adhoc\n";

test("the fixture signature is read back, not assumed", () => {
	const run = (text: string) => () => text;
	assert.deepEqual(signatureOf("/x/Fixture.app", { exec: run(SIGNED) as never }).adhoc, false);
	assert.equal(signatureOf("/x/Fixture.app", { exec: run(SIGNED) as never }).authority, "Apple Development: someone@example.com (ABCDEFG123)");
	assert.equal(signatureOf("/x/Fixture.app", { exec: run(ADHOC) as never }).adhoc, true);
	// No Signature line at all: an unsigned bundle is as unusable as an ad-hoc one.
	assert.equal(signatureOf("/x/Fixture.app", { exec: run("Identifier=x\n") as never }).adhoc, true);
});

test("a copy that would be ad-hoc signed is refused before anything runs", () => {
	const app = bundle(expectedFixtureSourceDigest(PACKAGE_ROOT));
	try {
		// This is the window that was lost: the identity was not in the environment, so the
		// copy was signed with `-` and amfid killed it at exec.
		const missing = checkFixture({ appPath: app, rootDir: PACKAGE_ROOT, willCopy: true });
		assert.equal(missing.ok, false);
		assert.match(missing.reason ?? "", /PI_CU_FIXTURE_SIGN_IDENTITY is unset/);
		// Same bundle, an identity in the environment: the source signature decides.
		const adhocSource = checkFixture({ appPath: app, rootDir: PACKAGE_ROOT, identity: "Apple Development: x", willCopy: true });
		assert.equal(adhocSource.ok, false, "a test bundle has no embedded signature");
		assert.match(adhocSource.reason ?? "", /ad-hoc signed/);
		// No copy is made when --no-fixture-copy is used, so signing is not demanded.
		assert.equal(checkFixture({ appPath: app, rootDir: PACKAGE_ROOT, willCopy: false }).ok, true);
	} finally {
		rmSync(path.dirname(app), { recursive: true, force: true });
	}
});
