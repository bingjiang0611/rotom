import assert from "node:assert/strict";
import test from "node:test";
import { TakeoverLifecycle, TAKEOVER_MAX_DURATION_MS, TAKEOVER_MAX_RESUMES, TAKEOVER_PAUSE_TIMEOUT_MS } from "../src/broker/takeover-lifecycle.ts";
import { BrokerCore } from "../src/broker/core.ts";
import { BROKER_PROTOCOL_VERSION, type TakeoverStateRequest } from "../src/broker/protocol.ts";

function fixture() {
	let now = 1_800_000_000_000;
	let holder: { agentId: string; leaseId: string } | undefined = { agentId: "a", leaseId: "lease" };
	let granted = true;
	const events: Array<{ state: string; reason: string }> = [];
	const machine = new TakeoverLifecycle({ now: () => now, holder: () => holder, granted: () => granted,
		end: () => { holder = undefined; }, emit: (_agent, state, reason) => { events.push({ state, reason }); } });
	const request = (phase: TakeoverStateRequest["phase"], extra: Partial<TakeoverStateRequest> = {}) => machine.handle({
		id: "request", type: "takeover_state", takeoverId: "one", targetAgentId: "a", leaseId: "lease", phase,
		sequence: 1, app: { bundleId: "fixture" }, targetValid: true,
		activity: { observedAt: now, listening: true, listeningSeconds: 60, lastUserInputAt: now - 30_000, idleSeconds: 30 }, ...extra,
	});
	assert.equal(request("begin").ok, true);
	return { machine, request, events, holder: () => holder, grant: (value: boolean) => { granted = value; }, advance: (ms: number) => { now += ms; }, loseLease: () => { holder = undefined; }, now: () => now };
}

test("pause retains authorization and lease; resume needs a fresh helper prepare and acknowledgment", () => {
	const f = fixture();
	assert.equal(f.request("pause").ok, true);
	assert.equal(f.machine.pausedAgent, "a");
	assert.equal(f.holder()?.leaseId, "lease");
	assert.equal(f.request("resumed").ok, false, "no unchecked resume");
	assert.deepEqual(f.request("prepare_resume"), { ok: true, type: "takeover_state", allowed: true });
	assert.equal(f.machine.pausedAgent, "a", "prepare does not claim successful resume");
	assert.deepEqual(f.request("commit_resume"), { ok: true, type: "takeover_state", allowed: true });
	assert.equal(f.machine.pausedAgent, "a", "commit still waits for native activation confirmation");
	assert.deepEqual(f.request("resumed"), { ok: true, type: "takeover_state", allowed: true });
	assert.equal(f.machine.pausedAgent, undefined);
	assert.deepEqual(f.events, [{ state: "paused", reason: "user_input_pause" }, { state: "resumed", reason: "auto_resume" }]);
});

test("quiet under 30 seconds, interrupted monitoring and stale snapshots never admit resume", () => {
	const f = fixture(); f.request("pause");
	for (const activity of [
		{ observedAt: f.now(), listening: true, listeningSeconds: 60, lastUserInputAt: f.now() - 29_000, idleSeconds: 29 },
		{ observedAt: f.now(), listening: false, listeningSeconds: 60, lastUserInputAt: 0, idleSeconds: -1 },
		{ observedAt: f.now(), listening: true, listeningSeconds: 29, lastUserInputAt: 0, idleSeconds: -1 },
		{ observedAt: f.now() - 2_001, listening: true, listeningSeconds: 60, lastUserInputAt: 0, idleSeconds: -1 },
	]) assert.deepEqual(f.request("prepare_resume", { activity }), { ok: true, type: "takeover_state", allowed: false });
	assert.equal(f.machine.pausedAgent, "a");
});

test("new input invalidates a pending resume; old generations cannot restart it", () => {
	const f = fixture(); f.request("pause"); f.request("prepare_resume");
	f.request("pause", { sequence: 2 });
	assert.equal(f.request("resumed").ok, false);
	assert.equal(f.request("prepare_resume", { takeoverId: "old" }).ok, false);
	assert.deepEqual(f.request("prepare_resume", { sequence: 3 }), { ok: true, type: "takeover_state", allowed: true });
	assert.equal(f.request("resumed", { sequence: 2 }).ok, false);
});

test("grant loss, lease loss and missing original target are terminal", () => {
	for (const loss of ["grant", "lease", "target"]) {
		const f = fixture(); f.request("pause");
		if (loss === "grant") f.grant(false);
		if (loss === "lease") f.loseLease();
		f.request("prepare_resume", { targetValid: loss !== "target" });
		assert.equal(f.holder(), undefined);
		assert.equal(f.events.at(-1)?.state, "ended");
		assert.equal(f.request("resumed").ok, false);
	}
});

test("pause timeout, total budget and resume count hard-end without new authorization", () => {
	for (const budget of ["pause", "duration", "count"]) {
		const f = fixture(); f.request("pause");
		if (budget === "pause") f.advance(TAKEOVER_PAUSE_TIMEOUT_MS);
		if (budget === "duration") f.advance(TAKEOVER_MAX_DURATION_MS);
		if (budget === "count") {
			for (let count = 1; count <= TAKEOVER_MAX_RESUMES; count++) {
				f.request("prepare_resume", { sequence: count }); f.request("commit_resume", { sequence: count }); f.request("resumed", { sequence: count });
				f.request("pause", { sequence: count + 1 });
			}
		}
		f.request("prepare_resume", { sequence: 4 });
		assert.equal(f.holder(), undefined);
		assert.equal(f.events.at(-1)?.state, "ended");
	}
});

test("explicit stop, release and helper disconnect cannot be undone by a late resume", () => {
	for (const reason of ["released_by_user", "stopped_by_user", "helper_disconnected"]) {
		const f = fixture(); f.request("pause"); f.request("prepare_resume");
		if (reason === "helper_disconnected") f.machine.helperDisconnected();
		else f.machine.revoked(["lease"], reason);
		assert.equal(f.request("resumed").ok, false);
		assert.equal(f.events.at(-1)?.state, "ended");
	}
});

test("agent role cannot forge pause, quiet observations, resume or end", async () => {
	const core = new BrokerCore();
	await core.handle(undefined, { id: "hello", type: "hello", protocolVersion: BROKER_PROTOCOL_VERSION, agent: { agentId: "a", role: "agent", pid: 1, pidChain: [], hasUI: false } });
	for (const phase of ["begin", "pause", "prepare_resume", "commit_resume", "resumed", "end"] as const) {
		const reply = await core.handle("a", { id: phase, type: "takeover_state", takeoverId: "one", targetAgentId: "a", leaseId: "lease", phase });
		assert.equal(reply.ok, false);
		assert.equal((reply as { code: string }).code, "not_permitted");
	}
	core.close();
});
