#!/usr/bin/env node
/**
 * Build the macOS fixture app bundle (Computer Use v2 live checks).
 *
 * The bundle used to be assembled by hand, and on 2026-11-07 that cost a whole B0 window:
 * the hand-written `Info.plist` was missing `CFBundleVersion`, so LaunchServices refused the
 * copy with "a miscellaneous error occurred" and the run had nothing to click. The keys here
 * are the ones the last known-good bundle had - nothing invented, nothing omitted.
 *
 *   node scripts/build-fixture.mjs --output ~/cu-v2-build/Fixture.app \
 *     --sign-identity "Apple Development: ... (TEAMID)"
 *
 * The app must run as a bundle for Accessibility to see a stable identity, and the copy a
 * live run makes is re-signed again by `prepareFixtureRun`.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { FIXTURE_MINIMUM_MACOS, fixtureInfoPlist, parseBuildVersionMinos } from "./lib/fixture.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

function argument(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

function run(command, args) {
	execFileSync(command, args, { stdio: "inherit" });
}

const outputArg = argument("--output");
if (!outputArg) {
	console.error("--output <path to the .app bundle> is required");
	process.exit(2);
}
if (process.platform !== "darwin") {
	console.error("the fixture is a macOS app bundle");
	process.exit(2);
}

const bundlePath = path.resolve(outputArg);
const sourcePath = path.join(rootDir, "native", "macos-fixture", "FixtureApp.swift");
const executablePath = path.join(bundlePath, "Contents", "MacOS", "Fixture");

rmSync(bundlePath, { recursive: true, force: true });
mkdirSync(path.dirname(executablePath), { recursive: true });
// `-parse-as-library` because the file uses `@main`: without it swiftc treats the file as
// top-level code and refuses the attribute. `-target` because without it swiftc takes the
// SDK default (28.0 on the 2026-11-07 host), and dyld refuses a binary that wants a newer
// macOS than the machine running it.
run("xcrun", ["swiftc", "-O", "-parse-as-library", "-target", `arm64-apple-macos${FIXTURE_MINIMUM_MACOS}`, sourcePath, "-o", executablePath]);
chmodSync(executablePath, 0o755);
writeFileSync(path.join(bundlePath, "Contents", "Info.plist"), fixtureInfoPlist({ version: "1" }));
writeFileSync(path.join(bundlePath, "Contents", "PkgInfo"), "APPL????");

// Read the binary back: the deployment target is the one thing about a bundle that no
// plist key can vouch for, and getting it wrong fails at launch with an opaque error.
const minos = parseBuildVersionMinos(execFileSync("otool", ["-l", executablePath], { encoding: "utf8" }));
if (minos !== FIXTURE_MINIMUM_MACOS) {
	console.error(`built binary wants macOS ${minos ?? "?"}, expected ${FIXTURE_MINIMUM_MACOS}; pass -target so dyld can load it`);
	process.exit(1);
}

const identity = argument("--sign-identity") ?? process.env.PI_CU_FIXTURE_SIGN_IDENTITY;
if (identity) {
	run("codesign", ["--force", "--timestamp=none", "-s", identity, bundlePath]);
	run("codesign", ["--verify", "--strict", bundlePath]);
} else {
	// Ad-hoc signing is refused by amfid for a copied bundle; the live run would fail later.
	console.log("no --sign-identity: bundle left unsigned (a live run needs a real identity)");
}

// Read it back through the system plist parser, so a broken file fails here and not in a run.
run("/usr/libexec/PlistBuddy", ["-c", "Print", path.join(bundlePath, "Contents", "Info.plist")]);
console.log(`built ${bundlePath.replace(process.env.HOME ?? "", "~")}`);
console.log(`source ${readFileSync(sourcePath, "utf8").length} bytes of FixtureApp.swift`);
