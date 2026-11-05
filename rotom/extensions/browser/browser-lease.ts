// What a subagent is allowed to do in the browser.
//
// The parent's browser extension publishes a scope (its already-open origins plus
// the allow switches) into the environment the child inherits. A child with a
// lease token materializes that scope once as a private lease file and re-reads
// the file before every gated operation, so the parent can widen or narrow the
// lease by rewriting the file.
//
// A missing, unreadable, expired or non-matching lease is a structured
// `needs-approval` result, never a silently-allowed operation and never a prompt.

import { constants } from "node:fs";
import { access, lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export const BROWSER_LEASE_SCOPE_ENV_V1 = "ROTOM_BROWSER_LEASE_SCOPE" as const;
export const BROWSER_LEASE_MAX_BYTES = 8 * 1024;
const MAX_LEASE_ORIGINS = 64;
const MAX_LEASE_TOKEN_CHARS = 128;

/** Capabilities a lease can grant; everything else stays denied. */
export const BROWSER_LEASE_CAPABILITIES_V1 = ["open", "write", "devtools", "upload", "download"] as const;
export type BrowserLeaseCapabilityV1 = (typeof BROWSER_LEASE_CAPABILITIES_V1)[number];

export interface BrowserLeaseScopeV1 {
	rootSessionId: string;
	origins: string[];
	allow: { devtools: boolean; upload: boolean; download: boolean };
	maxTabs: number;
	keepTabs: boolean;
	expiresAt: number;
}

export interface BrowserLeaseV1 extends BrowserLeaseScopeV1 {
	token: string;
	/** Always the token: a lease names the one agent it was written for. */
	agentId: string;
}

export interface BrowserLeaseNeedsApprovalV1 {
	ok: false;
	kind: "needs-approval";
	origin: string;
	capability: BrowserLeaseCapabilityV1;
	reason: "expired" | "origin" | "capability" | "missing" | "invalid";
}

const tokenPattern = /^[A-Za-z0-9._:-]{1,128}$/u;

export function safeBrowserLeaseTokenV1(value: unknown): string | undefined {
	return typeof value === "string" && value.length <= MAX_LEASE_TOKEN_CHARS && tokenPattern.test(value) ? value : undefined;
}

/** Canonical origin, or undefined for a non-http(s) or malformed URL. */
export function leaseOriginV1(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.origin;
	} catch { return undefined; }
}

function leaseDirV1(relayDir: string): string {
	return join(relayDir, "leases");
}

function sanitizeScopeV1(value: unknown): BrowserLeaseScopeV1 | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.schemaVersion !== 1) return undefined;
	if (typeof raw.rootSessionId !== "string") return undefined;
	if (!Array.isArray(raw.origins) || raw.origins.length > MAX_LEASE_ORIGINS) return undefined;
	const origins = raw.origins.map((origin) => leaseOriginV1(origin));
	if (origins.some((origin) => origin === undefined)) return undefined;
	if (!raw.allow || typeof raw.allow !== "object" || Array.isArray(raw.allow)) return undefined;
	const allow = raw.allow as Record<string, unknown>;
	for (const key of ["devtools", "upload", "download"]) if (typeof allow[key] !== "boolean") return undefined;
	if (!Number.isSafeInteger(raw.maxTabs) || (raw.maxTabs as number) < 0) return undefined;
	if (typeof raw.keepTabs !== "boolean") return undefined;
	if (!Number.isFinite(raw.expiresAt)) return undefined;
	return {
		rootSessionId: raw.rootSessionId,
		origins: origins as string[],
		allow: { devtools: allow.devtools as boolean, upload: allow.upload as boolean, download: allow.download as boolean },
		maxTabs: raw.maxTabs as number,
		keepTabs: raw.keepTabs,
		expiresAt: raw.expiresAt as number,
	};
}

function sanitizeLeaseV1(value: unknown, token: string): BrowserLeaseV1 | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.kind !== "rotom-browser-lease" || raw.token !== token) return undefined;
	const scope = sanitizeScopeV1(value);
	if (!scope) return undefined;
	return { token, agentId: token, ...scope };
}

/**
 * Read the lease the parent wrote for this token. Returns undefined when there is
 * no usable lease: absent, unreadable, oversized, a symlink or a schema mismatch.
 */
export async function readBrowserLeaseV1(relayDir: string, token: string): Promise<BrowserLeaseV1 | undefined> {
	const safeToken = safeBrowserLeaseTokenV1(token);
	if (!safeToken) return undefined;
	const directory = leaseDirV1(relayDir);
	const file = join(directory, `${safeToken}.json`);
	try {
		const dirInfo = await lstat(directory);
		if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || (dirInfo.mode & 0o077) !== 0) return undefined;
		const info = await lstat(file);
		if (!info.isFile() || info.isSymbolicLink() || info.size > BROWSER_LEASE_MAX_BYTES) return undefined;
		if ((info.mode & 0o077) !== 0) return undefined;
		if (await realpath(file) !== join(await realpath(directory), `${safeToken}.json`)) return undefined;
		return sanitizeLeaseV1(JSON.parse(await readFile(file, "utf8")), safeToken);
	} catch { return undefined; }
}

/**
 * Write the lease file when it does not exist yet. Concurrent children of the same
 * run are the only writers, so the first wins and later ones reuse it.
 */
export async function materializeBrowserLeaseV1(relayDir: string, scope: string, token: string): Promise<BrowserLeaseV1 | undefined> {
	const safeToken = safeBrowserLeaseTokenV1(token);
	if (!safeToken) return undefined;
	if (Buffer.byteLength(scope, "utf8") > BROWSER_LEASE_MAX_BYTES) return undefined;
	let parsed: unknown;
	try { parsed = JSON.parse(scope); } catch { return undefined; }
	const sanitized = sanitizeScopeV1(parsed);
	if (!sanitized) return undefined;
	const directory = leaseDirV1(relayDir);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("browser lease directory 权限不安全");
	const file = join(directory, `${safeToken}.json`);
	try {
		await access(file);
		return readBrowserLeaseV1(relayDir, safeToken);
	} catch { /* write it below */ }
	const lease = { schemaVersion: 1, kind: "rotom-browser-lease", token: safeToken, agentId: safeToken, ...sanitized };
	const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try { await handle.writeFile(`${JSON.stringify(lease)}\n`, "utf8"); }
	finally { await handle.close(); }
	return readBrowserLeaseV1(relayDir, safeToken);
}

/**
 * Decide one gated operation. `undefined` lease means this session has no lease at
 * all (the main agent): callers must not treat that as approval for a child.
 */
export function checkBrowserLeaseV1(lease: BrowserLeaseV1 | undefined, input: { origin: string | undefined; capability: BrowserLeaseCapabilityV1; now?: number }): { ok: true } | BrowserLeaseNeedsApprovalV1 {
	const capability = input.capability;
	if (!lease) return { ok: false, kind: "needs-approval", origin: input.origin ?? "", capability, reason: "missing" };
	const now = input.now ?? Date.now();
	const origin = input.origin ?? "";
	if (!(lease.expiresAt > now)) return { ok: false, kind: "needs-approval", origin, capability, reason: "expired" };
	if (capability === "devtools" && !lease.allow.devtools) return { ok: false, kind: "needs-approval", origin, capability, reason: "capability" };
	if (capability === "upload" && !lease.allow.upload) return { ok: false, kind: "needs-approval", origin, capability, reason: "capability" };
	if (capability === "download" && !lease.allow.download) return { ok: false, kind: "needs-approval", origin, capability, reason: "capability" };
	if (origin === "") return { ok: false, kind: "needs-approval", origin, capability, reason: "origin" };
	if (!lease.origins.includes(origin)) return { ok: false, kind: "needs-approval", origin, capability, reason: "origin" };
	return { ok: true };
}

/** Load the lease for one tool call: token from env, scope inherited from the parent. */
export async function loadBrowserLeaseForCallV1(input: { relayDir: string; token: string | undefined; scope: string | undefined }): Promise<BrowserLeaseV1 | undefined> {
	const token = safeBrowserLeaseTokenV1(input.token);
	if (!token) return undefined;
	const existing = await readBrowserLeaseV1(input.relayDir, token);
	if (existing) return existing;
	if (input.scope === undefined) return undefined;
	return materializeBrowserLeaseV1(input.relayDir, input.scope, token).catch(() => undefined);
}

/**
 * Give one origin to every child lease of this run (T20).
 *
 * The parent cannot see which child asked; it only knows its own root session and the
 * lease directory. When the user authorizes an origin for the parent, the parent's
 * children get the same origin so a child that already reported `needs-approval` does not
 * have to ask again on the next call. Files that do not parse or do not belong to this
 * root session are left untouched, and rewrites are atomic with 0600.
 */
export async function widenChildLeasesV1(input: { relayDir: string; rootSessionId: string; origin: string; allow?: Partial<BrowserLeaseScopeV1["allow"]> }): Promise<{ updated: number; skipped: number }> {
	const origin = leaseOriginV1(input.origin);
	if (origin === undefined) return { updated: 0, skipped: 0 };
	const directory = leaseDirV1(input.relayDir);
	let names: string[];
	try { names = await readdir(directory); } catch { return { updated: 0, skipped: 0 }; }
	let updated = 0;
	let skipped = 0;
	for (const name of names) {
		if (!name.endsWith(".json") || name.startsWith(".")) continue;
		const token = safeBrowserLeaseTokenV1(name.slice(0, -".json".length));
		if (token === undefined) { skipped += 1; continue; }
		const lease = await readBrowserLeaseV1(input.relayDir, token);
		if (lease === undefined || lease.rootSessionId !== input.rootSessionId) { skipped += 1; continue; }
		const origins = lease.origins.includes(origin) ? lease.origins : [...lease.origins, origin];
		const allow = { ...lease.allow, ...(input.allow ?? {}) };
		if (origins === lease.origins && JSON.stringify(allow) === JSON.stringify(lease.allow)) { skipped += 1; continue; }
		const next = { schemaVersion: 1, kind: "rotom-browser-lease", token, agentId: token, rootSessionId: lease.rootSessionId, origins, allow, maxTabs: lease.maxTabs, keepTabs: lease.keepTabs, expiresAt: lease.expiresAt };
		const staging = join(directory, `.${token}.${process.pid}.${Date.now()}.tmp`);
		const handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try { await handle.writeFile(`${JSON.stringify(next)}\n`, "utf8"); }
		finally { await handle.close(); }
		try { await rename(staging, join(directory, `${token}.json`)); updated += 1; }
		catch { await rm(staging, { force: true }).catch(() => undefined); skipped += 1; }
	}
	return { updated, skipped };
}
