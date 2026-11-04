import assert from "node:assert/strict";
import test from "node:test";
import { BrokerCore } from "../src/broker/core.ts";
import { createFakeClock } from "./helpers/fake-clock.ts";
import {
	BROKER_PROTOCOL_VERSION,
	type AgentRegistration,
	type BrokerEvent,
	type BrokerReply,
	type BrokerRequest,
} from "../src/broker/protocol.ts";

function registration(agentId: string, overrides: Partial<AgentRegistration> = {}): AgentRegistration {
	return { agentId, hasUI: true, pid: 4242, pidChain: [1000], ...overrides };
}

function setup(options: { heartbeatTimeoutMs?: number; leaseTtlMs?: number; waitTimeoutMs?: number } = {}) {
	const clock = createFakeClock();
	const events: Array<{ agentId: string; event: BrokerEvent }> = [];
	const core = new BrokerCore({
		now: clock.now,
		schedule: clock.schedule,
		heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 600_000,
		leaseTtlMs: options.leaseTtlMs ?? 60_000,
		waitTimeoutMs: options.waitTimeoutMs ?? 30_000,
	});
	core.attachTransport({
		send(agentId, event) {
			events.push({ agentId, event });
			return true;
		},
		connectedAgents: () => core.registry.connectedAgents().length,
	});
	return { clock, core, events };
}

let counter = 0;
function nextId(prefix: string): string {
	counter += 1;
	return `${prefix}-${counter}`;
}

async function hello(core: BrokerCore, agent: AgentRegistration): Promise<BrokerReply> {
	return await core.handle(undefined, {
		id: nextId("hello"),
		type: "hello",
		protocolVersion: BROKER_PROTOCOL_VERSION,
		agent,
	});
}

async function call(core: BrokerCore, agentId: string | undefined, request: Omit<BrokerRequest, "id">): Promise<BrokerReply> {
	return await core.handle(agentId, { ...request, id: nextId(request.type) } as BrokerRequest);
}

async function acquire(core: BrokerCore, agentId: string, resourceKey: string, extra: Record<string, unknown> = {}): Promise<BrokerReply> {
	return await call(core, agentId, { type: "acquire", resourceKey, ...extra } as Omit<BrokerRequest, "id">);
}

test("broker protocol version mismatch is refused instead of silently degrading", async () => {
	const { core } = setup();
	const reply = await core.handle(undefined, {
		id: "hello-old",
		type: "hello",
		protocolVersion: BROKER_PROTOCOL_VERSION + 1,
		agent: registration("agent-old"),
	});
	assert.equal(reply.ok, false);
	assert.equal((reply as { code: string }).code, "protocol_mismatch");
	assert.equal(core.registry.get("agent-old"), undefined);
});

test("second writer on the same resource gets resource_busy with holder and remaining time", async () => {
	const { core } = setup();
	await hello(core, registration("agent-a"));
	await hello(core, registration("agent-b"));

	const first = await acquire(core, "agent-a", "desktop-pid:900");
	assert.equal(first.ok, true);

	const second = await acquire(core, "agent-b", "desktop-pid:900");
	assert.equal(second.ok, false);
	const failure = second as { code: string; holder?: { agentId: string; remainingMs: number; leaseId: string } };
	assert.equal(failure.code, "resource_busy");
	assert.equal(failure.holder?.agentId, "agent-a");
	assert.equal(failure.holder?.remainingMs, 60_000);
	assert.equal(typeof failure.holder?.leaseId, "string");

	// A different resource is not blocked by the first lease.
	const other = await acquire(core, "agent-b", "desktop-pid:901");
	assert.equal(other.ok, true);
});

test("wait: true queues FIFO per resource, and a 30s deadline returns resource_busy", async () => {
	const { clock, core } = setup();
	await hello(core, registration("holder"));
	await hello(core, registration("waiter-1"));
	await hello(core, registration("waiter-2"));
	await hello(core, registration("late"));

	const held = await acquire(core, "holder", "desktop-pid:700");
	assert.equal(held.ok, true);
	const leaseId = (held as { lease: { leaseId: string } }).lease.leaseId;

	let firstGranted: string | undefined;
	let secondGranted: string | undefined;
	const waiting1 = acquire(core, "waiter-1", "desktop-pid:700", { wait: true }).then((reply) => {
		if (reply.ok) firstGranted = (reply as { lease: { agentId: string } }).lease.agentId;
		return reply;
	});
	const waiting2 = acquire(core, "waiter-2", "desktop-pid:700", { wait: true }).then((reply) => {
		if (reply.ok) secondGranted = (reply as { lease: { agentId: string } }).lease.agentId;
		return reply;
	});
	// Let both requests reach the queue.
	await Promise.resolve();

	await call(core, "holder", { type: "release", leaseId });
	const reply1 = await waiting1;
	assert.equal(reply1.ok, true);
	assert.equal(firstGranted, "waiter-1");
	assert.equal(secondGranted, undefined);

	const release1 = (reply1 as { lease: { leaseId: string } }).lease.leaseId;
	await call(core, "waiter-1", { type: "release", leaseId: release1 });
	const reply2 = await waiting2;
	assert.equal(reply2.ok, true);
	assert.equal(secondGranted, "waiter-2");

	// A fresh waiter that nobody releases gets resource_busy after 30 seconds.
	const timeoutWaiter = acquire(core, "late", "desktop-pid:700", { wait: true });
	await Promise.resolve();
	clock.advance(30_000);
	const timedOut = await timeoutWaiter;
	assert.equal(timedOut.ok, false);
	assert.equal((timedOut as { code: string }).code, "resource_busy");
	assert.equal((timedOut as { holder?: { agentId: string } }).holder?.agentId, "waiter-2");
});

test("disconnect and heartbeat timeout both release leases; revocation names the in-flight lease", async () => {
	const { clock, core, events } = setup({ heartbeatTimeoutMs: 10_000 });
	await hello(core, registration("agent-a"));
	await hello(core, registration("agent-b"));

	const lease = await acquire(core, "agent-a", "desktop-pid:500");
	assert.equal(lease.ok, true);
	const leaseId = (lease as { lease: { leaseId: string } }).lease.leaseId;

	// Socket close: the agent's lease is revoked and reported.
	core.handleDisconnect("agent-a");
	assert.equal(core.holderOf("desktop-pid:500"), undefined);
	const revocation = events.find((entry) => entry.event.event === "revoked" && entry.agentId === "agent-a");
	assert.ok(revocation);
	assert.deepEqual((revocation!.event as { leaseIds: string[] }).leaseIds, [leaseId]);
	assert.equal((revocation!.event as { reason: string }).reason, "owner_disconnected");

	const reacquired = await acquire(core, "agent-b", "desktop-pid:500");
	assert.equal(reacquired.ok, true);

	// Heartbeat timeout: no traffic for the timeout window disconnects the agent.
	clock.advance(10_000);
	core.sweep();
	// The sweep removes the record entirely once it revokes the leases.
	assert.equal(core.registry.get("agent-b"), undefined);
	assert.equal(core.holderOf("desktop-pid:500"), undefined);
	assert.ok(events.some((entry) => entry.event.event === "revoked" && entry.agentId === "agent-b"));
});

test("lease TTL expires on sweep, and renewal keeps it alive", async () => {
	const { clock, core, events } = setup();
	await hello(core, registration("agent-a"));
	const lease = await acquire(core, "agent-a", "desktop-pid:300", { ttlMs: 60_000 });
	const leaseId = (lease as { lease: { leaseId: string } }).lease.leaseId;

	clock.advance(59_000);
	core.sweep();
	assert.ok(core.holderOf("desktop-pid:300"), "lease survives before its TTL");

	const renewed = await call(core, "agent-a", { type: "renew", leaseId });
	assert.equal(renewed.ok, true);

	clock.advance(59_000);
	core.sweep();
	assert.ok(core.holderOf("desktop-pid:300"), "renewal extends the deadline");

	clock.advance(2_000);
	core.sweep();
	assert.equal(core.holderOf("desktop-pid:300"), undefined);
	const expired = events.find((entry) => entry.event.event === "revoked" && (entry.event as { reason: string }).reason === "expired");
	assert.ok(expired, "expiry is reported so the client can mark in-flight work unknown");
});

test("lease transfer moves write authority to a child agent and rejects the parent", async () => {
	const { core } = setup();
	await hello(core, registration("parent"));
	await hello(core, registration("child", { parentAgentId: "parent" }));

	const lease = await acquire(core, "parent", "desktop-pid:200");
	const leaseId = (lease as { lease: { leaseId: string } }).lease.leaseId;

	const transferred = await call(core, "parent", { type: "transfer", leaseId, toAgentId: "child" });
	assert.equal(transferred.ok, true);

	const parentWrite = await acquire(core, "parent", "desktop-pid:200");
	assert.equal(parentWrite.ok, false);
	assert.equal((parentWrite as { code: string }).code, "resource_busy");
	assert.equal((parentWrite as { holder?: { agentId: string } }).holder?.agentId, "child");

	const parentRenew = await call(core, "parent", { type: "renew", leaseId });
	assert.equal(parentRenew.ok, false);
	assert.equal((parentRenew as { code: string }).code, "not_holder");

	const childWrite = await acquire(core, "child", "desktop-pid:200");
	assert.equal(childWrite.ok, true);
});

test("a write using an epoch older than the broker's current epoch is stale", async () => {
	const { core } = setup();
	await hello(core, registration("agent-a"));
	await hello(core, registration("agent-b"));

	const first = await acquire(core, "agent-a", "desktop-pid:100");
	assert.equal(first.ok, true);
	const firstEpoch = (first as { lease: { epoch: number } }).lease.epoch;
	assert.equal(firstEpoch, 1);
	const firstLease = (first as { lease: { leaseId: string } }).lease.leaseId;
	await call(core, "agent-a", { type: "release", leaseId: firstLease });

	const staleWrite = await acquire(core, "agent-b", "desktop-pid:100", { baseEpoch: 0 });
	assert.equal(staleWrite.ok, false);
	assert.equal((staleWrite as { code: string }).code, "stale");
	assert.equal((staleWrite as { currentEpoch: number }).currentEpoch, 1);

	const currentWrite = await acquire(core, "agent-b", "desktop-pid:100", { baseEpoch: firstEpoch });
	assert.equal(currentWrite.ok, true);
	assert.equal((currentWrite as { lease: { epoch: number } }).lease.epoch, 2);
});

test("reads (epoch, status) need no lease and run while another agent holds the write lease", async () => {
	const { core } = setup();
	await hello(core, registration("writer"));
	await hello(core, registration("reader"));
	await acquire(core, "writer", "desktop-pid:400");

	const epoch = await call(core, "reader", { type: "epoch", resourceKey: "desktop-pid:400" });
	assert.equal(epoch.ok, true);
	assert.equal((epoch as { epoch: number }).epoch, 1);

	const status = await call(core, "reader", { type: "status" });
	assert.equal(status.ok, true);
	const holders = (status as { status: { resources: Array<{ resourceKey: string; epoch: number; holder?: { agentId: string } }> } }).status.resources;
	assert.equal(holders.find((entry) => entry.resourceKey === "desktop-pid:400")?.holder?.agentId, "writer");
});
