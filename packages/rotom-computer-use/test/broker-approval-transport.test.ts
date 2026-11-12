import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BrokerClient, BrokerRequestError } from "../src/broker/client.ts";
import { startBrokerServer } from "../src/broker/server.ts";
import { permissivePolicy } from "../src/broker/policy.ts";
import { BrokerCore } from "../src/broker/core.ts";
import { BROKER_PROTOCOL_VERSION, type ApprovalRequestEvent } from "../src/broker/protocol.ts";
import type { ApprovalDecision, ApprovalDiagnostic } from "../src/broker/protocol.ts";

const approvalPolicy = { ...permissivePolicy, check: () => ({ tier: "click" as const, requiresApproval: true, cacheKey: "fixture" }) };
const agent = (agentId: string, hasUI = true) => ({ agentId, hasUI, pid: process.pid, pidChain: [process.ppid] });

test("a child acquire survives 45 seconds while its parent handles approval, without resending", async (t) => {
	const root = mkdtempSync(path.join(tmpdir(), "cu-ap-"));
	const socketPath = path.join(root, "b.sock");
	const server = await startBrokerServer({ socketPath, policy: approvalPolicy, heartbeatTimeoutMs: 600_000, sweepIntervalMs: 600_000 });
	const received = Promise.withResolvers<void>();
	const choice = Promise.withResolvers<ApprovalDecision>();
	const acknowledged = Promise.withResolvers<void>();
	const diagnostics: ApprovalDiagnostic[] = [];
	let approvals = 0;
	const parent = await BrokerClient.connect({ socketPath, agent: agent("parent"), heartbeatMs: 0,
		onApproval: async () => { approvals++; received.resolve(); return choice.promise; },
		onApprovalDiagnostic: (entry) => { diagnostics.push(entry); acknowledged.resolve(); },
	});
	const child = await BrokerClient.connect({ socketPath, agent: { ...agent("child", false), parentAgentId: "parent" }, heartbeatMs: 0 });
	try {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
		let settled = false;
		const acquire = child.acquire({ resourceKey: "desktop-pid:1", baseEpoch: 0 }).then(
			(value) => { settled = true; return value; },
			(error: unknown) => { settled = true; return error; },
		);
		await received.promise;
		t.mock.timers.tick(60_000);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(settled, false, "approval is still valid after the old 45s client deadline");
		choice.resolve("allow_session");
		const result = await acquire;
		assert.ok(result && typeof result === "object" && "ok" in result && result.ok === true);
		await acknowledged.promise;
		assert.equal(approvals, 1);
		assert.equal(server.core.leases.all().length, 1);
		assert.deepEqual(diagnostics.map((entry) => entry.phase), ["response_ack"]);
	} finally {
		choice.resolve("deny");
		await child.close(); await parent.close(); await server.close();
		t.mock.timers.reset();
		rmSync(root, { recursive: true, force: true });
	}
});

test("an expired decision is refused even if its timeout callback has not run", async () => {
	let now = 1000;
	let approval: ApprovalRequestEvent | undefined;
	let persisted = 0;
	const core = new BrokerCore({ now: () => now, schedule: () => () => {},
		heartbeatTimeoutMs: 600_000, policy: { ...approvalPolicy, allowApp: () => { persisted++; } },
	});
	core.attachTransport({ send: (_agent, event) => { if (event.event === "approval") approval = event; return true; }, connectedAgents: () => 1 });
	try {
		await core.handle(undefined, { id: "hello", type: "hello", protocolVersion: BROKER_PROTOCOL_VERSION, agent: agent("client") });
		const pending = core.handle("client", { id: "acquire", type: "acquire", resourceKey: "desktop-pid:1", baseEpoch: 0 });
		assert.ok(approval);
		now = approval.deadline;
		const response = await core.handle("client", { id: "decision", type: "approval_response", requestId: approval.requestId, decision: "always" });
		assert.equal(response.ok, false);
		const denied = await pending;
		assert.ok(!denied.ok && denied.code === "approval_denied");
		assert.equal(persisted, 0);
		assert.equal(core.leases.all().length, 0);
	} finally { core.close(); }
});

test("broker exceptions preserve the request id and fail promptly, rather than timing out", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "cu-ap-"));
	const socketPath = path.join(root, "b.sock");
	const server = await startBrokerServer({ socketPath, policy: { ...permissivePolicy,
		check: () => { throw new Error("policy test failure"); },
	} });
	const client = await BrokerClient.connect({ socketPath, agent: agent("client"), heartbeatMs: 0 });
	try {
		await assert.rejects(client.acquire({ resourceKey: "desktop-pid:1", baseEpoch: 0 }),
			(error: unknown) => error instanceof BrokerRequestError && error.code === "invalid_request" && error.message === "policy test failure");
		assert.equal(server.core.leases.all().length, 0);
	} finally {
		await client.close(); await server.close(); rmSync(root, { recursive: true, force: true });
	}
});

test("disconnect cancels the approval signal and discards a late choice without sending it", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "cu-ap-"));
	const socketPath = path.join(root, "b.sock");
	const server = await startBrokerServer({ socketPath, policy: approvalPolicy });
	const received = Promise.withResolvers<AbortSignal>();
	const choice = Promise.withResolvers<ApprovalDecision>();
	const diagnostics: ApprovalDiagnostic[] = [];
	const client = await BrokerClient.connect({ socketPath, agent: agent("client"), heartbeatMs: 0,
		onApproval: async (_event, signal) => { received.resolve(signal); return choice.promise; },
		onApprovalDiagnostic: (entry) => diagnostics.push(entry),
	});
	try {
		const acquire = client.acquire({ resourceKey: "desktop-pid:1", baseEpoch: 0 }).catch((error: unknown) => error);
		const signal = await received.promise;
		await client.close();
		assert.equal(signal.aborted, true);
		choice.resolve("always");
		await acquire;
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(diagnostics, []);
		assert.equal(server.core.leases.all().length, 0);
	} finally {
		choice.resolve("deny"); await client.close(); await server.close();
		rmSync(root, { recursive: true, force: true });
	}
});
