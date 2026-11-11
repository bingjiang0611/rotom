import assert from "node:assert/strict";
import test from "node:test";
import { createBrokerApprovalHandler } from "../src/broker/approval-ui.ts";
import { approvalCopy } from "../src/constants/copy.ts";
import type { ApprovalDiagnostic, ApprovalRequestEvent } from "../src/broker/protocol.ts";

function event(): ApprovalRequestEvent {
	return { event: "approval", requestId: "approval-1", agentId: "agent", resourceKey: "desktop-pid:1",
		tier: "click", deadline: Date.now() + 120_000,
		app: { appName: "private-app-name" }, action: { name: "press", label: "private-target-label" } };
}

test("approval UI receives the broker deadline and cancellation signal; diagnostics contain no UI content", async () => {
	const entries: ApprovalDiagnostic[] = [];
	const controller = new AbortController();
	const request = event();
	const handler = createBrokerApprovalHandler({ hasUI: true, ui: { async select(title, options, opts) {
		assert.match(title, /private-app-name/);
		assert.deepEqual(options, approvalCopy.options());
		assert.equal(opts?.signal, controller.signal);
		assert.ok(opts?.timeout && opts.timeout <= 120_000 && opts.timeout > 110_000);
		return approvalCopy.allowSession;
	} } }, (entry) => entries.push(entry));
	assert.equal(await handler(request, controller.signal), "allow_session");
	assert.deepEqual(entries, [
		{ requestId: "approval-1", phase: "received" },
		{ requestId: "approval-1", phase: "prompt_requested" },
		{ requestId: "approval-1", phase: "decision", decision: "allow_session" },
	]);
	assert.doesNotMatch(JSON.stringify(entries), /private-app|private-target|desktop-pid|press/);
});

test("no UI, expired requests and cancelled connections never open a prompt", async () => {
	for (const mode of ["no-ui", "expired", "cancelled"]) {
		const entries: ApprovalDiagnostic[] = [];
		const controller = new AbortController();
		const request = event();
		if (mode === "expired") request.deadline = Date.now() - 1;
		if (mode === "cancelled") controller.abort();
		const handler = createBrokerApprovalHandler({ hasUI: mode !== "no-ui", ui: {
			async select() { assert.fail("must not request a prompt"); },
		} }, (entry) => entries.push(entry));
		assert.equal(await handler(request, controller.signal), "deny");
		assert.equal(entries.at(-1)?.phase, mode === "no-ui" ? "unavailable" : mode);
	}
});

test("late and cancelled choices cannot become approvals; UI errors are metadata-only", async () => {
	for (const mode of ["expired", "cancelled", "ui_error"]) {
		const entries: ApprovalDiagnostic[] = [];
		const request = event();
		const controller = new AbortController();
		const handler = createBrokerApprovalHandler({ hasUI: true, ui: { async select() {
			if (mode === "expired") request.deadline = Date.now() - 1;
			if (mode === "cancelled") controller.abort();
			if (mode === "ui_error") throw new Error("private-error-body");
			return approvalCopy.allowAlways;
		} } }, (entry) => entries.push(entry));
		assert.equal(await handler(request, controller.signal), "deny");
		assert.equal(entries.at(-1)?.phase, mode);
		assert.doesNotMatch(JSON.stringify(entries), /private-error-body|always/);
	}
});

test("external and unknown opens warn about foreground activation and offer only one-action approval", async () => {
	for (const openTarget of ["file", "package", "unknown", undefined] as const) {
		for (const choice of [approvalCopy.allowOnce, approvalCopy.allowSession, approvalCopy.allowAlways, undefined]) {
			const request = { ...event(), action: { name: "open", openTarget }, warning: "Existing high-risk warning" };
			const handler = createBrokerApprovalHandler({ hasUI: true, ui: { async select(title, options) {
				assert.ok(title.includes(approvalCopy.externalOpenWarning));
				assert.ok(title.includes("Existing high-risk warning"));
				assert.deepEqual(options, [approvalCopy.allowOnce, approvalCopy.deny]);
				return choice;
			} } }, () => undefined);
			assert.equal(await handler(request, new AbortController().signal), choice === approvalCopy.allowOnce ? "allow_once" : "deny");
		}
	}
});
