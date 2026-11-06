// Global user focus, shared by every agent that drives Chrome.
//
// Restoring "the tab the user was looking at" per operation is wrong once several
// agents run at once: each of them remembers a different pre-action focus. This
// coordinator keeps one record for the whole browser and updates it only for
// focus changes that no agent caused. Agent actions mark a short window, and any
// activation or window focus inside that window is treated as agent noise.
//
// The record is a best-effort hint: if the remembered tab or window is gone, the
// restore is a no-op, not an error.

export const AGENT_FOCUS_WINDOW_MS = 2_000;
/** chrome.windows.WINDOW_ID_NONE — "no window has focus". */
export const NO_FOCUS_WINDOW_ID = -1;

export function createFocusCoordinator({ now = Date.now, updateTab = async () => undefined, updateWindow = async () => undefined, windowIdOf = async () => undefined } = {}) {
	let focus;
	let agentUntil = 0;
	const isAgentActivity = () => now() < agentUntil;
	return {
		/** Called right before an agent dispatches something that steals focus. */
		markAgentActivity(ms = AGENT_FOCUS_WINDOW_MS) {
			agentUntil = Math.max(agentUntil, now() + ms);
		},
		isAgentActivity,
		/** Returns true when this activation became the user focus. */
		recordActivation({ tabId, windowId }) {
			if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) return false;
			if (isAgentActivity()) return false;
			focus = { ...focus, tabId, windowId, focused: focus?.focused ?? true };
			return true;
		},
		/** Returns true when this window focus change became the user focus. */
		recordWindowFocus(windowId) {
			if (!Number.isInteger(windowId)) return false;
			if (windowId === NO_FOCUS_WINDOW_ID) {
				// The user switched to another app; keep the last window so a restore
				// after `--headless`-style focus loss does not invent a target.
				if (focus) focus = { ...focus, focused: false };
				return false;
			}
			if (isAgentActivity()) return false;
			focus = { ...focus, windowId, focused: true };
			return true;
		},
		userFocus: () => (focus === undefined ? undefined : { ...focus }),
		/** Put the user back where they were: their tab, then their window on top. */
		async restore() {
			if (!focus) return { restored: false };
			let restoredTab = false;
			let restoredWindow = false;
			if (Number.isInteger(focus.tabId)) {
				try { await updateTab(focus.tabId); restoredTab = true; } catch { /* tab closed or moved */ }
			}
			if (Number.isInteger(focus.windowId) && focus.focused === true) {
				try { await updateWindow(focus.windowId); restoredWindow = true; } catch { /* window closed */ }
			}
			return { restored: restoredTab || restoredWindow, tabId: focus.tabId, windowId: focus.windowId };
		},
		/**
		 * Seed the record from the real active tab. `windowId` scopes it to the window
		 * the operation runs in; otherwise the last focused window is used.
		 */
		async observeActiveTab(windowId) {
			try {
				const active = await windowIdOf(windowId);
				if (Number.isInteger(active?.tabId) && Number.isInteger(active?.windowId)) {
					focus = { tabId: active.tabId, windowId: active.windowId, focused: active.focused === true };
				}
			} catch { /* no active tab is a valid state */ }
			return this.userFocus();
		},
	};
}
