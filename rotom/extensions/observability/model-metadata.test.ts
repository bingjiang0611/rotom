import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { qoderErrorAttributes } from "../qoder/diagnostics.mjs";
import { localTracePathForSessionFile } from "./trace-writer.ts";
import { providerErrorAttributes, runtimeVersionAttributes } from "./model-metadata.ts";
import { extensionHarness, assistantMessage } from "./trace-test-fixtures.ts";

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
