import assert from "node:assert/strict";
import { TakeoverLifecycle } from "../../src/broker/takeover-lifecycle.ts";

/** Exercise the actual broker state machine, without a helper or desktop. */
export function checkTakeoverLifecycle() {
	const now = 1_800_000_000_000;
	let holder = { agentId: "a", leaseId: "lease" };
	const events = [];
	const lifecycle = new TakeoverLifecycle({ now: () => now, holder: () => holder, granted: () => true,
		end: () => { holder = undefined; }, emit: (_agent, state) => events.push(state) });
	const send = (phase) => lifecycle.handle({ id: phase, type: "takeover_state", takeoverId: "one", targetAgentId: "a", leaseId: "lease", phase,
		sequence: 1, app: { bundleId: "fixture" }, targetValid: true,
		activity: { observedAt: now, listening: true, listeningSeconds: 60, lastUserInputAt: now - 30_000, idleSeconds: 30 } });
	assert.equal(send("begin").ok, true);
	assert.equal(send("pause").ok, true);
	assert.equal(lifecycle.pausedAgent, "a");
	assert.ok(holder);
	assert.equal(send("resumed").ok, false);
	assert.equal(send("prepare_resume").allowed, true);
	assert.equal(send("commit_resume").allowed, true);
	assert.equal(send("resumed").allowed, true);
	assert.equal(send("end").ok, true);
	assert.equal(send("resumed").ok, false);
	assert.equal(holder, undefined);
	assert.deepEqual(events, ["paused", "resumed", "ended"]);
	return "30s quiet admission; retained lease; no unchecked resume; terminal stop";

}
