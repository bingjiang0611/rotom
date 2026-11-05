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

test("lease expiry is milliseconds, the unit the helper compares against", async () => {
	// Real clock on purpose: the claim has to line up with the helper's `Date()`, and
	// a fake clock would hide a seconds/milliseconds mix-up (review E1).
	const core = new BrokerCore({ now: Date.now, leaseTtlMs: 60_000, heartbeatTimeoutMs: 600_000, leaseSecret: SECRET });
	core.attachTransport({ send: () => true, connectedAgents: () => 0 });
	await hello(core, registration("session:agent"));
	const acquired = await call(core, "session:agent", { type: "acquire", resourceKey: "desktop-pid:812" });
	assert.equal(acquired.ok, true);
	const lease = (acquired as { lease: { leaseId: string; token?: string; expiresAt: number } }).lease;

	const remaining = lease.expiresAt - Date.now();
	assert.ok(remaining > 55_000 && remaining <= 60_000, `expiry is ${remaining}ms away, not about one TTL`);

	// One millisecond before the claim the helper must accept it; at the claim it must not.
	assert.equal(verifyLeaseToken(SECRET, lease.token!, lease.expiresAt - 1).ok, true);
	assert.deepEqual(verifyLeaseToken(SECRET, lease.token!, lease.expiresAt), { ok: false, code: "lease_expired" });
});

test("lease ids are unique across broker processes, not a per-process counter", async () => {
	// Review E2: the helper keeps revocations by id, so a restarted broker that reused
	// `lease-1` would have its own leases refused as revoked.
	const first = setup();
	const second = setup();
	await hello(first.core, registration("session:agent"));
	await hello(second.core, registration("session:agent"));
	const leaseOf = async (core: BrokerCore) => {
		const reply = await call(core, "session:agent", { type: "acquire", resourceKey: "desktop-pid:812" });
		assert.equal(reply.ok, true);
		return (reply as { lease: { leaseId: string } }).lease.leaseId;
	};
	const left = await leaseOf(first.core);
	const right = await leaseOf(second.core);
	assert.match(left, /^lease-[0-9a-f]{8}-\d+$/);
	assert.match(right, /^lease-[0-9a-f]{8}-\d+$/);
	assert.notEqual(left, right, "two broker processes must not hand out the same id");
});

test("a handover revokes the old id with the moment it can be forgotten", async () => {
	const { core, clock } = setup();
	const delivered: Array<{ agentId: string; event: string; leaseIds?: string[]; expiresAt?: number }> = [];
	core.attachTransport({
		send(agentId, event) {
			delivered.push({
				agentId,
				event: event.event,
				...(event.event === "revoked" ? { leaseIds: event.leaseIds, expiresAt: event.expiresAt } : {}),
			});
			return true;
		},
		connectedAgents: () => core.registry.connectedAgents().length,
	});
	await hello(core, registration("helper:1", { role: "helper" }));
	await hello(core, registration("session:parent"));
	await hello(core, registration("session:child", { parentAgentId: "session:parent", hasUI: false }));
	const acquired = await call(core, "session:parent", { type: "acquire", resourceKey: "app:com.example.fixture" });
	const parentLease = (acquired as { lease: { leaseId: string; token?: string } }).lease;

	const transferred = await call(core, "session:parent", { type: "transfer", leaseId: parentLease.leaseId, toAgentId: "session:child" });
	assert.equal(transferred.ok, true);
	const childLease = (transferred as { lease: { leaseId: string; token?: string } }).lease;
	assert.notEqual(childLease.leaseId, parentLease.leaseId, "the receiver gets a new id");
	assert.notEqual(childLease.token, parentLease.token, "and a token for that id");

	const revocation = delivered.find((entry) => entry.agentId === "helper:1" && entry.event === "revoked");
	assert.deepEqual(revocation?.leaseIds, [parentLease.leaseId], "the old id is what gets revoked");
	assert.ok((revocation?.expiresAt ?? 0) > clock.now(), "the helper is told when it may forget the id");
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

test("only one helper may hold the signing key at a time", async () => {
	// Review E4: the helper role is self-declared, so the broker at least refuses a
	// second one instead of handing the key to every claimant.
	const { core } = setup();
	const first = await hello(core, registration("helper:1", { role: "helper" }));
	assert.ok((first as { leaseKey?: string }).leaseKey);

	const second = await hello(core, registration("helper:2", { role: "helper" }));
	assert.equal(second.ok, false);
	assert.equal((second as { code?: string }).code, "not_permitted");
	assert.equal((second as { leaseKey?: string }).leaseKey, undefined, "a refused helper never sees the key");

	// The same helper reconnecting is not a second helper.
	const again = await hello(core, registration("helper:1", { role: "helper" }));
	assert.equal(again.ok, true);

	// Once it is gone the slot is free again.
	core.handleDisconnect("helper:1");
	const replacement = await hello(core, registration("helper:2", { role: "helper" }));
	assert.equal(replacement.ok, true);
	assert.ok((replacement as { leaseKey?: string }).leaseKey);
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
