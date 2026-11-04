import assert from "node:assert/strict";
import net from "node:net";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BrokerClient, BrokerRequestError } from "../src/broker/client.ts";
import { startBrokerServer, BrokerAlreadyRunningError } from "../src/broker/server.ts";
import { UnsafePathError } from "../src/broker/paths.ts";
import type { AgentRegistration } from "../src/broker/protocol.ts";

function tempRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "rotom-cu-broker-"));
}

function agent(agentId: string, extra: Partial<AgentRegistration> = {}): AgentRegistration {
	return { agentId, hasUI: true, pid: process.pid, pidChain: [process.ppid], ...extra };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("Timed out waiting for broker state change.");
		await sleep(Math.min(10, remaining));
	}
}

function killQuietly(pid: number): void {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		/* already gone */
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function terminateProcess(pid: number): Promise<void> {
	killQuietly(pid);
	try {
		await waitFor(() => !isProcessAlive(pid));
	} catch {
		process.kill(pid, "SIGKILL");
		await waitFor(() => !isProcessAlive(pid));
	}
}

test("broker socket directory is 0700 and the socket itself is 0600", async () => {
	const root = tempRoot();
	const socketPath = path.join(root, "state", "broker.sock");
	const server = await startBrokerServer({ socketPath, sweepIntervalMs: 1_000 });
	try {
		assert.equal(statSync(path.join(root, "state")).mode & 0o777, 0o700);
		assert.equal(statSync(socketPath).mode & 0o777, 0o600);
	} finally {
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a symlinked state directory is refused instead of followed", async () => {
	const root = tempRoot();
	const real = path.join(root, "real");
	const link = path.join(root, "linked");
	mkdirSync(real, { recursive: true });
	chmodSync(real, 0o700);
	symlinkSync(real, link);
	try {
		await assert.rejects(
			() => startBrokerServer({ socketPath: path.join(link, "broker.sock") }),
			(error: unknown) => error instanceof UnsafePathError,
		);
		assert.equal(existsSync(path.join(real, "broker.sock")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a second start on a live socket is refused, not silently duplicated", async () => {
	const root = tempRoot();
	const socketPath = path.join(root, "broker.sock");
	const server = await startBrokerServer({ socketPath, sweepIntervalMs: 1_000 });
	try {
		await assert.rejects(
			() => startBrokerServer({ socketPath }),
			(error: unknown) => error instanceof BrokerAlreadyRunningError,
		);
	} finally {
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("two clients spawning at once converge on one broker and share arbitration", async () => {
	const root = tempRoot();
	const socketPath = path.join(root, "broker.sock");
	let first: BrokerClient | undefined;
	let second: BrokerClient | undefined;
	let brokerPid: number | undefined;
	try {
		[first, second] = await Promise.all([
			BrokerClient.connect({ socketPath, agent: agent("spawn-a"), spawnIfMissing: true, heartbeatMs: 0 }),
			BrokerClient.connect({ socketPath, agent: agent("spawn-b"), spawnIfMissing: true, heartbeatMs: 0 }),
		]);
		const [statusA, statusB] = await Promise.all([first.status(), second.status()]);
		assert.equal(statusA.pid, statusB.pid);
		brokerPid = statusA.pid;
		assert.notEqual(statusA.pid, process.pid, "the broker runs in its own detached process");

		const held = await first.acquire({ resourceKey: "desktop-pid:1" });
		assert.equal(held.lease.epoch, 1);

		await assert.rejects(
			() => second!.acquire({ resourceKey: "desktop-pid:1" }),
			(error: unknown) => {
				assert.ok(error instanceof BrokerRequestError);
				assert.equal(error.code, "resource_busy");
				assert.equal(error.reply.holder?.agentId, "spawn-a");
				return true;
			},
		);

		// A closed socket releases the lease without a cooperative release call.
		first.close();
		first = undefined;
		let acquired = false;
		for (let attempt = 0; attempt < 40 && !acquired; attempt += 1) {
			try {
				await second.acquire({ resourceKey: "desktop-pid:1" });
				acquired = true;
			} catch (error) {
				assert.ok(error instanceof BrokerRequestError);
				assert.equal(error.code, "resource_busy");
				await sleep(25);
			}
		}
		assert.equal(acquired, true, "the surviving client took over the released resource");
	} finally {
		first?.close();
		second?.close();
		if (brokerPid) await terminateProcess(brokerPid);
		rmSync(root, { recursive: true, force: true });
	}
});

test("a crashed broker is replaced by the next connecting client", async () => {
	const root = tempRoot();
	const socketPath = path.join(root, "broker.sock");
	let client: BrokerClient | undefined;
	let replacement: BrokerClient | undefined;
	let replacementPid: number | undefined;
	try {
		client = await BrokerClient.connect({ socketPath, agent: agent("crash-a"), spawnIfMissing: true, heartbeatMs: 0 });
		const firstStatus = await client.status();
		client.close();
		client = undefined;

		killQuietly(firstStatus.pid);
		for (let attempt = 0; attempt < 60; attempt += 1) {
			try {
				process.kill(firstStatus.pid, 0);
			} catch {
				break;
			}
			await sleep(25);
		}

		replacement = await BrokerClient.connect({ socketPath, agent: agent("crash-b"), spawnIfMissing: true, heartbeatMs: 0 });
		const secondStatus = await replacement.status();
		replacementPid = secondStatus.pid;
		assert.notEqual(secondStatus.pid, firstStatus.pid);
		// A restart resets epochs, so pre-restart observations read as stale.
		assert.equal(secondStatus.resources.length, 0);
	} finally {
		client?.close();
		replacement?.close();
		if (replacementPid) await terminateProcess(replacementPid);
		rmSync(root, { recursive: true, force: true });
	}
});

test("server.close completes with a connected client", async () => {
	const root = tempRoot();
	const socketPath = path.join(root, "broker.sock");
	const server = await startBrokerServer({ socketPath, sweepIntervalMs: 3_600_000 });
	let client: net.Socket | undefined;
	try {
		client = net.createConnection(socketPath);
		client.on("error", () => undefined);
		await new Promise<void>((resolve, reject) => {
			client!.once("connect", resolve);
			client!.once("error", reject);
		});
		await server.close();
		await server.closed;
		assert.equal(existsSync(socketPath), false);
	} finally {
		client?.destroy();
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("an idle broker shuts down once the last agent leaves", async () => {
	const root = tempRoot();
	const socketPath = path.join(root, "broker.sock");
	let now = 1_000;
	let server: Awaited<ReturnType<typeof startBrokerServer>> | undefined;
	let client: BrokerClient | undefined;
	try {
		server = await startBrokerServer({ socketPath, now: () => now, idleShutdownMs: 5_000, sweepIntervalMs: 3_600_000 });
		client = await BrokerClient.connect({ socketPath, agent: agent("idle-a"), heartbeatMs: 0 });
		client.close();
		await waitFor(() => server!.core.registry.connectedAgents().length === 0);
		assert.equal(server.tick(), false, "a fresh disconnect does not shut down immediately");
		now += 5_000;
		assert.equal(server.tick(), true);
		await server.closed;
		assert.equal(lstatSync(root).isDirectory(), true);
	} finally {
		client?.close();
		await server?.close();
		rmSync(root, { recursive: true, force: true });
	}
});
