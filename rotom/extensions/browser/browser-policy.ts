// Per-site browser authorization (T20).
//
// The lease decides what a *subagent* may touch; this decides what *any* agent may touch
// when the site has not been authorized yet. The order is fixed and testable: blocklist,
// then allowlist, then localhost, then ask the user. Nothing here talks to a browser, so
// every rule is unit-tested without a relay.

import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** Capabilities a policy entry can grant. */
export const BROWSER_POLICY_CAPABILITIES_V1 = ["read", "interact", "devtools", "upload", "download"] as const;
export type BrowserPolicyCapabilityV1 = (typeof BROWSER_POLICY_CAPABILITIES_V1)[number];

/** Largest policy file read or written. */
const BROWSER_POLICY_MAX_BYTES_V1 = 64 * 1024;
const MAX_POLICY_ENTRIES_V1 = 512;
const MAX_PATTERN_CHARS_V1 = 255;

export interface BrowserPolicyV1 {
	blocklist: string[];
	allowlist: Array<{ origin: string; capabilities: BrowserPolicyCapabilityV1[] }>;
}

export interface BrowserPolicyDecisionV1 {
	decision: "allow" | "deny" | "ask";
	reason: "blocklist" | "allowlist" | "localhost" | "unknown-origin";
	/** Canonical pattern that matched, for the ask/refusal text. */
	pattern?: string;
}

/** Env override for the policy file; tests and portable setups point it at their own file. */
export const BROWSER_POLICY_PATH_ENV_V1 = "ROTOM_BROWSER_POLICY_FILE" as const;

/** Default location: `<config dir>/rotom/browser-policy.json`. */
export function browserPolicyPathV1(home = homedir()): string {
	const override = process.env[BROWSER_POLICY_PATH_ENV_V1];
	if (typeof override === "string" && override.startsWith("/")) return override;
	return join(home, "Library", "Application Support", "rotom", "browser-policy.json");
}

/** Canonical origin, or undefined for a non-http(s)/malformed URL. */
export function policyOriginV1(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.origin;
	} catch { return undefined; }
}

/**
 * Normalize one policy pattern. Accepts an exact origin (`https://example.test:8443`) or a
 * wildcard host (`*.example.test`). A wildcard has no scheme, so it covers http and https.
 */
export function sanitizePolicyPatternV1(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return undefined;
	if (value.length > MAX_PATTERN_CHARS_V1) return undefined;
	if (value.startsWith("*.")) {
		const host = value.slice(2).toLowerCase();
		if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u.test(host)) return undefined;
		return `*.${host}`;
	}
	return policyOriginV1(value);
}

/** True when a canonical origin matches a policy pattern. */
export function policyMatchesOriginV1(pattern: string, origin: string): boolean {
	if (pattern === origin) return true;
	if (!pattern.startsWith("*.")) return false;
	let url: URL;
	try { url = new URL(origin); } catch { return false; }
	const host = url.hostname.toLowerCase();
	const suffix = pattern.slice(1); // ".example.test"
	// `*.example.test` means subdomains only. The apex needs its own entry so a wildcard
	// can never silently authorize a whole registered domain the user did not name.
	return host.endsWith(suffix) && host.length > suffix.length;
}

/** `localhost` and `127.0.0.1` are allowed for read/interact without asking. */
export function isLocalOriginV1(origin: string): boolean {
	let url: URL;
	try { url = new URL(origin); } catch { return false; }
	return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
}

/** Fixed order: blocklist, allowlist, localhost, ask. */
export function decideBrowserPolicyV1(policy: BrowserPolicyV1, input: { origin: string; capability: BrowserPolicyCapabilityV1 }): BrowserPolicyDecisionV1 {
	const { origin, capability } = input;
	const blocked = policy.blocklist.find((pattern) => policyMatchesOriginV1(pattern, origin));
	// A blocklist always wins, even for localhost: the user asked for it explicitly.
	if (blocked !== undefined) return { decision: "deny", reason: "blocklist", pattern: blocked };
	const allowed = policy.allowlist.find((entry) => policyMatchesOriginV1(entry.origin, origin) && entry.capabilities.includes(capability));
	if (allowed !== undefined) return { decision: "allow", reason: "allowlist", pattern: allowed.origin };
	if (isLocalOriginV1(origin) && (capability === "read" || capability === "interact")) return { decision: "allow", reason: "localhost", pattern: origin };
	return { decision: "ask", reason: "unknown-origin" };
}

function sanitizePolicyV1(value: unknown): BrowserPolicyV1 {
	const empty: BrowserPolicyV1 = { blocklist: [], allowlist: [] };
	if (value === undefined || value === null) return empty;
	if (typeof value !== "object" || Array.isArray(value)) throw new Error("browser policy 必须是对象");
	const raw = value as Record<string, unknown>;
	for (const key of Object.keys(raw)) if (key !== "blocklist" && key !== "allowlist" && key !== "schemaVersion") throw new Error(`browser policy 不接受字段 ${key}`);
	const blocklistRaw = raw.blocklist ?? [];
	const allowlistRaw = raw.allowlist ?? [];
	if (!Array.isArray(blocklistRaw) || !Array.isArray(allowlistRaw)) throw new Error("browser policy 的 blocklist/allowlist 必须是数组");
	if (blocklistRaw.length > MAX_POLICY_ENTRIES_V1 || allowlistRaw.length > MAX_POLICY_ENTRIES_V1) throw new Error("browser policy 条目过多");
	const blocklist = blocklistRaw.map((pattern) => {
		const safe = sanitizePolicyPatternV1(pattern);
		if (safe === undefined) throw new Error("browser policy blocklist 含非法 origin 或通配符");
		return safe;
	});
	const allowlist = allowlistRaw.map((entry) => {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("browser policy allowlist 条目必须是对象");
		const record = entry as Record<string, unknown>;
		const origin = sanitizePolicyPatternV1(record.origin);
		if (origin === undefined) throw new Error("browser policy allowlist 含非法 origin 或通配符");
		if (!Array.isArray(record.capabilities) || record.capabilities.length === 0) throw new Error("browser policy allowlist 条目缺少 capabilities");
		const capabilities: BrowserPolicyCapabilityV1[] = [];
		for (const capability of record.capabilities) {
			if (!BROWSER_POLICY_CAPABILITIES_V1.includes(capability as never)) throw new Error("browser policy allowlist 含未知 capability");
			if (!capabilities.includes(capability as BrowserPolicyCapabilityV1)) capabilities.push(capability as BrowserPolicyCapabilityV1);
		}
		return { origin, capabilities };
	});
	return { blocklist, allowlist };
}

/**
 * Read the policy. A missing file is an empty policy; a malformed or symlinked file is an
 * error, not an empty policy, because silently forgetting a blocklist would be worse.
 */
export async function readBrowserPolicyV1(path = browserPolicyPathV1()): Promise<BrowserPolicyV1> {
	let info;
	try { info = await lstat(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { blocklist: [], allowlist: [] };
		throw new Error("browser policy 无法读取");
	}
	if (info.isSymbolicLink()) throw new Error("browser policy 不能是符号链接");
	if (!info.isFile()) throw new Error("browser policy 不是普通文件");
	if ((info.mode & 0o077) !== 0) throw new Error("browser policy 权限过于宽松（需要 0600）");
	if (info.size > BROWSER_POLICY_MAX_BYTES_V1) throw new Error("browser policy 文件过大");
	return sanitizePolicyV1(JSON.parse(await readFile(path, "utf8")));
}

/** Atomically write the policy with 0600 permissions. Never follows a symlink. */
export async function writeBrowserPolicyV1(policy: BrowserPolicyV1, path = browserPolicyPathV1()): Promise<BrowserPolicyV1> {
	const sanitized = sanitizePolicyV1({ schemaVersion: 1, ...policy });
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const directoryInfo = await lstat(directory);
	if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("browser policy 目录不安全");
	const staging = join(directory, `.browser-policy.${randomUUID()}.tmp`);
	const handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try { await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, ...sanitized }, null, 2)}\n`, "utf8"); }
	finally { await handle.close(); }
	try {
		const existing = await lstat(path).catch(() => undefined);
		if (existing?.isSymbolicLink()) throw new Error("browser policy 不能是符号链接");
		await rename(staging, path);
	} catch (error) {
		await rm(staging, { force: true }).catch(() => undefined);
		throw error;
	}
	return sanitized;
}

/** Add one capability for one origin, merging with an existing entry. */
export async function grantBrowserPolicyV1(input: { origin: string; capability: BrowserPolicyCapabilityV1; path?: string }): Promise<BrowserPolicyV1> {
	const path = input.path ?? browserPolicyPathV1();
	const origin = sanitizePolicyPatternV1(input.origin);
	if (origin === undefined) throw new Error("不能把非法 origin 写入 browser policy");
	const policy = await readBrowserPolicyV1(path);
	const existing = policy.allowlist.find((entry) => entry.origin === origin);
	const allowlist = existing === undefined
		? [...policy.allowlist, { origin, capabilities: [input.capability] }]
		: policy.allowlist.map((entry) => (entry.origin === origin ? { origin, capabilities: entry.capabilities.includes(input.capability) ? entry.capabilities : [...entry.capabilities, input.capability] } : entry));
	return writeBrowserPolicyV1({ blocklist: policy.blocklist, allowlist }, path);
}
