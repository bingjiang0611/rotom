import type { PiCodingAgentHarnessOptions } from "./pi-harness.ts";

export type ReplayAuthorization = {
	id: string; provider: string; model: string;
	thinking: NonNullable<PiCodingAgentHarnessOptions["thinkingLevel"]>;
	maxRepetitions: number; maxRequests: number; maxInputTokens: number;
	tasks?: string[];
};
// Keep usage-unknown readable in historical rows; current accounting never emits it.
export type BudgetStop = "request-limit" | "input-limit" | "usage-unknown" | "provider-error" | "model-mismatch" | "run-error" | "persistence-error" | "threshold-not-reached" | "decision-ledger-incomplete";
export type BudgetSnapshot = {
	requests: number; input: number; output: number; cacheRead: number; cacheWrite: number;
	usageKnown: boolean; pessimisticRequests: number; stopReason: BudgetStop | null;
};
type Runtime = Awaited<ReturnType<NonNullable<PiCodingAgentHarnessOptions["modelRuntimeFactory"]>>>;
export type ReplayStream = ReturnType<Runtime["streamSimple"]>;
export type ReplayMessage = Awaited<ReturnType<ReplayStream["result"]>>;

export function validateLiveReplay(env: NodeJS.ProcessEnv, authorization: ReplayAuthorization | null) {
	if (env.ROTOM_EVAL_COMPACTION_OFFLOAD !== "1" || env.ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE !== "1") throw new Error("Live replay requires both explicit enablement flags");
	if (!authorization) throw new Error("Live replay has no authorization");
	if (env.ROTOM_EVAL_PROVIDER !== authorization.provider || env.ROTOM_EVAL_MODEL !== authorization.model || env.ROTOM_EVAL_THINKING !== authorization.thinking) throw new Error("Live replay selection does not exactly match authorization");
	const tasks = authorization.tasks;
	if (tasks !== undefined) {
		if (!tasks.length || new Set(tasks).size !== tasks.length || tasks.some(task => !task || task.includes(","))) throw new Error("Invalid authorized task list");
		if (env.ROTOM_EVAL_COMPACTION_OFFLOAD_TASKS !== tasks.join(",")) throw new Error("Replay tasks do not exactly match authorization");
	} else if (env.ROTOM_EVAL_COMPACTION_OFFLOAD_TASKS !== undefined) throw new Error("Replay task selection requires tasks in authorization");
	const value = env.ROTOM_EVAL_REPETITIONS ?? String(authorization.maxRepetitions);
	if (!/^[1-9]\d*$/u.test(value) || Number(value) > authorization.maxRepetitions) throw new Error("Replay repetitions exceed authorization or are invalid");
	return { authorization, repetitions: Number(value), tasks };
}

/** Shared by every arm/repetition in one campaign, including native summaries. */
export class ReplayBudget {
	private pending = new Set<Promise<void>>();
	private failures = 0;
	private totals: BudgetSnapshot = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usageKnown: true, pessimisticRequests: 0, stopReason: null };
	constructor(readonly limits: Pick<ReplayAuthorization, "maxRequests" | "maxInputTokens">) {
		for (const n of [limits.maxRequests, limits.maxInputTokens]) if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Replay budget limits must be positive safe integers");
	}
	get providerFailures() { return this.failures; }
	snapshot(): BudgetSnapshot { return { ...this.totals, usageKnown: this.totals.usageKnown && this.pending.size === 0 }; }
	async settled() { await Promise.all(this.pending); }
	halt(reason: BudgetStop) { this.totals.stopReason ??= reason; }
	admit() {
		if (this.totals.stopReason) throw new Error(`Replay stopped: ${this.totals.stopReason}`);
		this.totals.requests++;
		// The Nth request is admitted, but N+1 cannot start (even while N is in flight).
		if (this.totals.requests >= this.limits.maxRequests) this.halt("request-limit");
	}
	record(usage: ReplayMessage["usage"] | undefined, complete: boolean, contextWindow: number) {
		const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
		const valid = usage !== undefined && fields.every(key => Number.isFinite(usage[key]) && usage[key] >= 0);
		// Replace, rather than add to, partial input: one request gets one window.
		// Output has no such bound; retain only its reported nonnegative subtotal.
		if (complete && valid && usage.input + usage.cacheRead + usage.cacheWrite > 0) {
			for (const key of ["input", "cacheRead", "cacheWrite"] as const) this.totals[key] += usage[key];
		} else {
			this.totals.input += contextWindow;
			this.totals.usageKnown = false;
			this.totals.pessimisticRequests++;
		}
		if (usage && Number.isFinite(usage.output) && usage.output >= 0) this.totals.output += usage.output;
		if (this.totals.input + this.totals.cacheRead + this.totals.cacheWrite >= this.limits.maxInputTokens) this.halt("input-limit");
	}

	instrument(runtime: Runtime, Stream: new () => ReplayStream, selection: Pick<ReplayAuthorization, "provider" | "model">) {
		const original = runtime.streamSimple.bind(runtime);
		runtime.streamSimple = (model, context, options) => {
			if (model.provider !== selection.provider || model.id !== selection.model) this.halt("model-mismatch");
			if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) this.halt("run-error");
			this.admit();
			const forwarded = new Stream();
			const completion = (async () => {
				let terminal = false;
				try {
					// One SSE attempt per admission, identically in both arms.
					for await (const event of original(model, context, { ...options, transport: "sse", maxRetries: 0 })) {
						if (event.type === "done" || event.type === "error") {
							terminal = true;
							if (event.type === "error") this.failures++;
							this.record(event.type === "done" ? event.message.usage : event.error.usage, event.type === "done", model.contextWindow);
						}
						// Account BEFORE the consumer can issue its next request.
						forwarded.push(event);
						if (terminal) break;
					}
					if (!terminal) throw new Error("Replay stream ended without a terminal event");
					forwarded.end();
				} catch {
					// A post-terminal adapter failure must stop, but not charge the request twice.
					if (terminal) this.halt("run-error");
					else {
						this.failures++;
						this.record(undefined, false, model.contextWindow);
						forwarded.push({ type: "error", reason: "error", error: {
							role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
							stopReason: "error", errorMessage: "Replay stream failed; usage is unknown", timestamp: Date.now(),
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						} });
					}
					forwarded.end();
				}
			})();
			this.pending.add(completion);
			void completion.then(() => this.pending.delete(completion));
			return forwarded;
		};
	}
}
