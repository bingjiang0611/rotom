import assert from "node:assert/strict";
import { test } from "node:test";
import { buildActRequest } from "../src/tools/act-request.ts";
import { buildDirectL2Request, buildDirectTransportRequest } from "../scripts/lib/l2-direct.mjs";

const context = {
	lookId: "look-1",
	pid: 4242,
	cursorAgentId: "session:test",
	policy: "background" as const,
	delivery: "pid" as const,
	action: { action: "typeText", params: { text: "probe" }, target: { ref: "e7" } },
};

test("a product typeText request never pins the transport", () => {
	// Review G1: the product always names a delivery, so if the helper inferred the pin
	// from `delivery` being present, AX text insertion would be unreachable in production
	// and only the check script would exercise the input-method fix.
	const request = buildActRequest(context);
	assert.equal(request.params.delivery, "pid");
	assert.equal("requireTransport" in request.params, false);
});

test("a policy that picks l2 still leaves AX insertion allowed", () => {
	const request = buildActRequest({ ...context, delivery: "l2" });
	assert.equal(request.params.delivery, "l2");
	assert.equal("requireTransport" in request.params, false, "naming l2 is a preference, not a pin");
});

test("the direct-L2 check pins the transport explicitly", () => {
	const request = buildDirectL2Request({ lookId: "look-1", pid: 4242, ref: "e7", action: "typeText", params: { text: "probe" } });
	assert.equal(request.params.delivery, "l2");
	assert.equal(request.params.requireTransport, true);
	assert.equal(request.policy, "background");
});

test("the delivery matrix pins both native process transports explicitly", () => {
	for (const delivery of ["l2", "pid"] as const) {
		const request = buildDirectTransportRequest({ lookId: "look-1", pid: 4242, ref: "e7", action: "click", delivery });
		assert.equal(request.params.delivery, delivery);
		assert.equal(request.params.requireTransport, true);
		assert.equal(request.policy, "background");
	}
});

test("the lease and cursor identity travel with the request", () => {
	const request = buildActRequest({ ...context, lease: { token: "t", resourceKey: "desktop-pid:4242" } });
	assert.deepEqual(request.lease, { token: "t", resourceKey: "desktop-pid:4242" });
	assert.equal(request.cursorAgentId, "session:test");
});

test("an action with no helper request shape is refused instead of guessed", () => {
	assert.throws(() => buildActRequest({ ...context, action: { action: "teleport", params: {}, target: { ref: "e1" } } }), /No helper request shape/);
});
