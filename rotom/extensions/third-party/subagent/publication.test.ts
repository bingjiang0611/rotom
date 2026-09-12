import assert from "node:assert/strict";
import test from "node:test";
import { subagentPolicyApi, subagentEvidenceResult, prepareProductSubagentArguments, PRODUCT_HANDOFF_GUIDELINE } from "./policy.ts";

function fixture() {
	const handlers = new Map<string, Function[]>(); const tools = new Map<string, any>(); const published: unknown[] = [];
	const api = subagentPolicyApi({
		on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
		registerTool(tool: any) { tools.set(tool.name, tool); },
		sendMessage(message: unknown) { published.push(message); },
		sendUserMessage(message: unknown) { published.push(message); },
		appendEntry(type: string, data: unknown) { published.push({ type, data }); },
	} as any);
	return { api, tools, published, retire: () => handlers.get("session_shutdown")!.forEach((handler) => handler()) };
}

test("retired publication throws synchronously, cannot revive on A-B-A or affect independent SDK instances", () => {
	const old = fixture(); const independent = fixture(); const replacement = fixture();
	old.api.sendMessage({ customType: "fixture", content: "before", display: false });
	old.retire();
	for (const publish of [() => old.api.sendMessage({ customType: "fixture", content: "late", display: false }), () => old.api.sendUserMessage("late"), () => old.api.appendEntry("fixture", {})]) assert.throws(publish, /retired/u);
	independent.api.appendEntry("fixture", "B"); replacement.api.appendEntry("fixture", "A-again");
	assert.equal(old.published.length, 1); assert.equal(independent.published.length, 1); assert.equal(replacement.published.length, 1);
});

test("late onUpdate and terminal result are rejected without cancelling the underlying work", { timeout: 5000 }, async () => {
	const { api, tools, retire } = fixture();
	const release = Promise.withResolvers<any>(); let update: Function; let finished = false; const updates: unknown[] = [];
	api.registerTool({ name: "fixture", execute(_id: string, _args: any, _signal: any, onUpdate: Function) { update = onUpdate; return release.promise.then(() => { finished = true; return { content: [] }; }); } } as any);
	const pending = tools.get("fixture").execute("old", {}, undefined, (value: unknown) => updates.push(value));
	const rejected = assert.rejects(pending, /retired/u);
	retire();
	assert.throws(() => update!({ content: [] }), /retired/u);
	release.resolve(undefined); await rejected;
	assert.equal(finished, true); assert.deepEqual(updates, []);
});

test("all direct steering routes force no replacement recovery, while explicit resume stays separate", () => {
	for (const route of [{ id: "run" }, { dir: "/tmp/run" }]) for (const requested of [undefined, true, false]) {
		const args = prepareProductSubagentArguments({ ...route, action: " steer ", steeringRecovery: requested });
		assert.equal(args.action, "steer"); assert.equal(args.steeringRecovery, false);
	}
	assert.equal(prepareProductSubagentArguments({ action: "resume" }).action, "resume");
});

test("merged policy preserves tool binding, normalizes once and fences the main tool", async () => {
	const { api, tools, retire } = fixture(); const calls: any[] = []; const updates: unknown[] = [];
	const definition = { name: "subagent", description: "fixture", parameters: { type: "object", properties: {} }, execute(...args: any[]) { calls.push({ receiver: this, args }); args[3]?.({ content: [] }); return Promise.resolve({ content: [] }); } };
	api.registerTool(definition as any);
	const tool = tools.get("subagent");
	assert.equal(tool.promptGuidelines.filter((line: string) => line === PRODUCT_HANDOFF_GUIDELINE).length, 1);
	await tool.execute("call", { action: " steer ", id: "run", steeringRecovery: true }, undefined, (value: unknown) => updates.push(value));
	assert.equal(calls.length, 1); assert.equal(calls[0].receiver, definition);
	assert.deepEqual(calls[0].args[1], { action: "steer", id: "run", steeringRecovery: false }); assert.equal(updates.length, 1);
	assert.throws(() => tool.execute("invalid", { action: "refine" }), /outside/u);
	retire(); assert.throws(() => tool.execute("late", { action: "status" }), /retired/u); assert.equal(calls.length, 1);
});

test("task receipts and process evidence remain distinct without result mutation or replay", async () => {
	const { api, tools } = fixture(); let calls = 0;
	const receipt = { content: [{ type: "text", text: "Async workflow" }], details: { asyncId: "run-1", mode: "workflow", results: [] } };
	api.registerTool({ name: "subagent", execute() { calls++; return receipt; } } as any);
	const projected = await tools.get("subagent").execute("call", { workflowScript: "return 1" });
	assert.equal(calls, 1);
	assert.match(projected.content[0].text, /launch receipt only/u);
	assert.equal(projected.details, receipt.details);
	assert.equal(projected.content[1], receipt.content[0]);
	assert.equal(receipt.content.length, 1);
	for (const state of ["pending", "observed", "unknown", "not-started", "private-invalid-state"]) {
		const result = { content: [], isError: true, details: { lifecycleStatus: { processTerminal: { state, error: "private-error-body" } } } };
		const next = subagentEvidenceResult("subagent", { action: "status" }, result);
		assert.equal(next.details, result.details); assert.equal(next.isError, true);
		assert.match(next.content[0].text, /unknown does not authorize replay/u);
		assert.doesNotMatch(next.content[0].text, /private-/u);
		if (state === "observed") assert.match(next.content[0].text, /not whole-process-tree/u);
	}
	assert.match(subagentEvidenceResult("subagent_wait", {}, { content: [], details: { completions: [{ success: true }] } }).content[0].text, /not proof that every child/u);
	assert.equal(subagentEvidenceResult("subagent", { action: "guide" }, receipt), receipt);
	const failed = { ...receipt, isError: true };
	assert.equal(subagentEvidenceResult("subagent", {}, failed), failed, "failed admission must not be labeled a launch receipt");
	assert.equal(subagentEvidenceResult("unrelated", {}, { ...receipt, details: { workflow: {} } }).content[0].text, "Async workflow");
});

test("stop is dispatched once and remains a request, not writer-closure evidence", async () => {
	const { api, tools } = fixture(); let calls = 0;
	const raw = { content: [{ type: "text", text: "Stop requested for async run fixture." }], details: { mode: "management", results: [] } };
	api.registerTool({ name: "subagent", execute() { calls++; return raw; } } as any);
	const result = await tools.get("subagent").execute("stop", { action: " stop ", id: "fixture" });
	assert.equal(calls, 1);
	assert.match(result.content[0].text, /stop response is not proof of cancellation convergence/u);
	assert.match(result.content[0].text, /unknown does not authorize replay/u);
	assert.equal(result.details, raw.details);
	assert.equal(result.content[1], raw.content[0]);
	assert.equal(raw.content.length, 1);
	const rejected = { ...raw, isError: true };
	assert.equal(subagentEvidenceResult("subagent", { action: "stop" }, rejected), rejected);
	assert.equal(subagentEvidenceResult("subagent", { action: "status" }, raw), raw);
});

test("short handoff guideline retains evidence, unknown and freshness boundaries (text contract only)", () => {
	for (const required of ["constraints, unknowns", "next authorized action", "Summaries are not evidence", "never upgrade unknown to success", "readable evidence", "command/result/scope", "revalidate missing, conflicting or stale sources", "current revision", "relevant dirty files"]) assert.ok(PRODUCT_HANDOFF_GUIDELINE.includes(required), required);
	// A static text budget prevents regrowing the checklist; it is not a provider-token estimate.
	assert.ok(Buffer.byteLength(PRODUCT_HANDOFF_GUIDELINE, "utf8") <= 320);
});
