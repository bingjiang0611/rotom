/**
 * The replay budget's request and token fuse, driven through a real product event stream.
 * Split from compaction-offload-live.test.ts to keep each file within the staged-size budget;
 * the campaign-level tests that use the same fuse stay there.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReplayMessage as AssistantMessage, ReplayStream } from "../src/compaction-offload-budget.ts";
import { ReplayBudget } from "../src/compaction-offload-budget.ts";
import { REPLAY_PRODUCT } from "../src/compaction-offload-cases.ts";
import { FAUX_MODEL } from "../src/compaction-offload-faux.ts";

const { AssistantMessageEventStream } = await import(pathToFileURL(resolve(REPLAY_PRODUCT, "runtime/pi/node_modules/@earendil-works/pi-ai/dist/index.js")).href) as { AssistantMessageEventStream: new () => ReplayStream };
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Zero-network test"); })); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const model = { provider: FAUX_MODEL.provider, id: FAUX_MODEL.id, api: "faux", contextWindow: 256_000 } as any;
function message(): AssistantMessage {
	return { role: "assistant", provider: model.provider, model: model.id, api: model.api, content: [], stopReason: "stop", timestamp: 1,
		usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function runtimeStream() {
	return { streamSimple: vi.fn(() => { const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: "stop", message: message() }); return stream; }) };
}

it("stops exactly before N+1 and counts separate usage before the next request", async () => {
	const budget = new ReplayBudget({ maxRequests: 2, maxInputTokens: 100 });
	const runtime = runtimeStream(); const original = runtime.streamSimple;
	budget.instrument(runtime as any, AssistantMessageEventStream, { provider: model.provider, model: model.id });
	await (runtime.streamSimple as any)(model, { messages: [] }).result();
	await (runtime.streamSimple as any)(model, { messages: [] }).result();
	expect(() => (runtime.streamSimple as any)(model, { messages: [] })).toThrow("request-limit");
	expect(original).toHaveBeenCalledTimes(2);
	await budget.settled();
	expect(budget.snapshot()).toEqual({ requests: 2, input: 2, output: 4, cacheRead: 6, cacheWrite: 8, usageKnown: true, pessimisticRequests: 0, stopReason: "request-limit" });
});

it("the token fuse includes cacheRead and cacheWrite, not just input", async () => {
	const budget = new ReplayBudget({ maxRequests: 20, maxInputTokens: 8 });
	const runtime = runtimeStream();
	budget.instrument(runtime as any, AssistantMessageEventStream, { provider: model.provider, model: model.id });
	await (runtime.streamSimple as any)(model, { messages: [] }).result();
	expect(budget.snapshot().stopReason).toBe("input-limit");
	expect(() => (runtime.streamSimple as any)(model, { messages: [] })).toThrow("input-limit");
	expect(budget.snapshot().requests).toBe(1);
});

it("unknown stream usage is charged a context window and reaches the input limit", async () => {
	const budget = new ReplayBudget({ maxRequests: 20, maxInputTokens: 100 });
	const runtime = { streamSimple: () => { const stream = new AssistantMessageEventStream(); stream.end(); return stream; } };
	budget.instrument(runtime as any, AssistantMessageEventStream, { provider: model.provider, model: model.id });
	const result = await (runtime.streamSimple as any)(model, { messages: [] }).result();
	expect(result.stopReason).toBe("error");
	expect(budget.snapshot()).toMatchObject({ requests: 1, input: 256_000, usageKnown: false, pessimisticRequests: 1, stopReason: "input-limit" });
	expect(() => (runtime.streamSimple as any)(model, { messages: [] })).toThrow("input-limit");
});

it("waits for in-flight usage even after another request was refused", async () => {
	const budget = new ReplayBudget({ maxRequests: 1, maxInputTokens: 100 });
	const source = new AssistantMessageEventStream();
	const runtime = { streamSimple: () => source };
	budget.instrument(runtime as any, AssistantMessageEventStream, { provider: model.provider, model: model.id });
	const forwarded = (runtime.streamSimple as any)(model, { messages: [] });
	expect(() => (runtime.streamSimple as any)(model, { messages: [] })).toThrow("request-limit");
	expect(budget.snapshot().usageKnown).toBe(false);
	source.push({ type: "done", reason: "stop", message: message() });
	await budget.settled(); await forwarded.result();
	expect(budget.snapshot()).toMatchObject({ requests: 1, input: 1, cacheRead: 3, cacheWrite: 4, usageKnown: true });
});

it("a different model is rejected before dispatch", () => {
	const budget = new ReplayBudget({ maxRequests: 20, maxInputTokens: 100 });
	const runtime = runtimeStream(); const original = runtime.streamSimple;
	budget.instrument(runtime as any, AssistantMessageEventStream, { provider: model.provider, model: model.id });
	expect(() => (runtime.streamSimple as any)({ ...model, id: "different" }, { messages: [] })).toThrow("model-mismatch");
	expect(original).not.toHaveBeenCalled(); expect(budget.snapshot().requests).toBe(0);
});
