import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BrokerCore } from "../src/broker/core.ts";
import { BROKER_PROTOCOL_VERSION, type AgentRegistration, type ApprovalRequestEvent, type BrokerEvent, type BrokerRequest, type BrokerReply } from "../src/broker/protocol.ts";
import { createPolicyGate } from "../src/policy/gate.ts";
import { PolicyStore } from "../src/policy/policy-store.ts";
import { createFakeClock } from "./helpers/fake-clock.ts";

function tempRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "rotom-cu-approval-"));
}

function setup(root: string) {
	const clock = createFakeClock();
	const events: Array<{ agentId: string; event: BrokerEvent }> = [];
	const policy = new PolicyStore({ globalPath: path.join(root, "home", "policy.json"), projectPath: path.join(root, "none.json") });
	const core = new BrokerCore({
		now: clock.now,
		schedule: clock.schedule,
		heartbeatTimeoutMs: 600_000,
		policy: createPolicyGate({ store: policy }),
	});
	core.attachTransport({
		send(agentId, event) {
			events.push({ agentId, event });
			return true;
		},
		connectedAgents: () => core.registry.connectedAgents().length,
	});
	return { clock, core, events, policy };
}

function registration(agentId: string, overrides: Partial<AgentRegistration> = {}): AgentRegistration {
	return { agentId, hasUI: true, pid: 4242, pidChain: [1000], ...overrides };
}

async function hello(core: BrokerCore, agent: AgentRegistration): Promise<void> {
	const reply = await core.handle(undefined, { id: `hello-${agent.agentId}`, type: "hello", protocolVersion: BROKER_PROTOCOL_VERSION, agent });
	assert.equal(reply.ok, true);
}

async function call(core: BrokerCore, agentId: string, request: Omit<BrokerRequest, "id">): Promise<BrokerReply> {
	return await core.handle(agentId, { ...request, id: `${request.type}-${Math.random()}` } as BrokerRequest);
}

function acquire(core: BrokerCore, agentId: string, extra: Record<string, unknown> = {}): Promise<BrokerReply> {
	return call(core, agentId, { type: "acquire", resourceKey: "desktop-pid:900", app: { appName: "TextEdit", bundleId: "com.apple.TextEdit" }, action: { name: "press" }, ...extra } as Omit<BrokerRequest, "id">);
}

test("a subagent's card goes to the nearest UI-capable ancestor, and that answer gates the write", async () => {
	const root = tempRoot();
	const { core, events } = setup(root);
	try {
		await hello(core, registration("session:root", { hasUI: true, pid: 10 }));
		await hello(core, registration("session:middle", { hasUI: false, parentAgentId: "session:root", pid: 11 }));
		await hello(core, registration("session:leaf", { hasUI: false, parentAgentId: "session:middle", pid: 12 }));

		const pending = acquire(core, "session:leaf");
		const approval = events.find((entry) => entry.event.event === "approval");
		assert.ok(approval, "an approval event was delivered");
		assert.equal(approval!.agentId, "session:root", "routed past the UI-less middle session");
		const event = approval!.event as ApprovalRequestEvent;
		assert.equal(event.agentId, "session:leaf");
		assert.equal(event.tier, "full");

		// Only an ancestor of the requester may answer.
		const stranger = await call(core, "session:middle", { type: "approval_response", requestId: event.requestId, decision: "allow_session" });
		assert.equal(stranger.ok, true, "the middle session is an ancestor");
		const reply = await pending;
		assert.equal(reply.ok, true);
		assert.equal((reply as { approved?: boolean }).approved, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("without a UI-capable ancestor the write is refused with approval_unavailable", async () => {
	const root = tempRoot();
	const { core, events } = setup(root);
	try {
		await hello(core, registration("session:headless", { hasUI: false, pid: 20 }));
		const reply = await acquire(core, "session:headless");
		assert.equal(reply.ok, false);
		assert.equal((reply as { code: string }).code, "approval_unavailable");
		assert.equal(events.filter((entry) => entry.event.event === "approval").length, 0);
		assert.equal(core.leases.all().length, 0, "no lease exists for a refused action");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a denial and a timeout both refuse the write, and nothing is dispatched", async () => {
	const root = tempRoot();
	const { core, events, clock } = setup(root);
	try {
		await hello(core, registration("session:ui", { hasUI: true, pid: 30 }));
		const pendingDeny = acquire(core, "session:ui");
		const denyEvent = events.find((entry) => entry.event.event === "approval")!.event as ApprovalRequestEvent;
		await call(core, "session:ui", { type: "approval_response", requestId: denyEvent.requestId, decision: "deny" });
		const denied = await pendingDeny;
		assert.equal(denied.ok, false);
		assert.equal((denied as { code: string }).code, "approval_denied");

		events.length = 0;
		const pendingTimeout = acquire(core, "session:ui");
		assert.equal(events.length, 1);
		clock.advance(120_000);
		const timedOut = await pendingTimeout;
		assert.equal(timedOut.ok, false);
		assert.equal((timedOut as { code: string }).code, "approval_denied");
		assert.match((timedOut as { message: string }).message, /timed out/);
		assert.equal(core.leases.all().length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("allow_session is cached per agent, always is persisted, and a sensitive label asks again", async () => {
	const root = tempRoot();
	const { core, events, policy } = setup(root);
	try {
		await hello(core, registration("session:ui", { hasUI: true, pid: 40 }));

		const first = acquire(core, "session:ui");
		const card = events.find((entry) => entry.event.event === "approval")!.event as ApprovalRequestEvent;
		await call(core, "session:ui", { type: "approval_response", requestId: card.requestId, decision: "allow_session" });
		assert.equal((await first).ok, true);

		// The second write needs no card.
		events.length = 0;
		const second = await acquire(core, "session:ui");
		assert.equal(second.ok, true);
		assert.equal(events.length, 0, "session approval is reused");

		// A sensitive label forces a fresh card even for an approved app.
		const sensitiveWrite = acquire(core, "session:ui", { action: { name: "press", label: "删除" } });
		const sensitiveCard = events.find((entry) => entry.event.event === "approval") as { event: ApprovalRequestEvent } | undefined;
		assert.ok(sensitiveCard, "sensitive actions ask again");
		await call(core, "session:ui", { type: "approval_response", requestId: sensitiveCard!.event.requestId, decision: "always" });
		assert.equal((await sensitiveWrite).ok, true);
		assert.equal(policy.lookup({ bundleId: "com.apple.TextEdit" }, "textedit"), "full", "'always' persists a standing grant");

		// Persisting through the broker policy op requires the effective tier to match.
		const mismatch = await call(core, "session:ui", { type: "policy", op: "allow_app", app: { bundleId: "com.apple.TextEdit" }, tier: "view" });
		assert.equal(mismatch.ok, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a view-tier app refuses text input before any card is shown", async () => {
	const root = tempRoot();
	const { core, events } = setup(root);
	try {
		await hello(core, registration("session:ui", { hasUI: true, pid: 50 }));
		const reply = await call(core, "session:ui", {
			type: "acquire",
			resourceKey: "desktop-pid:950",
			app: { appName: "Stocks", bundleId: "com.apple.Stocks" },
			action: { name: "typeText" },
		});
		assert.equal(reply.ok, false);
		assert.equal((reply as { code: string }).code, "denied");
		assert.equal(events.length, 0, "tier refusal never reaches the user as a card");
		assert.equal(core.leases.all().length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
