import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BrokerClient } from "../src/broker/client.ts";
import { ClientLeaseBroker } from "../src/broker/lease-broker.ts";
import type { ActionIntent, ApprovalDecision, ApprovalRequestEvent } from "../src/broker/protocol.ts";
import { startBrokerServer } from "../src/broker/server.ts";
import { approvalCopy } from "../src/constants/copy.ts";
import { requiresOpenConfirmation } from "../src/open-target.ts";
import { platformBackendForRuntime } from "../src/platform/index.ts";
import { macosBackend } from "../src/platform/macos/backend.ts";
import { createPolicyGate } from "../src/policy/gate.ts";
import { PolicyStore } from "../src/policy/policy-store.ts";
import { LeaseUnavailableError, ResourceScheduler } from "../src/runtime.ts";

test("only positively classified non-package directories avoid external-open confirmation", () => {
	for (const name of ["open", "press+open"]) {
		assert.equal(requiresOpenConfirmation({ name, openTarget: "directory" }), false);
		for (const openTarget of ["file", "package", "unknown", undefined] as const) {
			assert.equal(requiresOpenConfirmation({ name, openTarget }), true);
		}
	}
	assert.equal(requiresOpenConfirmation({ name: "click" }), false);
	assert.equal(platformBackendForRuntime("darwin").inspectOpenTarget, macosBackend.inspectOpenTarget);
	assert.equal(typeof macosBackend.inspectOpenTarget, "function");
});

for (const standing of ["session", "always"] as const) test(`real broker transport and scheduler: ${standing} grants cannot bypass a denied external open; zero dispatches`, async () => {
	const root = mkdtempSync(path.join(tmpdir(), "cu-open-policy-"));
	const globalPath = path.join(root, "policy.json");
	// Disabling ordinary sensitive-label rules must not disable O1.
	const initialPolicy = { v: 1, sensitive: false, apps: standing === "always" ? { "com.apple.finder": "click" } : {} };
	writeFileSync(globalPath, JSON.stringify(initialPolicy), { mode: 0o600 });
	const policy = new PolicyStore({ globalPath, projectPath: path.join(root, "none.json") });
	const server = await startBrokerServer({ socketPath: path.join(root, "broker.sock"), policy: createPolicyGate({ store: policy }) });
	const cards: ApprovalRequestEvent[] = [];
	let decision: ApprovalDecision = "allow_session";
	let client: BrokerClient | undefined;
	try {
		client = await BrokerClient.connect({ socketPath: server.socketPath,
			agent: { agentId: "session:open-test", hasUI: true, pid: process.pid, pidChain: [] },
			onApproval: async (event) => { cards.push(event); return decision; },
		});
		const scheduler = new ResourceScheduler(new ClientLeaseBroker(client));
		const resource = "desktop-pid:900";
		let dispatches = 0;
		const write = (action: ActionIntent) => scheduler.write(resource, scheduler.epoch(resource), async () => { dispatches += 1; }, {
			app: { appName: "Finder", bundleId: "com.apple.finder" }, action,
		});
		await write({ name: "open", openTarget: "directory", label: "Downloads" });
		assert.equal(cards.length, standing === "session" ? 1 : 0);
		cards.length = 0;
		dispatches = 0;
		decision = "deny";
		await write({ name: "open", openTarget: "directory", label: "Downloads" });
		assert.equal(cards.length, 0, "folder navigation retains ordinary click-tier authorization");
		assert.equal(dispatches, 1);
		dispatches = 0;
		for (const openTarget of ["file", "package", "unknown", undefined] as const) {
			await assert.rejects(write({ name: "open", openTarget }), (error: unknown) => error instanceof LeaseUnavailableError && error.code === "approval_denied");
			assert.equal(dispatches, 0, "the scheduler callback must not run after denial");
		}
		await assert.rejects(write({ name: "press+open", openTarget: "file", label: "batch" }), (error: unknown) => error instanceof LeaseUnavailableError && error.code === "approval_denied");
		assert.equal(dispatches, 0, "a rejected batch cannot dispatch its prefix");
		assert.equal(cards.length, 5);
		for (const card of cards) assert.ok(card.warning?.includes(approvalCopy.externalOpenWarning));

		for (const choice of ["allow_once", "allow_session", "always"] as const) {
			decision = choice;
			await write({ name: "open", openTarget: "file" });
			const before: number = cards.length;
			const dispatched: number = dispatches;
			decision = "deny";
			await assert.rejects(write({ name: "open", openTarget: "file" }), (error: unknown) => error instanceof LeaseUnavailableError && error.code === "approval_denied");
			assert.equal(cards.length, before + 1, "even a standing-grant response must not authorize the next external open");
			assert.equal(dispatches, dispatched);
		}
		assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), initialPolicy);
	} finally {
		client?.close();
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
});
