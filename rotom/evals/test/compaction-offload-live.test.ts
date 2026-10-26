import { mkdtemp, readFile, readdir, rm, stat, symlink, rename, unlink, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import type { ReplayMessage as AssistantMessage, ReplayStream } from "../src/compaction-offload-budget.ts";
import { ReplayBudget, validateLiveReplay, type ReplayAuthorization } from "../src/compaction-offload-budget.ts";
import { REPLAY_KEEP_RECENT, REPLAY_PRODUCT, REPLAY_TASKS, REPLAY_THRESHOLD, type ReplayTask } from "../src/compaction-offload-cases.ts";
import { authorizedRuntimeFactory, createLiveReplayCampaign } from "../src/compaction-offload-live.ts";
import { createReplayStore, type LiveReplayRow } from "../src/compaction-offload-store.ts";
import { FAUX_MODEL, replayFaux, type FauxObservation } from "../src/compaction-offload-faux.ts";
import * as metrics from "../src/compaction-offload-metrics.ts";

const { AssistantMessageEventStream } = await import(pathToFileURL(resolve(REPLAY_PRODUCT, "runtime/pi/node_modules/@earendil-works/pi-ai/dist/index.js")).href) as { AssistantMessageEventStream: new () => ReplayStream };
const roots: string[] = [];
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Zero-network test"); })); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await mkdtemp(join(tmpdir(), "offload-live-test-")); roots.push(root); return root; }
const env = { ROTOM_EVAL_COMPACTION_OFFLOAD: "1", ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE: "1", ROTOM_EVAL_PROVIDER: "openai-codex", ROTOM_EVAL_MODEL: "gpt-5.6-luna", ROTOM_EVAL_THINKING: "low", ROTOM_EVAL_REPETITIONS: "3" };
const testAuthorization: ReplayAuthorization = { id: "validation-test-only", provider: "openai-codex", model: "gpt-5.6-luna", thinking: "low", maxRepetitions: 3, maxRequests: 2000, maxInputTokens: 100_000_000 };
const auth = (): ReplayAuthorization => ({ ...testAuthorization, id: "faux-only-test", provider: FAUX_MODEL.provider, model: FAUX_MODEL.id });
const observed = (): FauxObservation => ({ requests: [], config: null, agentDirMatches: false, summaryCalls: 0 });
const profile = (contextWindow = 256_000) => ({ model: FAUX_MODEL, contextWindow, reasoning: true });
const context = () => ({ artifacts: {}, setArtifact: vi.fn() });
const small: ReplayTask = {
	id: "budget-small", files: { "manifest.json": '["data.txt"]', "data.txt": "synthetic detail\n".repeat(150) }, reading: ["data.txt"],
	answer: "MODEL_BODY_MUST_NOT_BE_LOGGED", solution: {},
	scenario: { id: "budget-small", steps: [{ type: "prompt", content: "Read the manifest and the data." }, { type: "prompt", content: "Finish the task." }] },
};
async function rows(directory: string) {
	const names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
	expect(names).toHaveLength(1);
	const path = join(directory, names[0]!);
	return { path, lines: (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as LiveReplayRow) };
}

it("rejects missing authorization and validates explicit synthetic test grants", () => {
	expect(() => validateLiveReplay(env, null)).toThrow("no authorization");
	expect(validateLiveReplay(env, testAuthorization).repetitions).toBe(3);
	expect(validateLiveReplay({ ...env, ROTOM_EVAL_REPETITIONS: "1" }, testAuthorization).repetitions).toBe(1);
	for (const key of ["ROTOM_EVAL_COMPACTION_OFFLOAD", "ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE", "ROTOM_EVAL_PROVIDER", "ROTOM_EVAL_MODEL", "ROTOM_EVAL_THINKING"]) {
		expect(() => validateLiveReplay({ ...env, [key]: undefined }, testAuthorization)).toThrow();
		expect(() => validateLiveReplay({ ...env, [key]: env[key as keyof typeof env] + " " }, testAuthorization)).toThrow();
	}
	for (const value of ["4", "0", "-1", "1.5", "3 ", "", "NaN"]) expect(() => validateLiveReplay({ ...env, ROTOM_EVAL_REPETITIONS: value }, testAuthorization)).toThrow();
});

it("captures the original credential/model paths without reading them during registration", async () => {
	vi.stubEnv("PI_CODING_AGENT_DIR", "/synthetic-original-agent");
	const factory = authorizedRuntimeFactory();
	vi.stubEnv("PI_CODING_AGENT_DIR", "/synthetic-isolated-agent");
	const create = vi.fn(async () => ({}));
	await factory({ configDir: "/synthetic-isolated-agent", product: { runtime: { ModelRuntime: { create } } } } as any);
	expect(create).toHaveBeenCalledExactlyOnceWith({ authPath: "/synthetic-original-agent/auth.json", modelsPath: "/synthetic-original-agent/models.json", refreshOnCreate: false });
	expect(fetch).not.toHaveBeenCalled();
});

const model = { provider: FAUX_MODEL.provider, id: FAUX_MODEL.id, api: "faux" } as any;
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
	expect(budget.snapshot()).toEqual({ requests: 2, input: 2, output: 4, cacheRead: 6, cacheWrite: 8, usageKnown: true, stopReason: "request-limit" });
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

it("unknown stream usage settles as failure and cannot silently reuse the budget", async () => {
	const budget = new ReplayBudget({ maxRequests: 20, maxInputTokens: 100 });
	const runtime = { streamSimple: () => { const stream = new AssistantMessageEventStream(); stream.end(); return stream; } };
	budget.instrument(runtime as any, AssistantMessageEventStream, { provider: model.provider, model: model.id });
	const result = await (runtime.streamSimple as any)(model, { messages: [] }).result();
	expect(result.stopReason).toBe("error");
	expect(budget.snapshot()).toMatchObject({ requests: 1, usageKnown: false, stopReason: "usage-unknown" });
	expect(() => (runtime.streamSimple as any)(model, { messages: [] })).toThrow("usage-unknown");
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

it("persists completed, budget-failed and not-run rows, without model bodies", async () => {
	const task = { ...REPLAY_TASKS[0]!, answer: small.answer };
	const directory = await temporary();
	const observation = observed();
	const factory = vi.fn(replayFaux(task, observation, false, profile(), { batchSize: 10 }));
	const campaign = createLiveReplayCampaign({ ...auth(), maxRequests: 18 }, { directory, runtimeFactory: factory });
	const first = await campaign.harness(task, false, 1).run(task.scenario, context());
	expect(first.output.status).toBe("completed");
	expect(first.output.metrics?.correct).toBe(true);
	expect(first.output.transport).toBe("sse");
	expect(first.output.repetitions).toBe(3);
	expect(first.output.cumulative.requests).toBe(17);
	expect((await rows(directory)).lines).toHaveLength(1); // durable before run 2
	const second = await campaign.harness(task, true, 1).run(task.scenario, context());
	const third = await campaign.harness(task, false, 2).run(task.scenario, context());
	expect(second.output).toMatchObject({ status: "failed", reason: "request-limit", cumulative: { requests: 18 } });
	expect(third.output).toMatchObject({ status: "not-run", metrics: null, contextWindow: null, cumulative: { requests: 18 } });
	expect(factory).toHaveBeenCalledTimes(2);
	expect(observation.requests).toHaveLength(18);
	const saved = await rows(directory);
	expect(saved.lines).toEqual([first.output, second.output, third.output]);
	expect((await stat(directory)).mode & 0o777).toBe(0o700);
	expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
	expect(JSON.stringify(first)).not.toContain(task.answer);
	expect(await readFile(saved.path, "utf8")).not.toContain(task.answer);
	expect(fetch).not.toHaveBeenCalled();
}, 90_000);

it("the observed input-token cap stops an actual faux run before its next request", async () => {
	const directory = await temporary(); const observation = observed();
	const campaign = createLiveReplayCampaign({ ...auth(), maxInputTokens: 1 }, { directory, runtimeFactory: replayFaux(small, observation, false, profile()) });
	const first = await campaign.harness(small, false, 1).run(small.scenario, context());
	const second = await campaign.harness(small, true, 1).run(small.scenario, context());
	expect(first.output).toMatchObject({ status: "failed", reason: "input-limit", cumulative: { requests: 1 } });
	expect(first.output.cumulative.input).toBeGreaterThan(1); // usage arrives after an admitted request
	expect(second.output.status).toBe("not-run"); expect(observation.requests).toHaveLength(1);
	expect((await rows(directory)).lines).toHaveLength(2);
}, 90_000);

it("the shared fuse also prevents a native summary dispatch at the limit", async () => {
	const directory = await temporary(); const observation = observed(); const task = REPLAY_TASKS[0]!;
	const campaign = createLiveReplayCampaign({ ...auth(), maxRequests: 30 }, { directory, runtimeFactory: replayFaux(task, observation, false, profile()) });
	const result = await campaign.harness(task, false, 1).run(task.scenario, context());
	expect(result.output).toMatchObject({ status: "failed", reason: "request-limit", cumulative: { requests: 30 }, metrics: { thresholdCompactions: 2, nativeCompactions: 0 } });
	// Pi checks the threshold before and after the failed turn; neither
	// preparation is allowed to become a provider summary request.
	expect(observation.requests).toHaveLength(30); expect(observation.summaryCalls).toBe(0);
}, 90_000);

it.each([192_000, 320_000])("uses actual model window %s, and budgets native summaries too", async (window) => {
	const directory = await temporary(); const observation = observed(); const task = REPLAY_TASKS[0]!;
	const campaign = createLiveReplayCampaign(auth(), { directory, runtimeFactory: replayFaux(task, observation, false, profile(window)) });
	const result = await campaign.harness(task, false, 1).run(task.scenario, context());
	expect(result.output.status).toBe("completed");
	expect(result.output).toMatchObject({ contextWindow: window, reserveTokens: window - REPLAY_THRESHOLD, thinking: "low" });
	expect(observation.settings).toEqual({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: window - REPLAY_THRESHOLD, keepRecentTokens: REPLAY_KEEP_RECENT } });
	expect(observation.reasoning).toBe("low");
	expect(observation.requestControls).toHaveLength(observation.requests.length);
	expect(observation.requestControls!.every((o) => o.transport === "sse" && o.maxRetries === 0)).toBe(true);
	expect(observation.summaryCalls).toBe(2);
	expect(observation.requests.filter((r) => r.summary).every((r) => r.maxTokens === null)).toBe(true);
	expect(result.output.cumulative.requests).toBe(observation.requests.length);
	expect(result.output.cumulative.requests).toBe(result.output.metrics!.turns + observation.summaryCalls);
	expect(result.output.keepRecentTokens).toBe(REPLAY_KEEP_RECENT);
	for (const [total, metric] of [["input", "inputTokens"], ["output", "outputTokens"], ["cacheRead", "cacheRead"], ["cacheWrite", "cacheWrite"]] as const) expect(result.output.cumulative[total]).toBe(result.output.metrics![metric]);
	expect(fetch).not.toHaveBeenCalled();
}, 90_000);

it("preserves a failed row and stops when decision metadata is missing", async () => {
 vi.spyOn(metrics, "readOffloadDecisions").mockResolvedValue([]);
 const directory = await temporary(), observation = observed(), task = REPLAY_TASKS[0]!;
 const factory = vi.fn(replayFaux(task, observation, false, profile(), { batchSize: 10 }));
 const campaign = createLiveReplayCampaign(auth(), { directory, runtimeFactory: factory });
 const first = await campaign.harness(task, true, 1).run(task.scenario, context());
 expect(first.output).toMatchObject({ status: "failed", reason: "decision-ledger-incomplete", metrics: { correct: true, offloadDecisions: [] } });
 expect(first.output.metrics!.thresholdCompactions).toBeGreaterThan(0);
 const second = await campaign.harness(task, false, 1).run(task.scenario, context());
 expect(second.output.status).toBe("not-run");
 expect(factory).toHaveBeenCalledTimes(1);
 expect((await rows(directory)).lines).toEqual([first.output, second.output]);
 expect(fetch).not.toHaveBeenCalled();
});

it("stops an otherwise correct campaign when the threshold was never reached", async () => {
 const directory = await temporary(), observation = observed();
 const factory = vi.fn(replayFaux(small, observation, false, profile()));
 const campaign = createLiveReplayCampaign(auth(), { directory, runtimeFactory: factory });
 const first = await campaign.harness(small, false, 1).run(small.scenario, context());
 expect(first.output).toMatchObject({ status: "failed", reason: "threshold-not-reached", metrics: { correct: true, thresholdCompactions: 0 } });
 const second = await campaign.harness(small, true, 1).run(small.scenario, context());
 expect(second.output).toMatchObject({ status: "not-run", reason: "threshold-not-reached", metrics: null });
 expect(factory).toHaveBeenCalledTimes(1);
 expect(observation.requests).toHaveLength(5);
 expect((await rows(directory)).lines).toEqual([first.output, second.output]);
 expect(fetch).not.toHaveBeenCalled();
});

it("rejects a window at the threshold without dispatching or clamping it", async () => {
	const directory = await temporary(); const observation = observed();
	const campaign = createLiveReplayCampaign(auth(), { directory, runtimeFactory: replayFaux(small, observation, false, profile(REPLAY_THRESHOLD)) });
	const result = await campaign.harness(small, false, 1).run(small.scenario, context());
	expect(result.output).toMatchObject({ status: "failed", contextWindow: REPLAY_THRESHOLD, reserveTokens: null, metrics: null, cumulative: { requests: 0 } });
	expect(observation.requests).toHaveLength(0);
});

it("rejects worktrees and symlink destinations; a used authorization cannot rerun", async () => {
	await expect(createReplayStore(auth(), join(REPLAY_PRODUCT, ".must-not-create-replay"))).rejects.toThrow("outside Git");
	const directory = await temporary(); const link = join(await temporary(), "link");
	await symlink(directory, link); await expect(createReplayStore(auth(), link)).rejects.toThrow();
	await createReplayStore(auth(), directory);
	await expect(createReplayStore(auth(), directory)).rejects.toMatchObject({ code: "EEXIST" });
	expect((await readdir(directory)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
});

it("a log failure preserves earlier rows and seals the campaign before further requests", async () => {
	const directory = await temporary(); const observation = observed(); const task = REPLAY_TASKS[0]!;
	const campaign = createLiveReplayCampaign(auth(), { directory, runtimeFactory: replayFaux(task, observation, false, profile(), { batchSize: 10 }) });
	const first = await campaign.harness(task, false, 1).run(task.scenario, context());
	expect(first.output.status).toBe("completed");
	const saved = await rows(directory); await chmod(saved.path, 0o644);
	await expect(campaign.harness(task, true, 1).run(task.scenario, context())).rejects.toThrow("private regular file");
	const dispatched = observation.requests.length;
	await expect(campaign.harness(task, false, 2).run(task.scenario, context())).rejects.toThrow("no further writes or requests");
	expect(observation.requests).toHaveLength(dispatched);
	expect((await rows(directory)).lines).toEqual([first.output]);
	expect(campaign.budget.snapshot().stopReason).toBe("persistence-error");
}, 90_000);

it("does not retry an unknown log append even after the path is repaired", async () => {
	const directory = await temporary(); const store = await createReplayStore(auth(), directory);
	await rename(store.path, store.path + ".original"); await symlink(store.path + ".original", store.path);
	await expect(store.append({} as LiveReplayRow)).rejects.toThrow();
	await unlink(store.path); await rename(store.path + ".original", store.path);
	await expect(store.append({} as LiveReplayRow)).rejects.toThrow("no retry");
	expect(await readFile(store.path, "utf8")).toBe("");
});
