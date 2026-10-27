import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionFactory, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { LiveReplayRow } from "./compaction-offload-store.ts";

export const OFFLOAD_ENTRY = "sol-pi-compaction-offload";
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };
type Entry = (SessionEntry & { usage?: Usage; data?: { toolCallIds: string[]; observationIds: string[] } }) | { type: "usage"; usage?: Usage };
export type OffloadDecision = {
	decision: "defer" | "defer_stale" | "native"; reason?: string;
	before: number; after: number; T: number | null; candidates: number; originalBytes: number;
};

/** Ledger events are threshold-only. Copy a metadata whitelist, never raw lines. */
export async function readOffloadDecisions(sessionDir: string, sessionId: string): Promise<OffloadDecision[]> {
	let content: string;
	try { content = await readFile(join(sessionDir, "sol-pi", sessionId, "observation-pack/ledger.jsonl"), "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	return content.trim().split("\n").filter(Boolean).flatMap((line) => {
		const row = JSON.parse(line);
		if (!["offload_defer", "offload_defer_stale", "offload_native"].includes(row.event)) return [];
		if (![row.before, row.after, row.candidates, row.originalBytes].every(Number.isFinite) ||
			(row.T !== null && !Number.isFinite(row.T)) ||
			(row.event === "offload_native" && !["no_context_window", "no_candidates", "insufficient_savings", "store_failed", "record_append_failed"].includes(row.reason))) {
			throw new Error("Invalid offload ledger decision metadata");
		}
		return [{ decision: row.event.slice("offload_".length), ...(row.event === "offload_native" ? { reason: row.reason } : {}),
			before: row.before, after: row.after, T: row.T, candidates: row.candidates, originalBytes: row.originalBytes }];
	});
}

export type RecallMetric = { turn: number; offloaded: boolean; offloadIndex: number | null; resultError: boolean | null };
export type ReplayErrorCategory = "timeout" | "connection" | "rate_limit" | "http_4xx" | "http_5xx" | "stream_terminated" | "other";
export function classifyReplayError(text = ""): ReplayErrorCategory {
	if (/timeout|timed? out|ETIMEDOUT/iu.test(text)) return "timeout";
	if (/rate.?limit|too many requests|\b429\b/iu.test(text)) return "rate_limit";
	if (/(?:^|\b(?:http|status(?:code)?)\s*[:=]?\s*)4\d\d\b/iu.test(text)) return "http_4xx";
	if (/(?:^|\b(?:http|status(?:code)?)\s*[:=]?\s*)5\d\d\b/iu.test(text)) return "http_5xx";
	if (/Replay stream failed|\bterminated\b|unexpected (?:EOF|end)|stream.*(?:closed|ended|abort)/iu.test(text)) return "stream_terminated";
	if (/connection|fetch failed|network|socket|ECONN|ENOTFOUND|EAI_AGAIN|\bDNS\b|\bTLS\b/iu.test(text)) return "connection";
	return "other";
}

export type ReplayMetrics = {
	correct: boolean; thresholdCompactions: number; nativeCompactions: number; deferred: number;
	compactionWaitMs: number; obsRecallCalls: number; recalledOffloaded: number; offloadedResults: number;
	turns: number; toolCalls: number; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number;
	estimatedCostUsd: number | null; usageComplete: boolean; wallMs: number; thresholdAtTurns: number[];
	offloadDecisions: OffloadDecision[];
	toolNames: Record<string, number>;
	phase1Coverage: { readFiles: number; totalFiles: number; partialReads: number };
	contextPeak: number; contextByTurn: number[];
	phase1ReadCallsByTurn: number[];
	coverageNudges: number;
	recalls: RecallMetric[];
	errors: { turn: number; stopReason: "error" | "aborted"; category: ReplayErrorCategory }[];
};

/** Must be installed before cancellable product handlers; never changes an event. */
export function createReplayMetrics(now = () => performance.now(), manifestFiles: Readonly<Record<string, string>> = {}) {
	let workspace = "";
	let coverageNudges = 0;
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
		pi.on("session_start", (_event, ctx) => {
			workspace = ctx.cwd;
			started = now(); pending = undefined;
			thresholdCompactions = nativeCompactions = deferred = compactionWaitMs = coverageNudges = 0;
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
		recordCoverageNudge() { coverageNudges++; },
		output(entries: readonly SessionEntry[], correct: boolean, hasPricing: boolean, offloadDecisions: OffloadDecision[] = []): ReplayMetrics {
			if (pending !== undefined) throw new Error("Unfinished compaction observation");
			let turns = 0, toolCalls = 0, obsRecallCalls = 0, recalledOffloaded = 0, offloadedResults = 0;
			let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheWrite = 0, cost = 0, usageComplete = true;
			const ids = new Map<string, number>();
			let offloadIndex = 0;
			const recalls: RecallMetric[] = [];
			const recallCalls = new Map<string, RecallMetric>();
			const errors: ReplayMetrics["errors"] = [];
			const toolNames: Record<string, number> = Object.create(null);
			const contextByTurn: number[] = [];
			const phase1ReadCallsByTurn: number[] = [];
			const manifest = new Map(Object.entries(manifestFiles).map(([path, body]) => [resolve(workspace, path), body.split("\n").length]));
			const readFiles = new Set<string>();
			const phase1Reads = new Map<string, { path: string; partial: boolean }>();
			let phase: "reading" | "done" = "done", partialReads = 0, userTurns = 0;
			const addUsage = (usage: Usage) => {
				inputTokens += usage.input; outputTokens += usage.output;
				cacheRead += usage.cacheRead; cacheWrite += usage.cacheWrite; cost += usage.cost.total;
			};
			// Read the persisted branch, not session.messages (which loses compacted turns).
			// Recall attribution is temporal: a later offload cannot relabel an earlier recall.
			for (const entry of entries as Entry[]) {
				if (entry.type === "message" && entry.message.role === "user") phase = ++userTurns <= 1 + coverageNudges ? "reading" : "done";
				if (entry.type === "message" && entry.message.role === "toolResult") {
					const recall = recallCalls.get(entry.message.toolCallId);
					if (recall) recall.resultError = entry.message.isError;
					const read = phase1Reads.get(entry.message.toolCallId);
					if (read && !entry.message.isError) {
						readFiles.add(read.path);
						const details = entry.message.details as { truncation?: { truncated: boolean } } | undefined;
						if (read.partial || details?.truncation?.truncated) partialReads++;
					}
				}
				if (entry.type === "custom" && entry.customType === OFFLOAD_ENTRY) {
					offloadIndex++;
					for (const id of entry.data!.observationIds) ids.set(id, offloadIndex);
					offloadedResults += entry.data!.toolCallIds.length;
				}
				if (entry.type === "message" && entry.message.role === "assistant") {
					turns++;
					addUsage(entry.message.usage);
					const usage = entry.message.usage;
					contextByTurn.push(usage.input + usage.cacheRead + usage.cacheWrite);
					if (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") {
						usageComplete = false;
						errors.push({ turn: turns, stopReason: entry.message.stopReason, category: classifyReplayError(entry.message.errorMessage) });
					}
					let readCalls = 0;
					for (const part of entry.message.content) if (part.type === "toolCall") {
						if (part.name === "read") readCalls++;
						toolCalls++;
						toolNames[part.name] = (toolNames[part.name] ?? 0) + 1;
						if (phase === "reading" && part.name === "read" && typeof part.arguments.path === "string") {
							// Fixtures have ASCII paths; accept relative/absolute paths and Pi's @ prefix.
							const path = resolve(workspace, part.arguments.path.replace(/^@/u, ""));
							const lines = manifest.get(path);
							if (lines !== undefined) phase1Reads.set(part.id, { path,
								partial: Number(part.arguments.offset ?? 1) > 1 || (part.arguments.limit !== undefined && Number(part.arguments.limit) < lines) });
						}
						if (part.name === "obs_recall") {
							obsRecallCalls++;
							const index = ids.get(String(part.arguments.id)) ?? null;
							if (index !== null) recalledOffloaded++;
							const recall = { turn: turns, offloaded: index !== null, offloadIndex: index, resultError: null };
							recalls.push(recall);
							recallCalls.set(part.id, recall);
						}
					}
					if (phase === "reading") {
						// Count requested calls, including failed/non-manifest reads and zero-read turns.
						phase1ReadCallsByTurn.push(readCalls);
						if (entry.message.stopReason !== "toolUse") phase = "done";
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
				usageComplete, wallMs: now() - started, thresholdAtTurns: [...thresholdAtTurns], offloadDecisions,
				toolNames, phase1Coverage: { readFiles: readFiles.size, totalFiles: manifest.size, partialReads },
				contextPeak: Math.max(0, ...contextByTurn), contextByTurn, phase1ReadCallsByTurn, coverageNudges, recalls, errors };
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

/** Compare complete within-campaign pairs; also expose all recorded executed metrics. */
export function summarizeLiveReplay(rows: readonly LiveReplayRow[]) {
	const groups = new Map<string, Partial<Record<LiveReplayRow["arm"], ReplayMetrics>>>();
	for (const row of rows) {
		if (row.status !== "completed") continue;
		const key = JSON.stringify([row.authorizationId, row.task, row.repetition]);
		const group = groups.get(key) ?? {};
		group[row.arm] = row.metrics!;
		groups.set(key, group);
	}
	const pairs = [...groups.values()].filter(group => group.baseline && group.candidate);
	const executed = rows.filter(row => row.status !== "not-run");
	return {
		executedRuns: executed.length,
		rawRuns: executed.map(({ task, arm, repetition, status, reason, metrics }) => ({ task, arm, repetition, status, reason, metrics })),
		invalidRuns: rows.filter(row => row.status === "invalid").length,
		providerErrorRuns: rows.filter(row => row.status === "failed" && row.reason === "provider-error").length,
		unusableRuns: rows.filter(row => row.status === "invalid" || (row.status === "failed" && row.reason === "provider-error")).length,
		inputAccounting: "reported-or-context-window" as const,
		outputAccounting: "reported-subtotal" as const,
		validPairs: pairs.length,
		baseline: pairs.length ? summarizeReplay(pairs.map(pair => pair.baseline!)) : null,
		candidate: pairs.length ? summarizeReplay(pairs.map(pair => pair.candidate!)) : null,
	};
}
