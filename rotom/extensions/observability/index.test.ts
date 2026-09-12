import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyFaultSide, createObservabilityExtensionV1, LOCAL_TRACE_SCHEMA_V1, LocalTraceWriterV1, localTracePathForSessionFile, toolSurfaceMetrics } from "./index.ts";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

function extensionHarness(toolApi: Record<string, unknown> = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const pi = {
		...toolApi,
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
	];
	for (const [i, details] of cases.entries()) {
		await harness.emit("tool_execution_start", { toolCallId: String(i), toolName: "fixture" }, ctx);
		await harness.emit("tool_execution_end", { toolCallId: String(i), isError: false, result: { content: [], details } }, ctx);
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
	assert.equal(classifyFaultSide({ isError: true, result: { details: { status: "unknown" } } }, "unknown_outcome"), "unknown");
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
