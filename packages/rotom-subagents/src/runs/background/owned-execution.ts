import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { inspectSessionLease, canonicalSessionId } from "../shared/session-lease.ts";
import { EXECUTION_STORE, type ProcessTreeTerminalV1 } from "../../shared/types.ts";
import { OWNED_EXECUTION_SCOPE, assertExecutionStore, assertExecutionStoreScope } from "../../shared/execution-store.ts";
export { OWNED_EXECUTION_SCOPE };
export interface OwnedCapacityBinding {
	ownerSessionId: string;
	reservationToken: string;
	generation: number;
}
export interface OwnedWorkflowParent {
	kind?: "async" | "foreground";
	workflowRunId: string;
	controllerInstanceId: string;
	admissionId: string;
	childRunId: string;
}
export interface OwnedExecutionRequest {
	scope: typeof OWNED_EXECUTION_SCOPE;
	storeId: string;
	workflowParent?: OwnedWorkflowParent;
	capacity?: OwnedCapacityBinding;
}
export type OwnedWriterLease = { state: "not-held"; reason: "session-disabled" } | { state: "held"; sessionFile: string; canonicalSessionId: string; token: string; released?: boolean };
export interface OwnedWriter {
	sessionLease?: OwnedWriterLease;
	processInstanceId: string;
	kind: "external-cli" | "pi-writer";
	stepIndex: number;
	attempt: number;
	close?: { closeObservedAt: number; processTree: ProcessTreeTerminalV1 };
}
export interface OwnedExecutionV2 extends OwnedExecutionRequest {
	version: 2;
	runId: string;
	runnerProcessInstanceId: string;
	sealed: boolean;
	coverageComplete: boolean;
	writers: OwnedWriter[];
}
export interface OwnedClosureV2 extends OwnedExecutionRequest {
	version: 2;
	runId: string;
	runnerProcessInstanceId: string;
	state: "observed" | "unknown";
	descendantCoverage: "unverified";
	effectVerification: "unverified";
	observedAt?: number;
	writers?: OwnedWriter[];
}
const file = (dir: string) => path.join(dir, "process-terminal-candidate.json");
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
export function validWorkflowParent(value: unknown): value is OwnedWorkflowParent {
	const id = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
	return record(value) && (value.kind === undefined || value.kind === "async" || value.kind === "foreground") && id(value.workflowRunId) && id(value.controllerInstanceId) && id(value.admissionId) && id(value.childRunId);
}
export function sameWorkflowParent(value: unknown, expected: OwnedWorkflowParent): boolean {
	return validWorkflowParent(value) && (value.kind ?? "async") === (expected.kind ?? "async") && value.workflowRunId === expected.workflowRunId && value.controllerInstanceId === expected.controllerInstanceId
		&& value.admissionId === expected.admissionId && value.childRunId === expected.childRunId;
}
function binding(value: unknown): value is OwnedCapacityBinding {
	return record(value) && text(value.ownerSessionId) && text(value.reservationToken) && integer(value.generation);
}
function groupObserved(value: unknown): boolean {
	return record(value) && value.state === "observed" && value.mechanism === "posix-process-group"
		&& integer(value.processGroupId) && value.processGroupId > 1 && timestamp(value.verifiedAt);
}
function validWriterLease(value: unknown): value is OwnedWriterLease {
	return record(value) && ((value.state === "not-held" && value.reason === "session-disabled") || (value.state === "held" && text(value.sessionFile) && path.isAbsolute(value.sessionFile) && text(value.canonicalSessionId) && text(value.token) && (value.released === undefined || typeof value.released === "boolean")));
}
function writerLeaseReleased(writer: OwnedWriter): boolean {
	if (writer.kind !== "pi-writer") return true;
	const lease = writer.sessionLease;
	if (!validWriterLease(lease)) return false;
	if (lease.state === "not-held") return true;
	if (lease.released !== true) return false;
	const current = inspectSessionLease(lease.sessionFile);
	return current.state === "free" && current.canonicalSessionId === lease.canonicalSessionId;
}
function writer(value: unknown): value is OwnedWriter {
	if (!record(value) || !text(value.processInstanceId) || !["external-cli", "pi-writer"].includes(String(value.kind)) || !integer(value.stepIndex) || !integer(value.attempt)) return false;
	if (value.sessionLease !== undefined && !validWriterLease(value.sessionLease)) return false;
	if (value.close === undefined) return true;
	return record(value.close) && timestamp(value.close.closeObservedAt) && record(value.close.processTree)
		&& (groupObserved(value.close.processTree) || (value.close.processTree.state === "unknown" && ["unsupported-platform", "signal-failed", "verification-failed"].includes(String(value.close.processTree.reason))));
}
function writers(value: unknown): value is OwnedWriter[] {
	return Array.isArray(value) && value.length <= 1024 && value.every(writer)
		&& new Set(value.map((entry) => entry.processInstanceId)).size === value.length
		&& new Set(value.map((entry) => `${entry.stepIndex}:${entry.kind}:${entry.attempt}`)).size === value.length;
}
export { writers as validOwnedWriters };
export function ownedWritersClosed(value: unknown, observedAt: number): boolean {
	return timestamp(observedAt) && writers(value) && value.every(entry => entry.close && groupObserved(entry.close.processTree)
		&& entry.close.closeObservedAt <= observedAt && entry.close.processTree.state === "observed" && entry.close.processTree.verifiedAt <= observedAt);
}
/** Presence, not validity: malformed/newer scoped evidence must not downgrade
 * to legacy recovery or disappear under the ordinary retention TTL. */
export function hasOwnedExecutionEvidence(value: unknown): boolean {
	return record(value) && (Object.hasOwn(value, "ownedForeground") || Object.hasOwn(value, "ownedWorkflow") || Object.hasOwn(value, "ownedExecutionScope") || Object.hasOwn(value, "ownedExecution") || Object.hasOwn(value, "ownedClosure")
		|| (record(value.processTerminal) && Object.hasOwn(value.processTerminal, "ownedClosure")));
}
export function validOwnedExecution(value: unknown): value is OwnedExecutionV2 {
	return record(value) && value.version === 2 && value.scope === OWNED_EXECUTION_SCOPE
		&& text(value.storeId) && text(value.runId) && text(value.runnerProcessInstanceId)
		&& (value.workflowParent === undefined || (validWorkflowParent(value.workflowParent) && value.workflowParent.childRunId === value.runId))
		&& (value.capacity === undefined || binding(value.capacity)) && typeof value.sealed === "boolean"
		&& typeof value.coverageComplete === "boolean" && writers(value.writers);
}
function readCandidate(dir: string): Record<string, unknown> | undefined {
	assertExecutionStore(EXECUTION_STORE);
	try {
		const value: unknown = JSON.parse(fs.readFileSync(file(dir), "utf8"));
		if (!record(value)) throw new Error("Invalid owned execution candidate.");
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
function owned(candidate: Record<string, unknown> | undefined): OwnedExecutionV2 | undefined {
	if (candidate?.ownedExecution === undefined) return undefined; // Legacy, never upgraded from history.
	if (!validOwnedExecution(candidate.ownedExecution) || candidate.runId !== candidate.ownedExecution.runId || candidate.runnerProcessInstanceId !== candidate.ownedExecution.runnerProcessInstanceId) throw new Error("Owned execution identity unavailable.");
	assertExecutionStoreScope(EXECUTION_STORE, candidate.ownedExecution.scope, candidate.ownedExecution.storeId);
	return candidate.ownedExecution;
}
/** Called once by the newly created runner before any writer spawn. This is an
 * extension of its existing terminal candidate, not a separate task registry. */
export function beginOwnedExecution(dir: string, runId: string, runnerProcessInstanceId: string, request: OwnedExecutionRequest): void {
	assertExecutionStoreScope(EXECUTION_STORE, request.scope, request.storeId);
	if (!text(request.storeId) || (request.workflowParent !== undefined && (!validWorkflowParent(request.workflowParent) || request.workflowParent.childRunId !== runId)) || request.scope !== OWNED_EXECUTION_SCOPE || !text(runId) || !text(runnerProcessInstanceId) || (request.capacity !== undefined && !binding(request.capacity))) throw new Error("Invalid owned execution launch scope.");
	if (fs.existsSync(file(dir))) throw new Error("Owned execution cannot reuse a terminal candidate.");
	writePrivateAtomicJson(file(dir), { version: 1, runId, runnerProcessInstanceId, writers: {}, expectedWriters: {},
		ownedExecution: { ...request, version: 2, runId, runnerProcessInstanceId, sealed: false, coverageComplete: false, writers: [] } });
}
/** Registration is synchronous and durable BEFORE spawn. Failure prevents spawn;
 * missing close evidence can never be repaired by observing a historical PID. */
export function registerOwnedWriter(dir: string, kind: OwnedWriter["kind"], stepIndex: number, processInstanceId = randomUUID(), required = false): string {
	const candidate = readCandidate(dir), scope = owned(candidate);
	if (!scope) {
		if (required) throw new Error("Required owned execution roster is missing; writer must not start.");
		return processInstanceId;
	}
	if (scope.sealed || !integer(stepIndex) || scope.writers.length >= 1024 || scope.writers.some((entry) => entry.processInstanceId === processInstanceId)) throw new Error("Owned writer admission unavailable.");
	const attempt = scope.writers.filter((entry) => entry.stepIndex === stepIndex && entry.kind === kind).length;
	scope.writers.push({ processInstanceId, kind, stepIndex, attempt });
	writePrivateAtomicJson(file(dir), { ...candidate, ...(kind === "external-cli" ? { externalWritersUnverified: true } : {}), ownedExecution: scope });
	return processInstanceId;
}
export function ownedSessionPreviouslyReleased(dir: string, runId: string, sessionFile: string): boolean {
	const scope = owned(readCandidate(dir));
	return !!scope && scope.runId === runId && !scope.sealed && scope.writers.some(w => w.kind === "pi-writer" && w.sessionLease?.state === "held" && w.sessionLease.sessionFile === fs.realpathSync(sessionFile) && writerLeaseReleased(w) && ownedWritersClosed([w], Date.now()));
}
export function bindOwnedWriterLease(dir: string, processInstanceId: string, lease: OwnedWriterLease): void {
	const candidate = readCandidate(dir), scope = owned(candidate), entry = scope?.writers.find(w => w.processInstanceId === processInstanceId);
	if (!scope || scope.sealed || !entry || entry.kind !== "pi-writer" || entry.sessionLease || entry.close || !validWriterLease(lease)) throw new Error("Owned writer lease admission unavailable.");
	if (lease.state === "held" && (lease.released !== undefined || canonicalSessionId(lease.sessionFile) !== lease.canonicalSessionId)) throw new Error("Owned writer lease identity unavailable.");
	entry.sessionLease = structuredClone(lease);
	writePrivateAtomicJson(file(dir), { ...candidate, ownedExecution: scope });
}
export function markOwnedWriterLeaseRelease(dir: string, token: string, released: boolean): void {
	const candidate = readCandidate(dir), scope = owned(candidate);
	const entries = scope?.writers.filter(w => w.sessionLease?.state === "held" && w.sessionLease.token === token);
	if (!scope || !entries?.length || (released && !ownedWritersClosed(entries, Date.now()))) throw new Error("Owned writer lease release evidence unavailable.");
	for (const entry of entries) if (entry.sessionLease?.state === "held") entry.sessionLease.released = released;
	writePrivateAtomicJson(file(dir), { ...candidate, ownedExecution: scope });
}
export function closeOwnedWriter(dir: string, processInstanceId: string, processTree: ProcessTreeTerminalV1, closeObservedAt: number): void {
	const candidate = readCandidate(dir), scope = owned(candidate);
	if (!scope) return;
	const entry = scope.writers.find((item) => item.processInstanceId === processInstanceId);
	if (!entry || entry.close || scope.sealed || !timestamp(closeObservedAt)) throw new Error("Owned writer close identity unavailable.");
	entry.close = { processTree, closeObservedAt };
	writePrivateAtomicJson(file(dir), { ...candidate, ownedExecution: scope });
}
export function sealOwnedExecution(dir: string, runId: string, runnerProcessInstanceId: string, coverageComplete: boolean): OwnedExecutionV2 | undefined {
	const candidate = readCandidate(dir), scope = owned(candidate);
	if (!scope) return undefined;
	if (scope.runId !== runId || scope.runnerProcessInstanceId !== runnerProcessInstanceId || scope.sealed) throw new Error("Owned execution seal identity unavailable.");
	scope.sealed = true;
	scope.coverageComplete = coverageComplete;
	writePrivateAtomicJson(file(dir), { ...candidate, ownedExecution: scope });
	return scope;
}
/** Lease release precedes projection, so this deliberately checks resource
 * closure without using a lease-free projection (which would be circular). */
export function ownedExecutionCanReleaseLease(dir: string, runId: string): boolean {
	const scope = owned(readCandidate(dir));
	return !!scope && scope.runId === runId && scope.sealed && scope.coverageComplete && scope.writers.every(w => w.kind !== "pi-writer" || validWriterLease(w.sessionLease)) && ownedWritersClosed(scope.writers, Date.now());
}
export function projectOwnedClosure(scope: OwnedExecutionV2, close: { processInstanceId: string; closeObservedAt: number }, leaseFree: boolean): OwnedClosureV2 {
	assertExecutionStore(EXECUTION_STORE);
	const observed = validOwnedExecution(scope) && scope.storeId === EXECUTION_STORE.storeId && scope.sealed && scope.coverageComplete && leaseFree
		&& close.processInstanceId === scope.runnerProcessInstanceId && timestamp(close.closeObservedAt)
		&& scope.writers.every((entry) => writerLeaseReleased(entry) && entry.close && groupObserved(entry.close.processTree) && entry.close.closeObservedAt <= close.closeObservedAt && entry.close.processTree.state === "observed" && entry.close.processTree.verifiedAt <= close.closeObservedAt);
	return { version: 2, scope: OWNED_EXECUTION_SCOPE, storeId: scope.storeId, runId: scope.runId, runnerProcessInstanceId: scope.runnerProcessInstanceId,
		...(scope.capacity ? { capacity: scope.capacity } : {}), ...(scope.workflowParent ? { workflowParent: scope.workflowParent } : {}), state: observed ? "observed" : "unknown",
		descendantCoverage: "unverified", effectVerification: "unverified",
		...(observed ? { observedAt: close.closeObservedAt, writers: scope.writers } : {}) };
}
/** Validate scope and identity on every reader. An old v1 observed proof is not a
 * scoped proof; accepting v2 never upgrades the enclosing whole-graph unknown. */
type OwnedClosureExpectation = { runId: string; runnerProcessInstanceId: string; capacity?: OwnedCapacityBinding; workflowParent?: OwnedWorkflowParent };
function ownedClosureMatches(proof: unknown, expected: OwnedClosureExpectation, leaseReleased: (writer: OwnedWriter) => boolean): boolean {
	assertExecutionStore(EXECUTION_STORE);
	if (!record(proof) || proof.version !== 2 || proof.scope !== OWNED_EXECUTION_SCOPE || !text(proof.storeId) || proof.storeId !== EXECUTION_STORE.storeId || proof.state !== "observed"
		|| proof.runId !== expected.runId || proof.runnerProcessInstanceId !== expected.runnerProcessInstanceId
		|| proof.descendantCoverage !== "unverified" || proof.effectVerification !== "unverified" || !timestamp(proof.observedAt)
		|| !writers(proof.writers) || !proof.writers.every((entry) => leaseReleased(entry) && entry.close && groupObserved(entry.close.processTree) && entry.close.closeObservedAt <= (proof.observedAt as number) && entry.close.processTree.state === "observed" && entry.close.processTree.verifiedAt <= (proof.observedAt as number))) return false;
	if (proof.workflowParent !== undefined && (!validWorkflowParent(proof.workflowParent) || proof.workflowParent.childRunId !== proof.runId)) return false;
	if (expected.workflowParent && !sameWorkflowParent(proof.workflowParent, expected.workflowParent)) return false;
	if (proof.capacity !== undefined && !binding(proof.capacity)) return false;
	return !expected.capacity || (binding(proof.capacity) && proof.capacity.ownerSessionId === expected.capacity.ownerSessionId
		&& proof.capacity.reservationToken === expected.capacity.reservationToken && proof.capacity.generation === expected.capacity.generation);
}

// Historical observation only. A separately authorized native continuation can
// hold the same session lease without reopening the preceding writer's close.
// Never use this predicate to release capacity or authorize recovery/transfer.
export function ownedClosureWasObserved(proof: unknown, expected: OwnedClosureExpectation): boolean {
	return ownedClosureMatches(proof, expected, (writer) => writer.kind !== "pi-writer"
		|| (validWriterLease(writer.sessionLease) && (writer.sessionLease.state === "not-held" || writer.sessionLease.released === true)));
}

export function ownedClosureObserved(proof: unknown, expected: OwnedClosureExpectation): boolean {
	return ownedClosureMatches(proof, expected, writerLeaseReleased);
}
