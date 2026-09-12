import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAtomicJsonWriter } from "../../shared/atomic-json.ts";
import { OWNED_EXECUTION_SCOPE, assertExecutionStore } from "../../shared/execution-store.ts";
import { EXECUTION_STORE, BASE_TEMP_ROOT_DIR } from "../../shared/types.ts";

// Storage epochs must not create two independent locks for one canonical Pi session.
export const SESSION_LEASES_DIR = path.join(BASE_TEMP_ROOT_DIR, "session-leases");

export interface SessionLeaseRequest {
	sessionFile: string;
	runId: string;
	sourceRunId: string;
	parentSessionId?: string;
}

export interface SessionLeaseOwner {
	version: 1 | 2;
	scope?: typeof OWNED_EXECUTION_SCOPE;
	storeId?: string;
	token: string;
	canonicalSessionFile: string;
	runId: string;
	sourceRunId: string;
	parentSessionId?: string;
	pid: number;
	hostname: string;
	processStartIdentity?: string;
	writerState: "none" | "spawning" | "running";
	writerPid?: number;
	writerProcessStartIdentity?: string;
	acquiredAt: string;
	acquiredAtMs: number;
	updatedAtMs: number;
}

export interface SessionLeaseHandle {
	leaseDir: string;
	owner: SessionLeaseOwner;
	updateWriter(writer: { state: "none" | "spawning" } | { state: "running"; pid: number }): void;
	release(): boolean;
}

export type SessionLeaseState =
	| { state: "free"; canonicalSessionFile: string; canonicalSessionId: string }
	| { state: "owned"; canonicalSessionFile: string; canonicalSessionId: string; owner: SessionLeaseOwner }
	| { state: "unreadable"; canonicalSessionFile: string; canonicalSessionId: string };

interface SessionLeaseOptions {
	rootDir?: string;
	now?: () => number;
	token?: () => string;
	pid?: number;
	hostname?: string;
	processStartIdentity?: string;
	isProcessAlive?: (pid: number) => boolean | undefined;
	getProcessStartIdentity?: (pid: number) => string | undefined;
}

export class SessionLeaseConflictError extends Error {
	readonly owner?: SessionLeaseOwner;

	constructor(message: string, owner?: SessionLeaseOwner) {
		super(message);
		this.name = "SessionLeaseConflictError";
		this.owner = owner;
	}
}

function getProcessStartIdentity(pid: number): string | undefined {
	if (process.platform === "linux") {
		try {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
			const commandEnd = stat.lastIndexOf(")");
			if (commandEnd === -1) return undefined;
			const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
			const startTicks = fields[19];
			return startTicks ? `linux:${startTicks}` : undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function processIsAlive(pid: number): boolean | undefined {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		return undefined;
	}
}

export function canonicalSessionFilePath(sessionFile: string): string {
	return fs.realpathSync.native(path.resolve(sessionFile));
}

export function canonicalSessionId(sessionFile: string): string {
	const canonical = canonicalSessionFilePath(sessionFile);
	const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
	return createHash("sha256").update(key).digest("hex");
}

function leaseRoot(rootDir: string): string {
	assertExecutionStore(EXECUTION_STORE);
	if (!EXECUTION_STORE.scope) return rootDir;
	if (fs.realpathSync(rootDir) !== EXECUTION_STORE.leaseRoot) throw new Error("Scoped lease root cannot create a second canonical session lock.");
	return EXECUTION_STORE.leaseRoot!;
}
export function sessionLeaseDir(sessionFile: string, rootDir = SESSION_LEASES_DIR): string {
	return path.join(leaseRoot(rootDir), canonicalSessionId(sessionFile));
}

export function inspectSessionLease(sessionFile: string, rootDir = SESSION_LEASES_DIR): SessionLeaseState {
	assertExecutionStore(EXECUTION_STORE);
	const canonicalSessionFile = canonicalSessionFilePath(sessionFile);
	const canonicalSessionIdValue = canonicalSessionId(canonicalSessionFile);
	const leaseDir = path.join(leaseRoot(rootDir), canonicalSessionIdValue);
	try { fs.lstatSync(leaseDir); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "free", canonicalSessionFile, canonicalSessionId: canonicalSessionIdValue };
		throw error;
	}
	const owner = readLeaseOwner(leaseDir);
	return owner
		? { state: "owned", canonicalSessionFile, canonicalSessionId: canonicalSessionIdValue, owner }
		: { state: "unreadable", canonicalSessionFile, canonicalSessionId: canonicalSessionIdValue };
}

function parseOwner(value: unknown): SessionLeaseOwner | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const owner = value as Partial<SessionLeaseOwner>;
	const legacy = owner.version === 1 && owner.scope === undefined && owner.storeId === undefined;
	const scoped = owner.version === 2 && owner.scope === OWNED_EXECUTION_SCOPE && EXECUTION_STORE.scope === owner.scope && owner.storeId === EXECUTION_STORE.storeId;
	if ((!legacy && !scoped)
		|| typeof owner.token !== "string"
		|| typeof owner.canonicalSessionFile !== "string"
		|| typeof owner.runId !== "string"
		|| typeof owner.sourceRunId !== "string"
		|| typeof owner.pid !== "number"
		|| !Number.isInteger(owner.pid)
		|| owner.pid <= 0
		|| typeof owner.hostname !== "string"
		|| (owner.writerState !== "none" && owner.writerState !== "spawning" && owner.writerState !== "running")
		|| typeof owner.acquiredAt !== "string"
		|| typeof owner.acquiredAtMs !== "number"
		|| typeof owner.updatedAtMs !== "number") return undefined;
	if (owner.parentSessionId !== undefined && typeof owner.parentSessionId !== "string") return undefined;
	if (owner.processStartIdentity !== undefined && typeof owner.processStartIdentity !== "string") return undefined;
	if (owner.writerPid !== undefined && (typeof owner.writerPid !== "number" || !Number.isInteger(owner.writerPid) || owner.writerPid <= 0)) return undefined;
	if (owner.writerProcessStartIdentity !== undefined && typeof owner.writerProcessStartIdentity !== "string") return undefined;
	if (owner.writerState === "running" && owner.writerPid === undefined) return undefined;
	if (owner.writerState !== "running" && (owner.writerPid !== undefined || owner.writerProcessStartIdentity !== undefined)) return undefined;
	return owner as SessionLeaseOwner;
}

function readLeaseOwner(leaseDir: string): SessionLeaseOwner | undefined {
	try {
		const dir = fs.lstatSync(leaseDir), file = path.join(leaseDir, "owner.json"), stat = fs.lstatSync(file);
		if (!dir.isDirectory() || dir.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink()) return undefined;
		return parseOwner(JSON.parse(fs.readFileSync(file, "utf-8")));
	} catch {
		return undefined;
	}
}

function sameOwner(current: SessionLeaseOwner | undefined, expected: SessionLeaseOwner): boolean {
	return !!current && current.version === expected.version && current.scope === expected.scope && current.storeId === expected.storeId
		&& current.token === expected.token && current.canonicalSessionFile === expected.canonicalSessionFile
		&& current.runId === expected.runId && current.sourceRunId === expected.sourceRunId && current.parentSessionId === expected.parentSessionId
		&& current.pid === expected.pid && current.hostname === expected.hostname && current.processStartIdentity === expected.processStartIdentity;
}
function conflictMessage(canonicalSessionFile: string, owner: SessionLeaseOwner | undefined): string {
	if (EXECUTION_STORE.scope) return owner
		? `Direct revival of session '${canonicalSessionFile}' is already owned. Scoped closure is unavailable; PID death, a new run ID or a new session file does not authorize replay.`
		: `Direct revival of session '${canonicalSessionFile}' is blocked by an existing lease with unreadable owner metadata. Do not reclaim or replay without scoped closure evidence.`;
	if (!owner) {
		return `Direct revival of session '${canonicalSessionFile}' is blocked by an existing lease with unreadable owner metadata. Refusing to reclaim it without proof that the owner is stale.`;
	}
	const parent = owner.parentSessionId ? `, parent session '${owner.parentSessionId}'` : "";
	return `Direct revival of session '${canonicalSessionFile}' is already owned by run '${owner.runId}' (source run '${owner.sourceRunId}'${parent}, pid ${owner.pid} on ${owner.hostname}). Wait for that revival to finish or start a separate continuation without reusing this session file.`;
}

function processDemonstrablyGone(
	pid: number,
	startIdentity: string | undefined,
	options: Required<Pick<SessionLeaseOptions, "isProcessAlive" | "getProcessStartIdentity">>,
): boolean {
	const alive = options.isProcessAlive(pid);
	if (alive === false) return true;
	if (alive !== true || !startIdentity) return false;
	const currentIdentity = options.getProcessStartIdentity(pid);
	return currentIdentity !== undefined && currentIdentity !== startIdentity;
}

function demonstrablyStale(owner: SessionLeaseOwner, options: Required<Pick<SessionLeaseOptions, "hostname" | "isProcessAlive" | "getProcessStartIdentity">>): boolean {
	// PID death never proves scoped group/lease closure. Old readers see v2 as
	// unreadable; scoped readers also cannot reinterpret legacy stale records.
	if (owner.version === 2 || EXECUTION_STORE.scope) return false;
	if (owner.hostname !== options.hostname) return false;
	if (!processDemonstrablyGone(owner.pid, owner.processStartIdentity, options)) return false;
	if (owner.writerState === "spawning") return false;
	if (owner.writerState === "none") return true;
	return owner.writerPid !== undefined
		&& processDemonstrablyGone(owner.writerPid, owner.writerProcessStartIdentity, options);
}

function createLeaseDirectory(leaseDir: string, owner: SessionLeaseOwner): boolean {
	const tempDir = `${leaseDir}.candidate-${owner.token}`;
	fs.mkdirSync(path.dirname(leaseDir), { recursive: true, mode: 0o700 });
	fs.rmSync(tempDir, { recursive: true, force: true });
	fs.mkdirSync(tempDir, { mode: 0o700 });
	try {
		fs.writeFileSync(path.join(tempDir, "owner.json"), JSON.stringify(owner, null, 2), { encoding: "utf-8", mode: 0o600 });
		try {
			fs.renameSync(tempDir, leaseDir);
			return true;
		} catch (error) {
			if (fs.existsSync(leaseDir)) return false;
			throw error;
		}
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

export function acquireSessionLease(request: SessionLeaseRequest, options: SessionLeaseOptions = {}): SessionLeaseHandle {
	assertExecutionStore(EXECUTION_STORE);
	const canonicalSessionFile = canonicalSessionFilePath(request.sessionFile);
	const rootDir = options.rootDir ?? SESSION_LEASES_DIR;
	const leaseDir = sessionLeaseDir(canonicalSessionFile, rootDir);
	const now = options.now ?? Date.now;
	const pid = options.pid ?? process.pid;
	const hostname = options.hostname ?? os.hostname();
	const getIdentity = options.getProcessStartIdentity ?? getProcessStartIdentity;
	const processStartIdentity = options.processStartIdentity
		?? getIdentity(pid)
		?? (pid === process.pid ? `runtime:${Math.round(Date.now() - process.uptime() * 1000)}` : undefined);
	const acquiredAtMs = now();
	const owner: SessionLeaseOwner = {
		version: EXECUTION_STORE.scope ? 2 : 1,
		...(EXECUTION_STORE.scope ? { scope: EXECUTION_STORE.scope, storeId: EXECUTION_STORE.storeId } : {}),
		token: options.token?.() ?? randomUUID(),
		canonicalSessionFile,
		runId: request.runId,
		sourceRunId: request.sourceRunId,
		...(request.parentSessionId ? { parentSessionId: request.parentSessionId } : {}),
		pid,
		hostname,
		...(processStartIdentity ? { processStartIdentity } : {}),
		writerState: "none",
		acquiredAt: new Date(acquiredAtMs).toISOString(),
		acquiredAtMs,
		updatedAtMs: acquiredAtMs,
	};
	const staleOptions = {
		hostname,
		isProcessAlive: options.isProcessAlive ?? processIsAlive,
		getProcessStartIdentity: getIdentity,
	};

	for (let attempt = 0; attempt < 4; attempt++) {
		if (createLeaseDirectory(leaseDir, owner)) {
			const writeOwner = createAtomicJsonWriter();
			return {
				leaseDir,
				owner,
				updateWriter(writer) {
					assertExecutionStore(EXECUTION_STORE);
					const currentOwner = readLeaseOwner(leaseDir);
					if (!sameOwner(currentOwner, owner)) {
						throw new Error(`Session revival lease ownership changed for run '${owner.runId}'.`);
					}
					const writerProcessStartIdentity = writer.state === "running" ? getIdentity(writer.pid) : undefined;
					const nextOwner: SessionLeaseOwner = {
						...owner,
						writerState: writer.state,
						...(writer.state === "running" ? { writerPid: writer.pid } : {}),
						...(writerProcessStartIdentity ? { writerProcessStartIdentity } : {}),
						updatedAtMs: now(),
					};
					delete nextOwner.writerPid;
					delete nextOwner.writerProcessStartIdentity;
					if (writer.state === "running") {
						nextOwner.writerPid = writer.pid;
						if (writerProcessStartIdentity) nextOwner.writerProcessStartIdentity = writerProcessStartIdentity;
					}
					writeOwner(path.join(leaseDir, "owner.json"), nextOwner);
					delete owner.writerPid;
					delete owner.writerProcessStartIdentity;
					Object.assign(owner, nextOwner);
				},
				release() {
					assertExecutionStore(EXECUTION_STORE);
					const currentOwner = readLeaseOwner(leaseDir);
					if (!sameOwner(currentOwner, owner)) return false;
					fs.rmSync(leaseDir, { recursive: true, force: true });
					return !fs.existsSync(leaseDir);
				},
			};
		}

		const existingOwner = readLeaseOwner(leaseDir);
		if (!existingOwner || !demonstrablyStale(existingOwner, staleOptions)) {
			throw new SessionLeaseConflictError(conflictMessage(canonicalSessionFile, existingOwner), existingOwner);
		}
		// The per-owner tombstone is retained. Every contender that observed this
		// stale token targets the same occupied destination, so only the first can
		// rename it and later contenders cannot move a successor lease by mistake.
		const tombstone = `${leaseDir}.stale-${existingOwner.token.replace(/[^A-Za-z0-9._-]/g, "-")}`;
		try {
			fs.renameSync(leaseDir, tombstone);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || fs.existsSync(tombstone)) continue;
			throw error;
		}
	}

	const existingOwner = readLeaseOwner(leaseDir);
	throw new SessionLeaseConflictError(conflictMessage(canonicalSessionFile, existingOwner), existingOwner);
}
