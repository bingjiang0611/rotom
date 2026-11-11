import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { prepareAction as prepare, outcomeAfterCheck, canRetryInForeground, type ActionEnvironment } from "../src/actions.ts";
import type { UiAction } from "../src/contract.ts";
import { parseLookResponse } from "../src/outline.ts";
import { requiredTier } from "../src/policy/tiers.ts";
import { buildActRequest } from "../src/tools/act-request.ts";

const source = readFileSync(new URL("../native/macos/bridge.swift", import.meta.url), "utf8");
function environment(actions = ["AXOpen"], pictureOnly = false): ActionEnvironment {
	const outline = parseLookResponse({ lookId: "open-test", outline: {
		ref: "e1", role: "AXCell", actions, pictureOnly, rect: { x: 1, y: 2, w: 3, h: 4 },
	} }).parsedOutline;
	assert.ok(outline?.root);
	const node = outline.root;
	return { headless: true, node: () => node, center: () => ({ x: 2, y: 3 }), validatePoint: () => undefined };
}
function prepareAction(action: UiAction, env: ActionEnvironment) {
	return prepare(action, { currentFocus: false }, env);
}

test("explicit open requires the observed AXOpen capability and a semantic wire ref", () => {
	const action = prepareAction({ action: "open", ref: "@e1" }, environment());
	assert.ok(action.action === "open");
	assert.deepEqual(action.target, { ref: "e1" });
	assert.equal(action.needsForeground, false);
	assert.throws(() => prepareAction({ action: "open", ref: "@e1" }, environment(["AXPress"])), /AXOpen capability/);
	assert.throws(() => prepareAction({ action: "open", ref: "@e1" }, environment(["AXOpen"], true)), /picture-only or unmapped/);
	assert.throws(() => prepareAction({ action: "open" }, environment()), /requires an element ref/);
	assert.equal(prepareAction({ action: "click", ref: "@e1" }, environment()).action, "click", "click must not silently become open");
	assert.equal(requiredTier("open"), "click");
	assert.equal(canRetryInForeground(action, "unknown", false, { ROTOM_CU_SPECULATIVE_FOREGROUND_RETRY: "1" }), false);
});

test("open preserves policy and lease in the helper request without becoming click", () => {
	const action = prepareAction({ action: "open", ref: "@e1" }, environment());
	assert.ok(action.action === "open");
	const request = buildActRequest({
		action, lookId: "open-test", pid: 4242, policy: "background_text",
		delivery: "pid", cursorAgentId: "session:open-test",
		lease: { token: "test-token", resourceKey: "desktop-pid:4242" },
	});
	assert.equal(request.action, "open");
	assert.deepEqual(request.target, { ref: "e1" });
	assert.deepEqual(request.lease, { token: "test-token", resourceKey: "desktop-pid:4242" });
	assert.equal("delivery" in request, false);
	assert.equal(request.params.delivery, "pid");
	assert.equal(request.policy, "background_text");
	assert.equal(request.pid, 4242);
	assert.equal(outcomeAfterCheck("unknown", "preexisting"), "unknown");
	assert.equal(outcomeAfterCheck("unknown", "verified"), "worked");
});

test("native open is registered on the guarded semantic path with no click fallback", () => {
	assert.ok(/private let semanticActions: Set<String> = \[\s*"open"/.test(source), "open must use the semantic dispatcher");
	assert.ok(/takeoverState\.admitWrite\(expected: requestTakeoverId\) \} catch \{ return \.cannotComplete \}\s*return ApplicationServices\.AXUIElementPerformAction/.test(source), "the AX wrapper must check the write boundary before dispatch");
	const body = source.split('\t\tcase "open":')[1]?.split('\t\tcase "select":')[0];
	assert.ok(body);
	assert.equal((body.match(/AXUIElementPerformAction\(/g) ?? []).length, 1);
	assert.doesNotMatch(body, /postMouse|activate|AXPress|refreshElement|refound/);
});

test("native AXOpen control flow dispatches once and never equates AX acceptance with business success", { skip: process.platform !== "darwin" }, () => {
	// Execute the actual native switch arm with deterministic AX stubs, not a
	// helper or a live App. Full native typechecking separately checks SDK types.
	const body = source.split('\t\tcase "open":')[1]?.split('\t\tcase "select":')[0];
	assert.ok(body, "native open implementation must exist");
	const directory = mkdtempSync(path.join(tmpdir(), "cu-semantic-open-"));
	try {
		const file = path.join(directory, "main.swift");
		writeFileSync(file, `import Foundation

typealias CFString = String
struct BridgeFailure: Error { let message: String; let code: String }
enum AXError: Int32 { case success = 0, cannotComplete = -25204 }
var supported = false
var calls = 0
var response = AXError.success
func supportsAction(_ element: Int, action: String) -> Bool { precondition(action == "AXOpen"); return supported }
func AXUIElementPerformAction(_ element: Int, _ action: String) -> AXError { precondition(action == "AXOpen"); calls += 1; return response }
func open(_ element: Int) throws -> [String: Any] {
 var performed: [String: Any] = ["delivery": "pid", "grounding": "coordinates"]
${body}
}
do { _ = try open(1); fatalError("unsupported action dispatched") }
catch let error as BridgeFailure { precondition(error.code == "unsupported_action") }
precondition(calls == 0)
supported = true
for status in [AXError.success, AXError.cannotComplete] {
 calls = 0; response = status
 let result = try open(1)
 precondition(calls == 1)
 precondition(result["outcome"] as? String == "unknown")
 let performed = result["performed"] as! [String: Any]
 precondition(performed["delivery"] as? String == "ax")
 precondition(performed["grounding"] as? String == "description")
 precondition(performed["axAction"] as? String == "AXOpen")
 precondition(performed["verification"] as? String == "caller_required")
 precondition((result["evidence"] as! [String: Int32])["axReturnCode"] == status.rawValue)
 precondition((result["error"] != nil) == (status != .success))
}
print("semantic-open: unsupported=0 dispatches; success/error=1 dispatch each; both unknown")
`, { mode: 0o600 });
		const result = spawnSync("xcrun", ["swift", "-module-cache-path", path.join(directory, "module-cache"), file], { encoding: "utf8", timeout: 60_000 });
		assert.ifError(result.error);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /success\/error=1 dispatch each; both unknown/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
