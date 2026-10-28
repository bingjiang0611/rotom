import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LOCAL_TRACE_SCHEMA_V1 } from "./trace-schema.ts";
import { localTracePathForSessionFile } from "./trace-writer.ts";
import { extensionHarness, assistantMessage } from "./trace-test-fixtures.ts";

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

for (const finalStop of ["stop", "error"] as const) {
	test(`operation status follows the last agent run after a failed request (final ${finalStop})`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "rotom-observability-retry-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const sessionFile = join(root, "session.jsonl");
		writeFileSync(sessionFile, "{}\n", { mode: 0o600 });
		const harness = extensionHarness();
		const ctx = {
			mode: "print",
			model: { provider: "test", id: "test", api: "test" },
			thinkingLevel: "off",
			sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => `retry-${finalStop}` },
			ui: { notify() {} },
		};
		await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "work", systemPrompt: "system", systemPromptOptions: { selectedTools: [] } }, ctx);
		// Pi's automatic retry runs agent.continue(): a new run in the same operation.
		for (const stopReason of ["error", finalStop]) {
			await harness.emit("agent_start", { type: "agent_start" }, ctx);
			await harness.emit("turn_start", { type: "turn_start", turnIndex: 0 }, ctx);
			await harness.emit("before_provider_headers", { type: "before_provider_headers", headers: {} }, ctx);
			await harness.emit("message_end", { message: assistantMessage(stopReason) }, ctx);
			await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message: assistantMessage(stopReason) }, ctx);
			await harness.emit("agent_end", { type: "agent_end", messages: [assistantMessage(stopReason)] }, ctx);
		}
		await harness.emit("agent_settled", { type: "agent_settled" }, ctx);
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
		const ends = readFileSync(localTracePathForSessionFile(sessionFile), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((record) => record.kind === "span_end");
		assert.deepEqual(ends.filter((record) => record.name === "pi.agent.run").map((record) => record.status), ["error", finalStop === "stop" ? "ok" : "error"]);
		const operation = ends.find((record) => record.name === "pi.agent.operation");
		assert.equal(operation?.status, finalStop === "stop" ? "ok" : "error");
		assert.equal(operation?.attributes?.["pi.operation.failed_request_count"], finalStop === "stop" ? 1 : 2);
	});
}

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
