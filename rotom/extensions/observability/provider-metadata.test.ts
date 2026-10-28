import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { qoderChunks } from "../qoder/transport.mjs";
import { qoderErrorAttributes } from "../qoder/diagnostics.mjs";
import { localTracePathForSessionFile } from "./trace-writer.ts";
import { extensionHarness, assistantMessage } from "./trace-test-fixtures.ts";

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
