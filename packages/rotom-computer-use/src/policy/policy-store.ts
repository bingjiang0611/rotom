import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePrivateDir, UnsafePathError } from "../broker/paths.ts";
import { classifyApp, isAppTier, TIER_RANK, type AppIdentity, type AppTier } from "./catalog.ts";

export type PolicyGrant = AppTier | "deny";

export interface ParsedPolicy {
	/** Keyed by bundle id or app name. */
	apps: Record<string, PolicyGrant>;
	sensitive: boolean;
	error?: string;
	path?: string;
}

export const POLICY_VERSION = 1;

/** Path override for isolated setups and tests, like ROTOM_CU_BROKER_SOCKET. */
export const POLICY_PATH_ENV = "ROTOM_CU_POLICY";

export function defaultPolicyPath(environment: NodeJS.ProcessEnv = process.env): string {
	const configured = environment[POLICY_PATH_ENV]?.trim();
	return configured ? path.resolve(configured) : path.join(os.homedir(), ".rotom", "computer-use", "policy.json");
}

export function defaultProjectPolicyPath(cwd: string): string {
	return path.join(cwd, ".pi", "computer-use.json");
}

export function readPolicyFile(filePath: string): ParsedPolicy | undefined {
	if (!existsSync(filePath)) return undefined;
	if (lstatSync(filePath).isSymbolicLink()) throw new UnsafePathError(`${filePath} is a symlink; refusing to read policy from it.`);
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (error) {
		return { apps: {}, sensitive: true, error: `Cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`, path: filePath };
	}
	try {
		const parsed = JSON.parse(raw) as { v?: number; apps?: Record<string, unknown>; sensitive?: unknown };
		const apps: Record<string, PolicyGrant> = {};
		for (const [key, value] of Object.entries(parsed.apps ?? {})) {
			if (value === "deny") apps[key] = "deny";
			else if (isAppTier(value)) apps[key] = value;
			else if (value && typeof value === "object") {
				const tier = (value as { tier?: unknown }).tier;
				if (isAppTier(tier)) apps[key] = tier;
			}
		}
		return { apps, sensitive: parsed.sensitive !== false, path: filePath };
	} catch (error) {
		// An unreadable policy must not silently widen access.
		return { apps: {}, sensitive: true, error: `Cannot parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`, path: filePath };
	}
}

function tighten(left: PolicyGrant | undefined, right: PolicyGrant | undefined): PolicyGrant | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	if (left === "deny" || right === "deny") return "deny";
	return TIER_RANK[left] <= TIER_RANK[right] ? left : right;
}

/**
 * Project policy may only tighten the global one.
 *
 * A project entry can narrow an existing grant or deny an app; it can never
 * introduce a grant the user did not already make in `policy.json`.
 */
export function mergePolicies(base: ParsedPolicy | undefined, overlay: ParsedPolicy | undefined): ParsedPolicy {
	const apps: Record<string, PolicyGrant> = {};
	for (const key of new Set([...Object.keys(base?.apps ?? {}), ...Object.keys(overlay?.apps ?? {})])) {
		const globalGrant = base?.apps[key];
		const projectGrant = overlay?.apps[key];
		if (globalGrant === undefined) {
			// Denials are always narrowing; anything else here would widen access.
			if (projectGrant === "deny") apps[key] = "deny";
			continue;
		}
		const merged = tighten(globalGrant, projectGrant);
		if (merged) apps[key] = merged;
	}
	return {
		apps,
		sensitive: (base?.sensitive ?? true) && (overlay?.sensitive ?? true),
		error: [base?.error, overlay?.error].filter(Boolean).join("; ") || undefined,
	};
}

export interface PolicyStoreOptions {
	globalPath?: string;
	projectPath?: string;
}

/**
 * Effective app policy.
 *
 * `always` decisions live in the user's `policy.json` (0600, symlink refused),
 * project files can only narrow them, and an unreadable file yields no grants
 * plus an error, so every app falls back to asking the user.
 */
export class PolicyStore {
	readonly globalPath: string;
	readonly projectPath: string;
	private cached: ParsedPolicy | undefined;

	constructor(options: PolicyStoreOptions = {}) {
		this.globalPath = options.globalPath ?? defaultPolicyPath();
		this.projectPath = options.projectPath ?? defaultProjectPolicyPath(process.cwd());
	}

	effective(): ParsedPolicy {
		if (this.cached) return this.cached;
		const merged = mergePolicies(readPolicyFile(this.globalPath), readPolicyFile(this.projectPath));
		this.cached = merged;
		return merged;
	}

	invalidate(): void {
		this.cached = undefined;
	}

	/** Configured grant for an app, if any; project entries already merged. */
	lookup(app: AppIdentity | undefined, fallback: string): PolicyGrant | undefined {
		const policy = this.effective();
		const keys = [app?.bundleId?.trim(), app?.appName?.trim(), fallback].filter((key): key is string => Boolean(key));
		for (const key of keys) {
			const grant = policy.apps[key];
			if (grant) return grant;
		}
		return undefined;
	}

	/**
	 * Persist an "always allow" decision at the catalogue tier.
	 * Tightening a known entry is allowed; widening it is not.
	 */
	allowApp(app: AppIdentity | undefined, tier: AppTier): void {
		const key = app?.bundleId?.trim() || app?.appName?.trim();
		if (!key) throw new Error("Cannot persist a grant without a bundle id or app name.");
		const existing = readPolicyFile(this.globalPath) ?? { apps: {}, sensitive: true };
		const current = existing.apps[key];
		if (current === "deny") throw new Error(`${key} is denied by policy; remove that entry before granting it.`);
		if (current === undefined || TIER_RANK[tier] < TIER_RANK[current]) existing.apps[key] = tier;
		this.writeGlobal(existing);
		this.cached = undefined;
	}

	describe(): Record<string, unknown> {
		const policy = this.effective();
		return { path: this.globalPath, projectPath: this.projectPath, apps: policy.apps, sensitive: policy.sensitive, error: policy.error };
	}

	private writeGlobal(policy: ParsedPolicy): void {
		const directory = path.dirname(this.globalPath);
		ensurePrivateDir(directory);
		if (existsSync(this.globalPath)) {
			if (lstatSync(this.globalPath).isSymbolicLink()) throw new UnsafePathError(`${this.globalPath} is a symlink; refusing to write policy through it.`);
			chmodSync(this.globalPath, 0o600);
		}
		const payload = JSON.stringify({ v: POLICY_VERSION, sensitive: policy.sensitive, apps: sortRecord(policy.apps) }, null, 2);
		const temporary = `${this.globalPath}.${process.pid}.tmp`;
		writeFileSync(temporary, `${payload}\n`, { mode: 0o600 });
		renameSync(temporary, this.globalPath);
		chmodSync(this.globalPath, 0o600);
	}
}

function sortRecord(record: Record<string, PolicyGrant>): Record<string, PolicyGrant> {
	const sorted: Record<string, PolicyGrant> = {};
	for (const key of Object.keys(record).sort()) sorted[key] = record[key];
	return sorted;
}

/** Catalogue tier for an app, before any policy override. */
export function catalogueTier(app: AppIdentity | undefined): AppTier {
	return classifyApp(app).tier;
}
