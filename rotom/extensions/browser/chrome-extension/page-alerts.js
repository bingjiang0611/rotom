// 页面提示与表单校验错误。
//
// 表单流程最主要的失败模式是被校验拦下，而错误常在长页面下方或浮层里：交互 readback
// 只截取有界正文时，「已提交」和「被拦下」在模型眼里长得一模一样。原生
// `validationMessage` 更进一步——它根本不在 accessibility tree 里，全文快照也看不到。
//
// 只读不动页面：用 `validity.valid` 而不是 `checkValidity()`，后者会在页面上派发
// `invalid` 事件，那是对被观察页面的副作用。

export const MAX_PAGE_ALERTS = 8;
const MAX_ALERT_CHARS = 200;

/** 在页面里求值。必须自包含（含界限常量），因为它按 toString() 注入。 */
export function collectPageAlerts(rootWindow = window) {
	const maxAlerts = 8;
	const maxChars = 200;
	const selector = '[role="alert"],[role="alertdialog"],[role="status"],[aria-live="assertive"],[aria-live="polite"],output,[aria-invalid="true"]';
	const alerts = [];
	const seen = new Set();
	const push = (candidate) => {
		if (alerts.length >= maxAlerts || typeof candidate !== "string") return;
		const value = candidate.replace(/\s+/gu, " ").trim().slice(0, maxChars);
		if (!value || seen.has(value)) return;
		seen.add(value);
		alerts.push(value);
	};
	const messageOf = (element) => {
		try { if (typeof element.validationMessage === "string" && element.validationMessage) return element.validationMessage; } catch { /* 非表单控件 */ }
		try {
			const errorMessageId = element.getAttribute?.("aria-errormessage");
			const described = errorMessageId ? element.ownerDocument?.getElementById(errorMessageId) : undefined;
			if (described && typeof described.innerText === "string" && described.innerText.trim()) return described.innerText;
		} catch { /* 引用不存在 */ }
		try { return typeof element.innerText === "string" ? element.innerText : undefined; } catch { return undefined; }
	};
	const visit = (candidate) => {
		let document;
		try { document = candidate.document; } catch { return; }
		if (!document) return;
		let announced = [];
		try { announced = document.querySelectorAll(selector); } catch { announced = []; }
		for (const element of announced) {
			if (alerts.length >= maxAlerts) return;
			let rendered = true;
			try { rendered = Boolean(element.getClientRects?.().length); } catch { /* 无法测量时按可见处理 */ }
			if (!rendered) continue;
			push(messageOf(element));
		}
		let controls = [];
		try { controls = document.querySelectorAll("input,select,textarea"); } catch { controls = []; }
		for (const control of controls) {
			if (alerts.length >= maxAlerts) return;
			try {
				if (control.willValidate !== true || control.validity?.valid !== false) continue;
				push(typeof control.validationMessage === "string" ? control.validationMessage : undefined);
			} catch { /* 受控组件访问失败时跳过 */ }
		}
		let frames = 0;
		try { frames = candidate.frames.length; } catch { return; }
		for (let index = 0; index < frames; index += 1) {
			if (alerts.length >= maxAlerts) return;
			try { visit(candidate.frames[index]); } catch { /* 跨源 frame 由它自己的 CDP session 收集 */ }
		}
	};
	visit(rootWindow);
	return alerts;
}

/** 提示按只读 observation 节点回传，走与正文相同的脱敏和界限；ref 前缀与可交互 ref 不同族。 */
export function pageAlertNodes(documentGeneration, sources, maxNodes = MAX_PAGE_ALERTS) {
	if (!Number.isSafeInteger(documentGeneration) || documentGeneration < 1) throw new Error("page alert generation invalid");
	const limit = Math.max(1, Math.min(Number(maxNodes) || MAX_PAGE_ALERTS, MAX_PAGE_ALERTS));
	const nodes = [];
	const seen = new Set();
	let truncated = false;
	for (const source of Array.isArray(sources) ? sources : []) {
		const scopeId = source?.scopeId === "r" || /^f[1-9]\d*$/u.test(String(source?.scopeId)) ? source.scopeId : undefined;
		if (!scopeId) continue;
		for (const alert of Array.isArray(source.alerts) ? source.alerts : []) {
			if (typeof alert !== "string" || !alert.trim()) continue;
			const name = alert.slice(0, MAX_ALERT_CHARS);
			if (seen.has(name)) continue;
			if (nodes.length >= limit) { truncated = true; return { nodes, truncated }; }
			seen.add(name);
			nodes.push({ ref: `alert_${documentGeneration}_${scopeId}_${nodes.length + 1}`, role: "page-alert", name, states: ["read-only=true"] });
		}
	}
	return { nodes, truncated };
}
