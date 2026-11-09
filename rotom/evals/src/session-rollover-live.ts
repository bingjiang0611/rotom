import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHarness } from "vitest-evals/harness";
import { createRolloverHarness } from "./session-rollover-cases.ts";
import type { RolloverMetrics } from "./session-rollover-metrics.ts";
import { ROLLOVER_KEEP_RECENT, ROLLOVER_THRESHOLD, type RolloverTask } from "./session-rollover-tasks.ts";
import { rolloverRunBudget, type RolloverAuthorization } from "./session-rollover-budget.ts";
import type { ReplayBudget, BudgetSnapshot } from "./compaction-offload-budget.ts";
import type { PiCodingAgentHarnessOptions, PiCodingAgentInput } from "./pi-harness.ts";

type RuntimeFactory = NonNullable<PiCodingAgentHarnessOptions["modelRuntimeFactory"]>;

/**
 * Reads the user's credentials in place, exactly like the compaction-offload live replay: nothing is
 * copied and no login is attempted. `agentDir` is captured before `setupWorkspace` points Pi at the
 * isolated directory.
 */
export function liveRuntimeFactory(agentDir: string): RuntimeFactory {
	return async ({ product }) =>
		product.runtime.ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			refreshOnCreate: false,
		});
}

/**
 * Reads the window from the same persisted model store Pi loads with `refresh()`, because an
 * extension-provided provider is not registered yet when the run factory is called.
 */
export async function readStoredContextWindow(agentDir: string, provider: string, model: string): Promise<number | null> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(join(agentDir, "models-store.json"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const entry = (parsed as Record<string, { models?: { id?: unknown; contextWindow?: unknown }[] }>)[provider];
	const found = entry?.models?.find((candidate) => candidate.id === model);
	const window = found?.contextWindow;
	return typeof window === "number" && Number.isSafeInteger(window) && window > 0 ? window : null;
}

/**
 * Failures that produced no visible output and no side effect: the service answered 5xx or the
 * connection ended before the first frame. One retry is recorded as a separate attempt row.
 */
const PROVIDER_FAILURE = /upstream_error_frame|request_failed_before_output|stream_failed_before_output|connection_failed|socket hang up|ECONNRESET|fetch failed|\b5\d\d\b/u;

export type RolloverLiveRow = {
	version: 1;
	authorizationId: string;
	timestamp: string;
	task: string;
	arm: "candidate" | "baseline";
	repetition: number;
	repetitions: number;
	/** 1 for the first try, 2 for the single retry after a provider-side failure. */
	attempt: number;
	status: "completed" | "failed" | "not-run";
	reason: string | null;
	provider: string;
	model: string;
	thinking: string;
	contextWindow: number | null;
	thresholdTokens: number;
	keepRecentTokens: number;
	/** Whether the arm actually took over the compaction; recorded, not asserted, in live runs. */
	tookOver: boolean | null;
	metrics: RolloverMetrics | null;
	budget: BudgetSnapshot;
	sourceCommit: string;
	sourceDirty: boolean;
};

function store(directory: string, authorization: RolloverAuthorization) {
	const file = join(directory, `session-rollover-live-${authorization.provider}-${authorization.model}.jsonl`);
	return async (row: RolloverLiveRow) => {
		await mkdir(directory, { recursive: true });
		await appendFile(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
	};
}

/**
 * One campaign per authorized model. Each run gets a fresh budget, so a single runaway run stops
 * without throwing the rest of the campaign away, and every row is persisted before the next one
 * starts.
 */
export function createLiveRolloverCampaign(
	authorization: RolloverAuthorization,
	options: { directory: string; repetitions?: number; runtimeFactory: RuntimeFactory; sourceCommit: string; sourceDirty: boolean; contextWindow: number },
) {
	const repetitions = options.repetitions ?? authorization.maxRepetitions;
	const append = store(options.directory, authorization);
	const rows: RolloverLiveRow[] = [];
	return {
		rows,
		harness(task: RolloverTask, candidate: boolean, repetition: number) {
			let budget: ReplayBudget | undefined;
			let contextWindow: number | null = null;
			let metricsFromOutput: RolloverMetrics | undefined;
			let tookOver: boolean | null = null;
			let runtimeFailure: string | null = null;
			// A fresh inner harness per attempt: one replay run, one budget, one metrics pass.
			const makeInner = () => {
				budget = undefined;
				metricsFromOutput = undefined;
				tookOver = null;
				return createRolloverHarness(task, candidate, {
					model: { provider: authorization.provider, id: authorization.model },
					thinkingLevel: authorization.thinking,
					contextWindow: options.contextWindow,
					async modelRuntimeFactory(context) {
						const runtime = await options.runtimeFactory(context);
						// The budget stops on a model mismatch, so no pre-registration lookup is needed here.
						contextWindow = options.contextWindow;
						budget = rolloverRunBudget(authorization);
						const { AssistantMessageEventStream } = await import(pathToFileURL(resolve(context.product.verified.packageRoot, "../pi-ai/dist/index.js")).href);
						budget.instrument(runtime, AssistantMessageEventStream, authorization);
						return runtime;
					},
					onMetrics(metrics) {
						metricsFromOutput = metrics;
						tookOver = metrics.rolloverEntries > 0;
					},
				});
			};
			return createHarness<PiCodingAgentInput, RolloverLiveRow>({
				name: candidate ? "rollover" : "native-summary",
				async run({ input, signal }) {
					// A failure with no visible output and no side effect is retried once: the service
					// answered 5xx or the connection died before the first frame. Anything else, and any
					// second failure, is recorded as the run's result.
					const attempts = 2;
					let row: RolloverLiveRow | undefined;
					for (let attempt = 1; attempt <= attempts; attempt++) {
						const harness = makeInner();
						const started = performance.now();
						const current: RolloverLiveRow = {
							version: 1,
							authorizationId: authorization.id,
							timestamp: new Date().toISOString(),
							task: task.id,
							arm: candidate ? "candidate" : "baseline",
							repetition,
							repetitions,
							attempt,
							status: "not-run",
							reason: null,
							provider: authorization.provider,
							model: authorization.model,
							thinking: authorization.thinking,
							contextWindow: null,
							thresholdTokens: ROLLOVER_THRESHOLD,
							keepRecentTokens: ROLLOVER_KEEP_RECENT,
							tookOver: null,
							metrics: null,
							budget: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usageKnown: true, pessimisticRequests: 0, stopReason: null },
							sourceCommit: options.sourceCommit,
							sourceDirty: options.sourceDirty,
						};
						row = current;
						let retryable = false;
						try {
							await harness.run(input, { signal, artifacts: {}, setArtifact() {} });
							current.status = "completed";
						} catch (error) {
							current.status = "failed";
							current.reason = runtimeFailure ?? "run-error";
							current.metrics = harness.failureMetrics();
							const detail = error as { message?: string };
							const message = detail?.message ?? String(error);
							retryable = !signal?.aborted && PROVIDER_FAILURE.test(message);
							current.reason = runtimeFailure ?? (retryable ? "provider-error" : "run-error");
							if (!retryable) console.error(JSON.stringify({ rolloverLiveRun: current.task, arm: current.arm, repetition, attempt, reason: current.reason, error: message.slice(0, 300) }));
						}
						current.contextWindow = contextWindow;
						current.metrics = current.metrics ?? metricsFromOutput ?? null;
						current.tookOver = tookOver;
						if (current.metrics) current.metrics.wallMs = performance.now() - started;
						if (budget) {
							await budget.settled();
							current.budget = budget.snapshot();
							current.reason = current.reason ?? current.budget.stopReason;
							if (current.budget.stopReason && current.status === "completed") current.status = "failed";
						}
						await append(current);
						rows.push(current);
						if (!retryable || attempt === attempts) break;
						console.error(JSON.stringify({ rolloverLiveRetry: { task: current.task, arm: current.arm, repetition, attempt } }));
					}
					return { output: row!, events: [{ type: "message", role: "user", content: task.id }] };
				},
			});
		},
	};
}

function median(values: number[]): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export type RolloverLiveGroup = {
	runs: number;
	completed: number;
	correct: number;
	medianRequests: number | null;
	medianInputTokens: number | null;
	medianOutputTokens: number | null;
	medianCacheReadTokens: number | null;
	medianCacheWriteTokens: number | null;
	medianWallMs: number | null;
	/** Provider-reported USD when the model is priced, otherwise null = unknown. */
	costUsd: number | null;
	/** Qoder-recorded credits, summed over runs; null when the model reports none. */
	credits: number | null;
	/** One short token per wrong run, so a failure mode stays visible in the summary. */
	gradeReasons: string[];
	/** Runs whose created file obeyed the task rule, and runs checked for it. */
	ruleObeyed: string;
	recallCalls: number;
	/** Runs where at least one `context_recall` result repeated its own query. */
	runsWithRecallHit: number;
	nativeSummaries: number;
	rolloverEntries: number;
	takeovers: number;
	usageKnownRuns: number;
	budgetStops: string[];
};

/** Per model x task x arm. Tokens and provider-reported spend only; no price estimate. */
export function summarizeRolloverLive(rows: RolloverLiveRow[]) {
	const groups = new Map<string, RolloverLiveRow[]>();
	for (const row of rows) {
		const key = [row.provider, row.model, row.thinking, row.task, row.arm].join(" / ");
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	const out: Record<string, RolloverLiveGroup> = {};
	for (const [key, list] of groups) {
		const done = list.filter((row) => row.status === "completed" && row.metrics);
		const metrics = done.map((row) => row.metrics!);
		// `costUsd` sums Provider-reported totals; only a run whose price is known may quote it.
		const priced = metrics.filter((item) => item.costUnknownReason === null && item.costUsd !== null);
		const credited = metrics.filter((item) => item.credits !== null);
		out[key] = {
			runs: list.length,
			completed: done.length,
			correct: metrics.filter((item) => item.correct).length,
			medianRequests: median(metrics.map((item) => item.requests)),
			medianInputTokens: median(metrics.map((item) => item.inputTokens)),
			medianOutputTokens: median(metrics.map((item) => item.outputTokens)),
			medianCacheReadTokens: median(metrics.map((item) => item.cacheReadTokens)),
			medianCacheWriteTokens: median(metrics.map((item) => item.cacheWriteTokens)),
			medianWallMs: median(metrics.map((item) => item.wallMs)),
			costUsd: priced.length === metrics.length && priced.length > 0 ? priced.reduce((sum, item) => sum + (item.costUsd ?? 0), 0) : null,
			credits: credited.length > 0 ? credited.reduce((sum, item) => sum + (item.credits ?? 0), 0) : null,
			gradeReasons: metrics.flatMap((item) => (item.gradeReason ? [item.gradeReason] : [])),
			ruleObeyed: `${metrics.filter((item) => item.ruleObeyed === true).length}/${metrics.filter((item) => item.ruleObeyed !== null).length}`,
			recallCalls: metrics.reduce((sum, item) => sum + item.recallCalls, 0),
			runsWithRecallHit: metrics.filter((item) => item.recallQueries.some((query) => query.hit)).length,
			nativeSummaries: metrics.reduce((sum, item) => sum + item.nativeSummaries, 0),
			rolloverEntries: metrics.reduce((sum, item) => sum + item.rolloverEntries, 0),
			takeovers: list.filter((row) => row.tookOver === true).length,
			usageKnownRuns: metrics.filter((item) => item.usageKnown).length,
			budgetStops: list.flatMap((row) => (row.budget.stopReason ? [`${row.task}/${row.arm}#${row.repetition}:${row.budget.stopReason}`] : [])),
		};
	}
	return out;
}
