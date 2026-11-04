/**
 * Stopping other agents is a user action (review B3).
 *
 * PLAN §7 gives stopping to the user (menu bar item and Ctrl+Option+Cmd+.). Before
 * this test, any model-driven `cu_session stop` could revoke every peer's lease,
 * which breaks the multi-agent premise of the whole feature.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BrokerClient, BrokerRequestError } from "../src/broker/client.ts";
import type { AgentRegistration } from "../src/broker/protocol.ts";
import { startBrokerServer } from "../src/broker/server.ts";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function agent(agentId: string, extra: Partial<AgentRegistration> = {}): AgentRegistration {
	return { agentId, hasUI: true, pid: process.pid, pidChain: [process.ppid], role: "agent", ...extra };
}

async function withBroker(run: (socketPath: string) => Promise<void>): Promise<void> {
	const root = mkdtempSync(path.join(tmpdir(), "rotom-cu-stop-"));
	const socketPath = path.join(root, "broker.sock");
	const server = await startBrokerServer({ socketPath });
	try {
		await run(socketPath);
	} finally {
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
}

test("an agent may not stop its peers", async () => {
	await withBroker(async (socketPath) => {
		const first = await BrokerClient.connect({ socketPath, agent: agent("agent-a"), heartbeatMs: 0 });
		const second = await BrokerClient.connect({ socketPath, agent: agent("agent-b"), heartbeatMs: 0 });
		try {
			await assert.rejects(
				() => first.stop(),
				(error: unknown) => {
					assert.ok(error instanceof BrokerRequestError);
					assert.equal(error.code, "not_permitted");
					assert.match(error.message, /menu bar|Ctrl\+Option\+Cmd\+/);
					return true;
				},
			);
			// The peer keeps its lease: an agent cannot silence another agent.
			const held = await second.acquire({ resourceKey: "app:com.example.fixture" });
			const status = await first.status();
			assert.ok(status.agents.some((entry) => entry.agentId === "agent-b" && entry.leases.some((lease) => lease.leaseId === held.lease.leaseId)));
		} finally {
			await first.close();
			await second.close();
		}
	});
});

test("a helper connection may stop agents", async () => {
	await withBroker(async (socketPath) => {
		const peer = await BrokerClient.connect({ socketPath, agent: agent("agent-peer"), heartbeatMs: 0 });
		const helper = await BrokerClient.connect({ socketPath, agent: agent("helper", { role: "helper" }), heartbeatMs: 0 });
		try {
			const stopped = await helper.stop();
			assert.deepEqual(stopped, ["agent-peer"]);
		} finally {
			await helper.close();
			await peer.close();
		}
	});
});

test("the model-visible cu_session schema no longer offers stop", () => {
	const source = readFileSync(path.join(packageRoot, "extensions", "computer-use.ts"), "utf8");
	const block = source.slice(source.indexOf('name: "cu_session"'), source.indexOf("execute: executeCuSession"));
	assert.ok(block.length > 0, "cu_session tool definition should exist");
	assert.doesNotMatch(block, /Type\.Literal\("stop"\)/);
	assert.match(block, /Type\.Literal\("release"\)/);
});
