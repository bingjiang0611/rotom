// Page dialog state. A JS dialog (alert/confirm/prompt/beforeunload) suspends the page's
// own event loop, so every other operation on that tab would hang or answer from a stale
// tree. The state is therefore remembered per tab and checked before anything is
// dispatched; only the operations that can resolve or leave the tab can still run.
//
// Memory only, like the console and network buffers: a dialog cannot outlive its tab,
// and a service-worker restart cannot resurrect one.

/** Longest page-supplied dialog text kept. */
export const MAX_DIALOG_MESSAGE_CHARS_V1 = 300;
/** Longest `defaultPrompt` kept. */
export const MAX_DIALOG_PROMPT_CHARS_V1 = 300;
/** Dialog types Chrome reports; anything else is not trusted into the record. */
export const DIALOG_TYPES_V1 = ["alert", "confirm", "prompt", "beforeunload"];
/** Operations that address the session's current tab when `tabName` is omitted. */
export const DIALOG_CURRENT_TAB_OPERATIONS_V1 = ["interact", "snapshot", "snapshot_visible", "read_full", "screenshot", "console", "network", "wait"];
/** Operations that still run while a dialog is open. */
export const DIALOG_EXEMPT_OPERATIONS_V1 = ["dialog", "tabs", "close", "recover"];

/** Truncate by code point so a split surrogate pair never reaches the model. */
export function truncateDialogTextV1(value, max) {
	if (typeof value !== "string") return { text: "", truncated: false };
	const points = [...value];
	if (points.length <= max) return { text: value, truncated: false };
	return { text: points.slice(0, max).join(""), truncated: true };
}

export function createDialogStateV1({ now = () => Date.now() } = {}) {
	const byTabId = new Map();
	const detail = (tabId, entry) => ({ tabId, ...entry });
	return {
		/** Record an opened dialog; returns the stored (truncated) record. */
		opened(tabId, params) {
			if (!Number.isInteger(tabId) || tabId < 0) return undefined;
			const type = DIALOG_TYPES_V1.includes(params?.type) ? params.type : "alert";
			const message = truncateDialogTextV1(params?.message, MAX_DIALOG_MESSAGE_CHARS_V1);
			const prompt = truncateDialogTextV1(params?.defaultPrompt, MAX_DIALOG_PROMPT_CHARS_V1);
			const entry = {
				type,
				message: message.text,
				...(message.truncated ? { messageTruncated: true } : {}),
				...(type === "prompt" ? { defaultPrompt: prompt.text } : {}),
				...(prompt.truncated ? { defaultPromptTruncated: true } : {}),
				// beforeunload is the one dialog that can lose unsaved work.
				sensitive: type === "beforeunload",
				openedAt: now(),
			};
			byTabId.set(tabId, entry);
			return detail(tabId, entry);
		},
		/** Forget the dialog; returns what was open, if anything. */
		closed(tabId) {
			const entry = byTabId.get(tabId);
			byTabId.delete(tabId);
			return entry === undefined ? undefined : detail(tabId, entry);
		},
		reset(tabId) { byTabId.delete(tabId); },
		/** The current dialog for a tab, or undefined. */
		get(tabId) { const entry = byTabId.get(tabId); return entry === undefined ? undefined : detail(tabId, entry); },
		/** Refusal object for a blocked operation, or undefined when it may run. */
		blocking(operation, tabId) {
			if (DIALOG_EXEMPT_OPERATIONS_V1.includes(operation)) return undefined;
			const entry = tabId === undefined ? undefined : byTabId.get(tabId);
			if (entry === undefined) return undefined;
			return { schemaVersion: 1, kind: "dialog-blocking", dialog: detail(tabId, entry) };
		},
		get size() { return byTabId.size; },
	};
}
