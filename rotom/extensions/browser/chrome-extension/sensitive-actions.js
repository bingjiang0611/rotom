// Sensitive-action matching (T21).
//
// The page facts come from the renderer, the decision comes from here, and the user's
// answer comes from Pi. This module is deliberately plain data + pure functions so the
// same code can run inside the service worker and in Node tests.

/**
 * Names that make an interaction worth confirming. Chinese and English, because the
 * accessible name is whatever the site wrote.
 *
 * Containment is intentional: a button may read "Submit order" or "提交订单". ASCII words
 * match on a word boundary so "buy" does not match "buyer" and "pay" does not match
 * "payload"; CJK has no word boundaries, so those match as substrings.
 */
export const SENSITIVE_ACTION_WORDS_V1 = Object.freeze([
	"提交", "submit",
	"支付", "付款", "pay", "payment", "checkout", "结账", "购买", "buy", "purchase",
	"确认订单", "place order", "下单", "立即支付",
	"删除", "delete", "remove",
	"发送", "send",
	"转账", "transfer", "汇款",
	"授权", "authorize", "authorise", "grant access",
	"退订", "unsubscribe", "注销", "deactivate", "close account", "关闭账户",
	"重置", "reset", "发布", "publish", "发布订单",
]);

/** Lowercase, collapse whitespace, drop surrounding punctuation-ish space. */
export function normalizeSensitiveLabelV1(label) {
	if (typeof label !== "string") return "";
	return label.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim().slice(0, 200);
}

/** The first sensitive word the accessible name matches, if any. */
export function matchSensitiveLabelV1(label) {
	const normalized = normalizeSensitiveLabelV1(label);
	if (normalized === "") return undefined;
	for (const word of SENSITIVE_ACTION_WORDS_V1) {
		if (!/^[\x20-\x7e]+$/u.test(word)) {
			if (normalized.includes(word)) return word;
			continue;
		}
		// ASCII word: require a boundary so `pay` cannot match `payload`.
		const escaped = word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
		if (new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "u").test(normalized)) return word;
	}
	return undefined;
}

/**
 * Turn renderer facts into a confirmation request, or `undefined` when nothing is
 * sensitive. `creditCardForm` means the target is a `cc-*` autocomplete field or sits in
 * a form that has one — that is a payment form even when the button says "Continue".
 */
export function sensitivityFromFactsV1(facts) {
	if (!facts || typeof facts !== "object") return undefined;
	if (facts.creditCardForm === true) return { reason: "payment-form", matchedWord: null };
	const matchedWord = matchSensitiveLabelV1(facts.name);
	return matchedWord === undefined ? undefined : { reason: "sensitive-name", matchedWord };
}

/**
 * Page-side probe. Runs with `this` bound to the interaction target inside
 * `Runtime.callFunctionOn`, so it must not reference anything from module scope other
 * than its own literals. Returns facts only; the decision is made in the worker.
 */
export function readInteractionSensitivity() {
	try {
		const element = this;
		if (!element || typeof element.getAttribute !== "function") return { name: "", creditCardForm: false };
		const label = element.getAttribute("aria-label") || element.innerText || element.value || element.getAttribute("title") || "";
		let creditCardForm = /^cc-/iu.test(String(element.getAttribute("autocomplete") || ""));
		if (!creditCardForm && typeof element.closest === "function") {
			const form = element.closest("form");
			if (form) {
				creditCardForm = Array.from(form.querySelectorAll("[autocomplete]")).some((field) => /^cc-/iu.test(String(field.getAttribute("autocomplete") || "")));
			}
		}
		return { name: String(label).slice(0, 200), creditCardForm };
	} catch {
		return { name: "", creditCardForm: false };
	}
}
