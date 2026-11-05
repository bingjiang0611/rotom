/**
 * Handing an app to a subagent (PLAN §5.5 / F2, review item A4).
 *
 * A parent that holds an app may give the lease to a subagent it spawned, so the
 * child can work without waiting for a TTL. The broker enforces the two limits:
 * only own descendants may receive a lease, and a child's leases come back to the
 * parent when it exits instead of leaving the app locked.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BrokerCore } from "../src/broker/core.ts";
import { PARENT_AGENT_SESSION_ENV, agentRegistrationFor } from "../src/broker/identity.ts";
import { createFakeClock } from "./helpers/fake-clock.ts";
import {
	BROKER_PROTOCOL_VERSION,
	type AgentRegistration,
	type BrokerEvent,
	type BrokerReply,
	type BrokerRequest,
} from "../src/broker/protocol.ts";

function registration(agentId: string, overrides: Partial<AgentRegistration> = {}): AgentRegistration {
	return { agentId, hasUI: true, pid: 4242, pidChain: [1000], role: "agent", ...overrides };
}

function setup() {
	const clock = createFakeClock();
	const events: Array<{ agentId: string; event: BrokerEvent }> = [];
	const core = new BrokerCore({
		now: clock.now,
		schedule: clock.schedule,
		heartbeatTimeoutMs: 600_000,
		leaseTtlMs: 60_000,
		waitTimeoutMs: 30_000,
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
async function hello(core: BrokerCore, agent: AgentRegistration): Promise<BrokerReply> {
	counter += 1;
	return await core.handle(undefined, { id: `hello-${counter}`, type: "hello", protocolVersion: BROKER_PROTOCOL_VERSION, agent });
}

async function call(core: BrokerCore, agentId: string | undefined, request: Omit<BrokerRequest, "id">): Promise<BrokerReply> {
	counter += 1;
	return await core.handle(agentId, { ...request, id: `${request.type}-${counter}` } as BrokerRequest);
}

async function leaseOf(core: BrokerCore, agentId: string, resourceKey: string): Promise<string | undefined> {
	const reply = await call(core, agentId, { type: "status" });
	const status = (reply as { status: { agents: Array<{ agentId: string; leases: Array<{ resourceKey: string; leaseId: string }> }> } }).status;
	return status.agents.find((agent) => agent.agentId === agentId)?.leases.find((lease) => lease.resourceKey === resourceKey)?.leaseId;
}

test("the subagent host already links a child to its parent session id", () => {
	// No new environment variable: the subagent host exports the parent session id.
	const child = agentRegistrationFor({
		sessionId: "child-session",
		hasUI: false,
		pidChain: [2000],
		environment: { [PARENT_AGENT_SESSION_ENV]: "parent-session" } as NodeJS.ProcessEnv,
	});
	assert.equal(child.agentId, "session:child-session");
	assert.equal(child.parentAgentId, "session:parent-session");

	const root = agentRegistrationFor({ sessionId: "root", hasUI: true, pidChain: [], environment: {} as NodeJS.ProcessEnv });
	assert.equal(root.parentAgentId, undefined, "a root session has no parent");
});

test("a parent hands its app to a subagent: the parent can no longer write, the child can", async () => {
	const { core } = setup();
	await hello(core, registration("session:parent"));
	await hello(core, registration("session:child", { parentAgentId: "session:parent", hasUI: false }));

	const acquired = await call(core, "session:parent", { type: "acquire", resourceKey: "app:com.example.fixture" });
	assert.equal(acquired.ok, true);
	const leaseId = await leaseOf(core, "session:parent", "app:com.example.fixture");
	assert.ok(leaseId);

	const transferred = await call(core, "session:parent", { type: "transfer", leaseId: leaseId!, toAgentId: "session:child" });
	assert.equal(transferred.ok, true);

	// The handover moved the authority, it did not copy it.
	const parentWrite = await call(core, "session:parent", { type: "acquire", resourceKey: "app:com.example.fixture" });
	assert.equal(parentWrite.ok, false);
	assert.equal((parentWrite as { code: string }).code, "resource_busy", "the child now holds the app");

	// The child writes on the epoch the parent was granted: the transfer is the same
	// authorization, so the parent's observation is what the child acts on.
	const childWrite = await call(core, "session:child", {
		type: "acquire",
		resourceKey: "app:com.example.fixture",
		baseEpoch: (acquired as { lease: { epoch: number } }).lease.epoch,
	});
	assert.equal(childWrite.ok, true);
});

test("a lease cannot be handed to an agent that is not the caller's descendant", async () => {
	const { core } = setup();
	await hello(core, registration("session:parent"));
	await hello(core, registration("session:child", { parentAgentId: "session:parent" }));
	await hello(core, registration("session:stranger"));
	await call(core, "session:parent", { type: "acquire", resourceKey: "app:com.example.fixture" });
	const leaseId = await leaseOf(core, "session:parent", "app:com.example.fixture");

	const refused = await call(core, "session:parent", { type: "transfer", leaseId: leaseId!, toAgentId: "session:stranger" });
	assert.equal(refused.ok, false);
	assert.equal((refused as { code: string }).code, "not_permitted");
	// A stranger cannot take a lease that is merely being handed to someone else either.
	const stolen = await call(core, "session:stranger", { type: "transfer", leaseId: leaseId!, toAgentId: "session:stranger" });
	assert.equal(stolen.ok, false);
});

test("when the subagent exits, the app returns to the parent instead of staying locked", async () => {
	const { core, events } = setup();
	await hello(core, registration("session:parent"));
	await hello(core, registration("session:child", { parentAgentId: "session:parent", hasUI: false }));
	await call(core, "session:parent", { type: "acquire", resourceKey: "app:com.example.fixture" });
	const leaseId = await leaseOf(core, "session:parent", "app:com.example.fixture");
	await call(core, "session:parent", { type: "transfer", leaseId: leaseId!, toAgentId: "session:child" });

	core.handleDisconnect("session:child");

	assert.equal(await leaseOf(core, "session:parent", "app:com.example.fixture"), leaseId, "the lease must be back with the parent");
	assert.ok(
		events.some((entry) => entry.event.event === "revoked" && entry.agentId === "session:child" && (entry.event as { reason: string }).reason === "transferred"),
		"the handover back is reported as a transfer, not a lost lease",
	);

	// And the parent can act immediately instead of waiting for a TTL.
	const write = await call(core, "session:parent", { type: "acquire", resourceKey: "app:com.example.fixture" });
	assert.equal(write.ok, true);
});

test("a child whose parent is already gone loses its leases instead of leaking them", async () => {
	const { core, events } = setup();
	await hello(core, registration("session:parent"));
	await hello(core, registration("session:child", { parentAgentId: "session:parent", hasUI: false }));
	await call(core, "session:parent", { type: "acquire", resourceKey: "app:com.example.fixture" });
	const leaseId = await leaseOf(core, "session:parent", "app:com.example.fixture");
	await call(core, "session:parent", { type: "transfer", leaseId: leaseId!, toAgentId: "session:child" });

	core.handleDisconnect("session:parent");
	core.handleDisconnect("session:child");

	const reply = await call(core, "session:child", { type: "status" });
	const status = (reply as { status: { agents: Array<{ agentId: string; leases: unknown[] }> } }).status;
	assert.equal(status.agents.find((agent) => agent.agentId === "session:child"), undefined);
	assert.ok(
		events.some((entry) => entry.event.event === "revoked" && entry.agentId === "session:child" && (entry.event as { reason: string }).reason === "owner_disconnected"),
	);
});
