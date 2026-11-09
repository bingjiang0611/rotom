import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const source = readFileSync(path.join(root, "native", "macos", "bridge.swift"), "utf8");
const launchStart = source.indexOf("\tprivate func launchApp(");
const launchEnd = source.indexOf("\n\tprivate func quitApp(", launchStart);
const launch = source.slice(launchStart, launchEnd);

test("a pending NSWorkspace launch retains its configuration until completion", () => {
	assert.ok(launchStart >= 0 && launchEnd > launchStart, "launchApp source is present");
	assert.match(source, /private var pendingLaunchConfigurations: \[UUID: NSWorkspace\.OpenConfiguration\]/);
	assert.match(launch, /configuration\.arguments = request\["arguments"\] as\? \[String\] \?\? \[\]/);
	assert.match(launch, /pendingLaunchConfigurations\[launchId\] = configuration/);
	assert.ok(
		launch.indexOf("pendingLaunchConfigurations[launchId] = configuration") < launch.indexOf("NSWorkspace.shared.openApplication"),
		"the configuration is retained before the asynchronous launch begins",
	);
	assert.match(launch, /pendingLaunchConfigurations\.removeValue\(forKey: launchId\)/);
	assert.match(launch, /DispatchQueue\.main\.asyncAfter\(deadline: \.now\(\) \+ \.seconds\(60\)\)/);
	assert.match(launch, /return \["launched": false, "pending": true, "activated": activates\]/);
	assert.ok(
		launch.indexOf("if !waited") < launch.indexOf("if let launchError"),
		"a timeout returns pending before callback-owned results are read",
	);
});
