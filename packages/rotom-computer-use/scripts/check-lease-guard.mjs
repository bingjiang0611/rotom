#!/usr/bin/env node
/**
 * Deterministic lease-enforcement check for the native helper (review I2 / A5).
 *
 * Two things are proven here, both without touching the desktop:
 *  1. `--lease-self-test` inside the helper: valid / wrong signature / expired /
 *     pid mismatch / revoked / no-broker-key.
 *  2. Interoperability: a token signed by the TypeScript broker (`signLeaseToken`)
 *     is accepted by the Swift guard, and the same token is refused when the
 *     command targets a different pid.
 *
 * The binary is built into the product's cache directory rather than a temp path:
 * this machine's endpoint policy kills binaries executed from /tmp (SIGKILL, exit
 * 137), which would turn a real result into a confusing failure.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { signLeaseToken } from "../src/broker/lease-token.ts";

const cacheDir = path.join(homedir(), "Library", "Caches", "rotom-computer-use", "lease-self-test");
mkdirSync(cacheDir, { recursive: true });
const binary = path.join(cacheDir, "helper");

function run(args) {
	return spawnSync(binary, args, { encoding: "utf8" });
}

function fail(message) {
	console.error(`FAIL ${message}`);
	process.exitCode = 1;
}

const build = spawnSync(process.execPath, ["scripts/build-native.mjs", "--arch", process.arch, "--no-sign", "--output", binary], {
	encoding: "utf8",
	stdio: "inherit",
});
if (build.status !== 0) {
	console.error("helper build failed");
	process.exit(1);
}

const selfTest = run(["--lease-self-test"]);
process.stdout.write(selfTest.stdout ?? "");
if (selfTest.status !== 0) fail(`lease self-test exited ${selfTest.status}`);

const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
const claims = { agentId: "session:fixture", resourceKey: "desktop-pid:812", pid: 812, leaseId: "lease-fixture", expiresAt: Date.now() / 1000 + 120 };
const token = signLeaseToken(key, claims);
const fixture = (pid) => JSON.stringify({ key: key.toString("base64"), token, pid, resourceKey: "desktop-pid:812" });

const accepted = run([`--lease-fixture=${fixture(812)}`]);
if (accepted.status !== 0) fail(`a broker-signed token was refused: ${(accepted.stdout ?? "").trim()}`);

const wrongPid = run([`--lease-fixture=${fixture(999)}`]);
if (wrongPid.status === 0) fail("a token for pid 812 was accepted for a command on pid 999");

if (process.exitCode) {
	console.error("lease enforcement check failed");
} else {
	console.log("lease enforcement ok (self-test + broker-signed token accepted, wrong-pid token refused)");
}
