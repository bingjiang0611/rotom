import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReplayBudget, validateLiveReplay, type ReplayAuthorization, type ReplayMessage, type ReplayStream } from "../src/compaction-offload-budget.ts";
import { REPLAY_PRODUCT, REPLAY_TASKS } from "../src/compaction-offload-cases.ts";
import { createLiveReplayCampaign } from "../src/compaction-offload-live.ts";
import { FAUX_MODEL, replayFaux, type FauxObservation } from "../src/compaction-offload-faux.ts";

const { AssistantMessageEventStream: Stream } = await import(pathToFileURL(resolve(REPLAY_PRODUCT, "runtime/pi/node_modules/@earendil-works/pi-ai/dist/index.js")).href) as { AssistantMessageEventStream: new () => ReplayStream };
const roots: string[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Zero-network test"); })));
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const authorization: ReplayAuthorization = { id: "infra-faux-only", provider: FAUX_MODEL.provider, model: FAUX_MODEL.id, thinking: "low", maxRepetitions: 3, maxRequests: 3000, maxInputTokens: 140_000_000 };
const model = { ...FAUX_MODEL, api: "faux", contextWindow: 256_000 } as any;
const context = () => ({ artifacts: {}, setArtifact() {} });
function failure(): ReplayMessage {
	return { role: "assistant", provider: model.provider, model: model.id, api: model.api, stopReason: "error", timestamp: 1,
		content: [], errorMessage: "ECONNRESET PRIVATE_ERROR", usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } };
}
async function campaign(schedule: ("error" | "valid" | "invalid" | "setup-error" | "cleanup-error")[], maxInputTokens = 140_000_000) {
	const directory = await mkdtemp(join(tmpdir(), "offload-infra-")); roots.push(directory);
	const observed: FauxObservation = { requests: [], config: null, agentDirMatches: false, summaryCalls: 0 };
	const task = REPLAY_TASKS[0]!;
	let index = 0;
	const factory = vi.fn(async (ctx: Parameters<ReturnType<typeof replayFaux>>[0]) => {
		const mode = schedule[index++];
		if (mode === "setup-error") throw new Error("PRIVATE_HARNESS_ERROR");
		const runtime = await replayFaux(task, observed, false, { model: FAUX_MODEL, contextWindow: model.contextWindow, reasoning: true },
			{ batchSize: 20, ...(mode === "invalid" ? { phase1ReadLimit: 5 } : {}) })(ctx);
		if (mode === "error" || mode === "cleanup-error") runtime.streamSimple = (() => {
			const stream = new Stream(); stream.push({ type: "error", reason: "error", error: failure() }); return stream;
		}) as typeof runtime.streamSimple;
		if (mode === "cleanup-error") {
			const prototype = ctx.product.runtime.AgentSession.prototype, dispose = prototype.dispose;
			vi.spyOn(prototype, "dispose").mockImplementationOnce(function (this: InstanceType<typeof ctx.product.runtime.AgentSession>) {
				dispose.call(this); throw new Error("PRIVATE_CLEANUP_ERROR");
			});
		}
		return runtime;
	});
	return { task, directory, factory, live: createLiveReplayCampaign({ ...authorization, maxInputTokens }, { directory, runtimeFactory: factory }) };
}

it.each(["invalid", "error"] as const)("unusable samples accumulate across valid runs; final %s stops without replacement", async last => {
	const { task, live, factory, directory } = await campaign(["error", "valid", last === "invalid" ? "error" : "invalid", last]);
	const outputs = [];
	for (const [i, candidate] of [false, true, true, false].entries()) outputs.push((await live.harness(task, candidate, Math.floor(i / 2) + 1).run(task.scenario, context())).output);
	expect(outputs[0]).toMatchObject({ status: "failed", reason: "provider-error", metrics: { usageComplete: false, inputTokens: model.contextWindow, errors: [{ turn: 1, stopReason: "error", category: "connection" }] }, cumulative: { requests: 1, pessimisticRequests: 1, usageKnown: false, stopReason: null } });
	expect(outputs[1]).toMatchObject({ status: "completed", metrics: { correct: true, usageComplete: true }, cumulative: { usageKnown: false, pessimisticRequests: 1, stopReason: null } });
	expect(outputs[2]?.cumulative.stopReason).toBeNull();
	const reason = last === "invalid" ? "threshold-not-reached" : "provider-error";
	expect(outputs[3]).toMatchObject({ status: last === "invalid" ? "invalid" : "failed", reason, cumulative: { stopReason: reason, pessimisticRequests: 2 } });
	const requests = live.budget.snapshot().requests;
	const stopped = await live.harness(task, true, 3).run(task.scenario, context());
	expect(stopped.output.status).toBe("not-run"); expect(live.budget.snapshot().requests).toBe(requests); expect(factory).toHaveBeenCalledTimes(4);
	expect(live.summary()).toMatchObject({ executedRuns: 4, invalidRuns: 1, providerErrorRuns: 2, unusableRuns: 3, validPairs: 0, outputAccounting: "reported-subtotal", cumulative: { pessimisticRequests: 2 } });
	const path = join(directory, (await readdir(directory)).find(name => name.endsWith(".jsonl"))!);
	const text = await readFile(path, "utf8"); expect(text).not.toContain("PRIVATE_");
	expect(text.trim().split("\n").map(line => JSON.parse(line))).toEqual([...outputs, stopped.output]);
	expect(fetch).not.toHaveBeenCalled();
}, 120_000);

it("pessimistic input can stop immediately, before the three-sample limit", async () => {
	const { task, live, factory } = await campaign(["error"], model.contextWindow);
	const result = await live.harness(task, false, 1).run(task.scenario, context());
	expect(result.output).toMatchObject({ status: "failed", reason: "provider-error", cumulative: { input: model.contextWindow, stopReason: "input-limit", pessimisticRequests: 1 } });
	expect((await live.harness(task, true, 1).run(task.scenario, context())).output.status).toBe("not-run");
	expect(factory).toHaveBeenCalledTimes(1);
});

it.each(["setup-error", "cleanup-error"] as const)("%s remains a harness failure, even when a provider also failed", async mode => {
	const { task, live } = await campaign([mode]);
	const result = await live.harness(task, false, 1).run(task.scenario, context());
	expect(result.output).toMatchObject({ status: "failed", reason: "run-error", cumulative: { stopReason: "run-error" } });
});

it("unknown usage replaces partial input, preserves output subtotal, and is not charged again after a terminal event", async () => {
	const budget = new ReplayBudget({ maxRequests: 10, maxInputTokens: 1_000_000 });
	const message = failure(); message.usage = { ...message.usage, input: 10, cacheRead: 20, cacheWrite: 30, output: 7 };
	budget.record(message.usage, false, 256_000);
	expect(budget.snapshot()).toMatchObject({ input: 256_000, cacheRead: 0, cacheWrite: 0, output: 7, pessimisticRequests: 1, stopReason: null });
	const runtime = { streamSimple: () => (async function* () { try { yield { type: "done", reason: "stop", message: { ...message, stopReason: "stop" } }; } finally { throw new Error("PRIVATE_AFTER_TERMINAL"); } })() };
	budget.instrument(runtime as any, Stream, authorization);
	await (runtime.streamSimple as any)(model, { messages: [] }).result(); await budget.settled();
	expect(budget.snapshot()).toMatchObject({ requests: 1, input: 256_010, cacheRead: 20, cacheWrite: 30, output: 14, pessimisticRequests: 1, stopReason: "run-error" });
});

it("requires exact task authorization and rejects direct out-of-scope harness construction", () => {
	const env = { ROTOM_EVAL_COMPACTION_OFFLOAD: "1", ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE: "1", ROTOM_EVAL_PROVIDER: authorization.provider, ROTOM_EVAL_MODEL: authorization.model, ROTOM_EVAL_THINKING: "low" };
	const grant = { ...authorization, tasks: ["multi-file-fix"] };
	expect(validateLiveReplay({ ...env, ROTOM_EVAL_COMPACTION_OFFLOAD_TASKS: "multi-file-fix" }, grant).tasks).toEqual(grant.tasks);
	expect(() => validateLiveReplay(env, grant)).toThrow("tasks");
	expect(() => validateLiveReplay({ ...env, ROTOM_EVAL_COMPACTION_OFFLOAD_TASKS: "config-aggregate" }, grant)).toThrow("tasks");
	expect(() => validateLiveReplay({ ...env, ROTOM_EVAL_COMPACTION_OFFLOAD_TASKS: "multi-file-fix" }, authorization)).toThrow("tasks");
	const runtimeFactory = vi.fn();
	expect(() => createLiveReplayCampaign(grant, { runtimeFactory }).harness(REPLAY_TASKS[0]!, false, 1)).toThrow("not authorized");
	expect(runtimeFactory).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
});
