import type { ExtensionFactory, SessionEntry } from "@earendil-works/pi-coding-agent";

export const OFFLOAD_ENTRY = "sol-pi-compaction-offload";
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };
type Entry = (SessionEntry & { usage?: Usage; data?: { toolCallIds: string[]; observationIds: string[] } }) | { type: "usage"; usage?: Usage };
export type ReplayMetrics = {
	correct: boolean; thresholdCompactions: number; nativeCompactions: number; deferred: number;
	compactionWaitMs: number; obsRecallCalls: number; recalledOffloaded: number; offloadedResults: number;
	turns: number; toolCalls: number; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number;
	estimatedCostUsd: number | null; usageComplete: boolean; wallMs: number; thresholdAtTurns: number[];
};

/** Must be installed before cancellable product handlers; never changes an event. */
export function createReplayMetrics(now = () => performance.now()) {
	let started = 0;
	let pending: number | undefined;
	let thresholdCompactions = 0, nativeCompactions = 0, deferred = 0, compactionWaitMs = 0;
	const thresholdAtTurns: number[] = [];
	const finish = () => {
		if (pending === undefined) throw new Error("Compaction ended without an observed threshold start");
		compactionWaitMs += now() - pending;
		pending = undefined;
	};
	const extension: ExtensionFactory = (pi) => {
		pi.on("session_start", () => {
			started = now(); pending = undefined;
			thresholdCompactions = nativeCompactions = deferred = compactionWaitMs = 0;
			thresholdAtTurns.length = 0;
		});
		pi.on("session_before_compact", (event, ctx) => {
			if (event.reason !== "threshold") return;
			pending = now();
			thresholdCompactions++;
			thresholdAtTurns.push(ctx.sessionManager.getBranch().filter((e) => e.type === "message" && e.message.role === "assistant").length);
		});
		pi.on("session_compact", (event) => {
			if (event.reason !== "threshold") return;
			if (!event.fromExtension) nativeCompactions++;
			finish();
		});
		pi.on("session_compact_failed", (event) => {
			if (event.reason !== "threshold") return;
			if (event.aborted) deferred++;
			finish();
		});
	};
	return {
		extension,
		output(entries: readonly SessionEntry[], correct: boolean, hasPricing: boolean): ReplayMetrics {
			if (pending !== undefined) throw new Error("Unfinished compaction observation");
			let turns = 0, toolCalls = 0, obsRecallCalls = 0, recalledOffloaded = 0, offloadedResults = 0;
			let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheWrite = 0, cost = 0, usageComplete = true;
			const ids = new Set<string>();
			const addUsage = (usage: Usage) => {
				inputTokens += usage.input; outputTokens += usage.output;
				cacheRead += usage.cacheRead; cacheWrite += usage.cacheWrite; cost += usage.cost.total;
			};
			// Read the persisted branch, not session.messages (which loses compacted turns).
			// Recall attribution is temporal: a later offload cannot relabel an earlier recall.
			for (const entry of entries as Entry[]) {
				if (entry.type === "custom" && entry.customType === OFFLOAD_ENTRY) {
					for (const id of entry.data!.observationIds) ids.add(id);
					offloadedResults += entry.data!.toolCallIds.length;
				}
				if (entry.type === "message" && entry.message.role === "assistant") {
					turns++;
					addUsage(entry.message.usage);
					if (["error", "aborted"].includes(entry.message.stopReason)) usageComplete = false;
					for (const part of entry.message.content) if (part.type === "toolCall") {
						toolCalls++;
						if (part.name === "obs_recall") {
							obsRecallCalls++;
							if (ids.has(String(part.arguments.id))) recalledOffloaded++;
						}
					}
				}
				if (entry.type === "compaction" || entry.type === "usage") {
					if (entry.usage) addUsage(entry.usage);
					else usageComplete = false;
				}
			}
			return { correct, thresholdCompactions, nativeCompactions, deferred, compactionWaitMs,
				obsRecallCalls, recalledOffloaded, offloadedResults, turns, toolCalls, inputTokens, outputTokens,
				cacheRead, cacheWrite, estimatedCostUsd: hasPricing && usageComplete ? cost : null,
				usageComplete, wallMs: now() - started, thresholdAtTurns: [...thresholdAtTurns] };
		},
	};
}

export function summarizeReplay(rows: ReplayMetrics[]) {
	if (!rows.length) throw new Error("Cannot summarize an empty arm");
	const mean = (key: "compactionWaitMs" | "obsRecallCalls" | "recalledOffloaded" | "inputTokens" | "outputTokens" | "cacheRead" | "cacheWrite" | "wallMs") => rows.reduce((n, r) => n + r[key], 0) / rows.length;
	const waits = rows.map((r) => r.compactionWaitMs).sort((a, b) => a - b);
	return { correct: rows.filter((r) => r.correct).length, runs: rows.length,
		compactionWaitMsMean: mean("compactionWaitMs"),
		compactionWaitMsMedian: (waits[Math.floor((waits.length - 1) / 2)]! + waits[Math.floor(waits.length / 2)]!) / 2,
		nativeCompactions: rows.reduce((n, r) => n + r.nativeCompactions, 0), deferred: rows.reduce((n, r) => n + r.deferred, 0),
		obsRecallCalls: mean("obsRecallCalls"), recalledOffloaded: mean("recalledOffloaded"),
		inputTokens: mean("inputTokens"), outputTokens: mean("outputTokens"), cacheRead: mean("cacheRead"), cacheWrite: mean("cacheWrite"),
		estimatedCostUsd: rows.every((r) => r.estimatedCostUsd !== null) ? rows.reduce((n, r) => n + r.estimatedCostUsd!, 0) / rows.length : null,
		wallMs: mean("wallMs") };
}
