import type { ActionIntent, TargetAppInfo } from "../broker/protocol.ts";

/**
 * What a tool asks the broker for, built in one place.
 *
 * The resource key decides who has to wait for whom, and the action name decides
 * which tier the policy gate requires and whether a sensitive rule forces a
 * confirmation card. Both used to be spelled inline in `bridge.ts`, where a small
 * edit could silently drop the app identity (and with it the approval card) while
 * every test still passed. Keeping them here makes them the behavior under test.
 */
export interface WriteIntent {
	resourceKey: string;
	action: ActionIntent;
	app?: TargetAppInfo;
}

/** The clipboard is one shared resource, independent of the app in focus. */
export function clipboardIntent(action: "get" | "set" | "clear"): WriteIntent {
	return {
		resourceKey: "clipboard:system",
		action: { name: `clipboard_${action}`, label: "System clipboard" },
		// Named so the gate can still show which app a card is about; the clipboard
		// has no bundle identifier, so the tier check stands alone for it.
		app: { appName: "System Clipboard" },
	};
}

/**
 * An application is its own resource, keyed by identity when the tool knows it.
 *
 * A forced quit gets its own action name on purpose: the helper kills the process
 * instead of asking it, so it must be distinguishable from a normal quit even
 * after the user granted the app "always".
 */
export function appIntent(action: "launch" | "quit", app: TargetAppInfo | undefined, pid?: number, forced = false): WriteIntent {
	const forcedQuit = action === "quit" && forced;
	const name = forcedQuit ? "manage_app_force_quit" : `manage_app_${action}`;
	const target = app?.appName ?? app?.bundleId ?? "application";
	return {
		resourceKey: app ? `app:${app.bundleId ?? app.appName}` : `desktop-pid:${pid ?? 0}`,
		// The label is what the user reads on the card and what the sensitive rules
		// match, so a forced quit says so instead of borrowing the app's name.
		action: { name, label: forcedQuit ? `Force quit ${target}` : target },
		...(app ? { app } : {}),
	};
}

/** Window mutations belong to the owning process, not to the window. */
export function windowIntent(action: "move" | "resize" | "minimize" | "restore" | "maximize" | "focus", pid: number, windowId: number, app: TargetAppInfo | undefined): WriteIntent {
	return {
		resourceKey: `desktop-pid:${pid}`,
		action: { name: `manage_window_${action}`, label: `window ${windowId}` },
		...(app ? { app } : {}),
	};
}
