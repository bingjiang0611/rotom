import assert from "node:assert/strict";
import test from "node:test";
import { LeaseUnavailableError, ResourceScheduler } from "../src/runtime.ts";
import { UnavailableLeaseBroker } from "../src/broker/lease-broker.ts";
import { leaseConflictResult } from "../src/broker/lease-result.ts";
import { computerUseEvidenceResult } from "../src/recovery.ts";

test("broker unavailable blocks native work, forbids automatic retry and does not invent a holder", async () => {
	const scheduler = new ResourceScheduler();
	scheduler.setBroker(new UnavailableLeaseBroker("Broker request acquire timed out."));
	let writes = 0;
	await assert.rejects(scheduler.write("desktop-pid:1", 0, async () => { writes++; }), (error: unknown) => {
		assert.ok(error instanceof LeaseUnavailableError);
		const result = computerUseEvidenceResult("act_ui", leaseConflictResult("act_ui", error));
		assert.equal(result.details.code, "broker_unavailable");
		assert.equal(result.details.dispatch, "not_started");
		assert.equal(result.details.retry, "never");
		const text = result.content[0].text;
		assert.match(text, /dispatch=not_started/);
		assert.match(text, /does not prove another agent holds/);
		assert.doesNotMatch(text, /outcome=unknown|Held by agent|ROTOM_CU_BROKER=0|Ctrl\+Option|Retry after/);
		return true;
	});
	assert.equal(writes, 0);
});

test("only a genuine resource_busy refusal reports the holder", () => {
	const error = new LeaseUnavailableError("resource_busy", "busy", { holder: { agentId: "owner", remainingMs: 1000 } });
	const result = leaseConflictResult("act_ui", error);
	assert.match(result.content[0].text, /Held by agent owner/);
	assert.match(result.content[0].text, /fresh observation/);
	assert.equal(result.details.retry, "safe");
});

test("an unmarked or already-dispatched unknown result stays unknown", () => {
	const result = computerUseEvidenceResult("act_ui", {
		content: [{ type: "text", text: "unproven" }],
		details: { status: "lease_conflict", execution: { outcome: "unknown", stoppedAt: 1 } },
	});
	assert.match(result.content[0].text, /outcome=unknown/);
	assert.match(result.content[0].text, /earlier steps may already have executed/);
	assert.doesNotMatch(result.content[0].text, /dispatch=not_started/);
});
