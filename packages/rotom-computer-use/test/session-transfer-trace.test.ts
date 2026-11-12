import assert from "node:assert/strict";
import { test } from "node:test";
import { BrokerRequestError } from "../src/broker/client.ts";
import { createCuSessionTool } from "../src/tools/session-admin.ts";
import type { DesktopToolDeps } from "../src/tools/desktop-deps.ts";

const held = [
	{ leaseId: "lease-old-1", resourceKey: "desktop-pid:700", agentId: "session:parent" },
	{ leaseId: "lease-old-2", resourceKey: "clipboard:system", agentId: "session:parent" },
];

function recorder() {
	const entries: Array<Record<string, unknown>> = [];
	return { entries, record: (entry: Record<string, unknown>) => entries.push(entry) };
}

function deps(options: { refuse?: { resourceKey: string; code: string }; trace?: ReturnType<typeof recorder> }) {
	const transferred: string[] = [];
	const deps = {
		scheduler: () => ({}) as never,
		trace: () => options.trace as never,
		takeover: () => undefined,
		collectWindows: () => [],
		formatWindowLine: () => "",
		broker: () => ({
			client: {
				agentId: "session:parent",
				status: async () => ({ agents: [{ agentId: "session:parent", leases: held }] }),
				transfer: async (leaseId: string, toAgentId: string) => {
					const lease = held.find((candidate) => candidate.leaseId === leaseId)!;
					if (options.refuse?.resourceKey === lease.resourceKey) {
						// The real error type, because the tool only reports known broker refusals.
						throw new BrokerRequestError(options.refuse.code as never, "resource busy", { code: options.refuse.code } as never);
					}
					transferred.push(`${leaseId}->${toAgentId}`);
					return { leaseId: `lease-new-${leaseId}`, resourceKey: lease.resourceKey, agentId: toAgentId };
				},
			},
			broker: { releaseAll: async () => undefined },
		}) as never,
	} satisfies DesktopToolDeps;
	return { deps, transferred, recorder: options.trace };
}

test("a handover is traceable: who moved which resource to whom", async () => {
	// Review Q2: without this line a user cannot answer "who moved my app".
	const trace = recorder();
	const { deps: tool, transferred } = deps({ trace });
	const run = createCuSessionTool(tool);
	const result = await run({ action: "transfer", toAgentId: "session:child" }, undefined);
	assert.equal((result.details as { status: string }).status, "ok");
	assert.deepEqual(transferred, ["lease-old-1->session:child", "lease-old-2->session:child"]);
	assert.equal(trace.entries.length, 2);
	assert.deepEqual(trace.entries[0], {
		tool: "cu_session",
		status: "ok",
		transfer: { action: "transfer", toAgentId: "session:child", resourceKey: "desktop-pid:700", oldLeaseId: "lease-old-1", newLeaseId: "lease-new-lease-old-1" },
	});
	assert.equal(trace.entries[1]?.transfer !== undefined, true);
});

test("transfer only records the resource the caller named", async () => {
	const trace = recorder();
	const { deps: tool } = deps({ trace });
	const run = createCuSessionTool(tool);
	await run({ action: "transfer", toAgentId: "session:child", resourceKey: "clipboard:system" }, undefined);
	assert.equal(trace.entries.length, 1);
	assert.equal((trace.entries[0]?.transfer as { resourceKey: string }).resourceKey, "clipboard:system");
});

test("a refused handover is recorded without a new lease id", async () => {
	const trace = recorder();
	const { deps: tool } = deps({ trace, refuse: { resourceKey: "desktop-pid:700", code: "resource_busy" } });
	const run = createCuSessionTool(tool);
	const result = await run({ action: "transfer", toAgentId: "session:child" }, undefined);
	assert.equal((result.details as { status: string }).status, "denied");
	assert.equal(trace.entries.length, 1);
	assert.deepEqual(trace.entries[0], {
		tool: "cu_session",
		status: "lease_conflict",
		evidence: "resource_busy",
		transfer: { action: "transfer", toAgentId: "session:child", resourceKey: "desktop-pid:700", oldLeaseId: "lease-old-1" },
	});
});
