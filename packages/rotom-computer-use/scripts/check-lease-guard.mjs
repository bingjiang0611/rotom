#!/usr/bin/env node
/**
 * Deterministic lease-enforcement check for the native helper (review I2 / A5, E1).
 *
 * Three things are proven here, none of which touches the desktop:
 *  1. `--lease-self-test` inside the helper: valid / wrong signature / expired /
 *     pid mismatch / revoked / seconds-valued expiry / no-broker-key.
 *  2. Interoperability: every token comes from a real `BrokerCore` — the same code
 *     the broker runs — and the Swift guard is handed only that token. Tests no
 *     longer build claims by hand, so a unit or claim-shape drift is caught here
 *     instead of at a real machine (review E1).
 *  3. The expiry case is signed with a broker clock one hour in the past: if the
 *     Swift side went back to comparing seconds, that token would look valid.
 *  4. Review E2: a handed-over lease (new id for the receiver, old id revoked), a
 *     restarted broker (new key) and the revoked set's own expiry are exercised with
 *     tokens the broker really issued, not hand-built claims.
 *
 * The binary is built into the product's cache directory rather than a temp path:
 * this machine's endpoint policy kills binaries executed from /tmp (SIGKILL, exit
 * 137), which would turn a real result into a confusing failure.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { BrokerCore } from "../src/broker/core.ts";
import { BROKER_PROTOCOL_VERSION } from "../src/broker/protocol.ts";

const cacheDir = path.join(homedir(), "Library", "Caches", "rotom-computer-use", "lease-self-test");
mkdirSync(cacheDir, { recursive: true });
const binary = path.join(cacheDir, "helper");

function run(args) {
	return spawnSync(binary, args, { encoding: "utf8" });
}

function fail(message) {
	console.error(`FAIL ${message}`);
	process.exitCode = 1;
}

const build = spawnSync(process.execPath, ["scripts/build-native.mjs", "--arch", process.arch, "--no-sign", "--output", binary], {
	encoding: "utf8",
	stdio: "inherit",
});
if (build.status !== 0) {
	console.error("helper build failed");
	process.exit(1);
}

const selfTest = run(["--lease-self-test"]);
process.stdout.write(selfTest.stdout ?? "");
if (selfTest.status !== 0) fail(`lease self-test exited ${selfTest.status}`);

const SECRET = Buffer.alloc(32, 11);
let sequence = 0;

/**
 * Ask a real broker for a lease and return the token it hands back.
 *
 * `clockOffsetMs` moves only the broker's clock, so an "expired" token is expired
 * by the guard's real clock without any test-side arithmetic on the claim.
 */
async function brokerLease({ resourceKey = "desktop-pid:812", clockOffsetMs = 0, ttlMs = 60_000, expectExpired = false, secret = SECRET, transferTo } = {}) {
	const core = new BrokerCore({
		now: () => Date.now() + clockOffsetMs,
		schedule: () => () => undefined,
		leaseTtlMs: ttlMs,
		heartbeatTimeoutMs: 10 * 60_000,
		leaseSecret: secret,
	});
	core.attachTransport({ send: () => true, connectedAgents: () => 0 });
	const hello = async (agent) => await core.handle(undefined, { id: `hello-${++sequence}`, type: "hello", protocolVersion: BROKER_PROTOCOL_VERSION, agent });
	const helper = await hello({ agentId: "helper:check", hasUI: true, pid: 4242, pidChain: [], role: "helper" });
	if (!helper.ok || !helper.leaseKey) throw new Error("the broker did not hand the helper a key");
	await hello({ agentId: "session:check", hasUI: true, pid: 4243, pidChain: [], role: "agent" });
	const acquired = await core.handle("session:check", { id: `acquire-${++sequence}`, type: "acquire", resourceKey });
	if (!acquired.ok) throw new Error(`the broker refused ${resourceKey}: ${acquired.code}`);
	const lease = acquired.lease;
	if (!lease.token) throw new Error("the broker returned a lease with no token");
	// Sanity check on the side that owns the clock: the claim must already be past
	// when this lease is meant to be expired, or the fixture proves nothing.
	if (expectExpired && lease.expiresAt > Date.now()) throw new Error("the expired fixture is not actually expired");
	return { keyBase64: helper.leaseKey, token: lease.token, leaseId: lease.leaseId, resourceKey, pid: leasePidFrom(resourceKey) };
}

/**
 * A parent hands its lease to a subagent.
 *
 * Returns the token the broker gave the receiver and the revocation the helper is
 * told about, so the guard can be checked on both sides of the same handover.
 */
async function brokerTransfer({ resourceKey = "desktop-pid:812" } = {}) {
	const core = new BrokerCore({
		now: Date.now,
		schedule: () => () => undefined,
		leaseTtlMs: 60_000,
		heartbeatTimeoutMs: 10 * 60_000,
		leaseSecret: SECRET,
	});
	const events = [];
	core.attachTransport({ send: (agentId, event) => events.push({ agentId, event }), connectedAgents: () => 0 });
	const register = async (agent) => {
		const reply = await core.handle(undefined, { id: `hello-${++sequence}`, type: "hello", protocolVersion: BROKER_PROTOCOL_VERSION, agent });
		if (!reply.ok) throw new Error(`hello refused: ${reply.code}`);
		return reply;
	};
	const helper = await register({ agentId: "helper:check", hasUI: true, pid: 4242, pidChain: [], role: "helper" });
	await register({ agentId: "session:parent", hasUI: true, pid: 4243, pidChain: [] });
	await register({ agentId: "session:child", hasUI: true, pid: 4244, pidChain: [], parentAgentId: "session:parent" });
	const acquired = await core.handle("session:parent", { id: `acquire-${++sequence}`, type: "acquire", resourceKey });
	if (!acquired.ok) throw new Error(`the parent could not acquire ${resourceKey}: ${acquired.code}`);
	const transferred = await core.handle("session:parent", { id: `transfer-${++sequence}`, type: "transfer", leaseId: acquired.lease.leaseId, toAgentId: "session:child" });
	if (!transferred.ok) throw new Error(`the transfer was refused: ${transferred.code}`);
	const revocation = events.find((entry) => entry.event.event === "revoked" && entry.event.reason === "transferred");
	if (!revocation) throw new Error("the broker did not revoke the handed-over lease");
	return {
		keyBase64: helper.leaseKey,
		oldToken: acquired.lease.token,
		oldLeaseId: acquired.lease.leaseId,
		newToken: transferred.lease.token,
		resourceKey,
		pid: leasePidFrom(resourceKey),
		revokedIds: revocation.event.leaseIds,
		revokedUntil: revocation.event.expiresAt,
	};
}

function leasePidFrom(resourceKey) {
	const match = /^desktop-pid:(\d+)$/.exec(resourceKey);
	return match ? Number.parseInt(match[1], 10) : undefined;
}

const valid = await brokerLease();
const expired = await brokerLease({ clockOffsetMs: -3_600_000, expectExpired: true });

const actRequest = (lease, pid) => ({
	cmd: "act",
	...(pid === undefined ? {} : { pid }),
	...(lease ? { lease: { token: lease.token, resourceKey: lease.resourceKey } } : {}),
});

const handed = await brokerTransfer();
const restarted = await brokerLease({ secret: Buffer.alloc(32, 12) });

const steps = [
	{ name: "broker_valid", key: valid.keyBase64, command: "act", request: actRequest(valid, valid.pid), expect: "accept" },
	{ name: "broker_expired", key: expired.keyBase64, command: "act", request: actRequest(expired, expired.pid), expect: "reject", code: "lease_expired" },
	{ name: "broker_wrong_pid", key: valid.keyBase64, command: "act", request: actRequest(valid, 999), expect: "reject", code: "lease_invalid" },
	{ name: "no_token", key: valid.keyBase64, command: "act", request: actRequest(undefined, valid.pid), expect: "reject", code: "lease_invalid" },
	// E2: the handover revokes the parent's id and the receiver's own id works.
	{ name: "transfer_old_id_revoked", key: handed.keyBase64, command: "act", request: actRequest({ token: handed.oldToken, resourceKey: handed.resourceKey }, handed.pid), expect: "reject", code: "lease_invalid", revoke: handed.revokedIds, revokeExpiresAt: handed.revokedUntil },
	{ name: "transfer_receiver_accepted", key: handed.keyBase64, command: "act", request: actRequest({ token: handed.newToken, resourceKey: handed.resourceKey }, handed.pid), expect: "accept", carry: true },
	// E2: a revocation past its lease expiry is forgotten, so the id is not blocked forever.
	{ name: "expired_revocation_forgotten", key: valid.keyBase64, command: "act", request: actRequest(valid, valid.pid), expect: "accept", revoke: [valid.leaseId], revokeExpiresAt: Date.now() - 1 },
	// E2: a restarted broker signs with a new key; its leases must work.
	{ name: "restart_new_key_accepted", key: restarted.keyBase64, command: "act", request: actRequest(restarted, restarted.pid), expect: "accept" },
	{ name: "restart_old_key_rejected", key: restarted.keyBase64, command: "act", request: actRequest(valid, valid.pid), expect: "reject", code: "lease_invalid" },
];

const fixture = run([`--lease-fixture=${JSON.stringify({ steps })}`]);
process.stdout.write(fixture.stdout ?? "");
if (fixture.status !== 0) fail("a broker-signed step did not behave as expected");

if (process.exitCode) {
	console.error("lease enforcement check failed");
} else {
	console.log(`lease enforcement ok (self-test + ${steps.length} broker-signed steps)`);
}
