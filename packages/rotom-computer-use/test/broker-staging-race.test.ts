/**
 * Startup race regression for the broker launcher (review M1).
 *
 * `stageDaemonSources` used to delete the staged directory whenever it decided to
 * re-stage, so a process that was already importing from it died with exit 1. The
 * reviewer reproduced it as `Broker daemon exited with code 1` in
 * `broker-socket.test.ts` (1 of 8 runs). A valid staged tree must now be left
 * alone, and only a tree that fails verification is moved aside.
 *
 * The test spawns several real processes that stage and import at the same moment,
 * because the failure needs real concurrency: calls inside one process are already
 * serialized by the filesystem.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entryUrl = pathToFileURL(path.join(packageRoot, "src", "broker", "daemon-entry.mjs")).href;
const ITERATIONS = 20;
const WORKERS = 4;
const SETTLE_MS = 2500;

/**
 * A child that stages and then imports the staged daemon, exactly like the
 * launcher does. Importing starts the broker, or exits 0 when another process won
 * the start lock, so whatever is still alive after `SETTLE_MS` is a broker.
 */
const WORKER_SOURCE = `
import { pathToFileURL } from "node:url";
const { stageDaemonSources } = await import(${JSON.stringify(entryUrl)});
const { entry } = stageDaemonSources(process.env);
await import(pathToFileURL(entry).href);
`;

/** One round: `WORKERS` children staging and importing at the same time. */
async function oneRound(socketPath: string): Promise<{ failures: string[]; survivors: number }> {
	const children = await Promise.all(Array.from({ length: WORKERS }, () => spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", WORKER_SOURCE], {
		env: { ...process.env, ROTOM_CU_BROKER_SOCKET: socketPath },
		cwd: path.dirname(socketPath),
		stdio: ["ignore", "ignore", "pipe"],
	})));
	const stderr = new Map();
	for (const child of children) {
		stderr.set(child, "");
		child.stderr?.on("data", (chunk) => {
			stderr.set(child, `${stderr.get(child)}${String(chunk)}`);
		});
	}
	await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

	const failures: string[] = [];
	let survivors = 0;
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			survivors += 1;
			continue;
		}
		if (child.exitCode !== 0) {
			failures.push(`${child.exitCode}: ${String(stderr.get(child)).trim().split("\n").slice(-2).join(" | ")}`);
		}
	}
	for (const child of children) child.kill("SIGKILL");
	await Promise.all(children.map((child) => new Promise((resolve) => (child.exitCode !== null ? resolve(undefined) : child.once("exit", resolve)))));
	return { failures, survivors };
}

test(`${WORKERS} processes staging and importing at once never fail (${ITERATIONS} rounds)`, async () => {
	const failures: string[] = [];
	let roundsWithSurvivor = 0;
	for (let round = 0; round < ITERATIONS; round += 1) {
		const root = mkdtempSync(path.join(tmpdir(), `rotom-cu-race-${round}-`));
		try {
			const result = await oneRound(path.join(root, "broker.sock"));
			if (result.survivors > 0) roundsWithSurvivor += 1;
			failures.push(...result.failures.map((failure) => `round ${round}: ${failure}`));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
	assert.deepEqual(failures, [], `${failures.length} failing processes across ${ITERATIONS} rounds`);
	assert.ok(roundsWithSurvivor > 0, "at least one round should leave a broker running, otherwise the children never imported");
});
