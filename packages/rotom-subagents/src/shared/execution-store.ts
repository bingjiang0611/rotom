import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export const OWNED_EXECUTION_SCOPE = "owned-process-groups-v2" as const;
export const EXECUTION_STORE_MARKER = ".owned-process-groups-v2.json";
export interface ExecutionStore {
	baseRoot: string;
	root: string;
	scope?: typeof OWNED_EXECUTION_SCOPE;
	storeId?: string;
	device?: string;
	inode?: string;
	baseDevice?: string;
	baseInode?: string;
	leaseRoot?: string;
	leaseDevice?: string;
	leaseInode?: string;
	sessionRoot?: string;
	sessionDevice?: string;
	sessionInode?: string;
}
function directoryIdentity(dir: string, privateDirectory = false): { device: string; inode: string } {
	const stat = fs.lstatSync(dir, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & (privateDirectory ? 0o077n : 0o022n)) !== 0n || (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid()))) throw new Error("Execution store directory identity unavailable.");
	return { device: String(stat.dev), inode: String(stat.ino) };
}
function marker(baseRoot: string): Record<string, unknown> {
	const file = path.join(baseRoot, EXECUTION_STORE_MARKER), stat = fs.lstatSync(file);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (stat.mode & 0o077) || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("Execution store marker identity unavailable.");
	const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Execution store marker identity unavailable.");
	return value as Record<string, unknown>;
}
export function assertExecutionStore(store: ExecutionStore): void {
	if (!store.scope) return;
	const identity = directoryIdentity(store.root, true), base = directoryIdentity(store.baseRoot), value = marker(store.baseRoot);
	const leaseRoot = path.join(store.baseRoot, "session-leases"), sessionRoot = path.join(store.root, "sessions");
	const lease = directoryIdentity(leaseRoot, true), session = directoryIdentity(sessionRoot, true);
	if (store.leaseRoot !== leaseRoot || store.sessionRoot !== sessionRoot || value.leaseRoot !== leaseRoot || value.sessionRoot !== sessionRoot
		|| store.leaseDevice !== lease.device || store.leaseInode !== lease.inode || value.leaseDevice !== lease.device || value.leaseInode !== lease.inode
		|| store.sessionDevice !== session.device || store.sessionInode !== session.inode || value.sessionDevice !== session.device || value.sessionInode !== session.inode
		|| fs.realpathSync(store.baseRoot) !== store.baseRoot || fs.realpathSync(store.root) !== store.root
		|| value.version !== 3 || value.scope !== store.scope || value.storeId !== store.storeId
		|| value.root !== store.root || value.baseRoot !== store.baseRoot
		|| identity.device !== store.device || identity.inode !== store.inode
		|| value.device !== store.device || value.inode !== store.inode
		|| value.baseDevice !== store.baseDevice || value.baseInode !== store.baseInode
		|| base.device !== store.baseDevice || base.inode !== store.baseInode) throw new Error("Execution store identity drift; no adoption, replay or new writer is authorized.");
}
function supportedPlatform(): void {
	if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Scoped execution store requires a supported POSIX platform.");
}
/** Runtime open is read-only. Missing state is never a fresh capacity pool. */
export function resolveExecutionStore(baseRoot: string, requestedScope: string | undefined = process.env.PI_SUBAGENTS_EXECUTION_SCOPE): ExecutionStore {
	const scope = requestedScope?.trim() || undefined;
	if (scope !== undefined && scope !== OWNED_EXECUTION_SCOPE) throw new Error("PI_SUBAGENTS_EXECUTION_SCOPE must be owned-process-groups-v2 or unset.");
	baseRoot = path.resolve(baseRoot);
	if (!scope) return Object.freeze({ baseRoot, root: baseRoot });
	supportedPlatform();
	const base = directoryIdentity(baseRoot);
	baseRoot = fs.realpathSync(baseRoot);
	const root = path.join(baseRoot, OWNED_EXECUTION_SCOPE), value = marker(baseRoot), identity = directoryIdentity(root, true);
	if (typeof value.storeId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.storeId)) throw new Error("Execution store identifier unavailable.");
	const leaseRoot = path.join(baseRoot, "session-leases"), sessionRoot = path.join(root, "sessions");
	const lease = directoryIdentity(leaseRoot, true), session = directoryIdentity(sessionRoot, true);
	const store = Object.freeze({ baseRoot, root, scope, storeId: value.storeId, ...identity, baseDevice: base.device, baseInode: base.inode,
		leaseRoot, leaseDevice: lease.device, leaseInode: lease.inode, sessionRoot, sessionDevice: session.device, sessionInode: session.inode });
	assertExecutionStore(store);
	return store;
}
/** Explicit maintenance initialization only, never called by runtime fallback.
 * The anchor lives outside the namespace so namespace deletion cannot erase the fact
 * that this base already had a store. Neither marker nor directory is replaced.
 * This does not prove old writers closed or authorize migration/replay. */
export function initializeExecutionStore(baseRoot: string): ExecutionStore {
	supportedPlatform();
	baseRoot = path.resolve(baseRoot);
	fs.mkdirSync(baseRoot, { recursive: true, mode: 0o700 });
	const base = directoryIdentity(baseRoot);
	baseRoot = fs.realpathSync(baseRoot);
	const file = path.join(baseRoot, EXECUTION_STORE_MARKER), root = path.join(baseRoot, OWNED_EXECUTION_SCOPE);
	let exists = false;
	try { fs.lstatSync(file); exists = true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	// Resolution failures after an existing anchor are never initialization.
	if (exists) return resolveExecutionStore(baseRoot, OWNED_EXECUTION_SCOPE);
	fs.mkdirSync(root, { mode: 0o700 }); // Existing/unready/unmarked is never adopted.
	const identity = directoryIdentity(root, true), leaseRoot = path.join(baseRoot, "session-leases"), sessionRoot = path.join(root, "sessions");
	fs.mkdirSync(sessionRoot, { mode: 0o700 });
	try { fs.mkdirSync(leaseRoot, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	// Bind the existing shared directory, not its leases. Legacy records do not
	// acquire a new closure contract, and a deleted pool cannot reset exclusion.
	const lease = directoryIdentity(leaseRoot, true), session = directoryIdentity(sessionRoot, true);
	const value = { version: 3, scope: OWNED_EXECUTION_SCOPE, baseRoot, root, storeId: randomUUID(), ...identity, baseDevice: base.device, baseInode: base.inode,
		leaseRoot, leaseDevice: lease.device, leaseInode: lease.inode, sessionRoot, sessionDevice: session.device, sessionInode: session.inode };
	const temporary = path.join(baseRoot, `.scope-${value.storeId}.tmp`);
	fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
	fs.linkSync(temporary, file); // Atomic no-replace publication, including races.
	fs.unlinkSync(temporary);
	return resolveExecutionStore(baseRoot, OWNED_EXECUTION_SCOPE);
}
/** Native child sessions must not enter a legacy reader's discovery tree. */
export function scopedSessionRoot(store: ExecutionStore): string | undefined {
	if (!store.scope) return undefined;
	assertExecutionStore(store);
	return store.sessionRoot!;
}
export function assertScopedSessionPath(store: ExecutionStore, target: string): void {
	const root = scopedSessionRoot(store);
	if (!root) return;
	const relative = path.relative(root, path.resolve(target));
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Scoped session import or external destination is unavailable; no writer is authorized.");
	let current = root;
	for (const part of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Scoped session path cannot follow a symlink."); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
	}
}
export function assertExecutionStoreScope(store: ExecutionStore, scope: typeof OWNED_EXECUTION_SCOPE | undefined, storeId?: string): void {
	if (store.scope !== scope || (storeId !== undefined && storeId !== store.storeId)) throw new Error("Execution scope/store mismatch; select the scope before process startup. No writer is authorized.");
	assertExecutionStore(store);
}
