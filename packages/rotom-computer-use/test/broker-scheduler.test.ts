import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { connectLeaseBroker, shouldUseBroker } from "../src/broker/lease-broker.ts";
import { LeaseUnavailableError, ResourceScheduler, StaleResourceStateError } from "../src/runtime.ts";

function tempRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "rotom-cu-scheduler-"));
}

async function schedulerPair(socketPath: string) {
	const alpha = await connectLeaseBroker({ socketPath, agentId: "session:alpha", hasUI: true, pidChain: [] });
	const beta = await connectLeaseBroker({ socketPath, agentId: "session:beta", hasUI: true, pidChain: [] });
	return {
		alpha,
		beta,
		alphaScheduler: new ResourceScheduler(alpha.broker),
		betaScheduler: new ResourceScheduler(beta.broker),
	};
}


test("ROTOM_CU_BROKER=0 (and non-macOS) keeps the previous per-process behavior", () => {
	assert.equal(shouldUseBroker({ platform: "darwin", configured: true }), true);
	assert.equal(shouldUseBroker({ platform: "darwin", configured: false }), false, "explicit opt-out wins on macOS");
	assert.equal(shouldUseBroker({ platform: "linux", configured: true }), false);
	assert.equal(shouldUseBroker({ platform: "win32", configured: true }), false);
});

test("without a broker the scheduler still increments epochs locally and never leaves the process", async () => {
	const scheduler = new ResourceScheduler();
	const first = await scheduler.write("desktop-pid:1", 0, async (epoch) => epoch);
	assert.equal(first.epoch, 1);
	const second = await scheduler.write("desktop-pid:1", 1, async (epoch) => epoch);
	assert.equal(second.epoch, 2);
	await assert.rejects(() => scheduler.write("desktop-pid:1", 1, async () => "x"), (error: unknown) => error instanceof StaleResourceStateError);
});

test("two schedulers on one broker: the second write is a structured resource_busy, then it takes over on release", async () => {
	const root = tempRoot();
	const socketPath = path.join(root, "broker.sock");
	const { alpha, beta, alphaScheduler, betaScheduler } = await schedulerPair(socketPath);
	try {
		const first = await alphaScheduler.write("desktop-pid:900", 0, async (epoch) => `dispatched-at-${epoch}`);
		assert.equal(first.epoch, 1);

		// beta observes the same app after alpha's write, so its epoch is current and
		// the refusal is a holder conflict rather than a stale observation.
		const observedAt = await betaScheduler.syncEpoch("desktop-pid:900");
		assert.equal(observedAt, 1);
		await assert.rejects(
			() => betaScheduler.write("desktop-pid:900", observedAt, async () => "must not run"),
			(error: unknown) => {
				assert.ok(error instanceof LeaseUnavailableError, "conflict must be structured, not generic");
				assert.equal(error.code, "resource_busy");
				assert.equal(error.holder?.agentId, "session:alpha");
				assert.ok((error.holder?.remainingMs ?? 0) > 0);
				return true;
			},
		);
		// The holder is still reported for the model to explain the conflict.
		assert.equal(betaScheduler.holderOf("desktop-pid:900")?.agentId, "session:alpha");

		// Unrelated resources are not blocked.
		const parallel = await betaScheduler.write("desktop-pid:901", 0, async (epoch) => epoch);
		assert.equal(parallel.epoch, 1);

		// Releasing the app on the broker side frees it for the other agent.
		const status = await beta.client.status();
		const alphaLease = status.agents.find((entry) => entry.agentId === "session:alpha")?.leases.find((lease) => lease.resourceKey === "desktop-pid:900");
		assert.ok(alphaLease);
		await alpha.broker.release(alphaLease!.leaseId);
		const taken = await betaScheduler.write("desktop-pid:900", 1, async (epoch) => epoch);
		assert.equal(taken.epoch, 2);
	} finally {
		alpha.client.close();
		beta.client.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a cross-process stale observation is refused with the broker's current epoch", async () => {
	const root = tempRoot();
	const socketPath = path.join(root, "broker.sock");
	const { alpha, beta, alphaScheduler, betaScheduler } = await schedulerPair(socketPath);
	try {
		// alpha observes at broker epoch 0 and writes once.
		await alphaScheduler.write("desktop-pid:500", 0, async (epoch) => epoch);
		// beta observed the same app before that write: it still holds epoch 0.
		await assert.rejects(
			() => betaScheduler.write("desktop-pid:500", 0, async () => "must not run"),
			(error: unknown) => {
				assert.ok(error instanceof StaleResourceStateError);
				assert.equal(error.expectedEpoch, 0);
				return true;
			},
		);
		// After re-observing (syncEpoch) beta acts on the current epoch.
		const observedAt = await betaScheduler.syncEpoch("desktop-pid:500");
		assert.equal(observedAt, 1);
		// alpha's lease is still held; releasing lets beta's write through.
		const status = await alpha.client.status();
		const lease = status.agents.find((entry) => entry.agentId === "session:alpha")?.leases.find((entry) => entry.resourceKey === "desktop-pid:500");
		await alpha.broker.release(lease!.leaseId);
		const written = await betaScheduler.write("desktop-pid:500", observedAt, async (epoch) => epoch);
		assert.equal(written.epoch, 2);
	} finally {
		alpha.client.close();
		beta.client.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("an unreachable broker fails writes closed with an actionable code", async () => {
	const root = tempRoot();
	const socketPath = path.join(root, "missing", "broker.sock");
	// Point at a directory that cannot hold a socket: the connect and the daemon
	// both fail, and the scheduler must not silently degrade to local epochs.
	const scheduler = new ResourceScheduler();
	const { UnavailableLeaseBroker } = await import("../src/broker/lease-broker.ts");
	scheduler.setBroker(new UnavailableLeaseBroker(`The broker socket ${socketPath} is unavailable.`));
	await assert.rejects(
		() => scheduler.write("desktop-pid:1", 0, async () => "must not run"),
		(error: unknown) => {
			assert.ok(error instanceof LeaseUnavailableError);
			assert.equal(error.code, "broker_unavailable");
			assert.doesNotMatch(error.message, /ROTOM_CU_BROKER=0/);
			return true;
		},
	);
	rmSync(root, { recursive: true, force: true });
});
