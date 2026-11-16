import type { PolicyCheckInput, PolicyDecision, PolicyGate } from "../broker/policy.ts";
import type { TargetAppInfo } from "../broker/protocol.ts";
import { appPolicyKey, classifyApp, type AppIdentity, type AppTier } from "./catalog.ts";
import { defaultPolicyPath, defaultProjectPolicyPath, PolicyStore } from "./policy-store.ts";
import { tierAllows, tierRefusal } from "./tiers.ts";

export interface GateOptions {
	/** Fixed store (tests, single-project callers). */
	store?: PolicyStore;
	/** Global policy path when no store is injected. */
	globalPath?: string;
}

/**
 * Broker-side policy gate.
 *
 * Decisions are made in the broker, not in the model's process, so every agent
 * (main session, subagent, another Pi) gets the same answer for the same app.
 * Project files are applied per agent cwd and can only tighten the global file.
 * Actions never need an authorization card. Explicit deny/tier restrictions
 * still apply; automatic access does not persist a fabricated user grant.
 */
export function createPolicyGate(options: GateOptions): PolicyGate {
	const stores = new Map<string, PolicyStore>();
	const staticStore = options.store;
	const globalPath = options.globalPath ?? defaultPolicyPath();

	const storeFor = (cwd: string | undefined): PolicyStore => {
		if (staticStore) return staticStore;
		const projectPath = cwd ? defaultProjectPolicyPath(cwd) : "";
		const key = projectPath || "(none)";
		let store = stores.get(key);
		if (!store) {
			store = new PolicyStore({ globalPath, projectPath: projectPath || globalPath });
			stores.set(key, store);
		}
		return store;
	};

	return {
		check(input: PolicyCheckInput): PolicyDecision {
			const store = storeFor(input.cwd);
			const app = input.app;
			const configured = store.lookup(app, input.resourceKey);
			const tier: AppTier | "deny" = configured ?? "full";
			const appKey = appPolicyKey(app, input.resourceKey);
			const actionName = input.action?.name;

			if (tier === "deny") {
				return { tier: "view", requiresApproval: false, cacheKey: `${appKey}#denied`, denied: `${describeApp(app)} is denied by the user's Computer Use policy.` };
			}
			if (!tierAllows(tier, actionName)) {
				return { tier, requiresApproval: false, cacheKey: `${appKey}#tier`, denied: tierRefusal(tier, actionName ?? "(unknown action)") };
			}

			return {
				tier,
				requiresApproval: false,
				warning: classifyApp(app).warning,
				cacheKey: `${appKey}#tier`,
			};
		},
		foregroundGranted(app: TargetAppInfo | undefined, fallbackKey?: string, cwd?: string): boolean {
			const store = storeFor(cwd);
			// No foreground allowlist is required. Re-read policy so a paused
			// takeover cannot resume through a newly invalid policy file.
			store.invalidate();
			return !store.effective().error;
		},
		/** Persist the user's explicit foreground (L4) grant. */
		allowForeground(app: TargetAppInfo | undefined): void {
			(staticStore ?? storeFor(undefined)).allowForeground(app);
		},
		allowApp(app: TargetAppInfo | undefined, tier: AppTier): void {
			// "always" is a global grant; a project file may still tighten it later.
			(staticStore ?? storeFor(undefined)).allowApp(app, tier);
		},
		tierForApp(app: TargetAppInfo | undefined, fallbackKey: string): AppTier {
			const configured = (staticStore ?? storeFor(undefined)).lookup(app, fallbackKey);
			if (configured === "deny") return "view";
			return configured ?? "full";
		},
		describe(): Record<string, unknown> {
			return (staticStore ?? storeFor(undefined)).describe();
		},
	};
}

function describeApp(app: AppIdentity | undefined): string {
	return app?.appName ?? app?.bundleId ?? "This app";
}
