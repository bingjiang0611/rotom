/**
 * Packaged-install regression for the broker daemon (review B1).
 *
 * The product installs this package at
 * `rotom/extensions/third-party/node_modules/@injaneity/pi-computer-use/`.
 * Node refuses to strip types for files under `node_modules`
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so spawning `daemon.ts`
 * directly made every Computer Use write fail closed on macOS.
 *
 * The test copies the package into a temporary `node_modules` tree and drives the
 * real spawn arguments from `client.ts`. It also runs the pre-fix entry point
 * (`daemon.ts`) to show the failure this test exists to catch.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrokerClient } from "../src/broker/client.ts";
import type { AgentRegistration } from "../src/broker/protocol.ts";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let sandbox: string;
let installedPackage: string;
let socketPath: string;
let spawnedDaemon: import("node:child_process").ChildProcess | undefined;
let daemonStderr = "";

before(() => {
	sandbox = mkdtempSync(path.join(tmpdir(), "rotom-cu-packaged-"));
	installedPackage = path.join(sandbox, "node_modules", "@injaneity", "pi-computer-use");
	mkdirSync(installedPackage, { recursive: true });
	cpSync(path.join(packageRoot, "src"), path.join(installedPackage, "src"), { recursive: true });
	cpSync(path.join(packageRoot, "package.json"), path.join(installedPackage, "package.json"));
	socketPath = path.join(sandbox, "broker.sock");
});

after(() => {
	// The daemon is detached so it survives the client; stop it explicitly or the
	// test process waits for an idle-exit timeout.
	spawnedDaemon?.kill("SIGTERM");
	rmSync(sandbox, { recursive: true, force: true });
});

function packagedAgent(): AgentRegistration {
	return { agentId: "packaged-test", hasUI: true, pid: process.pid, pidChain: [process.ppid] };
}

function runDaemon(entry: string, timeoutMs = 15_000): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
			env: { ...process.env, ROTOM_CU_BROKER_SOCKET: socketPath },
			cwd: sandbox,
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, stderr });
		});
	});
}

test("a direct daemon.ts entry fails inside node_modules", async () => {
	// Control for the test below: this is the pre-fix spawn target.
	const result = await runDaemon(path.join(installedPackage, "src", "broker", "daemon.ts"), 10_000);
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING|not supported|Type Stripping/i);
});

test("the packaged daemon entry serves a client from inside node_modules", async () => {
	const entry = path.join(installedPackage, "src", "broker", "daemon-entry.mjs");
	const client = await BrokerClient.connect({ socketPath, agent: packagedAgent(), spawnIfMissing: false, heartbeatMs: 0 }).catch(async (error) => {
		// The daemon is started here exactly as `spawnBrokerDaemon` starts it, so the
		// test fails on the packaged entry rather than on the test harness.
		spawnedDaemon = spawn(process.execPath, ["--experimental-strip-types", entry], {
			env: { ...process.env, ROTOM_CU_BROKER_SOCKET: socketPath },
			cwd: sandbox,
			detached: true,
			stdio: ["ignore", "ignore", "pipe"],
		});
		spawnedDaemon.stderr?.on("data", (chunk) => {
			daemonStderr += String(chunk);
		});
		spawnedDaemon.unref();
		void error;
		return await connectWithRetry();
	});

	const lease = await client.acquire({ resourceKey: "desktop-pid:1", ttlMs: 5_000 });
	assert.equal(lease.ok, true);
	assert.ok(lease.lease.leaseId, "the packaged daemon should grant a lease");
	await client.release(lease.lease.leaseId);
	await client.close();
});

async function connectWithRetry(): Promise<BrokerClient> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 40; attempt += 1) {
		try {
			return await BrokerClient.connect({ socketPath, agent: packagedAgent(), spawnIfMissing: false, heartbeatMs: 0 });
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	}
	throw new Error(`the packaged daemon never accepted a connection: ${daemonStderr || (lastError instanceof Error ? lastError.message : String(lastError))}`);
}

test("the daemon entry stages sources under the broker's private root", () => {
	// The staged copy must not live in a shared directory: a predictable name under
	// `/tmp` lets another account win the race and get its own daemon.ts imported.
	const stagingRoot = path.join(sandbox, "stage");
	assert.ok(existsSync(stagingRoot), "the daemon should have staged its sources once");
	const staged = readdirSync(stagingRoot).filter((name) => /^[0-9a-f]{16}$/.test(name));
	assert.ok(staged.length > 0, `no staged fingerprint directory in ${stagingRoot}`);
	for (const name of staged) {
		const candidate = path.join(stagingRoot, name);
		assert.doesNotMatch(candidate, /node_modules/);
		assert.equal(statSync(candidate).mode & 0o777, 0o700, "staged sources must be private to this user");
		assert.ok(existsSync(path.join(candidate, "broker", "daemon.ts")), `missing staged entry in ${candidate}`);
	}
	assert.equal(statSync(stagingRoot).mode & 0o777, 0o700, "the staging root must be private to this user");
});

test("a tampered staged tree is replaced, not imported", async () => {
	// Importing the launcher in-process is safe: the side-effect import only runs
	// when it is the process entry point.
	const { stageDaemonSources } = await import(pathToFileURL(path.join(installedPackage, "src", "broker", "daemon-entry.mjs")).href);
	const environment = { ROTOM_CU_BROKER_SOCKET: socketPath };
	const first = stageDaemonSources(environment);
	const sourceText = readFileSync(path.join(installedPackage, "src", "broker", "daemon.ts"), "utf8");
	assert.equal(readFileSync(first.entry, "utf8"), sourceText);

	// Simulate an attacker who knows the fingerprint directory name and writes there.
	writeFileSync(first.entry, "throw new Error('tampered');\n");
	const second = stageDaemonSources(environment);
	assert.equal(second.stagedRoot, first.stagedRoot, "the same fingerprint must reuse the same directory");
	assert.equal(readFileSync(second.entry, "utf8"), sourceText, "the tampered file must be replaced by the real source");
});
