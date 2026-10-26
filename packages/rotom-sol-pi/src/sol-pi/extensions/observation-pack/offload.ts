import { lstat } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { buildSessionContext, estimateTokens as estimateMessageTokens, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { OFFLOAD_COPY } from "../../constants/copy.ts";
import { runtimeRoot } from "../../runtime-paths.ts";
import { formatSavingsCount, showSolPiSavings } from "../../tui.ts";
import type { Ledger } from "./ledger.ts";
import {
	createObservation, ensureStored, estimateTokens, isObservationId, isPureTextResult,
	type Observation, THRESHOLD_BYTES,
} from "./observation.ts";

export const OFFLOAD_MIN_BYTES = 1536;
export const OFFLOAD_EXCERPT_BYTES = 200;
export const OFFLOAD_TARGET_RATIO = 0.6;
export const OFFLOAD_ENTRY = "sol-pi-compaction-offload";

export type OffloadRecord = {
	version: 1;
	toolCallIds: string[];
	observationIds: string[];
	afterAssistantEntryId: string;
	estimatedTokensBefore: number;
	estimatedTokensAfter: number;
	thresholdTokens: number;
};

export function offloadPlaceholderFor(observation: Observation): string | undefined {
	const header = [
		"[older tool result offloaded before compaction]",
		`id: ${observation.id}`,
		`tool: ${observation.toolName}`,
		`original_bytes: ${observation.bytes}`,
		`original_lines: ${observation.lines}`,
		`retrieve: call obs_recall with {"id":"${observation.id}","offset":0}; continue with returned next_offset`,
	].join("\n");
	if (Buffer.byteLength(header, "utf8") > 512) return undefined;
	const budget = Math.min(OFFLOAD_EXCERPT_BYTES, 512 - Buffer.byteLength(header, "utf8") - 1);
	let excerpt = "";
	for (const line of observation.text.split(/(?<=\n)/u)) {
		if (Buffer.byteLength(excerpt + line, "utf8") > budget) break;
		excerpt += line;
	}
	const placeholder = excerpt ? `${header}\n${excerpt}` : header;
	return Buffer.byteLength(placeholder, "utf8") > observation.bytes / 2 ? undefined : placeholder;
}

export function offloadCandidate(message: AgentMessage, root: string) {
	if (!isPureTextResult(message) || message.toolName === "obs_recall") return undefined;
	const observation = createObservation(message, root, OFFLOAD_MIN_BYTES);
	if (!observation || observation.bytes > THRESHOLD_BYTES) return undefined;
	const placeholder = offloadPlaceholderFor(observation);
	if (!placeholder) return undefined;
	return { toolCallId: message.toolCallId, observation, placeholder };
}

export function selectOffloadCandidates(messages: readonly AgentMessage[], root: string, offloaded: ReadonlySet<string>) {
	const seen = new Set(offloaded);
	return messages.flatMap((message) => {
		if (message.role !== "toolResult" || seen.has(message.toolCallId)) return [];
		seen.add(message.toolCallId);
		const candidate = offloadCandidate(message, root);
		return candidate ? [candidate] : [];
	});
}

function isRecord(data: unknown): data is OffloadRecord {
	if (!data || typeof data !== "object") return false;
	const record = data as Partial<OffloadRecord>;
	return record.version === 1 &&
		Array.isArray(record.toolCallIds) && record.toolCallIds.length > 0 &&
		record.toolCallIds.every((id) => typeof id === "string" && id.length > 0) &&
		Array.isArray(record.observationIds) && record.observationIds.every((id) => typeof id === "string" && isObservationId(id)) &&
		record.toolCallIds.length === record.observationIds.length &&
		typeof record.afterAssistantEntryId === "string" && record.afterAssistantEntryId.length > 0 &&
		[record.estimatedTokensBefore, record.estimatedTokensAfter, record.thresholdTokens].every(
			(value) => typeof value === "number" && Number.isFinite(value),
		);
}

export function offloadRecords(branch: readonly SessionEntry[]): OffloadRecord[] {
	return branch.flatMap((entry) => entry.type === "custom" && entry.customType === OFFLOAD_ENTRY && isRecord(entry.data)
		? [entry.data] : []);
}

/** Only enabled callers register lifecycle handlers. Raw session messages never change. */
export function createCompactionOffload(pi: ExtensionAPI, ledgerFor: (ctx: ExtensionContext) => Ledger) {
	let offloaded = new Set<string>();
	let latest: OffloadRecord | undefined;
	// Pi may publish an entry to its in-memory branch before appendEntry throws.
	// Keep that record usable for recall, but never treat it as a confirmed defer.
	const unknown = new WeakSet<OffloadRecord>();
	const verified = new Set<string>();
	const log = async (ctx: ExtensionContext, entry: Record<string, unknown>) => {
		try {
			await ledgerFor(ctx)(entry);
		} catch {
			console.error("[observationpack] offload ledger write failed");
		}
	};
	const restore = (ctx: ExtensionContext) => {
		const records = offloadRecords(ctx.sessionManager.getBranch());
		offloaded = new Set(records.flatMap((record) => record.toolCallIds));
		latest = records.at(-1);
	};
	const reset = (ctx: ExtensionContext) => {
		verified.clear();
		restore(ctx);
	};
	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_tree", (_event, ctx) => reset(ctx));

	pi.on("session_before_compact", async (event, ctx) => {
		if (event.reason !== "threshold") return undefined;
		const before = event.preparation.tokensBefore;
		let after = before;
		let threshold: number | undefined;
		let reason = "store_failed";
		let candidateCount = 0, originalBytes = 0;
		const metadata = () => ({ before, after, T: threshold ?? null, candidates: candidateCount, originalBytes });
		const native = () => log(ctx, { event: "offload_native", reason, ...metadata() });
		try {
			restore(ctx);
			const window = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;
			if (window !== undefined) threshold = window - event.preparation.settings.reserveTokens;
			const assistant = ctx.sessionManager.getBranch().findLast(
				(entry) => entry.type === "message" && entry.message.role === "assistant",
			);
			if (latest && !unknown.has(latest) && assistant?.id === latest.afterAssistantEntryId) {
				after = latest.estimatedTokensAfter;
				await log(ctx, { event: "offload_defer_stale", afterAssistantEntryId: assistant.id, ...metadata() });
				return { cancel: true };
			}
			if (threshold === undefined) {
				reason = "no_context_window";
				await native();
				return undefined;
			}
			const candidates = selectOffloadCandidates([
				...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages,
			], runtimeRoot(ctx), offloaded);
			candidateCount = candidates.length;
			originalBytes = candidates.reduce((sum, c) => sum + c.observation.bytes, 0);
			if (candidates.length === 0) {
				reason = "no_candidates";
				await native();
				return undefined;
			}
			const saved = candidates.reduce((sum, { observation, placeholder }) =>
				sum + observation.tokens - estimateTokens(placeholder), 0);
			// Use Pi's current branch projection (including context edits/compaction),
			// then our confirmed offloads. Never reuse provider usage as the denominator.
			const messages = await Promise.all(buildSessionContext(ctx.sessionManager.getBranch()).messages
				.map(async (message) => await project(message, ctx) ?? message));
			const system = getCurrentSystemMessage(messages);
			const contextEstimate = (system ? estimateMessageTokens(system) : estimateTokens(ctx.getSystemPrompt())) +
				messages.reduce((sum, message) => sum + (message.role === "system" ? 0 : estimateMessageTokens(message)), 0);
			after = before * (1 - saved / contextEstimate);
			// No assistant means no usage anchor: do not invent a successful defer.
			if (!assistant || threshold <= 0 || after > OFFLOAD_TARGET_RATIO * threshold) {
				reason = "insufficient_savings";
				await native();
				return undefined;
			}
			for (const { observation } of candidates) await ensureStored(observation);
			const record: OffloadRecord = {
				version: 1,
				toolCallIds: candidates.map((candidate) => candidate.toolCallId),
				observationIds: candidates.map((candidate) => candidate.observation.id),
				afterAssistantEntryId: assistant.id,
				estimatedTokensBefore: before, estimatedTokensAfter: after, thresholdTokens: threshold,
			};
			reason = "record_append_failed";
			unknown.add(record);
			pi.appendEntry(OFFLOAD_ENTRY, record);
			unknown.delete(record);
			restore(ctx);
			await log(ctx, {
				event: "offload_defer", offloaded: candidates.length,
				placeholderBytes: candidates.reduce((sum, c) => sum + Buffer.byteLength(c.placeholder, "utf8"), 0),
				...metadata(),
			});
			try {
				showSolPiSavings(ctx, "Observation Pack", OFFLOAD_COPY.deferred(formatSavingsCount(saved, OFFLOAD_COPY.offloadedTokens)));
			} catch {
				console.error("[observationpack] offload savings notification failed");
			}
			return { cancel: true };
		} catch {
			console.error(`[observationpack] compaction offload failed: ${reason}`);
			await native();
			return undefined;
		}
	});

	const project = async (message: AgentMessage, ctx: ExtensionContext) => {
		if (message.role !== "toolResult" || !offloaded.has(message.toolCallId)) return undefined;
		const root = runtimeRoot(ctx);
		const candidate = offloadCandidate(message, root);
		if (!candidate) return undefined;
		const { observation, placeholder } = candidate;
		try {
			// Missing archived data must not become a dangling pointer. Forks whose
			// new runtime root has no object keep the raw session result instead.
			const key = `${root}\0${observation.id}`;
			if (!verified.has(key)) {
				await lstat(observation.filePath);
				await ensureStored(observation);
				verified.add(key);
			}
			await log(ctx, { event: "offload_placeholder", id: observation.id, tool: observation.toolName,
				originalBytes: observation.bytes, placeholderBytes: Buffer.byteLength(placeholder, "utf8") });
			return { ...message, content: [{ type: "text" as const, text: placeholder }] };
		} catch {
			console.error("[observationpack] offload projection failed; keeping original result");
			return undefined;
		}
	};
	return { restore, project };
}
