// 交互目标自身的状态证据。
//
// readback 正文能证明「页面动了」，但证明不了「这个控件变成了我要的样子」：勾选框、
// 下拉展开、受控输入把值回滚，三者都不改正文长度。所以写操作前后各读一次目标状态，
// 只回传布尔与长度，绝不回传输入内容——密码和验证码就填在这些控件里。
//
// 状态用**派发前解析到的同一个 JS 对象**读取，不重新按 ref 查找：元素被移除、被替换
// 本身就是强证据，重新查到一个长得一样的新元素会把这个信号抹掉。

/** 在页面里对目标元素求值（`this` = 元素）。必须自包含，因为它按 toString() 注入。 */
export function readInteractionTargetState() {
	const element = this;
	const attribute = (name) => {
		try {
			const value = element?.getAttribute?.(name);
			return typeof value === "string" ? value.slice(0, 16) : undefined;
		} catch { return undefined; }
	};
	const tristate = (own, name) => {
		if (typeof own === "boolean") return own;
		const value = attribute(name);
		return value === "true" ? true : value === "false" ? false : undefined;
	};
	let valueLength;
	try { if (typeof element?.value === "string") valueLength = element.value.length; } catch { /* 受控组件 getter 抛错时按未知处理 */ }
	let valid;
	try { if (typeof element?.validationMessage === "string") valid = element.validationMessage.length === 0; } catch { /* 非表单控件没有约束校验 */ }
	let focused;
	try { if (element?.ownerDocument) focused = element.ownerDocument.activeElement === element; } catch { /* 跨文档访问失败按未知处理 */ }
	const state = {
		connected: element?.isConnected === true,
		checked: tristate(typeof element?.checked === "boolean" ? element.checked : undefined, "aria-checked"),
		expanded: tristate(undefined, "aria-expanded"),
		selected: tristate(typeof element?.selected === "boolean" ? element.selected : undefined, "aria-selected"),
		disabled: tristate(typeof element?.disabled === "boolean" ? element.disabled : undefined, "aria-disabled"),
		focused,
		valueLength,
		valid,
	};
	for (const key of Object.keys(state)) if (state[key] === undefined) delete state[key];
	return state;
}

const TARGET_STATE_FIELDS = ["connected", "checked", "expanded", "selected", "disabled", "focused", "valueLength", "valid"];
const MAX_TRANSITIONS = 8;

/**
 * 目标状态差异。任一侧读不到就是 `changed: null`（未知），不是「没变」。
 * 焦点变化照实报告，但不参与判定：点击本身就会聚焦，那是动作的机械后果，
 * 不是页面对它的反应——把它算进去会让任何一次点击都「有效果」。
 */
export function interactionTargetChange(before, after) {
	if (!before || !after || typeof before !== "object" || typeof after !== "object") return { changed: null, transitions: [] };
	const transitions = [];
	for (const field of TARGET_STATE_FIELDS) {
		const from = before[field];
		const to = after[field];
		if (from === undefined || to === undefined || from === to) continue;
		if (transitions.length < MAX_TRANSITIONS) transitions.push(`${field}=${String(from)}→${String(to)}`);
	}
	return { changed: transitions.some((transition) => !transition.startsWith("focused=")), transitions };
}

const BOOLEAN_EXPECTATION_PATTERN = /^(checked|expanded|selected|disabled|connected|focused|valid)=(true|false)$/u;
const VALUE_EXPECTATION_PATTERN = /^value=(empty|nonempty)$/u;
// 消息写成英文并包含 "interaction"：它要穿过 relay 的错误白名单才能到达调用方，
// 否则会被压成一句无信息量的 "browser relay operation failed"。
export const INTERACTION_EXPECTATION_SYNTAX = "interaction expect must be checked|expanded|selected|disabled|connected|focused|valid=true|false or value=empty|nonempty";

/** 期望只接受一组固定判据：可判定、可解释，且不需要在页面里执行模型给的代码。 */
export function parseInteractionExpectation(value) {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length < 1 || value.length > 32) throw new Error(INTERACTION_EXPECTATION_SYNTAX);
	const booleanMatch = BOOLEAN_EXPECTATION_PATTERN.exec(value);
	if (booleanMatch) return { requested: value, field: booleanMatch[1], operator: booleanMatch[2] };
	const valueMatch = VALUE_EXPECTATION_PATTERN.exec(value);
	if (valueMatch) return { requested: value, field: "valueLength", operator: valueMatch[1] };
	throw new Error(INTERACTION_EXPECTATION_SYNTAX);
}

/** 满足、未满足、未知三态。读不到目标状态时是 unknown，不能压成 unmet。 */
export function evaluateInteractionExpectation(expectation, after) {
	if (!expectation) return undefined;
	const actual = after && typeof after === "object" ? after[expectation.field] : undefined;
	if (actual === undefined) return { requested: expectation.requested, outcome: "unknown" };
	if (expectation.field === "valueLength") return { requested: expectation.requested, outcome: (expectation.operator === "empty") === (actual === 0) ? "met" : "unmet" };
	return { requested: expectation.requested, outcome: (expectation.operator === "true") === (actual === true) ? "met" : "unmet" };
}
