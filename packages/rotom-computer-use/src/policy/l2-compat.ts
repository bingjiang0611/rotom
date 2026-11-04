/**
 * Apps that may receive window-targeted (L2) background input.
 *
 * L2 delivers synthetic events straight to the target process, so the system
 * cursor never moves and the frontmost app never changes — but only apps whose
 * input handling actually accepts that path work with it. Everything else must
 * be listed here only after the compatibility matrix in
 * `docs/agent/computer-use-v2/COMPATIBILITY.md` shows real success, and any app
 * that is not listed keeps `foreground_required` instead of a silent fallback.
 *
 * Start state (PLAN §6): IntelliJ only, which already ships a verified exact
 * background text channel.
 */
export const L2_COMPATIBLE_BUNDLE_IDS: ReadonlySet<string> = new Set(["com.jetbrains.intellij", "com.jetbrains.intellij.ce"]);

export const L2_ENV = "ROTOM_CU_L2";

export type L2Decision = { allowed: true } | { allowed: false; reason: string };

/** `ROTOM_CU_L2=0` forces every app back to pid-targeted posting. */
export function l2Enabled(environment: NodeJS.ProcessEnv = process.env): boolean {
	const value = environment[L2_ENV]?.trim().toLowerCase();
	return !(value === "0" || value === "false" || value === "off" || value === "no");
}

/** Whether this app may use targeted background input. */
export function l2DeliveryFor(bundleId: string | undefined, appName?: string): L2Decision {
	if (!bundleId) {
		return { allowed: false, reason: `'${appName ?? "Unknown app"}' has no bundle identifier, so targeted delivery cannot be verified` };
	}
	if (L2_COMPATIBLE_BUNDLE_IDS.has(bundleId)) return { allowed: true };
	return {
		allowed: false,
		reason: `'${appName ?? bundleId}' is not on the L2 compatibility list yet, so this action needs the foreground`,
	};
}

/** Delivery mode for a background action against this app. */
export function backgroundDelivery(bundleId: string | undefined, appName?: string): "l2" | "pid" {
	if (!l2Enabled()) return "pid";
	return l2DeliveryFor(bundleId, appName).allowed ? "l2" : "pid";
}
