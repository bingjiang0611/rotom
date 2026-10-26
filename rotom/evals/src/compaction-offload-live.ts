import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createHarness } from "vitest-evals/harness";
import { createReplayHarness, REPLAY_KEEP_RECENT, REPLAY_PRODUCT, REPLAY_THRESHOLD, type ReplayTask } from "./compaction-offload-cases.ts";
import { ReplayBudget, type ReplayAuthorization } from "./compaction-offload-budget.ts";
import { summarizeLiveReplay } from "./compaction-offload-metrics.ts";
import { createReplayStore, type LiveReplayRow } from "./compaction-offload-store.ts";
import type { PiCodingAgentHarnessOptions, PiCodingAgentInput } from "./pi-harness.ts";

type RuntimeFactory = NonNullable<PiCodingAgentHarnessOptions["modelRuntimeFactory"]>;

export function authorizedRuntimeFactory(): RuntimeFactory {
	// Capture BEFORE setupWorkspace binds PI_CODING_AGENT_DIR to the isolated
	// SoL-Pi directory. Only this deferred factory reads the real credential store.
	const agentDir = getAgentDir();
	return async ({ product }) => product.runtime.ModelRuntime.create({
		authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), refreshOnCreate: false,
	});
}

export function createLiveReplayCampaign(authorization: ReplayAuthorization, options: { directory?: string; runtimeFactory?: RuntimeFactory; repetitions?: number } = {}) {
	const budget = new ReplayBudget(authorization);
	const repetitions = options.repetitions ?? authorization.maxRepetitions;
	const runtimeFactory = options.runtimeFactory ?? authorizedRuntimeFactory();
	let storePromise: ReturnType<typeof createReplayStore> | undefined;
	let persistenceFailed = false;
	let running = false;
	let invalidRuns = 0;
	const rows: LiveReplayRow[] = [];
	const git = (args: string[]) => {
		const result = spawnSync("git", ["-C", REPLAY_PRODUCT, ...args], { encoding: "utf8" });
		if (result.status !== 0) throw new Error("Cannot identify replay source revision");
		return result.stdout.trim();
	};
	const sourceCommit = git(["rev-parse", "HEAD"]);
	const sourceDirty = git(["status", "--porcelain"]) !== "";
	return {
		budget,
		summary: () => ({ ...summarizeLiveReplay(rows), stopReason: budget.snapshot().stopReason }),
		harness(task: ReplayTask, candidate: boolean, repetition: number) {
			let contextWindow: number | null = null;
			const harness = createReplayHarness(task, candidate, {
				model: { provider: authorization.provider, id: authorization.model }, thinkingLevel: authorization.thinking,
				async modelRuntimeFactory(context) {
					const runtime = await runtimeFactory(context);
					const model = runtime.getModel(authorization.provider, authorization.model);
					if (!model) throw new Error("Authorized replay model is unavailable");
					contextWindow = model.contextWindow;
					const { AssistantMessageEventStream } = await import(pathToFileURL(resolve(context.product.verified.packageRoot, "../pi-ai/dist/index.js")).href);
					budget.instrument(runtime, AssistantMessageEventStream, authorization);
					return runtime;
				},
			});
			return createHarness<PiCodingAgentInput, LiveReplayRow>({
				name: harness.name,
				async run({ input, signal }) {
					if (persistenceFailed) throw new Error("Replay metrics persistence failed; no further writes or requests");
					const started = performance.now();
					storePromise ??= createReplayStore(authorization, options.directory, repetitions);
					const store = await storePromise;
					const row: LiveReplayRow = {
						version: 1, authorizationId: authorization.id, timestamp: new Date().toISOString(), task: task.id,
						arm: candidate ? "candidate" : "baseline", repetition, repetitions, status: "not-run", reason: budget.snapshot().stopReason,
						provider: authorization.provider, model: authorization.model, thinking: authorization.thinking, transport: "sse",
						sourceCommit, sourceDirty, contextWindow: null, thresholdTokens: REPLAY_THRESHOLD, reserveTokens: null, keepRecentTokens: null,
						metrics: null, cumulative: budget.snapshot(),
					};
					const before = budget.snapshot();
					if (running) budget.halt("run-error"); // This campaign requires serial runs.
					const abort = () => budget.halt("run-error");
					if (signal?.aborted) abort();
					if (!budget.snapshot().stopReason) {
						running = true;
						signal?.addEventListener("abort", abort, { once: true });
						try {
							// Keep raw inner artifacts out of eval metadata/JSON reporters.
							// Only the metric row crosses this boundary; the harness cleans
							// up its private raw session/trace after extracting metrics.
							const result = await harness.run(input, { signal, artifacts: {}, setArtifact() {} });
							row.metrics = result.output;
							row.status = "completed";
							if (candidate && row.metrics.offloadDecisions.length !== row.metrics.thresholdCompactions) {
								budget.halt("decision-ledger-incomplete");
								row.status = "failed";
							}
						} catch {
							budget.halt("run-error");
							row.status = "failed";
							row.metrics = harness.failureMetrics();
						} finally {
							// Include any aborted sibling summary/cache-warming stream.
							await budget.settled();
							signal?.removeEventListener("abort", abort);
							running = false;
						}
					}
					const after = budget.snapshot();
					if (row.status === "completed" && (!after.usageKnown || signal?.aborted)) row.status = "failed";
					if (row.status === "completed" && row.metrics!.thresholdCompactions === 0) {
						if (after.stopReason) row.status = "failed";
						else {
							row.status = "invalid";
							row.reason = "threshold-not-reached";
							if (++invalidRuns >= 3) budget.halt("threshold-not-reached");
						}
					}
					if (row.metrics) {
						// Dispatch usage also covers failed summaries not committed as a
						// compaction entry. Do not infer a dollar quote for this token cap.
						row.metrics.inputTokens = after.input - before.input;
						row.metrics.outputTokens = after.output - before.output;
						row.metrics.cacheRead = after.cacheRead - before.cacheRead;
						row.metrics.cacheWrite = after.cacheWrite - before.cacheWrite;
						row.metrics.usageComplete = after.usageKnown;
						row.metrics.estimatedCostUsd = null;
						row.metrics.wallMs = performance.now() - started;
					}
					row.contextWindow = contextWindow;
					row.reserveTokens = contextWindow !== null && contextWindow > REPLAY_THRESHOLD ? contextWindow - REPLAY_THRESHOLD : null;
					row.keepRecentTokens = row.reserveTokens !== null ? REPLAY_KEEP_RECENT : null;
					row.cumulative = budget.snapshot();
					row.reason = row.cumulative.stopReason ?? row.reason;
					try { await store.append(row); rows.push(row); }
					catch (error) { persistenceFailed = true; budget.halt("persistence-error"); throw error; }
					// The outer transcript identifies the case, not a simulated assistant reply.
					return { output: row, events: [{ type: "message", role: "user", content: task.id }] };
				},
			});
		},
	};
}
