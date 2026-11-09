import type { PolicyCheckInput, PolicyDecision, PolicyGate } from "../broker/policy.ts";
import type { TargetAppInfo } from "../broker/protocol.ts";
import { appPolicyKey, catalogueTierOf, classifyApp, type AppIdentity, type AppTier } from "./catalog.ts";
import { defaultPolicyPath, defaultProjectPolicyPath, PolicyStore } from "./policy-store.ts";
import { matchSensitiveAction } from "./sensitive.ts";
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
 * The model cannot answer its own card: approval requests travel to the nearest
 * UI-capable ancestor session.
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
			const tier: AppTier | "deny" = configured === "deny" ? "deny" : configured ?? catalogueTierOf(app);
			const appKey = appPolicyKey(app, input.resourceKey);
			const actionName = input.action?.name;

			if (tier === "deny") {
				return { tier: "view", requiresApproval: false, cacheKey: `${appKey}#denied`, denied: `${describeApp(app)} is denied by the user's Computer Use policy.` };
			}
			if (!tierAllows(tier, actionName)) {
				return { tier, requiresApproval: false, cacheKey: `${appKey}#tier`, denied: tierRefusal(tier, actionName ?? "(unknown action)") };
			}

			const effective = store.effective();
			const sensitive = effective.sensitive ? matchSensitiveAction(input.action) : undefined;
			const category = classifyApp(app);
			// A card authorizes an app by identity. Without one (e.g. a browser CDP
			// resource) there is nothing to persist, so the tier check stands alone.
			const identified = Boolean(app?.bundleId?.trim() || app?.appName?.trim());
			const requiresApproval = Boolean(sensitive) || (identified && configured === undefined);
			return {
				tier,
				requiresApproval,
				warning: category.warning,
				cacheKey: sensitive ? `${appKey}#sensitive:${sensitive.rule.id}` : `${appKey}#tier`,
			};
		},
		foregroundGranted(app: TargetAppInfo | undefined, fallbackKey?: string, cwd?: string): boolean {
			const store = storeFor(cwd);
			// A paused takeover must not resume on a cached, subsequently withdrawn
			// grant. Project policy can revoke it, but never grant it.
			store.invalidate();
			if (store.effective().error) return false;
			return store.hasForeground(app, fallbackKey);
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
			return configured ?? catalogueTierOf(app);
		},
		describe(): Record<string, unknown> {
			return (staticStore ?? storeFor(undefined)).describe();
		},
	};
}

function describeApp(app: AppIdentity | undefined): string {
	return app?.appName ?? app?.bundleId ?? "This app";
}
