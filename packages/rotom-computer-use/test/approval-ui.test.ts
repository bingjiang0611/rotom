import assert from "node:assert/strict";
import test from "node:test";
import { createBrokerApprovalHandler } from "../src/broker/approval-ui.ts";
import type { ApprovalDiagnostic, ApprovalRequestEvent } from "../src/broker/protocol.ts";

function event(): ApprovalRequestEvent {
	return { event: "approval", requestId: "approval-1", agentId: "agent", resourceKey: "desktop-pid:1",
		tier: "click", deadline: Date.now() + 120_000,
		app: { appName: "private-app-name" }, action: { name: "press", label: "private-target-label" } };
}

test("older broker requests are accepted once without UI or a standing grant; diagnostics are metadata-only", async () => {
	const entries: ApprovalDiagnostic[] = [];
	const handler = createBrokerApprovalHandler(entry => entries.push(entry));
	assert.equal(await handler(event(), new AbortController().signal), "allow_once");
	assert.deepEqual(entries, [
		{ requestId: "approval-1", phase: "received" },
		{ requestId: "approval-1", phase: "decision", decision: "allow_once" },
	]);
	assert.doesNotMatch(JSON.stringify(entries), /private-app|private-target|desktop-pid|press|prompt_requested/);
});

test("expired requests and cancelled connections still cannot authorize a dispatch", async () => {
	for (const mode of ["expired", "cancelled"] as const) {
		const entries: ApprovalDiagnostic[] = [];
		const controller = new AbortController();
		const request = event();
		if (mode === "expired") request.deadline = Date.now() - 1;
		if (mode === "cancelled") controller.abort();
		const handler = createBrokerApprovalHandler(entry => entries.push(entry));
		assert.equal(await handler(request, controller.signal), "deny");
		assert.equal(entries.at(-1)?.phase, mode);
	}
});

test("older sensitive-action, external-open and takeover requests never ask for user authorization", async () => {
	for (const action of [
		{ name: "press", label: "Pay" }, { name: "press", label: "Delete" }, { name: "takeover" },
		...(["file", "package", "unknown", undefined] as const).map(openTarget => ({ name: "open", openTarget } as const)),
	]) {
		const handler = createBrokerApprovalHandler(() => undefined);
		assert.equal(await handler({ ...event(), action }, new AbortController().signal), "allow_once");
	}
});
