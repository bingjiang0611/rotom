/**
 * The fixture-shaped dry-run checks, kept out of the runner so it stays readable.
 *
 * Everything here is about the app the live checks drive: the bundle it must be, the
 * counter it publishes, and the wiring that reads both. Each `run` returns a short note and
 * throws on failure, exactly like the inline checks.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { FIXTURE_MINIMUM_MACOS, fixtureInfoPlist, parseBuildVersionMinos } from "./fixture.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..", "..");

/** `scripts/lib/` -> package root -> a file path, without repeating the climb. */
export const read = (...parts) => readFileSync(path.join(packageRoot, ...parts), "utf8");

export const fixtureChecks = [
	{
		name: "the fixture button exposes the result on itself",
		run() {
			// Review 6 P4: `press` reads the pressed control, so a result only in a sibling Text
			// left every press `unknown`.
			const source = read("native", "macos-fixture", "FixtureApp.swift");
			assert.match(source, /accessibilityIdentifier\("cu-fixture-button"\)[\s\S]{0,800}accessibilityValue\(/);
			return "AXValue on cu-fixture-button";
		},
	},
	{
		name: "R1: the fixture publishes a click counter and B1 judges it",
		run() {
			// A boolean is spent after the first click, so a run that clicks the same button
			// twice could not tell whether the second one landed (review 7, R1).
			const source = read("native", "macos-fixture", "FixtureApp.swift");
			assert.match(source, /model\.clicks \+= 1/, "every click increments the counter");
			assert.match(source, /clicks: /, "the count is published as text");
			const modes = read("scripts", "lib", "l2-modes.mjs");
			assert.match(modes, /parseClickCount/, "the count is parsed, not string-compared");
			assert.match(modes, /after === before \+ 1/, "one click must mean exactly one");
			return "counter +1";
		},
	},
	{
		name: "the L2 script takes `alive` from the probe factory",
		run() {
			// The 2026-11-07 B0 run aborted with `alive is not defined`: the helper stayed behind
			// in the script when the probes moved into `lib/l2-probe.mjs`, and only a real run
			// evaluates that name, so a green suite and a green dry run both missed it.
			const script = read("scripts", "cu-v2-l2-check.mjs");
			assert.match(script, /createAlive\(/, "the script must build it from the factory");
			assert.doesNotMatch(script, /async function alive\(/, "no local copy to fall out of step");
			assert.match(read("scripts", "lib", "l2-probe.mjs"), /export function createAlive/, "the factory lives next to the probe that needs it");
			return "factory-owned";
		},
	},
	{
		name: "the fixture bundle carries the keys that make it launch",
		run() {
			// A hand-written Info.plist without CFBundleVersion made LaunchServices refuse the
			// copy, and the 2026-11-07 B0 run had nothing to click.
			const plist = fixtureInfoPlist({ version: "1" });
			assert.match(plist, /<key>CFBundleVersion<\/key>/);
			assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>Fixture<\/string>/);
			assert.match(plist, /<key>LSMinimumSystemVersion<\/key>/);
			assert.match(plist, /<key>NSHighResolutionCapable<\/key>/);
			const builder = read("scripts", "build-fixture.mjs");
			assert.match(builder, /-parse-as-library/, "@main needs a library compile");
			assert.match(builder, /PkgInfo/, "the known-good bundle shipped one");
			assert.match(builder, /source\.sha256/, "the bundle records which source it came from");
			// A binary built without -target wants the SDK's macOS, not this one; dyld then
			// refuses it and LaunchServices says only "a miscellaneous error occurred".
			assert.match(builder, /-target.*arm64-apple-macos/, "the deployment target must be pinned");
			assert.match(builder, /parseBuildVersionMinos/, "the built binary is read back, not assumed");
			assert.equal(parseBuildVersionMinos("LC_BUILD_VERSION\n    minos 14.0\n      sdk 26.5"), FIXTURE_MINIMUM_MACOS);
			assert.match(plist, new RegExp(`LSMinimumSystemVersion</key>\\s*<string>${FIXTURE_MINIMUM_MACOS}</string>`), "plist and target agree");
			return "8 keys + PkgInfo + minos pinned";
		},
	},
];
