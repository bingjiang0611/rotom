/**
 * Foreground takeover (PLAN §7, L4) and `preempted_by_user`.
 *
 * The broker owns all three conditions and the preemption consequence; the client
 * half only acquires the lease and shows the border. These tests drive the broker
 * with a fake clock and a controllable user-activity value, plus the client with a
 * fake backend, so no desktop is touched.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BrokerCore, type PolicyGate } from "../src/broker/core.ts";
import { BROKER_PROTOCOL_VERSION, TAKEOVER_RESOURCE, type AgentRegistration, type BrokerReply, type BrokerRequestInput, type BrokerRequest } from "../src/broker/protocol.ts";
import { TakeoverController } from "../src/takeover.ts";
import type { BrokerSession } from "../src/tools/desktop-deps.ts";
import { createFakeClock } from "./helpers/fake-clock.ts";

const APP = { appName: "Fixture", bundleId: "com.example.fixture" };

/** Policy double: only the foreground grant matters here. */
function gateWithForeground(granted: boolean): PolicyGate {
	return {
		check: () => ({ tier: "full", requiresApproval: false, cacheKey: "fixture" }),
		allowApp: () => undefined,
		tierForApp: () => "full",
		foregroundGranted: () => granted,
		describe: () => ({ apps: {} }),
	};
}

function setup(options: { foreground?: boolean } = {}) {
	const clock = createFakeClock();
	const delivered: Array<{ agentId: string; event: string }> = [];
	const core = new BrokerCore({
		now: clock.now,
		schedule: clock.schedule,
		heartbeatTimeoutMs: 600_000,
		leaseTtlMs: 60_000,
		policy: gateWithForeground(options.foreground ?? true),
		leaseSecret: Buffer.alloc(32, 3),
	});
	core.attachTransport({
		send(agentId, event) {
			delivered.push({ agentId, event: event.event });
			return true;
		},
		connectedAgents: () => core.registry.connectedAgents().length,
	});
	return { clock, core, delivered };
}

let counter = 0;
async function hello(core: BrokerCore, agent: AgentRegistration): Promise<BrokerReply> {
	counter += 1;
	return await core.handle(undefined, { id: `hello-${counter}`, type: "hello", protocolVersion: BROKER_PROTOCOL_VERSION, agent });
}

async function call(core: BrokerCore, agentId: string | undefined, request: BrokerRequestInput): Promise<BrokerReply> {
	counter += 1;
	return await core.handle(agentId, { ...request, id: `${request.type}-${counter}` } as BrokerRequest);
}

const HELPER: AgentRegistration = { agentId: "helper:1", hasUI: true, pid: 400, pidChain: [], role: "helper" };
const AGENT_A: AgentRegistration = { agentId: "session:a", hasUI: true, pid: 401, pidChain: [400] };
const AGENT_B: AgentRegistration = { agentId: "session:b", hasUI: true, pid: 402, pidChain: [400] };

/** The helper's event tap is the only source of user activity the broker accepts. */
async function reportActivity(core: BrokerCore, lastUserInputAt: number): Promise<void> {
	await call(core, HELPER.agentId, { type: "ping", lastUserInputAt });
}

async function takeover(core: BrokerCore, agentId: string): Promise<BrokerReply> {
	return await call(core, agentId, { type: "acquire", resourceKey: TAKEOVER_RESOURCE, app: APP, action: { name: "takeover" } });
}

test("a user-activity report in seconds is refused instead of making the user look idle", async () => {
	// Review E1: the helper used to send one value in seconds and the broker compared
	// it with milliseconds, so "the user just typed" could read as idle. Minutes-scale
	// numbers are the only thing the broker accepts now.
	// A real clock on purpose: a fake one starting near zero cannot tell seconds from
	// milliseconds, and that difference is the whole point.
	const core = new BrokerCore({ now: Date.now, heartbeatTimeoutMs: 600_000, leaseTtlMs: 60_000, policy: gateWithForeground(true), leaseSecret: Buffer.alloc(32, 3) });
	core.attachTransport({ send: () => true, connectedAgents: () => core.registry.connectedAgents().length });
	await hello(core, HELPER);
	await hello(core, AGENT_A);
	const inSeconds = await call(core, HELPER.agentId, { type: "ping", lastUserInputAt: Math.floor(Date.now() / 1000) });
	assert.equal(inSeconds.ok, false);
	assert.equal((inSeconds as { code?: string }).code, "invalid_request");

	const inMilliseconds = await call(core, HELPER.agentId, { type: "ping", lastUserInputAt: Date.now() });
	assert.equal(inMilliseconds.ok, true);
});

test("an app without a foreground grant is refused even when the user is idle", async () => {
	const { core } = setup({ foreground: false });
	await hello(core, HELPER);
	await hello(core, AGENT_A);
	await reportActivity(core, Date.now() - 60_000);
	const reply = await takeover(core, AGENT_A.agentId);
	assert.equal(reply.ok, false);
	assert.equal((reply as { code: string }).code, "takeover_conditions");
	assert.match((reply as { message: string }).message, /foreground/);
});

test("taking the foreground needs 10s without real user input", async () => {
	const { core, clock } = setup();
	await hello(core, HELPER);
	await hello(core, AGENT_A);

	await reportActivity(core, clock.now() - 2_000);
	const early = await takeover(core, AGENT_A.agentId);
	assert.equal(early.ok, false, "2s of idleness is not enough");
	assert.equal((early as { code: string }).code, "takeover_conditions");

	clock.advance(10_000);
	const late = await takeover(core, AGENT_A.agentId);
	assert.equal(late.ok, true, "12s of idleness must be enough");
	assert.equal((late as { lease: { resourceKey: string } }).lease.resourceKey, TAKEOVER_RESOURCE);
});

test("the user's own click allows a takeover without waiting for idleness", async () => {
	const { core, clock } = setup();
	await hello(core, HELPER);
	await hello(core, AGENT_A);
	await reportActivity(core, clock.now() - 1_000);
	assert.equal((await takeover(core, AGENT_A.agentId)).ok, false);

	const approved = await call(core, HELPER.agentId, { type: "takeover_approval" });
	assert.equal(approved.ok, true);
	const taken = await takeover(core, AGENT_A.agentId);
	assert.equal(taken.ok, true);

	// The consent is for the next takeover, not a standing grant.
	await call(core, AGENT_A.agentId, { type: "release", leaseId: (taken as { lease: { leaseId: string } }).lease.leaseId });
	clock.advance(61_000);
	await reportActivity(core, clock.now() - 1_000);
	const stale = await takeover(core, AGENT_A.agentId);
	assert.equal(stale.ok, false, "a click from more than a minute ago must not authorize a takeover");
});

test("only the helper may grant the foreground, and agents cannot fake user activity", async () => {
	const { core, clock } = setup();
	await hello(core, HELPER);
	await hello(core, AGENT_A);
	const approved = await call(core, AGENT_A.agentId, { type: "takeover_approval" });
	assert.equal(approved.ok, false);
	assert.equal((approved as { code: string }).code, "not_permitted");

	// An agent claiming the user is idle is ignored: only the helper's report counts.
	await call(core, AGENT_A.agentId, { type: "ping", lastUserInputAt: clock.now() - 300_000 });
	const reply = await takeover(core, AGENT_A.agentId);
	assert.equal(reply.ok, false);
	assert.equal((reply as { code: string }).code, "takeover_conditions");
});

test("two agents cannot both hold the foreground", async () => {
	const { core, clock } = setup();
	await hello(core, HELPER);
	await hello(core, AGENT_A);
	await hello(core, AGENT_B);
	await reportActivity(core, clock.now() - 30_000);

	assert.equal((await takeover(core, AGENT_A.agentId)).ok, true);
	const second = await takeover(core, AGENT_B.agentId);
	assert.equal(second.ok, false);
	assert.equal((second as { code: string }).code, "resource_busy");
	assert.equal((second as { holder: { agentId: string } }).holder.agentId, AGENT_A.agentId);
});

test("real input pauses without surrendering the lease, and paused renewal continues", async () => {
	const { core, clock, delivered } = setup();
	await hello(core, HELPER); await hello(core, AGENT_A); await hello(core, AGENT_B);
	await reportActivity(core, clock.now() - 30_000);
	const taken = await takeover(core, AGENT_A.agentId) as { ok: true; lease: { leaseId: string } };
	const lifecycle = (phase: Extract<BrokerRequest, { type: "takeover_state" }>["phase"]) => call(core, HELPER.agentId, { type: "takeover_state", takeoverId: "one", targetAgentId: AGENT_A.agentId, leaseId: taken.lease.leaseId, phase, app: APP, sequence: 1 });
	assert.equal((await lifecycle("begin")).ok, true);
	assert.equal((await lifecycle("pause")).ok, true);
	assert.ok(delivered.some((entry) => entry.event === "takeover_state"));
	assert.equal(core.leases.holder(TAKEOVER_RESOURCE)?.leaseId, taken.lease.leaseId);
	assert.equal((await call(core, AGENT_A.agentId, { type: "renew", leaseId: taken.lease.leaseId })).ok, true);
	assert.equal((await takeover(core, AGENT_A.agentId)).ok, false, "paused writes cannot reacquire");
	assert.equal((await takeover(core, AGENT_B.agentId)).ok, false, "another agent cannot take the retained lease");
	assert.equal((await call(core, AGENT_A.agentId, { type: "release", leaseId: taken.lease.leaseId })).ok, true);
	assert.equal(core.leases.holder(TAKEOVER_RESOURCE), undefined);
});

test("an agent cannot forge a helper pause or resume", async () => {
	const { core, clock } = setup();
	await hello(core, HELPER); await hello(core, AGENT_A);
	await reportActivity(core, clock.now() - 30_000);
	const taken = await takeover(core, AGENT_A.agentId) as { ok: true; lease: { leaseId: string } };
	const forged = await call(core, AGENT_A.agentId, { type: "takeover_state", phase: "pause", targetAgentId: AGENT_A.agentId, leaseId: taken.lease.leaseId, takeoverId: "one", sequence: 1 });
	assert.equal(forged.ok, false);
	assert.equal((forged as { code: string }).code, "not_permitted");
	assert.ok(core.leases.holder(TAKEOVER_RESOURCE));
});

/** Fake broker session: records calls, answers with a lease, never touches a socket. */
function fakeSession(options: { busy?: boolean; renewFails?: boolean } = {}) {
	const calls: string[] = [];
	let released = false;
	const client = {
		agentId: "session:a",
		async acquire(request: { resourceKey: string }) {
			calls.push(`acquire:${request.resourceKey}`);
			if (options.busy) {
				const { BrokerRequestError } = await import("../src/broker/client.ts");
				throw new BrokerRequestError("resource_busy", "Resource desktop-foreground is held by session:b.", {
					ok: false,
					code: "resource_busy",
					message: "busy",
					holder: { agentId: "session:b", remainingMs: 30_000, expiresAt: 0, leaseId: "lease-b" },
				});
			}
			return {
				ok: true,
				type: "acquire",
				tier: "full",
				lease: { leaseId: "lease-a", resourceKey: TAKEOVER_RESOURCE, agentId: "session:a", epoch: 1, expiresAt: Date.now() + 60_000, ttlMs: 60_000, token: "signed-lease-token" },
			};
		},
		async release(leaseId: string) {
			calls.push(`release:${leaseId}`);
			released = true;
		},
		async renew(leaseId: string) {
			calls.push(`renew:${leaseId}`);
			if (options.renewFails) throw new Error("not_holder");
			return { leaseId, resourceKey: TAKEOVER_RESOURCE, agentId: "session:a", epoch: 1, expiresAt: Date.now() + 60_000, ttlMs: 60_000 };
		},
		async status() {
			return { agents: [], resources: [], waiters: [] };
		},
	};
	const session = { broker: { releaseAll: async () => undefined }, client } as unknown as BrokerSession;
	return { session, calls, wasReleased: () => released };
}

function fakeBackend() {
	const shown: Array<{ pid: number; label: string; token?: string }> = [];
	let hidden = 0;
	return {
		shown,
		hiddenTimes: () => hidden,
		backend: {
			async takeoverBegin(input: { pid: number; label: string; lease?: { token: string } }) {
				shown.push({ pid: input.pid, label: input.label, ...(input.lease?.token ? { token: input.lease.token } : {}) });
			},
			async takeoverEnd() {
				hidden += 1;
			},
		},
	};
}

const APPS = [{ appName: "Fixture", bundleId: "com.example.fixture", pid: 812 }];

test("a headless session never takes the foreground and never calls the broker", async () => {
	const { session, calls } = fakeSession();
	const { backend, shown } = fakeBackend();
	const controller = new TakeoverController({ broker: () => session, backend: () => backend, listApps: async () => APPS, headless: () => true });
	const result = await controller.start(812);
	assert.equal(result.ok, false);
	assert.equal((result as { code: string }).code, "headless");
	assert.deepEqual(calls, [], "no lease was requested");
	assert.equal(shown.length, 0, "no border was shown");
});

test("the client shows the border, keeps the lease alive, and releases it", async () => {
	const { session, calls } = fakeSession();
	const { backend, shown, hiddenTimes } = fakeBackend();
	const controller = new TakeoverController({ broker: () => session, backend: () => backend, listApps: async () => APPS, headless: () => false, renewMs: 5 });
	const started = await controller.start(812);
	assert.equal(started.ok, true);
	assert.equal(shown.length, 1);
	assert.equal(shown[0].label, "Fixture");
	assert.ok(shown[0].token, "the border only appears with a broker-signed lease");

	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(calls.some((call) => call.startsWith("renew:lease-a")), "the lease is renewed while the border is up");
	assert.equal(controller.activeTakeover, true);

	const ended = await controller.end();
	assert.equal(ended.released, "lease-a");
	assert.ok(calls.includes("release:lease-a"));
	assert.equal(hiddenTimes(), 1);
	assert.equal(controller.activeTakeover, false);
});

test("a paused client retains and renews its lease but cannot dispatch until a helper resume event", async () => {
	const { session, calls } = fakeSession();
	const { backend } = fakeBackend();
	const controller = new TakeoverController({ broker: () => session, backend: () => backend, listApps: async () => APPS, headless: () => false, renewMs: 5 });
	await controller.start(812);
	controller.markPaused();
	assert.equal(controller.activeTakeover, false);
	assert.equal(controller.state?.leaseId, "lease-a");
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(calls.includes("renew:lease-a"));
	controller.markResumed();
	assert.equal(controller.activeTakeover, true);
	await controller.end();
	controller.markResumed();
	assert.equal(controller.activeTakeover, false, "late events cannot resurrect a released takeover");
});

test("a refused or unknown takeover never shows the border", async () => {
	const { session } = fakeSession({ busy: true });
	const { backend, shown } = fakeBackend();
	const controller = new TakeoverController({ broker: () => session, backend: () => backend, listApps: async () => APPS, headless: () => false });
	const busy = await controller.start(812);
	assert.equal(busy.ok, false);
	assert.equal((busy as { code: string }).code, "resource_busy");
	assert.equal((busy as { holder: { agentId: string } }).holder.agentId, "session:b");
	assert.equal(shown.length, 0);

	const unknown = await controller.start(4242);
	assert.equal((unknown as { code: string }).code, "unknown_app");
	assert.equal(shown.length, 0);
});

test("a failed renewal marks the takeover preempted instead of acting on a lost lease", async () => {
	const { session } = fakeSession({ renewFails: true });
	const { backend, hiddenTimes } = fakeBackend();
	const controller = new TakeoverController({ broker: () => session, backend: () => backend, listApps: async () => APPS, headless: () => false, renewMs: 5 });
	assert.equal((await controller.start(812)).ok, true);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(controller.activeTakeover, false);
	assert.equal(controller.preempted, true);
	await controller.end();
	assert.equal(hiddenTimes(), 0, "an ended controller cannot hide another border");
});
