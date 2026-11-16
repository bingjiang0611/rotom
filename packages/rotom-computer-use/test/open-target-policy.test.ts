import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BrokerClient } from "../src/broker/client.ts";
import { ClientLeaseBroker } from "../src/broker/lease-broker.ts";
import type { ActionIntent } from "../src/broker/protocol.ts";
import { startBrokerServer } from "../src/broker/server.ts";
import { isExternalOpen } from "../src/open-target.ts";
import { platformBackendForRuntime } from "../src/platform/index.ts";
import { macosBackend } from "../src/platform/macos/backend.ts";
import { createPolicyGate } from "../src/policy/gate.ts";
import { PolicyStore } from "../src/policy/policy-store.ts";
import { LeaseUnavailableError, ResourceScheduler } from "../src/runtime.ts";

test("open-target metadata still distinguishes directories from external or unknown targets", () => {
	for (const name of ["open", "press+open"]) {
		assert.equal(isExternalOpen({ name, openTarget: "directory" }), false);
		for (const openTarget of ["file", "package", "unknown", undefined] as const) {
			assert.equal(isExternalOpen({ name, openTarget }), true);
		}
	}
	assert.equal(isExternalOpen({ name: "click" }), false);
	assert.equal(platformBackendForRuntime("darwin").inspectOpenTarget, macosBackend.inspectOpenTarget);
	assert.equal(typeof macosBackend.inspectOpenTarget, "function");
});

for (const sensitive of [true, false]) test(`real broker and scheduler: all opens dispatch without authorization (legacy sensitive=${sensitive})`, async () => {
	const root = mkdtempSync(path.join(tmpdir(), "cu-open-policy-"));
	const globalPath = path.join(root, "policy.json");
	const initialPolicy = { v: 1, sensitive, apps: {} };
	writeFileSync(globalPath, JSON.stringify(initialPolicy), { mode: 0o600 });
	const policy = new PolicyStore({ globalPath, projectPath: path.join(root, "none.json") });
	const server = await startBrokerServer({ socketPath: path.join(root, "broker.sock"), policy: createPolicyGate({ store: policy }) });
	let client: BrokerClient | undefined;
	try {
		client = await BrokerClient.connect({ socketPath: server.socketPath,
			agent: { agentId: "session:open-test", hasUI: false, pid: process.pid, pidChain: [] },
			onApproval: async () => { assert.fail("no user authorization may be requested"); },
		});
		const scheduler = new ResourceScheduler(new ClientLeaseBroker(client));
		const resource = "desktop-pid:900";
		const app = { appName: "Finder", bundleId: "com.apple.finder" };
		let dispatches = 0;
		const write = (action: ActionIntent) => scheduler.write(resource, scheduler.epoch(resource), async () => { dispatches += 1; }, { app, action });
		for (const openTarget of ["directory", "file", "package", "unknown", undefined] as const) {
			await write({ name: "open", openTarget });
			await write({ name: "press+open", openTarget, label: "Delete then open" });
		}
		assert.equal(dispatches, 10, "the actual scheduler callback runs for every open, including batched external opens");
		assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), initialPolicy, "no fabricated user grant is persisted");

		policy.allowApp(app, "view");
		await assert.rejects(write({ name: "open", openTarget: "file" }), (error: unknown) => error instanceof LeaseUnavailableError && error.code === "denied");
		assert.equal(dispatches, 10, "explicit tier restriction still prevents dispatch");
		writeFileSync(globalPath, JSON.stringify({ v: 1, apps: { [app.bundleId]: "deny" } }));
		policy.invalidate();
		await assert.rejects(write({ name: "press+open", openTarget: "file" }), (error: unknown) => error instanceof LeaseUnavailableError && error.code === "denied");
		assert.equal(dispatches, 10, "explicit deny still prevents every step of a batch");
	} finally {
		await client?.close();
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
});
