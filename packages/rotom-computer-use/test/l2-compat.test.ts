import assert from "node:assert/strict";
import { test } from "node:test";
import { L2_COMPATIBLE_BUNDLE_IDS, backgroundDelivery, l2DeliveryFor, l2Enabled } from "../src/policy/l2-compat.ts";

test("only whitelisted apps get the targeted background channel", () => {
	assert.equal(backgroundDelivery("com.jetbrains.intellij", "IntelliJ IDEA"), "l2");
	assert.equal(backgroundDelivery("com.apple.TextEdit", "TextEdit"), "pid");
	// An app with no bundle id cannot be verified, so it keeps the old path and
	// must not be silently upgraded.
	assert.equal(backgroundDelivery(undefined, "Some App"), "pid");
	assert.equal(L2_COMPATIBLE_BUNDLE_IDS.size > 0, true);
});

test("a non-whitelisted app gets an explanation, not a silent fallback", () => {
	const decision = l2DeliveryFor("com.apple.TextEdit", "TextEdit");
	assert.equal(decision.allowed, false);
	assert.match(decision.allowed === false ? decision.reason : "", /compatibility list/);
});

test("ROTOM_CU_L2=0 forces pid-targeted posting everywhere", () => {
	assert.equal(l2Enabled({ ROTOM_CU_L2: "0" }), false);
	assert.equal(l2Enabled({ ROTOM_CU_L2: "off" }), false);
	assert.equal(l2Enabled({}), true);
	const previous = process.env.ROTOM_CU_L2;
	process.env.ROTOM_CU_L2 = "0";
	try {
		assert.equal(backgroundDelivery("com.jetbrains.intellij", "IntelliJ IDEA"), "pid");
	} finally {
		if (previous === undefined) delete process.env.ROTOM_CU_L2;
		else process.env.ROTOM_CU_L2 = previous;
	}
});
