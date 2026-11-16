import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BrokerCore } from "../src/broker/core.ts";
import { BROKER_PROTOCOL_VERSION, TAKEOVER_RESOURCE, type ActionIntent, type BrokerEvent } from "../src/broker/protocol.ts";
import { createPolicyGate } from "../src/policy/gate.ts";
import { PolicyStore } from "../src/policy/policy-store.ts";

const actions: ActionIntent[] = [
	{ name: "press", label: "Delete" },
	{ name: "press", label: "Send" },
	{ name: "press", label: "Pay" },
	{ name: "press", label: "Password" },
	{ name: "press", label: "Allow" },
	{ name: "manage_app", label: "force_quit" },
	{ name: "open", openTarget: "file" },
	{ name: "open", openTarget: "package" },
	{ name: "open", openTarget: "unknown" },
	{ name: "open" },
	{ name: "press+open", openTarget: "file" },
	{ name: "takeover" },
];

for (const action of actions) {
	test(`no user authorization for ${action.name}:${action.label ?? action.openTarget ?? "unspecified"}`, async () => {
		const root = mkdtempSync(path.join(tmpdir(), "rotom-cu-full-access-"));
		const globalPath = path.join(root, "policy.json");
		const policy = createPolicyGate({ store: new PolicyStore({ globalPath, projectPath: path.join(root, "project.json") }) });
		const core = new BrokerCore({ now: () => 100_000, policy });
		const events: BrokerEvent[] = [];
		core.attachTransport({ send(_agentId, event) { events.push(event); return true; }, connectedAgents: () => 2 });
		try {
			for (const [agentId, role] of [["agent", "agent"], ["helper", "helper"]] as const) {
				assert.equal((await core.handle(undefined, {
					id: agentId, type: "hello", protocolVersion: BROKER_PROTOCOL_VERSION,
					agent: { agentId, role, hasUI: false, pid: process.pid, pidChain: [] },
				})).ok, true);
			}
			// Takeover still needs real helper activity evidence, not user consent.
			assert.equal((await core.handle("helper", { id: "idle", type: "ping", lastUserInputAt: 80_000 })).ok, true);
			const reply = await core.handle("agent", {
				id: "write", type: "acquire", resourceKey: action.name === "takeover" ? TAKEOVER_RESOURCE : "desktop-pid:900",
				app: { appName: "Preview", bundleId: "com.apple.Preview" }, action,
			});
			assert.equal(reply.ok, true, JSON.stringify(reply));
			assert.equal(core.leases.all().length, 1);
			assert.equal(events.filter(event => event.event === "approval").length, 0);
			assert.equal(existsSync(globalPath), false, "automatic access never fabricates a persisted user grant");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
