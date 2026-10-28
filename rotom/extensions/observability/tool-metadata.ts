import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFERRED_CAPABILITY_GROUPS } from "../third-party/deferred-tools/register.ts";
import { boundedTag, finiteNumber, record, type TraceAttributes } from "./trace-schema.ts";

// Product-owned constant, imported rather than copied so a group or tool rename
// cannot silently desynchronise the trace's capability dimension.
export const CAPABILITY_GROUP_BY_TOOL = new Map(
	DEFERRED_CAPABILITY_GROUPS.flatMap((group) => group.toolNames.map((name) => [name, group.id] as const)),
);

type ToolOutcome = "ok" | "schema" | "permission" | "timeout" | "transport" | "tool_error" | "followup_failed" | "aborted" | "unknown_outcome" | "incomplete" | "unspecified";

function structuredToolCode(details: Record<string, unknown> | undefined): string | undefined {
	for (const candidate of [details?.code, record(details?.error)?.code, record(details?.protocolError)?.code]) {
		const code = boundedTag(candidate, 128)?.toLowerCase();
		if (code) return code;
	}
	return undefined;
}

/**
 * The two shapes of "unknown" are not the same problem and must not read as one.
 *
 * `unknown_outcome` is only produced here, from a tool that DID return its own end
 * event whose result declares an unknown / unverified / didn't-happen / failed
 * verification signal: the action ran, but the trace cannot confirm the effect.
 * That is the "ran but the model's step is unproven" case.
 *
 * `incomplete` (set by the recorder, never here) means the tool span never
 * received its own end event at all: it was force-closed because a newer call
 * superseded it or the turn was torn down mid-flight. That is a lifecycle gap
 * on our side, not evidence the model's step went wrong. Splitting the two keeps
 * "the harness never finished recording" from being mistaken for "the model got
 * derailed", which point at opposite fixes.
 */
export function classifyToolOutcome(event: any): ToolOutcome {
	const details = record(event.result?.details);
	const status = boundedTag(details?.status, 64)?.toLowerCase();
	const execution = record(details?.execution);
	if (status === "unknown" || details?.businessOutcome === "unknown" || details?.businessOutcome === "unverified"
		|| execution?.outcome === "unknown" || execution?.outcome === "didnt"
		|| record(execution?.verification)?.status === "failed") return "unknown_outcome";
	if (status === "aborted") return "aborted";
	if (event.isError !== true) return event.isError === false ? (status === "failed" ? "tool_error" : "ok") : "unspecified";
	// edit/write applied the file change and only its `then_run` command failed.
	// That is a failed build/test step, not a failed file tool.
	const phases = record(details?.codingPhases);
	if (phases?.source === "tool-reported" && phases.mutation === "applied" && phases.followup === "failed") return "followup_failed";
	const code = structuredToolCode(details);
	if (code === "aborted" || code === "abort_error" || code === "cancelled") return "aborted";
	if (code === "schema" || code === "schema_validation" || code === "validation_error" || code === "invalid_arguments") return "schema";
	if (code === "permission" || code === "permission_denied" || code === "approval_required" || code === "forbidden") return "permission";
	if (code === "timeout" || code === "deadline_exceeded") return "timeout";
	if (code === "transport" || code === "connection_failed" || code === "network_error" || code === "debugger_detached") return "transport";
	return "tool_error";
}

/**
 * Which side produced the artifact that failed.
 *
 * This is deliberately four values, not a taxonomy. Published step-level failure
 * attribution for agent runs lands around 14-53% accuracy, so a fine-grained
 * cause label would be a guess wearing a schema. This field answers only the
 * narrow question the local trace can actually evidence, and it answers
 * `unknown` whenever that evidence is missing.
 *
 * It is not a blame verdict and not a root cause:
 * - `model`       the model emitted the rejected artifact (arguments failed the
 *                 declared schema). A wrong schema on our side would show up
 *                 here too; the provable fact is only which side emitted it.
 * - `environment` an external system refused or failed to answer in time.
 * - `harness`     the local tool/protocol layer failed before or independently
 *                 of any external system.
 * - `unknown`     it failed, and nothing in the result proves a side.
 *
 * Absent for `ok`, and absent for `aborted` because a cancellation is not a
 * fault. Also absent for an `unknown_outcome` whose result only says the effect
 * is unverified or unknown: that is missing evidence, not a failure. A result
 * that reports the action did not happen, or that its verification failed, is a
 * failure and still gets a side. Derived purely from already-allowlisted codes and statuses: no prompt,
 * arguments, or result bodies are read.
 */
type FaultSide = "harness" | "model" | "environment" | "unknown";

const HARNESS_FAULT_CODES = new Set([
	"tool_not_found", "unknown_tool", "tool_not_registered", "not_registered",
	"tool_disabled", "tool_not_active", "protocol_error", "invalid_protocol",
]);

// Codes the edit matcher (Pi `core/tools/edit.ts`, also reached through SoL-Pi
// Action Fusion) attaches to a rejected oldText; they are model input errors.
const EDIT_INPUT_FAULT_CODES = new Set([
	"old_text_not_found", "old_text_ambiguous", "no_change", "overlapping_edits", "invalid_edit_input",
]);

/**
 * Error codes copied to pi.tool.error_code. Only known codes are recorded: details.code is
 * tool-controlled, and the trace keeps allowlisted metadata only.
 */
const RECORDED_TOOL_ERROR_CODES = new Set([
	...HARNESS_FAULT_CODES,
	// Agent loop: rejected before the tool ran.
	"aborted", "validation_error", "blocked", "truncated_arguments",
	// Bash: the command ran and failed, or could not run.
	"nonzero_exit", "command_timeout", "cwd_missing", "no_exit_code",
	// Node system errors thrown by file tools.
	"enoent", "eacces", "eperm", "eisdir", "enotdir", "eexist", "enospc", "emfile",
	// Edit matcher: the model's oldText did not address the file as written.
	// Codes only; the message text that produced them is never recorded.
	...EDIT_INPUT_FAULT_CODES,
]);

export function toolErrorAttributes(details: Record<string, unknown> | undefined): TraceAttributes {
	const code = structuredToolCode(details);
	if (!code || !RECORDED_TOOL_ERROR_CODES.has(code)) return {};
	const exitCode = finiteNumber(details?.exitCode);
	return {
		"pi.tool.error_code": code,
		...(code === "nonzero_exit" && exitCode !== undefined && Number.isInteger(exitCode) ? { "pi.tool.exit_code": exitCode } : {}),
	};
}

export function classifyFaultSide(event: any, outcome: ToolOutcome): FaultSide | undefined {
	if (outcome === "ok" || outcome === "aborted") return undefined;
	const details = record(event?.result?.details);
	const execution = record(details?.execution);
	if (outcome === "unknown_outcome" && execution?.outcome !== "didnt" && record(execution?.verification)?.status !== "failed") return undefined;
	// A protocol-level failure is our adapter, not the model's output and not the
	// external system the call would have reached.
	if (record(details?.protocolError)) return "harness";
	const code = structuredToolCode(details);
	if (code && HARNESS_FAULT_CODES.has(code)) return "harness";
	// A rejected oldText is the model's own input disagreeing with the file it
	// read, so these stay on the model side rather than "environment".
	if (code && EDIT_INPUT_FAULT_CODES.has(code)) return "model";
	if (outcome === "schema") return "model";
	if (outcome === "permission" || outcome === "timeout" || outcome === "transport") return "environment";
	// tool_error, unspecified and a failed unknown_outcome all mean "failed, side unproven".
	return "unknown";
}

const SAFE_TOOL_RESULT_STATUSES = new Set([
	"ok", "error", "aborted", "unknown", "verified", "accepted", "failed", "success",
	"complete", "completed", "running", "queued", "stopped", "rejected", "cancelled",
	"paused", "waiting", "unverified", "loading",
]);

export function opaqueDigest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function safeToolResultStatus(value: unknown): string | undefined {
	const status = typeof value === "string" ? value.trim().toLowerCase() : undefined;
	return status && SAFE_TOOL_RESULT_STATUSES.has(status) ? status : undefined;
}

export function toolResultMetrics(result: unknown): TraceAttributes {
	const resultRecord = record(result);
	const content = Array.isArray(resultRecord?.content) ? resultRecord.content : [];
	let textBytes = 0;
	let estimatedCharacters = 0;
	let imageCount = 0;
	for (const part of content) {
		const item = record(part);
		if (item?.type === "text" && typeof item.text === "string") {
			textBytes += Buffer.byteLength(item.text, "utf8");
			estimatedCharacters += item.text.length;
		} else if (item?.type === "image") {
			imageCount += 1;
			estimatedCharacters += 4_800;
		}
	}
	const details = record(resultRecord?.details);
	const status = safeToolResultStatus(details?.status);
	const operation = typeof details?.operation === "string" && details.operation ? opaqueDigest(details.operation) : undefined;
	const reportedTruncation = [details?.truncated, record(details?.truncation)?.truncated,
		record(details?.readback)?.truncated, record(details?.observation)?.truncated, record(details?.output)?.truncated]
		.filter((value): value is boolean => typeof value === "boolean");
	const execution = record(details?.execution);
	const verification = record(execution?.verification);
	const terminal = record(record(details?.lifecycleStatus)?.processTerminal);
	const phases = record(details?.codingPhases);
	const codingPhases = phases?.source === "tool-reported" ? phases : undefined;
	const evidence: TraceAttributes = {};
	for (const [key, value, allowed] of [
		["pi.tool.execution_outcome", execution?.outcome, ["worked", "didnt", "unknown"]],
		["pi.tool.verification_status", verification?.status, ["verified", "failed", "preexisting"]],
		["pi.tool.business_outcome", details?.businessOutcome, ["unknown", "unverified", "verified"]],
		["pi.tool.process_terminal_state", terminal?.state, ["pending", "observed", "unknown", "not-started"]],
		["pi.tool.subagent_phase", details?.subagentPhase, ["launch", "stop-request"]],
		["pi.tool.mutation_status", codingPhases?.mutation, ["applied"]],
		["pi.tool.followup_status", codingPhases?.followup, ["succeeded", "failed", "skipped"]],
		["pi.tool.coding_evidence_source", codingPhases?.source, ["tool-reported"]],
	] as const) {
		if (typeof value === "string" && (allowed as readonly string[]).includes(value)) evidence[key] = value;
	}
	// These are independent reported facts, not an inferred success/completion bit.
	if (typeof details?.acknowledged === "boolean") evidence["pi.tool.dispatch_acknowledged"] = details.acknowledged;
	const readback = record(details?.readback);
	if (typeof (readback?.contentComplete ?? details?.contentComplete) === "boolean") evidence["pi.tool.content_complete"] = (readback?.contentComplete ?? details?.contentComplete) as boolean;
	return {
		"pi.tool.result_text_bytes": Math.min(Number.MAX_SAFE_INTEGER, textBytes),
		"pi.tool.result_estimated_tokens": Math.ceil(estimatedCharacters / 4),
		"pi.tool.result_image_count": imageCount,
		...(reportedTruncation.length ? { "pi.tool.result_truncated": reportedTruncation.includes(true) } : {}),
		...evidence,
		...(operation ? { "pi.tool.operation_digest": operation } : {}),
		...(status ? { "pi.tool.result_status": status } : {}),
	};
}

export function toolLinkAttributes(detailsValue: unknown): TraceAttributes {
	const identifiers = {
		actionId: new Set<string>(),
		auditId: new Set<string>(),
		runId: new Set<string>(),
		asyncId: new Set<string>(),
		taskId: new Set<string>(),
	};
	let visited = 0;
	const visit = (value: unknown, depth: number): void => {
		if (depth > 3 || visited >= 64) return;
		if (Array.isArray(value)) {
			visited += 1;
			for (const child of value.slice(0, 16)) visit(child, depth + 1);
			return;
		}
		const item = record(value);
		if (!item) return;
		visited += 1;
		for (const [key, child] of Object.entries(item)) {
			if (Object.hasOwn(identifiers, key) && typeof child === "string") {
				if (child && identifiers[key as keyof typeof identifiers].size < 16) identifiers[key as keyof typeof identifiers].add(opaqueDigest(child));
			} else if (depth < 3 && child && typeof child === "object") visit(child, depth + 1);
		}
	};
	visit(detailsValue, 0);
	return {
		...(identifiers.actionId.size ? { "pi.link.action_id_digests": [...identifiers.actionId] } : {}),
		...(identifiers.auditId.size ? { "pi.link.audit_id_digests": [...identifiers.auditId] } : {}),
		...(identifiers.runId.size ? { "pi.link.run_id_digests": [...identifiers.runId] } : {}),
		...(identifiers.asyncId.size ? { "pi.link.async_id_digests": [...identifiers.asyncId] } : {}),
		...(identifiers.taskId.size ? { "pi.link.task_id_digests": [...identifiers.taskId] } : {}),
	};
}

export function toolSurfaceMetrics(pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">): TraceAttributes {
	try {
		const active = pi.getActiveTools();
		if (active.length > 256 || new Set(active).size !== active.length) return { "pi.tools.measurement": "unavailable" };
		const tools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
		const payloads: string[] = [];
		let bytes = 0;
		for (const name of active) {
			const tool = tools.get(name);
			if (!tool) return { "pi.tools.measurement": "unavailable" };
			const payload = JSON.stringify({ name, description: tool.description, parameters: tool.parameters });
			bytes += Buffer.byteLength(payload, "utf8");
			if (bytes > 1024 * 1024) return { "pi.tools.measurement": "unavailable" };
			payloads.push(payload);
		}
		// Which deferred capability groups are resident for this request. Derived
		// from the active tool names, so it reports observed surface state rather
		// than trusting the loader's own bookkeeping.
		const activeGroups = [...new Set(active.map((name) => CAPABILITY_GROUP_BY_TOOL.get(name)).filter((id): id is string => id !== undefined))].sort();
		return {
			"pi.tools.measurement": "public-metadata-not-wire",
			"pi.tools.active_count": active.length,
			"pi.tools.schema_bytes": bytes,
			"pi.tools.active_digest": opaqueDigest(JSON.stringify(active)),
			"pi.tools.schema_digest": opaqueDigest(JSON.stringify(payloads)),
			"pi.tools.deferred_groups": activeGroups,
		};
	} catch { return { "pi.tools.measurement": "unavailable" }; }
}
