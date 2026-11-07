/**
 * The fixture bundle metadata (2026-11-07, B0 window).
 *
 * The bundle was assembled by hand, and the hand-written `Info.plist` was missing
 * `CFBundleVersion`; LaunchServices answered "a miscellaneous error occurred" and the B0
 * run had no fixture to click. These tests pin the keys to the last bundle that launched.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { FIXTURE_MINIMUM_MACOS, fixtureInfoPlist, parseBuildVersionMinos } from "../scripts/lib/fixture.mjs";

const plist = fixtureInfoPlist({ version: "1" });

test("every key the known-good bundle had is present", () => {
	for (const key of [
		"CFBundleExecutable",
		"CFBundleIdentifier",
		"CFBundleName",
		"CFBundlePackageType",
		"CFBundleShortVersionString",
		"CFBundleVersion",
		"LSMinimumSystemVersion",
		"NSHighResolutionCapable",
	]) {
		assert.match(plist, new RegExp(`<key>${key}</key>`), `missing ${key}`);
	}
});

test("the keys that made the app unlaunchable stay fixed", () => {
	// Without CFBundleVersion LaunchServices refused the copy; the value matches the bundle
	// that did launch (`~/cu-v2-test/Fixture.app`).
	assert.match(plist, /<key>CFBundleVersion<\/key>\s*<string>1<\/string>/);
	assert.match(plist, /<key>LSMinimumSystemVersion<\/key>\s*<string>14\.0<\/string>/);
	assert.match(plist, /<key>CFBundlePackageType<\/key>\s*<string>APPL<\/string>/);
	assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>Fixture<\/string>/);
	// A copy is re-identified per run; the base bundle id must stay stable.
	assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>com\.example\.cu-fixture<\/string>/);
});

test("the bundle id can be overridden for a copy", () => {
	assert.match(fixtureInfoPlist({ bundleId: "com.example.cu-fixture.123" }), /com\.example\.cu-fixture\.123/);
});

test("the deployment target and the plist cannot drift apart", () => {
	// The binary must carry the same minimum macOS the plist advertises; building without
	// `-target` produced minos 28.0 on a 27.3 host, and the app then failed to launch.
	assert.equal(FIXTURE_MINIMUM_MACOS, "14.0");
	assert.match(plist, new RegExp(`<key>LSMinimumSystemVersion</key>\\s*<string>${FIXTURE_MINIMUM_MACOS}</string>`));
});

test("the built binary's minos is read back and compared", () => {
	const text = `      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform 1\n    minos 14.0\n      sdk 26.5\n`;
	assert.equal(parseBuildVersionMinos(text), "14.0");
	assert.equal(parseBuildVersionMinos(text.replace("14.0", "28.0")), "28.0");
	assert.equal(parseBuildVersionMinos("no build version here"), undefined);
});
