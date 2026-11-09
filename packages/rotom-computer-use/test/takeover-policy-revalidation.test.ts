import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrokerCore } from "../src/broker/core.ts";
import { BROKER_PROTOCOL_VERSION, TAKEOVER_RESOURCE, type BrokerEvent } from "../src/broker/protocol.ts";
import { createPolicyGate } from "../src/policy/gate.ts";

for (const change of ["global withdrawal", "project denial", "unreadable policy"]) {
	test(`a paused takeover cannot resume after ${change}, even with a cached grant`, async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "cu-takeover-policy-"));
		const globalPath = path.join(root, "global.json");
		const project = path.join(root, "project");
		mkdirSync(path.join(project, ".pi"), { recursive: true });
		writeFileSync(globalPath, JSON.stringify({ apps: { fixture: { tier: "full", foreground: true } } }));
		const now = 1_800_000_000_000;
		const core = new BrokerCore({ now: () => now, policy: createPolicyGate({ globalPath }) });
		const events: BrokerEvent[] = [];
		core.attachTransport({ send: (_agent, event) => { events.push(event); return true; }, connectedAgents: () => 2 });
		try {
			for (const [agentId, role] of [["a", "agent"], ["h", "helper"]] as const) await core.handle(undefined, { id: agentId, type: "hello", protocolVersion: BROKER_PROTOCOL_VERSION, agent: { agentId, role, pid: 1, pidChain: [], hasUI: true, cwd: project } });
			await core.handle("h", { id: "activity", type: "ping", lastUserInputAt: now - 60_000 });
			const acquired = await core.handle("a", { id: "acquire", type: "acquire", resourceKey: TAKEOVER_RESOURCE, app: { bundleId: "fixture" }, action: { name: "takeover" } });
			assert.ok(acquired.ok && acquired.type === "acquire");
			const state = { id: "state", type: "takeover_state", takeoverId: "one", targetAgentId: "a", leaseId: acquired.lease.leaseId, sequence: 1, app: { bundleId: "fixture" } } as const;
			assert.equal((await core.handle("h", { ...state, phase: "begin" })).ok, true);
			assert.equal((await core.handle("h", { ...state, phase: "pause" })).ok, true);
			assert.equal(core.status().takeover?.paused, true);
			if (change === "global withdrawal") writeFileSync(globalPath, JSON.stringify({ apps: { fixture: { tier: "full", foreground: false } } }));
			if (change === "project denial") writeFileSync(path.join(project, ".pi", "computer-use.json"), JSON.stringify({ apps: { fixture: "deny" } }));
			if (change === "unreadable policy") writeFileSync(globalPath, "not valid JSON");
			const resumed = await core.handle("h", { ...state, phase: "prepare_resume", targetValid: true, activity: { observedAt: now, listening: true, listeningSeconds: 60, lastUserInputAt: now - 60_000, idleSeconds: 60 } });
			assert.equal(resumed.ok, false);
			assert.equal(core.status().takeover, undefined);
			assert.ok(events.some((event) => event.event === "takeover_state" && event.state === "ended" && event.reason === "authorization_lost"));
			assert.equal(events.some((event) => event.event === "takeover_state" && event.state === "resumed"), false);
		} finally {
			core.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
}
