import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BrokerCore } from "../src/broker/core.ts";
import { BROKER_PROTOCOL_VERSION, type BrokerEvent } from "../src/broker/protocol.ts";
import { createPolicyGate } from "../src/policy/gate.ts";
import { PolicyStore } from "../src/policy/policy-store.ts";

for (const isChild of [false, true]) {
	test(`ordinary App access needs no authorization for a headless ${isChild ? "child" : "root"} session`, async () => {
		const root = mkdtempSync(path.join(tmpdir(), "rotom-cu-default-access-"));
		const globalPath = path.join(root, "home", "policy.json");
		const store = new PolicyStore({ globalPath, projectPath: path.join(root, "project.json") });
		const events: BrokerEvent[] = [];
		const core = new BrokerCore({ policy: createPolicyGate({ store }) });
		core.attachTransport({
			send(_agentId, event) { events.push(event); return true; },
			connectedAgents: () => core.registry.connectedAgents().length,
		});
		try {
			for (const agentId of isChild ? ["root", "child"] : ["root"]) {
				const reply = await core.handle(undefined, {
					id: `hello-${agentId}`, type: "hello", protocolVersion: BROKER_PROTOCOL_VERSION,
					agent: { agentId, hasUI: false, pid: 4242, pidChain: [], ...(agentId === "child" ? { parentAgentId: "root" } : {}) },
				});
				assert.equal(reply.ok, true);
			}
			const reply = await core.handle(isChild ? "child" : "root", {
				id: "press-preview", type: "acquire", resourceKey: "desktop-pid:900",
				app: { appName: "Preview", bundleId: "com.apple.Preview" },
				action: { name: "press", label: "example.png" },
			});
			assert.equal(reply.ok, true, JSON.stringify(reply));
			assert.equal(core.leases.all().length, 1, "the broker grants a real lease, not just an approval-shaped success");
			assert.equal(events.filter(event => event.event === "approval").length, 0);
			assert.equal(existsSync(globalPath), false, "default access does not persist a fabricated user grant");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
