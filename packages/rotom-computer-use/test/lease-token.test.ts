/**
 * Helper-side lease enforcement (review I2, review item A5).
 *
 * The broker is the arbiter, but the helper is what actually injects the event.
 * These tests cover the TS half: the token the broker issues, who may learn the
 * signing key, and the claims the native side compares against the command. The
 * Swift half (signature, expiry, pid, revocation) is covered by `self-test` in the
 * helper plus the deterministic fixtures described in STATUS-2.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BrokerCore } from "../src/broker/core.ts";
import { leasePidOf, signLeaseToken, verifyLeaseToken } from "../src/broker/lease-token.ts";
import { createFakeClock } from "./helpers/fake-clock.ts";
import { BROKER_PROTOCOL_VERSION, type AgentRegistration, type BrokerReply, type BrokerRequest } from "../src/broker/protocol.ts";

const SECRET = Buffer.alloc(32, 7);

function registration(agentId: string, overrides: Partial<AgentRegistration> = {}): AgentRegistration {
	return { agentId, hasUI: true, pid: 4242, pidChain: [1000], role: "agent", ...overrides };
}

function setup() {
	const clock = createFakeClock();
	const core = new BrokerCore({ now: clock.now, schedule: clock.schedule, heartbeatTimeoutMs: 600_000, leaseTtlMs: 60_000, leaseSecret: SECRET });
	core.attachTransport({ send: () => true, connectedAgents: () => core.registry.connectedAgents().length });
	return { clock, core };
}

let counter = 0;
async function hello(core: BrokerCore, agent: AgentRegistration): Promise<BrokerReply> {
	counter += 1;
	return await core.handle(undefined, { id: `hello-${counter}`, type: "hello", protocolVersion: BROKER_PROTOCOL_VERSION, agent });
}

async function call(core: BrokerCore, agentId: string, request: Omit<BrokerRequest, "id">): Promise<BrokerReply> {
	counter += 1;
	return await core.handle(agentId, { ...request, id: `${request.type}-${counter}` } as BrokerRequest);
}

test("a token is bound to its lease, resource, target pid and expiry", () => {
	const now = 1_000_000;
	const claims = { agentId: "session:a", resourceKey: "desktop-pid:812", pid: 812, leaseId: "lease-9", expiresAt: now + 60_000 };
	const token = signLeaseToken(SECRET, claims);
	assert.deepEqual(verifyLeaseToken(SECRET, token, now), { ok: true, claims });

	// Expiry is part of the claim, not a local guess.
	assert.deepEqual(verifyLeaseToken(SECRET, token, now + 60_001), { ok: false, code: "lease_expired" });
	// Another key cannot mint a valid token.
	assert.deepEqual(verifyLeaseToken(Buffer.alloc(32, 8), token, now), { ok: false, code: "lease_invalid" });
	// A tampered payload fails the signature.
	const [payload, mac] = token.split(".");
	const forgedPayload = Buffer.from(JSON.stringify({ ...claims, expiresAt: now + 999_999 }), "utf8").toString("base64url");
	assert.deepEqual(verifyLeaseToken(SECRET, `${forgedPayload}.${mac}`, now), { ok: false, code: "lease_invalid" });
	assert.deepEqual(verifyLeaseToken(SECRET, `${payload}.${"0".repeat(64)}`, now), { ok: false, code: "lease_invalid" });
	assert.deepEqual(verifyLeaseToken(SECRET, "not-a-token", now), { ok: false, code: "lease_invalid" });
});

test("only a desktop-pid resource names a target process", () => {
	assert.equal(leasePidOf("desktop-pid:812"), 812);
	assert.equal(leasePidOf("app:com.example.fixture"), undefined);
	assert.equal(leasePidOf("clipboard:system"), undefined);
	assert.equal(leasePidOf("desktop-pid:not-a-pid"), undefined);
});

test("the signing key goes to the helper connection only, never to an agent", async () => {
	const { core } = setup();
	const agent = await hello(core, registration("session:agent"));
	assert.equal((agent as { leaseKey?: string }).leaseKey, undefined, "an agent must not be able to forge lease tokens");

	const helper = await hello(core, registration("helper:1", { role: "helper" }));
	const key = (helper as { leaseKey?: string }).leaseKey;
	assert.ok(key, "the helper needs the key to verify tokens");
	assert.equal(Buffer.from(key!, "base64").length, 32);
});

test("an acquire reply carries a token the helper can verify for that pid", async () => {
	const { core, clock } = setup();
	await hello(core, registration("helper:1", { role: "helper" }));
	await hello(core, registration("session:agent"));
	const acquired = await call(core, "session:agent", { type: "acquire", resourceKey: "desktop-pid:812" });
	assert.equal(acquired.ok, true);
	const lease = (acquired as { lease: { leaseId: string; token?: string; expiresAt: number } }).lease;
	assert.ok(lease.token, "a broker lease must be provable to the helper");

	const verified = verifyLeaseToken(SECRET, lease.token!, clock.now());
	assert.equal(verified.ok, true);
	if (!verified.ok) return;
	assert.equal(verified.claims.agentId, "session:agent");
	assert.equal(verified.claims.resourceKey, "desktop-pid:812");
	assert.equal(verified.claims.pid, 812);
	assert.equal(verified.claims.leaseId, lease.leaseId);
});

test("a revoke reaches the helper connection too, so a stale token cannot outlive it", async () => {
	const { core } = setup();
	const delivered: Array<{ agentId: string; event: string; leaseIds?: string[] }> = [];
	core.attachTransport({
		send(agentId, event) {
			delivered.push({ agentId, event: event.event, ...(event.event === "revoked" ? { leaseIds: event.leaseIds } : {}) });
			return true;
		},
		connectedAgents: () => core.registry.connectedAgents().length,
	});
	await hello(core, registration("helper:1", { role: "helper" }));
	await hello(core, registration("session:agent"));
	const acquired = await call(core, "session:agent", { type: "acquire", resourceKey: "desktop-pid:812" });
	const leaseId = (acquired as { lease: { leaseId: string } }).lease.leaseId;

	await call(core, "helper:1", { type: "stop" });

	const toHelper = delivered.filter((entry) => entry.agentId === "helper:1" && entry.event === "revoked");
	assert.equal(toHelper.length, 1, "the helper must learn about revocations");
	assert.deepEqual(toHelper[0].leaseIds, [leaseId]);
});
