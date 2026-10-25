import type { PiCodingAgentHarnessOptions } from "./pi-harness.ts";

export type ReplayAuthorization = {
	id: string; provider: string; model: string;
	thinking: NonNullable<PiCodingAgentHarnessOptions["thinkingLevel"]>;
	maxRepetitions: number; maxRequests: number; maxInputTokens: number;
};
export type BudgetStop = "request-limit" | "input-limit" | "usage-unknown" | "model-mismatch" | "run-error" | "persistence-error";
export type BudgetSnapshot = {
	requests: number; input: number; output: number; cacheRead: number; cacheWrite: number;
	usageKnown: boolean; stopReason: BudgetStop | null;
};
type Runtime = Awaited<ReturnType<NonNullable<PiCodingAgentHarnessOptions["modelRuntimeFactory"]>>>;
export type ReplayStream = ReturnType<Runtime["streamSimple"]>;
export type ReplayMessage = Awaited<ReturnType<ReplayStream["result"]>>;

export function validateLiveReplay(env: NodeJS.ProcessEnv, authorization: ReplayAuthorization | null) {
	if (env.ROTOM_EVAL_COMPACTION_OFFLOAD !== "1" || env.ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE !== "1") throw new Error("Live replay requires both explicit enablement flags");
	if (!authorization) throw new Error("Live replay has no authorization");
	if (env.ROTOM_EVAL_PROVIDER !== authorization.provider || env.ROTOM_EVAL_MODEL !== authorization.model || env.ROTOM_EVAL_THINKING !== authorization.thinking) throw new Error("Live replay selection does not exactly match authorization");
	const value = env.ROTOM_EVAL_REPETITIONS ?? String(authorization.maxRepetitions);
	if (!/^[1-9]\d*$/u.test(value) || Number(value) > authorization.maxRepetitions) throw new Error("Replay repetitions exceed authorization or are invalid");
	return { authorization, repetitions: Number(value) };
}

/** Shared by every arm/repetition in one campaign, including native summaries. */
export class ReplayBudget {
	private pending = new Set<Promise<void>>();
	private totals: BudgetSnapshot = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usageKnown: true, stopReason: null };
	constructor(readonly limits: Pick<ReplayAuthorization, "maxRequests" | "maxInputTokens">) {
		for (const n of [limits.maxRequests, limits.maxInputTokens]) if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Replay budget limits must be positive safe integers");
	}
	snapshot(): BudgetSnapshot { return { ...this.totals, usageKnown: this.totals.usageKnown && this.pending.size === 0 }; }
	async settled() { await Promise.all(this.pending); }
	halt(reason: BudgetStop) { this.totals.stopReason ??= reason; }
	admit() {
		if (this.totals.stopReason) throw new Error(`Replay stopped: ${this.totals.stopReason}`);
		this.totals.requests++;
		// The Nth request is admitted, but N+1 cannot start (even while N is in flight).
		if (this.totals.requests >= this.limits.maxRequests) this.halt("request-limit");
	}
	record(usage: ReplayMessage["usage"], complete: boolean) {
		const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
		const valid = fields.every((key) => Number.isFinite(usage?.[key]) && usage[key] >= 0);
		if (valid) for (const key of fields) this.totals[key] += usage[key];
		// Every replay request has a nonempty prompt. A zero/missing input count
		// cannot prove consumption; fail closed instead of treating it as free.
		if (!complete || !valid || usage.input + usage.cacheRead + usage.cacheWrite === 0) this.unknown();
		if (this.totals.input + this.totals.cacheRead + this.totals.cacheWrite >= this.limits.maxInputTokens) this.halt("input-limit");
	}
	unknown() { this.totals.usageKnown = false; this.halt("usage-unknown"); }

	instrument(runtime: Runtime, Stream: new () => ReplayStream, selection: Pick<ReplayAuthorization, "provider" | "model">) {
		const original = runtime.streamSimple.bind(runtime);
		runtime.streamSimple = (model, context, options) => {
			if (model.provider !== selection.provider || model.id !== selection.model) this.halt("model-mismatch");
			this.admit();
			const forwarded = new Stream();
			const completion = (async () => {
				let terminal = false;
				try {
					// Codex auto-WebSocket can retry/fall back inside one SDK call.
					// Use one SSE attempt per admission, identically in both arms.
					for await (const event of original(model, context, { ...options, transport: "sse", maxRetries: 0 })) {
						if (event.type === "done" || event.type === "error") {
							terminal = true;
							this.record(event.type === "done" ? event.message.usage : event.error.usage, event.type === "done");
						}
						// Update totals BEFORE the consumer can issue its next request.
						forwarded.push(event);
					}
					if (!terminal) throw new Error("Replay stream ended without a terminal event");
					forwarded.end();
				} catch {
					this.unknown();
					// The consumer must settle, not hang on result() or a lost async task.
					forwarded.push({ type: "error", reason: "error", error: {
						role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
						stopReason: "error", errorMessage: "Replay stream failed; usage is unknown", timestamp: Date.now(),
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					} });
					forwarded.end();
				}
			})();
			this.pending.add(completion);
			void completion.then(() => this.pending.delete(completion));
			return forwarded;
		};
	}
}
