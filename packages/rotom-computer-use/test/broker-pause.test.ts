/**
 * Interfering with the user pauses the agent (PLAN §6 / F3, review item A3).
 *
 * Before this, `interferedWithUser` was only a flag in one action's result: the
 * agent could keep acting on a screen the user had just taken back. The broker now
 * owns the pause, so every write path sees it, and only the helper connection can
 * lift it.
 */
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

test("interference pauses the agent: writes are refused, reads and other agents are unaffected", async () => {
	const { core, events } = setup();
	await hello(core, registration("agent-a"));
	await hello(core, registration("agent-b"));

	const held = await call(core, "agent-a", { type: "acquire", resourceKey: "app:com.example.fixture" });
	assert.equal(held.ok, true);

	const reported = await call(core, "agent-a", { type: "interference", evidence: "frontmost_changed_with_user_input" });
	assert.equal(reported.ok, true);
	assert.equal((reported as { paused: boolean }).paused, true);

	// The pause is a write refusal with its own code, not a generic failure.
	const refused = await call(core, "agent-a", { type: "acquire", resourceKey: "app:com.example.fixture" });
	assert.equal(refused.ok, false);
	assert.equal((refused as { code: string }).code, "paused_interfered");
	assert.match((refused as { message: string }).message, /paused/);

	// Reads keep working, so the paused agent can still explain what happened.
	const epoch = await call(core, "agent-a", { type: "epoch", resourceKey: "app:com.example.fixture" });
	assert.equal(epoch.ok, true);
	const status = await call(core, "agent-a", { type: "status" });
	assert.equal(status.ok, true);
	const agents = (status as { status: { agents: Array<{ agentId: string; paused?: { reason: string } }> } }).status.agents;
	assert.equal(agents.find((entry) => entry.agentId === "agent-a")?.paused?.reason, "interfered_with_user");
	assert.equal(agents.find((entry) => entry.agentId === "agent-b")?.paused, undefined, "only the reporting agent is paused");

	// The paused agent's leases are revoked with a reason the trace can report, and
	// the app is free for everyone else.
	const revoked = events.find((entry) => entry.event.event === "revoked" && entry.agentId === "agent-a");
	assert.ok(revoked, "the pause must revoke the agent's leases");
	assert.equal((revoked!.event as { reason: string }).reason, "paused_interfered");
	assert.ok(events.some((entry) => entry.event.event === "paused" && entry.agentId === "agent-a"));
	const peer = await call(core, "agent-b", { type: "acquire", resourceKey: "app:com.example.fixture" });
	assert.equal(peer.ok, true, "a paused agent must not hold the app hostage");
});

test("only the helper connection may resume a paused agent", async () => {
	const { core } = setup();
	await hello(core, registration("agent-a"));
	await hello(core, registration("helper-1", { role: "helper" }));
	await call(core, "agent-a", { type: "interference" });

	// The agent cannot lift its own pause.
	const selfResume = await call(core, "agent-a", { type: "resume", targetAgentId: "agent-a" });
	assert.equal(selfResume.ok, false);
	assert.equal((selfResume as { code: string }).code, "not_permitted");
	const afterRefusal = await call(core, "agent-a", { type: "acquire", resourceKey: "app:com.example.fixture" });
	assert.equal((afterRefusal as { code?: string }).code, "paused_interfered", "a refused resume must not lift the pause");

	const resumed = await call(core, "helper-1", { type: "resume", targetAgentId: "agent-a" });
	assert.equal(resumed.ok, true);
	assert.deepEqual((resumed as { resumed: string[] }).resumed, ["agent-a"]);

	const written = await call(core, "agent-a", { type: "acquire", resourceKey: "app:com.example.fixture" });
	assert.equal(written.ok, true, "after the user resumes it, the agent may write again");
});

test("a peer agent cannot resume another agent", async () => {
	const { core } = setup();
	await hello(core, registration("agent-a"));
	await hello(core, registration("agent-b"));
	await call(core, "agent-a", { type: "interference" });
	const refused = await call(core, "agent-b", { type: "resume", targetAgentId: "agent-a" });
	assert.equal(refused.ok, false);
	assert.equal((refused as { code: string }).code, "not_permitted");
});
