import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localTracePathForSessionFile } from "./trace-writer.ts";
import { classifyFaultSide, toolSurfaceMetrics } from "./tool-metadata.ts";
import { extensionHarness } from "./trace-test-fixtures.ts";

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
		{ codingPhases: { mutation: "applied", followup: "skipped", source: "tool-reported" } },
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
	assert.equal(results[10].attributes["pi.tool.mutation_status"], "applied");
	assert.equal(results[10].attributes["pi.tool.followup_status"], "skipped");
	assert.equal(results[10].attributes["pi.tool.verification_status"], undefined);
	assert.equal(results[9].attributes["pi.tool.coding_evidence_source"], undefined);
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
		{ codingPhases: { mutation: "applied", followup: "failed", source: "tool-reported" } },
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
		[undefined, undefined, "followup_failed", "unknown"],
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
