import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { EXECUTION_STORE } from "../../shared/types.ts";
import { assertExecutionStore, assertExecutionStoreScope } from "../../shared/execution-store.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { OWNED_EXECUTION_SCOPE, type OwnedCapacityBinding, type OwnedWorkflowParent } from "./owned-execution.ts";
interface Admission {
	kind?: "async" | "foreground";
	admissionId: string;
	key: string;
	childRunId?: string;
}
export interface OwnedWorkflow {
	version: 2;
	scope: typeof OWNED_EXECUTION_SCOPE;
	storeId: string;
	runId: string;
	controllerInstanceId: string;
	ownerSessionId: string;
	capacity?: OwnedCapacityBinding;
	sealed: boolean;
	controllerClosedAt?: number;
	admissions: Admission[];
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
export function validOwnedWorkflow(value: unknown): value is OwnedWorkflow {
	if (!record(value) || value.version !== 2 || value.scope !== OWNED_EXECUTION_SCOPE || !text(value.storeId) || !id(value.runId) || !id(value.controllerInstanceId)
		|| !text(value.ownerSessionId) || typeof value.sealed !== "boolean" || !Array.isArray(value.admissions) || value.admissions.length > 1024) return false;
	if (value.capacity !== undefined && (!record(value.capacity) || value.capacity.ownerSessionId !== value.ownerSessionId || !text(value.capacity.reservationToken)
		|| !Number.isSafeInteger(value.capacity.generation) || (value.capacity.generation as number) < 0)) return false;
	if (value.sealed ? typeof value.controllerClosedAt !== "number" || !Number.isFinite(value.controllerClosedAt) || value.controllerClosedAt <= 0 : value.controllerClosedAt !== undefined) return false;
	return value.admissions.every((a: unknown) => record(a) && (a.kind === undefined || a.kind === "async" || a.kind === "foreground") && id(a.admissionId) && text(a.key) && (a.childRunId === undefined || id(a.childRunId)))
		&& new Set(value.admissions.map((a) => a.admissionId)).size === value.admissions.length
		&& new Set(value.admissions.map((a) => a.key)).size === value.admissions.length
		&& new Set(value.admissions.flatMap((a) => a.childRunId ? [a.childRunId] : [])).size === value.admissions.filter((a) => a.childRunId).length;
}
const candidatePath = (dir: string) => path.join(dir, "process-terminal-candidate.json");
/** This extends the existing terminal artifact, not status.steps or a second
 * scheduling registry. Invalid evidence throws before recovery can fall back. */
export function readOwnedWorkflow(dir: string): OwnedWorkflow | undefined {
	assertExecutionStore(EXECUTION_STORE);
	try {
		const file = candidatePath(dir), stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("Invalid workflow closure artifact.");
		const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!record(raw)) throw new Error("Invalid workflow closure artifact.");
		if (!("ownedWorkflow" in raw)) return undefined;
		if (raw.version !== 2 || !validOwnedWorkflow(raw.ownedWorkflow) || raw.runId !== raw.ownedWorkflow.runId) throw new Error("Invalid owned workflow identity.");
		assertExecutionStoreScope(EXECUTION_STORE, raw.ownedWorkflow.scope, raw.ownedWorkflow.storeId);
		return raw.ownedWorkflow;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
function save(dir: string, state: OwnedWorkflow): void {
	assertExecutionStoreScope(EXECUTION_STORE, state.scope, state.storeId);
	if (!validOwnedWorkflow(state)) throw new Error("Invalid owned workflow transition.");
	writePrivateAtomicJson(candidatePath(dir), { version: 2, runId: state.runId, ownedWorkflow: state });
}
export function beginOwnedWorkflow(dir: string, runId: string, ownerSessionId: string, capacity?: OwnedCapacityBinding): OwnedWorkflow {
	assertExecutionStoreScope(EXECUTION_STORE, OWNED_EXECUTION_SCOPE);
	try { fs.lstatSync(candidatePath(dir)); throw new Error("Owned workflow cannot reuse a terminal candidate."); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const state: OwnedWorkflow = { version: 2, scope: OWNED_EXECUTION_SCOPE, storeId: EXECUTION_STORE.storeId!, runId, controllerInstanceId: randomUUID(), ownerSessionId,
		...(capacity ? { capacity } : {}), sealed: false, admissions: [] };
	save(dir, state);
	return state;
}
function current(dir: string, handle: OwnedWorkflow): OwnedWorkflow {
	const state = readOwnedWorkflow(dir);
	if (!state || state.storeId !== handle.storeId || state.runId !== handle.runId || state.controllerInstanceId !== handle.controllerInstanceId || state.ownerSessionId !== handle.ownerSessionId
		|| JSON.stringify(state.capacity) !== JSON.stringify(handle.capacity) || state.sealed) throw new Error("Owned workflow admission is closed or unavailable.");
	return state;
}
/** Register before invoking the executor, including unsupported/failed launches.
 * Without an exact pre-spawn async binding the row remains unresolved. */
export function registerWorkflowAdmission(dir: string, handle: OwnedWorkflow, key: string): string {
	const state = current(dir, handle), admissionId = randomUUID();
	state.admissions.push({ key, admissionId }); save(dir, state);
	return admissionId;
}
export function bindWorkflowAdmission(dir: string, handle: OwnedWorkflow, admissionId: string, childRunId: string, kind: "async" | "foreground" = "async"): OwnedWorkflowParent {
	const state = current(dir, handle), row = state.admissions.find((a) => a.admissionId === admissionId);
	if (!row || row.childRunId !== undefined || childRunId === state.runId) throw new Error("Workflow child binding unavailable.");
	row.childRunId = childRunId; row.kind = kind; save(dir, state);
	return { kind, workflowRunId: state.runId, controllerInstanceId: state.controllerInstanceId, admissionId, childRunId };
}
/** Only the runtime's worker-exit + host-operation drain callback may call this.
 * Parent result completion, cancellation requests and Map absence are not proof. */
export function closeOwnedWorkflow(dir: string, handle: OwnedWorkflow): void {
	const state = current(dir, handle);
	state.sealed = true; state.controllerClosedAt = Date.now(); save(dir, state);
}
