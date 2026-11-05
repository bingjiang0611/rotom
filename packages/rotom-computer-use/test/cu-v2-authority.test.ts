/**
 * Behaviour tests for the four v2 tool families (review R3).
 *
 * The previous version of this coverage matched source strings, which cannot fail
 * when the wiring is changed rather than the text. These tests drive the real
 * broker with the real policy gate: the tool constructs its intent through
 * `src/tools/intents.ts`, and the broker decides whether the write may run.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BrokerCore } from "../src/broker/core.ts";
import { BROKER_PROTOCOL_VERSION, type AgentRegistration, type ApprovalRequestEvent, type BrokerEvent, type BrokerReply, type BrokerRequest } from "../src/broker/protocol.ts";
import { createPolicyGate } from "../src/policy/gate.ts";
import { PolicyStore } from "../src/policy/policy-store.ts";
import { appIntent, clipboardIntent, windowIntent } from "../src/tools/intents.ts";
import { createFakeClock } from "./helpers/fake-clock.ts";

function setup() {
	const root = mkdtempSync(path.join(tmpdir(), "rotom-cu-authority-"));
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
	return {
		core,
		events,
		policy,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function registration(agentId: string, overrides: Partial<AgentRegistration> = {}): AgentRegistration {
	return { agentId, hasUI: true, pid: 4242, pidChain: [1000], ...overrides };
}

async function hello(core: BrokerCore, agent: AgentRegistration): Promise<void> {
	const reply = await core.handle(undefined, { id: `hello-${agent.agentId}`, type: "hello", protocolVersion: BROKER_PROTOCOL_VERSION, agent });
	assert.equal(reply.ok, true);
}

async function acquire(core: BrokerCore, agentId: string, intent: ReturnType<typeof appIntent>, baseEpoch = 0): Promise<BrokerReply> {
	// `wait: false` keeps a contended acquire an immediate structured refusal instead
	// of a FIFO queue: these tests assert the refusal, not the waiting.
	const request = { type: "acquire", resourceKey: intent.resourceKey, baseEpoch, wait: false, action: intent.action, ...(intent.app ? { app: intent.app } : {}) } as Omit<BrokerRequest, "id">;
	return await core.handle(agentId, { ...request, id: `acquire-${Math.random()}` } as BrokerRequest);
}

const DOC_APP = { appName: "TextEdit", bundleId: "com.apple.TextEdit" };

test("write intents name the exact resource the helper checks", () => {
	// The helper recomputes these keys itself (review E3), so both sides have to agree
	// on one format: `app:<bundleId>` when known, `app:<appName>` otherwise, and
	// `desktop-pid:<pid>` for process-keyed writes.
	assert.equal(appIntent("quit", { appName: "Fixture", bundleId: "com.example.fixture" }, 900).resourceKey, "app:com.example.fixture");
	assert.equal(appIntent("launch", { appName: "com.example.fixture", bundleId: "com.example.fixture" }, undefined).resourceKey, "app:com.example.fixture");
	assert.equal(appIntent("quit", { appName: "Fixture" }, 900).resourceKey, "app:Fixture");
	assert.equal(appIntent("quit", undefined, 900).resourceKey, "desktop-pid:900");
	assert.equal(windowIntent("resize", 900, 12, undefined).resourceKey, "desktop-pid:900");
	assert.equal(clipboardIntent("set").resourceKey, "clipboard:system");
});

test("manage_app quit is refused for an app the user set to view tier", async () => {
	const { core, policy, cleanup } = setup();
	try {
		// "view" is the tier a user picks when they want observation only.
		policy.allowApp(DOC_APP, "view");
		await hello(core, registration("session:main"));
		const reply = await acquire(core, "session:main", appIntent("quit", DOC_APP, 900));
		assert.equal(reply.ok, false, "quitting a view-tier app must be refused");
		const refusal = reply as { code?: string; message?: string };
		assert.equal(refusal.code, "denied");
		assert.match(refusal.message ?? "", /view/i);
	} finally {
		cleanup();
	}
});

test("an agent without a UI ancestor cannot read the clipboard", async () => {
	const { core, events, cleanup } = setup();
	try {
		// No parent session, no UI: there is nobody to show a card to.
		await hello(core, registration("session:headless", { hasUI: false }));
		const reply = await acquire(core, "session:headless", clipboardIntent("get"));
		assert.equal(reply.ok, false);
		assert.equal((reply as { code?: string }).code, "approval_unavailable");
		assert.equal(events.filter((entry) => entry.event.event === "approval").length, 0, "no card can be delivered, so none is queued");
	} finally {
		cleanup();
	}
});

test("manage_window resize on an app another agent holds is resource_busy", async () => {
	const { core, policy, cleanup } = setup();
	try {
		// Allowed up front, so the only reason for a refusal is the other agent.
		policy.allowApp(DOC_APP, "full");
		await hello(core, registration("session:alpha"));
		await hello(core, registration("session:beta"));
		const alphaIntent = windowIntent("resize", 900, 12, DOC_APP);
		const first = await acquire(core, "session:alpha", alphaIntent);
		assert.equal(first.ok, true, "alpha takes the app first");

		// beta observes after alpha's write, so its epoch is current and the refusal is
		// a holder conflict rather than a stale observation.
		const betaIntent = windowIntent("move", 900, 12, DOC_APP);
		const second = await acquire(core, "session:beta", betaIntent, 1);
		assert.equal(second.ok, false);
		const refusal = second as { code?: string; holder?: { agentId: string } };
		assert.equal(refusal.code, "resource_busy");
		assert.equal(refusal.holder?.agentId, "session:alpha");
	} finally {
		cleanup();
	}
});

test("an app the user already allowed can be written to without a UI", async () => {
	// The documented way to keep unattended runs working: grant the app in
	// `policy.json` first. Without a grant the same agent gets approval_unavailable.
	const { core, policy, cleanup } = setup();
	try {
		policy.allowApp(DOC_APP, "full");
		await hello(core, registration("session:headless", { hasUI: false }));
		const allowed = await acquire(core, "session:headless", windowIntent("resize", 900, 12, DOC_APP));
		assert.equal(allowed.ok, true, `a pre-authorized app must be writable headlessly: ${JSON.stringify(allowed)}`);

		const other = { appName: "Notes", bundleId: "com.apple.Notes" };
		const refused = await acquire(core, "session:headless", windowIntent("resize", 901, 13, other));
		assert.equal(refused.ok, false, "an app with no grant still needs a card");
		assert.equal((refused as { code?: string }).code, "approval_unavailable");
	} finally {
		cleanup();
	}
});

test("a forced quit asks even for an app the user already allowed", async () => {
	const { core, events, policy, cleanup } = setup();
	try {
		// "always" is the strongest grant there is; it must still not cover force quit.
		policy.allowApp(DOC_APP, "full");
		await hello(core, registration("session:main"));
		const pending = acquire(core, "session:main", appIntent("quit", DOC_APP, 900, true));
		// The request is handled asynchronously; let it reach the approval step before
		// looking for the card.
		await new Promise((resolve) => setImmediate(resolve));
		const approval = events.find((entry) => entry.event.event === "approval");
		assert.ok(approval, "a forced quit must raise a confirmation card");
		const event = approval!.event as ApprovalRequestEvent;
		assert.equal(event.tier, "full");

		await core.handle("session:main", { id: "approve", type: "approval_response", requestId: event.requestId, decision: "allow_session" } as BrokerRequest);
		const granted = await pending;
		assert.equal(granted.ok, true);
		// Release the lease, or the next quit on the same app is a holder conflict
		// rather than a policy question.
		const leaseId = (granted as { lease?: { leaseId: string } }).lease?.leaseId;
		assert.ok(leaseId, "the forced quit should have been granted a lease");
		await core.handle("session:main", { id: "release", type: "release", leaseId } as BrokerRequest);

		// The same app, quit without force, is covered by the grant: no second card.
		const cardsBefore = events.filter((entry) => entry.event.event === "approval").length;
		const plain = await acquire(core, "session:main", appIntent("quit", DOC_APP, 900), 1);
		assert.equal(plain.ok, true, `a plain quit of an allowed app should run: ${JSON.stringify(plain)}`);
		assert.equal(events.filter((entry) => entry.event.event === "approval").length, cardsBefore, "a normal quit of an allowed app needs no card");
	} finally {
		cleanup();
	}
});
