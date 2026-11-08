import test from "node:test";
import assert from "node:assert/strict";
import { observationTextBaseline, compactInteractionReadback, observedInteractionNode } from "./chrome-extension/interaction-observation.js";
import { readInteractionTargetState, interactionTargetChange, parseInteractionExpectation, evaluateInteractionExpectation } from "./chrome-extension/interaction-target-state.js";
import { collectPageAlerts, pageAlertNodes } from "./chrome-extension/page-alerts.js";
import { interactionScrollTarget } from "./chrome-extension/interaction-scroll-target.js";
test("text compaction matches ref and content, never drops AX/alerts or crosses document generations", () => {
	const text = { ref: "txt_1_r_1", role: "document-text", name: "same text", states: ["read-only=true"] };
	const control = { ref: "ax_1_1", role: "button", name: "same text" };
	const alert = { ref: "alert_1_r_1", role: "page-alert", name: "same text" };
	const before = { documentGeneration: 1, observationEpoch: 2, nodes: [control, text, alert] };
	const baseline = observationTextBaseline(before);
	assert.deepEqual(baseline.nodes, [text]);
	const after = { ...before, observationEpoch: 3, truncated: true, contentCoverage: "rendered-dom", contentComplete: false };
	const delta = compactInteractionReadback(after, baseline);
	assert.deepEqual(delta.nodes, [control, alert]);
	assert.equal(delta.truncated, true);
	assert.equal(delta.contentComplete, false);
	assert.equal(delta.textBaselineEpoch, 2);
	assert.equal(delta.omittedUnchangedTextNodes, 1);
	assert.deepEqual(after.nodes, before.nodes, "do not mutate the full observation used as the next baseline");
	for (const changed of [{ ...text, name: "changed" }, { ...text, ref: "txt_1_f1_1" }]) {
		const observation = { ...after, nodes: [changed] };
		assert.equal(compactInteractionReadback(observation, baseline), observation);
	}
	const navigated = { ...after, documentGeneration: 2 };
	assert.equal(compactInteractionReadback(navigated, baseline), navigated);
	assert.equal(compactInteractionReadback(before, baseline), before, "the baseline must precede the new observation");
	assert.equal(compactInteractionReadback(after, undefined), after, "first readback, reconnect or restored tab has no baseline");
});
test("交互 ref 必须存在于最新 observation", () => {
	const node = { ref: "ax_3_42", role: "button", name: "Close" };
	assert.equal(observedInteractionNode([node], "ax_3_42"), node);
	assert.throws(() => observedInteractionNode([node], "ax_3_9371"), /stale or unavailable.*snapshot_visible/u);
	assert.throws(() => observedInteractionNode(undefined, "ax_3_42"), /stale or unavailable/u);
});
test("目标状态只读布尔与长度，且将未知与未变分开", () => {
	const element = (overrides = {}) => ({ isConnected: true, checked: false, disabled: false, value: "", validationMessage: "", ownerDocument: { activeElement: undefined }, getAttribute: (name) => (name === "aria-expanded" ? "false" : null), ...overrides });
	const before = readInteractionTargetState.call(element());
	assert.deepEqual(before, { connected: true, checked: false, expanded: false, disabled: false, focused: false, valueLength: 0, valid: true });
	const after = readInteractionTargetState.call(element({ checked: true, value: "hunter2", validationMessage: "请填写密码", getAttribute: (name) => (name === "aria-expanded" ? "true" : null) }));
	assert.equal(JSON.stringify(after).includes("hunter2"), false, "目标状态不得回传输入内容");
	assert.equal(JSON.stringify(after).includes("请填写密码"), false, "校验文案只能走 readback 节点的脱敏路径");
	assert.deepEqual(interactionTargetChange(before, after), { changed: true, transitions: ["checked=false→true", "expanded=false→true", "valueLength=0→7", "valid=true→false"] });
	assert.deepEqual(interactionTargetChange(before, undefined), { changed: null, transitions: [] }, "读不到状态是 unknown，不是未变");
	assert.deepEqual(interactionTargetChange(before, { ...before, focused: true }), { changed: false, transitions: ["focused=false→true"] }, "点击自带的聚焦是机械后果，不能当成页面反应");
	const removed = readInteractionTargetState.call(element({ isConnected: false }));
	assert.deepEqual(interactionTargetChange(before, removed), { changed: true, transitions: ["connected=true→false"] });
	assert.deepEqual(readInteractionTargetState.call({ isConnected: true, getAttribute: () => { throw new Error("detached"); } }), { connected: true }, "getter 抛错的字段必须缺省为未知");
});
test("expect 只接受固定判据，并保留 met/unmet/unknown 三态", () => {
	assert.equal(parseInteractionExpectation(undefined), undefined);
	assert.deepEqual(parseInteractionExpectation("checked=true"), { requested: "checked=true", field: "checked", operator: "true" });
	assert.deepEqual(parseInteractionExpectation("value=nonempty"), { requested: "value=nonempty", field: "valueLength", operator: "nonempty" });
	for (const invalid of ["", "checked", "checked=maybe", "value=12", "innerText=hi", "document.title", "x".repeat(33)])
		assert.throws(() => parseInteractionExpectation(invalid), /interaction expect must be/u);
	assert.deepEqual(evaluateInteractionExpectation(parseInteractionExpectation("checked=true"), { checked: true }), { requested: "checked=true", outcome: "met" });
	assert.deepEqual(evaluateInteractionExpectation(parseInteractionExpectation("checked=true"), { checked: false }), { requested: "checked=true", outcome: "unmet" });
	assert.deepEqual(evaluateInteractionExpectation(parseInteractionExpectation("checked=true"), {}), { requested: "checked=true", outcome: "unknown" }, "目标不报该字段时不能压成 unmet");
	assert.deepEqual(evaluateInteractionExpectation(parseInteractionExpectation("checked=true"), undefined), { requested: "checked=true", outcome: "unknown" });
	assert.deepEqual(evaluateInteractionExpectation(parseInteractionExpectation("value=nonempty"), { valueLength: 11 }), { requested: "value=nonempty", outcome: "met" });
	assert.deepEqual(evaluateInteractionExpectation(parseInteractionExpectation("value=empty"), { valueLength: 11 }), { requested: "value=empty", outcome: "unmet" });
	assert.equal(evaluateInteractionExpectation(undefined, { checked: true }), undefined);
});
test("页面提示收集只读、有界，且覆盖原生校验消息", () => {
	let validityChecks = 0;
	const node = (overrides) => ({ getClientRects: () => [{}], getAttribute: () => null, ...overrides });
	const control = node({ willValidate: true, validity: { valid: false }, validationMessage: "请填写 11 位手机号", checkValidity: () => { validityChecks += 1; return false; } });
	const alerts = collectPageAlerts({
		document: {
			querySelectorAll: (selector) => (selector.includes("role=\"alert\"") ? [node({ innerText: "  提交失败\n请稍后重试  " }), node({ innerText: "提交失败 请稍后重试" }), node({ getClientRects: () => [], innerText: "隐藏提示" })] : [control]),
			getElementById: () => undefined,
		},
		frames: { length: 0 },
	});
	assert.deepEqual(alerts, ["提交失败 请稍后重试", "请填写 11 位手机号"]);
	assert.equal(validityChecks, 0, "不得调用 checkValidity：它会在被观察页面上派发 invalid 事件");
	const built = pageAlertNodes(3, [{ scopeId: "r", alerts: ["A", "A", "B"] }, { scopeId: "f2", alerts: ["C"] }, { scopeId: "bogus", alerts: ["D"] }]);
	assert.deepEqual(built.nodes.map((entry) => [entry.ref, entry.role, entry.name, entry.states]), [["alert_3_r_1", "page-alert", "A", ["read-only=true"]], ["alert_3_r_2", "page-alert", "B", ["read-only=true"]], ["alert_3_f2_3", "page-alert", "C", ["read-only=true"]]]);
	assert.equal(built.truncated, false);
	const overflow = pageAlertNodes(1, [{ scopeId: "r", alerts: Array.from({ length: 12 }, (_, index) => `alert ${index}`) }]);
	assert.deepEqual([overflow.nodes.length, overflow.truncated], [8, true]);
	assert.throws(() => pageAlertNodes(0, []), /generation invalid/u);
});
test("scroll target 优先选择 anchor 最近的纵向滚动祖先并保留 document fallback", () => {
	const documentScroller = { nodeType: 1, scrollHeight: 2000, clientHeight: 800 };
	const document = {
		nodeType: 9,
		scrollingElement: documentScroller,
		documentElement: documentScroller,
		defaultView: { getComputedStyle: (element) => ({ overflowY: element.overflowY ?? "visible" }) },
	};
	const nestedScroller = { nodeType: 1, ownerDocument: document, parentElement: null, overflowY: "auto", scrollHeight: 900, clientHeight: 200 };
	const row = { nodeType: 1, ownerDocument: document, parentElement: nestedScroller, overflowY: "visible", scrollHeight: 40, clientHeight: 40 };
	assert.equal(interactionScrollTarget.call(row), nestedScroller);
	nestedScroller.scrollHeight = 200;
	assert.equal(interactionScrollTarget.call(row), documentScroller, "不可滚动的 auto 容器必须回退 document");
	nestedScroller.scrollHeight = 900;
	nestedScroller.overflowY = "hidden";
	assert.equal(interactionScrollTarget.call(row), documentScroller, "hidden 容器不能冒充用户可滚动区域");
	assert.equal(interactionScrollTarget.call(document), documentScroller);
	const frameScroller = { nodeType: 1, overflowY: "auto", scrollHeight: 1200, clientHeight: 300, parentElement: null };
	const frameRow = { nodeType: 1, parentElement: frameScroller };
	const frameDocument = {
		nodeType: 9,
		body: frameRow,
		defaultView: { innerWidth: 800, innerHeight: 600, getComputedStyle: (element) => ({ overflowY: element.overflowY ?? "visible" }) },
		elementFromPoint: () => frameRow,
	};
	frameScroller.ownerDocument = frameDocument;
	frameRow.ownerDocument = frameDocument;
	const iframe = { nodeType: 1, ownerDocument: document, contentDocument: frameDocument };
	document.defaultView.innerWidth = 1200;
	document.defaultView.innerHeight = 900;
	document.elementFromPoint = () => iframe;
	assert.equal(interactionScrollTarget.call(document), frameScroller, "无 targetRef 时必须下钻鼠标中心命中的同源 iframe 滚动容器");
	const shadowScroller = { nodeType: 1, ownerDocument: document, parentElement: null, overflowY: "scroll", scrollHeight: 600, clientHeight: 100 };
	const shadowRoot = { host: shadowScroller };
	const shadowRow = { nodeType: 1, ownerDocument: document, parentElement: null, getRootNode: () => shadowRoot };
	assert.equal(interactionScrollTarget.call(shadowRow), shadowScroller);
});
