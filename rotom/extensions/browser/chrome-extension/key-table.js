// Keyboard table for `browser_interact` keypress.
//
// Every key this relay can press is listed here. A key that is not in the table cannot be
// dispatched: there is no "press this raw string" path, and characters are never inserted
// with `Input.insertText` (that would fake a key without a key event).

export const BROWSER_KEY_MODIFIERS_V1 = ["Shift", "Control", "Alt", "Meta"];

/** CDP `Input.dispatchKeyEvent.modifiers` bit field. */
const MODIFIER_BITS_V1 = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const LETTERS = Array.from({ length: 26 }, (_, index) => String.fromCharCode(97 + index));
const DIGITS = Array.from({ length: 10 }, (_, index) => String(index));

/** key -> [code, windowsVirtualKeyCode, text or undefined]. */
const table = new Map();
for (const [index, letter] of LETTERS.entries()) table.set(letter, [`Key${letter.toUpperCase()}`, 65 + index, letter]);
for (const [index, digit] of DIGITS.entries()) table.set(digit, [`Digit${digit}`, 48 + index, digit]);
table.set("Enter", ["Enter", 13, "\r"]);
// Tab moves focus; inserting a tab character would be a different key.
table.set("Tab", ["Tab", 9, undefined]);
table.set("Escape", ["Escape", 27, undefined]);
table.set(" ", ["Space", 32, " "]);
table.set("Backspace", ["Backspace", 8, undefined]);
table.set("Delete", ["Delete", 46, undefined]);
table.set("Home", ["Home", 36, undefined]);
table.set("End", ["End", 35, undefined]);
table.set("PageUp", ["PageUp", 33, undefined]);
table.set("PageDown", ["PageDown", 34, undefined]);
table.set("ArrowLeft", ["ArrowLeft", 37, undefined]);
table.set("ArrowUp", ["ArrowUp", 38, undefined]);
table.set("ArrowRight", ["ArrowRight", 39, undefined]);
table.set("ArrowDown", ["ArrowDown", 40, undefined]);
for (let index = 1; index <= 12; index += 1) table.set(`F${index}`, [`F${index}`, 111 + index, undefined]);

/** The fixed whitelist, in a stable order for the tool schema. */
export const BROWSER_KEYS_V1 = Object.freeze([
	...LETTERS, ...DIGITS,
	" ", "Enter", "Tab", "Escape", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown",
	"ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown",
	...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
]);

export function isBrowserKeyV1(value) {
	return typeof value === "string" && table.has(value);
}

/** Canonical modifier list, or undefined when the input is invalid. */
export function normalizeModifiersV1(value) {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 4) return undefined;
	const seen = new Set();
	for (const modifier of value) {
		if (!BROWSER_KEY_MODIFIERS_V1.includes(modifier)) return undefined;
		if (seen.has(modifier)) return undefined;
		seen.add(modifier);
	}
	// Stable order keeps the audit digest and the dispatched bitmask identical for the
	// same logical modifier set.
	return BROWSER_KEY_MODIFIERS_V1.filter((modifier) => seen.has(modifier));
}

export function modifierBitmaskV1(modifiers = []) {
	let bits = 0;
	for (const modifier of modifiers) bits |= MODIFIER_BITS_V1[modifier] ?? 0;
	return bits;
}

/**
 * Build the CDP parameters for one key. `text` is present only when the key should insert
 * a character: a chorded key (Control/Alt/Meta) must not type, and Shift only changes the
 * character case for letters. Digits with Shift stay without text instead of guessing a
 * symbol layout.
 */
export function keyEventV1(key, modifiers = []) {
	const entry = table.get(key);
	if (!entry) return undefined;
	const [code, windowsVirtualKeyCode, printable] = entry;
	const shift = modifiers.includes("Shift");
	const chorded = modifiers.includes("Control") || modifiers.includes("Alt") || modifiers.includes("Meta");
	const text = printable === undefined || chorded ? undefined : shift && LETTERS.includes(printable) ? printable.toUpperCase() : shift ? undefined : printable;
	return {
		key: shift && LETTERS.includes(printable ?? "") ? printable.toUpperCase() : key,
		code,
		windowsVirtualKeyCode,
		modifiers: modifierBitmaskV1(modifiers),
		...(text === undefined ? {} : { text, unmodifiedText: text }),
	};
}
