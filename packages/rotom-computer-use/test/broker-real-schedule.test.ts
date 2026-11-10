import assert from "node:assert/strict";
import test from "node:test";
import { LeaseManager, realSchedule } from "../src/broker/leases.ts";

test("the default scheduler runs callbacks and supports cancellation", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const calls: string[] = [];
	realSchedule(() => calls.push("due"), 10);
	const cancel = realSchedule(() => calls.push("cancelled"), 10);
	cancel();
	t.mock.timers.tick(10);
	assert.deepEqual(calls, ["due"]);
});

test("a queued lease times out with the default scheduler, not only an injected clock", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const epochs = { current: () => 0, bump: () => 1 };
	const leases = new LeaseManager(epochs, { now: () => 1000, ttlMs: 60_000, waitTimeoutMs: 10 });
	assert.equal(leases.tryAcquire("holder", "desktop-pid:1").ok, true);
	const pending = leases.acquire("waiter", "desktop-pid:1", { wait: true });
	t.mock.timers.tick(10);
	const result = await pending;
	assert.equal(result.ok, false);
	if (result.ok) assert.fail("the existing holder must keep the lease");
	assert.equal(result.code, "resource_busy");
	assert.equal(leases.holder("desktop-pid:1")?.agentId, "holder");
});
