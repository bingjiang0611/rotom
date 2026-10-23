import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { qoderChunks } from "../qoder/transport.mjs";
import { qoderDiagnosticAttributes, qoderErrorAttributes, PROVIDER_METADATA_EVENT } from "../qoder/diagnostics.mjs";
import { providerErrorAttributes, classifyFaultSide, createObservabilityExtensionV1, LOCAL_TRACE_SCHEMA_V1, LocalTraceWriterV1, localTracePathForSessionFile, runtimeVersionAttributes, toolSurfaceMetrics } from "./index.ts";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

function extensionHarness(toolApi: Record<string, unknown> = {}) {
	const handlers = new Map<string, Handler[]>();
	const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
	const commands = new Map<string, any>();
	const pi = {
		...toolApi,
		events: {
			emit(channel: string, data: unknown) { for (const handler of eventHandlers.get(channel) ?? []) handler(data); },
			on(channel: string, handler: (data: unknown) => void) {
				eventHandlers.set(channel, [...(eventHandlers.get(channel) ?? []), handler]);
				return () => eventHandlers.set(channel, (eventHandlers.get(channel) ?? []).filter((candidate) => candidate !== handler));
			},
		},
		on(event: string, handler: Handler) {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
		registerCommand(name: string, command: any) { commands.set(name, command); },
	} as any;
	createObservabilityExtensionV1()(pi);
	return {
		handlers,
		commands,
		emitDiagnostic(value: unknown) { pi.events.emit(PROVIDER_METADATA_EVENT, { provider: "qoder", attributes: qoderDiagnosticAttributes(value) }); },
		emitMetadata(value: unknown, provider = "qoder") { pi.events.emit(PROVIDER_METADATA_EVENT, { provider, attributes: value }); },
		async emit(event: string, value: any, ctx: any) {
			for (const handler of handlers.get(event) ?? []) await handler(value, ctx);
		},
	};
}

function assistantMessage(stopReason = "toolUse") {
	return {
		role: "assistant",
		provider: "test-provider",
		model: "test-model",
		api: "test-api",
		stopReason,
		usage: {
			input: 120,
			output: 30,
			cacheRead: 40,
			cacheWrite: 5,
			reasoning: 7,
			totalTokens: 195,
			cost: { total: 0.0123 },
		},
	};
}

test("local observability writes correlated metadata spans without prompt, args, or results", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sessionDirectory = join(root, "sessions");
	mkdirSync(sessionDirectory, { recursive: true });
	const sessionFile = join(sessionDirectory, "session.jsonl");
	writeFileSync(sessionFile, "{\"type\":\"session\"}\n", { mode: 0o600 });
	const tracePath = localTracePathForSessionFile(sessionFile);
	const sessionManager = {
		getSessionFile: () => sessionFile,
		getSessionId: () => "session-123",
	};
	const notices: Array<{ message: string; level: string }> = [];
	const ctx = {
		mode: "print",
		model: { provider: "test-provider", id: "test-model", api: "test-api" },
		thinkingLevel: "medium",
		sessionManager,
		getContextUsage: () => ({ tokens: 96_000, contextWindow: 128_000, percent: 75 }),
		ui: { notify(message: string, level: string) { notices.push({ message, level }); } },
	};
	const harness = extensionHarness();
	assert.equal(harness.commands.has("trace"), true);
	assert.equal(harness.handlers.has("tool_call"), false, "observability must not intercept or alter tool behavior");

	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await harness.emit("before_agent_start", {
		type: "before_agent_start",
		prompt: "Authorization: Bearer user-prompt-secret",
		images: [],
		systemPrompt: "system prompt without business payload",
		systemPromptOptions: { selectedTools: ["read", "secret_named_tool"] },
	}, ctx);
	await harness.emit("agent_start", { type: "agent_start" }, ctx);
	await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, ctx);
	await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: { authorization: "secret-provider-header" } }, ctx);
	await harness.emit("after_provider_response", { type: "after_provider_response", status: 200, headers: { "set-cookie": "secret-cookie" } }, ctx);
	for (const assistantMessageEvent of [
		{ type: "thinking_start" },
		{ type: "thinking_delta", delta: "secret assistant stream" },
		{ type: "thinking_end" },
		{ type: "text_start" },
		{ type: "text_delta", delta: "secret assistant stream" },
		{ type: "text_end" },
	]) await harness.emit("message_update", { type: "message_update", assistantMessageEvent }, ctx);
	await harness.emit("message_end", { type: "message_end", message: assistantMessage("toolUse") }, ctx);
	await harness.emit("tool_execution_start", {
		type: "tool_execution_start",
		toolCallId: "/private/tool-call-1",
		toolName: "bash",
		args: { command: "echo secret-tool-argument" },
	}, ctx);
	await harness.emit("tool_execution_update", {
		type: "tool_execution_update",
		toolCallId: "/private/tool-call-1",
		toolName: "bash",
		partialResult: { content: "secret partial output" },
	}, ctx);
	await harness.emit("tool_execution_end", {
		type: "tool_execution_end",
		toolCallId: "/private/tool-call-1",
		toolName: "bash",
		isError: false,
		result: {
			content: [{ type: "text", text: "secret final output" }, { type: "image", source: { type: "base64", data: "secret-image" } }],
			details: { actionId: "/Users/name/private/customer.txt", results: [{ runId: "short-secret-run-body" }], operation: "/tmp/private-operation", status: "unknown", truncated: true, secret: "must-not-leak" },
		},
	}, ctx);
	await harness.emit("tool_execution_start", {
		type: "tool_execution_start",
		toolCallId: "tool-call-timeout",
		toolName: "remote_tool",
		args: {},
	}, ctx);
	await harness.emit("tool_execution_end", {
		type: "tool_execution_end",
		toolCallId: "tool-call-timeout",
		toolName: "remote_tool",
		isError: true,
		result: { content: [], details: { code: "timeout", taskId: "/private/task-789" } },
	}, ctx);
	const parallelToolIds = [`${"x".repeat(300)}-first`, `${"x".repeat(300)}-second\u0001`];
	for (const [index, toolCallId] of parallelToolIds.entries()) await harness.emit("tool_execution_start", {
		type: "tool_execution_start",
		toolCallId,
		toolName: `parallel-${index}`,
		args: { secret: `parallel-secret-${index}` },
	}, ctx);
	for (const [index, toolCallId] of [...parallelToolIds].reverse().entries()) await harness.emit("tool_execution_end", {
		type: "tool_execution_end",
		toolCallId,
		toolName: "parallel",
		isError: false,
		result: index === 0 ? { details: { status: "short-secret-status-body" } } : { details: { status: "failed" } },
	}, ctx);
	await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message: assistantMessage("stop"), toolResults: [] }, ctx);
	await harness.emit("agent_end", { type: "agent_end", messages: [assistantMessage("stop")] }, ctx);
	await harness.emit("agent_settled", { type: "agent_settled" }, ctx);
	await harness.emit("session_before_compact", {
		type: "session_before_compact",
		reason: "manual",
		willRetry: false,
		preparation: { tokensBefore: 42_000 },
	}, ctx);
	await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: { authorization: "secret-compaction-header" } }, ctx);
	await harness.emit("after_provider_response", { type: "after_provider_response", status: 201, headers: {} }, ctx);
	await harness.emit("session_compact", {
		type: "session_compact",
		reason: "manual",
		willRetry: false,
		fromExtension: false,
		compactionEntry: { usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 60, cost: { total: 0.001 } } },
	}, ctx);
	await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

	const text = readFileSync(tracePath, "utf8");
	for (const secret of [
		"user-prompt-secret",
		"secret-provider-header",
		"secret-compaction-header",
		"secret-cookie",
		"secret assistant stream",
		"secret-tool-argument",
		"secret partial output",
		"secret final output",
		"secret_named_tool",
		"must-not-leak",
		"secret-image",
		"/Users/name/private/customer.txt",
		"short-secret-run-body",
		"/tmp/private-operation",
		"/private/task-789",
		"/private/tool-call-1",
		"short-secret-status-body",
	]) assert.equal(text.includes(secret), false, `trace leaked ${secret}`);
	const records = text.trim().split("\n").map((line) => JSON.parse(line));
	assert.ok(records.length >= 14);
	assert.ok(records.every((record) => record.schema === LOCAL_TRACE_SCHEMA_V1));
	assert.ok(records.every((record) => /^[0-9a-f]{32}$/u.test(record.traceId)));
	assert.ok(records.every((record) => /^[0-9a-f]{16}$/u.test(record.spanId)));
	const digest = (value: string) => createHash("sha256").update(value).digest("hex");
	const starts = records.filter((record) => record.kind === "span_start");
	const ends = records.filter((record) => record.kind === "span_end");
	assert.deepEqual(new Set(ends.map((record) => record.spanId)), new Set(starts.map((record) => record.spanId)), "normal shutdown must close every span");
	const sessionStart = starts.find((record) => record.name === "pi.session.runtime");
	const operationStart = starts.find((record) => record.name === "pi.agent.operation");
	const turnStart = starts.find((record) => record.name === "pi.agent.turn");
	const providerEnds = ends.filter((record) => record.name === "pi.ai.request");
	const providerEnd = providerEnds[0];
	const compactionStart = starts.find((record) => record.name === "pi.session.compaction");
	const compactionProviderStart = starts.filter((record) => record.name === "pi.ai.request")[1];
	const toolStarts = starts.filter((record) => record.name === "pi.tool.execute");
	const toolEnds = ends.filter((record) => record.name === "pi.tool.execute");
	const toolStart = toolStarts[0];
	const toolEnd = toolEnds[0];
	assert.equal(operationStart.parentSpanId, sessionStart.spanId);
	assert.equal(turnStart.traceId, sessionStart.traceId);
	assert.equal(toolStart.parentSpanId, turnStart.spanId);
	assert.equal(toolStart.attributes["pi.tool.call_id_digest"], digest("/private/tool-call-1"));
	assert.equal(toolEnd.attributes["pi.tool.update_count"], 1);
	assert.equal(toolEnd.attributes["pi.tool.outcome"], "unknown_outcome");
	assert.equal(toolEnd.attributes["pi.tool.result_text_bytes"], Buffer.byteLength("secret final output"));
	assert.equal(toolEnd.attributes["pi.tool.result_estimated_tokens"], Math.ceil(("secret final output".length + 4_800) / 4));
	assert.equal(toolEnd.attributes["pi.tool.result_image_count"], 1);
	assert.equal(toolEnd.attributes["pi.tool.result_truncated"], true);
	assert.equal(toolEnd.attributes["pi.tool.operation_digest"], digest("/tmp/private-operation"));
	assert.deepEqual(toolEnd.attributes["pi.link.action_id_digests"], [digest("/Users/name/private/customer.txt")]);
	assert.deepEqual(toolEnd.attributes["pi.link.run_id_digests"], [digest("short-secret-run-body")]);
	const timeoutEnd = toolEnds.find((record) => record.attributes?.["pi.link.task_id_digests"]?.includes(digest("/private/task-789")));
	assert.ok(timeoutEnd);
	assert.equal(timeoutEnd.attributes["pi.tool.outcome"], "timeout");
	assert.equal(timeoutEnd.attributes["pi.tool.fault_side"], "environment", "a timeout is an external system failure, not our harness or the model");
	assert.equal(timeoutEnd.status, "error");
	assert.equal(toolEnds.some((record) => record.attributes?.["pi.tool.outcome"] === "tool_error" && record.status === "error"), true, "structured failed status must be an error even when the tool did not throw");
	assert.equal(toolStarts.length, 4, "parallel tools with colliding bounded display ids must retain distinct spans");
	assert.equal(toolEnds.length, 4);
	assert.equal(toolEnds.filter((record) => record.status === "ok").length, 1);
	assert.equal(toolEnds.filter((record) => record.status === "unknown").length, 1);
	assert.equal(toolEnds.filter((record) => record.status === "error").length, 2);
	assert.equal(compactionProviderStart.parentSpanId, compactionStart.spanId, "compaction provider must be nested under compaction");
	assert.equal(starts.filter((record) => record.name === "pi.agent.operation").length, 1, "compaction must not create a phantom agent operation");
	assert.equal(providerEnds[1].attributes["pi.ai.http.status_code"], 201);
	assert.equal(providerEnds[1].attributes["pi.usage.total_tokens"], 60);
	assert.equal(providerEnd.attributes["pi.ai.http.status_code"], 200);
	assert.equal(providerEnd.attributes["pi.usage.total_tokens"], 195);
	assert.equal(providerEnd.attributes["pi.usage.reasoning_tokens"], 7);
	assert.equal(providerEnd.attributes["pi.context.tokens"], 96_000);
	assert.equal(providerEnd.attributes["pi.context.window_tokens"], 128_000);
	assert.equal(providerEnd.attributes["pi.context.percent"], 75);
	assert.ok(providerEnd.attributes["pi.ai.http.time_to_response_ms"] >= 0);
	assert.ok(providerEnd.attributes["pi.ai.stream.time_to_first_chunk_ms"] >= 0);
	assert.ok(providerEnd.attributes["pi.ai.stream.time_to_first_content_ms"] >= 0);
	assert.equal(starts.some((record) => record.name === "pi.ai.startup"), true);
	assert.equal(starts.some((record) => record.name === "pi.ai.prefill"), true);
	assert.equal(starts.some((record) => record.name === "pi.ai.reasoning"), true);
	assert.equal(starts.some((record) => record.name === "pi.ai.generation"), true);
	assert.ok(ends.every((record) => record.durationMs >= 0));
	assert.equal(statSync(tracePath).mode & 0o777, 0o600);
	assert.equal(statSync(join(sessionDirectory, "observability")).mode & 0o777, 0o700);

	await harness.commands.get("trace").handler("", ctx);
	assert.match(notices.at(-1)?.message ?? "", /records=\d+ dropped=0 healthy=true/u);
});

test("Qoder diagnostics attach only allowlisted metadata to the active Qoder provider span", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-qoder-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sessionDirectory = join(root, "sessions");
	mkdirSync(sessionDirectory, { recursive: true });
	const sessionFile = join(sessionDirectory, "session.jsonl");
	writeFileSync(sessionFile, "{\"type\":\"session\"}\n", { mode: 0o600 });
	const harness = extensionHarness();
	const ctx = {
		mode: "print",
		model: { provider: "qoder", id: "ultimate", api: "openai-completions" },
		thinkingLevel: "high",
		sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "qoder-session" },
		getContextUsage: () => ({ tokens: 35_472, contextWindow: 272_000, percent: 13.04 }),
		ui: { notify() {} },
	};

	harness.emitDiagnostic({ code: "upstream_error_frame", status: 418, hasError: true, body: "PRIVATE_BEFORE_SPAN" });
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "PRIVATE_PROMPT", systemPrompt: "", images: [] }, ctx);
	await harness.emit("agent_start", { type: "agent_start" }, ctx);
	await harness.emit("turn_start", { type: "turn_start", turnIndex: 0 }, ctx);
	await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} }, ctx);
	await harness.emit("after_provider_response", { type: "after_provider_response", status: 200, headers: {} }, ctx);
	harness.emitDiagnostic({
		code: "upstream_error_frame",
		status: 503,
		hasError: true,
		body: "PRIVATE_UPSTREAM_BODY",
		error: { message: "PRIVATE_UPSTREAM_MESSAGE" },
		categories: ["PRIVATE_CATEGORY"],
	});
	harness.emitMetadata(qoderErrorAttributes("Qoder: upstream_error_frame", 503));
	await harness.emit("message_end", {
		type: "message_end",
		message: { ...assistantMessage("error"), provider: "qoder", model: "ultimate", errorMessage: "Qoder: upstream_error_frame" },
	}, ctx);
	await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} }, ctx);
	harness.emitDiagnostic({ code: "transport_failure", phase: "request", error: "PRIVATE_TRANSPORT_DETAIL" });
	harness.emitMetadata(qoderErrorAttributes("Qoder: request_failed"));
	await harness.emit("message_end", {
		type: "message_end",
		message: { ...assistantMessage("error"), provider: "qoder", model: "ultimate", errorMessage: "Qoder: request_failed" },
	}, ctx);
	await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} }, ctx);
	harness.emitMetadata(qoderErrorAttributes("Qoder: model_refusal"));
	await harness.emit("message_end", {
		type: "message_end",
		message: { ...assistantMessage("error"), provider: "qoder", model: "ultimate", errorMessage: "Qoder: model_refusal" },
	}, ctx);
	await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

	const text = readFileSync(localTracePathForSessionFile(sessionFile), "utf8");
	for (const secret of ["PRIVATE_BEFORE_SPAN", "PRIVATE_PROMPT", "PRIVATE_UPSTREAM_BODY", "PRIVATE_UPSTREAM_MESSAGE", "PRIVATE_CATEGORY", "PRIVATE_TRANSPORT_DETAIL"]) {
		assert.equal(text.includes(secret), false, `trace leaked ${secret}`);
	}
	const providerEnds = text.trim().split("\n").map((line) => JSON.parse(line))
		.filter((record) => record.kind === "span_end" && record.name === "pi.ai.request");
	assert.equal(providerEnds.length, 3);
	const providerEnd = providerEnds[0];
	assert.ok(providerEnd);
	assert.equal(providerEnd.status, "error");
	assert.equal(providerEnd.attributes["pi.ai.qoder.error_code"], "upstream_error_frame");
	assert.equal(providerEnd.attributes["pi.ai.qoder.diagnostic_code"], "upstream_error_frame");
	assert.equal(providerEnd.attributes["pi.ai.qoder.frame_status_code"], 503);
	assert.equal(providerEnd.attributes["pi.ai.qoder.frame_has_error"], true);
	assert.equal(providerEnd.attributes["pi.ai.http.status_code"], 200);
	const transportEnd = providerEnds[1];
	assert.ok(transportEnd);
	assert.equal(transportEnd.attributes["pi.ai.qoder.error_code"], "transport_failure");
	assert.equal(transportEnd.attributes["pi.ai.qoder.diagnostic_code"], "transport_failure");
	assert.equal(transportEnd.attributes["pi.ai.qoder.transport_phase"], "request");
	const refusalEnd = providerEnds[2];
	assert.equal(refusalEnd.status, "error");
	assert.equal(refusalEnd.attributes["pi.ai.qoder.error_code"], "model_refusal");
	assert.equal(refusalEnd.attributes["pi.ai.qoder.diagnostic_code"], undefined);
});

test("tool argument diagnostics reach trace without persisting malformed content", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-tool-arguments-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sessionFile = join(root, "session.jsonl");
	writeFileSync(sessionFile, "{\"type\":\"session\"}\n", { mode: 0o600 });
	const harness = extensionHarness();
	const ctx = {
		mode: "print", model: { provider: "qoder", id: "ultimate", api: "qoder" },
		sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "tool-arguments-session" },
		ui: { notify() {} },
	};
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await harness.emit("agent_start", { type: "agent_start" }, ctx);
	await harness.emit("turn_start", { type: "turn_start", turnIndex: 0 }, ctx);
	const beginRequest = () => harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} }, ctx);
	const endRequest = () => { harness.emitMetadata(qoderErrorAttributes("Qoder: invalid_tool_arguments")); return harness.emit("message_end", {
		type: "message_end",
		message: { ...assistantMessage("error"), provider: "qoder", model: "ultimate", errorMessage: "Qoder: invalid_tool_arguments" },
	}, ctx); };
	const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
	for (const args of ['{\"PRIVATE_ARGUMENT\":\"秘密\"', 'null']) {
		await beginRequest();
		const wire = frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "PRIVATE_ID", function: { name: "read", arguments: args } }] }, finish_reason: "tool_calls" }] })
			+ frame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + "data: [DONE]\n\n";
		await assert.rejects(async () => {
			for await (const _chunk of qoderChunks(new Response(wire).body, {
				toolNames: ["read"], onDiagnostic: (diagnostic: unknown) => harness.emitDiagnostic(diagnostic),
			})) { /* Consume until final argument validation. */ }
		}, { code: "invalid_tool_arguments" });
		await endRequest();
	}
	// Other extensions can forge events. Only fixed reasons and safe byte counts survive.
	for (const argumentBytes of [-1, 1.5, Infinity, "PRIVATE_LENGTH"]) {
		await beginRequest();
		harness.emitDiagnostic({ code: "invalid_tool_arguments", reason: "PRIVATE_REASON", argumentBytes, arguments: "PRIVATE_ARGUMENTS", id: "PRIVATE_ID", status: 418 });
		await endRequest();
	}
	await beginRequest(); // Diagnostics cannot leak across requests.
	await endRequest();
	await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

	const text = readFileSync(localTracePathForSessionFile(sessionFile), "utf8");
	assert.doesNotMatch(text, /PRIVATE_|秘密/);
	const ends = text.trim().split("\n").map(line => JSON.parse(line))
		.filter(record => record.kind === "span_end" && record.name === "pi.ai.request");
	assert.equal(ends.length, 7);
	const attributes = ends.map(end => Object.fromEntries(Object.entries(end.attributes).filter(([key]) => key.startsWith("pi.ai.qoder."))));
	for (const [index, reason, bytes] of [[0, "invalid_json", Buffer.byteLength('{\"PRIVATE_ARGUMENT\":\"秘密\"')], [1, "non_object", 4]] as const) {
		assert.deepEqual(attributes[index], {
			"pi.ai.qoder.error_code": "invalid_tool_arguments", "pi.ai.qoder.diagnostic_code": "invalid_tool_arguments",
			"pi.ai.qoder.tool_arguments_reason": reason, "pi.ai.qoder.tool_arguments_bytes": bytes,
		});
	}
	for (const index of [2, 3, 4, 5]) assert.deepEqual(attributes[index], {
		"pi.ai.qoder.error_code": "invalid_tool_arguments", "pi.ai.qoder.diagnostic_code": "invalid_tool_arguments",
	});
	assert.deepEqual(attributes[6], { "pi.ai.qoder.error_code": "invalid_tool_arguments" });
});

test("tool ID diagnostics reach trace through the parser without persisting tool content", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-tool-id-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sessionFile = join(root, "session.jsonl");
	writeFileSync(sessionFile, "{\"type\":\"session\"}\n", { mode: 0o600 });
	const harness = extensionHarness();
	const ctx = {
		mode: "print",
		model: { provider: "qoder", id: "ultimate", api: "qoder" },
		sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "tool-id-session" },
		ui: { notify() {} },
	};
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "", systemPrompt: "", images: [] }, ctx);
	await harness.emit("agent_start", { type: "agent_start" }, ctx);
	await harness.emit("turn_start", { type: "turn_start", turnIndex: 0 }, ctx);
	const beginRequest = () => harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} }, ctx);
	const endRequest = () => { harness.emitMetadata(qoderErrorAttributes("Qoder: invalid_tool_id")); return harness.emit("message_end", {
		type: "message_end",
		message: { ...assistantMessage("error"), provider: "qoder", model: "ultimate", errorMessage: "Qoder: invalid_tool_id" },
	}, ctx); };

	await beginRequest();
	const frame = (id: string, name: string, args: string) => `data: ${JSON.stringify({ choices: [{ delta: {
		tool_calls: [{ index: 0, id, function: { name, arguments: args } }],
	}, finish_reason: null }] })}\n\n`;
	const body = new Response(frame("PRIVATE_TOOL_ID", "read", '{"path":') + frame("PRIVATE_DIFFERENT_ID", "", '"PRIVATE_PATH"}')).body;
	await assert.rejects(async () => {
		for await (const _chunk of qoderChunks(body, {
			toolNames: ["read"], allowOpaqueReasoning: true, opaqueModelId: "ultimate",
			onDiagnostic: (diagnostic: unknown) => harness.emitDiagnostic(diagnostic),
		})) { /* Consume validated chunks until identity validation fails. */ }
	}, { code: "invalid_tool_id" });
	await endRequest();

	// Event payloads can be forged by other extensions. Reject unknown enum
	// values, out-of-range indices and arbitrary extra fields at persistence.
	for (const wireIndex of [-1, 64, 1.5, "PRIVATE_INDEX"]) {
		await beginRequest();
		harness.emitDiagnostic({
			code: "invalid_tool_id", reason: "PRIVATE_REASON", relation: "PRIVATE_RELATION",
			previousArgumentsComplete: "PRIVATE_ARGUMENTS", wireIndex,
			id: "PRIVATE_ID", arguments: "PRIVATE_ARGS", body: "PRIVATE_BODY", status: 418,
		});
		await endRequest();
	}
	await beginRequest();
	harness.emitDiagnostic({ code: "invalid_tool_id", reason: "changed", relation: "PRIVATE_RELATION", previousArgumentsComplete: "PRIVATE_ARGUMENTS" });
	await endRequest();
	await beginRequest(); // A later request must not inherit the previous diagnostic.
	await endRequest();
	await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

	const text = readFileSync(localTracePathForSessionFile(sessionFile), "utf8");
	assert.doesNotMatch(text, /PRIVATE_/);
	const ends = text.trim().split("\n").map(line => JSON.parse(line))
		.filter(record => record.kind === "span_end" && record.name === "pi.ai.request");
	assert.equal(ends.length, 7);
	const qoderAttributes = (index: number) => Object.fromEntries(Object.entries(ends[index].attributes)
		.filter(([key]) => key.startsWith("pi.ai.qoder.")));
	assert.deepEqual(qoderAttributes(0), {
		"pi.ai.qoder.error_code": "invalid_tool_id", "pi.ai.qoder.diagnostic_code": "invalid_tool_id",
		"pi.ai.qoder.tool_id_reason": "changed", "pi.ai.qoder.tool_id_relation": "distinct",
		"pi.ai.qoder.previous_arguments_complete": false, "pi.ai.qoder.tool_wire_index": 0,
	});
	for (const index of [1, 2, 3, 4]) assert.deepEqual(qoderAttributes(index), {
		"pi.ai.qoder.error_code": "invalid_tool_id", "pi.ai.qoder.diagnostic_code": "invalid_tool_id",
	});
	assert.deepEqual(qoderAttributes(5), {
		"pi.ai.qoder.error_code": "invalid_tool_id", "pi.ai.qoder.diagnostic_code": "invalid_tool_id", "pi.ai.qoder.tool_id_reason": "changed",
	});
	assert.deepEqual(qoderAttributes(6), { "pi.ai.qoder.error_code": "invalid_tool_id" });
});

test("trace write failures stay passive and surface through /trace", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-failure-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const blocker = join(root, "not-a-directory");
	writeFileSync(blocker, "block");
	const notices: string[] = [];
	const harness = extensionHarness();
	const ctx = {
		mode: "print",
		model: undefined,
		thinkingLevel: "off",
		sessionManager: { getSessionFile: () => join(blocker, "session.jsonl"), getSessionId: () => "failure-session" },
		ui: { notify(message: string) { notices.push(message); } },
	};
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await harness.commands.get("trace").handler("", ctx);
	assert.match(notices.at(-1) ?? "", /dropped=1 healthy=false/u);
	await harness.emit("agent_start", { type: "agent_start" }, ctx);
	await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
});

test("successful compactions receive monotonic sequences and link only the first subsequent turn", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-compaction-link-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sessionFile = join(root, "session.jsonl");
	writeFileSync(sessionFile, "{\"type\":\"session\"}\n", { mode: 0o600 });
	const harness = extensionHarness();
	const ctx = {
		mode: "print",
		model: { provider: "test-provider", id: "test-model", api: "test-api" },
		thinkingLevel: "off",
		sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "compaction-link" },
		ui: { notify() {} },
	};
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "task", images: [], systemPrompt: "system", systemPromptOptions: { selectedTools: [] } }, ctx);
	await harness.emit("agent_start", { type: "agent_start" }, ctx);
	await harness.emit("turn_start", { type: "turn_start", turnIndex: 0 }, ctx);
	await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message: assistantMessage("stop"), toolResults: [] }, ctx);
	for (const sequence of [1, 2]) {
		await harness.emit("session_before_compact", { type: "session_before_compact", reason: "manual", willRetry: false, preparation: { tokensBefore: 1_000 * sequence } }, ctx);
		await harness.emit("session_compact", { type: "session_compact", reason: "manual", willRetry: false, fromExtension: false, compactionEntry: {} }, ctx);
		await harness.emit("turn_start", { type: "turn_start", turnIndex: sequence }, ctx);
		await harness.emit("turn_end", { type: "turn_end", turnIndex: sequence, message: assistantMessage("stop"), toolResults: [] }, ctx);
	}
	await harness.emit("agent_end", { type: "agent_end", messages: [assistantMessage("stop")] }, ctx);
	await harness.emit("agent_settled", { type: "agent_settled" }, ctx);
	await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

	const records = readFileSync(localTracePathForSessionFile(sessionFile), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const compactionStarts = records.filter((record) => record.kind === "span_start" && record.name === "pi.session.compaction");
	const compactionEnds = records.filter((record) => record.kind === "span_end" && record.name === "pi.session.compaction");
	const turnStarts = records.filter((record) => record.kind === "span_start" && record.name === "pi.agent.turn");
	assert.deepEqual(compactionStarts.map((record) => record.attributes["pi.compaction.sequence"]), [1, 2]);
	assert.deepEqual(compactionEnds.map((record) => record.attributes["pi.compaction.sequence"]), [1, 2]);
	assert.equal(turnStarts[0].attributes["pi.compaction.preceding_sequence"], undefined);
	assert.deepEqual(turnStarts.slice(1).map((record) => record.attributes["pi.compaction.preceding_sequence"]), [1, 2]);
});

test("runtime span records only launcher-verified exact versions", () => {
	assert.deepEqual(runtimeVersionAttributes({ ROTOM_PRODUCT_VERSION: "0.1.21", ROTOM_VERIFIED_PI_VERSION: "1.1.0-rotom.2" }), {
		"rotom.product.version": "0.1.21",
		"pi.runtime.version": "1.1.0-rotom.2",
	});
	assert.deepEqual(runtimeVersionAttributes({}), {}, "direct SDK loads have no launcher metadata and stay absent");
	assert.deepEqual(runtimeVersionAttributes({ ROTOM_PRODUCT_VERSION: "latest", ROTOM_VERIFIED_PI_VERSION: "1.1\n0" }), {});
});

test("failed provider errors map to a bounded category from real error texts", () => {
	const cases: Array<[string, number | undefined, Record<string, string | number>]> = [
		["fetch failed", undefined, { "pi.ai.error.category": "network" }],
		["terminated", undefined, { "pi.ai.error.category": "network" }],
		["Connection error.", undefined, { "pi.ai.error.category": "network" }],
		["upstream connect error or disconnect/reset before headers. reset reason: overflow", undefined, { "pi.ai.error.category": "network" }],
		["opaque provider failure", undefined, { "pi.ai.error.category": "unknown" }],
		["fetch failed (caused by: Client network socket disconnected before secure TLS connection was established)", undefined, { "pi.ai.error.category": "network" }],
		["Connection error. (caused by: connect ECONNREFUSED 127.0.0.1:10808)", undefined, { "pi.ai.error.category": "network" }],
		["WebSocket closed 1012", undefined, { "pi.ai.error.category": "websocket" }],
		["WebSocket error", undefined, { "pi.ai.error.category": "websocket" }],
		["WebSocket idle timeout after 300000ms", undefined, { "pi.ai.error.category": "timeout" }],
		["Request timed out.", undefined, { "pi.ai.error.category": "timeout" }],
		["Codex error: Our servers are currently overloaded. Please try again later.", undefined, { "pi.ai.error.category": "overloaded" }],
		["{\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}", undefined, { "pi.ai.error.category": "overloaded" }],
		["Codex error: An error occurred while processing your request.", undefined, { "pi.ai.error.category": "provider_error" }],
		["API key auth failed for provider cc-switch: Failed to resolve API key", undefined, { "pi.ai.error.category": "auth" }],
		["This operation was aborted", undefined, { "pi.ai.error.category": "aborted" }],
		["403 data: {\"error\":{\"message\":\"PRIVATE\"}}", undefined, { "pi.ai.error.category": "http", "pi.ai.error.http_status": 403 }],
		["503 <!DOCTYPE HTML PUBLIC", undefined, { "pi.ai.error.category": "http", "pi.ai.error.http_status": 503 }],
		["stream ended", 529, { "pi.ai.error.category": "http", "pi.ai.error.http_status": 529 }],
		["Compaction failed: Summarization failed: fetch failed", undefined, { "pi.ai.error.category": "network" }],
		["Compaction failed: Turn prefix summarization failed: 403 data: {}", undefined, { "pi.ai.error.category": "http", "pi.ai.error.http_status": 403 }],
		["<html> <head> <meta name=viewport>", undefined, { "pi.ai.error.category": "unknown" }],
	];
	for (const [message, status, expected] of cases) {
		assert.deepEqual(providerErrorAttributes(message, status), expected, message);
	}
	assert.deepEqual(providerErrorAttributes(undefined, undefined), { "pi.ai.error.category": "unknown" });
});

test("failed requests and compactions carry the error category and version without error text", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-error-category-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sessionFile = join(root, "session.jsonl");
	writeFileSync(sessionFile, "{\"type\":\"session\"}\n", { mode: 0o600 });
	const previous = { product: process.env.ROTOM_PRODUCT_VERSION, pi: process.env.ROTOM_VERIFIED_PI_VERSION };
	process.env.ROTOM_PRODUCT_VERSION = "0.1.22";
	process.env.ROTOM_VERIFIED_PI_VERSION = "1.1.0-rotom.2";
	t.after(() => {
		for (const [key, value] of [["ROTOM_PRODUCT_VERSION", previous.product], ["ROTOM_VERIFIED_PI_VERSION", previous.pi]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	const harness = extensionHarness();
	const ctx = {
		mode: "print",
		model: { provider: "qoder", id: "test-model", api: "qoder" },
		thinkingLevel: "high",
		sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "error-category" },
		ui: { notify() {} },
	};
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "task", images: [], systemPrompt: "system", systemPromptOptions: { selectedTools: [] } }, ctx);
	await harness.emit("agent_start", { type: "agent_start" }, ctx);
	await harness.emit("turn_start", { type: "turn_start", turnIndex: 0 }, ctx);
	await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} }, ctx);
	harness.emitMetadata(qoderErrorAttributes("403 data: PRIVATE_BAN_NOTICE"));
	await harness.emit("message_end", { type: "message_end", message: { ...assistantMessage("error"), provider: "qoder", errorMessage: "Qoder: http_403" } }, ctx);
	await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} }, ctx);
	await harness.emit("message_end", { type: "message_end", message: assistantMessage("stop") }, ctx);
	await harness.emit("session_before_compact", { type: "session_before_compact", reason: "threshold", willRetry: false, preparation: { tokensBefore: 254_111 } }, ctx);
	await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} }, ctx);
	harness.emitMetadata(qoderErrorAttributes("503 <html>PRIVATE_DETAIL</html>"));
	await harness.emit("session_compact_failed", { type: "session_compact_failed", reason: "threshold", errorMessage: "Compaction failed: Summarization failed: Qoder: http_503", aborted: false, willRetry: false, fromExtension: false }, ctx);
	await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

	const text = readFileSync(localTracePathForSessionFile(sessionFile), "utf8");
	for (const secret of ["PRIVATE_BAN_NOTICE", "PRIVATE_DETAIL"]) assert.equal(text.includes(secret), false, `trace leaked ${secret}`);
	const records = text.trim().split("\n").map((line) => JSON.parse(line));
	const runtime = records.find((record) => record.kind === "span_start" && record.name === "pi.session.runtime");
	assert.equal(runtime.attributes["rotom.product.version"], "0.1.22");
	assert.equal(runtime.attributes["pi.runtime.version"], "1.1.0-rotom.2");
	const requests = records.filter((record) => record.kind === "span_end" && record.name === "pi.ai.request");
	assert.equal(requests.length, 3);
	assert.equal(requests[0].status, "error");
	assert.equal(requests[0].attributes["pi.ai.error.category"], "http");
	assert.equal(requests[0].attributes["pi.ai.error.http_status"], 403);
	assert.equal(requests[1].status, "ok");
	assert.equal(requests[1].attributes["pi.ai.error.category"], undefined, "successful requests carry no error category");
	assert.equal(requests[2].attributes["pi.ai.error.category"], "http");
	assert.equal(requests[2].attributes["pi.ai.error.http_status"], 503);
	const compaction = records.find((record) => record.kind === "span_end" && record.name === "pi.session.compaction");
	assert.equal(compaction.status, "error");
	assert.equal(compaction.attributes["pi.ai.error.category"], "http");
	assert.equal(compaction.attributes["pi.ai.error.http_status"], 503);
});

test("aborted assistant closes turn and operation as aborted", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-aborted-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sessionFile = join(root, "session.jsonl");
	writeFileSync(sessionFile, "{}\n", { mode: 0o600 });
	const harness = extensionHarness();
	const ctx = {
		mode: "print",
		model: { provider: "test", id: "test", api: "test" },
		thinkingLevel: "off",
		sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "aborted-session" },
		ui: { notify() {} },
	};
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "stop", systemPrompt: "system", systemPromptOptions: { selectedTools: [] } }, ctx);
	await harness.emit("agent_start", { type: "agent_start" }, ctx);
	await harness.emit("turn_start", { type: "turn_start", turnIndex: 0 }, ctx);
	await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message: assistantMessage("aborted") }, ctx);
	await harness.emit("agent_end", { type: "agent_end", messages: [assistantMessage("aborted")] }, ctx);
	await harness.emit("agent_settled", { type: "agent_settled" }, ctx);
	await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	const ends = readFileSync(localTracePathForSessionFile(sessionFile), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((record) => record.kind === "span_end");
	assert.equal(ends.find((record) => record.name === "pi.agent.turn")?.status, "aborted");
	assert.equal(ends.find((record) => record.name === "pi.agent.run")?.status, "aborted");
	assert.equal(ends.find((record) => record.name === "pi.agent.operation")?.status, "aborted");
});

test("trace paths reject directory and file symlinks without touching their targets", async (t) => {
	if (process.platform === "win32") { t.skip("symlink creation is privilege-dependent on Windows"); return; }
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-symlink-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const externalDirectory = join(root, "external-directory");
	const sessionDirectory = join(root, "sessions");
	mkdirSync(externalDirectory, { mode: 0o700 });
	mkdirSync(sessionDirectory, { mode: 0o700 });
	const directorySessionFile = join(sessionDirectory, "directory-session.jsonl");
	writeFileSync(directorySessionFile, "{}\n", { mode: 0o600 });
	symlinkSync(externalDirectory, join(sessionDirectory, "observability"));
	const directoryHarness = extensionHarness();
	const notices: string[] = [];
	const directoryCtx = {
		mode: "print",
		model: undefined,
		thinkingLevel: "off",
		sessionManager: { getSessionFile: () => directorySessionFile, getSessionId: () => "directory-symlink" },
		ui: { notify(message: string) { notices.push(message); } },
	};
	await directoryHarness.emit("session_start", { type: "session_start", reason: "startup" }, directoryCtx);
	await directoryHarness.commands.get("trace").handler("", directoryCtx);
	assert.match(notices.at(-1) ?? "", /healthy=false/u);
	assert.deepEqual(existsSync(join(externalDirectory, "directory-session.trace.jsonl")), false);

	rmSync(join(sessionDirectory, "observability"));
	mkdirSync(join(sessionDirectory, "observability"), { mode: 0o700 });
	const fileSessionFile = join(sessionDirectory, "file-session.jsonl");
	writeFileSync(fileSessionFile, "{}\n", { mode: 0o600 });
	const externalFile = join(root, "external-target.txt");
	writeFileSync(externalFile, "unchanged", { mode: 0o640 });
	const externalMode = statSync(externalFile).mode & 0o777;
	symlinkSync(externalFile, localTracePathForSessionFile(fileSessionFile));
	const fileHarness = extensionHarness();
	const fileCtx = {
		...directoryCtx,
		sessionManager: { getSessionFile: () => fileSessionFile, getSessionId: () => "file-symlink" },
	};
	await fileHarness.emit("session_start", { type: "session_start", reason: "startup" }, fileCtx);
	await fileHarness.commands.get("trace").handler("", fileCtx);
	assert.equal(readFileSync(externalFile, "utf8"), "unchanged");
	assert.equal(statSync(externalFile).mode & 0o777, externalMode);
});

test("provider metadata is scoped and generic failures still work without a provider producer", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-provider-scope-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sessionFile = join(root, "session.jsonl");
	writeFileSync(sessionFile, "{}\n", { mode: 0o600 });
	const harness = extensionHarness();
	const ctx = { mode: "print", model: { provider: "fixture", id: "model", api: "fixture" },
		sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "fixture" }, ui: { notify() {} } };
	await harness.emit("session_start", {}, ctx);
	await harness.emit("before_agent_start", { systemPromptOptions: { selectedTools: [] } }, ctx);
	await harness.emit("agent_start", {}, ctx);
	await harness.emit("turn_start", { turnIndex: 0 }, ctx);
	await harness.emit("before_provider_headers", {}, ctx);
	harness.emitMetadata({ "pi.ai.fixture.error_code": "wrong-provider" }, "unrelated");
	await harness.emit("message_end", { message: { ...assistantMessage("error"), errorMessage: "fetch failed" } }, ctx);
	await harness.emit("before_provider_headers", {}, ctx);
	harness.emitMetadata({ "pi.ai.error.category": "network", "pi.ai.fixture.error_code": "transport" }, "fixture");
	await harness.emit("after_provider_response", { status: 503 }, ctx);
	await harness.emit("message_end", { message: { ...assistantMessage("error"), errorMessage: "fetch failed" } }, ctx);
	await harness.emit("session_shutdown", {}, ctx);
	const requests = readFileSync(localTracePathForSessionFile(sessionFile), "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(r => r.name === "pi.ai.request" && r.kind === "span_end");
	assert.equal(requests[0].attributes["pi.ai.error.category"], "network");
	assert.equal(requests[0].attributes["pi.ai.fixture.error_code"], undefined);
	assert.equal(requests[1].attributes["pi.ai.error.category"], "http");
	assert.equal(requests[1].attributes["pi.ai.error.http_status"], 503);
	assert.equal(requests[1].attributes["pi.ai.fixture.error_code"], "transport");
});

test("shutdown closes active compaction children before their operation parent", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-compaction-shutdown-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sessionFile = join(root, "session.jsonl");
	writeFileSync(sessionFile, "{}\n", { mode: 0o600 });
	const harness = extensionHarness();
	const ctx = {
		mode: "print",
		model: { provider: "test", id: "test", api: "test" },
		thinkingLevel: "off",
		sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "compaction-shutdown" },
		ui: { notify() {} },
	};
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "compact", systemPrompt: "system", systemPromptOptions: { selectedTools: [] } }, ctx);
	await harness.emit("session_before_compact", { type: "session_before_compact", reason: "threshold", willRetry: false, preparation: { tokensBefore: 50_000 } }, ctx);
	await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} }, ctx);
	await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	const records = readFileSync(localTracePathForSessionFile(sessionFile), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const endIndex = (name: string) => records.findIndex((record) => record.kind === "span_end" && record.name === name);
	assert.ok(endIndex("pi.ai.request") < endIndex("pi.session.compaction"));
	assert.ok(endIndex("pi.session.compaction") < endIndex("pi.agent.operation"));
	assert.ok(endIndex("pi.agent.operation") < endIndex("pi.session.runtime"));
	for (const name of ["pi.ai.request", "pi.session.compaction", "pi.agent.operation"]) {
		assert.equal(records[endIndex(name)].status, "aborted");
	}
});

test("persisted reload closes the old runtime span before starting a new one", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-reload-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sessionFile = join(root, "session.jsonl");
	writeFileSync(sessionFile, "{}\n", { mode: 0o600 });
	const harness = extensionHarness();
	const ctx = {
		mode: "print",
		model: undefined,
		thinkingLevel: "off",
		sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "reload-session" },
		ui: { notify() {} },
	};
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await harness.emit("session_start", { type: "session_start", reason: "reload" }, ctx);
	await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	const records = readFileSync(localTracePathForSessionFile(sessionFile), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const sessionStarts = records.filter((record) => record.kind === "span_start" && record.name === "pi.session.runtime");
	const sessionEnds = records.filter((record) => record.kind === "span_end" && record.name === "pi.session.runtime");
	assert.equal(sessionStarts.length, 2);
	assert.equal(sessionEnds.length, 2);
	assert.equal(sessionEnds[0].attributes["pi.session.shutdown_reason"], "reload");
});

test("tool metadata digest tracks order/schema without exposing schema text and fails open", () => {
	let active = ["private-tool"];
	const definitions = [{ name: "private-tool", description: "private-description", parameters: { type: "object" } }];
	const pi = { getActiveTools: () => active, getAllTools: () => definitions } as any;
	const first = toolSurfaceMetrics(pi);
	assert.equal(first["pi.tools.measurement"], "public-metadata-not-wire");
	assert.equal(first["pi.tools.schema_bytes"], Buffer.byteLength(JSON.stringify(definitions[0])));
	assert.doesNotMatch(JSON.stringify(first), /private-/u);
	assert.deepEqual(toolSurfaceMetrics(pi), first);
	definitions[0].description += " changed";
	assert.notEqual(toolSurfaceMetrics(pi)["pi.tools.schema_digest"], first["pi.tools.schema_digest"]);
	assert.equal(toolSurfaceMetrics(pi)["pi.tools.active_digest"], first["pi.tools.active_digest"]);
	definitions.push({ name: "second", description: "private-second", parameters: { type: "object" } });
	active = ["private-tool", "second"];
	const ordered = toolSurfaceMetrics(pi);
	active.reverse();
	assert.notEqual(toolSurfaceMetrics(pi)["pi.tools.active_digest"], ordered["pi.tools.active_digest"]);
	assert.notEqual(toolSurfaceMetrics(pi)["pi.tools.schema_digest"], ordered["pi.tools.schema_digest"]);
	active = ["missing"];
	assert.deepEqual(toolSurfaceMetrics(pi), { "pi.tools.measurement": "unavailable" });
	active = ["private-tool"]; definitions[0].description = "x".repeat(1024 * 1024);
	assert.deepEqual(toolSurfaceMetrics(pi), { "pi.tools.measurement": "unavailable" });
	assert.deepEqual(toolSurfaceMetrics({ getActiveTools() { throw new Error("private-body"); } } as any), { "pi.tools.measurement": "unavailable" });
});

test("request metadata changes and independent result evidence survive trace without false completeness", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-evidence-trace-")); t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "session.jsonl");
	let active = ["read"]; let unavailable = false;
	const tools = ["read", "subagent"].map((name) => ({ name, description: "private-schema", parameters: { type: "object" } }));
	const harness = extensionHarness({ getActiveTools: () => active, getAllTools: () => { if (unavailable) throw Error("private-body"); return tools; } });
	const ctx = { mode: "print", sessionManager: { getSessionFile: () => file, getSessionId: () => "fixture" } };
	await harness.emit("session_start", { reason: "startup" }, ctx);
	await harness.emit("turn_start", { turnIndex: 0 }, ctx);
	for (const mode of ["initial", "unchanged", "add", "unavailable", "restored"]) {
		if (mode === "add") active = ["read", "subagent"];
		unavailable = mode === "unavailable";
		await harness.emit("before_provider_headers", {}, ctx);
	}
	const cases = [
		{ businessOutcome: "unverified", acknowledged: true, readback: { contentComplete: false, truncated: false } },
		{ status: "ok", execution: { outcome: "didnt", verification: { status: "failed" } } },
		{ lifecycleStatus: { processTerminal: { state: "pending" } } },
		{ truncation: { truncated: true } },
		{ execution: { outcome: "private-outcome" }, businessOutcome: "private-outcome" },
		{ subagentPhase: "launch", runId: "private-run-id" },
		{ subagentPhase: "stop-request" },
		{ codingPhases: { mutation: "applied", followup: "failed", source: "tool-reported", command: "private-command" } },
		{ subagentPhase: "private-phase", codingPhases: { mutation: "private-state", followup: "private-state", source: "tool-reported" } },
		{ codingPhases: { mutation: "applied", followup: "succeeded", source: "private-source" } },
	];
	for (const [i, details] of cases.entries()) {
		await harness.emit("tool_execution_start", { toolCallId: String(i), toolName: "fixture" }, ctx);
		await harness.emit("tool_execution_end", { toolCallId: String(i), isError: i === 7, result: { content: [], details } }, ctx);
	}
	await harness.emit("session_shutdown", { reason: "quit" }, ctx);
	const text = readFileSync(localTracePathForSessionFile(file), "utf8");
	assert.doesNotMatch(text, /private-/u);
	const rows = text.trim().split("\n").map((line) => JSON.parse(line));
	const requests = rows.filter((r) => r.kind === "span_start" && r.name === "pi.ai.request");
	assert.deepEqual(requests.map((r) => r.attributes["pi.tools.schema_changed"]), [undefined, false, true, undefined, undefined]);
	const results = rows.filter((r) => r.kind === "span_end" && r.name === "pi.tool.execute");
	assert.equal(results[0].status, "unknown");
	assert.equal(results[0].attributes["pi.tool.dispatch_acknowledged"], true);
	assert.equal(results[0].attributes["pi.tool.content_complete"], false);
	assert.equal(results[0].attributes["pi.tool.result_truncated"], false);
	assert.equal(results[1].status, "unknown");
	assert.equal(results[1].attributes["pi.tool.verification_status"], "failed");
	assert.equal(results[2].attributes["pi.tool.process_terminal_state"], "pending");
	assert.equal(results[2].attributes["pi.tool.content_complete"], undefined);
	assert.equal(results[2].attributes["pi.tool.result_truncated"], undefined);
	assert.equal(results[3].attributes["pi.tool.result_truncated"], true);
	assert.equal(results[5].status, "ok", "launch success remains a dispatch fact, not task acceptance");
	assert.equal(results[5].attributes["pi.tool.subagent_phase"], "launch");
	assert.equal(results[5].attributes["pi.tool.business_outcome"], undefined);
	assert.equal(results[6].attributes["pi.tool.subagent_phase"], "stop-request");
	assert.equal(results[7].status, "error", "successful mutation does not hide failed validation");
	assert.equal(results[7].attributes["pi.tool.mutation_status"], "applied");
	assert.equal(results[7].attributes["pi.tool.followup_status"], "failed");
	assert.equal(results[7].attributes["pi.tool.coding_evidence_source"], "tool-reported");
	assert.equal(results[8].attributes["pi.tool.subagent_phase"], undefined);
	assert.equal(results[8].attributes["pi.tool.mutation_status"], undefined);
	assert.equal(results[8].attributes["pi.tool.followup_status"], undefined);
	assert.equal(results[9].attributes["pi.tool.mutation_status"], undefined);
	assert.equal(results[9].attributes["pi.tool.coding_evidence_source"], undefined);
});

test("the persistent writer rejects post-open chmod/replacement and stops queued writes", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-writer-integrity-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "trace.jsonl");
	writeFileSync(file, "", { mode: 0o600 });
	const record = (name: string) => ({ schema: LOCAL_TRACE_SCHEMA_V1, kind: "span_start", timestamp: new Date().toISOString(), traceId: "0".repeat(32), spanId: name.padEnd(16, "0").slice(0, 16), name } as any);
	const writer = new LocalTraceWriterV1(file);
	writer.append(record("first"));
	assert.equal(await writer.flush(), true);
	chmodSync(file, 0o644);
	writer.append(record("chmod"));
	assert.equal(await writer.flush(), true);
	assert.equal(writer.healthy, false);
	assert.equal(writer.recordsWritten, 1);
	assert.equal(statSync(file).mode & 0o777, 0o644);
	await writer.close();

	const replacement = join(root, "replacement.jsonl");
	writeFileSync(replacement, "", { mode: 0o600 });
	const second = new LocalTraceWriterV1(replacement);
	second.append(record("first"));
	await second.flush();
	renameSync(replacement, join(root, "old.jsonl"));
	writeFileSync(replacement, "", { mode: 0o600 });
	second.append(record("replaced"));
	await second.flush();
	assert.equal(second.healthy, false);
	assert.equal(readFileSync(replacement, "utf8"), "");
	await second.close();

	let calls = 0;
	const queued = new LocalTraceWriterV1("/unused", async () => { calls += 1; throw new Error("write failed"); });
	queued.append(record("failed")); queued.append(record("must-not-run"));
	assert.equal(await queued.flush(), true);
	assert.equal(calls, 1);
	assert.equal(queued.recordsDropped, 2);
});

test("close drains accepted writes, rejects new appends and closes the pinned descriptor once", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-trace-close-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const writer = new LocalTraceWriterV1(join(root, "trace.jsonl"));
	const record = { schema: LOCAL_TRACE_SCHEMA_V1, kind: "span_start", name: "fixture" } as any;
	writer.append(record);
	await writer.flush();
	const handle = (writer as any).handle;
	assert.ok(handle);
	writer.append(record);
	await writer.flush();
	assert.equal((writer as any).handle, handle, "flush reuses the descriptor");
	writer.append(record);
	const pending = writer.close();
	writer.append(record);
	assert.equal(await pending, true);
	assert.equal(writer.recordsWritten, 3);
	assert.equal(writer.recordsDropped, 1);
	assert.equal(handle.fd, -1);
	assert.equal(await writer.close(), true);
	assert.equal((writer as any).handle, undefined);
});

test("directory permission drift stops an open writer before another record", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-trace-directory-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const writer = new LocalTraceWriterV1(join(root, "trace.jsonl"));
	const record = { schema: LOCAL_TRACE_SCHEMA_V1, kind: "span_start", name: "fixture" } as any;
	writer.append(record); await writer.flush();
	chmodSync(root, 0o755);
	writer.append(record); await writer.close();
	assert.equal(writer.recordsWritten, 1);
	assert.equal(writer.healthy, false);
});

test("flush has a bounded best-effort deadline", async () => {
	const writer = new LocalTraceWriterV1("/unused/trace.jsonl", async () => new Promise<void>(() => {}));
	writer.append({ schema: LOCAL_TRACE_SCHEMA_V1, kind: "span_start", timestamp: new Date().toISOString(), traceId: "0".repeat(32), spanId: "0".repeat(16), name: "stalled" } as any);
	const started = Date.now();
	assert.equal(await writer.flush(20), false);
	assert.ok(Date.now() - started < 500);
	assert.equal(writer.healthy, false);
	assert.equal(writer.recordsDropped, 1);
});

test("ephemeral sessions and explicit disable do not create trace files", async (t) => {
	const previous = process.env.ROTOM_OBSERVABILITY;
	t.after(() => {
		if (previous === undefined) delete process.env.ROTOM_OBSERVABILITY;
		else process.env.ROTOM_OBSERVABILITY = previous;
	});
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-disabled-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const notices: string[] = [];
	const harness = extensionHarness();
	const ctx: any = {
		mode: "print",
		model: undefined,
		thinkingLevel: "off",
		sessionManager: { getSessionFile: () => undefined, getSessionId: () => "ephemeral" },
		ui: { notify(message: string) { notices.push(message); } },
	};
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await harness.commands.get("trace").handler("", ctx);
	assert.match(notices.at(-1) ?? "", /ephemeral-session/u);

	process.env.ROTOM_OBSERVABILITY = "0";
	const sessionFile = join(root, "session.jsonl");
	chmodSync(root, 0o700);
	ctx.sessionManager.getSessionFile = () => sessionFile;
	await harness.emit("session_start", { type: "session_start", reason: "reload" }, ctx);
	await harness.commands.get("trace").handler("", ctx);
	assert.match(notices.at(-1) ?? "", /disabled-by-ROTOM_OBSERVABILITY/u);
	assert.throws(() => readFileSync(localTracePathForSessionFile(sessionFile), "utf8"), /ENOENT/u);
});

test("fault side is evidence-gated and never blames a side it cannot prove", () => {
	// Not a fault: no side.
	assert.equal(classifyFaultSide({ isError: false }, "ok"), undefined);
	assert.equal(classifyFaultSide({ isError: true }, "aborted"), undefined);
	// External system failures.
	assert.equal(classifyFaultSide({ isError: true, result: { details: { code: "timeout" } } }, "timeout"), "environment");
	assert.equal(classifyFaultSide({ isError: true, result: { details: { code: "permission_denied" } } }, "permission"), "environment");
	assert.equal(classifyFaultSide({ isError: true, result: { details: { code: "network_error" } } }, "transport"), "environment");
	// Model emitted a rejected artifact.
	assert.equal(classifyFaultSide({ isError: true, result: { details: { code: "schema_validation" } } }, "schema"), "model");
	// Our adapter/protocol layer.
	assert.equal(classifyFaultSide({ isError: true, result: { details: { protocolError: { code: "x" } } } }, "transport"), "harness");
	assert.equal(classifyFaultSide({ isError: true, result: { details: { code: "tool_not_found" } } }, "tool_error"), "harness");
	// Failed but unprovable stays unknown, not a guess.
	assert.equal(classifyFaultSide({ isError: true, result: { details: {} } }, "tool_error"), "unknown");
	// An unverified or unknown effect is missing evidence, not a failure: no side.
	assert.equal(classifyFaultSide({ isError: false, result: { details: { status: "unknown" } } }, "unknown_outcome"), undefined);
	assert.equal(classifyFaultSide({ isError: false, result: { details: { businessOutcome: "unverified" } } }, "unknown_outcome"), undefined);
	assert.equal(classifyFaultSide({ isError: false, result: { details: { execution: { outcome: "unknown" } } } }, "unknown_outcome"), undefined);
	// A reported non-effect or failed verification is a failure with an unproven side.
	assert.equal(classifyFaultSide({ isError: false, result: { details: { execution: { outcome: "didnt" } } } }, "unknown_outcome"), "unknown");
	assert.equal(classifyFaultSide({ isError: false, result: { details: { execution: { outcome: "worked", verification: { status: "failed" } } } } }, "unknown_outcome"), "unknown");
});

test("a provider request closed without its own end names why its status is unknown", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-superseded-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sessionFile = join(root, "session.jsonl");
	writeFileSync(sessionFile, "{}\n", { mode: 0o600 });
	const harness = extensionHarness();
	const ctx = {
		mode: "print",
		model: { provider: "test", id: "test", api: "test" },
		thinkingLevel: "off",
		sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "superseded-request" },
		ui: { notify() {} },
	};
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "compact", systemPrompt: "system", systemPromptOptions: { selectedTools: [] } }, ctx);
	// A retry starts a new request before the previous one reported an end.
	await harness.emit("turn_start", { turnIndex: 0 }, ctx);
	await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} }, ctx);
	await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} }, ctx);
	await harness.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: {} } }, ctx);
	await harness.emit("turn_end", { turnIndex: 0, message: { role: "assistant" } }, ctx);
	// A turn torn down while its request is still open.
	await harness.emit("turn_start", { turnIndex: 1 }, ctx);
	await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} }, ctx);
	await harness.emit("turn_end", { turnIndex: 1, message: { role: "user" } }, ctx);
	await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	const requests = readFileSync(localTracePathForSessionFile(sessionFile), "utf8").trim().split("\n").map((line) => JSON.parse(line))
		.filter((record) => record.kind === "span_end" && record.name === "pi.ai.request");
	assert.deepEqual(requests.map((record) => [record.status, record.attributes?.["pi.ai.request.end_reason"]]), [
		["unknown", "superseded_by_next_request"],
		["ok", undefined],
		["unknown", "turn_closed"],
	]);
});

test("parallel compaction requests share one request span and report per-summary timing", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-parallel-compaction-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sessionFile = join(root, "session.jsonl");
	writeFileSync(sessionFile, "{}\n", { mode: 0o600 });
	const harness = extensionHarness();
	const ctx = {
		mode: "print",
		model: { provider: "test", id: "test", api: "test" },
		thinkingLevel: "off",
		sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "parallel-compaction" },
		ui: { notify() {} },
	};
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await harness.emit("session_before_compact", { type: "session_before_compact", reason: "threshold", willRetry: false, preparation: { tokensBefore: 50_000 } }, ctx);
	// History and turn-prefix summaries start together; their responses cannot be told apart.
	await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} }, ctx);
	await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} }, ctx);
	await harness.emit("after_provider_response", { type: "after_provider_response", status: 529, headers: {} }, ctx);
	await harness.emit("after_provider_response", { type: "after_provider_response", status: 200, headers: {} }, ctx);
	await harness.emit("session_compact", {
		type: "session_compact",
		reason: "threshold",
		willRetry: false,
		fromExtension: false,
		compactionEntry: { usage: { input: 70, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 90, cost: { total: 0 } } },
		summaryCalls: [
			{ kind: "history", durationMs: 90_000, attempts: 2, firstThinkingMs: 4_000, firstTextMs: 60_000 },
			{ kind: "turn_prefix", durationMs: 30_000, attempts: 1, firstTextMs: 20_000 },
			{ kind: "other", durationMs: 1 },
		],
	}, ctx);
	await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	const ends = readFileSync(localTracePathForSessionFile(sessionFile), "utf8").trim().split("\n").map((line) => JSON.parse(line))
		.filter((record) => record.kind === "span_end");
	const requests = ends.filter((record) => record.name === "pi.ai.request");
	assert.equal(requests.length, 1, "one span covers the concurrent compaction requests");
	assert.equal(requests[0].status, "ok");
	assert.equal(requests[0].attributes["pi.ai.request.end_reason"], undefined, "a concurrent request is not superseded");
	assert.equal(requests[0].attributes["pi.ai.http.status_code"], 529, "a later 200 must not hide an error response");
	assert.equal(requests[0].attributes["pi.usage.output_tokens"], 20);
	const compaction = ends.find((record) => record.name === "pi.session.compaction");
	assert.deepEqual(Object.fromEntries(Object.entries(compaction.attributes).filter(([key]) => /request_starts|\.(history|turn_prefix|other)\./.test(key))), {
		"pi.compaction.request_starts": 2,
		"pi.compaction.history.ms": 90_000,
		"pi.compaction.history.attempts": 2,
		"pi.compaction.history.first_thinking_ms": 4_000,
		"pi.compaction.history.first_text_ms": 60_000,
		"pi.compaction.turn_prefix.ms": 30_000,
		"pi.compaction.turn_prefix.attempts": 1,
		"pi.compaction.turn_prefix.first_text_ms": 20_000,
	});
});

test("tool error codes are recorded only from the allowlist and drive outcome and side", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-error-code-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sessionFile = join(root, "session.jsonl");
	writeFileSync(sessionFile, "{}\n", { mode: 0o600 });
	const harness = extensionHarness();
	const ctx = {
		mode: "print",
		model: { provider: "test", id: "test", api: "test" },
		thinkingLevel: "off",
		sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "error-code" },
		ui: { notify() {} },
	};
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await harness.emit("agent_start", {}, ctx);
	await harness.emit("turn_start", { turnIndex: 0 }, ctx);
	const cases = [
		{ code: "nonzero_exit", exitCode: 3 },
		{ code: "command_timeout" },
		{ code: "validation_error" },
		{ code: "tool_not_found" },
		{ code: "aborted" },
		{ code: "secret-looking-value" },
	];
	for (const [index, details] of cases.entries()) {
		await harness.emit("tool_execution_start", { toolCallId: `call-${index}`, toolName: "bash" }, ctx);
		await harness.emit("tool_execution_end", { toolCallId: `call-${index}`, toolName: "bash", isError: true, result: { content: [], details } }, ctx);
	}
	await harness.emit("session_shutdown", { type: "session_shutdown", reason: "exit" }, ctx);
	const tools = readFileSync(localTracePathForSessionFile(sessionFile), "utf8").trim().split("\n").map((line) => JSON.parse(line))
		.filter((record) => record.kind === "span_end" && record.name === "pi.tool.execute");
	assert.deepEqual(tools.map((record) => [
		record.attributes["pi.tool.error_code"],
		record.attributes["pi.tool.exit_code"],
		record.attributes["pi.tool.outcome"],
		record.attributes["pi.tool.fault_side"],
	]), [
		["nonzero_exit", 3, "tool_error", "unknown"],
		["command_timeout", undefined, "tool_error", "unknown"],
		["validation_error", undefined, "schema", "model"],
		["tool_not_found", undefined, "tool_error", "harness"],
		["aborted", undefined, "aborted", undefined],
		[undefined, undefined, "tool_error", "unknown"],
	]);
});

test("subagent tool spans carry their deferred capability group", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-group-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sessionFile = join(root, "session.jsonl");
	writeFileSync(sessionFile, "{\"type\":\"session\"}\n", { mode: 0o600 });
	const ctx = {
		mode: "print",
		model: { provider: "test-provider", id: "test-model", api: "test-api" },
		thinkingLevel: "low",
		sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "session-group" },
		ui: { notify() {} },
	};
	const harness = extensionHarness();
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await harness.emit("agent_start", {}, ctx);
	await harness.emit("turn_start", { turnIndex: 0 }, ctx);
	await harness.emit("tool_execution_start", { toolCallId: "call-subagent", toolName: "subagent" }, ctx);
	await harness.emit("tool_execution_end", { toolCallId: "call-subagent", toolName: "subagent", isError: false, result: { details: { status: "ok" } } }, ctx);
	await harness.emit("tool_execution_start", { toolCallId: "call-bash", toolName: "bash" }, ctx);
	await harness.emit("tool_execution_end", { toolCallId: "call-bash", toolName: "bash", isError: false, result: { details: { status: "ok" } } }, ctx);
	await harness.emit("session_shutdown", { type: "session_shutdown", reason: "exit" }, ctx);
	const records = readFileSync(localTracePathForSessionFile(sessionFile), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	// pi.tool.name lives on the span_start; correlate to the span_end by spanId.
	const toolStartByName = new Map(records
		.filter((record) => record.kind === "span_start" && record.name === "pi.tool.execute")
		.map((record) => [record.attributes?.["pi.tool.name"], record.spanId]));
	const endBySpanId = new Map(records
		.filter((record) => record.kind === "span_end" && record.name === "pi.tool.execute")
		.map((record) => [record.spanId, record]));
	const subagentEnd = endBySpanId.get(toolStartByName.get("subagent"));
	const bashEnd = endBySpanId.get(toolStartByName.get("bash"));
	assert.equal(subagentEnd?.attributes?.["pi.tool.capability_group"], "subagent");
	assert.equal(bashEnd?.attributes?.["pi.tool.capability_group"], undefined, "a core tool has no deferred capability group");
});

test("tool-level unknown splits lifecycle-incomplete from ran-but-unverified", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rotom-observability-unknown-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sessionFile = join(root, "session.jsonl");
	writeFileSync(sessionFile, "{\"type\":\"session\"}\n", { mode: 0o600 });
	const ctx = {
		mode: "print",
		model: { provider: "test-provider", id: "test-model", api: "test-api" },
		thinkingLevel: "low",
		sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "session-unknown-split" },
		ui: { notify() {} },
	};
	const harness = extensionHarness();
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await harness.emit("agent_start", {}, ctx);
	await harness.emit("turn_start", { turnIndex: 0 }, ctx);
	// Superseded before its end event: the first span is force-closed incomplete,
	// then the re-registered span ends cleanly.
	await harness.emit("tool_execution_start", { toolCallId: "call-super", toolName: "bash" }, ctx);
	await harness.emit("tool_execution_start", { toolCallId: "call-super", toolName: "bash" }, ctx);
	await harness.emit("tool_execution_end", { toolCallId: "call-super", toolName: "bash", isError: false, result: { details: { status: "ok" } } }, ctx);
	// Left open when the turn is torn down: incomplete, never its own end event.
	await harness.emit("tool_execution_start", { toolCallId: "call-open", toolName: "edit" }, ctx);
	await harness.emit("turn_end", { turnIndex: 0, message: { role: "assistant" } }, ctx);
	// Ran and returned, but the result declares its effect unverified.
	await harness.emit("turn_start", { turnIndex: 1 }, ctx);
	await harness.emit("tool_execution_start", { toolCallId: "call-unver", toolName: "write" }, ctx);
	await harness.emit("tool_execution_end", { toolCallId: "call-unver", toolName: "write", isError: false, result: { details: { businessOutcome: "unverified" } } }, ctx);
	await harness.emit("session_shutdown", { type: "session_shutdown", reason: "exit" }, ctx);
	const records = readFileSync(localTracePathForSessionFile(sessionFile), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const toolEnds = records.filter((record) => record.kind === "span_end" && record.name === "pi.tool.execute");
	const incomplete = toolEnds.filter((record) => record.attributes?.["pi.tool.outcome"] === "incomplete");
	const unverified = toolEnds.filter((record) => record.attributes?.["pi.tool.outcome"] === "unknown_outcome");
	assert.equal(incomplete.length, 2, "a superseded span and a torn-down span are both lifecycle-incomplete");
	assert.equal(unverified.length, 1, "only the returned-but-unverified result is unknown_outcome");
	assert.equal(toolEnds.filter((record) => record.attributes?.["pi.tool.outcome"] === "ok").length, 1);
	assert.ok(incomplete.every((record) => record.status === "unknown"), "incomplete tools are still status unknown");
	assert.equal(unverified[0].status, "unknown");
	// Incomplete is a recording gap, not a proven failure, so it names no fault side.
	assert.ok(incomplete.every((record) => record.attributes?.["pi.tool.fault_side"] === undefined), "a lifecycle gap must not be attributed to any side");
});
