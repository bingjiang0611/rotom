import { TIER_RANK, type AppTier } from "./catalog.ts";

/**
 * Which tier each model-facing action needs.
 *
 * Unknown names default to `full`: a new action must be classified before it can
 * run against a `click` or `view` app, which fails closed instead of opening a
 * narrower app to a new capability.
 */
export const ACTION_TIERS: Record<string, AppTier> = {
	// Observation only.
	find_roots: "view",
	observe_ui: "view",
	search_ui: "view",
	expand_ui: "view",
	inspect_ui: "view",
	read_text: "view",
	wait_for: "view",
	list_apps: "view",
	list_windows: "view",
	list_displays: "view",
	system_surface_list: "view",
	clipboard_get: "view",
	cu_status: "view",
	trace_export: "view",

	// Pointer-free control.
	press: "click",
	click: "click",
	scroll: "click",
	moveMouse: "click",
	hover: "click",
	select: "click",
	setChecked: "click",
	expand: "click",
	collapse: "click",
	scrollTo: "click",
	focus: "click",
	showMenu: "click",
	manage_app_launch: "click",
	manage_app_list: "view",
	manage_window_list: "view",
	manage_window_move: "click",
	manage_window_resize: "click",
	manage_window_minimize: "click",
	manage_window_restore: "click",
	manage_window_maximize: "click",
	manage_window_focus: "click",
	release: "click",
	// Taking the foreground (L4) is a write to the whole desktop, never a read.
	takeover: "full",

	// Text, keys, clipboard, destructive or numeric writes.
	setText: "full",
	typeText: "full",
	keypress: "full",
	drag: "full",
	clear: "full",
	setValue: "full",
	clipboard_set: "full",
	clipboard_clear: "full",
	clipboard_restore: "full",
	manage_app_quit: "full",
	manage_app_force_quit: "full",
};

/** `setText+press` style names take the strongest tier of their parts. */
export function requiredTier(actionName: string | undefined): AppTier {
	if (!actionName) return "full";
	const parts = actionName.split("+").map((part) => part.trim()).filter(Boolean);
	if (parts.length === 0) return "full";
	let tier: AppTier = "view";
	for (const part of parts) {
		const partTier = ACTION_TIERS[part] ?? "full";
		if (TIER_RANK[partTier] > TIER_RANK[tier]) tier = partTier;
	}
	return tier;
}

export function tierAllows(appTier: AppTier, actionName: string | undefined): boolean {
	return TIER_RANK[requiredTier(actionName)] <= TIER_RANK[appTier];
}

export function tierRefusal(appTier: AppTier, actionName: string): string {
	return `App tier '${appTier}' does not allow '${actionName}' (needs '${requiredTier(actionName)}'). Observe-only and click-only apps never receive text input, key presses or clipboard writes.`;
}
