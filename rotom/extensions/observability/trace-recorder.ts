import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LOCAL_TRACE_SCHEMA_V1, boundedTag, finiteNumber, record, type TraceAttributes, type TraceStatus } from "./trace-schema.ts";
import { assistantAttributes, contextUsageAttributes, modelAttributes, providerErrorAttributes, statusFromAssistant, summaryCallAttributes, usageAttributes } from "./model-metadata.ts";
import { CAPABILITY_GROUP_BY_TOOL, classifyFaultSide, classifyToolOutcome, opaqueDigest, toolErrorAttributes, toolLinkAttributes, toolResultMetrics } from "./tool-metadata.ts";
import type { LocalTraceWriterV1 } from "./trace-writer.ts";

type ActiveSpan = {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	startedAt: number;
};

function randomTraceId(): string { return randomBytes(16).toString("hex"); }
function randomSpanId(): string { return randomBytes(8).toString("hex"); }

export class LocalTraceRecorderV1 {
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
