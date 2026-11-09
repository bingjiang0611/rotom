#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

if (process.platform !== "darwin") {
	console.log("macOS native self-tests skipped: not macOS");
	process.exit(0);
}

const root = path.resolve(import.meta.dirname, "..");
const arch = process.arch === "arm64" ? "arm64" : "x64";
const build = spawnSync(process.execPath, [path.join(root, "scripts", "build-native.mjs"), "--arch", arch], { cwd: root, encoding: "utf8" });
process.stdout.write(build.stdout ?? "");
process.stderr.write(build.stderr ?? "");
if (build.status !== 0) process.exit(build.status ?? 1);

const helper = path.join(root, "prebuilt", "macos", arch, "bridge");
for (const test of [
	{ flag: "--activity-self-test", expected: "case calibration metadata pass" },
	{ flag: "--mouse-target-self-test", expected: "case target-hid pass" },
	{ flag: "--input-source-self-test", expected: "input-source cases=7 failures=0" },
	{ flag: "--takeover-state-self-test", expected: "takeover-state failures=0" },
]) {
	const result = spawnSync(helper, [test.flag], { cwd: root, encoding: "utf8" });
	process.stdout.write(result.stdout ?? "");
	process.stderr.write(result.stderr ?? "");
	if (result.status !== 0 || !String(result.stdout).includes(test.expected)) {
		console.error(`${test.flag} failed or omitted '${test.expected}'`);
		process.exit(result.status || 1);
	}
}

console.log("macOS native self-tests passed");
