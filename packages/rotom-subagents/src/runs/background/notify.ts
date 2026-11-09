/**
 * Completion notification delivery.
 *
 * Async result files call this notifier directly and are deleted only after
 * `sendMessage()` accepts the notification. The event bus remains an
 * observation channel, not a delivery acknowledgement.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildCompletionKey, markSeenWithTtl } from "./completion-dedupe.ts";
import {
	type CompletionBatchConfig,
	type CompletionBatcher,
	createCompletionBatcher,
	resolveCompletionBatchConfig,
} from "./completion-batcher.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_FOREGROUND_COMPLETE_EVENT, TEMP_ROOT_DIR, type ParallelHandoffReference, type ScheduleOrigin, type SubagentState } from "../../shared/types.ts";
import { isUnexplainedProcessSignal } from "../shared/process-signal.ts";

export interface SubagentNotifyDetails {
	agent: string;
	status: "completed" | "failed" | "paused" | "stopped";
	source?: "async" | "foreground";
	taskInfo?: string;
	resultPreview: string;
	durationMs?: number;
	sessionLabel?: string;
	sessionValue?: string;
	handoffPath?: string;
	/** Present when a durable schedule launched the run. */
	scheduleOrigin?: ScheduleOrigin;
}

export interface CompletionNotification {
	[key: string]: unknown;
	id?: string | null;
	source?: "async" | "foreground";
	agent?: string | null;
	success?: boolean;
	summary?: string;
	exitCode?: number;
	state?: string;
	processSignal?: string | null;
	interrupted?: boolean;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudgetExceeded?: boolean;
	results?: Array<{
		status?: string;
		success?: boolean;
		exitCode?: number | null;
		processSignal?: string | null;
		interrupted?: boolean;
		timedOut?: boolean;
		stopped?: boolean;
		turnBudgetExceeded?: boolean;
	}>;
	timestamp?: number;
	durationMs?: number;
	cwd?: string;
	sessionFile?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	taskIndex?: number;
	totalTasks?: number;
	sessionId?: string | null;
	completionOwnerId?: string | null;
	triggerTurn?: boolean;
	/** True when an acknowledged grouped intercom relay already delivered this run. */
	intercomDelivered?: boolean;
	parallelHandoff?: ParallelHandoffReference;
	scheduleOrigin?: ScheduleOrigin;
}

interface NotifyTimerApi {
	setTimeout(handler: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface RegisterSubagentNotifyOptions {
	batchConfig?: CompletionBatchConfig;
	timers?: NotifyTimerApi;
	now?: () => number;
}

export interface CompletionNotifier {
	deliver(result: CompletionNotification): Promise<boolean>;
	dispose(): void;
}

function formatSessionLine(details: SubagentNotifyDetails): string | undefined {
	if (!details.sessionValue) return undefined;
	return details.sessionLabel ? `${details.sessionLabel}: ${details.sessionValue}` : details.sessionValue;
}

export function formatSingleCompletion(details: SubagentNotifyDetails): string {
	const sessionLine = formatSessionLine(details);
	const taskKind = details.source === "foreground" ? "Detached foreground task" : "Background task";
	const scheduleLine = details.scheduleOrigin
		? `Scheduled run from **${details.scheduleOrigin.name ?? details.scheduleOrigin.id}** (schedule ${details.scheduleOrigin.id}).`
		: undefined;
	return [
		`${taskKind} ${details.status}: **${details.agent}**${details.taskInfo ?? ""}`,
		"",
		scheduleLine,
		scheduleLine ? "" : undefined,
		details.resultPreview.trim() ? details.resultPreview : "(no output)",
		details.handoffPath ? "" : undefined,
		details.handoffPath ? `Parallel handoff: ${details.handoffPath}` : undefined,
		sessionLine ? "" : undefined,
		sessionLine,
	]
		.filter((line) => line !== undefined)
		.join("\n");
}

export function parseSubagentNotifyContent(content: string): SubagentNotifyDetails | undefined {
	const lines = content.split("\n");
	const match = (lines[0] ?? "").match(/^(Background task|Detached foreground task) (completed|failed|paused|stopped): \*\*(.+?)\*\*(?:\s+(\([^)]*\)))?$/);
	if (!match) return undefined;
	let body = lines.slice(2);
	// Restore the schedule origin so a re-rendered notice keeps its attribution and
	// does not fold the line into the result preview.
	const scheduleMatch = (body[0] ?? "").match(/^Scheduled run from \*\*(.+?)\*\* \(schedule (.+?)\)\.$/);
	let parsedScheduleOrigin: ScheduleOrigin | undefined;
	if (scheduleMatch) {
		const label = scheduleMatch[1]!;
		const id = scheduleMatch[2]!;
		parsedScheduleOrigin = { id, ...(label === id ? {} : { name: label }) };
		body = body.slice(body[1]?.trim() === "" ? 2 : 1);
	}
	let sessionIndex = -1;
	for (let i = body.length - 1; i >= 1; i--) {
		if (body[i - 1]?.trim() === "" && /^(Session|Session file|Session share error):\s+/.test(body[i]!)) {
			sessionIndex = i;
			break;
		}
	}
	const sessionLine = sessionIndex >= 0 ? body[sessionIndex] : undefined;
	const handoffIndex = body.findIndex((line) => line.startsWith("Parallel handoff: "));
	const metadataIndexes = [sessionIndex, handoffIndex].filter((index) => index >= 0);
	const firstMetadataIndex = metadataIndexes.length ? Math.min(...metadataIndexes) : body.length;
	const resultEnd = firstMetadataIndex > 0 && body[firstMetadataIndex - 1]?.trim() === "" ? firstMetadataIndex - 1 : firstMetadataIndex;
	const resultPreview = body.slice(0, resultEnd).join("\n").trim() || "(no output)";
	const handoffPath = handoffIndex >= 0 ? body[handoffIndex]!.slice("Parallel handoff: ".length).trim() : undefined;
	let sessionLabel: string | undefined;
	let sessionValue: string | undefined;
	if (sessionLine) {
		const separator = sessionLine.indexOf(":");
		sessionLabel = sessionLine.slice(0, separator).toLowerCase();
		sessionValue = sessionLine.slice(separator + 1).trim();
	}
	return {
		agent: match[3]!,
		status: match[2] as SubagentNotifyDetails["status"],
		...(match[1] === "Detached foreground task" ? { source: "foreground" as const } : {}),
		...(match[4] ? { taskInfo: match[4] } : {}),
		...(parsedScheduleOrigin ? { scheduleOrigin: parsedScheduleOrigin } : {}),
		resultPreview,
		...(handoffPath ? { handoffPath } : {}),
		...(sessionLabel && sessionValue ? { sessionLabel, sessionValue } : {}),
	};
}

export function formatGroupedCompletion(details: SubagentNotifyDetails[]): string {
	const header = `Background tasks completed (${details.length}): ${details.map((d) => `**${d.agent}**${d.taskInfo ?? ""}`).join(", ")}`;
	const blocks: string[] = [header, ""];
	for (let index = 0; index < details.length; index++) {
		const detail = details[index];
		if (!detail) continue;
		const sessionLine = formatSessionLine(detail);
		blocks.push(`${index + 1}. ${detail.agent}${detail.taskInfo ?? ""}${detail.scheduleOrigin ? ` — scheduled run from ${detail.scheduleOrigin.name ?? detail.scheduleOrigin.id} (schedule ${detail.scheduleOrigin.id})` : ""}`);
		blocks.push(detail.resultPreview.trim() ? detail.resultPreview : "(no output)");
		if (detail.handoffPath) blocks.push(`Parallel handoff: ${detail.handoffPath}`);
		if (sessionLine) blocks.push(sessionLine);
		blocks.push("");
	}
	return blocks.join("\n").trimEnd();
}

interface PendingCompletion {
	key: string;
	details: SubagentNotifyDetails;
	triggerTurn: boolean;
	resolve(accepted: boolean): void;
}

function sendCompletion(pi: Pick<ExtensionAPI, "sendMessage">, items: PendingCompletion[]): boolean {
	if (items.length === 0) return true;
	const details = items.map((item) => item.details);
	const content = details.length === 1 ? formatSingleCompletion(details[0]!) : formatGroupedCompletion(details);
	const display = details.some((detail) => detail.source === "foreground" || detail.status !== "completed" || detail.scheduleOrigin !== undefined);
	try {
		pi.sendMessage(
			{
				customType: "subagent-notify",
				content,
				display,
			},
			{ triggerTurn: items.some((item) => item.triggerTurn) },
		);
		return true;
	} catch {
		return false;
	}
}

function completionBatchKey(result: CompletionNotification): string {
	const sessionId = typeof result.sessionId === "string" ? result.sessionId.trim() : "";
	if (sessionId) return `session:${sessionId}`;
	const cwd = typeof result.cwd === "string" ? result.cwd.trim() : "";
	return cwd ? `cwd:${cwd}` : "unknown";
}

/** Largest completion text, in UTF-8 bytes, that enters the parent conversation verbatim. */
export const COMPLETION_PREVIEW_MAX_BYTES = 8 * 1024;
const COMPLETION_PREVIEW_TAIL_BYTES = 2 * 1024;
/** Saved full outputs older than this are removed on the next save, so the directory stays bounded. */
export const COMPLETION_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface CompletionPreviewOptions {
	/** Private directory for full outputs; defaults to `<execution store>/completion-output`. */
	outputDir?: string;
	maxBytes?: number;
	now?: () => number;
}

function utf8Slice(bytes: Buffer, start: number, end: number): string {
	// Cutting inside a multi-byte character yields U+FFFD at the edge; drop it.
	return bytes.subarray(start, end).toString("utf8").replace(/^\uFFFD+|\uFFFD+$/gu, "");
}

function pruneExpiredCompletions(outputDir: string, now: number): void {
	// Best effort: only regular .md files this module wrote, never links or directories.
	for (const name of fs.readdirSync(outputDir)) {
		if (!name.endsWith(".md")) continue;
		const file = path.join(outputDir, name);
		try {
			const info = fs.lstatSync(file);
			if (info.isFile() && now - info.mtimeMs > COMPLETION_OUTPUT_RETENTION_MS) fs.unlinkSync(file);
		} catch {
			// A concurrent prune or a vanished file is not an error for delivery.
		}
	}
}

function persistFullCompletion(text: string, runId: string, outputDir: string, now: number): { path: string } | { error: string } {
	try {
		fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
		const info = fs.lstatSync(outputDir);
		if (!info.isDirectory() || info.isSymbolicLink()) return { error: "output directory is not a private directory" };
		pruneExpiredCompletions(outputDir, now);
		const safeId = runId.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 80) || "run";
		const file = path.join(outputDir, `${safeId}-${now}-${process.pid}.md`);
		const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
		try {
			fs.writeFileSync(fd, text, "utf8");
		} finally {
			fs.closeSync(fd);
		}
		return { path: file };
	} catch (error) {
		return { error: (error as NodeJS.ErrnoException).code ?? "write failed" };
	}
}

/**
 * Bound the completion text that enters the parent conversation. Full child reports
 * reached 77 KB and triggered a new turn each; past the bound the parent sees the head
 * and the tail, an explicit not-complete marker and a private file with the full text.
 * Saved files are kept for seven days.
 */
export function boundCompletionPreview(text: string, runId: string, options: CompletionPreviewOptions = {}): string {
	const maxBytes = options.maxBytes ?? COMPLETION_PREVIEW_MAX_BYTES;
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	const tailBytes = Math.min(COMPLETION_PREVIEW_TAIL_BYTES, Math.floor(maxBytes / 4));
	const headBytes = maxBytes - tailBytes;
	const saved = persistFullCompletion(text, runId, options.outputDir ?? path.join(TEMP_ROOT_DIR, "completion-output"), (options.now ?? Date.now)());
	const where = "path" in saved
		? `The full output is saved at ${saved.path}; read it before relying on any omitted part.`
		: `The full output could not be saved (${saved.error}); inspect the run with subagent status before relying on any omitted part.`;
	return [
		utf8Slice(bytes, 0, headBytes),
		"",
		`[Subagent output truncated: showing the first ${headBytes} and last ${tailBytes} of ${bytes.length} bytes. This is not the complete result. ${where}]`,
		"",
		utf8Slice(bytes, bytes.length - tailBytes, bytes.length),
	].join("\n");
}

export function buildCompletionDetails(result: CompletionNotification, previewOptions: CompletionPreviewOptions = {}): SubagentNotifyDetails {
	const agent = result.agent ?? "unknown";
	const rawSummary = typeof result.summary === "string" ? result.summary : "";
	const runId = typeof result.id === "string" && result.id ? result.id : typeof result.runId === "string" ? result.runId : agent;
	const summary = boundCompletionPreview(rawSummary, runId, previewOptions);
	const stopped = result.stopped === true
		|| result.state === "stopped"
		|| (result.success !== true && result.exitCode !== 0 && isUnexplainedProcessSignal(result))
		|| result.results?.some((child) => child.stopped === true
			|| child.status === "stopped"
			|| (child.success !== true && child.exitCode !== 0 && isUnexplainedProcessSignal(child))) === true;
	const paused = !stopped && !result.success && (
		result.exitCode === 0
		|| result.state === "paused"
		|| rawSummary.startsWith("Paused after interrupt.")
	);
	const status = stopped ? "stopped" : paused ? "paused" : result.success ? "completed" : "failed";
	const taskInfo =
		result.taskIndex !== undefined && result.totalTasks !== undefined
			? ` (${result.taskIndex + 1}/${result.totalTasks})`
			: undefined;

	const parallelHandoff = result.parallelHandoff && typeof result.parallelHandoff === "object"
		? result.parallelHandoff as { path?: unknown }
		: undefined;
	const handoffPath = typeof parallelHandoff?.path === "string" ? parallelHandoff.path : undefined;
	const session =
		result.shareUrl
			? { label: "Session", value: result.shareUrl }
			: result.shareError
				? { label: "Session share error", value: result.shareError }
				: result.sessionFile
					? { label: "Session file", value: result.sessionFile }
					: undefined;
	const rawOrigin = result.scheduleOrigin;
	const scheduleOrigin = rawOrigin && typeof rawOrigin.id === "string"
		? { id: rawOrigin.id, ...(typeof rawOrigin.name === "string" ? { name: rawOrigin.name } : {}) }
		: undefined;
	return {
		agent,
		status,
		...(scheduleOrigin ? { scheduleOrigin } : {}),
		...(result.source ? { source: result.source } : {}),
		...(taskInfo ? { taskInfo } : {}),
		resultPreview: summary,
		...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
		...(handoffPath ? { handoffPath } : {}),
		...(session ? { sessionLabel: session.label, sessionValue: session.value } : {}),
	};
}

export default function registerSubagentNotify(
	pi: ExtensionAPI,
	state: Pick<SubagentState, "currentSessionId" | "completionOwnerId">,
	options: RegisterSubagentNotifyOptions = {},
): CompletionNotifier {
	const seen = new Map<string, number>();
	const pending = new Map<string, Promise<boolean>>();
	const ttlMs = 10 * 60 * 1000;
	const now = options.now ?? Date.now;
	const batchConfig = resolveCompletionBatchConfig(options.batchConfig);
	const batchers = new Map<string, CompletionBatcher<PendingCompletion>>();
	let disposed = false;

	const settle = (items: PendingCompletion[], accepted: boolean) => {
		for (const item of items) {
			pending.delete(item.key);
			if (accepted) markSeenWithTtl(seen, item.key, now(), ttlMs);
			item.resolve(accepted);
		}
	};
	const emit = (items: PendingCompletion[]) => settle(items, sendCompletion(pi, items));
	const getBatcher = (result: CompletionNotification) => {
		const key = completionBatchKey(result);
		let batcher = batchers.get(key);
		if (!batcher) {
			batcher = createCompletionBatcher<PendingCompletion>({
				config: batchConfig,
				emit,
				...(options.timers ? { timers: options.timers } : {}),
				now,
			});
			batchers.set(key, batcher);
		}
		return batcher;
	};

	const deliver = (result: CompletionNotification): Promise<boolean> => {
		if (disposed || typeof result.sessionId !== "string" || result.sessionId !== state.currentSessionId) return Promise.resolve(false);
		if (result.source !== "foreground" && (!state.completionOwnerId || result.completionOwnerId !== state.completionOwnerId)) return Promise.resolve(false);
		if (result.intercomDelivered === true) return Promise.resolve(true);
		const key = buildCompletionKey(result, "notify");
		const seenAt = seen.get(key);
		if (seenAt !== undefined && now() - seenAt <= ttlMs) return Promise.resolve(true);
		if (seenAt !== undefined) seen.delete(key);
		const inFlight = pending.get(key);
		if (inFlight) return inFlight;
		const details = buildCompletionDetails(result);
		let resolve!: (accepted: boolean) => void;
		const completion = new Promise<boolean>((settleCompletion) => { resolve = settleCompletion; });
		pending.set(key, completion);
		const item: PendingCompletion = {
			key,
			details,
			triggerTurn: result.triggerTurn !== false,
			resolve,
		};
		if (details.source === "foreground") {
			emit([item]);
			return completion;
		}
		const batcher = getBatcher(result);
		if (details.status !== "completed") {
			batcher.flush();
			emit([item]);
			return completion;
		}
		batcher.push(item);
		return completion;
	};

	const unsubscribeAsync = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => {
		void deliver(data as CompletionNotification);
	});
	const unsubscribeForeground = pi.events.on(SUBAGENT_FOREGROUND_COMPLETE_EVENT, (data) => {
		void deliver(data as CompletionNotification);
	});

	return {
		deliver,
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const batcher of batchers.values()) settle(batcher.dispose(), false);
			batchers.clear();
			for (const unsubscribe of [unsubscribeAsync, unsubscribeForeground]) {
				try {
					unsubscribe?.();
				} catch {
					// The runtime is already shutting down; pending records stay on disk.
				}
			}
		},
	};
}
