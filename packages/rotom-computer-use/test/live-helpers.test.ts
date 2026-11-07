/**
 * Review 6 P2/P4: the restore path and the refusal classification.
 *
 * Both used to decide from the wrong evidence - a swallowed `manageApps` call and a
 * regex over error text - so the tests drive the decisions rather than the messages.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { classifyActFailure, leaseForRestore, restoreOperatorApp, restoreOutcome } from "../scripts/lib/live-helpers.mjs";

function recorder() {
	const rows = [];
	return { rows, record: (area, action, result, note) => rows.push({ area, action, result, note }) };
}

const OPERATOR = { appName: "Scry", pid: 60263 };

test("a helper refusal is not a failure", () => {
	// `ax_only` refusing `typeText` carries `foreground_required`: the matrix used to
	// call that a fail cell and the review called it out (P4).
	assert.deepEqual(classifyActFailure(Object.assign(new Error("ax_only cannot deliver typeText"), { code: "foreground_required" })), { result: "refused", code: "foreground_required" });
	assert.deepEqual(classifyActFailure(Object.assign(new Error("x"), { code: "background_unsupported" })), { result: "refused", code: "background_unsupported" });
	assert.deepEqual(classifyActFailure(Object.assign(new Error("x"), { code: "l2_unavailable" })), { result: "refused", code: "l2_unavailable" });
	// Anything else is a failure even if it carries a code.
	assert.deepEqual(classifyActFailure(Object.assign(new Error("boom"), { code: "timeout" })), { result: "fail", code: "timeout" });
	assert.deepEqual(classifyActFailure(new Error("boom")), { result: "fail", code: "none" });
});

test("the restore says whether the lease was signed or merely unverified", async () => {
	const bare = await leaseForRestore({ pid: OPERATOR.pid, brokerEnabled: false });
	assert.equal(bare.state, "unverified");
	assert.equal(bare.lease, undefined);
	assert.match(bare.note, /unverified/);

	const signed = await leaseForRestore({ pid: OPERATOR.pid, brokerEnabled: true, acquire: async (key) => ({ token: "t", leaseId: "L", resourceKey: key }) });
	assert.equal(signed.state, "signed");
	assert.equal(signed.lease.token, "t");

	const missing = await leaseForRestore({ pid: OPERATOR.pid, brokerEnabled: true, acquire: async () => ({ leaseId: "L" }) });
	assert.equal(missing.state, "unavailable");
	assert.equal(missing.lease, undefined);

	const refused = await leaseForRestore({ pid: OPERATOR.pid, brokerEnabled: true, acquire: async () => { throw new Error("resource_busy"); } });
	assert.equal(refused.state, "unavailable");
	assert.match(refused.note, /resource_busy/);
});

test("the frontmost readback decides, not the call that was made", () => {
	assert.deepEqual(restoreOutcome({ original: OPERATOR, after: { appName: "Scry", pid: OPERATOR.pid } }).result, "pass");
	const left = restoreOutcome({ original: OPERATOR, after: { appName: "CU Fixture", pid: 98067 } });
	assert.equal(left.result, "fail");
	assert.match(left.note, /Scry \(60263\) → CU Fixture \(98067\)/);
	assert.equal(restoreOutcome({ original: OPERATOR, after: undefined }).result, "fail");
});

test("restoreOperatorApp raises the operator window through focusWindow and reads back", async () => {
	const calls = [];
	const backend = {
		listRoots: async ({ pid }) => [{ kind: "window", windowId: 41, rootRef: "r-41", pid }],
		focusWindow: async (target, _signal, lease) => {
			calls.push({ target, lease });
			return { focused: true };
		},
		getFrontmost: async () => ({ appName: "Scry", pid: OPERATOR.pid }),
	};
	const { rows, record } = recorder();
	const result = await restoreOperatorApp({ backend, original: OPERATOR, record, brokerEnabled: false });
	assert.equal(result.restored, true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].target.windowId, 41);
	assert.equal(calls[0].lease, undefined);
	assert.equal(rows.at(-1).result, "pass");
	assert.match(rows.at(-1).note, /lease=unverified/);
});

test("a restore that leaves the fixture in front fails", async () => {
	const { rows, record } = recorder();
	const backend = {
		listRoots: async () => [{ kind: "window", windowId: 41, rootRef: "r-41" }],
		focusWindow: async () => ({ focused: false, reason: "focus_failed" }),
		getFrontmost: async () => ({ appName: "CU Fixture", pid: 98067 }),
	};
	const result = await restoreOperatorApp({ backend, original: OPERATOR, record, brokerEnabled: false });
	assert.equal(result.restored, false);
	assert.equal(rows.at(-1).result, "fail");
	assert.match(rows.at(-1).note, /reason=focus_failed/);
});

test("an operator app with no window is a failure, not a silent skip", async () => {
	const { rows, record } = recorder();
	const backend = { listRoots: async () => [], focusWindow: async () => assert.fail("must not raise what does not exist"), getFrontmost: async () => OPERATOR };
	const result = await restoreOperatorApp({ backend, original: OPERATOR, record, brokerEnabled: false });
	assert.equal(result.result, "fail");
	assert.equal(rows.at(-1).result, "fail");
	assert.match(rows.at(-1).note, /no window/);
});
