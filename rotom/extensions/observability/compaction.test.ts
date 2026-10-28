import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localTracePathForSessionFile } from "./trace-writer.ts";
import { extensionHarness, assistantMessage } from "./trace-test-fixtures.ts";

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
