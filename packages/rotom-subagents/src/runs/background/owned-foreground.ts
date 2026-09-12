import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { OWNED_EXECUTION_SCOPE, hasOwnedExecutionEvidence, validWorkflowParent, sameWorkflowParent, validOwnedWriters, ownedWritersClosed, type OwnedWriter, type OwnedWorkflowParent } from "./owned-execution.ts";
import { readOwnedWorkflow } from "./owned-workflow.ts";
import { canonicalSessionId, inspectSessionLease, type SessionLeaseHandle } from "../shared/session-lease.ts";
import { EXECUTION_STORE, type ProcessTreeTerminalV1 } from "../../shared/types.ts";
import { assertExecutionStore, assertExecutionStoreScope } from "../../shared/execution-store.ts";
export interface OwnedForegroundHandle { dir: string; parent: OwnedWorkflowParent; coverageLost?: boolean }
interface Foreground {
	version: 2;
	scope: typeof OWNED_EXECUTION_SCOPE;
	storeId: string;
	runId: string;
	canonicalDir: string;
	controllerInstanceId: string;
	workflowParent: OwnedWorkflowParent;
	pipelineClosedAt?: number;
	hostReturnedAt?: number;
	coverageComplete: boolean;
	descendantCoverage: "unverified";
	effectVerification: "unverified";
	writers: (OwnedWriter & { sessionFile: string; canonicalSessionId: string; leaseToken: string; leaseReleased?: boolean })[];
}
const candidatePath = (dir: string) => path.join(dir, "process-terminal-candidate.json");
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const time = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
function valid(value: unknown): value is Foreground {
	return record(value) && value.version === 2 && value.scope === OWNED_EXECUTION_SCOPE && validWorkflowParent(value.workflowParent)
		&& typeof value.storeId === "string" && !!value.storeId && typeof value.canonicalDir === "string" && path.isAbsolute(value.canonicalDir)
		&& value.workflowParent.kind === "foreground" && value.runId === value.workflowParent.childRunId && value.controllerInstanceId === value.workflowParent.admissionId
		&& value.descendantCoverage === "unverified" && value.effectVerification === "unverified" && typeof value.coverageComplete === "boolean" && validOwnedWriters(value.writers) && value.writers.every(w => record(w) && w.kind === "pi-writer" && typeof w.sessionFile === "string" && path.isAbsolute(w.sessionFile)
			&& typeof w.canonicalSessionId === "string" && !!w.canonicalSessionId && typeof w.leaseToken === "string" && !!w.leaseToken && (w.leaseReleased === undefined || typeof w.leaseReleased === "boolean"))
		&& (value.pipelineClosedAt === undefined || time(value.pipelineClosedAt)) && (value.hostReturnedAt === undefined || time(value.hostReturnedAt));
}
export function readOwnedForeground(dir: string): Foreground | undefined {
	assertExecutionStore(EXECUTION_STORE);
	try {
		const directory = fs.lstatSync(dir);
		if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Invalid foreground closure directory.");
		const p = candidatePath(dir), stat = fs.lstatSync(p);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("Invalid foreground closure artifact.");
		const raw: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
		if (!record(raw)) throw new Error("Invalid foreground closure artifact.");
		if (!("ownedForeground" in raw)) return undefined;
		if (raw.version !== 2 || !valid(raw.ownedForeground) || raw.runId !== raw.ownedForeground.runId || fs.realpathSync(dir) !== raw.ownedForeground.canonicalDir) throw new Error("Foreground closure identity unavailable.");
		assertExecutionStoreScope(EXECUTION_STORE, raw.ownedForeground.scope, raw.ownedForeground.storeId);
		return raw.ownedForeground;
	} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function save(handle: OwnedForegroundHandle, state: Foreground): void {
	assertExecutionStoreScope(EXECUTION_STORE, state.scope, state.storeId);
	if (!valid(state) || !sameWorkflowParent(state.workflowParent, handle.parent)) throw new Error("Invalid foreground ownership transition.");
	writePrivateAtomicJson(candidatePath(handle.dir), { version: 2, runId: state.runId, ownedForeground: state });
}
function current(handle: OwnedForegroundHandle): Foreground {
	const state = readOwnedForeground(handle.dir);
	if (!state || !sameWorkflowParent(state.workflowParent, handle.parent)) throw new Error("Foreground ownership unavailable.");
	return state;
}
export function beginOwnedForeground(dir: string, parent: OwnedWorkflowParent): OwnedForegroundHandle {
	assertExecutionStoreScope(EXECUTION_STORE, OWNED_EXECUTION_SCOPE);
	if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Scoped foreground execution requires POSIX process groups.");
	if (!validWorkflowParent(parent) || parent.kind !== "foreground") throw new Error("Invalid foreground parent admission.");
	dir = path.resolve(dir);
	if (path.basename(dir) !== parent.childRunId) throw new Error("Foreground directory does not match its admitted child.");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const directory = fs.lstatSync(dir);
	if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Invalid foreground closure directory.");
	const canonicalDir = fs.realpathSync(dir);
	try { fs.lstatSync(candidatePath(dir)); throw new Error("Foreground closure candidate cannot be reused."); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const handle = { dir, parent: structuredClone(parent) };
	save(handle, { version: 2, scope: OWNED_EXECUTION_SCOPE, storeId: EXECUTION_STORE.storeId!, runId: parent.childRunId, canonicalDir, controllerInstanceId: parent.admissionId,
		workflowParent: parent, coverageComplete: true, descendantCoverage: "unverified", effectVerification: "unverified", writers: [] });
	return handle;
}
export function registerForegroundWriter(handle: OwnedForegroundHandle, lease: SessionLeaseHandle): string {
	const state = current(handle);
	if (state.pipelineClosedAt) throw new Error("Foreground writer admission is closed.");
	if (lease.owner.version !== 2 || lease.owner.scope !== OWNED_EXECUTION_SCOPE || lease.owner.storeId !== EXECUTION_STORE.storeId || lease.owner.runId !== handle.parent.childRunId || lease.owner.sourceRunId !== handle.parent.workflowRunId) throw new Error("Foreground session lease owner mismatch.");
	const processInstanceId = randomUUID();
	state.writers.push({ processInstanceId, kind: "pi-writer", stepIndex: 0, attempt: state.writers.length,
		sessionFile: lease.owner.canonicalSessionFile, canonicalSessionId: canonicalSessionId(lease.owner.canonicalSessionFile), leaseToken: lease.owner.token });
	save(handle, state); return processInstanceId;
}
export function closeForegroundWriter(handle: OwnedForegroundHandle, processInstanceId: string, processTree: ProcessTreeTerminalV1, closeObservedAt: number, leaseReleased: boolean): void {
	const state = current(handle), writer = state.writers.find(w => w.processInstanceId === processInstanceId);
	if (!writer || writer.close) throw new Error("Foreground writer close identity unavailable.");
	writer.close = { processTree, closeObservedAt }; writer.leaseReleased = leaseReleased; save(handle, state);
}
export function markForegroundCoverageUnavailable(handle: OwnedForegroundHandle): void {
	// Poison the live invocation before I/O: a failed marker write must not let
	// a later successful pipeline-close write forget an observed nested launch.
	handle.coverageLost = true;
	const state = current(handle); state.coverageComplete = false; save(handle, state);
}
export function finishForegroundPipeline(handle: OwnedForegroundHandle): void {
	const state = current(handle);
	if (state.pipelineClosedAt) throw new Error("Foreground pipeline already closed.");
	if (handle.coverageLost) state.coverageComplete = false;
	state.pipelineClosedAt = Date.now(); save(handle, state);
}
export function returnForegroundHost(handle: OwnedForegroundHandle): void {
	const state = current(handle);
	if (state.hostReturnedAt) throw new Error("Foreground host already returned.");
	state.hostReturnedAt = Date.now(); save(handle, state);
}
export function assertForegroundRecoveryAllowed(root: string, target: { id?: string; dir?: string }, resultsDir?: string): void {
	const canonical = (p: string) => { try { return fs.realpathSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(p); throw e; } };
	const targetDir = target.dir ? canonical(target.dir) : undefined;
	const matches = (id: string) => !!target.id && id.startsWith(target.id);
	const denied = () => { throw new Error("Owned foreground workflow child recovery is unavailable; do not bypass its parent fence."); };
	const persistedFence = (file: string) => {
		let raw: unknown;
		try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("Recovery evidence unavailable."); raw = JSON.parse(fs.readFileSync(file, "utf8")); }
		catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
		if (!record(raw) || raw.mode !== "workflow" || !hasOwnedExecutionEvidence(raw)) return;
		const children = Array.isArray(raw.results) ? raw.results : Array.isArray(raw.steps) ? raw.steps : [];
		if (children.some(c => record(c) && typeof c.runId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(c.runId) && (matches(c.runId) || targetDir === canonical(path.join(root, c.runId))))) {
			throw new Error("Owned workflow child recovery is unavailable; do not bypass its parent fence.");
		}
	};
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(root, { withFileTypes: true }); }
	catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; entries = []; }
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(root, entry.name), foreground = readOwnedForeground(dir);
		if (foreground && (matches(foreground.runId) || targetDir === canonical(dir)
			|| foreground.writers.some(w => targetDir === canonical(w.sessionFile)))) denied();
		// A lost child candidate must not erase its parent's durable admission fence.
		const workflow = readOwnedWorkflow(dir);
		if (workflow?.admissions.some(a => a.kind === "foreground" && a.childRunId && (matches(a.childRunId) || targetDir === canonical(path.join(root, a.childRunId))))) denied();
	}
	// These are only negative fences, never replacements for creation-time proof.
	for (const entry of entries) if (entry.isDirectory()) persistedFence(path.join(root, entry.name, "status.json"));
	if (resultsDir) {
		let names: string[];
		try { names = fs.readdirSync(resultsDir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
		for (const name of names) if (name.endsWith(".json")) persistedFence(path.join(resultsDir, name));
	}
}
export function foregroundClosureObserved(dir: string, expected: OwnedWorkflowParent): boolean {
	const state = readOwnedForeground(dir), now = Date.now();
	return !!state && sameWorkflowParent(state.workflowParent, expected) && state.coverageComplete
		&& !!state.pipelineClosedAt && state.pipelineClosedAt <= now && !!state.hostReturnedAt && state.hostReturnedAt <= now
		&& ownedWritersClosed(state.writers, now) && state.writers.every(w => {
			const lease = inspectSessionLease(w.sessionFile);
			return w.leaseReleased === true && lease.state === "free" && lease.canonicalSessionId === w.canonicalSessionId;
		});
}
