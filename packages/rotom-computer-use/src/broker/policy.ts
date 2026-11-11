import { TAKEOVER_RESOURCE, type ActionIntent, type AppTier, type TargetAppInfo } from "./protocol.ts";

export interface PolicyCheckInput {
	agentId: string;
	resourceKey: string;
	app?: TargetAppInfo;
	action?: ActionIntent;
	/** Session working directory, so the broker can apply the tighter project policy. */
	cwd?: string;
}

export interface PolicyDecision {
	/** This approval is never cached or persisted as an app-wide grant. */
	requiresFreshApproval?: boolean;
	tier: AppTier;
	/** Shown on the approval card; present for high-risk app categories. */
	warning?: string;
	/** False when the tier already allows the action without asking the user. */
	requiresApproval: boolean;
	/** Set when the app is denied outright (policy `deny` or an unreadable policy file). */
	denied?: string;
	/** Stable identity used for the per-session approval cache. */
	cacheKey: string;
}

export interface PolicyGate {
	check(input: PolicyCheckInput): PolicyDecision;
	/** Persist a permanent grant ("始终允许"). */
	allowApp(app: TargetAppInfo | undefined, tier: AppTier): void;
	/** Effective tier without an action check, used when persisting a grant. */
	tierForApp(app: TargetAppInfo | undefined, fallbackKey: string): AppTier;
	/**
	 * True when the user allowed this app to take the foreground (L4).
	 *
	 * Taking the foreground is a bigger permission than writing to an app: the
	 * agent gets physical input and can reach whatever the app can reach. The grant
	 * lives in the user's policy file, so an agent cannot hand it to itself.
	 */
	foregroundGranted(app: TargetAppInfo | undefined, fallbackKey?: string, cwd?: string): boolean;
	describe(): Record<string, unknown>;
}

/** Foreground consent and the current project tier must both still authorize takeover. */
export function takeoverGrantValid(policy: PolicyGate, app: TargetAppInfo | undefined, agentId: string, cwd?: string): boolean {
	return policy.foregroundGranted(app, app?.bundleId ?? app?.appName, cwd)
		&& !policy.check({ agentId, resourceKey: TAKEOVER_RESOURCE, app, action: { name: "takeover" }, cwd }).denied;
}

export const permissivePolicy: PolicyGate = {
	check(input) {
		return { tier: "full", requiresApproval: false, cacheKey: input.app?.bundleId ?? input.app?.appName ?? input.resourceKey };
	},
	allowApp() {},
	tierForApp() {
		return "full";
	},
	foregroundGranted() {
		return true;
	},
	describe() {
		return { apps: {}, sensitive: false };
	},
};
