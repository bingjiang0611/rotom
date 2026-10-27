import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFERRED_CAPABILITY_GROUPS } from "../third-party/deferred-tools/register.ts";

// Product-owned constant, imported rather than copied so a group or tool rename
// cannot silently desynchronise the trace's capability dimension.
const CAPABILITY_GROUP_BY_TOOL = new Map(
	DEFERRED_CAPABILITY_GROUPS.flatMap((group) => group.toolNames.map((name) => [name, group.id] as const)),
);

export const LOCAL_TRACE_SCHEMA_V1 = "rotom-local-trace/v1";
export const PROVIDER_METADATA_EVENT = "rotom:provider:metadata:v1";
const TRACE_DIRECTORY = "observability";
const TRACE_FLUSH_TIMEOUT_MS = 500;

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

type TraceStatus = "ok" | "error" | "aborted" | "unknown";
type TraceAttribute = string | number | boolean | string[] | number[] | boolean[];
type TraceAttributes = Record<string, TraceAttribute>;

// Bounded category of a failed provider request. Patterns match error texts seen
// in real rotom sessions; only the label (and an HTTP status parsed from a
// leading status code) is recorded, never the text. Anything else stays
// "unknown" rather than being guessed.
const PROVIDER_ERROR_CATEGORIES: ReadonlyArray<readonly [category: string, pattern: RegExp]> = [
	["timeout", /timed out|\btimeout\b/iu],
	["websocket", /^WebSocket (?:error|closed)\b/u],
	["aborted", /^This operation was aborted$/u],
	["overloaded", /overloaded/iu],
	["network", /^(?:fetch failed|terminated|Connection error\.)(?: \(caused by: .*\))?$|\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b|socket hang up|^upstream connect error/u],
	["auth", /^API key auth failed\b/u],
	["provider_error", /^Codex error:|^\{"type":"error"/u],
];
const LEADING_HTTP_STATUS = /^([45]\d\d)\b/u;
// Compaction failures wrap the provider error: "Compaction failed: Summarization failed: <error>".
const SUMMARY_FAILURE_PREFIX = /^Compaction failed: (?:[A-Za-z ]+ failed: )?/u;

export function providerErrorAttributes(errorMessage: unknown, httpStatus: number | undefined): TraceAttributes {
	const text = typeof errorMessage === "string" ? errorMessage.replace(SUMMARY_FAILURE_PREFIX, "").trim() : "";
	const status = Number(LEADING_HTTP_STATUS.exec(text)?.[1]) || (httpStatus !== undefined && httpStatus >= 400 ? httpStatus : undefined);
	if (status) return { "pi.ai.error.category": "http", "pi.ai.error.http_status": status };
	return { "pi.ai.error.category": PROVIDER_ERROR_CATEGORIES.find(([, pattern]) => pattern.test(text))?.[0] ?? "unknown" };
}

type ActiveSpan = {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	startedAt: number;
};

type TraceRecord = {
	schema: typeof LOCAL_TRACE_SCHEMA_V1;
	kind: "span_start" | "span_end";
	timestamp: string;
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	attributes?: TraceAttributes;
	status?: TraceStatus;
	durationMs?: number;
};

function enabledByEnvironment(value = process.env.ROTOM_OBSERVABILITY): boolean {
	return value === undefined || !/^(?:0|false|no)$/iu.test(value.trim());
}

function boundedTag(value: unknown, maximum = 256): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	return value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, maximum);
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Launcher-owned, identity-gated versions. Direct SDK or `-e` loads lack them and leave them absent. */
export function runtimeVersionAttributes(env: NodeJS.ProcessEnv = process.env): TraceAttributes {
	const product = env.ROTOM_PRODUCT_VERSION;
	const pi = env.ROTOM_VERIFIED_PI_VERSION;
	return {
		...(product && EXACT_VERSION.test(product) ? { "rotom.product.version": product } : {}),
		...(pi && EXACT_VERSION.test(pi) ? { "pi.runtime.version": pi } : {}),
	};
}

/** Per-request timing of a built-in compaction, keyed by summary kind. */
function summaryCallAttributes(value: unknown): TraceAttributes {
	if (!Array.isArray(value)) return {};
	const attributes: TraceAttributes = {};
	for (const call of value.slice(0, 2)) {
		const kind = call?.kind === "history" || call?.kind === "turn_prefix" ? call.kind : undefined;
		if (!kind) continue;
		for (const [field, name] of [["durationMs", "ms"], ["attempts", "attempts"], ["firstThinkingMs", "first_thinking_ms"], ["firstTextMs", "first_text_ms"]] as const) {
			const number = finiteNumber(call[field]);
			if (number !== undefined) attributes[`pi.compaction.${kind}.${name}`] = number;
		}
	}
	return attributes;
}

function usageAttributes(value: unknown): TraceAttributes {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const usage = value as Record<string, unknown>;
	const cost = usage.cost && typeof usage.cost === "object" && !Array.isArray(usage.cost)
		? finiteNumber((usage.cost as Record<string, unknown>).total)
		: undefined;
	return Object.fromEntries([
		["pi.usage.input_tokens", finiteNumber(usage.input)],
		["pi.usage.output_tokens", finiteNumber(usage.output)],
		["pi.usage.cache_read_tokens", finiteNumber(usage.cacheRead)],
		["pi.usage.cache_write_tokens", finiteNumber(usage.cacheWrite)],
		["pi.usage.reasoning_tokens", finiteNumber(usage.reasoning)],
		["pi.usage.total_tokens", finiteNumber(usage.totalTokens)],
		["pi.usage.cost", cost],
	].filter((entry): entry is [string, number] => entry[1] !== undefined));
}

type ToolOutcome = "ok" | "schema" | "permission" | "timeout" | "transport" | "tool_error" | "followup_failed" | "aborted" | "unknown_outcome" | "incomplete" | "unspecified";

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

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
function classifyToolOutcome(event: any): ToolOutcome {
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

function toolErrorAttributes(details: Record<string, unknown> | undefined): TraceAttributes {
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

function opaqueDigest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function safeToolResultStatus(value: unknown): string | undefined {
	const status = typeof value === "string" ? value.trim().toLowerCase() : undefined;
	return status && SAFE_TOOL_RESULT_STATUSES.has(status) ? status : undefined;
}

function toolResultMetrics(result: unknown): TraceAttributes {
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
		["pi.tool.followup_status", codingPhases?.followup, ["succeeded", "failed"]],
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

function toolLinkAttributes(detailsValue: unknown): TraceAttributes {
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

function statusFromAssistant(message: any): TraceStatus {
	if (message?.stopReason === "error") return "error";
	if (message?.stopReason === "aborted") return "aborted";
	return "ok";
}

function assistantAttributes(message: any): TraceAttributes {
	if (!message || message.role !== "assistant") return {};
	return {
		...(boundedTag(message.provider, 128) ? { "pi.ai.provider": boundedTag(message.provider, 128)! } : {}),
		...(boundedTag(message.model) ? { "pi.ai.model": boundedTag(message.model)! } : {}),
		...(boundedTag(message.api, 128) ? { "pi.ai.api": boundedTag(message.api, 128)! } : {}),
		...(boundedTag(message.stopReason, 64) ? { "pi.ai.response.stop_reason": boundedTag(message.stopReason, 64)! } : {}),
		...usageAttributes(message.usage),
	};
}

function modelAttributes(ctx: ExtensionContext): TraceAttributes {
	const model = ctx.model as any;
	return {
		...(boundedTag(model?.provider, 128) ? { "pi.ai.provider": boundedTag(model.provider, 128)! } : {}),
		...(boundedTag(model?.id) ? { "pi.ai.model": boundedTag(model.id)! } : {}),
		...(boundedTag(model?.api, 128) ? { "pi.ai.api": boundedTag(model.api, 128)! } : {}),
		...(finiteNumber(model?.contextWindow) !== undefined ? { "pi.ai.context_window": finiteNumber(model.contextWindow)! } : {}),
		...(boundedTag(ctx.thinkingLevel, 32) ? { "pi.ai.thinking_level": boundedTag(ctx.thinkingLevel, 32)! } : {}),
	};
}

function contextUsageAttributes(ctx: ExtensionContext): TraceAttributes {
	if (typeof ctx.getContextUsage !== "function") return {};
	const usage = ctx.getContextUsage();
	if (!usage) return {};
	return {
		...(finiteNumber(usage.tokens) !== undefined ? { "pi.context.tokens": finiteNumber(usage.tokens)! } : {}),
		...(finiteNumber(usage.contextWindow) !== undefined ? { "pi.context.window_tokens": finiteNumber(usage.contextWindow)! } : {}),
		...(finiteNumber(usage.percent) !== undefined ? { "pi.context.percent": finiteNumber(usage.percent)! } : {}),
	};
}

/** Public tool metadata only: not provider wire schemas, prompt tokens or cache-hit evidence. */
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

function randomTraceId(): string { return randomBytes(16).toString("hex"); }
function randomSpanId(): string { return randomBytes(8).toString("hex"); }

export function localTracePathForSessionFile(sessionFile: string): string {
	const fileName = basename(sessionFile).replace(/\.jsonl$/u, "");
	return join(dirname(sessionFile), TRACE_DIRECTORY, `${fileName}.trace.jsonl`);
}

async function ensurePrivateTraceDirectory(path: string): Promise<void> {
	let metadata;
	try {
		metadata = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await mkdir(path, { mode: 0o700 });
		metadata = await lstat(path);
	}
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("trace directory is not a private directory");
	if ((metadata.mode & 0o077) !== 0 || !ownerIsCurrent(metadata)) throw new Error("trace directory permissions are not private");
}

function ownerIsCurrent(metadata: any): boolean {
	return !process.getuid || metadata.uid === process.getuid();
}

export class LocalTraceWriterV1 {
	readonly path: string;
	private chain: Promise<void> = Promise.resolve();
	private failed = false;
	private enqueued = 0;
	private closeRequested = false;
	private handle?: Awaited<ReturnType<typeof open>>;
	private identity?: { dev: number; ino: number };
	private readonly appendLine?: (path: string, line: string) => Promise<void>;
	recordsWritten = 0;
	recordsDropped = 0;

	constructor(path: string, appendLine?: (path: string, line: string) => Promise<void>) {
		this.path = path;
		this.appendLine = appendLine;
	}

	private async openPrivateHandle(): Promise<Awaited<ReturnType<typeof open>>> {
		await ensurePrivateTraceDirectory(dirname(this.path));
		const flags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
		const handle = await open(this.path, flags, 0o600);
		try {
			const opened = await handle.stat();
			const current = await lstat(this.path);
			if (!opened.isFile() || (opened.mode & 0o077) !== 0 || !ownerIsCurrent(opened)
				|| current.isSymbolicLink() || !current.isFile() || (current.mode & 0o077) !== 0 || !ownerIsCurrent(current)
				|| opened.dev !== current.dev || opened.ino !== current.ino) throw new Error("trace path changed or is not private");
			this.identity = { dev: opened.dev, ino: opened.ino };
			return handle;
		} catch (error) { await handle.close().catch(() => {}); throw error; }
	}

	private async verifyPath(): Promise<void> {
		// The open descriptor's identity is immutable. Two pathname lstats are
		// sufficient to detect file replacement/symlinks and permission drift on
		// both the file and its parent, without another fstat or post-write probe.
		const [directory, current] = await Promise.all([lstat(dirname(this.path)), lstat(this.path)]);
		if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || !ownerIsCurrent(directory)
			|| !current.isFile() || (current.mode & 0o077) !== 0 || !ownerIsCurrent(current)
			|| this.identity!.dev !== current.dev || this.identity!.ino !== current.ino) throw new Error("trace path changed or is not private");
	}

	private async writeLine(line: string): Promise<void> {
		if (this.appendLine) { await this.appendLine(this.path, line); return; }
		if (this.handle) await this.verifyPath();
		else this.handle = await this.openPrivateHandle();
		await this.handle.writeFile(line, { encoding: "utf8" });
	}

	private noteDrop(): void {
		if (this.recordsDropped < this.enqueued - this.recordsWritten) this.recordsDropped += 1;
	}

	private async closeHandle(): Promise<void> {
		const handle = this.handle;
		this.handle = undefined;
		if (handle) await handle.close().catch(() => {});
	}

	append(record: TraceRecord): void {
		this.enqueued += 1;
		if (this.failed || this.closeRequested) { this.noteDrop(); return; }
		this.chain = this.chain.then(async () => {
			if (this.failed) { this.noteDrop(); return; }
			try { await this.writeLine(`${JSON.stringify(record)}\n`); this.recordsWritten += 1; }
			catch { this.failed = true; this.noteDrop(); }
		});
	}

	async flush(timeoutMs = TRACE_FLUSH_TIMEOUT_MS): Promise<boolean> {
		let timer: NodeJS.Timeout | undefined;
		const completed = await Promise.race([
			this.chain.then(() => true),
			new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref?.(); }),
		]);
		if (timer) clearTimeout(timer);
		if (!completed) {
			this.failed = true;
			this.recordsDropped = Math.max(this.recordsDropped, this.enqueued - this.recordsWritten);
		}
		return completed;
	}

	async close(timeoutMs = TRACE_FLUSH_TIMEOUT_MS): Promise<boolean> {
		if (!this.closeRequested) {
			this.closeRequested = true;
			// Drain already accepted writes; reject later appends immediately. Closing
			// remains queued even when the bounded caller stops waiting.
			this.chain = this.chain.then(() => this.closeHandle());
		}
		return this.flush(timeoutMs);
	}
	get healthy(): boolean { return !this.failed; }
}

class LocalTraceRecorderV1 {
	private readonly writer: LocalTraceWriterV1;
	private readonly sessionId: string;
	private sessionSpan: ActiveSpan;
	private operationSpan?: ActiveSpan;
	private operationStatus: TraceStatus = "ok";
	// Failed or aborted provider requests inside the operation. Pi retries in a
	// new agent run of the same operation, so a final successful run supersedes
	// these failures; the count keeps the recovery visible.
	private operationFailedRequests = 0;
	private agentSpan?: ActiveSpan;
	private turnSpan?: ActiveSpan;
	private providerSpan?: ActiveSpan;
	private providerStatus?: number;
	private providerName?: string;
	private providerFirstUpdateAt?: number;
	private providerFirstContentAt?: number;
	private providerResponseAt?: number;
	private providerAttributes: TraceAttributes = {};
	private startupSpan?: ActiveSpan;
	private prefillSpan?: ActiveSpan;
	private streamPhaseSpan?: ActiveSpan;
	private streamPhase?: "reasoning" | "generation";
	private compactionSpan?: ActiveSpan;
	private compactionRequestStarts = 0;
	private compactionSequence = 0;
	private activeCompactionSequence?: number;
	private pendingCompactionSequence?: number;
	private readonly toolSpans = new Map<string, { span: ActiveSpan; updates: number; capabilityGroup?: string }>();
	private previousToolSchemaDigest?: string;

	constructor(writer: LocalTraceWriterV1, sessionId: string, startAttributes: TraceAttributes) {
		this.writer = writer;
		this.sessionId = sessionId;
		this.sessionSpan = this.startSpan("pi.session.runtime", undefined, startAttributes);
	}

	private startSpan(name: string, parent?: ActiveSpan, attributes: TraceAttributes = {}): ActiveSpan {
		const span: ActiveSpan = {
			traceId: parent?.traceId ?? randomTraceId(),
			spanId: randomSpanId(),
			...(parent ? { parentSpanId: parent.spanId } : {}),
			name,
			startedAt: performance.now(),
		};
		this.writer.append({
			schema: LOCAL_TRACE_SCHEMA_V1,
			kind: "span_start",
			timestamp: new Date().toISOString(),
			traceId: span.traceId,
			spanId: span.spanId,
			...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
			name,
			attributes: { "pi.session.id": this.sessionId, ...attributes },
		});
		return span;
	}

	private endSpan(span: ActiveSpan | undefined, status: TraceStatus, attributes: TraceAttributes = {}): void {
		if (!span) return;
		this.writer.append({
			schema: LOCAL_TRACE_SCHEMA_V1,
			kind: "span_end",
			timestamp: new Date().toISOString(),
			traceId: span.traceId,
			spanId: span.spanId,
			...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
			name: span.name,
			status,
			durationMs: Math.max(0, performance.now() - span.startedAt),
			...(Object.keys(attributes).length ? { attributes } : {}),
		});
	}

	private ensureOperation(ctx: ExtensionContext): ActiveSpan {
		if (!this.operationSpan) this.operationSpan = this.startSpan("pi.agent.operation", this.sessionSpan, modelAttributes(ctx));
		return this.operationSpan;
	}

	beforeAgentStart(event: any, ctx: ExtensionContext): void {
		if (this.operationSpan) this.finishOperation("unknown");
		const selectedToolCount = Array.isArray(event.systemPromptOptions?.selectedTools)
			? event.systemPromptOptions.selectedTools.length
			: 0;
		const systemPrompt = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
		this.operationStatus = "ok";
		this.operationFailedRequests = 0;
		this.operationSpan = this.startSpan("pi.agent.operation", this.sessionSpan, {
			...modelAttributes(ctx),
			"pi.prompt.user_bytes": typeof event.prompt === "string" ? Buffer.byteLength(event.prompt, "utf8") : 0,
			"pi.prompt.image_count": Array.isArray(event.images) ? event.images.length : 0,
			"pi.prompt.system_bytes": Buffer.byteLength(systemPrompt, "utf8"),
			"pi.tools.active_count": selectedToolCount,
		});
	}

	agentStart(ctx: ExtensionContext): void {
		if (this.agentSpan) this.endSpan(this.agentSpan, "unknown");
		this.agentSpan = this.startSpan("pi.agent.run", this.ensureOperation(ctx), modelAttributes(ctx));
	}

	turnStart(event: any, ctx: ExtensionContext): void {
		if (this.turnSpan) this.finishTurn("unknown");
		const precedingCompactionSequence = this.pendingCompactionSequence;
		this.pendingCompactionSequence = undefined;
		this.turnSpan = this.startSpan("pi.agent.turn", this.agentSpan ?? this.ensureOperation(ctx), {
			"pi.turn.index": finiteNumber(event.turnIndex) ?? 0,
			...(precedingCompactionSequence !== undefined ? { "pi.compaction.preceding_sequence": precedingCompactionSequence } : {}),
		});
	}

	providerStart(ctx: ExtensionContext, surface: TraceAttributes = {}): void {
		const parent = this.compactionSpan ?? this.turnSpan;
		if (!parent) return;
		if (this.compactionSpan) {
			// A split-turn compaction sends its summary requests at the same time, and hooks
			// cannot tell which request a response belongs to. One request span therefore covers
			// all requests of the compaction; per-request timing arrives with session_compact.
			this.compactionRequestStarts++;
			if (this.providerSpan) return;
		}
		// Hooks only see request starts. A retry starts a new attempt, so the open
		// request's own end was never observed.
		if (this.providerSpan) this.finishProvider("unknown", { "pi.ai.request.end_reason": "superseded_by_next_request" });
		this.providerStatus = undefined;
		this.providerFirstUpdateAt = undefined;
		this.providerFirstContentAt = undefined;
		this.providerResponseAt = undefined;
		this.providerAttributes = {};
		this.providerName = ctx.model?.provider;
		const digest = typeof surface["pi.tools.schema_digest"] === "string" ? surface["pi.tools.schema_digest"] : undefined;
		this.providerSpan = this.startSpan("pi.ai.request", parent, {
			...modelAttributes(ctx),
			"pi.ai.operation": this.compactionSpan ? "compaction" : "stream",
			...surface,
			...(digest && this.previousToolSchemaDigest ? { "pi.tools.schema_changed": digest !== this.previousToolSchemaDigest } : {}),
		});
		// An unavailable sample breaks continuity; never compare across an unknown gap.
		this.previousToolSchemaDigest = digest;
		this.startupSpan = this.startSpan("pi.ai.startup", this.providerSpan, {
			"pi.measurement.scope": "client_observed",
		});
	}

	providerMetadata(value: unknown): void {
		const event = record(value);
		if (!this.providerSpan || event?.provider !== this.providerName) return;
		const attributes = record(event?.attributes);
		if (!attributes) return;
		// Trusted product-provider contract: producers own content removal and exact
		// enum allowlists. This layer enforces only generic metadata shape/bounds,
		// never consumes raw diagnostics, error bodies, headers or tool arguments.
		const metadata: TraceAttributes = {};
		const tag = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9_.-]{1,64}$/u.test(value);
		for (const [key, candidate] of Object.entries(attributes).slice(0, 32)) {
			if (!/^pi\.ai\.[a-z0-9_.]{1,96}$/u.test(key)) continue;
			if (key === "pi.ai.error.category" && this.providerAttributes[key] === "http" && candidate !== "http") continue;
			if (tag(candidate) || typeof candidate === "boolean"
				|| (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0)) metadata[key] = candidate;
			else if (Array.isArray(candidate) && candidate.length <= 16 && candidate.every(tag)) metadata[key] = candidate;
		}
		this.providerAttributes = { ...this.providerAttributes, ...metadata };
	}

	private failureAttributes(errorMessage: unknown): TraceAttributes {
		const generic = providerErrorAttributes(errorMessage, this.providerStatus);
		if (generic["pi.ai.error.category"] === "http") return { ...this.providerAttributes, ...generic };
		const provided = this.providerAttributes["pi.ai.error.category"];
		return provided && provided !== "unknown" ? { ...generic, ...this.providerAttributes } : { ...this.providerAttributes, ...generic };
	}

	providerResponse(status: unknown): void {
		// Inside a compaction several responses share one span: keep the first error status.
		const keepError = this.compactionSpan !== undefined && this.providerStatus !== undefined && this.providerStatus >= 400;
		if (!keepError) this.providerStatus = finiteNumber(status);
		if (!this.providerSpan || this.providerResponseAt !== undefined) return;
		this.providerResponseAt = performance.now();
		this.endSpan(this.startupSpan, "ok");
		this.startupSpan = undefined;
		this.prefillSpan = this.startSpan("pi.ai.prefill", this.providerSpan, {
			"pi.measurement.scope": "response_headers_to_first_content",
		});
	}

	messageUpdate(event: any): void {
		if (!this.providerSpan) return;
		const now = performance.now();
		if (this.providerFirstUpdateAt === undefined) this.providerFirstUpdateAt = now;
		const type = boundedTag(event?.assistantMessageEvent?.type, 64);
		const phase = type === "thinking_start" || type === "thinking_delta"
			? "reasoning"
			: type === "text_start" || type === "text_delta" || type === "toolcall_start" || type === "toolcall_delta"
				? "generation"
				: undefined;
		if (phase) {
			if (this.providerFirstContentAt === undefined) {
				this.providerFirstContentAt = now;
				this.endSpan(this.startupSpan, "ok");
				this.startupSpan = undefined;
				this.endSpan(this.prefillSpan, "ok");
				this.prefillSpan = undefined;
			}
			if (phase !== this.streamPhase) {
				this.endSpan(this.streamPhaseSpan, "ok");
				this.streamPhase = phase;
				this.streamPhaseSpan = this.startSpan(`pi.ai.${phase}`, this.providerSpan, {
					"pi.measurement.scope": "client_observed_stream",
				});
			}
			return;
		}
		if ((type === "thinking_end" && this.streamPhase === "reasoning")
			|| ((type === "text_end" || type === "toolcall_end") && this.streamPhase === "generation")) {
			this.endSpan(this.streamPhaseSpan, "ok");
			this.streamPhaseSpan = undefined;
			this.streamPhase = undefined;
		}
	}

	messageEnd(message: any, ctx: ExtensionContext): void {
		if (message?.role !== "assistant" || !this.providerSpan) return;
		const status = statusFromAssistant(message);
		if (status !== "ok") {
			this.operationStatus = status;
			this.operationFailedRequests++;
		}
		this.finishProvider(status, {
			...assistantAttributes(message),
			...(status === "error" ? this.failureAttributes(message.errorMessage) : {}),
			...contextUsageAttributes(ctx),
		});
	}

	toolStart(event: any, ctx: ExtensionContext): void {
		const rawToolCallId = typeof event.toolCallId === "string" && event.toolCallId ? event.toolCallId : undefined;
		if (!rawToolCallId) return;
		const existing = this.toolSpans.get(rawToolCallId);
		// Superseded before its own end event arrived: a lifecycle gap, not a
		// proven bad step. `incomplete` keeps it distinct from `unknown_outcome`.
		if (existing) this.endSpan(existing.span, "unknown", {
			"pi.tool.outcome": "incomplete",
			"pi.tool.update_count": existing.updates,
			...(existing.capabilityGroup ? { "pi.tool.capability_group": existing.capabilityGroup } : {}),
		});
		const capabilityGroup = typeof event.toolName === "string" ? CAPABILITY_GROUP_BY_TOOL.get(event.toolName) : undefined;
		const span = this.startSpan("pi.tool.execute", this.turnSpan ?? this.agentSpan ?? this.ensureOperation(ctx), {
			"pi.tool.name": boundedTag(event.toolName, 128) ?? "unknown",
			"pi.tool.call_id_digest": opaqueDigest(rawToolCallId),
			...(capabilityGroup ? { "pi.tool.capability_group": capabilityGroup } : {}),
		});
		this.toolSpans.set(rawToolCallId, { span, updates: 0, ...(capabilityGroup ? { capabilityGroup } : {}) });
	}

	toolUpdate(event: any): void {
		const current = typeof event.toolCallId === "string" ? this.toolSpans.get(event.toolCallId) : undefined;
		if (current) current.updates += 1;
	}

	toolEnd(event: any): void {
		const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
		const current = toolCallId ? this.toolSpans.get(toolCallId) : undefined;
		if (!current) return;
		this.toolSpans.delete(toolCallId!);
		const outcome = classifyToolOutcome(event);
		const faultSide = classifyFaultSide(event, outcome);
		const status: TraceStatus = outcome === "aborted"
			? "aborted"
			: outcome === "unknown_outcome" || outcome === "unspecified"
				? "unknown"
				: outcome === "ok"
					? "ok"
					: "error";
		this.endSpan(current.span, status, {
			"pi.tool.is_error": event.isError === true,
			"pi.tool.update_count": current.updates,
			"pi.tool.outcome": outcome,
			...(faultSide ? { "pi.tool.fault_side": faultSide } : {}),
			...(event.isError === true ? toolErrorAttributes(record(event.result?.details)) : {}),
			// Repeated from span start: a reader merging start into end sees only the
			// end attributes, and the aggregation groups over end records.
			...(current.capabilityGroup ? { "pi.tool.capability_group": current.capabilityGroup } : {}),
			...toolResultMetrics(event.result),
			...toolLinkAttributes(event.result?.details),
			...usageAttributes(event.result?.usage),
		});
	}

	turnEnd(event: any): void {
		const status = event.message?.role === "assistant" ? statusFromAssistant(event.message) : "ok";
		this.finishTurn(status, { "pi.turn.index": finiteNumber(event.turnIndex) ?? 0 });
	}

	agentEnd(event: any): void {
		const lastAssistant = Array.isArray(event.messages)
			? [...event.messages].reverse().find((message) => message?.role === "assistant")
			: undefined;
		const status = statusFromAssistant(lastAssistant);
		// The latest run decides the operation: an automatic retry that succeeds
		// recovers the earlier failed run instead of leaving the operation failed.
		this.operationStatus = status;
		this.endSpan(this.agentSpan, status, assistantAttributes(lastAssistant));
		this.agentSpan = undefined;
	}

	compactionStart(event: any): void {
		this.finishProvider("unknown", { "pi.ai.request.end_reason": "compaction_started" });
		if (this.compactionSpan) this.endSpan(this.compactionSpan, "unknown", {
			...(this.activeCompactionSequence !== undefined ? { "pi.compaction.sequence": this.activeCompactionSequence } : {}),
		});
		const sequence = ++this.compactionSequence;
		this.activeCompactionSequence = sequence;
		this.compactionRequestStarts = 0;
		this.compactionSpan = this.startSpan("pi.session.compaction", this.operationSpan ?? this.sessionSpan, {
			"pi.compaction.sequence": sequence,
			"pi.compaction.reason": boundedTag(event.reason, 32) ?? "unknown",
			"pi.compaction.will_retry": event.willRetry === true,
			...(finiteNumber(event.preparation?.tokensBefore) !== undefined ? { "pi.compaction.tokens_before": finiteNumber(event.preparation.tokensBefore)! } : {}),
		});
	}

	compactionEnd(event: any, failed: boolean): void {
		if (!this.compactionSpan) return;
		const status: TraceStatus = failed ? (event.aborted === true ? "aborted" : "error") : "ok";
		const sequence = this.activeCompactionSequence;
		const errorAttributes = status === "error" ? this.failureAttributes(event.errorMessage) : {};
		this.finishProvider(status, { ...errorAttributes, ...usageAttributes(event.compactionEntry?.usage) });
		this.endSpan(this.compactionSpan, status, {
			...errorAttributes,
			...(sequence !== undefined ? { "pi.compaction.sequence": sequence } : {}),
			"pi.compaction.reason": boundedTag(event.reason, 32) ?? "unknown",
			"pi.compaction.will_retry": event.willRetry === true,
			"pi.compaction.from_extension": event.fromExtension === true,
			"pi.compaction.request_starts": this.compactionRequestStarts,
			...summaryCallAttributes(event.summaryCalls),
		});
		if (!failed && sequence !== undefined) this.pendingCompactionSequence = sequence;
		this.compactionSpan = undefined;
		this.activeCompactionSequence = undefined;
	}

	settled(): void { this.finishOperation(this.operationStatus); }

	private finishProvider(status: TraceStatus, attributes: TraceAttributes = {}): void {
		if (!this.providerSpan) return;
		this.endSpan(this.streamPhaseSpan, status);
		this.endSpan(this.prefillSpan, status);
		this.endSpan(this.startupSpan, status);
		this.streamPhaseSpan = undefined;
		this.streamPhase = undefined;
		this.prefillSpan = undefined;
		this.startupSpan = undefined;
		this.endSpan(this.providerSpan, status, {
			...(this.providerStatus !== undefined ? { "pi.ai.http.status_code": this.providerStatus } : {}),
			...(this.providerResponseAt !== undefined ? { "pi.ai.http.time_to_response_ms": Math.max(0, this.providerResponseAt - this.providerSpan.startedAt) } : {}),
			...(this.providerFirstUpdateAt !== undefined ? { "pi.ai.stream.time_to_first_chunk_ms": Math.max(0, this.providerFirstUpdateAt - this.providerSpan.startedAt) } : {}),
			...(this.providerFirstContentAt !== undefined ? { "pi.ai.stream.time_to_first_content_ms": Math.max(0, this.providerFirstContentAt - this.providerSpan.startedAt) } : {}),
			...this.providerAttributes,
			...attributes,
		});
		this.providerSpan = undefined;
		this.providerStatus = undefined;
		this.providerAttributes = {};
		this.providerFirstUpdateAt = undefined;
		this.providerFirstContentAt = undefined;
		this.providerResponseAt = undefined;
	}

	private finishTurn(status: TraceStatus, attributes: TraceAttributes = {}): void {
		this.finishProvider("unknown", { "pi.ai.request.end_reason": "turn_closed" });
		for (const [toolCallId, current] of this.toolSpans) {
			// Turn torn down while the tool was still open: no end event of its own.
			this.endSpan(current.span, "unknown", {
				"pi.tool.outcome": "incomplete",
				"pi.tool.update_count": current.updates,
				...(current.capabilityGroup ? { "pi.tool.capability_group": current.capabilityGroup } : {}),
			});
			this.toolSpans.delete(toolCallId);
		}
		this.endSpan(this.turnSpan, status, attributes);
		this.turnSpan = undefined;
	}

	private finishOperation(status: TraceStatus): void {
		this.finishTurn(status === "ok" ? "unknown" : status);
		if (this.agentSpan) this.endSpan(this.agentSpan, status);
		this.agentSpan = undefined;
		this.endSpan(this.operationSpan, status, this.operationFailedRequests > 0
			? { "pi.operation.failed_request_count": this.operationFailedRequests }
			: {});
		this.operationSpan = undefined;
		this.operationStatus = "ok";
		this.operationFailedRequests = 0;
	}

	async shutdown(reason: string): Promise<void> {
		if (this.compactionSpan) {
			this.finishProvider("aborted");
			this.endSpan(this.compactionSpan, "aborted", {
				...(this.activeCompactionSequence !== undefined ? { "pi.compaction.sequence": this.activeCompactionSequence } : {}),
			});
			this.compactionSpan = undefined;
			this.activeCompactionSequence = undefined;
		}
		if (this.operationSpan) this.finishOperation("aborted");
		this.endSpan(this.sessionSpan, "ok", { "pi.session.shutdown_reason": boundedTag(reason, 32) ?? "unknown" });
		await this.writer.close();
	}
}

export function createObservabilityExtensionV1() {
	return function observabilityExtension(pi: ExtensionAPI): void {
		let recorder: LocalTraceRecorderV1 | undefined;
		let writer: LocalTraceWriterV1 | undefined;
		let unavailableReason = "session-not-started";

		pi.registerCommand("trace", {
			description: "Show the current local metadata trace path and write status",
			async handler(_args, ctx) {
				await writer?.flush();
				const message = writer
					? `Local metadata trace: ${writer.path}\nrecords=${writer.recordsWritten} dropped=${writer.recordsDropped} healthy=${writer.healthy}`
					: `Local metadata trace unavailable: ${unavailableReason}`;
				ctx.ui.notify(message, writer?.healthy === false ? "warning" : "info");
			},
		});

		pi.events.on(PROVIDER_METADATA_EVENT, (metadata) => recorder?.providerMetadata(metadata));

		pi.on("session_start", async (event, ctx) => {
			if (recorder) await recorder.shutdown("reload");
			recorder = undefined;
			writer = undefined;
			if (!enabledByEnvironment()) { unavailableReason = "disabled-by-ROTOM_OBSERVABILITY"; return; }
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) { unavailableReason = "ephemeral-session"; return; }
			writer = new LocalTraceWriterV1(localTracePathForSessionFile(sessionFile));
			recorder = new LocalTraceRecorderV1(writer, ctx.sessionManager.getSessionId(), {
				"pi.session.start_reason": event.reason,
				"pi.session.mode": ctx.mode,
				...runtimeVersionAttributes(),
			});
			unavailableReason = "available";
		});
		pi.on("before_agent_start", (event, ctx) => recorder?.beforeAgentStart(event, ctx));
		pi.on("agent_start", (_event, ctx) => recorder?.agentStart(ctx));
		pi.on("turn_start", (event, ctx) => recorder?.turnStart(event, ctx));
		pi.on("before_provider_headers", (_event, ctx) => {
			if (recorder) recorder.providerStart(ctx, toolSurfaceMetrics(pi));
		});
		pi.on("after_provider_response", (event) => recorder?.providerResponse(event.status));
		pi.on("message_update", (event) => recorder?.messageUpdate(event));
		pi.on("message_end", (event, ctx) => recorder?.messageEnd(event.message, ctx));
		pi.on("tool_execution_start", (event, ctx) => recorder?.toolStart(event, ctx));
		pi.on("tool_execution_update", (event) => recorder?.toolUpdate(event));
		pi.on("tool_execution_end", (event) => recorder?.toolEnd(event));
		pi.on("turn_end", (event) => recorder?.turnEnd(event));
		pi.on("agent_end", (event) => recorder?.agentEnd(event));
		pi.on("agent_settled", () => recorder?.settled());
		pi.on("session_before_compact", (event) => recorder?.compactionStart(event));
		pi.on("session_compact", (event) => recorder?.compactionEnd(event, false));
		pi.on("session_compact_failed", (event) => recorder?.compactionEnd(event, true));
		pi.on("session_shutdown", async (event) => {
			await recorder?.shutdown(event.reason);
			recorder = undefined;
		});
	};
}

export default createObservabilityExtensionV1();
