import assert from "node:assert/strict";
import test from "node:test";
import {
	matchSensitiveLabelV1,
	normalizeSensitiveLabelV1,
	readInteractionSensitivity,
	sensitivityFromFactsV1,
} from "./chrome-extension/sensitive-actions.js";
import {
	AUTO_APPROVE_LOCALHOST_V1,
	SENSITIVE_CONFIRM_ENV_V1,
	preflightSensitiveReasonV1,
	sanitizeSensitiveConfirmationV1,
	sensitiveAutoApprovedV1,
	sensitiveReasonTextV1,
} from "./sensitive-actions.ts";

test("sensitive: 词表命中中英文敏感名称，普通名称不命中", () => {
	for (const label of ["Submit", "Submit form", "提交订单", "Place order", "删除账号", "Send message", "立即支付", "Unsubscribe", "购买"]) {
		assert.ok(matchSensitiveLabelV1(label), `${label} 必须命中`);
	}
	for (const label of ["Cancel", "取消", "Helper text", "buyer name", "payload size", "Sender address", "Reading list", "", undefined]) {
		assert.equal(matchSensitiveLabelV1(label), undefined, `${String(label)} 不能命中`);
	}
});

test("sensitive: 归一化去掉大小写与多余空白后再匹配", () => {
	assert.equal(normalizeSensitiveLabelV1("  Submit   FORM \n"), "submit form");
	assert.equal(matchSensitiveLabelV1("SUBMIT FORM"), "submit");
	assert.equal(matchSensitiveLabelV1("提  交"), undefined, "中文词被拆开就不该命中");
	assert.equal(matchSensitiveLabelV1("　提交　订单　"), "提交", "全角空格必须被归一化");
});

test("sensitive: cc-* 字段所在的表单算支付表单，即使按钮写 Continue", () => {
	assert.deepEqual(sensitivityFromFactsV1({ name: "Continue", creditCardForm: true }), { reason: "payment-form", matchedWord: null });
	assert.deepEqual(sensitivityFromFactsV1({ name: "Next", creditCardForm: false }), undefined);
	assert.deepEqual(sensitivityFromFactsV1({ name: "Place order", creditCardForm: false }), { reason: "sensitive-name", matchedWord: "place order" });
	assert.equal(sensitivityFromFactsV1(undefined), undefined);
});

test("sensitive: 页面探针只读事实，不返回标签以外的内容", () => {
	// 探针在 Runtime.callFunctionOn 里以 `this` 绑定目标元素运行，这里用同一形状的假元素。
	const field = { getAttribute: (name) => (name === "autocomplete" ? "cc-number" : name === "aria-label" ? "Card number" : null), innerText: "", value: "", closest: () => null };
	assert.deepEqual(readInteractionSensitivity.call(field), { name: "Card number", creditCardForm: true });
	const button = { getAttribute: (name) => (name === "aria-label" ? "Pay now" : null), innerText: "Pay now", value: "", closest: () => ({ querySelectorAll: () => [{ getAttribute: () => "cc-csc" }] }) };
	assert.deepEqual(readInteractionSensitivity.call(button), { name: "Pay now", creditCardForm: true });
	const plain = { getAttribute: () => null, innerText: "Continue", value: "", closest: () => null };
	assert.deepEqual(readInteractionSensitivity.call(plain), { name: "Continue", creditCardForm: false });
	assert.deepEqual(readInteractionSensitivity.call(null), { name: "", creditCardForm: false });
	assert.equal(readInteractionSensitivity.toString().includes("matchSensitiveLabelV1"), false, "探针不能用模块作用域里的东西");
});

test("sensitive: auto-approve-localhost 只对 localhost 生效，其它值一律不放行", () => {
	assert.equal(sensitiveAutoApprovedV1({ origin: "http://127.0.0.1:8080", env: AUTO_APPROVE_LOCALHOST_V1 }), true);
	assert.equal(sensitiveAutoApprovedV1({ origin: "http://localhost:3000", env: AUTO_APPROVE_LOCALHOST_V1 }), true);
	assert.equal(sensitiveAutoApprovedV1({ origin: "http://[::1]:3000", env: AUTO_APPROVE_LOCALHOST_V1 }), true);
	// 非 localhost origin 上开关必须无效，哪怕名字里带 localhost。
	for (const origin of ["https://example.com", "https://localhost.example.com", "https://127.0.0.1.example.com/x", "http://127.0.0.2:8080", "https://sub.localhost", ""]) {
		assert.equal(sensitiveAutoApprovedV1({ origin, env: AUTO_APPROVE_LOCALHOST_V1 }), false, `${origin} 不能被自动放行`);
	}
	assert.equal(sensitiveAutoApprovedV1({ origin: undefined, env: AUTO_APPROVE_LOCALHOST_V1 }), false, "没有 origin 就不能自动放行");
	for (const env of [undefined, "", "auto-approve", "auto-approve-localhost ", "AUTO-APPROVE-LOCALHOST", "1"]) {
		assert.equal(sensitiveAutoApprovedV1({ origin: "http://127.0.0.1:8080", env }), false, `${String(env)} 不是有效开关`);
	}
	assert.equal(SENSITIVE_CONFIRM_ENV_V1, "ROTOM_BROWSER_CONFIRM");
});

test("sensitive: upload 与 beforeunload 在派发前就是已知敏感动作", () => {
	assert.equal(preflightSensitiveReasonV1({ action: "upload" }), "upload");
	assert.equal(preflightSensitiveReasonV1({ action: "dialog", dialogType: "beforeunload" }), "beforeunload");
	assert.equal(preflightSensitiveReasonV1({ action: "dialog", dialogType: "alert" }), undefined);
	assert.equal(preflightSensitiveReasonV1({ action: "click" }), undefined);
	assert.equal(preflightSensitiveReasonV1({ action: "scroll" }), undefined);
});

test("sensitive: relay 的 needs-confirmation 只按白名单字段解读", () => {
	const ok = sanitizeSensitiveConfirmationV1({ kind: "needs-confirmation", reason: "sensitive-name", matchedWord: "提交", origin: "https://example.test" });
	assert.deepEqual(ok, { reason: "sensitive-name", matchedWord: "提交", origin: "https://example.test" });
	assert.equal(sanitizeSensitiveConfirmationV1({ kind: "needs-confirmation", reason: "sensitive-name", matchedWord: "x".repeat(41) }).matchedWord, undefined, "过长的词不当证据");
	assert.equal(sanitizeSensitiveConfirmationV1({ kind: "needs-confirmation", reason: "whatever" }), undefined);
	assert.equal(sanitizeSensitiveConfirmationV1({ kind: "browser-interaction-result" }), undefined);
	assert.equal(sanitizeSensitiveConfirmationV1(undefined), undefined);
	// 页面自己的标签不回到模型：结果里没有 label 字段。
	assert.equal("label" in sanitizeSensitiveConfirmationV1({ kind: "needs-confirmation", reason: "payment-form", label: "Card holder" }), false);
	assert.match(sensitiveReasonTextV1({ reason: "sensitive-name", matchedWord: "提交" }), /提交/u);
	assert.match(sensitiveReasonTextV1({ reason: "payment-form" }), /cc-\*/u);
});
