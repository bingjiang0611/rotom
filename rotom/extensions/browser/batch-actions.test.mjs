import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BATCH_STEPS_V1, batchErrorOutcomeV1, batchStepOutcomeV1, batchStepSummaryV1, parseBatchActionsV1 } from "./batch-actions.ts";

const step = (extra = {}) => ({ action: "click", targetRef: "ax_r_1_1", ...extra });
const result = (extra = {}) => ({ kind: "browser-interaction-result", acknowledged: true, effect: {}, readback: { tabId: 7, documentGeneration: 3 }, ...extra });

test("batch：单动作与 actions 互斥，空数组、超长、非法字段都在本地拒绝", () => {
	assert.equal(parseBatchActionsV1({ action: "click", targetRef: "ax_r_1_1" }), undefined);
	assert.throws(() => parseBatchActionsV1({}), /action 或 actions/u);
	assert.throws(() => parseBatchActionsV1({ actions: [] }), /非空数组/u);
	assert.throws(() => parseBatchActionsV1({ actions: Array.from({ length: MAX_BATCH_STEPS_V1 + 1 }, () => step()) }), /最多 10 步/u);
	assert.throws(() => parseBatchActionsV1({ actions: [step()], action: "click" }), /互斥/u);
	assert.throws(() => parseBatchActionsV1({ operation: "snapshot", actions: [step()] }), /operation=execute/u);
	assert.throws(() => parseBatchActionsV1({ operation: "execute", actions: [step({ tabName: "other" })] }), /不接受字段 tabName/u);
	// `paths`/`accept` 属于单步动作，批次里合法；`limit`/`cursor` 这类工具级字段不合法。
	assert.throws(() => parseBatchActionsV1({ operation: "execute", actions: [step({ limit: 5 })] }), /不接受字段 limit/u);
	assert.throws(() => parseBatchActionsV1({ operation: "execute", actions: [null] }), /必须是对象/u);
	assert.throws(() => parseBatchActionsV1({ operation: "execute", actions: [{ targetRef: "ax_r_1_1" }] }), /缺少 action/u);
});

test("batch：合法的批次保留每一步自己的动作字段", () => {
	const parsed = parseBatchActionsV1({ operation: "execute", tabName: "form", actions: [step(), { action: "type", targetRef: "ax_r_1_2", text: "hello", replace: true }, { action: "keypress", targetRef: "ax_r_1_3", key: "Enter" }] });
	assert.ok(parsed);
	assert.equal(parsed.tabName, "form");
	assert.equal(parsed.steps.length, 3);
	assert.equal(parsed.steps[1].text, "hello");
	assert.equal(parsed.steps[2].key, "Enter");
});

test("batch：dialog-blocking、needs-approval、非交互结果都立即停下", () => {
	assert.deepEqual(batchStepOutcomeV1({ kind: "dialog-blocking" }, {}), { stop: true, reason: "dialog-blocking" });
	assert.deepEqual(batchStepOutcomeV1({ kind: "needs-approval" }, {}), { stop: true, reason: "blocked" });
	assert.deepEqual(batchStepOutcomeV1({ kind: "tabs" }, {}), { stop: true, reason: "failed" });
	// 打开弹窗的那一步本身是交互结果，但页面已被挂起：同样停下。
	assert.deepEqual(batchStepOutcomeV1(result({ effect: { dialogOpened: true } }), {}), { stop: true, reason: "dialog-blocking" });
});

test("batch：expect 不满足就停下，满足则继续", () => {
	assert.deepEqual(batchStepOutcomeV1(result({ effect: { expectation: { outcome: "unmet" } } }), {}), { stop: true, reason: "expect-unmet" });
	assert.equal(batchStepOutcomeV1(result({ effect: { expectation: { outcome: "met" } } }), { tabId: 7, documentGeneration: 3 }).stop, false);
	assert.equal(batchStepOutcomeV1(result({ effect: { expectation: { outcome: "unknown" } } }), { tabId: 7, documentGeneration: 3 }).stop, false);
});

test("batch：导航（tab 或 documentGeneration 变化）立即停下", () => {
	assert.deepEqual(batchStepOutcomeV1(result({ readback: { tabId: 8, documentGeneration: 3 } }), { tabId: 7 }), { stop: true, reason: "navigation" });
	assert.deepEqual(batchStepOutcomeV1(result({ readback: { tabId: 7, documentGeneration: 4 } }), { tabId: 7, documentGeneration: 3 }), { stop: true, reason: "navigation" });
	// The tool returns a snapshot page around the observation; both shapes must count.
	assert.deepEqual(batchStepOutcomeV1(result({ readback: { observation: { tabId: 7, documentGeneration: 4 } } }), { tabId: 7, documentGeneration: 3 }), { stop: true, reason: "navigation" });
	const carried = batchStepOutcomeV1(result(), { tabId: 7, documentGeneration: 3 });
	assert.deepEqual(carried, { stop: false, tabId: 7, documentGeneration: 3 });
});

test("batch：超时算 unknown（不重放），本地校验错误算 failed", () => {
	assert.deepEqual(batchErrorOutcomeV1(new Error("timeout；click 结果 unknown，dispatch 可能已生效")), { stop: true, reason: "unknown" });
	assert.deepEqual(batchErrorOutcomeV1(new Error("browser relay interact operation timeout")), { stop: true, reason: "unknown" });
	assert.deepEqual(batchErrorOutcomeV1(new Error("keypress 需要 targetRef")), { stop: true, reason: "failed" });
	assert.deepEqual(batchErrorOutcomeV1("boom"), { stop: true, reason: "failed" });
});

test("batch：单步摘要只留证据字段，不回放整页内容", () => {
	const summary = batchStepSummaryV1(2, "click", {
		kind: "browser-interaction-result",
		acknowledged: true,
		actionId: "pi1_browser_action_x",
		effect: { dispatch: "mouse", target: { changed: true, transitions: ["checked=true"] }, expectation: { outcome: "met" }, dialog: { type: "alert" } },
		readback: { digest: "abc", url: "https://example.test/form", documentGeneration: 2, nodes: [{ role: "button", name: "x" }] },
	}, "expect-unmet");
	assert.deepEqual(summary, { index: 2, action: "click", status: "expect-unmet", acknowledged: true, actionId: "pi1_browser_action_x", dispatch: "mouse", targetChanged: true, expectation: "met", dialog: "alert", readbackDigest: "abc", url: "https://example.test/form", documentGeneration: 2 });
	assert.equal(JSON.stringify(summary).includes("nodes"), false, "摘要不带整页节点");
	assert.equal(batchStepSummaryV1(0, undefined, {}, "failed").action, "unknown");
});
